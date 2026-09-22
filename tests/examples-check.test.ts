import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const manifest = fs.readFileSync(path.resolve(import.meta.dir, "../examples/package.json"), "utf8");

describe("examples aggregate check", () => {
  for (const [first, second] of [[0, 0], [17, 0], [0, 23]]) {
    test(`executes the real aggregate command and propagates child exits ${first}/${second}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "example checks "));
      try {
        fs.writeFileSync(path.join(root, "package.json"), manifest);
        for (const [folder, code] of [["openai-chat", first], ["anthropic-chat", second]] as const) {
          const dir = path.join(root, folder);
          fs.mkdirSync(dir);
          fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { check: "bun check.ts" } }));
          fs.writeFileSync(path.join(dir, "check.ts"), `import { writeFileSync } from "node:fs"; writeFileSync("../${folder}.ran", "yes"); process.exit(${code});`);
        }
        const result = Bun.spawnSync([process.execPath, "run", "check"], {
          cwd: root, env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` }, timeout: 10_000,
        });
        expect(result.exitCode).toBe(first || second);
        expect(fs.existsSync(path.join(root, "openai-chat.ran"))).toBe(true);
        expect(fs.existsSync(path.join(root, "anthropic-chat.ran"))).toBe(first === 0);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  }
});
