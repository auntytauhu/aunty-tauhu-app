/* Shopping list (restock list) for the daily notification.
   Same rules as Inv.restock() in inventory.js, written without the app
   around it so the server can run it. Keep the two in step: the test
   suite compares both on the same data. */
const q3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000;
const fq = (x) => String(q3(x));
const plur = (name, n) => !name ? "" : (q3(n) === 1 || /s$/i.test(name)) ? name : name + "s";
const addDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const CAT_ORDER = { dry: 0, wet: 1, pack: 2, frozen: 3 };

export function buildShoppingList({ items, counts, buys, prices, restock, suppliers }) {
  const byItem = new Map(), byKey = new Map(), price = new Map((prices || []).map((p) => [p.id, p]));
  (counts || []).forEach((r) => { if (!byItem.has(r.itemId)) byItem.set(r.itemId, []); byItem.get(r.itemId).push(r); });
  byItem.forEach((l) => l.sort((a, b) => a.date.localeCompare(b.date)));
  (buys || []).forEach((p) => { const k = p.itemId + "|" + p.unitId; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(p); });
  byKey.forEach((l) => l.sort((a, b) => a.date.localeCompare(b.date) || (a.cAt || 0) - (b.cAt || 0)));
  const sup = (id) => (suppliers || []).find((s) => s.id === id);
  const supName = (p) => { const s = p && p.supId ? sup(p.supId) : null; return s ? s.name : ((p && p.supName) || ""); };
  const recs = (id) => byItem.get(id) || [];
  const bought = (it, u, a, b) => { if (a > b) return 0; let s = 0; for (const p of byKey.get(it.id + "|" + u) || []) if (p.date >= a && p.date <= b) s += p.qty; return q3(s); };
  const start = (it, u) => q3((it.start || {})[u] || 0);
  const chain = (it, u) => {
    const out = [], sd = it.startDate || "0000-00-00", st = start(it, u); let prevD = null, prevEnd = null;
    for (const r of recs(it.id)) {
      const L = (r.lines || {})[u] || {};
      const open = prevD == null ? (r.date >= sd ? q3(st + bought(it, u, sd, addDays(r.date, -1))) : st)
        : q3(prevEnd + bought(it, u, addDays(prevD, 1), addDays(r.date, -1)));
      const recv = q3(bought(it, u, r.date, r.date) + q3(L.rx || 0)), exp = q3(open + recv - q3(L.us || 0) - q3(L.ws || 0));
      const end = L.cl == null ? exp : q3(L.cl);
      out.push({ date: r.date, end }); prevD = r.date; prevEnd = end;
    }
    return out;
  };
  const cur = (it, u) => {
    const c = chain(it, u), D = "9999-12-31", e = c.length ? c[c.length - 1] : null;
    if (e) return q3(e.end + bought(it, u, addDays(e.date, 1), D));
    const sd = it.startDate || "0000-00-00"; return D >= sd ? q3(start(it, u) + bought(it, u, sd, D)) : start(it, u);
  };
  const conv = (it) => it.mode !== "status" && (it.units || []).length > 1 && it.units.slice(1).every((x) => x.per > 0);
  const statusNow = (it) => { const rs = recs(it.id); for (let i = rs.length - 1; i >= 0; i--) if (rs[i].st) return rs[i].st; return it.startStatus || "available"; };
  const state = (it) => {
    if (it.mode === "status") { const st = statusNow(it); return { level: st === "out" ? "out" : st === "low" ? "low" : "ok", st, lines: [] }; }
    const lines = (it.units || []).map((u, i) => { const qty = cur(it, u.id), min = u.min == null ? null : u.min; return { u, i, qty, min, low: min != null && qty <= min, out: qty <= 0 }; });
    if (conv(it)) { const total = q3(lines.reduce((a, l) => a + (l.i ? l.qty * l.u.per : l.qty), 0)), min = lines[0].min; return { lines, total, combined: true, level: total <= 0 ? "out" : min != null && total <= min ? "low" : "ok" }; }
    return { lines, level: !lines.length ? "ok" : lines.every((l) => l.out) ? "out" : lines.some((l) => l.low) ? "low" : "ok" };
  };
  const suggest = (l) => { if (!l.u) return 1; const c = Math.max(0, l.qty || 0);
    if (l.target != null) return Math.max(0, Math.ceil(q3(l.target - c)));
    if (l.min != null) return Math.max(1, Math.ceil(q3(l.min * 2 - c))); return 1; };
  const lastPriced = (it, u) => { const l = (byKey.get(it.id + "|" + u) || []).filter((p) => { const pr = price.get(p.id); return pr && pr.up != null; }); return l.length ? l[l.length - 1] : null; };

  const active = (items || []).filter((i) => i.active !== false).sort((a, b) => (CAT_ORDER[a.cat] ?? 9) - (CAT_ORDER[b.cat] ?? 9) || a.name.localeCompare(b.name));
  const rows = new Map((restock || []).map((r) => [r.id, r])), out = [];
  active.forEach((it) => {
    const S = state(it), push = (u, qty, min, target) => { const id = it.id + "|" + (u ? u.id : "-"); out.push({ id, it, u, qty, min, target, level: S.level, st: S.st, row: rows.get(id) }); rows.delete(id); };
    if (it.mode === "status") { if (S.level !== "ok") push(null, null, null, null); }
    else if (S.combined) { if (S.level !== "ok") push(it.units[0], S.total, S.lines[0].min, it.units[0].target ?? null); }
    else S.lines.forEach((l) => { if (l.low || (S.level === "out" && l.i === 0)) push(l.u, l.qty, l.min, l.u.target ?? null); });
  });
  rows.forEach((row) => {
    if (!row.manual) return; const it = (items || []).find((i) => i.id === row.itemId); if (!it || it.active === false) return;
    const u = row.unitId === "-" ? null : (it.units || []).find((x) => x.id === row.unitId); if (row.unitId !== "-" && !u) return;
    const S = state(it), qty = !u ? null : S.combined && u.id === it.units[0].id ? S.total : cur(it, u.id);
    out.push({ id: row.id, it, u, qty, min: u ? u.min ?? null : null, target: u ? u.target ?? null : null, level: S.level, st: S.st, row });
  });
  return out.map((l) => {
    const sug = l.row && l.row.qty != null ? l.row.qty : suggest(l), lp = l.u ? lastPriced(l.it, l.u.id) : null;
    const supplier = l.it.supId && sup(l.it.supId) ? sup(l.it.supId).name : (lp ? supName(lp) : "");
    return { id: l.id, name: l.it.name, unit: l.u ? l.u.name : "", qty: l.qty, sug, level: l.level, done: !!(l.row && l.row.done), supplier };
  });
}

/* notification text: only what is still to buy (ticked items left out) */
export function shoppingMessage(lines) {
  const todo = lines.filter((l) => !l.done);
  if (!todo.length) return { title: "Shopping list: nothing to buy", body: "All stock is above its minimum level today." };
  const part = (l) => `${l.name}${l.unit ? `: ${fq(l.sug)} ${plur(l.unit, l.sug)}` : (l.level === "out" ? " (out)" : " (low)")}`;
  const out = todo.filter((l) => l.level === "out").length;
  return {
    title: `Shopping list: ${todo.length} item${todo.length > 1 ? "s" : ""} to buy${out ? ` (${out} out of stock)` : ""}`,
    body: todo.map(part).join(" · "),
  };
}
