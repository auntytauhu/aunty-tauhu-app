/* =====================================================================
   AUNTY TAUHU — ALL SALES FOR A DAY (owner)
   Adds the POS project's sales (shop, kiosks, events) to the app's own
   sales (BWA booths, vendors DD/Kuekas, BWA + Aunty Tauhu orders).
   POS figures come from the "pos-sales" server function as a daily
   summary; nothing is copied into this app's database.
   Money from the POS is in RM; it is turned into sen here like the rest
   of the app.
   ===================================================================== */
"use strict";
const POS_PM={cash:"Cash",duitnow_qr:"DuitNow QR",bank_transfer:"Bank transfer"};
const Pos={cache:{},busy:{},
  get(from,to){const k=from+"_"+to,c=this.cache[k];if(!c||Date.now()-c.at>60000){if(!this.busy[k])this.load(from,to);}return c||null;},
  async load(from,to){const k=from+"_"+to;this.busy[k]=true;let res;
    try{if(!Sync.sb||!Sync.sb.functions)throw new Error("offline");
      const{data,error}=await Sync.sb.functions.invoke("pos-sales",{body:{from,to}});
      if(error){let code="error";try{const b=await error.context.json();code=b.error||code;}catch(e){if(/fetch|network/i.test(String(error.message)))code="offline";}
        res={at:Date.now(),err:code,days:this.cache[k]&&this.cache[k].days};}
      else res={at:Date.now(),days:(data&&data.days||[]).map(d=>({...d,netS:Math.round(d.net*100),grossS:Math.round(d.gross*100),refundS:Math.round(d.refunds*100)}))};}
    catch(e){res={at:Date.now(),err:"offline",days:this.cache[k]&&this.cache[k].days};}
    finally{this.busy[k]=false;}
    this.cache[k]=res;if(ui.screen==="app"&&!ui.sheet&&(ui.tab==="today"||ui.tab==="report"))render();},
  errText(e){return{pos_key_missing:"POS not connected yet. The owner needs to add the POS key in Supabase (one time).",owner_only:"Only the owner can see POS sales.",offline:"No connection. POS sales will load when the signal is back.",pos_error:"POS can't be read right now. Please try again shortly."}[e]||"POS sales can't be loaded right now.";},
  sum(days){const r={net:0,gross:0,refunds:0,tx:0,locs:{},pms:{},items:{}};
    (days||[]).forEach(d=>{r.net+=d.netS;r.gross+=d.grossS;r.refunds+=d.refundS;r.tx+=d.tx;
      (d.locations||[]).forEach(l=>{const x=r.locs[l.name]=r.locs[l.name]||{tx:0,net:0};x.tx+=l.tx;x.net+=Math.round(l.net*100);});
      Object.entries(d.payments||{}).forEach(([m,v])=>{r.pms[m]=(r.pms[m]||0)+Math.round(v*100);});
      (d.items||[]).forEach(i=>{const x=r.items[i.name]=r.items[i.name]||{qty:0,net:0};x.qty+=i.qty;x.net+=Math.round(i.net*100);});});
    return r;}};
/* the app's own sales for one day, by channel (booths/vendors after their cut) */
function appDaySales(from,to){const R=report(from,to),t=R.tot;
  return{rows:[["BWA booths (after BWA cut)",t.net],["Vendors DD / Kuekas (after cut)",t.vNet],["BWA orders (to claim)",t.orders],["Aunty Tauhu orders",t.direct]],total:grand(t),pending:R.pending,R};}
/* Booths page: "Total sales today" card */
function salesDayCard(d){if(!API.isOwner())return"";const A=appDaySales(d,d),P=Pos.get(d,d),pd=P&&P.days?Pos.sum(P.days):null;
  const posRow=pd?`<div class="r"><span>POS shop & events${pd.tx?` <span class="muted">(${pd.tx} sale${pd.tx>1?"s":""})</span>`:""}</span><b>${RM(pd.net)}</b></div>`
    :`<div class="r"><span>POS shop & events</span><span class="muted">${P&&P.err?"–":"loading…"}</span></div>`;
  return`<div class="card calc" style="border:2px solid var(--navy);margin-top:12px"><div class="row between" style="margin-bottom:6px"><b style="font-size:16px">Total sales today</b><span class="muted">${fmtDs(d)}</span></div>
   ${A.rows.map(([l,v])=>`<div class="r"><span>${l}</span><span>${RM(v)}</span></div>`).join("")}${posRow}
   <div class="r t"><span>Aunty Tauhu total</span><span>${RM(A.total+(pd?pd.net:0))}</span></div>
   ${A.pending?`<div class="muted" style="margin-top:4px">${A.pending} booth/vendor record${A.pending>1?"s":""} without leftover yet, not counted.</div>`:""}
   ${P&&P.err?`<div class="muted" style="margin-top:4px;color:var(--amber)">${esc(Pos.errText(P.err))}${pd?" (last POS figures shown)":""}</div>`:""}
   ${pd&&Object.keys(pd.locs).length?`<div class="muted" style="margin-top:6px">POS: ${Object.entries(pd.locs).filter(([,x])=>x.net).map(([n,x])=>`${esc(n)} ${RM(x.net)}`).join(" · ")||"no sales"}</div>`:""}</div>`;}
/* Reports page: POS section + overall daily totals */
function salesReportSection(from,to){if(!API.isOwner())return"";const A=appDaySales(from,to),P=Pos.get(from,to),pd=P&&P.days?Pos.sum(P.days):null;
  const byDay={};A.R.days.forEach(d=>{byDay[d.date]={app:grand(d),pos:0};});(P&&P.days||[]).forEach(d=>{(byDay[d.date]=byDay[d.date]||{app:0,pos:0}).pos=d.netS;});
  const days=Object.keys(byDay).sort();
  const items=pd?Object.entries(pd.items).sort((a,b)=>b[1].net-a[1].net).slice(0,8):[];
  return`<h3>All Aunty Tauhu sales</h3>
  <div class="grid2"><div class="stat"><div class="l">App (booths, vendors, orders)</div><div class="v">${RM(A.total)}</div></div><div class="stat"><div class="l">POS shop & events${pd?` (${pd.tx})`:""}</div><div class="v">${pd?RM(pd.net):P&&P.err?"–":"…"}</div>${pd&&pd.refunds?`<div class="muted">after ${RM(pd.refunds)} refunds</div>`:""}</div>
   <div class="stat hl" style="grid-column:1/-1"><div class="l">Grand total</div><div class="v">${RM(A.total+(pd?pd.net:0))}</div></div></div>
  ${P&&P.err?`<div class="note" style="margin-top:10px">${esc(Pos.errText(P.err))}</div>`:""}
  ${days.length?`<div class="card" style="margin-top:12px"><table><thead><tr><th>Day</th><th>App</th><th>POS</th><th>Total</th></tr></thead><tbody>${days.map(d=>`<tr><td>${dayName(d)} ${fmtDs(d)}</td><td>${RM(byDay[d].app)}</td><td>${pd?RM(byDay[d].pos):"–"}</td><td><b>${RM(byDay[d].app+byDay[d].pos)}</b></td></tr>`).join("")}</tbody>
   <tfoot><tr><td>Total</td><td>${RM(A.total)}</td><td>${pd?RM(pd.net):"–"}</td><td>${RM(A.total+(pd?pd.net:0))}</td></tr></tfoot></table><div class="muted" style="margin-top:6px">App = booths & vendors after their cut + orders. POS = shop & event sales after refunds.</div></div>`:""}
  ${pd&&pd.tx?`<div class="card"><b>POS by location</b>${Object.entries(pd.locs).sort((a,b)=>b[1].net-a[1].net).map(([n,x])=>`<div class="uline"><span>${esc(n)} <span class="muted">(${x.tx})</span></span><b>${RM(x.net)}</b></div>`).join("")}
   <div style="margin-top:8px"><b>Payment method</b>${Object.entries(pd.pms).map(([m,v])=>`<div class="uline"><span>${POS_PM[m]||esc(m)}</span><span>${RM(v)}</span></div>`).join("")}</div>
   ${items.length?`<div style="margin-top:8px"><b>Best sellers (POS)</b>${items.map(([n,x])=>`<div class="uline"><span>${esc(n)} <span class="muted">× ${x.qty}</span></span><span>${RM(x.net)}</span></div>`).join("")}</div>`:""}</div>`:""}`;}
