import { expect, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { REPO_ROOT_PATH } from "./fixtures";

export const FIXTURE_PRIMARY_RUN_ID = "00000000000000000000000000000001";
export const FIXTURE_SAVED_SIBLING_RUN_ID = "00000000000000000000000000000002";
export const FIXTURE_LIVE_RUN_ID = "00000000000000000000000000000003";
export const FIXTURE_DISPLAY_NAME = "agent.turn";
export const FIXTURE_SPAN_COUNT = 6;

const FORBIDDEN_IDENTITY_HASHES = new Set([
  "ee510d1a07ac7e6491ea191cd1918ea553ed2a358c8a0a04c1b90bd89222c314",
  "1a89614a7ae4f0ff33ad4cf25ee6512cdf87b763d086466ac684ebc596a57e2d",
]);

function containsForbiddenIdentity(value: string): boolean {
  const candidates = value.toLowerCase().match(/[a-z][a-z0-9._-]*/g) ?? [];
  return candidates.some((candidate) => {
    const namespace = candidate.split("_")[0] ?? candidate;
    return [candidate, namespace].some((probe) =>
      FORBIDDEN_IDENTITY_HASHES.has(createHash("sha256").update(probe).digest("hex")),
    );
  });
}

export type RunPhantomRunRow = {
  id: string;
  event_name: string | null;
  user_id: string | null;
  convo_id: string | null;
};

export type RunPhantomSpanRow = {
  id: string;
  run_id: string;
  name: string;
  span_type: string | null;
  status: string | null;
  input_payload: string | null;
  output_payload: string | null;
};

type RunPhantomDetailResponse = {
  run: {
    id: string;
    event_name?: string | null;
    name?: string | null;
    user_id?: string | null;
    convo_id?: string | null;
    started_at: number;
  };
};

export async function seedRunPhantomFixtures(runPhantomUrl: string): Promise<void> {
  const seed = spawnSync("bun", ["scripts/seed-traces.ts"], {
    cwd: REPO_ROOT_PATH,
    env: { ...process.env, RUNPHANTOM_URL: runPhantomUrl },
    stdio: "inherit",
  });
  expect(seed.status, "seed-traces.ts failed").toBe(0);
}

export async function clearRunPhantom(runPhantomUrl: string): Promise<void> {
  const res = await fetch(`${runPhantomUrl}/api/clear`, { method: "POST" });
  expect(res.ok, `POST /api/clear -> ${res.status}`).toBe(true);
}

export async function listRunPhantomRuns(runPhantomUrl: string): Promise<unknown[]> {
  const res = await fetch(`${runPhantomUrl}/api/runs?limit=5000`);
  expect(res.ok, `GET /api/runs -> ${res.status}`).toBe(true);
  return res.json() as Promise<unknown[]>;
}

export async function saveRunPhantomRun(runPhantomUrl: string, runId: string): Promise<void> {
  const detailRes = await fetch(`${runPhantomUrl}/api/runs/detail/${encodeURIComponent(runId)}`);
  expect(detailRes.ok, `GET /api/runs/detail/${runId} -> ${detailRes.status}`).toBe(true);
  const detail = await detailRes.json() as RunPhantomDetailResponse;
  const run = detail.run;

  const saveRes = await fetch(`${runPhantomUrl}/api/saved-runs/events/${encodeURIComponent(runId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: run.id,
      event_name: run.event_name ?? run.name ?? run.id.slice(0, 12),
      user_id: run.user_id ?? null,
      convo_id: run.convo_id ?? null,
      timestamp: new Date(run.started_at).toISOString(),
      user_input: "Fix the typo in README.md",
      assistant_output: null,
      saved_at: Date.now(),
      source: "local",
    }),
  });
  expect(saveRes.ok, `PUT /api/saved-runs/events/${runId} -> ${saveRes.status}`).toBe(true);
}

export async function expectRunPhantomBranding(page: Page): Promise<void> {
  await expect(page.getByRole("link", { name: /^Run Phantom/ }).first()).toBeVisible({ timeout: 10_000 });
  expect(containsForbiddenIdentity(await page.locator("body").innerText())).toBe(false);
}

export async function readLocalStorageKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => Object.keys(localStorage).sort());
}

export function hasLegacyIdentityKey(keys: string[]): boolean {
  return keys.some(containsForbiddenIdentity);
}

async function fetchRunPhantomSpansViaApi(
  runPhantomUrl: string,
  runId: string,
): Promise<Array<{
  id: string;
  name: string;
  span_type: string | null;
  status: string | null;
  input_preview: string;
  output_preview: string;
}>> {
  const res = await fetch(
    `${runPhantomUrl}/api/runs/${encodeURIComponent(runId)}/spans?limit=500&payload_preview_chars=400`,
  );
  if (!res.ok) {
    throw new Error(`GET /api/runs/${runId}/spans -> ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<Array<{
    id: string;
    name: string;
    span_type: string | null;
    status: string | null;
    input_preview: string;
    output_preview: string;
  }>>;
}

export async function readRunPhantomRun(runPhantomUrl: string, runId: string): Promise<RunPhantomRunRow | null> {
  const res = await fetch(`${runPhantomUrl}/api/runs/${encodeURIComponent(runId)}/outline?payload_preview_chars=0`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET /api/runs/${runId}/outline -> ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { run: RunPhantomRunRow | null };
  return body.run ?? null;
}

export async function readRunPhantomSpans(runPhantomUrl: string, runId: string): Promise<RunPhantomSpanRow[]> {
  const spans = await fetchRunPhantomSpansViaApi(runPhantomUrl, runId);
  return spans.map((span) => ({
    id: span.id,
    run_id: runId,
    name: span.name,
    span_type: span.span_type,
    status: span.status,
    input_payload: span.input_preview || null,
    output_payload: span.output_preview || null,
  }));
}
