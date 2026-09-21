#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function linkDevCommand(
  repoRoot = REPO_ROOT,
  platform: NodeJS.Platform = process.platform,
): string {
  const binDir = path.join(repoRoot, "node_modules", ".bin");
  const command = path.join(binDir, "runphantom-dev");
  fs.mkdirSync(binDir, { recursive: true });
  fs.rmSync(command, { force: true });
  fs.rmSync(`${command}.cmd`, { force: true });

  if (platform === "win32") {
    const entry = path.win32.relative(binDir, path.join(repoRoot, "src", "index.ts"));
    fs.writeFileSync(
      `${command}.cmd`,
      [
        "@echo off",
        'set "RUNPHANTOM_BIN_PATH=%~f0"',
        `bun "%~dp0${entry}" %*`,
        "",
      ].join("\r\n"),
    );
    return `${command}.cmd`;
  }

  fs.symlinkSync("../../bin/runphantom-dev", command);
  return command;
}

if (import.meta.main) linkDevCommand();
