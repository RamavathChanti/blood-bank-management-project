import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "mongodb";
import { emergencyInput, signalInput, SIGNALS, workflowId, type SignalKind } from "../core/workflow-events";
import { inngest, requireWorkflow } from "../inngest/client";
import { requestCreated, signalTypes, type CreatedData, type SignalData } from "../inngest/events";
import { identity, type Principal } from "./identity";
import { database } from "./mongodb";
import { WorkflowStore, workflowDigest } from "./workflow-store";
import { RegistryError, deny, validate } from "./errors";
import { readJsonInput } from "./registry-api";
import { span, traced, correlateRequest } from "./telemetry";

const headers = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie, Authorization", "X-Content-Type-Options": "nosniff" };
type Receipt = { requestId: string; tenantId: string; hospitalId: string; stateId: string; acceptedAt: string; eventIds: string[] };
type Payload = { id: string; name: string; data: CreatedData | SignalData };
export type EmergencyDependencies = {
  identity: () => Promise<Principal>; database: () => Promise<Db>;
  send: (payload: Payload) => Promise<{ ids: string[] }>;
  configured: () => void; secret: () => string; now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};
const defaults: EmergencyDependencies = { identity, database, send: payload => inngest.send(payload), configured: requireWorkflow, secret: () => {
  const secret = process.env.WORKFLOW_RECEIPT_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (process.env.INNGEST_DEV === "1" && !process.env.VERCEL) return "pulsegrid-local-dev-receipts-only-2026";
  throw new RegistryError(503, "WORKFLOW_RECEIPT_SECRET_REQUIRED");
}, now: () => new Date(), log: entry => console.warn(JSON.stringify(entry)) };
function sign(receipt: Receipt, secret: string) {
  const payload = Buffer.from(JSON.stringify(receipt)).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
function receipt(request: Request, actor: Principal, id: string, secret: string): Receipt | undefined {
  const token = request.headers.get("x-emergency-receipt");
  if (!token) return;
  try {
    if (token.length > 4096) throw new Error();
    const [payload, signature, extra] = token.split(".");
    const expected = createHmac("sha256", secret).update(payload).digest(), actual = Buffer.from(signature, "base64url");
    if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Receipt;
    if (actor.role !== "HOSPITAL" || value.requestId !== id || value.tenantId !== actor.tenantId || value.hospitalId !== actor.hospitalId || value.stateId !== actor.stateId) throw new Error();
    return value;
  } catch { return deny("INVALID_RECEIPT"); }
}
function dashboard() {
  const configured = process.env.WORKFLOW_DASHBOARD_URL;
  try { const url = new URL(configured ?? (process.env.INNGEST_DEV === "1" && !process.env.VERCEL ? "http://127.0.0.1:8288/runs" : "https://app.inngest.com")); if (url.protocol === "https:" && url.hostname === "app.inngest.com" || process.env.INNGEST_DEV === "1" && !process.env.VERCEL && ["127.0.0.1", "localhost"].includes(url.hostname)) return url.toString(); } catch { /* No arbitrary browser links. */ }
  return "https://app.inngest.com";
}
export function emergencyHandler(deps = defaults) {
  return traced("emergency", async (request: Request, path: string[] = []) => {
    let accepted: Receipt | undefined;
    try {
      const actor = await deps.identity(), now = deps.now();
      if (new URL(request.url).search) throw new RegistryError(400, "INVALID_INPUT");
      if (path.length) { validate(workflowId, path[0]); correlateRequest(path[0]); }
      if (request.method === "POST" && path.length === 0) {
        if (actor.role !== "HOSPITAL") deny();
        const input = validate(emergencyInput, await readJsonInput(request));
        const duration = Date.parse(input.expectedTransfusionAt) - now.getTime();
        if (duration <= 0 || duration > 86_400_000) throw new RegistryError(400, "DEADLINE_OUT_OF_RANGE");
        deps.configured(); const secret = deps.secret();
        const requestId = `emergency-${workflowDigest([actor.stateId, actor.tenantId, actor.hospitalId, input]).slice(0, 48)}`;
        correlateRequest(requestId);
        const data: CreatedData = { requestId, input, actor, fingerprint: workflowDigest(input), acceptedAt: now.toISOString() };
        // No database call precedes durable acknowledgement.
        let result;
        try { result = await span("workflow", "durable-intake", () => deps.send({ ...requestCreated.create(data), id: `${requestId}-created` })); }
        catch { return Response.json({ accepted: false, status: "ACKNOWLEDGEMENT_UNKNOWN", error: "WORKFLOW_UNAVAILABLE", requestId, retrySamePayload: true }, { status: 503, headers }); }
        if (!result.ids.length || result.ids.some(id => typeof id !== "string" || !id)) throw new RegistryError(503, "WORKFLOW_ACK_MISSING");
        const ack: Receipt = { requestId, tenantId: actor.tenantId, hospitalId: actor.hospitalId, stateId: actor.stateId, acceptedAt: data.acceptedAt, eventIds: result.ids };
        return Response.json({ accepted: true, status: "ACKNOWLEDGED_PENDING", requestId, eventIds: result.ids, receipt: sign(ack, secret), statusUrl: `/api/emergencies/${requestId}`, dashboardUrl: dashboard() }, { status: 202, headers });
      }
      const [requestId, kind] = path;
      if (!requestId) throw new RegistryError(404, "NOT_FOUND");
      if (actor.role === "HOSPITAL") accepted = receipt(request, actor, requestId, deps.secret());
      if (request.method === "GET" && path.length === 1) {
        const store = new WorkflowStore(await deps.database(), now);
        const req = await store.c("requests").findOne({ _id: requestId, stateId: actor.stateId, workflow: { $exists: true } });
        if (!req) {
          if (!accepted) deny();
          return Response.json({ accepted: true, status: "ACKNOWLEDGED_PENDING", requestId, eventIds: accepted.eventIds, dashboardUrl: dashboard() }, { status: 202, headers });
        }
        if (actor.role !== "STATE_ADMIN" && (actor.role !== "HOSPITAL" || actor.hospitalId !== req.hospitalId || actor.tenantId !== req.tenantId)) deny();
        if (actor.role === "HOSPITAL" && !await store.c("hospitals").findOne({ _id: actor.hospitalId, tenantId: actor.tenantId, stateId: actor.stateId })) deny("MEMBERSHIP_REQUIRED");
        const allocations = await store.c("allocations").find({ requestId, hospitalId: req.hospitalId, hospitalTenantId: req.tenantId, stateId: req.stateId, status: { $ne: "RELEASED" } }, { projection: { _id: 0, id: 1, unitId: 1, bankId: 1, status: 1, handoverAt: 1, dispatchApproved: 1 } }).limit(20).toArray();
        const replies = await store.c("alerts").aggregate<{ _id: string; count: number }>([{ $match: { requestId, stateId: actor.stateId } }, { $group: { _id: "$status", count: { $sum: 1 } } }]).toArray();
        const count = (status: string) => replies.find(r => r._id === status)?.count ?? 0;
        return Response.json({ accepted: true, requestId, status: req.workflow.status, requestStatus: req.status, quantity: req.quantity, allocatedQuantity: req.allocatedQuantity, transfusedQuantity: req.transfusedQuantity, acceptedDonors: count("ACCEPTED"), declinedDonors: count("DECLINED"), expectedTransfusionAt: req.expectedTransfusionAt, workflow: req.workflow, allocations, dashboardUrl: dashboard() }, { headers });
      }
      if (request.method === "POST" && path.length === 2 && SIGNALS.includes(kind as SignalKind)) {
        const signalKind = kind as SignalKind, input = validate(v => signalInput(signalKind, v), await readJsonInput(request));
        deps.configured();
        // A signed intake receipt lets cancellation queue even during an Atlas outage.
        if (!(accepted && (kind === "cancel" || kind === "escalate"))) {
          const store = new WorkflowStore(await deps.database(), now), req = await store.request(requestId);
          await store.authorizeSignal(req, actor, signalKind, input);
          if (["COMPLETED", "CANCELLED", "ESCALATED", "FAILED"].includes(req.workflow.status)) throw new RegistryError(409, "WORKFLOW_CLOSED");
        }
        const signalId = `signal-${workflowDigest([requestId, actor, signalKind, input])}`;
        const data: SignalData = { requestId, actor, kind: signalKind, input, signalId, receivedAt: now.toISOString() };
        const result = await span("workflow", "durable-signal", () => deps.send({ ...signalTypes[signalKind].create(data), id: signalId }));
        if (!result.ids.length) throw new RegistryError(503, "WORKFLOW_ACK_MISSING");
        return Response.json({ accepted: true, status: "SIGNAL_ACKNOWLEDGED_PENDING", requestId, signalId, eventIds: result.ids }, { status: 202, headers });
      }
      throw new RegistryError(404, "NOT_FOUND");
    } catch (error) {
      const mapped = error instanceof RegistryError ? error : new RegistryError(503, "WORKFLOW_OR_DATABASE_UNAVAILABLE");
      deps.log({ event: "emergency.error", code: mapped.code, status: mapped.status });
      return Response.json({ error: mapped.code, ...(accepted && mapped.status >= 500 ? { accepted: true, requestId: accepted.requestId, status: "ACKNOWLEDGED_STATUS_UNAVAILABLE", eventIds: accepted.eventIds } : {}) }, { status: mapped.status, headers });
    }
  });
}
