// Local routing rehearsal only; this does not deploy or roll back a Vercel project.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const stop = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const reserve = createServer(); const goodPort = await listen(reserve); await stop(reserve);
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", DEMO_CONTROLS_ENABLED: "0" };
for (const key of ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "MONGODB_URI", "INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY"]) delete env[key];
const good = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(goodPort)], { env, windowsHide: true, stdio: "ignore" });
const bad = createServer((_req, response) => { response.writeHead(503, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: "DELIBERATELY_BROKEN_LOCAL_FIXTURE" })); });
let active = goodPort;
const router = createServer(async (request, response) => {
  try { const upstream = await fetch(`http://127.0.0.1:${active}${request.url}`); response.writeHead(upstream.status, { "Content-Type": "application/json" }); response.end(await upstream.text()); }
  catch { response.writeHead(502); response.end(); }
});
try {
  const badPort = await listen(bad), routerPort = await listen(router), url = `http://127.0.0.1:${routerPort}/api/health`;
  let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* wait for known-good artifact */ } await new Promise(resolve => setTimeout(resolve, 200)); }
  assert(ready, "Known-good production build unavailable");
  const baseline = await (await fetch(url)).json(); assert.equal(baseline.status, "ok");
  active = badPort; const detectedAt = performance.now(); assert.equal((await fetch(url)).status, 503);
  const rollbackStarted = performance.now(); active = goodPort;
  const restored = await fetch(url); assert.equal(restored.status, 200); assert.deepEqual(await restored.json(), baseline);
  const evidence = { environment: "LOCAL ONLY: actual Next production build + deliberately failing HTTP stand-in + local routing proxy. No Vercel deployment or rollback.", observedAt: new Date().toISOString(), knownGood: "Current prebuilt .next artifact; /api/health JSON verified", brokenStatus: 503, recoveredStatus: 200, observedFailureToRecoveryMs: Math.round((performance.now() - detectedAt) * 10) / 10, observedRouteRestoreMs: Math.round((performance.now() - rollbackStarted) * 10) / 10, hostedRollback: "PENDING: needs configured Vercel project and two eligible immutable deployments; use docs/resilience.md" };
  await writeFile(resolve("../_ai_context/artifacts/stage-12-local-rollback.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await stop(router); await stop(bad);
  const exited = new Promise(resolve => good.once("exit", resolve));
  if (good.exitCode === null) { good.kill(); await exited; }
}
