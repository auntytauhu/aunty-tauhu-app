/* =====================================================================
   AUNTY TAUHU — DAILY SHOPPING LIST NOTIFICATION (5:00 PM)
   Each phone turns it on once (Stock → Restock list). The phone's push
   address is saved in Supabase (push_subs); every day at 5 PM a Supabase
   job sends the restock list to all phones that turned it on.
   ===================================================================== */
"use strict";
const PUSH_VAPID_PUBLIC = "BMLZJEjBQDKoYdrQ9IdfkHy-jMSL3BjuONHufeyf6rnRD9ss1GYYZ8JTlJnMG070tRcJH4ZtEWGk1wIPq_UXOQc";
const Push = {
  st: "checking", reg: null, busy: false,
  standalone() { return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true; },
  supported() { return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; },
  async init() {
    if (!("serviceWorker" in navigator)) { this.st = "unsupported"; return; }
    try {
      this.reg = await navigator.serviceWorker.register("sw.js", { scope: "./" });
      navigator.serviceWorker.addEventListener("message", (e) => { if (e.data && e.data.open === "restock") Push.openRestock(); });
      if (!this.supported()) { this.st = "unsupported"; return this.redraw(); }
      const s = await this.reg.pushManager.getSubscription();
      this.st = Notification.permission === "denied" ? "denied" : s ? "on" : "off";
      if (s && API.me) this.save(s).catch(() => {}); /* keep the saved address fresh */
    } catch (e) { console.warn("push init", e); this.st = "unsupported"; }
    this.redraw();
  },
  redraw() { if (ui.screen === "app" && ui.tab === "stock" && ui.inv === "restock" && !ui.sheet) render(); },
  openRestock() { if (ui.screen !== "app") return; ui.tab = "stock"; ui.inv = "restock"; ui.sheet = null; render(); },
  key() { const s = atob(PUSH_VAPID_PUBLIC.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - PUSH_VAPID_PUBLIC.length % 4) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)); },
  async id(endpoint) { const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)); return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40); },
  async save(s) {
    const j = s.toJSON(), id = await this.id(j.endpoint);
    const { error } = await Sync.sb.from("push_subs").upsert({ id, data: { endpoint: j.endpoint, keys: j.keys, uid: API.me.id, name: API.me.name, role: API.me.role, ua: navigator.userAgent.slice(0, 140), at: Date.now() } });
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
      await this.save(s); this.st = "on"; toast("Done. The shopping list will arrive every day at 5:00 PM.");
      API.log("Notifications turned on", `${API.me.name} (${API.me.role}): daily shopping list`);save();
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
  card() {
    const s = this.st, wrap = (inner, cls = "") => `<div class="card ${cls}" style="margin-top:12px">${inner}</div>`;
    if (s === "checking") return "";
    if (s === "unsupported") return wrap(`<b>5:00 PM shopping list notification</b><div class="muted" style="margin-top:4px">${this.standalone() ? "This phone can't receive notifications. iPhone needs iOS 16.4 or newer." : "To get it on this phone, open the app from its Home Screen icon (Safari → Share → Add to Home Screen), then turn it on here."}</div>`);
    if (s === "denied") return wrap(`<b>Notifications are blocked on this phone</b><div class="muted" style="margin-top:4px">Turn them on in iPhone Settings → Notifications → Aunty Tauhu, then come back here.</div>`);
    if (s === "on") return wrap(`<div class="row between"><div><b>✓ 5:00 PM shopping list is on</b><div class="muted">This phone gets the list of things to buy every day.</div></div></div>
      <div class="grid2" style="margin-top:10px"><button class="btn sm sec" data-a="invPushTest">Send test now</button><button class="btn sm ghost" data-a="invPushOff">Turn off</button></div>`);
    return wrap(`<b>Get this list every day at 5:00 PM</b><div class="muted" style="margin:4px 0 10px">A notification with the things to buy. Turn it on once on each phone.</div><button class="btn block" data-a="invPushOn">Turn on notifications</button>`, "");
  },
};
