# Run Phantom

Run Phantom is a local-first debugger for AI-agent runs. It captures traces,
spans, tool calls, replay state, and local agent context so you can inspect what
happened instead of guessing.

Owned and maintained by Divyam Talwar, who holds all rights in the software.

**See the run. Find the reason.**

## What It Does

- Runs a local daemon and UI for inspecting agent runs
- Ingests OTLP traces and stores them in SQLite
- Searches, annotates, saves, exports, and compares trace evidence
- Searches the full local trace store, including captured prompts and tool results, with status/model/provider filters
- Replays captured runs against project-owned local replay endpoints
- Opens trace-aware Claude Code or Codex sessions when those local CLIs are installed
- Exposes MCP and CLI entry points for supported local workflows
- Checks tool arguments in frozen regression cases and exports JSON/JUnit reports for CI
- Compares captured changes and analyzes repeated trials with explicit missing-evidence bounds
- Shares project traces, notes, and saved checks through an isolated authenticated team service
- Ships as source-first code from this repository

## Build and Run

Run Phantom requires Bun 1.4.0 or newer.

```bash
bun install --frozen-lockfile
bun run dev
```

`bun run dev` starts the daemon on `:5947` and the Vite UI on `:5948` by
default.

To run the example suite:

```bash
bun run dev:examples
```

## CLI

From a source checkout the CLI is not on your `PATH`. `bun install` links a
`runphantom-dev` wrapper into `node_modules/.bin`, so invoke it with `bun x`:

```bash
bun x runphantom-dev            # start the daemon and open the UI
bun x runphantom-dev serve      # run in the foreground
bun x runphantom-dev start      # run in the background
bun x runphantom-dev stop
bun x runphantom-dev status
bun x runphantom-dev open
bun x runphantom-dev connect    # configure this project for local OTLP export
bun x runphantom-dev setup      # install skills and MCP into supported agents
bun x runphantom-dev reset      # delete local traces after confirmation
bun x runphantom-dev mcp        # serve MCP over stdio
bun x runphantom-dev sync
bun x runphantom-dev replay register
bun x runphantom-dev team serve # shared projects in a separate service on :5949
bun x runphantom-dev uninstall
```

`bun x runphantom-dev --help` prints the authoritative list.

To get a real `runphantom` binary on your `PATH`, build and install it from
this checkout:

```bash
bun run install:local
```

Environment overrides:

| Env var | Purpose | Default |
| --- | --- | --- |
| `RUNPHANTOM_PORT` | HTTP + WebSocket port | `5947` |
| `RUNPHANTOM_BIND_HOST` | Daemon bind address | `127.0.0.1` |
| `RUNPHANTOM_UI_PORT` | Vite dev UI port | `5948` |
| `RUNPHANTOM_DB_PATH` | SQLite database file | `~/.runphantom/runphantom.db` |
| `RUNPHANTOM_ALLOWED_HOSTS` | Comma-separated extra `Host` header names | unset |
| `RUNPHANTOM_ALLOWED_SOURCE_IPS` | Exact non-loopback client IPs to permit | unset |
| `RUNPHANTOM_ALLOWED_ORIGINS` | Comma-separated browser origins allowed to mutate | unset |
| `RUNPHANTOM_URL` | Daemon URL used by the MCP bridge | `http://127.0.0.1:5947` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Standard OTLP trace target for examples and integrations | `http://127.0.0.1:5947/v1/traces` |

No API key or LLM is required for capture, storage, inspection, search,
annotations, downloads, MCP trace tools, or local replay routing. Optional AI
features use `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or a locally installed and
authenticated Claude Code or Codex CLI. `.env.example` documents every
variable, including which component reads it.

## Search and share debugging evidence

**Local Search** searches stored run metadata and span names, inputs, and outputs.
Use status, model, and provider filters to narrow results, and **Load more** to
page through matches. Text is matched literally; SQL wildcards and regular
expressions are not evaluated. Searches have a time limit, so narrow a query
if a large store exceeds it. Results refresh as new traces arrive; pagination
does not freeze a changing store.

**Download** on a run exports a versioned JSON trace with captured spans, live
events, display/event metadata, and annotations. **Import trace** in Local
Search restores it into another local workspace. Exports contain captured
contents and notes, so review them before sharing. Older trace files remain
supported. Reimporting identical annotations is safe; conflicting annotation
identities or replacement spans that would orphan a local note reject the
whole import. An import replaces the captured spans of a run with the same ID.
If only a saved cache remains, the download identifies it as a legacy saved
trace: its payloads may be compacted, and it includes only annotations still
present in the local store.

Current ingestion recognizes standard GenAI tool/agent operations and
OpenInference LLM/tool/agent conventions alongside the existing SDK adapters.
This lets multiple instrumented services contribute evidence using their
existing OTLP exporters.

**Compare captured changes** on a replay shows input/output, model/provider,
status, usage, and timing differences alongside links to original spans. Unique
structural matches stay aligned through reordering; repeated calls with
insufficient identity remain explicitly ambiguous. Missing evidence never
establishes equality. The existing two-pane trace view remains available.

## Shared team projects

Build the UI with `bun run build`, then run `bun src/index.ts team serve` and open
`http://127.0.0.1:5949/team`. Team mode uses a separate database and authenticated
project memberships. Administrators invite viewers/editors, issue project
ingestion keys, and review audit history. Members inspect shared traces, leave
authored notes, and save deterministic checks against frozen captured inputs.

First setup requires the code from the private team data directory. Network
sharing requires a dedicated HTTPS origin and explicitly trusted reverse-proxy
peers. The [team service guide](src/team/README.md) describes setup, exporter
configuration, roles, storage limits, and the local/shared process boundary.

## Evaluation reports and CI

In **Evaluations**, create a dataset from captured runs and declare the expected
response, tools, arguments, errors, or resource limits. A tool-argument rule can
check a JSON path such as `customer.id` against an expected value, for at least
one or every call to a named tool. Missing evidence produces an inconclusive
result. See the [evaluation guide](src/evaluations/README.md) for the evidence
and versioning rules.

Download a **JSON report** or **JUnit report** from an experiment, or check its
frozen result from a script:

```bash
bun scripts/check-evaluation.ts --experiment EXPERIMENT_ID
bun scripts/check-evaluation.ts --experiment CANDIDATE_ID --baseline BASELINE_ID --format junit --output results.junit.xml
```

Use `--url http://127.0.0.1:5947` to select a daemon, or set `RUNPHANTOM_URL`.
The output file must not already exist. Exit code **0** means every case passed;
**1** means failed, inconclusive, or unfinished evidence; **2** means invalid
arguments, an incompatible comparison, or an operational error. Baseline and
candidate must use the same dataset revision and evaluator versions. These
commands inspect saved evidence without rerunning agents or calling providers.

Select **2–20 terminal experiments** in Evaluations to analyze repeated trials.
Selections must share the same frozen dataset and evaluator definitions, and
repeated run captures are rejected. The report includes every selected trial,
pass/fail/unknown counts, resolved coverage, and missing-evidence bounds. These
bounds describe captured evidence; they are not confidence intervals or proof
that trials were statistically independent. Cancelled/error campaigns retain
their separate completion gate. The analysis can be downloaded as versioned JSON
or requested through MCP without starting new provider calls.

Reports retain case counts, machine verdicts and evaluator versions. They omit
captured inputs/outputs, expected/actual values, and free-form model explanations.
JUnit represents inconclusive evidence as an error, so it cannot silently appear
as a successful skipped test. Human reviews remain separate from machine scores.

## Source-First Install

This repository is the source distribution. There is no external installer flow
in this tree.

Use the local checkout directly:

```bash
bun install --frozen-lockfile
bun run dev
```

The daemon, React UI, SQLite schema, CLI, MCP server, examples, tests, and build
scripts are present in this tree. Core capture and inspection do not depend on a
closed Run Phantom service. Optional OpenAI, Anthropic, Claude Code, and Codex
features still depend on those third-party providers or locally installed tools.

## Development Checks

```bash
bun run build
bun run test
bun run lint
bun x tsc --noEmit
```

For the UI package:

```bash
cd app
bun x tsc --noEmit
bun run build
```

## Examples

The `examples/` directory contains single-file demo apps that exercise the
local daemon, trace ingestion, and replay flow from different SDKs and runtimes.

```bash
bun run dev:examples
```

## Documentation

- [Agent guide](./AGENTS.md) — build, test, and contribution rules for this repository
- [Third-party notices](./THIRD_PARTY_NOTICES.md)

The CLI is self-documenting: `bun x runphantom-dev --help` lists every
subcommand, and `.env.example` documents every environment variable with the
source location that reads it.

## License

MIT, copyright Divyam Talwar. See [`LICENSE`](./LICENSE) for the notice and
terms that must be retained in copies and substantial portions of the software.
Third-party names referenced in this repository remain the property of their
respective owners; see [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
