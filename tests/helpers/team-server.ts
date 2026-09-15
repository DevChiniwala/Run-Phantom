import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

const root = path.resolve(__dirname, "../..");

export async function startTeamFixture(name = "integration", binary?: string) {
  const profile = mkdtempSync(path.join(tmpdir(), `runphantom-team-${name}-`));
  const dataDir = path.join(profile, "team");
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const url = `http://127.0.0.1:${port}`;
  const setupCode = randomBytes(32).toString("base64url");
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("RUNPHANTOM_") && key !== "OPENAI_API_KEY" && key !== "ANTHROPIC_API_KEY"));
  const runtime = process.versions.bun ? process.execPath : "bun";
  const child = spawn(binary ?? runtime,
    binary ? ["team", "serve"] : [path.join(root, "src/index.ts"), "team", "serve"], {
      cwd: profile,
      env: {
        ...inherited,
        HOME: profile,
        USERPROFILE: profile,
        RUNPHANTOM_TEAM_DATA_DIR: dataDir,
        RUNPHANTOM_TEAM_PORT: String(port),
        RUNPHANTOM_TEAM_BIND_HOST: "127.0.0.1",
        RUNPHANTOM_TEAM_PUBLIC_ORIGIN: url,
        RUNPHANTOM_TEAM_BOOTSTRAP_CODE: setupCode,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  let output = "";
  const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-32_768); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  let launchError: Error | null = null;
  child.on("error", error => { launchError = error; });
  const close = async () => {
    if (!launchError && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        child.kill("SIGTERM");
      });
    }
    rmSync(profile, { recursive: true, force: true });
  };
  try {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (launchError || child.exitCode !== null) throw new Error(`Team fixture could not start: ${output}`);
      try {
        const response = await fetch(`${url}/api/team/session`, { signal: AbortSignal.timeout(500) });
        if (response.status === 200) return { url, profile, dataDir, setupCode, close, logs: () => output };
      } catch { /* server is starting */ }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Team fixture startup timed out: ${output}`);
  } catch (error) {
    await close();
    throw error;
  }
}

export type TeamFixture = Awaited<ReturnType<typeof startTeamFixture>>;
