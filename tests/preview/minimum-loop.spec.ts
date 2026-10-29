import { expect, test, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
const requireLive = process.env.PREVIEW_REQUIRE_LIVE === "1";

test("login, inventory, hospital, Code Red and public board routes render", async ({ page }) => {
  for (const [path, title] of [["/sign-in", "Sign in to the synthetic registry"], ["/inventory", "Inventory"], ["/hospital", "Hospital portal"], ["/code-red", "Code Red"], ["/public-board", "Public Board"]]) {
    expect((await page.goto(path))?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
    await expect(page.getByRole("contentinfo")).toContainText("Teaching model, not clinical software.");
    if (path === "/sign-in" && requireLive) await expect(page.locator(".cl-signIn-root")).toBeVisible();
  }
});
test("public resource payload is allowlisted and actual CDN observations are retained", async ({ request }, testInfo) => {
  const observations = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await request.get("/api/public-board");
    observations.push({ status: response.status(), cache: response.headers()["x-vercel-cache"] ?? "unknown", age: response.headers().age ?? "unknown", body: await response.json() });
  }
  await testInfo.attach("public-cache-observations", { body: JSON.stringify(observations, null, 2), contentType: "application/json" });
  if (requireLive) expect(observations.every(row => row.status === 200)).toBe(true);
  for (const row of observations.filter(row => row.status === 200)) {
    expect(Object.keys(row.body).sort()).toEqual(["cells", "generatedAt", "schema", "source"]);
    expect(row.body.cells).toHaveLength(96);
    for (const cell of row.body.cells) expect(Object.keys(cell).sort()).toEqual(["band", "component", "district", "group"]);
  }
  if (requireLive) expect(observations.some(row => ["HIT", "STALE", "REVALIDATED"].includes(row.cache))).toBe(true);
});
test("private responses never allow shared caching and unsigned sessions cannot read records", async ({ request }) => {
  for (const path of ["/api/registry/me", "/api/registry/state/units", "/api/emergencies/unknown"]) {
    const response = await request.get(path);
    expect(requireLive ? [401] : [401, 503]).toContain(response.status());
    expect(response.headers()["cache-control"]).toContain("private, no-store");
    expect(response.headers()["vary"]).toContain("Authorization");
    expect(await response.json()).not.toHaveProperty("records");
  }
});
test("atomic Duel browser teaching model has one winner", async ({ page }) => {
  await page.goto("/duel"); await page.getByRole("button", { name: "Start shared countdown" }).click();
  await expect(page.getByRole("status")).toHaveText("Race complete");
  await expect(page.getByTestId("duel-owner-count")).toHaveText("1"); await expect(page.getByTestId("duel-double-count")).toHaveText("0");
});

test("signed bank inventory and two hospital requests race for the same real last unit", async ({ browser, baseURL }, testInfo) => {
  const states = [process.env.PREVIEW_BANK_STORAGE_STATE, process.env.PREVIEW_HOSPITAL_STORAGE_STATE, process.env.PREVIEW_HOSPITAL_B_STORAGE_STATE];
  if (requireLive) expect(states.every(Boolean), "Full live smoke requires three preauthenticated synthetic session states.").toBe(true);
  test.skip(!states.every(Boolean), "Supply three synthetic Clerk session states for the authenticated cloud replay.");
  const contexts: BrowserContext[] = [];
  const created: { context: BrowserContext; parent: string; requestId: string }[] = [];
  const post = async (context: BrowserContext, path: string, data: unknown) => {
    const response = await context.request.post(path, { headers: { Origin: baseURL! }, data });
    expect(response.ok()).toBe(true); expect(response.headers()["cache-control"]).toContain("private, no-store"); return response.json();
  };
  try {
    for (const state of states) contexts.push(await browser.newContext({ baseURL, storageState: JSON.parse(state!), extraHTTPHeaders: process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET } : {} }));
    const bank = await contexts[0].newPage(); await bank.goto("/bank"); await expect(bank.getByRole("heading", { name: "Manage bank stock" })).toBeVisible();
    for (const context of contexts.slice(1)) {
      const page = await context.newPage(); await page.goto("/hospital"); await expect(page.getByRole("heading", { name: "Manage hospital requests" })).toBeVisible();
      const me = await context.request.get("/api/registry/me"); expect(me.ok()).toBe(true); const identity = (await me.json()).identity;
      const parent = `/api/registry/hospitals/${identity.hospitalId}`;
      const request = await post(context, `${parent}/requests`, { key: randomUUID(), group: "O-", component: "PRBC", quantity: 1, urgency: "ROUTINE", expectedTransfusionAt: new Date(Date.now() + 3_600_000).toISOString() });
      created.push({ context, parent, requestId: request.requestId });
      const search = await post(context, `${parent}/requests/${request.requestId}/search`, {});
      expect(search.records, "Use an isolated seeded preview with exactly one eligible O-negative PRBC unit.").toHaveLength(1);
    }
    expect(new Set(created.map(item => item.parent)).size, "The two hospital sessions must belong to different institutions.").toBe(2);
    const results = await Promise.all(created.map(item => post(item.context, `${item.parent}/requests/${item.requestId}/reserve`, { key: randomUUID() })));
    expect(results.filter(result => result.reserved)).toHaveLength(1);
    expect(results.filter(result => !result.reserved)).toHaveLength(1);
    await testInfo.attach("live-duel-results", { body: JSON.stringify(results), contentType: "application/json" });
    const winner = results.find(result => result.reserved);
    await expect(bank.getByRole("cell", { name: winner.unitId, exact: true }).first()).toBeVisible({ timeout: 15_000 });
    const bankSlots = await contexts[0].request.get(`/api/registry/banks/${(await (await contexts[0].request.get("/api/registry/me")).json()).identity.bankId}/allocations`);
    expect((await bankSlots.json()).records.filter((row: { unitId: string; status: string }) => row.unitId === winner.unitId && row.status === "ACTIVE")).toHaveLength(1);
  } finally {
    try { for (const item of created) await post(item.context, `${item.parent}/requests/${item.requestId}/cancel`, { key: randomUUID() }); }
    finally { for (const context of contexts) await context.close(); }
  }
});
