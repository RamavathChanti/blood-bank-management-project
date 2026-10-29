import { baseline } from "../../src/server/audit";
import { workflowFailure } from "../../src/server/workflow-alerts";
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { MongoClient, type Db, type Document } from "mongodb";
import { resolve } from "node:path";
import { ensureSchema } from "../../src/server/schema";
import { WorkflowStore, workflowDigest, type WorkflowRow } from "../../src/server/workflow-store";
import { emergencyHandler, type EmergencyDependencies } from "../../src/server/emergency-api";
import { Operations } from "../../src/server/operations";
import { STATE_ID } from "../../src/server/registry-constants";
import { orchestrate, type DurableSteps } from "../../src/inngest/orchestrate";
import type { CreatedData, SignalData } from "../../src/inngest/events";
import type { Principal } from "../../src/server/identity";
import { emergencyInput, type SignalInput, type SignalKind } from "../../src/core/workflow-events";

let repl: MongoMemoryReplSet, client: MongoClient, db: Db;
const start = new Date("2026-10-29T09:00:00.000Z"); let now = start;
const hospital: Principal = { userId: "hospital-user", role: "HOSPITAL", hospitalId: "hospital-1", tenantId: "tenant-hospital-1", stateId: STATE_ID };
const bank: Principal = { userId: "bank-user", role: "BANK", bankId: "bank-1", tenantId: "tenant-bank-1", stateId: STATE_ID };
const donor: Principal = { userId: "donor-user", role: "DONOR", donorId: "donor-1", tenantId: "tenant-donor-1", stateId: STATE_ID };
const c = (name: string) => db.collection<WorkflowRow>(name);
const store = () => new WorkflowStore(db, now);
function data(extra: Document = {}): CreatedData {
  const input = emergencyInput({ key: "test-emergency", group: "O-", component: "PRBC", quantity: 1, urgency: "CRITICAL", expectedTransfusionAt: new Date(start.getTime() + 12 * 3_600_000).toISOString(), ...extra });
  const requestId = `emergency-${workflowDigest([STATE_ID, "tenant-hospital-1", "hospital-1", input]).slice(0, 48)}`;
  return { input, actor: hospital, requestId, fingerprint: workflowDigest(input), acceptedAt: start.toISOString() };
}
async function init(input = data()) { await store().initialize(input, "test-run", "test-event"); return input; }
async function unit(id = "unit-1", extra: Document = {}) {
  const sealed = baseline({ _id: id, id, stateId: STATE_ID, tenantId: "tenant-bank-1", bankId: "bank-1", donorId: "donor-1", group: "O-", component: "PRBC", product: "PRBC_SAGM", collectedAt: new Date(start.getTime() - 86_400_000), expiresAt: new Date(start.getTime() + 86_400_000), status: "AVAILABLE", screening: { HIV: "NON_REACTIVE", HEPATITIS_B: "NON_REACTIVE", HEPATITIS_C: "NON_REACTIVE", SYPHILIS: "NON_REACTIVE", MALARIA: "NON_REACTIVE" }, storage: "VERIFIED", ...extra }, start);
  await c("units").insertOne(sealed.unit);
  await c("unitEvents").insertOne(sealed.event);
}
async function signal(requestId: string, kind: SignalKind, input: SignalInput, actor = hospital) {
  const signalId = `signal-${workflowDigest([requestId, actor, kind, input])}`;
  const value: SignalData = { requestId, actor, kind, input, signalId, receivedAt: now.toISOString() };
  await store().ingest(value); return value;
}
async function approve(requestId: string) {
  for (const slot of await c("allocations").find({ requestId, status: "ACTIVE" }).toArray()) await signal(requestId, "dispatch.approved", { key: `approve-${slot.id}`, unitId: slot.unitId, allocationId: slot.id, preparationConfirmed: true }, bank);
  await store().reconcile(requestId);
}
async function handoverAndUse(requestId: string) {
  for (const slot of await c("allocations").find({ requestId, status: "ISSUED" }).toArray()) {
    await signal(requestId, "handover", { key: `handover-${slot.id}`, unitId: slot.unitId, allocationId: slot.id });
    await signal(requestId, "synthetic-use", { key: `use-${slot.id}`, unitId: slot.unitId, allocationId: slot.id });
  }
  await store().reconcile(requestId); await store().reconcile(requestId);
}
function journal(wait: (index: number, until: string) => Promise<void>, failAfter?: string) {
  const outputs = new Map<string, unknown>(); let waits = 0, failed = false;
  const steps: DurableSteps = {
    run: async <T>(id: string, action: () => Promise<T>) => {
      if (outputs.has(id)) return structuredClone(outputs.get(id)) as T;
      const result = await action();
      if (!failed && id === failAfter) { failed = true; throw new Error("lost step response"); }
      const serialized = JSON.parse(JSON.stringify(result ?? null)); outputs.set(id, serialized); return serialized as T;
    },
    wait: async (_id, until) => { if (++waits > 20) throw new Error("test wait bound"); await wait(waits, until); },
    escalation: async () => {}
  };
  return { steps, outputs };
}
let sent: { id: string; data: CreatedData | SignalData }[];
it("retains deduplicated workflow failure alerts and preserves already completed outcomes", async () => {
  const request = await init();
  await workflowFailure(request.requestId, "orchestration", async () => db);
  await workflowFailure(request.requestId, "orchestration", async () => db);
  expect((await c("requests").findOne({ _id: request.requestId }))?.workflow.status).toBe("FAILED");
  expect(await c("operations").countDocuments({ tenantId: "state-workflow-alert" })).toBe(1);
  await c("requests").updateOne({ _id: request.requestId }, { $set: { "workflow.status": "COMPLETED" } });
  await workflowFailure(request.requestId, "signal", async () => db);
  expect((await c("requests").findOne({ _id: request.requestId }))?.workflow.status).toBe("COMPLETED");
  expect(await c("operations").countDocuments({ tenantId: "state-workflow-alert" })).toBe(2);
});
const deps = (overrides: Partial<EmergencyDependencies> = {}): EmergencyDependencies => ({ identity: async () => hospital, database: async () => db, send: async payload => { sent.push(payload); return { ids: [payload.id] }; }, configured: () => {}, secret: () => "test-receipt-secret-with-at-least-32-characters", now: () => now, log: () => {}, ...overrides });
async function api(path = "", body?: unknown, overrides: Partial<EmergencyDependencies> = {}, receipt?: string) {
  const response = await emergencyHandler(deps(overrides))(new Request(`https://registry.test/api/emergencies${path ? `/${path}` : ""}`, { method: body ? "POST" : "GET", headers: { origin: "https://registry.test", "content-type": "application/json", ...(receipt ? { "x-emergency-receipt": receipt } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), path ? path.split("/") : []);
  return { status: response.status, body: await response.json(), headers: response.headers };
}
beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ binary: { version: "8.0.17", downloadDir: resolve(".tools/mongodb") }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  client = await new MongoClient(repl.getUri(), { maxPoolSize: 10 }).connect(); db = client.db("pulsegrid_test_stage7"); await ensureSchema(db);
});
beforeEach(async () => {
  now = new Date(start); sent = [];
  for (const name of ["banks", "hospitals", "donors", "units", "requests", "allocations", "unitEvents", "stock", "alerts", "operations", "workflowSignals"]) await c(name).deleteMany({});
  for (const [kind, id] of [["banks", "bank-1"], ["hospitals", "hospital-1"]]) await c(kind).insertOne({ _id: id, id, stateId: STATE_ID, tenantId: `tenant-${id}`, name: `Synthetic ${id}`, district: "Mumbai City", location: { type: "Point", coordinates: [72.8, 19] } });
  await c("donors").insertOne({ _id: "donor-1", id: "donor-1", stateId: STATE_ID, tenantId: "tenant-donor-1", nickname: "Synthetic donor", group: "O-", location: { type: "Point", coordinates: [72.8, 19] }, eligibleFrom: new Date(0), audience: false, birthDate: "2000-01-01", weightKg: 65, haemoglobin: 14, donationVolumeMl: 450, deferrals: [] });
});
afterAll(async () => { await client?.close(); await repl?.stop(); });

describe("durable acknowledgement and tenant boundaries", () => {
  it("prevents urgent/critical intake from bypassing Inngest through the old registry endpoint", async () => {
    for (const urgency of ["URGENT", "CRITICAL"]) await expect(new Operations(db, hospital, now).post(["hospitals", "hospital-1", "requests"], { ...data().input, urgency })).rejects.toMatchObject({ code: "USE_DURABLE_EMERGENCY_INTAKE" });
    expect(await c("requests").countDocuments()).toBe(0);
  });
  it("acknowledges without any database call, retains a verifiable pending receipt through outage", async () => {
    const unavailable = vi.fn(async (): Promise<Db> => { throw new Error("synthetic outage"); });
    const result = await api("", data().input, { database: unavailable });
    expect(result.status).toBe(202); expect(unavailable).not.toHaveBeenCalled(); expect(sent).toHaveLength(1);
    const pending = await api(result.body.requestId, undefined, {}, result.body.receipt);
    expect(pending.status).toBe(202); expect(pending.body.status).toBe("ACKNOWLEDGED_PENDING");
    const down = await api(result.body.requestId, undefined, { database: unavailable }, result.body.receipt);
    expect(down.status).toBe(503); expect(down.body).toMatchObject({ accepted: true, status: "ACKNOWLEDGED_STATUS_UNAVAILABLE", requestId: result.body.requestId });
    const cancel = await api(`${result.body.requestId}/cancel`, { key: "cancel" }, { database: unavailable }, result.body.receipt);
    expect(cancel.status).toBe(202);
    await store().ingest(sent[1].data as SignalData); // Cancel arrives before creation.
    await store().initialize(sent[0].data as CreatedData, "recovered-run", "created-event"); await store().reconcile(result.body.requestId);
    expect((await store().snapshot(result.body.requestId)).status).toBe("CANCELLED");
  });
  it("reports unknown acknowledgement on send failure and retries the same event/request ID", async () => {
    const failed = await api("", data().input, { send: async () => { throw new Error("provider secret never leaks"); } });
    expect(failed.status).toBe(503); expect(failed.body.accepted).toBe(false); expect(JSON.stringify(failed.body)).not.toContain("provider secret");
    const first = await api("", data().input), second = await api("", data().input);
    expect(first.body.requestId).toBe(failed.body.requestId); expect(second.body.requestId).toBe(first.body.requestId); expect(sent[0].id).toBe(sent[1].id);
  });
  it("does not accept an empty provider acknowledgement", async () => {
    const result = await api("", data().input, { send: async () => ({ ids: [] }) });
    expect(result.status).toBe(503); expect(result.body).not.toHaveProperty("accepted", true);
  });
  it("rejects forged receipts, unknown request IDs and cross-tenant access", async () => {
    const ack = await api("", data().input);
    expect((await api(ack.body.requestId)).status).toBe(403);
    expect((await api(ack.body.requestId, undefined, {}, `${ack.body.receipt}tampered`)).status).toBe(403);
    const other: Principal = { ...hospital, role: "HOSPITAL", hospitalId: "hospital-2", tenantId: "tenant-hospital-2" };
    expect((await api(ack.body.requestId, undefined, { identity: async () => other }, ack.body.receipt)).status).toBe(403);
    await init(); expect((await api(data().requestId, undefined, { identity: async () => other })).status).toBe(403);
    expect((await api(data().requestId)).headers.get("cache-control")).toContain("private, no-store");
  });
  it.each(["quantity", "expectedTransfusionAt", "tenantId", "urgency"])("validates intake %s before send", async field => {
    const invalid = { ...data().input, [field]: field === "quantity" ? 0 : field === "urgency" ? "ROUTINE" : "invalid" };
    expect((await api("", invalid)).status).toBe(400); expect(sent).toHaveLength(0);
  });
  it("denies non-hospital intake and fails closed without identity", async () => {
    expect((await api("", data().input, { identity: async () => bank })).status).toBe(403);
    expect((await api("", data().input, { identity: async () => { throw new Error("auth outage"); } })).status).toBe(503); expect(sent).toHaveLength(0);
  });
  it("stores delayed requests as escalated rather than fabricating fulfilment", async () => {
    now = new Date(start.getTime() + 13 * 3_600_000); const d = await init();
    expect((await store().snapshot(d.requestId)).status).toBe("ESCALATED"); expect(await c("allocations").countDocuments()).toBe(0);
  });
});

describe("real transaction workflow paths with injected durable waits", () => {
  it("completes stock, approval, dispatch, early handover and synthetic use with no duplicate side effects", async () => {
    await unit(); const d = data();
    const replay = journal(async index => { if (index === 1) { await approve(d.requestId); const slot = await c("allocations").findOne({ requestId: d.requestId }); await signal(d.requestId, "handover", { key: "early", unitId: slot!.unitId, allocationId: slot!.id }); await store().reconcile(d.requestId); expect((await c("units").findOne({ _id: "unit-1" }))!.status).toBe("RESERVED"); } else await handoverAndUse(d.requestId); });
    const outcome = await orchestrate(d, "stock-run", "stock-event", replay.steps, async () => store());
    expect(outcome.status).toBe("COMPLETED"); expect(await c("allocations").countDocuments()).toBe(1); expect(await c("unitEvents").countDocuments({ action: "ISSUE" })).toBe(1); expect(await c("alerts").countDocuments()).toBe(0);
    await orchestrate(d, "stock-run", "stock-event", replay.steps, async () => store());
    expect(await c("unitEvents").countDocuments({ action: "TRANSFUSE" })).toBe(1);
  });
  it("retries after a committed reservation loses its step response", async () => {
    await unit(); const d = data(); const replay = journal(async index => { if (index === 1) await approve(d.requestId); else await handoverAndUse(d.requestId); }, "atomic-reservation-0");
    await expect(orchestrate(d, "retry-run", "event", replay.steps, async () => store())).rejects.toThrow("lost step response");
    const result = await orchestrate(d, "retry-run", "event", replay.steps, async () => store());
    expect(result.status).toBe("COMPLETED"); expect(await c("unitEvents").countDocuments({ action: "RESERVE" })).toBe(1); expect(await c("allocations").countDocuments()).toBe(1);
  });
  it("recovers via donor waves, preserving acceptance separately from screened stock", async () => {
    const d = data();
    const replay = journal(async index => {
      if (index === 1) {
        const reply = await signal(d.requestId, "donor.reply", { key: "accept", donorId: "donor-1", reply: "ACCEPTED" }, donor);
        await store().ingest(reply); await store().reconcile(d.requestId);
        expect(await c("units").countDocuments()).toBe(0); expect((await store().snapshot(d.requestId)).allocated).toBe(0);
      } else if (index === 2) await unit(); // Separate completed collection/screening fixture.
      else if (index === 3) await approve(d.requestId);
      else await handoverAndUse(d.requestId);
    });
    expect((await orchestrate(d, "donor-run", "event", replay.steps, async () => store())).status).toBe("COMPLETED");
    expect(await c("alerts").countDocuments()).toBe(1); expect((await c("alerts").findOne({ donorId: "donor-1" }))!.status).toBe("ACCEPTED");
  });
  it("exhausts 5/10/25 km waves and releases partial reservations", async () => {
    await c("donors").deleteMany({}); await unit(); const d = data({ quantity: 2 });
    const replay = journal(async (_index, until) => { now = new Date(until); });
    expect((await orchestrate(d, "exhausted", "event", replay.steps, async () => store())).status).toBe("ESCALATED");
    const req = await store().request(d.requestId); expect(req.workflow.waves.map((w: Document) => w.radiusKm)).toEqual([5, 10, 25]); expect(req.workflow.reason).toBe("DONOR_WAVES_EXHAUSTED"); expect(req.allocatedQuantity).toBe(0); expect(await c("allocations").countDocuments({ status: "ACTIVE" })).toBe(0);
  });
  it("escalates a missing handover at deadline and retains issued ownership for review", async () => {
    await unit(); const d = data({ expectedTransfusionAt: new Date(start.getTime() + 15 * 60_000).toISOString() });
    const replay = journal(async (index, until) => { if (index === 1) await approve(d.requestId); else now = new Date(until); });
    expect((await orchestrate(d, "timeout", "event", replay.steps, async () => store())).status).toBe("ESCALATED");
    expect(await c("allocations").countDocuments({ status: "ISSUED" })).toBe(1); expect((await store().request(d.requestId)).transfusedQuantity).toBe(0);
  });
  it("cancels a sleeping request before dispatch, releasing its reservation", async () => {
    await unit(); const d = data(); const replay = journal(async () => { await signal(d.requestId, "cancel", { key: "cancel" }); });
    expect((await orchestrate(d, "cancel", "event", replay.steps, async () => store())).status).toBe("CANCELLED"); expect((await c("units").findOne({ _id: "unit-1" }))!.status).toBe("AVAILABLE");
  });
  it("cancellation after dispatch escalates for review without reissuing the unit", async () => {
    await unit(); const d = await init(); await store().reserve(d.requestId, 0); await approve(d.requestId); await store().dispatch(d.requestId, 0);
    await signal(d.requestId, "cancel", { key: "cancel-issued" }); await store().reconcile(d.requestId);
    expect((await store().snapshot(d.requestId)).status).toBe("ESCALATED"); expect((await c("units").findOne({ _id: "unit-1" }))!.status).toBe("ISSUED");
  });
});

describe("idempotency, correlation and readiness gates", () => {
  it("duplicates initialization, notification waves and responses without duplicate records", async () => {
    const d = data(); await Promise.all(Array.from({ length: 5 }, () => store().initialize(d, "run", "event")));
    await store().wave(d.requestId, 0); await store().wave(d.requestId, 0);
    const response = await signal(d.requestId, "donor.reply", { key: "reply", donorId: "donor-1", reply: "ACCEPTED" }, donor);
    await store().ingest(response); await store().reconcile(d.requestId); await store().reconcile(d.requestId);
    expect(await c("requests").countDocuments()).toBe(1); expect(await c("alerts").countDocuments()).toBe(1); expect(await c("workflowSignals").countDocuments()).toBe(1);
  });
  it("enforces alert cooldown across different requests", async () => {
    const a = await init(), b = await init(data({ key: "second" })); await store().wave(a.requestId, 0); await store().wave(b.requestId, 0);
    expect(await c("alerts").countDocuments()).toBe(1);
  });
  it("serializes concurrent wave fatigue decisions across requests", async () => {
    const a = await init(), b = await init(data({ key: "concurrent-second" }));
    await Promise.all([store().wave(a.requestId, 0), store().wave(b.requestId, 0)]);
    expect(await c("alerts").countDocuments()).toBe(1);
    expect((await store().request(a.requestId)).workflow.waves).toHaveLength(1);
    expect((await store().request(b.requestId)).workflow.waves).toHaveLength(1);
  });
  it("requires explicit plasma preparation before atomic workflow dispatch", async () => {
    await unit("plasma-unit", { component: "FFP", product: "FFP_FROZEN" });
    const d = await init(data({ component: "FFP" })); await store().reserve(d.requestId, 0);
    const slot = await c("allocations").findOne({ requestId: d.requestId });
    await signal(d.requestId, "dispatch.approved", { key: "unprepared", unitId: slot!.unitId, allocationId: slot!.id, preparationConfirmed: false }, bank); await store().reconcile(d.requestId);
    expect(await store().dispatch(d.requestId, 0)).toMatchObject({ dispatched: false, reason: "BANK_APPROVAL_REQUIRED" });
    await signal(d.requestId, "dispatch.approved", { key: "prepared", unitId: slot!.unitId, allocationId: slot!.id, preparationConfirmed: true }, bank); await store().reconcile(d.requestId);
    expect(await store().dispatch(d.requestId, 1)).toMatchObject({ dispatched: true });
    expect((await c("units").findOne({ _id: "plasma-unit" }))!.preparationConfirmedAt).toEqual(now);
  });
  it("denies donor replies outside wave membership and after audience logical expiry", async () => {
    const d = await init(); expect((await api(`${d.requestId}/donor.reply`, { key: "reply", donorId: "donor-1", reply: "ACCEPTED" }, { identity: async () => donor })).status).toBe(403);
    await store().wave(d.requestId, 0); await c("donors").updateOne({ _id: "donor-1" }, { $set: { audience: true, expireAt: now } });
    expect((await api(`${d.requestId}/donor.reply`, { key: "reply", donorId: "donor-1", reply: "ACCEPTED" }, { identity: async () => donor })).status).toBe(403);
  });
  it("does not turn a late reply or a reply for another request into an acceptance", async () => {
    const d = await init(); await store().wave(d.requestId, 0); now = new Date(start.getTime() + 4 * 60_000);
    await signal(d.requestId, "donor.reply", { key: "late", donorId: "donor-1", reply: "ACCEPTED" }, donor); await store().reconcile(d.requestId);
    expect((await store().snapshot(d.requestId)).acceptedDonors).toBe(0);
    const other = await init(data({ key: "other" })); await signal(other.requestId, "donor.reply", { key: "wrong-request", donorId: "donor-1", reply: "ACCEPTED" }, donor); await store().reconcile(other.requestId);
    expect((await c("workflowSignals").findOne({ requestId: other.requestId }))!.status).toBe("REJECTED");
  });
  it("rechecks required quantity and issues nothing on partial coverage", async () => {
    await unit(); const d = await init(data({ quantity: 2 })); await store().reserve(d.requestId, 0); await approve(d.requestId);
    expect(await store().dispatch(d.requestId, 0)).toMatchObject({ dispatched: false, reason: "UNMET_QUANTITY" }); expect(await c("units").countDocuments({ status: "ISSUED" })).toBe(0);
  });
  it("blocks unapproved stock, manual issue bypass and cancelled request bypass", async () => {
    await unit(); const d = await init(); await store().reserve(d.requestId, 0);
    expect(await store().dispatch(d.requestId, 0)).toMatchObject({ dispatched: false, reason: "BANK_APPROVAL_REQUIRED" });
    await expect(new Operations(db, bank, now).post(["banks", "bank-1", "units", "unit-1", "action"], { key: "bypass", type: "ISSUE", preparationConfirmed: true })).rejects.toMatchObject({ code: "USE_WORKFLOW_DISPATCH_APPROVAL" });
    await expect(new Operations(db, hospital, now).post(["hospitals", "hospital-1", "requests", d.requestId, "cancel"], { key: "cancel" })).rejects.toMatchObject({ code: "USE_DURABLE_CANCELLATION" });
  });
  it("rejects stale unit/allocation approvals after lease expiry and reacquisition", async () => {
    await unit(); const d = await init(); await store().reserve(d.requestId, 0); const first = await c("allocations").findOne({ requestId: d.requestId });
    await signal(d.requestId, "dispatch.approved", { key: "stale", unitId: "unit-1", allocationId: first!.id, preparationConfirmed: true }, bank);
    now = new Date(start.getTime() + 10 * 60_000); await store().reserve(d.requestId, 1); await store().reconcile(d.requestId);
    const next = await c("allocations").findOne({ requestId: d.requestId }); expect(next!.id).not.toBe(first!.id); expect(next!.dispatchApproved).not.toBe(true);
    expect(await store().dispatch(d.requestId, 1)).toMatchObject({ dispatched: false, reason: "BANK_APPROVAL_REQUIRED" });
  });
  it("issues none of a batch when any reserved unit fails readiness", async () => {
    await unit("unit-1"); await unit("unit-2"); const d = await init(data({ quantity: 2 })); await store().reserve(d.requestId, 0); await approve(d.requestId);
    await c("units").updateOne({ _id: "unit-2" }, { $set: { "screening.HIV": "REACTIVE" } });
    expect(await store().dispatch(d.requestId, 0)).toMatchObject({ dispatched: false, reason: "STOCK_NOT_READY" }); expect(await c("unitEvents").countDocuments({ action: "ISSUE" })).toBe(0);
  });
  it("does not send alerts to quiet-hour noncritical, opted-out or invalid donors", async () => {
    now = new Date("2026-10-29T18:00:00.000Z"); const d = await init(data({ urgency: "URGENT" })); await store().wave(d.requestId, 0); expect(await c("alerts").countDocuments()).toBe(0);
    now = new Date(start); await c("donors").updateOne({ _id: "donor-1" }, { $set: { optedOut: true } }); const other = await init(data({ key: "opt-out" })); await store().wave(other.requestId, 0); expect(await c("alerts").countDocuments()).toBe(0);
  });
});
