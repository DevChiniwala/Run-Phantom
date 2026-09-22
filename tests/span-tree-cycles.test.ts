import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

// realpath because macOS reports a symlinked tmpdir; a bare "/private/tmp" literal
// is a macOS-ism that cannot be created on Linux CI.
let directory: string;
let DB: string;

const { upsertRun, insertSpan, getRunOutline, closeDb } = await import("../src/db");

// Every test file in the suite shares one process AND one memoised db handle
// (db.ts caches _dbPath on first open), so pointing the module at this fixture
// leaks into any later file that asserts on the default state path. Scope the
// env override to seeding, then closeDb() in afterAll to drop the memoised path.
function withFixtureDb(fn: () => void): void {
  const original = process.env.RUNPHANTOM_DB_PATH;
  process.env.RUNPHANTOM_DB_PATH = DB;
  try { fn(); }
  finally {
    if (original === undefined) delete process.env.RUNPHANTOM_DB_PATH;
    else process.env.RUNPHANTOM_DB_PATH = original;
  }
}

afterAll(() => {
  closeDb();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

function seed(runId: string, spans: { id: string; parent?: string; name: string }[]) {
  const now = Date.now();
  upsertRun({ id: runId, name: runId, started_at: now, last_updated_at: now });
  spans.forEach((s, i) =>
    insertSpan({ id: s.id, run_id: runId, parent_span_id: s.parent, name: s.name,
      start_time_ms: now + i, end_time_ms: now + i + 1, duration_ms: 1 }));
}

describe("outline depth on malformed parent chains", () => {
  // Nothing in OTLP forbids a span naming a descendant as its parent, and the
  // recursive depth walk overflowed the stack on one, taking the run's outline
  // to a 500 for good.
  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rp-cycles-"));
    DB = path.join(directory, "cycle-test.db");
    closeDb();
    withFixtureDb(() => {
    seed("cycle2", [{ id: "a", parent: "b", name: "A" }, { id: "b", parent: "a", name: "B" }]);
    seed("selfref", [{ id: "s", parent: "s", name: "S" }]);
    seed("cycle3", [
      { id: "c1", parent: "c3", name: "C1" }, { id: "c2", parent: "c1", name: "C2" },
      { id: "c3", parent: "c2", name: "C3" }, { id: "leaf", parent: "c3", name: "leaf" },
    ]);
    seed("normal", [
      { id: "r", name: "root" }, { id: "k1", parent: "r", name: "kid1" },
      { id: "k2", parent: "k1", name: "kid2" },
    ]);
    // Force the lazy connection open while the fixture path is still in effect.
    getRunOutline("normal");
    });
  });

  test("a two-span cycle returns finite depths instead of overflowing", () => {
    const spans = getRunOutline("cycle2").spans;
    expect(spans).toHaveLength(2);
    for (const s of spans) expect(Number.isFinite(s.depth)).toBe(true);
  });

  test("a self-parenting span terminates", () => {
    expect(getRunOutline("selfref").spans[0].depth).toBeLessThan(10);
  });

  test("a longer cycle terminates and its non-cyclic child still resolves", () => {
    const spans = getRunOutline("cycle3").spans;
    expect(spans).toHaveLength(4);
    for (const s of spans) expect(Number.isFinite(s.depth)).toBe(true);
  });

  test("well-formed trees keep their exact depths", () => {
    const byName = Object.fromEntries(getRunOutline("normal").spans.map((s) => [s.name, s.depth]));
    expect(byName).toEqual({ root: 0, kid1: 1, kid2: 2 });
  });
});
