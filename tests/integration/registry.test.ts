import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { MongoClient, type Db, type Document } from "mongodb";
import { resolve } from "node:path";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(), currentUser: vi.fn() }));
import { auth, currentUser } from "@clerk/nextjs/server";
import { identity, principalFromMetadata, type Principal } from "../../src/server/identity";
import { registryHandler } from "../../src/server/registry-api";
import { seedRegistry, requireDemoTarget, seedDocuments, upgradeSchema } from "../../src/server/seed";
import { verifyIndexes, COLLECTIONS } from "../../src/server/schema";
import { STATE_ID } from "../../src/server/registry-constants";
import { mongoClient, databaseName } from "../../src/server/mongodb";

const at = "2026-10-28T12:00:00.000Z", now = new Date(at);
const admin = { role: "STATE_ADMIN", stateId: STATE_ID };
const bank = (n: number) => ({ role: "BANK", stateId: STATE_ID, tenantId: `tenant-demo-bank-${n}`, bankId: `demo-bank-${n}` });
const hospital = (n: number) => ({ role: "HOSPITAL", stateId: STATE_ID, tenantId: `tenant-demo-hospital-${n}`, hospitalId: `demo-hospital-${n}` });
const donor = (id = "demo-donor-1") => ({ role: "DONOR", stateId: STATE_ID, tenantId: `tenant-${id}`, donorId: id });
let repl: MongoMemoryReplSet, client: MongoClient, db: Db;
const logs: Record<string, unknown>[] = [];
const handle = registryHandler({ identity, database: async () => db, now: () => now, log: entry => logs.push(entry) });
function as(metadata: unknown, userId: string | null = "test-user") {
  vi.mocked(auth).mockResolvedValue({ userId } as Awaited<ReturnType<typeof auth>>);
  vi.mocked(currentUser).mockResolvedValue(userId ? { id: userId, publicMetadata: { registry: metadata } } as unknown as Awaited<ReturnType<typeof currentUser>> : null);
}
async function call(path: string, method = "GET", body?: unknown, extra: Record<string, string> = {}) {
  const [pathname, query] = path.split("?");
  return handle(new Request(`https://pulsegrid.test/api/registry/${pathname}${query ? `?${query}` : ""}`, { method, headers: { origin: "https://pulsegrid.test", "content-type": "application/json", ...extra }, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) }), pathname.split("/"));
}
beforeAll(async () => {
  vi.stubEnv("CLERK_SECRET_KEY", "test-placeholder"); vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "test-placeholder");
  repl = await MongoMemoryReplSet.create({ binary: { version: "8.0.17", downloadDir: resolve(".tools/mongodb") }, replSet: { count: 1, storageEngine: "wiredTiger" }, instanceOpts: [{ args: ["--setParameter", "ttlMonitorEnabled=false"] }] });
  client = await new MongoClient(repl.getUri(), { maxPoolSize: 5 }).connect(); db = client.db("pulsegrid_test_stage5");
  vi.stubEnv("MONGODB_URI", repl.getUri()); vi.stubEnv("MONGODB_DB_NAME", db.databaseName);
  await seedRegistry(client, db, { confirm: db.databaseName, at });
});
afterAll(async () => { const cached = (globalThis as typeof globalThis & { pulsegridMongo?: Promise<MongoClient> }).pulsegridMongo; if (cached) await (await cached).close(); await client?.close(); await repl?.stop(); vi.unstubAllEnvs(); });

describe("Clerk identity and API denials", () => {
  it("rejects an unauthenticated session and logs no tokens or provider error", async () => {
    as(null, null); const response = await call("banks/demo-bank-1");
    expect(response.status).toBe(401); expect(await response.json()).toMatchObject({ error: "UNAUTHENTICATED" });
    expect(logs.at(-1)).toMatchObject({ event: "registry.access_denied", actorId: null, status: 401 });
    expect(Object.keys(logs.at(-1)!)).toEqual(["event", "requestId", "actorId", "role", "code", "status"]);
  });
  it.each([undefined, {}, { ...bank(1), role: "ADMIN" }, { ...bank(1), tenantId: undefined }, { ...bank(1), bankId: { $ne: "" } }, { ...bank(1), stateId: "other-state" }, { ...bank(1), hospitalId: "demo-hospital-1" }])("fails closed on malformed metadata %j", async metadata => {
    as(metadata); expect((await call("me")).status).toBe(403);
  });
  it("uses backend metadata instead of client headers or unsafe metadata", async () => {
    as(bank(1)); const response = await call("state/units", "GET", undefined, { "x-role": "STATE_ADMIN", "x-tenant-id": "tenant-demo-bank-2" });
    expect(response.status).toBe(403); expect(logs.at(-1)).toMatchObject({ event: "registry.access_denied", role: "BANK" });
  });
  it("rejects a session/user identity mismatch", async () => {
    as(bank(1)); vi.mocked(currentUser).mockResolvedValue({ id: "different-user", publicMetadata: { registry: admin } } as unknown as Awaited<ReturnType<typeof currentUser>>);
    expect((await call("me")).status).toBe(401);
  });
  it("requires both institution and tenant membership", async () => {
    as({ ...bank(1), tenantId: bank(2).tenantId }); expect((await call("me")).status).toBe(403);
    as({ ...hospital(1), hospitalId: hospital(2).hospitalId }); expect((await call("me")).status).toBe(403);
  });
  it("fails closed when Clerk is unconfigured", async () => {
    vi.stubEnv("CLERK_SECRET_KEY", ""); expect((await call("me")).status).toBe(503); vi.stubEnv("CLERK_SECRET_KEY", "test-placeholder");
  });
  it("checks revoked backend membership on the next request", async () => {
    as(bank(1)); expect((await call("me")).status).toBe(200);
    as(undefined); expect((await call("banks/demo-bank-1/units")).status).toBe(403);
  });
});

describe("tenant and related-record isolation", () => {
  it.each(["banks/demo-bank-2", "banks/demo-bank-2/units", "banks/demo-bank-2/stock", "banks/demo-bank-2/unitEvents", "banks/demo-bank-2/allocations", "hospitals/demo-hospital-1/requests", "donors/demo-donor-1", "state/banks", "matching/banks"])("denies Bank A reading %s", async path => {
    as(bank(1)); expect((await call(path)).status).toBe(403);
  });
  it("returns only own units and never donor identifiers or tenant metadata", async () => {
    as(bank(1)); const response = await call("banks/demo-bank-1/units"); const payload = await response.json();
    expect(response.status).toBe(200); expect(payload.records.length).toBeGreaterThan(0);
    for (const record of payload.records) { expect(record.bankId).toBe("demo-bank-1"); expect(record).not.toHaveProperty("donorId"); expect(record).not.toHaveProperty("tenantId"); }
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0"); expect(response.headers.get("vary")).toBe("Cookie, Authorization");
  });
  it("denies a foreign unit under an authorized parent", async () => {
    as(bank(1)); const other = await db.collection("units").findOne({ bankId: "demo-bank-2" });
    expect((await call(`banks/demo-bank-1/units/${other!.id}`)).status).toBe(403);
  });
  it("requires tenantId and related bankId to agree even for corrupted records", async () => {
    const original = await db.collection("units").findOne({ bankId: "demo-bank-2" });
    await db.collection<Document & { _id: string }>("units").insertOne({ ...original!, _id: "corrupt-owner-unit", id: "corrupt-owner-unit", tenantId: bank(1).tenantId });
    as(bank(1)); expect((await call("banks/demo-bank-1/units/corrupt-owner-unit")).status).toBe(403);
    as(bank(2)); expect((await call("banks/demo-bank-2/units/corrupt-owner-unit")).status).toBe(403);
    await db.collection<Document & { _id: string }>("units").deleteOne({ _id: "corrupt-owner-unit" });
  });
  it("isolates hospital requests", async () => {
    as(hospital(1)); expect((await call("hospitals/demo-hospital-2/requests")).status).toBe(403);
    expect((await call("banks/demo-bank-1/units")).status).toBe(403);
    const payload = await (await call("hospitals/demo-hospital-1/requests")).json();
    expect(payload.records).toHaveLength(1); expect(payload.records[0].hospitalId).toBe("demo-hospital-1");
  });
  it("authorizes the state-wide hospital matching directory without private fields", async () => {
    as(hospital(1)); const response = await call("matching/banks"); const payload = await response.json();
    expect(response.status).toBe(200); expect(payload.records).toHaveLength(4);
    expect(Object.keys(payload.records[0]).sort()).toEqual(["district", "id", "location", "name"]);
  });
  it("explicitly allows state admin reads across all registry collections", async () => {
    as(admin);
    for (const collection of COLLECTIONS) expect((await call(`state/${collection}`)).status).toBe(200);
    expect((await call("banks/demo-bank-2/units")).status).toBe(200);
  });
  it("keeps admin reads inside the assigned state", async () => {
    const source = await db.collection("banks").findOne({ id: "demo-bank-1" });
    await db.collection<Document & { _id: string }>("banks").insertOne({ ...source!, _id: "foreign-state-bank", id: "foreign-state-bank", stateId: "other-state" });
    as(admin); const payload = await (await call("state/banks")).json();
    expect(payload.records.some((row: { id: string }) => row.id === "foreign-state-bank")).toBe(false);
    expect((await call("state/banks/foreign-state-bank")).status).toBe(403);
    expect((await call("banks/foreign-state-bank")).status).toBe(403);
    await db.collection<Document & { _id: string }>("banks").deleteOne({ _id: "foreign-state-bank" });
  });
  it("scopes allocation reads to both bank and hospital ownership", async () => {
    const allocation = { _id: "fixture-allocation", id: "fixture-allocation", stateId: STATE_ID, tenantId: bank(1).tenantId, bankTenantId: bank(1).tenantId, hospitalTenantId: hospital(1).tenantId, bankId: bank(1).bankId, hospitalId: hospital(1).hospitalId, unitId: "fixture-unit", requestId: "fixture-request", status: "ACTIVE", reservedAt: now };
    await db.collection<Document & { _id: string }>("allocations").insertOne(allocation);
    for (const [metadata, path] of [[bank(1), "banks/demo-bank-1"], [hospital(1), "hospitals/demo-hospital-1"]] as const) { as(metadata); expect((await (await call(`${path}/allocations`)).json()).records).toHaveLength(1); }
    as(hospital(2)); expect((await call("hospitals/demo-hospital-2/allocations/fixture-allocation")).status).toBe(403);
    await expect(db.collection<Document & { _id: string }>("allocations").insertOne({ ...allocation, _id: "duplicate", id: "duplicate" })).rejects.toMatchObject({ code: 11000 });
    await db.collection<Document & { _id: string }>("allocations").deleteMany({ unitId: "fixture-unit" });
  });
});

describe("server mutation validation", () => {
  it("persists only an authorized profile update", async () => {
    as(bank(1)); expect((await call("banks/demo-bank-1", "PATCH", { name: "Synthetic Bank A" })).status).toBe(200);
    expect((await db.collection("banks").findOne({ id: "demo-bank-1" }))!.name).toBe("Synthetic Bank A");
    expect((await call("banks/demo-bank-2", "PATCH", { name: "Unauthorized" })).status).toBe(403);
    expect((await db.collection("banks").findOne({ id: "demo-bank-2" }))!.name).toBe("Demo Bank 2");
  });
  it.each(["tenantId", "bankId", "hospitalId", "role", "stateId", "status", "screening", "available", "$set", "__proto__"])("rejects client-supplied privileged field %s", async field => {
    as(bank(1)); const body = Object.fromEntries([["name", "Still synthetic"], [field, "attacker-value"]]);
    expect((await call("banks/demo-bank-1", "PATCH", body)).status).toBe(400);
  });
  it("denies inventory mutation until the lifecycle API exists", async () => {
    as(bank(1)); expect((await call("banks/demo-bank-1/units", "PATCH", { status: "AVAILABLE" })).status).toBe(403);
  });
  it("denies a wrong-role mutation and allows a state admin profile update", async () => {
    as(hospital(1)); expect((await call("banks/demo-bank-1", "PATCH", { name: "Denied" })).status).toBe(403);
    as(admin); expect((await call("hospitals/demo-hospital-2", "PATCH", { name: "Synthetic admin update" })).status).toBe(200);
  });
  it("isolates writes between hospitals and between donors", async () => {
    as(hospital(1)); expect((await call("hospitals/demo-hospital-1", "PATCH", { name: "Synthetic Hospital A" })).status).toBe(200);
    expect((await call("hospitals/demo-hospital-2", "PATCH", { name: "Denied" })).status).toBe(403);
    as(donor()); expect((await call("donors/demo-donor-2", "PATCH", { nickname: "Denied" })).status).toBe(403);
  });
  it("rejects malformed JSON, oversized bodies and cross-origin writes", async () => {
    as(bank(1)); expect((await call("banks/demo-bank-1", "PATCH", "{")).status).toBe(400);
    expect((await call("banks/demo-bank-1", "PATCH", { name: "x".repeat(9000) })).status).toBe(413);
    expect((await call("banks/demo-bank-1", "PATCH", { name: "x" }, { origin: "https://attacker.test" })).status).toBe(403);
    expect((await call("banks/demo-bank-1", "PATCH", { name: "x" }, { "content-type": "text/plain" })).status).toBe(415);
  });
  it("rejects query-filter and pagination injection", async () => {
    as(bank(1)); expect((await call("banks/demo-bank-1/units?tenantId=other")).status).toBe(400);
    expect((await call("banks/demo-bank-1/units?after=%7B%22%24ne%22%3Anull%7D")).status).toBe(400);
  });
});

describe("donor expiry and seed/database guarantees", () => {
  it("upgrades a Stage 5 database without deleting edits or changing its fixture hash", async () => {
    const source = await db.collection("banks").findOne({ id: "demo-bank-1" });
    const marker = await db.collection("_registryMeta").findOne({ kind: "pulsegrid-stage5-v1" });
    await db.collection("operations").drop();
    const report = await upgradeSchema(db, db.databaseName);
    expect(report.dataPreserved).toBe(true); expect(report.indexes.operations).toBe(3);
    expect(await db.collection("banks").findOne({ id: "demo-bank-1" })).toEqual(source);
    expect(seedDocuments(at).hash).toBe(marker!.hash);
    await expect(upgradeSchema(db, "different-db")).rejects.toThrow();
  });
  it("reuses a single application MongoClient promise and limits the pool", async () => {
    const first = mongoClient(), second = mongoClient(); expect(first).toBe(second);
    expect((await first).options.maxPoolSize).toBe(5); expect(databaseName()).toBe(db.databaseName);
  });
  it("permits only self donor reads and nickname changes", async () => {
    as(donor()); expect((await call("donors/demo-donor-1")).status).toBe(200);
    expect((await call("donors/demo-donor-2")).status).toBe(403);
    expect((await call("donors/demo-donor-1", "PATCH", { nickname: "Synthetic nickname" })).status).toBe(200);
    expect((await call("donors/demo-donor-1", "PATCH", { nickname: "Synthetic", expireAt: at })).status).toBe(400);
  });
  it("excludes audience donors at the exact expiry boundary before physical TTL deletion", async () => {
    await db.collection("donors").updateOne({ id: "audience-donor-1" }, { $set: { expireAt: now } });
    expect(await db.collection("donors").countDocuments({ id: "audience-donor-1" })).toBe(1);
    as(donor("audience-donor-1")); expect((await call("donors/audience-donor-1")).status).toBe(403);
    expect((await call("donors/audience-donor-1", "PATCH", { nickname: "Cannot revive" })).status).toBe(403);
    as(admin); const payload = await (await call("state/donors")).json();
    expect(payload.records.some((r: { id: string }) => r.id === "audience-donor-1")).toBe(false);
    expect((await call("state/donors/audience-donor-1")).status).toBe(403);
  });
  it("supports bounded, non-overlapping pagination", async () => {
    as(admin); const one = await (await call("state/donors")).json(), two = await (await call(`state/donors?after=${one.next}`)).json();
    expect(one.records).toHaveLength(100); expect(two.records).toHaveLength(100);
    const ids = [...one.records, ...two.records].map((r: { id: string }) => r.id); expect(new Set(ids).size).toBe(200);
  });
  it("creates all specified indexes and enforces BSON Date audience expiry", async () => {
    expect(Object.keys(await verifyIndexes(db))).toHaveLength(COLLECTIONS.length);
    const source = await db.collection("donors").findOne({ id: "audience-donor-1" });
    for (const expireAt of [undefined, at]) await expect(db.collection<Document & { _id: string }>("donors").insertOne({ ...source!, _id: "invalid-donor", id: "invalid-donor", expireAt })).rejects.toMatchObject({ code: 121 });
  });
  it("enforces unique stock buckets", async () => {
    const source = await db.collection("stock").findOne({});
    await expect(db.collection<Document & { _id: string }>("stock").insertOne({ ...source!, _id: "duplicate-stock", id: "duplicate-stock" })).rejects.toMatchObject({ code: 11000 });
  });
  it("is deterministic, replay-safe and does not overwrite live edits on reseed", async () => {
    expect(seedDocuments(at).hash).toBe(seedDocuments(at).hash);
    const report = await seedRegistry(client, db, { confirm: db.databaseName });
    expect(report.transaction.supported).toBe(true); expect(report.counts.units).toBe(120);
    expect((await db.collection("banks").findOne({ id: "demo-bank-1" }))!.name).toBe("Synthetic Bank A");
    expect(await db.collection("_registryMeta").countDocuments({ kind: "transaction-probe" })).toBe(0);
  });
  it.each([["production", "production"], ["pulsegrid_demo", undefined], ["pulsegrid_demo", "pulsegrid_dev"]])("blocks unsafe seed/reset target %s", (name, confirmation) => {
    expect(() => requireDemoTarget(name!, confirmation)).toThrow();
  });
  it("resets only the explicitly confirmed marked demo database", async () => {
    const report = await seedRegistry(client, db, { confirm: db.databaseName, reset: true });
    expect(report.counts.donors).toBe(201); expect(report.counts.allocations).toBe(0);
    expect((await db.collection("banks").findOne({ id: "demo-bank-1" }))!.name).toBe("Demo Bank 1");
  });
  it("refuses nonempty databases without a seed ownership marker", async () => {
    const other = client.db("pulsegrid_test_unowned"); await other.collection("unrelated").insertOne({ keep: true });
    await expect(seedRegistry(client, other, { confirm: other.databaseName, reset: true })).rejects.toThrow("nonempty");
    expect(await other.collection("unrelated").countDocuments()).toBe(1);
  });
  it("sanitizes database failures", async () => {
    as(admin); const broken = registryHandler({ identity, database: async () => { throw new Error("mongodb://secret:password@private-host"); }, log: entry => logs.push(entry) });
    const response = await broken(new Request("https://pulsegrid.test/api/registry/me"), ["me"]);
    expect(response.status).toBe(503); expect(JSON.stringify(await response.json()) + JSON.stringify(logs.at(-1))).not.toContain("password");
  });
  it("constructs all four validated principal roles", () => {
    const roles: Principal[] = [admin, bank(1), hospital(1), donor()].map(m => principalFromMetadata("user-1", m));
    expect(roles.map(p => p.role)).toEqual(["STATE_ADMIN", "BANK", "HOSPITAL", "DONOR"]);
  });
});
