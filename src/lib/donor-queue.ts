import type { QueuedReply } from "../core/donor-app";
const databaseName = "pulsegrid-donor-v1";
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("responses", { keyPath: "key" });
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("Offline storage unavailable. Stay online to respond."));
  });
}
export async function queuedResponses(): Promise<QueuedReply[]> {
  const db = await database();
  try { return await new Promise((resolve, reject) => { const req = db.transaction("responses").objectStore("responses").getAll(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
  finally { db.close(); }
}
export async function saveResponse(reply: QueuedReply) {
  const db = await database();
  try { await new Promise<void>((resolve, reject) => { const tx = db.transaction("responses", "readwrite"); tx.objectStore("responses").put(reply); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); }
  finally { db.close(); }
  try { const reg = await navigator.serviceWorker?.getRegistration(); if (reg && "sync" in reg) await (reg as ServiceWorkerRegistration & { sync: { register: (tag: string) => Promise<void> } }).sync.register("pulsegrid-donor-replies"); } catch { /* Foreground sync is supported independently. */ }
}
export async function clearResponses() {
  const db = await database();
  try { await new Promise<void>((resolve, reject) => { const tx = db.transaction("responses", "readwrite"); tx.objectStore("responses").clear(); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); } finally { db.close(); }
}
let syncing: Promise<void> | undefined;
export function syncResponses(donorId: string) {
  if (syncing) return syncing;
  syncing = (async () => {
    for (const item of await queuedResponses()) {
      if (item.state !== "PENDING") continue;
      if (item.donorId !== donorId) { await saveResponse({ ...item, state: "TOO_LATE", message: "Previous donor session ended." }); continue; }
      try {
        const { key, alertId, reply } = item;
        const res = await fetch("/api/donor/reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, alertId, reply }), cache: "no-store", signal: AbortSignal.timeout(10_000) });
        const body = await res.json();
        if (res.ok) await saveResponse({ ...item, state: body.state });
        else if ([400, 401, 403, 409].includes(res.status)) await saveResponse({ ...item, state: "TOO_LATE", message: body.error });
        else break;
      } catch { break; }
    }
  })().finally(() => { syncing = undefined; });
  return syncing;
}
