import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const runner = pathToFileURL(path.resolve(import.meta.dir, "../scripts/dev.ts")).href;
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
async function until(check: () => boolean, timeout = 3_000) {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await Bun.sleep(10);
  expect(check()).toBe(true);
}

// Real local processes only; every recorded PID is also cleaned up on assertion failure.
describe("development process lifecycle", () => {
  async function scenario(mode: string, action?: NodeJS.Signals, exitCode = 0) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runphantom dev lifecycle "));
    const pidsFile = path.join(root, "pids");
    const ready = path.join(root, "ready");
    const trigger = path.join(root, "exit");
    const pids = () => fs.existsSync(pidsFile)
      ? fs.readFileSync(pidsFile, "utf8").trim().split("\n").filter(Boolean).map(Number) : [];
    fs.writeFileSync(path.join(root, "child.ts"), `
      import fs from 'node:fs';
      const [mode, pids, ready, trigger, code] = process.argv.slice(2);
      if (mode === 'tree') {
        const child = Bun.spawn([process.execPath, '-e',
          "process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(" + JSON.stringify(ready) + ", 'ready'); setInterval(() => {}, 1000)"],
          { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
        fs.appendFileSync(pids, child.pid + '\\n');
      }
      if (mode === 'stubborn') {
        process.on('SIGINT', () => {}); process.on('SIGTERM', () => {});
      }
      if (mode !== 'tree') fs.writeFileSync(ready, 'ready');
      setInterval(() => {
        if (fs.existsSync(trigger)) {
          if (Number(code) === 143) process.kill(process.pid, 'SIGTERM');
          else process.exit(Number(code));
        }
      }, 10);
    `);
    const commands = [
      { label: "daemon", cmd: [process.execPath, "child.ts", mode, pidsFile, ready, trigger, String(exitCode)], cwd: root },
      { label: "UI", cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"], cwd: mode === "startup-error" ? path.join(root, "missing") : root },
    ];
    fs.writeFileSync(path.join(root, "runner.ts"), `
      import fs from 'node:fs';
      import { runDev } from ${JSON.stringify(runner)};
      const spawn = Bun.spawn;
      Bun.spawn = (...args) => {
        const child = spawn(...args);
        fs.appendFileSync(${JSON.stringify(pidsFile)}, child.pid + '\\n');
        return child;
      };
      await runDev(${JSON.stringify(commands)}, 150);
    `);
    const parent = Bun.spawn([process.execPath, path.join(root, "runner.ts")], {
      stdin: "ignore", stdout: "ignore", stderr: "pipe",
    });
    try {
      if (mode !== "startup-error") {
        await until(() => fs.existsSync(ready) && pids().length >= (mode === "tree" ? 3 : 2));
        if (action) {
          parent.kill(action);
          // A second signal during shutdown must not interrupt cleanup or change status.
          await Bun.sleep(20);
          if (alive(parent.pid)) parent.kill(action);
        } else fs.writeFileSync(trigger, "exit");
      }
      const result = await Promise.race([parent.exited, Bun.sleep(3_000).then(() => "timeout")]);
      expect(result).toBe(mode === "startup-error" ? 1 : action ? 0 : exitCode);
      expect(pids().length).toBeGreaterThanOrEqual(mode === "startup-error" ? 1 : 2);
      await until(() => pids().every(pid => !alive(pid)));
    } finally {
      for (const pid of pids()) {
        try { process.kill(-pid, "SIGKILL"); } catch { /* group may be gone */ }
        try { process.kill(pid, "SIGKILL"); } catch { /* process may be gone */ }
      }
      parent.kill("SIGKILL");
      await parent.exited;
      await new Response(parent.stderr).text();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  test("cleans up the first sibling when the second spawn throws", () => scenario("startup-error"));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test.skipIf(process.platform === "win32")(`cleans up grandchildren on repeated ${signal}`, () => scenario("tree", signal));
    test.skipIf(process.platform === "win32")(`force-kills an uncooperative child on ${signal}`, () => scenario("stubborn", signal));
  }
  for (const code of [0, 7, 143]) {
    test.skipIf(process.platform === "win32" && code === 143)(`preserves child exit ${code} and cleans up its descendants and sibling`, () => scenario("tree", undefined, code));
  }
});
