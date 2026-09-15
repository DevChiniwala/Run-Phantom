import { hasDuplicateJsonKeys } from "../json-keys";
import { parseJsonEvidence } from "../evaluations/json-evidence";

/** Completion of captured output is separate from a span's ended timestamp. */
export type OutputCompletion = "not-streaming" | "confirmed" | "unconfirmed";
const MAX_CAPTURE_BYTES = 64 * 1024;
const unavailable = /\[(?:REDACTED|TRUNCATED|UNAVAILABLE|UNSERIALIZABLE|CIRCULAR|COMPACTED)\]|__REDACTED__/i;
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function decoded(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (new TextEncoder().encode(value).byteLength > MAX_CAPTURE_BYTES) return null;
  try {
    const parsed: unknown = parseJsonEvidence(value);
    return hasDuplicateJsonKeys(value) ? null : parsed;
  } catch { return null; }
}
function finish(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && !unavailable.test(value);
}

/** Only explicit streaming telemetry requires a captured provider finish marker.
 * A finish reason for one choice cannot certify another captured choice.
 * This does not diagnose interruption or infer completion from usage counts. */
export function outputCompletionEvidence(attributes: unknown, attributesAvailable = true): OutputCompletion {
  if (!attributesAvailable) return "unconfirmed";
  const attrs = typeof attributes === "string" ? decoded(attributes) : attributes;
  if (typeof attributes === "string" && !object(attrs)) return "unconfirmed";
  if (!object(attrs) || !Object.hasOwn(attrs, "gen_ai.is_streaming")) return "not-streaming";
  const streaming = attrs["gen_ai.is_streaming"];
  if (streaming === false || streaming === "false") return "not-streaming";
  if (streaming !== true && streaming !== "true") return "unconfirmed";
  let requiredChoices = 1;
  for (const key of ["gen_ai.request.choice.count", "gen_ai.request.n"]) {
    if (!Object.hasOwn(attrs, key)) continue;
    const raw = attrs[key];
    const count = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) return "unconfirmed";
    requiredChoices = Math.max(requiredChoices, count);
  }
  const hasReasons = Object.hasOwn(attrs, "gen_ai.response.finish_reasons");
  const reasons = decoded(attrs["gen_ai.response.finish_reasons"]);
  if (hasReasons && (!Array.isArray(reasons) || reasons.length < requiredChoices || !reasons.every(finish))) return "unconfirmed";
  if (Object.hasOwn(attrs, "gen_ai.output.messages")) {
    const messages = decoded(attrs["gen_ai.output.messages"]);
    if (hasReasons && Array.isArray(messages) && Array.isArray(reasons) && messages.length !== reasons.length) return "unconfirmed";
    return Array.isArray(messages) && messages.length >= requiredChoices && messages.every(message => object(message) && finish(message.finish_reason))
      ? "confirmed" : "unconfirmed";
  }
  return Array.isArray(reasons) && reasons.length >= requiredChoices && reasons.every(finish) ? "confirmed" : "unconfirmed";
}
