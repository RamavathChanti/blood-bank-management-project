import { test, expect } from "@playwright/test";
import { preview, type PreviewServer } from "vite";
import { resolve } from "node:path";

let sandbox: PreviewServer, sandboxOrigin: string;
test.beforeAll(async () => {
  sandbox = await preview({ configFile: false, root: resolve("scripts/offline"), build: { outDir: resolve("../_ai_context/submission/offline-sandbox") }, preview: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  const address = sandbox.httpServer.address();
  if (!address || typeof address === "string") throw new Error("No sandbox port");
  sandboxOrigin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await new Promise<void>((done, reject) => sandbox?.httpServer.close(error => error ? reject(error) : done())); });

test("guide supports keyboard entry, readable narrow layouts and safe participation instructions", async ({ page }, info) => {
  await page.goto("/try");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Things worth trying");
  await expect(page.getByRole("heading", { name: "Join the synthetic donor exercise" })).toBeVisible();
  await expect(page.getByText("A pending offline response is a queued attempt", { exact: false })).toBeVisible();
  await page.screenshot({ path: resolve(`../_ai_context/artifacts/stage-15-guide-${info.project.name}.png`), fullPage: true });
  await page.setViewportSize({ width: 640, height: 900 });
  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("link", { name: "Explain a safe match", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/inventory$/);
  await expect(page.getByRole("heading", { name: "Find eligible stock" })).toBeVisible();
});

test("slow aggregate response keeps controls responsive and failure recovers explicitly", async ({ page }) => {
  let fail = true;
  await page.route("**/api/public-board", async route => {
    await new Promise(done => setTimeout(done, 900));
    await route.fulfill({ status: fail ? 503 : 200, json: fail ? { error: "PUBLIC_BOARD_UNAVAILABLE" } : { schema: 1, source: "synthetic-registry", generatedAt: new Date().toISOString(), cells: [] } });
  });
  await page.goto("/public-board");
  await expect(page.getByRole("status").filter({ hasText: "Loading public aggregate" })).toBeVisible();
  await page.getByLabel("Public group", { exact: true }).selectOption("O-");
  await expect(page.getByRole("region", { name: "Public registry availability" }).getByRole("alert")).toContainText("Refresh unavailable");
  await expect(page.getByRole("status").filter({ hasText: "NO LIVE DATA" })).toContainText("No last-good snapshot");
  fail = false;
  await page.getByRole("button", { name: "Refresh public snapshot" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Snapshot" })).toContainText("Within freshness target");
  await expect(page.getByRole("region", { name: "Public registry availability" }).getByRole("alert")).toHaveCount(0);
});

test("prebuilt offline sandbox runs workers and a complete emergency with external traffic blocked", async ({ page, context }) => {
  test.setTimeout(120000);
  const external: string[] = [], errors: string[] = [];
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (["127.0.0.1", "localhost"].includes(url.hostname) || ["data:", "blob:"].includes(url.protocol)) return route.continue();
    external.push(url.origin); return route.abort();
  });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(sandboxOrigin);
  await expect(page.getByTestId("playback-status")).toHaveText("PAUSED");
  await page.getByRole("button", { name: "Advance 1 hour", exact: true }).click();
  await expect(page.getByLabel("Heartbeat and activity")).not.toContainText("No events yet");
  await page.getByRole("navigation", { name: "Offline scenes" }).getByRole("button", { name: "Code Red", exact: true }).click();
  await page.getByRole("button", { name: "Start simulated Code Red" }).click();
  await page.getByRole("button", { name: "Dispatch reserved stock" }).click();
  await page.getByRole("button", { name: "Advance 60 min", exact: true }).click();
  await page.getByRole("button", { name: "Confirm handover", exact: true }).click();
  await page.getByRole("button", { name: "Confirm synthetic use", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Completed locally" })).toBeVisible();
  await page.getByRole("navigation", { name: "Offline scenes" }).getByRole("button", { name: "Blood Weather", exact: true }).click();
  await page.getByRole("button", { name: "Run matched month" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Month complete" })).toBeVisible({ timeout: 90000 });
  expect(external).toEqual([]); expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
