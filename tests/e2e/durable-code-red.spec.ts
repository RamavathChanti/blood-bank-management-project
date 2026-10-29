import { test, expect, type Route } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { resolve } from "node:path";
test.setTimeout(60_000);

let server: ViteDevServer, origin: string;
test.beforeAll(async () => {
  server = await createServer({ configFile: false, root: resolve("."), define: { "process.env": "{}" }, cacheDir: resolve(`.tools/workflow-harness-${test.info().workerIndex}`), resolve: { alias: { "@": resolve("src") } }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null }, logLevel: "error" });
  await server.listen(); const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("Expected port"); origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); });

test("reviewed multilingual draft fills the durable form and only Queue emergency submits", async ({ page }) => {
  let submissions = 0;
  await page.route("**/api/refresh-hints", route => route.fulfill({ json: { hintsEnabled: false } }));
  await page.route("**/api/emergencies**", async route => {
    if (route.request().method() === "POST") { submissions++; await route.fulfill({ status: 202, json: { accepted: true, status: "ACKNOWLEDGED_PENDING", requestId: "emergency-draft", receipt: "synthetic-draft-receipt", eventIds: ["draft-event"], dashboardUrl: "https://app.inngest.com" } }); }
    else await route.fulfill({ status: 503, json: { error: "SYNTHETIC_STATUS_UNAVAILABLE" } });
  });
  await page.goto(`${origin}/tests/workflow-harness.html`);
  await page.getByLabel("Synthetic request text").fill("B+ platelets 3 units jaldi 2 ghante mein");
  await page.getByRole("button", { name: "Extract editable draft" }).click();
  await expect(page.getByRole("button", { name: "Confirm reviewed draft" })).toBeDisabled();
  await page.getByLabel("I reviewed every field", { exact: false }).check(); await page.getByRole("button", { name: "Confirm reviewed draft" }).click();
  await expect(page.getByLabel("Emergency recipient group")).toHaveValue("B+"); await expect(page.getByLabel("Emergency component")).toHaveValue("PLATELETS"); await expect(page.getByLabel("Emergency quantity")).toHaveValue("3"); expect(submissions).toBe(0);
  await page.getByRole("button", { name: "Queue emergency" }).click(); await expect(page.locator("strong").filter({ hasText: "emergency-draft" })).toBeVisible(); expect(submissions).toBe(1);
});
test("retains ten distinct acknowledged receipts across new intakes and reload", async ({ page }) => {
  let index = 0;
  await page.route("**/api/refresh-hints", route => route.fulfill({ json: { hintsEnabled: true } }));
  await page.route("**/api/emergencies**", async route => {
    if (route.request().method() === "POST") {
      index++; const requestId = `emergency-${index.toString(16).padStart(48, "0")}`;
      await route.fulfill({ status: 202, json: { accepted: true, status: "ACKNOWLEDGED_PENDING", requestId, receipt: `synthetic-receipt-${index}`, eventIds: [`event-${index}`], dashboardUrl: "https://app.inngest.com" } });
    } else await route.fulfill({ status: 503, json: { accepted: true, status: "ACKNOWLEDGED_STATUS_UNAVAILABLE", error: "DEMO_DATABASE_DOWN" } });
  });
  await page.goto(`${origin}/tests/workflow-harness.html`);
  for (let i = 0; i < 10; i++) {
    await page.getByLabel("Emergency deadline (UTC)").fill("2026-10-29T20:00");
    await page.getByRole("button", { name: "Queue emergency", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Workflow progress" })).toBeVisible();
    if (i < 9) await page.getByRole("button", { name: "Start another emergency" }).click();
  }
  await page.reload(); await expect(page.getByText("10 distinct durable receipts retained", { exact: false })).toBeVisible();
  const receipts = JSON.parse(await page.getByLabel("Receipt export (private; retain for recovery)").inputValue());
  expect(receipts).toHaveLength(10); expect(new Set(receipts.map((r: { requestId: string }) => r.requestId)).size).toBe(10);
  await page.getByLabel("Inspect retained acknowledgement").selectOption(receipts[0].requestId);
  await expect(page.locator("strong").filter({ hasText: receipts[0].requestId })).toBeVisible(); expect(index).toBe(10);
});
test("durable mode fails closed when authentication is unconfigured", async ({ page, request }) => {
  await page.goto("/code-red"); await page.getByRole("button", { name: "Durable registry", exact: true }).click();
  await expect(page.getByText("Authentication is not configured.", { exact: false })).toBeVisible();
  const response = await request.post("/api/emergencies", { data: {} }); expect([401, 503]).toContain(response.status()); expect(await response.json()).not.toHaveProperty("accepted", true);
});
test("retains uncertain intake, retries the identical payload and restores acknowledged ID after reload", async ({ page }, testInfo) => {
  const submissions: unknown[] = []; let attempts = 0, down = false;
  let holdNext = false, held: Route | undefined;
  const id = `emergency-${"a".repeat(48)}`;
  await page.route("**/api/emergencies**", async route => {
    const request = route.request();
    if (request.method() === "POST") {
      submissions.push(request.postDataJSON()); attempts++;
      await route.fulfill({ status: attempts === 1 ? 503 : 202, json: attempts === 1 ? { accepted: false, error: "WORKFLOW_UNAVAILABLE", requestId: id } : { accepted: true, status: "ACKNOWLEDGED_PENDING", requestId: id, receipt: "synthetic-test-receipt", eventIds: ["test-event-id"], dashboardUrl: "https://app.inngest.com" } }); return;
    }
    if (holdNext) { holdNext = false; held = route; return; }
    await route.fulfill({ status: down ? 503 : 200, json: down ? { accepted: true, status: "ACKNOWLEDGED_STATUS_UNAVAILABLE", error: "DATABASE_UNAVAILABLE", requestId: id } : { accepted: true, status: "AWAITING_BANK_APPROVAL", quantity: 1, allocatedQuantity: 1, transfusedQuantity: 0, workflow: { runId: "test-run-id", trace: [{ status: "STOCK_SEARCH", at: "2026-10-29T09:00:00Z" }], waves: [] }, allocations: [] } });
  });
  await page.goto(`${origin}/tests/workflow-harness.html`);
  await page.getByLabel("Emergency deadline (UTC)").fill("2026-10-29T20:00");
  await page.getByRole("button", { name: "Queue emergency", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("WORKFLOW_UNAVAILABLE");
  await page.getByRole("button", { name: "Retry retained emergency" }).click();
  await expect(page.getByRole("status").filter({ hasText: "AWAITING_BANK_APPROVAL" })).toBeVisible(); expect(submissions[0]).toEqual(submissions[1]);
  await page.reload(); await expect(page.locator("strong").filter({ hasText: id })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "AWAITING_BANK_APPROVAL" })).toBeVisible(); expect(submissions).toHaveLength(2);
  holdNext = true; await page.getByRole("button", { name: "Refresh durable status" }).click(); await expect.poll(() => Boolean(held)).toBe(true);
  down = true; await page.getByRole("button", { name: "Refresh durable status" }).click();
  await expect(page.getByRole("alert")).toContainText("acknowledged request ID is retained"); await expect(page.locator("strong").filter({ hasText: id })).toBeVisible();
  const oldResponse = page.waitForResponse(response => response.headers()["x-test-held"] === "1");
  await held!.fulfill({ status: 200, headers: { "x-test-held": "1" }, json: { accepted: true, status: "AWAITING_BANK_APPROVAL" } }); await (await oldResponse).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByRole("alert")).toContainText("acknowledged request ID is retained");
  await expect(page.getByText("Last known: 1/1 allocated", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("durable-status-outage-fixture.png"), fullPage: true });
});
test("submits bank approval with exact request and allocation IDs and retains uncertain signal key", async ({ page }) => {
  const bodies: unknown[] = []; let attempt = 0;
  await page.route("**/api/emergencies/**", async route => { bodies.push(route.request().postDataJSON()); await route.fulfill({ status: ++attempt === 1 ? 503 : 202, json: attempt === 1 ? { error: "WORKFLOW_UNAVAILABLE" } : { accepted: true } }); });
  await page.goto(`${origin}/tests/workflow-harness.html`);
  await page.getByLabel("Workflow event", { exact: true }).selectOption("dispatch.approved");
  await page.getByLabel("Event request ID").fill("emergency-test"); await page.getByLabel("Event unit ID").fill("unit-test"); await page.getByLabel("Event allocation ID").fill("allocation-test");
  await page.getByLabel("Synthetic plasma preparation confirmed", { exact: false }).check(); await page.getByRole("button", { name: "Send workflow event" }).click();
  await expect(page.getByRole("alert")).toContainText("WORKFLOW_UNAVAILABLE"); await page.getByRole("button", { name: "Retry retained event" }).click();
  await expect(page.getByRole("status")).toContainText("acknowledged; processing is pending"); expect(bodies[0]).toEqual(bodies[1]); expect(bodies[0]).toMatchObject({ unitId: "unit-test", allocationId: "allocation-test", preparationConfirmed: true });
});

test("audience acceptance updates the presenter response count without creating allocated stock", async ({ page, browser }) => {
  const requestId = "emergency-audience-fixture"; let accepted = 0;
  await page.route("**/api/emergencies**", route => route.fulfill({ status: route.request().method() === "POST" ? 202 : 200, json: route.request().method() === "POST" ? { accepted: true, requestId, receipt: "fixture-receipt", eventIds: ["fixture-event"], dashboardUrl: "https://app.inngest.com" } : { accepted: true, requestId, status: "AWAITING_DONORS", quantity: 1, allocatedQuantity: 0, transfusedQuantity: 0, acceptedDonors: accepted, declinedDonors: 0, workflow: { runId: "fixture-run", trace: [], waves: [] }, allocations: [] } }));
  await page.goto(`${origin}/tests/workflow-harness.html`);
  await page.getByLabel("Emergency deadline (UTC)").fill("2026-10-29T20:00");
  await page.getByRole("button", { name: "Queue emergency", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Donor responses: 0 accepted" })).toBeVisible();
  const context = await browser.newContext();
  try {
    const donor = await context.newPage();
    await donor.route("**/api/donor/*", route => {
      if (route.request().url().endsWith("/reply")) { accepted = 1; return route.fulfill({ json: { state: "RECEIVED", requestId } }); }
      return route.fulfill({ json: { donor: { id: "audience-fixture", nickname: "Coral-fixture", group: "O-", eligibleFrom: new Date().toISOString(), expireAt: new Date(Date.now() + 86400_000).toISOString(), optedOut: false, pushState: "OFF" }, alerts: [{ id: "alert-fixture", requestId, group: "O-", component: "PRBC", quantity: 1, status: accepted ? "ACCEPTED" : "PENDING", deadlineAt: new Date(Date.now() + 3600_000).toISOString(), collection: "Synthetic bank" }], pushPublicKey: null } });
    });
    await donor.goto(`${process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3000"}/donor`);
    await donor.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(donor.getByRole("status").filter({ hasText: "Received — accepted." })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Donor responses: 1 accepted" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("0/1 allocated", { exact: false })).toBeVisible();
  } finally { await context.close(); }
});
