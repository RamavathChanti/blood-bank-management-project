import { expect, test } from "@playwright/test";

test("Duel models an atomic winner and the naive stale-read double allocation without registry writes", async ({ page }, testInfo) => {
  const registryCalls: string[] = [], errors: string[] = [];
  page.on("request", request => { if (request.url().includes("/api/registry/")) registryCalls.push(request.url()); });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/duel");
  await expect(page.getByText("ISOLATED BROWSER FIXTURE")).toBeVisible();
  await page.getByRole("button", { name: "Start shared countdown" }).click();
  await expect(page.getByRole("status")).toContainText("Shared countdown");
  await expect(page.getByLabel("Reservation mode")).toBeDisabled();
  await expect(page.getByRole("status")).toHaveText("Race complete");
  await expect(page.getByTestId("duel-double-count")).toHaveText("0");
  await expect(page.getByTestId("duel-owner-count")).toHaveText("1");
  await expect(page.getByText("Claim rejected · retry another unit")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("duel-atomic.png"), fullPage: true });
  await page.getByLabel("Reservation mode").selectOption("NAIVE");
  await page.getByRole("button", { name: "Start shared countdown" }).click();
  await expect(page.getByRole("status")).toHaveText("Race complete");
  await expect(page.getByTestId("duel-double-count")).toHaveText("1");
  await expect(page.getByTestId("duel-owner-count")).toHaveText("2");
  await page.screenshot({ path: testInfo.outputPath("duel-naive.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(registryCalls).toEqual([]); expect(errors).toEqual([]);
});

test("Duel reset cancels a running countdown and restores an independent fixture", async ({ page }) => {
  await page.goto("/duel");
  await page.getByRole("button", { name: "Start shared countdown" }).click();
  await page.getByRole("button", { name: "Reset fixture" }).click();
  await expect(page.getByRole("status")).toHaveText("Ready for a shared countdown");
  await expect(page.getByLabel("Reservation mode")).toBeEnabled();
  await expect(page.getByTestId("duel-owner-count")).toHaveText("0");
  await expect(page.getByRole("heading", { name: "Conditional atomic unit update" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Multi-document transaction" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Unique allocation index" })).toBeVisible();
  await expect(page.getByRole("contentinfo")).toContainText("Teaching model, not clinical software.");
});
