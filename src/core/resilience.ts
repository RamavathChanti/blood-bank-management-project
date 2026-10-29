export type Reconciled = { requestId: string; outcome: "PENDING" | "ACCEPTED" | "FULFILLED" | "ESCALATED" | "CANCELLED" | "FAILED"; status: string; recoveryMs: number | null };
export function reconcileOutcome(requestId: string, row?: { workflow: { status: string; acceptedAt?: string; trace?: { at: Date | string }[] } }) : Reconciled {
  const status = row?.workflow.status ?? "NOT_MATERIALIZED";
  const outcome = status === "COMPLETED" ? "FULFILLED" : status === "ESCALATED" ? "ESCALATED" : status === "CANCELLED" ? "CANCELLED" : status === "FAILED" ? "FAILED" : row ? "ACCEPTED" : "PENDING";
  const first = row?.workflow.trace?.[0]?.at;
  const latency = first && row?.workflow.acceptedAt ? (first instanceof Date ? first.getTime() : Date.parse(first)) - Date.parse(row.workflow.acceptedAt) : NaN;
  return { requestId, outcome, status, recoveryMs: Number.isFinite(latency) ? Math.max(0, latency) : null };
}
export function reconciliation(rows: Reconciled[]) {
  const count = (kind: Reconciled["outcome"]) => rows.filter(r => r.outcome === kind).length;
  return { acknowledged: rows.length, pending: count("PENDING"), accepted: count("ACCEPTED"), fulfilled: count("FULFILLED"), escalated: count("ESCALATED"), cancelled: count("CANCELLED"), failed: count("FAILED"), loss: rows.length > 0 && rows.every(r => ["FULFILLED", "ESCALATED", "CANCELLED"].includes(r.outcome)) ? 0 : null, lossExplanation: "Zero observed loss is reported only when every supplied acknowledgement has a fulfilled, escalated or cancelled outcome. Unresolved or failed runs need workflow-history investigation; absence in Atlas is not proof of loss.", rows };
}
