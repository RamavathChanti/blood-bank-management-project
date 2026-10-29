import "server-only";
import type { Db, Document, IndexDescription } from "mongodb";

export const COLLECTIONS = ["banks", "hospitals", "units", "unitEvents", "requests", "allocations", "donors", "stock", "alerts", "operations", "workflowSignals", "anchors"] as const;
export type CollectionName = typeof COLLECTIONS[number];
const tenant = { bsonType: "string", minLength: 1 };
const geo = { bsonType: "object", required: ["type", "coordinates"], properties: { type: { enum: ["Point"] }, coordinates: { bsonType: "array", minItems: 2, maxItems: 2, items: { bsonType: ["double", "int", "long", "decimal"] } } } };
const date = { bsonType: "date" };
const group = { enum: ["O-", "O+", "A-", "A+", "B-", "B+", "AB-", "AB+"] };
const component = { enum: ["PRBC", "PLATELETS", "FFP"] };
const fields: Record<CollectionName, Document> = {
  banks: { name: tenant, district: tenant, location: geo },
  hospitals: { name: tenant, district: tenant, location: geo },
  units: { bankId: tenant, donorId: tenant, group, component, status: { enum: ["COLLECTED", "TESTING", "AVAILABLE", "RESERVED", "ISSUED", "TRANSFUSED", "EXPIRED", "DISCARDED", "RETURNED_QUARANTINE", "QUARANTINED"] }, collectedAt: date, expiresAt: date },
  unitEvents: { bankId: tenant, unitId: tenant, at: date, actorId: tenant, action: tenant },
  requests: { hospitalId: tenant, group, component, status: tenant, expectedTransfusionAt: date, createdAt: date, quantity: { bsonType: "int", minimum: 1 }, allocatedQuantity: { bsonType: "int", minimum: 0 } },
  allocations: { bankId: tenant, hospitalId: tenant, bankTenantId: tenant, hospitalTenantId: tenant, unitId: tenant, requestId: tenant, status: { enum: ["ACTIVE", "RELEASED", "ISSUED", "TRANSFUSED"] }, reservedAt: date },
  donors: { nickname: tenant, group, location: geo, eligibleFrom: date, audience: { bsonType: "bool" } },
  stock: { bankId: tenant, group, component, available: { bsonType: "int", minimum: 0 } },
  alerts: { donorId: tenant, requestId: tenant, status: tenant, createdAt: date },
  operations: { fingerprint: tenant, result: { bsonType: "object" }, createdAt: date },
  anchors: { day: tenant, merkleRoot: tenant, heads: { bsonType: "array" }, createdAt: date, count: { bsonType: "int", minimum: 0 } },
  workflowSignals: { requestId: tenant, kind: tenant, fingerprint: tenant, data: { bsonType: "object" }, status: { enum: ["PENDING", "APPLIED", "REJECTED"] }, createdAt: date }
};
export function validatorFor(name: CollectionName) {
  const properties = { _id: tenant, id: tenant, stateId: tenant, tenantId: tenant, ...fields[name], ...(name === "units" ? { sig: { bsonType: "string", pattern: "^[a-f0-9]{64}$" }, auditSeq: { bsonType: "int", minimum: 1 }, auditHead: { bsonType: "string", pattern: "^[a-f0-9]{64}$" } } : {}), ...(name === "unitEvents" ? { seq: { bsonType: "int", minimum: 1 }, hash: tenant, prevHash: tenant, stateHash: tenant, beforeStateHash: tenant, state: { bsonType: "object" } } : {}), ...(name === "donors" ? { expireAt: date } : {}) };
  const schema = { $jsonSchema: { bsonType: "object", required: ["_id", "id", "stateId", "tenantId", ...Object.keys(fields[name])], properties } };
  return name === "donors" ? { $and: [schema, { $or: [{ audience: false, expireAt: { $exists: false } }, { audience: true, expireAt: { $type: "date" } }] }] } : schema;
}
export const INDEXES: Record<CollectionName, IndexDescription[]> = {
  banks: [{ key: { location: "2dsphere" }, name: "bank_geo" }, { key: { stateId: 1, tenantId: 1 }, name: "bank_tenant" }],
  hospitals: [{ key: { location: "2dsphere" }, name: "hospital_geo" }, { key: { stateId: 1, tenantId: 1 }, name: "hospital_tenant" }],
  units: [{ key: { bankId: 1, component: 1, group: 1, expiresAt: 1, _id: 1 }, name: "available_fefo", partialFilterExpression: { status: "AVAILABLE" } }, { key: { stateId: 1, tenantId: 1, bankId: 1 }, name: "unit_tenant" }],
  unitEvents: [{ key: { unitId: 1, seq: 1 }, name: "unit_sequence", unique: true, partialFilterExpression: { seq: { $type: "number" } } }, { key: { stateId: 1, tenantId: 1, bankId: 1, unitId: 1, at: 1 }, name: "unit_timeline" }, { key: { stateId: 1, hospitalTenantId: 1, hospitalId: 1, requestId: 1, at: 1, unitId: 1, revision: 1 }, name: "hospital_history" }, { key: { stateId: 1, action: 1, at: 1, _id: 1 }, name: "forecast_issues" }],
  requests: [{ key: { stateId: 1, tenantId: 1, hospitalId: 1, createdAt: -1, _id: 1 }, name: "hospital_requests" }, { key: { stateId: 1, status: 1, expectedTransfusionAt: 1 }, name: "request_queue" }],
  // One durable ownership slot per unit. Stage 6 must archive releases in unitEvents
  // and atomically reuse the slot; released rows do not bypass this unique index.
  allocations: [{ key: { unitId: 1 }, name: "one_owner_per_unit", unique: true }, { key: { stateId: 1, hospitalTenantId: 1, hospitalId: 1, requestId: 1 }, name: "request_allocations" }, { key: { stateId: 1, bankTenantId: 1, bankId: 1 }, name: "bank_allocations" }, { key: { stateId: 1, hospitalTenantId: 1, hospitalId: 1, status: 1, leaseExpiresAt: 1 }, name: "hospital_lease_expiry" }],
  donors: [{ key: { location: "2dsphere" }, name: "donor_geo" }, { key: { group: 1, eligibleFrom: 1 }, name: "eligible_donors" }, { key: { expireAt: 1 }, name: "audience_ttl", expireAfterSeconds: 0 }, { key: { stateId: 1, tenantId: 1 }, name: "donor_tenant" }, { key: { sessionHash: 1 }, name: "audience_session", unique: true, sparse: true }],
  stock: [{ key: { bankId: 1, group: 1, component: 1 }, name: "stock_bucket", unique: true }],
  alerts: [{ key: { requestId: 1, donorId: 1 }, name: "one_alert_per_request_donor", unique: true }, { key: { stateId: 1, tenantId: 1, donorId: 1 }, name: "donor_alerts" }, { key: { expireAt: 1 }, name: "audience_alert_ttl", expireAfterSeconds: 0 }],
  operations: [{ key: { stateId: 1, tenantId: 1, createdAt: 1 }, name: "operation_tenant" }, { key: { expireAt: 1 }, name: "audience_receipt_ttl", expireAfterSeconds: 0 }],
  anchors: [{ key: { stateId: 1, day: 1 }, name: "daily_anchor", unique: true }],
  workflowSignals: [{ key: { requestId: 1, status: 1, createdAt: 1 }, name: "pending_workflow_signals" }]
};
export async function ensureSchema(db: Db) {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));
  for (const name of COLLECTIONS) {
    const validator = validatorFor(name);
    if (!existing.has(name)) await db.createCollection(name, { validator, validationLevel: "strict", validationAction: "error" });
    else await db.command({ collMod: name, validator, validationLevel: "strict", validationAction: "error" });
    await db.collection(name).createIndexes(INDEXES[name]);
  }
}
export async function verifyIndexes(db: Db) {
  const report: Record<string, number> = {};
  for (const name of COLLECTIONS) {
    const actual = await db.collection(name).listIndexes().toArray();
    for (const expected of INDEXES[name]) {
      const found = actual.find(i => i.name === expected.name);
      if (!found || JSON.stringify(found.key) !== JSON.stringify(expected.key) || Boolean(found.unique) !== Boolean(expected.unique) || found.expireAfterSeconds !== expected.expireAfterSeconds || JSON.stringify(found.partialFilterExpression) !== JSON.stringify(expected.partialFilterExpression)) throw new Error(`Index mismatch: ${name}.${expected.name}`);
    }
    report[name] = actual.length;
  }
  return report;
}
