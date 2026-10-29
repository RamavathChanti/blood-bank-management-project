"use client";
import { useState } from "react";
import { OPS_TEMPLATES, opsAnswer, type OpsTemplate } from "@/core/intelligence";
import { DEFAULT_WASTE, makeWasteTape, WasteRun } from "@/core/waste-simulation";
export function OpsCopilot({ registry = false }: { registry?: boolean }) {
  const [template, setTemplate] = useState<OpsTemplate>("SHORTAGES"), [result, setResult] = useState<Record<string, unknown> | null>(null), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  return <section className="panel lab-panel"><h2>Read-only ops copilot</h2><p>{registry ? "Authorized state-admin forecast aggregates. No raw donor records or data sent to an AI provider." : "Offline synthetic aggregate demonstration. Sign in to the State registry for authorized stored forecasts."} Fixed templates keep every answer inspectable; no free-form database queries or write tools. This template assistant does not use an LLM.</p>
    <label>Safe query template<select value={template} onChange={e => { setTemplate(e.target.value as OpsTemplate); setResult(null); setMessage(""); }}>{OPS_TEMPLATES.map(t => <option key={t}>{t}</option>)}</select></label>
    <button className="button button-secondary" disabled={busy} onClick={async () => { setBusy(true); setResult(null); setMessage(""); try {
      if (registry) { const response = await fetch("/api/intelligence/ops", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ template }), signal: AbortSignal.timeout(10000) }), data = await response.json(); if (!response.ok) throw new Error(data.error); if (!data.result) setMessage(data.reason); else setResult(data); }
      else { const tape = makeWasteTape(DEFAULT_WASTE), run = new WasteRun("FEFO", tape); setResult({ source: "LOCAL_SYNTHETIC_AGGREGATES", snapshotAt: run.now, result: opsAnswer(template, run.weather(), run.transfers) }); }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Forecast unavailable"); } finally { setBusy(false); } }}>Inspect aggregate answer</button>
    <p role="status">{message}</p>{result && <><p>{String((result.result as { summary: string }).summary)}</p><details open><summary>Inspect template, snapshot and result</summary><pre className="extras-json">{JSON.stringify(result, null, 2)}</pre></details></>}
  </section>;
}
