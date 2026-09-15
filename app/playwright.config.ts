import { defineConfig, devices } from "@playwright/test";

// Sandboxed dev environments (e.g. Cursor cloud agents) often can't reach
// `cdn.playwright.dev`, so `playwright install chromium` fails. When the
// host already ships a Google Chrome binary, drive that instead of giving
// up on e2e. Set PLAYWRIGHT_USE_SYSTEM_CHROME=1 to switch the chromium
// project onto Playwright's `chrome` channel, which uses the host's
// installed Chrome instead of downloading one. CI keeps the default
// (managed Playwright chromium) so we don't drift from upstream.
const useSystemChrome = process.env.PLAYWRIGHT_USE_SYSTEM_CHROME === "1";

export default defineConfig({
  testDir: "./tests-e2e",
  fullyParallel: true,
  workers: process.env.CI ? 2 : 1,
  // One CI retry absorbs infrastructure startup jitter without hiding persistent regressions.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : [["list"]],
  use: {
    headless: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    actionTimeout: 15000,
    navigationTimeout: 20000,
  },
  // Seeded traces arrive through the Run Phantom daemon and then fan out into
  // the UI, so the default 30s file budget is too tight for this suite.
  timeout: 90_000,
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(useSystemChrome ? { channel: "chrome" } : {}),
      },
    },
  ],
});
