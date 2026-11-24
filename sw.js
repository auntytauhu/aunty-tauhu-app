/* Aunty Tauhu service worker: shows push notifications (new pre-orders, daily shopping list)
   and opens the app on the right page when one is tapped.
   No caching here, so app updates always load straight away. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: "Aunty Tauhu", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Aunty Tauhu", {
    body: d.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: d.tag || "restock",
    renotify: true,
    data: { url: d.url || "./#restock" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./#restock", self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = url.includes("#pre") ? "pre" : "restock";
    for (const w of wins) { w.postMessage({ open }); if ("focus" in w) return w.focus(); }
    return self.clients.openWindow(url);
  })());
});
