import { createTeamServer } from "./server";
import { loadTeamConfig } from "./config";
import { TeamError } from "./errors";
import { EventEmitter } from "node:events";

export async function runTeamCli(args: string[]): Promise<number> {
  if (!args.length || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    console.log("Run Phantom team\n\n  runphantom team serve\n\nConfigure RUNPHANTOM_TEAM_PORT, RUNPHANTOM_TEAM_DATA_DIR and RUNPHANTOM_TEAM_PUBLIC_ORIGIN.\nDefault: loopback port 5949. Shared use requires HTTPS and configured trusted proxy peers.");
    return 0;
  }
  if (args.length !== 1 || args[0] !== "serve") { console.error("Unknown team command. Use runphantom team --help."); return 1; }
  let handle: Awaited<ReturnType<typeof createTeamServer>> | undefined;
  try {
    handle = await createTeamServer(loadTeamConfig());
    await new Promise<void>((resolve, reject) => { handle!.server.once("error", reject); handle!.server.listen(handle!.config.port, handle!.config.bindHost, () => { handle!.server.off("error", reject); resolve(); }); });
    console.log(`Run Phantom team: ${handle.config.publicOrigin}/team`);
    if (handle.store.setupRequired() && handle.bootstrapFile) console.log(`Read the private setup code from: ${handle.bootstrapFile}`);
    await new Promise<void>(resolve => {
      const shutdown = () => {
        EventEmitter.prototype.removeListener.call(process, "SIGINT", shutdown);
        EventEmitter.prototype.removeListener.call(process, "SIGTERM", shutdown);
        void handle!.close().then(resolve);
      };
      process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
    });
    return 0;
  } catch (error) {
    if (handle) await handle.close();
    console.error(error instanceof TeamError ? error.message : "Run Phantom team could not start. Check the configured port and private data directory.");
    return 1;
  }
}
