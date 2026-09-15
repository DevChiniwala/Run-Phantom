import { createHash, randomUUID } from "node:crypto";
import { EVALUATION_VERSION, SNAPSHOT_VERSION, type RuleResult, type Status } from "../evaluations/protocol";
import { snapshotRun } from "../evaluations/snapshot";
import { boundRuleResult, CODE_EVALUATOR_VERSION, TOOL_ARGUMENT_EVALUATOR_VERSION, evaluateRule } from "../evaluations/rules";
import { EvaluationError, fields, object, parseRule } from "../evaluations/validation";
import { TEAM_CHECK_FORMAT, TEAM_LIMITS as L, type Check, type CheckCreate, type CheckReport, type CheckSummary, type PageQuery } from "./protocol";
import { TeamError } from "./errors";
import { redactTeamText } from "./ingest";
import type { ProjectContext, TeamStore } from "./store";

type CheckStore = Pick<TeamStore, "projectScope" | "acquireCheckEvidence" | "persistCheck" | "listChecks" | "getCheck" | "getCheckReport">;
const fold = (values: Status[]): Status => values.includes("fail") ? "fail" : !values.length || values.includes("inconclusive") ? "inconclusive" : "pass";
const yieldTurn = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export function parseCheckCreate(body: unknown): CheckCreate {
  try {
    const value = object(body); fields(value, ["name", "referenceRunId", "candidateRunIds", "rules"]);
    if (typeof value.name !== "string" || !value.name.trim() || Array.from(value.name).length > L.NAME_CHARACTERS || Buffer.byteLength(value.name) > L.NAME_BYTES) throw new Error();
    const runId = (id: unknown): string => { if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) throw new Error(); return id; };
    if (!Array.isArray(value.candidateRunIds) || !value.candidateRunIds.length || value.candidateRunIds.length > L.CHECK_CANDIDATES ||
      !Array.isArray(value.rules) || !value.rules.length || value.rules.length > L.CHECK_RULES) throw new Error();
    const candidateRunIds = value.candidateRunIds.map(runId);
    if (new Set(candidateRunIds).size !== candidateRunIds.length) throw new Error();
    const rules = value.rules.map(raw => {
      const rule = parseRule(raw); if (rule.kind === "rubric") throw new Error(); return rule;
    });
    const definition = { name: value.name, referenceRunId: runId(value.referenceRunId), candidateRunIds, rules };
    const encoded = JSON.stringify(definition);
    if (Buffer.byteLength(encoded) > L.CHECK_REQUEST_BYTES) throw new TeamError("too_large", "Check definition exceeds its size limit");
    if (redactTeamText(encoded) !== encoded) throw new Error();
    return structuredClone(definition);
  } catch (error) {
    if (error instanceof TeamError) throw error;
    throw new TeamError("invalid_request", "Check requires a safe name, project run identifiers and bounded deterministic rules");
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) result[key] = canonical((value as Record<string, unknown>)[key]);
    return result;
  }
  return value;
}
function boundedReason(value: string): string {
  let result = "";
  for (const char of redactTeamText(value)) { if (Buffer.byteLength(result + char) > 512) break; result += char; }
  return result;
}
export function summarizeCheck(check: Check): CheckSummary {
  return { id: check.id, projectId: check.projectId, name: check.name, author: { id: check.author.id, email: check.author.email }, createdAt: check.createdAt,
    referenceRunId: check.referenceRunId, candidateRunIds: [...check.candidateRunIds], status: check.status, counts: { ...check.counts },
    evaluationVersion: check.evaluationVersion, snapshotVersion: check.snapshotVersion, definitionDigest: check.definitionDigest, calculationDurationMs: check.calculationDurationMs };
}
export function createCheckReport(check: Check): CheckReport {
  const report: CheckReport = { format: TEAM_CHECK_FORMAT, check: summarizeCheck(check), results: check.results.map(result => ({ runId: result.runId,
    inputMatch: result.inputMatch, status: result.status, rules: result.ruleResults.map((rule, index) => ({ kind: check.definition.rules[index].kind,
      status: rule.status, evaluatorVersion: rule.evaluatorVersion, reason: boundedReason(rule.reason), redacted: rule.redacted, truncated: rule.truncated || Buffer.byteLength(rule.reason) > 512 })) })) };
  if (Buffer.byteLength(JSON.stringify(report)) > L.CHECK_BYTES) throw new TeamError("too_large", "Saved check report exceeds its size limit");
  return report;
}

/** Explicit scoped store plus pure captured-evidence rules; never imports the local evaluation service or judge. */
export class TeamCheckService {
  private active = 0;
  private closed = false;
  private globalStarts: number[] = [];
  private userStarts = new Map<string, number[]>();
  constructor(private readonly store: CheckStore) {}

  private cancelled(signal?: AbortSignal): void {
    if (this.closed || signal?.aborted) throw new TeamError("conflict", "Check creation was cancelled");
  }
  private admit(userId: string): void {
    const cutoff = Date.now() - L.RATE_WINDOW_MS;
    this.globalStarts = this.globalStarts.filter(time => time > cutoff);
    for (const [id, starts] of this.userStarts) {
      const current = starts.filter(time => time > cutoff);
      if (current.length) this.userStarts.set(id, current); else this.userStarts.delete(id);
    }
    const starts = this.userStarts.get(userId) ?? [];
    if (this.active >= L.CHECK_CONCURRENCY) throw new TeamError("rate_limited", "Two check calculations are already active", undefined, 1);
    if (starts.length >= L.CHECKS_PER_USER || this.globalStarts.length >= L.CHECKS_GLOBAL) throw new TeamError("rate_limited", "Check creation rate limit reached", undefined, 60);
    const now = Date.now(); starts.push(now); this.userStarts.set(userId, starts); this.globalStarts.push(now); this.active++;
  }
  async create(scope: ProjectContext, body: unknown, signal?: AbortSignal): Promise<Check> {
    this.cancelled(signal);
    this.store.projectScope(scope, scope.projectId, "editor");
    const definition = parseCheckCreate(body);
    this.admit(scope.user.id);
    try {
      await yieldTurn(); this.cancelled(signal);
      this.store.projectScope(scope, scope.projectId, "editor");
      const evidence = this.store.acquireCheckEvidence(scope, [...new Set([definition.referenceRunId, ...definition.candidateRunIds])], Buffer.byteLength(JSON.stringify(definition)));
      const started = performance.now();
      const snapshots = new Map(evidence.runs.map(item => [item.run.id, snapshotRun(item.run, item.spans)]));
      const referenceSnapshot = snapshots.get(definition.referenceRunId);
      if (!referenceSnapshot || definition.candidateRunIds.some(id => !snapshots.has(id))) throw new TeamError("not_found", "Run not found");
      const results: Check["results"] = definition.candidateRunIds.map(runId => {
        const snapshot = snapshots.get(runId)!;
        const inputMatch = !referenceSnapshot.complete || referenceSnapshot.input === null || snapshot.input === null ? "unavailable" as const
          : referenceSnapshot.input.replace(/\r\n/g, "\n") === snapshot.input.replace(/\r\n/g, "\n") ? "match" as const : "mismatch" as const;
        const ruleResults: RuleResult[] = definition.rules.map(rule => inputMatch === "match" ? evaluateRule(rule, snapshot) : boundRuleResult({
          status: "inconclusive", source: "code", evaluatorVersion: rule.kind === "toolArgument" ? TOOL_ARGUMENT_EVALUATOR_VERSION : CODE_EVALUATOR_VERSION,
          score: null, reason: inputMatch === "mismatch" ? "Candidate input does not match the frozen reference input" : "Complete matching reference and candidate input is unavailable",
          actual: null, expected: null, spanIds: [], redacted: referenceSnapshot.redacted || snapshot.redacted, truncated: referenceSnapshot.truncated || snapshot.truncated,
        }));
        return { runId, inputMatch, status: fold(ruleResults.map(result => result.status)), snapshot, ruleResults };
      });
      const counts = { total: results.length, pass: 0, fail: 0, inconclusive: 0 };
      for (const result of results) counts[result.status]++;
      const definitionDigest = createHash("sha256").update(JSON.stringify(canonical({ definition, referenceInput: referenceSnapshot.input }))).digest("hex");
      const check: Check = { id: randomUUID(), projectId: scope.projectId, name: definition.name, author: { ...evidence.author }, createdAt: evidence.acquiredAt,
        referenceRunId: definition.referenceRunId, candidateRunIds: [...definition.candidateRunIds], status: fold(results.map(result => result.status)), counts,
        evaluationVersion: EVALUATION_VERSION, snapshotVersion: SNAPSHOT_VERSION, definitionDigest, calculationDurationMs: Math.max(0, performance.now() - started),
        definition, referenceSnapshot, results };
      if (Buffer.byteLength(JSON.stringify(check)) > L.CHECK_BYTES) throw new TeamError("too_large", "Saved check exceeds its size limit");
      const report = createCheckReport(check);
      await yieldTurn(); this.cancelled(signal);
      this.store.projectScope(scope, scope.projectId, "editor");
      return this.store.persistCheck(scope, check, report);
    } catch (error) {
      if (error instanceof EvaluationError) throw new TeamError(error.status === 413 ? "too_large" : "invalid_request", "Captured evidence cannot be evaluated within the check limits");
      throw error;
    } finally { this.active--; }
  }
  list(scope: ProjectContext, query?: PageQuery) { return this.store.listChecks(scope, query); }
  get(scope: ProjectContext, id: string) { return this.store.getCheck(scope, id); }
  report(scope: ProjectContext, id: string) { return this.store.getCheckReport(scope, id); }
  close(): void { this.closed = true; }
}
