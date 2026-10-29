import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { resolve } from "node:path";
let server: ViteDevServer, origin: string;
test.beforeAll(async () => {
  server = await createServer({ configFile: false, root: resolve("."), define: { "process.env": "{}" }, cacheDir: resolve(`.tools/vital-harness-${test.info().workerIndex}`), resolve: { alias: { "@": resolve("src") } }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null }, logLevel: "error" });
  await server.listen(); const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("port"); origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); });
test("Vital Signs fails closed without authentication", async ({ page, request }) => {
  await page.goto("/vital-signs"); await expect(page.getByRole("heading", { name: "Vital Signs", exact: true })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "AUTH_NOT_CONFIGURED" })).toBeVisible();
  const response = await request.post("/api/resilience/flags", { data: {} }); expect([401, 503]).toContain(response.status());
});
test("admin fixture exposes faults, traces, unavailable counts and cohort reconciliation", async ({ page }, info) => {
  test.setTimeout(60000); // Cold Vite harness imports can exceed 30s during the full browser run.
  let failed = false; let written: unknown;
  await page.route("**/api/refresh-hints", route => route.fulfill({ json: { hintsEnabled: true } }));
  await page.route("**/api/resilience/**", async route => {
    if (route.request().url().endsWith("/flags")) { written = route.request().postDataJSON(); await route.fulfill({ json: { saved: true, propagationPending: true } }); return; }
    if (route.request().url().endsWith("/reconcile")) { await route.fulfill({ json: { acknowledged: 10, pending: 0, accepted: 0, fulfilled: 2, escalated: 5, cancelled: 3, failed: 0, lossExplanation: "All supplied acknowledged IDs accounted for.", rows: [] } }); return; }
    await route.fulfill({ status: failed ? 503 : 200, json: failed ? { error: "SERVICE_UNAVAILABLE" } : { sampledAt: "2026-10-29T09:00:00Z", controlsEnabled: true, flags: { dbDown: true, dbSlowMs: 500, realtimeDown: true, expiresAt: "2026-10-29T09:10:00Z" }, services: { api: "responding", atlas: "unavailable", realtime: "polling available" }, counts: null, alerts: null, telemetry: { scope: "Synthetic process sample", recoveryMs: { atlas: 2300 }, rows: [{ at: "2026-10-29T09:00:00Z", correlationId: "synthetic-trace", service: "atlas", operation: "database-access", durationMs: 501, ok: false }] } } });
  });
  await page.goto(`${origin}/tests/vital-harness.html`);
  await expect(page.getByText("Degraded service.", { exact: false })).toBeVisible();
  await expect(page.getByText("Counts unavailable. No zero count is inferred.")).toBeVisible();
  await page.getByRole("button", { name: "atlas: database-access", exact: false }).click();
  await expect(page.getByRole("dialog", { name: "Request trace" })).toContainText("synthetic-trace");
  await page.getByRole("button", { name: "Close trace" }).click();
  await page.getByRole("button", { name: "Apply for 10 minutes" }).click();
  await expect(page.getByText("Configuration write acknowledged.", { exact: false })).toBeVisible(); expect(written).toMatchObject({ dbDown: true, dbSlowMs: 500, realtimeDown: true });
  await page.getByLabel("Acknowledged request IDs").fill(Array.from({ length: 10 }, (_, i) => `emergency-${i.toString(16).padStart(48, "0")}`).join("\n"));
  await page.getByRole("button", { name: "Reconcile acknowledged IDs" }).click(); await expect(page.getByText("10 acknowledged", { exact: false })).toBeVisible();
  failed = true; await page.getByRole("button", { name: "Refresh Vital Signs" }).click(); await expect(page.getByRole("alert")).toContainText("Last known measurements");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `../_ai_context/artifacts/stage-12-vital-signs-${info.project.name}.png`, fullPage: true });
});
