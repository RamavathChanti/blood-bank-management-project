import { COMPONENTS, GROUPS, SCREENS, type Bank, type Component, type Group, type Unit } from "./domain";
import type { HistoricalIssue } from "./state-generator";
import { DAY_MS } from "./shelf-life";
import * as v from "./validation";

export type Coverage = { bankId: string; from: string; until: string };
export type DemandSeries = { start: string; values: (number | null)[] };
export type ForecastOptions = { weekly: number[]; dengue: boolean; plateletMultiplier: number; alpha: number; beta: number; gamma: number };
export const DEFAULT_FORECAST: ForecastOptions = { weekly: [.8, 1.2, 1.15, 1.1, 1.05, 1, .7], dengue: true, plateletMultiplier: 2, alpha: .3, beta: .1, gamma: .2 };
export function forecastOptions(input: ForecastOptions): ForecastOptions {
  const result = v.object({ weekly: v.array(v.number(0, 7)), dengue: v.boolean, plateletMultiplier: v.number(1, 5), alpha: v.number(0, 1), beta: v.number(0, 1), gamma: v.number(0, 1) })(input);
  if (result.weekly.length !== 7 || result.weekly.reduce((a, b) => a + b, 0) === 0) throw new Error("Seven non-zero-total weekday weights required");
  const mean = result.weekly.reduce((a, b) => a + b, 0) / 7;
  return { ...result, weekly: result.weekly.map(value => value / mean) };
}
export function readyUnit(unit: Unit, now: string, unavailable: ReadonlySet<string> = new Set()) {
  return unit.status === "AVAILABLE" && unit.storage === "VERIFIED" && SCREENS.every(screen => unit.screening[screen] === "NON_REACTIVE") && Date.parse(unit.collectedAt) <= Date.parse(now) && Date.parse(unit.expiresAt) > Date.parse(now) && !unavailable.has(unit.id);
}
/** Complete rolling 24h bins ending at `until`; absent observation is null, never zero. */
export function issueSeries(issues: readonly HistoricalIssue[], bankIds: readonly string[], coverage: readonly Coverage[], group: Group, component: Component, until: string, days = 56): DemandSeries {
  v.number(1, 366, true)(days); v.instant(until);
  const end = Date.parse(until), start = end - days * DAY_MS;
  const selected = new Set(bankIds);
  const values = Array.from({ length: days }, (_, i) => bankIds.length > 0 && bankIds.every(bankId => coverage.some(c => c.bankId === bankId && Date.parse(c.from) <= start + i * DAY_MS && Date.parse(c.until) >= start + (i + 1) * DAY_MS)) ? 0 : null);
  for (const issue of issues) {
    const at = Date.parse(issue.at), index = Math.floor((at - start) / DAY_MS);
    if (selected.has(issue.bankId) && issue.group === group && issue.component === component && at >= start && at < end && values[index] !== null) values[index]! += v.number(1, 1000, true)(issue.quantity);
  }
  return { start: new Date(start).toISOString(), values };
}
export function supplyRate(series: DemandSeries, available: number) {
  v.number(0, Infinity, true)(available);
  const window = series.values.slice(-14), observedDays = window.filter(value => value !== null).length;
  if (window.length < 14 || observedDays < 14) return { state: "MISSING_HISTORY" as const, observedDays, dailyRate: null, daysOfSupply: null };
  const dailyRate = (window as number[]).reduce((sum, value) => sum + value, 0) / 14;
  // Infinity is deliberately represented as null + explicit state for JSON/worker safety.
  return { state: dailyRate === 0 ? "ZERO_DEMAND" as const : "OBSERVED" as const, observedDays, dailyRate, daysOfSupply: dailyRate === 0 ? null : available / dailyRate };
}
type Model = { method: "BASELINE_14_DAY" | "HOLT_WINTERS"; predict: (h: number) => number; residualScale: number };
function fit(values: number[], options: ForecastOptions, useHW: boolean): Model {
  const mean = values.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, values.length);
  if (!useHW || values.length < 28) {
    const residualScale = Math.sqrt(values.slice(-14).reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.min(14, values.length));
    return { method: "BASELINE_14_DAY", predict: () => mean, residualScale };
  }
  const { alpha, beta, gamma } = options, m = 7;
  const firstMean = values.slice(0, m).reduce((a, b) => a + b) / m;
  let trend = (values.slice(m, 2 * m).reduce((a, b) => a + b) / m - firstMean) / m;
  let level = firstMean + trend * (m - 1) / 2;
  const seasonal = values.slice(0, m).map((value, i) => value - (firstMean + (i - (m - 1) / 2) * trend)), residuals: number[] = [];
  for (let t = m; t < values.length; t++) {
    const prior = level, priorTrend = trend, season = seasonal[t % m];
    residuals.push(values[t] - (level + trend + season));
    level = alpha * (values[t] - season) + (1 - alpha) * (level + trend);
    trend = beta * (level - prior) + (1 - beta) * trend;
    seasonal[t % m] = gamma * (values[t] - prior - priorTrend) + (1 - gamma) * season;
  }
  return { method: "HOLT_WINTERS", predict: h => Math.max(0, level + h * trend + seasonal[(values.length + h - 1) % m]), residualScale: Math.sqrt(residuals.reduce((sum, value) => sum + value * value, 0) / residuals.length) };
}
export type Forecast = { method: "MISSING_HISTORY" | Model["method"]; observedDays: number; daily: { at: string; expected: number; low: number; high: number }[]; assumptions: string };
export function forecast(series: DemandSeries, component: Component, input = DEFAULT_FORECAST, horizon = 7, useHW = true): Forecast {
  v.instant(series.start); v.number(1, 30, true)(horizon); const options = forecastOptions(input);
  for (const value of series.values) if (value !== null) v.number(0)(value);
  // Never train across gaps, and never read future samples.
  const gap = series.values.lastIndexOf(null), values = series.values.slice(gap + 1) as number[];
  const assumptions = "Synthetic issue history can understate unmet demand. Weekly weights apply to baseline only; Holt–Winters learns weekly effects. Dengue is a future platelet scenario adjustment. Bands are heuristic ±1.96 residual RMSE × √h, not calibrated clinical intervals.";
  if (values.length < 14) return { method: "MISSING_HISTORY", observedDays: values.length, daily: [], assumptions };
  const model = fit(values, options, useHW), end = Date.parse(series.start) + series.values.length * DAY_MS;
  const multiplier = component === "PLATELETS" && options.dengue ? options.plateletMultiplier : 1;
  return { method: model.method, observedDays: values.length, assumptions, daily: Array.from({ length: horizon }, (_, i) => {
    const at = new Date(end + i * DAY_MS).toISOString();
    const weekday = new Date(Date.parse(at) + 5.5 * 3_600_000).getUTCDay();
    const factor = multiplier * (model.method === "BASELINE_14_DAY" ? options.weekly[weekday] : 1);
    const expected = model.predict(i + 1) * factor, spread = 1.96 * model.residualScale * Math.sqrt(i + 1) * factor;
    return { at, expected, low: Math.max(0, expected - spread), high: expected + spread };
  }) };
}
export function backtest(series: DemandSeries, component: Component, options = DEFAULT_FORECAST, holdout = 14) {
  v.number(1, 30, true)(holdout);
  if (series.values.length < 28 + holdout || series.values.some(value => value === null)) return { state: "INSUFFICIENT_HISTORY" as const };
  const train = { start: series.start, values: series.values.slice(0, -holdout) }, actual = series.values.slice(-holdout) as number[];
  const score = (hw: boolean) => {
    const result = forecast(train, component, options, holdout, hw), errors = result.daily.map((day, i) => day.expected - actual[i]);
    return { method: result.method, mae: errors.reduce((sum, x) => sum + Math.abs(x), 0) / holdout, rmse: Math.sqrt(errors.reduce((sum, x) => sum + x * x, 0) / holdout) };
  };
  return { state: "MEASURED" as const, trainDays: train.values.length, holdoutDays: holdout, baseline: score(false), holtWinters: score(true) };
}
export type WeatherRow = { scope: "BANK" | "DISTRICT"; id: string; name: string; district: string; group: Group; component: Component; available: number; rate: ReturnType<typeof supplyRate>; forecast: Forecast; weather: "UNKNOWN" | "NO_OBSERVED_DEMAND" | "STORM" | "WATCH" | "CLEAR" };
export function bloodWeather(banks: readonly Bank[], units: readonly Unit[], issues: readonly HistoricalIssue[], coverage: readonly Coverage[], now: string, options = DEFAULT_FORECAST, unavailable: ReadonlySet<string> = new Set(), historyUntil = now): WeatherRow[] {
  const scopes = [...banks.map(bank => ({ scope: "BANK" as const, id: bank.id, name: bank.name, district: bank.district, ids: [bank.id] })), ...[...new Set(banks.map(b => b.district))].map(district => ({ scope: "DISTRICT" as const, id: district, name: district, district, ids: banks.filter(b => b.district === district).map(b => b.id) }))];
  return scopes.flatMap(scope => COMPONENTS.flatMap(component => GROUPS.map(group => {
    const available = units.filter(u => scope.ids.includes(u.bankId) && u.component === component && u.group === group && readyUnit(u, now, unavailable)).length;
    const series = issueSeries(issues, scope.ids, coverage, group, component, historyUntil), rate = supplyRate(series, available), prediction = forecast(series, component, options);
    const expected = prediction.daily.reduce((sum, day) => sum + day.expected, 0) / 7;
    const adjustedDays = expected > 0 ? available / expected : null;
    const weather = rate.state === "MISSING_HISTORY" ? "UNKNOWN" : rate.state === "ZERO_DEMAND" ? "NO_OBSERVED_DEMAND" : adjustedDays! < 2 ? "STORM" : adjustedDays! < 5 ? "WATCH" : "CLEAR";
    return { scope: scope.scope, id: scope.id, name: scope.name, district: scope.district, group, component, available, rate, forecast: prediction, weather };
  })));
}
