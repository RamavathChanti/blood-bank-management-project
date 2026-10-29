import { beforeAll, expect, it } from "vitest";
import { compareAlertPolicies, DEFAULT_WASTE, makeWasteTape, runWasteComparison, WasteRun, type WasteComparison } from "../../src/core/waste-simulation";
import { readyUnit } from "../../src/core/forecast";
import { transitIds } from "../../src/core/rebalancing";
import { parseUnit } from "../../src/core/domain";

let result: WasteComparison;
beforeAll(() => { result = runWasteComparison(); }, 60000);
it("replays a matched month byte-for-byte and shares all exogenous requests/collections", () => {
  expect(runWasteComparison()).toEqual(result);
  expect(new Set(result.results.map(r => r.tapeSignature)).size).toBe(1);
  expect(new Set(result.results.map(r => r.metrics.requests)).size).toBe(1);
  expect(new Set(result.results.slice(0, 3).map(r => r.metrics.collected)).size).toBe(1);
  expect(result.results.every(r => r.daily.length === 30)).toBe(true);
}, 60000);
it("forecast assumption changes never change future demand or baseline donations", () => {
  expect(makeWasteTape({ ...DEFAULT_WASTE, forecast: { ...DEFAULT_WASTE.forecast, plateletMultiplier: 5, dengue: false } }).signature).toBe(makeWasteTape().signature);
  expect(makeWasteTape({ ...DEFAULT_WASTE, seed: "different" }).signature).not.toBe(makeWasteTape().signature);
});
it("measures saved identities and expiry denominator rather than counting transfers or remaining stock", () => {
  const fefo = result.results[1];
  for (const r of result.results) {
    expect(r.unitsSaved).toBe(r.issuedIds.filter(id => fefo.expiredIds.includes(id)).length);
    expect(r.metrics.wastagePercent).toBe(r.metrics.expired / r.metrics.collected * 100);
    expect(r.metrics.fulfilmentPercent).toBe(r.metrics.fulfilled / r.metrics.requests * 100);
    expect(r.metrics.issuedUnits).toBe(r.issuedIds.length);
    expect(r.metrics.oNegativeAvoidable).toBeLessThanOrEqual(r.metrics.oNegativeNonONegative);
  }
  expect(result.results[2].metrics.transfers).toBeGreaterThan(0);
  expect(result.results[3].metrics.campDonations).toBeGreaterThan(0);
  expect(result.backtest.state).toBe("MEASURED");
});
it("stock conservation holds after each day including transit", () => {
  const run = new WasteRun("FORECAST_CAMPS", makeWasteTape());
  for (let day = 0; day < 30; day++) {
    run.advanceDay(); const transit = transitIds(run.transfers), ready = run.units.filter(u => readyUnit(u, run.now, transit));
    expect(new Set(run.units.map(u => u.id)).size).toBe(run.units.length);
    for (const unit of run.units) expect(parseUnit(unit)).toEqual(unit);
    expect(ready.every(u => !transit.has(u.id))).toBe(true);
    const counters = run.result().metrics;
    expect(counters.collected).toBe(counters.available + counters.expired + counters.issuedUnits + counters.screeningDiscarded + counters.inTransit + run.units.filter(u => u.status === "TESTING").length);
  }
}, 60000);
it("donor waves share individual outcomes, expose escalation delay and never claim screened stock", () => {
  const comparison = compareAlertPolicies("monsoon"); expect(comparison).toEqual(compareAlertPolicies("monsoon"));
  expect(comparison.waves.alerts).toBeLessThan(comparison.everyone.alerts); expect(comparison.waves.successful).toBeLessThanOrEqual(comparison.everyone.successful);
  expect(comparison.waves.meanEscalationWaitMinutes).toBeGreaterThanOrEqual(0); expect(comparison.assumptions).toContain("not screened blood");
});
