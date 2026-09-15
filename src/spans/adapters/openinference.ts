import type { AdapterInput, SpanAdapter } from "./types";
import type { NormalizedMessage } from "../normalized";
import { extractContent, lastUserText, parseJsonOrRaw } from "./helpers";

type Attributes = AdapterInput["attrs"];

function text(attrs: Attributes, key: string): string | undefined {
  return typeof attrs[key] === "string" ? attrs[key] : undefined;
}

/** Lists use indexed attribute names; sparse indices must stay in numeric order. */
function indexed(attrs: Attributes, prefix: string): Attributes[] {
  const entries = new Map<number, Attributes>();
  for (const [key, value] of Object.entries(attrs)) {
    if (!key.startsWith(prefix)) continue;
    const match = /^(\d+)\.(.+)$/.exec(key.slice(prefix.length));
    if (!match) continue;
    const index = Number(match[1]);
    if (!Number.isSafeInteger(index)) continue;
    let item = entries.get(index);
    if (!item) { item = Object.create(null) as Attributes; entries.set(index, item); }
    item[match[2]] = value;
  }
  return [...entries].sort(([a], [b]) => a - b).map(([, item]) => item);
}

function contentParts(attrs: Attributes): unknown[] {
  return indexed(attrs, "message.contents.").map((part) => {
    const type = text(part, "message_content.type") ?? "unknown";
    if (type === "text") return { type, text: text(part, "message_content.text") ?? "", source: part };
    if (type === "image") return { type, image: text(part, "message_content.image.image.url"), source: part };
    // Keep unsupported media and unknown content visibly non-text for consumers
    // deciding whether captured input can safely support an evaluation/replay.
    return { type, source: part };
  });
}

function message(attrs: Attributes): NormalizedMessage | undefined {
  const sourceRole = text(attrs, "message.role");
  const role = sourceRole === "developer" ? "system" : sourceRole;
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") return undefined;
  const parts = contentParts(attrs);
  const calls = indexed(attrs, "message.tool_calls.").map((call) => ({
    type: "tool_use", id: text(call, "tool_call.id"), name: text(call, "tool_call.function.name"),
    input: parseJsonOrRaw(text(call, "tool_call.function.arguments")), source: call,
  }));
  const plain = text(attrs, "message.content");
  const content = plain ?? extractContent(parts);
  const rawContent = parts.length || calls.length
    ? [...(plain !== undefined ? [{ type: "text", text: plain }] : []), ...parts, ...calls]
    : content;
  return {
    role, content,
    ...(role === "tool" && text(attrs, "message.tool_call_id") !== undefined ? { toolCallId: text(attrs, "message.tool_call_id") } : {}),
    raw: { role, content: rawContent, source: attrs },
  };
}

function messages(attrs: Attributes, prefix: string): NormalizedMessage[] {
  return indexed(attrs, prefix).map(message).filter((item): item is NormalizedMessage => item !== undefined);
}

export const openInferenceLlmAdapter: SpanAdapter = {
  name: "openinference-llm",
  apply(input) {
    if (input.spanType !== "LLM_GENERATION" || input.attrs["openinference.span.kind"] !== "LLM") return null;
    const attrs = input.attrs;
    const allMessages = messages(attrs, "llm.input_messages.");
    const conversation = allMessages.filter((item) => item.role !== "system");
    const indexedOutput = indexed(attrs, "llm.output_messages.");
    const output = indexedOutput.map(message).filter((item): item is NormalizedMessage => item?.role === "assistant");
    const inputRaw = text(attrs, "input.value");
    const outputRaw = text(attrs, "output.value");
    const answer = output.map((item) => item.content).filter(Boolean).join("\n\n");
    const hasTextOutput = indexedOutput.some((item) => item["message.role"] === "assistant" && (text(item, "message.content") !== undefined
      || indexed(item, "message.contents.").some((part) => part["message_content.type"] === "text" && text(part, "message_content.text") !== undefined)));
    return {
      inputPayload: inputRaw ?? (allMessages.length ? JSON.stringify(allMessages.map((item) => item.raw)) : undefined),
      // output.value commonly contains the entire provider response envelope.
      // Indexed output messages are authoritative whenever they are captured.
      outputPayload: indexedOutput.length ? hasTextOutput ? answer : undefined : outputRaw,
      ...(indexedOutput.length && !hasTextOutput ? { outputUnavailable: true } : {}),
      normalized: {
        kind: "llm", messages: conversation, userMessage: lastUserText(conversation),
        systemPrompt: allMessages.filter((item) => item.role === "system").map((item) => item.content).filter(Boolean).join("\n\n"),
        model: text(attrs, "llm.response.model_name") ?? text(attrs, "llm.model_name") ?? text(attrs, "llm.request.model_name"),
      },
    };
  },
};

export const openInferenceToolAdapter: SpanAdapter = {
  name: "openinference-tool",
  apply(input) {
    if (input.spanType !== "TOOL_CALL" || input.attrs["openinference.span.kind"] !== "TOOL") return null;
    const attrs = input.attrs;
    const inputPayload = text(attrs, "input.value");
    const outputPayload = text(attrs, "output.value");
    const status = attrs["otel.status.code"];
    return {
      inputPayload, outputPayload,
      normalized: {
        kind: "tool", name: text(attrs, "tool.name") || input.spanName,
        args: parseJsonOrRaw(inputPayload), result: parseJsonOrRaw(outputPayload),
        resultIsError: status === 2 || status === "2" || status === "ERROR" || status === "STATUS_CODE_ERROR",
      },
    };
  },
};
