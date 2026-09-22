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

export async function runDev(commands = devCommands(), shutdownTimeout = 5_000): Promise<void> {
  const processes: { label: string; process: Bun.Subprocess }[] = [];
  const useProcessGroups = process.platform !== "win32";
  const signalChild = (child: Bun.Subprocess, signal: NodeJS.Signals) => {
    try {
      if (useProcessGroups) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* already stopped */ }
  };
  const isRunning = (child: Bun.Subprocess) => {
    if (!useProcessGroups) return child.exitCode === null;
    try { process.kill(-child.pid, 0); return true; } catch { return false; }
  };

  let stopping = false;
  const stop = async (signal: NodeJS.Signals, exitCode: number) => {
    if (stopping) return;
    stopping = true;
    for (const child of processes) signalChild(child.process, signal);
    const deadline = Date.now() + shutdownTimeout;
    // A launcher can exit before its descendants, so wait on the entire group.
    while (processes.some(child => isRunning(child.process)) && Date.now() < deadline) {
      await Bun.sleep(Math.min(25, Math.max(0, deadline - Date.now())));
    }
    for (const child of processes) signalChild(child.process, "SIGKILL");
    await Promise.allSettled(processes.map(child => child.process.exited));
    process.exit(exitCode);
  };

  process.on("SIGINT", () => void stop("SIGINT", 0));
  process.on("SIGTERM", () => void stop("SIGTERM", 0));

  try {
    for (const command of commands) {
      const child = Bun.spawn({
        cmd: command.cmd,
        cwd: command.cwd,
        env: process.env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        // Keep descendants addressable after their immediate parent exits.
        detached: useProcessGroups,
      });
      processes.push({ label: command.label, process: child });
    }

    console.log(`\nRun Phantom UI: http://localhost:${process.env.RUNPHANTOM_UI_PORT ?? "5948"}\n`);
    const first = await Promise.race(processes.map(async child => ({
      label: child.label,
      exitCode: await child.process.exited,
    })));
    if (!stopping) {
      console.error(`[dev] ${first.label} exited with code ${first.exitCode}`);
      await stop("SIGTERM", first.exitCode ?? 1);
    }
  } catch (error) {
    console.error("[dev] startup failed", error);
    await stop("SIGTERM", 1);
  }
}

if (import.meta.main) void runDev();
