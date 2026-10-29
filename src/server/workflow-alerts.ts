import "server-only";
import { createHash } from "node:crypto";
import { database } from "./mongodb";
import { STATE_ID } from "./registry-constants";
import type { WorkflowRow } from "./workflow-store";
import type { Db } from "mongodb";
import { workflowId } from "../core/workflow-events";

export async function workflowFailure(requestId: string, source: "orchestration" | "signal", connect: () => Promise<Db> = database) {
  try { workflowId(requestId); } catch { console.error(JSON.stringify({ event: "pulsegrid.alert", kind: "WORKFLOW_INVALID_EVENT", source })); return; }
  // Emit before Atlas access: this alarm still exists when Atlas itself is down.
  console.error(JSON.stringify({ event: "pulsegrid.alert", kind: "WORKFLOW_FAILURE", source, requestId, correlationId: requestId }));
  const db = await connect(), id = `workflow-alert-${createHash("sha256").update(`${source}:${requestId}`).digest("hex")}`;
  await db.collection<WorkflowRow>("operations").updateOne({ _id: id }, { $setOnInsert: { id, stateId: STATE_ID, tenantId: "state-workflow-alert", fingerprint: id, createdAt: new Date(), result: { kind: "WORKFLOW_FAILURE", source, requestId } } }, { upsert: true });
  if (source === "orchestration") await db.collection("requests").updateOne({ id: requestId, "workflow.status": { $nin: ["COMPLETED", "CANCELLED", "ESCALATED"] } }, { $set: { "workflow.status": "FAILED", "workflow.reason": "RETRIES_EXHAUSTED_INSPECT_INNGEST", "workflow.updatedAt": new Date() } });
}
