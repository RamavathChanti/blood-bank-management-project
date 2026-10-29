"use client";
import { useEffect, useRef, useState } from "react";
import { verifyHistory, type AuditRecord, type Verification } from "@/core/audit";
import { passportFixture, tamperFixture } from "@/core/audit-fixture";
import { AuditMeter } from "./audit-meter";

type VisibleEvent = { id: string; seq: number; action: string; actorId: string; at: string; from?: string; to: string; hash: string; prevHash: string; stateHash: string; screening?: AuditRecord; storage?: string };
type Passport = { unit: AuditRecord; events: VisibleEvent[]; verification: Verification };
const labels: Record<string, string> = { COLLECT: "Collected", START_TESTING: "Screening started", UPDATE_SCREENING: "Screening results", VERIFY_STORAGE: "Storage verified", MAKE_AVAILABLE: "Available", RESERVE: "Reserved", ISSUE: "Issued", HANDOVER: "Handed over", TRANSFUSE: "Synthetic transfusion", IMPORT_BASELINE: "Imported baseline" };
export function UnitPassport() {
  const [mode, setMode] = useState("local"), [fixture, setFixture] = useState<Awaited<ReturnType<typeof passportFixture>> | null>(null), [data, setData] = useState<Passport | null>(null), [unitId, setUnitId] = useState("seed-unit-1"), [message, setMessage] = useState("Preparing synthetic history…"), [busy, setBusy] = useState(true);
  const version = useRef(0);
  async function local(next?: Awaited<ReturnType<typeof passportFixture>>) {
    const run = ++version.current; setBusy(true); setMessage("");
    try {
      const value = next ?? await passportFixture(), verification = await verifyHistory(value.unit, value.events, "LOCAL_ONLY");
      if (run !== version.current) return;
      setFixture(value); setData({ ...value, events: value.events as unknown as VisibleEvent[], verification });
    } catch { if (run === version.current) setMessage("Could not verify the local fixture. Retry reset."); }
    finally { if (run === version.current) setBusy(false); }
  }
  useEffect(() => {
    let active = true;
    void passportFixture().then(async value => {
      const verification = await verifyHistory(value.unit, value.events, "LOCAL_ONLY");
      if (active) { setFixture(value); setData({ ...value, events: value.events as unknown as VisibleEvent[], verification }); setBusy(false); setMessage(""); }
    }).catch(() => { if (active) { setBusy(false); setMessage("Could not prepare the local fixture. Retry reset."); } });
    return () => { active = false; };
  }, []);
  async function registry() {
    const run = ++version.current; setBusy(true); setMessage(""); setData(null);
    try {
      const response = await fetch(`/api/audit/passport/${encodeURIComponent(unitId)}`, { cache: "no-store", signal: AbortSignal.timeout(30000) }), result = await response.json();
      if (run !== version.current) return;
      if (!response.ok) throw new Error(result.error);
      setData(result);
    } catch (error) { if (run === version.current) setMessage(error instanceof Error ? error.message : "Verification unavailable"); }
    finally { if (run === version.current) setBusy(false); }
  }
  const v = data?.verification;
  return <div className="unit-passport"><div className="page-heading"><div><p className="eyebrow">ACCOUNTABILITY / VEIN TO VEIN</p><h1>Unit Passport</h1><p className="page-description">Follow one synthetic unit. Inspect every link. Detect a change.</p></div></div>
    <section className="panel lab-panel"><div className="lab-controls"><label>Passport source<select value={mode} disabled={busy} onChange={e => { setMode(e.target.value); setData(null); setMessage(""); if (e.target.value === "local") void local(); }}><option value="local">Isolated local tamper fixture</option><option value="registry">Authenticated registry</option></select></label>{mode === "registry" && <label>Unit ID<input value={unitId} onChange={e => setUnitId(e.target.value)} maxLength={128} /></label>}</div>
      <p>{mode === "local" ? "Local simulation · SHA-256 evidence only · no server HMAC · no database writes. Mock screening is accelerated for this fixture." : "Private synthetic registry · bank ownership or state-admin access required · server verifies HMAC and event/state consistency."}</p>
      <div className="lab-actions"><button className="button button-primary" disabled={busy} onClick={() => void (mode === "local" ? local(fixture ?? undefined) : registry())}>Verify unit</button>{mode === "local" && <><button className="button button-secondary" disabled={busy} onClick={() => void local()}>Reset fixture</button>{([['event', 'Alter event 3'], ['missing', 'Remove event 3'], ['reordered', 'Swap events 3 and 4'], ['unit', 'Change current expiry']] as const).map(([key, label]) => <button key={key} className="button button-secondary" disabled={busy || !fixture} onClick={async () => void local(tamperFixture(await passportFixture(), key))}>{label}</button>)}</>}</div>
      <p role="status">{busy ? "Verifying history…" : message}</p>
      {data && v && <><div className={`passport-verdict ${v.ok ? "passport-valid" : "passport-broken"}`} role={v.ok ? "status" : "alert"}><h2>{v.ok ? "Integrity verified" : "Integrity check failed"}</h2><p>Chain: {v.chain} · Signature: {v.signature} · Current state: {v.state}</p>{v.firstBadSeq !== null && <strong>First affected record: {v.firstBadSeq}</strong>}{v.problems.length > 0 && <p>{v.problems.join(" · ")}</p>}</div><p className="workflow-identifier">{String(data.unit.id)} · {String(data.unit.group)} {String(data.unit.component)} · {String(data.unit.status)} · Expires {String(data.unit.expiresAt)}</p>
      <ol className="passport-timeline" aria-label="Unit event timeline">{data.events.map((e, i) => <li key={`${e.id}-${i}`} className={v.firstBadSeq !== null && i + 1 >= v.firstBadSeq ? "passport-event-broken" : ""}><p className="eyebrow">RECORD {e.seq}</p><h3>{labels[e.action] ?? e.action}</h3><p>{e.from ? `${e.from} → ` : ""}{e.to}</p><time>{String(e.at)}</time><p>Actor: {e.actorId}</p>{e.screening && Object.keys(e.screening).length > 0 && <p>Screening: {Object.entries(e.screening).map(([key, value]) => `${key}: ${value}`).join(" · ")}</p>}{e.storage && <p>Storage: {e.storage}</p>}<details><summary>Inspect hashes</summary><dl><dt>Previous hash</dt><dd>{e.prevHash}</dd><dt>Event SHA-256</dt><dd>{e.hash}</dd><dt>State SHA-256</dt><dd>{e.stateHash}</dd></dl></details></li>)}</ol></>}
    </section><section className="panel lab-panel"><h2>What this proves</h2><p>A changed event breaks its hash at that record. Missing or reordered events break sequence links. A direct edit to a signed unit produces a signature mismatch and a current-state mismatch, while its event chain can remain valid.</p><p>The application server and its HMAC key are trusted. A database administrator can remove evidence or rewrite unanchored history; a separately retained external commitment helps expose a later rewrite. A root stored only in the same database is not an independent witness.</p></section><AuditMeter /></div>;
}
