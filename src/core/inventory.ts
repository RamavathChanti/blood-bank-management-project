import { SCREENS, parseRequest, parseUnit, type BloodRequest, type LifecycleEvent, type Unit } from "./domain";
import { isCompatible, preferenceTier } from "./compatibility";
import { calculateExpiry, DEFAULT_SHELF_LIFE, type ShelfLifeRules } from "./shelf-life";
import { instant } from "./validation";

export type StockReason = "NOT_AVAILABLE" | "OWNED" | "SCREENING_INCOMPLETE" | "SCREENING_REACTIVE" | "STORAGE_UNVERIFIED" | "EXPIRED" | "EXPIRES_BEFORE_USE" | "COMPONENT_MISMATCH" | "INCOMPATIBLE_GROUP" | "INVALID_SHELF_LIFE" | "NOT_COLLECTED_YET";
export const reasonText: Record<StockReason, string> = {
  NOT_AVAILABLE: "Lifecycle state is not AVAILABLE", OWNED: "Unit already has an owner", SCREENING_INCOMPLETE: "All five screens must be non-reactive", SCREENING_REACTIVE: "Reactive screening blocks use", STORAGE_UNVERIFIED: "Storage is not verified", EXPIRED: "Unit has reached its expiry instant", EXPIRES_BEFORE_USE: "Unit must expire strictly after expected use", COMPONENT_MISMATCH: "Different component", INCOMPATIBLE_GROUP: "Group is incompatible under this component policy", INVALID_SHELF_LIFE: "Expiry exceeds the configured product lifetime", NOT_COLLECTED_YET: "Collection is later than the supplied clock"
};
/** These checks apply even if a background expiry/reconciliation job has not run. */
export function readinessReasons(input: Unit, now: string, expectedAt: string = now, rules: ShelfLifeRules = DEFAULT_SHELF_LIFE): StockReason[] {
  const unit = parseUnit(input), time = Date.parse(instant(now)), use = Date.parse(instant(expectedAt));
  const reasons: StockReason[] = [];
  if (Date.parse(unit.collectedAt) > time) reasons.push("NOT_COLLECTED_YET");
  if (SCREENS.some(key => unit.screening[key] === "REACTIVE")) reasons.push("SCREENING_REACTIVE");
  else if (!SCREENS.every(key => unit.screening[key] === "NON_REACTIVE")) reasons.push("SCREENING_INCOMPLETE");
  if (unit.storage !== "VERIFIED") reasons.push("STORAGE_UNVERIFIED");
  if (Date.parse(unit.expiresAt) > Date.parse(calculateExpiry(unit.collectedAt, unit.product, rules))) reasons.push("INVALID_SHELF_LIFE");
  if (Date.parse(unit.expiresAt) <= time) reasons.push("EXPIRED");
  if (Date.parse(unit.expiresAt) <= use) reasons.push("EXPIRES_BEFORE_USE");
  return reasons;
}
export function validateRequestForUse(input: BloodRequest, now: string): BloodRequest {
  const request = parseRequest(input);
  if (Date.parse(request.expectedTransfusionAt) < Date.parse(instant(now))) throw new Error("Request has a past expected-use deadline");
  if (!["OPEN", "PARTIAL", "ALLOCATED"].includes(request.status)) throw new Error("Request is closed or escalated");
  return request;
}
export function stockReasons(input: Unit, request: BloodRequest, now: string, rules: ShelfLifeRules = DEFAULT_SHELF_LIFE): StockReason[] {
  const unit = parseUnit(input);
  const reasons = readinessReasons(unit, now, request.expectedTransfusionAt, rules);
  if (unit.status !== "AVAILABLE") reasons.unshift("NOT_AVAILABLE");
  if (unit.reservation) reasons.push("OWNED");
  if (unit.component !== request.component) reasons.push("COMPONENT_MISMATCH");
  else if (!isCompatible(unit.group, request.group, request.component)) reasons.push("INCOMPATIBLE_GROUP");
  return reasons;
}
export function matchInventory(inputs: readonly Unit[], input: BloodRequest, now: string, rules: ShelfLifeRules = DEFAULT_SHELF_LIFE) {
  const request = validateRequestForUse(input, now), units = inputs.map(parseUnit);
  if (new Set(units.map(unit => unit.id)).size !== units.length) throw new Error("Duplicate unit IDs in inventory");
  const assessed = units.map(unit => ({ unit, reasons: stockReasons(unit, request, now, rules), tier: preferenceTier(unit.group, request.group, request.component) }));
  const candidates = assessed.filter(item => item.reasons.length === 0).sort((a, b) => compareStock(a.unit, b.unit, request));
  const needed = request.quantity - request.allocatedQuantity;
  const selected = candidates.slice(0, needed).map(item => item.unit);
  return { selected, candidates: candidates.map(item => item.unit), shortage: needed - selected.length, assessments: assessed.map(item => ({ ...item, selected: selected.some(unit => unit.id === item.unit.id), explanation: item.reasons.length ? item.reasons.map(reason => reasonText[reason]).join("; ") : `Eligible · preference ${item.tier + 1} · FEFO ${item.unit.expiresAt}${selected.some(unit => unit.id === item.unit.id) ? " · selected" : " · quantity already covered by earlier candidates"}` })) };
}
export function compareStock(a: Unit, b: Unit, request: BloodRequest): number {
  return preferenceTier(a.group, request.group, request.component) - preferenceTier(b.group, request.group, request.component) || Date.parse(a.expiresAt) - Date.parse(b.expiresAt) || compareId(a.bankId, b.bankId) || compareId(a.id, b.id);
}
function compareId(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }

/** Structural result shared by local batch operations; persistence/transactions belong to Stage 6. */
export type UnitChange = Readonly<{ unit: Unit; event: LifecycleEvent }>;
