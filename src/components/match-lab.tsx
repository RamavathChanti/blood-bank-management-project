"use client";

import { useState } from "react";
import { COMPONENTS, GROUPS, type Component, type Group } from "@/core/domain";
import { compatibilityPreference, explainCompatibility, isCompatible } from "@/core/compatibility";
import { MatchAnimation } from "./match-animation";
import { StatusBadge } from "./ui/status-badge";

export function MatchLab() {
  const [component, setComponent] = useState<Component>("PRBC");
  const [donor, setDonor] = useState<Group>("O-");
  const [recipient, setRecipient] = useState<Group>("A+");
  const allowed = isCompatible(donor, recipient, component);
  return <>
    <div className="page-heading"><div><p className="eyebrow">REGISTRY / COMPATIBILITY ENGINE</p><h1>Match Lab</h1><p className="page-description">Explore all 64 donor-to-recipient pairs for each component. Select a cell to explain the teaching rule.</p></div><StatusBadge>Interactive teaching model</StatusBadge></div>
    <div className="foundation-banner"><div><span className="banner-marker">8 × 8</span><p><strong>Component rules are different</strong><span>PRBC: 27 allowed pairs · FFP: 36 · Platelets: 8 under the identical-only policy</span></p></div><span className="mono text-small">NO LIVE DATA</span></div>
    <section className="panel lab-panel"><div className="lab-controls"><label>Component<select value={component} onChange={event => setComponent(event.target.value as Component)}>{COMPONENTS.map(item => <option key={item}>{item}</option>)}</select></label><label>Donor unit group<select value={donor} onChange={event => setDonor(event.target.value as Group)}>{GROUPS.map(item => <option key={item}>{item}</option>)}</select></label><label>Recipient group<select value={recipient} onChange={event => setRecipient(event.target.value as Group)}>{GROUPS.map(item => <option key={item}>{item}</option>)}</select></label></div>
      <div className="compatibility-explanation" role="status"><StatusBadge tone={allowed ? "healthy" : "critical"}>{allowed ? "Allowed pair" : "Rejected pair"}</StatusBadge><h2>{donor} → {recipient} · {component}</h2><p>{explainCompatibility(donor, recipient, component)}</p></div>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Compatibility grid, scroll horizontally"><table className="compatibility-grid"><caption>Rows: donor unit · Columns: recipient · ✓ allowed / × rejected</caption><thead><tr><th scope="col">Donor ↓ / Recipient →</th>{GROUPS.map(group => <th key={group} scope="col">{group}</th>)}</tr></thead><tbody>{GROUPS.map(d => <tr key={d}><th scope="row">{d}</th>{GROUPS.map(r => { const ok = isCompatible(d, r, component); return <td key={r}><button className={`compatibility-cell ${ok ? "pair-allowed" : "pair-rejected"}`} aria-label={`${d} to ${r}: ${ok ? "allowed" : "rejected"}`} aria-pressed={donor === d && recipient === r} onClick={() => { setDonor(d); setRecipient(r); }}>{ok ? "✓" : "×"}</button></td>; })}</tr>)}</tbody></table></div>
      <div className="preference-note"><h2>Preference for {recipient}</h2><p className="mono">{compatibilityPreference(recipient, component).join(" → ")}</p><p className="muted text-small">{component === "FFP" ? "Both RhD variants of the same ABO group share a tier; FEFO breaks the tie." : "Each group is a separate preference tier. FEFO applies within a tier."} This fixed ordering is a project policy.</p></div>
    </section>
    <MatchAnimation donor={donor} recipient={recipient} component={component} allowed={allowed} />
    <div className="notice"><p>{component === "PLATELETS" ? "Platelets: this model requires identical ABO and RhD, which is stricter than real specialist practice. Platelets do not express RhD; residual red cells can matter." : "ABO/RhD compatibility alone does not replace crossmatching, additional antigen testing, screening, or storage checks."} No clinical recommendation is produced.</p></div>
    <p className="source-note">Teaching references: <a href="https://www.lifeblood.com.au/patients-recipients/blood-plasma-platelets/blood-for-transfusion/matching-blood-groups">Lifeblood matching blood groups</a> and <a href="https://www.lifeblood.com.au/health-professionals/products/component-compatibility">component compatibility</a>.</p>
  </>;
}
