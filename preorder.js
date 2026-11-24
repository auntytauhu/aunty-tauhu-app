/* =====================================================================
   AUNTY TAUHU — PRE-ORDERS (orders from the customer form)
   1) customer sends the form (+ WhatsApp)       → order is Not paid
   2) owner types the delivery charge here        → total is ready
   3) staff taps "Send total on WhatsApp"         → customer gets the total
   4) customer pays, staff taps "Paid"            → counted in sales
   ===================================================================== */
"use strict";
const preList=()=>DB.orders.filter(o=>o.src==="form"&&o.status!=="cancelled");
const preNeedsFee=o=>!!(o.delivery&&o.delivery.feeTbc);
const preTodo=()=>preList().filter(o=>!custPaid(o));
const preCount=()=>preTodo().length;
const PAY_URL=o=>location.origin+location.pathname.replace(/[^/]*$/,"")+`pay.html?o=${encodeURIComponent(o.no)}&a=${(orderTotal(o)/100).toFixed(2)}`;
function preMsg(o){const B=DB.business;
  return[`Hi ${o.customer}, thank you for ordering with Aunty Tauhu!`,``,`Order ${o.no}`,`${dayName(o.date)}, ${fmtD(o.date)}${o.time?", "+o.time:""}`,o.delivery?`Delivery to: ${o.delivery.address}`:`Self pick up`,``,
    ...o.items.map(i=>`${i.qty} x ${i.name}: ${RM(i.qty*i.price)}`),...(o.delivery?[`Delivery: ${RM(o.delivery.fee)}`]:[]),``,`*Total to pay: ${RM(orderTotal(o))}*`,``,`*How to pay*`,
    `DuitNow QR: ${PAY_URL(o)}`,...(B.bank?[`Bank transfer: ${B.bank}`]:[]),``,`Please send the payment receipt here. Thank you!`].join("\n");}
/* share the total + the DuitNow QR picture (phone share sheet → WhatsApp → customer's chat) */
let QR_FILE=null;
async function preShareQr(o){
  try{if(!QR_FILE){const r=await fetch("icons/duitnow-qr.jpg");QR_FILE=new File([await r.blob()],"Aunty-Tauhu-DuitNow-QR.jpg",{type:"image/jpeg"});}
    const data={files:[QR_FILE],text:preMsg(o)};
    if(!navigator.canShare||!navigator.canShare(data)){toast("This phone can't share pictures from here. Use 'Send total on WhatsApp' (it has the QR link).",true);return false;}
    try{await navigator.clipboard.writeText(preMsg(o));}catch(_){}
    toast("Message copied too. If WhatsApp shows only the picture, paste the message.");await navigator.share(data);return true;}
  catch(e){if(e&&e.name==="AbortError")return false;console.error(e);toast("Couldn't share. Use 'Send total on WhatsApp'.",true);return false;}}
function preCard(o){const own=API.isOwner(),need=preNeedsFee(o),paid=custPaid(o),items=itemsTotal(o);
  return`<div class="card pcard" data-name="${esc((o.customer+" "+o.no+" "+(o.phone||"")).toLowerCase())}">
   <button class="ph" data-a="order" data-id="${o.id}">${o.time?`<div class="tpill">${tShort(o.time)}</div>`:""}<div class="grow"><b>${esc(o.customer)}</b> <span class="muted">${o.no}</span><div class="muted">${dayName(o.date)} ${fmtDs(o.date)}${o.time?" · "+esc(o.time):""} · ${o.delivery?"Delivery":"Pick up"}</div></div>
    <span class="badge ${paid?"b-green":need?"b-amber":"b-red"}">${paid?"Paid":need?"Set delivery":"Not paid"}</span></button>
   <div class="pitems">${o.items.map(i=>`<div>${i.qty} × ${esc(i.name)}</div>`).join("")}</div>
   ${o.delivery?`<div class="paddr"><div class="grow"><small>Address</small>${esc(o.delivery.address)}</div><button class="btn sm ghost" data-a="preCopy" data-id="${o.id}">Copy</button></div>`:""}
   ${o.notes?`<div class="muted" style="margin:6px 0">Remarks: ${esc(o.notes)}</div>`:""}
   <div class="ptot"><div class="r"><span>Items</span><span>${RM(items)}</span></div>
    ${o.delivery?`<div class="r"><span>Delivery</span>${!paid?`<span class="pfee"><span>RM</span><input id="pfee_${o.id}" inputmode="decimal" placeholder="e.g. 25" value="${need?"":s2d(o.delivery.fee)}"><button class="btn sm" data-a="preFee" data-id="${o.id}">Save</button></span>`:`<span>${need?`<span class="muted">not set</span>`:RM(o.delivery.fee)}</span>`}</div>`:""}
    <div class="r t"><span>Total to pay</span><span>${need?"–":RM(orderTotal(o))}</span></div></div>
   ${paid?"":`<button class="btn wa block" data-a="preSend" data-id="${o.id}" ${need||!o.phone?"disabled":""}>${need?"Set the delivery charge first":"Send total on WhatsApp"}</button>
    ${need?"":`<button class="btn sm ghost block" style="margin-top:6px" data-a="preQr" data-id="${o.id}">Send with QR picture</button>`}
    ${o.sentAt?`<div class="muted" style="text-align:center;margin-top:4px">Total sent ${fmtT(o.sentAt)} by ${esc(o.sentBy||"")}${o.sentTotal!==orderTotal(o)?` · <b style="color:var(--red)">total changed since, send again</b>`:""}</div>`:""}`}
   <div class="seg" style="margin:10px 0 0">${[["no","Not paid"],["yes","Paid"]].map(([k,l])=>`<button class="${(k==="yes")===paid?"on":""}" data-a="prePaid" data-id="${o.id}:${k}" ${need&&k==="yes"?"disabled":""}>${l}</button>`).join("")}</div>
   ${paid&&o.paidAt?`<div class="muted" style="text-align:center;margin-top:4px">Paid ${fmtT(o.paidAt)}${o.paidBy?" · "+esc(o.paidBy):""}. You can proceed.</div>`:""}</div>`;}
function preView(){const f=ui.preF||"todo",all=preList(),todo=all.filter(o=>!custPaid(o)),t=today();
  let list=f==="todo"?todo:f==="paid"?all.filter(o=>custPaid(o)&&o.date>=t):all;
  const srt=(a,b)=>a.date.localeCompare(b.date)||tMin(a.time)-tMin(b.time);list=[...list].sort(f==="all"?(a,b)=>-srt(a,b):srt);
  const fee=list.filter(preNeedsFee),rest=list.filter(o=>!preNeedsFee(o));
  const sec=(title,l,hint)=>l.length?`<div class="lhead"><h3>${title}</h3><span>${l.length}</span></div>${hint?`<p class="muted" style="margin:-4px 0 8px">${hint}</p>`:""}${l.map(preCard).join("")}`:"";
  return`<div class="row between"><h2 style="margin:0">Pre-orders</h2><button class="btn sm sec" data-a="preLink">Copy form link</button></div>
  <p class="muted">Orders customers send from the order form. Type the delivery charge, send the total on WhatsApp, then tap Paid when the customer has paid.</p>
  ${Push.card("pre")}
  <div class="chips">${[["todo",`To do (${todo.length})`],["paid","Paid (upcoming)"],["all","All"]].map(([k,l])=>`<button class="chip ${f===k?"on":""}" data-a="preF" data-id="${k}">${l}</button>`).join("")}</div>
  ${all.length>4?`<input class="search" type="search" placeholder="Search name, order no or phone" data-filter="preList" autocomplete="off">`:""}
  <div id="preList">${f==="todo"?sec("1. Set delivery charge",fee,"Check the address, type the charge and tap Save.")+sec("2. Send total · wait for payment",rest,""):
    list.map(preCard).join("")}${list.length?`<div class="empty" data-none style="display:none">No order matches.</div>`:`<div class="empty">${f==="todo"?"Nothing to do. New orders from the form will appear here.":"No orders here."}</div>`}</div>`;}
function preClick(a,id,el){const o=id&&DB.orders.find(x=>x.id===String(id).split(":")[0]);
  switch(a){
    case"preF":ui.preF=id;return;
    case"prePushOn":Push.on();return false;
    case"prePushOff":Push.off();return false;
    case"prePushTest":Push.test();return false;
    case"prePushPref":Push.pref(id);return false;
    case"preLink":copyText(FORM_URL());return false;
    case"preCopy":copyText(o.delivery.address);return false;
    case"preFee":{const r=API.setDeliveryFee(o.id,val("pfee_"+o.id));if(r.ok)toast(`Delivery ${RM(o.delivery.fee)} saved · total ${RM(orderTotal(o))}`);else toast(r.error,true);return;}
    case"preSend":{if(preNeedsFee(o))return false;o.sentAt=Date.now();o.sentBy=API.me.name;o.sentTotal=orderTotal(o);API.log("Total sent on WhatsApp",`${o.no} ${o.customer} · ${RM(o.sentTotal)}`);save();
      window.open(`https://wa.me/${waNum(o.phone)}?text=${encodeURIComponent(preMsg(o))}`,"_blank");return;}
    case"preQr":{if(preNeedsFee(o))return false;preShareQr(o).then(ok=>{if(ok){o.sentAt=Date.now();o.sentBy=API.me.name;o.sentTotal=orderTotal(o);API.log("Total + QR sent",`${o.no} ${o.customer} · ${RM(o.sentTotal)}`);save();render();}});return false;}
    case"prePaid":{const yes=id.endsWith(":yes");const r=API.setPay(o.id,yes?"paid":"pending");if(!r.ok){toast(r.error,true);return false;}if(yes)o.paidBy=API.me.name;else delete o.paidBy;save();toast(yes?`${o.no} marked as paid`:`${o.no} marked as not paid`);return;}
  }
  return undefined;}
