import { auditSnapshot, baseline, verifyUnit } from "../../src/server/audit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { MongoClient, type Db, type Document } from "mongodb";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { registryHandler } from "../../src/server/registry-api";
import { principalFromMetadata, type Principal } from "../../src/server/identity";
import { ensureSchema } from "../../src/server/schema";
import { STATE_ID } from "../../src/server/registry-constants";
import { Registry } from "../../src/server/registry";

type Row = Document & { _id: string };
const start = new Date("2026-10-29T09:00:00.000Z");
let now = start, client: MongoClient, db: Db, repl: MongoMemoryReplSet;
const actor = (role: "BANK" | "HOSPITAL", n = 1) => principalFromMetadata(`user-${role}-${n}`, { role, stateId: STATE_ID, tenantId: `tenant-${role.toLowerCase()}-${n}`, [role === "BANK" ? "bankId" : "hospitalId"]: `${role.toLowerCase()}-${n}` });
const bank = actor("BANK"), hospital = actor("HOSPITAL");
function c(name: string) { return db.collection<Row>(name); }
async function post(path: string, body: unknown, p: Principal = hospital, extra: Record<string, string> = {}) {
  const handle = registryHandler({ identity: async () => p, database: async () => db, now: () => now, log: () => {} });
  const response = await handle(new Request(`https://registry.test/api/registry/${path}`, { method: "POST", headers: { origin: "https://registry.test", "content-type": "application/json", ...extra }, body: JSON.stringify(body) }), path.split("/"));
  return { status: response.status, body: await response.json() as Document, headers: response.headers };
}
const base = (n = 1) => `hospitals/hospital-${n}/requests`;
async function request(quantity = 1, n = 1, extra: Document = {}) {
  const result = await post(base(n), { key: randomUUID(), group: "O-", component: "PRBC", quantity, urgency: "ROUTINE", expectedTransfusionAt: new Date(start.getTime() + 3_600_000).toISOString(), ...extra }, actor("HOSPITAL", n));
  expect(result.status).toBe(200); return result.body.requestId as string;
}
async function reserve(requestId: string, n = 1, key: string = randomUUID()) { return post(`${base(n)}/${requestId}/reserve`, { key }, actor("HOSPITAL", n)); }
async function unit(id: string, extra: Document = {}) {
  const sealed = baseline({ _id: id, id, stateId: STATE_ID, tenantId: "tenant-bank-1", bankId: "bank-1", donorId: "donor-1", group: "O-", component: "PRBC", product: "PRBC_SAGM", collectedAt: new Date(start.getTime() - 86_400_000), expiresAt: new Date(start.getTime() + 86_400_000), status: "AVAILABLE", screening: { HIV: "NON_REACTIVE", HEPATITIS_B: "NON_REACTIVE", HEPATITIS_C: "NON_REACTIVE", SYPHILIS: "NON_REACTIVE", MALARIA: "NON_REACTIVE" }, storage: "VERIFIED", ...extra }, start);
  await c("units").insertOne(sealed.unit);
  await c("unitEvents").insertOne(sealed.event);
}
async function action(unitId: string, type: string, p = bank, extra: Document = {}) {
  const root = p.role === "BANK" ? `banks/${p.bankId}` : p.role === "HOSPITAL" ? `hospitals/${p.hospitalId}` : "invalid";
  return post(`${root}/units/${unitId}/action`, { key: randomUUID(), type, ...extra }, p);
}
beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ binary: { version: "8.0.17", downloadDir: resolve(".tools/mongodb") }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  client = await new MongoClient(repl.getUri(), { maxPoolSize: 20 }).connect(); db = client.db("pulsegrid_test_stage6");
  await ensureSchema(db);
  for (const kind of ["banks", "hospitals"]) for (let n = 1; n <= 2; n++) {
    const id = `${kind === "banks" ? "bank" : "hospital"}-${n}`;
    await c(kind).insertOne({ _id: id, id, stateId: STATE_ID, tenantId: `tenant-${id}`, name: `Synthetic ${id}`, district: "Mumbai City", location: { type: "Point", coordinates: [72.8 + n * .01, 19] } });
  }
  await c("donors").insertOne({ _id: "donor-1", id: "donor-1", stateId: STATE_ID, tenantId: "tenant-donor-1", nickname: "Synthetic donor", group: "O-", location: { type: "Point", coordinates: [72.8, 19] }, eligibleFrom: new Date(0), audience: false });
});
beforeEach(async () => {
  now = new Date(start);
  for (const name of ["units", "requests", "allocations", "unitEvents", "stock", "operations"]) await c(name).deleteMany({});
});
afterAll(async () => { await client?.close(); await repl?.stop(); });

describe("transactional reservations on a real replica set", () => {
  it("100 concurrent attempts for 10 units produce exactly 10 owners and matching counters", async () => {
    for (let i = 0; i < 10; i++) await unit(`race-${i}`);
    const requests = await Promise.all(Array.from({ length: 100 }, (_, i) => request(1, i % 2 + 1)));
    const t0 = performance.now();
    const results = await Promise.all(requests.map((id, i) => reserve(id, i % 2 + 1)));
    expect(results.filter(r => r.status !== 200)).toEqual([]);
    expect(results.filter(r => r.body.reserved)).toHaveLength(10);
    const slots = await c("allocations").find({ status: "ACTIVE" }).toArray();
    expect(slots).toHaveLength(10); expect(new Set(slots.map(s => s.unitId)).size).toBe(10);
    expect(await c("units").countDocuments({ status: "RESERVED" })).toBe(10);
    expect(await c("units").countDocuments({ status: "AVAILABLE" })).toBe(0);
    expect((await c("stock").find({}).toArray()).reduce((n, r) => n + r.available, 0)).toBe(0);
    const allRequests = await c("requests").find({}).toArray();
    expect(allRequests.reduce((n, r) => n + r.allocatedQuantity, 0)).toBe(10);
    expect(allRequests.every(r => r.allocatedQuantity <= r.quantity)).toBe(true);
    expect(await c("unitEvents").countDocuments({ action: "RESERVE" })).toBe(10);
    await auditSnapshot(db, async session => {
      for (const row of await c("units").find({}, { session }).toArray()) expect((await verifyUnit(db, row, session)).verification.ok).toBe(true);
    });
    const report = { at: start.toISOString(), environment: "local MongoDB 8.0.17 WiredTiger single-node replica set; injected authenticated principals", attempts: 100, units: 10, successfulReservations: 10, owners: slots.map(s => ({ unitId: s.unitId, hospitalId: s.hospitalId, requestId: s.requestId })), doubleAllocations: 0, allocatedQuantity: 10, availableCounter: 0, elapsedMs: Math.round(performance.now() - t0) };
    await mkdir(resolve("../_ai_context/artifacts"), { recursive: true });
    await writeFile(resolve("../_ai_context/artifacts/stage-6-race.json"), JSON.stringify(report, null, 2) + "\n");
  }, 90_000);
  it("concurrent calls cannot overfill a single one-unit request", async () => {
    for (let i = 0; i < 10; i++) await unit(`bounded-${i}`);
    const id = await request();
    const results = await Promise.all(Array.from({ length: 30 }, () => reserve(id)));
    expect(results.every(r => r.status === 200)).toBe(true);
    expect(results.filter(r => r.body.reserved)).toHaveLength(1);
    expect((await c("requests").findOne({ _id: id }))!.allocatedQuantity).toBe(1);
    expect((await c("stock").findOne({ bankId: "bank-1" }))!.available).toBe(9);
  });
  it("parallel identical reservation retries return one durable result and one side effect", async () => {
    await unit("replay-1"); await unit("replay-2"); const id = await request(2), key = randomUUID();
    const results = await Promise.all(Array.from({ length: 10 }, () => reserve(id, 1, key)));
    expect(results.every(r => r.status === 200)).toBe(true);
    for (const result of results) expect(result.body).toEqual(results[0].body);
    expect(await c("allocations").countDocuments()).toBe(1);
    expect(await c("unitEvents").countDocuments({ action: "RESERVE" })).toBe(1);
    expect((await c("requests").findOne({ _id: id }))!.allocatedQuantity).toBe(1);
  });
  it("allocation reads and pagination use stable slot cursors when reservation IDs differ", async () => {
    await c("allocations").insertMany(Array.from({ length: 101 }, (_, i) => ({ _id: `slot-${String(i).padStart(3, "0")}`, id: `reservation-${i}`, unitId: `page-unit-${i}`, requestId: "page-request", stateId: STATE_ID, tenantId: "tenant-bank-1", bankTenantId: "tenant-bank-1", hospitalTenantId: "tenant-hospital-1", bankId: "bank-1", hospitalId: "hospital-1", status: "RELEASED", reservedAt: now })));
    const registry = new Registry(db, hospital, now);
    const first = await registry.read(["hospitals", "hospital-1", "allocations"]);
    if (!("records" in first)) throw new Error("Expected allocation list");
    expect(first.records).toHaveLength(100); expect(first.next).toBe("slot-099");
    const second = await registry.read(["hospitals", "hospital-1", "allocations"], first.next!);
    if (!("records" in second)) throw new Error("Expected allocation list");
    expect(second.records).toHaveLength(1); expect(second.records![0].id).toBe("reservation-100");
    const single = await registry.read(["hospitals", "hospital-1", "allocations", "reservation-100"]);
    expect(single).toMatchObject({ record: { id: "reservation-100", unitId: "page-unit-100" } });
    expect(first.records![0]).not.toHaveProperty("_id");
  });
  it("replays request creation, rejects changed payload under the same key", async () => {
    const body = { key: "same-key", group: "O-", component: "PRBC", quantity: 2, urgency: "ROUTINE", expectedTransfusionAt: new Date(start.getTime() + 3_600_000).toISOString() };
    const results = await Promise.all(Array.from({ length: 5 }, () => post(base(), body)));
    expect(results.every(r => r.status === 200)).toBe(true); expect(await c("requests").countDocuments()).toBe(1);
    expect((await post(base(), { ...body, quantity: 3 })).body.error).toBe("IDEMPOTENCY_KEY_REUSED");
  });
  it("persists a no-stock receipt; a new action is required when stock arrives", async () => {
    const id = await request(), key = randomUUID(); const first = await reserve(id, 1, key);
    expect(first.body).toMatchObject({ reserved: false, reason: "NO_ELIGIBLE_STOCK" });
    await unit("later-stock"); expect((await reserve(id, 1, key)).body).toEqual(first.body);
    expect((await reserve(id)).body.reserved).toBe(true);
  });
  it("leaves a partial allocation explicit when demand exceeds supply", async () => {
    await unit("partial"); const id = await request(2);
    expect((await reserve(id)).body).toMatchObject({ reserved: true, status: "PARTIAL", remaining: 1 });
    expect((await reserve(id)).body).toMatchObject({ reserved: false, status: "PARTIAL", remaining: 1 });
  });
  it("rolls back unit, allocation, request, counter and receipt if a later write fails", async () => {
    await unit("rollback"); const id = await request();
    await c("unitEvents").createIndex({ action: 1 }, { unique: true, name: "test_failure" });
    await c("unitEvents").insertOne({ _id: "block", id: "block", stateId: STATE_ID, tenantId: "tenant-bank-1", bankId: "bank-1", unitId: "other", action: "RESERVE", at: now, actorId: "fixture" });
    try {
      expect((await reserve(id)).status).toBe(409);
      expect((await c("units").findOne({ _id: "rollback" }))!.status).toBe("AVAILABLE");
      expect(await c("allocations").countDocuments()).toBe(0);
      expect((await c("requests").findOne({ _id: id }))!.allocatedQuantity).toBe(0);
      expect(await c("operations").countDocuments()).toBe(1); // request receipt only
      expect(await c("stock").countDocuments()).toBe(0);
    } finally { await c("unitEvents").dropIndex("test_failure"); }
    expect((await reserve(id)).body.reserved).toBe(true);
  });
});

describe("matching and lifecycle safety gates", () => {
  it("uses indexed geography, exact preference then FEFO across banks", async () => {
    const id = await request(3, 1, { group: "A+" });
    await unit("conserve-o", { expiresAt: new Date(start.getTime() + 7_200_000) });
    await unit("exact-later", { group: "A+" });
    await unit("exact-first", { group: "A+", bankId: "bank-2", tenantId: "tenant-bank-2", expiresAt: new Date(start.getTime() + 10_800_000) });
    const search = await post(`${base()}/${id}/search`, {});
    expect(search.status).toBe(200); expect(search.body.records.map((r: Document) => r.unitId)).toEqual(["exact-first", "exact-later", "conserve-o"]);
    expect(search.body.records[0]).toHaveProperty("distanceKm"); expect(search.body.records[0]).not.toHaveProperty("donorId"); expect(search.body.records[0]).not.toHaveProperty("tenantId");
    expect((await reserve(id)).body.unitId).toBe("exact-first");
  });
  it.each([
    { status: "TESTING" }, { storage: "UNKNOWN" }, { screening: { HIV: "REACTIVE" } }, { screening: { HIV: "NON_REACTIVE" } },
    { group: "A+" }, { component: "FFP", product: "FFP_FROZEN" }, { expiresAt: new Date(start.getTime() + 3_600_000) }, { expiresAt: start },
    { collectedAt: new Date(start.getTime() + 1_000) }, { expiresAt: new Date(start.getTime() + 60 * 86_400_000) }, { tenantId: "tenant-bank-2" }, { stateId: "other-state" }
  ])("never reserves an ineligible unit %j", async extra => {
    await unit("ineligible", extra); const id = await request();
    expect((await reserve(id)).body.reserved).toBe(false); expect(await c("allocations").countDocuments()).toBe(0);
  });
  it("excludes banks outside the documented 250 km search radius", async () => {
    await c("banks").insertOne({ _id: "far", id: "far", stateId: STATE_ID, tenantId: "tenant-far", name: "Synthetic far", district: "Pune", location: { type: "Point", coordinates: [79, 23] } });
    try { await unit("far-unit", { bankId: "far", tenantId: "tenant-far" }); const id = await request(); expect((await reserve(id)).body.reserved).toBe(false); }
    finally { await c("banks").deleteOne({ _id: "far" }); }
  });
  it("refuses an inconsistent occupied allocation slot and tries the next candidate", async () => {
    await unit("a-occupied"); await unit("b-good");
    await c("allocations").insertOne({ _id: "occupied", id: "occupied", unitId: "a-occupied", requestId: "unknown", stateId: STATE_ID, tenantId: "tenant-bank-1", bankTenantId: "tenant-bank-1", hospitalTenantId: "tenant-hospital-2", bankId: "bank-1", hospitalId: "hospital-2", status: "ACTIVE", reservedAt: now });
    const id = await request(); expect((await reserve(id)).body.unitId).toBe("b-good");
  });
  it("releases on cancellation, reuses the unique slot, retains both ownership histories", async () => {
    await unit("reusable"); const first = await request(); const reserved = await reserve(first);
    expect((await post(`${base()}/${first}/cancel`, { key: "cancel" })).body.released).toBe(1);
    expect((await c("stock").findOne({ bankId: "bank-1" }))!.available).toBe(1);
    expect((await reserve(first)).status).toBe(409);
    const second = await request(1, 2); const next = await reserve(second, 2);
    expect(next.body.reserved).toBe(true); expect(next.body.allocationId).not.toBe(reserved.body.allocationId);
    expect(await c("allocations").countDocuments({ unitId: "reusable" })).toBe(1);
    const history = await post(`${base()}/${first}/history`, {});
    expect(history.body.records.map((r: Document) => r.action)).toEqual(["RESERVE", "CANCEL_RESERVATION"]);
    const events = await c("unitEvents").find({ requestId: first }).toArray();
    expect(events[1].allocationSnapshot.requestId).toBe(first);
    expect((await post(`${base(2)}/${first}/history`, {}, actor("HOSPITAL", 2))).status).toBe(403);
    expect((await reserve(first, 1, "new-closed-key")).body.error).toBe("REQUEST_CLOSED_OR_DUE");
    const replayKey = "held-result"; const third = await request(1, 2); expect((await reserve(third, 2, replayKey)).body.reserved).toBe(false);
  });
  it("expires a lease at its exact boundary and permits another request to acquire stock", async () => {
    await unit("lease"); const first = await request(); await reserve(first);
    now = new Date(start.getTime() + 600_000);
    expect((await action("lease", "ISSUE", bank, { preparationConfirmed: false })).status).toBe(409);
    const result = await post("banks/bank-1/maintain", { key: "expiry" }, bank);
    expect(result.body.processed).toBe(1); expect((await c("requests").findOne({ _id: first }))!.allocatedQuantity).toBe(0);
    expect((await c("units").findOne({ _id: "lease" }))!.status).toBe("AVAILABLE");
    expect((await reserve(await request())).body.reserved).toBe(true);
  });
  it("logical unit expiry blocks matching before maintenance and reconciles stale counters", async () => {
    await unit("expiring", { expiresAt: new Date(start.getTime() + 1_000) });
    await post("banks/bank-1/maintain", { key: "before" }, bank);
    expect((await c("stock").findOne({ group: "O-", component: "PRBC" }))!.available).toBe(1);
    now = new Date(start.getTime() + 1_000);
    expect((await reserve(await request())).body.reserved).toBe(false);
    await post("banks/bank-1/maintain", { key: "after" }, bank);
    expect((await c("units").findOne({ _id: "expiring" }))!.status).toBe("EXPIRED");
    expect((await c("stock").findOne({ group: "O-", component: "PRBC" }))!.available).toBe(0);
  });
  it("hospital maintenance releases only its own due allocations across bank tenants", async () => {
    await unit("hospital-lease-1"); await unit("hospital-lease-2", { bankId: "bank-2", tenantId: "tenant-bank-2" });
    const first = await request(), second = await request(1, 2);
    const a = await reserve(first), b = await reserve(second, 2);
    now = new Date(start.getTime() + 600_000);
    expect((await post("hospitals/hospital-1/maintain", { key: "own-expiry" })).body.processed).toBe(1);
    expect((await c("units").findOne({ _id: a.body.unitId }))!.status).toBe("AVAILABLE");
    expect((await c("units").findOne({ _id: b.body.unitId }))!.status).toBe("RESERVED");
    expect((await c("requests").findOne({ _id: second }))!.allocatedQuantity).toBe(1);
  });
  it("completes collection → screening → reservation → issue → handover → synthetic use", async () => {
    const collect = { key: "collection", donorId: "donor-1", group: "O-", product: "PRBC_SAGM", collectedAt: now.toISOString() };
    const result = await post("banks/bank-1/collect", collect, bank); expect(result.status).toBe(200);
    expect((await post("banks/bank-1/collect", collect, bank)).body).toEqual(result.body);
    const id = result.body.unitId as string;
    expect((await action(id, "MAKE_AVAILABLE")).status).toBe(409);
    expect((await action(id, "START_TESTING")).status).toBe(200);
    expect((await action(id, "MAKE_AVAILABLE")).status).toBe(409);
    const screening = Object.fromEntries(["HIV", "HEPATITIS_B", "HEPATITIS_C", "SYPHILIS", "MALARIA"].map(s => [s, "NON_REACTIVE"]));
    expect((await action(id, "UPDATE_SCREENING", bank, { screening })).status).toBe(200);
    expect((await action(id, "VERIFY_STORAGE", bank, { storage: "VERIFIED" })).status).toBe(200);
    expect((await action(id, "MAKE_AVAILABLE")).status).toBe(200);
    const req = await request(); expect((await reserve(req)).body.unitId).toBe(id);
    expect((await action(id, "TRANSFUSE", hospital)).status).toBe(403);
    expect((await action(id, "ISSUE", bank, { preparationConfirmed: false })).status).toBe(200);
    expect((await post(`${base()}/${req}/cancel`, { key: "cancel-issued" })).body.error).toBe("RETURN_ISSUED_STOCK_FIRST");
    expect((await action(id, "TRANSFUSE", hospital)).status).toBe(409);
    const handover = { key: "handover", type: "HANDOVER" };
    expect((await post(`hospitals/hospital-1/units/${id}/action`, handover)).status).toBe(200);
    expect((await post(`hospitals/hospital-1/units/${id}/action`, handover)).status).toBe(200);
    expect((await action(id, "TRANSFUSE", hospital)).status).toBe(200);
    expect((await c("requests").findOne({ _id: req }))).toMatchObject({ status: "COMPLETED", allocatedQuantity: 1, transfusedQuantity: 1 });
    expect((await c("allocations").findOne({ unitId: id }))!.status).toBe("TRANSFUSED");
    await auditSnapshot(db, async session => {
      const row = (await c("units").findOne({ id }, { session }))!;
      expect((await verifyUnit(db, row, session)).verification).toMatchObject({ ok: true, chain: "VALID", signature: "VALID", state: "MATCH" });
    });
  });
  it("reactive screening discards stock and a return stays quarantined", async () => {
    await unit("reactive", { status: "TESTING" }); expect((await action("reactive", "UPDATE_SCREENING", bank, { screening: { HIV: "REACTIVE", HEPATITIS_B: "PENDING", HEPATITIS_C: "PENDING", SYPHILIS: "PENDING", MALARIA: "PENDING" } })).body.status).toBe("DISCARDED");
    await unit("return"); const id = await request(); await reserve(id); await action("return", "ISSUE", bank, { preparationConfirmed: false });
    expect((await action("return", "RETURN", bank, { note: "Synthetic return; manual review" })).body.status).toBe("RETURNED_QUARANTINE");
    expect((await action("return", "MAKE_AVAILABLE")).status).toBe(409);
    expect((await c("requests").findOne({ _id: id }))!.allocatedQuantity).toBe(0);
    expect((await c("allocations").findOne({ unitId: "return" }))!.status).toBe("RELEASED");
    expect((await post(`${base()}/${id}/cancel`, { key: "after-return" })).status).toBe(200);
  });
  it("requires explicit synthetic FFP preparation before issue", async () => {
    await unit("ffp", { component: "FFP", product: "FFP_FROZEN" }); const id = await request(1, 1, { component: "FFP" }); await reserve(id);
    expect((await action("ffp", "ISSUE", bank, { preparationConfirmed: false })).status).toBe(409);
    expect((await action("ffp", "ISSUE", bank, { preparationConfirmed: true })).status).toBe(200);
  });
});

describe("POST authorization and strict input validation", () => {
  it("rejects other tenants, wrong roles and operator/privileged fields", async () => {
    await unit("private"); const id = await request();
    expect((await post(`${base(2)}/${id}/reserve`, { key: "foreign" }, actor("HOSPITAL", 2))).status).toBe(403);
    expect((await post(`${base()}/${id}/reserve`, { key: "wrong" }, bank)).status).toBe(403);
    expect((await action("private", "DISCARD", actor("BANK", 2), { note: "foreign" })).status).toBe(403);
    expect((await post(`${base()}/${id}/reserve`, { key: "evil", tenantId: "other" })).status).toBe(400);
    expect((await post(`${base()}/${id}/reserve`, { key: "evil", mode: "NAIVE" })).status).toBe(400);
    expect((await post(`${base()}/${id}/reserve`, { key: { $ne: "" } })).status).toBe(400);
    expect((await post(`${base()}/${id}/reserve`, { key: "origin" }, hospital, { origin: "https://foreign.test" })).status).toBe(403);
    expect((await action("private", "HANDOVER", bank)).status).toBe(403);
    expect((await action("private", "START_TESTING", hospital)).status).toBe(403);
    const forged = principalFromMetadata("bad", { role: "BANK", stateId: STATE_ID, tenantId: "tenant-bank-2", bankId: "bank-1" });
    expect((await post("banks/bank-1/maintain", { key: "forged" }, forged)).status).toBe(403);
  });
  it.each([{ quantity: 0 }, { quantity: 21 }, { quantity: 1.5 }, { group: "X+" }, { expectedTransfusionAt: start.toISOString() }, { expectedTransfusionAt: "2026-10-31T09:00:00Z" }, { hospitalId: "hospital-2" }, { status: "ALLOCATED" }])("rejects invalid request %j", async extra => {
    expect((await post(base(), { key: "invalid", group: "O-", component: "PRBC", quantity: 1, urgency: "URGENT", expectedTransfusionAt: new Date(start.getTime() + 3_600_000).toISOString(), ...extra })).status).toBe(400);
  });
  it("denies foreign hospital handover and leaves owner state intact", async () => {
    await unit("owned"); const id = await request(); await reserve(id); await action("owned", "ISSUE", bank, { preparationConfirmed: false });
    expect((await action("owned", "HANDOVER", actor("HOSPITAL", 2))).status).toBe(403);
    expect((await c("units").findOne({ _id: "owned" }))!.handoverAt).toBeUndefined();
  });
  it("rejects future collection, donor/group mismatch, and incomplete screening payloads", async () => {
    const input = { key: "collect-invalid", donorId: "donor-1", group: "O-", product: "PRBC_SAGM", collectedAt: now.toISOString() };
    expect((await post("banks/bank-1/collect", { ...input, collectedAt: new Date(start.getTime() + 1_000).toISOString() }, bank)).status).toBe(400);
    expect((await post("banks/bank-1/collect", { ...input, group: "A+" }, bank)).status).toBe(400);
    await unit("test", { status: "TESTING" }); expect((await action("test", "UPDATE_SCREENING", bank, { screening: { HIV: "NON_REACTIVE" } })).status).toBe(400);
  });
});
