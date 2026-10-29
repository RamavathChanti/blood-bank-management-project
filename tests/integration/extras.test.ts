import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { MongoClient, type Db, type Document } from "mongodb";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { baseline, verifyUnit, auditSnapshot } from "../../src/server/audit";
import { ensureSchema } from "../../src/server/schema";
import { STATE_ID } from "../../src/server/registry-constants";
import { Operations } from "../../src/server/operations";
import { registryHandler } from "../../src/server/registry-api";
import { intelligenceHandler, structuredOutput } from "../../src/server/intelligence";
import type { Principal } from "../../src/server/identity";
import { dictionaryIntake } from "../../src/core/intelligence";
import { CLEAR_SCREENING } from "../../src/core/fixtures";
import { bloodWeather } from "../../src/core/forecast";
type Row = Document & { _id: string };
let repl: MongoMemoryReplSet, client: MongoClient, db: Db;
const at = new Date("2026-10-29T09:00:00.000Z"), c = (name: string) => db.collection<Row>(name);
const bank: Principal = { userId: "test-bank", role: "BANK", bankId: "bank-1", tenantId: "tenant-bank-1", stateId: STATE_ID }, hospital: Principal = { userId: "test-hospital", role: "HOSPITAL", hospitalId: "hospital-1", tenantId: "tenant-hospital-1", stateId: STATE_ID }, admin: Principal = { userId: "test-admin", role: "STATE_ADMIN", stateId: STATE_ID };
async function unit(id: string, bankId = "bank-1") {
  const sealed = baseline({ _id: id, id, stateId: STATE_ID, tenantId: `tenant-${bankId}`, bankId, donorId: "synthetic-donor", group: "O-", component: "PRBC", product: "PRBC_SAGM", collectedAt: new Date(at.getTime() - 86400000), expiresAt: new Date(at.getTime() + 86400000), status: "AVAILABLE", storage: "VERIFIED", screening: CLEAR_SCREENING }, at);
  await c("units").insertOne(sealed.unit); await c("unitEvents").insertOne(sealed.event);
}
const apply = (key = "sample", fault = true) => new Operations(db, bank, at).post(["banks", "bank-1", "cold-chain"], { key, component: "PRBC", fault });
async function request() { return (await new Operations(db, hospital, at).post(["hospitals", "hospital-1", "requests"], { key: "request", group: "O-", component: "PRBC", quantity: 1, urgency: "ROUTINE", expectedTransfusionAt: new Date(at.getTime() + 3600000).toISOString() })).requestId as string; }
beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ binary: { version: "8.0.17", downloadDir: resolve(".tools/mongodb") }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  client = await new MongoClient(repl.getUri()).connect(); db = client.db("pulsegrid_test_extras"); await ensureSchema(db);
  for (const id of ["bank-1", "hospital-1"]) await c(id.startsWith("bank") ? "banks" : "hospitals").insertOne({ _id: id, id, stateId: STATE_ID, tenantId: `tenant-${id}`, name: `Synthetic ${id}`, district: "Thane", location: { type: "Point", coordinates: [73, 19] } });
});
beforeEach(async () => { vi.stubEnv("COLD_CHAIN_DEMO_ENABLED", "1"); for (const name of ["units", "unitEvents", "stock", "requests", "allocations", "operations"]) await c(name).deleteMany({}); await unit("cold-1"); });
afterAll(async () => { vi.unstubAllEnvs(); await client?.close(); await repl?.stop(); });
it("quarantine commits one signed event under concurrent same-key replay and preserves tenant isolation", async () => {
  await unit("other-bank", "bank-2"); const replies = await Promise.all([apply(), apply(), apply()]); expect(replies[1]).toEqual(replies[0]);
  expect(await c("unitEvents").countDocuments({ action: "QUARANTINE" })).toBe(1); expect(await c("operations").countDocuments()).toBe(1);
  expect((await c("units").findOne({ _id: "other-bank" }))!.status).toBe("AVAILABLE");
  const verified = await auditSnapshot(db, async session => verifyUnit(db, (await c("units").findOne({ _id: "cold-1" }, { session }))!, session));
  expect(verified.verification.ok).toBe(true); expect(verified.unit.status).toBe("QUARANTINED"); expect((await c("stock").findOne({ bankId: "bank-1" }))!.available).toBe(0);
  await apply("healthy", false); expect((await c("units").findOne({ _id: "cold-1" }))!.status).toBe("QUARANTINED");
  await writeFile(resolve("../_ai_context/artifacts/stage-14-watchdog.json"), JSON.stringify({ environment: "temporary local MongoDB 8.0.17 replica set; synthetic principals", sample: replies[0], audit: verified.verification, events: verified.events.map(e => ({ action: e.action, seq: e.seq, hash: e.hash })), stockAvailable: 0, otherTenantStatus: "AVAILABLE", concurrentReplays: 3 }, null, 2));
});
it("quarantine and reserve races cannot leave usable stock or orphan ownership", async () => {
  const id = await request();
  await Promise.all([new Operations(db, hospital, at).post(["hospitals", "hospital-1", "requests", id, "reserve"], { key: "reserve" }), apply()]);
  expect((await c("units").findOne({ _id: "cold-1" }))!.status).toBe("QUARANTINED");
  expect(await c("allocations").countDocuments({ status: "ACTIVE" })).toBe(0); expect((await c("requests").findOne({ _id: id }))!.allocatedQuantity).toBe(0);
});
it("issued stock quarantine releases the allocation and counters through the same audited path", async () => {
  const id = await request(); await new Operations(db, hospital, at).post(["hospitals", "hospital-1", "requests", id, "reserve"], { key: "reserve" });
  await new Operations(db, bank, at).post(["banks", "bank-1", "units", "cold-1", "action"], { key: "issue", type: "ISSUE", preparationConfirmed: false });
  await apply(); expect((await c("allocations").findOne({ unitId: "cold-1" }))!.status).toBe("RELEASED"); expect((await c("requests").findOne({ _id: id }))!.allocatedQuantity).toBe(0);
});
it("bad audit append rolls back the whole watchdog batch and receipt", async () => {
  await unit("cold-2"); await c("unitEvents").createIndex({ action: 1 }, { unique: true, partialFilterExpression: { action: "QUARANTINE" }, name: "test-quarantine-rollback" });
  try { await expect(apply()).rejects.toMatchObject({ code: 11000 }); expect(await c("units").countDocuments({ status: "AVAILABLE" })).toBe(2); expect(await c("operations").countDocuments()).toBe(0); } finally { await c("unitEvents").dropIndex("test-quarantine-rollback"); }
});
it("staff can discard reviewed quarantine with its audit chain intact", async () => {
  await apply();
  await new Operations(db, bank, at).post(["banks", "bank-1", "units", "cold-1", "action"], { key: "review-discard", type: "DISCARD", note: "Reviewed synthetic excursion; discard" });
  expect((await c("units").findOne({ _id: "cold-1" }))!.status).toBe("DISCARDED");
  expect((await auditSnapshot(db, async session => verifyUnit(db, (await c("units").findOne({ _id: "cold-1" }, { session }))!, session))).verification.ok).toBe(true);
});
it("disabled watchdog, tenant spoofing, cross-origin calls and oversized batches fail closed", async () => {
  vi.stubEnv("COLD_CHAIN_DEMO_ENABLED", "0"); await expect(apply()).rejects.toMatchObject({ code: "COLD_CHAIN_DEMO_DISABLED" }); vi.stubEnv("COLD_CHAIN_DEMO_ENABLED", "1");
  await expect(new Operations(db, hospital, at).post(["banks", "bank-1", "cold-chain"], { key: "x", component: "PRBC", fault: true })).rejects.toMatchObject({ status: 403 });
  const handler = registryHandler({ identity: async () => bank, database: async () => db, now: () => at, log: () => {} });
  expect((await handler(new Request("https://test.local/api/registry/banks/bank-1/cold-chain", { method: "POST", headers: { origin: "https://evil.local", "content-type": "application/json" }, body: "{}" }), ["banks", "bank-1", "cold-chain"])).status).toBe(403);
  for (let i = 0; i < 200; i++) await unit(`batch-${i}`);
  await expect(apply()).rejects.toMatchObject({ code: "COLD_CHAIN_BATCH_LIMIT" }); expect(await c("units").countDocuments({ status: "AVAILABLE" })).toBe(201);
});
async function aiApi(actor: Principal, route: string, body: unknown, origin = "https://test.local") {
  const extract = vi.fn(async () => dictionaryIntake("O- PRBC 2 units critical 2 hours", at.toISOString()));
  const handler = intelligenceHandler({ identity: async () => actor, database: async () => db, now: () => at, extract });
  const response = await handler(new Request(`https://test.local/api/intelligence/${route}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }), [route]); return { response, extract };
}
it("AI draft role/origin/schema checks happen before provider calls and cannot create emergencies", async () => {
  for (const actor of [bank, admin]) { const { response, extract } = await aiApi(actor, "intake", { text: "synthetic" }); expect(response.status).toBe(403); expect(extract).not.toHaveBeenCalled(); }
  expect((await aiApi(hospital, "intake", { text: "x" }, "https://evil.local")).response.status).toBe(403);
  expect((await aiApi(hospital, "intake", { text: "x", hospitalId: "other" })).response.status).toBe(400);
  const { response } = await aiApi(hospital, "intake", { text: "Synthetic O-" }); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ requiresConfirmation: true });
  expect(await c("requests").countDocuments()).toBe(0);
});
it("ops templates use only authorized retained aggregates, reject arbitrary pipelines and make no writes", async () => {
  expect((await aiApi(bank, "ops", { template: "SHORTAGES" })).response.status).toBe(403);
  expect((await aiApi(admin, "ops", { template: "SHORTAGES", pipeline: [{ $match: {} }] })).response.status).toBe(400);
  expect(await (await aiApi(admin, "ops", { template: "SHORTAGES" })).response.json()).toMatchObject({ result: null });
  const weather = bloodWeather([], [], [], [], at.toISOString());
  await c("operations").insertOne({ _id: "forecast", id: "forecast", stateId: STATE_ID, tenantId: "state-forecast-scheduler", fingerprint: "synthetic", result: { kind: "REGISTRY_FORECAST_PROPOSAL", weather, plannedTransfers: [], cutoff: at.toISOString(), inputSha256: "synthetic-input" }, createdAt: at });
  const { response, extract } = await aiApi(admin, "ops", { template: "TRANSFER_SUMMARY" }); expect(response.headers.get("cache-control")).toContain("no-store"); const text = await response.text(); expect(text).toContain("0 proposed transfers"); expect(text).not.toContain("donorId"); expect(extract).not.toHaveBeenCalled(); expect(await c("operations").countDocuments()).toBe(1);
});
it("provider adapter sends strict schema with no tools and validates actual Responses envelope", async () => {
  vi.stubEnv("AI_INTAKE_ENABLED", "1"); vi.stubEnv("OPENAI_API_KEY", "test-not-a-key"); vi.stubEnv("OPENAI_INTAKE_MODEL", "fixture-model");
  const draft = dictionaryIntake("O- PRBC 2 units critical 2 hours", at.toISOString()), transport = vi.fn(async () => Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(draft) }] }] }));
  expect(await structuredOutput("synthetic", at.toISOString(), transport)).toEqual(draft);
  const body = JSON.parse((transport.mock.calls[0] as unknown as [string, RequestInit])[1].body as string); expect(body.store).toBe(false); expect(body.text.format.strict).toBe(true); expect(body.tools).toBeUndefined();
  for (const output of [{ status: "incomplete", output: [] }, { status: "completed", output: [{ content: [{ type: "refusal" }] }] }, { status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify({ ...draft, quantity: 999 }) }] }] }]) await expect(structuredOutput("synthetic", at.toISOString(), async () => Response.json(output))).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
  await expect(structuredOutput("synthetic", at.toISOString(), async () => new Response("private error", { status: 429 }))).rejects.toMatchObject({ code: "AI_UNAVAILABLE" });
  vi.stubEnv("AI_INTAKE_ENABLED", "0"); await expect(structuredOutput("synthetic", at.toISOString(), transport)).rejects.toMatchObject({ code: "AI_NOT_CONFIGURED" });
});
