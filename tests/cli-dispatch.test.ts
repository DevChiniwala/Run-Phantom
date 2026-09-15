import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");

function run(args: string[]) {
  const profile = mkdtempSync(path.join(tmpdir(), "runphantom-cli-"));
  try {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith("RUNPHANTOM_") && key !== "OPENAI_API_KEY" && key !== "ANTHROPIC_API_KEY"));
    return spawnSync(process.execPath, ["src/index.ts", ...args], {
      cwd: root,
      env: {
        ...inherited,
        HOME: profile,
        USERPROFILE: profile,
        RUNPHANTOM_DB_PATH: path.join(profile, "local.db"),
        RUNPHANTOM_SECRET_STORE_PATH: path.join(profile, "secrets.json"),
      },
      encoding: "utf8",
      timeout: 10_000,
    });
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

describe("CLI dispatch compatibility", () => {
  test.each(["--help", "-h", "help"])("%s preserves the existing command surface", flag => {
    const result = run([flag]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("runphantom replay register");
    expect(result.stdout).toContain("runphantom mcp");
    expect(result.stdout).toContain("runphantom connect");
    expect(result.stderr).toBe("");
  });

  test.each(["--version", "-v", "version"])("%s retains the source version", flag => {
    const result = run([flag]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.0.0-dev");
    expect(result.stderr).toBe("");
  });

  test("unknown commands keep usage exit status 64", () => {
    const result = run(["not-a-command"]);
    expect(result.status).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown subcommand: not-a-command");
  });

  test("replay help retains nested argument dispatch", () => {
    const result = run(["replay", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("runphantom replay register [--cwd=DIR]");
    expect(result.stderr).toBe("");
  });
});
