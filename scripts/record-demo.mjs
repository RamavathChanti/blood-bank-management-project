// Records credential-free local production pages; never signs in or mutates a registry.
import { chromium } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
const output = resolve("../_ai_context/submission"), artifacts = resolve("../_ai_context/artifacts");
await mkdir(output, { recursive: true });
const socket = createServer(); await new Promise(done => socket.listen(0, "127.0.0.1", done));
const port = socket.address().port; await new Promise(done => socket.close(done));
const origin = `http://127.0.0.1:${port}`;
if (existsSync(".env.local") || existsSync(".env.production.local")) throw new Error("Use a credential-free checkout for recording; do not record configured private sessions.");
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };
for (const key of Object.keys(env)) if (/CLERK|MONGODB|INNGEST|WORKFLOW_|VAPID|DONOR_PUSH|AUDIT_|GITHUB_ANCHOR|RESEND|DEMO_|GLOBAL_CONFIG|EDGE_CONFIG|COLD_CHAIN|AI_INTAKE|OPENAI_/.test(key)) delete env[key];
const app = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], { env, windowsHide: true, stdio: "ignore" });
let browser, context, video;
const scenes = [], errors = [], external = [];
const started = performance.now();
try {
  let ready = false;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${origin}/api/health`)).ok) { ready = true; break; } } catch { /* starting */ } await new Promise(done => setTimeout(done, 250)); }
  if (!ready) throw new Error("Local production server did not start");
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, recordVideo: { dir: resolve(".tools/submission-video"), size: { width: 1440, height: 1000 } }, reducedMotion: "reduce" });
  await context.route("**/*", route => { const url = new URL(route.request().url()); if (url.origin === origin || ["data:", "blob:"].includes(url.protocol)) return route.continue(); external.push(url.origin); return route.abort(); });
  const page = await context.newPage(); video = page.video();
  page.on("pageerror", error => errors.push(error.message));
  const scene = async (title, caption, action, hold = 7000) => {
    const t = performance.now();
    await action();
    await page.evaluate(({ title, caption }) => {
      document.getElementById("recording-caption")?.remove();
      const box = document.createElement("aside"); box.id = "recording-caption"; box.setAttribute("aria-label", "Recording narration");
      Object.assign(box.style, { position: "fixed", left: "0", bottom: "0", width: "100%", background: "#07131ff5", color: "#fff", borderTop: "3px solid #72d7bc", padding: "20px 32px", zIndex: "2147483647", font: "20px/1.5 Arial", boxSizing: "border-box" });
      const heading = document.createElement("strong"); heading.textContent = title + " — LOCAL SYNTHETIC DEMO";
      const text = document.createElement("p"); text.textContent = caption; text.style.margin = "6px 0 0";
      box.append(heading, text); document.body.append(box);
    }, { title, caption });
    await page.waitForTimeout(hold);
    const slug = String(scenes.length + 1).padStart(2, "0");
    await page.screenshot({ path: resolve(artifacts, `stage-15-scene-${slug}.png`) });
    scenes.push({ title, caption, startSeconds: (t - started) / 1000, endSeconds: (performance.now() - started) / 1000 });
  };
  const open = path => page.goto(origin + path);
  await scene("Scope and guide", "Teaching model, not clinical software. Four synthetic districts; no patient data. This recording shows the local application, not a hosted cloud deployment.", () => open("/try"), 10000);
  await scene("Repeatable Pulse Map", "Seed monsoon, Development, explicit teaching clock. Browser workers model supply/demand without Atlas writes; all times here are simulated.", async () => { await open("/"); await page.getByTestId("playback-status").waitFor(); await page.getByRole("button", { name: "Advance 1 hour", exact: true }).click(); await page.getByLabel("Simulation metrics").scrollIntoViewIfNeeded(); }, 10000);
  await scene("Explainable inventory", "A+ PRBC, quantity 2, expected use in 2 hours: DEMO-002 precedes DEMO-001. Screening, storage, compatibility and expiry are mandatory gates.", async () => { await open("/inventory"); await page.getByRole("button", { name: "Reserve selected locally" }).click(); await page.getByRole("button", { name: "Cancel reservations" }).click(); }, 10000);
  await scene("Component compatibility", "A+ red cells to O-negative are rejected. Plasma uses reverse ABO rules; platelets use the documented identical-group simplification. This is not laboratory crossmatching.", async () => { await open("/match-lab"); await page.getByRole("button", { name: "A+ to O-: rejected", exact: true }).click(); }, 9000);
  await scene("Code Red: reserve and dispatch", "Stock available fixture: start and dispatch the reserved unit. Issued stock still needs arrival, handover and synthetic-use confirmation.", async () => { await open("/code-red"); await page.getByRole("button", { name: "Start simulated Code Red" }).click(); await page.getByRole("button", { name: "Dispatch reserved stock" }).click(); await page.getByRole("region", { name: "Journey progress", exact: true }).scrollIntoViewIfNeeded(); }, 9000);
  await scene("Code Red: traceable completion", "Advance the teaching clock 60 minutes, confirm handover and synthetic use. Completion follows the full journey; donor acceptance alone never supplies screened blood.", async () => { await page.getByRole("button", { name: "Advance 60 min", exact: true }).click(); await page.getByRole("button", { name: "Confirm handover", exact: true }).click(); await page.getByRole("button", { name: "Confirm synthetic use", exact: true }).click(); await page.getByRole("status").filter({ hasText: "Completed locally" }).waitFor(); }, 10000);
  await scene("Shortage remains explicit", "A two-unit shortage opens 5/10/25 km donor waves and ends unresolved after exhaustion. Escalation is an accounted outcome, not fulfilment.", async () => { await page.getByRole("button", { name: "Reset journey" }).click(); await page.getByLabel("Demo scenario").selectOption("stock-shortage"); await page.getByRole("button", { name: "Start simulated Code Red" }).click(); await page.getByRole("button", { name: "Dispatch reserved stock" }).click(); for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Advance 3 min", exact: true }).click(); await page.getByRole("region", { name: "Donor waves", exact: true }).scrollIntoViewIfNeeded(); }, 10000);
  await scene("Atomic ownership", "The browser Duel explains one owner and zero double allocations. Independent real replica-set tests prove the transaction/index/counter behavior; this animation is not that database race.", async () => { await open("/duel"); await page.getByRole("button", { name: "Start shared countdown" }).click(); await page.getByRole("status").filter({ hasText: "Race complete" }).waitFor(); }, 10000);
  await scene("Matched-month evidence", "Same synthetic demand: nearest 55/264 expired; FEFO 46/264; rebalancing 24/264; camps 26/288. Camps add supply; a lower percentage does not mean fewer absolute expiries.", async () => { await open("/waste-lab"); await page.getByRole("button", { name: "Run matched month" }).click(); await page.getByRole("status").filter({ hasText: "Month complete" }).waitFor({ timeout: 90000 }); await page.getByLabel("Policy comparison").scrollIntoViewIfNeeded(); }, 13000);
  await scene("Tamper evidence", "Isolated SHA-256 fixture: altered event 3 is located at record 3. The private registry adds server HMAC. App/key compromise and unanchored rewrites remain trust limits.", async () => { await open("/unit-passport"); await page.getByRole("heading", { name: "Integrity verified", exact: true }).waitFor(); await page.getByRole("button", { name: "Alter event 3", exact: true }).click(); await page.getByText("First affected record: 3", { exact: true }).waitFor(); }, 11000);
  await scene("Reset and limits", "Reset verifies the original fixture again. Local Inngest outage evidence accounts for 10 acknowledgements: 3 cancelled, 7 escalated. Hosted deployment, rollback and physical phone rehearsal remain pending.", async () => { await page.getByRole("button", { name: "Reset fixture", exact: true }).click(); await page.getByRole("heading", { name: "Integrity verified", exact: true }).waitFor(); }, 11000);
  await scene("Fallback and handoff", "The submission includes report, slides, architecture, viva answers, acceptance procedures, video and an internet-independent simulator. Use the release checklist for college details, named review and actual-device sign-off.", () => open("/try"), 12000);
  if (errors.length || external.length) throw new Error(`Recording boundary failed: ${errors.length} page errors, ${external.length} external requests`);
  await context.close(); context = undefined;
  const source = await video.path(); await rename(source, resolve(output, "PulseGrid-Demo.webm"));
  const localEncoder = resolve(".tools/submission-ffmpeg.exe");
  const ffmpeg = process.env.SUBMISSION_FFMPEG || (existsSync(localEncoder) ? localEncoder : undefined);
  if (!ffmpeg) throw new Error("Set SUBMISSION_FFMPEG to a local H.264-capable FFmpeg executable for MP4 export");
  const conversion = spawnSync(ffmpeg, ["-y", "-i", resolve(output, "PulseGrid-Demo.webm"), "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", resolve(output, "PulseGrid-Demo.mp4")], { windowsHide: true, encoding: "utf8" });
  if (conversion.status !== 0) throw new Error("MP4 conversion failed");
  const check = await browser.newPage();
  // A local HTTP resource is needed for ordinary browser decode validation.
  const mp4 = await import("node:fs/promises").then(fs => fs.readFile(resolve(output, "PulseGrid-Demo.mp4")));
  await check.route("https://recording.invalid/demo.mp4", route => route.fulfill({ contentType: "video/mp4", body: mp4 }));
  await check.goto("about:blank");
  const decoded = await check.evaluate(async () => { const v = document.createElement("video"); v.muted = true; v.src = "https://recording.invalid/demo.mp4"; document.body.append(v); await new Promise((done, reject) => { v.onloadeddata = done; v.onerror = reject; }); await v.play(); return { duration: v.duration, width: v.videoWidth, height: v.videoHeight, paused: v.paused }; });
  if (!decoded.width || decoded.duration < 100 || decoded.paused) throw new Error("Recorded video decode check failed");
  await writeFile(resolve(output, "demo-transcript.md"), "# Recorded local demo transcript\n\nSilent, burned-in captions. Teaching model, not clinical software.\nLocal browser recording; no hosted or human rehearsal claim.\n\n" + scenes.map(row => `## ${row.startSeconds.toFixed(1)}–${row.endSeconds.toFixed(1)} seconds: ${row.title}\n\n${row.caption}\n`).join("\n"));
  await writeFile(resolve(artifacts, "stage-15-recording.json"), JSON.stringify({ environment: "local production Next.js, credential-free synthetic browser scenes", timezone: "Asia/Calcutta", scenes, errors, externalRequests: external, decodedMP4: decoded, humanRehearsal: false, physicalLaptopVerified: false }, null, 2));
  console.log(`Recorded ${scenes.length} scenes; MP4 ${decoded.duration.toFixed(1)}s, ${decoded.width}x${decoded.height}; no page errors or external requests.`);
} finally { await context?.close(); await browser?.close(); app.kill(); }
