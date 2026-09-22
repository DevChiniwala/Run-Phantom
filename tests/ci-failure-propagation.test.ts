import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workflow = fs.readFileSync(path.resolve(import.meta.dir, "../.github/workflows/ci.yml"), "utf8");
const gates = [
  { target: "app", kind: "d", name: "app typecheck" },
  { target: "tests", kind: "d", name: "native tests" },
  { target: "scripts/embed-migrations.ts", kind: "f", name: "migration check" },
  { target: "app/vite.config.ts", kind: "f", name: "UI build" },
];
function command(target: string, kind: string): string {
  const line = workflow.split(/\r?\n/).find(line => line.includes("run:") && line.includes(`[ -${kind} ${target} ]`));
  const match = line?.trim().match(/^run: '(.*)'$/);
  if (!match) throw new Error(`Missing CI command for ${target}`);
  return match[1];
}

describe("CI failure propagation", () => {
  for (const gate of gates) {
    test(`${gate.name} separates missing targets from command failures`, () => {
      const run = command(gate.target, gate.kind);
      expect(run).toStartWith("if [ ");
      expect(run).toContain("; else echo ");
      expect(run).toEndWith("; fi");
      expect(run).not.toContain("|| echo");
    });

    for (const scenario of ["missing", "success", "failure"] as const) {
      test.skipIf(process.platform === "win32")(`${gate.name}: ${scenario} has the correct shell exit code`, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "ci-gate-"));
        try {
          const bin = path.join(root, "bin");
          fs.mkdirSync(bin);
          fs.writeFileSync(path.join(bin, "bun"), '#!/bin/sh\nprintf "CHECK_EXECUTED\\n"\nexit "$CHECK_EXIT"\n', { mode: 0o755 });
          if (scenario !== "missing") {
            const target = path.join(root, gate.target);
            if (gate.kind === "d") fs.mkdirSync(target, { recursive: true });
            else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, ""); }
          }
          const result = Bun.spawnSync(["bash", "-e", "-c", command(gate.target, gate.kind)], {
            cwd: root, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CHECK_EXIT: scenario === "failure" ? "37" : "0" },
            timeout: 5_000,
          });
          expect(result.exitCode).toBe(scenario === "failure" ? 37 : 0);
          expect(result.stdout.toString().includes("CHECK_EXECUTED")).toBe(scenario !== "missing");
          expect(result.stdout.toString().includes("skipped")).toBe(scenario === "missing");
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
      });
    }
  }
});
