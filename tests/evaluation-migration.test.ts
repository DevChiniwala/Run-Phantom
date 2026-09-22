import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, getDrizzleDb } from "../src/db";
import { createEvaluationService } from "../src/evaluations/service";
import { addReview, getExperiment, getRevision, listReviews } from "../src/evaluations/store";

interface MigrationJournal {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
}

test("evaluation migration upgrades schema 0005 without changing traces or verification and persists scored revisions and reviews", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "runphantom-evaluation-migration-"));
  const dbPath = path.join(directory, "prior-workspace.db");
  const priorMigrations = path.join(directory, "prior-migrations");
  const sourceMigrations = path.resolve(import.meta.dir, "../drizzle");
  const journal = JSON.parse(readFileSync(path.join(sourceMigrations, "meta/_journal.json"), "utf8")) as MigrationJournal;
  const priorEntries = journal.entries.filter((entry) => entry.idx <= 5);
  const previousDb = process.env.RUNPHANTOM_DB_PATH;
  let baseline: Database | null = null;
  let upgraded: Database | null = null;
  let reopened: Database | null = null;
  let service: ReturnType<typeof createEvaluationService> | undefined;
  closeDb();

  try {
    expect(priorEntries.map((entry) => entry.idx)).toEqual([0, 1, 2, 3, 4, 5]);
    mkdirSync(path.join(priorMigrations, "meta"), { recursive: true });
    writeFileSync(path.join(priorMigrations, "meta/_journal.json"), JSON.stringify({ ...journal, entries: priorEntries }));
    for (const entry of priorEntries) copyFileSync(path.join(sourceMigrations, `${entry.tag}.sql`), path.join(priorMigrations, `${entry.tag}.sql`));
    baseline = new Database(dbPath, { create: true });
    baseline.exec("PRAGMA legacy_alter_table = ON");
    baseline.exec("PRAGMA foreign_keys = OFF");
    migrate(drizzle(baseline), { migrationsFolder: priorMigrations });
    baseline.exec("PRAGMA foreign_keys = ON");
    baseline.exec("PRAGMA legacy_alter_table = OFF");
    expect(baseline.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'evaluation_%'").all()).toEqual([]);

    const before = 1_780_000_000_000;
    baseline.query("INSERT INTO runs (id, name, started_at, last_updated_at) VALUES (?, ?, ?, ?)")
      .run("historical-checkout", "Historical checkout", before, before + 100);
    baseline.query("INSERT INTO spans (run_id, id, name, span_type, status, input_payload, output_payload, start_time_ms, end_time_ms, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("historical-checkout", "historical-root", "Checkout answer", "AGENT_ROOT", "OK", "Describe the checkout result.", '{"status":"paid"}', before, before + 100, 100);
    const priorContext = JSON.stringify({ origin: "http://127.0.0.1:3000", quietMs: 300, redacted: false, truncated: false, checks: [{
      step: 1, predicate: { kind: "network", urlContains: "/api/checkout", status: 200 }, status: "pass",
      reason: "The response was observed.", since: 10, through: 14, generation: 1,
      coverage: { network: true, console: true, dom: true, state: true, signal: true, route: true },
      complete: true, dropped: 0, settled: true,
    }] });
    baseline.query("INSERT INTO verification_flows (id, name, origin, steps, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("historical-flow", "Historical checkout flow", "http://127.0.0.1:3000", JSON.stringify([{ command: { type: "click", selector: "#checkout" }, predicate: { kind: "network", urlContains: "/api/checkout", status: 200 } }]), before + 110);
    baseline.query("INSERT INTO verification_reports (id, session_id, run_id, flow_id, name, status, reason, evidence, context, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("historical-report", "historical-session", "historical-checkout", "historical-flow", "Prior runtime evidence", "pass", "A response was observed.", "[]", priorContext, before + 120);
    const original = {
      runs: baseline.query("SELECT * FROM runs ORDER BY id").all(),
      spans: baseline.query("SELECT * FROM spans ORDER BY run_id, id").all(),
      flows: baseline.query("SELECT * FROM verification_flows ORDER BY id").all(),
      reports: baseline.query("SELECT * FROM verification_reports ORDER BY id").all(),
      history: baseline.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at").all(),
    };
    expect(original.history).toHaveLength(6);
    baseline.close(true);
    baseline = null;

    process.env.RUNPHANTOM_DB_PATH = dbPath;
    upgraded = getDrizzleDb().$client;
    expect(upgraded.query("SELECT * FROM runs ORDER BY id").all()).toEqual(original.runs);
    expect(upgraded.query("SELECT * FROM spans ORDER BY run_id, id").all()).toEqual(original.spans);
    expect(upgraded.query("SELECT * FROM verification_flows ORDER BY id").all()).toEqual(original.flows);
    expect(upgraded.query("SELECT * FROM verification_reports ORDER BY id").all()).toEqual(original.reports);
    const upgradedHistory = upgraded.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at").all();
    expect(upgradedHistory).toHaveLength(journal.entries.length);
    expect(upgradedHistory.slice(0, 6)).toEqual(original.history);

    service = createEvaluationService();
    const initial = service.createDataset({ name: "Migrated checkout dataset" });
    const revision = service.updateDataset(initial.datasetId, { expectedVersion: initial.version, cases: [{
      name: "Original checkout answer", sourceRunId: "historical-checkout",
      rules: [{ kind: "output", operation: "contains", value: "paid" }],
    }] });
    const started = service.start({ datasetId: revision.datasetId, version: revision.version, name: "Evaluation after upgrade",
      assignments: [{ caseId: revision.cases[0].id, runId: "historical-checkout" }] });
    const deadline = Date.now() + 3000;
    while (getExperiment(started.id).status !== "completed" && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    const experiment = getExperiment(started.id);
    expect(experiment.status).toBe("completed");
    expect(experiment.verdict).toBe("pass");
    expect(experiment.results[0].checks[0]).toMatchObject({ status: "pass", source: "code", evaluatorVersion: "code:2" });
    const review = addReview(experiment.id, { caseId: revision.cases[0].id, rating: "fail", note: "Human feedback remains independent of the passing text check." });
    expect(getExperiment(experiment.id).verdict).toBe("pass");

    service.close();
    service = undefined;
    upgraded.close(true);
    upgraded = null;
    closeDb();
    reopened = getDrizzleDb().$client;
    expect(getRevision(initial.datasetId, 1)).toEqual(initial);
    expect(getRevision(revision.datasetId)).toEqual(revision);
    expect(getExperiment(experiment.id)).toEqual(experiment);
    expect(listReviews(experiment.id)).toEqual([review]);
    expect(reopened.query("SELECT * FROM runs ORDER BY id").all()).toEqual(original.runs);
    expect(reopened.query("SELECT * FROM spans ORDER BY run_id, id").all()).toEqual(original.spans);
    expect(reopened.query("SELECT * FROM verification_flows ORDER BY id").all()).toEqual(original.flows);
    expect(reopened.query("SELECT * FROM verification_reports ORDER BY id").all()).toEqual(original.reports);
    expect(reopened.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at").all()).toEqual(upgradedHistory);
    expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    try {
      service?.close();
      // The baseline is not globally owned; close every acquired client strictly
      // before resetting global state. Release aliases before closeDb collects.
      baseline?.close(true); baseline = null;
      upgraded?.close(true); upgraded = null;
      reopened?.close(true); reopened = null;
      closeDb();
    } finally {
      if (previousDb === undefined) delete process.env.RUNPHANTOM_DB_PATH;
      else process.env.RUNPHANTOM_DB_PATH = previousDb;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
