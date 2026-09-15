import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { compareCapturedRuns, getRunComparison, RunComparisonError, type CapturedComparisonRun, type CapturedComparisonSpan } from "../src/run-comparison";
import { COMPARISON_FIELDS, RUN_COMPARISON_LIMITS as L, type RunComparison } from "../src/run-comparison-protocol";

function span(id: string, changes: Partial<CapturedComparisonSpan> = {}): CapturedComparisonSpan {
  return { id, run_id: "", parent_span_id: null, name: id, span_type: "TOOL_CALL", status: "OK", input_payload: '{"order":42}', output_payload: '{"ok":true}',
    model: "model-a", provider: "local", start_time_ms: 10, end_time_ms: 20, duration_ms: 10, input_tokens: 0, output_tokens: 0, attributes: null, ...changes };
}
function run(id: string, spans: CapturedComparisonSpan[]): CapturedComparisonRun { return { id, name: id, spans: spans.map(item => ({ ...item, run_id: id })) }; }
function compare(a: CapturedComparisonSpan[], b: CapturedComparisonSpan[], offset = 0, limit = 50) { return compareCapturedRuns(run("before", a), run("after", b), offset, limit); }
function reconciles(result: RunComparison) {
  const c = result.counts;
  expect(c.changed + c.unchanged + c.unavailable).toBe(c.paired);
  expect(c.paired + c.removed + c.ambiguousBaselineSpans).toBe(result.baseline.spanCount);
  expect(c.paired + c.added + c.ambiguousCandidateSpans).toBe(result.candidate.spanCount);
  expect(c.changed + c.unchanged + c.unavailable + c.added + c.removed + c.ambiguous).toBe(result.totalRows);
}
function memoryStore() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, name TEXT, display_name TEXT, event_name TEXT);
    CREATE TABLE spans (id TEXT, run_id TEXT, parent_span_id TEXT, name TEXT, span_type TEXT, status TEXT, input_payload TEXT, output_payload TEXT,
      model TEXT, provider TEXT, attributes TEXT, start_time_ms REAL, end_time_ms REAL, duration_ms REAL, input_tokens INTEGER, output_tokens INTEGER);
    CREATE TABLE saved_run_cache (id TEXT PRIMARY KEY, data TEXT);`);
  for (const id of ["before", "after"]) {
    db.prepare("INSERT INTO runs(id,name) VALUES (?,?)").run(id, id);
    const item = { ...span("tool"), run_id: id };
    const keys = Object.keys(item);
    db.prepare(`INSERT INTO spans (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(item));
  }
  return db;
}

describe("captured run comparison", () => {
  test("different IDs use explicit structural correspondence and preserve both span links", () => {
    const result = compare([span("old", { name: "checkout" })], [span("new", { name: "checkout" })]);
    expect(result.counts.unchanged).toBe(1); expect(result.rows[0].match).toBe("unique sibling key");
    expect(result.rows[0].baseline[0].href).toBe("/runs/before/span/old");
    expect(result.rows[0].candidate[0].href).toBe("/runs/after/span/new");
    expect(result.rows[0].fields).toHaveLength(COMPARISON_FIELDS.length); reconciles(result);
  });
  test.each([
    ["input_payload", '{"order":43}'], ["output_payload", '{"ok":false}'], ["status", "ERROR"], ["model", "model-b"],
    ["provider", "another"], ["span_type", "LLM_GENERATION"], ["input_tokens", 8], ["output_tokens", 3], ["duration_ms", 22],
  ] as const)("%s-only changes remain visible", (field, value) => {
    const result = compare([span("tool")], [span("tool", { [field]: value })]);
    expect(result.counts.changed).toBe(1);
    expect(result.rows[0].fields.filter(item => item.state === "changed").map(item => item.name)).toEqual([field]);
    if (field === "span_type") expect(result.rows[0].match).toBe("unique captured input");
    reconciles(result);
  });
  test("insertion and removal do not cascade into positional differences", () => {
    const result = compare([span("one"), span("removed"), span("two")], [span("added"), span("two"), span("one")]);
    expect(result.counts).toMatchObject({ paired: 2, unchanged: 2, changed: 0, added: 1, removed: 1, ambiguous: 0 }); reconciles(result);
  });
  test("unique repeated-call inputs align through reordering without output-based identity", () => {
    const a = [span("a", { name: "fetch", input_payload: "first", start_time_ms: 10 }), span("b", { name: "fetch", input_payload: "second", start_time_ms: 11 })];
    const b = [span("c", { name: "fetch", input_payload: "second", start_time_ms: 10 }), span("d", { name: "fetch", input_payload: "first", start_time_ms: 11, output_payload: "changed" })];
    const result = compare(a, b);
    expect(result.counts).toMatchObject({ paired: 2, changed: 1, unchanged: 1 });
    expect(result.rows.every(item => item.match === "unique captured input" && item.reordered)).toBe(true);
    expect(result.rows[0].candidate[0].id).toBe("d"); reconciles(result);
  });
  test.each([10, null])("tied or missing timestamps (%s) do not turn ID sorting into an order-change claim", started => {
    const result = compare([span("a", { name: "foo", start_time_ms: started }), span("b", { name: "bar", start_time_ms: started })],
      [span("z", { name: "foo", start_time_ms: started }), span("y", { name: "bar", start_time_ms: started })]);
    expect(result.rows.every(item => !item.reordered && !item.orderAvailable)).toBe(true);
    expect(result.warnings.some(warning => warning.includes("order comparison is unavailable"))).toBe(true); reconciles(result);
  });
  test("duplicate leftovers remain ambiguous, including their descendants", () => {
    const make = (prefix: string) => [span(`${prefix}1`, { name: "same" }), span(`${prefix}2`, { name: "same" }), span(`${prefix}3`, { parent_span_id: `${prefix}1`, name: "child" })];
    const result = compare(make("a"), make("b"));
    expect(result.counts).toMatchObject({ paired: 0, ambiguous: 1, ambiguousBaselineSpans: 3, ambiguousCandidateSpans: 3 });
    expect(result.rows[0].fields).toEqual([]); reconciles(result);
  });
  test("one remaining duplicate after a unique anchor is never guessed", () => {
    const result = compare([span("a", { name: "same", input_payload: "anchor" }), span("b", { name: "same", input_payload: "old" })],
      [span("c", { name: "same", input_payload: "anchor" }), span("d", { name: "same", input_payload: "new" })]);
    expect(result.counts).toMatchObject({ paired: 1, ambiguous: 1 }); reconciles(result);
  });
  test("missing kind or input cannot create an invented identity for duplicate siblings", () => {
    const result = compare([span("a", { name: "same", span_type: null }), span("b", { name: "same", input_payload: null })],
      [span("c", { name: "same", span_type: null }), span("d", { name: "same", input_payload: null })]);
    expect(result.counts).toMatchObject({ paired: 1, ambiguous: 1, unavailable: 1 });
    expect(result.rows.find(item => item.match)?.match).toBe("unique sibling key"); reconciles(result);
  });
  test("recursive calls and repeated names stay under their matched ancestor", () => {
    const a = [span("root"), span("nested", { name: "root", parent_span_id: "root", input_payload: "nested" }), span("leaf", { name: "fetch", parent_span_id: "nested" }), span("other"), span("other-leaf", { name: "fetch", parent_span_id: "other", output_payload: "elsewhere" })];
    const b = a.map(item => ({ ...item, id: `b:${item.id}`, parent_span_id: item.parent_span_id ? `b:${item.parent_span_id}` : null }));
    const result = compare(a, b); expect(result.counts.unchanged).toBe(5); reconciles(result);
    expect(result.rows.find(item => item.baseline[0].id === "leaf")?.candidate[0].id).toBe("b:leaf");
  });
  test("orphans, cycles, and depth excess stay unresolved with reconciled counts", () => {
    const a = [span("orphan", { parent_span_id: "missing" }), span("cycle-a", { parent_span_id: "cycle-b" }), span("cycle-b", { parent_span_id: "cycle-a" })];
    for (let index = 0; index <= L.depth; index++) a.push(span(`depth-${index}`, { parent_span_id: index ? `depth-${index - 1}` : null }));
    const result = compare(a, [], 0, 200); expect(result.baseline.complete).toBe(false);
    expect(result.rows.some(item => item.reason === "Missing parent span")).toBe(true);
    expect(result.rows.some(item => item.reason === "Cyclic ancestry")).toBe(true);
    expect(result.rows.some(item => item.reason === "Ancestry exceeds supported depth")).toBe(true); reconciles(result);
  });
  test("unknown numeric values are different from captured zero", () => {
    const result = compare([span("tool", { input_tokens: null })], [span("tool")]);
    expect(result.counts).toMatchObject({ unavailable: 1, unchanged: 0, changed: 0 });
    const field = result.rows[0].fields.find(item => item.name === "input_tokens")!;
    expect(field).toMatchObject({ state: "unavailable", baseline: { value: null, unavailable: "missing" }, candidate: { value: 0, unavailable: null }, delta: null });
    reconciles(result);
  });
  test("incomplete intervals never certify partial output or usage equality", () => {
    const result = compare([span("tool", { end_time_ms: null })], [span("tool", { end_time_ms: null })]);
    expect(result.baseline.complete).toBe(false);
    expect(result.rows[0].fields.find(item => item.name === "output_payload")?.baseline.unavailable).toBe("incomplete");
    expect(result.counts.unchanged).toBe(0); reconciles(result);
  });
  test("payload bytes preserve malformed JSON, whitespace, duplicate keys and large integers", () => {
    for (const [a, b] of [["{broken", "{other"], ['{"n":1}', '{ "n":1}'], ['{"n":9007199254740992}', '{"n":9007199254740993}'], ['{"x":1,"x":2}', '{"x":2}']]) {
      const result = compare([span("tool", { input_payload: a })], [span("tool", { input_payload: b })]);
      expect(result.rows[0].fields.find(item => item.name === "input_payload")?.state).toBe("changed");
    }
  });
  test.each(["[REDACTED]", "[TRUNCATED]", "[COMPACTED]", "[UNAVAILABLE]"])("%s is unavailable even on both sides", marker => {
    const result = compare([span("tool", { input_payload: marker })], [span("tool", { input_payload: marker })]);
    expect(result.rows[0].fields.find(item => item.name === "input_payload")?.state).toBe("unavailable");
  });
  test("whole payload identity is unavailable above its byte cap, and UTF-8 previews are exact", () => {
    const huge = "🧪".repeat(L.fieldBytes / 4 + 1);
    const result = compare([span("tool", { input_payload: huge, output_payload: "🧪".repeat(200) })], [span("tool", { input_payload: huge })]);
    expect(result.rows[0].fields.find(item => item.name === "input_payload")?.baseline.unavailable).toBe("oversized");
    const preview = result.rows[0].fields.find(item => item.name === "output_payload")!.baseline;
    expect(Buffer.byteLength(String(preview.value))).toBe(L.previewBytes); expect(preview.previewTruncated).toBe(true);
    expect(String(preview.value)).not.toContain("�");
  });
  test("all counts are computed before pagination and reconcile on every page", () => {
    const spans = Array.from({ length: 120 }, (_, n) => span(`tool-${n}`));
    const result = compare(spans, spans, 50, 50);
    expect(result).toMatchObject({ offset: 50, nextOffset: 100, totalRows: 120 }); expect(result.rows).toHaveLength(50);
    expect(result.counts.unchanged).toBe(120); reconciles(result);
  });
  test("maximum supported span count stays bounded and every span is accounted for", () => {
    const spans = Array.from({ length: L.spansPerRun }, (_, n) => span(`tool-${n}`));
    const result = compare(spans, spans);
    expect(result.counts.unchanged).toBe(L.spansPerRun); expect(result.rows).toHaveLength(50); reconciles(result);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(L.responseBytes);
  });
  test("span limits, identities and output escape expansion are bounded", () => {
    expect(() => compare(Array.from({ length: L.spansPerRun + 1 }, (_, n) => span(String(n))), [])).toThrow("span limit");
    expect(() => compareCapturedRuns(run("a", [span("x")]), { ...run("b", [span("x")]), spans: [span("x", { run_id: "wrong" })] })).toThrow("does not belong");
    const spans = Array.from({ length: 200 }, (_, n) => span(String(n), { input_payload: "\u0001".repeat(512), output_payload: "\u0001".repeat(512) }));
    expect(() => compare(spans, spans, 0, 200)).toThrow("response limit");
  });
});

describe("comparison SQL acquisition", () => {
  test("reads the same comparison without mutating stored evidence", () => {
    const db = memoryStore();
    try {
      const before = db.serialize();
      const result = getRunComparison(db, { baseline: "before", candidate: "after" });
      expect(result.counts.unchanged).toBe(1); expect(db.serialize()).toEqual(before); reconciles(result);
    } finally { db.close(); }
  });
  test("cached-only and empty persisted placeholders cannot silently replace displayed cached evidence", () => {
    const db = memoryStore();
    try {
      db.prepare("INSERT INTO saved_run_cache VALUES (?, ?)").run("cached", "opaque evidence not parsed");
      expect(() => getRunComparison(db, { baseline: "before", candidate: "cached" })).toThrow("Saved cache");
      db.prepare("INSERT INTO runs(id) VALUES (?)").run("cached");
      expect(() => getRunComparison(db, { baseline: "before", candidate: "cached" })).toThrow("saved cache");
      expect(() => getRunComparison(db, { baseline: "before", candidate: "missing" })).toThrow("no longer exists");
    } finally { db.close(); }
  });
  test.each(["name", "status", "input_payload", "attributes", "id", "parent_span_id", "model", "provider"])("preflights oversized span %s before loading rows", field => {
    const db = memoryStore();
    let materialized = false;
    try {
      db.exec(`UPDATE spans SET ${field} = printf('%.*c', ${L.acquiredBytes + 1}, 'x') WHERE run_id = 'after'`);
      const observed = new Proxy(db, { get(target, key) {
        if (key === "prepare") return (sql: string) => {
          if (/^SELECT id,/.test(sql)) materialized = true;
          return target.prepare(sql);
        };
        const member = Reflect.get(target, key); return typeof member === "function" ? member.bind(target) : member;
      } });
      expect(() => getRunComparison(observed, { baseline: "before", candidate: "after" })).toThrow("evidence limits");
      expect(materialized).toBe(false);
    } finally { db.close(); }
  });
  test("run names also participate in aggregate preflight", () => {
    const db = memoryStore();
    try { db.exec(`UPDATE runs SET display_name = printf('%.*c', ${L.acquiredBytes + 1}, 'x') WHERE id = 'before'`);
      expect(() => getRunComparison(db, { baseline: "before", candidate: "after" })).toThrow("evidence limits");
    } finally { db.close(); }
  });
  test("combined evidence budget applies across both runs before acquiring either", () => {
    const db = memoryStore();
    try { db.exec(`UPDATE spans SET attributes = printf('%.*c', ${L.acquiredBytes / 2}, 'x')`);
      expect(() => getRunComparison(db, { baseline: "before", candidate: "after" })).toThrow("evidence limits");
    } finally { db.close(); }
  });
  test("per-field acquisition withholding cannot recover partial equality from prefixes", () => {
    const db = memoryStore();
    try { db.exec(`UPDATE spans SET input_payload = printf('%.*c', ${L.fieldBytes + 1}, 'x')`);
      const result = getRunComparison(db, { baseline: "before", candidate: "after" });
      expect(result.rows[0].fields.find(item => item.name === "input_payload")).toMatchObject({ state: "unavailable", baseline: { value: null, unavailable: "oversized" } });
    } finally { db.close(); }
  });
  test.each([{ baseline: ["before"], candidate: "after" }, { baseline: "before", candidate: "after", limit: "0" }, { baseline: "before", candidate: "after", offset: "-1" }, { baseline: "before", candidate: "after", query: "unexpected" }])("rejects malformed query", query => {
    const db = memoryStore(); try { expect(() => getRunComparison(db, query)).toThrow(RunComparisonError); } finally { db.close(); }
  });
});
