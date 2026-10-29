import { expect, test, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { resolve } from "node:path";

// Exercise the actual workflow component with explicit synthetic API responses,
// without adding a Clerk bypass or a test page to the production application.
// Allow bounded cold Vite startup under full-suite CPU contention. Serial mode
// keeps one fixture failure from cascading into misleading later observations.
test.describe.configure({ mode: "serial", timeout: 60_000 });
let server: ViteDevServer, origin: string;
test.beforeAll(async () => {
  server = await createServer({ configFile: false, root: resolve("."), cacheDir: resolve(`.tools/portal-harness-${test.info().workerIndex}`), resolve: { alias: { "@": resolve("src") } }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null }, logLevel: "error" });
  await server.listen();
  const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("Expected local harness port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); });
async function mock(page: Page, respond: (path: string, body: Record<string, unknown> | null) => { status?: number; body: unknown }) {
  await page.route("**/api/registry/**", async route => {
    const request = route.request(), result = respond(new URL(request.url()).pathname.replace("/api/registry/", ""), request.method() === "POST" ? request.postDataJSON() : null);
    await route.fulfill({ status: result.status ?? 200, contentType: "application/json", body: JSON.stringify(result.body) });
  });
}
test("Bank workflow sends validated collection and screening commands, then refreshes stock", async ({ page }, testInfo) => {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const unit = { id: "fixture-unit", group: "O-", component: "PRBC", status: "TESTING", storage: "UNKNOWN", expiresAt: "2026-10-30T00:00:00Z", screening: { HIV: "PENDING" } };
  await mock(page, (path, body) => {
    if (!body) return { body: { records: [unit], next: null } };
    writes.push({ path, body });
    if (body.type === "UPDATE_SCREENING") unit.screening = body.screening as typeof unit.screening;
    return { body: { unitId: unit.id, status: "TESTING" } };
  });
  await page.goto(`${origin}/tests/portal-harness.html?role=BANK`);
  await page.getByText("Record a synthetic collection", { exact: true }).click();
  await page.getByLabel("Synthetic donor ID").fill("donor-1");
  await page.getByLabel("Collected group").selectOption("O-");
  await page.getByRole("button", { name: "Record collection", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("fixture-unit");
  expect(writes[0]).toMatchObject({ path: "banks/bank-1/collect", body: { donorId: "donor-1", group: "O-", product: "PRBC_SAGM" } });
  expect(writes[0].body.key).toEqual(expect.any(String));
  await page.getByLabel("Bank unit").selectOption("fixture-unit");
  await page.getByLabel("Lifecycle action").selectOption("UPDATE_SCREENING");
  for (const screen of ["HIV", "HEPATITIS_B", "HEPATITIS_C", "SYPHILIS", "MALARIA"]) await page.getByLabel(screen, { exact: true }).selectOption("NON_REACTIVE");
  await page.getByRole("button", { name: "Apply lifecycle action" }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({ path: "banks/bank-1/units/fixture-unit/action", body: { type: "UPDATE_SCREENING", screening: { HIV: "NON_REACTIVE", MALARIA: "NON_REACTIVE" } } });
  await expect(page.getByText(/Selected expiry/)).toContainText("NON_REACTIVE");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("bank-workflow-fixture.png"), fullPage: true });
});
test("Hospital workflow creates, searches, reserves, and confirms issued stock", async ({ page }, testInfo) => {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const request = { id: "request-1", group: "O-", component: "PRBC", quantity: 1, allocatedQuantity: 0, transfusedQuantity: 0, status: "OPEN" };
  let issued = false, handover = false, used = false;
  await mock(page, (path, body) => {
    if (!body) return { body: { records: path.endsWith("/allocations") ? issued ? [{ id: "allocation-1", unitId: "unit-1", requestId: request.id, status: used ? "TRANSFUSED" : "ISSUED", leaseExpiresAt: "2026-10-29T09:10:00Z", ...(handover ? { handoverAt: "2026-10-29T09:05:00Z" } : {}) }] : [] : [request], next: null } };
    writes.push({ path, body });
    if (path.endsWith("/search")) return { body: { policy: "Synthetic candidate fixture", records: [{ unitId: "unit-1", bankName: "Synthetic bank", group: "O-", component: "PRBC", preference: 1, distanceKm: 1 }] } };
    if (path.endsWith("/reserve")) { request.allocatedQuantity = 1; request.status = "ALLOCATED"; issued = true; return { body: { reserved: true, requestId: request.id, allocatedQuantity: 1, remaining: 0 } }; }
    if (body.type === "HANDOVER") handover = true;
    if (body.type === "TRANSFUSE") { request.status = "COMPLETED"; request.transfusedQuantity = 1; used = true; }
    return { body: { requestId: request.id, status: request.status } };
  });
  await page.goto(`${origin}/tests/portal-harness.html?role=HOSPITAL`);
  await page.getByText("Create a synthetic request", { exact: true }).click();
  await page.getByLabel("Recipient group").selectOption("O-");
  await page.getByRole("button", { name: "Create request", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("request-1");
  expect(writes[0]).toMatchObject({ path: "hospitals/hospital-1/requests", body: { group: "O-", quantity: 1 } });
  await page.getByLabel("Hospital request").selectOption("request-1");
  await page.getByRole("button", { name: "Search compatible stock" }).click();
  await expect(page.getByText("Synthetic bank", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reserve next unit" }).click();
  const transfuse = page.getByRole("button", { name: "Confirm synthetic transfusion unit-1" });
  await expect(transfuse).toBeDisabled();
  await page.getByRole("button", { name: "Confirm handover unit-1" }).click();
  await expect(transfuse).toBeEnabled(); await transfuse.click();
  await expect(page.getByRole("cell", { name: "COMPLETED", exact: true })).toBeVisible();
  expect(writes.some(w => w.body.type === "TRANSFUSE")).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("hospital-workflow-fixture.png"), fullPage: true });
});
test("uncertain writes retain the same retry key and lock new mutations until recovery", async ({ page }) => {
  const keys: unknown[] = [];
  await mock(page, (path, body) => {
    if (!body) return { body: { records: [{ id: "request-1", quantity: 1, allocatedQuantity: 0, status: "OPEN" }], next: null } };
    keys.push(body.key);
    return keys.length === 1 ? { status: 503, body: { error: "DATABASE_UNAVAILABLE", requestId: "synthetic-reference" } } : { body: { reserved: true, requestId: "request-1" } };
  });
  await page.goto(`${origin}/tests/portal-harness.html?role=HOSPITAL`);
  await page.getByLabel("Hospital request").selectOption("request-1");
  await page.getByRole("button", { name: "Reserve next unit" }).click();
  await expect(page.getByRole("alert")).toContainText("DATABASE_UNAVAILABLE");
  await expect(page.getByRole("button", { name: "Reserve next unit" })).toBeDisabled();
  await page.getByRole("button", { name: "Retry pending action" }).click();
  await expect(page.getByRole("status")).toContainText("Reserved stock for request request-1");
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  await expect(page.getByRole("button", { name: "Retry pending action" })).toHaveCount(0);
});
