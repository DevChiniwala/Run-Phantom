import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareTeamDirectory } from "../src/team/config";

function fixture(run: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "team directory "));
  try { run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe("team data directory traversal", () => {
  test("creates nested paths without walking the filesystem root twice", () => {
    fixture(root => {
      const target = path.join(root, "nested folder", "team");
      expect(prepareTeamDirectory(target)).toBe(fs.realpathSync(target));
      expect(fs.statSync(target).isDirectory()).toBe(true);
      expect(prepareTeamDirectory(`${target}${path.sep}`)).toBe(fs.realpathSync(target));
      expect(fs.readdirSync(root)).toEqual(["nested folder"]);
      if (process.platform !== "win32") expect(fs.statSync(target).mode & 0o777).toBe(0o700);
    });
  });

  test("resolves a relative path before walking its components", () => {
    fixture(root => {
      const target = path.join(root, "relative", "team");
      expect(prepareTeamDirectory(path.relative(process.cwd(), target))).toBe(fs.realpathSync(target));
    });
  });

  test("rejects a regular file in the parent chain without modifying it", () => {
    fixture(root => {
      const file = path.join(root, "not-a-directory");
      fs.writeFileSync(file, "keep this content");
      expect(() => prepareTeamDirectory(path.join(file, "team"))).toThrow("directory");
      expect(fs.readFileSync(file, "utf8")).toBe("keep this content");
    });
  });

  test("rejects a linked final directory without modifying its target", () => {
    fixture(root => {
      const target = path.join(root, "original");
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, "canary"), "unchanged");
      const link = path.join(root, "linked-team");
      fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
      expect(() => prepareTeamDirectory(link)).toThrow("symbolic links");
      expect(fs.readFileSync(path.join(target, "canary"), "utf8")).toBe("unchanged");
    });
  });

  test("Windows uid zero does not grant an ancestor junction system-alias trust", () => {
    fixture(root => {
      const target = path.join(root, "original");
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, "canary"), "unchanged");
      const link = path.join(root, "linked-parent");
      fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      const realLstat = fs.lstatSync;
      const statSpy = spyOn(fs, "lstatSync").mockImplementation(((candidate: fs.PathLike, options?: unknown) => {
        const stat = realLstat(candidate, options as Parameters<typeof fs.lstatSync>[1]);
        if (String(candidate) === link) Object.defineProperty(stat, "uid", { value: 0 });
        return stat;
      }) as typeof fs.lstatSync);
      try {
        Object.defineProperty(process, "platform", { ...platform, value: "win32" });
        expect(() => prepareTeamDirectory(path.join(link, "team"))).toThrow("symbolic links");
        expect(fs.existsSync(path.join(target, "team"))).toBe(false);
        expect(fs.readFileSync(path.join(target, "canary"), "utf8")).toBe("unchanged");
      } finally {
        statSpy.mockRestore();
        Object.defineProperty(process, "platform", platform);
      }
    });
  });

  test.skipIf(process.platform !== "win32")("native Windows rejects ancestor junctions before creating team state", () => {
    fixture(root => {
      const target = path.join(root, "outside-team");
      fs.mkdirSync(target);
      const link = path.join(root, "ancestor");
      fs.symlinkSync(target, link, "junction");
      expect(() => prepareTeamDirectory(path.join(link, "team"))).toThrow("symbolic links");
      expect(fs.readdirSync(target)).toEqual([]);
    });
  });
});
