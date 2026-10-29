"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { UserButton, useAuth } from "@clerk/nextjs";
import { PortalWorkflow } from "./portal-workflows";
import { OpsCopilot } from "./ops-copilot";
import { BankWatchdog } from "./bank-watchdog";
import { RegistryForecast } from "./registry-forecast";
import { announceRegistryChange, useLiveRefresh } from "@/lib/live-updates";

type Role = "BANK" | "HOSPITAL" | "DONOR" | "STATE_ADMIN";
type Row = Record<string, unknown>;
type Member = { role: Role; bankId?: string; hospitalId?: string; donorId?: string };
type Payload = { identity?: Member; record?: Row; records?: Row[]; next?: string | null };
class RegistryApiError extends Error { constructor(message: string, public status: number) { super(message); } }
async function api(path: string, body?: unknown): Promise<Payload> {
  const response = await fetch(`/api/registry/${path}`, { cache: "no-store", signal: AbortSignal.timeout(10_000), ...(body ? { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new RegistryApiError(`${result.error} · reference ${result.requestId}`, response.status);
  if (body) announceRegistryChange();
  return result;
}
const columns = ["id", "name", "nickname", "district", "unitId", "requestId", "group", "component", "status", "action", "from", "to", "at", "quantity", "allocatedQuantity", "transfusedQuantity", "available", "expiresAt", "expectedTransfusionAt", "leaseExpiresAt", "handoverAt", "eligibleFrom", "expireAt"];
function Records({ rows }: { rows: Row[] }) {
  if (!rows.length) return <p>No records in this authenticated scope.</p>;
  const keys = columns.filter(key => rows.some(row => key in row));
  return <div style={{ overflowX: "auto" }}><table className="registry-table"><thead><tr>{keys.map(key => <th key={key} scope="col">{key}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={String(row.id)}>{keys.map(key => <td key={key}>{String(row[key] ?? "—")}</td>)}</tr>)}</tbody></table></div>;
}
function Portal({ role, configured }: { role: Role; configured: boolean }) {
  const [member, setMember] = useState<Member | null>(null), [profile, setProfile] = useState<Row | null>(null);
  const [resource, setResource] = useState(role === "BANK" ? "units" : role === "HOSPITAL" ? "requests" : role === "DONOR" ? "alerts" : "banks");
  const [rows, setRows] = useState<Row[]>([]), [next, setNext] = useState<string | null>(null), [error, setError] = useState("");
  const [loading, setLoading] = useState(configured), [name, setName] = useState(""), [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const refreshVersion = useRef(0);
  const changed = useCallback(() => setRevision(n => n + 1), []);
  const title = role === "BANK" ? "Bank portal" : role === "HOSPITAL" ? "Hospital portal" : role === "DONOR" ? "Donor portal" : "State registry";
  const parent = member?.role === "BANK" ? `banks/${member.bankId}` : member?.role === "HOSPITAL" ? `hospitals/${member.hospitalId}` : member?.role === "DONOR" ? `donors/${member.donorId}` : "state";
  useEffect(() => {
    if (!configured) return;
    let active = true;
    api("me").then(async result => {
      if (!active) return;
      if (result.identity?.role !== role) throw new Error("This portal requires the corresponding server-assigned role. Use your assigned portal.");
      setMember(result.identity);
      if (role !== "STATE_ADMIN") {
        const m = result.identity;
        const path = role === "BANK" ? `banks/${m.bankId}` : role === "HOSPITAL" ? `hospitals/${m.hospitalId}` : `donors/${m.donorId}`;
        const p = await api(path);
        if (active) { setProfile(p.record!); setName(String(p.record?.name ?? p.record?.nickname ?? "")); }
      }
    }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [configured, role]);
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      const result = await api(`${parent}/${resource}`);
      if (version === refreshVersion.current) { setRows(result.records ?? []); setNext(result.next ?? null); setError(""); }
      return true;
    } catch (cause) {
      if (version === refreshVersion.current) {
        if (cause instanceof RegistryApiError && [401, 403].includes(cause.status)) { setRows([]); setProfile(null); setMember(null); }
        setError(`${(cause as Error).message}. Refresh failed; retry to reconcile.`);
      }
      return false;
    }
  }, [parent, resource]);
  const live = useLiveRefresh(refresh, !!member, `${parent}/${resource}/${revision}`);
  useEffect(() => () => { refreshVersion.current++; }, [parent, resource]);
  const choices = role === "BANK" ? ["units", "stock", "unitEvents", "allocations"] : role === "HOSPITAL" ? ["requests", "allocations"] : role === "DONOR" ? ["alerts"] : ["banks", "hospitals", "units", "unitEvents", "requests", "allocations", "donors", "stock", "alerts"];
  return <><div className="page-heading"><div><p className="eyebrow">ATLAS REGISTRY / STAGE 6</p><h1>{title}</h1><p className="page-description">Synthetic registry data. Access follows your server-assigned membership.</p></div>{configured && <UserButton />}</div>
    {!configured ? <section className="panel feature-panel registry-panel"><h2>{role === "BANK" ? "Bank access is not configured" : "Registry access is not configured"}</h2><p>Configure Clerk and Atlas using the registry setup guide. Private APIs fail closed while services are unavailable.</p></section> : <>
      <p><Link href="/sign-in">Sign in</Link> · <Link href="/bank">Bank</Link> · <Link href="/hospital">Hospital</Link> · <Link href="/donor">Donor</Link> · <Link href="/registry">State admin</Link></p>
      {loading && <p role="status">Checking authenticated membership…</p>}{error && <div className="notice" role="alert"><p>{error}</p><button className="button button-secondary" onClick={() => window.location.reload()}>Retry</button></div>}
      {member && <><p role="status">Private updates: {live.paused ? "paused after 120 attempts" : "bounded polling every five seconds while visible"}. Reconnect fetches current authorized records.</p><button className="button button-secondary" onClick={live.resume}>Refresh private records</button><section className="panel feature-panel registry-panel"><h2>Authorized scope · {member.role}</h2>{profile && <><Records rows={[profile]} /><form onSubmit={async event => {
        event.preventDefault(); setNotice(""); setError("");
        try { const result = await api(parent, role === "DONOR" ? { nickname: name } : { name }); setProfile(result.record!); setNotice("Synthetic display name saved in Atlas."); } catch (e) { setError((e as Error).message); }
      }}><label htmlFor="registry-name">Synthetic display name</label><input id="registry-name" value={name} maxLength={80} required onChange={e => setName(e.target.value)} /><button className="button button-secondary" type="submit">Save display name</button></form></>}{notice && <p role="status">{notice}</p>}</section>
      {(role === "BANK" || role === "HOSPITAL") && <PortalWorkflow parent={parent} role={role} onChanged={changed} />}
      {role === "BANK" && member?.bankId && <BankWatchdog bankId={member.bankId} onChanged={changed} />}
      {role === "STATE_ADMIN" && <><RegistryForecast /><OpsCopilot registry /></>}
      <section className="panel feature-panel registry-panel"><h2>Private records</h2><label htmlFor="registry-resource">Collection</label><select id="registry-resource" value={resource} onChange={e => { setRows([]); setNext(null); setError(""); setResource(e.target.value); }}>{choices.map(item => <option key={item}>{item}</option>)}</select><Records rows={rows} />{next && <button className="button button-secondary" onClick={async () => {
        const version = refreshVersion.current;
        try { const result = await api(`${parent}/${resource}?after=${encodeURIComponent(next)}`); if (version !== refreshVersion.current) return; setRows(current => [...current, ...result.records ?? []]); setNext(result.next ?? null); } catch (e) { if (version === refreshVersion.current) setError((e as Error).message); }
      }}>Load more</button>}</section></>}
    </>}
    <div className="notice"><p>Bank and Hospital actions use the authenticated registry. Simulation controls use separate browser fixtures. Teaching model, not clinical software.</p></div></>;
}

function ConfiguredPortal({ role }: { role: Role }) {
  const { userId, isLoaded } = useAuth();
  // Discard all fetched tenant records when the authenticated account changes.
  return isLoaded ? <Portal key={userId ?? "signed-out"} role={role} configured /> : <p role="status">Loading registry session…</p>;
}
export function RegistryPortal({ role, configured }: { role: Role; configured: boolean }) {
  return configured ? <ConfiguredPortal role={role} /> : <Portal role={role} configured={false} />;
}
