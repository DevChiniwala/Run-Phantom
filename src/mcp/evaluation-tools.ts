import { ErrorCode, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { parseDatasetExport, parseDatasetUpdate } from "../evaluations/validation";
import { parseTrialSelection } from "../evaluations/trials";

const text = { type: "string", minLength: 1, maxLength: 128 };
const version = { type: "integer", minimum: 1, maximum: 20 };
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const rule = { oneOf: [
  object({ kind: { const: "output" }, operation: { enum: ["equals", "contains", "notContains"] }, value: { type: "string", maxLength: 4096 } }, ["kind", "operation", "value"]),
  object({ kind: { const: "json" } }, ["kind"]),
  object({ kind: { const: "jsonPath" }, path: { type: "string", maxLength: 1024 }, equals: {} }, ["kind", "path", "equals"]),
  object({ kind: { const: "tools" }, operation: { enum: ["required", "forbidden", "sequence"] }, names: { type: "array", minItems: 1, maxItems: 20, items: text } }, ["kind", "operation", "names"]),
  object({ kind: { const: "toolArgument" }, name: text, path: { type: "string", maxLength: 1024 }, equals: {}, match: { enum: ["any", "all"], description: "any requires a proven matching call; all requires every named call to match. Zero calls fail; unavailable evidence remains inconclusive." } }, ["kind", "name", "path", "equals", "match"]),
  object({ kind: { const: "budget" }, metric: { enum: ["inputTokens", "outputTokens", "totalTokens", "durationMs", "costUsd", "toolCalls"] }, max: { type: "number", minimum: 0 } }, ["kind", "metric", "max"]),
  object({ kind: { const: "errors" }, max: { type: "integer", minimum: 0 } }, ["kind", "max"]),
  object({ kind: { const: "rubric" }, provider: { enum: ["openai", "anthropic"] }, model: text, rubric: { type: "string", minLength: 1, maxLength: 2000 }, threshold: { type: "number", minimum: 0, maximum: 1 } }, ["kind", "provider", "model", "rubric", "threshold"]),
] };
const cases = { type: "array", maxItems: 50, items: object({ id: text, name: text, input: { type: "string", maxLength: 16384 }, sourceRunId: text, sourceSpanId: text, tags: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 64 } }, rules: { type: "array", minItems: 1, maxItems: 8, items: rule } }, ["name", "rules"]) };
const portable = object({ format: { const: "runphantom-evaluations/v1" }, name: text, cases }, ["format", "name", "cases"]);

export const EVALUATION_TOOLS: Tool[] = [
  { name: "eval_dataset", description: "List/get/create/update/import/export/delete versioned regression datasets. Create requires name. Update requires datasetId, expectedVersion and complete cases; concurrent or stale revisions return409. Each case requires explicit rules; sourceRunId/sourceSpanId captures reference input/output, and input is an explicit manual override. Import data is the portable format and never restores trusted source identities. Deletion retains frozen experiment history. No executable evaluators.", inputSchema: { type: "object", required: ["action"], properties: { action: { enum: ["list", "get", "create", "update", "import", "export", "delete"] }, datasetId: text, name: text, version, expectedVersion: version, cases, data: portable }, additionalProperties: false } },
  { name: "eval_run", description: "Snapshot a captured run, start an evaluation experiment, list/get jobs or cancel a job. analyze requires 2–20 distinct experimentIds with identical frozen definitions and distinct captured runs per case; returns observed outcomes and unresolved bounds, not a confidence interval, without rerunning anything. snapshot requires runId and optional outputSpanId. report requires experimentId and optional compatible baseline; returns a compact JSON report with a strict gate, without raw payloads or model explanations. start requires datasetId,name and assignments mapping EVERY revision case once to a captured candidate run. Inputs must match exactly except CRLF normalization; mismatch/unavailable yields inconclusive without model calls. Returns frozen pending/running results and a job id immediately; poll get until terminal. Model rubric calls require explicit allowModelJudges:true consent and send selected trace data externally. Omitted consent never authorizes model calls. This does not replay agents.", inputSchema: { type: "object", required: ["action"], properties: { action: { enum: ["snapshot", "start", "get", "list", "cancel", "report", "analyze"] }, experimentIds: { type: "array", minItems: 2, maxItems: 20, uniqueItems: true, items: text }, baseline: text, runId: text, outputSpanId: text, experimentId: text, datasetId: text, version, name: text, assignments: { type: "array", minItems: 1, maxItems: 50, items: object({ caseId: text, runId: text, outputSpanId: text }, ["caseId", "runId"]) }, allowModelJudges: { type: "boolean" } }, additionalProperties: false } },
  { name: "eval_compare", description: "Compare completed baseline and candidate experiments from the SAME dataset id/revision/hash, case membership and evaluator versions. Returns per-case regressions/improvements/inconclusive and candidate-minus-baseline token/duration/reported-cost deltas. Unknown metrics stay null. Incompatible experiments fail instead of weakening the comparison.", inputSchema: { type: "object", required: ["baseline", "candidate"], properties: { baseline: text, candidate: text }, additionalProperties: false } },
  { name: "eval_review", description: "List append-only human reviews or create a human pass/fail review for a case in an experiment. Human reviews are separate from code/model verdicts and never overwrite automatic scores. create requires experimentId,caseId,rating and optional note.", inputSchema: { type: "object", required: ["action", "experimentId"], properties: { action: { enum: ["list", "create"] }, experimentId: text, caseId: text, rating: { enum: ["pass", "fail"] }, note: { type: "string", maxLength: 2000 } }, additionalProperties: false } },
];

function required(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim() || value.length > 128) throw new McpError(ErrorCode.InvalidParams, `${name} must be a nonempty string of at most 128 characters`);
  return value;
}
function optionalVersion(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 20) throw new McpError(ErrorCode.InvalidParams, `${name} must be a revision number from 1 to 20`);
  return value;
}
async function request(url: string, path: string, method = "GET", body?: unknown) {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  if (encoded && Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw new McpError(ErrorCode.InvalidParams, "Evaluation request exceeds 2 MiB");
  let response: Response;
  try { response = await fetch(`${url.replace(/\/$/, "")}/api/evaluations${path}`, { method, headers: encoded ? { "Content-Type": "application/json" } : undefined, body: encoded }); }
  catch { throw new McpError(ErrorCode.InternalError, "Run Phantom is unreachable. Start the local daemon and retry."); }
  if (response.status === 204) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }] };
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : `Evaluation request failed (${response.status})`;
    throw new McpError(response.status < 500 ? ErrorCode.InvalidParams : ErrorCode.InternalError, error);
  }
  if (value === null) throw new McpError(ErrorCode.InternalError, "Run Phantom returned an invalid evaluation response");
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function datasetRequestBody(value: unknown, portable = false) {
  try { return portable ? parseDatasetExport(value) : parseDatasetUpdate(value); }
  catch (error) { throw new McpError(ErrorCode.InvalidParams, error instanceof Error ? error.message : "Invalid evaluation dataset"); }
}

export async function callEvaluationTool(name: string, args: Record<string, unknown>, backendUrl: string) {
  const tool = EVALUATION_TOOLS.find(item => item.name === name);
  if (!tool) return undefined;
  if (Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties ?? {}, key))) throw new McpError(ErrorCode.InvalidParams, "Unexpected evaluation argument");
  const id = (key: string) => encodeURIComponent(required(args, key));
  switch (name) {
    case "eval_dataset": {
      switch (args.action) {
        case "list": return request(backendUrl, "/datasets");
        case "create": return request(backendUrl, "/datasets", "POST", { name: required(args, "name") });
        case "get": case "export": {
          const revision = optionalVersion(args, "version");
          return request(backendUrl, `/datasets/${id("datasetId")}${args.action === "export" ? "/export" : ""}${revision === undefined ? "" : `?version=${revision}`}`);
        }
        case "update": {
          const expectedVersion = optionalVersion(args, "expectedVersion");
          if (expectedVersion === undefined || !Array.isArray(args.cases)) throw new McpError(ErrorCode.InvalidParams, "expectedVersion and cases are required");
          return request(backendUrl, `/datasets/${id("datasetId")}`, "PUT", datasetRequestBody({ expectedVersion, cases: args.cases }));
        }
        case "import": {
          if (!args.data || typeof args.data !== "object" || Array.isArray(args.data)) throw new McpError(ErrorCode.InvalidParams, "data must be a portable dataset object");
          return request(backendUrl, "/datasets/import", "POST", datasetRequestBody(args.data, true));
        }
        case "delete": return request(backendUrl, `/datasets/${id("datasetId")}`, "DELETE");
        default: throw new McpError(ErrorCode.InvalidParams, "action must be list/get/create/update/import/export/delete");
      }
    }
    case "eval_run": {
      switch (args.action) {
        case "analyze": {
          let experimentIds: string[];
          try { experimentIds = parseTrialSelection({ experimentIds: args.experimentIds }); }
          catch (error) { throw new McpError(ErrorCode.InvalidParams, error instanceof Error ? error.message : "Invalid trial selection"); }
          return request(backendUrl, "/analyses/repeated-trials", "POST", { experimentIds });
        }
        case "list": return request(backendUrl, "/experiments");
        case "snapshot": return request(backendUrl, `/runs/${id("runId")}/snapshot${args.outputSpanId === undefined ? "" : `?outputSpanId=${id("outputSpanId")}`}`);
        case "get": return request(backendUrl, `/experiments/${id("experimentId")}`);
        case "report": return request(backendUrl, `/experiments/${id("experimentId")}/report${args.baseline === undefined ? "" : `?${new URLSearchParams({ baseline: required(args, "baseline") })}`}`);
        case "cancel": return request(backendUrl, `/experiments/${id("experimentId")}/cancel`, "POST");
        case "start": {
          if (!Array.isArray(args.assignments) || !args.assignments.length) throw new McpError(ErrorCode.InvalidParams, "assignments must map every case to a candidate run");
          if (args.allowModelJudges !== undefined && typeof args.allowModelJudges !== "boolean") throw new McpError(ErrorCode.InvalidParams, "allowModelJudges must be boolean");
          return request(backendUrl, "/experiments", "POST", { datasetId: required(args, "datasetId"), name: required(args, "name"), version: optionalVersion(args, "version"), assignments: args.assignments, ...(args.allowModelJudges === undefined ? {} : { allowModelJudges: args.allowModelJudges }) });
        }
        default: throw new McpError(ErrorCode.InvalidParams, "action must be snapshot/start/get/list/cancel/report/analyze");
      }
    }
    case "eval_compare": return request(backendUrl, `/compare?${new URLSearchParams({ baseline: required(args, "baseline"), candidate: required(args, "candidate") })}`);
    case "eval_review": {
      const experimentId = id("experimentId");
      if (args.action === "list") return request(backendUrl, `/experiments/${experimentId}/reviews`);
      if (args.action !== "create" || (args.rating !== "pass" && args.rating !== "fail") || (args.note !== undefined && (typeof args.note !== "string" || args.note.length > 2000))) throw new McpError(ErrorCode.InvalidParams, "create requires rating pass/fail and an optional note up to 2000 characters");
      return request(backendUrl, `/experiments/${experimentId}/reviews`, "POST", { caseId: required(args, "caseId"), rating: args.rating, note: args.note });
    }
  }
}
