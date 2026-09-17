#!/usr/bin/env bun
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function devCommands(repoRoot = REPO_ROOT) {
  return [
    { label: "daemon", cmd: [process.execPath, "--watch", "src/index.ts", "serve"], cwd: repoRoot },
    { label: "UI", cmd: [process.execPath, "x", "vite", "--force"], cwd: path.join(repoRoot, "app") },
  ];
}

async function main(): Promise<void> {
  const processes = devCommands().map((command) => ({
    ...command,
    process: Bun.spawn({
      cmd: command.cmd,
      cwd: command.cwd,
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }),
  }));

  console.log(`\nRun Phantom UI: http://localhost:${process.env.RUNPHANTOM_UI_PORT ?? "5948"}\n`);

  let stopping = false;
  const stop = async (signal: NodeJS.Signals, exitCode: number) => {
    if (stopping) return;
    stopping = true;
    for (const child of processes) {
      try { child.process.kill(signal); } catch { /* already stopped */ }
    }
    await Promise.race([
      Promise.allSettled(processes.map(child => child.process.exited)),
      new Promise(resolve => setTimeout(resolve, 5_000)),
    ]);
    for (const child of processes) {
      if (child.process.exitCode === null) {
        try { child.process.kill("SIGKILL"); } catch { /* already stopped */ }
      }
    }
    process.exit(exitCode);
  };

  process.on("SIGINT", () => void stop("SIGINT", 0));
  process.on("SIGTERM", () => void stop("SIGTERM", 0));

  const first = await Promise.race(processes.map(async child => ({
    label: child.label,
    exitCode: await child.process.exited,
  })));
  if (!stopping) {
    console.error(`[dev] ${first.label} exited with code ${first.exitCode}`);
    await stop("SIGTERM", first.exitCode ?? 1);
  }
}

if (import.meta.main) void main();
