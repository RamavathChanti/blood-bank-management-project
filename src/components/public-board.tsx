"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { COMPONENTS, GROUPS } from "@/core/domain";
import { cacheObservation, PUBLIC_DISTRICTS, type PublicBoard as Board } from "@/core/public-board";
import { useLiveRefresh } from "@/lib/live-updates";

export function PublicBoard({ compact = false }: { compact?: boolean }) {
  const fieldId = useId();
  const [board, setBoard] = useState<Board | null>(null), [error, setError] = useState("");
  const [cache, setCache] = useState("unknown"), [age, setAge] = useState(0);
  const [group, setGroup] = useState("ALL"), [component, setComponent] = useState("PRBC");
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    let observed = "unknown";
    try {
      const response = await fetch("/api/public-board", { credentials: "omit", signal: AbortSignal.timeout(10_000) });
      const value = await response.json();
      if (version !== generation.current) return;
      observed = cacheObservation(response.headers); setCache(observed);
      if (!response.ok) throw new Error("The public registry aggregate is unavailable.");
      setBoard(value); setAge(Math.max(0, Math.floor((Date.now() - Date.parse(value.generatedAt)) / 1000))); setError(""); return true;
    } catch {
      if (version === generation.current) { setCache(observed); setError("Refresh unavailable. Any previous snapshot is last known data; availability must be confirmed by a bank."); }
      return false;
    }
  }, []);
  const live = useLiveRefresh(refresh, true, "public-board", 15_000);
  useEffect(() => {
    if (!board) return;
    const timer = setInterval(() => setAge(Math.max(0, Math.floor((Date.now() - Date.parse(board.generatedAt)) / 1000))), 1000);
    return () => clearInterval(timer);
  }, [board]);
  useEffect(() => () => { generation.current++; }, []);
  return <section className="panel lab-panel public-board" aria-label="Public registry availability">
    <div className="panel-heading"><h2>{compact ? "Registry availability" : "District availability"}</h2><span className="mono" aria-label="Observed CDN cache">CDN cache: {cache}</span></div>
    <p>Live synthetic registry · public district bands · bounded polling fallback. Freshness target: approximately 30 seconds.</p>
    {board ? <p role="status">Snapshot {board.generatedAt} · age {age}s · {error || age > 30 ? "Last known / stale" : "Within freshness target"}</p> : <p role="status">NO LIVE DATA · {error ? "No last-good snapshot is available in this browser." : "Loading public aggregate…"}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="lab-controls"><div><label htmlFor={`${fieldId}-group`}>Public group</label><select id={`${fieldId}-group`} value={group} onChange={event => setGroup(event.target.value)}><option value="ALL">All groups</option>{GROUPS.map(value => <option key={value}>{value}</option>)}</select></div><div><label htmlFor={`${fieldId}-component`}>Public component</label><select id={`${fieldId}-component`} value={component} onChange={event => setComponent(event.target.value)}>{COMPONENTS.map(value => <option key={value}>{value}</option>)}</select></div></div>
    {board && <div className="table-scroll"><table className="registry-table"><caption>Availability bands by district, group and component</caption><thead><tr><th scope="col">District</th>{GROUPS.filter(value => group === "ALL" || value === group).map(value => <th scope="col" key={value}>{value}</th>)}</tr></thead><tbody>{PUBLIC_DISTRICTS.map(district => <tr key={district}><th scope="row">{district}</th>{GROUPS.filter(value => group === "ALL" || value === group).map(value => <td key={value}>{board.cells.find(cell => cell.district === district && cell.group === value && cell.component === component)?.band ?? "unknown"}</td>)}</tr>)}</tbody></table></div>}
    <p className="source-note">NONE · LOW · MODERATE · HIGH are broad teaching bands. No donor details or exact inventory counts. This snapshot cannot reserve stock. CDN status comes only from the resource’s x-vercel-cache response header; local and unsupported hosts show unknown.</p>
    <button className="button button-secondary" onClick={() => { live.resume(); }}>{live.paused ? "Resume public updates" : "Refresh public snapshot"}</button><p>{live.paused ? "Automatic updates paused after 120 attempts." : "Checks every 15 seconds while visible; backs off during failures."}</p>
  </section>;
}
