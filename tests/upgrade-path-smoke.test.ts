import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
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
async function run(f: ReturnType<typeof fixture>, port: number, commandPath = process.env.PATH!, interruptWhen?: string) {
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
  let interruptedAt: number | undefined;
  const interruptTimer = interruptWhen ? setInterval(() => {
    if (interruptedAt === undefined && existsSync(interruptWhen)) {
      interruptedAt = Date.now();
      child.kill("SIGTERM");
    }
  }, 10) : undefined;
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
    return { code, signal, output, cancellationMs: interruptedAt === undefined ? undefined : Date.now() - interruptedAt };
  } finally {
    clearTimeout(timer); clearTimeout(forceKill); clearInterval(interruptTimer);
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
  test("capture preserves output, stderr, failure status, and the previous value on failure", () => {
    const f = fixture();
    try {
      const source = readFileSync(script, "utf8");
      const helpers = source.slice(source.indexOf("run_tracked()"), source.indexOf('echo "── 1/8'));
      const result = spawnSync("/bin/bash", ["-c", `
${source.slice(0, source.indexOf("REPO_ROOT="))}
TEST_ROOT=${quote(f.directory)}
DAEMON_PID=""
DAEMON_LOG=""
COMMAND_PID=""
${helpers}
capture_tracked value /bin/bash -c 'printf "first\\nsecond\\n\\n"; printf "diagnostic\\n" >&2'
[ "$value" = $'first\\nsecond' ]
status=0
capture_tracked value /bin/bash -c 'printf discarded; exit 23' || status=$?
[ "$status" -eq 23 ]
[ "$value" = $'first\\nsecond' ]
[ -z "$COMMAND_PID" ]
`], { encoding: "utf8", timeout: 5000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("diagnostic");
    } finally { f.cleanup(); }
  });

  for (const capture of [false, true]) {
    for (const interrupt of [false, true]) {
      test(`${capture ? "capture" : "run"} owns descendants after ${interrupt ? "build interruption" : "driver exit"}`, async () => {
        const f = fixture(), unrelated = await unrelatedProcess();
        const descendantFile = path.join(f.directory, "descendant.pid");
        const driverFile = path.join(f.directory, "driver.pid");
        const groupFile = path.join(f.directory, "group.pid");
        const descendant = path.join(f.directory, "descendant.ts");
        const driver = path.join(f.directory, "driver.ts");
        const harness = path.join(f.directory, "harness.sh");
        let child: ReturnType<typeof spawn> | undefined;
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        let poll: ReturnType<typeof setInterval> | undefined;
        try {
          writeFileSync(descendant, `import fs from "node:fs";
process.on("SIGTERM", () => {});
fs.writeFileSync(${JSON.stringify(descendantFile)}, String(process.pid));
setInterval(() => {}, 1000);
`);
          writeFileSync(driver, `import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
fs.writeFileSync(${JSON.stringify(driverFile)}, String(process.pid));
${interrupt ? `spawnSync(process.execPath, [${JSON.stringify(descendant)}], { stdio: "ignore" });` : `
const child = spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: "ignore" });
child.unref();
const deadline = Date.now() + 3000;
while (!fs.existsSync(${JSON.stringify(descendantFile)}) && Date.now() < deadline) Bun.sleepSync(10);
process.exit(7);`}
`);
          // Exercise the production functions, without needing a baseline or TCP.
          const source = readFileSync(script, "utf8");
          const helpers = source.slice(source.indexOf("run_tracked()"), source.indexOf('echo "── 1/8'))
            .replace("COMMAND_PID=$!", `COMMAND_PID=$!; printf '%s\\n' "$COMMAND_PID" > ${quote(groupFile)}`);
          writeFileSync(harness, `#!/bin/bash
${source.slice(0, source.indexOf("REPO_ROOT="))}
TEST_ROOT=${quote(f.directory)}
DAEMON_PID=""
DAEMON_LOG=""
COMMAND_PID=""
${helpers}
${capture ? "capture_tracked result" : "run_tracked"} ${quote(process.execPath)} ${quote(driver)}
`);
          child = spawn("/bin/bash", [harness], { stdio: ["ignore", "ignore", "pipe"] });
          let output = "";
          child.stderr!.on("data", chunk => { output += chunk.toString(); });
          const closed = once(child, "close");
          let signalled = false;
          let groupTargetVerified = false;
          poll = setInterval(() => {
            if (!existsSync(descendantFile) || signalled) return;
            signalled = true;
            if (interrupt) {
              const pid = Number(readFileSync(groupFile, "utf8"));
              try { process.kill(-pid, 0); groupTargetVerified = true; } catch { /* Assert below. */ }
              child!.kill("SIGTERM");
            }
          }, 10);
          watchdog = setTimeout(() => child!.kill("SIGKILL"), 8000);
          const [code, signal] = await closed;
          expect(signal).toBeNull();
          expect(code, output).toBe(interrupt ? 143 : 7);
          const pid = Number(readFileSync(descendantFile, "utf8"));
          const driverPid = Number(readFileSync(driverFile, "utf8"));
          if (interrupt) {
            expect(groupTargetVerified).toBe(true);
            const pgid = Number(readFileSync(groupFile, "utf8"));
            expect(pgid).toBeGreaterThan(1);
            expect(() => process.kill(-pgid, 0)).toThrow();
          }
          // These assertions precede all rescue cleanup, including on failure.
          expect(pid).toBeGreaterThan(1);
          expect(() => process.kill(pid, 0)).toThrow();
          expect(() => process.kill(driverPid, 0)).toThrow();
          expect(() => process.kill(unrelated.child.pid!, 0)).not.toThrow();
        } finally {
          clearTimeout(watchdog); clearInterval(poll);
          child?.kill("SIGKILL");
          for (const file of [descendantFile, driverFile]) {
            if (!existsSync(file)) continue;
            const pid = Number(readFileSync(file, "utf8"));
            if (Number.isInteger(pid) && pid > 1) {
              try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ }
            }
          }
          await unrelated.close(); f.cleanup();
        }
      }, testTimeout);
    }
  }

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

  for (const phase of ["shutdown", "version", "seed", "http"] as const) {
    test(`TERM during ${phase} reaps owned children within a bound`, async () => {
      const f = fixture(), unrelated = await unrelatedProcess();
      const marker = path.join(f.directory, "interrupt-ready");
      const operationPid = path.join(f.directory, "operation.pid");
      const stall = `process.on("SIGTERM", () => {});
fs.writeFileSync(${JSON.stringify(operationPid)}, String(process.pid));
fs.writeFileSync(${JSON.stringify(marker)}, "ready");
setInterval(() => {}, 1000);`;
      try {
        f.binary(`
if (process.argv[2] === "--version") {
  ${phase === "version" ? stall : 'console.log("fixture-baseline"); process.exit(0);'}
} else {
  if (process.argv[2] !== "serve") process.exit(9);
  fs.writeFileSync(${JSON.stringify(f.snapshot)}, JSON.stringify({ pid: process.pid, cwd: process.cwd() }));
  process.on("SIGTERM", () => {
    ${phase === "shutdown" ? `fs.writeFileSync(${JSON.stringify(marker)}, "grace period active");` : ""}
  });
  Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.RUNPHANTOM_PORT), fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ pid: process.pid });
    ${phase === "http" ? `fs.writeFileSync(${JSON.stringify(marker)}, "HTTP request active"); return new Promise(() => {});` : `
    if (url.pathname === "/api/runs") return Response.json([{}, {}, {}]);
    return Response.json({ run: { event_name: "synthetic" }, spans: [{}] });`}
  } });
}
`);
        const bin = path.join(f.directory, "commands");
        mkdirSync(bin);
        const seed = path.join(f.directory, "seed.ts");
        writeFileSync(seed, `import fs from "node:fs";\n${phase === "seed" ? stall : "process.exit(0);"}`);
        writeFileSync(path.join(bin, "bun"), `#!/bin/sh
case "$1" in
  */scripts/seed-traces.ts) exec ${quote(process.execPath)} ${quote(seed)} ;;
  *) exec ${quote(process.execPath)} "$@" ;;
esac
`, { mode: 0o700 });
        // Record the real curl PID; cancellation must reap the active request too.
        writeFileSync(path.join(bin, "curl"), `#!/bin/sh
case "$*" in
  */api/*) echo "$$" > ${quote(operationPid)} ;;
esac
exec /usr/bin/curl "$@"
`, { mode: 0o700 });
        const result = await run(f, await freePort(), `${bin}${path.delimiter}${process.env.PATH}`, marker);
        expect(result.code).toBe(143);
        expect(result.signal).toBeNull();
        expect(result.cancellationMs).toBeDefined();
        expect(result.cancellationMs!).toBeLessThan(7_000);
        expect(f.commands()).toEqual(phase === "version" ? ["--version"] : ["--version", "serve"]);
        if (phase !== "version") {
          const snapshot = JSON.parse(readFileSync(f.snapshot, "utf8"));
          expect(() => process.kill(snapshot.pid, 0)).toThrow();
          expect(existsSync(snapshot.cwd)).toBe(false);
        }
        if (phase !== "shutdown") {
          const pid = Number(readFileSync(operationPid, "utf8"));
          expect(pid).toBeGreaterThan(0);
          expect(() => process.kill(pid, 0)).toThrow();
        }
        expect(readdirSync(f.directory).filter(name => name.startsWith("runphantom-upgrade."))).toEqual([]);
        expect(unrelated.child.exitCode).toBeNull();
        expect(unrelated.child.signalCode).toBeNull();
      } finally {
        // Failed assertions must not leak synthetic fixtures. This happens only
        // after checking their liveness; rescue cleanup cannot satisfy the test.
        const pids = [
          existsSync(f.snapshot) ? JSON.parse(readFileSync(f.snapshot, "utf8")).pid : undefined,
          existsSync(operationPid) ? Number(readFileSync(operationPid, "utf8")) : undefined,
        ];
        for (const pid of pids) {
          if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ }
          }
        }
        await unrelated.close(); f.cleanup();
      }
    }, testTimeout);
  }

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
