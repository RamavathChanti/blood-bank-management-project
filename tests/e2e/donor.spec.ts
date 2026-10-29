import { test, expect, type Page } from "@playwright/test";
import type { DonorView } from "../../src/core/donor-app";

function fixture(): DonorView {
  return { donor: { id: "audience-test", nickname: "Indigo-fixture", group: "O-", eligibleFrom: new Date().toISOString(), expireAt: new Date(Date.now() + 86400_000).toISOString(), optedOut: false, pushState: "OFF" }, alerts: [{ id: "alert-test", requestId: "request-test", group: "O-", component: "PRBC", quantity: 1, status: "PENDING", deadlineAt: new Date(Date.now() + 3600_000).toISOString(), collection: "Synthetic campus bank" }], pushPublicKey: null };
}
async function mount(page: Page, options: { joined?: boolean; late?: boolean; push?: boolean } = {}) {
  let joined = options.joined ?? true, offline = false;
  const data = fixture(), requests: { key: string; alertId: string; reply: string }[] = [];
  if (options.push) data.pushPublicKey = "B".repeat(87);
  await page.route("**/api/donor/*", async route => {
    if (offline) return route.abort("internetdisconnected");
    const path = new URL(route.request().url()).pathname.split("/").at(-1);
    if (path === "me") return route.fulfill({ status: joined ? 200 : 401, json: joined ? data : { error: "DONOR_SESSION_EXPIRED" } });
    if (path === "register") { expect(route.request().postDataJSON()).toEqual({ group: "AB+", site: "Pune", consent: true }); joined = true; return route.fulfill({ json: { donorId: data.donor.id } }); }
    if (path === "reply") { const body = route.request().postDataJSON(); requests.push(body); data.alerts[0].status = options.late ? "TOO_LATE" : body.reply; return route.fulfill({ json: { state: options.late ? "TOO_LATE" : "RECEIVED", requestId: "request-test", reply: body.reply } }); }
    if (path === "opt-out") { data.donor.optedOut = true; return route.fulfill({ json: { state: "OPTED_OUT" } }); }
    if (path === "delete") { joined = false; return route.fulfill({ json: { state: "DELETED" } }); }
    return route.fulfill({ status: 503, json: { error: "PUSH_NOT_CONFIGURED" } });
  });
  await page.goto("/donor");
  return { data, requests, disconnect: (value: boolean) => { offline = value; } };
}

test("phone-first registration requests only pretend details, consent and a generated nickname", async ({ page }, info) => {
  await mount(page, { joined: false });
  await expect(page.getByRole("button", { name: "Join the demo" })).toBeDisabled();
  await page.getByLabel("Pretend blood group").selectOption("AB+");
  await page.getByLabel("I agree to synthetic demo participation.", { exact: false }).check();
  await page.getByRole("button", { name: "Join the demo" }).click();
  await expect(page.getByRole("heading", { name: "Indigo-fixture · O-" })).toBeVisible();
  await expect(page.getByText("Next eligible date (mock):", { exact: false })).toBeVisible();
  await expect(page.getByRole("img", { name: "QR code for demo donor registration" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("donor-phone.png"), fullPage: true });
});

test("full-screen alert is tied to a request and acceptance shows a received receipt", async ({ page }) => {
  const state = await mount(page);
  await page.getByRole("button", { name: "Open full-screen alert" }).click();
  const dialog = page.getByRole("dialog", { name: "Full-screen donor alert" });
  await expect(dialog).toContainText("Request: request-test"); await expect(dialog.getByRole("button", { name: "Close alert" })).toBeFocused();
  await dialog.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Received — accepted.");
  expect(state.requests).toHaveLength(1); expect(state.requests[0]).toMatchObject({ alertId: "alert-test", reply: "ACCEPTED" });
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
});

test("IndexedDB retains an offline response through reload and syncs it with the same key", async ({ page }) => {
  const state = await mount(page); await expect(page.getByText("Indigo-fixture · O-")).toBeVisible();
  state.disconnect(true); await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Pending — saved" })).toBeVisible();
  const original = await page.evaluate(async () => { const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open("pulsegrid-donor-v1", 1); req.onsuccess = () => resolve(req.result); }); const rows = await new Promise<{ key: string }[]>(resolve => { const req = db.transaction("responses").objectStore("responses").getAll(); req.onsuccess = () => resolve(req.result); }); db.close(); return rows[0].key; });
  state.disconnect(false); await page.reload();
  await expect(page.getByRole("status").filter({ hasText: "Received — accepted." })).toBeVisible();
  expect(state.requests).toHaveLength(1); expect(state.requests[0].key).toBe(original);
});

test("a queued response arriving after fulfilment is visibly too late", async ({ page }) => {
  const state = await mount(page, { late: true }); await expect(page.getByText("Indigo-fixture · O-")).toBeVisible();
  state.disconnect(true); await page.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Pending — saved" })).toBeVisible();
  state.disconnect(false); await page.getByRole("button", { name: "Sync responses / refresh" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Too late — this response was not applied." })).toBeVisible();
  expect(state.requests[0].reply).toBe("DECLINED");
});

test("push unconfigured and denied permission keep the in-app alert usable", async ({ page }) => {
  await mount(page); await page.getByRole("button", { name: "Enable notifications" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Push is not configured" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toBeEnabled();
});

test("denied push permission falls back to in-app alerts", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "Notification", { value: { requestPermission: async () => "denied" }, configurable: true }); });
  await mount(page, { push: true }); await page.getByRole("button", { name: "Enable notifications" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Notifications denied or dismissed" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toBeEnabled();
});

test("unsupported push still permits an in-app response", async ({ page }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(window, "Notification"); });
  await mount(page, { push: true }); await page.getByRole("button", { name: "Enable notifications" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Push is unsupported here" })).toBeVisible();
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Received — declined." })).toBeVisible();
});

test("opt-out disables responses; deletion clears this device's queued data", async ({ page }) => {
  await mount(page); await page.getByRole("button", { name: "Opt out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Delete my demo donor" }).click();
  await expect(page.getByRole("button", { name: "Join the demo" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "receipts deleted" })).toBeVisible();
});

test("manifest and worker install a public-only offline fallback", async ({ page, context }) => {
  await page.goto("/donor");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true })); });
  const manifest = await (await page.request.get("/manifest.webmanifest")).json(); expect(manifest).toMatchObject({ start_url: "/donor", display: "standalone" });
  const cached = await page.evaluate(async () => { const keys = await caches.keys(); return (await Promise.all(keys.filter(k => k.startsWith("pulsegrid-donor-public-")).map(async k => (await (await caches.open(k)).keys()).map(r => new URL(r.url).pathname)))).flat(); });
  expect(cached.sort()).toEqual(["/donor-192.png", "/donor-512.png", "/donor-offline.html", "/manifest.webmanifest"]);
  await context.setOffline(true); await page.goto("/donor");
  await expect(page.getByRole("heading", { name: "You’re offline" })).toBeVisible();
  await context.setOffline(false);
});
