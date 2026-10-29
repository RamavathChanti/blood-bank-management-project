"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import { DEMO_SITES, type DonorView, type QueuedReply } from "@/core/donor-app";
import { GROUPS } from "@/core/domain";
import { clearResponses, queuedResponses, saveResponse, syncResponses } from "@/lib/donor-queue";
import { announceRegistryChange, useLiveRefresh } from "@/lib/live-updates";

async function post(path: string, body: unknown) {
  const res = await fetch(`/api/donor/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(10_000) });
  const result = await res.json(); if (!res.ok) throw new Error(result.error); return result;
}
function AlertDialog({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} aria-label="Full-screen donor alert" className="donor-overlay" onCancel={onClose}><button autoFocus className="button-secondary" onClick={onClose}>Close alert</button>{children}</dialog>;
}
export function DonorApp() {
  const [view, setView] = useState<DonorView | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [notice, setNotice] = useState(""), [group, setGroup] = useState("O-"), [site, setSite] = useState("Pune"), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<QueuedReply[]>([]), [selected, setSelected] = useState<string | null>(null), [joinUrl, setJoinUrl] = useState("");
  const qr = useRef<HTMLCanvasElement>(null), generation = useRef(0), joined = useRef(false);
  const refresh = useCallback(async () => {
    const version = generation.current;
    try {
      const res = await fetch("/api/donor/me", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (res.status === 401) { if (version === generation.current) { setView(null); if (joined.current) { setNotice("Your donor session expired or was deleted. Pending responses cannot be applied."); await clearResponses(); setQueue([]); } joined.current = false; setError(""); } return false; }
      if (!res.ok) throw new Error((await res.json()).error);
      const data = await res.json() as DonorView;
      if (version !== generation.current) return false;
      joined.current = true; setView(data); setError("");
      await syncResponses(data.donor.id);
      if (version === generation.current) setQueue((await queuedResponses()).filter(i => i.donorId === data.donor.id));
      return true;
    } catch (e) { if (version === generation.current) setError(`Live donor status unavailable: ${e instanceof Error ? e.message : "offline"}. Pending replies stay on this device.`); return false; }
    finally { if (version === generation.current) setLoading(false); }
  }, []);
  const live = useLiveRefresh(refresh, true, "audience-donor");
  useEffect(() => {
    if (qr.current) void QRCode.toCanvas(qr.current, `${location.origin}/donor`, { width: 200, margin: 2, errorCorrectionLevel: "M" }).then(() => {
      setJoinUrl(`${location.origin}/donor`);
      if (/^#[A-Za-z0-9_-]{1,128}$/.test(location.hash)) setSelected(location.hash.slice(1));
    }).catch(() => setNotice("QR unavailable. Share the /donor address directly."));
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/donor-sw.js", { scope: "/" }).catch(() => setNotice("Offline installation unavailable. You can still use the in-app alerts online."));
    const changed = () => { void refresh(); };
    navigator.serviceWorker?.addEventListener("message", changed);
    return () => navigator.serviceWorker?.removeEventListener("message", changed);
  }, [refresh]);
  const action = async (fn: () => Promise<void>) => { setBusy(true); setError(""); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "Action unavailable"); } finally { setBusy(false); } };
  const reply = (alertId: string, value: "ACCEPTED" | "DECLINED") => action(async () => {
    if (!view) return;
    const existing = (await queuedResponses()).find(q => q.donorId === view.donor.id && q.alertId === alertId);
    if (!existing) await saveResponse({ key: crypto.randomUUID(), donorId: view.donor.id, alertId, reply: value, state: "PENDING" });
    await syncResponses(view.donor.id); setQueue((await queuedResponses()).filter(q => q.donorId === view.donor.id)); announceRegistryChange(); await refresh();
  });
  const enablePush = () => action(async () => {
    if (!view?.pushPublicKey) { setNotice("Push is not configured. Keep this screen open for in-app alerts."); return; }
    if (!("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator)) { setNotice("Push is unsupported here. Use in-app alerts. On iPhone, install to the Home Screen first."); return; }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") { setNotice("Notifications denied or dismissed. In-app alerts remain available; permission can be changed in browser settings."); return; }
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Offline worker unavailable. Use in-app alerts.")), 10_000))]);
    let existing = await reg.pushManager.getSubscription();
    if (existing && view.donor.pushState === "EXPIRED") { await existing.unsubscribe(); existing = null; }
    const subscription = existing ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: view.pushPublicKey });
    await post("subscription", subscription.toJSON()); setNotice("Push enabled. In-app alerts also remain available."); await refresh();
  });
  const alert = view?.alerts.find(a => a.id === selected);
  const alertCard = (a: NonNullable<DonorView>["alerts"][number]) => {
    const receipt = queue.find(q => q.alertId === a.id), pending = a.status === "PENDING" && !view?.donor.optedOut;
    return <article className="donor-alert" key={a.id}><span className="eyebrow">SYNTHETIC REQUEST</span><h3>{a.group} · {a.component} · {a.quantity} unit(s)</h3><p>{a.collection}</p><p className="mono donor-request-id">Request: {a.requestId}</p><p>Respond by {new Date(a.deadlineAt).toLocaleString()}</p><p role="status">{receipt ? receipt.state === "PENDING" ? "Pending — saved on this device; awaiting server receipt." : receipt.state === "RECEIVED" ? `Received — ${receipt.reply === "ACCEPTED" ? "accepted" : "declined"}.` : "Too late — this response was not applied." : a.status}</p><div className="donor-actions"><button className="button-primary" disabled={!pending || busy || Boolean(receipt)} onClick={() => void reply(a.id, "ACCEPTED")}>Accept</button><button className="button-secondary" disabled={!pending || busy || Boolean(receipt)} onClick={() => void reply(a.id, "DECLINED")}>Decline</button>{!selected && <button className="button-secondary" onClick={() => setSelected(a.id)}>Open full-screen alert</button>}</div><p className="muted">Acceptance means willingness to join the demo. It does not create screened stock.</p></article>;
  };
  return <div className="donor-page"><header><p className="eyebrow">AUDIENCE PARTICIPATION · 24-HOUR SESSION</p><h1>Play a donor. Join the response.</h1><p>Teaching model, not clinical software. Use a pretend group and a demo location. No real health data, phone number, email, or device location is requested.</p></header>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {loading ? <p role="status">Checking donor session…</p> : view ? <section className="donor-panel" aria-label="Your donor session"><h2>{view.donor.nickname} · {view.donor.group}</h2><p>Next eligible date (mock): {new Date(view.donor.eligibleFrom).toLocaleString()}</p><p>Automatic expiry: {new Date(view.donor.expireAt).toLocaleString()}</p><p>{view.donor.optedOut ? "Opted out — no new alerts." : "In-app alerts active"} · Push: {view.donor.pushState}</p><div className="donor-actions"><button className="button-primary" disabled={busy || view.donor.optedOut} onClick={() => void enablePush()}>Enable notifications</button><button className="button-secondary" onClick={() => { live.resume(); void refresh(); }}>Sync responses / refresh</button><button className="button-secondary" disabled={busy || view.donor.optedOut} onClick={() => void action(async () => { await post("opt-out", {}); await clearResponses(); setQueue([]); await refresh(); })}>Opt out</button><button className="button-secondary" disabled={busy} onClick={() => void action(async () => { generation.current++; await post("delete", {}); joined.current = false; setView(null); setSelected(null); await clearResponses(); setQueue([]); setNotice("Demo donor, encrypted subscription, alerts and response receipts deleted."); })}>Delete my demo donor</button></div>{live.paused && <p>Automatic updates paused. Use Sync responses / refresh to resume.</p>}
      <h2>Your alerts</h2>{view.alerts.length ? view.alerts.map(alertCard) : <p>No alerts yet. Keep this screen open while the presenter starts a compatible nearby Code Red shortage.</p>}</section> : <form className="donor-panel" onSubmit={e => { e.preventDefault(); void action(async () => { generation.current++; await clearResponses(); await post("register", { group, site, consent }); await refresh(); }); }}><h2>Join with synthetic details</h2><p>Your nickname and eligibility profile are generated for the demo. The selected city is a fixed fictional meeting point.</p><label>Pretend blood group<select value={group} onChange={e => setGroup(e.target.value)}>{GROUPS.map(g => <option key={g}>{g}</option>)}</select></label><label>Demo location<select value={site} onChange={e => setSite(e.target.value)}>{Object.keys(DEMO_SITES).map(s => <option key={s}>{s}</option>)}</select></label><label className="donor-consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} required />I agree to synthetic demo participation. My donor and encrypted push subscription expire after 24 hours; I can opt out or delete now.</label><button className="button-primary" disabled={!consent || busy}>Join the demo</button></form>}
    <section className="donor-panel" aria-label="Install and share"><h2>Bring the demo to your phone</h2><div className="donor-share"><canvas ref={qr} aria-label="QR code for demo donor registration" role="img" /><div><a href={joinUrl}>{joinUrl || "/donor"}</a><p>Scan this QR on the shared HTTPS deployment. A localhost address works only on this computer.</p><p><strong>Android Chrome:</strong> open the menu → Install app / Add to Home screen → open PulseGrid → Enable notifications.</p><p><strong>iPhone (iOS 16.4+):</strong> Safari → Share → Add to Home Screen → open from that icon → Enable notifications.</p><p>Permission is optional. In-app alerts work without push. Offline replies show Pending until this app reconnects; iOS may require reopening the app to sync.</p></div></div></section>
    {alert && <AlertDialog onClose={() => setSelected(null)}>{alertCard(alert)}</AlertDialog>}
  </div>;
}
