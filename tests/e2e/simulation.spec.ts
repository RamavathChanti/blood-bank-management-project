import { expect, test } from "@playwright/test";

test("Pulse Map filters, keyboard markers, transfers and heartbeat react to worker events", async ({ page }, testInfo) => {
  const errors: string[] = [], registryRequests: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (!["/api/public-board", "/api/refresh-hints"].some(path => request.url().endsWith(path)) && (request.url().includes("/api/") || /mongodb|inngest|clerk|atlas/.test(request.url()))) registryRequests.push(request.url()); });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Pulse Map", exact: true })).toBeVisible();
  await expect(page.getByTestId("dataset-summary")).toContainText("4 banks · 4 hospitals · 200 donors");
  await expect(page.getByTestId("playback-status")).toHaveText("PAUSED");
  await expect(page.getByText("No events yet.", { exact: false })).toBeVisible();
  await page.getByRole("combobox", { name: "Blood group", exact: true }).selectOption("O-");
  await expect(page.getByTestId("selected-stock")).toContainText("PRBC units available · O-");
  const marker = page.getByRole("button", { name: /^Select Demo Bank 2,/ });
  await marker.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("combobox", { name: "Bank", exact: true })).toHaveValue("demo-bank-2");
  const hospital = page.getByRole("button", { name: "Select Demo Hospital 1", exact: true });
  await hospital.focus(); await page.keyboard.press("Space");
  await expect(page.getByRole("heading", { name: "Demo Hospital 1", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Component", exact: true }).selectOption("PLATELETS");
  await expect(page.getByTestId("selected-stock")).toContainText("PLATELETS units available · O-");
  await page.getByRole("button", { name: "Advance 1 hour", exact: true }).click();
  await expect(page.getByTestId("elapsed")).toContainText("0d 1h 0m");
  await expect(page.getByTestId("transfer-arc")).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Heartbeat and activity" })).toContainText("TRANSFER");
  await expect(page.getByRole("img", { name: "Activity in the last simulated hour" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("pulse-map.png"), fullPage: true });
  expect(errors).toEqual([]); expect(registryRequests).toEqual([]);
});

test("day replay reproduces every metric, reset restores the fixture and persistence restores configuration", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Pulse Map", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Scenario", exact: true }).selectOption("near-expiry");
  await page.getByRole("button", { name: "Load scenario", exact: true }).click();
  await expect(page.getByTestId("elapsed")).toContainText("Near-expiry inventory");
  await page.getByRole("button", { name: "Advance 1 day", exact: true }).click();
  await expect(page.getByTestId("elapsed")).toContainText("1d 0h 0m");
  await expect(page.getByTestId("playback-status")).toHaveText("PAUSED");
  const before = await page.locator(".pulse-metrics").innerText();
  expect(Number(await page.getByTestId("metric-expired").innerText())).toBeGreaterThanOrEqual(12);
  await page.getByRole("button", { name: "Replay elapsed time", exact: true }).click();
  await expect(page.getByTestId("playback-status")).toHaveText("PAUSED");
  await expect(page.getByTestId("elapsed")).toContainText("1d 0h 0m");
  // Worker snapshots arrive asynchronously; wait for the completed replay rather
  // than comparing an intermediate render immediately after an already-true clock.
  await expect(page.locator(".pulse-metrics")).toHaveText(before, { useInnerText: true });
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.getByTestId("elapsed")).toContainText("0d 0h 0m");
  await expect(page.getByTestId("metric-expired")).toHaveText("0");
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Scenario", exact: true })).toHaveValue("near-expiry");
  await expect(page.getByTestId("elapsed")).toContainText("0d 0h 0m");
  await expect(page.getByTestId("playback-status")).toHaveText("PAUSED");
});

test("demo preset runs in the worker while controls remain responsive, then pauses", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Pulse Map", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Dataset", exact: true }).selectOption("demo");
  await page.getByRole("combobox", { name: "Scenario", exact: true }).selectOption("dengue-season");
  await page.getByRole("button", { name: "Load scenario", exact: true }).click();
  await expect(page.getByTestId("dataset-summary")).toContainText("20 banks · 50 hospitals · 5,000 donors");
  await page.getByRole("combobox", { name: "Simulation speed", exact: true }).selectOption("86400");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByTestId("playback-status")).toHaveText("RUNNING");
  await page.getByRole("combobox", { name: "Blood group", exact: true }).selectOption("AB-");
  await page.getByRole("combobox", { name: "Component", exact: true }).selectOption("PLATELETS");
  await expect(page.getByTestId("selected-stock")).toContainText("PLATELETS units available · AB-");
  await expect(page.getByTestId("metric-requests")).not.toHaveText("1");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByTestId("playback-status")).toHaveText("PAUSED");
  const clock = await page.getByTestId("elapsed").innerText();
  await page.waitForTimeout(600); expect(await page.getByTestId("elapsed").innerText()).toBe(clock);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("demo-pulse-map.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("last unit and shortage scenarios expose scarce O-negative stock", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Pulse Map", exact: true })).toBeVisible();
  for (const scenario of ["last-o-negative", "stock-shortage"]) {
    await page.getByRole("combobox", { name: "Scenario", exact: true }).selectOption(scenario);
    await page.getByRole("button", { name: "Load scenario", exact: true }).click();
    await expect(page.getByTestId("elapsed")).toContainText(scenario === "stock-shortage" ? "Stock shortage" : "Last O-negative unit");
    await page.getByRole("combobox", { name: "Blood group", exact: true }).selectOption("O-");
    await expect(page.getByTestId("selected-stock")).toHaveText("1 PRBC units available · O-");
    await page.getByRole("button", { name: "Advance 1 hour", exact: true }).click();
    await expect(page.getByTestId("elapsed")).toContainText("0d 1h 0m");
    await expect(page.getByTestId("selected-stock")).toHaveText("0 PRBC units available · O-");
    await expect(page.getByRole("region", { name: "Heartbeat and activity" })).toContainText("scenario-last-o-negative matched and issued");
  }
});

test("invalid storage and configuration fail visibly and allow recovery", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pulsegrid.simulation.v1", '{"version":9000}'));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Pulse Map", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Scenario controls" }).getByRole("status")).toContainText("monsoon baseline was loaded");
  await page.getByRole("textbox", { name: "Seed", exact: true }).fill(" ");
  await page.getByRole("button", { name: "Load scenario", exact: true }).click();
  await expect(page.getByRole("region", { name: "Scenario controls" }).getByRole("alert")).toContainText("non-empty seed");
  await page.getByRole("textbox", { name: "Seed", exact: true }).fill("monsoon");
  await page.getByRole("button", { name: "Load scenario", exact: true }).click();
  await expect(page.getByRole("region", { name: "Scenario controls" }).getByRole("alert")).toHaveCount(0);
});
