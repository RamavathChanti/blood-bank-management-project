import { defineConfig, devices } from "@playwright/test";

const remoteUrl = process.env.PLAYWRIGHT_BASE_URL;
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: remoteUrl || "http://127.0.0.1:3000",
    // Do not retain network traces containing a protected-preview bypass header.
    trace: bypass ? "off" : "retain-on-failure",
    screenshot: "only-on-failure",
    extraHTTPHeaders: bypass ? { "x-vercel-protection-bypass": bypass } : {}
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } }
  ],
  webServer: remoteUrl ? undefined : {
    command: "npm run start -- --hostname 127.0.0.1",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: false,
    timeout: 60_000
  }
});
