import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { MongoClient, type Db } from "mongodb";
import { resolve } from "node:path";
import webpush from "web-push";
vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(), currentUser: vi.fn() }));
import { donorHandler } from "../../src/server/donor-api";
import { ensureSchema, COLLECTIONS } from "../../src/server/schema";
import { WorkflowStore, type WorkflowRow } from "../../src/server/workflow-store";
import { STATE_ID } from "../../src/server/registry-constants";
import { decryptSubscription, deliverDonorPush, encryptSubscription, subscriptionInput } from "../../src/server/donor-push";
import { emergencyHandler } from "../../src/server/emergency-api";

let repl: MongoMemoryReplSet, client: MongoClient, db: Db, now: Date, cookie: string, donorId: string;
const start = new Date("2026-10-29T06:00:00.000Z");
const c = (name: string) => db.collection<WorkflowRow>(name);
const handle = donorHandler({ database: async () => db, now: () => now });
async function call(path: string, body?: unknown, session = cookie, extra: Record<string, string> = {}) {
  return handle(new Request(`https://pulsegrid.test/api/donor/${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin: "https://pulsegrid.test", "content-type": "application/json", cookie: session, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), [path]);
}
async function join() {
  const res = await call("register", { group: "O-", site: "Pune", consent: true }, "");
  expect(res.status).toBe(200); cookie = res.headers.get("set-cookie")!.split(";")[0]; donorId = (await res.json()).donorId;
  return res;
}
async function wave() { await new WorkflowStore(db, now).wave("request-1", 0); return (await c("alerts").findOne({ donorId }))!; }
const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/synthetic-demo", keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) } };
async function configurePush() { const keys = webpush.generateVAPIDKeys(); vi.stubEnv("VAPID_PUBLIC_KEY", keys.publicKey); vi.stubEnv("VAPID_PRIVATE_KEY", keys.privateKey); vi.stubEnv("VAPID_SUBJECT", "mailto:demo@example.test"); vi.stubEnv("DONOR_PUSH_ENCRYPTION_KEY", "ab".repeat(32)); }
beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ binary: { version: "8.0.17", downloadDir: resolve(".tools/mongodb") }, replSet: { count: 1, storageEngine: "wiredTiger" }, instanceOpts: [{ args: ["--setParameter", "ttlMonitorEnabled=false"] }] });
  client = await new MongoClient(repl.getUri()).connect(); db = client.db("pulsegrid_test_stage9"); await ensureSchema(db);
});
afterAll(async () => { await client?.close(); await repl?.stop(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  now = new Date(start); cookie = ""; donorId = "";
  vi.stubEnv("VAPID_PRIVATE_KEY", ""); vi.stubEnv("DONOR_PUSH_ENCRYPTION_KEY", "");
  for (const name of COLLECTIONS) await c(name).deleteMany({});
  await c("banks").insertOne({ _id: "bank-1", id: "bank-1", stateId: STATE_ID, tenantId: "bank-tenant", name: "Synthetic campus bank", district: "Pune", location: { type: "Point", coordinates: [73.8567, 18.5204] } });
  await c("hospitals").insertOne({ _id: "hospital-1", id: "hospital-1", stateId: STATE_ID, tenantId: "hospital-tenant", name: "Synthetic hospital", district: "Pune", location: { type: "Point", coordinates: [73.8567, 18.5204] } });
  await c("requests").insertOne({ _id: "request-1", id: "request-1", stateId: STATE_ID, tenantId: "hospital-tenant", hospitalId: "hospital-1", group: "O-", component: "PRBC", quantity: 1, allocatedQuantity: 0, transfusedQuantity: 0, urgency: "CRITICAL", status: "OPEN", createdAt: now, expectedTransfusionAt: new Date(now.getTime() + 3600_000), workflow: { status: "AWAITING_DONORS", waves: [] } });
});
describe("audience session and disclosure boundary", () => {
  it("registers only synthetic fields, hashes the bearer secret, and sets a scoped secure HttpOnly cookie", async () => {
    const res = await join(); expect(res.headers.get("set-cookie")).toContain("Path=/api/donor; HttpOnly; SameSite=Strict; Max-Age=86400; Secure");
    const row = (await c("donors").findOne({ _id: donorId }))!;
    expect(row.nickname).toMatch(/^(Amber|Coral|Indigo|Silver)-[0-9a-f]{6}$/); expect(row.expireAt.getTime() - now.getTime()).toBe(86400_000); expect(row.sessionHash).not.toContain(cookie.split("=")[1]);
    const me = await call("me"), json = await me.json(); expect(me.headers.get("cache-control")).toContain("private, no-store");
    expect(Object.keys(json.donor)).toEqual(["id", "nickname", "group", "eligibleFrom", "expireAt", "optedOut", "pushState"]); expect(JSON.stringify(json)).not.toMatch(/sessionHash|haemoglobin|birthDate|pushSubscription/);
    expect((await (await call("register", { group: "AB+", site: "Mumbai City", consent: true })).json()).donorId).toBe(donorId);
  });
  it.each([{ group: "O-", site: "Pune", consent: false }, { group: "wrong", site: "Pune", consent: true }, { group: "O-", site: "Pune", consent: true, phone: "123" }, { group: "O-", site: "GPS", consent: true }])("rejects invalid or personal registration fields %j", async body => { expect((await call("register", body)).status).toBe(400); });
  it("denies cross-origin writes, unsupported methods and oversized input", async () => {
    expect((await call("register", {}, "", { origin: "https://evil.test" })).status).toBe(403);
    expect((await call("register")).status).toBe(405);
    expect((await call("register", { junk: "x".repeat(9000) })).status).toBe(413);
  });
  it("blocks an unknown cookie, another session's alerts and the exact expiry boundary before TTL deletion", async () => {
    await join(); const first = { cookie, donorId }, alert = await wave();
    await join(); expect((await call("reply", { key: "foreign", alertId: alert.id, reply: "ACCEPTED" })).status).toBe(403);
    expect((await call("me", undefined, "pulsegrid-audience=bad")).status).toBe(401);
    cookie = first.cookie; now = new Date(start.getTime() + 86400_000);
    expect((await call("me")).status).toBe(401); expect(await c("donors").countDocuments({ _id: first.donorId })).toBe(1);
  });
  it("bounds audience registration without storing IP addresses", async () => {
    await join(); await c("operations").updateOne({ tenantId: "audience" }, { $set: { count: 200 } });
    expect((await call("register", { group: "O-", site: "Pune", consent: true }, "")).status).toBe(429);
  });
  it("opts out and explicitly deletes donor, subscription, alerts and response receipts", async () => {
    await join(); const alert = await wave(); await call("reply", { key: "reply-1", alertId: alert.id, reply: "DECLINED" });
    await c("donors").updateOne({ _id: donorId }, { $set: { pushSubscription: { fake: true } } });
    expect((await call("opt-out", {})).status).toBe(200); expect((await c("donors").findOne({ _id: donorId }))!.pushSubscription).toBeUndefined();
    expect((await call("delete", {})).status).toBe(200);
    expect(await c("donors").countDocuments({ _id: donorId })).toBe(0); expect(await c("alerts").countDocuments({ donorId })).toBe(0); expect(await c("operations").countDocuments({ tenantId: `tenant-${donorId}` })).toBe(0); expect((await call("me")).status).toBe(401);
  });
});
describe("transactional replies and request visibility", () => {
  it.each(["ACCEPTED", "DECLINED"])("applies %s once and exposes it in the main workflow snapshot", async reply => {
    await join(); const alert = await wave(), input = { key: "same-offline-key", alertId: alert.id, reply };
    const receipts = await Promise.all([call("reply", input), call("reply", input)]); expect(await receipts[0].json()).toMatchObject({ state: "RECEIVED", requestId: "request-1" }); expect(await receipts[1].json()).toMatchObject({ state: "RECEIVED" });
    expect(await c("operations").countDocuments({ tenantId: `tenant-${donorId}` })).toBe(1);
    expect((await new WorkflowStore(db, now).snapshot("request-1")).acceptedDonors).toBe(reply === "ACCEPTED" ? 1 : 0); expect(await c("units").countDocuments()).toBe(0);
    const status = emergencyHandler({ identity: async () => ({ userId: "hospital-user", role: "HOSPITAL", stateId: STATE_ID, tenantId: "hospital-tenant", hospitalId: "hospital-1" }), database: async () => db, now: () => now, configured: () => {}, secret: () => "test-secret", send: async () => ({ ids: [] }), log: () => {} });
    const main = await status(new Request("https://pulsegrid.test/api/emergencies/request-1"), ["request-1"]);
    expect(await main.json()).toMatchObject({ acceptedDonors: reply === "ACCEPTED" ? 1 : 0, declinedDonors: reply === "DECLINED" ? 1 : 0, allocatedQuantity: 0 });
    expect((await call("reply", { ...input, reply: reply === "ACCEPTED" ? "DECLINED" : "ACCEPTED" })).status).toBe(409);
  });
  it.each(["deadline", "fulfilled", "cancelled", "opt-out", "ineligible", "wave"])("reports TOO_LATE for %s and creates no accepted donor", async reason => {
    await join(); const alert = await wave();
    if (reason === "deadline") now = new Date(alert.deadlineAt);
    if (reason === "fulfilled") await c("requests").updateOne({ _id: "request-1" }, { $set: { allocatedQuantity: 1, status: "ALLOCATED" } });
    if (reason === "cancelled") await c("requests").updateOne({ _id: "request-1" }, { $set: { status: "CANCELLED" } });
    if (reason === "opt-out") await call("opt-out", {});
    if (reason === "ineligible") await c("donors").updateOne({ _id: donorId }, { $set: { eligibleFrom: new Date(now.getTime() + 1000) } });
    if (reason === "wave") await c("requests").updateOne({ _id: "request-1" }, { $set: { "workflow.waves": [] } });
    expect(await (await call("reply", { key: "late", alertId: alert.id, reply: "ACCEPTED" })).json()).toMatchObject({ state: "TOO_LATE" });
    expect((await new WorkflowStore(db, now).snapshot("request-1")).acceptedDonors).toBe(0);
  });
});
describe("encrypted push with in-app fallback", () => {
  it("authenticates ciphertext and donor binding, rejects internal endpoints, and exposes only the public VAPID key", async () => {
    await configurePush(); const cipher = encryptSubscription(subscription, "donor-a"); expect(JSON.stringify(cipher)).not.toContain(subscription.endpoint); expect(decryptSubscription(cipher, "donor-a")).toEqual(subscription);
    expect(() => decryptSubscription(cipher, "donor-b")).toThrow(); expect(() => decryptSubscription({ ...cipher, tag: Buffer.alloc(16).toString("base64") }, "donor-a")).toThrow();
    expect(() => subscriptionInput({ ...subscription, endpoint: "https://127.0.0.1/private" })).toThrow();
    await join(); expect((await call("subscription", subscription)).status).toBe(200); const me = await (await call("me")).json(); expect(me.pushPublicKey).toBe(process.env.VAPID_PUBLIC_KEY); expect(JSON.stringify(me)).not.toContain(process.env.VAPID_PRIVATE_KEY);
  });
  it("sends a generic notification once, then removes an expired provider subscription", async () => {
    await join(); const alert = await wave(); await configurePush(); await call("subscription", subscription);
    const send = vi.fn().mockResolvedValue({}); await Promise.all([deliverDonorPush(db, "request-1", now, send), deliverDonorPush(db, "request-1", now, send)]); await deliverDonorPush(db, "request-1", now, send); expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0][1]).not.toContain("O-");
    await c("alerts").updateOne({ _id: alert.id }, { $unset: { pushStatus: "" } }); send.mockRejectedValue({ statusCode: 410 }); await deliverDonorPush(db, "request-1", now, send);
    expect((await c("donors").findOne({ _id: donorId }))!.pushSubscription).toBeUndefined(); expect((await c("alerts").findOne({ _id: alert.id }))!.status).toBe("PENDING"); expect((await (await call("me")).json()).donor.pushState).toBe("EXPIRED");
  });
  it.each(["opt-out", "fulfilled", "expired", "fatigue", "cooldown", "ineligible", "wave", "quiet"])("rechecks %s before provider send", async reason => {
    await join(); const alert = await wave(); await configurePush(); await call("subscription", subscription);
    if (reason === "opt-out") await call("opt-out", {});
    if (reason === "fulfilled") await c("requests").updateOne({ _id: "request-1" }, { $set: { allocatedQuantity: 1 } });
    if (reason === "expired") await c("donors").updateOne({ _id: donorId }, { $set: { expireAt: now } });
    if (reason === "ineligible") await c("donors").updateOne({ _id: donorId }, { $set: { eligibleFrom: new Date(now.getTime() + 1000) } });
    if (reason === "wave") await c("requests").updateOne({ _id: "request-1" }, { $set: { "workflow.waves": [] } });
    if (reason === "quiet") { now = new Date("2026-10-28T18:00:00Z"); await c("requests").updateOne({ _id: "request-1" }, { $set: { urgency: "URGENT" } }); await c("donors").updateOne({ _id: donorId }, { $set: { eligibleFrom: now } }); }
    if (reason === "cooldown" || reason === "fatigue") for (let i = 0; i < (reason === "fatigue" ? 4 : 1); i++) await c("alerts").insertOne({ ...alert, _id: `previous-${i}`, id: `previous-${i}`, requestId: `previous-request-${i}`, createdAt: new Date(start.getTime() - (reason === "fatigue" ? 3 * 86400_000 : 1000)) });
    const send = vi.fn(); await deliverDonorPush(db, "request-1", now, send); expect(send).not.toHaveBeenCalled();
  });
  it("retries a transient provider failure without duplicating the in-app alert", async () => {
    await join(); await wave(); await configurePush(); await call("subscription", subscription);
    const send = vi.fn().mockRejectedValueOnce({ statusCode: 503 }).mockResolvedValue({});
    await expect(deliverDonorPush(db, "request-1", now, send)).rejects.toMatchObject({ code: "PUSH_DELIVERY_RETRY" });
    await deliverDonorPush(db, "request-1", now, send); expect(send).toHaveBeenCalledTimes(2); expect(await c("alerts").countDocuments()).toBe(1);
  });
});
