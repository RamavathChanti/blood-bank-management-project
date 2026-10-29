"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { DEFAULT_CAMP, planCamps } from "@/core/camp-planner";
import { donorEligibility } from "@/core/donor-eligibility";
import { DEFAULT_WASTE, makeWasteTape, WasteRun } from "@/core/waste-simulation";
export function CampPlanner() {
  const [capacity, setCapacity] = useState(8), [radiusKm, setRadius] = useState(25), [turnout, setTurnout] = useState(.65), [seed, setSeed] = useState("monsoon");
  const data = useMemo(() => { const tape = makeWasteTape({ ...DEFAULT_WASTE, seed }), run = new WasteRun("FEFO", tape); for (let day = 0; day < 7; day++) run.advanceDay(); return { tape, weather: run.weather(), now: run.now }; }, [seed]);
  const valid = Number.isInteger(capacity) && capacity >= 0 && capacity <= 20 && radiusKm >= 1 && radiusKm <= 100 && turnout >= 0 && turnout <= 1;
  const excluded = new Set(data.tape.donations.map(d => d.donorId)), plans = valid ? planCamps(data.tape.banks, data.tape.donors, data.weather, data.now, { capacity, radiusKm, turnout }, excluded) : [];
  const eligible = data.tape.donors.filter(d => !excluded.has(d.id) && donorEligibility(d, data.now).eligible);
  // Each district is a labelled local inset, avoiding misleading long-range spacing.
  return <>
    <div className="page-heading"><div><p className="eyebrow">SUPPLY / ELIGIBLE SYNTHETIC POPULATION</p><h1>Donation-camp planner</h1><p className="page-description">Rank bank sites by scarcity-weighted expected turnout.</p></div></div>
    <div className="simulation-banner"><strong>LOCAL PLANNING · NO DONOR CONTACT OR ATLAS WRITES</strong><p>Planning snapshot: seven simulated days after start. Candidate sites are the four synthetic banks. Missing forecast history contributes no weight. Baseline donation appointments are excluded.</p></div>
    <section className="panel lab-panel"><div className="lab-controls"><label>Planner seed<select value={seed} onChange={e => setSeed(e.target.value)}><option>monsoon</option><option>camp-replay</option></select></label><label>Weekly invitations<input type="number" min={0} max={20} value={Number.isNaN(capacity) ? "" : capacity} onChange={e => setCapacity(e.target.valueAsNumber)} /></label><label>Radius (km)<input type="number" min={1} max={100} value={Number.isNaN(radiusKm) ? "" : radiusKm} onChange={e => setRadius(e.target.valueAsNumber)} /></label><label>Base turnout probability<input type="number" min={0} max={1} step={.05} value={Number.isNaN(turnout) ? "" : turnout} onChange={e => setTurnout(e.target.valueAsNumber)} /></label></div>
    {!valid && <p role="alert">Use 0–20 invitations, a 1–100 km radius and 0–1 turnout.</p>}<p role="status">{plans.length} proposed sites · {plans.reduce((s, p) => s + p.invitations.length, 0)} invitations · {plans.reduce((s, p) => s + p.expectedTurnout, 0).toFixed(2)} expected arrivals · {eligible.length} eligible donors without baseline appointments</p>
    <div className="extras-grid camp-heatmap" aria-label="Synthetic eligible-donor heatmap">{data.tape.banks.map(bank => {
      const nearby = eligible.filter(d => Math.abs(d.location.latitude - bank.location.latitude) < .15 && Math.abs(d.location.longitude - bank.location.longitude) < .15);
      const cells = Array.from({ length: 25 }, (_, i) => nearby.filter(d => Math.max(0, Math.min(4, Math.floor((d.location.longitude - bank.location.longitude + .15) / .06))) === i % 5 && Math.max(0, Math.min(4, Math.floor((d.location.latitude - bank.location.latitude + .15) / .06))) === Math.floor(i / 5)).length);
      return <figure key={bank.id}><figcaption>{bank.district}</figcaption><svg viewBox="0 0 150 150" role="img" aria-label={`${bank.district}: ${nearby.length} eligible synthetic donors in local inset`}>{cells.map((count, i) => <rect key={i} x={i % 5 * 30} y={(4 - Math.floor(i / 5)) * 30} width={28} height={28} fill="#75ccbd" fillOpacity={.08 + Math.min(1, count / 4) * .85}><title>{count} eligible synthetic donors in cell</title></rect>)}<circle cx={75} cy={75} r={5} fill="#ed8dab" /></svg><p>{nearby.length} eligible · pink: candidate bank</p></figure>;
    })}</div><p className="source-note">Illustrative local insets, ±0.15° around each bank; brighter teal cells contain more eligible donors. North is up. Geographic proximity is straight-line distance; no travel route is inferred.</p>
    {plans.length ? plans.map((p, i) => <article key={p.bankId}><h2>{i + 1}. {data.tape.banks.find(b => b.id === p.bankId)!.name}</h2><p>Score {p.score.toFixed(2)} · {p.invitations.length} invitations · {p.expectedTurnout.toFixed(2)} expected arrivals</p><details><summary>Inspect weighted invitations</summary><pre className="extras-json">{JSON.stringify(p, null, 2)}</pre></details></article>) : <p>No site has both weighted scarcity and eligible donors inside this radius.</p>}
    <p>Expected arrivals = sum of distance-adjusted turnout probabilities. Score = sum of probability × three-day group deficit. Selection is greedy over bank sites; it is not an optimal geographic placement or an attendance guarantee.</p>
    <p><Link href="/waste-lab">Compare the forecast-camp policy over a month</Link>. The simulator uses this same ranking with a {DEFAULT_CAMP.radiusKm} km radius, {DEFAULT_CAMP.turnout} base turnout and the weekly invitation limit selected in Blood Weather. Interactive radius/turnout changes here are exploratory and do not change that run.</p></section>
  </>;
}
