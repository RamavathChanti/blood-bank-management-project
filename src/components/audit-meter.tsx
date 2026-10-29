"use client";
import { useState } from "react";
import Link from "next/link";
import type { AuditReport } from "@/server/audit-jobs";
type Status = { report: AuditReport | null; alert: AuditReport | null; anchor: { day: string; merkleRoot: string; count: number; external: { status: string } | null; verification: { ok: boolean; reason: string } } | null };
export function AuditMeter() {
  const [data, setData] = useState<Status | null>(null), [message, setMessage] = useState("State-admin sign-in required for registry checks."), [busy, setBusy] = useState(false);
  async function load(verify: boolean) {
    setBusy(true); setMessage("");
    try {
      if (verify) {
        const response = await fetch("/api/audit/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(30000) });
        const value = await response.json(); if (!response.ok) throw new Error(value.error);
      }
      const response = await fetch("/api/audit/status", { cache: "no-store", signal: AbortSignal.timeout(30000) }), value = await response.json();
      if (!response.ok) throw new Error(value.error);
      setData(value); if (!value.report) setMessage("No completed registry verification yet.");
    } catch (error) { setData(null); setMessage(error instanceof Error ? error.message : "Audit unavailable"); }
    finally { setBusy(false); }
  }
  return <section className="panel lab-panel audit-meter"><h2>Registry integrity</h2><p>Last completed snapshot check. <Link href="/unit-passport">Inspect a Unit Passport</Link>.</p><div className="lab-actions"><button className="button button-secondary" disabled={busy} onClick={() => void load(false)}>Refresh integrity meter</button><button className="button button-secondary" disabled={busy} onClick={() => void load(true)}>Verify registry now</button></div><p role="status">{busy ? "Checking private registry…" : message}</p>{data?.report && <div role={data.report.ok ? "status" : "alert"}><strong>{data.report.valid} / {data.report.checked} units valid · {data.report.ok ? "PASS" : "INTEGRITY ALARM"}</strong><p>Checked {data.report.at} · Orphan histories: {data.report.orphanEvents}</p>{data.report.failed.map(f => <p className="workflow-identifier" key={f.unitId}>{f.unitId}: chain {f.chain}, signature {f.signature}, state {f.state}, first affected record {f.firstBadSeq ?? "none"}</p>)}</div>}{data?.alert && <p role="alert">Last recorded admin alert: {data.alert.at}. {data.alert.failed.length} failed units; {data.alert.orphanEvents} orphan histories. Retained for investigation even after a clean check.</p>}{data?.anchor && <p className="workflow-identifier">Anchor {data.anchor.day} · {data.anchor.count} units · {data.anchor.merkleRoot} · {data.anchor.verification.reason} · External publication: {data.anchor.external?.status ?? "not published"}</p>}</section>;
}
