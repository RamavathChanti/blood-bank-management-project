"use client";

import { useState } from "react";
import { COMPONENTS, GROUPS, STATUSES, type Component, type Group } from "@/core/domain";
import { FIXTURE_NOW, fixtureBanks, fixtureRequest, inventoryFixtures } from "@/core/fixtures";
import { matchInventory } from "@/core/inventory";
import { issueLocalStock, releaseLocalStock, reserveLocalStock } from "@/core/local-registry";
import { StatusBadge } from "./ui/status-badge";

export function InventoryLab() {
  const [units, setUnits] = useState(inventoryFixtures);
  const [group, setGroup] = useState<Group>("A+");
  const [component, setComponent] = useState<Component>("PRBC");
  const [quantity, setQuantity] = useState(2);
  const [hours, setHours] = useState(2);
  const [status, setStatus] = useState("ALL");
  const [bank, setBank] = useState("ALL");
  const [query, setQuery] = useState("");
  const [activeRequest, setActiveRequest] = useState<ReturnType<typeof fixtureRequest> | null>(null);
  const [message, setMessage] = useState("Choose a recipient to inspect every candidate, then reserve local stock.");
  const [history, setHistory] = useState<string[]>([]);
  const [error, setError] = useState("");
  const request = activeRequest ?? fixtureRequest(group, component, quantity, hours);
  const match = matchInventory(units, request, FIXTURE_NOW);
  const visible = match.assessments.filter(({ unit }) => (status === "ALL" || unit.status === status) && (bank === "ALL" || unit.bankId === bank) && unit.id.toLowerCase().includes(query.toLowerCase()));
  function operate(action: "reserve" | "issue" | "cancel") {
    try {
      const result = action === "reserve" ? reserveLocalStock(units, request, FIXTURE_NOW, `demo-${history.length}`) : action === "issue" ? issueLocalStock(units, request, FIXTURE_NOW, `demo-${history.length}`, true) : releaseLocalStock(units, request, FIXTURE_NOW, `demo-${history.length}`, "CANCEL");
      setUnits(result.units); setActiveRequest(action === "cancel" ? null : result.request);
      setHistory(previous => [...previous, ...result.events.map(event => `${event.unitId} · ${event.from} → ${event.to} · ${event.action}`)]);
      setMessage(action === "reserve" ? `${result.events.length} unit(s) reserved locally; ${match.shortage} still needed. Lease ends within 10 minutes of the fixture clock.` : action === "issue" ? `${result.events.length} unit(s) issued in preference and FEFO order. Issue does not confirm handover or transfusion.` : `${result.events.length} reservation(s) released after rechecking readiness.`);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Local operation failed"); }
  }
  function reset() { setUnits(inventoryFixtures()); setActiveRequest(null); setHistory([]); setError(""); setStatus("ALL"); setBank("ALL"); setQuery(""); setMessage("Fixture reset. All changes are local to this page."); }
  const reserved = units.filter(unit => unit.status === "RESERVED" && unit.reservation?.requestId === request.id).length;
  return <>
    <div className="page-heading"><div><p className="eyebrow">REGISTRY / DOMAIN ENGINE</p><h1>Inventory</h1><p className="page-description">Inspect synthetic stock, explain exclusions, and try a local reservation and issue in FEFO order.</p></div><StatusBadge>Local fixture · Stage 02</StatusBadge></div>
    <div className="foundation-banner"><div><span className="banner-marker">FIXED CLOCK</span><p><strong>28 Oct 2026 · 09:00 IST</strong><span>15 hand-authored units · no clock progression · reload resets changes</span></p></div><span className="mono text-small">NO LIVE DATA</span></div>
    <section className="panel lab-panel" aria-labelledby="selection-heading"><div className="lab-section-heading"><div><p className="eyebrow">LOCAL MATCH & ISSUE</p><h2 id="selection-heading">Find eligible stock</h2></div><button className="button button-secondary" onClick={reset}>Reset fixture</button></div>
      <div className="lab-controls"><label>Recipient group<select value={group} disabled={!!activeRequest} onChange={event => setGroup(event.target.value as Group)}>{GROUPS.map(item => <option key={item}>{item}</option>)}</select></label><label>Component<select value={component} disabled={!!activeRequest} onChange={event => setComponent(event.target.value as Component)}>{COMPONENTS.map(item => <option key={item}>{item}</option>)}</select></label><label>Units requested<select value={quantity} disabled={!!activeRequest} onChange={event => setQuantity(Number(event.target.value))}>{[1, 2, 3, 5, 10].map(item => <option key={item}>{item}</option>)}</select></label><label>Expected use<select value={hours} disabled={!!activeRequest} onChange={event => setHours(Number(event.target.value))}>{[1, 2, 6, 24, 72].map(item => <option key={item} value={item}>In {item} hour(s)</option>)}</select></label></div>
      <p className="muted text-small">Exact group first, then fixed compatible preferences, then earliest expiry. O-negative red cells are conserved. Plasma ignores RhD; platelets require identical ABO/RhD in this teaching model.</p>
      <div className="lab-actions"><button className="button button-primary" disabled={match.selected.length === 0} onClick={() => operate("reserve")}>Reserve selected locally</button><button className="button button-secondary" disabled={!reserved} onClick={() => operate("issue")}>Issue reserved locally</button><button className="button button-secondary" disabled={!reserved} onClick={() => operate("cancel")}>Cancel reservations</button></div>
      {component === "FFP" && <p className="notice">“Issue reserved locally” explicitly confirms synthetic FFP preparation. No thawed storage window or clinical process is modelled.</p>}
      <p className="lab-result" role="status">{message}</p>{error && <p role="alert" className="error-text">{error}</p>}
      <div className="stock-metrics"><span><strong>{match.candidates.length}</strong> eligible now</span><span><strong>{request.allocatedQuantity}</strong> / {request.quantity} allocated</span><span><strong>{match.shortage}</strong> still needed</span><span><strong>{units.filter(unit => unit.status === "ISSUED").length}</strong> issued locally</span></div>
    </section>
    <section className="panel lab-panel" aria-labelledby="stock-heading"><div className="lab-section-heading"><div><p className="eyebrow">UNIT REGISTER</p><h2 id="stock-heading">Stock & match explanations</h2></div><span className="small-label">ALL TIMES UTC</span></div>
      <div className="lab-controls"><label>Find unit<input value={query} placeholder="DEMO-002" onChange={event => setQuery(event.target.value)} /></label><label>Lifecycle status<select value={status} onChange={event => setStatus(event.target.value)}><option value="ALL">All statuses</option>{STATUSES.map(item => <option key={item}>{item}</option>)}</select></label><label>Bank<select value={bank} onChange={event => setBank(event.target.value)}><option value="ALL">All demo banks</option>{fixtureBanks.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
      <p className="muted text-small">{visible.length} of {units.length} units shown. Filters affect the table; selection searches the full fixture.</p>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Inventory results, scroll horizontally"><table className="data-table"><caption className="sr-only">Synthetic inventory with screening, expiry, lifecycle and match decisions</caption><thead><tr>{["Unit / bank", "Group / product", "Expires at", "Lifecycle", "Match decision"].map(item => <th key={item} scope="col">{item}</th>)}</tr></thead><tbody>{visible.map(({ unit, selected, explanation, reasons }) => <tr key={unit.id} className={selected ? "selected-row" : ""}><th scope="row"><span className="mono">{unit.id}</span><span className="table-detail">{fixtureBanks.find(bank => bank.id === unit.bankId)?.name}</span></th><td><strong>{unit.group}</strong><span className="table-detail">{unit.product}</span></td><td className="mono text-small">{unit.expiresAt.slice(0, 10)}<span className="table-detail">{unit.expiresAt.slice(11, 19)} UTC</span></td><td><StatusBadge tone={unit.status === "AVAILABLE" && !reasons.length ? "healthy" : ["EXPIRED", "DISCARDED"].includes(unit.status) ? "critical" : "neutral"}>{unit.status}</StatusBadge><span className="table-detail">Storage: {unit.storage.toLowerCase()}</span></td><td><strong className={selected ? "selected-label" : ""}>{selected ? `Selected #${match.selected.findIndex(item => item.id === unit.id) + 1}` : reasons.length ? "Excluded" : "Eligible alternative"}</strong><span className="table-detail decision-detail">{explanation}</span></td></tr>)}</tbody></table></div>
      {!visible.length && <p className="lab-result" role="status">No units match these table filters. Change the filters or reset the fixture.</p>}
    </section>
    {history.length > 0 && <section className="panel lab-panel"><h2>Local lifecycle events</h2><ol className="event-list">{history.map((entry, index) => <li key={index} className="mono text-small">{entry}</li>)}</ol></section>}
    <p className="notice">Local single-thread demonstration. Atlas transactions, tenant authorization, concurrent reservation safety, and durable request completion arrive in later stages. Issued returns remain quarantined and cannot be reissued.</p>
  </>;
}
