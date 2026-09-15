# Regression evaluations

The Evaluations workspace turns captured agent runs into repeatable quality checks. It uses the existing local Run Phantom daemon and SQLite database.

## From a trace to a regression check

1. Open an agent run and choose **Evaluate run**, or open **Evaluations** in the sidebar.
2. Inspect its captured input and selected response. If several responses could represent the result, select the relevant span explicitly.
3. Create a dataset and add a named case. Declare the expected output, JSON value, tool behavior or resource limit; review the expectation before saving.
4. Choose a captured candidate run for every case and start an experiment. A later replay can supply another candidate run after its trace finishes.
5. Inspect each result and its evidence. Compare a baseline and candidate experiment against the same dataset revision, then add a separate human review where useful.

Evaluation scores captured evidence. Starting an experiment does not automatically rerun registered agents or reproduce their environment. The recorded candidate input must match the frozen case input; missing, redacted or different inputs make the case inconclusive. This prevents unrelated tasks from appearing to prove an improvement.

Input matching and response checks operate on captured text. Prompts whose normalization would discard images, audio or files are unavailable for matching; identical text alone does not establish that two multimodal requests are the same.

## Rules and evidence

Deterministic checks support output equality and containment, valid JSON and safe JSON-path equality, required/forbidden tools, ordered tool sequences, recorded errors, and token/duration/reported-cost budgets. Tool order uses completed-call intervals; overlapping or unrecorded intervals cannot establish a strict sequence.

Tool-argument rules compare a declared JSON path in the captured arguments of a named tool with an expected JSON value. Choose **at least one** or **every** matching call. No matching calls fail when identity coverage is complete. At least one proven match satisfies the first mode; one proven contradiction fails the second. Missing, malformed, redacted, or truncated arguments leave the remaining question inconclusive. JSON numbers that change during JavaScript parsing are rejected in expectations and unavailable in captured arguments; encode exact identifiers such as `9007199254740993` as strings. A completed tool call can have known arguments even if execution failed; use an error rule when execution success is required. Historical snapshots without argument evidence remain readable and unavailable for this check; they are never filled from later source edits.

Every check is **pass**, **fail** or **inconclusive**, with its expected and observed values and a reason. A case fails when a declared rule fails. If no rule fails but some evidence is unavailable, the case is inconclusive. Empty cases and datasets cannot produce a successful experiment.

Unknown usage is displayed as **Unavailable**. Cache and reasoning details are not added to totals a second time. Ambiguous nested usage is withheld instead of double-counted. Duration is the wall-time window of captured completed spans. Cost budgets use instrumentation-reported USD cost, with no assumption that an unpriced call was free. These are measurements of captured spans, not a guarantee of complete instrumentation or task correctness.

## Versioning and comparison

Saving a dataset edit appends a new revision; concurrent edits use an expected-version check. Each revision retains its source links, source snapshots, rules and content hash. Exported JSON contains portable definitions and can be imported as a new dataset without executing code.

Experiments freeze the selected revision, every candidate snapshot and the evaluator versions before scoring. Completed machine scores remain unchanged. Comparisons require compatible evaluator/snapshot versions and identical dataset revisions and case membership. Every case contributes to the denominator, including inconclusive results. A missing measurement yields an unavailable delta.

New deterministic checks record `code:2`, which withholds JSON-path comparisons when parsing captured numbers would round, underflow or overflow. Syntax-only JSON checks still validate the captured syntax. Historical `code:1` results remain frozen and cannot be combined with the corrected evaluator in a comparison or repeated-trial analysis. Tool-argument and model-rubric versions remain `toolargs:1` and `rubric:1`.

Human pass/fail reviews and notes are separate, append-only decisions. They do not rewrite automatic scores. Deleting a source run or dataset preserves frozen experiment history. Clearing all local data removes evaluation history and cancels active jobs.

## Repeated-trial evidence

Choose **Analyze repeated trials** to select 2–20 completed or cancelled experiments from one frozen dataset revision. Every selected case and trial stays in the denominator. The same captured run cannot appear twice for a case, including when it was graded again under another experiment name. Distinct captures do not establish independent sampling or identical agent configuration.

The analysis shows passing, failing and inconclusive outcomes, the observed pass fraction, and resolved coverage. Unresolved-outcome bounds range from the fraction already known to pass to the fraction that could pass if all inconclusive outcomes passed. This range reflects missing evidence; it is not a confidence interval. A cancelled or errored experiment keeps its available case results but prevents the all-trial gate from passing.

Download the versioned JSON analysis to retain its exact selection, dataset hash, evaluator versions and compact outcomes. The operation reads frozen experiments without replay or provider calls. Missing history, active experiments, incompatible definitions and selections exceeding 8 MiB of stored evidence reject as a whole; the report is capped at 1 MiB. The HTTP operation is `POST /api/evaluations/analyses/repeated-trials` with `{ "experimentIds": ["FIRST_ID", "SECOND_ID"] }`; MCP uses `eval_run` with `action: "analyze"` and the same `experimentIds`.

## Optional model grading

A rubric rule can request an OpenAI or Anthropic score using credentials configured through Run Phantom's existing Settings or environment. Starting such an experiment requires an explicit opt-in to send the selected, bounded trace data to that provider. Local rules and browsing need no provider call.

The result records the rubric, provider, model, threshold, score and explanation. Model judgment is advisory evidence. Missing credentials, unavailable input/output, invalid responses, cancellation and provider failures produce an inconclusive check. Judge calls cannot run tools, execute test-definition code or select an arbitrary endpoint.

Anthropic grading uses its JSON-schema output format and requires a compatible model; Haiku 4.5 was exercised in live acceptance. OpenAI grading requests JSON-object output. Both providers' responses still undergo local score, explanation and completion validation. See [Anthropic's structured-output documentation](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) for model compatibility.

Jobs expose progress and cancellation. Restarting the daemon preserves completed checks and marks unfinished work inconclusive; it does not silently resume external calls. A completed failure remains visible when another case is interrupted.

## MCP and API

The existing MCP server includes `eval_dataset`, `eval_run`, `eval_compare` and `eval_review`. These use the same `/api/evaluations` service as the UI. Starting a job returns its ID and state; clients can poll or cancel it. Model grading remains opt-in through MCP as well.

`eval_run` with `action: "report"`, `experimentId`, and optional `baseline` returns a compact report and strict quality gate. The HTTP equivalent is `GET /api/evaluations/experiments/:id/report?format=json`; use `format=junit` for XML and `baseline=ID` for a compatible comparison. Reports include identity, versions, case counts, verdicts, and bounded code-check reasons. They omit raw prompts, responses, rule expectations/actual values, and free-form model explanations. Report generation does not change saved scores or make provider calls.

From the repository, `bun scripts/check-evaluation.ts --experiment ID --format junit --output results.junit.xml` writes a new report file and returns 0 only for a complete passing experiment. Failed/inconclusive/nonterminal outcomes return 1; operational errors or incompatible comparisons return 2. An existing output file is not overwritten. JUnit uses failures for contradicted checks and errors for inconclusive evidence or an unfinished experiment gate. All cases remain in the denominator. Optional baseline comparison does not excuse preexisting candidate failures.

Dataset and experiment sizes, input acquisition, retained evidence, job count and provider responses are bounded. Redacted or truncated evidence is identified explicitly. The original trace replay and the application verification tools keep their existing roles.
