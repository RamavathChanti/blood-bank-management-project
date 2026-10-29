import { expect, test } from "@playwright/test";
test("passport verifies, locates tampering and resets without changing registry data", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/unit-passport");
  await expect(page.getByRole("heading", { name: "Integrity verified", exact: true })).toBeVisible();
  await expect(page.getByLabel("Unit event timeline").getByRole("listitem")).toHaveCount(9);
  await page.getByText("Inspect hashes", { exact: true }).first().click();
  await expect(page.getByText("Event SHA-256", { exact: true }).first()).toBeVisible();
  for (const label of ["Alter event 3", "Remove event 3", "Swap events 3 and 4"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.getByText("First affected record: 3", { exact: true })).toBeVisible();
    if (label === "Alter event 3") {
      await expect(page.locator(".passport-event-broken")).toHaveCount(7);
      await page.screenshot({ path: `../_ai_context/artifacts/stage-11-tampered-${test.info().project.name}.png`, fullPage: true });
    }
  }
  await page.getByRole("button", { name: "Change current expiry" }).click();
  await expect(page.getByText("CURRENT_STATE_MISMATCH", { exact: true })).toBeVisible();
  await expect(page.getByText(/Chain: VALID · Signature: LOCAL_ONLY · Current state: MISMATCH/)).toBeVisible();
  await page.getByRole("button", { name: "Reset fixture" }).click();
  await expect(page.getByRole("heading", { name: "Integrity verified", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: `../_ai_context/artifacts/stage-11-passport-${test.info().project.name}.png`, fullPage: true });
});
test("admin integrity meter shows separate failures and retains an alert after a clean check", async ({ page }) => {
  const report = { kind: "AUDIT_REPORT", at: "2026-10-29T09:00:00.000Z", checked: 1, valid: 0, failed: [{ unitId: "synthetic-unit", chain: "VALID", signature: "MISMATCH", state: "MISMATCH", firstBadSeq: null }], orphanEvents: 0, ok: false };
  let clean = false;
  await page.route("**/api/audit/status", route => route.fulfill({ json: { report: clean ? { ...report, ok: true, valid: 1, failed: [] } : report, alert: report, anchor: null } }));
  await page.route("**/api/audit/verify", async route => { expect(route.request().method()).toBe("POST"); expect(route.request().postDataJSON()).toEqual({}); clean = true; await route.fulfill({ json: { report: { ...report, ok: true } } }); });
  await page.goto("/unit-passport");
  await page.getByRole("button", { name: "Refresh integrity meter" }).click();
  await expect(page.getByText("0 / 1 units valid · INTEGRITY ALARM", { exact: true })).toBeVisible();
  await expect(page.getByText(/synthetic-unit: chain VALID, signature MISMATCH/)).toBeVisible();
  await page.getByRole("button", { name: "Verify registry now" }).click();
  await expect(page.getByText("1 / 1 units valid · PASS", { exact: true })).toBeVisible();
  await expect(page.getByText(/Last recorded admin alert:/)).toBeVisible();
});
test("private audit fails closed when authentication is unconfigured", async ({ page, request }) => {
  await page.goto("/unit-passport");
  await expect(page.getByRole("heading", { name: "Integrity verified", exact: true })).toBeVisible();
  await page.getByLabel("Passport source").selectOption("registry");
  await page.getByRole("button", { name: "Verify unit", exact: true }).click();
  await expect(page.getByText("AUTH_NOT_CONFIGURED", { exact: true })).toBeVisible();
  const response = await request.get("/api/audit/status"); expect(response.status()).toBe(503); expect(response.headers()["cache-control"]).toContain("no-store");
});
