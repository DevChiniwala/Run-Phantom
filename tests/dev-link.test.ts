import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { linkDevCommand } from "../scripts/link-dev";

describe("source CLI link", () => {
  test("writes an idempotent Windows command shim", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runphantom link win-"));
    try {
      const command = linkDevCommand(root, "win32");
      expect(command).toEndWith("runphantom-dev.cmd");
      expect(fs.readFileSync(command, "utf8")).toBe([
        "@echo off",
        'set "RUNPHANTOM_BIN_PATH=%~f0"',
        'bun "%~dp0..\\..\\src\\index.ts" %*',
        "",
      ].join("\r\n"));
      const contents = fs.readFileSync(command, "utf8");
      expect(linkDevCommand(root, "win32")).toBe(command);
      expect(fs.readFileSync(command, "utf8")).toBe(contents);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("links the existing POSIX wrapper", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runphantom link posix-"));
    try {
      fs.mkdirSync(path.join(root, "bin"), { recursive: true });
      fs.writeFileSync(path.join(root, "bin", "runphantom-dev"), "#!/usr/bin/env bash\n");
      const command = linkDevCommand(root, process.platform);
      expect(fs.lstatSync(command).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(command)).toBe("../../bin/runphantom-dev");
      expect(linkDevCommand(root, process.platform)).toBe(command);
      expect(fs.readlinkSync(command)).toBe("../../bin/runphantom-dev");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
