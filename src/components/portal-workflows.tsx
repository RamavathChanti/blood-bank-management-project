"use client";

import { cloneElement, useCallback, useEffect, useId, useRef, useState, type ReactElement } from "react";
import { COMPONENTS, GROUPS, PRODUCTS, SCREENS } from "@/core/domain";
import { announceRegistryChange, useLiveRefresh } from "@/lib/live-updates";

type Row = Record<string, unknown>;
type Result = { records?: Row[]; next?: string | null } & Row;
function resultMessage(result: Result) {
  if (result.reserved === true) return `Reserved ${String(result.unitId ?? "stock")} for request ${String(result.requestId)}.${result.remaining !== undefined ? ` ${String(result.remaining)} units still needed.` : ""}${result.leaseExpiresAt ? ` Lease ends ${String(result.leaseExpiresAt)}.` : ""}`;
  if (result.reserved === false) return result.reason === "QUANTITY_COVERED" ? "The requested quantity is already allocated." : `No eligible stock available. ${String(result.remaining ?? "Unknown")} units still needed.`;
  if (result.processed !== undefined) return `Processed ${String(result.processed)} due units.${result.countersReconciled ? " Stock counters reconciled." : ""}${result.more ? " More due units remain; run maintenance again." : ""}`;
  if (result.unitId) return `Unit ${String(result.unitId)} · ${String(result.status)}.`;
  return `Request ${String(result.requestId)} · ${String(result.status)}.`;
}
class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
async function call(path: string, body?: Row): Promise<Result> {
  const response = await fetch(`/api/registry/${path}`, { cache: "no-store", signal: AbortSignal.timeout(10_000), ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new ApiError(`${result.error} · reference ${result.requestId}`, response.status);
  if (body) announceRegistryChange();
  return result;
}
function Records({ rows }: { rows: Row[] }) {
  if (!rows.length) return <p>No matching records.</p>;
  const keys = ["id", "unitId", "requestId", "bankName", "group", "component", "status", "action", "quantity", "allocatedQuantity", "transfusedQuantity", "preference", "distanceKm", "expiresAt", "leaseExpiresAt", "handoverAt", "at"].filter(k => rows.some(r => k in r));
  return <div className="table-scroll"><table className="registry-table"><thead><tr>{keys.map(k => <th key={k} scope="col">{k}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={String(row.id ?? row.unitId ?? i)}>{keys.map(k => <td key={k}>{String(row[k] ?? "—")}</td>)}</tr>)}</tbody></table></div>;
}
function useRows(path: string, revision: number) {
  const [rows, setRows] = useState<Row[]>([]), [next, setNext] = useState<string | null>(null), [error, setError] = useState("");
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    try { const r = await call(path); if (version === generation.current) { setRows(r.records ?? []); setNext(r.next ?? null); setError(""); } return true; }
    catch (cause) {
      if (version === generation.current) {
        if (cause instanceof ApiError && [401, 403].includes(cause.status)) { setRows([]); setNext(null); }
        setError(`${(cause as Error).message}. Refresh failed; any retained records are last known.`);
      }
      return false;
    }
  }, [path]);
  const live = useLiveRefresh(refresh, true, `${path}/${revision}`);
  useEffect(() => () => { generation.current++; }, [path, revision]);
  const load = async () => { const version = generation.current; try { const result = await call(`${path}?after=${encodeURIComponent(next!)}`); if (version !== generation.current) return; setRows(current => [...current, ...result.records ?? []]); setNext(result.next ?? null); } catch (e) { if (version === generation.current) setError((e as Error).message); } };
  return { rows, error, more: <>{live.paused && <button className="button button-secondary" onClick={live.resume}>Resume {path.split("/").at(-1)} updates</button>}{next && <button className="button button-secondary" type="button" onClick={load}>Load more {path.endsWith("units") ? "units" : path.endsWith("requests") ? "requests" : "allocations"}</button>}</> };
}
function useWrites(changed: () => void) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [pending, setPending] = useState<{ path: string; body: Row } | null>(null);
  const lock = useRef(false);
  const send = async (path: string, body: Row, retry = false) => {
    if (lock.current || pending && !retry) return;
    lock.current = true; setBusy(true); setError(""); setNotice("");
    const payload = retry ? body : { ...body, key: crypto.randomUUID() };
    try {
      const result = await call(path, payload); setPending(null); setNotice(resultMessage(result)); changed();
    } catch (e) {
      setError((e as Error).message);
      if (!(e instanceof ApiError) || e.status >= 500) setPending({ path, body: payload });
      else setPending(null);
    } finally { lock.current = false; setBusy(false); }
  };
  return { send, disabled: busy || Boolean(pending), feedback: <>{busy && <p role="status">Waiting for the registry transaction…</p>}{notice && <p className="workflow-result" role="status">{notice}</p>}{error && <p className="error-text" role="alert">{error}</p>}{pending && <div className="notice"><p>The outcome is uncertain. Retry the same action to recover its saved result.</p><button type="button" className="button button-secondary" disabled={busy} onClick={() => send(pending.path, pending.body, true)}>Retry pending action</button></div>}</> };
}
function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = useId();
  return <div className="workflow-field"><label htmlFor={id}>{label}</label>{cloneElement(children, { id })}</div>;
}
function Options({ values }: { values: readonly string[] }) { return values.map(s => <option key={s}>{s}</option>); }

export function PortalWorkflow({ parent, role, onChanged }: { parent: string; role: "BANK" | "HOSPITAL"; onChanged: () => void }) {
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => { setRevision(n => n + 1); onChanged(); }, [onChanged]);
  const writes = useWrites(changed);
  return <section className="panel registry-panel feature-panel workflow-panel"><p className="eyebrow">SYNTHETIC REGISTRY / TRANSACTIONS</p><h2>{role === "BANK" ? "Manage bank stock" : "Manage hospital requests"}</h2>
    <p>Actions persist to the configured registry. Each successful action has a durable retry receipt. Bounded polling refreshes current records across tabs and after reconnect.</p>
    <div className="lab-actions"><button type="button" className="button button-secondary" onClick={changed} disabled={writes.disabled}>Refresh progress</button><button type="button" className="button button-secondary" disabled={writes.disabled} onClick={() => writes.send(`${parent}/maintain`, {})}>Release expired leases{role === "BANK" ? " and reconcile stock" : ""}</button></div>
    <p className="source-note">Leases last up to 10 minutes, bounded by expected use. Maintenance handles up to 100 due units per pass; repeat if more remain. Durable emergencies reconcile leases in their workflow; routine requests use this maintenance control.</p>
    {role === "BANK" ? <BankWorkflow parent={parent} revision={revision} writes={writes} /> : <HospitalWorkflow parent={parent} revision={revision} writes={writes} />}
    {writes.feedback}
  </section>;
}
type Writes = ReturnType<typeof useWrites>;
function BankWorkflow({ parent, revision, writes }: { parent: string; revision: number; writes: Writes }) {
  const units = useRows(`${parent}/units`, revision);
  const [unitId, setUnitId] = useState(""), [action, setAction] = useState("START_TESTING"), [group, setGroup] = useState("A+"), [product, setProduct] = useState("PRBC_SAGM"), [donorId, setDonorId] = useState("");
  const [collectedAt, setCollectedAt] = useState(() => new Date().toISOString()), [storage, setStorage] = useState("VERIFIED"), [screening, setScreening] = useState<Record<string, string>>(Object.fromEntries(SCREENS.map(s => [s, "PENDING"]))), [note, setNote] = useState(""), [prepared, setPrepared] = useState(false);
  const unit = units.rows.find(r => r.id === unitId);
  return <>
    <details className="workflow-section"><summary>Record a synthetic collection</summary><form onSubmit={e => { e.preventDefault(); writes.send(`${parent}/collect`, { donorId, group, product, collectedAt }); }}><fieldset disabled={writes.disabled} className="request-fields lab-controls">
      <Field label="Synthetic donor ID"><input required value={donorId} onChange={e => setDonorId(e.target.value)} placeholder="demo-donor-1" /></Field>
      <Field label="Collected group"><select value={group} onChange={e => setGroup(e.target.value)}><Options values={GROUPS} /></select></Field>
      <Field label="Collected product"><select value={product} onChange={e => setProduct(e.target.value)}><Options values={PRODUCTS} /></select></Field>
      <Field label="Collection time (ISO with timezone)"><input required value={collectedAt} onChange={e => setCollectedAt(e.target.value)} /></Field>
      <button className="button button-primary" type="submit">Record collection</button></fieldset></form><p className="source-note">Use an existing synthetic donor with the same group. Collection creates quarantined stock; all five screens and verified storage are required before availability.</p></details>
    <div className="workflow-section"><h3>Stock lifecycle</h3>{units.error && <p role="alert">{units.error}</p>}
      <p className="source-note">Loaded {units.rows.length} units · available {units.rows.filter(u => u.status === "AVAILABLE").length} · quarantined {units.rows.filter(u => ["COLLECTED", "TESTING", "RETURNED_QUARANTINE", "QUARANTINED"].includes(String(u.status))).length}. Counts describe loaded lifecycle states; server stock excludes logically expired units.</p>
      <form onSubmit={e => { e.preventDefault(); const extra = action === "UPDATE_SCREENING" ? { screening } : action === "VERIFY_STORAGE" ? { storage } : action === "ISSUE" ? { preparationConfirmed: prepared } : ["RETURN", "DISCARD"].includes(action) ? { note } : {}; writes.send(`${parent}/units/${unitId}/action`, { type: action, ...extra }); }}><fieldset className="request-fields lab-controls" disabled={writes.disabled}>
        <Field label="Bank unit"><select value={unitId} required onChange={e => setUnitId(e.target.value)}><option value="">Choose a unit</option>{units.rows.map(u => <option key={String(u.id)} value={String(u.id)}>{String(u.id)} · {String(u.group)} {String(u.component)} · {String(u.status)}</option>)}</select></Field>
        <Field label="Lifecycle action"><select value={action} onChange={e => setAction(e.target.value)}><Options values={["START_TESTING", "UPDATE_SCREENING", "VERIFY_STORAGE", "MAKE_AVAILABLE", "ISSUE", "RETURN", "EXPIRE", "DISCARD"]} /></select></Field>
        {action === "UPDATE_SCREENING" && SCREENS.map(s => <Field key={s} label={s}><select value={screening[s]} onChange={e => setScreening(current => ({ ...current, [s]: e.target.value }))}><Options values={["PENDING", "NON_REACTIVE", "REACTIVE", "INVALID"]} /></select></Field>)}
        {action === "VERIFY_STORAGE" && <Field label="Storage verification"><select value={storage} onChange={e => setStorage(e.target.value)}><Options values={["VERIFIED", "UNKNOWN", "FAILED"]} /></select></Field>}
        {["RETURN", "DISCARD"].includes(action) && <Field label="Synthetic reason"><input required maxLength={200} value={note} onChange={e => setNote(e.target.value)} /></Field>}
        {action === "ISSUE" && unit?.component === "FFP" && <Field label="Synthetic plasma preparation confirmed"><input type="checkbox" checked={prepared} onChange={e => setPrepared(e.target.checked)} /></Field>}
        <button type="submit" className="button button-primary" disabled={!unitId}>Apply lifecycle action</button>
      </fieldset></form>{unit && <><p className="source-note">Selected expiry: {String(unit.expiresAt)} · storage: {String(unit.storage)} · screening: {JSON.stringify(unit.screening)}</p><Records rows={[unit]} /></>}
      {units.more}<p className="source-note">Issue requires an active, unexpired reservation. For a durable emergency, approve its exact allocation in Code Red → Durable registry. Returns go to RETURNED_QUARANTINE and require manual review; they cannot return directly to available stock.</p>
    </div>
  </>;
}
function HospitalWorkflow({ parent, revision, writes }: { parent: string; revision: number; writes: Writes }) {
  const requests = useRows(`${parent}/requests`, revision), allocations = useRows(`${parent}/allocations`, revision);
  const [requestId, setRequestId] = useState(""), [group, setGroup] = useState("A+"), [component, setComponent] = useState("PRBC"), [quantity, setQuantity] = useState(1), [deadline, setDeadline] = useState(() => new Date(Date.now() + 3_600_000).toISOString());
  const [search, setSearch] = useState<Row[]>([]), [history, setHistory] = useState<Row[]>([]), [readError, setReadError] = useState(""), [policy, setPolicy] = useState("");
  const selected = requests.rows.find(r => r.id === requestId);
  const read = async (action: string) => {
    setReadError(""); try { const result = await call(`${parent}/requests/${requestId}/${action}`, {}); if (action === "search") { setSearch(result.records ?? []); setPolicy(String(result.policy)); } else setHistory(result.records ?? []); } catch (e) { setReadError((e as Error).message); }
  };
  return <>
    <details className="workflow-section"><summary>Create a synthetic request</summary><form onSubmit={e => { e.preventDefault(); writes.send(`${parent}/requests`, { group, component, quantity, urgency: "ROUTINE", expectedTransfusionAt: deadline }); }}><fieldset className="request-fields lab-controls" disabled={writes.disabled}>
      <Field label="Recipient group"><select value={group} onChange={e => setGroup(e.target.value)}><Options values={GROUPS} /></select></Field>
      <Field label="Requested component"><select value={component} onChange={e => setComponent(e.target.value)}><Options values={COMPONENTS} /></select></Field>
      <Field label="Units required"><input type="number" min={1} max={20} required value={quantity} onChange={e => setQuantity(Number(e.target.value))} /></Field>
      <Field label="Urgency"><select value="ROUTINE" disabled><Options values={["ROUTINE"]} /></select></Field>
      <Field label="Expected use (ISO with timezone)"><input required value={deadline} onChange={e => setDeadline(e.target.value)} /></Field>
      <button type="submit" className="button button-primary">Create request</button></fieldset></form><p className="source-note">Use a future time within 24 hours. This form creates routine requests. For urgent or critical emergencies, use Code Red → Durable registry. No patient details are collected.</p></details>
    <div className="workflow-section"><h3>Requests and progress</h3>{(requests.error || allocations.error) && <p role="alert">{requests.error || allocations.error}</p>}
      <div className="lab-controls"><Field label="Hospital request"><select value={requestId} onChange={e => { setRequestId(e.target.value); setSearch([]); setHistory([]); setPolicy(""); }}><option value="">Choose a request</option>{requests.rows.map(r => <option key={String(r.id)} value={String(r.id)}>{String(r.id)} · {String(r.status)} · {String(r.allocatedQuantity)}/{String(r.quantity)}</option>)}</select></Field></div>
      {requests.more}{selected && <><Records rows={[selected]} /><div className="lab-actions">
        <button type="button" className="button button-secondary" onClick={() => read("search")}>Search compatible stock</button>
        <button type="button" className="button button-primary" disabled={writes.disabled || !["OPEN", "PARTIAL"].includes(String(selected.status))} onClick={() => writes.send(`${parent}/requests/${requestId}/reserve`, {})}>Reserve next unit</button>
        <button type="button" className="button button-secondary" disabled={writes.disabled || ["CANCELLED", "COMPLETED"].includes(String(selected.status))} onClick={() => writes.send(`${parent}/requests/${requestId}/cancel`, {})}>Cancel request</button>
        <button type="button" className="button button-secondary" onClick={() => read("history")}>Load request history</button>
      </div><p className="source-note">Each reservation claims one unit. Repeat until fully allocated; a shortage remains PARTIAL or OPEN. Cancellation requires issued stock to be returned by its bank first and is blocked after synthetic use.</p>
      {policy && <><p className="source-note">{policy}</p><Records rows={search} /></>}
      {history.length > 0 && <Records rows={history} />}
      <h3>Current allocation slots</h3>{allocations.rows.filter(r => r.requestId === requestId).map(a => <div className="wave-card" key={String(a.id)}><p>{String(a.unitId)} · {String(a.status)} · lease {String(a.leaseExpiresAt)}</p>{a.status === "ISSUED" && <div className="lab-actions"><button type="button" className="button button-secondary" disabled={writes.disabled || Boolean(a.handoverAt)} onClick={() => writes.send(`${parent}/units/${a.unitId}/action`, { type: "HANDOVER" })}>Confirm handover {String(a.unitId)}</button><button type="button" className="button button-primary" disabled={writes.disabled || !a.handoverAt} onClick={() => writes.send(`${parent}/units/${a.unitId}/action`, { type: "TRANSFUSE" })}>Confirm synthetic transfusion {String(a.unitId)}</button></div>}</div>)}
      {allocations.more}<p className="source-note">Released slots may later belong to a new request; the request history retains earlier reservations and releases.</p></>}
      {readError && <p className="error-text" role="alert">{readError}</p>}
    </div>
  </>;
}
