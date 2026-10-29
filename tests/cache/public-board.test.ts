// Tests the real production Next Data Cache, not a mocked cache or a Map.
import { afterAll, beforeAll, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { MongoClient, type Db } from "mongodb";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { SCREENS } from "../../src/core/domain";
import type { PublicBoard } from "../../src/core/public-board";

let repl: MongoMemoryReplSet, client: MongoClient, db: Db, app: ChildProcess, origin: string;
const evidence: Record<string, unknown> = { environment: "local production Next.js; temporary MongoDB; no Vercel CDN or Clerk session" };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function stopApp() {
  if (!app || app.exitCode !== null) return;
  const exited = new Promise<void>(resolve => app.once("exit", () => resolve()));
  app.kill(); await exited;
}
async function startApp(uri?: string) {
  const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address(); if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>(resolve => socket.close(() => resolve()));
  origin = `http://127.0.0.1:${address.port}`;
  const env = { ...process.env, MONGODB_DB_NAME: db.databaseName, NEXT_TELEMETRY_DISABLED: "1" };
  for (const key of ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "MONGODB_URI", "VERCEL", "INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY"]) delete env[key as keyof typeof env];
  if (uri) Object.assign(env, { MONGODB_URI: uri });
  app = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(address.port)], { env, windowsHide: true, stdio: "pipe" });
  app.stdout?.resume(); app.stderr?.resume();
  for (let i = 0; i < 120; i++) {
    if (app.exitCode !== null) throw new Error("Production test server exited");
    try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch { /* wait for startup */ }
    await delay(250);
  }
  throw new Error("Production test server failed to start");
}
async function board() {
  const response = await fetch(`${origin}/api/public-board`);
  return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.json() as PublicBoard };
}
beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ binary: { version: "8.0.17", downloadDir: resolve(".tools/mongodb") }, replSet: { count: 1 }, instanceOpts: [{ args: ["--setParameter", "enableTestCommands=1"] }] });
  client = await new MongoClient(repl.getUri()).connect(); db = client.db(`pulsegrid_test_cache_${Date.now()}`);
  await db.collection("banks").insertOne({ _id: "test-bank", tenantId: "test-tenant", stateId: "maharashtra-pilot", district: "Pune" } as never);
  await db.collection("units").insertOne({ bankId: "test-bank", tenantId: "test-tenant", stateId: "maharashtra-pilot", group: "O-", component: "PRBC", product: "PRBC_SAGM", collectedAt: new Date(), status: "AVAILABLE", storage: "VERIFIED", expiresAt: new Date(Date.now() + 3_600_000), screening: Object.fromEntries(SCREENS.map(screen => [screen, "NON_REACTIVE"])) });
});
afterAll(async () => {
  await stopApp(); await client?.close(); await repl?.stop();
  await mkdir(resolve("../_ai_context/artifacts"), { recursive: true });
  await writeFile(resolve("../_ai_context/artifacts/stage-8-cache-runtime.json"), JSON.stringify(evidence, null, 2));
});
it("does not cache a cold failure, then warms, revalidates, retains last-good on failure and recovers", async () => {
  await startApp();
  const cold = await board(); expect(cold.status).toBe(503); expect(cold.headers["cache-control"]).toBe("no-store");
  expect(cold.body).toEqual({ error: "PUBLIC_BOARD_UNAVAILABLE" }); evidence.cold = cold;
  await stopApp(); await startApp(repl.getUri());
  const warm = await board(); expect(warm.status).toBe(200);
  const hit = await board(); expect(hit.body.generatedAt).toBe(warm.body.generatedAt);
  expect(hit.headers["x-vercel-cache"]).toBeUndefined(); evidence.warm = warm; evidence.repeat = hit;
  await db.collection("units").updateMany({}, { $set: { status: "ISSUED" } });
  expect((await board()).body).toEqual(warm.body);
  await delay(31_000);
  // Stale-while-revalidate returns last-good first, then the fresh aggregate.
  const stale = await board(); expect(stale.status).toBe(200);
  let fresh = stale;
  for (let i = 0; i < 30; i++) { fresh = await board(); if (fresh.body.generatedAt !== warm.body.generatedAt) break; await delay(100); }
  expect(fresh.body.generatedAt).not.toBe(warm.body.generatedAt);
  expect(fresh.body.cells.every(cell => cell.band === "NONE")).toBe(true);
  evidence.revalidated = fresh;
  await db.admin().command({ configureFailPoint: "failCommand", mode: "alwaysOn", data: { failCommands: ["aggregate"], errorCode: 2 } });
  await expect(db.collection("units").aggregate([{ $match: {} }]).toArray()).rejects.toThrow();
  await delay(31_000);
  const outage = await board(); expect(outage.status).toBe(200); expect(outage.body).toEqual(fresh.body);
  await delay(1000); expect((await board()).body).toEqual(fresh.body); evidence.lastGoodDuringDatabaseFailure = outage;
  await db.admin().command({ configureFailPoint: "failCommand", mode: "off" });
  await db.collection("units").updateMany({}, { $set: { status: "AVAILABLE" } });
  let recovered = await board();
  for (let i = 0; i < 40; i++) { recovered = await board(); if (recovered.body.generatedAt !== fresh.body.generatedAt) break; await delay(100); }
  expect(recovered.body.generatedAt).not.toBe(fresh.body.generatedAt);
  expect(recovered.body.cells.some(cell => cell.band === "LOW")).toBe(true); evidence.recovered = recovered;
});
