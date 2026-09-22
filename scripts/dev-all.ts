#!/usr/bin/env bun
/**
 * dev-all: bring up the Run Phantom daemon + every example app on stable, distinct
 * ports for end-to-end testing in a browser.
 *
 * Run it from the repository root:
 *
 *   bun run dev:examples
 *
 * What it does:
 *   1. Starts the Run Phantom daemon in-process on $RUNPHANTOM_PORT (default 5947).
 *      Run Phantom UI:     http://localhost:5947
 *      Trace ingest:       http://localhost:5947/v1/traces
 *      MCP (stdio):        bun src/index.ts mcp
 *   2. Spawns every example app under examples/ as a child `bun` process,
 *      each with a stable port and its OTLP trace endpoint pointed at (1).
 *   3. Tees each child's stdout/stderr through a colored, prefixed logger so
 *      a single shell tab is enough to follow the whole stack.
 *   4. On Ctrl-C, broadcasts SIGINT to every child and waits for them to exit
 *      before tearing the daemon down.
 *
 * Examples run in their own working dir + their own node_modules, so version
 * skew across third-party SDK variants does not bleed across.
 *
 * Adding a new example: drop it in `EXAMPLE_APPS` below. Anything that has a
 * `server.ts` exporting `startServer()` and self-hosts when run directly will
 * Just Work.
 */
import { spawn, spawnSync, type Subprocess } from "bun";
import path from "path";
import fs from "fs";
import { RUNPHANTOM_BIND_HOST } from "../src/local-access";
import { createServer } from "../src/server";
import { getDbPath } from "../src/db";

function pidOnPort(port: number): string | null {
  try {
    const r = spawnSync(["lsof", "-ti", `:${port}`, "-sTCP:LISTEN"]);
    const pid = new TextDecoder().decode(r.stdout).trim().split("\n")[0];
    return pid || null;
  } catch {
    return null;
  }
}

function checkPortsOrExit(ports: { port: number; label: string }[]): void {
  const conflicts = ports
    .map((p) => ({ ...p, pid: pidOnPort(p.port) }))
    .filter((p): p is typeof p & { pid: string } => p.pid !== null);
  if (conflicts.length === 0) return;
  console.error("\n  Cannot start dev:examples — ports already in use:\n");
  for (const c of conflicts) {
    console.error(`    :${c.port}  ${c.label.padEnd(22)} pid=${c.pid}`);
  }
  console.error(`\n  Free them and retry:`);
  console.error(`    kill -9 ${conflicts.map((c) => c.pid).join(" ")}\n`);
  process.exit(1);
}

export function pathEntries(value: string, platform: NodeJS.Platform): string[] {
  return value.split(platform === "win32" ? ";" : ":");
}

export function executableCandidates(
  bin: string,
  platform: NodeJS.Platform,
  pathext = process.env.PATHEXT,
): string[] {
  const extensions = (pathext ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  if (
    platform !== "win32" ||
    extensions.some((extension) => bin.toLowerCase().endsWith(extension.toLowerCase()))
  ) {
    return [bin];
  }
  return [bin, ...extensions.map((extension) => `${bin}${extension}`)];
}

export function binOnPath(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathValue = env.PATH ?? env.Path ?? "";
  const join = (...parts: string[]) =>
    platform === "win32" ? path.win32.join(...parts) : path.posix.join(...parts);
  const candidates = executableCandidates(bin, platform, env.PATHEXT);
  return pathEntries(pathValue, platform).some((dir) =>
    candidates.some((candidate) => {
      try {
        return fs.existsSync(join(dir, candidate));
      } catch {
        return false;
      }
    }),
  );
}

// The daemon's SPA fallthrough sends every non-API route to
// app/dist/index.html (src/server.ts → resolveBuiltAppDir); without a build
// it 500s on the first browser hit. Aborts on failure — no bundle, no UI.
function ensureRunPhantomUi(): void {
  const indexHtml = path.join(REPO_ROOT, "app", "dist", "index.html");
  if (fs.existsSync(indexHtml)) return;

  console.log("\x1b[2m  Building runphantom UI bundle (app/dist/)…\x1b[0m");
  const r = spawnSync(["bun", "run", "build:ui"], {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (r.exitCode !== 0) {
    console.error(
      `\n  bun run build:ui failed (exit ${r.exitCode}). The runphantom daemon needs app/dist/index.html to serve the UI; cannot continue.\n`,
    );
    process.exit(1);
  }
}

// macOS ships `python3` → 3.9, too old for some SDKs (requires ≥ 3.10);
// prefer a Homebrew `python3.12` / `python3.13` there, while Windows commonly
// exposes the same runtime as `python` or the `py` launcher.
export function pickPython3(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const candidates = platform === "win32"
    ? ["python", "python3", "py"]
    : ["python3.13", "python3.12", "python3.11", "python3.10", "python3"];
  for (const candidate of candidates) {
    if (binOnPath(candidate, env, platform)) return candidate;
  }
  return null;
}

export function pythonVenvPath(cwd: string, platform: NodeJS.Platform = process.platform): string {
  const join = (...parts: string[]) =>
    platform === "win32" ? path.win32.join(...parts) : path.posix.join(...parts);
  return platform === "win32"
    ? join(cwd, ".venv", "Scripts", "python.exe")
    : join(cwd, ".venv", "bin", "python");
}

export function pythonPipPath(cwd: string, platform: NodeJS.Platform = process.platform): string {
  const join = (...parts: string[]) =>
    platform === "win32" ? path.win32.join(...parts) : path.posix.join(...parts);
  return platform === "win32"
    ? join(cwd, ".venv", "Scripts", "pip.exe")
    : join(cwd, ".venv", "bin", "pip");
}

type ExampleRuntime = "bun" | "python" | "rust" | "go";

interface ExampleApp {
  /** Folder name under `examples/`. */
  name: string;
  /** Stable port that the orchestrator pins this example to. */
  port: number;
  /** Human-readable label printed in the URL summary + log prefix. */
  label: string;
  /** Toolchain used to spawn the example. Defaults to `bun`. */
  runtime?: ExampleRuntime;
  /**
   * Optional precondition checks. If any returns a non-empty string,
   * the example is skipped and the message is shown instead.
   */
  skipIf?: () => string | null;
}

const ENTRYPOINT_BY_RUNTIME: Record<ExampleRuntime, string> = {
  bun: "server.ts",
  python: "server.py",
  rust: "Cargo.toml",
  go: "go.mod",
};

function spawnCmdFor(runtime: ExampleRuntime, cwd: string): string[] {
  switch (runtime) {
    case "python": {
      const venvPython = pythonVenvPath(cwd);
      const py = fs.existsSync(venvPython) ? venvPython : pickPython3() ?? "python3";
      return [py, "server.py"];
    }
    case "rust":
      return ["cargo", "run", "--quiet"];
    case "go":
      return ["go", "run", "."];
    case "bun":
      return ["bun", "server.ts"];
  }
}

// Each example pins its own dep set (e.g. ai-sdk-otelv2 vs the root
// third-party SDKs); without a local `node_modules/` bun's upward bare-import
// resolution silently falls back to the runphantom's hoisted deps.
function ensureBunDeps(app: ExampleApp, cwd: string): string | null {
  if ((app.runtime ?? "bun") !== "bun") return null;
  if (fs.existsSync(path.join(cwd, "node_modules"))) return null;
  if (!fs.existsSync(path.join(cwd, "package.json"))) return null;

  console.log(
    `\x1b[2m  Installing dependencies for examples/${app.name}…\x1b[0m`,
  );
  const r = spawnSync(["bun", "install", "--silent"], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (r.exitCode !== 0) {
    return `bun install failed (exit ${r.exitCode}) — run \`cd examples/${app.name} && bun install\``;
  }
  return null;
}

function ensurePythonVenv(app: ExampleApp, cwd: string): string | null {
  if (app.runtime !== "python") return null;
  const venvPython = pythonVenvPath(cwd);
  if (fs.existsSync(venvPython)) return null;

  const python = pickPython3();
  if (!python) return null;

  const requirements = path.join(cwd, "requirements.txt");
  console.log(
    `\x1b[2m  Bootstrapping python venv for examples/${app.name} (${python})…\x1b[0m`,
  );
  const venv = spawnSync([python, "-m", "venv", ".venv"], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (venv.exitCode !== 0) {
    const venvPython = pythonVenvPath(".");
    return `${python} -m venv failed (exit ${venv.exitCode}) — run \`cd examples/${app.name} && ${python} -m venv .venv && ${venvPython} -m pip install -r requirements.txt\``;
  }
  if (fs.existsSync(requirements)) {
    const pip = spawnSync(
      [pythonPipPath(cwd), "install", "-q", "-r", "requirements.txt"],
      { cwd, stdout: "inherit", stderr: "inherit" },
    );
    if (pip.exitCode !== 0) {
      return `pip install failed (exit ${pip.exitCode}) — run \`cd examples/${app.name} && ${pythonPipPath(".")} install -r requirements.txt\` (verify your venv interpreter and SDK compatibility)`;
    }
  }
  return null;
}

const REPO_ROOT = path.resolve(import.meta.dir, "..");

const EXAMPLE_APPS: ExampleApp[] = [
  { name: "openai-chat", port: 3012, label: "OpenAI chat" },
  { name: "anthropic-chat", port: 3013, label: "Anthropic chat" },
  {
    name: "python-chat",
    port: 3017,
    label: "Python SDK chat",
    runtime: "python",
    skipIf: () =>
      pickPython3() ? null : "python3 not found on PATH — install python ≥ 3.10 via your OS package manager or python.org",
  },
  {
    name: "rust-chat",
    port: 3018,
    label: "Rust SDK chat",
    runtime: "rust",
    skipIf: () =>
      binOnPath("cargo") ? null : "cargo not found on PATH — install via rustup",
  },
  {
    name: "go-chat",
    port: 3019,
    label: "Go SDK chat",
    runtime: "go",
    skipIf: () =>
      binOnPath("go") ? null : "go not found on PATH — install via brew or go.dev",
  },
];

const PALETTE = ["36", "33", "35", "32", "34", "31"];
function color(idx: number, text: string): string {
  const code = PALETTE[idx % PALETTE.length];
  return `\x1b[${code}m${text}\x1b[0m`;
}

function listen(server: ReturnType<typeof createServer> extends Promise<infer R> ? R extends { server: infer S } ? S : never : never, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, RUNPHANTOM_BIND_HOST, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else resolve(port);
    });
  });
}

interface RunningChild {
  app: ExampleApp;
  proc: Subprocess;
  logIdx: number;
}

async function pipeWithPrefix(
  stream: ReadableStream<Uint8Array> | null,
  prefix: string,
  sink: typeof process.stdout | typeof process.stderr,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) sink.write(`${prefix} ${line}\n`);
  }
  if (buf) sink.write(`${prefix} ${buf}\n`);
}

async function main(): Promise<void> {
  const debuggerPort = Number(process.env.RUNPHANTOM_PORT ?? 5947);

  // Before port check: a missing bundle is the slower, fail-fast condition.
  ensureRunPhantomUi();

  checkPortsOrExit([
    { port: debuggerPort, label: "Run Phantom daemon" },
    ...EXAMPLE_APPS
      .filter((a) => !a.skipIf?.())
      .map((a) => ({ port: a.port, label: a.name })),
  ]);

  const { server } = await createServer(debuggerPort);
  const boundDebuggerPort = await listen(server, debuggerPort);

  const debuggerBase = `http://127.0.0.1:${boundDebuggerPort}`;
  const debuggerIngestBase = `${debuggerBase}/v1/`;
  const debuggerTraceEndpoint = `${debuggerBase}/v1/traces`;

  // Examples discover the local daemon via these env vars. Don't clobber if
  // the operator already pointed them somewhere else (e.g. a remote endpoint).
  process.env.RUNPHANTOM_LOCAL_DEBUGGER ??= debuggerIngestBase;
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??= debuggerTraceEndpoint;

  const children: RunningChild[] = [];
  const skipped: { app: ExampleApp; reason: string }[] = [];

  // Rust + Go fetch their own deps at `cargo run` / `go run` time.
  const installFailures = new Map<string, string>();
  for (const app of EXAMPLE_APPS) {
    if (app.skipIf?.()) continue;
    const cwd = path.join(REPO_ROOT, "examples", app.name);
    const err = ensureBunDeps(app, cwd) ?? ensurePythonVenv(app, cwd);
    if (err) installFailures.set(app.name, err);
  }

  for (let idx = 0; idx < EXAMPLE_APPS.length; idx++) {
    const app = EXAMPLE_APPS[idx];
    const skipReason = app.skipIf?.() ?? null;
    if (skipReason) {
      skipped.push({ app, reason: skipReason });
      continue;
    }

    const installError = installFailures.get(app.name);
    if (installError) {
      skipped.push({ app, reason: installError });
      continue;
    }

    const cwd = path.join(REPO_ROOT, "examples", app.name);
    const runtime: ExampleRuntime = app.runtime ?? "bun";
    const entrypoint = ENTRYPOINT_BY_RUNTIME[runtime];
    if (!fs.existsSync(path.join(cwd, entrypoint))) {
      skipped.push({ app, reason: `examples/${app.name}/${entrypoint} missing` });
      continue;
    }

    const env = {
      ...process.env,
      PORT: String(app.port),
      RUNPHANTOM_LOCAL_DEBUGGER: process.env.RUNPHANTOM_LOCAL_DEBUGGER!,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT!,
    };

    const proc = spawn({
      cmd: spawnCmdFor(runtime, cwd),
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const logIdx = idx;
    const prefix = color(logIdx, `[${app.name.padEnd(18)}]`);
    void pipeWithPrefix(proc.stdout as ReadableStream<Uint8Array>, prefix, process.stdout);
    void pipeWithPrefix(proc.stderr as ReadableStream<Uint8Array>, prefix, process.stderr);

    children.push({ app, proc, logIdx });
  }

  // Print the "you can now click these" summary once everything is launched.
  // Do this after a short tick so the children's startup banners settle.
  await new Promise((r) => setTimeout(r, 250));

  const banner = (text: string) => `\x1b[1m${text}\x1b[0m`;
  console.log("");
  console.log(banner("  Run Phantom is running"));
  console.log("");
  console.log(`  ${"Run Phantom UI".padEnd(18)}  ${debuggerBase}`);
  console.log(`  ${"Run Phantom ingest".padEnd(18)}  ${debuggerBase}/v1/traces`);
  console.log(`  ${"Run Phantom MCP".padEnd(18)}  bun src/index.ts mcp`);
  console.log(`  ${"Run Phantom DB".padEnd(18)}  ${getDbPath()}`);
  console.log("");
  for (const child of children) {
    console.log(
      `  ${child.app.label.padEnd(18)}  http://127.0.0.1:${child.app.port}`,
    );
  }
  for (const { app, reason } of skipped) {
    console.log(
      `  ${app.label.padEnd(18)}  \x1b[2m(skipped: ${reason})\x1b[0m`,
    );
  }
  console.log("");
  console.log("  Ctrl-C to stop everything.");
  console.log("");

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down ${children.length} example app(s)…`);
    for (const child of children) {
      try {
        child.proc.kill(signal);
      } catch {
        // child may already be gone
      }
    }
    // Give children up to 5s to exit cleanly, then SIGKILL stragglers.
    const deadline = Date.now() + 5_000;
    for (const child of children) {
      const remaining = Math.max(0, deadline - Date.now());
      await Promise.race([
        child.proc.exited,
        new Promise((r) => setTimeout(r, remaining)),
      ]);
      if (child.proc.exitCode === null) {
        try {
          child.proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Surface unexpected child exits — if a single example dies, log it but keep
  // the rest running. Operators usually want to fix the broken one and re-run.
  await Promise.all(
    children.map(async (child) => {
      const code = await child.proc.exited;
      if (!shuttingDown && code !== 0 && code !== null) {
        console.error(
          `\x1b[31m[${child.app.name}] exited with code ${code}\x1b[0m`,
        );
      }
    }),
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
