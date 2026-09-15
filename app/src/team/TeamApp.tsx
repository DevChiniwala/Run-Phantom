import { useState } from "react";
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { ChevronDown, Menu, X } from "lucide-react";
import { projectPath, type Project } from "../api/team";
import { TeamProvider, RequireSession, ProjectBoundary, useAccount, useProject, useTeam, useTeamPages } from "./context";
import { Action, ErrorNotice, Select, TeamBrand, useTask } from "./common";
import { AuthPage, AccountPage } from "./auth";
import { OverviewPage, ProjectsPage } from "./projects";
import { TracesPage } from "./traces";
import { ChecksPage } from "./checks";
import { AdminPage } from "./admin";
import "./team.css";

function TeamShell({ children }: { children: React.ReactNode }) {
  const { client, clearSession } = useTeam(); const account = useAccount(); const task = useTask();
  return <div className="team-root"><a className="skip-link" href="#team-main">Skip to team workspace</a><header className="team-topbar"><TeamBrand /><nav aria-label="Account navigation"><Link to="/team">Projects</Link><Link to="/team/account" className="team-account-link" title={account.user.email}>{account.user.email}</Link><Action disabled={task.busy} onClick={() => void task.run(() => client.request("/logout", { method: "POST", body: {} }), clearSession)}>Sign out</Action></nav></header><ErrorNotice error={task.error} />{children}</div>;
}
function ProjectShell() {
  const project = useProject(); const navigate = useNavigate(); const location = useLocation(); const [open, setOpen] = useState(false);
  const projects = useTeamPages<Project>(["projects"], "/projects", {}, 30_000);
  const items = projects.data?.pages.flatMap(page => page.items) ?? [];
  const links = [["", "Overview"], ["traces", "Traces"], ["checks", "Checks"], ...(project.role === "admin" ? [["members", "Members"], ["keys", "Ingestion keys"], ["audit", "Audit log"]] : [])];
  return <div className="team-workspace"><aside className={`team-sidebar ${open ? "team-sidebar-open" : ""}`}>
    <div className="team-switcher"><label htmlFor="team-project-switcher">Project</label><Select id="team-project-switcher" value={project.id} onChange={event => { setOpen(false); navigate(projectPath(event.target.value)); }}>{!items.some(item => item.id === project.id) && <option value={project.id}>{project.name}</option>}{items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select>{projects.hasNextPage && <Action onClick={() => void projects.fetchNextPage()}>More projects <ChevronDown size={14} /></Action>}</div>
    <nav aria-label="Project navigation">{links.map(([path, name]) => <NavLink key={path} end={!path} to={`${projectPath(project.id)}${path ? `/${path}` : ""}`} onClick={() => setOpen(false)}>{name}</NavLink>)}</nav><p className="team-sidebar-footer">Signed in as <strong>{project.role}</strong><br />Project access is checked on every request.</p>
  </aside><div className="team-content"><div className="team-mobile-bar"><Action aria-label={open ? "Close project navigation" : "Open project navigation"} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <X /> : <Menu />}{project.name}</Action></div><main id="team-main" tabIndex={-1} key={project.id}>
    <Routes location={location}><Route index element={<OverviewPage />} /><Route path="traces/*" element={<TracesPage />} /><Route path="checks/*" element={<ChecksPage />} /><Route path="members" element={<AdminPage kind="members" />} /><Route path="keys" element={<AdminPage kind="keys" />} /><Route path="audit" element={<AdminPage kind="audit" />} /><Route path="*" element={<p className="team-page">This team page does not exist. <Link to={projectPath(project.id)}>Open project overview</Link></p>} /></Routes>
  </main></div></div>;
}
function SignedInRoutes() {
  const session = useAccount();
  return <TeamShell key={session.session.id}><Routes><Route path="account" element={<main id="team-main" tabIndex={-1}><AccountPage /></main>} /><Route path="projects/:projectId/*" element={<ProjectBoundary><ProjectShell /></ProjectBoundary>} /><Route path="*" element={<main id="team-main" tabIndex={-1}><ProjectsPage /></main>} /></Routes></TeamShell>;
}
export default function TeamApp() {
  return <TeamProvider><Routes><Route path="login" element={<AuthPage />} /><Route path="invite" element={<AuthPage invite />} /><Route path="*" element={<RequireSession><SignedInRoutes /></RequireSession>} /></Routes></TeamProvider>;
}
