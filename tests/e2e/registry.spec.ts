import { expect, test } from "@playwright/test";

test("unauthenticated registry APIs expose no private records and prohibit shared caching", async ({ request }) => {
  for (const path of ["me", "banks/demo-bank-1/units", "hospitals/demo-hospital-1/requests", "state/donors", "matching/banks"]) {
    const response = await request.get(`/api/registry/${path}`);
    expect([401, 503]).toContain(response.status());
    const body = await response.json();
    expect(body).not.toHaveProperty("records"); expect(body).not.toHaveProperty("record");
    expect(["UNAUTHENTICATED", "AUTH_NOT_CONFIGURED"]).toContain(body.error);
    expect(response.headers()["cache-control"]).toContain("private, no-store");
    expect(response.headers()["vary"]).toContain("Authorization");
  }
  const write = await request.patch("/api/registry/banks/demo-bank-1", { data: { name: "Unauthorized write" } });
  expect([401, 503]).toContain(write.status());
  for (const path of ["banks/demo-bank-1/collect", "hospitals/demo-hospital-1/requests", "hospitals/demo-hospital-1/requests/unknown/reserve"]) {
    const mutation = await request.post(`/api/registry/${path}`, { data: { key: "unauthorized" } });
    expect([401, 503]).toContain(mutation.status());
    expect(await mutation.json()).not.toHaveProperty("reserved");
    expect(mutation.headers()["cache-control"]).toContain("private, no-store");
  }
});

test("registry and login screens render safely without browser errors or horizontal overflow", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  for (const route of ["bank", "hospital", "donor", "registry", "sign-in"]) {
    expect((await page.goto(`/${route}`))?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("contentinfo")).toContainText("Teaching model, not clinical software.");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (route === "bank") await page.screenshot({ path: testInfo.outputPath("registry-unconfigured.png"), fullPage: true });
  }
  expect(errors).toEqual([]);
});
