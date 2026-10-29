"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const eventName = "pulsegrid-registry-invalidated";
const channelName = "pulsegrid-refresh-v1";
export function announceRegistryChange() {
  window.dispatchEvent(new Event(eventName));
  try { const channel = new BroadcastChannel(channelName); channel.postMessage("refresh"); channel.close(); } catch { /* Timed polling remains available. */ }
}

// Refresh hints carry no records, request IDs, tenant IDs, tokens or receipts.
// Every receiver fetches authoritative data using its own current session.
export function useLiveRefresh(refresh: () => Promise<boolean | void>, enabled: boolean, scope: string, interval = 5000) {
  const callback = useRef(refresh);
  const [paused, setPaused] = useState(false), [epoch, setEpoch] = useState(0);
  useEffect(() => { callback.current = refresh; }, [refresh]);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false, busy = false, attempts = 0, failures = 0, last = 0;
    let hintsEnabled = false, gateReadAt = 0;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => { timer = setTimeout(() => void run(), Math.min(30_000, interval * 2 ** failures)); };
    async function run() {
      if (stopped || busy) return;
      if (document.visibilityState !== "visible" || !navigator.onLine) { schedule(); return; }
      if (attempts >= 120) { setPaused(true); return; }
      busy = true; attempts++; last = Date.now();
      try {
        if (Date.now() - gateReadAt > 15_000) {
          try {
            const response = await fetch("/api/refresh-hints", { cache: "no-store", signal: AbortSignal.timeout(2500) });
            hintsEnabled = response.ok && (await response.json()).hintsEnabled === true;
          } catch { hintsEnabled = false; }
          gateReadAt = Date.now();
        }
        failures = await callback.current() === false ? Math.min(failures + 1, 3) : 0;
      }
      catch { failures = Math.min(failures + 1, 3); }
      finally { busy = false; if (!stopped) schedule(); }
    }
    const reconcile = () => {
      if (stopped || busy || attempts >= 120 || Date.now() - last < 1000) return;
      clearTimeout(timer); void run();
    };
    const hint = () => { if (hintsEnabled) reconcile(); };
    let channel: BroadcastChannel | undefined;
    try { channel = new BroadcastChannel(channelName); channel.onmessage = message => { if (message.data === "refresh") hint(); }; } catch { /* polling fallback */ }
    window.addEventListener("online", reconcile); window.addEventListener("focus", reconcile);
    window.addEventListener(eventName, hint); document.addEventListener("visibilitychange", reconcile);
    timer = setTimeout(() => { setPaused(false); void run(); }, 0);
    return () => {
      stopped = true; clearTimeout(timer); channel?.close();
      window.removeEventListener("online", reconcile); window.removeEventListener("focus", reconcile);
      window.removeEventListener(eventName, hint); document.removeEventListener("visibilitychange", reconcile);
    };
  }, [enabled, scope, interval, epoch]);
  const resume = useCallback(() => setEpoch(value => value + 1), []);
  return { paused, resume };
}
