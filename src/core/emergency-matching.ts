import { parseLocation, type Bank, type BloodRequest, type Donor, type Hospital, type Unit } from "./domain";
import { preferenceTier, isCompatible } from "./compatibility";
import { donorEligibility } from "./donor-eligibility";
import { stockReasons, validateRequestForUse } from "./inventory";
import { SeededRandom } from "./random";
import * as v from "./validation";

type Location = Bank["location"];
export function distanceKm(from: Location, to: Location): number {
  const a = parseLocation(from), b = parseLocation(to), rad = Math.PI / 180;
  const h = Math.sin((b.latitude - a.latitude) * rad / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin((b.longitude - a.longitude) * rad / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
/** Straight-line distance / assumed 30 km/h + five minutes handling. No road routing. */
export function travelMinutes(km: number) { return Math.ceil(v.number(0)(km) * 2 + 5); }
export function matchEmergencyStock(units: readonly Unit[], request: BloodRequest, banks: readonly Bank[], hospital: Hospital, now: string) {
  validateRequestForUse(request, now);
  if (new Set(units.map(u => u.id)).size !== units.length) throw new Error("Duplicate unit IDs in inventory");
  if (hospital.id !== request.hospitalId) throw new Error("Request hospital mismatch");
  const assessments = units.map(unit => {
    const bank = banks.find(bank => bank.id === unit.bankId), reasons: string[] = stockReasons(unit, request, now);
    const distance = bank ? distanceKm(bank.location, hospital.location) : Infinity;
    const eta = bank ? travelMinutes(distance) : Infinity;
    if (!bank) reasons.push("Unknown bank");
    if (Date.parse(now) + eta * 60_000 > Date.parse(request.expectedTransfusionAt)) reasons.push("Estimated arrival exceeds deadline");
    return { unit, bank, distance, eta, reasons };
  });
  const candidates = assessments.filter(item => !item.reasons.length).sort((a, b) => preferenceTier(a.unit.group, request.group, request.component) - preferenceTier(b.unit.group, request.group, request.component) || a.eta - b.eta || a.distance - b.distance || Date.parse(a.unit.expiresAt) - Date.parse(b.unit.expiresAt) || a.unit.bankId.localeCompare(b.unit.bankId) || a.unit.id.localeCompare(b.unit.id));
  return { assessments, candidates, selected: candidates.slice(0, request.quantity - request.allocatedQuantity) };
}

/** P(X >= k), calculated via bounded Bernoulli convolution; handles p=0/1 and underflow. */
export function acceptanceProbability(n: number, k: number, p: number): number {
  v.number(0, 5000, true)(n); v.number(0, 1000, true)(k); v.number(0, 1)(p);
  if (k === 0) return 1;
  if (n < k || p === 0) return 0;
  if (p === 1) return 1;
  const below = Array<number>(k).fill(0); below[0] = 1;
  let success = 0;
  for (let trial = 0; trial < n; trial++) {
    success += below[k - 1] * p;
    for (let j = k - 1; j > 0; j--) below[j] = below[j] * (1 - p) + below[j - 1] * p;
    below[0] *= 1 - p;
  }
  return Math.max(0, Math.min(1, success));
}
export function sizeWave(k: number, p: number, population: number, target = .95) {
  v.number(0, 1000, true)(k); v.number(0, 1)(p); v.number(0, 5000, true)(population); v.number(.01, 1)(target);
  // Compute each n in one pass; capped population makes impossible cases finite.
  const below = Array<number>(Math.max(1, k)).fill(0); below[0] = 1;
  let probability = k === 0 ? 1 : 0, count = 0;
  while (count < population && probability < target) {
    probability += below[k - 1] * p;
    for (let j = k - 1; j > 0; j--) below[j] = below[j] * (1 - p) + below[j - 1] * p;
    below[0] *= 1 - p; count++;
  }
  return { count, probability: Math.min(1, probability), target, targetMet: probability >= target, required: k, population };
}
export function monteCarloAcceptance(n: number, k: number, p: number, seed: string, trials = 20_000) {
  acceptanceProbability(n, k, p); v.number(1, 100_000, true)(trials);
  const random = new SeededRandom(seed); let successes = 0;
  for (let i = 0; i < trials; i++) { let accepted = 0; for (let j = 0; j < n; j++) if (random.next() < p) accepted++; if (accepted >= k) successes++; }
  return successes / trials;
}

export type AlertProfile = { donor: Donor; reliability: number; alertsThisMonth: number; lastAlertAt?: string };
export const parseWaveConfig = v.object({ acceptanceRate: v.number(0, 1), target: v.number(.01, 1), waitMinutes: v.number(1, 60, true), fatigueCap: v.number(1, 30, true), quietStartHour: v.number(0, 23, true), quietEndHour: v.number(0, 23, true), utcOffsetMinutes: v.number(-720, 840, true) });
export type WaveConfig = ReturnType<typeof parseWaveConfig>;
export const DEFAULT_WAVES: WaveConfig = { acceptanceRate: .23, target: .95, waitMinutes: 3, fatigueCap: 4, quietStartHour: 22, quietEndHour: 7, utcOffsetMinutes: 330 };
export function rankDonors(profiles: readonly AlertProfile[], request: BloodRequest, bank: Bank, now: string, input: WaveConfig, alerted: readonly string[] = []) {
  const config = parseWaveConfig(input), hour = new Date(Date.parse(v.instant(now)) + config.utcOffsetMinutes * 60_000).getUTCHours();
  const quiet = config.quietStartHour < config.quietEndHour ? hour >= config.quietStartHour && hour < config.quietEndHour : config.quietStartHour > config.quietEndHour && (hour >= config.quietStartHour || hour < config.quietEndHour);
  return profiles.map(profile => {
    v.number(0, 1)(profile.reliability); v.number(0, 1000, true)(profile.alertsThisMonth);
    const eligibility = donorEligibility(profile.donor, now), reasons = [...eligibility.reasons];
    const distance = distanceKm(profile.donor.location, bank.location), eta = travelMinutes(distance);
    if (!isCompatible(profile.donor.group, request.group, request.component)) reasons.push("Incompatible group");
    if (profile.alertsThisMonth >= config.fatigueCap) reasons.push("Monthly fatigue cap");
    if (profile.lastAlertAt && Date.parse(now) - Date.parse(v.instant(profile.lastAlertAt)) < 24 * 3_600_000) reasons.push("24-hour alert cooldown");
    if (alerted.includes(profile.donor.id)) reasons.push("Already alerted for this request");
    if (quiet && request.urgency !== "CRITICAL") reasons.push("Quiet hours (IST)");
    const days = eligibility.eligibleFrom ? Math.max(0, (Date.parse(now) - Date.parse(eligibility.eligibleFrom)) / 86_400_000) : 0;
    const score = 10 / eta + 2 * profile.reliability + Math.min(days, 365) / 365 - .25 * profile.alertsThisMonth;
    return { ...profile, distance, eta, score, days, reasons };
  }).sort((a, b) => b.score - a.score || a.donor.id.localeCompare(b.donor.id));
}
