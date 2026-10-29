import { parseBank, parseRequest, parseUnit, type Group, type Product, type Unit } from "./domain";
import { calculateExpiry, DAY_MS } from "./shelf-life";

export const FIXTURE_NOW = "2026-10-28T03:30:00.000Z";
export const fixtureBanks = [parseBank({ id: "demo-bank-a", name: "Demo Bank A", district: "Mumbai City", location: { latitude: 19.07, longitude: 72.87 } }), parseBank({ id: "demo-bank-b", name: "Demo Bank B", district: "Thane", location: { latitude: 19.21, longitude: 72.97 } })];
export const CLEAR_SCREENING = { HIV: "NON_REACTIVE", HEPATITIS_B: "NON_REACTIVE", HEPATITIS_C: "NON_REACTIVE", SYPHILIS: "NON_REACTIVE", MALARIA: "NON_REACTIVE" } as const;
/** Small hand-authored fixtures only; state generation belongs to Stage 3. */
export function inventoryFixtures(): readonly Unit[] {
  function unit(id: string, group: Group, daysLeft: number, product: Product = "PRBC_SAGM", overrides: Partial<Unit> = {}): Unit {
    const days = product === "PRBC_CPDA1" ? 35 : product === "PLATELETS_CLOSED" ? 5 : product === "FFP_FROZEN" ? 365 : 42;
    const collectedAt = new Date(Date.parse(FIXTURE_NOW) + (daysLeft - days) * DAY_MS).toISOString();
    return parseUnit({ id, bankId: "demo-bank-a", donorId: `demo-donor-${id}`, group, component: product === "PLATELETS_CLOSED" ? "PLATELETS" : product === "FFP_FROZEN" ? "FFP" : "PRBC", product, collectedAt, expiresAt: calculateExpiry(collectedAt, product), status: "AVAILABLE", screening: CLEAR_SCREENING, storage: "VERIFIED", ...overrides });
  }
  return [
    unit("DEMO-001", "A+", 4), unit("DEMO-002", "A+", 2),
    unit("DEMO-003", "O-", 1), unit("DEMO-004", "O+", 3),
    unit("DEMO-005", "B+", 8), unit("DEMO-006", "A+", -1),
    unit("DEMO-007", "A+", 6, "PRBC_CPDA1", { status: "TESTING", screening: { ...CLEAR_SCREENING, HIV: "PENDING" } }),
    unit("DEMO-008", "A+", 5, "PRBC_SAGM", { storage: "UNKNOWN" }),
    unit("DEMO-009", "A+", 0.05),
    unit("DEMO-010", "A+", 2, "PLATELETS_CLOSED"),
    unit("DEMO-011", "AB-", 100, "FFP_FROZEN"),
    unit("DEMO-012", "A-", 40, "FFP_FROZEN", { bankId: "demo-bank-b" }),
    unit("DEMO-013", "A+", 10, "PRBC_SAGM", { status: "RETURNED_QUARANTINE" }),
    unit("DEMO-014", "A+", 8, "PRBC_SAGM", { status: "DISCARDED", screening: { ...CLEAR_SCREENING, MALARIA: "REACTIVE" } }),
    unit("DEMO-015", "A-", 2, "PRBC_CPDA1", { bankId: "demo-bank-b" })
  ];
}
export function fixtureRequest(group: Group = "A+", component: Unit["component"] = "PRBC", quantity = 2, hoursUntilUse = 2) {
  return parseRequest({ id: "demo-request", hospitalId: "demo-hospital", group, component, quantity, allocatedQuantity: 0, transfusedQuantity: 0, urgency: "URGENT", expectedTransfusionAt: new Date(Date.parse(FIXTURE_NOW) + hoursUntilUse * 3_600_000).toISOString(), status: "OPEN" });
}
