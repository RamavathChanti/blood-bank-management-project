import { expect, it } from "vitest";
import { DEFAULT_ELIGIBILITY, donorEligibility } from "../../src/core/donor-eligibility";
import { FIXTURE_NOW as now } from "../../src/core/fixtures";

const donor = { id: "demo-donor", nickname: "Synthetic volunteer", group: "A+", location: { latitude: 19, longitude: 73 }, birthDate: "1996-10-28", weightKg: 55, haemoglobin: 12.5, donationVolumeMl: 350, eligibleFrom: "2026-01-01T00:00:00Z", deferrals: [] };
it.each([
  [17, false, false], [18, false, true], [60, false, true], [61, false, false], [65, false, false], [66, false, false],
  [17, true, false], [18, true, true], [60, true, true], [61, true, true], [65, true, true], [66, true, false]
])("age %i, repeat %s => eligible %s", (age, repeat, eligible) => {
  expect(donorEligibility({ ...donor, birthDate: `${2026 - Number(age)}-10-28`, ...(repeat ? { lastDonationAt: "2025-01-01T00:00:00Z" } : {}) }, now).eligible).toBe(eligible);
});
it("uses completed age before and on the birthday", () => {
  expect(donorEligibility({ ...donor, birthDate: "2008-10-29" }, now).eligible).toBe(false);
  expect(donorEligibility({ ...donor, birthDate: "2008-10-28" }, now).eligible).toBe(true);
});
it.each([[350, 44.99, false], [350, 45, true], [450, 55, false], [450, 55.01, true]])("volume %i at %s kg => %s", (donationVolumeMl, weightKg, eligible) => expect(donorEligibility({ ...donor, donationVolumeMl, weightKg }, now).eligible).toBe(eligible));
it("requires Hb >=12.5 and valid, known inputs", () => {
  expect(donorEligibility({ ...donor, haemoglobin: 12.49 }, now).eligible).toBe(false);
  expect(donorEligibility({ ...donor, haemoglobin: 12.5 }, now).eligible).toBe(true);
  for (const invalid of [{ ...donor, haemoglobin: undefined }, { ...donor, birthDate: "1996-02-30" }, {}, null]) expect(donorEligibility(invalid, now).eligible).toBe(false);
});
it("takes the maximum interval, eligibleFrom and temporary deferral with equality allowed", () => {
  const input = { ...donor, lastDonationAt: "2026-06-30T03:30:00Z" }; // Exactly 120 elapsed days.
  expect(donorEligibility(input, now).eligible).toBe(true);
  expect(donorEligibility(input, "2026-10-28T03:29:59.999Z").eligible).toBe(false);
  const temporary = { ...input, eligibleFrom: "2026-10-29T03:30:00Z", deferrals: [{ kind: "TEMPORARY", reason: "scenario flag", until: "2026-10-30T03:30:00Z" }] };
  expect(donorEligibility(temporary, now).eligibleFrom).toBe("2026-10-30T03:30:00.000Z");
  expect(donorEligibility(temporary, "2026-10-30T03:30:00Z").eligible).toBe(true);
  expect(donorEligibility({ ...donor, eligibleFrom: now }, now).eligible).toBe(true);
});
it("blocks permanent and malformed deferrals, future donation history and future births", () => {
  expect(donorEligibility({ ...donor, deferrals: [{ kind: "PERMANENT", reason: "scenario flag" }] }, now).eligible).toBe(false);
  expect(donorEligibility({ ...donor, deferrals: [{ kind: "TEMPORARY", reason: "no end" }] }, now).eligible).toBe(false);
  expect(donorEligibility({ ...donor, lastDonationAt: "2027-01-01T00:00:00Z" }, now).eligible).toBe(false);
  expect(donorEligibility({ ...donor, birthDate: "2027-01-01" }, now).eligible).toBe(false);
});
it("supports explicit alternative interval configuration", () => {
  const input = { ...donor, lastDonationAt: "2026-07-30T03:30:00Z" };
  expect(donorEligibility(input, now).eligible).toBe(false);
  expect(donorEligibility(input, now, { ...DEFAULT_ELIGIBILITY, intervalDays: 90 }).eligible).toBe(true);
  expect(() => donorEligibility(input, now, { ...DEFAULT_ELIGIBILITY, minimumAge: 70 })).toThrow(/configuration/);
});
