import "server-only";
import { MongoError } from "mongodb";
import { identity } from "./identity";
import { database } from "./mongodb";
import { deny, RegistryError } from "./errors";
import { readJsonInput, type ApiDependencies } from "./registry-api";
import { auditSnapshot, verifyUnit, type Row } from "./audit";
import { runAuditVerifier, verifyAnchor } from "./audit-jobs";
import { traced } from "./telemetry";

const defaults: ApiDependencies = { identity, database, log: entry => console.warn(JSON.stringify(entry)) };
export function auditHandler(deps = defaults) {
  return traced("audit", async (request: Request, path: string[]) => {
    const headers = { "Cache-Control": "private, no-store", Vary: "Cookie, Authorization", "X-Content-Type-Options": "nosniff" };
    try {
      const actor = await deps.identity();
      if (new URL(request.url).search || path.some(s => !/^[a-zA-Z0-9_-]{1,128}$/.test(s))) throw new RegistryError(400, "INVALID_INPUT");
      if (actor.role !== "STATE_ADMIN" && actor.role !== "BANK") deny();
      const db = await deps.database();
      if (path[0] === "passport" && path.length === 2 && request.method === "GET") {
        const result = await auditSnapshot(db, async session => {
          if (actor.role === "BANK" && !await db.collection("banks").findOne({ id: actor.bankId, tenantId: actor.tenantId, stateId: actor.stateId }, { session })) deny("MEMBERSHIP_REQUIRED");
          const unit = await db.collection<Row>("units").findOne({ _id: path[1], stateId: actor.stateId, ...(actor.role === "BANK" ? { bankId: actor.bankId, tenantId: actor.tenantId } : {}) }, { session });
          if (!unit) deny();
          const verified = await verifyUnit(db, unit, session);
          // Full snapshots remain server-side: exclude donor IDs, notes and unrelated hospital ownership.
          return { unit: { id: unit.id, group: unit.group, component: unit.component, status: unit.status, expiresAt: unit.expiresAt }, verification: verified.verification, events: verified.events.map(e => ({ id: e.id, unitId: e.unitId, seq: e.seq, action: e.action, actorId: e.actorId, at: e.at, from: e.from, to: e.to, hash: e.hash, prevHash: e.prevHash, stateHash: e.stateHash, screening: e.screening, storage: e.storage })) };
        });
        return Response.json(result, { headers });
      }
      if (actor.role !== "STATE_ADMIN") deny();
      if (path.join("/") === "verify" && request.method === "POST") {
        const body = await readJsonInput(request);
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) throw new RegistryError(400, "INVALID_INPUT");
        return Response.json({ report: await runAuditVerifier(db, (deps.now?.() ?? new Date()).toISOString()) }, { headers });
      }
      if (path.join("/") === "status" && request.method === "GET") {
        const report = await db.collection<Row>("operations").findOne({ stateId: actor.stateId, tenantId: "state-audit" }, { sort: { createdAt: -1 } });
        const alert = await db.collection<Row>("operations").findOne({ stateId: actor.stateId, tenantId: "state-audit-alert" }, { sort: { createdAt: -1 } });
        const anchor = await db.collection<Row>("anchors").findOne({ stateId: actor.stateId }, { sort: { day: -1 } });
        return Response.json({ report: report?.result ?? null, alert: alert?.result ?? null, anchor: anchor ? { day: anchor.day, merkleRoot: anchor.merkleRoot, count: anchor.count, external: anchor.external ?? null, verification: await verifyAnchor(db, anchor) } : null }, { headers });
      }
      throw new RegistryError(404, "NOT_FOUND");
    } catch (error) {
      const mapped = error instanceof RegistryError ? error : new RegistryError(503, error instanceof MongoError ? "DATABASE_UNAVAILABLE" : "AUDIT_UNAVAILABLE");
      deps.log({ event: "audit.error", code: mapped.code, status: mapped.status });
      return Response.json({ error: mapped.code }, { status: mapped.status, headers });
    }
  });
}
