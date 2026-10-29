"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { COMPONENTS, GROUPS, type Component, type Group } from "@/core/domain";
import { DEFAULT_WASTE, POLICY_LABELS, WASTE_POLICIES, wasteConfig, type WasteComparison, type WasteConfig, type WastePolicy } from "@/core/waste-simulation";
import { makeWasteTape } from "@/core/waste-simulation";
import { bloodWeather, type WeatherRow } from "@/core/forecast";
import type { PlannedTransfer } from "@/core/rebalancing";

const number = (value: number | null, digits = 1) => value === null ? "No sample" : value.toFixed(digits);
const initialTape = makeWasteTape(DEFAULT_WASTE);
const initialWeather = bloodWeather(initialTape.banks, initialTape.initialUnits, initialTape.history, initialTape.banks.map(b => ({ bankId: b.id, from: initialTape.historyFrom, until: DEFAULT_WASTE.startedAt })), DEFAULT_WASTE.startedAt);

export function WasteLab() {
  const [config, setConfig] = useState<WasteConfig>(DEFAULT_WASTE), [result, setResult] = useState<WasteComparison | null>(null);
  const [progress, setProgress] = useState<{ completed: number; policy: WastePolicy; day: number } | null>(null), [error, setError] = useState("");
  const [policy, setPolicy] = useState<WastePolicy>("REBALANCE"), [component, setComponent] = useState<Component>("PLATELETS"), [group, setGroup] = useState<Group>("B+");
  const [scope, setScope] = useState<"BANK" | "DISTRICT">("DISTRICT");
  const worker = useRef<Worker | null>(null);
  useEffect(() => () => worker.current?.terminate(), []);
  const update = (change: Partial<WasteConfig>) => setConfig(current => ({ ...current, ...change }));
  function cancel() { worker.current?.terminate(); worker.current = null; setProgress(null); }
  function run() {
    try {
      const parsed = wasteConfig(config); cancel(); setError(""); setResult(null); setProgress({ completed: 0, policy: "NEAREST", day: 0 });
      const instance = new Worker(new URL("../workers/waste.worker.ts", import.meta.url), { type: "module" }); worker.current = instance;
      instance.onerror = () => { if (worker.current === instance) { cancel(); setError("The comparison worker stopped. Retry the run."); } };
      instance.onmessage = event => {
        if (worker.current !== instance) return;
        if (event.data.type === "progress") setProgress(event.data);
        else if (event.data.type === "error") { setError(event.data.message); cancel(); }
        else if (event.data.type === "complete") { setResult(event.data.result); cancel(); }
      };
      instance.postMessage(parsed);
    } catch (error) { cancel(); setError(error instanceof Error ? error.message : "Invalid inputs"); }
  }
  function downloadResults() {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `pulsegrid-waste-${result.tapeSignature}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const banks = useMemo(() => result ? makeWasteTape(result.config).banks : initialTape.banks, [result]);
  const selected = result?.results.find(row => row.policy === policy), rows = (selected?.weather ?? initialWeather).filter(row => row.component === component && row.group === group && row.scope === scope);
  const changed = result && JSON.stringify(result.config) !== JSON.stringify(wasteConfigSafe(config));
  return <div className="waste-lab">
    <div className="page-heading"><div><p className="eyebrow">WASTE REDUCTION · STAGE 10</p><h1>Blood Weather</h1><p>Forecast demand. Move surplus. Measure the trade-offs.</p></div></div>
    <div className="simulation-banner"><span className="simulation-beacon" /><div><strong>MONTHLY SIMULATION · NO LIVE DATA</strong><p>Four synthetic banks. Identical baseline events across four policies. No Atlas writes or real camps.</p></div></div>
    <section className="panel lab-panel" aria-label="Forecast experiment inputs"><h2>Set the assumptions</h2><p className="source-note">Fixed truth: 70% of initial stock and most collections start at low-demand bank 4; a future 2× platelet shock is independent of your forecast. Weekly weights below apply to the baseline model; Holt–Winters learns its own weekly pattern. New inputs take effect on Run.</p>
      <form onSubmit={event => { event.preventDefault(); run(); }}><fieldset disabled={Boolean(progress)} className="waste-inputs">
        <label>Seed<input required maxLength={80} value={config.seed} onChange={event => update({ seed: event.target.value })} /></label>
        <label>Platelet forecast multiplier<input type="number" min={1} max={5} step={.1} value={config.forecast.plateletMultiplier} onChange={event => update({ forecast: { ...config.forecast, plateletMultiplier: event.target.valueAsNumber } })} /></label>
        <label className="waste-checkbox"><input type="checkbox" checked={config.forecast.dengue} onChange={event => update({ forecast: { ...config.forecast, dengue: event.target.checked } })} /> Assume dengue season</label>
        <label>Weekly camp invitations<input type="number" min={0} max={20} value={config.campCapacity} onChange={event => update({ campCapacity: event.target.valueAsNumber })} /></label>
        <label>Arrival buffer (hours)<input type="number" min={1} max={48} value={config.rebalance.bufferHours} onChange={event => update({ rebalance: { ...config.rebalance, bufferHours: event.target.valueAsNumber } })} /></label>
        <label>Daily capacity per bank<input type="number" min={0} max={50} value={config.rebalance.inboundCapacity} onChange={event => update({ rebalance: { ...config.rebalance, inboundCapacity: event.target.valueAsNumber, outboundCapacity: event.target.valueAsNumber } })} /></label>
        {(["alpha", "beta", "gamma"] as const).map(key => <label key={key}>Holt–Winters {key}<input type="number" min={0} max={1} step={.05} value={config.forecast[key]} onChange={event => update({ forecast: { ...config.forecast, [key]: event.target.valueAsNumber } })} /></label>)}
        {config.forecast.weekly.map((value, i) => <label key={i}>{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][i]} demand weight<input type="number" min={0} max={7} step={.05} value={value} onChange={event => update({ forecast: { ...config.forecast, weekly: config.forecast.weekly.map((w, j) => j === i ? event.target.valueAsNumber : w) } })} /></label>)}
      </fieldset><div className="lab-actions"><button className="button button-primary" type="submit" disabled={Boolean(progress)}>Run matched month</button>{progress && <button className="button button-secondary" type="button" onClick={cancel}>Cancel run</button>}{result && <button className="button button-secondary" type="button" onClick={downloadResults}>Download results JSON</button>}</div></form>
      <p role="status" aria-live="polite">{progress ? `${POLICY_LABELS[progress.policy]} · day ${progress.day}/30 · ${progress.completed}/120 policy-days` : result ? `Month complete · shared event schedule ${result.tapeSignature}` : "Ready · run a reproducible 30-day comparison."}</p>{progress && <progress aria-label="Comparison progress" max={120} value={progress.completed} />}{error && <p role="alert">{error}</p>}{changed && <p className="source-note">Inputs changed. Results below retain the completed run’s assumptions; run again to apply changes.</p>}
    </section>
    {result && <section className="panel lab-panel" aria-label="Policy comparison"><h2>One month, four policies</h2><p className="source-note">Fulfilment counts fully issued requests; time-to-match excludes unresolved requests. Wastage = expired component units ÷ (initial + newly collected component units). Transfers cost distance even when no unit is saved.</p><div className="table-scroll" role="region" aria-label="Monthly results table" tabIndex={0}><table className="registry-table"><caption>Measured synthetic results · {result.config.seed} · 30 days</caption><thead><tr>{["Policy", "Wastage", "Fulfilment", "Median / p95 min", "O− non-O− / avoidable", "Transfer unit-km", "Units saved / extra expiries", "Camps / collected"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{result.results.map(row => <tr key={row.policy} data-testid={`policy-${row.policy}`}><th scope="row">{POLICY_LABELS[row.policy]}</th><td>{number(row.metrics.wastagePercent)}% ({row.metrics.expired}/{row.metrics.collected})</td><td>{number(row.metrics.fulfilmentPercent)}% ({row.metrics.fulfilled}/{row.metrics.requests})</td><td>{number(row.metrics.medianMatchMinutes)} / {number(row.metrics.p95MatchMinutes)}</td><td>{row.metrics.oNegativeNonONegative} / {row.metrics.oNegativeAvoidable}</td><td>{number(row.metrics.transferUnitKm)}</td><td>{row.unitsSaved} / {row.additionalExpiries}</td><td>{row.metrics.campDonations} / {row.metrics.collected}</td></tr>)}</tbody></table></div><p className="source-note">Units saved: the same unit expires under FEFO but is issued under this policy. Extra expiries: units issued under FEFO that expire here. Remaining stock is not counted as saved. Camp products are extra supply and change the wastage denominator. O− “avoidable” means an eligible exact-group unit was also available at that decision.</p><div className="waste-bars" aria-label="Cumulative expiry by day">{result.results.map(row => <div key={row.policy}><strong>{POLICY_LABELS[row.policy]}</strong><svg viewBox="0 0 300 70" role="img" aria-label={`${POLICY_LABELS[row.policy]}: ${row.metrics.expired} expiries over 30 days`}><polyline fill="none" stroke="currentColor" strokeWidth="2" points={row.daily.map(d => `${d.day * 10},${65 - d.expired / Math.max(1, ...result.results.map(r => r.metrics.expired)) * 60}`).join(" ")} /></svg><span>{row.metrics.expired} expired · {row.netExpiryReduction >= 0 ? "+" : ""}{row.netExpiryReduction} net reduction vs FEFO</span></div>)}</div></section>}
    <section className="panel lab-panel" aria-label="Blood Weather forecast"><div className="lab-section-heading"><div><p className="eyebrow">BLOOD WEATHER</p><h2>{result ? "End-of-month supply outlook" : "Starting supply outlook"}</h2></div></div><div className="lab-controls">
      <label>Policy<select value={policy} onChange={event => setPolicy(event.target.value as WastePolicy)}>{WASTE_POLICIES.map(item => <option key={item} value={item}>{POLICY_LABELS[item]}</option>)}</select></label>
      <label>Component<select aria-label="Component" value={component} onChange={event => setComponent(event.target.value as Component)}>{COMPONENTS.map(item => <option key={item}>{item}</option>)}</select></label>
      <label>Group<select aria-label="Group" value={group} onChange={event => setGroup(event.target.value as Group)}>{GROUPS.map(item => <option key={item}>{item}</option>)}</select></label>
      <label>Aggregate by<select value={scope} onChange={event => setScope(event.target.value as typeof scope)}><option value="DISTRICT">District</option><option value="BANK">Bank</option></select></label>
    </div><div className="weather-grid">{rows.map(row => <WeatherCard key={row.id} row={row} />)}</div><p className="source-note">Days of supply = ready stock ÷ trailing 14-day average issues. Weather uses the adjusted seven-day forecast: storm &lt;2 days, watch &lt;5, clear ≥5. Missing history is unknown; observed zero demand has no finite supply estimate. Issue history can understate shortages. Forecast ranges are heuristic uncertainty bands.</p>
      <TransferMap banks={banks} transfers={selected?.transfers ?? []} startedAt={result?.config.startedAt ?? DEFAULT_WASTE.startedAt} />
    </section>
    {result && <section className="panel lab-panel" aria-label="Forecast and donor comparison"><h2>Check the models</h2>{result.backtest.state === "MEASURED" ? <p data-testid="forecast-backtest">Held-out synthetic B+ platelet demand · {result.backtest.trainDays} training days / {result.backtest.holdoutDays} unseen days. Baseline MAE {number(result.backtest.baseline.mae, 3)}, RMSE {number(result.backtest.baseline.rmse, 3)}. Holt–Winters MAE {number(result.backtest.holtWinters.mae, 3)}, RMSE {number(result.backtest.holtWinters.rmse, 3)}. No dengue adjustment on this pre-shock holdout.</p> : <p>Insufficient history for a held-out comparison.</p>}<p>Donor experiment · {result.alerts.trials} matched trials · {result.alerts.population} donors · {result.alerts.required} acceptances needed: waves sent {result.alerts.waves.alerts.toLocaleString()} alerts, succeeded {result.alerts.waves.successful} times, and added {number(result.alerts.waves.meanEscalationWaitMinutes, 2)} mean escalation minutes. Alert-everyone sent {result.alerts.everyone.alerts.toLocaleString()} alerts and succeeded {result.alerts.everyone.successful} times.</p><p className="source-note">{result.alerts.assumptions}</p></section>}
    <details className="metric-definitions"><summary>Experiment rules and limits</summary><p>The fixed monthly tape is independent of forecast parameters. The four-bank development fixture is intentionally imbalanced, with 70 days of complete synthetic prehistory. Matching is within 30 km by default, with a six-hour expected-use deadline; units must outlive that deadline. Nearest chooses by distance then ID. Other policies conserve exact groups and use FEFO within each bank. Rebalancing maximizes feasible flow before minimizing travel minutes plus a near-expiry penalty, with three-day deficits, seven-day surplus eligibility, per-bank daily capacities, 180 km routes and a configurable expiry buffer. All distances are straight-line assumptions. Planned stock stays at source; transit belongs to neither available pool; receipt changes bank ownership. Camps run weekly with eligible, local, once-only synthetic donors and six-hour mock screening; baseline donations have priority. No acceptance counts as available blood. The hourly simulation can delay observations by up to an hour; last-day unresolved requests and surviving stock are censored at day 30. No handover, clinical outcome or cloud quota is inferred.</p></details>
  </div>;
}
function wasteConfigSafe(config: WasteConfig) { try { return wasteConfig(config); } catch { return null; } }
function WeatherCard({ row }: { row: WeatherRow }) {
  return <article className={`weather-card weather-${row.weather.toLowerCase()}`}><p className="eyebrow">{row.weather.replaceAll("_", " ")}</p><h3>{row.name}</h3><strong>{row.available} units · {row.rate.state === "ZERO_DEMAND" ? "No observed demand" : row.rate.daysOfSupply === null ? "Unknown supply" : `${number(row.rate.daysOfSupply)} days of supply`}</strong><p>{row.group} {row.component} · {number(row.rate.dailyRate, 2)} issued / day · {row.rate.observedDays}/14 observed days</p><p>{row.forecast.method.replaceAll("_", " ")}</p><ol>{row.forecast.daily.map(day => <li key={day.at}><time>{new Date(day.at).toISOString().slice(5, 10)}</time><span>{number(day.expected)} units <small>({number(day.low)}–{number(day.high)})</small></span></li>)}</ol></article>;
}
function TransferMap({ banks, transfers, startedAt }: { banks: ReturnType<typeof makeWasteTape>["banks"]; transfers: PlannedTransfer[]; startedAt: string }) {
  const [day, setDay] = useState(30);
  const at = Date.parse(startedAt) + day * 86400000;
  const visible = transfers.filter(t => Date.parse(t.plannedAt) <= at && Date.parse(t.plannedAt) >= at - 86400000).slice(-50);
  const point = (id: string) => { const b = banks.find(bank => bank.id === id)!; return { x: 50 + (b.location.longitude - 72.75) * 500, y: 40 + (19.4 - b.location.latitude) * 220 }; };
  return <div className="waste-transfer-map"><h3>Transfer arcs</h3><label>Inspect transfer day: {day}<input type="range" min={0} max={30} value={day} onChange={event => setDay(event.target.valueAsNumber)} /></label><svg viewBox="0 0 650 300" role="img" aria-label={`Synthetic bank transfer arcs on day ${day}`}>
    {visible.map(t => { const from = point(t.fromBankId), to = point(t.toBankId), status = at < Date.parse(t.arrivesAt) ? "IN_TRANSIT" : t.status; return <path key={t.id} data-testid="waste-transfer-arc" d={`M${from.x} ${from.y} Q${(from.x + to.x) / 2} ${Math.min(from.y, to.y) - 40} ${to.x} ${to.y}`} fill="none" stroke={status === "IN_TRANSIT" ? "#ed8dab" : "#75ccbd"} strokeWidth="2"><title>{t.fromBankId} → {t.toBankId} · {t.unitId} · {status} · {number(t.distanceKm)} km</title></path>; })}
    {banks.map(bank => { const p = point(bank.id); return <g key={bank.id}><circle cx={p.x} cy={p.y} r="7" fill="#ed8dab" /><text x={p.x - 10} y={p.y + 22} fill="#e7cdd9" fontSize="12">{bank.district}</text></g>; })}
  </svg><p className="source-note">{visible.length} recent transfers shown (maximum 50). Pink in transit / cyan received at inspected time; illustrative coordinates. Full transfer records are in the results download.</p></div>;
}
