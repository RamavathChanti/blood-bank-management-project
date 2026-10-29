import { expect, test } from "@playwright/test";

test("matched month replays, filters weather, downloads evidence and stays responsive", async ({ page }, testInfo) => {
  test.setTimeout(120000);
  const errors: string[] = [], registryCalls: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.url().includes("/api/registry")) registryCalls.push(request.url()); });
  await page.goto("/waste-lab");
  await expect(page.getByRole("heading", { name: "Blood Weather", exact: true })).toBeVisible();
  await expect(page.getByRole("contentinfo")).toContainText("Teaching model, not clinical software.");
  await page.getByRole("button", { name: "Run matched month" }).click();
  // Main-thread filtering continues while the monthly calculation runs in a worker.
  await page.getByLabel("Aggregate by").selectOption("BANK");
  await expect(page.getByLabel("Comparison progress")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Month complete" })).toBeVisible({ timeout: 90000 });
  const first = await page.getByTestId("policy-REBALANCE").innerText();
  await expect(page.getByLabel("Policy comparison").getByRole("row")).toHaveCount(5);
  await expect(page.getByTestId("forecast-backtest")).toContainText("unseen days");
  await page.getByLabel("Group", { exact: true }).selectOption("A+");
  await page.getByLabel("Component", { exact: true }).selectOption("PRBC");
  await expect(page.getByLabel("Blood Weather forecast")).toContainText("A+ PRBC");
  const downloadPromise = page.waitForEvent("download"); await page.getByRole("button", { name: "Download results JSON" }).click();
  expect((await downloadPromise).suggestedFilename()).toMatch(/^pulsegrid-waste-[a-f0-9]+\.json$/);
  await page.getByRole("button", { name: "Run matched month" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Month complete" })).toBeVisible({ timeout: 90000 });
  expect(await page.getByTestId("policy-REBALANCE").innerText()).toBe(first);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]); expect(registryCalls).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("blood-weather.png"), fullPage: true });
  await page.getByLabel("Policy comparison").screenshot({ path: testInfo.outputPath("policy-comparison.png") });
  await page.getByLabel("Blood Weather forecast").screenshot({ path: testInfo.outputPath("forecast-and-transfers.png") });
});
test("cancel terminates the worker and invalid assumptions do not start a comparison", async ({ page }) => {
  await page.goto("/waste-lab"); await page.getByRole("button", { name: "Run matched month" }).click(); await page.getByRole("button", { name: "Cancel run" }).click();
  await expect(page.getByRole("button", { name: "Run matched month" })).toBeEnabled();
  for (const day of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) await page.getByLabel(`${day} demand weight`).fill("0");
  await page.getByRole("button", { name: "Run matched month" }).click(); await expect(page.getByRole("main").getByRole("alert")).toContainText("weekday weights");
  await expect(page.getByLabel("Comparison progress")).toHaveCount(0);
});
