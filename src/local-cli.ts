#!/usr/bin/env node
/** Local Run Phantom commands, loaded only after CLI mode selection. */
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { createInterface } from "readline/promises";
import { createServer } from "./server";
import { RUNPHANTOM_BIND_HOST } from "./local-access";
import { closeDb, getDbPath } from "./db";
import { findFreePort, isPortFree } from "./port-check";
import { IS_PACKAGED_RUNTIME, VERSION } from "./version";
import { cmdSetup } from "./init";
import { cmdSync } from "./install/sync";
import { cmdUninstall } from "./uninstall";
import { stopRunPhantomStartup } from "./runphantom-startup";
import { registerReplayProject } from "./agents-config";
import { openInBrowser } from "./open-browser";
import { SOURCE_ENTRY } from "./source-paths";

const STATE_DIR = path.join(os.homedir(), ".runphantom");
const PID_PATH = path.join(STATE_DIR, "runphantom.pid");
const PORT_PATH = path.join(STATE_DIR, "runphantom.port");
const LOG_PATH = path.join(STATE_DIR, "runphantom.log");
const DEFAULT_PORT = 5947;
const MAX_PORT = 65535;
const PORT_ENV = "RUNPHANTOM_PORT";
const BIND_HOST_ENV = "RUNPHANTOM_BIND_HOST";
const DEFAULT_BIND_HOST = RUNPHANTOM_BIND_HOST;

function getConfiguredBindHost(): string {
  const raw = process.env[BIND_HOST_ENV]?.trim();
  return raw ? raw : DEFAULT_BIND_HOST;
}

function printRunPhantomAccess(port: number, opts: { pid?: number | null; logs?: boolean } = {}): void {
  console.log("");
  console.log(`\x1b[36mRun Phantom:\x1b[0m \x1b[4mhttp://localhost:${port}\x1b[0m`);
  if (opts.pid) console.log("\x1b[2mStop: runphantom stop\x1b[0m");
  if (opts.logs) console.log("\x1b[2mLogs: " + LOG_PATH + "\x1b[0m");
  console.log("");
  console.log("env");
  console.log("  \x1b[2mOTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:" + port + "/v1/traces\x1b[0m");
  console.log("");
}

function printPortFallback(requestedPort: number, port: number): void {
  if (port !== requestedPort) {
    console.log(`requested :${requestedPort}; using :${port}`);
  }
}

async function runBackend(): Promise<void> {
  const requestedPort = getConfiguredPort();
  const port = hasExplicitPort() ? requestedPort : await findFreePort(requestedPort);
  const bindHost = getConfiguredBindHost();
  const { server } = await createServer(port);

  server.listen(port, bindHost, () => {
    printPortFallback(requestedPort, port);
    printRunPhantomAccess(port);
  });

  // The daemon is detached with stdio redirected to a log file, so anything that
  // escapes a handler kills it leaving nothing but a truncated log — observed in
  // testing as a daemon that simply vanished mid-session. A rejected promise is
  // usually one stray fetch and losing every open WebSocket over it is the worse
  // outcome, so log and keep serving. An uncaught exception can leave real state
  // torn, so record it properly and then exit.
  process.on("unhandledRejection", (reason) => {
    console.error("[runphantom] unhandled promise rejection (continuing):",
      reason instanceof Error ? (reason.stack ?? reason.message) : reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[runphantom] uncaught exception, shutting down:", err?.stack ?? err);
    try { server.close(); } catch { /* already closing */ }
    process.exit(1);
  });

  const shutdown = () => { server.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGUSR2", shutdown); // nodemon/tsx watch sends SIGUSR2

  // Block forever. Caller (`process.exit(await dispatchRunPhantom(...))`) would
  // otherwise kill us the moment server.listen schedules its callback.
  await new Promise<void>(() => {});
}

async function runMcp(): Promise<void> {
  // The MCP server is a thin WebSocket bridge to the local daemon. If the
  // daemon isn't already running, the bridge would crash on `backend.connect()`
  // with no clear signal to the user (Claude Code surfaces the failure as
  // "Failed to reconnect"). Auto-start the daemon so the plugin is robust to
  // machine restarts. All progress goes to stderr — stdout is reserved for
  // JSON-RPC frames.
  if (!process.env.RUNPHANTOM_URL) {
    try {
      const result = await ensureDaemonRunning();
      process.env.RUNPHANTOM_URL = `http://localhost:${result.port}`;
      if (!result.alreadyRunning) {
        console.error(
          `[runphantom mcp] auto-started daemon on :${result.port}` +
            (result.pid ? ` (pid ${result.pid})` : "") +
            ` — logs at ${LOG_PATH}`
        );
      }
    } catch (err) {
      console.error(`[runphantom mcp] failed to ensure daemon: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  const { runMcpServer } = await import("./mcp");
  const handle = await runMcpServer();
  const shutdown = async () => { await handle.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGUSR2", shutdown);

  // Block forever; stdio transport stays alive on its own, but we must not
  // let the dispatch chain return into `process.exit(0)`.
  await new Promise<void>(() => {});
}

interface EnsureDaemonResult {
  alreadyRunning: boolean;
  pid: number | null;
  requestedPort: number;
  port: number;
}

interface RunPhantomPortSelection {
  alreadyRunning: boolean;
  port: number;
}

async function ensureDaemonRunning(): Promise<EnsureDaemonResult> {
  fs.mkdirSync(STATE_DIR, { recursive: true });

  const requestedPort = getConfiguredPort();
  const selection = hasExplicitPort()
    ? await selectExactRunPhantomPort(requestedPort)
    : await selectRunPhantomPort(requestedPort);
  const port = selection.port;

  if (selection.alreadyRunning) {
    try { fs.writeFileSync(PORT_PATH, String(port)); } catch {}
    return { alreadyRunning: true, pid: readPid(), requestedPort, port };
  }

  const stale = readPid();
  if (stale && !processAlive(stale)) {
    try { fs.unlinkSync(PID_PATH); } catch {}
    try { fs.unlinkSync(PORT_PATH); } catch {}
  }

  const logFd = fs.openSync(LOG_PATH, "a");
  // A compiled release re-executes itself; source mode re-executes Bun with
  // this entry file. Packaged mode is a build capability, not a filename test.
  const childArgs = IS_PACKAGED_RUNTIME
    ? ["serve"]
    : [SOURCE_ENTRY, "serve"];
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, [PORT_ENV]: String(port) },
  });
  // Guard the async 'error' event: unhandled it would abort the launcher with a
  // bare stack instead of the health-check timeout message below.
  child.on("error", (err) => {
    console.error(`[runphantom] failed to start daemon process: ${(err as Error).message}`);
  });
  fs.writeFileSync(PID_PATH, String(child.pid));
  fs.writeFileSync(PORT_PATH, String(port));
  child.unref();

  // 30s — cold-start sqlite migration replay + bun import on a loaded CI
  // worker can run for several seconds before /health responds.
  for (let i = 0; i < 300; i++) {
    await sleep(100);
    if (await isHealthy(port)) {
      return { alreadyRunning: false, pid: child.pid ?? null, requestedPort, port };
    }
  }
  throw new Error(
    `Run Phantom did not respond on :${port} within 30s — tail ${LOG_PATH} for details`
  );
}

async function cmdStart(): Promise<number> {
  try {
    const result = await ensureDaemonRunning();
    printPortFallback(result.requestedPort, result.port);
    printRunPhantomAccess(result.port, { pid: result.pid, logs: !result.alreadyRunning || Boolean(result.pid) });
    return 0;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}

async function cmdStop(portHint?: number): Promise<number> {
  let pid = readPid();
  if (!pid) {
    const port = portHint ?? readPort();
    const health = port ? await getRunPhantomHealth(port) : null;
    if (typeof health?.pid === "number" && processAlive(health.pid)) {
      pid = health.pid;
    }
  }
  if (!pid) {
    const startup = stopRunPhantomStartup();
    console.log(startup.ok && !startup.skipped ? startup.message : "Run Phantom is not running (no pid file)");
    try { fs.unlinkSync(PORT_PATH); } catch {}
    return 0;
  }
  if (!processAlive(pid)) {
    console.log(`Run Phantom is not running (stale pid ${pid}); cleaning up`);
    try { fs.unlinkSync(PID_PATH); } catch {}
    try { fs.unlinkSync(PORT_PATH); } catch {}
    const startup = stopRunPhantomStartup();
    if (startup.ok && !startup.skipped) console.log(startup.message);
    return 0;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    console.error(`failed to signal pid ${pid}:`, (err as Error).message);
    return 1;
  }
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (!processAlive(pid)) {
      try { fs.unlinkSync(PID_PATH); } catch {}
      try { fs.unlinkSync(PORT_PATH); } catch {}
      const startup = stopRunPhantomStartup();
      if (startup.ok && !startup.skipped) console.log(startup.message);
      console.log(`Run Phantom stopped (pid ${pid})`);
      return 0;
    }
  }
  console.error(`pid ${pid} did not exit within 5s`);
  return 1;
}

async function cmdReset(args: string[]): Promise<number> {
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      console.log(`runphantom reset — reset the local Run Phantom database

USAGE
    runphantom reset

This deletes local traces and saved data after confirmation.
`);
      return 0;
    } else {
      console.error(`unknown flag: ${arg}`);
      return 64;
    }
  }

  let selection: RunPhantomPortSelection;
  try {
    selection = await selectConfiguredRunPhantomPort();
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  if (selection.alreadyRunning) {
    console.error(`Run Phantom is running on :${selection.port}, stopping it first…`);
    const stopCode = await cmdStop(selection.port);
    if (stopCode !== 0) {
      console.error("failed to stop Run Phantom; aborting reset");
      return stopCode;
    }
    if (await isHealthy(selection.port)) {
      console.error(`Run Phantom is still running on :${selection.port}; aborting reset`);
      return 1;
    }
  }

  const dbPath = getDbPath();
  const targets = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  const existing = targets.filter((target) => fs.existsSync(target));

  console.error("This will permanently delete the local Run Phantom database.");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question('Type "Y" to continue: ');
    if (answer.trim().toLowerCase() !== "y") {
      console.error("reset cancelled");
      return 1;
    }
  } finally {
    rl.close();
  }

  closeDb();
  for (const target of existing) {
    fs.rmSync(target, { force: true });
  }
  if (existing.length === 0) {
    console.log("Reset successfully.");
  } else {
    console.log("Reset successfully.");
  }
  return 0;
}

async function cmdStatus(): Promise<number> {
  const pid = readPid();
  const requestedPort = getConfiguredPort();
  let selection: RunPhantomPortSelection;
  try {
    selection = await selectConfiguredRunPhantomPort();
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  const port = selection.port;
  const healthy = selection.alreadyRunning;
  if (healthy && pid) {
    console.log(`running on :${port} (pid ${pid})`);
    return 0;
  }
  if (healthy) {
    console.log(`running on :${port} (no pid file — started externally)`);
    return 0;
  }
  if (pid && processAlive(pid)) {
    const unhealthyPort = readPort() ?? requestedPort;
    console.log(`pid ${pid} alive but /health on :${unhealthyPort} not responding`);
    console.log("hint: runphantom stop && runphantom start");
    return 2;
  }
  console.log("not running");
  console.log("hint: start it with `runphantom`, then open http://localhost:" + port);
  return 1;
}

/**
 * Default action when the user runs `runphantom` with no further
 * subcommand: ensure the daemon is up, then open the UI in the browser.
 * Idempotent — re-running is harmless.
 */
async function cmdRunPhantomDefault(): Promise<number> {
  let port: number;
  try {
    const result = await ensureDaemonRunning();
    port = result.port;
    if (!process.env.RUNPHANTOM_SKIP_WORKSPACE_ACTIVATE) {
      try {
        await activateWorkspace(port, process.cwd());
      } catch (err) {
        console.warn(`[runphantom] ${(err as Error).message}`);
      }
    }
    printPortFallback(result.requestedPort, result.port);
    printRunPhantomAccess(result.port, { pid: result.pid, logs: !result.alreadyRunning || Boolean(result.pid) });
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  const url = `http://localhost:${port}`;
  openInBrowser(url);
  return 0;
}

/**
 * `runphantom connect` configures the current project to export traces to
 * the local debugger. Three jobs, in order:
 *
 *   1. Write `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:<port>/v1/traces` into
 *      ./.env (idempotent; won't clobber a different existing value unless
 *      `--force` is given).
 *   2. Start the daemon (or no-op if already running).
 *   3. Open the UI in the browser.
 *
 * The single command a new user runs after install. Designed to be the
 * shortest distance between installation and seeing local traces
 * appear in a browser".
 */
async function cmdConnect(args: string[]): Promise<number> {
  let force = false;
  let envFile: string | null = null;
  let printOnly = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--force") force = true;
    else if (a === "--print") printOnly = true;
    else if (a === "--file") envFile = args[++i] ?? null;
    else if (a.startsWith("--file=")) envFile = a.slice("--file=".length);
    else if (a === "--help" || a === "-h") {
      console.log(`runphantom connect — configure local trace export

USAGE
    runphantom connect [--file=PATH] [--force] [--print]

WHAT IT DOES
    1. Writes OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:<port>/v1/traces into ./.env
       (or --file=PATH). Idempotent — same line already present is a no-op.
    2. Starts the daemon if not already running.
    3. Opens the UI in the browser.

FLAGS
    --file=PATH   Target env file (default: ./.env in current directory).
    --force       Replace an existing OTEL_EXPORTER_OTLP_TRACES_ENDPOINT line that
                  points elsewhere. Without this, setup bails on a conflict.
    --print       Don't modify any file; just print the export line and
                  skip start/open. Useful for shells that don't read .env.
`);
      return 0;
    } else {
      console.error(`unknown flag: ${a}`);
      return 64;
    }
  }

  let selection: RunPhantomPortSelection;
  try {
    selection = await selectConfiguredRunPhantomPort();
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  const port = selection.port;
  const targetLine = `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:${port}/v1/traces`;

  if (printOnly) {
    console.log(targetLine);
    return 0;
  }

  const target = path.resolve(envFile ?? path.join(process.cwd(), ".env"));
  const writeResult = writeEnvLine(target, targetLine, { force });
  if (writeResult.kind === "conflict") {
    console.error(
      `[connect] ${target} has a different OTEL_EXPORTER_OTLP_TRACES_ENDPOINT value:\n` +
        `  existing: ${writeResult.existing}\n` +
        `  proposed: ${targetLine}\n` +
        `re-run with --force to overwrite, or edit the file manually.`
    );
    return 2;
  }
  if (writeResult.kind === "noop") {
    console.log(`[connect] ${target} already has OTEL_EXPORTER_OTLP_TRACES_ENDPOINT — nothing to write`);
  } else {
    console.log(`[connect] wrote ${targetLine} to ${target}`);
  }

  // Start daemon + open UI. Failure here doesn't undo the env-write — that's
  // intentional, the env line is still useful even if the daemon is down.
  const runResult = await cmdRunPhantomDefault();
  return runResult;
}

interface EnvWriteResult {
  kind: "wrote" | "noop" | "conflict";
  existing?: string;
}

/**
 * Idempotent line-level upsert into a `.env`-style file:
 *
 *   - File doesn't exist → create with the single line.
 *   - Line already present (exact match) → no-op.
 *   - Line key present but value differs:
 *       - force=true → replace the line.
 *       - force=false → return "conflict" without modifying the file.
 *   - Line key absent → append (preserving trailing newline shape).
 */
function writeEnvLine(file: string, line: string, opts: { force: boolean }): EnvWriteResult {
  const eq = line.indexOf("=");
  const key = line.slice(0, eq);
  const keyRe = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*=`);

  let original = "";
  let exists = false;
  try {
    original = fs.readFileSync(file, "utf8");
    exists = true;
  } catch { /* file doesn't exist — we'll create it */ }

  if (!exists) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, line + "\n");
    return { kind: "wrote" };
  }

  const lines = original.split("\n");
  const idx = lines.findIndex((l) => keyRe.test(l));
  if (idx === -1) {
    const sep = original.endsWith("\n") || original.length === 0 ? "" : "\n";
    fs.writeFileSync(file, original + sep + line + "\n");
    return { kind: "wrote" };
  }
  if (lines[idx].trim() === line) {
    return { kind: "noop" };
  }
  if (!opts.force) {
    return { kind: "conflict", existing: lines[idx] };
  }
  lines[idx] = line;
  fs.writeFileSync(file, lines.join("\n"));
  return { kind: "wrote" };
}

function readPid(): number | null {
  try {
    const raw = fs.readFileSync(PID_PATH, "utf8").trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function readPort(): number | null {
  try {
    const raw = fs.readFileSync(PORT_PATH, "utf8").trim();
    const port = parseInt(raw, 10);
    return Number.isInteger(port) && port >= 1 && port <= MAX_PORT ? port : null;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getRunPhantomHealth(port: number): Promise<{ service?: string; pid?: number } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return null;
    const body = await res.json() as { service?: string; pid?: number };
    return body.service === "runphantom" ? body : null;
  } catch {
    return null;
  }
}

async function isHealthy(port: number): Promise<boolean> {
  return Boolean(await getRunPhantomHealth(port));
}

async function activateWorkspace(port: number, cwd: string): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/workspace/active`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd }),
      signal: AbortSignal.timeout(1_000),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(body || `HTTP ${res.status}`);
    }
  } catch (err) {
    throw new Error(`failed to activate workspace ${cwd}: ${(err as Error).message}`);
  }
}

function getConfiguredPort(): number {
  const port = parseInt(process.env[PORT_ENV] ?? String(DEFAULT_PORT), 10);
  if (Number.isInteger(port) && port >= 1 && port <= MAX_PORT) return port;
  return DEFAULT_PORT;
}

function hasExplicitPort(): boolean {
  return Boolean(process.env[PORT_ENV] && process.env[PORT_ENV]?.trim());
}

async function selectExactRunPhantomPort(port: number): Promise<RunPhantomPortSelection> {
  if (await isHealthy(port)) return { alreadyRunning: true, port };
  if (await isPortFree(port)) return { alreadyRunning: false, port };
  throw new Error(`:${port} is already in use by another process.`);
}

async function selectConfiguredRunPhantomPort(): Promise<RunPhantomPortSelection> {
  const requestedPort = getConfiguredPort();
  return hasExplicitPort()
    ? selectExactRunPhantomPort(requestedPort)
    : selectRunPhantomPort(requestedPort);
}

async function selectRunPhantomPort(startPort: number): Promise<RunPhantomPortSelection> {
  const savedPort = hasExplicitPort() ? null : readPort();
  if (savedPort && await isHealthy(savedPort)) {
    return { alreadyRunning: true, port: savedPort };
  }

  return findRunPhantomPort(startPort);
}

async function findRunPhantomPort(startPort: number): Promise<RunPhantomPortSelection> {
  for (let port = startPort; port <= MAX_PORT; port++) {
    if (await isHealthy(port)) return { alreadyRunning: true, port };
    if (await isPortFree(port)) return { alreadyRunning: false, port };
  }

  throw new Error(`no usable port available at or above :${startPort}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printRootHelp(): void {
  const port = process.env[PORT_ENV] ?? String(DEFAULT_PORT);
  console.log(`runphantom ${VERSION} — See the run. Find the reason.

USAGE
    runphantom                       Start the daemon and open Run Phantom.
    runphantom connect [flags]       Configure this project for local OTLP export.
    runphantom setup [flags]         Install skills and MCP in supported agents.

DAEMON
    runphantom open                  Start and open the UI.
    runphantom start                 Start in the background.
    runphantom stop                  Stop the daemon.
    runphantom status                Show daemon health.
    runphantom serve                 Run in the foreground.
    runphantom reset                 Delete local traces after confirmation.
    runphantom mcp                   Serve MCP over stdio.

TEAM
    runphantom team serve            Start the isolated shared team service.
    runphantom team --help           Show team configuration and access.

TOOLS
    runphantom sync                  Refresh tracked agent integrations.
    runphantom replay register       Register replay configuration for this project.
    runphantom uninstall             Remove Run Phantom from this machine.

ENVIRONMENT
    RUNPHANTOM_PORT                  Exact daemon port (default: ${port}).
    RUNPHANTOM_DB_PATH               SQLite path (default: ~/.runphantom/runphantom.db).
    RUNPHANTOM_BIND_HOST             Bind interface (default: 127.0.0.1).
    RUNPHANTOM_ALLOWED_HOSTS         Comma-separated extra Host header names.
    RUNPHANTOM_ALLOWED_SOURCE_IPS    Exact non-loopback client IPs to permit.
    RUNPHANTOM_ALLOWED_ORIGINS       Comma-separated browser origins for mutations.
    RUNPHANTOM_UI_PORT               Local Vite UI port (default: 5948).
    RUNPHANTOM_URL                   Daemon URL used by the MCP bridge.
`);
}

async function dispatchReplay(verb: string | undefined, rest: string[]): Promise<number> {
  switch (verb) {
    case "register": {
      let cwd = process.cwd();
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (arg === "--cwd") cwd = path.resolve(rest[++i] ?? process.cwd());
        else if (arg.startsWith("--cwd=")) cwd = path.resolve(arg.slice("--cwd=".length));
        else if (arg === "-h" || arg === "--help") {
          console.log(`runphantom replay register — register project replay config

USAGE
    runphantom replay register [--cwd=DIR]
`);
          return 0;
        } else {
          console.error(`unknown flag: ${arg}`);
          return 64;
        }
      }
      try {
        const result = await registerReplayProject(cwd);
        console.log("Registered replay project:");
        console.log(`  path: ${result.cwd}`);
        console.log(`  config: ${result.configPath}`);
        console.log("  agents:");
        for (const agent of result.agents) console.log(`    - eventName: ${agent}`);
        return 0;
      } catch (err) {
        console.error((err as Error).message);
        return 1;
      }
    }
    case undefined:
    case "-h":
    case "--help":
    case "help":
      console.log(`runphantom replay — local agent replay helpers

USAGE
    runphantom replay register [--cwd=DIR]
`);
      return 0;
    default:
      console.error(`unknown subcommand: replay ${verb}`);
      return 64;
  }
}

async function dispatchRunPhantom(verb: string | undefined, rest: string[]): Promise<number> {
  switch (verb) {
    case undefined:
    case "open":
      return cmdRunPhantomDefault();
    case "connect":
      return cmdConnect(rest);
    case "start":
      return cmdStart();
    case "stop":
      return cmdStop();
    case "reset":
      return cmdReset(rest);
    case "status":
      return cmdStatus();
    case "serve":
      await runBackend(); // never resolves
      return 0;
    case "mcp":
      await runMcp();
      return 0;
    case "-h":
    case "--help":
    case "help":
      printRootHelp();
      return 0;
    case "-v":
    case "--version":
    case "version":
      console.log(VERSION);
      return 0;
    default:
      console.error(`unknown subcommand: ${verb}`);
      console.error("run `runphantom --help` for usage.");
      return 64;
  }
}

(async () => {
  const top = process.argv[2];
  switch (top) {
    case undefined:
    case "open":
      process.exit(await cmdRunPhantomDefault());
      break;
    case "-h":
    case "--help":
    case "help":
      printRootHelp();
      process.exit(0);
      break;
    case "-v":
    case "--version":
    case "version":
      console.log(VERSION);
      process.exit(0);
      break;
    case "setup":
      process.exit(await cmdSetup(process.argv.slice(3)));
      break;
    case "sync":
      process.exit(await cmdSync(process.argv.slice(3)));
      break;
    case "replay":
      process.exit(await dispatchReplay(process.argv[3], process.argv.slice(4)));
      break;
    case "uninstall":
      process.exit(await cmdUninstall(process.argv.slice(3)));
      break;
    case "connect":
    case "start":
    case "stop":
    case "reset":
    case "status":
    case "serve":
    case "mcp":
      process.exit(await dispatchRunPhantom(top, process.argv.slice(3)));
      break;
    default:
      console.error(`unknown subcommand: ${top}`);
      console.error("run `runphantom --help` for usage.");
      process.exit(64);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
