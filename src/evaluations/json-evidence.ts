/** JSON numeric evidence must retain its decimal value through JavaScript and storage. */
export class LossyJsonNumberError extends Error {
  constructor() { super("JSON numbers must be representable without rounding, underflow or overflow."); this.name = "LossyJsonNumberError"; }
}

function decimal(token: string): string {
  const parts = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token)!;
  let digits = (parts[2] + (parts[3] ?? "")).replace(/^0+/, "");
  if (!digits) return "0";
  const exponent = Number(parts[4] ?? 0) - (parts[3]?.length ?? 0);
  if (!Number.isSafeInteger(exponent)) throw new LossyJsonNumberError();
  const trailing = /0+$/.exec(digits)?.[0].length ?? 0;
  if (trailing) digits = digits.slice(0, -trailing);
  return `${parts[1]}${digits}e${exponent + trailing}`;
}

/** Inspect tokens outside JSON strings before a transport/parser can round them. Syntax is validated by JSON.parse. */
export function assertLosslessJsonNumbers(text: string): void {
  const tokens = /"(?:[^"\\]|\\[\s\S])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  for (const [token] of text.matchAll(tokens)) {
    if (token.startsWith('"')) continue;
    const value = Number(token);
    if (!Number.isFinite(value) || decimal(token) !== decimal(String(value))) throw new LossyJsonNumberError();
  }
}

export function parseJsonEvidence(text: string): unknown {
  const value: unknown = JSON.parse(text);
  assertLosslessJsonNumbers(text);
  return value;
}
