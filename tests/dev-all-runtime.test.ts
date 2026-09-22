import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  binOnPath,
  executableCandidates,
  pathEntries,
  pythonPipPath,
  pythonVenvPath,
} from "../scripts/dev-all";

describe("example runtime discovery", () => {
  test("uses the platform path delimiter", () => {
    expect(pathEntries("C:\\tools;C:\\other", "win32")).toEqual(["C:\\tools", "C:\\other"]);
    expect(pathEntries("/tools:/other", "linux")).toEqual(["/tools", "/other"]);
  });

  test("recognizes Windows executable extensions", () => {
    expect(executableCandidates("cargo", "win32", ".EXE;.CMD")).toEqual([
      "cargo",
      "cargo.EXE",
      "cargo.CMD",
    ]);
    expect(executableCandidates("cargo.exe", "win32", ".EXE;.CMD")).toEqual(["cargo.exe"]);
    expect(executableCandidates("python3.13", "win32", ".EXE;.CMD")).toEqual([
      "python3.13",
      "python3.13.EXE",
      "python3.13.CMD",
    ]);
  });

  test("discovers Windows Python and virtual-environment paths", () => {
    expect(pythonVenvPath("C:\\fixture", "win32")).toBe("C:\\fixture\\.venv\\Scripts\\python.exe");
    expect(pythonPipPath("C:\\fixture", "win32")).toBe("C:\\fixture\\.venv\\Scripts\\pip.exe");
  });

  test("finds an executable in the host PATH", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runphantom-runtime-"));
    const name = process.platform === "win32" ? "fixture.cmd" : "fixture";
    fs.writeFileSync(path.join(root, name), "");
    const env = {
      PATH: root,
      PATHEXT: ".CMD",
    };
    try {
      expect(binOnPath("fixture", env, process.platform)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
