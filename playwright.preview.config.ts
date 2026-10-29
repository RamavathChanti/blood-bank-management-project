import { defineConfig, devices } from "@playwright/test";
const origin = process.env.PLAYWRIGHT_BASE_URL;
if (!origin) throw new Error("PLAYWRIGHT_BASE_URL is required for deployed preview smoke.");
export default defineConfig({
  testDir: "./tests/preview", workers: 1, retries: 0, timeout: 60_000,
  reporter: [["list"], ["json", { outputFile: "test-results/preview-smoke.json" }]],
  use: { baseURL: origin, ...devices["Desktop Chrome"], trace: "off", screenshot: "off", extraHTTPHeaders: process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET } : {} }
});
