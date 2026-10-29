import { describe, expect, it, vi } from "vitest";
import { COMPONENTS, GROUPS, parseBank, parseDonor, parseHospital, parseRequest, parseUnit } from "../../src/core/domain";
import { matchInventory } from "../../src/core/inventory";
import { isCompatible } from "../../src/core/compatibility";
import { SeededRandom } from "../../src/core/random";
import { DAY_MS, calculateExpiry } from "../../src/core/shelf-life";
import { DEFAULT_SCENARIO, parseScenarioConfig, PRESETS, SCENARIOS } from "../../src/core/simulation-config";
import { MAX_DURATION_MS, percentile, Simulator, TICK_MS } from "../../src/core/simulator";
import { generateState, GROUP_WEIGHTS, measureDataset, sampleGroup } from "../../src/core/state-generator";
import { SimulationRuntime } from "../../src/workers/simulation-runtime";
import type { SimulationWorkerResponse } from "../../src/workers/protocol";

describe("seeded state generator", () => {
  it("repeats a seed and separates seeds without reading ambient randomness", () => {
    const ambient = vi.spyOn(Math, "random").mockImplementation(() => { throw new Error("ambient randomness forbidden"); });
    const wallClock = vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("wall clock forbidden"); });
    try {
      expect(generateState(DEFAULT_SCENARIO)).toEqual(generateState(DEFAULT_SCENARIO));
      expect(generateState({ ...DEFAULT_SCENARIO, seed: "different" })).not.toEqual(generateState(DEFAULT_SCENARIO));
    } finally { ambient.mockRestore(); wallClock.mockRestore(); }
  });
  it.each(Object.keys(PRESETS) as (keyof typeof PRESETS)[])("validates %s entities, references, history, geography and storage allowance", preset => {
    const config = { ...DEFAULT_SCENARIO, preset }, state = generateState(config), expected = PRESETS[preset];
    expect([state.banks.length, state.hospitals.length, state.donors.length, state.units.length, state.historicalIssues.length]).toEqual([expected.banks, expected.hospitals, expected.donors, expected.units, expected.historicalIssues]);
    const banks = new Set(state.banks.map(b => parseBank(b)).map(b => b.id)), hospitals = new Set(state.hospitals.map(h => parseHospital(h)).map(h => h.id)), donors = new Map(state.donors.map(parseDonor).map(d => [d.id, d]));
    expect(new Set([...banks, ...hospitals, ...donors.keys(), ...state.units.map(u => u.id)]).size).toBe(banks.size + hospitals.size + donors.size + state.units.length);
    expect(new Set(state.banks.map(b => b.district)).size).toBe(4);
    for (const unit of state.units.map(parseUnit)) {
      expect(banks.has(unit.bankId)).toBe(true); expect(donors.get(unit.donorId)?.group).toBe(unit.group);
      expect(Date.parse(donors.get(unit.donorId)!.lastDonationAt!)).toBeGreaterThanOrEqual(Date.parse(unit.collectedAt));
      expect(unit.expiresAt).toBe(calculateExpiry(unit.collectedAt, unit.product));
    }
    for (const record of state.historicalIssues) {
      expect(banks.has(record.bankId) && hospitals.has(record.hospitalId)).toBe(true);
      expect(Date.parse(record.at)).toBeLessThan(Date.parse(config.startedAt));
      expect(Date.parse(record.at)).toBeGreaterThanOrEqual(Date.parse(config.startedAt) - 14 * DAY_MS);
    }
    for (const donor of donors.values()) { expect(donor.location.latitude).toBeGreaterThan(18.4); expect(donor.location.latitude).toBeLessThan(19.4); }
    const size = measureDataset(state);
    expect(size.jsonBytes).toBeGreaterThan(100_000); expect(size.withinPlanningBudget).toBe(true); expect(size.planningBytes).toBeLessThan(64 * 1024 * 1024);
  });
  it("samples the source plan's normalized group mix", () => {
    const random = new SeededRandom("distribution-check"), counts = Object.fromEntries(GROUPS.map(g => [g, 0]));
    for (let i = 0; i < 100_000; i++) counts[sampleGroup(random)]++;
    for (const [group, weight] of GROUP_WEIGHTS) expect(Math.abs(counts[group] / 100_000 - weight / 99.8)).toBeLessThan(.004);
  });
  it.each(SCENARIOS)("provides the named %s fixture", scenario => {
    const state = generateState({ ...DEFAULT_SCENARIO, scenario });
    if (["last-o-negative", "stock-shortage"].includes(scenario)) expect(state.units.filter(u => u.component === "PRBC" && u.group === "O-" && u.status === "AVAILABLE")).toHaveLength(1);
    if (scenario === "near-expiry") expect(state.units.filter(u => u.component === "PLATELETS" && Date.parse(u.expiresAt) === Date.parse(DEFAULT_SCENARIO.startedAt) + 3_600_000)).toHaveLength(12);
  });
  it("rejects malformed persisted configuration and accepts equivalent clock zones", () => {
    expect(parseScenarioConfig({ ...DEFAULT_SCENARIO, startedAt: "2026-10-28T09:00:00+05:30" })).toEqual(DEFAULT_SCENARIO);
    for (const input of [null, [], { ...DEFAULT_SCENARIO, version: 2 }, { ...DEFAULT_SCENARIO, preset: "__proto__" }, { ...DEFAULT_SCENARIO, seed: "x".repeat(81) }, { ...DEFAULT_SCENARIO, scenario: "unknown" }, { ...DEFAULT_SCENARIO, arbitraryCount: 1e9 }, { ...DEFAULT_SCENARIO, startedAt: "9999-01-01T00:00:00Z" }]) expect(() => parseScenarioConfig(input)).toThrow();
  });
});

describe("fixed-tick simulation", () => {
  it("the optimized candidate index preserves the domain engine's ordering for every component and recipient", () => {
    const sim = new Simulator(DEFAULT_SCENARIO), original = structuredClone(sim.state.units);
    for (const component of COMPONENTS) for (const group of GROUPS) sim.requests.push({ createdAt: sim.now, request: parseRequest({ id: `ordering:${component}:${group}`, hospitalId: sim.state.hospitals[0].id, group, component, quantity: 2, allocatedQuantity: 0, transfusedQuantity: 0, urgency: "ROUTINE", expectedTransfusionAt: "2026-10-28T09:30:00.000Z", status: "OPEN" }) });
    sim.advanceBy(TICK_MS);
    let pool = original.filter(unit => !sim.transfers.some(transfer => transfer.unitId === unit.id));
    for (const entry of sim.requests) {
      const unallocated = parseRequest({ ...entry.request, allocatedQuantity: 0, status: "OPEN" });
      const expected = matchInventory(pool, unallocated, sim.now).selected.map(unit => unit.id);
      const actual = sim.state.units.filter(unit => unit.reservation?.requestId === entry.request.id).map(unit => unit.id);
      expect(actual.sort()).toEqual([...expected].sort());
      pool = pool.filter(unit => !expected.includes(unit.id));
    }
  });
  it("replays an entire month byte-for-byte despite different wall clocks and batch sizes", () => {
    const one = new Simulator(DEFAULT_SCENARIO), two = new Simulator(DEFAULT_SCENARIO);
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(0), ambient = vi.spyOn(Math, "random").mockImplementation(() => { throw new Error("unseeded randomness forbidden"); });
    try {
      one.advanceBy(30 * DAY_MS);
      wallClock.mockReturnValue(9_000_000_000_000);
      for (let i = 0; i < 30; i++) { two.advanceBy(123_457); two.advanceBy(DAY_MS - 123_457); }
      expect(JSON.stringify(one.exportState())).toBe(JSON.stringify(two.exportState()));
      expect(one.snapshot().metrics.requests).toBeGreaterThan(500);
    } finally { wallClock.mockRestore(); ambient.mockRestore(); }
  }, 60_000);
  it("preserves fractional-tick remainder and guards bounded duration", () => {
    const one = new Simulator(DEFAULT_SCENARIO), two = new Simulator(DEFAULT_SCENARIO);
    one.advanceBy(TICK_MS + 123); two.advanceBy(123); two.advanceBy(TICK_MS);
    expect(one.exportState()).toEqual(two.exportState());
    for (const delta of [-1, NaN, Infinity, 1.5, MAX_DURATION_MS + 1]) expect(() => one.advanceBy(delta)).toThrow();
  });
  it("last O-negative fixture has exactly one allocation winner; shortage stays partial", () => {
    const last = new Simulator({ ...DEFAULT_SCENARIO, scenario: "last-o-negative" }); last.advanceBy(TICK_MS);
    expect(last.requests[0].request.status).toBe("ALLOCATED"); expect(last.requests[1].request.allocatedQuantity).toBe(0);
    expect(last.requests[0].matchedAt).toBe("2026-10-28T03:35:00.000Z");
    const shortage = new Simulator({ ...DEFAULT_SCENARIO, scenario: "stock-shortage" }); shortage.advanceBy(TICK_MS);
    expect(shortage.requests[0].request).toMatchObject({ quantity: 2, allocatedQuantity: 1, status: "PARTIAL" });
    expect(shortage.snapshot().metrics.fulfilled).toBeLessThan(shortage.snapshot().metrics.requests);
  });
  it("screening delay, shared reactive results and donation interval apply to all three components", () => {
    const sim = new Simulator(DEFAULT_SCENARIO);
    let firstTime = 0;
    for (let i = 0; i < 288; i++) { sim.advanceBy(TICK_MS); if (sim.state.units.some(u => u.id.startsWith("collection-"))) { firstTime = sim.elapsedMs; break; } }
    expect(firstTime).toBeGreaterThan(0);
    const collection = sim.state.units.filter(u => u.id.startsWith("collection-"));
    expect(collection).toHaveLength(3); expect(new Set(collection.map(u => u.component)).size).toBe(3);
    expect(collection.every(u => u.status === "TESTING" && Object.keys(u.screening).length === 0)).toBe(true);
    sim.advanceBy(6 * 3_600_000 - TICK_MS);
    expect(collection.every(unit => sim.state.units.find(u => u.id === unit.id)?.status === "TESTING")).toBe(true);
    sim.advanceBy(TICK_MS);
    expect(collection.every(unit => !["TESTING", "COLLECTED"].includes(sim.state.units.find(u => u.id === unit.id)!.status))).toBe(true);
    sim.advanceBy(7 * DAY_MS);
    const donated = sim.state.units.filter(u => u.id.startsWith("collection-"));
    for (const donorId of new Set(donated.map(u => u.donorId))) expect(new Set(donated.filter(u => u.donorId === donorId).map(u => u.collectedAt)).size).toBe(1);
    for (const collectionTime of new Set(donated.map(u => `${u.donorId}:${u.collectedAt}`))) {
      const products = donated.filter(u => `${u.donorId}:${u.collectedAt}` === collectionTime);
      expect(products).toHaveLength(3);
      expect(new Set(products.map(u => u.screening.HIV === "REACTIVE")).size).toBe(1);
    }
  }, 30_000);
  it("never matches incompatible, expired, quarantined or in-transit units", () => {
    const sim = new Simulator({ ...DEFAULT_SCENARIO, scenario: "dengue-season" }); sim.advanceBy(3 * DAY_MS);
    for (const unit of sim.state.units) {
      parseUnit(unit);
      if (unit.status !== "ISSUED") continue;
      const entry = sim.requests.find(entry => entry.request.id === unit.reservation!.requestId)!;
      expect(isCompatible(unit.group, entry.request.group, unit.component)).toBe(true);
      expect(unit.component).toBe(entry.request.component);
      expect(Date.parse(unit.expiresAt)).toBeGreaterThan(Date.parse(entry.request.expectedTransfusionAt));
      expect(Object.values(unit.screening).every(result => result === "NON_REACTIVE")).toBe(true);
      for (const t of sim.transfers.filter(t => t.unitId === unit.id)) expect(Date.parse(unit.reservation!.reservedAt)).toBeGreaterThanOrEqual(Date.parse(t.arrivesAt));
    }
    expect(sim.requests.some(entry => entry.request.status === "ESCALATED")).toBe(true);
    expect(sim.requests.every(entry => entry.request.status !== "COMPLETED")).toBe(true);
  }, 30_000);
  it("counts transferring stock at neither bank, then at only the destination on receipt", () => {
    const sim = new Simulator(DEFAULT_SCENARIO); sim.advanceBy(TICK_MS);
    const transfer = sim.transfers[0], unit = sim.state.units.find(u => u.id === transfer.unitId)!;
    expect(transfer.status).toBe("IN_TRANSIT"); expect(unit.bankId).toBe(transfer.fromBankId);
    const count = () => sim.snapshot().banks.reduce((sum, bank) => sum + COMPONENTS.reduce((total, c) => total + GROUPS.reduce((s, g) => s + bank.stock[c][g], 0), 0), 0);
    expect(count()).toBe(sim.snapshot().metrics.availableStock);
    expect(count()).toBe(sim.state.units.filter(u => u.status === "AVAILABLE").length - 1);
    sim.advanceBy(3_600_000);
    expect(transfer.status).toBe("RECEIVED"); expect(sim.state.units.find(u => u.id === transfer.unitId)!.bankId).toBe(transfer.toBankId);
    expect(count()).toBe(sim.snapshot().metrics.availableStock);
  });
  it("expires near-expiry inventory at the equality boundary", () => {
    const sim = new Simulator({ ...DEFAULT_SCENARIO, scenario: "near-expiry" });
    const ids = sim.state.units.filter(u => u.component === "PLATELETS" && Date.parse(u.expiresAt) === Date.parse(sim.now) + 3_600_000).map(u => u.id);
    sim.advanceBy(3_600_000 - TICK_MS); expect(sim.state.units.filter(u => ids.includes(u.id)).every(u => u.status === "AVAILABLE")).toBe(true);
    sim.advanceBy(TICK_MS); expect(sim.state.units.filter(u => ids.includes(u.id)).every(u => u.status === "EXPIRED")).toBe(true);
    expect(sim.snapshot().metrics.expiredUnits).toBeGreaterThanOrEqual(12);
  });
  it("dengue season adds platelet demand against the same baseline seed", () => {
    const baseline = new Simulator(DEFAULT_SCENARIO), dengue = new Simulator({ ...DEFAULT_SCENARIO, scenario: "dengue-season" });
    baseline.advanceBy(DAY_MS); dengue.advanceBy(DAY_MS);
    expect(dengue.requests.filter(r => r.request.component === "PLATELETS").length).toBeGreaterThan(baseline.requests.filter(r => r.request.component === "PLATELETS").length);
  });
  it("defines empty and nearest-rank percentiles", () => {
    expect(percentile([], .5)).toBeNull(); expect(percentile([5, 0, 30, 10], .5)).toBe(5); expect(percentile([5, 0, 30, 10], .95)).toBe(30);
    const metrics = new Simulator(DEFAULT_SCENARIO).snapshot().metrics;
    expect(metrics).toMatchObject({ requests: 0, fulfilmentPercent: null, medianMatchMinutes: null, p95MatchMinutes: null, expiredUnits: 0 });
  });
});

describe("worker playback controller", () => {
  it("supports speeds, pause, reset, chunked replay and equivalent paced duration", () => {
    const messages: SimulationWorkerResponse[] = [], runtime = new SimulationRuntime(response => messages.push(response));
    runtime.handle({ type: "load", config: DEFAULT_SCENARIO });
    runtime.handle({ type: "speed", speed: 3600 }); runtime.handle({ type: "play" });
    for (let i = 0; i < 8; i++) runtime.pump(250);
    expect(runtime.engine!.elapsedMs).toBe(2 * 3_600_000);
    runtime.handle({ type: "pause" }); const expected = JSON.stringify(runtime.engine!.exportState()); runtime.pump(250);
    expect(JSON.stringify(runtime.engine!.exportState())).toBe(expected);
    runtime.handle({ type: "replay" }); while (runtime.target !== null) runtime.pump(0);
    expect(JSON.stringify(runtime.engine!.exportState())).toBe(expected); expect(runtime.running).toBe(false);
    runtime.handle({ type: "reset" }); expect(runtime.engine!.elapsedMs).toBe(0);
    runtime.handle({ type: "advance", milliseconds: 2 * 3_600_000 }); while (runtime.target !== null) runtime.pump(0);
    expect(JSON.stringify(runtime.engine!.exportState())).toBe(expected);
    expect(messages.some(m => m.type === "error")).toBe(false);
    runtime.handle({ type: "advance", milliseconds: DAY_MS }); runtime.pump(0); runtime.handle({ type: "pause" });
    const paused = runtime.engine!.elapsedMs; runtime.pump(0); expect(runtime.engine!.elapsedMs).toBe(paused);
  });
  it("rejects invalid commands, preserves previous state, and stops at 30 days", () => {
    const messages: SimulationWorkerResponse[] = [], runtime = new SimulationRuntime(response => messages.push(response));
    runtime.handle({ type: "play" }); expect(messages.at(-1)?.type).toBe("error");
    runtime.handle({ type: "load", config: DEFAULT_SCENARIO });
    runtime.handle({ type: "speed", speed: Infinity }); expect(messages.at(-1)?.type).toBe("error");
    runtime.handle({ type: "advance", milliseconds: MAX_DURATION_MS + 1 }); expect(runtime.engine!.elapsedMs).toBe(0);
    runtime.handle({ type: "load", config: { ...DEFAULT_SCENARIO, seed: "" } }); expect(runtime.engine!.config).toEqual(DEFAULT_SCENARIO);
    runtime.engine!.advanceBy(MAX_DURATION_MS); runtime.handle({ type: "play" }); expect(runtime.running).toBe(false);
    runtime.handle({ type: "reset" }); runtime.handle({ type: "play" }); runtime.handle({ type: "pause" }); expect(runtime.engine!.elapsedMs).toBe(0);
  }, 30_000);
});
