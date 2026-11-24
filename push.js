/* =====================================================================
   AUNTY TAUHU — DAILY SHOPPING LIST NOTIFICATION (5:00 PM)
   Each phone turns it on once (Stock → Restock list). The phone's push
   address is saved in Supabase (push_subs); every day at 5 PM a Supabase
   job sends the restock list to all phones that turned it on.
   ===================================================================== */
"use strict";
const PUSH_VAPID_PUBLIC = "BMLZJEjBQDKoYdrQ9IdfkHy-jMSL3BjuONHufeyf6rnRD9ss1GYYZ8JTlJnMG070tRcJH4ZtEWGk1wIPq_UXOQc";
const Push = {
  st: "checking", reg: null, busy: false, prefs: { orders: true, restock: true },
  standalone() { return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true; },
  supported() { return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; },
  async init() {
    if (!("serviceWorker" in navigator)) { this.st = "unsupported"; return; }
    try {
      this.reg = await navigator.serviceWorker.register("sw.js", { scope: "./" });
      navigator.serviceWorker.addEventListener("message", (e) => { if (e.data && e.data.open === "restock") Push.openRestock(); if (e.data && e.data.open === "pre") Push.openPre(); });
      if (!this.supported()) { this.st = "unsupported"; return this.redraw(); }
      const s = await this.reg.pushManager.getSubscription();
      this.st = Notification.permission === "denied" ? "denied" : s ? "on" : "off";
      if (s && API.me) { await this.loadPrefs(s).catch(() => {}); this.save(s).catch(() => {}); } /* keep the saved address fresh */
    } catch (e) { console.warn("push init", e); this.st = "unsupported"; }
    this.redraw();
  },
  redraw() { if (ui.screen === "app" && !ui.sheet && (ui.tab === "pre" || (ui.tab === "stock" && ui.inv === "restock"))) render(); },
  openPre() { if (ui.screen !== "app") return; ui.tab = "pre"; ui.sheet = null; render(); },
  async loadPrefs(s) { const { data } = await Sync.sb.from("push_subs").select("data").eq("id", await this.id(s.endpoint)).maybeSingle(); if (data && data.data && data.data.prefs) this.prefs = Object.assign({ orders: true, restock: true }, data.data.prefs); },
  async pref(k) { if (this.busy) return; this.busy = true; const was = this.prefs[k];
    try { this.prefs = { ...this.prefs, [k]: !was }; const reg = this.reg || await navigator.serviceWorker.ready, s = await reg.pushManager.getSubscription(); if (s) await this.save(s); toast(`${k === "orders" ? "New pre-order" : "Shopping list"} notifications ${this.prefs[k] ? "on" : "off"} for this phone`); }
    catch (e) { console.error(e); this.prefs = { ...this.prefs, [k]: was }; toast("Couldn't change it. Try again.", true); }
    finally { this.busy = false; this.redraw(); } },
  openRestock() { if (ui.screen !== "app") return; ui.tab = "stock"; ui.inv = "restock"; ui.sheet = null; render(); },
  key() { const s = atob(PUSH_VAPID_PUBLIC.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - PUSH_VAPID_PUBLIC.length % 4) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)); },
  async id(endpoint) { const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)); return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40); },
  async save(s) {
    const j = s.toJSON(), id = await this.id(j.endpoint);
    const { error } = await Sync.sb.from("push_subs").upsert({ id, data: { endpoint: j.endpoint, keys: j.keys, prefs: this.prefs, uid: API.me.id, name: API.me.name, role: API.me.role, ua: navigator.userAgent.slice(0, 140), at: Date.now() } });
    if (error) throw error;
  },
  /* must start from a tap (iPhone only asks for permission after a tap) */
  async on() {
    if (this.busy) return; this.busy = true;
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { this.st = perm === "denied" ? "denied" : "off"; toast("Notifications were not allowed", true); return; }
      const reg = this.reg || await navigator.serviceWorker.ready;
      const s = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: this.key() });
      await this.save(s); this.st = "on"; toast("Notifications are on for this phone.");
      API.log("Notifications turned on", `${API.me.name} (${API.me.role}): ${[this.prefs.orders ? "new pre-orders" : "", this.prefs.restock ? "5 PM shopping list" : ""].filter(Boolean).join(", ")}`);save();
    } catch (e) { console.error(e); toast("Couldn't turn on notifications. Check your connection and try again.", true); }
    finally { this.busy = false; this.redraw(); }
  },
  async off() {
    if (this.busy) return; this.busy = true;
    try {
      const reg = this.reg || await navigator.serviceWorker.ready, s = await reg.pushManager.getSubscription();
      if (s) { const id = await this.id(s.endpoint); await Sync.sb.from("push_subs").delete().eq("id", id); await s.unsubscribe(); }
      this.st = "off"; toast("Notifications turned off for this phone");
    } catch (e) { console.error(e); toast("Couldn't turn off. Try again.", true); }
    finally { this.busy = false; this.redraw(); }
  },
  async test() {
    if (this.busy) return; this.busy = true;
    try {
      const { data, error } = await Sync.sb.functions.invoke("daily-restock-push", { body: { mode: "test" } });
      if (error) throw error;
      toast(data && data.sent ? "Test sent. It should appear in a few seconds." : "No notification was sent. Turn notifications on first.", !(data && data.sent));
    } catch (e) { console.error(e); toast("Couldn't send the test. Try again.", true); }
    finally { this.busy = false; }
  },
  /* p = the page's click prefix ("inv" on the Restock list, "pre" on Pre-orders) */
  card(p = "inv") {
    const s = this.st, wrap = (inner) => `<div class="card" style="margin:12px 0">${inner}</div>`;
    const what = p === "pre" ? "a notification when a customer sends a pre-order" : "the shopping list every day at 5:00 PM";
    if (s === "checking") return "";
    if (s === "unsupported") return wrap(`<b>Notifications</b><div class="muted" style="margin-top:4px">${this.standalone() ? "This phone can't receive notifications. iPhone needs iOS 16.4 or newer." : `To get ${what}, open the app from its Home Screen icon (Safari → Share → Add to Home Screen), then turn it on here.`}</div>`);
    if (s === "denied") return wrap(`<b>Notifications are blocked on this phone</b><div class="muted" style="margin-top:4px">Turn them on in iPhone Settings → Notifications → Aunty Tauhu, then come back here.</div>`);
    if (s === "on") return wrap(`<b>🔔 Notifications on this phone</b>
      ${[["orders", "New pre-orders", "When a customer sends the order form"], ["restock", "5:00 PM shopping list", "Things to buy for the kitchen"]].map(([k, l, d]) => `<div class="switch" style="margin-top:10px"><div><b style="font-weight:700">${l}</b><div class="muted">${d}</div></div><button class="${this.prefs[k] !== false ? "on" : ""}" data-a="${p}PushPref" data-id="${k}"></button></div>`).join("")}
      <div class="grid2" style="margin-top:12px"><button class="btn sm sec" data-a="${p}PushTest">Send test now</button><button class="btn sm ghost" data-a="${p}PushOff">Turn off</button></div>`);
    return wrap(`<b>🔔 Get notified</b><div class="muted" style="margin:4px 0 10px">Get ${what} on this phone. Turn it on once on each phone (owner and staff).</div><button class="btn block" data-a="${p}PushOn">Turn on notifications</button>`);
  },
};
