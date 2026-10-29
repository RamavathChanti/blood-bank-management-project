import "server-only";
import type { Db, Document, Filter } from "mongodb";
import type { Principal } from "./identity";
import { deny, RegistryError, validate } from "./errors";
import { COLLECTIONS, type CollectionName } from "./schema";
import * as v from "../core/validation";

type RecordDoc = Document & { _id: string };
const id = (value: unknown) => {
  const parsed = v.text(value);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(parsed)) throw new Error("Invalid ID");
  return parsed;
};
const safeName = (value: unknown) => {
  const result = v.text(value);
  if (result.length > 80 || /[\u0000-\u001f\u007f]/.test(result)) throw new Error("Invalid name");
  return result;
};
const institutionPatch = v.object({ name: safeName });
const donorPatch = v.object({ nickname: safeName });
const projections: Record<CollectionName, Document> = {
  banks: { id: 1, name: 1, district: 1, location: 1 },
  hospitals: { id: 1, name: 1, district: 1, location: 1 },
  units: { id: 1, bankId: 1, group: 1, component: 1, product: 1, collectedAt: 1, expiresAt: 1, status: 1, screening: 1, storage: 1 },
  unitEvents: { id: 1, bankId: 1, unitId: 1, requestId: 1, allocationId: 1, at: 1, revision: 1, actorId: 1, action: 1, from: 1, to: 1 },
  requests: { id: 1, hospitalId: 1, group: 1, component: 1, quantity: 1, allocatedQuantity: 1, transfusedQuantity: 1, urgency: 1, expectedTransfusionAt: 1, status: 1, createdAt: 1 },
  allocations: { id: 1, unitId: 1, bankId: 1, hospitalId: 1, requestId: 1, status: 1, reservedAt: 1, leaseExpiresAt: 1, handoverAt: 1, releasedAt: 1, releaseReason: 1 },
  donors: { id: 1, nickname: 1, group: 1, eligibleFrom: 1, audience: 1, expireAt: 1 },
  stock: { id: 1, bankId: 1, group: 1, component: 1, available: 1 },
  alerts: { id: 1, donorId: 1, requestId: 1, status: 1, createdAt: 1, deadlineAt: 1, collectionBankId: 1, wave: 1, channel: 1 },
  operations: { id: 1, createdAt: 1 },
  anchors: { id: 1, day: 1, merkleRoot: 1, count: 1, createdAt: 1, external: 1 },
  workflowSignals: { id: 1, requestId: 1, kind: 1, status: 1, createdAt: 1 }
};
export class Registry {
  constructor(private db: Db, private actor: Principal, private now = new Date()) {}
  private collection(name: CollectionName) { return this.db.collection<RecordDoc>(name); }
  private async membership() {
    const p = this.actor;
    if (p.role === "STATE_ADMIN") return;
    const name = p.role === "BANK" ? "banks" : p.role === "HOSPITAL" ? "hospitals" : "donors";
    const ownId = p.role === "BANK" ? p.bankId : p.role === "HOSPITAL" ? p.hospitalId : p.donorId;
    const record = await this.collection(name).findOne({ _id: ownId, stateId: p.stateId, tenantId: p.tenantId, ...(name === "donors" ? this.aliveDonors() : {}) }, { projection: { _id: 1 } });
    if (!record) deny("MEMBERSHIP_REQUIRED");
  }
  private aliveDonors(): Filter<RecordDoc> {
    // Missing expiry is allowed only for permanent synthetic seed donors. A corrupt
    // audience row without a BSON Date is excluded even before TTL cleanup runs.
    return { $or: [{ audience: false, expireAt: { $exists: false } }, { audience: true, expireAt: { $type: "date", $gt: this.now } }] };
  }
  private async parent(name: "banks" | "hospitals" | "donors", resourceId: string) {
    const p = this.actor;
    const owns = p.role === "BANK" && name === "banks" && p.bankId === resourceId || p.role === "HOSPITAL" && name === "hospitals" && p.hospitalId === resourceId || p.role === "DONOR" && name === "donors" && p.donorId === resourceId;
    if (p.role !== "STATE_ADMIN" && !owns) deny();
    const result = await this.collection(name).findOne({ _id: resourceId, stateId: p.stateId, ...(p.role === "STATE_ADMIN" ? {} : { tenantId: p.tenantId }), ...(name === "donors" ? this.aliveDonors() : {}) });
    if (!result) deny(); // Same response for nonexistent and inaccessible IDs.
    return result;
  }
  private async scope(path: string[]): Promise<{ name: CollectionName; filter: Filter<RecordDoc>; single: boolean }> {
    const [root, parentId, child, childId] = path;
    if (root === "state") {
      if (this.actor.role !== "STATE_ADMIN") deny();
      if (!COLLECTIONS.includes(parentId as CollectionName) || path.length > 3) throw new RegistryError(404, "NOT_FOUND");
      const name = parentId as CollectionName;
      return { name, filter: { stateId: this.actor.stateId, ...(child ? { [name === "allocations" ? "id" : "_id"]: child } : {}), ...(name === "donors" ? this.aliveDonors() : {}) }, single: Boolean(child) };
    }
    if (!["banks", "hospitals", "donors"].includes(root) || !parentId || path.length > 4) throw new RegistryError(404, "NOT_FOUND");
    const parentName = root as "banks" | "hospitals" | "donors";
    const parent = await this.parent(parentName, parentId);
    const base = { stateId: this.actor.stateId, tenantId: parent.tenantId };
    if (!child) return { name: parentName, filter: { ...base, _id: parentId, ...(parentName === "donors" ? this.aliveDonors() : {}) }, single: true };
    const allowed = root === "banks" ? ["units", "unitEvents", "stock", "allocations"] : root === "hospitals" ? ["requests", "allocations"] : ["alerts"];
    if (!allowed.includes(child)) deny();
    const name = child as CollectionName;
    const relation = root === "banks" ? { bankId: parentId } : root === "hospitals" ? { hospitalId: parentId } : { donorId: parentId };
    const ownership = name === "allocations" ? { stateId: this.actor.stateId, [root === "banks" ? "bankTenantId" : "hospitalTenantId"]: parent.tenantId } : base;
    return { name, filter: { ...ownership, ...relation, ...(childId ? { [name === "allocations" ? "id" : "_id"]: childId } : {}) }, single: Boolean(childId) };
  }
  async read(path: string[], after?: string) {
    path = path.map(value => validate(id, value));
    if (after !== undefined) after = validate(id, after);
    await this.membership();
    if (path.length === 1 && path[0] === "me") return { identity: this.actor };
    if (path.join("/") === "state/forecast") {
      if (this.actor.role !== "STATE_ADMIN") deny();
      if (after) throw new RegistryError(400, "INVALID_INPUT");
      const row = await this.collection("operations").findOne({ stateId: this.actor.stateId, tenantId: "state-forecast-scheduler", "result.kind": "REGISTRY_FORECAST_PROPOSAL", expireAt: { $gt: this.now } }, { sort: { createdAt: -1 }, projection: { _id: 0, result: 1 }, maxTimeMS: 5000 });
      return { forecast: row?.result ?? null };
    }
    if (path.join("/") === "matching/banks") {
      if (!["HOSPITAL", "STATE_ADMIN"].includes(this.actor.role)) deny();
      // Explicit state-wide capability; institution directory only. Private stock,
      // donor data and future reservations must use separate authorized methods.
      return this.list("banks", { stateId: this.actor.stateId }, after);
    }
    const { name, filter, single } = await this.scope(path);
    if (!single) return this.list(name, filter, after);
    if (after) throw new RegistryError(400, "INVALID_INPUT");
    const record = await this.collection(name).findOne(filter, { projection: { ...projections[name], _id: 0 } });
    if (!record) deny();
    return { record };
  }
  private async list(name: CollectionName, filter: Filter<RecordDoc>, after?: string) {
    const records = await this.collection(name).find({ ...filter, ...(after ? { _id: { $gt: after } } : {}) }, { projection: { ...projections[name], _id: 1 }, maxTimeMS: 5_000 }).sort({ _id: 1 }).limit(101).toArray();
    return { records: records.slice(0, 100).map(record => { const visible = { ...record }; delete (visible as Document)._id; return visible; }), next: records.length > 100 ? records[99]._id : null };
  }
  async patch(path: string[], input: unknown) {
    path = path.map(value => validate(id, value));
    await this.membership();
    if (path.length !== 2 || !["banks", "hospitals", "donors"].includes(path[0])) deny();
    const name = path[0] as "banks" | "hospitals" | "donors";
    const parent = await this.parent(name, path[1]);
    const changes = name === "donors" ? validate(donorPatch, input) : validate(institutionPatch, input);
    const record = await this.collection(name).findOneAndUpdate({ _id: parent._id, tenantId: parent.tenantId, stateId: this.actor.stateId, ...(name === "donors" ? this.aliveDonors() : {}) }, { $set: changes }, { returnDocument: "after", projection: { ...projections[name], _id: 0 } });
    if (!record) deny();
    return { record };
  }
}
