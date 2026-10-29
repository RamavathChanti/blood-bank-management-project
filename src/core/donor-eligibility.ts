import { parseDonor, type Donor } from "./domain";
import { DAY_MS } from "./shelf-life";
import * as v from "./validation";

const parseRules = v.object({ minimumAge: v.number(1, 100, true), firstDonationMaximumAge: v.number(1, 100, true), repeatDonationMaximumAge: v.number(1, 100, true), intervalDays: v.number(1, 1000, true), minimumWeight350: v.number(1, 500), exclusiveWeight450: v.number(1, 500), minimumHaemoglobin: v.number(1, 30) });
export type EligibilityRules = ReturnType<typeof parseRules>;
export const DEFAULT_ELIGIBILITY: EligibilityRules = Object.freeze({ minimumAge: 18, firstDonationMaximumAge: 60, repeatDonationMaximumAge: 65, intervalDays: 120, minimumWeight350: 45, exclusiveWeight450: 55, minimumHaemoglobin: 12.5 });
export function donorEligibility(input: Donor | unknown, now: string, config: EligibilityRules = DEFAULT_ELIGIBILITY) {
  const clock = new Date(v.instant(now)), rules = parseRules(config);
  if (rules.minimumAge > rules.firstDonationMaximumAge || rules.firstDonationMaximumAge > rules.repeatDonationMaximumAge) throw new Error("Invalid eligibility age configuration");
  let donor: Donor;
  try { donor = parseDonor(input); } catch { return { eligible: false, reasons: ["Unknown or invalid mock donor inputs"], eligibleFrom: null, age: null }; }
  const born = new Date(`${donor.birthDate}T00:00:00Z`);
  let age = clock.getUTCFullYear() - born.getUTCFullYear();
  if (clock.getUTCMonth() < born.getUTCMonth() || clock.getUTCMonth() === born.getUTCMonth() && clock.getUTCDate() < born.getUTCDate()) age--;
  const reasons: string[] = [];
  if (age < rules.minimumAge || age > (donor.lastDonationAt ? rules.repeatDonationMaximumAge : rules.firstDonationMaximumAge)) reasons.push("Age outside teaching policy");
  if (donor.weightKg < rules.minimumWeight350 || donor.donationVolumeMl === 450 && donor.weightKg <= rules.exclusiveWeight450) reasons.push("Weight outside collection-volume policy");
  if (donor.haemoglobin < rules.minimumHaemoglobin) reasons.push("Mock haemoglobin below threshold");
  if (donor.deferrals.some(d => d.kind === "PERMANENT")) reasons.push("Permanent mock deferral");
  if (donor.lastDonationAt && Date.parse(donor.lastDonationAt) > clock.getTime()) reasons.push("Donation history is in the future");
  const from = Math.max(Date.parse(donor.eligibleFrom), donor.lastDonationAt ? Date.parse(donor.lastDonationAt) + rules.intervalDays * DAY_MS : -Infinity, ...donor.deferrals.filter(d => d.kind === "TEMPORARY").map(d => Date.parse(d.until!)));
  if (clock.getTime() < from) reasons.push("Donation interval, eligibleFrom, or temporary deferral has not elapsed");
  return { eligible: reasons.length === 0, reasons, eligibleFrom: new Date(from).toISOString(), age };
}
