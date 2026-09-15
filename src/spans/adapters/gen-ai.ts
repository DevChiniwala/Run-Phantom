import type { SpanAdapter } from "./types";
import { parseJsonOrRaw } from "./helpers";

function payload(value: string | number | boolean | undefined): string | undefined {
  return value === undefined ? undefined : typeof value === "string" ? value : JSON.stringify(value);
}

// Runs after payload adapters so known metadata cannot hide a captured prompt.
export const genAiMetadataAdapter: SpanAdapter = {
  name: "gen-ai-metadata",
  apply(input) {
    if (input.spanType !== "LLM_GENERATION") return null;
    const operation = input.attrs["gen_ai.operation.name"];
    if (operation !== "chat" && operation !== "text_completion" && operation !== "generate_content") return null;
    const model = input.attrs["gen_ai.response.model"] ?? input.attrs["gen_ai.request.model"];
    return { normalized: { kind: "llm", messages: [], userMessage: "", systemPrompt: "", model: typeof model === "string" ? model : undefined } };
  },
};

export const genAiToolAdapter: SpanAdapter = {
  name: "gen-ai-tool",
  apply(input) {
    if (input.spanType !== "TOOL_CALL" || input.attrs["gen_ai.operation.name"] !== "execute_tool") return null;
    const attrs = input.attrs;
    const inputPayload = payload(attrs["gen_ai.tool.call.arguments"]);
    const outputPayload = payload(attrs["gen_ai.tool.call.result"]);
    const name = attrs["gen_ai.tool.name"];
    const status = attrs["otel.status.code"];
    const result = parseJsonOrRaw(outputPayload);
    return {
      inputPayload, outputPayload,
      normalized: {
        kind: "tool", name: typeof name === "string" && name ? name : input.spanName,
        args: parseJsonOrRaw(inputPayload), result,
        resultIsError: status === 2 || status === "2" || status === "ERROR" || status === "STATUS_CODE_ERROR"
          || !!(result && typeof result === "object" && "isError" in result && result.isError === true),
      },
    };
  },
};
