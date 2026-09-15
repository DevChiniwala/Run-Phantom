#!/usr/bin/env node
/** Select shared or local authority before loading either runtime. */
if (process.argv[2] === "team") {
  try {
    const { runTeamCli } = await import("./team/cli");
    process.exit(await runTeamCli(process.argv.slice(3)));
  } catch {
    console.error("Run Phantom team could not start. Check the team configuration and data directory.");
    process.exit(1);
  }
} else {
  await import("./local-cli");
}

export {};
