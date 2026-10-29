"use client";
import dynamic from "next/dynamic";
import { useState } from "react";
import { COMPONENTS, type Component, type LifecycleEvent } from "@/core/domain";
import { FIXTURE_NOW, inventoryFixtures } from "@/core/fixtures";
import { affectedBySample, expiryCue, STORAGE, temperatureSample } from "@/core/cold-chain";
import { transitionUnit } from "@/core/lifecycle";
const Scene = dynamic(() => import("./cold-room-scene"), { ssr: false, loading: () => <p>Loading the storage view…</p> });
export function ColdRoom() {
  const [units, setUnits] = useState(inventoryFixtures), [selected, setSelected] = useState("DEMO-003"), [tick, setTick] = useState(0), [fault, setFault] = useState<Component | "NONE">("NONE"), [events, setEvents] = useState<LifecycleEvent[]>([]), [show3d, setShow3d] = useState(false);
  const now = new Date(Date.parse(FIXTURE_NOW) + tick * 60000).toISOString(), current = units.find(u => u.id === selected)!;
  const samples = COMPONENTS.map(c => temperatureSample("monsoon", c, now, fault === c));
  function advance() {
    const nextTick = tick + 1, at = new Date(Date.parse(FIXTURE_NOW) + nextTick * 60000).toISOString(), changes: LifecycleEvent[] = [];
    const next = units.map(unit => { const sample = temperatureSample("monsoon", unit.component, at, fault === unit.component); if (!affectedBySample(unit, sample)) return unit; const change = transitionUnit(unit, { type: "QUARANTINE", note: `Synthetic ${sample.celsius} C storage excursion; manual review required.` }, { now: at, actorId: "local-watchdog", eventId: `cold-${nextTick}-${unit.id}` }); changes.push(change.event); return change.unit; });
    setUnits(next); setEvents([...events, ...changes]); setTick(nextTick);
  }
  return <>
    <div className="page-heading"><div><p className="eyebrow">STORAGE / SYNTHETIC TELEMETRY</p><h1>Cold Room</h1><p className="page-description">Three component environments, one traceable quarantine path.</p></div></div>
    <div className="simulation-banner"><strong>LOCAL FIXTURE · NO SENSOR OR ATLAS CONNECTION</strong><p>Feed clock {now}. Breach is evaluated only when advancing the feed. No automatic release after recovery.</p></div>
    <section className="extras-grid" aria-label="Storage environments">{samples.map(sample => <article className="panel lab-panel" key={sample.component}><h2>{sample.component}</h2><p>{STORAGE[sample.component].label}</p><strong className="temperature-reading">{sample.celsius} °C</strong><p>{sample.component === "PLATELETS" ? sample.agitation ? "Agitation ON" : "Agitation OFF" : "Storage temperature"} · synthetic</p></article>)}</section>
    <section className="panel lab-panel"><div className="lab-controls"><label>Synthetic fault<select value={fault} onChange={e => setFault(e.target.value as Component | "NONE")}><option value="NONE">No fault</option>{COMPONENTS.map(c => <option key={c}>{c}</option>)}</select></label><button className="button button-primary" onClick={advance} disabled={tick >= 120}>Advance feed 1 minute</button><button className="button button-secondary" onClick={() => { setUnits(inventoryFixtures()); setEvents([]); setTick(0); setFault("NONE"); }}>Reset local fixture</button><button className="button button-secondary" aria-pressed={show3d} onClick={() => setShow3d(!show3d)}>{show3d ? "Hide 3D view" : "Enable 3D view"}</button></div>
    {show3d && <div className="cold-scene"><Scene units={units} selected={selected} onSelect={setSelected} /></div>}
    <p>Chambers left to right: red-cell refrigerator, platelet agitator, plasma freezer. Red / gold / teal identify components; amber means quarantined. Expiry and availability are stated below. 3D shows at most 18 packs per chamber.</p>
    <label>Inspect synthetic unit<select value={selected} onChange={e => setSelected(e.target.value)}>{units.map(u => <option key={u.id} value={u.id}>{u.id} · {u.component} · {u.status}</option>)}</select></label><p role="status">{current.id} · {current.group} · {current.status} · {expiryCue(current, now)} · storage {current.storage}</p>
    <div className="table-scroll"><table className="registry-table"><caption>Same fixture inventory used by the storage view</caption><thead><tr><th>Unit</th><th>Component</th><th>Status</th><th>Expiry</th></tr></thead><tbody>{units.map(u => <tr key={u.id}><td>{u.id}</td><td>{u.component}</td><td>{u.status}</td><td>{expiryCue(u, now)}</td></tr>)}</tbody></table></div></section>
    <section className="panel lab-panel"><h2>Watchdog lifecycle events</h2><p role="status">{events.length} quarantine events. Local lifecycle events are unsigned; the bank portal path appends signed events transactionally.</p><ol>{events.map(e => <li key={e.id}>{e.unitId} · {e.action} · {e.from} → {e.to} · {e.at}</li>)}</ol></section>
    <p className="source-note">Storage references: <a href="https://www.lifeblood.com.au/health-professionals/products/storage-and-handling">Lifeblood storage and handling</a>. Local teaching shelf lives remain PRBC 35/42 days, platelets 5 days, frozen plasma one calendar year. This is not a sensor validation or release protocol.</p>
  </>;
}
