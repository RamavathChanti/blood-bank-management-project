import { COMPONENTS, GROUPS } from "./domain";
import * as v from "./validation";

export const workflowId = (input: unknown) => {
  const value = v.text(input);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid ID");
  return value;
};
export const emergencyInput = v.object({ key: workflowId, group: v.oneOf(GROUPS), component: v.oneOf(COMPONENTS), quantity: v.number(1, 20, true), urgency: v.oneOf(["URGENT", "CRITICAL"]), expectedTransfusionAt: v.instant });
export type EmergencyInput = ReturnType<typeof emergencyInput>;
export const SIGNALS = ["donor.reply", "stock.ready", "dispatch.approved", "handover", "synthetic-use", "cancel", "escalate"] as const;
export type SignalKind = typeof SIGNALS[number];
const common = { key: workflowId };
export type SignalInput = { key: string; donorId?: string; reply?: "ACCEPTED" | "DECLINED"; unitId?: string; allocationId?: string; preparationConfirmed?: boolean };
export function signalInput(kind: SignalKind, input: unknown): SignalInput {
  if (kind === "donor.reply") return v.object({ ...common, donorId: workflowId, reply: v.oneOf(["ACCEPTED", "DECLINED"]) })(input);
  if (kind === "stock.ready") return v.object({ ...common, unitId: workflowId })(input);
  if (kind === "dispatch.approved") return v.object({ ...common, unitId: workflowId, allocationId: workflowId, preparationConfirmed: v.boolean })(input);
  if (kind === "handover" || kind === "synthetic-use") return v.object({ ...common, unitId: workflowId, allocationId: workflowId })(input);
  return v.object(common)(input);
}
export const WORKFLOW_TERMINAL = ["COMPLETED", "CANCELLED", "ESCALATED", "FAILED"];
export const WAVE_RADII = [5, 10, 25] as const;
export const WAVE_WAIT_MS = 3 * 60_000;
export const RECHECK_MS = 5 * 60_000;
