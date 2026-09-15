import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { projectApi, projectPath, type Metrics, type Project } from "../api/team";
import { useAccount, useProject, useTeam, useTeamPages, useTeamQuery } from "./context";
import { Action, Badge, DateTime, Empty, ErrorNotice, Field, Heading, Input, Loading, More, Select, duration, useTask } from "./common";

export function ProjectsPage() {
  const projects = useTeamPages<Project>(["projects"], "/projects", {}, 30_000); const account = useAccount(); const { client } = useTeam(); const navigate = useNavigate(); const task = useTask(); const [name, setName] = useState("");
  const items = projects.data?.pages.flatMap(page => page.items) ?? [];
  return <div className="team-page"><Heading title="Your projects">A shared view of your team's captured agent runs.</Heading><ErrorNotice error={projects.error} retry={() => void projects.refetch()} />{projects.isPending && <Loading />}
    {!projects.error && <div className="team-list">{items.map(project => <Link key={project.id} to={projectPath(project.id)} className="team-row team-row-link"><div><strong>{project.name}</strong><p className="team-muted">Created <DateTime value={project.createdAt} /></p></div><Badge value={project.role} /></Link>)}</div>}
    {!projects.isPending && !projects.error && !items.length && <Empty title="No projects yet"><p>{account.user.isOwner ? "Create your first project to connect your agent and invite teammates." : "Ask a project administrator for an invitation code."}</p><Link to="/team/invite">Accept an invitation</Link></Empty>}
    <More available={projects.hasNextPage} busy={projects.isFetchingNextPage} onClick={() => void projects.fetchNextPage()} />
    {account.user.isOwner && <section className="team-section"><h2>Create a project</h2><form className="team-form team-narrow" onSubmit={event => { event.preventDefault(); void task.run(() => client.request<Project>("/projects", { method: "POST", body: { name } }), project => navigate(projectPath(project.id))); }}><Field label="Project name"><Input required maxLength={128} placeholder="Customer support agent" value={name} onChange={event => setName(event.target.value)} /></Field><ErrorNotice error={task.error} /><Action primary type="submit" disabled={task.busy}>{task.busy ? "Creating…" : "Create project"}</Action></form></section>}
  </div>;
}

export function OverviewPage() {
  const project = useProject(); const [window, setWindow] = useState<Metrics["window"]["selection"]>("24h");
  const metrics = useTeamQuery<Metrics>([project.id, "metrics", window], `${projectApi(project.id)}/metrics?window=${window}`, 10_000);
  return <div className="team-page"><Heading title={project.name} action={<Field label="Time window"><Select value={window} onChange={event => setWindow(event.target.value as typeof window)}><option value="1h">Last hour</option><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option></Select></Field>}>Project overview · <Badge value={project.role} /></Heading>
    <ErrorNotice error={metrics.error} retry={() => void metrics.refetch()} />{metrics.isPending && <Loading text="Loading project metrics…" />}
    {metrics.data && !metrics.error && <><div className="team-metrics">{Object.entries(metrics.data.traces).filter(([key]) => key !== "terminal").map(([key, value]) => <div key={key}><span>{key === "total" ? "Captured traces" : key}</span><strong>{value.toLocaleString()}</strong></div>)}</div>
      <section className="team-section"><h2>Recorded duration</h2><dl className="team-facts"><div><dt>Median (p50)</dt><dd>{duration(metrics.data.duration.p50Ms)}</dd></div><div><dt>p95</dt><dd>{duration(metrics.data.duration.p95Ms)}</dd></div><div><dt>Eligible completed traces</dt><dd>{metrics.data.duration.knownCount}</dd></div><div><dt>Duration unavailable</dt><dd>{metrics.data.duration.unavailableCount}</dd></div></dl><p className="team-muted">Nearest-rank percentiles use completed traces with recorded timing. The window uses captured start time.</p><p className="team-muted">Updated <DateTime value={metrics.data.asOf} /></p></section>
      {metrics.data.traces.total === 0 ? <IngestGuide /> : <Link className="team-text-link" to={`${projectPath(project.id)}/traces`}>Explore captured traces →</Link>}</>}
  </div>;
}

export function IngestGuide() {
  const project = useProject();
  return <Empty title="Connect your agent"><p>Send OTLP traces to this project using an ingestion key.</p><p className="team-muted">Traces endpoint</p><code className="team-code">{location.origin}/api/team/ingest/v1/traces</code><p className="team-muted">Authorization header</p><code className="team-code">Bearer &lt;project ingestion key&gt;</code><p>{project.role === "admin" ? <Link to={`${projectPath(project.id)}/keys`}>Create an ingestion key</Link> : "Ask a project administrator for an ingestion key."}</p></Empty>;
}
