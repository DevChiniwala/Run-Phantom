import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

type ControlledSocket = {
  readyState: number;
  open(): void;
  fail(): void;
  disconnect(): void;
  lateEvents(): void;
};
type ControlledWindow = Window & { daemonSockets: ControlledSocket[] };

// Hold only the daemon handshake. HTTP, verification sockets and other WebSockets
// retain their real implementations; no application state or React hooks are mocked.
async function holdDaemonHandshake(page: Page) {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const sockets: ControlledSocket[] = [];
    (window as unknown as ControlledWindow).daemonSockets = sockets;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args: ConstructorParameters<typeof WebSocket>) {
        const url = new URL(String(args[0]), location.href);
        if (url.host !== location.host || url.pathname !== "/ws") {
          return Reflect.construct(target, args);
        }
        class DaemonSocket extends EventTarget {
          readyState: number = NativeWebSocket.CONNECTING;
          onopen: ((event: Event) => void) | null = null;
          onerror: ((event: Event) => void) | null = null;
          onclose: ((event: Event) => void) | null = null;
          onmessage = null;
          retiredOpen: ((event: Event) => void) | null = null;
          retiredClose: ((event: Event) => void) | null = null;
          send() {}
          close() {
            this.retiredOpen ??= this.onopen;
            this.retiredClose ??= this.onclose;
            this.readyState = NativeWebSocket.CLOSED;
            this.onclose?.(new Event("close"));
          }
          open() {
            this.readyState = NativeWebSocket.OPEN;
            this.onopen?.(new Event("open"));
          }
          fail() {
            this.retiredOpen = this.onopen;
            this.retiredClose = this.onclose;
            // Error without a following close must still recover.
            this.onerror?.(new Event("error"));
          }
          disconnect() { this.close(); }
          lateEvents() {
            this.retiredOpen?.(new Event("open"));
            this.retiredClose?.(new Event("close"));
          }
        }
        const socket = new DaemonSocket();
        sockets.push(socket);
        return socket;
      },
    });
  });
}

async function socketAction(page: Page, index: number, action: "open" | "fail" | "disconnect" | "lateEvents") {
  await page.evaluate(({ index, action }) => {
    (window as unknown as ControlledWindow).daemonSockets[index]![action]();
  }, { index, action });
}

async function expectSocketCount(page: Page, count: number) {
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as ControlledWindow).daemonSockets.length)).toBe(count);
}

const offlineDialog = (page: Page) => page.getByRole("alertdialog", { name: "Run Phantom isn't running." });

async function expectOffline(page: Page) {
  await page.clock.runFor(200);
  await expect(offlineDialog(page)).toBeVisible();
  await page.clock.runFor(50);
  await expect(offlineDialog(page)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(offlineDialog(page)).toBeFocused();
}

test("delayed healthy startup preserves skip focus and entered pairing origin", async ({ page, runPhantom }) => {
  await holdDaemonHandshake(page);
  await page.goto(`${runPhantom.url}/verification`);
  await expectSocketCount(page, 1);
  const origin = page.getByLabel(/^App origin/);
  await expect(origin).toBeVisible();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to trace workspace" });
  await expect(skip).toBeFocused();
  // Cross the old 100 ms offline deadline while the handshake is still pending.
  await page.clock.runFor(500);
  await expect(offlineDialog(page)).toHaveCount(0);
  await expect(skip).toBeFocused();
  await origin.fill("http://localhost:3000");
  await page.clock.runFor(500);
  await expect(origin).toHaveValue("http://localhost:3000");
  await expect(origin).toBeFocused();
  await expect(page.getByRole("button", { name: "Pair app", exact: true })).toBeEnabled();
  await socketAction(page, 0, "open");
  await page.clock.runFor(12_000);
  await expect(offlineDialog(page)).toHaveCount(0);
  await expect(origin).toBeFocused();
  await expect(origin).toHaveValue("http://localhost:3000");
  await expectSocketCount(page, 1);
});

for (const failure of ["fail", "disconnect"] as const) {
  test(`${failure} surfaces offline and stays offline until successful reconnect`, async ({ page, runPhantom }) => {
    await holdDaemonHandshake(page);
    await page.goto(`${runPhantom.url}/verification`);
    await expectSocketCount(page, 1);
    const origin = page.getByLabel(/^App origin/);
    await origin.fill("http://localhost:3000");
    // Cover an initial handshake error and a close after a healthy connection.
    if (failure === "disconnect") await socketAction(page, 0, "open");
    await socketAction(page, 0, failure);
    await expectOffline(page);
    await page.clock.runFor(2_000);
    await expectSocketCount(page, 2);
    await expect(offlineDialog(page)).toBeVisible();
    await socketAction(page, 0, "lateEvents");
    await page.clock.runFor(200);
    await expect(offlineDialog(page)).toBeVisible();
    await socketAction(page, 1, "open");
    await expect(offlineDialog(page)).toHaveCount(0);
    await page.clock.runFor(12_000);
    await expect(origin).toBeFocused();
    await expect(origin).toHaveValue("http://localhost:3000");
    await expectSocketCount(page, 2);
    await expect(offlineDialog(page)).toHaveCount(0);
  });
}

test("never completing handshakes time out, retry once per attempt, and recover", async ({ page, runPhantom }) => {
  await holdDaemonHandshake(page);
  await page.goto(`${runPhantom.url}/verification`);
  await expectSocketCount(page, 1);
  await page.clock.runFor(9_000);
  await expect(offlineDialog(page)).toHaveCount(0);
  await page.clock.runFor(1_000);
  await expectOffline(page);
  expect(await page.evaluate(() => (window as unknown as ControlledWindow).daemonSockets[0]!.readyState)).toBe(3);
  await page.clock.runFor(2_000);
  await expectSocketCount(page, 2);
  await expect(offlineDialog(page)).toBeVisible();
  await page.clock.runFor(10_000);
  await expect(offlineDialog(page)).toBeVisible();
  await page.clock.runFor(2_000);
  await expectSocketCount(page, 3);
  await socketAction(page, 2, "open");
  await expect(offlineDialog(page)).toHaveCount(0);
  await page.clock.runFor(12_000);
  await expectSocketCount(page, 3);
  await expect(offlineDialog(page)).toHaveCount(0);
});
