// Aunty Tauhu notifications.
//  - {mode:"daily"} (scheduler, x-cron-key): 5 PM shopping list -> phones with the shopping list turned on
//  - {mode:"neworder", id} (database, x-cron-key): a customer sent the order form -> phones with new orders turned on
//  - called from the app by a signed-in user with {mode:"test"} -> sends to that user's phones only
//  - {mode:"preview"} -> returns the message without sending (signed-in user)
import { createClient } from "jsr:@supabase/supabase-js@2";
import { buildShoppingList, shoppingMessage } from "./restock.js";
import { sendPush } from "./webpush.js";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: sec, error: se } = await admin.rpc("push_secrets");
    if (se || !sec?.push_vapid_private || !sec?.push_vapid_public) return json({ error: "keys_missing" }, 500);
    const body = await req.json().catch(() => ({}));

    // who is calling?
    let mode = "daily", uid: string | null = null;
    const cronKey = req.headers.get("x-cron-key");
    if (cronKey) {
      if (cronKey !== sec.push_cron_key) return json({ error: "bad_key" }, 401);
      if (body?.mode === "neworder") mode = "neworder";
    } else {
      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      const { data: u } = token ? await admin.auth.getUser(token) : { data: null };
      if (!u?.user) return json({ error: "not_logged_in" }, 401);
      uid = u.user.id;
      mode = body?.mode === "preview" ? "preview" : "test";
    }

    const vapid = { publicKey: sec.push_vapid_public, privateKey: sec.push_vapid_private, subject: "https://auntytauhu.github.io/aunty-tauhu-app/" };
    const sendAll = async (payload: Record<string, string>, want: (d: Record<string, unknown>) => boolean, onlyUid: string | null) => {
      let q = admin.from("push_subs").select("id,data");
      if (onlyUid) q = q.eq("data->>uid", onlyUid);
      const { data: subs, error: qe } = await q;
      if (qe) throw qe;
      const list = (subs ?? []).filter((s: { data: Record<string, unknown> }) => want(s.data || {}));
      let sent = 0, failed = 0, removed = 0;
      const errors: unknown[] = [];
      for (const s of list) {
        try {
          const r = await sendPush(s.data, payload, vapid);
          if (r.ok) sent++;
          else if (r.gone) { await admin.from("push_subs").delete().eq("id", s.id); removed++; }
          else { failed++; errors.push({ status: r.status, detail: r.detail, who: s.data?.name }); }
        } catch (e) { failed++; errors.push({ error: String(e).slice(0, 200), who: s.data?.name }); }
      }
      return { phones: list.length, sent, failed, removed, errors };
    };
    const prefOn = (k: string) => (d: Record<string, unknown>) => ((d.prefs as Record<string, boolean>) ?? {})[k] !== false;

    // ---- new order from the customer form ----
    if (mode === "neworder") {
      const { data: row, error: oe } = await admin.from("orders").select("data").eq("id", String(body?.id ?? "")).maybeSingle();
      if (oe) throw oe;
      const o = row?.data as Record<string, any> | undefined;
      if (!o) return json({ error: "order_not_found" }, 404);
      const RM = (sen: number) => "RM" + (sen / 100).toFixed(2);
      const items = (o.items ?? []) as { qty: number; name: string; price: number }[];
      const total = items.reduce((a, i) => a + i.qty * i.price, 0), packs = items.reduce((a, i) => a + i.qty, 0);
      const d = new Date(o.date + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
      const payload = {
        title: `New pre-order: ${o.customer}${o.time ? " · " + o.time : ""}`,
        body: `${o.no} · ${d}${o.time ? ", " + o.time : ""} · ${o.delivery ? "Delivery" : "Pick up"} · ${packs} pack${packs === 1 ? "" : "s"}, ${RM(total)}${o.delivery ? " + delivery. Set the delivery charge." : ". Send the total to the customer."}`,
        url: "./#pre",
        tag: "order-" + o.id,
      };
      const res = await sendAll(payload, prefOn("orders"), null);
      console.log(JSON.stringify({ mode, order: o.no, ...res }));
      return json({ mode, title: payload.title, ...res });
    }

    // stock data (all rows, in pages of 1000)
    const all = async (t: string) => {
      const rows: unknown[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await admin.from(t).select("data").range(from, from + 999);
        if (error) throw error;
        rows.push(...(data ?? []).map((r: { data: unknown }) => r.data));
        if (!data || data.length < 1000) break;
      }
      return rows;
    };
    const [items, counts, buys, prices, restock, suppliers] = await Promise.all(
      ["inv_items", "inv_counts", "inv_purchases", "inv_prices", "inv_restock", "inv_suppliers"].map(all),
    );
    const lines = buildShoppingList({ items, counts, buys, prices, restock, suppliers } as never);
    const msg = shoppingMessage(lines);
    if (mode === "preview") return json({ mode, ...msg, lines });

    const payload = {
      title: (mode === "test" ? "Test: " : "") + msg.title,
      body: msg.body.length > 1500 ? msg.body.slice(0, 1497) + "…" : msg.body,
      url: "./#restock",
      tag: "restock",
    };
    // the test goes to all of this user's phones; the daily list only to phones that keep it on
    const res = await sendAll(payload, mode === "test" ? () => true : prefOn("restock"), uid);
    console.log(JSON.stringify({ mode, toBuy: lines.filter((l) => !l.done).length, ...res }));
    return json({ mode, title: payload.title, ...res });
  } catch (e) {
    console.log("error", String(e));
    return json({ error: "server_error", detail: String(e).slice(0, 300) }, 500);
  }
});
