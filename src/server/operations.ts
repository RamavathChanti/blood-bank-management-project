import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { MongoServerError, type ClientSession, type Db, type Document, type Filter } from "mongodb";
import { componentFor, GROUPS, PRODUCTS, parseRequest, parseUnit, type BloodRequest, type Unit } from "../core/domain";
import { compatibilityPreference, preferenceTier } from "../core/compatibility";
import { readinessReasons, stockReasons } from "../core/inventory";
import { createCollectedUnit, transitionUnit, type UnitCommand } from "../core/lifecycle";
import * as v from "../core/validation";
import { deny, RegistryError, validate } from "./errors";
import { appendChange } from "./audit";
import type { Principal } from "./identity";
import { temperatureSample, storageBreach } from "../core/cold-chain";

type Row = Document & { _id: string };
const id = (value: unknown) => { const s = v.text(value); if (!/^[a-zA-Z0-9_-]{1,128}$/.test(s)) throw new Error("Invalid ID"); return s; };
const key = { key: id };
const requestInput = v.object({ ...key, group: v.oneOf(GROUPS), component: v.oneOf(["PRBC", "PLATELETS", "FFP"]), quantity: v.number(1, 20, true), urgency: v.oneOf(["ROUTINE", "URGENT", "CRITICAL"]), expectedTransfusionAt: v.instant });
const collectInput = v.object({ ...key, donorId: id, group: v.oneOf(GROUPS), product: v.oneOf(PRODUCTS), collectedAt: v.instant });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function conflict(code = "LIFECYCLE_CONFLICT"): never { throw new RegistryError(409, code); }
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : value;
export function unitModel(row: Row): Unit {
  return parseUnit(Object.fromEntries(["id", "bankId", "donorId", "group", "component", "product", "collectedAt", "expiresAt", "status", "screening", "storage", "reservation", "handoverAt", "preparationConfirmedAt", "lastEventAt"].map(k => [k, iso(row[k])])));
}
function requestModel(row: Row): BloodRequest {
  return parseRequest(Object.fromEntries(["id", "hospitalId", "group", "component", "quantity", "allocatedQuantity", "transfusedQuantity", "urgency", "expectedTransfusionAt", "status"].map(k => [k, iso(row[k])])));
}
const clean = (value: object): Document => JSON.parse(JSON.stringify(value));
function unitFields(unit: Unit) {
  const result = clean(unit);
  for (const k of ["collectedAt", "expiresAt", "handoverAt", "preparationConfirmedAt", "lastEventAt"]) if (result[k]) result[k] = new Date(result[k]);
  return result;
}

/** All mutations are bounded, server-authorized transactions. No simulation mode exists here. */
export class Operations {
  constructor(private db: Db, private actor: Principal, private now = new Date()) {}
  private c(name: string) { return this.db.collection<Row>(name); }
  private async parent(kind: "banks" | "hospitals", resourceId: string, session?: ClientSession) {
    const p = this.actor;
    if (!(kind === "banks" && p.role === "BANK" && p.bankId === resourceId || kind === "hospitals" && p.role === "HOSPITAL" && p.hospitalId === resourceId)) deny();
    const row = await this.c(kind).findOne({ _id: resourceId, stateId: p.stateId, tenantId: p.tenantId }, { session });
    if (!row) deny("MEMBERSHIP_REQUIRED");
    return row;
  }
  private owned(parent: Row) { return { stateId: this.actor.stateId, tenantId: parent.tenantId }; }
  private async request(parent: Row, requestId: string, session?: ClientSession) {
    const row = await this.c("requests").findOne({ _id: requestId, hospitalId: parent.id, ...this.owned(parent) }, { session });
    if (!row) deny();
    return row;
  }
  private async transaction<T>(run: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.db.client.startSession();
    try { return await session.withTransaction(() => run(session), { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10_000, timeoutMS: 25_000 }); }
    finally { await session.endSession(); }
  }
  private async once(kind: "banks" | "hospitals", resourceId: string, route: string, body: { key: string }, run: (parent: Row, session: ClientSession) => Promise<Document>) {
    const operationId = digest([this.actor.stateId, kind, resourceId, route, body.key]);
    const fingerprint = digest(body);
    // Duplicate-key races can occur on the receipt or the first ownership slot.
    // A fresh transaction sees the committed receipt/candidate, never replays a side effect.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.transaction(async session => {
          const parent = await this.parent(kind, resourceId, session);
          const previous = await this.c("operations").findOne({ _id: operationId, ...this.owned(parent) }, { session });
          if (previous) { if (previous.fingerprint !== fingerprint) conflict("IDEMPOTENCY_KEY_REUSED"); return previous.result as Document; }
          const result = await run(parent, session);
          await this.c("operations").insertOne({ _id: operationId, id: operationId, ...this.owned(parent), fingerprint, result, createdAt: this.now }, { session });
          return result;
        });
      } catch (e) { if (!(e instanceof MongoServerError && e.code === 11000) || attempt === 4) throw e; }
    }
    return conflict("RETRY_CONFLICT");
  }
  private readyFilter(): Filter<Row> {
    return { status: "AVAILABLE", reservation: { $exists: false }, storage: "VERIFIED", collectedAt: { $lte: this.now }, expiresAt: { $gt: this.now }, ...Object.fromEntries(["HIV", "HEPATITIS_B", "HEPATITIS_C", "SYPHILIS", "MALARIA"].map(s => [`screening.${s}`, "NON_REACTIVE"])) };
  }
  private async stock(unit: Row, session: ClientSession) {
    const scope = { stateId: unit.stateId, tenantId: unit.tenantId, bankId: unit.bankId, group: unit.group, component: unit.component };
    let available = 0;
    for await (const row of this.c("units").find({ ...scope, ...this.readyFilter() }, { session })) {
      try { if (!readinessReasons(unitModel(row), this.now.toISOString()).length) available++; } catch { /* Invalid records never count as usable stock. */ }
    }
    const bucket = `${unit.bankId}-${String(unit.group).replace("+", "pos").replace("-", "neg")}-${unit.component}`;
    await this.c("stock").updateOne(scope, { $set: { available, reconciledAt: this.now }, $setOnInsert: { _id: bucket, id: bucket, ...scope } }, { session, upsert: true });
  }
  private async saveTransition(row: Row, command: UnitCommand, session: ClientSession) {
    let change;
    try { change = transitionUnit(unitModel(row), command, { now: this.now.toISOString(), actorId: this.actor.userId, eventId: randomUUID() }); }
    catch { return conflict(); }
    const next: Row = { ...row, ...unitFields(change.unit), revision: (row.revision ?? 0) + 1 };
    for (const k of ["reservation", "handoverAt", "preparationConfirmedAt"] as const) if (change.unit[k] === undefined) delete next[k];
    const allocation = row.reservation ? await this.c("allocations").findOne({ unitId: row.id, requestId: row.reservation.requestId, id: row.reservation.allocationId, stateId: row.stateId, bankTenantId: row.tenantId, bankId: row.bankId }, { session }) : null;
    if (row.reservation && !allocation) conflict("OWNERSHIP_INCONSISTENT");
    if (allocation && (row.status === "RESERVED" && allocation.status !== "ACTIVE" || row.status === "ISSUED" && allocation.status !== "ISSUED")) conflict("OWNERSHIP_INCONSISTENT");
    if (allocation && this.actor.role === "HOSPITAL" && (allocation.hospitalId !== this.actor.hospitalId || allocation.hospitalTenantId !== this.actor.tenantId)) deny();
    const released = Boolean(row.reservation && !change.unit.reservation);
    if (allocation) {
      const status = released ? "RELEASED" : change.unit.status === "TRANSFUSED" ? "TRANSFUSED" : change.unit.status === "ISSUED" ? "ISSUED" : "ACTIVE";
      await this.c("allocations").updateOne({ _id: allocation._id }, { $set: { status, updatedAt: this.now, ...(command.type === "HANDOVER" ? { handoverAt: this.now } : {}), ...(released ? { releasedAt: this.now, releaseReason: command.type } : {}) } }, { session });
      if (released || command.type === "TRANSFUSE") {
        const req = await this.c("requests").findOne({ _id: allocation.requestId, stateId: row.stateId, tenantId: allocation.hospitalTenantId, hospitalId: allocation.hospitalId }, { session });
        if (!req || released && req.allocatedQuantity <= req.transfusedQuantity) conflict("COUNTERS_INCONSISTENT");
        const allocatedQuantity = req.allocatedQuantity - (released ? 1 : 0);
        const transfusedQuantity = req.transfusedQuantity + (command.type === "TRANSFUSE" ? 1 : 0);
        const status = transfusedQuantity === req.quantity ? "COMPLETED" : ["CANCELLED", "ESCALATED"].includes(req.status) ? req.status : allocatedQuantity === req.quantity ? "ALLOCATED" : allocatedQuantity ? "PARTIAL" : "OPEN";
        await this.c("requests").updateOne({ _id: req._id }, { $set: { allocatedQuantity, transfusedQuantity, status } }, { session });
      }
    }
    await appendChange(this.db, row, next, { ...clean(change.event), _id: change.event.id, ...this.owned(row), bankId: row.bankId, at: this.now, revision: next.revision, ...(allocation ? { hospitalId: allocation.hospitalId, hospitalTenantId: allocation.hospitalTenantId, allocationSnapshot: { ...allocation, status: released ? "RELEASED" : change.unit.status === "TRANSFUSED" ? "TRANSFUSED" : change.unit.status === "ISSUED" ? "ISSUED" : "ACTIVE" }, released } : {}) }, session);
    await this.stock(next, session);
    return { unitId: row.id, status: change.unit.status };
  }
  private async banks(parent: Row) {
    return this.c("banks").aggregate<Row>([
      { $geoNear: { near: parent.location, distanceField: "distanceMetres", spherical: true, maxDistance: 250_000, query: { stateId: this.actor.stateId } } },
      { $limit: 100 }, { $project: { id: 1, tenantId: 1, stateId: 1, name: 1, distanceMetres: 1 } }
    ], { maxTimeMS: 5_000 }).toArray();
  }
  private async candidates(req: Row, banks: Row[], session?: ClientSession) {
    const request = requestModel(req);
    if (!["OPEN", "PARTIAL", "ALLOCATED"].includes(request.status) || Date.parse(request.expectedTransfusionAt) <= this.now.getTime()) conflict("REQUEST_CLOSED_OR_DUE");
    if (!banks.length) return [];
    const rows = await this.c("units").aggregate<Row>([
      { $match: { ...this.readyFilter(), stateId: this.actor.stateId, component: request.component, group: { $in: [...compatibilityPreference(request.group, request.component)] }, expiresAt: { $gt: new Date(request.expectedTransfusionAt) }, $or: banks.map(b => ({ bankId: b.id, tenantId: b.tenantId })) } },
      { $set: { matchTier: { $switch: { branches: compatibilityPreference(request.group, request.component).map(group => ({ case: { $eq: ["$group", group] }, then: preferenceTier(group, request.group, request.component) })), default: 100 } } } },
      // Ranking metadata is not part of the stored/signed unit.
      { $sort: { matchTier: 1, expiresAt: 1, _id: 1 } }, { $limit: 500 }, { $unset: "matchTier" }
    ], { session, maxTimeMS: 5_000 }).toArray();
    return rows.filter(row => { try { return stockReasons(unitModel(row), request, this.now.toISOString()).length === 0; } catch { return false; } }).sort((a, b) => preferenceTier(a.group, request.group, request.component) - preferenceTier(b.group, request.group, request.component) || a.expiresAt.getTime() - b.expiresAt.getTime() || banks.find(x => x.id === a.bankId)!.distanceMetres - banks.find(x => x.id === b.bankId)!.distanceMetres || a.id.localeCompare(b.id));
  }
  /** Trusted workflow entry point; every unit is rechecked and issued in one transaction. */
  async dispatchWorkflow(requestId: string, key: string) {
    if (this.actor.role !== "HOSPITAL") deny();
    const hospitalId = this.actor.hospitalId;
    return this.once("hospitals", hospitalId, `${requestId}/workflow-dispatch`, { key }, async (parent, session) => {
      const req = await this.request(parent, requestId, session);
      if (!req.workflow || ["CANCELLED", "ESCALATED", "COMPLETED"].includes(req.status) || req.expectedTransfusionAt <= this.now) return { dispatched: false, reason: "REQUEST_CLOSED_OR_DUE" };
      const slots = await this.c("allocations").find({ requestId, stateId: parent.stateId, hospitalId, hospitalTenantId: parent.tenantId, status: { $in: ["ACTIVE", "ISSUED", "TRANSFUSED"] } }, { session }).limit(21).toArray();
      if (slots.length !== req.quantity || req.allocatedQuantity !== req.quantity) return { dispatched: false, reason: "UNMET_QUANTITY" };
      const pending: Row[] = [];
      for (const slot of slots) {
        const row = await this.c("units").findOne({ _id: slot.unitId, bankId: slot.bankId, tenantId: slot.bankTenantId, stateId: parent.stateId, "reservation.requestId": requestId, "reservation.allocationId": slot.id }, { session });
        if (!row || slot.status === "ACTIVE" && row.status !== "RESERVED" || slot.status === "ISSUED" && row.status !== "ISSUED" || slot.status === "TRANSFUSED" && row.status !== "TRANSFUSED") return { dispatched: false, reason: "OWNERSHIP_INCONSISTENT" };
        if (row.status === "RESERVED") {
          if (!slot.dispatchApproved || row.component === "FFP" && !slot.preparationConfirmed) return { dispatched: false, reason: "BANK_APPROVAL_REQUIRED" };
          try { transitionUnit(unitModel(row), { type: "ISSUE", request: requestModel(req), preparationConfirmed: slot.preparationConfirmed }, { now: this.now.toISOString(), actorId: this.actor.userId, eventId: "readiness-probe" }); }
          catch { return { dispatched: false, reason: "STOCK_NOT_READY" }; }
          pending.push(row);
        } else if (row.status === "ISSUED" && readinessReasons(unitModel(row), this.now.toISOString()).length) return { dispatched: false, reason: "STOCK_NOT_READY" };
      }
      for (const row of pending) await this.saveTransition(row, { type: "ISSUE", request: requestModel(req), preparationConfirmed: true }, session);
      return { dispatched: true, quantity: slots.length };
    });
  }
  /** Cancel/escalate atomically with reservation cleanup, retaining issued stock for review. */
  async closeWorkflow(requestId: string, key: string, outcome: "CANCELLED" | "ESCALATED", reason: string) {
    if (this.actor.role !== "HOSPITAL") deny();
    const body = { key, outcome, reason };
    return this.once("hospitals", this.actor.hospitalId, `${requestId}/workflow-close`, body, async (parent, session) => {
      const req = await this.request(parent, requestId, session);
      if (!req.workflow) conflict("WORKFLOW_REQUIRED");
      if (["COMPLETED", "CANCELLED", "ESCALATED"].includes(req.workflow.status)) return { status: req.workflow.status };
      const rows = await this.c("units").find({ stateId: parent.stateId, "reservation.requestId": requestId, status: { $in: ["RESERVED", "ISSUED"] } }, { session }).limit(21).toArray();
      for (const row of rows.filter(u => u.status === "RESERVED")) await this.saveTransition(row, { type: "CANCEL_RESERVATION", requestId }, session);
      const review = rows.some(u => u.status === "ISSUED") || req.transfusedQuantity > 0;
      const status = outcome === "CANCELLED" && review ? "ESCALATED" : outcome;
      await this.c("requests").updateOne({ _id: req._id }, { $set: { status, "workflow.status": status, "workflow.reason": review ? "ISSUED_OR_USED_STOCK_REQUIRES_MANUAL_REVIEW" : reason, "workflow.updatedAt": this.now } }, { session });
      return { status, released: rows.filter(u => u.status === "RESERVED").length, manualReview: review };
    });
  }
  async post(rawPath: string[], input: unknown): Promise<Document> {
    const path = rawPath.map(p => validate(id, p));
    const [kind, resourceId, resource, recordId, action] = path;
    if (kind !== "banks" && kind !== "hospitals" || !resourceId) deny();
    const parent = await this.parent(kind, resourceId);
    if (kind === "banks" && resource === "cold-chain" && path.length === 3) {
      if (process.env.COLD_CHAIN_DEMO_ENABLED !== "1") throw new RegistryError(503, "COLD_CHAIN_DEMO_DISABLED");
      const body = validate(v.object({ ...key, component: v.oneOf(["PRBC", "PLATELETS", "FFP"]), fault: v.boolean }), input);
      return this.once(kind, resourceId, "cold-chain", body, async (p, session) => {
        const sample = temperatureSample(`registry:${p.id}:${body.key}`, body.component, this.now.toISOString(), body.fault);
        if (!storageBreach(sample)) return { sample, quarantined: [], reason: "IN_RANGE" };
        const rows = await this.c("units").find({ ...this.owned(p), bankId: p.id, component: body.component, status: { $in: ["COLLECTED", "TESTING", "AVAILABLE", "RESERVED", "ISSUED", "RETURNED_QUARANTINE"] } }, { session, batchSize: 201 }).sort({ _id: 1 }).limit(201).toArray();
        if (rows.length > 200) throw new RegistryError(409, "COLD_CHAIN_BATCH_LIMIT");
        for (const row of rows) await this.saveTransition(row, { type: "QUARANTINE", note: `Synthetic storage excursion ${sample.celsius} C; agitation ${sample.agitation}; ${sample.at}. Manual review required.` }, session);
        return { sample, quarantined: rows.map(row => row.id), reason: "MANUAL_REVIEW_REQUIRED" };
      });
    }
    if (kind === "hospitals" && resource === "requests" && path.length === 3) {
      const body = validate(requestInput, input);
      const requestId = `request-${digest([parent.id, body.key]).slice(0, 40)}`;
      return this.once(kind, resourceId, "create-request", body, async (p, session) => {
        const expected = new Date(body.expectedTransfusionAt);
        if (expected <= this.now || expected.getTime() > this.now.getTime() + 86_400_000) throw new RegistryError(400, "DEADLINE_OUT_OF_RANGE");
        if (body.urgency !== "ROUTINE") throw new RegistryError(409, "USE_DURABLE_EMERGENCY_INTAKE");
        await this.c("requests").insertOne({ ...body, key: undefined, _id: requestId, id: requestId, ...this.owned(p), hospitalId: p.id, allocatedQuantity: 0, transfusedQuantity: 0, status: "OPEN", createdAt: this.now, expectedTransfusionAt: expected }, { session });
        return { requestId, status: "OPEN" };
      });
    }
    if (kind === "banks" && resource === "collect" && path.length === 3) {
      const body = validate(collectInput, input);
      return this.once(kind, resourceId, "collect", body, async (p, session) => {
        if (Date.parse(body.collectedAt) > this.now.getTime()) throw new RegistryError(400, "FUTURE_COLLECTION");
        const donor = await this.c("donors").findOne({ _id: body.donorId, stateId: p.stateId, group: body.group, $or: [{ audience: false, expireAt: { $exists: false } }, { audience: true, expireAt: { $gt: this.now, $type: "date" } }] }, { session });
        if (!donor) throw new RegistryError(400, "SYNTHETIC_DONOR_REQUIRED");
        const unitId = `unit-${digest([p.id, body.key]).slice(0, 40)}`;
        const unit = validate(() => createCollectedUnit({ id: unitId, bankId: p.id, donorId: body.donorId, group: body.group, product: body.product, component: componentFor(body.product), collectedAt: body.collectedAt }), null);
        if (Date.parse(unit.expiresAt) <= this.now.getTime()) throw new RegistryError(400, "COLLECTION_ALREADY_EXPIRED");
        const eventId = randomUUID();
        await appendChange(this.db, null, { ...unitFields(unit), _id: unitId, ...this.owned(p), revision: 0 }, { _id: eventId, id: eventId, ...this.owned(p), bankId: p.id, unitId, action: "COLLECT", to: "COLLECTED", at: this.now, actorId: this.actor.userId }, session);
        await this.stock({ ...unitFields(unit), _id: unitId, ...this.owned(p) }, session);
        return { unitId, status: "COLLECTED" };
      });
    }
    if (kind === "hospitals" && resource === "requests" && recordId && path.length === 5) {
      const req = await this.request(parent, recordId);
      if (action === "search" || action === "history") {
        validate(v.object({}), input);
        if (action === "history") {
          const records = await this.c("unitEvents").find({ stateId: parent.stateId, hospitalTenantId: parent.tenantId, hospitalId: parent.id, requestId: req.id }, { projection: { _id: 0, id: 1, unitId: 1, requestId: 1, allocationId: 1, action: 1, from: 1, to: 1, at: 1, revision: 1, released: 1 } }).sort({ at: 1, unitId: 1, revision: 1, _id: 1 }).limit(500).toArray();
          return { records };
        }
        const banks = await this.banks(parent), rows = await this.candidates(req, banks);
        return { records: rows.map(row => ({ unitId: row.id, bankId: row.bankId, bankName: banks.find(b => b.id === row.bankId)!.name, group: row.group, component: row.component, expiresAt: row.expiresAt, preference: preferenceTier(row.group, req.group, req.component) + 1, distanceKm: banks.find(b => b.id === row.bankId)!.distanceMetres / 1000 })), policy: "250 km / up to 100 banks and 500 units; compatibility preference, then FEFO, then straight-line distance. Search is advisory; reserve rechecks all gates." };
      }
      if (action === "reserve") {
        const body = validate(v.object(key), input), banks = await this.banks(parent);
        return this.once(kind, resourceId, `${recordId}/reserve`, body, async (p, session) => {
          const current = await this.request(p, recordId, session);
          if (["CANCELLED", "COMPLETED", "ESCALATED"].includes(current.status) || current.expectedTransfusionAt <= this.now) conflict("REQUEST_CLOSED_OR_DUE");
          if (current.allocatedQuantity >= current.quantity) return { reserved: false, reason: "QUANTITY_COVERED", requestId: recordId };
          const candidates = await this.candidates(current, banks, session);
          for (const row of candidates) {
            const previous = await this.c("allocations").findOne({ unitId: row.id }, { session });
            if (previous && previous.status !== "RELEASED") continue;
            const allocationId = randomUUID();
            const change = transitionUnit(unitModel(row), { type: "RESERVE", request: requestModel(current), allocationId }, { now: this.now.toISOString(), actorId: this.actor.userId, eventId: randomUUID() });
            const unit = { ...row, ...unitFields(change.unit), revision: (row.revision ?? 0) + 1 };
            const allocation = { _id: previous?._id ?? `slot-${row.id}`, id: allocationId, stateId: row.stateId, tenantId: row.tenantId, bankTenantId: row.tenantId, hospitalTenantId: p.tenantId, bankId: row.bankId, hospitalId: p.id, unitId: row.id, requestId: recordId, status: "ACTIVE", reservedAt: this.now, leaseExpiresAt: new Date(change.unit.reservation!.leaseExpiresAt), updatedAt: this.now };
            if (previous) await this.c("allocations").replaceOne({ _id: previous._id, status: "RELEASED" }, allocation, { session });
            else await this.c("allocations").insertOne(allocation, { session });
            const updated = await this.c("requests").findOneAndUpdate({ _id: current._id, ...this.owned(p), hospitalId: p.id, status: { $in: ["OPEN", "PARTIAL"] }, allocatedQuantity: current.allocatedQuantity, $expr: { $lt: ["$allocatedQuantity", "$quantity"] } }, { $inc: { allocatedQuantity: 1 }, $set: { status: current.allocatedQuantity + 1 === current.quantity ? "ALLOCATED" : "PARTIAL" } }, { session, returnDocument: "after" });
            if (!updated) conflict("REQUEST_CHANGED");
            await appendChange(this.db, row, unit, { ...clean(change.event), _id: change.event.id, ...this.owned(row), bankId: row.bankId, hospitalId: p.id, hospitalTenantId: p.tenantId, at: this.now, revision: unit.revision, allocationSnapshot: allocation }, session);
            await this.stock(unit, session);
            return { reserved: true, requestId: recordId, unitId: row.id, allocationId, allocatedQuantity: updated.allocatedQuantity, remaining: updated.quantity - updated.allocatedQuantity, status: updated.status, leaseExpiresAt: allocation.leaseExpiresAt };
          }
          return { reserved: false, requestId: recordId, reason: "NO_ELIGIBLE_STOCK", remaining: current.quantity - current.allocatedQuantity, status: current.status };
        });
      }
      if (action === "cancel") {
        const body = validate(v.object(key), input);
        return this.once(kind, resourceId, `${recordId}/cancel`, body, async (p, session) => {
          const current = await this.request(p, recordId, session);
          if (current.workflow) conflict("USE_DURABLE_CANCELLATION");
          if (current.status === "COMPLETED" || current.transfusedQuantity > 0) conflict("CANNOT_CANCEL_USED_STOCK");
          const units = await this.c("units").find({ stateId: p.stateId, "reservation.requestId": recordId, status: { $in: ["RESERVED", "ISSUED"] } }, { session }).limit(21).toArray();
          if (units.some(u => u.status === "ISSUED")) conflict("RETURN_ISSUED_STOCK_FIRST");
          for (const row of units) await this.saveTransition(row, { type: "CANCEL_RESERVATION", requestId: recordId }, session);
          await this.c("requests").updateOne({ _id: current._id }, { $set: { status: "CANCELLED" } }, { session });
          return { requestId: recordId, status: "CANCELLED", released: units.length };
        });
      }
    }
    if (resource === "units" && recordId && action === "action" && path.length === 5) {
      const raw = input as { type?: unknown } | null;
      const type = validate(v.oneOf(["START_TESTING", "UPDATE_SCREENING", "VERIFY_STORAGE", "MAKE_AVAILABLE", "ISSUE", "RETURN", "EXPIRE", "DISCARD", "HANDOVER", "TRANSFUSE"]), raw?.type);
      const extra: Record<string, v.Parser<unknown>> = type === "UPDATE_SCREENING" ? { screening: v.object(Object.fromEntries(["HIV", "HEPATITIS_B", "HEPATITIS_C", "SYPHILIS", "MALARIA"].map(s => [s, v.oneOf(["PENDING", "NON_REACTIVE", "REACTIVE", "INVALID"])]))) } : type === "VERIFY_STORAGE" ? { storage: v.oneOf(["UNKNOWN", "VERIFIED", "FAILED"]) } : type === "ISSUE" ? { preparationConfirmed: v.boolean } : type === "RETURN" || type === "DISCARD" ? { note: (value: unknown) => { const s = v.text(value); if (s.length > 200) throw new Error("Note too long"); return s; } } : {};
      const body = validate(v.object({ ...key, type: v.oneOf([type]), ...extra }), input);
      if (kind === "hospitals" ? !["HANDOVER", "TRANSFUSE"].includes(type) : ["HANDOVER", "TRANSFUSE"].includes(type)) deny();
      return this.once(kind, resourceId, `${recordId}/action`, body, async (p, session) => {
        let row: Row | null;
        if (kind === "banks") row = await this.c("units").findOne({ _id: recordId, ...this.owned(p), bankId: p.id }, { session });
        else {
          const allocation = await this.c("allocations").findOne({ unitId: recordId, stateId: p.stateId, hospitalTenantId: p.tenantId, hospitalId: p.id, status: "ISSUED" }, { session });
          if (!allocation) deny();
          row = await this.c("units").findOne({ _id: recordId, stateId: p.stateId, tenantId: allocation.bankTenantId, bankId: allocation.bankId, "reservation.requestId": allocation.requestId, "reservation.allocationId": allocation.id }, { session });
        }
        if (!row) deny();
        let command: UnitCommand = { ...body, requestId: row.reservation?.requestId } as unknown as UnitCommand;
        if (type === "ISSUE") {
          const allocation = await this.c("allocations").findOne({ unitId: row.id, id: row.reservation?.allocationId, stateId: p.stateId, bankTenantId: p.tenantId, bankId: p.id, status: "ACTIVE" }, { session });
          if (!allocation) conflict("NO_ACTIVE_RESERVATION");
          const req = await this.c("requests").findOne({ _id: allocation.requestId, stateId: p.stateId, tenantId: allocation.hospitalTenantId, hospitalId: allocation.hospitalId }, { session });
          if (!req) conflict("OWNERSHIP_INCONSISTENT");
          if (req.workflow) conflict("USE_WORKFLOW_DISPATCH_APPROVAL");
          command = { type: "ISSUE", request: requestModel(req), preparationConfirmed: Boolean((body as Document).preparationConfirmed) };
        }
        return this.saveTransition(row, command, session);
      });
    }
    if (resource === "maintain" && path.length === 3) {
      const body = validate(v.object(key), input);
      return this.once(kind, resourceId, "maintain", body, async (p, session) => {
        let scope: Filter<Row> = { ...this.owned(p), bankId: p.id };
        if (kind === "hospitals") {
          const slots = await this.c("allocations").find({ stateId: p.stateId, hospitalTenantId: p.tenantId, hospitalId: p.id, status: "ACTIVE", leaseExpiresAt: { $lte: this.now } }, { session }).sort({ leaseExpiresAt: 1, _id: 1 }).limit(101).toArray();
          if (!slots.length) return { processed: 0, more: false, countersReconciled: false };
          scope = { stateId: p.stateId, $or: slots.map(slot => ({ _id: slot.unitId, bankId: slot.bankId, tenantId: slot.bankTenantId, "reservation.requestId": slot.requestId, "reservation.allocationId": slot.id })) };
        }
        const due = await this.c("units").find({ $and: [scope, { $or: [{ status: "RESERVED", "reservation.leaseExpiresAt": { $lte: this.now.toISOString() } }, { status: { $in: ["COLLECTED", "TESTING", "AVAILABLE", "RESERVED", "ISSUED", "RETURNED_QUARANTINE", "QUARANTINED"] }, expiresAt: { $lte: this.now } }] }] }, { session }).sort({ _id: 1 }).limit(101).toArray();
        for (const row of due.slice(0, 100)) await this.saveTransition(row, row.expiresAt <= this.now ? { type: "EXPIRE" } : { type: "EXPIRE_RESERVATION", requestId: row.reservation.requestId }, session);
        if (kind === "banks") for (const group of GROUPS) for (const component of ["PRBC", "PLATELETS", "FFP"]) await this.stock({ _id: "", ...this.owned(p), bankId: p.id, group, component }, session);
        return { processed: Math.min(100, due.length), more: due.length > 100, countersReconciled: kind === "banks" };
      });
    }
    throw new RegistryError(404, "NOT_FOUND");
  }
}
