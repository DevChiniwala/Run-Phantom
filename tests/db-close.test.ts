import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, getDbPath, getDrizzleDb, queryTraces, upsertRun } from "../src/db";

function withFixtureDb(check: (directory: string, dbPath: string) => void) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runphantom-db-close-"));
  const dbPath = path.join(directory, "runphantom.db");
  const previous = process.env.RUNPHANTOM_DB_PATH;
  try {
    closeDb();
    process.env.RUNPHANTOM_DB_PATH = dbPath;
    check(directory, dbPath);
  } finally {
    closeDb();
    if (previous === undefined) delete process.env.RUNPHANTOM_DB_PATH;
    else process.env.RUNPHANTOM_DB_PATH = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("closing the database releases its files for profile cleanup", () => {
  withFixtureDb((directory, dbPath) => {
    getDrizzleDb();
    expect(fs.statSync(dbPath).isFile()).toBe(true);
    expect(getDbPath()).toBe(dbPath);
    closeDb();
    fs.rmSync(directory, { recursive: true });
    expect(fs.existsSync(directory)).toBe(false);
  });
});

test("the cleanup fixture replaces an already-cached connection", () => {
  withFixtureDb((_directory, previousPath) => {
    const previousDb = getDrizzleDb();
    expect(fs.statSync(previousPath).isFile()).toBe(true);

    withFixtureDb((_fixtureDirectory, fixturePath) => {
      const fixtureDb = getDrizzleDb();
      expect(fs.statSync(fixturePath).isFile()).toBe(true);
      expect(getDbPath()).toBe(fixturePath);
      expect(fixtureDb).not.toBe(previousDb);
      expect(() => previousDb.$client.exec("SELECT 1")).toThrow();
    });
  });
});

test("closing repeatedly is harmless and reopening preserves committed data", () => {
  withFixtureDb((_directory, dbPath) => {
    closeDb();
    closeDb();
    expect(fs.existsSync(dbPath)).toBe(false);

    const first = getDrizzleDb();
    expect(getDrizzleDb()).toBe(first);
    upsertRun({ id: "persisted-run", name: "Before close", started_at: 1, last_updated_at: 2 });
    expect(fs.statSync(dbPath).isFile()).toBe(true);
    closeDb();
    closeDb();
    expect(() => first.$client.exec("SELECT 1")).toThrow();

    const reopened = getDrizzleDb();
    expect(reopened).not.toBe(first);
    expect(reopened.$client).not.toBe(first.$client);
    expect(getDbPath()).toBe(dbPath);
    expect(queryTraces("SELECT id, name FROM runs").rows).toEqual([
      { id: "persisted-run", name: "Before close" },
    ]);
    upsertRun({ id: "persisted-run", name: "After reopen", started_at: 1, last_updated_at: 3 });
    closeDb();
    expect(queryTraces("SELECT name FROM runs").rows).toEqual([{ name: "After reopen" }]);
  });
});

test("close clears a cached path even when no connection was opened", () => {
  withFixtureDb((directory, dbPath) => {
    expect(getDbPath()).toBe(dbPath);
    closeDb();
    const nextPath = path.join(directory, "next.db");
    process.env.RUNPHANTOM_DB_PATH = nextPath;
    expect(getDbPath()).toBe(nextPath);
    getDrizzleDb();
    expect(fs.statSync(nextPath).isFile()).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(false);
  });
});

test("Windows GC branch collects only when closing an open database", () => {
  withFixtureDb((_directory, dbPath) => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    // Exercise branch logic on every host; this does not simulate Windows file locking.
    const gc = spyOn(Bun, "gc");
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      closeDb();
      getDbPath();
      closeDb();
      expect(gc).not.toHaveBeenCalled();

      getDrizzleDb();
      expect(fs.statSync(dbPath).isFile()).toBe(true);
      closeDb();
      expect(gc).toHaveBeenCalledTimes(1);
      expect(gc).toHaveBeenCalledWith(true);
      closeDb();
      expect(gc).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, "platform", platform);
      gc.mockRestore();
    }
  });
});
