import { describe, expect, it } from "vitest";
import { backtest, bloodWeather, DEFAULT_FORECAST, forecast, forecastOptions, issueSeries, supplyRate } from "../../src/core/forecast";
import { fixtureBanks, FIXTURE_NOW, inventoryFixtures } from "../../src/core/fixtures";
import { DAY_MS } from "../../src/core/shelf-life";
import type { HistoricalIssue } from "../../src/core/state-generator";

const until = FIXTURE_NOW, start = new Date(Date.parse(until) - 14 * DAY_MS).toISOString();
const coverage = fixtureBanks.map(bank => ({ bankId: bank.id, from: start, until }));
const history: HistoricalIssue[] = [{ id: "one", bankId: fixtureBanks[0].id, hospitalId: "synthetic", group: "A+", component: "PRBC", quantity: 14, at: start }];
describe("explicit observation coverage and supply", () => {
  it("includes the start boundary, excludes cutoff/future issues and separates bank/group/component", () => {
    const series = issueSeries([...history, { ...history[0], at: until, quantity: 100 }, { ...history[0], group: "B+", quantity: 100 }, { ...history[0], component: "PLATELETS", quantity: 100 }], [fixtureBanks[0].id], coverage, "A+", "PRBC", until, 14);
    expect(series.values).toEqual([14, ...Array(13).fill(0)]); expect(supplyRate(series, 3)).toEqual({ state: "OBSERVED", observedDays: 14, dailyRate: 1, daysOfSupply: 3 });
  });
  it("never turns absent or partially observed history into zero demand", () => {
    expect(supplyRate(issueSeries([], [fixtureBanks[0].id], [], "A+", "PRBC", until), 10).state).toBe("MISSING_HISTORY");
    expect(supplyRate(issueSeries([], [fixtureBanks[0].id], coverage.map(c => ({ ...c, from: new Date(Date.parse(start) + 1).toISOString() })), "A+", "PRBC", until, 14), 10).observedDays).toBe(13);
    expect(supplyRate({ start, values: Array(14).fill(0) }, 4)).toMatchObject({ state: "ZERO_DEMAND", dailyRate: 0, daysOfSupply: null });
  });
  it("aggregates district issues before division, and excludes unavailable and transiting stock", () => {
    const banks = fixtureBanks.map(b => ({ ...b, district: "Same district" }));
    const weather = bloodWeather(banks, inventoryFixtures(), history, coverage, until, DEFAULT_FORECAST, new Set(["DEMO-002"]));
    const row = weather.find(r => r.scope === "DISTRICT" && r.group === "A+" && r.component === "PRBC")!;
    expect(row.rate.dailyRate).toBe(1); expect(row.available).toBe(2); // DEMO-001 and near-expiry DEMO-009 only
    expect(weather.find(r => r.scope === "BANK" && r.id === banks[1].id && r.group === "A+" && r.component === "PRBC")?.rate.state).toBe("ZERO_DEMAND");
  });
});
describe("forecast models and independent held-out demand", () => {
  const flat = { ...DEFAULT_FORECAST, dengue: false, weekly: Array(7).fill(1) };
  it("requires fourteen consecutive days and twenty-eight for additive Holt–Winters", () => {
    expect(forecast({ start, values: Array(13).fill(1) }, "PRBC", flat).method).toBe("MISSING_HISTORY");
    expect(forecast({ start, values: Array(27).fill(1) }, "PRBC", flat).method).toBe("BASELINE_14_DAY");
    expect(forecast({ start, values: Array(28).fill(1) }, "PRBC", flat).method).toBe("HOLT_WINTERS");
    expect(forecast({ start, values: [...Array(40).fill(1), null, ...Array(13).fill(1)] }, "PRBC", flat).method).toBe("MISSING_HISTORY");
  });
  it("reproduces constant demand, zero demand, and an independent linear trend", () => {
    for (const day of forecast({ start, values: Array(28).fill(3) }, "PRBC", flat).daily) expect(day.expected).toBeCloseTo(3);
    expect(forecast({ start, values: Array(28).fill(0) }, "PRBC", flat).daily.every(d => d.expected === 0 && d.low === 0 && d.high === 0)).toBe(true);
    const f = forecast({ start, values: Array.from({ length: 56 }, (_, i) => 10 + i) }, "PRBC", { ...flat, alpha: 1, beta: 1, gamma: 0 });
    expect(f.daily[0].expected).toBeCloseTo(66); expect(f.daily[6].expected).toBeCloseTo(72);
  });
  it("learns a seven-day additive pattern without applying weekly factors twice", () => {
    const values = Array.from({ length: 56 }, (_, i) => [1, 2, 3, 4, 3, 2, 1][i % 7]);
    expect(forecast({ start, values }, "PRBC", { ...flat, weekly: [0, 0, 0, 0, 0, 0, 7] }).daily.map(d => d.expected)).toEqual(values.slice(0, 7));
  });
  it("applies the future platelet multiplier only to platelet forecasts and normalizes baseline weekly weights", () => {
    const options = { ...flat, dengue: true, plateletMultiplier: 3 };
    expect(forecast({ start, values: Array(14).fill(2) }, "PLATELETS", options).daily[0].expected).toBe(6);
    expect(forecast({ start, values: Array(14).fill(2) }, "PRBC", options).daily[0].expected).toBe(2);
    expect(forecastOptions({ ...flat, weekly: Array(7).fill(2) }).weekly).toEqual(Array(7).fill(1));
    expect(() => forecastOptions({ ...flat, weekly: Array(7).fill(0) })).toThrow();
  });
  it("fits only the training interval; seasonal holdout favors HW without requiring it on every dataset", () => {
    const series = { start, values: Array.from({ length: 70 }, (_, i) => [2, 4, 6, 8, 6, 4, 2][i % 7]) };
    const result = backtest(series, "PRBC", flat);
    expect(result.state).toBe("MEASURED");
    if (result.state === "MEASURED") { expect(result.holtWinters.mae).toBeLessThan(.000001); expect(result.baseline.mae).toBeGreaterThan(1); }
    expect(backtest({ start, values: Array(28).fill(1) }, "PRBC", flat).state).toBe("INSUFFICIENT_HISTORY");
    expect(() => forecast({ start, values: [NaN, ...Array(13).fill(1)] }, "PRBC")).toThrow();
  });
});
