import { expect, test } from "bun:test";
import { startTeamFixture } from "./helpers/team-server";
import { TEAM_LIMITS as L, type Project, type SessionResponse } from "../src/team/protocol";

test("oversized raw and inherited captures reject before expensive work while real HTTP remains responsive", async () => {
  const fixture = await startTeamFixture("ingest-admission");
  try {
    const setup = await fetch(`${fixture.url}/api/team/setup`, { method: "POST", headers: { Origin: fixture.url, "Content-Type": "application/json" }, body: JSON.stringify({ setupCode: fixture.setupCode, email: "ingest@example.test", password: "Bounded ingestion fixture 42!" }) });
    expect(setup.status).toBe(201);
    const session = await setup.json() as Extract<SessionResponse, { authenticated: true }>;
    const headers = { Cookie: setup.headers.get("set-cookie")!.split(";")[0], Origin: fixture.url, "Content-Type": "application/json", "X-RunPhantom-CSRF": session.csrfToken };
    const projectResponse = await fetch(`${fixture.url}/api/team/projects`, { method: "POST", headers, body: '{"name":"Admission fixture"}' });
    expect(projectResponse.status).toBe(201);
    const project = await projectResponse.json() as Project;
    const issued = await fetch(`${fixture.url}/api/team/projects/${project.id}/keys`, { method: "POST", headers, body: '{"label":"Admission exporter"}' });
    const { token } = await issued.json() as { token: string };
    const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
    const span = (n: number, attributes: unknown[] = []) => ({ traceId: "1".repeat(32), spanId: n.toString(16).padStart(16, "0"), name: "agent", startTimeUnixNano: "1000000", endTimeUnixNano: "2000000", attributes });
    const payloads = [
      { resourceSpans: [{ scopeSpans: [{ spans: [span(1, [attr("runphantom.input", "eyJ".repeat(300000))])] }] }] },
      { resourceSpans: [{ resource: { attributes: [attr("shared", "https://example.test/?" + Array.from({ length: 1400 }, (_, n) => `password${n}=canary`).join("&"))] }, scopeSpans: [{ spans: Array.from({ length: 80 }, (_, n) => span(n + 1)) }] }] },
    ].map(body => JSON.stringify(body));
    for (const body of payloads) expect(Buffer.byteLength(body)).toBeLessThan(L.INGEST_WIRE_BYTES);
    let pending = payloads.length;
    const attempts = payloads.map(async body => {
      try {
        const response = await fetch(`${fixture.url}/api/team/ingest/v1/traces`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body });
        expect(response.status).toBe(413);
        expect((await response.json() as { error: { code: string } }).error.code).toBe("too_large");
      } finally { pending--; }
    });
    const health: number[] = [];
    const pulse = async () => {
      do {
        const start = performance.now();
        const response = await fetch(`${fixture.url}/api/team/session`);
        expect(response.status).toBe(200); await response.arrayBuffer();
        health.push(performance.now() - start);
        await new Promise(resolve => setTimeout(resolve, 1));
      } while (pending);
    };
    await Promise.all([...attempts, pulse()]);
    expect(Math.max(...health)).toBeLessThan(1000);
    const runs = await fetch(`${fixture.url}/api/team/projects/${project.id}/runs`, { headers: { Cookie: headers.Cookie } });
    expect((await runs.json() as { items: unknown[] }).items).toHaveLength(0);
    expect(fixture.logs()).not.toContain(token);
    console.info(JSON.stringify({ fixture: "team-ingest-effective-capture-admission", requestBytes: payloads.map(body => Buffer.byteLength(body)), rejections: 2, maxHealthMs: Math.max(...health), healthRequests: health.length }));

    const encoded = Buffer.from("https://example.test/?" + Array.from({ length: 30000 }, (_, n) => `password${n}=canary`).join("&")).toString("base64");
    const metadata = { attributes: [{ key: "encoded", value: { bytesValue: encoded } }] };
    const unusedPayloads = [
      { resourceSpans: [{ resource: metadata, scopeSpans: [{ spans: [] }] }] },
      { resourceSpans: [{ scopeSpans: [{ scope: metadata, spans: [] }] }] },
      { resourceSpans: [{ resource: metadata, scopeSpans: [] }, { scopeSpans: [{ spans: [span(1, [attr("runphantom.output", "visible")])] }] }] },
      { resourceSpans: [{ scopeSpans: [{ scope: metadata, spans: [] }, { spans: [span(1, [attr("runphantom.output", "visible")])] }] }] },
    ].map(body => JSON.stringify(body));
    health.length = 0;
    for (const body of unusedPayloads) {
      expect(Buffer.byteLength(body)).toBeLessThan(L.INGEST_WIRE_BYTES);
      pending = 1;
      await Promise.all([pulse(), (async () => {
        try {
          const response = await fetch(`${fixture.url}/api/team/ingest/v1/traces`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body });
          expect(response.status).toBe(200);
          expect(await response.text()).not.toContain(encoded);
        } finally { pending = 0; }
      })()]);
    }
    expect(Math.max(...health)).toBeLessThan(1000);
    const captured = await fetch(`${fixture.url}/api/team/projects/${project.id}/runs`, { headers: { Cookie: headers.Cookie } });
    expect((await captured.json() as { items: unknown[] }).items).toHaveLength(1);
    console.info(JSON.stringify({ fixture: "team-ingest-unused-metadata", requestBytes: unusedPayloads.map(body => Buffer.byteLength(body)), accepted: 4, maxHealthMs: Math.max(...health), healthRequests: health.length }));
  } finally { await fixture.close(); }
}, 30_000);
