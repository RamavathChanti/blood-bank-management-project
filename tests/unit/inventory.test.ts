import { describe, expect, it, vi } from "vitest";
import { parseRequest, type Unit } from "../../src/core/domain";
import { FIXTURE_NOW as now, CLEAR_SCREENING, fixtureRequest, inventoryFixtures } from "../../src/core/fixtures";
import { calculateExpiry, DAY_MS, DEFAULT_SHELF_LIFE, isExpired } from "../../src/core/shelf-life";
import { matchInventory, readinessReasons, stockReasons } from "../../src/core/inventory";
import { createCollectedUnit, requestWithAllocations, transitionUnit, type UnitCommand } from "../../src/core/lifecycle";
import { issueLocalStock, releaseLocalStock, reserveLocalStock } from "../../src/core/local-registry";

const context = { now, eventId: "event-1", actorId: "demo-actor" };
function change(unit: Unit, command: UnitCommand, at = now) { return transitionUnit(unit, command, { ...context, now: at }).unit; }
function available() { return inventoryFixtures()[0]; }
function reservation(unit = available()) { return reserveLocalStock([unit], fixtureRequest(unit.group, unit.component, 1), now, "op"); }

describe("product expiry and strict boundaries", () => {
  it.each([["PRBC_SAGM", 42], ["PRBC_CPDA1", 35], ["PLATELETS_CLOSED", 5]] as const)("%s lasts %i elapsed days", (product, days) => expect(Date.parse(calculateExpiry(now, product)) - Date.parse(now)).toBe(days * DAY_MS));
  it("uses a clamped UTC anniversary for FFP, including time and leap year", () => {
    expect(calculateExpiry("2024-02-29T09:15:30Z", "FFP_FROZEN")).toBe("2025-02-28T09:15:30.000Z");
    expect(calculateExpiry("2023-03-01T09:15:30Z", "FFP_FROZEN")).toBe("2024-03-01T09:15:30.000Z");
  });
  it("checks one millisecond before, at, and after expiry", () => {
    expect(isExpired(now, "2026-10-28T03:29:59.999Z")).toBe(false);
    expect(isExpired(now, now)).toBe(true);
    expect(isExpired(now, "2026-10-28T03:30:00.001Z")).toBe(true);
  });
  it("preserves collection time across separation and uses configured lifetime", () => {
    const unit = createCollectedUnit({ id: "component-1", donorId: "donor", bankId: "bank", group: "A+", component: "PRBC", product: "PRBC_CPDA1", collectedAt: "2026-10-01T00:00:00Z" });
    expect(unit.collectedAt).toBe("2026-10-01T00:00:00.000Z"); expect(unit.expiresAt).toBe("2026-11-05T00:00:00.000Z");
    expect(calculateExpiry(now, "PRBC_SAGM", { ...DEFAULT_SHELF_LIFE, PRBC_SAGM: { days: 30 } })).toBe("2026-11-27T03:30:00.000Z");
    expect(() => calculateExpiry(now, "PRBC_SAGM", { ...DEFAULT_SHELF_LIFE, PRBC_SAGM: { days: -1 } })).toThrow();
  });
  it("rejects expected-use equality, past deadlines, extended shelf labels and future collection", () => {
    const unit = available();
    expect(stockReasons(unit, { ...fixtureRequest(), expectedTransfusionAt: unit.expiresAt }, now)).toContain("EXPIRES_BEFORE_USE");
    expect(() => matchInventory([unit], { ...fixtureRequest(), expectedTransfusionAt: "2026-10-28T03:29:59Z" }, now)).toThrow(/past/);
    expect(readinessReasons({ ...unit, expiresAt: "2030-01-01T00:00:00Z" }, now)).toContain("INVALID_SHELF_LIFE");
    expect(readinessReasons({ ...unit, collectedAt: "2026-10-29T00:00:00Z" }, now)).toContain("NOT_COLLECTED_YET");
  });
});

describe("matching, exclusions, preferences and FEFO", () => {
  it("explains every fixture, selects exact groups in FEFO order and reports shortage", () => {
    const result = matchInventory(inventoryFixtures(), fixtureRequest(), now);
    expect(result.selected.map(unit => unit.id)).toEqual(["DEMO-002", "DEMO-001"]);
    expect(result.assessments).toHaveLength(15); expect(result.assessments.every(item => item.explanation.length > 0)).toBe(true);
    expect(result.shortage).toBe(0);
    expect(result.assessments.find(item => item.unit.id === "DEMO-006")?.reasons).toContain("EXPIRED");
    expect(result.assessments.find(item => item.unit.id === "DEMO-009")?.reasons).toContain("EXPIRES_BEFORE_USE");
    expect(result.assessments.find(item => item.unit.id === "DEMO-010")?.reasons).toContain("COMPONENT_MISMATCH");
    expect(result.assessments.find(item => item.unit.id === "DEMO-013")?.reasons).toContain("NOT_AVAILABLE");
    expect(matchInventory(inventoryFixtures(), fixtureRequest("O-", "PRBC", 2), now).shortage).toBe(1);
  });
  it("conserves O-negative before considering expiry and uses stable bank/unit ties", () => {
    const unit = available();
    const inputs: Unit[] = [{ ...unit, id: "z", bankId: "bank-b" }, { ...unit, id: "b", bankId: "bank-a" }, { ...unit, id: "a", bankId: "bank-a" }, inventoryFixtures()[2]];
    expect(matchInventory(inputs, fixtureRequest("A+", "PRBC", 5), now).selected.map(u => u.id)).toEqual(["a", "b", "z", "DEMO-003"]);
    expect(matchInventory([...inputs].reverse(), fixtureRequest("A+", "PRBC", 5), now).selected.map(u => u.id)).toEqual(["a", "b", "z", "DEMO-003"]);
    expect(matchInventory(inventoryFixtures(), fixtureRequest("A+", "PRBC", 10), now).selected.map(u => u.group)).toEqual(["A+", "A+", "O+", "A-", "O-"]);
  });
  it("treats Rh variants equally for identical-ABO plasma and takes the earlier expiry", () => {
    const units = inventoryFixtures().filter(u => u.component === "FFP");
    const input = [...units, { ...units[1], id: "plasma-plus", group: "A+" as const, expiresAt: "2026-11-20T00:00:00.000Z" }];
    expect(matchInventory(input, fixtureRequest("A+", "FFP", 3), now).selected.map(u => u.id)).toEqual(["plasma-plus", "DEMO-012", "DEMO-011"]);
  });
  it.each(["PENDING", "INVALID", undefined] as const)("blocks %s or missing screening", result => {
    const unit = { ...available(), screening: { ...CLEAR_SCREENING, HIV: result } };
    expect(matchInventory([unit], fixtureRequest(), now).selected).toEqual([]);
    expect(stockReasons(unit, fixtureRequest(), now)).toContain("SCREENING_INCOMPLETE");
  });
  it("blocks reactive screens, unknown/failed storage, owned and quarantined stock", () => {
    for (const unit of [{ ...available(), screening: { ...CLEAR_SCREENING, MALARIA: "REACTIVE" as const } }, { ...available(), storage: "UNKNOWN" as const }, { ...available(), storage: "FAILED" as const }, { ...available(), status: "TESTING" as const }, reservation().units[0]]) expect(matchInventory([unit], fixtureRequest(), now).selected).toEqual([]);
    expect(() => matchInventory([available(), available()], fixtureRequest(), now)).toThrow(/Duplicate/);
  });
});

describe("controlled lifecycle and local ownership", () => {
  it("runs collection -> screening -> reservation -> issue -> handover -> synthetic use", () => {
    let unit = change({ ...available(), status: "COLLECTED", screening: {}, storage: "UNKNOWN" }, { type: "START_TESTING" });
    expect(() => change(unit, { type: "MAKE_AVAILABLE" })).toThrow(/Readiness/);
    unit = change(unit, { type: "UPDATE_SCREENING", screening: CLEAR_SCREENING });
    unit = change(unit, { type: "VERIFY_STORAGE", storage: "VERIFIED" });
    unit = change(unit, { type: "MAKE_AVAILABLE" });
    const reserved = reservation(unit); unit = reserved.units[0];
    expect(unit.reservation?.leaseExpiresAt).toBe("2026-10-28T03:40:00.000Z");
    unit = change(unit, { type: "ISSUE", request: reserved.request });
    expect(() => change(unit, { type: "TRANSFUSE", requestId: reserved.request.id })).toThrow(/Handover/);
    unit = change(unit, { type: "HANDOVER", requestId: reserved.request.id });
    const used = transitionUnit(unit, { type: "TRANSFUSE", requestId: reserved.request.id }, context);
    expect(used.unit.status).toBe("TRANSFUSED");
    expect(used.event).toMatchObject({ from: "ISSUED", to: "TRANSFUSED", requestId: reserved.request.id, actorId: "demo-actor", screening: CLEAR_SCREENING, storage: "VERIFIED" });
    expect(() => change(used.unit, { type: "RETURN", requestId: reserved.request.id, note: "test" })).toThrow();
    expect(parseRequest({ ...reserved.request, transfusedQuantity: 1, status: "COMPLETED" }).status).toBe("COMPLETED");
  });
  it("keeps pending/invalid/missing screens quarantined and reactive fixtures discarded", () => {
    const unit = { ...available(), status: "TESTING" as const };
    for (const screening of [{}, { ...CLEAR_SCREENING, HIV: "PENDING" as const }, { ...CLEAR_SCREENING, HIV: "INVALID" as const }]) {
      const result = change(unit, { type: "UPDATE_SCREENING", screening });
      expect(result.status).toBe("TESTING"); expect(() => change(result, { type: "MAKE_AVAILABLE" })).toThrow();
    }
    expect(change(unit, { type: "UPDATE_SCREENING", screening: { ...CLEAR_SCREENING, HIV: "REACTIVE" } }).status).toBe("DISCARDED");
    expect(change(unit, { type: "VERIFY_STORAGE", storage: "FAILED" }).status).toBe("DISCARDED");
    expect(() => change({ ...unit, status: "COLLECTED" }, { type: "MAKE_AVAILABLE" })).toThrow();
    expect(() => change(unit, { type: "RESERVE", request: fixtureRequest(), allocationId: "a" })).toThrow();
  });
  it("releases at exact lease expiry, rejects early expiry and expired-lease issue, and reacquires with the same ownership record ID", () => {
    const reserved = reservation(), unit = reserved.units[0];
    expect(() => change(unit, { type: "EXPIRE_RESERVATION", requestId: reserved.request.id }, "2026-10-28T03:39:59.999Z")).toThrow(/not expired/);
    expect(() => change(unit, { type: "ISSUE", request: reserved.request }, "2026-10-28T03:40:00Z")).toThrow(/lease expired/);
    const released = releaseLocalStock(reserved.units, reserved.request, "2026-10-28T03:40:00Z", "release", "EXPIRE");
    expect(released.units[0].status).toBe("AVAILABLE"); expect(released.request.allocatedQuantity).toBe(0);
    expect(released.allocations[0].status).toBe("RELEASED");
    const otherRequest = { ...fixtureRequest("A+", "PRBC", 1), id: "other-request" };
    const acquired = reserveLocalStock(released.units, otherRequest, "2026-10-28T03:40:00Z", "reacquire");
    expect(acquired.allocations[0].id).toBe(reserved.allocations[0].id);
    expect(acquired.units[0].reservation?.requestId).toBe("other-request");
    expect(released.events[0].requestId).toBe("demo-request");
  });
  it("rechecks owner, time, compatibility, storage, component and request changes before issue", () => {
    const r = reservation(), unit = r.units[0];
    expect(() => change(unit, { type: "ISSUE", request: { ...r.request, id: "wrong" } })).toThrow(/owner/);
    expect(() => change(unit, { type: "ISSUE", request: { ...r.request, expectedTransfusionAt: "2026-10-29T00:00:00Z" } })).toThrow(/changed/);
    expect(() => change(unit, { type: "ISSUE", request: { ...r.request, status: "CANCELLED" } })).toThrow(/closed/);
    expect(() => change({ ...unit, group: "B+" }, { type: "ISSUE", request: r.request })).toThrow(/compatibility/);
    expect(() => change({ ...unit, storage: "UNKNOWN" }, { type: "ISSUE", request: r.request })).toThrow(/Readiness/);
    expect(() => change(unit, { type: "ISSUE", request: { ...r.request, component: "PLATELETS" } })).toThrow(/changed/);
    expect(() => change(unit, { type: "CANCEL_RESERVATION", requestId: "wrong" })).toThrow(/owner/);
    expect(() => change(unit, { type: "MAKE_AVAILABLE" })).toThrow();
  });
  it("handles cancellation, expired product release and fail-closed readiness on release", () => {
    const r = reservation();
    expect(releaseLocalStock(r.units, r.request, now, "cancel", "CANCEL").units[0].status).toBe("AVAILABLE");
    expect(change(r.units[0], { type: "CANCEL_RESERVATION", requestId: r.request.id }, r.units[0].expiresAt).status).toBe("EXPIRED");
    expect(change({ ...r.units[0], storage: "FAILED" }, { type: "CANCEL_RESERVATION", requestId: r.request.id }).status).toBe("DISCARDED");
    expect(releaseLocalStock(r.units, r.request, now, "early", "EXPIRE").events).toEqual([]);
  });
  it("quarantines issued returns permanently; rejects restock/reissue and allows discard", () => {
    const r = reservation();
    const issued = change(r.units[0], { type: "ISSUE", request: r.request });
    const returned = change(issued, { type: "RETURN", requestId: r.request.id, note: "Handling review needed" });
    expect(returned.status).toBe("RETURNED_QUARANTINE"); expect(returned.reservation).toBeUndefined();
    for (const command of [{ type: "MAKE_AVAILABLE" }, { type: "START_TESTING" }, { type: "ISSUE", request: r.request }] as UnitCommand[]) expect(() => change(returned, command)).toThrow();
    expect(matchInventory([returned], fixtureRequest(), now).selected).toEqual([]);
    expect(change(returned, { type: "DISCARD", note: "No verified return policy" }).status).toBe("DISCARDED");
  });
  it("requires explicit FFP preparation before issue", () => {
    const plasma = inventoryFixtures().find(u => u.id === "DEMO-012")!;
    const r = reservation(plasma);
    expect(() => change(r.units[0], { type: "ISSUE", request: r.request })).toThrow(/preparation/);
    expect(change(r.units[0], { type: "ISSUE", request: r.request, preparationConfirmed: true }).preparationConfirmedAt).toBe(now);
  });
  it("caps leases at expected use, supports explicit duration and rejects issue at expiry", () => {
    const request = { ...fixtureRequest("A+", "PRBC", 1), expectedTransfusionAt: "2026-10-28T03:35:00.000Z" };
    expect(change(available(), { type: "RESERVE", request, allocationId: "a" }).reservation?.leaseExpiresAt).toBe(request.expectedTransfusionAt);
    expect(change(available(), { type: "RESERVE", request: fixtureRequest(), allocationId: "a", leaseMinutes: 2 }).reservation?.leaseExpiresAt).toBe("2026-10-28T03:32:00.000Z");
    const r = reservation();
    expect(() => change({ ...r.units[0], expiresAt: r.request.expectedTransfusionAt }, { type: "ISSUE", request: r.request })).toThrow(/EXPIRES_BEFORE_USE/);
    expect(() => change(available(), { type: "RESERVE", request, allocationId: "a", leaseMinutes: 0 })).toThrow();
  });
  it("expires stock only at its boundary and never resurrects terminal stock", () => {
    const unit = available();
    expect(() => change(unit, { type: "EXPIRE" })).toThrow(/not expired/);
    const expired = change(unit, { type: "EXPIRE" }, unit.expiresAt);
    expect(expired.status).toBe("EXPIRED");
    expect(() => change(expired, { type: "START_TESTING" }, unit.expiresAt)).toThrow();
    const discarded = change(unit, { type: "DISCARD", note: "Synthetic failure" });
    expect(() => change(discarded, { type: "MAKE_AVAILABLE" })).toThrow();
  });
  it("issues a partial reservation in FEFO order without completing the request or overallocating", () => {
    const r = reserveLocalStock(inventoryFixtures(), fixtureRequest("A+", "PRBC", 10), now, "reserve");
    expect(r.request.status).toBe("PARTIAL"); expect(r.request.allocatedQuantity).toBe(5); expect(r.shortage).toBe(5);
    const issued = issueLocalStock(r.units, r.request, now, "issue");
    expect(issued.events.map(event => event.unitId)).toEqual(r.events.map(event => event.unitId));
    expect(issued.request.transfusedQuantity).toBe(0); expect(issued.request.status).toBe("PARTIAL");
    const full = requestWithAllocations(fixtureRequest(), 2);
    expect(matchInventory(inventoryFixtures(), full, now).selected).toEqual([]);
    expect(() => change(available(), { type: "RESERVE", request: full, allocationId: "a" })).toThrow(/already allocated/);
  });
  it("never reads the wall clock, mutates inputs, or permits time reversal", () => {
    const units = inventoryFixtures(), request = fixtureRequest(), before = JSON.stringify({ units, request });
    const spy = vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("wall clock forbidden"); });
    try { const r = reserveLocalStock(units, request, now, "r"); issueLocalStock(r.units, r.request, now, "i"); expect(JSON.stringify({ units, request })).toBe(before); } finally { spy.mockRestore(); }
    expect(() => change({ ...available(), lastEventAt: "2026-10-28T03:31:00Z" }, { type: "DISCARD", note: "test" })).toThrow(/backwards/);
  });
});
