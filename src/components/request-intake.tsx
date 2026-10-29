"use client";
import { useState } from "react";
import { COMPONENTS, GROUPS } from "@/core/domain";
import { confirmIntake, dictionaryIntake, parseIntakeDraft, type IntakeDraft } from "@/core/intelligence";
export function RequestIntake({ onConfirm }: { onConfirm?: (draft: IntakeDraft) => void }) {
  const [text, setText] = useState("O- PRBC 2 units critical within 2 hours"), [draft, setDraft] = useState<IntakeDraft | null>(null), [mode, setMode] = useState("dictionary"), [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [reviewed, setReviewed] = useState(false);
  function update(patch: Partial<IntakeDraft>) { setDraft(previous => previous ? { ...previous, ...patch } : previous); setReviewed(false); setMessage(""); }
  return <section className="panel lab-panel"><h2>Multilingual request intake</h2><p>Use synthetic requests only. English, Hindi or Hinglish; uncertain fields stay empty. The AI adapter sends your text to the configured provider; the dictionary demonstration runs in this browser.</p>
    <label>Extraction mode<select value={mode} disabled={busy} onChange={e => { setMode(e.target.value); setDraft(null); setReviewed(false); setMessage(""); }}><option value="dictionary">Offline dictionary · not AI</option><option value="ai">AI draft · hospital sign-in required</option></select></label>
    <label>Synthetic request text<textarea maxLength={600} value={text} disabled={busy} onChange={e => { setText(e.target.value); setDraft(null); setReviewed(false); setMessage(""); }} /></label>
    <p className="source-note">Try: “A+ PRBC 2 यूनिट तुरंत 2 घंटे में” or “B+ platelets 3 units jaldi 4 ghante mein”. Dictionary mode recognizes explicit symbols, product words, unit counts and hours; it cannot understand negation.</p>
    <button className="button button-secondary" disabled={busy || !text.trim()} onClick={async () => { setBusy(true); setMessage(""); setDraft(null); setReviewed(false); try {
      if (mode === "dictionary") setDraft(dictionaryIntake(text, new Date().toISOString()));
      else { const response = await fetch("/api/intelligence/intake", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(20000) }), result = await response.json(); if (!response.ok) throw new Error(result.error); setDraft(parseIntakeDraft(result.draft)); }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Draft unavailable"); } finally { setBusy(false); } }}>{busy ? "Extracting draft…" : "Extract editable draft"}</button>
    {draft && <div className="intake-draft"><h3>Unconfirmed draft</h3><p>Extraction source: {mode === "ai" ? "AI · not independently verified" : "Offline dictionary · not AI"}. Missing, conflicting or incorrect fields require editing. No confidence score is claimed.</p><ul>{draft.uncertainties.map((item, i) => <li key={i}>{item}</li>)}{Object.entries(draft).filter(([key, value]) => key !== "uncertainties" && value === null).map(([key]) => <li key={key}>Missing or ambiguous: {key}</li>)}</ul>
      <div className="lab-controls"><label>Draft blood group<select value={draft.group ?? ""} onChange={e => update({ group: e.target.value as IntakeDraft["group"] || null })}><option value="">Choose group</option>{GROUPS.map(g => <option key={g}>{g}</option>)}</select></label>
      <label>Draft component<select value={draft.component ?? ""} onChange={e => update({ component: e.target.value as IntakeDraft["component"] || null })}><option value="">Choose component</option>{COMPONENTS.map(c => <option key={c}>{c}</option>)}</select></label>
      <label>Draft quantity<input type="number" min={1} max={20} value={draft.quantity ?? ""} onChange={e => update({ quantity: Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : null })} /></label>
      <label>Draft urgency<select value={draft.urgency ?? ""} onChange={e => update({ urgency: e.target.value as IntakeDraft["urgency"] || null })}><option value="">Choose urgency</option><option>URGENT</option><option>CRITICAL</option></select></label>
      <label>Draft expected use (UTC)<input type="datetime-local" value={draft.expectedTransfusionAt?.slice(0, 16) ?? ""} onChange={e => update({ expectedTransfusionAt: e.target.value ? `${e.target.value}:00Z` : null })} /></label></div>
      <label className="review-checkbox"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} /> I reviewed every field, including urgency and UTC deadline.</label>
      <button className="button button-primary" disabled={!reviewed} onClick={() => { try { confirmIntake(draft, new Date().toISOString()); onConfirm?.(draft); setReviewed(false); setMessage(onConfirm ? "Confirmed draft copied to the emergency form. Review and queue it there." : "Draft confirmed for this local demonstration. No request has been submitted."); } catch (error) { setMessage(error instanceof Error ? error.message : "Correct the draft"); } }}>Confirm reviewed draft</button>
    </div>}
    {message && <p role="status">{message}</p>}
  </section>;
}
