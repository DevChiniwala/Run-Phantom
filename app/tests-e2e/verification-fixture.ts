import { createServer, type ServerResponse } from "node:http";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test as base, type RunPhantomHandle } from "./fixtures";
import type { AppCommand, Observation, Predicate, SessionSummary, VerificationReport } from "../../src/verification/protocol";

interface RuntimeHandle {
  disconnect(): void;
  signal(name: string, data?: unknown): void;
  registerStore(name: string, read: () => unknown): () => void;
}

declare global {
  interface Window {
    runtime: RuntimeHandle;
    checkoutState: { status: string; requests: number; password?: string };
    originalMethods: { fetch: typeof fetch; pushState: History["pushState"]; error: Console["error"]; xhrOpen: XMLHttpRequest["open"]; xhrSend: XMLHttpRequest["send"] };
    lateFetchWrapper?: typeof fetch;
  }
}

const FIXTURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Runtime verification fixture</title></head>
<body>
  <h1>Checkout fixture</h1>
  <label>Name <input id="name"></label>
  <label>Password <input id="password" type="password"></label>
  <button id="checkout">Pay</button><button id="xhr">Load details</button>
  <button id="route">Open confirmation</button><button id="signal">Confirm signal</button>
  <button id="console">Report error</button><button id="late-error">Delayed error</button>
  <button id="slow">Start delayed request</button><button id="noop">Do nothing</button>
  <output id="status">idle</output>
  <script>
    window.originalMethods = { fetch, pushState: history.pushState, error: console.error,
      xhrOpen: XMLHttpRequest.prototype.open, xhrSend: XMLHttpRequest.prototype.send };
    window.checkoutState = { status: 'idle', requests: 0 };
    document.querySelector('#checkout').onclick = async () => {
      const response = await fetch('/api/checkout', { method: 'POST' });
      window.checkoutState.requests += 1;
      window.checkoutState.status = response.ok ? 'paid' : 'failed';
      document.querySelector('#status').textContent = window.checkoutState.status;
    };
    document.querySelector('#xhr').onclick = () => {
      const request = new XMLHttpRequest(); request.open('GET', '/api/details'); request.send();
    };
    document.querySelector('#route').onclick = () => history.pushState({}, '', '/confirmed');
    document.querySelector('#signal').onclick = () => window.runtime.signal('checkout.confirmed', { source: 'fixture' });
    document.querySelector('#console').onclick = () => console.error('fixture observed error');
    document.querySelector('#late-error').onclick = () => setTimeout(() => console.error('fixture delayed error'), 80);
    document.querySelector('#slow').onclick = () => { void fetch('/api/late'); };
    document.querySelector('#password').oninput = (event) => {
      window.checkoutState.password = event.target.value;
    };
  </script>
</body></html>`;

export interface TargetApp {
  origin: string;
  setBroken(value: boolean): void;
  releaseDelayed(): void;
}

export const test = base.extend<{ targetApp: TargetApp }>({
  targetApp: async ({}, use) => {
    let broken = true;
    const delayed = new Set<ServerResponse>();
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/api/late") {
        delayed.add(response);
        response.on("close", () => delayed.delete(response));
        return;
      }
      if (pathname.startsWith("/api/")) {
        response.writeHead(pathname === "/api/checkout" && broken ? 500 : 200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: !broken }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(FIXTURE_HTML);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture did not bind a TCP port");
    const releaseDelayed = () => {
      for (const response of delayed) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end('{"ok":true}');
      }
      delayed.clear();
    };
    try {
      await use({ origin: `http://127.0.0.1:${address.port}`, setBroken: (value) => { broken = value; }, releaseDelayed });
    } finally {
      releaseDelayed();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  },
});

export { expect };

export async function connectTarget(
  page: Page,
  request: APIRequestContext,
  daemon: RunPhantomHandle,
  origin: string,
  runId?: string,
): Promise<SessionSummary> {
  const response = await request.post(`${daemon.url}/api/verification/sessions`, { data: { origin, ...(runId ? { runId } : {}) } });
  expect(response.ok(), "Control caller can create a runtime session").toBe(true);
  const paired = await response.json() as SessionSummary & { token: string; sdkUrl: string };
  await page.goto(origin);
  await page.evaluate(async ({ url, sessionId, token, sdkUrl }) => {
    const sdk = await import(sdkUrl) as { connect(options: { url: string; sessionId: string; token: string }): RuntimeHandle };
    window.runtime = sdk.connect({ url, sessionId, token });
    window.runtime.registerStore("checkout", () => window.checkoutState);
  }, { url: daemon.url, sessionId: paired.id, token: paired.token, sdkUrl: new URL(paired.sdkUrl, daemon.url).href });
  await expect.poll(async () => {
    const sessions = await request.get(`${daemon.url}/api/verification/sessions`);
    const body = await sessions.json() as SessionSummary[];
    return body.find((session) => session.id === paired.id)?.connected;
  }).toBe(true);
  return { id: paired.id, origin: paired.origin, runId: paired.runId, connected: true, createdAt: paired.createdAt, coverage: paired.coverage, cursor: paired.cursor, dropped: paired.dropped };
}

export async function act(request: APIRequestContext, daemon: RunPhantomHandle, sessionId: string, command: AppCommand): Promise<number> {
  const response = await request.post(`${daemon.url}/api/verification/sessions/${sessionId}/command`, { data: command });
  expect(response.ok(), `Runtime ${command.type} request succeeds`).toBe(true);
  const result = await response.json() as { ok: boolean; cursor: number };
  expect(result.ok, `Runtime ${command.type} executes in the target page`).toBe(true);
  return result.cursor;
}

export async function observe(request: APIRequestContext, daemon: RunPhantomHandle, sessionId: string): Promise<Observation> {
  const response = await request.get(`${daemon.url}/api/verification/sessions/${sessionId}/events`);
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Observation>;
}

export async function assertRuntime(request: APIRequestContext, daemon: RunPhantomHandle, sessionId: string, predicate: Predicate, since: number, name = "Browser fixture check"): Promise<VerificationReport> {
  const response = await request.post(`${daemon.url}/api/verification/sessions/${sessionId}/assert`, { data: { predicate, since, name } });
  expect(response.ok(), `Runtime assertion returns a report (HTTP ${response.status()})`).toBe(true);
  return response.json() as Promise<VerificationReport>;
}
