"use client";
import { useCallback, useState, type FormEvent } from "react";
import { useLiveRefresh } from "../lib/live-updates";
import Link from "next/link";

type Span = { at: string; correlationId: string; requestId?: string; service: string; operation: string; durationMs: number; ok: boolean };
type Snapshot = {
  flags: { dbDown: boolean; dbSlowMs: number; realtimeDown: boolean; expiresAt: string } | null;
  controlsEnabled: boolean; services: Record<string, string>; sampledAt: string;
  counts: { basis: string; byStatus: Record<string, number> } | null;
  alerts: { id: string; createdAt: string; result: { kind: string; requestId?: string } }[] | null;
  telemetry: { scope: string; rows: Span[]; recoveryMs: Record<string, number> };
};
type Reconciliation = { acknowledged: number; pending: number; accepted: number; fulfilled: number; escalated: number; cancelled: number; failed: number; lossExplanation: string; rows: { requestId: string; outcome: string; status: string; recoveryMs: number | null }[] };

export function VitalSigns() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false), [trace, setTrace] = useState<string | null>(null), [result, setResult] = useState<Reconciliation | null>(null), [resultStale, setResultStale] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/resilience/status", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      const value = await response.json(); if (!response.ok) throw new Error(value.error || "STATUS_UNAVAILABLE");
      setSnapshot(value); setError(""); return true;
    } catch (cause) { setError(`${(cause as Error).message}. Last known measurements, if present, are retained. Retry to reconcile.`); return false; }
  }, []);
  const live = useLiveRefresh(refresh, true, "vital-signs", 10_000);
  async function changeFlags(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage("");
    const fields = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/resilience/flags", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dbDown: fields.has("dbDown"), realtimeDown: fields.has("realtimeDown"), dbSlowMs: Number(fields.get("dbSlowMs")), expiresAt: new Date(Date.now() + 600_000).toISOString() }), signal: AbortSignal.timeout(10_000) });
      const value = await response.json(); if (!response.ok) throw new Error(value.error);
      setMessage("Configuration write acknowledged. Propagation is pending; refresh and inspect the observed active flags."); await refresh();
    } catch (cause) { setError(`${(cause as Error).message}. Configuration change is unconfirmed; inspect active flags before retrying.`); }
    finally { setBusy(false); }
  }
  async function reconcile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const fields = new FormData(event.currentTarget); setBusy(true); setResultStale(true);
    try {
      const acknowledgedIds = String(fields.get("ids")).split(/[\s,]+/).filter(Boolean);
      const response = await fetch("/api/resilience/reconcile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ acknowledgedIds }), signal: AbortSignal.timeout(15_000) });
      const value = await response.json(); if (!response.ok) throw new Error(value.error);
      setResult(value); setResultStale(false); setError("");
    } catch (cause) { setError(`${(cause as Error).message}. Reconciliation is pending; retain every acknowledgement.`); }
    finally { setBusy(false); }
  }
  const degraded = snapshot && (snapshot.services.atlas !== "reachable" || snapshot.services.config === "unavailable" || snapshot.flags?.dbSlowMs || snapshot.flags?.realtimeDown);
  return <div className="vital-signs">
    <div className="page-heading"><div><p className="eyebrow">RESILIENCE / STAGE 12</p><h1>Vital Signs</h1><p className="page-description">Measured dependency activity, synthetic failure controls, and acknowledgement reconciliation. State admin access required.</p></div><button className="button button-secondary" onClick={() => void refresh()}>Refresh Vital Signs</button></div>
    <p>Teaching model, not clinical software. <Link href="/sign-in">Sign in</Link> · <Link href="/public-board">Public Board</Link> · <Link href="/code-red">Durable Code Red</Link></p>
    {error && <div className="notice" role="alert">{error}</div>}
    {degraded && <div className="notice" role="status">Degraded service. Keep acknowledgement IDs; database writes and reconciliation may be pending. Polling and manual refresh remain available.</div>}
    {message && <p role="status">{message}</p>}
    {live.paused && <button className="button button-secondary" onClick={live.resume}>Resume bounded polling</button>}
    {!snapshot && <p>No authenticated service measurements available.</p>}
    {snapshot && <>
      <p className="muted">{error ? "Last known sample" : "Sampled"}: {snapshot.sampledAt}</p>
      <section className="panel lab-panel"><h2>Service health</h2><dl className="vital-services">{Object.entries(snapshot.services).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl><p>Workflow configuration is not a delivery probe. Atlas ping measures reachability. No CPU, uptime percentage, queue depth, or fleet latency is inferred.</p></section>
      <section className="panel lab-panel"><h2>Active demo controls</h2><p>Observed: {snapshot.flags ? `dbDown=${snapshot.flags.dbDown}, dbSlowMs=${snapshot.flags.dbSlowMs}, realtimeDown=${snapshot.flags.realtimeDown}. Expires ${snapshot.flags.expiresAt}` : "configuration unavailable"}</p><p>Slowness is an injected delay per database access. Realtime loss suppresses browser refresh hints; this app uses polling, without a hosted realtime provider.</p>
        <form onSubmit={changeFlags}><fieldset disabled={busy || !snapshot.controlsEnabled || !snapshot.flags} key={JSON.stringify(snapshot.flags)}><label><input type="checkbox" name="dbDown" defaultChecked={snapshot.flags?.dbDown} /> Cut database (synthetic fault)</label><label><input type="checkbox" name="realtimeDown" defaultChecked={snapshot.flags?.realtimeDown} /> Drop refresh hints</label><label>Database delay (ms)<input type="number" name="dbSlowMs" min={0} max={3000} defaultValue={snapshot.flags?.dbSlowMs ?? 0} /></label><button className="button button-primary">Apply for 10 minutes</button></fieldset></form>
        {!snapshot.controlsEnabled && <p>Controls are disabled in this environment.</p>}
      </section>
      <section className="panel lab-panel"><h2>Materialized workflow counts</h2>{snapshot.counts ? <><p>{snapshot.counts.basis}</p><dl className="vital-services">{Object.entries(snapshot.counts.byStatus).map(([s, count]) => <div key={s}><dt>{s}</dt><dd>{count}</dd></div>)}</dl>{!Object.keys(snapshot.counts.byStatus).length && <p>No materialized workflows.</p>}</> : <p>Counts unavailable. No zero count is inferred.</p>}</section>
      <section className="panel lab-panel"><h2>Latency and recovery observations</h2><p>{snapshot.telemetry.scope}. Recovery is elapsed time between this process observing a failure and its next successful observation.</p><dl className="vital-services">{Object.entries(snapshot.telemetry.recoveryMs).map(([s, ms]) => <div key={s}><dt>{s} recovery</dt><dd>{ms} ms</dd></div>)}</dl><p>Each trace reports measured operation duration; overlapping spans must not be added together.</p><div className="vital-traces">{snapshot.telemetry.rows.slice(-20).reverse().map((s, i) => <button key={i} className="button button-secondary" onClick={() => setTrace(s.correlationId)}>{s.service}: {s.operation} · {s.durationMs} ms · {s.ok ? "ok" : "failed"}</button>)}</div></section>
      <section className="panel lab-panel"><h2>Retained alerts</h2>{snapshot.alerts === null ? <p>Alert storage unavailable; inspect structured platform logs and Inngest failed runs.</p> : snapshot.alerts.length ? snapshot.alerts.map(a => <p key={a.id}>{a.result.kind} · {a.createdAt} · {a.result.requestId ?? "Inspect integrity report"}</p>) : <p>No retained workflow or integrity alerts found in this sample.</p>}</section>
    </>}
    <section className="panel lab-panel"><h2>Account for acknowledged requests</h2><p>Paste up to 100 distinct IDs from successful durable intake receipts. Keep signed receipts and provider event IDs separately. An unknown API response is not an acknowledgement.</p><form onSubmit={reconcile}><label>Acknowledged request IDs<textarea name="ids" rows={5} required /></label><button className="button button-secondary" disabled={busy}>Reconcile acknowledged IDs</button></form>
      {result && <><p>{resultStale ? "Last known reconciliation; retry pending. " : ""}{result.acknowledged} acknowledged · {result.pending} pending persistence · {result.accepted} accepted/in progress · {result.fulfilled} fulfilled · {result.escalated} escalated · {result.cancelled} cancelled · {result.failed} failed</p><p>{result.lossExplanation}</p><ul>{result.rows.map(r => <li key={r.requestId}><code>{r.requestId}</code>: {r.outcome} ({r.status}) · intake to first persistence: {r.recoveryMs === null ? "unavailable" : `${r.recoveryMs} ms`}</li>)}</ul></>}
    </section>
    {trace && snapshot && <aside className="vital-drawer panel" role="dialog" aria-modal="false" aria-label="Request trace"><button className="button button-secondary" onClick={() => setTrace(null)}>Close trace</button><h2>Request trace</h2><code>{trace}</code><p>API correlation IDs appear in response headers and structured logs. Workflow steps correlate by the durable emergency request ID; use the Inngest run history for durable steps across processes.</p><ol>{snapshot.telemetry.rows.filter(s => s.correlationId === trace).map((s, i) => <li key={i}>{s.at}: {s.service} / {s.operation} · {s.durationMs} ms · {s.ok ? "ok" : "failed"}</li>)}</ol></aside>}
  </div>;
}
