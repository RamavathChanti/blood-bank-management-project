import "server-only";
import { NonRetriableError } from "inngest";
import { inngest } from "./client";
import { changed, donorWaveOpened, escalationNotice, requestCreated, donorReply, stockReady, dispatchApproved, handover, syntheticUse, cancelled, escalated } from "./events";
import { orchestrate } from "./orchestrate";
import { database } from "../server/mongodb";
import { WorkflowStore } from "../server/workflow-store";
import { RegistryError } from "../server/errors";
import { deliverDonorPush, pushPublicKey } from "../server/donor-push";
import { workflowId } from "../core/workflow-events";
import { auditVerifier, auditAnchor } from "./audit-functions";
import { forecastMaintenance } from "./forecast-functions";
import { workflowTrace } from "../server/telemetry";
import { workflowFailure } from "../server/workflow-alerts";
import { ATLAS_WORKFLOW_CONCURRENCY, CRITICAL_PRIORITY } from "../core/surge";

export const workflowConcurrency = [
  ATLAS_WORKFLOW_CONCURRENCY,
  { limit: 1, key: "event.data.requestId", scope: "fn" as const }
] as const;
const store = async () => new WorkflowStore(await database());
export const emergencyWorkflow = inngest.createFunction({
  id: "emergency-orchestration-v1", triggers: [requestCreated], retries: 8,
  concurrency: [...workflowConcurrency], idempotency: "event.data.requestId",
  priority: { run: CRITICAL_PRIORITY },
  onFailure: async ({ event, step }) => {
    const requestId = event.data.event.data.requestId;
    await step.run("record-exhausted-retries", async () => {
      await workflowFailure(requestId, "orchestration");
    });
  }
}, async ({ event, step, runId }) => {
  try {
    return await orchestrate(event.data, runId, event.id ?? event.data.requestId, {
      run: <T>(id: string, action: () => Promise<T>) => step.run(id, () => workflowTrace(event.data.requestId, action, id)) as Promise<T>,
      wait: async (id, until) => { await step.waitForEvent(id, { event: changed, timeout: new Date(until), match: "data.requestId" }); },
      notifyWave: async (requestId, index) => { await step.sendEvent(`publish-donor-push-${index}`, donorWaveOpened.create({ requestId, index }, { id: `${requestId}-push-${index}` })); },
      escalation: async (id, reason) => { await step.sendEvent(id, escalationNotice.create({ requestId: event.data.requestId, reason }, { id: `${event.data.requestId}-escalation` })); }
    }, store);
  } catch (error) {
    if (error instanceof RegistryError && error.status < 500) throw new NonRetriableError(error.code);
    throw error;
  }
});
export const emergencySignals = inngest.createFunction({
  id: "emergency-signals-v1", triggers: [donorReply, stockReady, dispatchApproved, handover, syntheticUse, cancelled, escalated], retries: 8,
  concurrency: [...workflowConcurrency], idempotency: "event.data.signalId",
  onFailure: async ({ event, step }) => { await step.run("record-signal-failure", () => workflowFailure(event.data.event.data.requestId, "signal")); }
}, async ({ event, step }) => {
  await step.run("persist-signal", () => workflowTrace(event.data.requestId, async () => (await store()).ingest(event.data)));
  await step.run("apply-persisted-signal", () => workflowTrace(event.data.requestId, async () => (await store()).reconcile(event.data.requestId)));
  await step.sendEvent("wake-request", changed.create({ requestId: event.data.requestId }, { id: `${event.data.signalId}-wake` }));
  return { requestId: event.data.requestId };
});
// Provider retries are isolated from stock allocation, donor receipts and handover.
export const donorPushWorkflow = inngest.createFunction({ id: "donor-push-v1", triggers: [donorWaveOpened], retries: 8, concurrency: [ATLAS_WORKFLOW_CONCURRENCY, { limit: 1, scope: "fn" }], idempotency: 'event.data.requestId + "-" + event.data.index' }, async ({ event, step }) => {
  const requestId = workflowId(event.data.requestId);
  if (![0, 1, 2].includes(event.data.index)) throw new NonRetriableError("INVALID_WAVE");
  return step.run("deliver-current-donor-alerts", async () => {
    if (!pushPublicKey()) return { configured: false };
    await deliverDonorPush(await database(), requestId);
    return { configured: true };
  });
});
export const functions = [emergencyWorkflow, emergencySignals, donorPushWorkflow, forecastMaintenance, auditVerifier, auditAnchor];
