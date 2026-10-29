import { parseAllocation, parseRequest, type Allocation, type BloodRequest, type LifecycleEvent, type Unit } from "./domain";
import { compareStock, matchInventory } from "./inventory";
import { requestWithAllocations, transitionUnit } from "./lifecycle";

/** Local, single-thread teaching batch. This makes no database concurrency guarantee. */
export function reserveLocalStock(units: readonly Unit[], request: BloodRequest, now: string, operationId: string) {
  const match = matchInventory(units, request, now);
  const updated = new Map<string, Unit>(), allocations: Allocation[] = [], events: LifecycleEvent[] = [];
  let nextRequest = request;
  for (const unit of match.selected) {
    const allocationId = `allocation:${unit.id}`; // One current-ownership record per unit.
    const change = transitionUnit(unit, { type: "RESERVE", request: nextRequest, allocationId }, { now, actorId: "demo-bank", eventId: `${operationId}:reserve:${unit.id}` });
    updated.set(unit.id, change.unit); events.push(change.event);
    allocations.push(parseAllocation({ id: allocationId, unitId: unit.id, requestId: request.id, status: "ACTIVE", reservedAt: now, leaseExpiresAt: change.unit.reservation!.leaseExpiresAt, updatedAt: now }));
    nextRequest = requestWithAllocations(nextRequest, nextRequest.allocatedQuantity + 1);
  }
  return { units: units.map(unit => updated.get(unit.id) ?? unit), request: nextRequest, allocations, events, shortage: match.shortage };
}

export function issueLocalStock(units: readonly Unit[], request: BloodRequest, now: string, operationId: string, preparationConfirmed = false) {
  const events: LifecycleEvent[] = [], allocations: Allocation[] = [];
  const updated = new Map<string, Unit>();
  for (const unit of units.filter(unit => unit.status === "RESERVED" && unit.reservation?.requestId === request.id).sort((a, b) => compareStock(a, b, request))) {
    const change = transitionUnit(unit, { type: "ISSUE", request, preparationConfirmed }, { now, actorId: "demo-bank", eventId: `${operationId}:issue:${unit.id}` });
    events.push(change.event);
    allocations.push(parseAllocation({ id: unit.reservation!.allocationId, unitId: unit.id, requestId: request.id, status: "ISSUED", reservedAt: unit.reservation!.reservedAt, leaseExpiresAt: unit.reservation!.leaseExpiresAt, updatedAt: now }));
    updated.set(unit.id, change.unit);
  }
  return { units: units.map(unit => updated.get(unit.id) ?? unit), request: parseRequest(request), allocations, events };
}

export function releaseLocalStock(units: readonly Unit[], request: BloodRequest, now: string, operationId: string, mode: "CANCEL" | "EXPIRE") {
  const events: LifecycleEvent[] = [], allocations: Allocation[] = [];
  const updated = units.map(unit => {
    if (unit.status !== "RESERVED" || unit.reservation?.requestId !== request.id || mode === "EXPIRE" && Date.parse(now) < Date.parse(unit.reservation.leaseExpiresAt)) return unit;
    const change = transitionUnit(unit, { type: mode === "CANCEL" ? "CANCEL_RESERVATION" : "EXPIRE_RESERVATION", requestId: request.id }, { now, actorId: "demo-bank", eventId: `${operationId}:release:${unit.id}` });
    events.push(change.event);
    allocations.push(parseAllocation({ id: unit.reservation.allocationId, unitId: unit.id, requestId: request.id, status: "RELEASED", reservedAt: unit.reservation.reservedAt, leaseExpiresAt: unit.reservation.leaseExpiresAt, updatedAt: now }));
    return change.unit;
  });
  return { units: updated, request: requestWithAllocations(request, request.allocatedQuantity - events.length), allocations, events };
}
