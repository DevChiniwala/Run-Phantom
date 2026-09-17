import { expect, test } from "bun:test";
import path from "node:path";
import { devCommands } from "../scripts/dev";

test("development startup launches the daemon and UI without shell operators", () => {
  const root = path.resolve("fixture", "repository");
  expect(devCommands(root)).toEqual([
    { label: "daemon", cmd: [process.execPath, "--watch", "src/index.ts", "serve"], cwd: root },
    { label: "UI", cmd: [process.execPath, "x", "vite", "--force"], cwd: path.join(root, "app") },
  ]);
});
