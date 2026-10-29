import { expect, test } from "@playwright/test";

test("Control Room navigation reaches the local inventory engine", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page).toHaveTitle("PulseGrid — College Demo");
  await expect(page.getByRole("heading", { name: "A network with a pulse." })).toBeVisible();
  await expect(page.getByRole("contentinfo")).toContainText("Teaching model, not clinical software.");
  await page.screenshot({ path: testInfo.outputPath("control-room.png"), fullPage: true });
  await page.getByRole("navigation").getByRole("link", { name: "Inventory", exact: true }).click();
  await expect(page).toHaveURL(/\/inventory$/);
  await expect(page.getByRole("heading", { name: "Find eligible stock" })).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("link", { name: "Inventory", exact: true })).toHaveAttribute("aria-current", "page");
});

test("every planned route renders a disclaimer and no failed response", async ({ page }) => {
  for (const [route, heading] of [["inventory", "Inventory"], ["match-lab", "Match Lab"], ["code-red", "Code Red"], ["bank", "Bank portal"], ["hospital", "Hospital portal"], ["duel", "The Duel"], ["public-board", "Public Board"]]) {
    const response = await page.goto(`/${route}`);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
    await expect(page.getByRole("contentinfo")).toContainText("Teaching model, not clinical software.");
    if (!["bank", "hospital", "public-board"].includes(route)) await expect(page.getByText("NO LIVE DATA", { exact: true })).toBeVisible();
    if (route === "public-board") await expect(page.getByLabel("Observed CDN cache")).toBeVisible();
  }
});

test("browser worker initializes without registry access or browser errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/system");
  await page.getByRole("button", { name: "Check worker", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Worker ready" })).toHaveText("Worker ready · fixed seed and clock received.");
  expect(errors).toEqual([]);
});

test("health is uncached Node liveness without claiming provider connectivity", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(await response.json()).toMatchObject({ status: "ok", stage: "registry-foundation", runtime: "nodejs", integrations: { atlas: "not-probed", clerk: "not-probed", inngest: "not-probed" } });
});

test("missing routes recover and the keyboard skip link reaches content", async ({ page }) => {
  expect((await page.goto("/missing-workspace"))?.status()).toBe(404);
  await page.getByRole("link", { name: "Return to Control Room" }).click();
  await expect(page).toHaveURL("/");
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
