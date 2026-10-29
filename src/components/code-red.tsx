"use client";

import { useState, type FormEvent } from "react";
import { COMPONENTS, GROUPS } from "@/core/domain";
import { commandEmergency, emergencyFixture, startEmergency, type Emergency, type EmergencyCommand, type EmergencyPreset } from "@/core/emergency";
import { DEFAULT_WAVES, distanceKm, matchEmergencyStock, rankDonors, travelMinutes } from "@/core/emergency-matching";
import { FIXTURE_NOW } from "@/core/fixtures";
import { StatusBadge } from "./ui/status-badge";

const presets: { id: EmergencyPreset; label: string }[] = [{ id: "stock-available", label: "Stock available · one O− unit" }, { id: "stock-shortage", label: "Stock shortage · two O− units" }, { id: "screened-recovery", label: "Screened recovery · 12-hour window" }];
const time = (value: string) => `${value.slice(11, 16)} UTC`;
export function CodeRed() {
  const [preset, setPreset] = useState<EmergencyPreset>("stock-available");
  const [form, setForm] = useState(() => emergencyFixture("stock-available").request);
  const [wait, setWait] = useState(3), [probability, setProbability] = useState(.23);
  const [state, setState] = useState<Emergency | null>(null), [error, setError] = useState("");
  const fixture = emergencyFixture(preset), registry = state?.registry ?? fixture.registry;
  const running = !!state && ["OPEN", "PARTIAL", "ALLOCATED"].includes(state.request.status);
  function reset(value: EmergencyPreset) { setPreset(value); setForm(emergencyFixture(value).request); setState(null); setError(""); }
  function submit(event: FormEvent) {
    event.preventDefault();
    try { setState(startEmergency(preset, form, { ...DEFAULT_WAVES, waitMinutes: wait, acceptanceRate: probability })); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start simulation"); }
  }
  function act(command: EmergencyCommand) {
    if (!state) return;
    try { setState(commandEmergency(state, command)); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Simulation command failed"); }
  }
  const bank = state ? registry.banks.find(b => b.id === state.collectionBankId)! : registry.banks[0];
  const hospital = state ? registry.hospitals.find(h => h.id === state.request.hospitalId)! : registry.hospitals[0];
  const owned = state ? registry.units.filter(u => u.reservation?.requestId === state.request.id) : [];
  const remaining = state ? Math.max(0, Math.ceil((Date.parse(state.request.expectedTransfusionAt) - Date.parse(state.now)) / 60_000)) : 0;
  const stock = state && running ? matchEmergencyStock(registry.units, state.request, registry.banks, hospital, state.now) : null;
  const ranked = state ? rankDonors(state.profiles, state.request, bank, state.now, state.config, state.alerts.map(a => a.donorId)) : [];
  const pending = state?.alerts.filter(a => a.status === "PENDING") ?? [];
  const radarProfiles = state?.profiles ?? fixture.profiles;
  const steps = state ? [
    ["Request", "Validated locally", true],
    ["Stock search", `${state.request.allocatedQuantity}/${state.request.quantity} allocated`, state.request.allocatedQuantity === state.request.quantity],
    ["Donor waves", state.waves.length ? `${state.waves.length}/3 waves opened` : "No shortage", state.waves.length > 0 || state.request.allocatedQuantity === state.request.quantity],
    ["Dispatch", `${Object.keys(state.dispatched).length} issued`, Object.keys(state.dispatched).length > 0],
    ["Handover", `${owned.filter(u => !!u.handoverAt).length} received`, owned.some(u => !!u.handoverAt)],
    ["Synthetic use", `${state.request.transfusedQuantity}/${state.request.quantity} confirmed`, state.request.status === "COMPLETED"]
  ] as const : [];
  return <>
    <div className="page-heading"><div><p className="eyebrow">OPERATIONS / EMERGENCY SIMULATOR</p><h1>Code Red</h1><p className="page-description">Follow compatible stock and mock donor opportunities through an explainable emergency journey.</p></div><StatusBadge tone={state?.request.status === "ESCALATED" ? "critical" : "neutral"}>{state?.request.status ?? "Local simulation · Stage 04"}</StatusBadge></div>
    <div className="simulation-banner"><span className="simulation-beacon" /><div><strong>SIMULATION · SYNTHETIC RECORDS ONLY</strong><p>Seed monsoon · starts 28 Oct 2026, 09:00 IST · advances only with controls · reset or reload clears this journey. Separate from the Control Room and Inventory.</p></div><span className="small-label">NO LIVE DATA</span></div>
    <section className="panel lab-panel" aria-labelledby="request-heading"><div className="lab-section-heading"><div><p className="eyebrow">01 / REQUEST INTAKE</p><h2 id="request-heading">Create a simulated request</h2></div><button className="button button-secondary" onClick={() => reset(preset)}>Reset journey</button></div>
      <div className="lab-controls"><label>Demo scenario<select value={preset} onChange={e => reset(e.target.value as EmergencyPreset)}>{presets.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label></div>
      <form onSubmit={submit} noValidate><fieldset disabled={!!state} className="request-fields"><div className="lab-controls">
        <label>Hospital<select value={form.hospitalId} onChange={e => setForm({ ...form, hospitalId: e.target.value })}>{registry.hospitals.map(h => <option key={h.id} value={h.id}>{h.name} · {h.district}</option>)}</select></label>
        <label>Recipient group<select value={form.group} onChange={e => setForm({ ...form, group: e.target.value })}>{GROUPS.map(g => <option key={g}>{g}</option>)}</select></label>
        <label>Component<select value={form.component} onChange={e => setForm({ ...form, component: e.target.value })}>{COMPONENTS.map(c => <option key={c}>{c}</option>)}</select></label>
        <label>Quantity (component units)<input type="number" min={1} max={20} value={Number.isNaN(form.quantity) ? "" : form.quantity} onChange={e => setForm({ ...form, quantity: e.target.valueAsNumber })} /></label>
        <label>Urgency<select value={form.urgency} onChange={e => setForm({ ...form, urgency: e.target.value })}>{["ROUTINE", "URGENT", "CRITICAL"].map(u => <option key={u}>{u}</option>)}</select></label>
        <label>Expected transfusion deadline (UTC)<input type="datetime-local" value={form.expectedTransfusionAt.slice(0, 16)} onChange={e => setForm({ ...form, expectedTransfusionAt: e.target.value ? `${e.target.value}:00.000Z` : "" })} /></label>
        <label>Wait per wave (simulated min)<input type="number" min={1} max={60} value={Number.isNaN(wait) ? "" : wait} onChange={e => setWait(e.target.valueAsNumber)} /></label>
        <label>Assumed acceptance probability<input type="number" min={0} max={1} step={.01} value={Number.isNaN(probability) ? "" : probability} onChange={e => setProbability(e.target.valueAsNumber)} /></label>
      </div><button className="button button-primary" type="submit">Start simulated Code Red</button></fieldset></form>
      <p className="source-note">Deadline must be within 24 simulated hours. Critical alerts may bypass quiet hours (22:00–07:00 IST); eligibility, four-alert monthly cap and 24-hour cooldown still apply.</p>
      {error && <p className="error-text" role="alert">{error}</p>}
    </section>
    {state && <>
      <section className="panel lab-panel" aria-labelledby="journey-heading"><div className="lab-section-heading"><div><p className="eyebrow">02 / INJECTED CLOCK</p><h2 id="journey-heading">Journey progress</h2></div><span className="code-countdown mono" role="timer" aria-label="Simulated deadline countdown">{remaining} min remaining</span></div>
        <p className="mono text-small">{state.now} · {remaining ? "Simulated time" : "Deadline reached"}</p>
        <div className="stock-metrics" aria-label="Emergency measurements"><span><strong>{state.request.allocatedQuantity}/{state.request.quantity}</strong> allocated</span><span><strong>{state.request.transfusedQuantity}/{state.request.quantity}</strong> synthetic use</span><span><strong>{state.matchedAt ? (Date.parse(state.matchedAt) - Date.parse(state.startedAt)) / 60_000 : "Unresolved"}</strong> first full stock match (sim min)</span><span><strong>{state.firstAcceptanceAt ? (Date.parse(state.firstAcceptanceAt) - Date.parse(state.startedAt)) / 60_000 : "None"}</strong> first accept (sim min)</span></div>
        <ol className="code-steps">{steps.map(([label, detail, done]) => <li key={label} className={done ? "step-done" : ""}><strong>{label}</strong><span>{detail}</span></li>)}</ol>
        <div className="lab-actions">{[1, 3, 15, 60, 360].map(minutes => <button key={minutes} className="button button-secondary" disabled={!running} onClick={() => act({ type: "ADVANCE", minutes })}>Advance {minutes} min</button>)}</div>
        <div className="lab-actions"><button className="button button-secondary" disabled={!running} onClick={() => act({ type: "MATCH" })}>Search stock again</button><button className="button button-primary" disabled={!running || !owned.some(u => u.status === "RESERVED")} onClick={() => act({ type: "DISPATCH", preparationConfirmed: true })}>{state.request.component === "FFP" ? "Confirm mock FFP preparation & dispatch" : "Dispatch reserved stock"}</button><button className="button button-secondary" disabled={!running || !owned.some(u => u.status === "ISSUED" && !u.handoverAt)} onClick={() => act({ type: "HANDOVER" })}>Confirm handover</button><button className="button button-secondary" disabled={!running || !owned.some(u => u.status === "ISSUED" && u.handoverAt)} onClick={() => act({ type: "CONFIRM_USE" })}>Confirm synthetic use</button><button className="button button-secondary" disabled={!running || owned.some(u => ["ISSUED", "TRANSFUSED"].includes(u.status))} onClick={() => act({ type: "CANCEL" })}>Cancel request</button></div>
        <p className="source-note">Reservations last at most ten simulated minutes. Dispatch before lease expiry, or search again after release. Handover requires estimated arrival. A donor reply, allocation or dispatch alone cannot complete demand.</p>
        {state.escalation && <p className="notice" role="status">{state.escalation} Confirmed synthetic use: {state.request.transfusedQuantity}/{state.request.quantity}. No automatic completion.</p>}
        {state.request.status === "COMPLETED" && <p className="notice" role="status">Completed locally: all {state.request.quantity} unit(s) have handover and synthetic use confirmation.</p>}
        {state.request.status === "CANCELLED" && <p className="notice" role="status">Cancelled locally; reservations released. Reset to replay.</p>}
      </section>
      <div className="code-grid"><section className="panel lab-panel" aria-labelledby="radar-heading"><p className="eyebrow">03 / STOCK & DONOR RADAR</p><h2 id="radar-heading">Search around the collection bank</h2>
        <svg viewBox="0 0 320 280" className="code-radar" role="img" aria-label="Donor radar with 5, 10 and 25 kilometre rings"><g transform="translate(160 140)">{[25, 10, 5].map(km => <g key={km}><circle r={km * 4.5} fill="none" stroke="#785366" strokeDasharray="3 4" /><text x="4" y={-km * 4.5 + 12} fill="#cdb1bf" fontSize="9">{km} km</text></g>)}<path d="M-120 0H120M0-120V120" stroke="#503442" /><circle r="5" fill="#9edccd" />{radarProfiles.map((p, i) => { const d = distanceKm(p.donor.location, bank.location), angle = i * 2.399; const a = state.alerts.find(a => a.donorId === p.donor.id); return <circle key={p.donor.id} cx={Math.cos(angle) * d * 4.5} cy={Math.sin(angle) * d * 4.5} r="3" fill={a?.status === "ACCEPTED" || a?.status === "SCREENED" ? "#9edccd" : a ? "#eea3bb" : "#775966"}><title>{p.donor.nickname}: {d.toFixed(1)} km · {a?.status ?? "not alerted"}</title></circle>; })}</g></svg>
        <p className="source-note">{bank.name} → {hospital.name}: {distanceKm(bank.location, hospital.location).toFixed(1)} km, ~{travelMinutes(distanceKm(bank.location, hospital.location))} min. Straight-line-derived estimate at 30 km/h + 5 min handling; no routed ETA. Radar dots use illustrative angles.</p>
        <p className="source-note">{ranked.filter(p => !p.reasons.length && p.distance <= 25).length} unalerted eligible donors within 25 km. {pending.length} awaiting replies. Rank: inverse ETA, reliability, capped days since eligibility, then alert-fatigue penalty.</p>
        <details className="metric-definitions"><summary>Donor ranking and exclusion details</summary><div className="table-scroll" tabIndex={0}><table className="data-table"><thead><tr><th>Donor</th><th>Distance / ETA</th><th>Reliability / days eligible / alerts</th><th>Score / exclusions</th></tr></thead><tbody>{ranked.map(p => <tr key={p.donor.id}><th>{p.donor.nickname}</th><td>{p.distance.toFixed(1)} km / {p.eta} min</td><td>{p.reliability.toFixed(2)} / {p.days.toFixed(0)} / {p.alertsThisMonth}</td><td>{p.score.toFixed(3)} · {p.reasons.join("; ") || "Eligible"}</td></tr>)}</tbody></table></div></details>
      </section><section className="panel lab-panel" aria-labelledby="wave-heading"><p className="eyebrow">04 / BOUNDED ALERTS</p><h2 id="wave-heading">Donor waves</h2><p className="source-note">Smallest n with P(Binomial(n, p) ≥ required donors) ≥ 95%, bounded by the eligible population. Independent replies and a common p are teaching assumptions, not guarantees. Donor count models one requested component per collection.</p>
        {!state.waves.length && <p className="lab-result">Screened stock covers this request. No donor alerts needed.</p>}
        {state.waves.map((w, i) => <div className="wave-card" key={w.radius}><strong>Wave {i + 1} · {w.radius} km</strong><p>{w.count} alerts / {w.population} candidates · needs {w.required} donor(s)</p><p>p = {state.config.acceptanceRate} · assumed chance {(w.probability * 100).toFixed(1)}% · {w.targetMet ? "95% target met" : "95% target NOT met — insufficient population"}</p><p>{time(w.openedAt)} → {time(w.closesAt)} · {state.config.waitMinutes} simulated min wait</p></div>)}
        <button className="button button-secondary" disabled={!running || !pending.length} onClick={() => act({ type: "SEEDED_RESPONSES" })}>Sample seeded replies</button>
        <p className="notice">Acceptance is a collection opportunity. Allow donor travel plus six hours for mock screening and component transport. A short emergency deadline can expire before new stock is ready.</p>
      </section></div>
      {state.alerts.length > 0 && <section className="panel lab-panel" aria-labelledby="response-heading"><h2 id="response-heading">Mock donor responses & screening</h2><div className="donor-responses" tabIndex={0} role="region" aria-label="Donor response cards, scroll for more">{state.alerts.map(a => <article key={a.donorId} className="wave-card" aria-label={a.donorId}><div className="donor-title"><strong>{state.profiles.find(p => p.donor.id === a.donorId)?.donor.nickname}</strong><StatusBadge>{a.status}</StatusBadge></div><p>Wave {a.wave} · collection arrival {time(a.arrivalAt)}{a.readyAt ? ` · screening ready ${time(a.readyAt)}` : ""}</p>
        {a.status === "PENDING" && <div className="lab-actions"><button disabled={!running} className="button button-secondary" onClick={() => act({ type: "RESPOND", donorId: a.donorId, accepted: true })}>Accept</button><button disabled={!running} className="button button-secondary" onClick={() => act({ type: "RESPOND", donorId: a.donorId, accepted: false })}>Decline</button></div>}
        {a.status === "ACCEPTED" && <button disabled={!running || state.now < a.arrivalAt} className="button button-secondary" onClick={() => act({ type: "COLLECT", donorId: a.donorId })}>Collect synthetic donation</button>}
        {a.status === "COLLECTED" && <div className="lab-actions"><button disabled={!running || state.now < a.readyAt!} className="button button-secondary" onClick={() => act({ type: "SCREEN", donorId: a.donorId, result: "NON_REACTIVE" })}>Pass all mock screens</button><button disabled={!running || state.now < a.readyAt!} className="button button-secondary" onClick={() => act({ type: "SCREEN", donorId: a.donorId, result: "REACTIVE" })}>Mock reactive result</button></div>}
      </article>)}</div></section>}
      <section className="panel lab-panel" aria-labelledby="stock-heading"><h2 id="stock-heading">Stock decisions & allocations</h2><p className="source-note">Exact/compatible group preference → nearby bank / estimated travel → FEFO within the bank. Every reservation and issue rechecks screening, expiry, component and deadline.</p><div className="table-scroll code-stock-scroll" tabIndex={0} role="region" aria-label="Emergency stock results"><table className="data-table"><thead><tr><th>Unit / group</th><th>Bank / estimate</th><th>State / expiry UTC</th><th>Decision</th></tr></thead><tbody>{registry.units.filter(u => owned.some(o => o.id === u.id) || (u.component === state.request.component && (u.group === state.request.group || stock?.candidates.some(a => a.unit.id === u.id))) || u.id.startsWith("red-unit")).map(u => { const assessment = stock?.assessments.find(a => a.unit.id === u.id), b = registry.banks.find(b => b.id === u.bankId)!; return <tr key={u.id}><th>{u.id}<span className="table-detail">{u.group} · {u.component}</span></th><td>{b.name}<span className="table-detail">{travelMinutes(distanceKm(b.location, hospital.location))} min estimated</span></td><td>{u.status}<span className="table-detail">{u.expiresAt}</span></td><td>{owned.some(o => o.id === u.id) ? `Owned by request${u.handoverAt ? " · handover recorded" : ""}` : assessment?.reasons.join("; ") || (running ? "Eligible alternative" : "Journey closed")}{u.reservation && <span className="table-detail">Lease until {time(u.reservation.leaseExpiresAt)}</span>}{state.dispatched[u.id] && <span className="table-detail">Courier arrival {time(state.dispatched[u.id])}</span>}</td></tr>; })}</tbody></table></div></section>
      <section className="panel lab-panel" aria-labelledby="trace-heading"><h2 id="trace-heading">Journey trace</h2><ol className="event-list">{state.log.map((entry, i) => <li key={i}><time className="mono">{time(entry.at)}</time> · {entry.message}</li>)}</ol><details className="metric-definitions"><summary>Unit lifecycle events ({state.events.length})</summary><ol className="event-list">{state.events.map(e => <li key={e.id} className="mono text-small">{time(e.at)} · {e.unitId} · {e.action} · {e.from} → {e.to}</li>)}</ol></details></section>
    </>}
    {!state && <p className="notice">Choose a scenario and start. Stock available completes through dispatch and handover. Stock shortage demonstrates partial fulfilment and unresolved waves. Screened recovery gives a 12-hour window to collect, test and use new synthetic stock.</p>}
    <p className="source-note">Teaching model, not clinical software. Local, single-thread simulation; no real donors, notifications, road routing, Atlas writes or durable cloud workflow. Current fixture clock: {FIXTURE_NOW}.</p>
  </>;
}
