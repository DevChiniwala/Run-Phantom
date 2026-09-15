import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { Project, SessionInfo, SessionResponse } from "../api/team";
import { projectPath } from "../api/team";
import { useAccount, useTeam, useTeamQuery } from "./context";
import { Action, DateTime, ErrorNotice, Field, Heading, Input, Loading, TeamBrand, useTask } from "./common";

export function AuthPage({ invite = false }: { invite?: boolean }) {
  const { client, session, acceptSession, notice } = useTeam(); const navigate = useNavigate();
  const setup = !session.authenticated && session.setupRequired && !invite;
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [code, setCode] = useState(""); const task = useTask();
  if (session.authenticated && !invite) return <Navigate to="/team" replace />;
  const title = invite ? "Join your project" : setup ? "Set up your team workspace" : "Welcome back";
  return <main className="team-auth"><TeamBrand /><div className="team-auth-content"><Heading title={title}>{invite ? "Enter the invitation code shared by your project administrator." : setup ? "Create the owner account for this Run Phantom instance." : "Sign in to review captured runs with your team."}</Heading>
    {notice && <p role="status" className="team-notice">{notice}</p>}
    <form className="team-form" onSubmit={event => { event.preventDefault(); void task.run(async () => {
      if (invite) return client.request<{ session: SessionResponse; project: Project }>("/invites/accept", { method: "POST", body: { token: code, email, password } });
      const next = await client.request<SessionResponse>(setup ? "/setup" : "/login", { method: "POST", body: { email, password, ...(setup ? { setupCode: code } : {}) } });
      return { session: next, project: null };
    }, result => { setPassword(""); setCode(""); acceptSession(result.session); navigate(result.project ? projectPath(result.project.id) : "/team", { replace: true }); }); }}>
      {(setup || invite) && <Field label={setup ? "Setup code" : "Invitation code"} hint={setup ? "Use the private bootstrap code supplied by the instance operator." : "Codes expire and can be used once. Keep this value private."}><Input value={code} onChange={event => setCode(event.target.value)} autoComplete="off" required maxLength={256} /></Field>}
      <Field label="Email"><Input type="email" autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} required maxLength={128} /></Field>
      <Field label="Password" hint={invite ? "Already have an account? Use its existing password. Otherwise choose 12–128 characters." : setup ? "Use 12–128 characters. Spaces are preserved." : undefined}><Input type="password" autoComplete={setup ? "new-password" : "current-password"} value={password} onChange={event => setPassword(event.target.value)} required /></Field>
      <ErrorNotice error={task.error} /><Action primary type="submit" disabled={task.busy}>{task.busy ? "Please wait…" : invite ? "Accept invitation" : setup ? "Create owner account" : "Sign in"}</Action>
    </form><p className="team-muted">{invite ? <Link to="/team/login">Back to sign in</Link> : <Link to="/team/invite">Have an invitation code?</Link>}</p></div></main>;
}

export function AccountPage() {
  const { client, acceptSession, clearSession } = useTeam(); const account = useAccount(); const queries = useQueryClient();
  const sessions = useTeamQuery<{ items: SessionInfo[] }>(["sessions"], "/sessions"); const task = useTask(); const revoke = useTask();
  const [currentPassword, setCurrentPassword] = useState(""); const [newPassword, setNewPassword] = useState(""); const [success, setSuccess] = useState(false);
  return <div className="team-page"><Heading title="Your account">{account.user.email}</Heading><section className="team-section"><h2>Change password</h2><p className="team-muted">Changing your password signs out your other sessions.</p>
    <form className="team-form team-narrow" onSubmit={event => { event.preventDefault(); setSuccess(false); void task.run(() => client.request<SessionResponse>("/password", { method: "POST", body: { currentPassword, newPassword } }), value => { setCurrentPassword(""); setNewPassword(""); acceptSession(value); setSuccess(true); }); }}>
      <Field label="Current password"><Input type="password" autoComplete="current-password" required value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} /></Field>
      <Field label="New password" hint="12–128 characters, preserving spaces."><Input type="password" autoComplete="new-password" required value={newPassword} onChange={event => setNewPassword(event.target.value)} /></Field>
      <ErrorNotice error={task.error} />{success && <p role="status">Password changed. Other sessions were signed out.</p>}<Action primary type="submit" disabled={task.busy}>{task.busy ? "Changing password…" : "Change password"}</Action>
    </form></section><section className="team-section"><h2>Active sessions</h2><ErrorNotice error={sessions.error} retry={() => void sessions.refetch()} /><ErrorNotice error={revoke.error} />{sessions.isPending && <Loading />}
    <div className="team-list">{sessions.data?.items.map(session => <div className="team-row" key={session.id}><div><strong>{session.current ? "This session" : "Another session"}</strong><p className="team-muted">Last active <DateTime value={session.lastActiveAt} /> · Expires <DateTime value={session.expiresAt} /></p></div><Action disabled={revoke.busy} onClick={() => void revoke.run(() => client.request(`/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" }), () => { if (session.current) clearSession(); else void queries.invalidateQueries({ queryKey: ["team", account.session.id, account.user.id, "sessions"] }); })}>{session.current ? "Sign out" : "Revoke session"}</Action></div>)}</div>
    </section></div>;
}
