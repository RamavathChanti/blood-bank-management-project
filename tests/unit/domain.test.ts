import { expect, it } from "vitest";
import { parseAllocation, parseBank, parseDonor, parseGroup, parseHospital, parseLifecycleEvent, parseRequest, parseUnit } from "../../src/core/domain";
import { fixtureBanks, fixtureRequest, inventoryFixtures } from "../../src/core/fixtures";
import { dateOnly, instant } from "../../src/core/validation";

it("validates every fixture and detaches nested input", () => {
  const units = inventoryFixtures();
  expect(units).toHaveLength(15);
  for (const unit of units) expect(parseUnit(unit)).toEqual(unit);
  const input = structuredClone(units[0]); const parsed = parseUnit(input);
  expect(parsed.screening).not.toBe(input.screening);
  expect(parseBank(fixtureBanks[0])).toEqual(parseHospital(fixtureBanks[0]));
  expect(parseRequest(fixtureRequest()).quantity).toBe(2);
});
it("rejects malformed entities and privileged/unknown fields", () => {
  expect(() => parseGroup("A")).toThrow();
  expect(() => parseBank({ ...fixtureBanks[0], location: { latitude: 91, longitude: 0 } })).toThrow();
  expect(() => parseHospital({ ...fixtureBanks[0], role: "STATE_ADMIN" })).toThrow(/unknown field/);
  expect(() => parseUnit({ ...inventoryFixtures()[0], product: "FFP_FROZEN" })).toThrow(/component mismatch/);
  expect(() => parseUnit({ ...inventoryFixtures()[0], status: "RESERVED" })).toThrow(/ownership/);
  expect(() => parseUnit({ ...inventoryFixtures()[0], screening: { HIV: "PASSED" } })).toThrow();
  expect(() => parseDonor({})).toThrow();
  expect(() => parseRequest({ ...fixtureRequest(), quantity: 1.2 })).toThrow();
  expect(() => parseRequest({ ...fixtureRequest(), allocatedQuantity: 3 })).toThrow();
  expect(() => parseRequest({ ...fixtureRequest(), status: "COMPLETED" })).toThrow(/completion/);
  expect(() => parseRequest({ ...fixtureRequest(), status: "ALLOCATED" })).toThrow(/status/);
  expect(() => parseAllocation({ id: "a", unitId: "u", requestId: "r", status: "ACTIVE", reservedAt: "2026-10-28T01:00:00Z", leaseExpiresAt: "2026-10-28T01:00:00Z", updatedAt: "2026-10-28T01:00:00Z" })).toThrow(/chronology/);
  expect(() => parseLifecycleEvent({})).toThrow();
  expect(() => parseLifecycleEvent({ id: "e", unitId: "u", actorId: "a", at: "2026-10-28T03:30:00Z", action: "MAKE_AVAILABLE", from: "COLLECTED", to: "AVAILABLE" })).toThrow(/action disagrees/);
  expect(() => parseLifecycleEvent({ id: "e", unitId: "u", actorId: "a", at: "2026-10-28T03:30:00Z", action: "RESERVE", from: "AVAILABLE", to: "RESERVED" })).toThrow(/ownership/);
});
it("normalizes timezone instants and rejects impossible or ambiguous dates", () => {
  expect(instant("2026-10-28T09:00:00+05:30")).toBe("2026-10-28T03:30:00.000Z");
  for (const value of ["2026-02-30T00:00:00Z", "2026-10-28T00:00:00", "2026-01-01T24:00:00Z", "2026-01-01T00:00:60Z"]) expect(() => instant(value)).toThrow();
  expect(() => dateOnly("2025-02-29")).toThrow();
});
