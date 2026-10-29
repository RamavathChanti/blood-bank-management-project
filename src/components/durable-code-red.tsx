"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { COMPONENTS, GROUPS } from "@/core/domain";
import { emergencyInput, SIGNALS, WORKFLOW_TERMINAL, type EmergencyInput, type SignalKind } from "@/core/workflow-events";
import { CodeRed } from "./code-red";
import { announceRegistryChange, useLiveRefresh } from "@/lib/live-updates";

import { RequestIntake } from "./request-intake";
import type { IntakeDraft } from "@/core/intelligence";
import { CodeRedSound } from "./code-red-sound";

type Ack = { requestId: string; receipt: string; eventIds: string[]; dashboardUrl: string };
type Progress = { status: string; requestStatus?: string; quantity?: number; allocatedQuantity?: number; transfusedQuantity?: number; acceptedDonors?: number; declinedDonors?: number; expectedTransfusionAt?: string; dashboardUrl?: string; workflow?: { runId: string; reason?: string; trace: { status: string; at: string }[]; waves: { radiusKm: number; count: number; targetMet: boolean }[] }; allocations?: { id: string; unitId: string; bankId: string; status: string; handoverAt?: string; dispatchApproved?: boolean }[] };
type Saved = { pending?: EmergencyInput; ack?: Ack; acknowledgements?: Ack[] };

export function DurableCodeRed({ storageKey }: { storageKey: string }) {
  const refreshVersion = useRef(0);
  const [intakeDraft, setIntakeDraft] = useState<IntakeDraft | null>(null);
  const [saved, setSaved] = useState<Saved>({}), [loaded, setLoaded] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [signal, setSignal] = useState<SignalKind>("donor.reply"), [target, setTarget] = useState(""), [unitId, setUnitId] = useState(""), [allocationId, setAllocationId] = useState(""), [donorId, setDonorId] = useState(""), [reply, setReply] = useState("ACCEPTED"), [prepared, setPrepared] = useState(false);
  const [signalPending, setSignalPending] = useState<{ target: string; kind: SignalKind; body: Record<string, unknown> } | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
    try { const value = sessionStorage.getItem(storageKey); if (value) { const parsed = JSON.parse(value) as Saved; if (parsed.pending) emergencyInput(parsed.pending); const validAck = (ack: Ack) => ack && typeof ack.receipt === "string" && typeof ack.requestId === "string" && Array.isArray(ack.eventIds) && ack.eventIds.every(id => typeof id === "string"); if (parsed.ack && !validAck(parsed.ack) || parsed.acknowledgements && (!Array.isArray(parsed.acknowledgements) || parsed.acknowledgements.length > 100 || parsed.acknowledgements.some(ack => !validAck(ack)))) throw new Error(); setSaved(parsed); } }
    catch { setError("Saved request could not be restored. Inspect your hospital records before submitting another request."); }
    setLoaded(true);
    }, 0);
    return () => clearTimeout(timer);
  }, [storageKey]);
  function remember(value: Saved) {
    refreshVersion.current++;
    const receipts = [...(saved.acknowledgements ?? []), ...(saved.ack ? [saved.ack] : []), ...(value.ack ? [value.ack] : [])];
    const next = { ...value, acknowledgements: [...new Map(receipts.map(ack => [ack.requestId, ack])).values()] };
    setSaved(next);
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { setError("Browser storage is unavailable. Copy the request ID and keep this tab open for retries."); }
  }
  const refresh = useCallback(async () => {
    if (!saved.ack) return;
    const version = ++refreshVersion.current;
    try {
      const response = await fetch(`/api/emergencies/${saved.ack.requestId}`, { cache: "no-store", signal: AbortSignal.timeout(10_000), headers: { "x-emergency-receipt": saved.ack.receipt } });
      const value = await response.json();
      if (version !== refreshVersion.current) return;
      if (value.accepted) setProgress(current => ({ ...current, ...value }));
      if (!response.ok) throw new Error(value.error ?? "Status unavailable");
      setError(""); return true;
    } catch (cause) { if (version === refreshVersion.current) setError(`${(cause as Error).message}. The acknowledged request ID is retained; refresh to reconcile it.`); return false; }
  }, [saved.ack]);
  const status = progress?.status;
  const live = useLiveRefresh(refresh, !!saved.ack && !(status && WORKFLOW_TERMINAL.includes(status)), saved.ack?.requestId ?? "no-request");
  useEffect(() => () => { refreshVersion.current++; }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      const fields = new FormData(event.currentTarget);
      const input = saved.pending ?? emergencyInput({ key: crypto.randomUUID(), group: fields.get("group"), component: fields.get("component"), quantity: Number(fields.get("quantity")), urgency: fields.get("urgency"), expectedTransfusionAt: `${fields.get("deadline")}:00Z` });
      remember({ pending: input });
      const response = await fetch("/api/emergencies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(15_000) });
      const value = await response.json();
      if (!response.ok || !value.accepted) {
        if (response.status < 500) remember({});
        throw new Error(`${value.error ?? "Acknowledgement unavailable"}${value.requestId ? ` · ${value.requestId}` : ""}.${response.status >= 500 ? " Retry the retained payload." : " Correct the form or account membership and retry."}`);
      }
      remember({ ack: value }); setProgress({ status: value.status }); announceRegistryChange(); setMessage("Inngest acknowledged the event. Atlas creation and matching run asynchronously.");
    } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  }
  async function sendSignal(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    const requestId = target || saved.ack?.requestId || "";
    const action = signalPending ?? { target: requestId, kind: signal, body: { key: crypto.randomUUID(), ...(signal === "donor.reply" ? { donorId, reply } : {}), ...(["stock.ready", "dispatch.approved", "handover", "synthetic-use"].includes(signal) ? { unitId } : {}), ...(["dispatch.approved", "handover", "synthetic-use"].includes(signal) ? { allocationId } : {}), ...(signal === "dispatch.approved" ? { preparationConfirmed: prepared } : {}) } };
    setSignalPending(action);
    try {
      const response = await fetch(`/api/emergencies/${action.target}/${action.kind}`, { method: "POST", headers: { "content-type": "application/json", ...(saved.ack?.requestId === action.target ? { "x-emergency-receipt": saved.ack.receipt } : {}) }, body: JSON.stringify(action.body), signal: AbortSignal.timeout(15_000) });
      const value = await response.json();
      if (!response.ok) { if (response.status < 500) setSignalPending(null); throw new Error(value.error ?? "Signal unavailable"); }
      setSignalPending(null); announceRegistryChange(); setMessage(`${action.kind}: acknowledged; processing is pending. Refresh authoritative status to see the result.`); await refresh();
    } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  }
  return <section className="durable-code-red" aria-label="Durable emergency registry">
    <div className="page-heading"><div><p className="eyebrow">AUTHENTICATED REGISTRY / INNGEST</p><h1>Durable Code Red</h1><p className="page-description">Synthetic emergencies use your hospital membership, Atlas transactions, and durable workflow waits.</p></div></div>
    <p><Link href="/sign-in">Sign in</Link> · <Link href="/bank">Bank screening and allocations</Link> · <Link href="/hospital">Hospital records</Link> · <Link href="/donor">Donor alerts</Link></p>
    <div className="notice"><p>Teaching model, not clinical software. Alerts are durable in-app records. Donor acceptance requires collection and all screening/storage gates before it can become stock.</p></div>
    {!saved.ack && <section className="panel lab-panel"><h2>Queue a synthetic emergency</h2><p>Hospital accounts only. Expected use must be within 24 hours. An uncertain response retains this exact payload and retry key in this browser session.</p>
      <RequestIntake onConfirm={setIntakeDraft} /><form key={JSON.stringify(intakeDraft)} onSubmit={submit}><fieldset disabled={busy || !loaded || !!saved.pending}><div className="lab-controls">
        <label>Emergency recipient group<select name="group" defaultValue={intakeDraft?.group ?? "O-"}>{GROUPS.map(g => <option key={g}>{g}</option>)}</select></label>
        <label>Emergency component<select name="component" defaultValue={intakeDraft?.component ?? "PRBC"}>{COMPONENTS.map(c => <option key={c}>{c}</option>)}</select></label>
        <label>Emergency quantity<input name="quantity" type="number" min={1} max={20} defaultValue={intakeDraft?.quantity ?? 1} required /></label>
        <label>Emergency urgency<select name="urgency" defaultValue={intakeDraft?.urgency ?? "CRITICAL"}><option>CRITICAL</option><option>URGENT</option></select></label>
        <label>Emergency deadline (UTC)<input name="deadline" type="datetime-local" defaultValue={intakeDraft?.expectedTransfusionAt?.slice(0, 16)} required /></label>
      </div></fieldset><button className="button button-primary" disabled={busy || !loaded}>{saved.pending ? "Retry retained emergency" : "Queue emergency"}</button></form>
      {saved.pending && <p>Retained: {saved.pending.quantity} {saved.pending.component} · {saved.pending.group} · {saved.pending.expectedTransfusionAt}. Resolve this submission before creating another.</p>}
    </section>}
    {saved.ack && <section className="panel lab-panel"><h2>Workflow progress</h2><p className="workflow-identifier">Request ID: <strong>{saved.ack.requestId}</strong></p><p role="status">{progress?.status ?? "ACKNOWLEDGED_PENDING"} {progress?.requestStatus ? `· registry ${progress.requestStatus}` : ""}</p>
      {progress?.quantity === undefined ? <p>Allocation and use counts are not available yet.</p> : <p>{progress.status === "ACKNOWLEDGED_STATUS_UNAVAILABLE" ? "Last known: " : ""}{progress.allocatedQuantity}/{progress.quantity} allocated · {progress.transfusedQuantity} synthetic uses confirmed</p>}
      {progress?.acceptedDonors !== undefined && <p role="status">Donor responses: {progress.acceptedDonors} accepted ? {progress.declinedDonors ?? 0} declined. Acceptance is not screened stock.</p>}
      {progress?.workflow?.reason && <p>{progress.workflow.reason}</p>}
      <p><a href={progress?.dashboardUrl ?? saved.ack.dashboardUrl} target="_blank" rel="noreferrer">Inspect Inngest run history</a> · Run ID: <span className="workflow-identifier">{progress?.workflow?.runId ?? "pending Atlas record"}</span></p><p className="workflow-identifier">Acknowledged event IDs: {saved.ack.eventIds.join(", ")}</p>
      <button className="button button-secondary" onClick={() => { void refresh(); live.resume(); }}>Refresh durable status</button><p>Polls every five seconds while visible, up to 120 attempts per request. Reconnect fetches authoritative state. {status && WORKFLOW_TERMINAL.includes(status) ? "Workflow is terminal; automatic polling stopped." : live.paused ? "Automatic polling paused; use refresh." : "Polling active; backs off during failures."}</p>
      <ol>{progress?.workflow?.trace.map((entry, index) => <li key={index}>{entry.status} · {entry.at}</li>)}</ol>
      {progress?.workflow?.waves.map((wave, index) => <p key={index}>Wave {index + 1}: {wave.radiusKm} km · {wave.count} in-app alerts · probability target {wave.targetMet ? "met" : "unmet"}</p>)}
      {progress?.allocations?.map(a => <p className="workflow-identifier" key={a.id}>Unit {a.unitId} · allocation {a.id} · bank {a.bankId} · {a.status} · {a.dispatchApproved ? "bank approved" : "approval pending"}{a.handoverAt ? " · handed over" : ""}</p>)}
      <button className="button button-secondary" disabled={busy || !!signalPending || (saved.acknowledgements?.length ?? 0) >= 100} onClick={() => { remember({}); setProgress(null); setMessage("Previous acknowledgement retained below. Each new intake uses a distinct key."); }}>Start another emergency</button>
    </section>}
    {!!saved.acknowledgements?.length && <section className="panel lab-panel"><h2>Retained acknowledgement cohort</h2><p>{saved.acknowledgements.length} distinct durable receipts retained in this signed-in browser session. Keep this session open through recovery. Only acknowledged submissions appear here.</p><label>Acknowledged IDs for Vital Signs<textarea readOnly rows={5} value={saved.acknowledgements.map(a => a.requestId).join("\n")} /></label><label>Receipt export (private; retain for recovery)<textarea readOnly rows={4} value={JSON.stringify(saved.acknowledgements)} /></label><label>Inspect retained acknowledgement<select value={saved.ack?.requestId ?? ""} disabled={!!saved.pending || busy || !!signalPending} onChange={event => { const ack = saved.acknowledgements?.find(a => a.requestId === event.target.value); if (ack) { remember({ ack }); setProgress(null); } }}><option value="">Choose a request</option>{saved.acknowledgements.map(a => <option key={a.requestId} value={a.requestId}>{a.requestId}</option>)}</select></label></section>}
    <section className="panel lab-panel"><h2>Send an authorized workflow event</h2><p>Use your own donor alert or bank allocation IDs. Bank approves dispatch; Hospital confirms handover and synthetic use. Cancellation retains issued stock for manual review.</p>
      <form onSubmit={sendSignal}><fieldset disabled={busy || !!signalPending}><div className="lab-controls">
        <label htmlFor="durable-event-kind">Workflow event</label><select id="durable-event-kind" value={signal} onChange={e => setSignal(e.target.value as SignalKind)}>{SIGNALS.map(s => <option key={s}>{s}</option>)}</select>
        <label>Event request ID<input value={target} onChange={e => setTarget(e.target.value)} placeholder={saved.ack?.requestId ?? "emergency-…"} required={!saved.ack} /></label>
        {signal === "donor.reply" && <><label>Reply donor ID<input value={donorId} onChange={e => setDonorId(e.target.value)} required /></label><label>Donor response<select value={reply} onChange={e => setReply(e.target.value)}><option>ACCEPTED</option><option>DECLINED</option></select></label></>}
        {["stock.ready", "dispatch.approved", "handover", "synthetic-use"].includes(signal) && <label>Event unit ID<input value={unitId} onChange={e => setUnitId(e.target.value)} required /></label>}
        {["dispatch.approved", "handover", "synthetic-use"].includes(signal) && <label>Event allocation ID<input value={allocationId} onChange={e => setAllocationId(e.target.value)} required /></label>}
        {signal === "dispatch.approved" && <label><input type="checkbox" checked={prepared} onChange={e => setPrepared(e.target.checked)} /> Synthetic plasma preparation confirmed (required for FFP)</label>}
      </div></fieldset><button className="button button-secondary" disabled={busy}>{signalPending ? "Retry retained event" : "Send workflow event"}</button></form>
    </section>
    {message && <p role="status">{message}</p>}{error && <div className="notice" role="alert">{error}</div>}
  </section>;
}
function SignedInDurable() {
  const { userId, isLoaded } = useAuth();
  if (!isLoaded) return <p role="status">Checking session…</p>;
  if (!userId) return <section className="panel lab-panel"><h1>Durable Code Red</h1><p><Link href="/sign-in">Sign in</Link> with an assigned synthetic registry membership.</p></section>;
  return <DurableCodeRed key={userId} storageKey={`pulsegrid-emergency-v1-${userId}`} />;
}
export function CodeRedModes({ configured }: { configured: boolean }) {
  const [mode, setMode] = useState("simulation");
  return <><CodeRedSound /><div className="lab-controls" role="group" aria-label="Code Red data mode"><button className="button button-secondary" aria-pressed={mode === "simulation"} onClick={() => setMode("simulation")}>Local simulator</button><button className="button button-secondary" aria-pressed={mode === "durable"} onClick={() => setMode("durable")}>Durable registry</button></div>
    {mode === "simulation" ? <CodeRed /> : configured ? <SignedInDurable /> : <section className="panel lab-panel"><h1>Durable Code Red</h1><p>Authentication is not configured. Follow docs/workflows.md to configure Clerk, Atlas, and Inngest; the local simulator is available independently.</p></section>}</>;
}
