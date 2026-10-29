import * as v from "./validation";

export const GROUPS = ["O-", "O+", "A-", "A+", "B-", "B+", "AB-", "AB+"] as const;
export const COMPONENTS = ["PRBC", "PLATELETS", "FFP"] as const;
export const PRODUCTS = ["PRBC_SAGM", "PRBC_CPDA1", "PLATELETS_CLOSED", "FFP_FROZEN"] as const;
export const STATUSES = ["COLLECTED", "TESTING", "AVAILABLE", "RESERVED", "ISSUED", "TRANSFUSED", "EXPIRED", "DISCARDED", "RETURNED_QUARANTINE", "QUARANTINED"] as const;
export const SCREENS = ["HIV", "HEPATITIS_B", "HEPATITIS_C", "SYPHILIS", "MALARIA"] as const;
export type Group = typeof GROUPS[number];
export type Component = typeof COMPONENTS[number];
export type Product = typeof PRODUCTS[number];
export type UnitStatus = typeof STATUSES[number];
export const parseGroup = v.oneOf(GROUPS);
export const parseComponent = v.oneOf(COMPONENTS);
const screeningResult = v.optional(v.oneOf(["PENDING", "NON_REACTIVE", "REACTIVE", "INVALID"]));
export const parseScreening = v.object({ HIV: screeningResult, HEPATITIS_B: screeningResult, HEPATITIS_C: screeningResult, SYPHILIS: screeningResult, MALARIA: screeningResult });
export type Screening = ReturnType<typeof parseScreening>;
export const parseLocation = v.object({ latitude: v.number(-90, 90), longitude: v.number(-180, 180) });
const institution = { id: v.text, name: v.text, district: v.text, location: parseLocation };
export const parseBank = v.object(institution);
export const parseHospital = v.object(institution);
export type Bank = ReturnType<typeof parseBank>;
export type Hospital = ReturnType<typeof parseHospital>;
const deferral = v.object({ kind: v.oneOf(["TEMPORARY", "PERMANENT"]), reason: v.text, until: v.optional(v.instant) });
const donor = v.object({ id: v.text, nickname: v.text, group: parseGroup, location: parseLocation, birthDate: v.dateOnly, weightKg: v.number(1, 500), haemoglobin: v.number(0, 30), donationVolumeMl: v.oneOf([350, 450]), lastDonationAt: v.optional(v.instant), eligibleFrom: v.instant, deferrals: v.array(deferral) });
export function parseDonor(value: unknown) {
  const result = donor(value, "donor");
  for (const entry of result.deferrals) if (entry.kind === "TEMPORARY" && !entry.until) v.invalid("donor.deferrals", "temporary deferrals require an end date");
  return result;
}
export type Donor = ReturnType<typeof parseDonor>;
const reservation = v.object({ requestId: v.text, allocationId: v.text, recipientGroup: parseGroup, reservedAt: v.instant, leaseExpiresAt: v.instant, expectedTransfusionAt: v.instant });
const unit = v.object({ id: v.text, bankId: v.text, donorId: v.text, group: parseGroup, component: parseComponent, product: v.oneOf(PRODUCTS), collectedAt: v.instant, expiresAt: v.instant, status: v.oneOf(STATUSES), screening: parseScreening, storage: v.oneOf(["UNKNOWN", "VERIFIED", "FAILED"]), reservation: v.optional(reservation), handoverAt: v.optional(v.instant), preparationConfirmedAt: v.optional(v.instant), lastEventAt: v.optional(v.instant) });
export function componentFor(product: Product): Component { return product.startsWith("PRBC_") ? "PRBC" : product === "FFP_FROZEN" ? "FFP" : "PLATELETS"; }
export function parseUnit(value: unknown) {
  const result = unit(value, "unit");
  if (componentFor(result.product) !== result.component) v.invalid("unit.product", "component mismatch");
  if (Date.parse(result.expiresAt) <= Date.parse(result.collectedAt)) v.invalid("unit.expiresAt", "must follow collection");
  const owned = ["RESERVED", "ISSUED", "TRANSFUSED"].includes(result.status);
  if (owned !== Boolean(result.reservation)) v.invalid("unit.reservation", "ownership must agree with lifecycle state");
  if (result.lastEventAt && Date.parse(result.lastEventAt) < Date.parse(result.collectedAt)) v.invalid("unit.lastEventAt", "precedes collection");
  if (result.reservation) {
    const r = result.reservation;
    if (Date.parse(r.reservedAt) < Date.parse(result.collectedAt) || Date.parse(r.leaseExpiresAt) <= Date.parse(r.reservedAt) || Date.parse(r.expectedTransfusionAt) < Date.parse(r.reservedAt)) v.invalid("unit.reservation", "invalid reservation chronology");
  }
  for (const at of [result.handoverAt, result.preparationConfirmedAt]) if (at && (Date.parse(at) < Date.parse(result.collectedAt) || (result.lastEventAt && Date.parse(at) > Date.parse(result.lastEventAt)))) v.invalid("unit", "invalid confirmation chronology");
  if (result.handoverAt && !["ISSUED", "TRANSFUSED"].includes(result.status)) v.invalid("unit.handoverAt", "requires issued stock");
  if (result.status === "TRANSFUSED" && !result.handoverAt) v.invalid("unit.handoverAt", "required before synthetic use");
  if (result.component === "FFP" && ["ISSUED", "TRANSFUSED"].includes(result.status) && !result.preparationConfirmedAt) v.invalid("unit.preparationConfirmedAt", "frozen plasma requires synthetic preparation");
  return result;
}
export type Unit = ReturnType<typeof parseUnit>;
const request = v.object({ id: v.text, hospitalId: v.text, group: parseGroup, component: parseComponent, quantity: v.number(1, 1000, true), allocatedQuantity: v.number(0, 1000, true), transfusedQuantity: v.number(0, 1000, true), urgency: v.oneOf(["ROUTINE", "URGENT", "CRITICAL"]), expectedTransfusionAt: v.instant, status: v.oneOf(["OPEN", "PARTIAL", "ALLOCATED", "COMPLETED", "CANCELLED", "ESCALATED"]) });
export function parseRequest(value: unknown) {
  const result = request(value, "request");
  if (result.allocatedQuantity > result.quantity || result.transfusedQuantity > result.allocatedQuantity) v.invalid("request", "quantity counters disagree");
  if ((result.status === "COMPLETED") !== (result.transfusedQuantity === result.quantity)) v.invalid("request.status", "completion requires every unit's synthetic use");
  if (result.status === "OPEN" && result.allocatedQuantity !== 0 || result.status === "PARTIAL" && !(result.allocatedQuantity > 0 && result.allocatedQuantity < result.quantity) || result.status === "ALLOCATED" && result.allocatedQuantity !== result.quantity) v.invalid("request.status", "status disagrees with allocation count");
  return result;
}
export type BloodRequest = ReturnType<typeof parseRequest>;
const allocation = v.object({ id: v.text, unitId: v.text, requestId: v.text, status: v.oneOf(["ACTIVE", "RELEASED", "ISSUED", "TRANSFUSED"]), reservedAt: v.instant, leaseExpiresAt: v.instant, updatedAt: v.instant });
export function parseAllocation(value: unknown) {
  const result = allocation(value, "allocation");
  if (Date.parse(result.leaseExpiresAt) <= Date.parse(result.reservedAt) || Date.parse(result.updatedAt) < Date.parse(result.reservedAt)) v.invalid("allocation", "invalid chronology");
  return result;
}
export type Allocation = ReturnType<typeof parseAllocation>;
export const ACTIONS = ["START_TESTING", "UPDATE_SCREENING", "VERIFY_STORAGE", "MAKE_AVAILABLE", "RESERVE", "CANCEL_RESERVATION", "EXPIRE_RESERVATION", "ISSUE", "HANDOVER", "TRANSFUSE", "RETURN", "EXPIRE", "DISCARD", "QUARANTINE"] as const;
const lifecycleEvent = v.object({ id: v.text, unitId: v.text, at: v.instant, actorId: v.text, action: v.oneOf(ACTIONS), from: v.oneOf(STATUSES), to: v.oneOf(STATUSES), requestId: v.optional(v.text), allocationId: v.optional(v.text), note: v.optional(v.text), screening: v.optional(parseScreening), storage: v.optional(v.oneOf(["UNKNOWN", "VERIFIED", "FAILED"])), leaseExpiresAt: v.optional(v.instant), expectedTransfusionAt: v.optional(v.instant) });
export function parseLifecycleEvent(value: unknown) {
  const result = lifecycleEvent(value, "event");
  const transitions: Record<typeof ACTIONS[number], readonly string[]> = {
    QUARANTINE: ["COLLECTED:QUARANTINED", "TESTING:QUARANTINED", "AVAILABLE:QUARANTINED", "RESERVED:QUARANTINED", "ISSUED:QUARANTINED", "RETURNED_QUARANTINE:QUARANTINED"],
    START_TESTING: ["COLLECTED:TESTING"], UPDATE_SCREENING: ["TESTING:TESTING", "TESTING:DISCARDED"], VERIFY_STORAGE: ["COLLECTED:COLLECTED", "COLLECTED:DISCARDED", "TESTING:TESTING", "TESTING:DISCARDED"], MAKE_AVAILABLE: ["TESTING:AVAILABLE"], RESERVE: ["AVAILABLE:RESERVED"], CANCEL_RESERVATION: ["RESERVED:AVAILABLE", "RESERVED:EXPIRED", "RESERVED:DISCARDED"], EXPIRE_RESERVATION: ["RESERVED:AVAILABLE", "RESERVED:EXPIRED", "RESERVED:DISCARDED"], ISSUE: ["RESERVED:ISSUED"], HANDOVER: ["ISSUED:ISSUED"], TRANSFUSE: ["ISSUED:TRANSFUSED"], RETURN: ["ISSUED:RETURNED_QUARANTINE"], EXPIRE: ["COLLECTED:EXPIRED", "TESTING:EXPIRED", "AVAILABLE:EXPIRED", "RESERVED:EXPIRED", "ISSUED:EXPIRED", "RETURNED_QUARANTINE:EXPIRED", "QUARANTINED:EXPIRED"], DISCARD: ["COLLECTED:DISCARDED", "TESTING:DISCARDED", "AVAILABLE:DISCARDED", "RESERVED:DISCARDED", "ISSUED:DISCARDED", "RETURNED_QUARANTINE:DISCARDED", "QUARANTINED:DISCARDED"]
  };
  if (!transitions[result.action].includes(`${result.from}:${result.to}`)) v.invalid("event", "action disagrees with lifecycle transition");
  if (["RESERVE", "CANCEL_RESERVATION", "EXPIRE_RESERVATION", "ISSUE", "HANDOVER", "TRANSFUSE", "RETURN"].includes(result.action) && (!result.requestId || !result.allocationId)) v.invalid("event", "ownership IDs are required");
  return result;
}
export type LifecycleEvent = ReturnType<typeof parseLifecycleEvent>;
