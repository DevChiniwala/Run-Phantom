import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, getDrizzleDb } from "../src/db";

test("closing the database releases its files for profile cleanup", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runphantom-db-close-"));
  const previous = process.env.RUNPHANTOM_DB_PATH;
  try {
    process.env.RUNPHANTOM_DB_PATH = path.join(directory, "runphantom.db");
    getDrizzleDb();
    closeDb();
    fs.rmSync(directory, { recursive: true, force: true });
    expect(fs.existsSync(directory)).toBe(false);
  } finally {
    closeDb();
    if (previous === undefined) delete process.env.RUNPHANTOM_DB_PATH;
    else process.env.RUNPHANTOM_DB_PATH = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
