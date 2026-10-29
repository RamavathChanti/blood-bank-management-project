import { componentFor, parseBank, parseDonor, parseHospital, parseUnit, type Bank, type Component, type Donor, type Group, type Hospital, type Product, type Unit } from "./domain";
import { CLEAR_SCREENING } from "./fixtures";
import { SeededRandom } from "./random";
import { calculateExpiry, DAY_MS } from "./shelf-life";
import { parseScenarioConfig, PRESETS, type ScenarioConfig } from "./simulation-config";

export const DISTRICT_CENTERS = [
  { id: "mumbai-city", name: "Mumbai City", location: { latitude: 18.98, longitude: 72.83 } },
  { id: "mumbai-suburban", name: "Mumbai Suburban", location: { latitude: 19.14, longitude: 72.88 } },
  { id: "thane", name: "Thane", location: { latitude: 19.25, longitude: 73.02 } },
  { id: "pune", name: "Pune", location: { latitude: 18.53, longitude: 73.86 } }
] as const;
/** Source plan §3.1 approximate weights total 99.8; normalize when sampling. */
export const GROUP_WEIGHTS: readonly (readonly [Group, number])[] = [["O+", 35.1], ["B+", 30.5], ["A+", 21.6], ["AB+", 7.3], ["O-", 2], ["B-", 1.7], ["A-", 1.2], ["AB-", .4]];
export function sampleGroup(random: SeededRandom): Group {
  let value = random.next() * GROUP_WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [group, weight] of GROUP_WEIGHTS) { value -= weight; if (value < 0) return group; }
  return "AB-";
}
export type HistoricalIssue = { id: string; bankId: string; hospitalId: string; group: Group; component: Component; quantity: number; at: string };
export type GeneratedState = { districts: typeof DISTRICT_CENTERS; banks: Bank[]; hospitals: Hospital[]; donors: Donor[]; units: Unit[]; historicalIssues: HistoricalIssue[] };
export const atOffset = (at: string, milliseconds: number) => new Date(Date.parse(at) + milliseconds).toISOString();

export function generateState(input: ScenarioConfig): GeneratedState {
  const config = parseScenarioConfig(input), preset = PRESETS[config.preset], random = new SeededRandom(`${config.seed}:geography:v1`);
  const point = (index: number) => {
    const center = DISTRICT_CENTERS[index % 4];
    return { latitude: +(center.location.latitude + (random.next() - .5) * .1).toFixed(5), longitude: +(center.location.longitude + (random.next() - .5) * .1).toFixed(5) };
  };
  const banks = Array.from({ length: preset.banks }, (_, i) => parseBank({ id: `demo-bank-${i + 1}`, name: `Demo Bank ${i + 1}`, district: DISTRICT_CENTERS[i % 4].name, location: point(i) }));
  const hospitals = Array.from({ length: preset.hospitals }, (_, i) => parseHospital({ id: `demo-hospital-${i + 1}`, name: `Demo Hospital ${i + 1}`, district: DISTRICT_CENTERS[i % 4].name, location: point(i) }));
  const populationRandom = new SeededRandom(`${config.seed}:population:v1`);
  const donors = Array.from({ length: preset.donors }, (_, i) => {
    const daysSince = populationRandom.integer(1, 240), lastDonationAt = atOffset(config.startedAt, -daysSince * DAY_MS);
    const born = new Date(config.startedAt); born.setUTCFullYear(born.getUTCFullYear() - populationRandom.integer(20, 59));
    return parseDonor({ id: `demo-donor-${i + 1}`, nickname: `Synthetic donor ${i + 1}`, group: sampleGroup(populationRandom), location: point(i), birthDate: born.toISOString().slice(0, 10), weightKg: populationRandom.integer(56, 90), haemoglobin: 13.5, donationVolumeMl: 450, lastDonationAt, eligibleFrom: atOffset(lastDonationAt, 120 * DAY_MS), deferrals: i % 31 === 0 ? [{ kind: "TEMPORARY", reason: "Synthetic short deferral", until: atOffset(config.startedAt, 3 * DAY_MS) }] : [] });
  });
  const stockRandom = new SeededRandom(`${config.seed}:stock:v1`);
  const units = Array.from({ length: preset.units }, (_, i) => {
    const donor = donors[i % donors.length], product: Product = stockRandom.pick(["PRBC_SAGM", "PRBC_SAGM", "PLATELETS_CLOSED", "FFP_FROZEN"]);
    const lifetime = product === "PRBC_SAGM" ? 42 : product === "PLATELETS_CLOSED" ? 5 : 365;
    const collectedAt = atOffset(config.startedAt, -(stockRandom.integer(1, lifetime * 24 - 1)) * 3_600_000);
    return parseUnit({ id: `seed-unit-${i + 1}`, bankId: banks[i % banks.length].id, donorId: donor.id, group: donor.group, component: componentFor(product), product, collectedAt, expiresAt: calculateExpiry(collectedAt, product), status: "AVAILABLE", screening: CLEAR_SCREENING, storage: "VERIFIED" });
  });
  // Named fixtures are deliberate overrides of the statistical baseline.
  if (["last-o-negative", "stock-shortage"].includes(config.scenario)) {
    for (let i = units.length - 1; i >= 0; i--) if (units[i].group === "O-" && units[i].component === "PRBC") units.splice(i, 1);
    let donor = donors.find(donor => donor.group === "O-");
    if (!donor) {
      donor = { ...donors[donors.length - 1], group: "O-" };
      donors[donors.length - 1] = donor;
      for (let i = 0; i < units.length; i++) if (units[i].donorId === donor.id) units[i] = { ...units[i], group: "O-" };
    }
    units.push(parseUnit({ id: "scenario-last-o-negative", bankId: banks[0].id, donorId: donor.id, group: "O-", component: "PRBC", product: "PRBC_SAGM", collectedAt: atOffset(config.startedAt, -40 * DAY_MS), expiresAt: atOffset(config.startedAt, 2 * DAY_MS), status: "AVAILABLE", screening: CLEAR_SCREENING, storage: "VERIFIED" }));
  }
  if (config.scenario === "near-expiry") {
    for (const unit of units.filter(u => u.component === "PLATELETS").slice(0, 12)) {
      const collectedAt = atOffset(config.startedAt, -5 * DAY_MS + 3_600_000);
      units[units.indexOf(unit)] = { ...unit, collectedAt, expiresAt: calculateExpiry(collectedAt, unit.product) };
    }
  }
  // Initial inventory is collection history too; donors cannot donate again early.
  const latestCollections = new Map<string, string>();
  for (const unit of units) if (!latestCollections.has(unit.donorId) || unit.collectedAt > latestCollections.get(unit.donorId)!) latestCollections.set(unit.donorId, unit.collectedAt);
  for (let i = 0; i < donors.length; i++) {
    const last = latestCollections.get(donors[i].id);
    if (last && last > donors[i].lastDonationAt!) donors[i] = { ...donors[i], lastDonationAt: last, eligibleFrom: atOffset(last, 120 * DAY_MS) };
  }
  const historyRandom = new SeededRandom(`${config.seed}:history:v1`);
  const historicalIssues = Array.from({ length: preset.historicalIssues }, (_, i): HistoricalIssue => ({ id: `history-${i + 1}`, bankId: historyRandom.pick(banks).id, hospitalId: historyRandom.pick(hospitals).id, group: sampleGroup(historyRandom), component: historyRandom.pick(["PRBC", "PLATELETS", "FFP"] as const), quantity: historyRandom.integer(1, 3), at: atOffset(config.startedAt, -historyRandom.integer(1, 14 * 24 * 60) * 60_000) })).sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1);
  return { districts: DISTRICT_CENTERS, banks, hospitals, donors, units, historicalIssues };
}

/** UTF-8 JSON measurement only; BSON and Atlas index bytes must be checked at Stage 5. */
export function measureDataset(state: GeneratedState) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;
  return { jsonBytes, planningBytes: jsonBytes * 4, planningBudgetBytes: 64 * 1024 * 1024, withinPlanningBudget: jsonBytes * 4 < 64 * 1024 * 1024 };
}
