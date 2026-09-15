import { test, expect, connectTarget, act, assertRuntime, observe } from "./verification-fixture";

declare global {
  interface Window {
    verificationUnhandledReasons: string[];
    verificationCaughtFetch: boolean;
  }
}

test("runtime network observation preserves uncaught fetch rejections and fails a quiet console check", async ({ page, request, runPhantom, targetApp }) => {
  const session = await connectTarget(page, request, runPhantom, targetApp.origin);
  await page.evaluate(() => {
    window.verificationUnhandledReasons = [];
    window.addEventListener("unhandledrejection", (event) => {
      window.verificationUnhandledReasons.push(event.reason instanceof Error ? event.reason.name : "unknown");
    });
    const button = document.createElement("button");
    button.id = "uncaught-fetch";
    button.textContent = "Start uncaught failing request";
    button.onclick = () => { void fetch("http://127.0.0.1:1/uncaught"); };
    document.body.append(button);
  });
  const cursor = await act(request, runPhantom, session.id, { type: "click", selector: "#uncaught-fetch" });
  await expect.poll(() => page.evaluate(() => window.verificationUnhandledReasons)).toEqual(["TypeError"]);
  const report = await assertRuntime(request, runPhantom, session.id, { kind: "console", level: "error", absent: true }, cursor, "Uncaught fetch must remain visible");
  expect(report.status).toBe("fail");
  const events = (await observe(request, runPhantom, session.id)).events;
  expect(events.some((event) => event.type === "network" && event.data.status === 0 && event.data.ok === false)).toBe(true);
  expect(events.some((event) => event.type === "console" && event.data.level === "error")).toBe(true);
});

test("runtime network observation does not create unhandled rejections when the app catches fetch failures", async ({ page, request, runPhantom, targetApp }) => {
  const session = await connectTarget(page, request, runPhantom, targetApp.origin);
  await page.evaluate(() => {
    window.verificationUnhandledReasons = [];
    window.verificationCaughtFetch = false;
    window.addEventListener("unhandledrejection", (event) => {
      window.verificationUnhandledReasons.push(event.reason instanceof Error ? event.reason.name : "unknown");
    });
    const button = document.createElement("button");
    button.id = "caught-fetch";
    button.textContent = "Start handled failing request";
    button.onclick = () => {
      void fetch("http://127.0.0.1:1/caught").catch(() => { window.verificationCaughtFetch = true; });
    };
    document.body.append(button);
  });
  const cursor = await act(request, runPhantom, session.id, { type: "click", selector: "#caught-fetch" });
  await expect.poll(() => page.evaluate(() => window.verificationCaughtFetch)).toBe(true);
  const report = await assertRuntime(request, runPhantom, session.id, { kind: "console", level: "error", absent: true }, cursor, "Caught fetch preserves quiet console");
  expect(report.status).toBe("pass");
  expect(await page.evaluate(() => window.verificationUnhandledReasons)).toEqual([]);
  expect((await observe(request, runPhantom, session.id)).events.some((event) => event.type === "console" && event.data.level === "error")).toBe(false);
});
