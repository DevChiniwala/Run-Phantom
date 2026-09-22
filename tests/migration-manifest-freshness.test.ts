import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const generator = path.resolve(import.meta.dir, "../scripts/embed-migrations.ts");
function fixture(run: (root: string, output: string, invoke: (...args: string[]) => ReturnType<typeof Bun.spawnSync>) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "migration manifest "));
  const script = path.join(root, "scripts", "embed-migrations.ts");
  const output = path.join(root, "src", "db", "migration-assets.ts");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(path.join(root, "drizzle", "meta"), { recursive: true });
  fs.copyFileSync(generator, script);
  fs.writeFileSync(path.join(root, "drizzle", "meta", "_journal.json"), JSON.stringify({
    version: "7", dialect: "sqlite", entries: [{ idx: 0, tag: "0000_fixture", when: 123, breakpoints: true }],
  }));
  fs.writeFileSync(path.join(root, "drizzle", "0000_fixture.sql"), "SELECT 1;\r\n");
  const invoke = (...args: string[]) => Bun.spawnSync([process.execPath, script, ...args], { cwd: root, timeout: 10_000 });
  try { run(root, output, invoke); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe("embedded migration manifest freshness", () => {
  test("accepts a CRLF checkout without rewriting the manifest or SQL bytes", () => {
    fixture((root, output, invoke) => {
      expect(invoke().exitCode).toBe(0);
      const generated = fs.readFileSync(output, "utf8");
      expect(generated).not.toContain("\r");
      expect(generated).toContain("../../drizzle/0000_fixture.sql");
      const checkout = generated.replaceAll("\n", "\r\n");
      fs.writeFileSync(output, checkout);
      expect(invoke("--check").exitCode).toBe(0);
      expect(fs.readFileSync(output, "utf8")).toBe(checkout);
      expect(fs.readFileSync(path.join(root, "drizzle", "0000_fixture.sql"), "utf8")).toBe("SELECT 1;\r\n");
    });
  });

  test("line ending equivalence cannot hide a changed journal or generated import", () => {
    fixture((root, output, invoke) => {
      expect(invoke().exitCode).toBe(0);
      const generated = fs.readFileSync(output, "utf8");
      fs.writeFileSync(output, generated.replace("../../drizzle/0000_fixture.sql", "../../drizzle/wrong.sql").replaceAll("\n", "\r\n"));
      expect(invoke("--check").exitCode).toBe(1);
      fs.writeFileSync(output, generated);
      const journalPath = path.join(root, "drizzle", "meta", "_journal.json");
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      journal.entries[0].when++;
      fs.writeFileSync(journalPath, JSON.stringify(journal));
      expect(invoke("--check").exitCode).toBe(1);
      expect(fs.readFileSync(output, "utf8")).toBe(generated);
    });
  });

  test("missing output and missing journaled SQL still reject", () => {
    fixture((root, output, invoke) => {
      expect(invoke("--check").exitCode).toBe(1);
      expect(fs.existsSync(output)).toBe(false);
      expect(invoke().exitCode).toBe(0);
      fs.unlinkSync(path.join(root, "drizzle", "0000_fixture.sql"));
      expect(invoke("--check").exitCode).not.toBe(0);
    });
  });
});
