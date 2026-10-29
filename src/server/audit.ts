import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ClientSession, Db, Document } from "mongodb";
import { canonical, eventPayload, GENESIS, unitState, verifyHistory, without, type AuditEvent, type AuditRecord } from "../core/audit";
import { RegistryError } from "./errors";

export type Row = Document & { _id: string };
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function secret() {
  const key = process.env.AUDIT_HMAC_SECRET;
  if (!key || !/^[a-fA-F0-9]{64}$/.test(key)) throw new RegistryError(503, "AUDIT_KEY_UNCONFIGURED");
  return Buffer.from(key, "hex");
}
export function signUnit(unit: AuditRecord) { return createHmac("sha256", secret()).update("pulsegrid-unit-v1:" + canonical(without(unit, ["sig"]))).digest("hex"); }
export function signatureStatus(unit: AuditRecord) {
  secret(); // Configuration failure is different from a malformed stored document.
  if (typeof unit.sig !== "string") return "UNSIGNED" as const;
  try {
    const expected = signUnit(unit);
    return /^[a-f0-9]{64}$/.test(unit.sig) && timingSafeEqual(Buffer.from(unit.sig, "hex"), Buffer.from(expected, "hex")) ? "VALID" as const : "MISMATCH" as const;
  } catch { return "MISMATCH" as const; }
}
function persisted(value: unknown): unknown {
  if (value instanceof Date || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(persisted);
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, persisted(v)]));
}
export function sealChange(previous: Row | null, next: Row, event: Row) {
  next = persisted(next) as Row; event = persisted(event) as Row;
  const seq = previous ? previous.auditSeq + 1 : 1;
  const payload = { ...event, version: 1, seq, prevHash: previous?.auditHead ?? GENESIS, beforeStateHash: previous ? digest(canonical(unitState(previous))) : GENESIS, stateHash: digest(canonical(unitState(next))), state: JSON.parse(canonical(unitState(next))) };
  const sealed = { ...payload, hash: digest(payload.prevHash + canonical(payload)) } as unknown as AuditEvent & Row;
  const unit = { ...next, auditSeq: seq, auditHead: sealed.hash };
  return { unit: { ...unit, sig: signUnit(unit) }, event: sealed };
}
/** Explicit baseline for synthetic imports, never an invented donation/screening history. */
export function baseline(unit: Row, at: Date, actorId = "synthetic-seed") {
  return sealChange(null, unit, { _id: `baseline-${unit.id}`, id: `baseline-${unit.id}`, unitId: unit.id, bankId: unit.bankId, stateId: unit.stateId, tenantId: unit.tenantId, action: "IMPORT_BASELINE", to: unit.status, screening: unit.screening, storage: unit.storage, actorId, at });
}
/** Check the signed head before a write, so a mutation cannot silently re-sign a tamper. */
export async function assertWritable(db: Db, row: Row, session: ClientSession) {
  if (signatureStatus(row) !== "VALID" || !Number.isInteger(row.auditSeq)) throw new RegistryError(409, "AUDIT_INTEGRITY_FAILED");
  const head = await db.collection<Row>("unitEvents").findOne({ stateId: row.stateId, tenantId: row.tenantId, bankId: row.bankId, unitId: row.id, seq: row.auditSeq }, { session });
  if (!head || head.hash !== row.auditHead || head.hash !== digest(head.prevHash + canonical(eventPayload(head))) || head.stateHash !== digest(canonical(unitState(row)))) throw new RegistryError(409, "AUDIT_INTEGRITY_FAILED");
}
export async function appendChange(db: Db, previous: Row | null, next: Row, event: Row, session: ClientSession) {
  if (previous) await assertWritable(db, previous, session);
  const sealed = sealChange(previous, next, event);
  if (previous) {
    const result = await db.collection<Row>("units").replaceOne({ _id: previous._id, stateId: previous.stateId, tenantId: previous.tenantId, bankId: previous.bankId, auditSeq: previous.auditSeq, auditHead: previous.auditHead, sig: previous.sig }, sealed.unit, { session });
    if (result.modifiedCount !== 1) throw new RegistryError(409, "AUDIT_WRITE_CONFLICT");
  } else await db.collection<Row>("units").insertOne(sealed.unit, { session });
  await db.collection<Row>("unitEvents").insertOne(sealed.event, { session });
  return sealed.unit;
}
export async function verifyUnit(db: Db, unit: Row, session: ClientSession) {
  const events = await db.collection<Row>("unitEvents").find({ unitId: unit.id, stateId: unit.stateId }, { session }).sort({ seq: 1, _id: 1 }).limit(1001).batchSize(1001).toArray();
  if (events.length > 1000) throw new RegistryError(409, "AUDIT_HISTORY_BUDGET_EXCEEDED");
  const verification = await verifyHistory(unit, events as unknown as AuditEvent[], signatureStatus(unit), digest);
  return { unit, events, verification };
}
export async function auditSnapshot<T>(db: Db, run: (session: ClientSession) => Promise<T>) {
  const session = db.client.startSession();
  try { return await session.withTransaction(() => run(session), { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary", timeoutMS: 25000 }); }
  finally { await session.endSession(); }
}
