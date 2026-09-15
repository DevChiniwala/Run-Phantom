import { readFileSync } from "node:fs";
import type { APIRequestContext } from "@playwright/test";
import { test, expect } from "./fixtures";
import type { DatasetRevision, Experiment } from "../../src/evaluations/protocol";

const runs = { good: "0000000000000000000000000000a101", wrong: "0000000000000000000000000000a102", missing: "0000000000000000000000000000a103", mixed: "0000000000000000000000000000a104" };
const input = "Refund order 7 to customer-1.";
async function seed(request: APIRequestContext, daemon: string) {
  const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });
  const time = (offset: number) => String(BigInt(1_780_000_000_000 + offset) * 1_000_000n);
  for (const [kind, traceId] of Object.entries(runs)) {
    const spanId = (slot: number) => `${traceId.slice(-8)}${slot.toString(16).padStart(8, "0")}`;
    const tool = (slot: number, customer: string | null) => ({ traceId, spanId: spanId(slot), parentSpanId: spanId(1), name: "refund", kind: 1,
      startTimeUnixNano: time(slot * 10), endTimeUnixNano: time(slot * 10 + 5), status: { code: 1 }, attributes: [
        attribute("ai.operationId", "ai.toolCall"), attribute("ai.toolCall.name", "refund"),
        ...(customer === null ? [] : [attribute("ai.toolCall.args", JSON.stringify({ customer: { id: customer }, order: 7 }))]),
        attribute("ai.toolCall.result", '{"accepted":true}'),
      ] });
    const spans = [{ traceId, spanId: spanId(1), name: `Refund ${kind}`, kind: 1, startTimeUnixNano: time(0), endTimeUnixNano: time(100), status: { code: 1 }, attributes: [
      attribute("runphantom.span.kind", "agent_root"), attribute("runphantom.input", input), attribute("runphantom.output", "Refund accepted."),
    ] }, tool(2, kind === "missing" ? null : kind === "wrong" ? "other-customer" : "customer-1"), ...(kind === "mixed" ? [tool(3, "other-customer")] : [])];
    expect((await request.post(`${daemon}/v1/traces`, { data: { resourceSpans: [{ scopeSpans: [{ spans }] }] } })).ok()).toBe(true);
  }
}

test("tool arguments: user declares every/any, detects wrong calls and downloads frozen evidence reports", async ({ page, request, runPhantom }, testInfo) => {
  await seed(request, runPhantom.url);
  await page.goto(`${runPhantom.url}/evaluations`);
  await page.getByRole("textbox", { name: "Dataset name", exact: true }).fill("Refund argument regression");
  await page.getByRole("button", { name: "Create dataset", exact: true }).click();
  const dataset = page.getByRole("combobox", { name: "Dataset", exact: true });
  await expect(dataset).not.toHaveValue("");
  const datasetId = await dataset.inputValue();
  await page.getByRole("combobox", { name: "Source run", exact: true }).selectOption(runs.good);
  await page.getByRole("button", { name: "Preview source", exact: true }).click();
  await expect(page.getByRole("region", { name: "Source snapshot", exact: true }).getByText(input, { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Case name", exact: true }).fill("Correct refund recipient");
  const rule = page.getByRole("group", { name: "Rule 1", exact: true });
  await rule.getByRole("combobox", { name: "Rule type", exact: true }).selectOption("toolArgument");
  await rule.getByRole("textbox", { name: "Tool name", exact: true }).fill("refund");
  await expect(rule.getByRole("combobox", { name: /^Matching calls/ })).toHaveValue("all");
  await rule.getByRole("textbox", { name: /^JSON property path/ }).fill("customer.id");
  for (const invalid of ["1e400", "9007199254740993", "1e-400"]) {
    await rule.getByRole("textbox", { name: /^Expected JSON value/ }).fill(invalid);
    await page.getByRole("button", { name: "Add case", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "JSON numbers must be representable without rounding, underflow or overflow." })).toBeVisible();
  }
  await rule.getByRole("textbox", { name: /^Expected JSON value/ }).fill('"customer-1"');
  await rule.screenshot({ path: testInfo.outputPath("tool-argument-editor.png") });
  await page.getByRole("button", { name: "Add case", exact: true }).click();
  await page.getByRole("button", { name: "Save new revision", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Revision", exact: true })).toHaveValue("2");
  const saved = await (await request.get(`${runPhantom.url}/api/evaluations/datasets/${datasetId}`)).json() as DatasetRevision;
  expect(saved.cases[0].rules).toEqual([{ kind: "toolArgument", name: "refund", path: "customer.id", equals: "customer-1", match: "all" }]);
  const results = page.getByRole("region", { name: "Experiment results", exact: true });
  const start = async (kind: keyof typeof runs, outcome: "pass" | "fail" | "inconclusive", name = kind) => {
    const controls = page.getByRole("region", { name: "Start experiment", exact: true });
    await controls.getByRole("textbox", { name: "Experiment name", exact: true }).fill(name);
    await controls.getByRole("combobox", { name: "Candidate run for Correct refund recipient", exact: true }).selectOption(runs[kind]);
    await controls.getByRole("button", { name: "Start experiment", exact: true }).click();
    await expect(results.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(results.getByRole("status").first()).toHaveText("completed");
    await expect(results.getByRole("article", { name: `Correct refund recipient: ${outcome}`, exact: true })).toBeVisible();
    const id = await page.getByRole("combobox", { name: "View experiment", exact: true }).inputValue();
    const experiment = await (await request.get(`${runPhantom.url}/api/evaluations/experiments/${id}`)).json() as Experiment;
    expect(experiment.results[0].checks[0].evaluatorVersion).toBe("toolargs:1");
    return experiment;
  };
  await start("good", "pass");
  const wrong = await start("wrong", "fail");
  await expect(results.getByText("A captured tool call has a different argument value", { exact: true })).toBeVisible();
  for (const format of ["JSON", "JUnit"]) {
    const pendingDownload = page.waitForEvent("download");
    await results.getByRole("button", { name: `Download ${format} report`, exact: true }).click();
    const downloaded = await pendingDownload;
    const file = await downloaded.path();
    expect(file).toBeTruthy();
    const report = readFileSync(file!, "utf8");
    expect(report).not.toContain("other-customer");
    expect(report).not.toContain(input);
    if (format === "JSON") expect(JSON.parse(report)).toMatchObject({ experiment: { id: wrong.id }, summary: { fail: 1 }, gate: { pass: false } });
    else expect(await page.evaluate(xml => {
      const document = new DOMParser().parseFromString(xml, "application/xml");
      return { errors: document.querySelectorAll("parsererror").length, failures: document.querySelectorAll("failure").length };
    }, report)).toEqual({ errors: 0, failures: 1 });
  }
  await start("missing", "inconclusive");
  await start("mixed", "fail");
  await page.getByRole("button", { name: "Edit case Correct refund recipient", exact: true }).click();
  await expect(rule.getByRole("textbox", { name: "Tool name", exact: true })).toHaveValue("refund");
  await expect(rule.getByRole("textbox", { name: /^JSON property path/ })).toHaveValue("customer.id");
  await rule.getByRole("combobox", { name: /^Matching calls/ }).selectOption("any");
  await page.getByRole("button", { name: "Update case draft", exact: true }).click();
  await page.getByRole("button", { name: "Save new revision", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Revision", exact: true })).toHaveValue("3");
  await start("mixed", "pass", "mixed");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Edit case Correct refund recipient", exact: true }).click();
  await rule.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await rule.screenshot({ path: testInfo.outputPath("tool-argument-editor-mobile.png") });
  await page.reload();
  await dataset.selectOption(datasetId);
  await page.getByRole("button", { name: "Edit case Correct refund recipient", exact: true }).click();
  await expect(rule.getByRole("combobox", { name: /^Matching calls/ })).toHaveValue("any");
  const datasetsBefore = await (await request.get(`${runPhantom.url}/api/evaluations/datasets`)).json();
  await page.getByText("Import and export datasets", { exact: true }).click();
  for (const invalid of ["1e400", "9007199254740993", "1e-400"]) {
    await page.getByRole("textbox", { name: "Dataset JSON", exact: true }).fill(`{"format":"runphantom-evaluations/v1","name":"Lossy import","cases":[{"name":"Refund","input":"Refund","rules":[{"kind":"toolArgument","name":"refund","path":"amount","equals":${invalid},"match":"all"}]}]}`);
    await page.getByRole("button", { name: "Import JSON", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "JSON numbers must be representable without rounding, underflow or overflow." })).toBeVisible();
  }
  expect(await (await request.get(`${runPhantom.url}/api/evaluations/datasets`)).json()).toEqual(datasetsBefore);
  await expect(dataset).toHaveValue(datasetId);
});
