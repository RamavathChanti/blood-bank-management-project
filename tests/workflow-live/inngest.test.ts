import { baseline } from "../../src/server/audit";
import { afterAll, beforeAll, it, expect, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { MongoClient, type Db, type Document } from "mongodb";
import { serve } from "inngest/node";
import { inngest } from "../../src/inngest/client";
import { functions } from "../../src/inngest/functions";
import { requestCreated, signalTypes, type CreatedData } from "../../src/inngest/events";
import { ensureSchema } from "../../src/server/schema";
import { workflowDigest, type WorkflowRow } from "../../src/server/workflow-store";
import { emergencyInput, type SignalInput, type SignalKind } from "../../src/core/workflow-events";
import type { Principal } from "../../src/server/identity";
import { STATE_ID } from "../../src/server/registry-constants";
import { forecastDay, FORECAST_JOB_LIMITS } from "../../src/server/forecast-jobs";
import { emergencyHandler } from "../../src/server/emergency-api";
import { database } from "../../src/server/mongodb";
import { reconciliation, reconcileOutcome } from "../../src/core/resilience";

let repl: MongoMemoryReplSet, client: MongoClient, db: Db, server: Server, cli: ChildProcess;
let rejectedCallbacks = 0, failNextCallback = false, cliLog = "";
const evidence: Document[] = [];
const hospital: Principal = { userId: "live-hospital-user", role: "HOSPITAL", hospitalId: "hospital-live", tenantId: "tenant-hospital-live", stateId: STATE_ID };
const bank: Principal = { userId: "live-bank-user", role: "BANK", bankId: "bank-live", tenantId: "tenant-bank-live", stateId: STATE_ID };
const c = (name: string) => db.collection<WorkflowRow>(name);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(condition: () => Promise<T | null | false | undefined>, label: string, timeout = 35_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await condition(); if (value) return value; await delay(250); }
  throw new Error(`Timed out: ${label}. CLI: ${cliLog.slice(-3000)}`);
}
function creation(key: string): CreatedData {
  const acceptedAt = new Date().toISOString();
  const input = emergencyInput({ key, group: "O-", component: "PRBC", quantity: 1, urgency: "CRITICAL", expectedTransfusionAt: new Date(Date.now() + 3_600_000).toISOString() });
  const requestId = `emergency-${workflowDigest([STATE_ID, "tenant-hospital-live", "hospital-live", input]).slice(0, 48)}`;
  return { requestId, actor: hospital, input, acceptedAt, fingerprint: workflowDigest(input) };
}
async function sendSignal(requestId: string, kind: SignalKind, input: SignalInput, actor = hospital) {
  const signalId = `signal-${workflowDigest([requestId, actor, kind, input])}`;
  return inngest.send(signalTypes[kind].create({ requestId, kind, input, actor, receivedAt: new Date().toISOString(), signalId }, { id: signalId }));
}
async function available(id: string) {
  const now = Date.now();
  const sealed = baseline({ _id: id, id, stateId: STATE_ID, tenantId: "tenant-bank-live", bankId: "bank-live", donorId: "synthetic-donor", group: "O-", component: "PRBC", product: "PRBC_SAGM", collectedAt: new Date(now - 86_400_000), expiresAt: new Date(now + 86_400_000), status: "AVAILABLE", screening: { HIV: "NON_REACTIVE", HEPATITIS_B: "NON_REACTIVE", HEPATITIS_C: "NON_REACTIVE", SYPHILIS: "NON_REACTIVE", MALARIA: "NON_REACTIVE" }, storage: "VERIFIED" }, new Date(now));
  await c("units").insertOne(sealed.unit);
  await c("unitEvents").insertOne(sealed.event);
}
beforeAll(async () => {
  // This service test is isolated from the application and never loads .env.local.
  process.env.INNGEST_DEV = "1"; delete process.env.VERCEL;
  repl = await MongoMemoryReplSet.create({ binary: { version: "8.0.17", downloadDir: resolve(".tools/mongodb") }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGODB_URI = repl.getUri(); process.env.MONGODB_DB_NAME = "pulsegrid_test_inngest_live";
  client = await new MongoClient(repl.getUri()).connect(); db = client.db(process.env.MONGODB_DB_NAME); await ensureSchema(db);
  for (const [kind, id] of [["hospitals", "hospital-live"], ["banks", "bank-live"]]) await c(kind).insertOne({ _id: id, id, stateId: STATE_ID, tenantId: `tenant-${id}`, name: `Synthetic ${id}`, district: "Mumbai City", location: { type: "Point", coordinates: [72.8, 19] } });
  const callback = serve({ client: inngest, functions });
  server = createServer((req, res) => { if (failNextCallback && req.method === "POST") { failNextCallback = false; rejectedCallbacks++; res.writeHead(503); res.end("Synthetic callback outage"); return; } callback(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing port");
  const executable = process.platform === "win32" ? "inngest.exe" : "inngest";
  cli = spawn(resolve("node_modules/inngest-cli/bin", executable), ["dev", "--host", "127.0.0.1", "--port", "8288", "--no-discovery", "--retry-interval", "1", "-u", `http://127.0.0.1:${address.port}/api/inngest`], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  cli.stdout?.on("data", chunk => { cliLog = (cliLog + chunk.toString()).slice(-20_000); }); cli.stderr?.on("data", chunk => { cliLog = (cliLog + chunk.toString()).slice(-20_000); });
  await until(async () => { try { const response = await fetch("http://127.0.0.1:8288/dev"); return response.ok; } catch { return false; } }, "Dev Server startup");
  // Explicit sync avoids relying on a background discovery interval.
  await until(async () => { try { const response = await fetch(`http://127.0.0.1:${address.port}/api/inngest`, { method: "PUT" }); return response.ok; } catch { return false; } }, "SDK sync");
});
afterAll(async () => {
  await mkdir(resolve("../_ai_context/artifacts"), { recursive: true });
  await writeFile(resolve("../_ai_context/artifacts/stage-7-inngest-live.json"), JSON.stringify({ environment: "Local Inngest CLI 1.49.0; production SDK 4.26.1 functions over Node HTTP adapter; temporary MongoDB 8.0.17 replica set; injected synthetic principals; no Clerk/Atlas/Vercel", rejectedCallbacks, cases: evidence }, null, 2));
  cli?.kill(); server?.closeAllConnections(); await new Promise<void>(resolve => { if (!server?.listening) resolve(); else server.close(() => resolve()); });
  await client?.close(); await repl?.stop();
});
it("real service retries HTTP failure, deduplicates delivery, waits and completes stock through handover", async () => {
  await available("live-stock"); const data = creation("stock-success"), started = Date.now(); failNextCallback = true;
  const payload = requestCreated.create(data, { id: `${data.requestId}-created` });
  const ack = await inngest.send(payload); await inngest.send(payload);
  await until(async () => { const req = await c("requests").findOne({ _id: data.requestId }); return req?.workflow.status === "AWAITING_BANK_APPROVAL" && req; }, "bank approval wait");
  await delay(2000);
  const slot = await c("allocations").findOne({ requestId: data.requestId }); expect(slot).toBeTruthy();
  await sendSignal(data.requestId, "dispatch.approved", { key: "approve", unitId: slot!.unitId, allocationId: slot!.id, preparationConfirmed: true }, bank);
  await until(async () => (await c("units").findOne({ _id: "live-stock" }))?.status === "ISSUED", "dispatch");
  await delay(2000);
  await sendSignal(data.requestId, "handover", { key: "handover", unitId: slot!.unitId, allocationId: slot!.id });
  await until(async () => (await c("units").findOne({ _id: "live-stock" }))?.handoverAt, "handover");
  await delay(2000);
  await sendSignal(data.requestId, "synthetic-use", { key: "use", unitId: slot!.unitId, allocationId: slot!.id });
  const req = await until(async () => { const row = await c("requests").findOne({ _id: data.requestId }); return row?.workflow.status === "COMPLETED" && row; }, "closure");
  expect(rejectedCallbacks).toBe(1); expect(await c("allocations").countDocuments({ requestId: data.requestId })).toBe(1); expect(await c("unitEvents").countDocuments({ requestId: data.requestId, action: "ISSUE" })).toBe(1);
  evidence.push({ case: "stock/retry/duplicate/handover", requestId: data.requestId, acknowledgedEventIds: ack.ids, runId: req.workflow.runId, status: req.workflow.status, trace: req.workflow.trace, elapsedMs: Date.now() - started });
});
it("real service cancellation wakes a sleeping request and releases its reservation", async () => {
  await available("live-cancel"); const data = creation("cancellation"), ack = await inngest.send(requestCreated.create(data, { id: `${data.requestId}-created` }));
  await until(async () => (await c("requests").findOne({ _id: data.requestId }))?.workflow.status === "AWAITING_BANK_APPROVAL", "cancellation wait");
  await delay(2000); await sendSignal(data.requestId, "cancel", { key: "cancel" });
  const req = await until(async () => { const row = await c("requests").findOne({ _id: data.requestId }); return row?.workflow.status === "CANCELLED" && row; }, "cancellation");
  expect((await c("units").findOne({ _id: "live-cancel" }))?.status).toBe("AVAILABLE");
  evidence.push({ case: "cancellation", requestId: data.requestId, acknowledgedEventIds: ack.ids, runId: req.workflow.runId, status: req.workflow.status });
});
it("real donor reply wakes screening recovery, then independently ready stock completes", async () => {
  await c("units").deleteMany({ status: "AVAILABLE" });
  const donor: Principal = { userId: "live-donor-user", role: "DONOR", donorId: "donor-live", tenantId: "tenant-donor-live", stateId: STATE_ID };
  await c("donors").insertOne({ _id: "donor-live", id: "donor-live", stateId: STATE_ID, tenantId: "tenant-donor-live", nickname: "Synthetic live donor", group: "O-", location: { type: "Point", coordinates: [72.8, 19] }, eligibleFrom: new Date(0), audience: false, birthDate: "2000-01-01", weightKg: 65, haemoglobin: 14, donationVolumeMl: 450, deferrals: [] });
  const data = creation("donor-success"), ack = await inngest.send(requestCreated.create(data, { id: `${data.requestId}-created` }));
  await until(async () => (await c("requests").findOne({ _id: data.requestId }))?.workflow.status === "AWAITING_DONORS", "donor wave");
  await delay(2000); await sendSignal(data.requestId, "donor.reply", { key: "accept", donorId: "donor-live", reply: "ACCEPTED" }, donor);
  await until(async () => (await c("requests").findOne({ _id: data.requestId }))?.workflow.status === "AWAITING_SCREENED_STOCK", "screening wait");
  expect(await c("allocations").countDocuments({ requestId: data.requestId })).toBe(0);
  // A separately completed synthetic collection/screening fixture, not acceptance-to-stock conversion.
  await available("live-screened"); await delay(2000); await sendSignal(data.requestId, "stock.ready", { key: "ready", unitId: "live-screened" }, bank);
  await until(async () => (await c("requests").findOne({ _id: data.requestId }))?.workflow.status === "AWAITING_BANK_APPROVAL", "recovered stock");
  const slot = await c("allocations").findOne({ requestId: data.requestId });
  await delay(2000); await sendSignal(data.requestId, "dispatch.approved", { key: "approve", unitId: slot!.unitId, allocationId: slot!.id, preparationConfirmed: true }, bank);
  await until(async () => (await c("units").findOne({ _id: "live-screened" }))?.status === "ISSUED", "recovered dispatch");
  await delay(2000); await sendSignal(data.requestId, "handover", { key: "handover", unitId: slot!.unitId, allocationId: slot!.id });
  await until(async () => (await c("units").findOne({ _id: "live-screened" }))?.handoverAt, "recovered handover");
  await delay(2000); await sendSignal(data.requestId, "synthetic-use", { key: "use", unitId: slot!.unitId, allocationId: slot!.id });
  const req = await until(async () => { const row = await c("requests").findOne({ _id: data.requestId }); return row?.workflow.status === "COMPLETED" && row; }, "donor closure");
  expect(await c("alerts").countDocuments({ requestId: data.requestId })).toBe(1);
  evidence.push({ case: "donor/screened-stock-recovery", requestId: data.requestId, acknowledgedEventIds: ack.ids, runId: req.workflow.runId, status: req.workflow.status, trace: req.workflow.trace });
});
it("real durable wait times out into escalation without holding an HTTP request open", async () => {
  const base = creation("deadline"), input = { ...base.input, expectedTransfusionAt: new Date(Date.now() + 6000).toISOString() };
  const data: CreatedData = { ...base, input, fingerprint: workflowDigest(input), requestId: `emergency-${workflowDigest([STATE_ID, "tenant-hospital-live", "hospital-live", input]).slice(0, 48)}` };
  const ack = await inngest.send(requestCreated.create(data, { id: `${data.requestId}-created` }));
  const req = await until(async () => { const row = await c("requests").findOne({ _id: data.requestId }); return row?.workflow.status === "ESCALATED" && row; }, "durable timeout");
  expect(req.transfusedQuantity).toBe(0); expect(req.workflow.reason).toBe("DEADLINE_UNMET");
  evidence.push({ case: "durable-timeout", requestId: data.requestId, acknowledgedEventIds: ack.ids, runId: req.workflow.runId, status: req.workflow.status, reason: req.workflow.reason });
});
it("retains ten durable acknowledgements during database outage and reconciles all IDs without duplicate effects", async () => {
  const fetcher = globalThis.fetch;
  let down = true;
  const started = Date.now(), receipts: { requestId: string; receipt: string; eventIds: string[] }[] = [];
  // Keep the cohort deadline independent of machine speed; the separate six-second
  // test proves durable timeout. Explicit signals give this cohort exact outcomes.
  const inputs = Array.from({ length: 10 }, (_, i) => ({ ...creation(`resilience-${i}`).input, expectedTransfusionAt: new Date(started + 300_000).toISOString() }));
  vi.stubEnv("DEMO_CONTROLS_ENABLED", "1"); vi.stubEnv("GLOBAL_CONFIG", "https://global-config.vercel.com/ecfg_localtest?token=synthetic");
  vi.stubGlobal("fetch", (url: Parameters<typeof fetch>[0], init?: RequestInit) => String(url).startsWith("https://global-config.vercel.com/") ? Promise.resolve(Response.json({ dbDown: down, dbSlowMs: 0, realtimeDown: false, expiresAt: new Date(Date.now() + 60_000).toISOString() })) : fetcher(url, init));
  const handler = emergencyHandler({ identity: async () => hospital, database, configured: () => {}, send: payload => inngest.send(payload), secret: () => "synthetic-stable-test-receipt-secret-32", now: () => new Date(), log: () => {} });
  const submit = (input: typeof inputs[number]) => handler(new Request("http://app.test/api/emergencies", { method: "POST", headers: { origin: "http://app.test", "Content-Type": "application/json" }, body: JSON.stringify(input) }));
  try {
    await c("units").deleteMany({ status: "AVAILABLE" }); await c("donors").deleteMany({});
    for (const input of inputs) {
      const response = await submit(input); expect(response.status).toBe(202); const ack = await response.json();
      expect(ack.accepted).toBe(true); receipts.push(ack);
    }
    expect(new Set(receipts.map(r => r.requestId)).size).toBe(10);
    for (const ack of receipts) {
      const response = await handler(new Request(`http://app.test/api/emergencies/${ack.requestId}`, { headers: { "x-emergency-receipt": ack.receipt } }), [ack.requestId]);
      expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ accepted: true, status: "ACKNOWLEDGED_STATUS_UNAVAILABLE", requestId: ack.requestId });
    }
    expect(await c("requests").countDocuments({ _id: { $in: receipts.map(r => r.requestId) } })).toBe(0);
    await delay(2000); down = false; const restoredAt = Date.now();
    await until(async () => await c("requests").countDocuments({ _id: { $in: receipts.map(r => r.requestId) } }) === 10, "all ten persisted after fault restoration", 45_000);
    for (let i = 0; i < inputs.length; i++) { const response = await submit(inputs[i]); expect((await response.json()).requestId).toBe(receipts[i].requestId); }
    for (const ack of receipts.slice(0, 3)) await sendSignal(ack.requestId, "cancel", { key: "resilience-cancel" });
    for (const ack of receipts.slice(3)) await sendSignal(ack.requestId, "escalate", { key: "resilience-escalate" });
    const rows = await until(async () => {
      const found = await c("requests").find({ _id: { $in: receipts.map(r => r.requestId) } }).toArray();
      return found.length === 10 && found.every(r => ["CANCELLED", "ESCALATED"].includes(r.workflow.status)) && found;
    }, "all ten terminal outcomes", 55_000);
    const report = reconciliation(rows.map(r => reconcileOutcome(r.id, { workflow: r.workflow })));
    expect(report).toMatchObject({ acknowledged: 10, pending: 0, accepted: 0, fulfilled: 0, cancelled: 3, escalated: 7, failed: 0 });
    const ids = receipts.map(r => r.requestId);
    expect(await c("allocations").countDocuments({ requestId: { $in: ids } })).toBe(0);
    expect(await c("alerts").countDocuments({ requestId: { $in: ids } })).toBe(0);
    expect(await c("unitEvents").countDocuments({ requestId: { $in: ids } })).toBe(0);
    await writeFile(resolve("../_ai_context/artifacts/stage-12-ten-acknowledgements.json"), JSON.stringify({ environment: "actual local Inngest service; temporary MongoDB; mocked Edge Config transport; synthetic principals", acknowledgements: receipts.map(({ requestId, eventIds }) => ({ requestId, eventIds })), report, observedRecoveryToAllTerminalMs: Date.now() - restoredAt, outageMs: restoredAt - started, duplicateIntakes: 10, allocations: 0, donorAlerts: 0, lifecycleSideEffects: 0 }, null, 2));
  } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
});
it("real forecast function persists one daily proposal across distinct manual event deliveries", async () => {
  const started = Date.now(), timestamp = new Date().toISOString(), day = forecastDay(timestamp).day;
  const first = await inngest.send({ name: "pulsegrid/forecast.requested", data: {}, id: `forecast-first-${started}` });
  const receipt = await until(async () => c("operations").findOne({ tenantId: "state-forecast-scheduler", "result.day": day }), "scheduled forecast proposal");
  const second = await inngest.send({ name: "pulsegrid/forecast.requested", data: { day: "untrusted-ignored" }, id: `forecast-second-${started}` });
  await delay(3000);
  expect(await c("operations").countDocuments({ tenantId: "state-forecast-scheduler", "result.day": day })).toBe(1);
  expect(receipt.result.kind).toBe("REGISTRY_FORECAST_PROPOSAL"); expect(receipt.result.measured.resultBytes).toBeLessThan(FORECAST_JOB_LIMITS.resultBytes);
  const report = { environment: "Actual local Inngest 1.49.0 and production SDK 4.26.1; temporary MongoDB replica set; manual trigger of the daily function, not a hosted cron", firstEventIds: first.ids, secondEventIds: second.ids, day, dailyReceipts: 1, measured: receipt.result.measured, functionSteps: 1, noRetryExecutionsPerRun: 2, scheduledNoRetryExecutionsPer31Days: 62, cloudDashboardMeasured: false };
  await writeFile(resolve("../_ai_context/artifacts/stage-10-inngest-local.json"), JSON.stringify(report, null, 2));
});

it("real audit verifier and daily anchor functions persist clean commitments and raise a tamper alarm", async () => {
  // A prior workflow scenario deliberately deleted AVAILABLE fixtures. Reset only
  // this temporary test service's inventory/history before the audit rehearsal.
  await c("units").deleteMany({}); await c("unitEvents").deleteMany({});
  await available("live-audit");
  const started = Date.now();
  const cleanAck = await inngest.send({ name: "pulsegrid/audit.verify", data: {}, id: `audit-clean-${started}` });
  const clean = await until(async () => c("operations").findOne({ tenantId: "state-audit", "result.ok": true }), "clean audit report");
  expect(clean.result.checked).toBe(1);
  const anchorAck = await inngest.send({ name: "pulsegrid/audit.anchor", data: {}, id: `audit-anchor-${started}` });
  const anchor = await until(async () => c("anchors").findOne({ "external.status": "DISABLED" }), "daily Merkle anchor");
  expect(anchor.count).toBe(1); expect(anchor.merkleRoot).toMatch(/^[a-f0-9]{64}$/);
  await c("units").updateOne({ id: "live-audit" }, { $set: { expiresAt: new Date(Date.now() + 172800000) } });
  const tamperAck = await inngest.send({ name: "pulsegrid/audit.verify", data: {}, id: `audit-tamper-${started}` });
  const alarm = await until(async () => c("operations").findOne({ tenantId: "state-audit-alert" }), "integrity alarm");
  expect(alarm.result.failed[0]).toMatchObject({ unitId: "live-audit", chain: "VALID", signature: "MISMATCH", state: "MISMATCH" });
  await writeFile(resolve("../_ai_context/artifacts/stage-11-inngest-local.json"), JSON.stringify({ environment: "actual local Inngest CLI 1.49.0 and production SDK 4.26.1; temporary MongoDB replica set; manual events, not hosted cron", cleanEventIds: cleanAck.ids, anchorEventIds: anchorAck.ids, tamperEventIds: tamperAck.ids, clean: clean.result, anchor: { day: anchor.day, merkleRoot: anchor.merkleRoot, count: anchor.count, external: anchor.external }, alarm: alarm.result, sentEmail: false, publishedGithubCommit: false }, null, 2));
});
