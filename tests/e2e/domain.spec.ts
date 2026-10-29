import { expect, test } from "@playwright/test";

test("inventory explains FEFO, reserves, cancels, issues and resets local stock", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/inventory");
  const row = (id: string) => page.getByRole("row").filter({ hasText: id });
  await expect(row("DEMO-002")).toContainText("Selected #1");
  await expect(row("DEMO-001")).toContainText("Selected #2");
  await expect(row("DEMO-006")).toContainText("Unit has reached its expiry instant");
  await expect(row("DEMO-007")).toContainText("All five screens must be non-reactive");
  await expect(row("DEMO-009")).toContainText("Unit must expire strictly after expected use");
  await expect(row("DEMO-010")).toContainText("Different component");
  await page.getByRole("button", { name: "Reserve selected locally" }).click();
  await expect(page.getByRole("status").filter({ hasText: "2 unit(s) reserved locally" })).toBeVisible();
  await expect(row("DEMO-002")).toContainText("RESERVED");
  await expect(page.getByRole("combobox", { name: "Recipient group", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel reservations" }).click();
  await expect(row("DEMO-002")).toContainText("AVAILABLE");
  await expect(page.getByRole("combobox", { name: "Recipient group", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Reserve selected locally" }).click();
  await page.getByRole("button", { name: "Issue reserved locally" }).click();
  await expect(row("DEMO-002")).toContainText("ISSUED");
  await expect(page.getByRole("status").filter({ hasText: "2 unit(s) issued in preference and FEFO order" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Issue reserved locally" })).toBeDisabled();
  await page.getByRole("button", { name: "Reset fixture" }).click();
  await expect(row("DEMO-002")).toContainText("Selected #1");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("inventory.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("inventory filters stock and exposes an insufficient-stock outcome", async ({ page }) => {
  await page.goto("/inventory");
  await page.getByRole("combobox", { name: "Recipient group", exact: true }).selectOption("O-");
  await page.getByRole("button", { name: "Reserve selected locally" }).click();
  await expect(page.getByRole("status").filter({ hasText: "1 unit(s) reserved locally; 1 still needed" })).toBeVisible();
  await page.getByRole("combobox", { name: "Lifecycle status", exact: true }).selectOption("RESERVED");
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(2);
  await page.getByRole("textbox", { name: "Find unit", exact: true }).fill("nothing");
  await expect(page.getByRole("status").filter({ hasText: "No units match these table filters" })).toBeVisible();
  await page.getByRole("button", { name: "Reset fixture" }).click();
  // Reset also clears table filters, so all fixture rows are visible again.
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(16);
});

test("Match Lab changes component rules and explains an accessible grid selection", async ({ page }, testInfo) => {
  await page.goto("/match-lab");
  await expect(page.getByRole("button", { name: /: allowed$/ })).toHaveCount(27);
  await expect(page.locator(".compatibility-explanation")).toContainText("Allowed pair");
  await page.getByRole("button", { name: "A+ to O-: rejected", exact: true }).click();
  await expect(page.locator(".compatibility-explanation")).toContainText("Rejected pair");
  await expect(page.getByRole("button", { name: "A+ to O-: rejected", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("combobox", { name: "Component", exact: true }).selectOption("FFP");
  await expect(page.getByRole("button", { name: /: allowed$/ })).toHaveCount(36);
  await expect(page.locator(".compatibility-explanation")).toContainText("RhD is ignored");
  await expect(page.locator(".compatibility-explanation")).toContainText("Allowed pair");
  await page.getByRole("combobox", { name: "Component", exact: true }).selectOption("PLATELETS");
  await expect(page.getByRole("button", { name: /: allowed$/ })).toHaveCount(8);
  await expect(page.locator(".compatibility-explanation")).toContainText("identical ABO and RhD");
  await page.getByRole("button", { name: "O- to O-: allowed", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".compatibility-explanation")).toContainText("O- → O-");
  await page.getByRole("button", { name: "O- to O-: allowed", exact: true }).evaluate(element => element.blur());
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("match-lab.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
