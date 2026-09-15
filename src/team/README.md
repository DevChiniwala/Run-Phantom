# Shared Run Phantom projects

Team mode is a separate self-hosted service for shared trace inspection, notes,
and deterministic checks. It has its own accounts, project memberships, ingestion
credentials, and SQLite database. The local debugger continues to use its existing
commands and data directory.

Build the UI and start the service:

```sh
bun run build
bun src/index.ts team serve
```

With a compiled executable, use `runphantom team serve`. Open
`http://127.0.0.1:5949/team`. On first startup, read the private
`~/.runphantom/team/bootstrap.code` file and paste its code into setup. The code
does not appear in the URL or application logs. Setup creates one owner account;
create the first project after signing in. Completed setup cannot be repeated.

Administrators create invitations for a specific email and role. Share the
one-time code through your chosen channel; the recipient pastes it into the
invitation form. Existing accounts must enter their current password. Email is an
account identifier, with no email verification or delivery service in this mode.

| Role | Project capabilities |
| --- | --- |
| Viewer | Read traces, span evidence, notes, metrics, and saved checks/reports. |
| Editor | Viewer capabilities; create checks, add notes, and delete their own notes. |
| Admin | Editor capabilities; manage members, invitations, and ingestion keys; view audit history; delete individual live traces. |

The instance owner can create projects. Every project read still requires an
explicit membership. A project's last administrator cannot be removed or
demoted. Deleting a live trace removes its spans and notes while preserving saved
checks and their frozen evidence.

## Collecting traces

Create an ingestion key in the project's administration page. Copy its value at
creation; later views show only metadata. Configure your OTLP exporter with these
settings, substituting the service origin and the generated key:

```text
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:5949/api/team/ingest/v1/traces
OTEL_EXPORTER_OTLP_TRACES_HEADERS=Authorization=Bearer <project-ingestion-key>
```

The endpoint accepts OTLP JSON and protobuf, including gzip. The key determines
the project and grants ingestion only. Browser sessions cannot ingest, and
ingestion keys cannot read project data. A key remains valid until expiry or
revocation even if its creator leaves the project.

Use an HTTP exporter for this endpoint. Team mode receives traces; it does not
provide an OTLP gRPC listener or `/v1/logs`. Some instrumentation sends prompts
and responses as OTLP log records instead of span attributes. In that mode,
successful trace ingestion does not mean the message bodies were captured.

For the OpenLLMetry OpenAI instrumentor, `use_attributes=True` keeps messages in
span attributes; `use_attributes=False` can route them to logs when a logger is
configured. Content capture must also be enabled if messages are needed. LiteLLM
has separate span-only, event-only, both, and no-content modes; its inspected
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` setting means
event-only. Choose span capture explicitly for this traces endpoint.

With the Langtrace Python SDK, the current initializer supports a standard OTLP
exporter. Its custom-host path helper appends `/v1/traces`, and environment host
settings take precedence over the `api_host` argument. A derived host prefix for
this service is `http://127.0.0.1:5949/api/team/ingest`; passing the full traces URL
to that helper can duplicate the suffix. An explicit standard HTTP
`OTLPSpanExporter` passed as `custom_remote_exporter` can instead target the full
endpoint above and set `headers={"Authorization": "Bearer <project-ingestion-key>"}`.
Use a custom host configuration and a dedicated producer environment so ambient
cloud endpoint settings do not select another destination. The legacy
`LangTraceExporter` class uses a different proprietary payload and is not this
standard OTLP path.

For short-lived agents, flush or shut down the producer's tracer provider before
exit. An exporter-reported span end or `OK` status is evidence about telemetry
lifecycle, not proof that the entire streamed answer or agent task completed.
These SDK constraints come from the pinned source inspection in the
[source audit](../../RESEARCH.md);
they are not a claim that every SDK configuration was executed against this service.

Ingestion applies a fixed credential-redaction policy before persistence. It
handles recognized credential fields and patterns, nested structures, URLs, and
team credentials. This policy does not classify every form of personal or
sensitive data. Redacted, missing, or truncated evidence stays visibly unavailable
to deterministic checks.

## Working with shared evidence

Trace search covers retained sanitized payloads and metadata with literal text
matching. Time filters use captured start time. Lists show bounded pages; span
detail loads the selected payload separately. The UI polls active traces and
checks the current session and project membership again while it is visible.

Saved checks compare explicit candidate runs against a reference run's frozen
input and deterministic rules. Missing or mismatched inputs produce an
inconclusive result. Saved definitions, snapshots, authorship, versions, and
results remain immutable when source traces change. The downloadable
`runphantom-team-check/v1` report excludes raw snapshots and expected/actual
payload values. It is a distinct format from the local evaluation CLI report.

Overview durations use completed traces with known timing. The UI reports the
population and unavailable counts. It does not invent token or cost aggregates
from incomplete or overlapping spans.

## Server configuration

| Variable | Default or purpose |
| --- | --- |
| `RUNPHANTOM_TEAM_PORT` | `5949` |
| `RUNPHANTOM_TEAM_BIND_HOST` | `127.0.0.1`; an explicit IP address |
| `RUNPHANTOM_TEAM_DATA_DIR` | `~/.runphantom/team` |
| `RUNPHANTOM_TEAM_PUBLIC_ORIGIN` | The loopback listener's HTTP origin |
| `RUNPHANTOM_TEAM_TRUSTED_PROXY_IPS` | Exact comma-separated proxy socket IPs |
| `RUNPHANTOM_TEAM_BOOTSTRAP_CODE` | Optional operator-supplied setup secret; otherwise a private file is generated |

For shared network use, place the listener behind a TLS-terminating reverse proxy
on a dedicated HTTPS hostname. Configure that HTTPS public origin and the exact
proxy socket IPs; preserve its Host header. A nonloopback listener refuses startup
without both settings. Forwarded headers cannot grant network trust. Cookies are
host-scoped, so separate ports on one hostname do not provide cookie isolation.
Production sessions use Secure, HttpOnly, SameSite=Strict cookies. Loopback HTTP
uses a separate development cookie name.

Keep the team data directory private and back it up using a SQLite-consistent
method. It contains `team.sqlite` and its WAL state. Run one service writer for
the directory. Do not copy only a live database file while discarding its WAL.
Session, invitation, and key expiry are enforced across restarts. Password changes
rotate the current session and revoke other sessions.

## Limits and operational scope

The service rejects oversized requests and exhausted storage quotas atomically.
Defaults include 1 MiB wire and expanded ingestion bodies, 1,000 spans per trace,
10,000 traces and 512 MiB of evidence per project, and 10,000 retained audit events
per project. Search uses two bounded read workers with a five-second caller
deadline. Checks admit two calculations, at most ten candidates and eight rules,
with an aggregate acquisition budget of 256 KiB and 200 spans. These are admission
limits, not throughput claims. The centralized values are in `protocol.ts`.

Before normalization, effective raw captures also have a 64 KiB per-span and
1 MiB aggregate budget. Inherited resource/scope attributes count toward each
span's capture, preventing a small request from expanding into unbounded work.

Team mode exposes shared evidence and deterministic checks. Provider execution,
machine commands, local replay, and local credential configuration remain in the
local debugger's process. There is no public account directory, bulk trace-clear
endpoint, invitation email delivery, or SSO configuration in this service.
