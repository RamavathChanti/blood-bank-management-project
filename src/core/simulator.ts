import { GROUPS, COMPONENTS, parseRequest, type BloodRequest, type Component, type Group, type Unit } from "./domain";
import { isCompatible, preferenceTier } from "./compatibility";
import { donorEligibility } from "./donor-eligibility";
import { CLEAR_SCREENING } from "./fixtures";
import { matchInventory } from "./inventory";
import { createCollectedUnit, requestWithAllocations, transitionUnit, type UnitCommand } from "./lifecycle";
import { SeededRandom } from "./random";
import { DAY_MS } from "./shelf-life";
import { parseScenarioConfig, PRESETS, type ScenarioConfig } from "./simulation-config";
import { atOffset, generateState, measureDataset, sampleGroup, type GeneratedState } from "./state-generator";

export const TICK_MS = 5 * 60_000;
export const MAX_DURATION_MS = 30 * DAY_MS;
export const SPEEDS = [1, 60, 3600, 86400] as const;
// Compatibility policy is fixed. Compute its tiny ranking table once, outside hot loops.
const TIERS = Object.fromEntries(COMPONENTS.map(component => [component, Object.fromEntries(GROUPS.map(recipient => [recipient, Object.fromEntries(GROUPS.map(donor => [donor, isCompatible(donor, recipient, component) ? preferenceTier(donor, recipient, component) : -1]))]))])) as Record<Component, Record<Group, Record<Group, number>>>;
type SimRequest = { request: BloodRequest; createdAt: string; matchedAt?: string };
export type Transfer = { id: string; unitId: string; fromBankId: string; toBankId: string; departedAt: string; arrivesAt: string; status: "IN_TRANSIT" | "RECEIVED" | "EXPIRED" };
export type Activity = { id: number; at: string; kind: "REQUEST" | "MATCH" | "DONATION" | "SCREENING" | "EXPIRY" | "TRANSFER" | "ARRIVAL" | "ESCALATION"; text: string };
export type Metrics = { requests: number; fulfilled: number; fulfilmentPercent: number | null; requestedUnits: number; issuedUnits: number; medianMatchMinutes: number | null; p95MatchMinutes: number | null; expiredUnits: number; expiryPercent: number; availableStock: number; testingStock: number; inTransit: number; recentRequestsPerMinute: number };
export type BankSummary = GeneratedState["banks"][number] & { stock: Record<Component, Record<Group, number>> };
export type SimulationSnapshot = {
  config: ScenarioConfig; elapsedMs: number; now: string; banks: BankSummary[]; hospitals: GeneratedState["hospitals"]; districts: GeneratedState["districts"];
  counts: { donors: number; units: number; historicalIssues: number }; storage: ReturnType<typeof measureDataset>; metrics: Metrics; activity: Activity[]; transfers: Transfer[];
};
function emptyStock(): BankSummary["stock"] {
  return Object.fromEntries(COMPONENTS.map(component => [component, Object.fromEntries(GROUPS.map(group => [group, 0]))])) as BankSummary["stock"];
}
export function percentile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

/** Mutable isolated engine; all time comes from advanceBy, never Date.now or timers. */
export class Simulator {
  readonly config: ScenarioConfig;
  readonly state: GeneratedState;
  readonly storage: ReturnType<typeof measureDataset>;
  readonly requests: SimRequest[] = [];
  readonly transfers: Transfer[] = [];
  readonly activity: Activity[] = [];
  elapsedMs = 0;
  private tick = 0;
  private serial = 0;
  private readonly random: SeededRandom;
  private readonly screeningDue = new Map<string, { at: number; reactive: boolean }>();
  private readonly transit = new Set<string>();

  constructor(input: ScenarioConfig) {
    this.config = parseScenarioConfig(input);
    this.state = generateState(this.config);
    this.storage = measureDataset(this.state);
    if (!this.storage.withinPlanningBudget) throw new Error("Dataset exceeds the local planning budget");
    this.random = new SeededRandom(`${this.config.seed}:events:v1`);
    if (this.config.scenario === "last-o-negative") {
      this.addRequest(this.config.startedAt, "O-", "PRBC", 1, 0);
      this.addRequest(this.config.startedAt, "O-", "PRBC", 1, 1);
    } else if (this.config.scenario === "stock-shortage") this.addRequest(this.config.startedAt, "O-", "PRBC", 2, 0);
    else if (this.config.scenario === "dengue-season") this.addRequest(this.config.startedAt, "B+", "PLATELETS", 4, 0);
  }
  get now() { return atOffset(this.config.startedAt, this.elapsedMs); }

  advanceBy(milliseconds: number) {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || this.elapsedMs + milliseconds > MAX_DURATION_MS) throw new Error("Simulation duration must be non-negative integer milliseconds within 30 days");
    const target = this.elapsedMs + milliseconds;
    while ((this.tick + 1) * TICK_MS <= target) {
      this.tick++;
      this.step(atOffset(this.config.startedAt, this.tick * TICK_MS));
    }
    this.elapsedMs = target;
  }
  private event(at: string, kind: Activity["kind"], text: string) {
    this.activity.push({ id: ++this.serial, at, kind, text });
    if (this.activity.length > 80) this.activity.shift();
  }
  private change(index: number, command: UnitCommand, now: string) {
    this.state.units[index] = transitionUnit(this.state.units[index], command, { now, actorId: "simulation", eventId: `sim:${this.tick}:${++this.serial}` }).unit;
  }
  private addRequest(now: string, group = sampleGroup(this.random), component: Component = this.random.pick(["PRBC", "PRBC", "PLATELETS", "FFP"]), quantity = this.random.integer(1, 3), hospitalIndex?: number) {
    const hospital = hospitalIndex === undefined ? this.random.pick(this.state.hospitals) : this.state.hospitals[hospitalIndex];
    const request = parseRequest({ id: `sim-request-${this.requests.length + 1}`, hospitalId: hospital.id, group, component, quantity, allocatedQuantity: 0, transfusedQuantity: 0, urgency: component === "PLATELETS" ? "URGENT" : "ROUTINE", expectedTransfusionAt: atOffset(now, 6 * 3_600_000), status: "OPEN" });
    this.requests.push({ request, createdAt: now });
    this.event(now, "REQUEST", `${hospital.name}: ${quantity} ${group} ${component} requested`);
  }
  private step(now: string) {
    const time = Date.parse(now);
    // Inventory expiry happens before arrivals, screening and matching at the same instant.
    for (let i = 0; i < this.state.units.length; i++) {
      const unit = this.state.units[i];
      if (["COLLECTED", "TESTING", "AVAILABLE"].includes(unit.status) && Date.parse(unit.expiresAt) <= time) {
        this.change(i, { type: "EXPIRE" }, now); this.screeningDue.delete(unit.id);
        this.event(now, "EXPIRY", `${unit.id}: ${unit.component} expired`);
      }
    }
    for (const transfer of this.transfers) if (transfer.status === "IN_TRANSIT" && Date.parse(transfer.arrivesAt) <= time) {
      const unit = this.state.units.find(u => u.id === transfer.unitId)!;
      this.transit.delete(unit.id);
      transfer.status = unit.status === "EXPIRED" ? "EXPIRED" : "RECEIVED";
      if (transfer.status === "RECEIVED") this.state.units[this.state.units.indexOf(unit)] = { ...unit, bankId: transfer.toBankId };
      this.event(now, "ARRIVAL", `${transfer.id}: ${transfer.status === "RECEIVED" ? "received at destination" : "expired in transit; excluded from stock"}`);
    }
    for (let i = 0; i < this.state.units.length; i++) {
      const unit = this.state.units[i], due = this.screeningDue.get(unit.id);
      if (!due || due.at > time) continue;
      this.change(i, { type: "UPDATE_SCREENING", screening: due.reactive ? { ...CLEAR_SCREENING, HIV: "REACTIVE" } : CLEAR_SCREENING }, now);
      if (!due.reactive) this.change(i, { type: "MAKE_AVAILABLE" }, now);
      this.screeningDue.delete(unit.id);
      this.event(now, "SCREENING", `${unit.id}: ${due.reactive ? "reactive mock screen; discarded" : "five mock screens clear; available"}`);
    }
    const preset = PRESETS[this.config.preset], clock = new Date(now);
    const hour = (clock.getUTCHours() + 5.5) % 24;
    const weekday = new Date(time + 5.5 * 3_600_000).getUTCDay(), weekend = weekday === 0 || weekday === 6;
    const demandPattern = hour >= 8 && hour < 12 ? 1.8 : hour < 6 || hour >= 22 ? (weekend ? 1.5 : .8) : .8;
    const demand = this.random.poisson(preset.requestsPerDay / 288 * demandPattern);
    for (let i = 0; i < demand; i++) this.addRequest(now);
    if (this.config.scenario === "dengue-season") {
      const extra = this.random.poisson(preset.requestsPerDay / 288); // additional platelet-only arrivals
      for (let i = 0; i < extra; i++) this.addRequest(now, sampleGroup(this.random), "PLATELETS");
    }
    const donations = this.random.poisson(preset.donationsPerDay / 288 * (weekend && hour >= 9 && hour < 15 ? 3 : 1));
    for (let i = 0; i < donations; i++) this.donate(now);

    // Demonstrative bank-to-bank moves, not Stage 10 optimized rebalancing.
    if (this.tick === 1 || this.tick % 288 === 0) this.transfer(now);
    const available = this.state.units.filter(unit => unit.status === "AVAILABLE" && !this.transit.has(unit.id));
    const pools = new Map<string, Unit[]>(), consumed = new Set<string>();
    for (const entry of this.requests) {
      if (!["OPEN", "PARTIAL"].includes(entry.request.status)) continue;
      if (time >= Date.parse(entry.request.expectedTransfusionAt)) {
        entry.request = parseRequest({ ...entry.request, status: "ESCALATED" });
        this.event(now, "ESCALATION", `${entry.request.id}: deadline reached with ${entry.request.quantity - entry.request.allocatedQuantity} units unmet`);
        continue;
      }
      const key = `${entry.request.component}:${entry.request.group}`, tiers = TIERS[entry.request.component][entry.request.group];
      let pool = pools.get(key);
      if (!pool) {
        pool = available.filter(unit => unit.component === entry.request.component && tiers[unit.group] >= 0).sort((a, b) => tiers[a.group] - tiers[b.group] || (a.expiresAt < b.expiresAt ? -1 : a.expiresAt > b.expiresAt ? 1 : a.bankId < b.bankId ? -1 : a.bankId > b.bankId ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        pools.set(key, pool);
      }
      // Reuse tick-local sorted indexes; final candidates still pass the Stage 2 engine.
      const candidates = pool.filter(unit => !consumed.has(unit.id) && unit.expiresAt > entry.request.expectedTransfusionAt).slice(0, entry.request.quantity - entry.request.allocatedQuantity);
      const selected = matchInventory(candidates, entry.request, now).selected;
      for (const selectedUnit of selected) {
        consumed.add(selectedUnit.id);
        const index = this.state.units.findIndex(u => u.id === selectedUnit.id);
        this.change(index, { type: "RESERVE", request: entry.request, allocationId: `sim-allocation:${selectedUnit.id}` }, now);
        entry.request = requestWithAllocations(entry.request, entry.request.allocatedQuantity + 1);
        this.change(index, { type: "ISSUE", request: entry.request, preparationConfirmed: true }, now);
        this.event(now, "MATCH", `${entry.request.id}: ${selectedUnit.id} matched and issued (synthetic)`);
      }
      if (entry.request.allocatedQuantity === entry.request.quantity) entry.matchedAt = now;
    }
  }
  private donate(now: string) {
    // A bounded search avoids repeatedly choosing an ineligible or recently used donor.
    const start = this.random.integer(0, this.state.donors.length - 1);
    let donor = this.state.donors[start];
    let found = false;
    for (let i = 0; i < this.state.donors.length; i++) {
      donor = this.state.donors[(start + i) % this.state.donors.length];
      if (donorEligibility(donor, now).eligible) { found = true; break; }
    }
    if (!found) return;
    const bank = this.random.pick(this.state.banks), reactive = this.random.next() < .02;
    this.state.donors[this.state.donors.indexOf(donor)] = { ...donor, lastDonationAt: now, eligibleFrom: atOffset(now, 120 * DAY_MS) };
    const collectionId = `collection-${this.tick}-${this.state.units.length}`;
    for (const product of ["PRBC_SAGM", "PLATELETS_CLOSED", "FFP_FROZEN"] as const) {
      const component = product === "PRBC_SAGM" ? "PRBC" : product === "PLATELETS_CLOSED" ? "PLATELETS" : "FFP";
      const unit = createCollectedUnit({ id: `${collectionId}:${component}`, donorId: donor.id, bankId: bank.id, group: donor.group, component, product, collectedAt: now });
      this.state.units.push(unit);
      const index = this.state.units.length - 1;
      this.change(index, { type: "START_TESTING" }, now);
      this.change(index, { type: "VERIFY_STORAGE", storage: "VERIFIED" }, now);
      this.screeningDue.set(unit.id, { at: Date.parse(now) + 6 * 3_600_000, reactive });
    }
    this.event(now, "DONATION", `${donor.nickname}: 3 components quarantined for 6 simulated hours`);
  }
  private transfer(now: string) {
    const unit = this.state.units.filter(u => u.status === "AVAILABLE" && u.group !== "O-" && !this.transit.has(u.id) && Date.parse(u.expiresAt) > Date.parse(now) + 3_600_000).sort((a, b) => a.expiresAt < b.expiresAt ? -1 : a.expiresAt > b.expiresAt ? 1 : a.id < b.id ? -1 : 1)[0];
    if (!unit) return;
    const fromIndex = this.state.banks.findIndex(b => b.id === unit.bankId), destination = this.state.banks[(fromIndex + 1) % this.state.banks.length];
    this.transit.add(unit.id);
    const transfer: Transfer = { id: `transfer-${this.transfers.length + 1}`, unitId: unit.id, fromBankId: unit.bankId, toBankId: destination.id, departedAt: now, arrivesAt: atOffset(now, 3_600_000), status: "IN_TRANSIT" };
    this.transfers.push(transfer);
    this.event(now, "TRANSFER", `${unit.id}: ${unit.bankId} → ${destination.id}; 1 simulated hour`);
  }
  snapshot(): SimulationSnapshot {
    const banks = this.state.banks.map(bank => ({ ...bank, stock: emptyStock() })), byBank = new Map(banks.map(bank => [bank.id, bank]));
    let availableStock = 0, testingStock = 0;
    for (const unit of this.state.units) {
      if (unit.status === "AVAILABLE" && !this.transit.has(unit.id) && Date.parse(unit.expiresAt) > Date.parse(this.now)) { byBank.get(unit.bankId)!.stock[unit.component][unit.group]++; availableStock++; }
      if (["COLLECTED", "TESTING"].includes(unit.status)) testingStock++;
    }
    const fulfilled = this.requests.filter(entry => entry.matchedAt).length;
    const times = this.requests.flatMap(entry => entry.matchedAt ? [(Date.parse(entry.matchedAt) - Date.parse(entry.createdAt)) / 60_000] : []);
    const expiredUnits = this.state.units.filter(unit => unit.status === "EXPIRED").length;
    const metrics: Metrics = { requests: this.requests.length, fulfilled, fulfilmentPercent: this.requests.length ? fulfilled / this.requests.length * 100 : null, requestedUnits: this.requests.reduce((sum, entry) => sum + entry.request.quantity, 0), issuedUnits: this.requests.reduce((sum, entry) => sum + entry.request.allocatedQuantity, 0), medianMatchMinutes: percentile(times, .5), p95MatchMinutes: percentile(times, .95), expiredUnits, expiryPercent: expiredUnits / this.state.units.length * 100, availableStock, testingStock, inTransit: this.transit.size, recentRequestsPerMinute: this.requests.filter(entry => Date.parse(entry.createdAt) > Date.parse(this.now) - 3_600_000).length / 60 };
    return { config: this.config, elapsedMs: this.elapsedMs, now: this.now, banks, hospitals: this.state.hospitals, districts: this.state.districts, counts: { donors: this.state.donors.length, units: this.state.units.length, historicalIssues: this.state.historicalIssues.length }, storage: this.storage, metrics, activity: this.activity.slice(-20), transfers: this.transfers.filter(t => t.status === "IN_TRANSIT" || Date.parse(t.arrivesAt) > Date.parse(this.now) - 3_600_000).slice(-20) };
  }
  /** Full deterministic state for byte-for-byte replay checks, not worker messages. */
  exportState() { return { config: this.config, state: this.state, elapsedMs: this.elapsedMs, tick: this.tick, randomState: this.random.state, serial: this.serial, requests: this.requests, transfers: this.transfers, activity: this.activity, screeningDue: [...this.screeningDue], transit: [...this.transit] }; }
}
