import { test, expect } from "./fixtures";

type ChatMessage = { role: string; content: string };
const record = (value: unknown) => `${JSON.stringify(value)}\n`;
const successfulReply = record({ type: "delta", delta: "A completed reply." }) + record({ type: "complete" });

for (const [scenario, ending] of [
  ["provider failure", record({ type: "error", error: "OpenAI failed to complete the reply. Please try again." })],
  ["provider incomplete", record({ type: "error", error: "OpenAI could not finish the reply. Please try again." })],
  ["clean EOF without completion", ""],
  ["truncated completion record", '{"type":"complete"'],
  ["malformed record", "{invalid}\n"],
]) {
  test(`demo ${scenario} retains failed text without saving it into follow-up history`, async ({ page, runPhantom }) => {
    const calls: ChatMessage[][] = [];
    await page.route("**/api/demo-chat", async (route) => {
      const body = route.request().postDataJSON() as { messages: ChatMessage[] };
      calls.push(body.messages);
      await route.fulfill({ status: 200, contentType: "application/x-ndjson",
        body: calls.length === 1 ? record({ type: "delta", delta: "Partial reply" }) + ending : successfulReply });
    });
    await page.goto(`${runPhantom.url}/demo-chat`);
    await page.getByLabel("Prompt", { exact: true }).fill("Explain a trace");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator("#status")).toHaveText("Request failed.");
    await expect(page.getByLabel("Incomplete assistant reply")).toHaveText("Partial reply");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

    await page.getByLabel("Prompt", { exact: true }).fill("Try again");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator("#status")).toHaveText("Reply complete.");
    expect(calls).toHaveLength(2);
    expect(calls[1].some((message) => message.role === "assistant" && message.content === "Partial reply")).toBe(false);
    expect(calls[1].filter((message) => message.role === "user").map((message) => message.content)).toEqual(["Explain a trace", "Try again"]);
    await expect(page.getByText("A completed reply.", { exact: true })).toBeVisible();
  });
}

test("demo displays incremental text and saves a successful reply once, only after the complete record", async ({ page, runPhantom }) => {
  await page.goto(`${runPhantom.url}/demo-chat`);
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    const state = window as typeof window & {
      demoTestStream?: ReadableStreamDefaultController<Uint8Array>;
      demoTestRequests?: Array<{ messages: Array<{ role: string; content: string }> }>;
    };
    state.demoTestRequests = [];
    window.fetch = (input, init) => {
      if (String(input) !== "/api/demo-chat") return originalFetch(input, init);
      state.demoTestRequests!.push(JSON.parse(String(init?.body)));
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) { state.demoTestStream = controller; },
      }), { headers: { "Content-Type": "application/x-ndjson" } }));
    };
  });
  const sendChunk = (chunk: string) => page.evaluate((value) => {
    (window as typeof window & { demoTestStream: ReadableStreamDefaultController<Uint8Array> }).demoTestStream.enqueue(new TextEncoder().encode(value));
  }, chunk);

  await page.getByLabel("Prompt", { exact: true }).fill("First question");
  await page.getByRole("button", { name: "Send" }).click();
  await sendChunk(record({ type: "delta", delta: "Hello " }));
  await expect(page.locator(".assistant").last()).toHaveText("Hello");
  await expect(page.locator("#status")).toHaveText("Running...");
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await sendChunk(record({ type: "delta", delta: "world" }) + '{"type":"comp');
  await expect(page.locator(".assistant").last()).toHaveText("Hello world");
  await expect(page.locator("#status")).toHaveText("Running...");
  await sendChunk('lete"}\n');
  await expect(page.locator("#status")).toHaveText("Reply complete.");
  await page.getByLabel("Prompt", { exact: true }).fill("Second question");
  await page.getByRole("button", { name: "Send" }).click();
  const messages = await page.evaluate(() => (window as typeof window & {
    demoTestRequests: Array<{ messages: ChatMessage[] }>;
  }).demoTestRequests[1].messages);
  expect(messages.filter((message) => message.role === "assistant" && message.content === "Hello world")).toHaveLength(1);
  await sendChunk(successfulReply);
  await expect(page.locator("#status")).toHaveText("Reply complete.");
});
