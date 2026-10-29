import { canonical, GENESIS, sha256, unitState, type AuditEvent, type AuditRecord } from "./audit";
import { createCollectedUnit, transitionUnit, type UnitCommand } from "./lifecycle";
import { parseRequest, type Unit } from "./domain";

export async function passportFixture() {
  const start = Date.parse("2026-10-29T09:00:00.000Z"), events: AuditEvent[] = [];
  let model = createCollectedUnit({ id: "passport-local-1", bankId: "local-bank", donorId: "synthetic-local", group: "O-", component: "PRBC", product: "PRBC_SAGM", collectedAt: new Date(start).toISOString() });
  let unit: AuditRecord = {};
  async function append(next: Unit, detail: AuditRecord, minute: number) {
    const seq = events.length + 1, state = JSON.parse(canonical({ ...next, _id: next.id, stateId: "local-only", tenantId: "local-bank" }));
    const event = { ...detail, action: String(detail.action), id: `local-event-${seq}`, unitId: next.id, stateId: "local-only", tenantId: "local-bank", bankId: next.bankId, seq, actorId: "synthetic-demo-operator", at: new Date(start + minute * 60000).toISOString(), prevHash: events.at(-1)?.hash ?? GENESIS, beforeStateHash: events.at(-1)?.stateHash ?? GENESIS, stateHash: await sha256(canonical(state)), state };
    const sealed = { ...event, hash: await sha256(event.prevHash + canonical(event)) } as AuditEvent;
    events.push(sealed); unit = { ...state, auditSeq: seq, auditHead: sealed.hash }; model = next;
  }
  await append(model, { action: "COLLECT", to: "COLLECTED" }, 0);
  const request = parseRequest({ id: "local-request", hospitalId: "local-hospital", group: "O-", component: "PRBC", quantity: 1, allocatedQuantity: 0, transfusedQuantity: 0, urgency: "ROUTINE", expectedTransfusionAt: new Date(start + 3600000).toISOString(), status: "OPEN" });
  const commands: UnitCommand[] = [{ type: "START_TESTING" }, { type: "UPDATE_SCREENING", screening: { HIV: "NON_REACTIVE", HEPATITIS_B: "NON_REACTIVE", HEPATITIS_C: "NON_REACTIVE", SYPHILIS: "NON_REACTIVE", MALARIA: "NON_REACTIVE" } }, { type: "VERIFY_STORAGE", storage: "VERIFIED" }, { type: "MAKE_AVAILABLE" }, { type: "RESERVE", request, allocationId: "local-allocation" }, { type: "ISSUE", request: { ...request, status: "ALLOCATED", allocatedQuantity: 1 } }, { type: "HANDOVER", requestId: request.id }, { type: "TRANSFUSE", requestId: request.id }];
  for (let i = 0; i < commands.length; i++) {
    const minute = i + 1, change = transitionUnit(model, commands[i], { now: new Date(start + minute * 60000).toISOString(), actorId: "synthetic-demo-operator", eventId: `local-event-${i + 2}` });
    await append(change.unit, change.event, minute);
  }
  return { unit, events };
}
export function tamperFixture(fixture: Awaited<ReturnType<typeof passportFixture>>, mode: "event" | "missing" | "reordered" | "unit") {
  const copy = structuredClone(fixture);
  if (mode === "event") copy.events[2].actorId = "changed-by-demo";
  if (mode === "missing") copy.events.splice(2, 1);
  if (mode === "reordered") [copy.events[2], copy.events[3]] = [copy.events[3], copy.events[2]];
  if (mode === "unit") copy.unit.expiresAt = "2027-01-01T00:00:00.000Z";
  return copy;
}
export { unitState };
