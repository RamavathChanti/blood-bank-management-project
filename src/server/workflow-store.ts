import "server-only";
import { createHash } from "node:crypto";
import { MongoServerError, type ClientSession, type Db, type Document } from "mongodb";
import { parseDonor, parseRequest } from "../core/domain";
import { rankDonors, DEFAULT_WAVES, sizeWave } from "../core/emergency-matching";
import { readinessReasons } from "../core/inventory";
import { emergencyInput, signalInput, SIGNALS, workflowId, WORKFLOW_TERMINAL, WAVE_RADII, WAVE_WAIT_MS, RECHECK_MS } from "../core/workflow-events";
import { principalFromMetadata, type Principal } from "./identity";
import { Operations, unitModel } from "./operations";
import { deny, RegistryError, validate } from "./errors";
import { STATE_ID } from "./registry-constants";
import type { CreatedData, SignalData } from "../inngest/events";

export type WorkflowRow = Document & { _id: string };
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
export const workflowDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const location = (row: WorkflowRow) => ({ longitude: row.location.coordinates[0] as number, latitude: row.location.coordinates[1] as number });
const alive = (now: Date) => ({ $or: [{ audience: false, expireAt: { $exists: false } }, { audience: true, expireAt: { $type: "date", $gt: now } }] });
export function checkedActor(actor: Principal) {
  const { userId, ...metadata } = actor;
  return principalFromMetadata(workflowId(userId), metadata);
}
export function creationData(data: CreatedData): CreatedData {
  const actor = checkedActor(data.actor), input = validate(emergencyInput, data.input);
  if (actor.role !== "HOSPITAL") deny();
  const fingerprint = workflowDigest(input);
  const requestId = `emergency-${workflowDigest([actor.stateId, actor.tenantId, actor.hospitalId, input]).slice(0, 48)}`;
  if (data.fingerprint !== fingerprint || data.requestId !== requestId || !Number.isFinite(Date.parse(data.acceptedAt))) throw new RegistryError(400, "INVALID_EVENT");
  const duration = Date.parse(input.expectedTransfusionAt) - Date.parse(data.acceptedAt);
  if (duration <= 0 || duration > 86_400_000) throw new RegistryError(400, "DEADLINE_OUT_OF_RANGE");
  return { ...data, actor, input };
}
export class WorkflowStore {
  constructor(readonly db: Db, readonly now = new Date()) {}
  c(name: string) { return this.db.collection<WorkflowRow>(name); }
  async transaction<T>(run: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.db.client.startSession();
    try { return await session.withTransaction(() => run(session), { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, timeoutMS: 25_000 }); }
    finally { await session.endSession(); }
  }
  async request(requestId: string, session?: ClientSession) {
    const req = await this.c("requests").findOne({ _id: workflowId(requestId), stateId: STATE_ID, workflow: { $exists: true } }, { session });
    if (!req) throw new RegistryError(503, "WORKFLOW_RECORD_PENDING");
    return req;
  }
  actor(req: WorkflowRow): Principal { return { userId: "pulsegrid-workflow", role: "HOSPITAL", stateId: req.stateId, tenantId: req.tenantId, hospitalId: req.hospitalId }; }
  operations(req: WorkflowRow) { return new Operations(this.db, this.actor(req), this.now); }
  async initialize(raw: CreatedData, runId: string, eventId: string) {
    const data = creationData(raw), actor = data.actor;
    if (actor.role !== "HOSPITAL") deny();
    const member = await this.c("hospitals").findOne({ _id: actor.hospitalId, tenantId: actor.tenantId, stateId: actor.stateId });
    const reason = !member ? "HOSPITAL_MEMBERSHIP_UNAVAILABLE" : Date.parse(data.input.expectedTransfusionAt) <= this.now.getTime() ? "DEADLINE_PASSED_IN_QUEUE" : null;
    const { key: _key, ...input } = data.input; void _key;
    const status = reason ? "ESCALATED" : "OPEN";
    try {
      await this.c("requests").updateOne({ _id: data.requestId }, { $setOnInsert: { _id: data.requestId, id: data.requestId, stateId: actor.stateId, tenantId: actor.tenantId, hospitalId: actor.hospitalId, ...input, expectedTransfusionAt: new Date(input.expectedTransfusionAt), allocatedQuantity: 0, transfusedQuantity: 0, status, createdAt: new Date(data.acceptedAt), workflow: { fingerprint: data.fingerprint, status, reason, runId, eventId, acceptedAt: data.acceptedAt, updatedAt: this.now, waves: [], trace: [{ status, at: this.now }] } } }, { upsert: true });
    } catch (error) { if (!(error instanceof MongoServerError && error.code === 11000)) throw error; }
    const req = await this.request(data.requestId);
    if (req.tenantId !== actor.tenantId || req.workflow.fingerprint !== data.fingerprint) throw new RegistryError(409, "IDEMPOTENCY_KEY_REUSED");
    return { requestId: data.requestId, status: req.workflow.status as string };
  }
  async note(requestId: string, status: string, reason?: string) {
    const update: Document = { $set: { "workflow.status": status, "workflow.updatedAt": this.now, ...(reason ? { "workflow.reason": reason } : {}) }, $push: { "workflow.trace": { $each: [{ status, at: this.now }], $slice: -50 } } };
    await this.c("requests").updateOne({ _id: requestId, "workflow.status": { $nin: [...WORKFLOW_TERMINAL, status] } }, update);
  }
  async authorizeSignal(req: WorkflowRow, actor: Principal, kind: SignalData["kind"], input: SignalData["input"]) {
    if (actor.stateId !== req.stateId) deny();
    if (["cancel", "escalate", "handover", "synthetic-use"].includes(kind)) {
      if (actor.role !== "HOSPITAL" || actor.hospitalId !== req.hospitalId || actor.tenantId !== req.tenantId) deny();
      if (!await this.c("hospitals").findOne({ _id: actor.hospitalId, tenantId: actor.tenantId, stateId: actor.stateId })) deny("MEMBERSHIP_REQUIRED");
    }
    if (kind === "donor.reply") {
      if (actor.role !== "DONOR" || !("donorId" in input) || actor.donorId !== input.donorId) deny();
      if (!await this.c("donors").findOne({ _id: actor.donorId, tenantId: actor.tenantId, stateId: actor.stateId, ...alive(this.now) })) deny();
      if (!await this.c("alerts").findOne({ requestId: req.id, donorId: actor.donorId, stateId: actor.stateId })) deny("WAVE_MEMBERSHIP_REQUIRED");
    }
    if (kind === "stock.ready" || kind === "dispatch.approved") {
      if (actor.role !== "BANK" || !input.unitId) deny();
      if (!await this.c("banks").findOne({ _id: actor.bankId, tenantId: actor.tenantId, stateId: actor.stateId })) deny("MEMBERSHIP_REQUIRED");
      const unit = await this.c("units").findOne({ _id: input.unitId, stateId: actor.stateId, tenantId: actor.tenantId, bankId: actor.bankId });
      if (!unit) deny();
      if (kind === "stock.ready" && (unit.status !== "AVAILABLE" || readinessReasons(unitModel(unit), this.now.toISOString()).length)) throw new RegistryError(409, "STOCK_NOT_READY");
      if (kind === "dispatch.approved" && (!("allocationId" in input) || unit.status !== "RESERVED" || unit.reservation?.requestId !== req.id || unit.reservation?.allocationId !== input.allocationId || Date.parse(unit.reservation.leaseExpiresAt) <= this.now.getTime())) throw new RegistryError(409, "NO_ACTIVE_RESERVATION");
    }
    if (kind === "handover" || kind === "synthetic-use") {
      if (!("unitId" in input) || !("allocationId" in input) || !await this.c("allocations").findOne({ unitId: input.unitId, id: input.allocationId, requestId: req.id, hospitalId: req.hospitalId, hospitalTenantId: req.tenantId, stateId: req.stateId, status: { $in: ["ACTIVE", "ISSUED", "TRANSFUSED"] } })) deny();
    }
  }
  async ingest(raw: SignalData) {
    const kind = validate(value => { if (!SIGNALS.includes(value as SignalData["kind"])) throw new Error(); return value as SignalData["kind"]; }, raw.kind);
    const data: SignalData = { ...raw, requestId: validate(workflowId, raw.requestId), actor: checkedActor(raw.actor), kind, input: validate(v => signalInput(kind, v), raw.input) };
    const fingerprint = workflowDigest([data.requestId, data.actor, data.kind, data.input]);
    if (data.signalId !== `signal-${fingerprint}`) throw new RegistryError(400, "INVALID_EVENT");
    // Persist before processing. A cancellation may arrive before request initialization.
    await this.c("workflowSignals").updateOne({ _id: data.signalId }, { $setOnInsert: { _id: data.signalId, id: data.signalId, requestId: data.requestId, stateId: data.actor.stateId, tenantId: "tenantId" in data.actor ? data.actor.tenantId : "state", kind, fingerprint, data, status: "PENDING", createdAt: new Date(data.receivedAt) } }, { upsert: true });
    return { requestId: data.requestId };
  }
  async reconcile(requestId: string) {
    const req = await this.request(requestId);
    const pending = await this.c("workflowSignals").find({ requestId, status: "PENDING" }).sort({ createdAt: 1, _id: 1 }).limit(100).toArray();
    // Cancellation/escalation wins over approvals and replies delivered in the same batch.
    pending.sort((a, b) => Number(["cancel", "escalate"].includes(b.kind)) - Number(["cancel", "escalate"].includes(a.kind)));
    for (const signal of pending) {
      const data = signal.data as SignalData, body = data.input;
      try {
        const current = await this.request(requestId);
        if (WORKFLOW_TERMINAL.includes(current.workflow.status)) throw new RegistryError(409, "WORKFLOW_CLOSED");
        await this.authorizeSignal(current, data.actor, data.kind, body);
        if (data.kind === "cancel" || data.kind === "escalate") await this.operations(current).closeWorkflow(requestId, signal.id, data.kind === "cancel" ? "CANCELLED" : "ESCALATED", "STAFF_REQUESTED");
        if (data.kind === "donor.reply" && "donorId" in body) await this.c("alerts").updateOne({ requestId, donorId: body.donorId, status: "PENDING", deadlineAt: { $gt: new Date(data.receivedAt) } }, { $set: { status: body.reply, repliedAt: new Date(data.receivedAt) } });
        if (data.kind === "dispatch.approved" && "allocationId" in body && "preparationConfirmed" in body) await this.c("allocations").updateOne({ id: body.allocationId, unitId: body.unitId, requestId, status: "ACTIVE" }, { $set: { dispatchApproved: true, preparationConfirmed: body.preparationConfirmed } });
        if ((data.kind === "handover" || data.kind === "synthetic-use") && body.unitId) {
          const unit = await this.c("units").findOne({ _id: body.unitId, "reservation.requestId": requestId, "reservation.allocationId": body.allocationId });
          if (!unit || unit.status === "RESERVED" || data.kind === "synthetic-use" && !unit.handoverAt) continue; // Early delivery is retained, never treated as stock readiness.
          if (!(data.kind === "handover" && unit.handoverAt || data.kind === "synthetic-use" && unit.status === "TRANSFUSED")) await new Operations(this.db, data.actor, this.now).post(["hospitals", current.hospitalId, "units", body.unitId, "action"], { key: signal.id, type: data.kind === "handover" ? "HANDOVER" : "TRANSFUSE" });
        }
        await this.c("workflowSignals").updateOne({ _id: signal.id }, { $set: { status: "APPLIED", processedAt: this.now } });
      } catch (error) {
        if (!(error instanceof RegistryError) || error.status >= 500) throw error;
        await this.c("workflowSignals").updateOne({ _id: signal.id }, { $set: { status: "REJECTED", reason: error.code, processedAt: this.now } });
      }
    }
    return { processed: pending.length, hospitalId: req.hospitalId };
  }
  async reserve(requestId: string, round: number) {
    await this.maintain(requestId, round);
    const req = await this.request(requestId);
    if (WORKFLOW_TERMINAL.includes(req.workflow.status) || ["CANCELLED", "COMPLETED", "ESCALATED"].includes(req.status) || req.expectedTransfusionAt <= this.now) return { reserved: 0 };
    const ops = this.operations(req);
    await this.note(requestId, (await this.c("alerts").countDocuments({ requestId, status: "ACCEPTED" })) ? "AWAITING_SCREENED_STOCK" : "STOCK_SEARCH");
    let reserved = 0;
    for (let index = 0; index < req.quantity; index++) {
      const result = await ops.post(["hospitals", req.hospitalId, "requests", requestId, "reserve"], { key: `${requestId}-${round}-${index}` });
      if (!result.reserved) break;
      reserved++;
    }
    return { reserved };
  }
  async maintain(requestId: string, round: number) {
    const req = await this.request(requestId);
    if (WORKFLOW_TERMINAL.includes(req.workflow.status) || ["COMPLETED", "CANCELLED", "ESCALATED"].includes(req.status)) return;
    await this.operations(req).post(["hospitals", req.hospitalId, "maintain"], { key: `${requestId}-${round}-maintain` });
  }
  async wave(requestId: string, index: number) {
    if (index < 0 || index >= WAVE_RADII.length) throw new RegistryError(400, "INVALID_WAVE");
    return this.transaction(async session => {
      const req = await this.request(requestId, session);
      const existing = req.workflow.waves.find((w: Document) => w.index === index);
      if (existing) return existing;
      if (WORKFLOW_TERMINAL.includes(req.workflow.status) || req.expectedTransfusionAt <= this.now || req.allocatedQuantity >= req.quantity) return { index, count: 0 };
      const hospital = await this.c("hospitals").findOne({ _id: req.hospitalId, tenantId: req.tenantId, stateId: req.stateId }, { session });
      if (!hospital) deny("MEMBERSHIP_REQUIRED");
      const banks = await this.c("banks").aggregate<WorkflowRow>([{ $geoNear: { near: hospital.location, distanceField: "distance", maxDistance: 250_000, spherical: true, query: { stateId: req.stateId } } }, { $limit: 1 }], { session }).toArray();
      const bank = banks[0];
      const rows = bank ? await this.c("donors").aggregate<WorkflowRow>([{ $geoNear: { near: bank.location, distanceField: "distance", maxDistance: WAVE_RADII[index] * 1000, spherical: true, query: { stateId: req.stateId, ...alive(this.now), optedOut: { $ne: true } } } }, { $limit: 5000 }], { session }).toArray() : [];
      const recent = await this.c("alerts").find({ stateId: req.stateId, createdAt: { $gt: new Date(this.now.getTime() - 30 * 86_400_000) } }, { session }).limit(20_001).toArray();
      if (recent.length > 20_000) throw new RegistryError(503, "ALERT_SCAN_BOUND_REACHED");
      const already = await this.c("alerts").find({ requestId }, { session }).toArray();
      const profiles = rows.flatMap(row => {
        try {
          const donor = parseDonor(Object.fromEntries(["id", "nickname", "group", "birthDate", "weightKg", "haemoglobin", "donationVolumeMl", "lastDonationAt", "eligibleFrom", "deferrals"].map(k => [k, row[k] instanceof Date ? row[k].toISOString() : row[k]]).concat([["location", location(row)]])));
          const alerts = recent.filter(a => a.donorId === row.id).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          return [{ donor, reliability: .8, alertsThisMonth: alerts.length, lastAlertAt: alerts[0]?.createdAt.toISOString() }];
        } catch { return []; }
      });
      const request = parseRequest({ ...Object.fromEntries(["id", "hospitalId", "group", "component", "quantity", "allocatedQuantity", "transfusedQuantity", "urgency", "status"].map(k => [k, req[k]])), expectedTransfusionAt: req.expectedTransfusionAt.toISOString() });
      const ranked = bank ? rankDonors(profiles, request, { id: bank.id, name: bank.name, district: bank.district, location: location(bank) }, this.now.toISOString(), DEFAULT_WAVES, already.map(a => a.donorId)).filter(p => !p.reasons.length) : [];
      const needed = Math.max(0, req.quantity - req.allocatedQuantity - already.filter(a => a.status === "ACCEPTED").length);
      const sizing = sizeWave(needed, DEFAULT_WAVES.acceptanceRate, ranked.length);
      const deadlineAt = new Date(Math.min(this.now.getTime() + WAVE_WAIT_MS, req.expectedTransfusionAt.getTime()));
      for (const profile of ranked.slice(0, sizing.count)) {
        const donor = rows.find(d => d.id === profile.donor.id)!;
        // Serialize competing requests' fatigue decisions on the donor document.
        await this.c("donors").updateOne({ _id: donor.id }, { $inc: { alertRevision: 1 } }, { session });
        const id = `alert-${workflowDigest([requestId, donor.id])}`;
        await this.c("alerts").insertOne({ _id: id, id, stateId: req.stateId, tenantId: donor.tenantId, donorId: donor.id, requestId, status: "PENDING", createdAt: this.now, deadlineAt, wave: index, channel: "IN_APP", collectionBankId: bank.id, ...(donor.audience ? { expireAt: donor.expireAt } : {}) }, { session });
      }
      const wave = { index, radiusKm: WAVE_RADII[index], count: sizing.count, probability: sizing.probability, targetMet: sizing.targetMet, openedAt: this.now, deadlineAt, collectionBankId: bank?.id ?? null };
      await this.c("requests").updateOne({ _id: requestId }, { $set: { "workflow.waves": [...req.workflow.waves, wave], "workflow.updatedAt": this.now } }, { session });
      return wave;
    });
  }
  async dispatch(requestId: string, round: number) {
    const req = await this.request(requestId);
    return this.operations(req).dispatchWorkflow(requestId, `${requestId}-dispatch-${round}`);
  }
  async close(requestId: string, outcome: "CANCELLED" | "ESCALATED", reason: string) {
    const req = await this.request(requestId);
    return this.operations(req).closeWorkflow(requestId, `${requestId}-close-${outcome}`, outcome, reason);
  }
  async snapshot(requestId: string) {
    const req = await this.request(requestId);
    if (["COMPLETED", "CANCELLED", "ESCALATED"].includes(req.status)) await this.note(requestId, req.status);
    const slots = await this.c("allocations").find({ requestId, stateId: req.stateId, hospitalTenantId: req.tenantId, hospitalId: req.hospitalId, status: { $ne: "RELEASED" } }).limit(21).toArray();
    const alerts = await this.c("alerts").find({ requestId, status: "ACCEPTED" }).toArray();
    const waves = req.workflow.waves as { index: number; deadlineAt: Date; count: number }[];
    const last = waves.at(-1);
    return { status: ["COMPLETED", "CANCELLED", "ESCALATED"].includes(req.status) ? req.status as string : req.workflow.status as string, quantity: req.quantity as number, allocated: req.allocatedQuantity as number, transfused: req.transfusedQuantity as number, issued: slots.filter(s => s.status === "ISSUED" || s.status === "TRANSFUSED").length, handedOver: slots.filter(s => s.handoverAt || s.status === "TRANSFUSED").length, acceptedDonors: alerts.length, waveCount: waves.length, waveDue: !last || last.deadlineAt <= this.now, due: req.expectedTransfusionAt <= this.now, nextWakeAt: new Date(Math.min(this.now.getTime() + RECHECK_MS, req.expectedTransfusionAt.getTime(), last && last.deadlineAt > this.now ? last.deadlineAt.getTime() : Infinity)).toISOString() };
  }
}
