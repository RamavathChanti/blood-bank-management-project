import { parseLifecycleEvent, parseRequest, parseScreening, parseUnit, type BloodRequest, type Screening, type Unit, type UnitStatus } from "./domain";
import { readinessReasons, stockReasons, validateRequestForUse, type UnitChange } from "./inventory";
import { isCompatible } from "./compatibility";
import { calculateExpiry, DEFAULT_SHELF_LIFE, type ShelfLifeRules } from "./shelf-life";
import * as v from "./validation";

export const DEFAULT_LEASE_MINUTES = 10;
type Context = Readonly<{ now: string; actorId: string; eventId: string; shelfLife?: ShelfLifeRules }>;
export type UnitCommand =
  | { type: "START_TESTING" | "MAKE_AVAILABLE" | "EXPIRE" }
  | { type: "UPDATE_SCREENING"; screening: Screening }
  | { type: "VERIFY_STORAGE"; storage: Unit["storage"] }
  | { type: "RESERVE"; request: BloodRequest; allocationId: string; leaseMinutes?: number }
  | { type: "CANCEL_RESERVATION" | "EXPIRE_RESERVATION" | "HANDOVER" | "TRANSFUSE"; requestId: string }
  | { type: "ISSUE"; request: BloodRequest; preparationConfirmed?: boolean }
  | { type: "RETURN"; requestId: string; note: string }
  | { type: "DISCARD" | "QUARANTINE"; note: string };

/** A pure transition: no clock reads, I/O, mutation, role assertion, or implicit lease renewal. */
export function transitionUnit(input: Unit, command: UnitCommand, context: Context): UnitChange {
  const unit = parseUnit(input), now = v.instant(context.now), time = Date.parse(now), rules = context.shelfLife ?? DEFAULT_SHELF_LIFE;
  v.text(context.actorId); v.text(context.eventId);
  if (time < Date.parse(unit.lastEventAt ?? unit.collectedAt)) throw new Error("Lifecycle clock cannot move backwards");
  const expect = (...states: UnitStatus[]) => { if (!states.includes(unit.status)) throw new Error(`${command.type} not permitted from ${unit.status}`); };
  const requireReady = (expectedAt = now) => { const reasons = readinessReasons(unit, now, expectedAt, rules); if (reasons.length) throw new Error(`Readiness rejected: ${reasons.join(", ")}`); };
  const requireOwner = (requestId: string) => { v.text(requestId); if (unit.reservation?.requestId !== requestId) throw new Error("Reservation owner mismatch"); };
  let next: Unit = { ...unit, lastEventAt: now };
  let requestId = unit.reservation?.requestId, allocationId = unit.reservation?.allocationId, note: string | undefined;
  switch (command.type) {
    case "QUARANTINE": expect("COLLECTED", "TESTING", "AVAILABLE", "RESERVED", "ISSUED", "RETURNED_QUARANTINE"); note = v.text(command.note); next = { ...next, status: "QUARANTINED", storage: "FAILED", reservation: undefined, handoverAt: undefined, preparationConfirmedAt: undefined }; break;
    case "START_TESTING": expect("COLLECTED"); next = { ...next, status: "TESTING" }; break;
    case "UPDATE_SCREENING": {
      expect("TESTING"); const screening = parseScreening(command.screening);
      next = { ...next, screening, status: Object.values(screening).includes("REACTIVE") ? "DISCARDED" : "TESTING" }; break;
    }
    case "VERIFY_STORAGE":
      expect("COLLECTED", "TESTING"); next = { ...next, storage: v.oneOf(["UNKNOWN", "VERIFIED", "FAILED"])(command.storage), status: command.storage === "FAILED" ? "DISCARDED" : unit.status }; break;
    case "MAKE_AVAILABLE": expect("TESTING"); requireReady(); next = { ...next, status: "AVAILABLE" }; break;
    case "RESERVE": {
      expect("AVAILABLE"); const request = validateRequestForUse(command.request, now);
      if (request.allocatedQuantity >= request.quantity) throw new Error("Request quantity already allocated");
      const reasons = stockReasons(unit, request, now, rules); if (reasons.length) throw new Error(`Reservation rejected: ${reasons.join(", ")}`);
      allocationId = v.text(command.allocationId); requestId = request.id;
      const minutes = v.number(0.01, 1440)(command.leaseMinutes ?? DEFAULT_LEASE_MINUTES);
      // A lease cannot outlive expected use or the product. Equal-to-now use is matchable but not reservable.
      const end = Math.min(time + minutes * 60_000, Date.parse(request.expectedTransfusionAt), Date.parse(unit.expiresAt));
      if (end <= time) throw new Error("Reservation requires a future expected-use instant");
      next = { ...next, status: "RESERVED", reservation: { requestId, allocationId, recipientGroup: request.group, expectedTransfusionAt: request.expectedTransfusionAt, reservedAt: now, leaseExpiresAt: new Date(end).toISOString() } }; break;
    }
    case "CANCEL_RESERVATION":
    case "EXPIRE_RESERVATION": {
      expect("RESERVED"); requireOwner(command.requestId);
      if (command.type === "EXPIRE_RESERVATION" && time < Date.parse(unit.reservation!.leaseExpiresAt)) throw new Error("Reservation lease has not expired");
      const reasons = readinessReasons(unit, now, now, rules);
      next = { ...next, reservation: undefined, status: reasons.includes("EXPIRED") ? "EXPIRED" : reasons.length ? "DISCARDED" : "AVAILABLE" }; break;
    }
    case "ISSUE": {
      expect("RESERVED"); const request = validateRequestForUse(command.request, now); requireOwner(request.id);
      if (time >= Date.parse(unit.reservation!.leaseExpiresAt)) throw new Error("Reservation lease expired");
      if (request.component !== unit.component || request.group !== unit.reservation!.recipientGroup || request.expectedTransfusionAt !== unit.reservation!.expectedTransfusionAt) throw new Error("Request changed since reservation; release and rematch");
      if (!isCompatible(unit.group, request.group, unit.component)) throw new Error("Issue compatibility check failed");
      if (!["PARTIAL", "ALLOCATED"].includes(request.status)) throw new Error("Issue requires an allocated request");
      requireReady(request.expectedTransfusionAt);
      if (unit.component === "FFP" && command.preparationConfirmed !== true) throw new Error("Frozen plasma requires explicit synthetic preparation confirmation");
      next = { ...next, status: "ISSUED", ...(unit.component === "FFP" ? { preparationConfirmedAt: now } : {}) }; break;
    }
    case "HANDOVER": expect("ISSUED"); requireOwner(command.requestId); requireReady(); if (unit.handoverAt) throw new Error("Handover already recorded"); next = { ...next, handoverAt: now }; break;
    case "TRANSFUSE": expect("ISSUED"); requireOwner(command.requestId); requireReady(); if (!unit.handoverAt) throw new Error("Handover required before synthetic use"); next = { ...next, status: "TRANSFUSED" }; break;
    case "RETURN": expect("ISSUED"); requireOwner(command.requestId); note = v.text(command.note); next = { ...next, status: "RETURNED_QUARANTINE", reservation: undefined, handoverAt: undefined, preparationConfirmedAt: undefined }; break;
    case "EXPIRE": expect("COLLECTED", "TESTING", "AVAILABLE", "RESERVED", "ISSUED", "RETURNED_QUARANTINE", "QUARANTINED"); if (time < Date.parse(unit.expiresAt)) throw new Error("Unit has not expired"); next = { ...next, status: "EXPIRED", reservation: undefined, handoverAt: undefined }; break;
    case "DISCARD": expect("COLLECTED", "TESTING", "AVAILABLE", "RESERVED", "ISSUED", "RETURNED_QUARANTINE", "QUARANTINED"); note = v.text(command.note); next = { ...next, status: "DISCARDED", reservation: undefined, handoverAt: undefined }; break;
    default: throw new Error("Unknown lifecycle command");
  }
  return { unit: parseUnit(next), event: parseLifecycleEvent({ id: context.eventId, unitId: unit.id, at: now, actorId: context.actorId, action: command.type, from: unit.status, to: next.status, requestId, allocationId, note, screening: next.screening, storage: next.storage, leaseExpiresAt: next.reservation?.leaseExpiresAt ?? unit.reservation?.leaseExpiresAt, expectedTransfusionAt: next.reservation?.expectedTransfusionAt ?? unit.reservation?.expectedTransfusionAt }) };
}

/** Collection timestamp stays unchanged when a synthetic collection is separated. */
export function createCollectedUnit(input: Omit<Unit, "status" | "screening" | "storage" | "expiresAt">, rules: ShelfLifeRules = DEFAULT_SHELF_LIFE): Unit {
  return parseUnit({ ...input, expiresAt: calculateExpiry(input.collectedAt, input.product, rules), status: "COLLECTED", screening: {}, storage: "UNKNOWN" });
}

/** Counter updates are returned to a caller, never persisted here. */
export function requestWithAllocations(request: BloodRequest, allocatedQuantity: number): BloodRequest {
  return parseRequest({ ...request, allocatedQuantity, status: allocatedQuantity === request.quantity ? "ALLOCATED" : allocatedQuantity > 0 ? "PARTIAL" : "OPEN" });
}
