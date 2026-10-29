import { parseRequest, type Bank, type Component, type Group, type Unit } from "./domain";
import { isCompatible, preferenceTier } from "./compatibility";
import { donorEligibility } from "./donor-eligibility";
import { distanceKm, sizeWave, travelMinutes } from "./emergency-matching";
import { CLEAR_SCREENING } from "./fixtures";
import { bloodWeather, backtest, DEFAULT_FORECAST, forecastOptions, issueSeries, readyUnit, type Coverage, type ForecastOptions, type WeatherRow } from "./forecast";
import { createCollectedUnit, requestWithAllocations, transitionUnit } from "./lifecycle";
import { SeededRandom } from "./random";
import { DEFAULT_REBALANCE, dispatchTransfer, planRebalancing, rebalanceOptions, receiveTransfers, transitIds, type PlannedTransfer, type RebalanceOptions } from "./rebalancing";
import { DAY_MS } from "./shelf-life";
import { DEFAULT_SCENARIO, createSimulationConfig } from "./simulation-config";
import { generateState, sampleGroup, type HistoricalIssue } from "./state-generator";
import { percentile } from "./simulator";
import * as v from "./validation";
import { planCamps, DEFAULT_CAMP } from "./camp-planner";

const HOUR = 3600000;
export const WASTE_POLICIES = ["NEAREST", "FEFO", "REBALANCE", "FORECAST_CAMPS"] as const;
export type WastePolicy = typeof WASTE_POLICIES[number];
export const POLICY_LABELS: Record<WastePolicy, string> = { NEAREST: "Nearest bank · any eligible unit", FEFO: "FEFO", REBALANCE: "FEFO + rebalancing", FORECAST_CAMPS: "Rebalancing + forecast camps" };
export type WasteConfig = { seed: string; startedAt: string; forecast: ForecastOptions; rebalance: RebalanceOptions; campCapacity: number; requestRadiusKm: number };
export const DEFAULT_WASTE: WasteConfig = { seed: "monsoon", startedAt: DEFAULT_SCENARIO.startedAt, forecast: DEFAULT_FORECAST, rebalance: DEFAULT_REBALANCE, campCapacity: 8, requestRadiusKm: 30 };
export function wasteConfig(input: WasteConfig): WasteConfig {
  if (!input || Object.keys(input).some(key => !["seed", "startedAt", "forecast", "rebalance", "campCapacity", "requestRadiusKm"].includes(key)) || typeof input.seed !== "string" || input.seed.length > 80) throw new Error("Invalid waste configuration");
  return { ...createSimulationConfig(input.seed, v.instant(input.startedAt)), forecast: forecastOptions(input.forecast), rebalance: rebalanceOptions(input.rebalance), campCapacity: v.number(0, 20, true)(input.campCapacity), requestRadiusKm: v.number(5, 180)(input.requestRadiusKm) };
}
type TapeRequest = { id: string; at: string; hospitalId: string; group: Group; component: Component; quantity: number; deadline: string };
type TapeDonation = { id: string; at: string; bankId: string; donorId: string; group: Group; reactive: boolean };
export type WasteTape = { banks: Bank[]; initialUnits: Unit[]; donors: ReturnType<typeof generateState>["donors"]; hospitals: ReturnType<typeof generateState>["hospitals"]; history: HistoricalIssue[]; requests: TapeRequest[]; donations: TapeDonation[]; historyFrom: string; signature: string };
/** Stable small checksum for UI equality only; artifact scripts also retain SHA-256. */
export function checksum(value: unknown) { let hash = 2166136261; const text = JSON.stringify(value); for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619); return (hash >>> 0).toString(16).padStart(8, "0"); }
export function makeWasteTape(input = DEFAULT_WASTE): WasteTape {
  const config = wasteConfig(input), state = generateState({ ...DEFAULT_SCENARIO, seed: config.seed, startedAt: config.startedAt, scenario: "near-expiry" });
  const start = Date.parse(config.startedAt), random = new SeededRandom(`${config.seed}:waste-exogenous:v1`);
  const origin = () => { const p = random.next(); return p < .55 ? 0 : p < .8 ? 1 : p < .95 ? 2 : 3; };
  const component = (): Component => random.pick(["PRBC", "PRBC", "PLATELETS", "FFP"]);
  const requests: TapeRequest[] = [], history: HistoricalIssue[] = [], donations: TapeDonation[] = [];
  // Deliberate teaching imbalance: 70% initial stock and most collections at low-demand bank 4.
  const initialUnits = state.units.map((unit, i) => ({ ...unit, bankId: i % 10 < 7 ? state.banks[3].id : unit.bankId }));
  const historyFrom = new Date(start - 70 * DAY_MS).toISOString();
  for (let day = -70; day < 30; day++) {
    const at = new Date(start + day * DAY_MS), weekday = new Date(at.getTime() + 5.5 * HOUR).getUTCDay();
    // Truth has its own fixed weekly shape; forecast inputs never rewrite the held-out truth.
    const count = random.poisson(24 * [.8, 1.2, 1.15, 1.1, 1.05, 1, .7][weekday]);
    for (let i = 0; i < count; i++) {
      const bankIndex = origin(), group = sampleGroup(random), type = component(), quantity = random.integer(1, 3);
      const time = new Date(start + day * DAY_MS + random.integer(0, 23) * HOUR).toISOString();
      if (day < 0) history.push({ id: `waste-history-${day}-${i}`, bankId: state.banks[bankIndex].id, hospitalId: state.hospitals[bankIndex].id, group, component: type, quantity, at: time });
      else requests.push({ id: `waste-request-${day}-${i}`, at: time, hospitalId: state.hospitals[bankIndex].id, group, component: type, quantity, deadline: new Date(Date.parse(time) + 6 * HOUR).toISOString() });
    }
    // Truth is a fixed 2x platelet shock, regardless of the assumed forecast multiplier.
    if (day >= 0) for (let i = 0, n = random.poisson(6); i < n; i++) {
      const bankIndex = origin(), time = new Date(start + day * DAY_MS + random.integer(0, 23) * HOUR).toISOString();
      requests.push({ id: `waste-dengue-${day}-${i}`, at: time, hospitalId: state.hospitals[bankIndex].id, group: sampleGroup(random), component: "PLATELETS", quantity: random.integer(1, 3), deadline: new Date(Date.parse(time) + 6 * HOUR).toISOString() });
    }
  }
  // Baseline donation schedule uses only eligible synthetic donors, once per month.
  const eligible = state.donors.filter(d => donorEligibility(d, config.startedAt).eligible);
  eligible.forEach((donor, i) => donations.push({ id: `waste-donation-${i}`, at: new Date(start + random.integer(0, 719) * HOUR).toISOString(), bankId: state.banks[random.next() < .6 ? 3 : random.integer(0, 2)].id, donorId: donor.id, group: donor.group, reactive: random.next() < .02 }));
  requests.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)); donations.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return { banks: state.banks, hospitals: state.hospitals, donors: state.donors, initialUnits, history, requests, donations, historyFrom, signature: checksum({ initialUnits, requests, donations, history }) };
}
export type WasteMetrics = { collected: number; expired: number; wastagePercent: number; requests: number; fulfilled: number; fulfilmentPercent: number | null; requestedUnits: number; issuedUnits: number; medianMatchMinutes: number | null; p95MatchMinutes: number | null; oNegativeNonONegative: number; oNegativeAvoidable: number; transferUnitKm: number; transfers: number; campDonations: number; screeningDiscarded: number; available: number; inTransit: number };
export type PolicyResult = { policy: WastePolicy; tapeSignature: string; metrics: WasteMetrics; expiredIds: string[]; issuedIds: string[]; transfers: PlannedTransfer[]; weather: WeatherRow[]; daily: { day: number; expired: number; issued: number; available: number }[]; unitsSaved: number; additionalExpiries: number; netExpiryReduction: number; stateSignature: string };
/** Isolated, hour-resolution teaching experiment. Random outcomes are pre-generated,
 * so policy decisions cannot change later requests, collections or screening results. */
export class WasteRun {
  readonly config: WasteConfig;
  readonly units: Unit[];
  readonly issues: HistoricalIssue[];
  readonly transfers: PlannedTransfer[] = [];
  readonly daily: PolicyResult["daily"] = [];
  readonly issuedIds = new Set<string>();
  readonly requests: { input: TapeRequest; allocated: number; matchedAt?: string }[] = [];
  private readonly screening = new Map<string, { due: number; reactive: boolean }>();
  private readonly campUsed = new Set<string>();
  private readonly baselineDonors: Set<string>;
  private requestIndex = 0;
  private donationIndex = 0;
  private hour = -1;
  private campDonations = 0;
  private oNegativeNonONegative = 0;
  private oNegativeAvoidable = 0;
  constructor(readonly policy: WastePolicy, readonly tape: WasteTape, input = DEFAULT_WASTE) {
    this.config = wasteConfig(input); this.units = tape.initialUnits.map(unit => ({ ...unit })); this.issues = [...tape.history]; this.baselineDonors = new Set(tape.donations.map(d => d.donorId));
  }
  get now() { return new Date(Date.parse(this.config.startedAt) + Math.max(0, this.hour) * HOUR).toISOString(); }
  private coverage(): Coverage[] { return this.tape.banks.map(bank => ({ bankId: bank.id, from: this.tape.historyFrom, until: this.now })); }
  weather() { return bloodWeather(this.tape.banks, this.units, this.issues, this.coverage(), this.now, this.config.forecast, transitIds(this.transfers)); }
  private collect(donation: TapeDonation) {
    for (const product of ["PRBC_SAGM", "PLATELETS_CLOSED", "FFP_FROZEN"] as const) {
      const component = product === "PRBC_SAGM" ? "PRBC" : product === "PLATELETS_CLOSED" ? "PLATELETS" : "FFP";
      const unit = createCollectedUnit({ id: `${donation.id}:${component}`, bankId: donation.bankId, donorId: donation.donorId, group: donation.group, component, product, collectedAt: donation.at });
      const context = { now: donation.at, actorId: "waste-simulation", eventId: `collect:${unit.id}` };
      const testing = transitionUnit(unit, { type: "START_TESTING" }, context).unit;
      this.units.push(transitionUnit(testing, { type: "VERIFY_STORAGE", storage: "VERIFIED" }, context).unit); this.screening.set(unit.id, { due: Date.parse(donation.at) + 6 * HOUR, reactive: donation.reactive });
    }
  }
  private planCamps(weather: WeatherRow[]) {
    const plans = planCamps(this.tape.banks, this.tape.donors, weather, this.now, { ...DEFAULT_CAMP, capacity: this.config.campCapacity }, new Set([...this.baselineDonors, ...this.campUsed]));
    for (const plan of plans) for (const invitation of plan.invitations) {
      const donor = this.tape.donors.find(d => d.id === invitation.donorId)!;
      this.campUsed.add(donor.id);
      const random = new SeededRandom(`${this.config.seed}:camp:${donor.id}`);
      if (random.next() >= invitation.probability) continue;
      this.campDonations++;
      this.collect({ id: `camp-${donor.id}`, at: this.now, bankId: plan.bankId, donorId: donor.id, group: donor.group, reactive: random.next() < .02 });
    }
  }
  advanceDay() { const target = Math.min(720, Math.max(0, this.hour) + 24); while (this.hour < target) this.step(); }
  private step() {
    this.hour++; const now = this.now, time = Date.parse(now), start = Date.parse(this.config.startedAt);
    const context = { now, actorId: "waste-simulation", eventId: `tick:${this.hour}` };
    for (let i = 0; i < this.units.length; i++) if (["AVAILABLE", "TESTING"].includes(this.units[i].status) && Date.parse(this.units[i].expiresAt) <= time) { this.units[i] = transitionUnit(this.units[i], { type: "EXPIRE" }, context).unit; this.screening.delete(this.units[i].id); }
    receiveTransfers(this.transfers, this.units, now);
    for (let i = 0; i < this.units.length; i++) {
      const due = this.screening.get(this.units[i].id);
      if (due && due.due <= time) {
        this.units[i] = transitionUnit(this.units[i], { type: "UPDATE_SCREENING", screening: due.reactive ? { ...CLEAR_SCREENING, HIV: "REACTIVE" } : CLEAR_SCREENING }, context).unit;
        if (!due.reactive) this.units[i] = transitionUnit(this.units[i], { type: "MAKE_AVAILABLE" }, context).unit;
        this.screening.delete(this.units[i].id);
      }
    }
    while (this.donationIndex < this.tape.donations.length && Date.parse(this.tape.donations[this.donationIndex].at) <= time) this.collect(this.tape.donations[this.donationIndex++]);
    if (this.hour % 24 === 0 && this.hour < 720 && ["REBALANCE", "FORECAST_CAMPS"].includes(this.policy)) {
      const weather = this.weather();
      const plan = planRebalancing(this.tape.banks, this.units, weather, now, this.config.rebalance, transitIds(this.transfers));
      this.transfers.push(...plan.transfers);
      for (const transfer of plan.transfers) dispatchTransfer(transfer, this.units, now, this.transfers, this.config.rebalance.bufferHours);
      if (this.policy === "FORECAST_CAMPS" && this.hour % (7 * 24) === 0) this.planCamps(this.weather());
    }
    while (this.requestIndex < this.tape.requests.length && Date.parse(this.tape.requests[this.requestIndex].at) <= time) this.requests.push({ input: this.tape.requests[this.requestIndex++], allocated: 0 });
    const unavailable = transitIds(this.transfers), byBank = new Map(this.tape.banks.map(bank => [bank.id, bank]));
    for (const entry of this.requests) {
      const r = entry.input; if (entry.matchedAt || time >= Date.parse(r.deadline)) continue;
      const hospital = this.tape.hospitals.find(h => h.id === r.hospitalId)!;
      const candidates = this.units.filter(u => readyUnit(u, now, unavailable) && u.component === r.component && isCompatible(u.group, r.group, r.component) && Date.parse(u.expiresAt) > Date.parse(r.deadline)).map(unit => ({ unit, km: distanceKm(byBank.get(unit.bankId)!.location, hospital.location) })).filter(item => item.km <= this.config.requestRadiusKm && time + travelMinutes(item.km) * 60000 <= Date.parse(r.deadline));
      candidates.sort((a, b) => (this.policy === "NEAREST" ? 0 : preferenceTier(a.unit.group, r.group, r.component) - preferenceTier(b.unit.group, r.group, r.component)) || a.km - b.km || (this.policy === "NEAREST" ? 0 : Date.parse(a.unit.expiresAt) - Date.parse(b.unit.expiresAt)) || a.unit.id.localeCompare(b.unit.id));
      const exactRemaining = new Set(candidates.filter(c => c.unit.group === r.group).map(c => c.unit.id));
      for (const { unit } of candidates.slice(0, r.quantity - entry.allocated)) {
        if (unit.group === "O-" && r.group !== "O-" && r.component === "PRBC") { this.oNegativeNonONegative++; if (exactRemaining.size > 0) this.oNegativeAvoidable++; }
        exactRemaining.delete(unit.id);
        let request = parseRequest({ id: r.id, hospitalId: r.hospitalId, group: r.group, component: r.component, quantity: r.quantity, allocatedQuantity: entry.allocated, transfusedQuantity: 0, urgency: "ROUTINE", expectedTransfusionAt: r.deadline, status: entry.allocated ? "PARTIAL" : "OPEN" });
        const reserved = transitionUnit(unit, { type: "RESERVE", request, allocationId: `waste-allocation:${unit.id}` }, context).unit;
        request = requestWithAllocations(request, entry.allocated + 1);
        const index = this.units.indexOf(unit); this.units[index] = transitionUnit(reserved, { type: "ISSUE", request, preparationConfirmed: true }, context).unit; this.issuedIds.add(unit.id); entry.allocated++;
        this.issues.push({ id: `issue:${unit.id}`, bankId: unit.bankId, hospitalId: r.hospitalId, group: unit.group, component: unit.component, quantity: 1, at: now });
      }
      if (entry.allocated === r.quantity) entry.matchedAt = now;
    }
    if (this.hour > 0 && this.hour % 24 === 0) this.daily.push({ day: (time - start) / DAY_MS, expired: this.units.filter(u => u.status === "EXPIRED").length, issued: this.issuedIds.size, available: this.units.filter(u => readyUnit(u, now, unavailable)).length });
  }
  result(): PolicyResult {
    const times = this.requests.flatMap(entry => entry.matchedAt ? [(Date.parse(entry.matchedAt) - Date.parse(entry.input.at)) / 60000] : []), expiredIds = this.units.filter(u => u.status === "EXPIRED").map(u => u.id).sort();
    const fulfilled = times.length, metrics: WasteMetrics = { collected: this.units.length, expired: expiredIds.length, wastagePercent: expiredIds.length / this.units.length * 100, requests: this.requests.length, fulfilled, fulfilmentPercent: this.requests.length ? fulfilled / this.requests.length * 100 : null, requestedUnits: this.requests.reduce((sum, entry) => sum + entry.input.quantity, 0), issuedUnits: this.issuedIds.size, medianMatchMinutes: percentile(times, .5), p95MatchMinutes: percentile(times, .95), oNegativeNonONegative: this.oNegativeNonONegative, oNegativeAvoidable: this.oNegativeAvoidable, transferUnitKm: this.transfers.filter(t => t.departedAt).reduce((sum, t) => sum + t.distanceKm, 0), transfers: this.transfers.filter(t => t.departedAt).length, campDonations: this.campDonations, screeningDiscarded: this.units.filter(u => u.status === "DISCARDED").length, available: this.units.filter(u => readyUnit(u, this.now, transitIds(this.transfers))).length, inTransit: transitIds(this.transfers).size };
    const stateSignature = checksum({ units: this.units, requests: this.requests, transfers: this.transfers });
    return { policy: this.policy, tapeSignature: this.tape.signature, metrics, expiredIds, issuedIds: [...this.issuedIds].sort(), transfers: this.transfers, weather: this.weather(), daily: this.daily, unitsSaved: 0, additionalExpiries: 0, netExpiryReduction: 0, stateSignature };
  }
}
export type WasteComparison = { config: WasteConfig; tapeSignature: string; results: PolicyResult[]; backtest: ReturnType<typeof backtest>; alerts: ReturnType<typeof compareAlertPolicies> };
export function compareAlertPolicies(seed: string, trials = 1000) {
  v.number(1, 10000, true)(trials);
  const population = 100, required = 2, p = .3, waveSize = sizeWave(required, p, population, .95).count;
  let wavesAlerts = 0, everyoneAlerts = 0, wavesSuccess = 0, everyoneSuccess = 0, wavesWait = 0;
  for (let trial = 0; trial < trials; trial++) {
    const random = new SeededRandom(`${seed}:alert-trial:${trial}`), accepts = Array.from({ length: population }, () => random.next() < p);
    everyoneAlerts += population; if (accepts.filter(Boolean).length >= required) everyoneSuccess++;
    let accepted = 0, alerted = 0, waves = 0;
    while (accepted < required && alerted < population && waves < 3) { const end = Math.min(population, alerted + waveSize); accepted += accepts.slice(alerted, end).filter(Boolean).length; alerted = end; waves++; }
    wavesAlerts += alerted; if (accepted >= required) { wavesSuccess++; wavesWait += Math.max(0, waves - 1) * 3; }
  }
  return { trials, population, required, acceptanceProbability: p, waveSize, waves: { alerts: wavesAlerts, successful: wavesSuccess, meanEscalationWaitMinutes: wavesSuccess ? wavesWait / wavesSuccess : null }, everyone: { alerts: everyoneAlerts, successful: everyoneSuccess, meanEscalationWaitMinutes: 0 }, assumptions: "Same per-donor Bernoulli outcomes in both policies; 3 waves maximum, 3-minute waits, no geography, quiet-hours or fatigue. Acceptance is not screened blood or time-to-match." };
}
export function finishComparison(config: WasteConfig, tape: WasteTape, results: PolicyResult[]): WasteComparison {
  const baseline = results.find(result => result.policy === "FEFO")!, baseExpired = new Set(baseline.expiredIds), baseIssued = new Set(baseline.issuedIds);
  for (const result of results) {
    result.unitsSaved = result.issuedIds.filter(id => baseExpired.has(id)).length;
    result.additionalExpiries = result.expiredIds.filter(id => baseIssued.has(id)).length;
    result.netExpiryReduction = baseline.metrics.expired - result.metrics.expired;
  }
  // Dedicated pre-shock synthetic demand holdout: no dengue uplift applied to that historical interval.
  const series = issueSeries(tape.history, tape.banks.map(b => b.id), tape.banks.map(bank => ({ bankId: bank.id, from: tape.historyFrom, until: config.startedAt })), "B+", "PLATELETS", config.startedAt, 70);
  return { config, tapeSignature: tape.signature, results, backtest: backtest(series, "PLATELETS", { ...config.forecast, dengue: false }), alerts: compareAlertPolicies(config.seed) };
}
export function runWasteComparison(input = DEFAULT_WASTE) {
  const config = wasteConfig(input), tape = makeWasteTape(config);
  return finishComparison(config, tape, WASTE_POLICIES.map(policy => { const run = new WasteRun(policy, tape, config); for (let day = 0; day < 30; day++) run.advanceDay(); return run.result(); }));
}
