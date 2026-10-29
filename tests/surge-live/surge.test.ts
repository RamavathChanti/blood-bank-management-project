import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { MongoClient, type Db, type Document } from "mongodb";
import { eventType, staticSchema } from "inngest";
import { serve } from "inngest/node";
import { inngest } from "../../src/inngest/client";
import { functions, workflowConcurrency } from "../../src/inngest/functions";
import { signalTypes } from "../../src/inngest/events";
import { emergencyHandler } from "../../src/server/emergency-api";
import { database, mongoClient } from "../../src/server/mongodb";
import { ensureSchema } from "../../src/server/schema";
import { baseline } from "../../src/server/audit";
import { workflowDigest, type WorkflowRow } from "../../src/server/workflow-store";
import { STATE_ID } from "../../src/server/registry-constants";
import type { Principal } from "../../src/server/identity";
import { ATLAS_WORKFLOW_CONCURRENCY, CRITICAL_PRIORITY, percentile95, SURGE_LIMITS } from "../../src/core/surge";
import { reconciliation, reconcileOutcome } from "../../src/core/resilience";

let repl: MongoMemoryReplSet, client: MongoClient, db: Db, server: Server, cli: ChildProcess;
let cliLog = "", callbacks = 0, active = 0, peak = 0, commands = 0;
let hold = true;
const starts: { id: string; at: number; urgency: string }[] = [], finishes: { id: string; at: number }[] = [];
const reports: Document[] = [];
let sharedGuard: Document | null = null;
const artifact = resolve("../_ai_context/artifacts/stage-13-surge-local.json");
const hospital: Principal = { userId: "surge-hospital-user", role: "HOSPITAL", hospitalId: "hospital-surge", tenantId: "tenant-hospital-surge", stateId: STATE_ID };
const c = (name: string) => db.collection<WorkflowRow>(name);
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(read: () => Promise<T | null | false | undefined>, label: string, timeout = 50_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(100); }
  throw new Error(`Timed out: ${label}; ${cliLog.slice(-2000)}`);
}
type Probe = { id: string; input: { urgency: "URGENT" | "CRITICAL" } };
const probeEvents = ["serial", "bounded", "priority"].map(name => eventType(`pulsegrid/surge.${name}`, { schema: staticSchema<Probe>() }));
// Test-only adapter: real provider queue, same priority expression, a measured DB
// command and labelled injected service time. Never registered in production.
const probes = probeEvents.map((event, index) => inngest.createFunction({ id: `surge-probe-${index}`, triggers: [event], retries: 0, concurrency: index === 0 ? 1 : [ATLAS_WORKFLOW_CONCURRENCY], priority: { run: index === 2 ? CRITICAL_PRIORITY : "0" } }, async ({ event, step }) => step.run("bounded-database-work", async () => {
  const data = event.data;
  starts.push({ id: data.id, at: Date.now(), urgency: data.input.urgency }); active++; peak = Math.max(peak, active);
  try {
    await until(async () => !hold, "release initial slots", 15_000);
    await db.command({ ping: 1 });
    await delay(SURGE_LIMITS.serviceMs);
    finishes.push({ id: data.id, at: Date.now() });
    return { id: data.id };
  } finally { active--; }
})));

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ binary: { version: "8.0.17", downloadDir: resolve(".tools/mongodb") }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGODB_URI = repl.getUri(); process.env.MONGODB_DB_NAME = "pulsegrid_test_surge";
  client = await new MongoClient(repl.getUri(), { monitorCommands: true }).connect(); db = client.db(process.env.MONGODB_DB_NAME);
  client.on("commandStarted", e => { if (e.commandName === "ping") commands++; });
  await ensureSchema(db);
  for (const [kind, id] of [["hospitals", "hospital-surge"], ["banks", "bank-surge"]]) await c(kind).insertOne({ _id: id, id, stateId: STATE_ID, tenantId: `tenant-${id}`, name: `Synthetic ${id}`, district: "Mumbai City", location: { type: "Point", coordinates: [72.8, 19] } });
  const callback = serve({ client: inngest, functions: [...functions, ...probes] });
  server = createServer((req, res) => { if (req.method === "POST") callbacks++; callback(req, res); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("port");
  cli = spawn(resolve("node_modules/inngest-cli/bin", process.platform === "win32" ? "inngest.exe" : "inngest"), ["dev", "--host", "127.0.0.1", "--port", "8290", "--no-discovery", "--retry-interval", "1", "-u", `http://127.0.0.1:${address.port}/api/inngest`], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  for (const pipe of [cli.stdout, cli.stderr]) pipe?.on("data", b => { cliLog = (cliLog + b.toString()).slice(-10000); });
  await until(async () => { try { return (await fetch("http://127.0.0.1:8290/dev")).ok; } catch { return false; } }, "service startup");
  await until(async () => (await fetch(`http://127.0.0.1:${address.port}/api/inngest`, { method: "PUT" })).ok, "sync");
});
afterAll(async () => {
  hold = false; cli?.kill(); server?.closeAllConnections();
  if (server?.listening) await new Promise<void>(r => server.close(() => r()));
  if (process.env.MONGODB_URI) await (await mongoClient()).close();
  await client?.close(); await repl?.stop();
});

it("compares actual local queue capacity and critical priority with bounded measured work", async () => {
  for (let mode = 0; mode < 3; mode++) {
    starts.length = 0; finishes.length = 0; active = 0; peak = 0; hold = true; commands = 0;
    const before = callbacks, sentAt = new Map<string, number>(), acknowledged: { id: string; eventIds: string[] }[] = [];
    const send = async (index: number, critical = false) => {
      const id = `probe-${mode}-${index}`; sentAt.set(id, Date.now());
      const ack = await inngest.send(probeEvents[mode].create({ id, input: { urgency: critical ? "CRITICAL" : "URGENT" } }, { id }));
      expect(ack.ids.length).toBeGreaterThan(0); acknowledged.push({ id, eventIds: ack.ids });
    };
    const slots = mode === 0 ? 1 : 2;
    for (let i = 0; i < slots; i++) await send(i);
    await until(async () => starts.length === slots, "initial slots occupied");
    for (let i = slots; i < 6; i++) await send(i);
    // Separate enqueue times beyond the scheduler's coarse time buckets.
    await delay(1500);
    for (let i = 6; i < 8; i++) await send(i, true);
    // Let real event ingestion enqueue the backlog before releasing active work.
    await delay(1500); const releasedAt = Date.now(); hold = false;
    await until(async () => finishes.length === 8, "probe completion");
    expect(peak).toBe(slots); expect(commands).toBe(8);
    const backlogOrder = starts.slice(slots).map(r => r.urgency);
    if (mode === 2) expect(backlogOrder.slice(0, 2)).toEqual(["CRITICAL", "CRITICAL"]);
    reports.push({ mode: ["Serial, no priority", "Two slots, no priority", "Two slots, critical priority"][mode], slots, acknowledged: acknowledged.length, callbackInvocations: callbacks - before, databaseCommands: commands, peakActive: peak, pendingBeforeRelease: 8 - slots, queueDepth: null, queueDepthBasis: "Provider queue depth unavailable; pendingBeforeRelease is acknowledged minus observed started, before any completions", elapsedMs: Date.now() - releasedAt, throughputPerSecond: 8 / ((Date.now() - releasedAt) / 1000), p95EndToEndMs: percentile95(finishes.map(f => f.at - sentAt.get(f.id)!)), p95CriticalMs: percentile95(finishes.filter(f => ["probe-" + mode + "-6", "probe-" + mode + "-7"].includes(f.id)).map(f => f.at - sentAt.get(f.id)!)), injectedServiceMs: SURGE_LIMITS.serviceMs, acknowledgedIds: acknowledged, starts: [...starts], finishes: [...finishes] });
  }
});

it("shares two executing slots across different functions using the production environment key", async () => {
  starts.length = 0; finishes.length = 0; peak = 0; active = 0; hold = true;
  const acks = [];
  for (let i = 0; i < 8; i++) acks.push(await inngest.send(probeEvents[1 + i % 2].create({ id: `shared-${i}`, input: { urgency: "URGENT" } }, { id: `shared-${i}` })));
  await until(async () => starts.length === 2, "two shared slots occupied");
  await delay(1000); expect(starts).toHaveLength(2); hold = false;
  await until(async () => finishes.length === 8, "shared-key drain");
  expect(peak).toBe(2); expect(acks.every(a => a.ids.length > 0)).toBe(true);
  sharedGuard = { acknowledged: 8, peakExecuting: peak, functions: 2, scope: "env", key: "pulsegrid-atlas", starts: [...starts], finishes: [...finishes] };
});

it("reconciles a production emergency burst, duplicate delivery, unique stock and counters", async () => {
  expect(workflowConcurrency[0]).toMatchObject({ limit: 2, scope: "env" });
  for (let i = 0; i < 4; i++) {
    const id = `surge-unit-${i}`, now = Date.now();
    const sealed = baseline({ _id: id, id, stateId: STATE_ID, tenantId: "tenant-bank-surge", bankId: "bank-surge", donorId: "synthetic-donor", group: "O-", component: "PRBC", product: "PRBC_SAGM", collectedAt: new Date(now - 86400000), expiresAt: new Date(now + 86400000), status: "AVAILABLE", screening: { HIV: "NON_REACTIVE", HEPATITIS_B: "NON_REACTIVE", HEPATITIS_C: "NON_REACTIVE", SYPHILIS: "NON_REACTIVE", MALARIA: "NON_REACTIVE" }, storage: "VERIFIED" }, new Date(now));
    await c("units").insertOne(sealed.unit); await c("unitEvents").insertOne(sealed.event);
  }
  await c("stock").insertOne({ _id: "surge-stock", id: "surge-stock", stateId: STATE_ID, tenantId: "tenant-bank-surge", bankId: "bank-surge", group: "O-", component: "PRBC", available: 4 });
  const inputs = Array.from({ length: 12 }, (_, i) => ({ key: `surge-${i}`, group: "O-", component: "PRBC", quantity: 1, urgency: i >= 10 ? "CRITICAL" : "URGENT", expectedTransfusionAt: new Date(Date.now() + 300000).toISOString() }));
  const handler = emergencyHandler({ identity: async () => hospital, database, configured: () => {}, send: p => inngest.send(p), secret: () => "synthetic-surge-test-receipt-secret-32", now: () => new Date(), log: () => {} });
  const submit = (input: unknown) => handler(new Request("http://app.test/api/emergencies", { method: "POST", headers: { origin: "http://app.test", "Content-Type": "application/json" }, body: JSON.stringify(input) }));
  const before = callbacks, started = Date.now();
  const receipts = await Promise.all(inputs.map(async input => { const res = await submit(input); expect(res.status).toBe(202); const ack = await res.json(); return { requestId: ack.requestId as string, eventIds: ack.eventIds as string[] }; }));
  expect(new Set(receipts.map(r => r.requestId)).size).toBe(12);
  const ids = receipts.map(r => r.requestId);
  await until(async () => {
    const rows = await c("requests").find({ _id: { $in: ids } }).toArray();
    return rows.length === 12 && rows.every(r => ["AWAITING_BANK_APPROVAL", "AWAITING_DONORS"].includes(r.workflow.status));
  }, "all burst workflows settled into waits");
  const slots = await c("allocations").find({ status: "ACTIVE" }).toArray(); expect(slots).toHaveLength(4);
  expect(new Set(slots.map(s => s.unitId)).size).toBe(4);
  expect((await c("stock").findOne({ _id: "surge-stock" }))?.available).toBe(0);
  expect(await c("units").countDocuments({ status: "AVAILABLE" })).toBe(0);
  // Retry identical intake: same identity, no additional reservation side effects.
  for (let i = 0; i < inputs.length; i++) expect((await (await submit(inputs[i])).json()).requestId).toBe(ids[i]);
  for (let i = 0; i < ids.length; i++) {
    const kind = i < 4 ? "cancel" : "escalate", input = { key: `surge-stop-${i}` }, receivedAt = new Date().toISOString();
    const signalId = `signal-${workflowDigest([ids[i], hospital, kind, input])}`;
    await inngest.send(signalTypes[kind].create({ requestId: ids[i], kind, input, actor: hospital, receivedAt, signalId }, { id: signalId }));
  }
  const rows = await until(async () => { const rows = await c("requests").find({ _id: { $in: ids } }).toArray(); return rows.every(r => ["CANCELLED", "ESCALATED"].includes(r.workflow.status)) && rows; }, "terminal outcomes");
  const reconciled = reconciliation(ids.map(id => { const row = rows.find(r => r._id === id); return reconcileOutcome(id, row ? { workflow: { status: row.workflow.status, acceptedAt: row.workflow.acceptedAt, trace: row.workflow.trace } } : undefined); }));
  expect(reconciled).toMatchObject({ acknowledged: 12, cancelled: 4, escalated: 8, pending: 0, accepted: 0, failed: 0, loss: 0 });
  expect(await c("allocations").countDocuments({ status: "ACTIVE" })).toBe(0);
  expect(await c("units").countDocuments({ status: "AVAILABLE" })).toBe(4);
  expect((await c("stock").findOne({ _id: "surge-stock" }))?.available).toBe(4);
  expect(rows.every(r => r.allocatedQuantity === 0 && r.transfusedQuantity === 0)).toBe(true);
  const duplicates = await c("allocations").aggregate([{ $group: { _id: "$unitId", count: { $sum: 1 } } }, { $match: { count: { $gt: 1 } } }]).toArray(); expect(duplicates).toEqual([]);
  expect(reports).toHaveLength(3);
  expect(sharedGuard).not.toBeNull();
  const report = { measuredAt: new Date().toISOString(), environment: "Local Inngest CLI 1.49.0 / SDK 4.26.1; temporary MongoDB 8.0.17 replica set; synthetic principals; no Atlas, Clerk or Vercel", comparisons: reports, sharedGuard, production: { ...reconciled, acknowledgedIds: receipts, callbackInvocations: callbacks - before, elapsedMs: Date.now() - started, uniqueAllocatedUnits: 4, availableAfterDrain: 4, activeAllocationsAfterDrain: 0, countersMatch: true, duplicateAllocations: duplicates.length, databaseOperations: null, queueDepth: null }, limits: { maxRequests: SURGE_LIMITS.maxRequests, workflowSlots: 2 }, hosted: { functionInstances: null, billingDelta: null, atlasOpsPerSecond: null } };
  await mkdir(resolve("../_ai_context/artifacts"), { recursive: true });
  await writeFile(artifact, JSON.stringify(report, null, 2));
  // Public report contains synthetic IDs/timings only, never signed receipts.
  await mkdir(resolve("src/data"), { recursive: true }); await writeFile(resolve("src/data/surge-evidence.json"), JSON.stringify(report, null, 2));
});
