import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const generator = path.resolve(import.meta.dir, "../scripts/build-verification-sdk.ts");
function fixture(run: (root: string, output: string, invoke: (...args: string[]) => ReturnType<typeof Bun.spawnSync>) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdk freshness "));
  const script = path.join(root, "scripts", "build-verification-sdk.ts");
  const entry = path.join(root, "src", "verification", "browser", "index.ts");
  const output = path.join(root, "src", "verification", "browser-sdk.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.copyFileSync(generator, script);
  fs.writeFileSync(entry, 'export const fixture = "version-one";\n');
  const invoke = (...args: string[]) => Bun.spawnSync([process.execPath, script, ...args], { cwd: root, timeout: 10_000 });
  try { run(root, output, invoke); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe("browser SDK freshness through the real Bun generator", () => {
  test("writes LF output and verifies the unchanged artifact without rewriting it", () => {
    fixture((_root, output, invoke) => {
      expect(invoke().exitCode).toBe(0);
      const contents = fs.readFileSync(output, "utf8");
      expect(contents).toContain("version-one");
      expect(contents).not.toContain("\r");
      expect(invoke("--check").exitCode).toBe(0);
      expect(fs.readFileSync(output, "utf8")).toBe(contents);
    });
  });

  test.each(["\r\n", "\r"])("accepts equivalent %j line endings without rewriting them", newline => {
    fixture((_root, output, invoke) => {
      expect(invoke().exitCode).toBe(0);
      const contents = fs.readFileSync(output, "utf8").replaceAll("\n", newline);
      fs.writeFileSync(output, contents);
      expect(invoke("--check").exitCode).toBe(0);
      expect(fs.readFileSync(output, "utf8")).toBe(contents);
    });
  });

  test("rejects real content changes even when line endings differ", () => {
    fixture((_root, output, invoke) => {
      expect(invoke().exitCode).toBe(0);
      const changed = fs.readFileSync(output, "utf8").replace("version-one", "version-two").replaceAll("\n", "\r\n");
      fs.writeFileSync(output, changed);
      const result = invoke("--check");
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr?.toString()).toContain("stale");
      expect(fs.readFileSync(output, "utf8")).toBe(changed);
    });
  });

  test("missing output, source build errors and unsupported options fail closed", () => {
    fixture((root, output, invoke) => {
      expect(invoke("--check").exitCode).not.toBe(0);
      expect(fs.existsSync(output)).toBe(false);
      expect(invoke("--invalid").exitCode).not.toBe(0);
      fs.writeFileSync(path.join(root, "src", "verification", "browser", "index.ts"), "export const = ;");
      expect(invoke().exitCode).not.toBe(0);
      expect(fs.existsSync(output)).toBe(false);
    });
  });
});
