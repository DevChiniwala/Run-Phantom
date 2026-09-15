import { test as base, expect } from "@playwright/test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

export type RunPhantomHandle = {
  url: string;
  dbPath: string;
  port: number;
};

const DAEMON_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    !key.startsWith("RUNPHANTOM_")
    && key !== "ANTHROPIC_API_KEY"
    && key !== "OPENAI_API_KEY"
  ),
);

async function waitForHealth(url: string, proc: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    if (proc.exitCode != null || proc.signalCode != null) {
      throw new Error(`Run Phantom exited before becoming healthy: ${proc.exitCode ?? proc.signalCode}`);
    }
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Run Phantom /health never came up at ${url}: ${String(lastErr)}`);
}

async function stopProc(p: ChildProcess): Promise<void> {
  if (p.exitCode != null || p.signalCode != null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKillTimer);
      p.off("exit", finish);
      resolve();
    };
    p.once("exit", finish);
    const forceKillTimer = setTimeout(() => {
      if (p.exitCode != null || p.signalCode != null) {
        finish();
        return;
      }
      try {
        p.kill("SIGKILL");
      } finally {
        finish();
      }
    }, 2500);
    try {
      p.kill("SIGTERM");
    } catch {
      finish();
      return;
    }
  });
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("could not resolve a free local port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

export const test = base.extend<{ runPhantom: RunPhantomHandle; localNetworkOnly: void }>({
  localNetworkOnly: [async ({ page }, use) => {
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      const isDocumentLocal = ["about:", "blob:", "data:"].includes(url.protocol);
      if (isLocal || isDocumentLocal) await route.continue();
      else await route.abort("blockedbyclient");
    });
    await use();
  }, { auto: true }],
  runPhantom: async ({}, use, testInfo) => {
    const port = await reservePort();
    const tmp = mkdtempSync(path.join(realpathSync(tmpdir()), `runphantom-w${testInfo.workerIndex}-`));
    const dbPath = path.join(tmp, "runphantom.db");
    mkdirSync(path.dirname(dbPath), { recursive: true });

    const proc = spawn("bun", ["src/index.ts", "serve"], {
      cwd: REPO_ROOT,
      env: {
        ...DAEMON_ENV,
        HOME: tmp,
        USERPROFILE: tmp,
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        RUNPHANTOM_OPENAI_API_KEY: "",
        RUNPHANTOM_PORT: String(port),
        RUNPHANTOM_BIND_HOST: "127.0.0.1",
        RUNPHANTOM_ALLOWED_HOSTS: "",
        RUNPHANTOM_ALLOWED_SOURCE_IPS: "",
        RUNPHANTOM_ALLOWED_ORIGINS: "",
        RUNPHANTOM_DB_PATH: dbPath,
        RUNPHANTOM_SECRET_STORE_PATH: path.join(tmp, "secrets.json"),
        RUNPHANTOM_CLAUDE_CLI_CHAT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const logs: string[] = [];
    let stopping = false;
    proc.stdout?.on("data", (d) => logs.push(`[runphantom ${port}] ${d}`));
    proc.stderr?.on("data", (d) => logs.push(`[runphantom ${port}!] ${d}`));
    proc.on("exit", (code, signal) => {
      if (!stopping) {
        console.error(`[runphantom ${port}] exited unexpectedly (${code ?? signal})\n${logs.slice(-50).join("")}`);
      }
    });

    try {
      await waitForHealth(`http://localhost:${port}`, proc, 45_000);
      await use({ url: `http://localhost:${port}`, dbPath, port });
    } catch (err) {
      console.error(logs.slice(-50).join(""));
      throw err;
    } finally {
      stopping = true;
      await stopProc(proc);
      rmSync(tmp, { recursive: true, force: true });
    }
  },
});

export { expect };
export const REPO_ROOT_PATH = REPO_ROOT;
