import { expect, it } from "vitest";
import { affectedBySample, expiryCue, storageBreach, temperatureSample } from "../../src/core/cold-chain";
import { FIXTURE_NOW, inventoryFixtures, fixtureRequest } from "../../src/core/fixtures";
import { transitionUnit } from "../../src/core/lifecycle";
import { stockReasons } from "../../src/core/inventory";
import { confirmIntake, dictionaryIntake, opsAnswer, parseIntakeDraft } from "../../src/core/intelligence";
import { planCamps } from "../../src/core/camp-planner";
import { DEFAULT_SCENARIO } from "../../src/core/simulation-config";
import { generateState } from "../../src/core/state-generator";
import { bloodWeather } from "../../src/core/forecast";
const at = FIXTURE_NOW;
it.each([["PRBC", 2, false], ["PRBC", 6, false], ["PRBC", 1.99, true], ["PRBC", 6.01, true], ["PLATELETS", 20, false], ["PLATELETS", 24, false], ["PLATELETS", 19.99, true], ["FFP", -25, false], ["FFP", -25.01, false], ["FFP", -24.99, true]] as const)("checks %s at %s C independently of the feed generator", (component, celsius, breach) => {
  expect(storageBreach({ component, at, celsius, agitation: true, synthetic: true })).toBe(breach);
});
it("checks agitation loss, invalid sensor input, terminal stock and deterministic replay", () => {
  expect(storageBreach({ component: "PLATELETS", at, celsius: 22, agitation: false, synthetic: true })).toBe(true);
  expect(() => storageBreach({ component: "PRBC", at, celsius: NaN, agitation: true, synthetic: true })).toThrow();
  const sample = temperatureSample("monsoon", "PRBC", at, true);
  expect(sample).toEqual(temperatureSample("monsoon", "PRBC", at, true));
  expect(affectedBySample(inventoryFixtures()[0], sample)).toBe(true);
  expect(affectedBySample(inventoryFixtures()[9], sample)).toBe(false);
  expect(affectedBySample(inventoryFixtures()[13], sample)).toBe(false);
});
it("quarantines reserved stock, clears ownership, blocks use and cannot silently recover", () => {
  const source = inventoryFixtures()[2], req = fixtureRequest("O-", "PRBC", 1);
  const context = { now: at, actorId: "synthetic", eventId: "event" };
  const reserved = transitionUnit(source, { type: "RESERVE", request: req, allocationId: "allocation" }, context).unit;
  const { unit, event } = transitionUnit(reserved, { type: "QUARANTINE", note: "Synthetic excursion" }, context);
  expect(unit).toMatchObject({ status: "QUARANTINED", storage: "FAILED" }); expect(unit.reservation).toBeUndefined();
  expect(event).toMatchObject({ action: "QUARANTINE", from: "RESERVED", to: "QUARANTINED", requestId: req.id, allocationId: "allocation" });
  expect(stockReasons(unit, req, at)).toContain("NOT_AVAILABLE");
  for (const type of ["MAKE_AVAILABLE", "VERIFY_STORAGE"] as const) expect(() => transitionUnit(unit, type === "VERIFY_STORAGE" ? { type, storage: "VERIFIED" } : { type }, context)).toThrow();
  expect(affectedBySample(unit, temperatureSample("monsoon", "PRBC", at, true))).toBe(false);
  expect(expiryCue(source, source.expiresAt)).toBe("Expired");
  expect(transitionUnit(unit, { type: "DISCARD", note: "Manual synthetic review" }, context).unit.status).toBe("DISCARDED");
  expect(transitionUnit(unit, { type: "EXPIRE" }, { ...context, now: unit.expiresAt }).unit.status).toBe("EXPIRED");
});
it.each(["O- PRBC 2 units critical within 2 hours", "O- PRBC 2 यूनिट गंभीर 2 घंटे में", "O- PRBC 2 units critical 2 ghante mein"])("extracts the same explicit multilingual dictionary fields: %s", text => {
  const draft = dictionaryIntake(text, at); expect(draft).toMatchObject({ group: "O-", component: "PRBC", quantity: 2, urgency: "CRITICAL", expectedTransfusionAt: "2026-10-28T05:30:00.000Z" });
  expect(confirmIntake(draft, at).quantity).toBe(2);
});
it("keeps ambiguity empty and refuses unknown fields, out-of-range values and expired confirmations", () => {
  expect(dictionaryIntake("O- or A+ PRBC or platelets 2 units urgent critical 2 hours", at)).toMatchObject({ group: null, component: null, urgency: null });
  const draft = dictionaryIntake("O- PRBC 2 units critical 2 hours", at);
  expect(() => parseIntakeDraft({ ...draft, command: "submit" })).toThrow();
  expect(() => parseIntakeDraft({ ...draft, quantity: 21 })).toThrow();
  expect(() => confirmIntake({ ...draft, group: null }, at)).toThrow();
  expect(() => confirmIntake({ ...draft, expectedTransfusionAt: at }, at)).toThrow();
});
it("ranks eligible nearby donors once across sites, respects capacity and ignores missing history", () => {
  const state = generateState(DEFAULT_SCENARIO), coverage = state.banks.map(b => ({ bankId: b.id, from: new Date(Date.parse(at) - 14 * 86400000).toISOString(), until: at }));
  const weather = bloodWeather(state.banks, [], state.historicalIssues, coverage, at);
  const plans = planCamps(state.banks, state.donors, weather, at), invites = plans.flatMap(p => p.invitations);
  expect(invites.length).toBeGreaterThan(0); expect(invites.length).toBeLessThanOrEqual(8); expect(new Set(invites.map(i => i.donorId)).size).toBe(invites.length);
  expect(invites.every(i => i.distanceKm <= 25 && i.probability <= .65)).toBe(true);
  expect(plans.reduce((s, p) => s + p.expectedTurnout, 0)).toBeCloseTo(invites.reduce((s, i) => s + i.probability, 0));
  expect(planCamps(state.banks, state.donors, weather, at)).toEqual(plans);
  expect(planCamps(state.banks, state.donors, weather, at, { capacity: 0, radiusKm: 25, turnout: .65 })).toEqual([]);
  expect(planCamps(state.banks, state.donors, weather, at, undefined, new Set(state.donors.map(d => d.id)))).toEqual([]);
  const missing = bloodWeather(state.banks, [], [], [], at);
  expect(planCamps(state.banks, state.donors, missing, at)).toEqual([]);
});
it("copilot templates return aggregate fields only and count distinct proposed units", () => {
  expect(opsAnswer("TRANSFER_SUMMARY", [], [{ unitId: "one" }, { unitId: "one" }]).summary).toContain("1 proposed component units");
  expect(() => opsAnswer("drop database" as never, [], [])).toThrow();
});
