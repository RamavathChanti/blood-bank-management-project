/* Public assets only. Never cache authenticated documents, API responses or sessions. */
const CACHE = "pulsegrid-donor-public-v1";
const ASSETS = ["/donor-offline.html", "/donor-192.png", "/donor-512.png", "/manifest.webmanifest"];
self.addEventListener("install", event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener("activate", event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("pulsegrid-donor-public-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== "GET") return;
  if (event.request.mode === "navigate" && url.pathname === "/donor") event.respondWith(fetch(event.request).catch(() => caches.match("/donor-offline.html")));
  else if (ASSETS.includes(url.pathname)) event.respondWith(caches.match(event.request).then(value => value || fetch(event.request)));
});
self.addEventListener("push", event => {
  let data = {}; try { data = event.data.json(); } catch { /* Generic fallback. */ }
  const alertId = typeof data.alertId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(data.alertId) ? data.alertId : "";
  event.waitUntil(self.registration.showNotification("PulseGrid synthetic donor alert", { body: "A demo request needs a response. Open the app to review.", icon: "/donor-192.png", tag: alertId || "pulsegrid", data: { url: `/donor${alertId ? `#${alertId}` : ""}` } }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = event.notification.data?.url || "/donor";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async clients => { const existing = clients.find(c => new URL(c.url).pathname === "/donor"); if (existing) { await existing.navigate(url); return existing.focus(); } return self.clients.openWindow(url); }));
});
async function withStore(mode, run) {
  const db = await new Promise((resolve, reject) => { const req = indexedDB.open("pulsegrid-donor-v1", 1); req.onupgradeneeded = () => req.result.createObjectStore("responses", { keyPath: "key" }); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  try { return await new Promise((resolve, reject) => { const tx = db.transaction("responses", mode); const req = run(tx.objectStore("responses")); tx.oncomplete = () => resolve(req.result); tx.onerror = () => reject(tx.error); }); } finally { db.close(); }
}
async function syncReplies() {
  const res = await fetch("/api/donor/me", { cache: "no-store" });
  if (!res.ok && res.status !== 401) throw new Error("Session check unavailable");
  const own = res.ok ? (await res.json()).donor.id : null;
  for (const item of await withStore("readonly", store => store.getAll())) {
    if (item.state !== "PENDING") continue;
    let state = "TOO_LATE";
    if (own === item.donorId) {
      const { key, alertId, reply } = item;
      const response = await fetch("/api/donor/reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, alertId, reply }), cache: "no-store" });
      if (!response.ok && ![400, 401, 403, 409].includes(response.status)) throw new Error("Response temporarily unavailable");
      if (response.ok) state = (await response.json()).state;
    }
    await withStore("readwrite", store => store.put({ ...item, state }));
  }
  for (const client of await self.clients.matchAll({ type: "window" })) client.postMessage("donor-sync-complete");
}
self.addEventListener("sync", event => { if (event.tag === "pulsegrid-donor-replies") event.waitUntil(syncReplies()); });
