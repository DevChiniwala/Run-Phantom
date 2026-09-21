import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

/**
 * The set of files a push would actually publish: tracked files plus untracked
 * files that .gitignore does not exclude. Using this rather than a filesystem
 * walk is the point — it is the same view git has, so a rule that passes here
 * cannot be defeated by a build artifact or a scratch file sitting on disk.
 */
function publishedFiles(): string[] {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: ROOT,
    maxBuffer: 1 << 28,
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function readIfText(rel: string): string | null {
  const raw = fs.readFileSync(path.join(ROOT, rel));
  if (raw.includes(0)) return null;
  return raw.toString("utf8");
}

describe("publication hygiene", () => {
  test("no environment file is publishable except the example template", () => {
    const offenders = publishedFiles().filter((rel) => {
      const base = path.basename(rel);
      return (base === ".env" || base.startsWith(".env.")) && base !== ".env.example";
    });
    expect(offenders).toEqual([]);
  });

  test(".env.example carries no populated secret values", () => {
    const content = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
    const populated: string[] = [];
    for (const line of content.split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)\s*=\s*(.+)$/.exec(line);
      if (match && match[2].trim().length > 0) populated.push(match[1]);
    }
    expect(populated).toEqual([]);
  });

  test("no credential-shaped literal is publishable", () => {
    // Provider key prefixes are distinctive enough to match without also
    // flagging ordinary base64 or hashes, which would make this test useless.
    const patterns = [
      /sk-ant-[A-Za-z0-9_-]{16,}/,
      /\bsk-[A-Za-z0-9]{32,}/,
      /\bghp_[A-Za-z0-9]{20,}/,
      /\bgithub_pat_[A-Za-z0-9_]{20,}/,
      /\bAKIA[A-Z0-9]{16}\b/,
      /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
      /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
      // sk-proj- keys need their own pattern: the hyphens break the 32-char
      // alphanumeric run the bare sk- pattern above requires.
      /\bsk-proj-[A-Za-z0-9_-]{20,}/,
      /\bAIza[A-Za-z0-9_-]{30,}/,
      /\bglpat-[A-Za-z0-9_-]{20,}/,
      /\bhf_[A-Za-z0-9]{30,}/,
      /\bhooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+/,
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"']*:[^\s"'@/]+@/,
    ];
    const offenders: string[] = [];
    for (const rel of publishedFiles()) {
      if (rel === "tests/publication-hygiene.test.ts") continue;
      const content = readIfText(rel);
      if (content === null) continue;
      if (patterns.some((p) => p.test(content))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test("no developer home path is publishable", () => {
    const offenders: string[] = [];
    for (const rel of publishedFiles()) {
      if (rel === "tests/publication-hygiene.test.ts") continue;
      const content = readIfText(rel);
      if (content === null) continue;
      for (const line of content.split(/\r?\n/)) {
        // "/Users/<name>" and "/home/<user>" are documentation placeholders, not
        // real paths, and appear in error-message examples.
        if (/\/(?:Users|home)\/(?!<)[A-Za-z0-9._-]+/.test(line)) {
          offenders.push(`${rel}: ${line.trim().slice(0, 100)}`);
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("declared executables are executable", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };
    const targets = new Set([...Object.values(pkg.bin ?? {}), "install.sh", "scripts/install.sh"]);
    const result = Bun.spawnSync(["git", "ls-files", "--stage", "-z", "--", ...targets], { cwd: ROOT });
    expect(result.exitCode).toBe(0);
    const executable = new Set(result.stdout.toString().split("\0")
      .filter(line => /^100755 [0-9a-f]+ 0\t/.test(line))
      .map(line => line.slice(line.indexOf("\t") + 1)));
    const notExecutable = [...targets].filter(rel => !executable.has(rel));
    expect(notExecutable).toEqual([]);
  });

  test("every bin entry points at a file that exists", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      main?: string;
      bin?: Record<string, string>;
    };
    const missing = [...Object.values(pkg.bin ?? {}), ...(pkg.main ? [pkg.main] : [])].filter(
      (rel) => !fs.existsSync(path.join(ROOT, rel)),
    );
    expect(missing).toEqual([]);
  });

  test("LICENSE attributes the owner", () => {
    const license = fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8");
    expect(license).toContain("MIT License");
    expect(license).toContain("Divyam Talwar");
  });

  test("no markdown link in README points at a missing file", () => {
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    const dead: string[] = [];
    for (const match of readme.matchAll(/\]\((\.\/[^)]+)\)/g)) {
      const target = match[1].replace(/^\.\//, "").split("#")[0];
      if (!fs.existsSync(path.join(ROOT, target))) dead.push(target);
    }
    expect(dead).toEqual([]);
  });
});
