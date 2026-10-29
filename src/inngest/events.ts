import { eventType, staticSchema } from "inngest";
import type { EmergencyInput, SignalInput, SignalKind } from "../core/workflow-events";
import type { Principal } from "../server/identity";

export type CreatedData = { requestId: string; actor: Principal; input: EmergencyInput; acceptedAt: string; fingerprint: string };
export type SignalData = { requestId: string; actor: Principal; kind: SignalKind; input: SignalInput; receivedAt: string; signalId: string };
// Runtime validation is also performed at both HTTP and worker boundaries.
export const requestCreated = eventType("pulsegrid/emergency.created", { schema: staticSchema<CreatedData>() });
export const donorReply = eventType("pulsegrid/donor.reply", { schema: staticSchema<SignalData>() });
export const stockReady = eventType("pulsegrid/stock.ready", { schema: staticSchema<SignalData>() });
export const dispatchApproved = eventType("pulsegrid/dispatch.approved", { schema: staticSchema<SignalData>() });
export const handover = eventType("pulsegrid/handover", { schema: staticSchema<SignalData>() });
export const syntheticUse = eventType("pulsegrid/synthetic-use", { schema: staticSchema<SignalData>() });
export const cancelled = eventType("pulsegrid/emergency.cancel", { schema: staticSchema<SignalData>() });
export const escalated = eventType("pulsegrid/emergency.escalate", { schema: staticSchema<SignalData>() });
export const changed = eventType("pulsegrid/emergency.changed", { schema: staticSchema<{ requestId: string }>() });
export const donorWaveOpened = eventType("pulsegrid/donor.wave-opened", { schema: staticSchema<{ requestId: string; index: number }>() });
export const escalationNotice = eventType("pulsegrid/emergency.escalated", { schema: staticSchema<{ requestId: string; reason: string }>() });
export const signalTypes = { "donor.reply": donorReply, "stock.ready": stockReady, "dispatch.approved": dispatchApproved, handover, "synthetic-use": syntheticUse, cancel: cancelled, escalate: escalated };
