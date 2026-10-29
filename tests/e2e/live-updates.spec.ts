import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { resolve } from "node:path";
import { publicBoard } from "../../src/core/public-board";
test.setTimeout(60_000);
let server: ViteDevServer, origin: string;
test.beforeAll(async () => {
  server = await createServer({ configFile: false, root: resolve("."), define: { "process.env": "{}" }, cacheDir: resolve(`.tools/live-harness-${test.info().workerIndex}`), resolve: { alias: { "@": resolve("src") } }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null }, logLevel: "error" });
  await server.listen(); const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("Expected port"); origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ context }) => { await context.route("**/api/refresh-hints", route => route.fulfill({ json: { hintsEnabled: true } })); });
test("Public Board observes real response headers, filters bands and retains a labelled stale snapshot on failure", async ({ page }, testInfo) => {
  let down = false, header = "MISS";
  const board = publicBoard(new Date(), [{ district: "Pune", group: "O-", component: "PRBC", count: 6 }]);
  await page.route("**/api/public-board", route => route.fulfill({ status: down ? 503 : 200, headers: header ? { "x-vercel-cache": header } : {}, json: down ? { error: "PUBLIC_BOARD_UNAVAILABLE" } : board }));
  await page.goto("/public-board");
  await expect(page.getByLabel("Observed CDN cache")).toHaveText("CDN cache: MISS");
  await page.getByLabel("Public group", { exact: true }).selectOption("O-");
  await expect(page.getByRole("row").filter({ hasText: "Pune" })).toContainText("MODERATE");
  header = "HIT"; await page.getByRole("button", { name: "Refresh public snapshot" }).click(); await expect(page.getByLabel("Observed CDN cache")).toHaveText("CDN cache: HIT");
  header = "STALE"; await page.getByRole("button", { name: "Refresh public snapshot" }).click(); await expect(page.getByLabel("Observed CDN cache")).toHaveText("CDN cache: STALE");
  header = ""; await page.getByRole("button", { name: "Refresh public snapshot" }).click(); await expect(page.getByLabel("Observed CDN cache")).toHaveText("CDN cache: unknown");
  down = true; await page.getByRole("button", { name: "Refresh public snapshot" }).click(); await expect(page.getByRole("region", { name: "Public registry availability" }).getByRole("alert")).toContainText("last known");
  await expect(page.getByRole("status")).toContainText("Last known / stale"); await expect(page.getByRole("row").filter({ hasText: "Pune" })).toContainText("MODERATE");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("public-board-last-good.png"), fullPage: true });
  down = false; await page.getByRole("button", { name: "Refresh public snapshot" }).click(); await expect(page.getByRole("region", { name: "Public registry availability" }).getByRole("alert")).toHaveCount(0);
});
test("cold public outage never displays zero availability as successful data", async ({ page }) => {
  await page.route("**/api/public-board", route => route.fulfill({ status: 503, json: { error: "PUBLIC_BOARD_UNAVAILABLE" } }));
  await page.goto("/public-board"); await expect(page.getByRole("status")).toContainText("No last-good snapshot"); await expect(page.getByRole("table")).toHaveCount(0);
});
test("two browser sessions fetch changed authoritative portal records after polling and reconnect", async ({ browser }) => {
  const first = await browser.newContext(), second = await browser.newContext();
  const bank = await first.newPage(), hospital = await second.newPage();
  let status = "ACTIVE";
  const allocation = () => ({ records: [{ id: "allocation-1", unitId: "unit-1", requestId: "request-1", status }], next: null });
  try {
    for (const context of [first, second]) await context.route("**/api/registry/**", async route => {
      const url = route.request().url();
      await route.fulfill({ json: url.endsWith("allocations") ? allocation() : url.endsWith("units") ? { records: [{ id: "unit-1", group: "O-", component: "PRBC", status }], next: null } : { records: [{ id: "request-1", status: "ALLOCATED", quantity: 1, allocatedQuantity: 1 }], next: null } });
    });
    await bank.clock.install(); await hospital.clock.install();
    await bank.goto(`${origin}/tests/live-harness.html?mode=bank`); await hospital.goto(`${origin}/tests/live-harness.html?mode=hospital`);
    await expect(bank.getByLabel("Bank unit")).toContainText("ACTIVE");
    await hospital.getByLabel("Hospital request", { exact: true }).selectOption("request-1");
    await expect(hospital.getByText("unit-1 · ACTIVE", { exact: false })).toBeVisible();
    status = "ISSUED";
    await bank.clock.runFor(5100); await hospital.clock.runFor(5100);
    await expect(bank.getByLabel("Bank unit")).toContainText("ISSUED"); await expect(hospital.getByText("unit-1 · ISSUED", { exact: false })).toBeVisible();
    await second.setOffline(true); status = "TRANSFUSED"; await hospital.clock.runFor(5100);
    await expect(hospital.getByText("unit-1 · ISSUED", { exact: false })).toBeVisible();
    await second.setOffline(false); await expect(hospital.getByText("unit-1 · TRANSFUSED", { exact: false })).toBeVisible();
  } finally { await first.close(); await second.close(); }
});
test("same-origin tabs exchange only invalidation hints and re-read their own APIs", async ({ context }) => {
  let status = "before";
  await context.route("**/fixture/private", route => route.fulfill({ json: { status } }));
  const first = await context.newPage(), second = await context.newPage();
  await first.clock.install(); await second.clock.install();
  await first.goto(`${origin}/tests/live-harness.html?mode=probe`); await second.goto(`${origin}/tests/live-harness.html?mode=probe`);
  await expect(second.getByRole("status")).toHaveText("before");
  await first.clock.runFor(1100); await second.clock.runFor(1100); status = "after";
  await first.getByRole("button", { name: "Announce change" }).click();
  await expect(second.getByRole("status")).toHaveText("after");
});
test("refresh-hint loss keeps polling usable and reconnect restores hints", async ({ context }) => {
  let down = true, status = "before";
  let reads = 0, restoredGateReads = 0;
  await context.route("**/api/refresh-hints", route => { if (!down) restoredGateReads++; return route.fulfill({ json: { hintsEnabled: !down } }); });
  await context.route("**/fixture/private", route => { reads++; return route.fulfill({ json: { status } }); });
  const page = await context.newPage(); await page.clock.install(); await page.goto(`${origin}/tests/live-harness.html?mode=probe`);
  await expect(page.getByRole("status")).toHaveText("before");
  await page.clock.runFor(1100); status = "polling-only";
  await page.getByRole("button", { name: "Announce change" }).click(); await expect(page.getByRole("status")).toHaveText("before");
  await page.clock.runFor(5100); await expect(page.getByRole("status")).toHaveText("polling-only");
  down = false;
  for (let i = 0; i < 4; i++) { const before = reads; await page.clock.runFor(5100); await expect.poll(() => reads).toBeGreaterThan(before); }
  expect(restoredGateReads).toBeGreaterThan(0); await page.clock.runFor(1100); status = "hint-reconnected";
  await page.getByRole("button", { name: "Announce change" }).click(); await expect(page.getByRole("status")).toHaveText("hint-reconnected");
});
test("polling backs off, pauses offline/hidden and stops after a bounded attempt budget", async ({ page, context }) => {
  let requests = 0, down = true;
  await page.route("**/fixture/private", route => { requests++; return route.fulfill({ status: down ? 503 : 200, json: { status: `authoritative-${requests}` } }); });
  await page.clock.install(); await page.goto(`${origin}/tests/live-harness.html?mode=probe`);
  await expect(page.getByRole("status")).toHaveText("failed"); expect(requests).toBe(1);
  await page.clock.runFor(5100); expect(requests).toBe(1);
  await page.clock.runFor(5000); await expect.poll(() => requests).toBe(2);
  down = false; await context.setOffline(true); await page.clock.runFor(30_000); expect(requests).toBe(2);
  await context.setOffline(false); await expect(page.getByRole("status")).toHaveText("authoritative-3"); expect(requests).toBe(3);
  await page.evaluate(() => Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }));
  await page.clock.runFor(10_000); expect(requests).toBe(3);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect(page.getByRole("status")).toHaveText("authoritative-4");
  for (let i = 4; i < 120; i++) { await page.clock.runFor(5100); await expect(page.getByRole("status")).toHaveText(`authoritative-${i + 1}`); }
  await page.clock.runFor(5000); await expect(page.getByText("paused", { exact: true })).toBeVisible(); expect(requests).toBe(120);
  await page.clock.runFor(60_000); expect(requests).toBe(120);
  await page.getByRole("button", { name: "Resume updates" }).click(); await expect.poll(() => requests).toBe(121);
});
