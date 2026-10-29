import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
test.use({ launchOptions: { args: ["--enable-unsafe-swiftshader"] } });
test("Cold Room quarantines once, holds after recovery, resets and renders the 3D scene", async ({ page }, info) => {
  const errors: string[] = [], writes: string[] = []; page.on("pageerror", e => errors.push(e.message)); page.on("request", r => { if (r.url().includes("/api/registry")) writes.push(r.url()); });
  await page.goto("/cold-room"); await expect(page.getByRole("heading", { name: "Cold Room", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Synthetic fault", exact: true }).selectOption("PRBC"); await page.getByRole("button", { name: "Advance feed 1 minute" }).click();
  await page.getByLabel("Inspect synthetic unit").selectOption("DEMO-003"); await expect(page.getByRole("status").filter({ hasText: "DEMO-003" })).toContainText("QUARANTINED");
  const first = await page.getByRole("status").filter({ hasText: "quarantine events" }).innerText();
  await page.getByRole("button", { name: "Advance feed 1 minute" }).click(); expect(await page.getByRole("status").filter({ hasText: "quarantine events" }).innerText()).toBe(first);
  await page.getByRole("combobox", { name: "Synthetic fault", exact: true }).selectOption("NONE"); await page.getByRole("button", { name: "Advance feed 1 minute" }).click(); await expect(page.getByRole("status").filter({ hasText: "DEMO-003" })).toContainText("QUARANTINED");
  await page.getByRole("button", { name: "Enable 3D view" }).click(); await expect(page.locator("canvas")).toBeVisible(); await page.waitForTimeout(1000);
  await page.screenshot({ path: resolve(`../_ai_context/artifacts/stage-14-cold-${info.project.name}.png`), fullPage: true });
  await page.getByRole("button", { name: "Reset local fixture" }).click(); await expect(page.getByRole("status").filter({ hasText: "DEMO-003" })).toContainText("AVAILABLE"); expect(errors).toEqual([]); expect(writes).toEqual([]);
});
test("dictionary Hindi/Hinglish drafts stay editable and require explicit confirmation with no submission", async ({ page }) => {
  let submitted = 0; page.on("request", r => { if (r.method() === "POST" && r.url().includes("/api/emergencies")) submitted++; });
  await page.goto("/intelligence"); await page.getByLabel("Synthetic request text").fill("A+ PRBC 2 यूनिट तुरंत 2 घंटे में"); await page.getByRole("button", { name: "Extract editable draft" }).click();
  await expect(page.getByLabel("Draft blood group")).toHaveValue("A+"); await expect(page.getByRole("button", { name: "Confirm reviewed draft" })).toBeDisabled();
  await page.getByLabel("I reviewed every field", { exact: false }).check(); await page.getByLabel("Draft quantity").fill("3"); await expect(page.getByRole("button", { name: "Confirm reviewed draft" })).toBeDisabled();
  await page.getByLabel("I reviewed every field", { exact: false }).check(); await page.getByRole("button", { name: "Confirm reviewed draft" }).click(); await expect(page.getByRole("status").filter({ hasText: "Draft confirmed" })).toBeVisible(); expect(submitted).toBe(0);
});
test("AI mode fails closed and ops templates expose only inspectable local aggregates", async ({ page }) => {
  await page.goto("/intelligence"); await page.getByLabel("Extraction mode").selectOption("ai"); await page.getByRole("button", { name: "Extract editable draft" }).click(); await expect(page.getByRole("status").filter({ hasText: /AUTH_NOT_CONFIGURED|UNAUTHENTICATED/ })).toBeVisible();
  await page.getByLabel("Safe query template").selectOption("TRANSFER_SUMMARY"); await page.getByRole("button", { name: "Inspect aggregate answer" }).click(); await expect(page.locator("pre")).toContainText("LOCAL_SYNTHETIC_AGGREGATES"); await expect(page.locator("pre")).not.toContainText("donorId");
});
test("camp planner handles capacity zero and invalid input, then replays a weighted plan", async ({ page }, info) => {
  await page.goto("/camp-planner"); await expect(page.getByRole("heading", { name: "Donation-camp planner" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("proposed sites"); const initial = await page.getByRole("status").innerText(); expect(initial).not.toContain("0 proposed sites");
  await page.getByLabel("Weekly invitations").fill("0"); await expect(page.getByRole("status")).toContainText("0 proposed sites");
  await page.getByLabel("Weekly invitations").fill("21"); await expect(page.getByRole("alert").filter({ hasText: "Use 0" })).toBeVisible(); await page.getByLabel("Weekly invitations").fill("8"); await expect(page.getByRole("status")).toHaveText(initial);
  await page.screenshot({ path: resolve(`../_ai_context/artifacts/stage-14-camp-${info.project.name}.png`), fullPage: true });
});
test("Match Lab animation and isolated Bombay case honor reduced motion", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); await page.goto("/match-lab"); await expect(page.locator(".reaction-cell").first()).toHaveCSS("animation-name", "none");
  await page.getByLabel("Optional Bombay-phenotype case").check(); await expect(page.getByRole("status").filter({ hasText: "Isolated exception" })).toBeVisible();
  await page.getByRole("button", { name: "Pause reaction animation" }).click(); await expect(page.getByRole("button", { name: "Resume reaction animation" })).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: resolve(`../_ai_context/artifacts/stage-14-match-${info.project.name}.png`), fullPage: true });
});
test("Demo Director requires opt-in, navigates scenes and leaves form typing alone", async ({ page }) => {
  await page.goto("/intelligence"); await page.keyboard.press("Alt+Shift+Digit2"); await expect(page).toHaveURL(/\/intelligence$/);
  await page.getByRole("button", { name: "Demo Director off" }).click(); await page.getByLabel("Synthetic request text").focus(); await page.keyboard.press("Alt+Shift+Digit2"); await expect(page).toHaveURL(/\/intelligence$/);
  await page.getByRole("button", { name: "Demo Director on" }).focus(); await page.keyboard.press("Alt+Shift+Digit2"); await expect(page).toHaveURL(/\/cold-room$/);
});
test("optional sound is off initially and new pages fit desktop and mobile", async ({ page }) => {
  await page.goto("/code-red"); await expect(page.getByRole("button", { name: "Play Code Red cue" })).toBeDisabled(); await page.getByLabel("Enable optional demo sound").check(); await expect(page.getByRole("button", { name: "Play Code Red cue" })).toBeEnabled(); await page.getByLabel("Enable optional demo sound").uncheck();
  for (const route of ["cold-room", "camp-planner", "intelligence"]) { await page.goto(`/${route}`); await expect(page.getByRole("contentinfo")).toContainText("Teaching model, not clinical software."); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
});
