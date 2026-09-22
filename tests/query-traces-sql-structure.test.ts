import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { _queryTracesInternal } from "../src/db";

const validate = _queryTracesInternal.assertReadOnlyTraceQuery;
function execute(sql: string): Record<string, unknown>[] {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE runs (id TEXT); CREATE TABLE spans (run_id TEXT); CREATE TABLE messages (content TEXT)");
    db.exec("INSERT INTO runs VALUES ('run'); INSERT INTO spans VALUES ('run'); INSERT INTO messages VALUES ('synthetic private chat')");
    return db.query(validate(sql)).all() as Record<string, unknown>[];
  } finally { db.close(true); }
}

describe("trace query SQL structure", () => {
  test.each([
    "SELECT * FROM (messages)",
    "SELECT * FROM ('messages')",
    "SELECT 'synthetic private chat' IN messages",
    "SELECT 'synthetic private chat' NOT IN messages",
    'SELECT 1 IN "messages"',
    "SELECT 1 IN main.runs",
    "SELECT 1 IN json_each('[]')",
    "SELECT * FROM (((messages)))",
    'SELECT * FROM ("messages")',
    "SELECT * FROM (runs, messages)",
    "SELECT * FROM ((runs), (messages))",
    "SELECT * FROM (((runs)), messages)",
    "SELECT * FROM (runs JOIN messages ON 1)",
    "SELECT * FROM (runs JOIN (messages) ON 1)",
    "SELECT * FROM (SELECT * FROM (messages))",
    "SELECT * FROM (runs), (messages)",
    "SELECT * FROM (main.runs)",
    "SELECT * FROM (sqlite_master)",
    "SELECT * FROM (saved_events)",
    "SELECT * FROM (json_each('[]'))",
  ])("rejects forbidden grouped sources: %s", sql => {
    expect(() => execute(sql)).toThrow(/trace-safe tables/);
  });

  test.each([
    "SELECT * FROM (runs)",
    "SELECT * FROM ('runs')",
    "SELECT * FROM (((runs)))",
    "SELECT * FROM (runs, spans)",
    "SELECT * FROM ((runs), spans)",
    "SELECT * FROM (((runs)), (spans))",
    "SELECT * FROM (runs JOIN spans ON runs.id = spans.run_id)",
    "SELECT * FROM (SELECT * FROM runs) r JOIN spans s ON r.id = s.run_id",
    "SELECT * FROM (runs r JOIN (SELECT * FROM spans) s ON r.id = s.run_id)",
  ])("preserves valid grouped trace sources: %s", sql => {
    expect(execute(sql)).toHaveLength(1);
  });

  for (const name of ["printf", "format", "randomblob", "zeroblob", "hex", "quote", "group_concat", "json_group_array", "json_group_object"]) {
    test.each([name, `"${name}"`, `'${name}'`, `\`${name}\``, `[${name}]`])("rejects output-amplifying function %s", spelling => {
      expect(() => validate(`SELECT ${spelling}/*comment*/('x') FROM runs`)).toThrow(/amplify output size/);
    });
  }

  test.each([
    ["SELECT 'ticket--42' AS value", "ticket--42"],
    ["SELECT 'https://host/a/*keep*/b' AS value", "https://host/a/*keep*/b"],
    ["SELECT 'a''--b/*c*/' AS value", "a'--b/*c*/"],
    ["SELECT 'printf; DROP TABLE messages' AS value", "printf; DROP TABLE messages"],
  ])("preserves literal bytes: %s", (sql, value) => {
    expect(execute(sql)).toEqual([{ value }]);
  });

  test("keeps comment markers inside quoted identifiers", () => {
    expect(execute('SELECT id AS "trace--id/*value*/" FROM runs')).toEqual([{ "trace--id/*value*/": "run" }]);
    expect(execute('SELECT id AS "a""--b" FROM runs')).toEqual([{ 'a"--b': "run" }]);
  });

  test("real comments separate tokens without changing literals", () => {
    expect(execute("SELECT/*separator*/id FROM/*separator*/runs; -- trailing comment")).toEqual([{ id: "run" }]);
    expect(execute("SELECT '/*literal*/' AS value /* real -- comment */")).toEqual([{ value: "/*literal*/" }]);
  });

  test("IN lists, subqueries and allowlisted bare sources remain legal", () => {
    expect(execute("SELECT 'run' IN runs AS value")).toEqual([{ value: 1 }]);
    expect(execute("SELECT 'run' IN ('run', 'other') AS value")).toEqual([{ value: 1 }]);
    expect(execute("SELECT 'run' IN (SELECT id FROM runs) AS value")).toEqual([{ value: 1 }]);
  });

  test("function names in ordinary literal values remain legal", () => {
    expect(execute("SELECT 'printf' AS value")).toEqual([{ value: "printf" }]);
    expect(execute("SELECT length('printf(') AS value")).toEqual([{ value: 7 }]);
  });

  test.each([
    "SELECT content FROM (runs AS window, messages)",
    "SELECT content FROM (runs window, messages)",
    "SELECT content FROM runs AS window, messages",
    "SELECT content FROM (runs AS window, (messages))",
    "SELECT content FROM (VALUES ((SELECT content FROM messages)))",
  ])("contextual aliases cannot hide forbidden sources: %s", sql => {
    expect(() => execute(sql)).toThrow(/trace-safe tables/);
  });

  test("VALUES subqueries and actual WINDOW clauses remain supported", () => {
    expect(execute("SELECT * FROM (VALUES (1), (2))")).toEqual([{ column1: 1 }, { column1: 2 }]);
    expect(execute("SELECT row_number() OVER w AS n FROM runs WINDOW w AS (), w2 AS ()")).toEqual([{ n: 1 }]);
    expect(execute("SELECT id FROM (runs AS window, spans)")).toEqual([{ id: "run" }]);
  });

  test("line comments terminate at LF, not a bare carriage return", () => {
    expect(execute("SELECT 1 AS value -- hidden\r, 2 AS extra\n")).toEqual([{ value: 1 }]);
    expect(execute("SELECT 1 AS value -- hidden\r, 2 AS extra")).toEqual([{ value: 1 }]);
    expect(execute("SELECT 'literal\r--text' AS value")).toEqual([{ value: "literal\r--text" }]);
  });

  test.each(["éwhere", "界union", "🚀where", "éwindow", "\u00a0where"])("Unicode aliases cannot split into clause keywords: %s", alias => {
    expect(() => execute(`SELECT content FROM (runs AS ${alias}, messages)`)).toThrow(/trace-safe tables/);
    expect(() => execute(`SELECT content FROM runs AS ${alias}, messages`)).toThrow(/trace-safe tables/);
  });

  test("single-quoted window and IN table names preserve SQLite semantics", () => {
    expect(execute("SELECT row_number() OVER w2 AS n FROM runs WINDOW 'w' AS (), w2 AS ()")).toEqual([{ n: 1 }]);
    expect(execute("SELECT 'run' IN 'runs' AS value")).toEqual([{ value: 1 }]);
    expect(() => execute("SELECT 'synthetic private chat' IN 'messages'")).toThrow(/trace-safe tables/);
  });
});
