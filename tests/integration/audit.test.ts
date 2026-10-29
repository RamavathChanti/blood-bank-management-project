import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { MongoClient, type Db } from "mongodb";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { canonical, without } from "../../src/core/audit";
import { auditSnapshot, baseline, signatureStatus, signUnit, verifyUnit, type Row } from "../../src/server/audit";
import { auditHandler } from "../../src/server/audit-api";
import { publicAnchor, publishGithubAnchor, runAuditVerifier, runDailyAnchor, sendAuditEmail, verifyAnchor } from "../../src/server/audit-jobs";
import { Operations } from "../../src/server/operations";
import { seedRegistry } from "../../src/server/seed";
import { ensureSchema } from "../../src/server/schema";
import { STATE_ID } from "../../src/server/registry-constants";
import type { Principal } from "../../src/server/identity";

let repl: MongoMemoryReplSet, client: MongoClient, db: Db;
const at = new Date("2026-10-29T09:00:00.000Z"), c = (name: string) => db.collection<Row>(name);
const bank: Principal = { userId: "test-bank", role: "BANK", bankId: "bank-1", tenantId: "tenant-bank-1", stateId: STATE_ID }, admin: Principal = { userId: "test-admin", role: "STATE_ADMIN", stateId: STATE_ID };
async function fixture() {
  const sealed = baseline({ _id: "audit-unit", id: "audit-unit", stateId: STATE_ID, tenantId: "tenant-bank-1", bankId: "bank-1", donorId: "synthetic-donor", group: "O-", component: "PRBC", product: "PRBC_SAGM", collectedAt: new Date(at.getTime() - 86400000), expiresAt: new Date(at.getTime() + 86400000), status: "COLLECTED", storage: "UNKNOWN", screening: { HIV: "PENDING", HEPATITIS_B: "PENDING", HEPATITIS_C: "PENDING", SYPHILIS: "PENDING", MALARIA: "PENDING" } }, at);
  await c("units").insertOne(sealed.unit); await c("unitEvents").insertOne(sealed.event);
  return sealed;
}
const verify = async () => auditSnapshot(db, async session => verifyUnit(db, (await c("units").findOne({ id: "audit-unit" }, { session }))!, session));
async function api(path: string, actor = admin, method = "GET", origin = "https://test.local") {
  const handler = auditHandler({ identity: async () => actor, database: async () => db, now: () => at, log: () => {} });
  return handler(new Request(`https://test.local/api/audit/${path}`, { method, ...(method === "POST" ? { headers: { origin, "content-type": "application/json" }, body: "{}" } : {}) }), path.split("/"));
}
beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ binary: { version: "8.0.17", downloadDir: resolve(".tools/mongodb") }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  client = await new MongoClient(repl.getUri()).connect(); db = client.db("pulsegrid_test_audit"); await ensureSchema(db);
  await c("banks").insertOne({ _id: "bank-1", id: "bank-1", stateId: STATE_ID, tenantId: "tenant-bank-1", name: "Synthetic bank", district: "Thane", location: { type: "Point", coordinates: [73, 19] } });
});
beforeEach(async () => { for (const name of ["units", "unitEvents", "operations", "anchors", "stock"]) await c(name).deleteMany({}); await fixture(); });
afterAll(async () => { await client?.close(); await repl?.stop(); });
it("signs the complete canonical unit with a server key and fails closed without the key", async () => {
  const row = (await c("units").findOne({}))!;
  expect(signatureStatus(row)).toBe("VALID");
  expect(row.sig).toBe(createHmac("sha256", Buffer.from(process.env.AUDIT_HMAC_SECRET!, "hex")).update("pulsegrid-unit-v1:" + canonical(without(row, ["sig"]))).digest("hex"));
  expect(signatureStatus({ ...row, tenantId: "other" })).toBe("MISMATCH");
  expect(signatureStatus({ ...row, injected: new Map() })).toBe("MISMATCH");
  const key = process.env.AUDIT_HMAC_SECRET; delete process.env.AUDIT_HMAC_SECRET;
  try { expect(() => signUnit(row)).toThrow("AUDIT_KEY_UNCONFIGURED"); } finally { process.env.AUDIT_HMAC_SECRET = key; }
});
it("concurrent writers serialize one chain and duplicate seq is rejected", async () => {
  await Promise.all(Array.from({ length: 12 }, (_, i) => new Operations(db, bank, at).post(["banks", "bank-1", "units", "audit-unit", "action"], { key: `storage-${i}`, type: "VERIFY_STORAGE", storage: "VERIFIED" })));
  const result = await verify(); expect(result.verification.ok).toBe(true); expect(result.unit.auditSeq).toBe(13);
  expect(result.events.map(e => e.seq)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
  await expect(c("unitEvents").insertOne({ ...result.events[0], _id: "duplicate", id: "duplicate" })).rejects.toMatchObject({ code: 11000 });
});
it("a failed event append rolls back unit, stock and operation receipt", async () => {
  await c("unitEvents").createIndex({ action: 1 }, { unique: true, name: "test_append_failure" });
  try {
    await new Operations(db, bank, at).post(["banks", "bank-1", "units", "audit-unit", "action"], { key: "first", type: "VERIFY_STORAGE", storage: "VERIFIED" });
    const before = await c("units").findOne({});
    await expect(new Operations(db, bank, at).post(["banks", "bank-1", "units", "audit-unit", "action"], { key: "second", type: "VERIFY_STORAGE", storage: "UNKNOWN" })).rejects.toMatchObject({ code: 11000 });
    expect(await c("units").findOne({})).toEqual(before); expect(await c("operations").countDocuments()).toBe(1);
  } finally { await c("unitEvents").dropIndex("test_append_failure"); }
});
it("direct unit tampering differs from a broken event and cannot be re-signed through an API action", async () => {
  await c("units").updateOne({}, { $set: { expiresAt: new Date(at.getTime() + 3 * 86400000) } });
  expect((await verify()).verification).toMatchObject({ chain: "VALID", signature: "MISMATCH", state: "MISMATCH", firstBadSeq: null });
  await expect(new Operations(db, bank, at).post(["banks", "bank-1", "units", "audit-unit", "action"], { key: "cannot-heal", type: "START_TESTING" })).rejects.toMatchObject({ code: "AUDIT_INTEGRITY_FAILED" });
  expect(await c("unitEvents").countDocuments()).toBe(1); expect(await c("operations").countDocuments()).toBe(0);
});
it("pinpoints changed event hashes and refuses to anchor corruption", async () => {
  await c("unitEvents").updateOne({}, { $set: { actorId: "manual-edit" } });
  expect((await verify()).verification).toMatchObject({ chain: "BROKEN", signature: "VALID", firstBadSeq: 1 });
  await expect(runDailyAnchor(db, at.toISOString())).rejects.toMatchObject({ code: "AUDIT_ANCHOR_REFUSED" });
  const report = await runAuditVerifier(db, at.toISOString()); expect(report.ok).toBe(false);
  expect(await c("operations").countDocuments({ tenantId: "state-audit-alert" })).toBe(1);
});
it("detects missing unit documents and unsigned legacy records", async () => {
  await c("units").deleteMany({});
  expect(await runAuditVerifier(db, at.toISOString())).toMatchObject({ ok: false, checked: 0, orphanEvents: 1 });
  const sealed = baseline({ _id: "legacy", id: "legacy", stateId: STATE_ID, tenantId: "tenant-bank-1", bankId: "bank-1", donorId: "synthetic", group: "O-", component: "PRBC", status: "COLLECTED", collectedAt: at, expiresAt: new Date(at.getTime() + 86400000) }, at);
  await c("units").insertOne(without(sealed.unit, ["sig", "auditSeq", "auditHead"]) as Row);
  const report = await runAuditVerifier(db, new Date(at.getTime() + 1000).toISOString());
  expect(report.failed[0]).toMatchObject({ chain: "UNTRACKED", signature: "UNSIGNED" });
});
it("daily anchors are replay-safe under races and retain historical commitments after append", async () => {
  const anchors = await Promise.all(Array.from({ length: 3 }, () => runDailyAnchor(db, at.toISOString())));
  expect(await c("anchors").countDocuments()).toBe(1); expect(anchors[1]).toEqual(anchors[0]);
  await new Operations(db, bank, at).post(["banks", "bank-1", "units", "audit-unit", "action"], { key: "later", type: "START_TESTING" });
  expect(await verifyAnchor(db, anchors[0])).toMatchObject({ ok: true });
  await c("unitEvents").updateOne({ seq: 1 }, { $set: { hash: "f".repeat(64) } });
  expect(await verifyAnchor(db, anchors[0])).toMatchObject({ ok: false, reason: "ANCHORED_HEAD_MISMATCH" });
});
it("passport and integrity APIs enforce roles, tenant membership, privacy and same origin writes", async () => {
  expect((await api("passport/audit-unit", bank)).status).toBe(200);
  const response = await api("passport/audit-unit", bank), data = await response.json();
  expect(data.verification.ok).toBe(true); expect(JSON.stringify(data)).not.toContain("synthetic-donor"); expect(JSON.stringify(data)).not.toContain("sig\"");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect((await api("passport/audit-unit", { ...bank, tenantId: "other" })).status).toBe(403);
  expect((await api("passport/absent", bank)).status).toBe(403);
  expect((await api("status", bank)).status).toBe(403);
  expect((await api("verify", admin, "POST", "https://attacker.test")).status).toBe(403);
  expect((await api("verify", admin, "POST")).status).toBe(200);
  expect((await (await api("status")).json()).report).toMatchObject({ ok: true, checked: 1 });
});
it("external publication exports only the root, is opt-in, and refuses to overwrite a different witness", async () => {
  const anchor = await runDailyAnchor(db, at.toISOString()), fetcher = vi.fn<typeof fetch>();
  const old = { ...process.env };
  try {
    delete process.env.AUDIT_GITHUB_ENABLED;
    expect(await publishGithubAnchor(anchor, fetcher)).toEqual({ status: "DISABLED" }); expect(fetcher).not.toHaveBeenCalled();
    process.env.AUDIT_GITHUB_ENABLED = "1"; process.env.GITHUB_ANCHOR_REPOSITORY = "operator/audit"; process.env.GITHUB_ANCHOR_BRANCH = "anchors"; process.env.GITHUB_ANCHOR_TOKEN = "test-only-token";
    fetcher.mockResolvedValueOnce(new Response("", { status: 404 })).mockResolvedValueOnce(Response.json({ content: { html_url: "https://github.com/operator/audit/commit/example" } }));
    expect((await publishGithubAnchor(anchor, fetcher)).status).toBe("PUBLISHED");
    const body = JSON.parse(fetcher.mock.calls[1][1]!.body as string), payload = Buffer.from(body.content, "base64").toString("utf8");
    expect(JSON.parse(payload)).toEqual(publicAnchor(anchor)); expect(payload).not.toContain("audit-unit"); expect(payload).not.toContain("tenant");
    fetcher.mockResolvedValueOnce(Response.json({ content: Buffer.from("changed").toString("base64") }));
    await expect(publishGithubAnchor(anchor, fetcher)).rejects.toMatchObject({ code: "EXTERNAL_ANCHOR_CONFLICT" }); expect(fetcher).toHaveBeenCalledTimes(3);
  } finally { process.env = old; }
});
it("optional email is disabled by default; failed checks create reviewable evidence", async () => {
  const fetcher = vi.fn<typeof fetch>(); delete process.env.AUDIT_EMAIL_ENABLED;
  await c("unitEvents").updateOne({}, { $set: { actorId: "tampered" } });
  const report = await runAuditVerifier(db, at.toISOString()); await sendAuditEmail(report, fetcher); expect(fetcher).not.toHaveBeenCalled();
  await mkdir(resolve("../_ai_context/artifacts"), { recursive: true });
  await writeFile(resolve("../_ai_context/artifacts/stage-11-audit.json"), JSON.stringify({ environment: "local MongoDB 8.0.17 replica set; injected identity; synthetic data", report, passport: (await verify()).verification, externalPublication: "mock transport only; no commit or email sent" }, null, 2) + "\n");
});

it("new seeds sign every imported baseline and reseeding does not repair tampered evidence", async () => {
  const seeded = client.db("pulsegrid_test_audit_seed");
  await seedRegistry(client, seeded, { confirm: seeded.databaseName, at: at.toISOString() });
  expect(await runAuditVerifier(seeded, at.toISOString())).toMatchObject({ ok: true, checked: 120, valid: 120 });
  await seeded.collection("unitEvents").updateOne({}, { $set: { actorId: "manual-tamper" } });
  await seedRegistry(client, seeded, { confirm: seeded.databaseName });
  expect((await runAuditVerifier(seeded, at.toISOString())).failed).toHaveLength(1);
});

it("optional staff email uses a stable retry key and sends no private unit identity", async () => {
  await c("unitEvents").updateOne({}, { $set: { actorId: "changed" } });
  const report = await runAuditVerifier(db, at.toISOString()), fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "mock-email" }));
  vi.stubEnv("AUDIT_EMAIL_ENABLED", "1"); vi.stubEnv("RESEND_API_KEY", "test-only"); vi.stubEnv("AUDIT_STAFF_EMAIL", "staff@example.test"); vi.stubEnv("AUDIT_EMAIL_FROM", "demo@example.test");
  try {
    expect(await sendAuditEmail(report, fetcher)).toEqual({ status: "SENT" });
    await sendAuditEmail(report, fetcher);
    expect(fetcher.mock.calls[0][1]!.headers).toEqual(fetcher.mock.calls[1][1]!.headers);
    const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(body.text).toContain("1 unit checks"); expect(JSON.stringify(body)).not.toContain("audit-unit");
    fetcher.mockResolvedValueOnce(new Response("", { status: 500 }));
    await expect(sendAuditEmail(report, fetcher)).rejects.toMatchObject({ code: "AUDIT_EMAIL_FAILED" });
  } finally { vi.unstubAllEnvs(); }
});
