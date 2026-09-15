#!/usr/bin/env bun
import { writeFile } from "node:fs/promises";
import { EVALUATION_VERSION, SNAPSHOT_VERSION, EVALUATION_LIMITS as L } from "../src/evaluations/protocol";
import { REPORT_FORMAT, MAX_REPORT_BYTES, evaluationReportJUnit, type EvaluationReport } from "../src/evaluations/report";

const HELP = `Usage: bun scripts/check-evaluation.ts --experiment ID [--baseline ID] [--url http://127.0.0.1:5947] [--format json|junit] [--output FILE]

Checks a frozen experiment without rerunning agents or calling providers.
Exit codes: 0 all cases pass; 1 failed/inconclusive/nonterminal gate; 2 invalid arguments, incompatible comparison, or operational failure.
Without --output, the report is written to stdout. Diagnostics go to stderr.`;

async function readReport(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Daemon returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REPORT_BYTES) throw new Error("Report exceeds 1 MiB");
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new Error("Daemon returned invalid JSON"); }
  } finally { await reader.cancel().catch(() => {}); }
}

function validReport(value: unknown, id: string, baseline?: string): value is EvaluationReport {
  const keys = (item: unknown, allowed: string[]): boolean => !!item && typeof item === "object" && !Array.isArray(item)
    && Object.keys(item).every(key => allowed.includes(key));
  const text = (item: unknown, max = 128): item is string => typeof item === "string" && item.length > 0 && item.length <= max;
  const count = (item: unknown): item is number => typeof item === "number" && Number.isSafeInteger(item) && item >= 0 && item <= L.MAX_CASES;
  const status = (item: unknown) => item === "pass" || item === "fail" || item === "inconclusive";
  if (!keys(value, ["format", "experiment", "dataset", "summary", "gate", "cases", "comparison"])) return false;
  const report = value as EvaluationReport;
  if (report.format !== REPORT_FORMAT || !keys(report.experiment, ["id", "name", "status", "evaluationVersion", "snapshotVersion", "createdAt", "completedAt"])
    || !keys(report.dataset, ["id", "name", "version", "hash"]) || !keys(report.summary, ["total", "pass", "fail", "inconclusive", "passRate"])
    || !keys(report.gate, ["pass", "reasons"]) || !Array.isArray(report.cases) || report.cases.length > L.MAX_CASES) return false;
  const experiment = report.experiment, dataset = report.dataset, summary = report.summary;
  if (experiment.id !== id || !text(experiment.name) || !["queued", "running", "completed", "cancelled"].includes(experiment.status)
    || experiment.evaluationVersion !== EVALUATION_VERSION || experiment.snapshotVersion !== SNAPSHOT_VERSION
    || !Number.isFinite(experiment.createdAt) || !(experiment.completedAt === null || Number.isFinite(experiment.completedAt))) return false;
  if (!text(dataset.id) || !text(dataset.name) || !text(dataset.hash) || !Number.isSafeInteger(dataset.version) || dataset.version < 1) return false;
  if (![summary.total, summary.pass, summary.fail, summary.inconclusive].every(count) || summary.total !== report.cases.length
    || summary.total !== summary.pass + summary.fail + summary.inconclusive || summary.passRate !== (summary.total ? summary.pass / summary.total : 0)) return false;
  if (typeof report.gate.pass !== "boolean" || !Array.isArray(report.gate.reasons) || report.gate.reasons.length > 16
    || !report.gate.reasons.every(reason => text(reason, L.MAX_REASON)) || report.gate.pass !== (report.gate.reasons.length === 0)) return false;
  const ids = new Set<string>();
  const observed = { pass: 0, fail: 0, inconclusive: 0 };
  for (const result of report.cases) {
    if (!keys(result, ["id", "name", "runId", "status", "checks"]) || !text(result.id) || ids.has(result.id) || !text(result.name) || !text(result.runId)
      || !status(result.status) || !Array.isArray(result.checks) || result.checks.length > L.MAX_RULES) return false;
    ids.add(result.id); observed[result.status]++;
    for (const check of result.checks) {
      if (!keys(check, ["status", "source", "evaluatorVersion", "reason"]) || !status(check.status)
        || !(check.source === "code" && ["code:1", "code:2", "toolargs:1"].includes(check.evaluatorVersion)
          || check.source === "llm" && check.evaluatorVersion === "rubric:1")
        || !text(check.reason, L.MAX_REASON)) return false;
    }
    if (result.status === "pass" && (!result.checks.length || !result.checks.every(check => check.status === "pass"))) return false;
  }
  if (observed.pass !== summary.pass || observed.fail !== summary.fail || observed.inconclusive !== summary.inconclusive) return false;
  if (baseline === undefined) { if (report.comparison !== null) return false; }
  else {
    const comparison = report.comparison;
    if (!keys(comparison, ["baselineId", "candidateId", "summary"]) || !comparison || comparison.baselineId !== baseline || comparison.candidateId !== id
      || !keys(comparison.summary, ["regressions", "improvements", "unchanged", "inconclusive"])) return false;
    const counts = comparison.summary;
    if (![counts.regressions, counts.improvements, counts.unchanged, counts.inconclusive].every(count)
      || counts.regressions + counts.improvements + counts.unchanged + counts.inconclusive !== summary.total) return false;
    if (report.gate.pass && (counts.regressions || counts.inconclusive)) return false;
  }
  return !report.gate.pass || experiment.status === "completed" && summary.total > 0 && summary.pass === summary.total;
}

export async function checkEvaluation(args: string[]): Promise<number> {
  try {
    if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) { console.log(HELP); return 0; }
    const values: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i];
      if (!["--experiment", "--baseline", "--url", "--format", "--output"].includes(flag) || Object.hasOwn(values, flag) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("Invalid or duplicate argument. Use --help for usage.");
      values[flag] = args[i + 1];
    }
    const id = values["--experiment"];
    if (!id || id.length > 128 || values["--baseline"]?.length > 128) throw new Error("--experiment and optional --baseline must be IDs up to 128 characters");
    const format = values["--format"] ?? "json";
    if (format !== "json" && format !== "junit") throw new Error("--format must be json or junit");
    const base = new URL(values["--url"] ?? process.env.RUNPHANTOM_URL ?? "http://127.0.0.1:5947");
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new Error("--url must be an HTTP origin without credentials, path, query or fragment");
    const url = new URL(`/api/evaluations/experiments/${encodeURIComponent(id)}/report`, base);
    if (values["--baseline"]) url.searchParams.set("baseline", values["--baseline"]);
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "error" });
    if (!response.ok) throw new Error(`Evaluation report request failed (HTTP ${response.status}); check experiment and baseline compatibility`);
    const report = await readReport(response);
    if (!validReport(report, id, values["--baseline"])) throw new Error("Daemon returned an invalid evaluation report");
    const output = format === "junit" ? evaluationReportJUnit(report) : `${JSON.stringify(report, null, 2)}\n`;
    if (Buffer.byteLength(output, "utf8") > MAX_REPORT_BYTES) throw new Error("Formatted report exceeds 1 MiB");
    if (values["--output"]) await writeFile(values["--output"], output, { flag: "wx" });
    else process.stdout.write(output);
    console.error(report.gate.pass ? "Evaluation gate passed." : `Evaluation gate failed: ${report.gate.reasons.join(" ")}`);
    return report.gate.pass ? 0 : 1;
  } catch (cause) {
    // Do not echo server bodies, credentials in URLs, or captured trace content to CI logs.
    console.error(cause instanceof Error ? cause.message.replace(/https?:\/\/\S+/g, "[URL]") : "Evaluation gate failed operationally");
    return 2;
  }
}

if (import.meta.main) process.exitCode = await checkEvaluation(process.argv.slice(2));
