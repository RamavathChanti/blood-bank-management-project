import "server-only";
import { identity } from "./identity";
import { database } from "./mongodb";
import { RegistryError, deny } from "./errors";
import { readJsonInput } from "./registry-api";
import { controlsEnabled, readDemoFlags, writeDemoFlags } from "./demo-controls";
import { span, telemetrySnapshot, traced } from "./telemetry";
import { workflowConfigured } from "../inngest/client";
import { reconciliation, reconcileOutcome } from "../core/resilience";
import type { WorkflowRow } from "./workflow-store";

const defaults = { identity, database, read: readDemoFlags, write: writeDemoFlags };
export function resilienceHandler(deps = defaults) {
  return traced("resilience", async (request: Request, path: string[]) => {
    const headers = { "Cache-Control": "private, no-store", Vary: "Cookie, Authorization", "X-Content-Type-Options": "nosniff" };
    try {
      const actor = await deps.identity(); if (actor.role !== "STATE_ADMIN") deny();
      if (new URL(request.url).search) throw new RegistryError(400, "INVALID_INPUT");
      const action = path.join("/");
      if (action === "flags" && request.method === "POST") return Response.json(await deps.write(await readJsonInput(request)), { headers });
      if (action === "reconcile" && request.method === "POST") {
        const body = await readJsonInput(request) as { acknowledgedIds: unknown };
        if (!body || Object.keys(body).join() !== "acknowledgedIds" || !Array.isArray(body.acknowledgedIds) || !body.acknowledgedIds.length || body.acknowledgedIds.length > 100 || body.acknowledgedIds.some(id => typeof id !== "string" || !/^emergency-[a-f0-9]{48}$/.test(id))) throw new RegistryError(400, "INVALID_ACKNOWLEDGED_IDS");
        const ids = [...new Set(body.acknowledgedIds)] as string[], db = await deps.database();
        const rows = await span("atlas", "reconcile-acknowledgements", () => db.collection<WorkflowRow & { workflow: { status: string; acceptedAt?: string; trace?: { at: string | Date }[] } }>("requests").find({ _id: { $in: ids }, stateId: actor.stateId, workflow: { $exists: true } }, { projection: { _id: 1, workflow: 1 } }).maxTimeMS(5000).limit(100).toArray());
        return Response.json({ ...reconciliation(ids.map(id => reconcileOutcome(id, rows.find(r => r._id === id)))), basis: "Operator-supplied acknowledged IDs; verify each against its signed intake receipt / Inngest event history" }, { headers });
      }
      if (action === "status" && request.method === "GET") {
        let flags = null, config = "disabled", atlas = "unavailable", counts = null, alerts = null;
        try { flags = await deps.read(); config = controlsEnabled() ? "read-ok" : "disabled"; } catch { config = "unavailable"; }
        try {
          const db = await deps.database();
          await span("atlas", "ping", () => db.command({ ping: 1, maxTimeMS: 5000 })); atlas = "reachable";
          const groups = await span("atlas", "workflow-counts", () => db.collection("requests").aggregate<{ _id: string; count: number }>([{ $match: { stateId: actor.stateId, workflow: { $exists: true } } }, { $group: { _id: "$workflow.status", count: { $sum: 1 } } }], { maxTimeMS: 5000 }).toArray());
          counts = { basis: "Materialized Atlas workflows; excludes acknowledgements not yet persisted", byStatus: Object.fromEntries(groups.map(g => [g._id, g.count])) };
          alerts = await db.collection("operations").find({ stateId: actor.stateId, tenantId: { $in: ["state-workflow-alert", "state-audit-alert"] } }, { projection: { _id: 0, id: 1, createdAt: 1, "result.kind": 1, "result.requestId": 1 } }).sort({ createdAt: -1 }).limit(20).maxTimeMS(5000).toArray();
        } catch { /* Unavailable measurements stay null, never zero. */ }
        return Response.json({ flags, controlsEnabled: controlsEnabled(), services: { api: "responding", config, atlas, workflow: workflowConfigured() ? "configured; delivery not probed" : "not configured", realtime: flags?.realtimeDown ? "refresh hints suppressed; polling available" : "browser refresh hints + polling; no hosted realtime provider" }, counts, alerts, telemetry: telemetrySnapshot(), sampledAt: new Date().toISOString() }, { headers });
      }
      throw new RegistryError(404, "NOT_FOUND");
    } catch (error) {
      const mapped = error instanceof RegistryError ? error : new RegistryError(503, "RESILIENCE_UNAVAILABLE");
      return Response.json({ error: mapped.code }, { status: mapped.status, headers });
    }
  });
}
