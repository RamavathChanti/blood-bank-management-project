"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { runDuel, type DuelMode, type DuelResult } from "@/core/duel";

export function Duel() {
  const [mode, setMode] = useState<DuelMode>("ATOMIC"), [countdown, setCountdown] = useState<number | null>(null), [result, setResult] = useState<DuelResult | null>(null);
  useEffect(() => {
    if (countdown === null) return;
    const timer = setTimeout(() => {
      if (countdown > 1) setCountdown(countdown - 1);
      else { setResult(runDuel(mode)); setCountdown(null); }
    }, 700);
    return () => clearTimeout(timer);
  }, [countdown, mode]);
  return <>
    <div className="page-heading"><div><p className="eyebrow">CONSISTENCY / STAGE 6</p><h1>The Duel</h1><p className="page-description">Two hospitals race for the last synthetic O-negative unit.</p></div><span className="small-label">NO LIVE DATA</span></div>
    <div className="simulation-banner"><span className="simulation-beacon" /><div><strong>ISOLATED BROWSER FIXTURE</strong><p>Both modes run a scheduled interleaving in browser memory. This is an explanation, not a live MongoDB race or a performance measurement. No registry writes.</p></div></div>
    <section className="panel registry-panel lab-panel"><h2>Race for DUEL-O-001</h2><div className="lab-controls"><label>Reservation mode<select value={mode} disabled={countdown !== null} onChange={e => { setMode(e.target.value as DuelMode); setResult(null); }}><option value="ATOMIC">Conditional atomic model</option><option value="NAIVE">Naive read-then-write simulation</option></select></label></div>
      <p className="code-countdown" role="status" aria-live="polite">{countdown !== null ? `Shared countdown: ${countdown}` : result ? "Race complete" : "Ready for a shared countdown"}</p>
      <div className="code-grid">{["Hospital A", "Hospital B"].map(hospital => <article className="wave-card" key={hospital}><h3>{hospital}</h3><p>Request: 1 × O-negative PRBC</p><p>{countdown !== null ? "Waiting for GO" : !result ? "Ready to attempt" : result.owners.includes(hospital) ? "Claim recorded" : "Claim rejected · retry another unit"}</p></article>)}</div>
      <div className="stock-metrics"><p>Double-allocation counter <strong data-testid="duel-double-count">{result?.doubleAllocations ?? 0}</strong></p><p>Claims recorded <strong data-testid="duel-owner-count">{result?.owners.length ?? 0}</strong></p></div>
      <div className="lab-actions"><button className="button button-primary" disabled={countdown !== null} onClick={() => { setResult(null); setCountdown(3); }}>Start shared countdown</button><button className="button button-secondary" onClick={() => { setCountdown(null); setResult(null); }}>Reset fixture</button></div>
      {result && <ol className="event-list">{result.steps.map(step => <li key={step}>{step}</li>)}</ol>}
    </section>
    <section className="panel registry-panel lab-panel"><h2>Three different guarantees</h2><div className="workflow-section"><h3>Conditional atomic unit update</h3><p>A real reservation uses findOneAndUpdate with AVAILABLE, compatible group/component, screening, storage, and expected-use expiry conditions. One writer can claim a unit.</p></div><div className="workflow-section"><h3>Multi-document transaction</h3><p>The unit, allocation slot, bounded request count, stock bucket, history event, and retry receipt commit together. Failure rolls them all back. One request cannot receive more units than requested.</p></div><div className="workflow-section"><h3>Unique allocation index</h3><p>The unconditional unique allocations.unitId index is a second safety net. Released slots are reused transactionally; earlier ownership stays in request-scoped history.</p></div><p className="source-note">The real implementation is exercised by the replica-set integration suite, including 100 concurrent attempts against 10 units. Run the suite to measure your environment. <Link href="/hospital">Hospital portal</Link> · <Link href="/bank">Bank portal</Link>. Teaching model, not clinical software.</p></section>
  </>;
}
