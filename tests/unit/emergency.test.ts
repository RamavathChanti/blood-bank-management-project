import { describe, expect, it, vi } from "vitest";
import { commandEmergency, emergencyFixture, startEmergency, validateEmergencyRequest, type Emergency, type EmergencyCommand } from "../../src/core/emergency";
import { acceptanceProbability, DEFAULT_WAVES, distanceKm, matchEmergencyStock, monteCarloAcceptance, rankDonors, sizeWave } from "../../src/core/emergency-matching";
import { FIXTURE_NOW } from "../../src/core/fixtures";
import { atOffset } from "../../src/core/state-generator";
import { parseRequest, parseUnit } from "../../src/core/domain";

const run = (s: Emergency, ...commands: EmergencyCommand[]) => commands.reduce(commandEmergency, s);
const advance = (minutes: number): EmergencyCommand => ({ type: "ADVANCE", minutes });
function acceptFirst(s: Emergency) {
  const id = s.alerts.find(a => a.status === "PENDING")!.donorId;
  return { id, state: commandEmergency(s, { type: "RESPOND", donorId: id, accepted: true }) };
}
function collectFirst(s: Emergency) {
  const accepted = acceptFirst(s);
  return { id: accepted.id, state: run(accepted.state, { type: "DISPATCH" }, advance(15), { type: "COLLECT", donorId: accepted.id }) };
}
describe("validated request and local stock journey", () => {
  it.each([0, -1, 21, 1.5, NaN, Infinity])("rejects invalid quantity %s", quantity => {
    const f = emergencyFixture("stock-available");
    expect(() => validateEmergencyRequest({ ...f.request, quantity }, f.registry, FIXTURE_NOW)).toThrow();
  });
  it.each([{ hospitalId: "unknown" }, { group: "C+" }, { component: "WHOLE" }, { urgency: "NOW" }, { expectedTransfusionAt: FIXTURE_NOW }, { expectedTransfusionAt: atOffset(FIXTURE_NOW, -1) }, { expectedTransfusionAt: atOffset(FIXTURE_NOW, 25 * 3_600_000) }, { expectedTransfusionAt: "2026-10-28T12:00:00" }, { extra: true }])("rejects invalid request %j", override => {
    const f = emergencyFixture("stock-available");
    expect(() => validateEmergencyRequest({ ...f.request, ...override }, f.registry, FIXTURE_NOW)).toThrow();
  });
  it("reserves but never completes on a match or dispatch; arrival gates handover", () => {
    const s = startEmergency("stock-available");
    expect(s.request.status).toBe("ALLOCATED"); expect(s.matchedAt).toBe(FIXTURE_NOW); expect(s.waves).toHaveLength(0);
    expect(() => commandEmergency(s, { type: "CONFIRM_USE" })).toThrow(/handover/);
    const dispatched = commandEmergency(s, { type: "DISPATCH" });
    expect(dispatched.request.transfusedQuantity).toBe(0);
    expect(() => commandEmergency(dispatched, { type: "HANDOVER" })).toThrow(/arrival/);
    expect(() => commandEmergency(dispatched, { type: "CANCEL" })).toThrow(/Dispatched/);
    const complete = run(dispatched, advance(60), { type: "HANDOVER" }, { type: "CONFIRM_USE" });
    expect(complete.request.status).toBe("COMPLETED"); expect(complete.request.transfusedQuantity).toBe(1);
    expect(complete.events.map(e => e.action)).toEqual(["RESERVE", "ISSUE", "HANDOVER", "TRANSFUSE"]);
    expect(s.registry.units.find(u => u.id === "scenario-last-o-negative")?.status).toBe("RESERVED");
    expect(() => commandEmergency(complete, { type: "CONFIRM_USE" })).toThrow(/closed/);
  });
  it("releases leases exactly at ten minutes; explicit search reacquires", () => {
    const s = startEmergency("stock-available");
    expect(commandEmergency(s, advance(9)).request.allocatedQuantity).toBe(1);
    const expired = commandEmergency(s, advance(10));
    expect(expired.request.allocatedQuantity).toBe(0);
    expect(() => commandEmergency(expired, { type: "DISPATCH" })).toThrow(/No active/);
    const rematched = commandEmergency(expired, { type: "MATCH" });
    expect(rematched.request.allocatedQuantity).toBe(1);
    expect(new Set(rematched.events.map(e => e.id)).size).toBe(rematched.events.length);
  });
  it("cancels before dispatch, releases stock and suppresses replies and further waves", () => {
    const s = commandEmergency(startEmergency("stock-shortage"), { type: "CANCEL" });
    expect(s.request.status).toBe("CANCELLED"); expect(s.request.allocatedQuantity).toBe(0);
    expect(s.alerts.every(a => a.status === "CANCELLED")).toBe(true);
    expect(s.registry.units.find(u => u.id === "scenario-last-o-negative")?.status).toBe("AVAILABLE");
    expect(() => commandEmergency(s, advance(1))).toThrow(/closed/);
  });
  it("rechecks arrival deadlines on dispatch", () => {
    const s = startEmergency("stock-available");
    const altered = { ...s, request: { ...s.request, expectedTransfusionAt: atOffset(s.now, 60_000) } };
    expect(() => commandEmergency(altered, { type: "DISPATCH" })).toThrow(/deadline/);
  });
  it("requires explicit synthetic FFP preparation before issue", () => {
    const f = emergencyFixture("stock-available");
    const plasma = f.registry.units.find(u => u.component === "FFP")!;
    const hospital = f.registry.hospitals.find(h => h.district === f.registry.banks.find(b => b.id === plasma.bankId)!.district)!;
    const s = startEmergency("stock-available", { ...f.request, hospitalId: hospital.id, group: plasma.group, component: "FFP" });
    expect(s.request.allocatedQuantity).toBe(1);
    expect(() => commandEmergency(s, { type: "DISPATCH" })).toThrow(/preparation/);
    const issued = commandEmergency(s, { type: "DISPATCH", preparationConfirmed: true });
    expect(issued.registry.units.find(u => u.status === "ISSUED")!.preparationConfirmedAt).toBe(s.now);
  });
});

describe("travel, compatibility preference and FEFO", () => {
  it("uses haversine distances including coincident and antipodal locations", () => {
    expect(distanceKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0 })).toBe(0);
    expect(distanceKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 })).toBeCloseTo(111.195, 2);
    expect(distanceKm({ latitude: 90, longitude: 0 }, { latitude: -90, longitude: 0 })).toBeCloseTo(20015.087, 2);
  });
  it("ranks compatibility then nearer bank then FEFO; excludes unsafe stock and slow travel", () => {
    const s = startEmergency("stock-available"), h = s.registry.hospitals[0];
    const request = parseRequest({ ...s.request, group: "A+", allocatedQuantity: 0, status: "OPEN", quantity: 4 });
    const banks = [{ ...s.registry.banks[0], location: h.location }, { ...s.registry.banks[1], location: { ...h.location, latitude: h.location.latitude + .1 } }];
    const base = s.registry.units.find(u => u.id === "scenario-last-o-negative")!;
    const unit = (id: string, override = {}) => parseUnit({ ...base, id, group: "A+", status: "AVAILABLE", reservation: undefined, ...override });
    const units = [unit("far-earlier", { bankId: banks[1].id }), unit("near-later", { expiresAt: atOffset(base.expiresAt, 60_000) }), unit("near-earlier"), unit("universal", { group: "O-" }), unit("pending", { screening: {} }), unit("wrong-component", { component: "FFP", product: "FFP_FROZEN" }), unit("unknown-bank", { bankId: "unknown" })];
    // Preserve valid shelf-life for the later-expiring candidate.
    units[1] = { ...units[1], collectedAt: atOffset(base.collectedAt, 60_000) };
    const result = matchEmergencyStock(units, request, banks, h, s.now);
    expect(result.selected.map(a => a.unit.id)).toEqual(["near-earlier", "near-later", "far-earlier", "universal"]);
    expect(result.assessments.find(a => a.unit.id === "pending")!.reasons).toContain("SCREENING_INCOMPLETE");
    expect(result.assessments.find(a => a.unit.id === "unknown-bank")!.reasons).toContain("Unknown bank");
    const soon = { ...request, expectedTransfusionAt: atOffset(s.now, 10 * 60_000) };
    expect(matchEmergencyStock(units, soon, banks, h, s.now).selected.map(a => a.unit.id)).not.toContain("far-earlier");
  });
});

describe("probability sizing verified independently", () => {
  it.each([0, .01, .23, .5, .99, 1])("matches an independent binomial sum at p=%s", p => {
    const factorial = (n: number): number => n <= 1 ? 1 : n * factorial(n - 1);
    for (let n = 1; n <= 20; n++) for (let k = 1; k <= n; k++) {
      let expected = 0;
      for (let x = k; x <= n; x++) expected += factorial(n) / factorial(x) / factorial(n - x) * p ** x * (1 - p) ** (n - x);
      expect(acceptanceProbability(n, k, p)).toBeCloseTo(expected, 11);
    }
  });
  it("chooses the minimum wave meeting 95% and agrees with a fixed Monte Carlo run", () => {
    expect(sizeWave(1, .23, 100).count).toBe(12);
    for (const k of [1, 2, 4]) {
      const plan = sizeWave(k, .23, 100);
      expect(plan.targetMet).toBe(true); expect(acceptanceProbability(plan.count - 1, k, .23)).toBeLessThan(.95);
      expect(plan.probability).toBeCloseTo(acceptanceProbability(plan.count, k, .23), 12);
      expect(Math.abs(monteCarloAcceptance(plan.count, k, .23, `monsoon-${k}`) - plan.probability)).toBeLessThan(.012);
    }
  });
  it("handles empty/insufficient/impossible/certain populations and large n stably", () => {
    expect(sizeWave(0, .23, 0)).toMatchObject({ count: 0, probability: 1, targetMet: true });
    expect(sizeWave(1, 0, 24)).toMatchObject({ count: 24, probability: 0, targetMet: false });
    expect(sizeWave(2, 1, 1).targetMet).toBe(false); expect(sizeWave(2, 1, 10).count).toBe(2);
    expect(sizeWave(3, .23, 0)).toMatchObject({ count: 0, targetMet: false });
    expect(acceptanceProbability(5000, 2, .5)).toBeCloseTo(1, 12);
    expect(() => sizeWave(1, NaN, 5)).toThrow(); expect(() => sizeWave(1, .2, 5001)).toThrow();
  });
});

describe("donor eligibility, quiet hours and ranking", () => {
  it("combines ETA, reliability, time since eligibility and fatigue with deterministic ties", () => {
    const s = startEmergency("stock-shortage"), p = { ...s.profiles[0], lastAlertAt: undefined }, bank = s.registry.banks[0];
    const profiles = [
      { ...p, donor: { ...p.donor, id: "a" }, reliability: .9, alertsThisMonth: 0 },
      { ...p, donor: { ...p.donor, id: "b" }, reliability: .1, alertsThisMonth: 0 },
      { ...p, donor: { ...p.donor, id: "c" }, reliability: .9, alertsThisMonth: 2 },
      { ...p, donor: { ...p.donor, id: "d", eligibleFrom: FIXTURE_NOW }, reliability: .9, alertsThisMonth: 0 }
    ];
    const ranked = rankDonors(profiles, s.request, bank, s.now, DEFAULT_WAVES);
    expect(ranked.map(p => p.donor.id)).toEqual(["a", "c", "d", "b"]);
    expect(ranked.every(p => !p.reasons.length)).toBe(true);
  });
  it("excludes incompatible, deferred, fatigued, recent and duplicate donors", () => {
    const s = startEmergency("stock-shortage"), p = s.profiles[0];
    const profiles = [
      { ...p, donor: { ...p.donor, id: "group", group: "A+" as const } },
      { ...p, donor: { ...p.donor, id: "deferred", eligibleFrom: atOffset(s.now, 1) } },
      { ...p, donor: { ...p.donor, id: "fatigue" }, alertsThisMonth: 4 },
      { ...p, donor: { ...p.donor, id: "recent" }, lastAlertAt: s.now },
      { ...p, donor: { ...p.donor, id: "duplicate" } }
    ];
    expect(rankDonors(profiles, s.request, s.registry.banks[0], s.now, DEFAULT_WAVES, ["duplicate"]).every(p => p.reasons.length > 0)).toBe(true);
  });
  it.each(["2026-10-28T16:30:00.000Z", "2026-10-29T01:29:00.000Z"])("applies quiet hours at %s with a critical-only override", now => {
    const s = startEmergency("stock-shortage"), p = { ...s.profiles[20], alertsThisMonth: 0, lastAlertAt: undefined };
    expect(rankDonors([p], { ...s.request, urgency: "URGENT" }, s.registry.banks[0], now, DEFAULT_WAVES)[0].reasons).toContain("Quiet hours (IST)");
    expect(rankDonors([p], s.request, s.registry.banks[0], now, DEFAULT_WAVES)[0].reasons).not.toContain("Quiet hours (IST)");
  });
  it("ends quiet hours at 07:00 IST and cooldown at exactly 24 hours", () => {
    const s = startEmergency("stock-shortage"), now = "2026-10-29T01:30:00.000Z";
    const p = { ...s.profiles[20], alertsThisMonth: 0, lastAlertAt: atOffset(now, -86_400_000) };
    expect(rankDonors([p], { ...s.request, urgency: "URGENT" }, s.registry.banks[0], now, DEFAULT_WAVES)[0].reasons).toEqual([]);
  });
});

describe("shortage, responses and screening gates", () => {
  it("opens 5/10/25 km waves, retains partial fulfilment, deduplicates and escalates after exhaustion", () => {
    let s = startEmergency("stock-shortage");
    expect(s.request.status).toBe("PARTIAL"); expect(s.waves[0]).toMatchObject({ radius: 5, count: 8, targetMet: false });
    s = run(s, { type: "DISPATCH" }, advance(9));
    expect(s.request.status).toBe("ESCALATED"); expect(s.waves.map(w => w.radius)).toEqual([5, 10, 25]);
    expect(new Set(s.alerts.map(a => a.donorId)).size).toBe(24); expect(s.alerts.every(a => a.status === "TIMED_OUT")).toBe(true);
    expect(s.request.allocatedQuantity).toBe(1); expect(s.request.transfusedQuantity).toBe(0);
    expect(s.escalation).toMatch(/Neighbouring-district/);
  });
  it("records refusal, rejects duplicate/late replies and waits the configured duration", () => {
    const s = startEmergency("stock-shortage", undefined, { ...DEFAULT_WAVES, waitMinutes: 5 });
    const id = s.alerts[0].donorId;
    const declined = commandEmergency(s, { type: "RESPOND", donorId: id, accepted: false });
    expect(declined.alerts[0].status).toBe("DECLINED");
    expect(() => commandEmergency(declined, { type: "RESPOND", donorId: id, accepted: true })).toThrow();
    expect(commandEmergency(declined, advance(4)).waves).toHaveLength(1);
    const widened = commandEmergency(declined, advance(5)); expect(widened.waves).toHaveLength(2);
    expect(() => commandEmergency(widened, { type: "RESPOND", donorId: s.alerts[1].donorId, accepted: true })).toThrow();
  });
  it("empty eligible populations produce explicit zero-alert waves and finite escalation", () => {
    const f = emergencyFixture("stock-shortage");
    const s = startEmergency("stock-shortage", { ...f.request, group: "AB-", component: "PLATELETS", quantity: 20 });
    expect(s.alerts).toHaveLength(0);
    const exhausted = commandEmergency(s, advance(9));
    expect(exhausted.request.status).toBe("ESCALATED");
    expect(exhausted.waves).toHaveLength(3);
    expect(exhausted.waves.every(w => w.count === 0 && !w.targetMet)).toBe(true);
  });
  it("cancelling a collected opportunity preserves its quarantined component", () => {
    const { id, state } = acceptFirst(startEmergency("screened-recovery"));
    const collected = run(state, advance(15), { type: "COLLECT", donorId: id });
    const cancelled = commandEmergency(collected, { type: "CANCEL" });
    expect(cancelled.request.allocatedQuantity).toBe(0);
    expect(cancelled.registry.units.at(-1)?.status).toBe("TESTING");
    expect(cancelled.request.transfusedQuantity).toBe(0);
  });
  it("acceptance never adds inventory or allocation and pending tests cannot be passed early", () => {
    const s = startEmergency("screened-recovery"), { id, state } = acceptFirst(s);
    expect(state.request.allocatedQuantity).toBe(1); expect(state.registry.units).toEqual(s.registry.units);
    expect(() => commandEmergency(state, { type: "COLLECT", donorId: id })).toThrow(/reach/);
    const collected = run(state, { type: "DISPATCH" }, advance(15), { type: "COLLECT", donorId: id });
    expect(collected.registry.units.at(-1)?.status).toBe("TESTING"); expect(collected.request.allocatedQuantity).toBe(1);
    expect(() => commandEmergency(collected, { type: "SCREEN", donorId: id, result: "NON_REACTIVE" })).toThrow(/six-hour/i);
    expect(commandEmergency(collected, advance(359)).request.transfusedQuantity).toBe(0);
  });
  it("completes a shortage only after collection, full screening, reservation and two handovers/use confirmations", () => {
    const { id, state } = collectFirst(startEmergency("screened-recovery"));
    const partial = run(state, advance(45), { type: "HANDOVER" }, { type: "CONFIRM_USE" });
    expect(partial.request.transfusedQuantity).toBe(1); expect(partial.request.status).toBe("PARTIAL");
    const screened = run(partial, advance(315), { type: "SCREEN", donorId: id, result: "NON_REACTIVE" });
    expect(screened.request.status).toBe("ALLOCATED"); expect(screened.request.transfusedQuantity).toBe(1);
    expect(screened.matchedAt).toBe(atOffset(FIXTURE_NOW, 375 * 60_000));
    const complete = run(screened, { type: "DISPATCH" }, advance(60), { type: "HANDOVER" }, { type: "CONFIRM_USE" });
    expect(complete.request.status).toBe("COMPLETED"); expect(complete.request.transfusedQuantity).toBe(2);
    expect(complete.registry.units.filter(u => u.status === "TRANSFUSED")).toHaveLength(2);
    complete.registry.units.forEach(parseUnit); parseRequest(complete.request);
    expect(new Set(complete.events.map(e => e.id)).size).toBe(complete.events.length);
  });
  it("reactive screening discards the unit and resumes unmet-demand waves", () => {
    const { id, state } = collectFirst(startEmergency("screened-recovery"));
    const failed = run(state, advance(360), { type: "SCREEN", donorId: id, result: "REACTIVE" });
    expect(failed.registry.units.at(-1)?.status).toBe("DISCARDED"); expect(failed.request.allocatedQuantity).toBe(1);
    expect(commandEmergency(failed, advance(1)).waves).toHaveLength(2);
  });
  it("a short deadline expires with accepted opportunities without manufacturing ready blood", () => {
    const { state } = acceptFirst(startEmergency("stock-shortage"));
    const expired = run(state, { type: "DISPATCH" }, advance(120));
    expect(expired.request.status).toBe("ESCALATED"); expect(expired.escalation).toMatch(/deadline/);
    expect(expired.request.transfusedQuantity).toBe(0); expect(expired.registry.units.some(u => u.id.startsWith("red-unit"))).toBe(false);
  });
  it("replays seeded replies and clock chunks identically without wall-clock or unseeded RNG", () => {
    const wall = vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("wall clock forbidden"); });
    const rng = vi.spyOn(Math, "random").mockImplementation(() => { throw new Error("unseeded RNG forbidden"); });
    try {
      const a = run(startEmergency("stock-shortage"), { type: "SEEDED_RESPONSES" }, { type: "DISPATCH" });
      const b = run(startEmergency("stock-shortage"), { type: "SEEDED_RESPONSES" }, { type: "DISPATCH" });
      expect(a).toEqual(b);
      expect(commandEmergency(a, advance(8))).toEqual(run(b, advance(3), advance(5)));
    } finally { wall.mockRestore(); rng.mockRestore(); }
  });
});
