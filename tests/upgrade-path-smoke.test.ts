import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const script = path.join(root, "scripts/upgrade-path-smoke.sh");
// The shell harness requires /bin/bash, executable fixtures, and POSIX signals.
const describePosix = process.platform === "win32" ? describe.skip : describe;
// Allow the 10s watchdog and 6s shutdown grace to finish before Bun times out.
const testTimeout = 20_000;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function listen() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { server, port: (server.address() as { port: number }).port };
}
async function freePort() {
  const { server, port } = await listen();
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
function fixture() {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "runphantom-upgrade-test-")));
  const baseline = path.join(directory, "baseline");
  const calls = path.join(directory, "calls.jsonl");
  const snapshot = path.join(directory, "snapshot.json");
  function binary(source: string) {
    const module = path.join(directory, "baseline.ts");
    writeFileSync(module, `import fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv[2]) + "\\n");\n${source}\n`);
    writeFileSync(baseline, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(module)} "$@"\n`, { mode: 0o700 });
  }
  return {
    directory, baseline, calls, snapshot, binary,
    commands: () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [],
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
async function run(f: ReturnType<typeof fixture>, port: number, commandPath = process.env.PATH!) {
  const child = spawn("/bin/bash", [script], {
    cwd: root,
    detached: true,
    env: {
      PATH: commandPath, HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME,
      TMPDIR: f.directory, PORT: String(port), RUNPHANTOM_BASELINE_BINARY: f.baseline,
      OPENAI_API_KEY: "synthetic-provider-canary", ANTHROPIC_API_KEY: "synthetic-provider-canary",
      RUNPHANTOM_SECRET_STORE_PATH: path.join(f.directory, "must-not-use-secrets.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.on("data", chunk => { output += chunk.toString(); });
  let timedOut = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceKill = setTimeout(() => {
      // Include descendants if Bash is stuck waiting for a foreground command.
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* Already exited. */ }
    }, 6_000);
  }, 10_000);
  try {
    const [code, signal] = await once(child, "close");
    if (timedOut) throw new Error(`Upgrade smoke harness timed out:\n${output}`);
    return { code, signal, output };
  } finally {
    clearTimeout(timer); clearTimeout(forceKill);
    if (timedOut && child.pid !== undefined) {
      // A timed-out shell may exit before its descendants release their handles.
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
    }
  }
}
async function unrelatedProcess() {
  const child = spawn(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });
  const exited = once(child, "exit");
  await once(child.stdout!, "data");
  return {
    child,
    close: async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await exited; },
  };
}

describePosix("upgrade smoke process isolation", () => {
  test("failed baseline validation never invokes stop or terminates an unrelated daemon", async () => {
    const f = fixture(), unrelated = await unrelatedProcess();
    try {
      f.binary(`if (process.argv[2] === "--version") process.exit(7);
if (process.argv[2] === "stop") process.kill(${unrelated.child.pid}, "SIGTERM");`);
      const result = await run(f, await freePort());
      expect(result.code).toBe(7);
      expect(f.commands()).toEqual(["--version"]);
      expect(unrelated.child.exitCode).toBeNull();
      expect(unrelated.child.signalCode).toBeNull();
    } finally { await unrelated.close(); f.cleanup(); }
  }, testTimeout);

  test("a busy non-HTTP port rejects before invoking the baseline or creating test state", async () => {
    const { server, port } = await listen();
    const f = fixture();
    try {
      f.binary("process.exit(7);");
      const before = readdirSync(f.directory).sort();
      const result = await run(f, port);
      expect(result.code).toBe(2);
      expect(result.output).toContain("already in use");
      expect(f.commands()).toEqual([]);
      expect(readdirSync(f.directory).sort()).toEqual(before);
      expect(server.listening).toBe(true);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); f.cleanup(); }
  }, testTimeout);

  for (const failure of ["startup", "seed", "stubborn-seed", "slow-stubborn-seed"] as const) {
    test(`${failure} failure removes only owned state and foreground process`, async () => {
      const f = fixture(), unrelated = await unrelatedProcess();
      try {
        f.binary(`
if (process.argv[2] === "--version") { console.log("fixture-baseline"); process.exit(0); }
if (process.argv[2] !== "serve") process.exit(9);
fs.writeFileSync(${JSON.stringify(f.snapshot)}, JSON.stringify({
  pid: process.pid, cwd: process.cwd(), home: process.env.HOME,
  db: process.env.RUNPHANTOM_DB_PATH, secrets: process.env.RUNPHANTOM_SECRET_STORE_PATH,
  bindHost: process.env.RUNPHANTOM_BIND_HOST, chat: process.env.RUNPHANTOM_CLAUDE_CLI_CHAT,
  hasProvider: !!(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY),
}));
${failure.includes("stubborn") ? 'process.on("SIGTERM", () => {});' : ""}
${failure === "startup" ? "process.exit(37);" : `Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.RUNPHANTOM_PORT), fetch(req) {
  return new URL(req.url).pathname === "/health"
    ? Response.json({ pid: process.pid, status: "ok" })
    : new Response("intentional fixture failure", { status: 500 });
} });`}
`);
        let commandPath = process.env.PATH!;
        if (failure === "slow-stubborn-seed") {
          const bin = path.join(f.directory, "slow-commands");
          mkdirSync(bin);
          writeFileSync(path.join(bin, "sleep"), "#!/bin/sh\nexec /bin/sleep 0.3\n", { mode: 0o700 });
          commandPath = `${bin}${path.delimiter}${commandPath}`;
        }
        const result = await run(f, await freePort(), commandPath);
        expect(result.code).toBe(1);
        expect(f.commands()).toEqual(["--version", "serve"]);
        const snapshot = JSON.parse(readFileSync(f.snapshot, "utf8")) as {
          pid: number; cwd: string; home?: string; db: string; secrets: string;
          bindHost: string; chat: string; hasProvider: boolean;
        };
        expect(snapshot.home).toBe(process.env.HOME);
        expect(snapshot.cwd.startsWith(`${f.directory}/runphantom-upgrade.`)).toBe(true);
        expect(snapshot.db).toBe(path.join(snapshot.cwd, "upgrade.db"));
        expect(snapshot.secrets).toBe(path.join(snapshot.cwd, "secrets.json"));
        expect(snapshot.bindHost).toBe("127.0.0.1");
        expect(snapshot.chat).toBe("0");
        expect(snapshot.hasProvider).toBe(false);
        expect(existsSync(snapshot.cwd)).toBe(false);
        expect(() => process.kill(snapshot.pid, 0)).toThrow();
        expect(unrelated.child.exitCode).toBeNull();
        expect(unrelated.child.signalCode).toBeNull();
      } finally { await unrelated.close(); f.cleanup(); }
    }, testTimeout);
  }
});
