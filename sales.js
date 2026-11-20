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
  /* one line per POS location / event, e.g. "POS UM unity fest" */
  const locs=pd?Object.entries(pd.locs).sort((a,b)=>b[1].net-a[1].net):[];
  const posRow=!pd?`<div class="r"><span>POS</span><span class="muted">${P&&P.err?"–":"loading…"}</span></div>`
    :!locs.length?`<div class="r"><span>POS</span><span class="muted">no sales</span></div>`
    :locs.map(([n,x])=>`<div class="r"><span>POS ${esc(n)} <span class="muted">(${x.net?`${x.tx} sale${x.tx>1?"s":""}`:"all refunded"})</span></span><b>${RM(x.net)}</b></div>`).join("");
  return`<div class="card calc" style="border:2px solid var(--navy);margin-top:12px"><div class="row between" style="margin-bottom:6px"><b style="font-size:16px">${d===today()?"Total sales today":"Total sales"}</b><span class="muted">${fmtDs(d)}</span></div>
   ${A.rows.map(([l,v])=>`<div class="r"><span>${l}</span><span>${RM(v)}</span></div>`).join("")}${posRow}
   <div class="r t"><span>Aunty Tauhu total</span><span>${RM(A.total+(pd?pd.net:0))}</span></div>
   ${A.pending?`<div class="muted" style="margin-top:4px">${A.pending} booth/vendor record${A.pending>1?"s":""} without leftover yet, not counted.</div>`:""}
   ${P&&P.err?`<div class="muted" style="margin-top:4px;color:var(--amber)">${esc(Pos.errText(P.err))}${pd?" (last POS figures shown)":""}</div>`:""}
   ${locs.length>1?`<div class="muted" style="margin-top:6px">POS all events: ${RM(pd.net)}</div>`:""}
   ${DL?`<button class="btn block" style="margin-top:12px" data-a="dayPdf" data-id="${d}">Download day report PDF</button>`:""}</div>`;}
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

/* One PDF with everything sold on one day: every channel, details, POS per event */
function daySalesPdf(d){
  const A=appDaySales(d,d),R=A.R,t=R.tot,pct=DB.settings.pct,P=Pos.get(d,d),pd=P&&P.days?Pos.sum(P.days):null;
  const pdf=new Pdf(),M=pdf.M,W=pdf.W-2*M,grey=[107,111,120];
  pdfHead(pdf,"Daily Sales Report","All Aunty Tauhu sales",`${dayName(d)}, ${fmtD(d)}`,`Prepared ${new Date().toLocaleString("en-GB")} by ${API.me.name}`);
  const total=A.total+(pd?pd.net:0),bw=(W-12)/3,box=(x,l,v,dark)=>{pdf.rect(x,pdf.y,bw,46,dark?[21,33,58]:[245,239,227]);pdf.text(x+8,pdf.y+15,l,{size:7.5,color:dark?[200,208,224]:grey});pdf.text(x+8,pdf.y+34,v,{size:14,bold:true,color:dark?[255,255,255]:[14,23,38]});};
  box(M,"App (booths, vendors, orders)",RM(A.total));box(M+bw+6,pd?`POS shop & events (${pd.tx} sales)`:"POS shop & events",pd?RM(pd.net):"not loaded");box(M+2*(bw+6),"Aunty Tauhu total",RM(total),true);pdf.y+=56;
  if(R.pending){pdf.text(M,pdf.y,`Note: ${R.pending} booth/vendor record(s) without leftover yet are not counted.`,{size:8,color:[154,103,0]});pdf.y+=12;}
  if(!pd){pdf.text(M,pdf.y,`Note: POS sales could not be loaded (${Pos.errText(P&&P.err||"offline")}). They are not included in the total.`,{size:8,color:[154,103,0]});pdf.y+=12;}
  /* summary by channel */
  pdf.heading("Sales by channel");
  const ch=A.rows.map(([l,v])=>[l,"",RM(v)]);
  if(pd)Object.entries(pd.locs).sort((a,b)=>b[1].net-a[1].net).forEach(([n,x])=>ch.push([`POS ${n}`,x.net?`${x.tx} sale(s)`:"all refunded",RM(x.net)]));
  pdf.table([{h:"Channel",w:.6},{h:"Sales",w:.18,align:"right"},{h:"Amount",w:.22,align:"right"}],ch,["Aunty Tauhu total","",RM(total)]);
  /* booths */
  if(R.booths.length){pdf.heading(`BWA booths (after BWA ${pct}%)`);
    const rows=API.entriesBetween(d,d).map(e=>({e,c:calc(e),n:API.booth(e.boothId).name})).filter(x=>x.c.done).sort((a,b)=>a.n.localeCompare(b.n));
    pdf.table([{h:"Booth",w:.22},{h:"Sent T/P",w:.11,align:"right"},{h:"Left T/P",w:.11,align:"right"},{h:"Sold T/P",w:.11,align:"right"},{h:"Promo",w:.1,align:"right"},{h:"Gross",w:.12,align:"right"},{h:`BWA ${pct}%`,w:.11,align:"right"},{h:"Due",w:.12,align:"right"}],
      rows.map(({e,c,n})=>[n,`${e.sentT}/${e.sentP}`,`${e.retT}/${e.retP}`,`${c.soldT}/${c.soldP}`,c.promoQty||"-",RM(c.gross),RM(c.bwa),RM(c.net)]),["Total",`${t.sentT}/${t.sentP}`,"",`${t.soldT}/${t.soldP}`,t.promoQty||"-",RM(t.gross),RM(t.bwa),RM(t.net)]);}
  /* vendors */
  if(R.vendors.length){pdf.heading("Vendors (DD, Kuekas)");
    pdf.table([{h:"Vendor",w:.26},{h:"Sold tauhu",w:.13,align:"right"},{h:"Sold popia",w:.13,align:"right"},{h:"Promo",w:.1,align:"right"},{h:"Gross",w:.13,align:"right"},{h:"Cut",w:.12,align:"right"},{h:"Due",w:.13,align:"right"}],
      R.vendors.map(v=>[v.name,v.vSoldT,v.vSoldP,v.vPromo||"-",RM(v.vGross),RM(v.vCut),RM(v.vNet)]),["Total",t.vSoldT,t.vSoldP,t.vPromo||"-",RM(t.vGross),RM(t.vCut),RM(t.vNet)]);}
  /* customer orders */
  const ordTable=(list,title,tot)=>{if(!list.length)return;pdf.heading(title);const rows=[];
    list.forEach(o=>{o.items.forEach((i,k)=>rows.push([k?"":o.no,k?"":o.customer,i.name,i.qty,RM(i.qty*i.price)]));if(o.delivery)rows.push(["","","Delivery charge",1,RM(o.delivery.fee)]);});
    pdf.table([{h:"Order",w:.13},{h:"Customer",w:.24},{h:"Item",w:.38},{h:"Qty",w:.08,align:"right"},{h:"Amount",w:.17,align:"right"}],rows,["Total",`${list.length} order${list.length>1?"s":""}`,"","",RM(tot)]);};
  ordTable(R.orders,"BWA customer orders (claim from BWA, full price)",t.orders);
  ordTable(R.direct,"Aunty Tauhu orders (direct)",t.direct);
  /* POS */
  if(pd&&pd.tx){pdf.heading("POS shop & events");
    pdf.table([{h:"Event / location",w:.6},{h:"Sales",w:.15,align:"right"},{h:"Amount",w:.25,align:"right"}],Object.entries(pd.locs).sort((a,b)=>b[1].net-a[1].net).map(([n,x])=>[n,x.tx,RM(x.net)]),["Total POS",pd.tx,RM(pd.net)]);
    if(pd.refunds){pdf.text(M,pdf.y+2,`Gross ${RM(pd.gross)} less refunds ${RM(pd.refunds)} = ${RM(pd.net)}`,{size:8,color:grey});pdf.y+=12;}
    pdf.heading("POS payment methods");
    pdf.table([{h:"Method",w:.6},{h:"",w:.15},{h:"Amount",w:.25,align:"right"}],Object.entries(pd.pms).map(([m,v])=>[POS_PM[m]||m,"",RM(v)]),["Total","",RM(pd.net)]);
    const items=Object.entries(pd.items).sort((a,b)=>b[1].net-a[1].net);
    if(items.length){pdf.heading("POS products sold");
      pdf.table([{h:"Product",w:.6},{h:"Qty",w:.15,align:"right"},{h:"Amount",w:.25,align:"right"}],items.map(([n,x])=>[n,x.qty,RM(x.net)]),["Total",items.reduce((a,[,x])=>a+x.qty,0),RM(items.reduce((a,[,x])=>a+x.net,0))]);}}
  pdfFoot(pdf,"Daily Sales Report");return pdf.build();}
