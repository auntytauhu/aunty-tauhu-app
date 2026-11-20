/* =====================================================================
   AUNTY TAUHU — INVENTORY MODULE
   Raw materials, packaging, frozen & sauce. Loaded before the main app
   script; uses the same store/sync layer (one Supabase row per record).

   How stock is worked out (per item, per unit — units are never mixed
   unless the owner sets a conversion):
     opening  = previous day's closing (physical count, or expected if the
                day was not counted) + purchases on days with no update
     received = purchases recorded on that day (Purchases page)
                + "other received" typed in the daily update
     expected closing = opening + received − used − wastage
     discrepancy      = physical closing − expected closing
   Records are never overwritten: every correction keeps the previous
   version (with who, when and why) inside the record, and is written to
   the activity log. Prices live in a separate owner-only table.
   ===================================================================== */
"use strict";
const INV_COLL={invItems:"inv_items",invSup:"inv_suppliers",invCounts:"inv_counts",invBuys:"inv_purchases",
  invPrices:"inv_prices",invRestock:"inv_restock",invRecipes:"inv_recipes",invProd:"inv_production"};
const invEmpty=()=>({invItems:[],invSup:[],invCounts:[],invBuys:[],invPrices:[],invRestock:[],invRecipes:[],invProd:[]});
const INV_CATS=[{id:"dry",en:"Dry Goods",ms:"Barang Kering"},{id:"wet",en:"Wet Goods",ms:"Barang Basah"},
  {id:"pack",en:"Packaging",ms:"Packaging"},{id:"frozen",en:"Frozen & Sauce",ms:"Frozen dan Kuah"}];
const INV_CAT=Object.fromEntries(INV_CATS.map(c=>[c.id,c]));
const INV_ST={available:"Available",low:"Running low",out:"Out of stock"};

/* ---------- quantities (up to 3 decimals, rounded to avoid 0.1+0.2 errors) ---------- */
const q3=x=>Math.round((Number(x)||0)*1000)/1000;
const fq=x=>x==null||x===""?"–":String(q3(x));
const plur=(name,n)=>!name?"":(q3(n)===1||/s$/i.test(name))?name:name+"s";
const qu=(n,name)=>`${fq(n)} ${plur(name,n)}`;
const signed=x=>(x>0?"+":"")+fq(x);
/* "" = left empty, null = not a valid number, otherwise the number */
function parseQ(v){const t=String(v??"").trim().replace(/,/g,".");if(t==="")return"";if(!/^\d+(\.\d{1,3})?$/.test(t)&&!/^\.\d{1,3}$/.test(t))return null;return q3(parseFloat(t));}
const invFail=(e,x)=>Object.assign({ok:false,error:e},x||{});

/* =====================================================================
   ENGINE
   ===================================================================== */
const Inv={
  ver:0,_m:null,
  bump(){this.ver++;},
  me(){return API.me?API.me.name:"system";},
  canEdit(date){return API.isOwner()||date===today();},
  item(id){return DB.invItems.find(i=>i.id===id);},
  sup(id){return DB.invSup.find(s=>s.id===id);},
  supName(p){const s=p&&p.supId?this.sup(p.supId):null;return s?s.name:((p&&p.supName)||"");},
  catOrder:{dry:0,wet:1,pack:2,frozen:3},
  items(all){return DB.invItems.filter(i=>all||i.active!==false).sort((a,b)=>(this.catOrder[a.cat]??9)-(this.catOrder[b.cat]??9)||a.name.localeCompare(b.name));},
  unit(it,u){return(it.units||[]).find(x=>x.id===u);},
  label(it){return it.en&&it.en.toLowerCase()!==it.name.toLowerCase()?`${it.en} (${it.name})`:it.name;},
  /* lookup tables, rebuilt only when data changes */
  m(){const M=this._m;if(M&&M.db===DB&&M.ver===this.ver)return M;
    const counts=new Map(),buys=new Map(),price=new Map(),prod=new Map();
    DB.invCounts.forEach(r=>{if(!counts.has(r.itemId))counts.set(r.itemId,[]);counts.get(r.itemId).push(r);});
    counts.forEach(l=>l.sort((a,b)=>a.date.localeCompare(b.date)));
    DB.invBuys.forEach(p=>{const k=p.itemId+"|"+p.unitId;if(!buys.has(k))buys.set(k,[]);buys.get(k).push(p);});
    buys.forEach(l=>l.sort((a,b)=>a.date.localeCompare(b.date)||(a.cAt||0)-(b.cAt||0)));
    DB.invPrices.forEach(p=>price.set(p.id,p));
    DB.invProd.forEach(p=>prod.set(p.date,p));
    return this._m={db:DB,ver:this.ver,counts,buys,price,prod,chains:new Map(),states:new Map()};},
  recs(itemId){return this.m().counts.get(itemId)||[];},
  rec(date,itemId){return DB.invCounts.find(r=>r.id===date+"_"+itemId)||null;},
  buyList(it,u){return this.m().buys.get(it.id+"|"+u)||[];},
  bought(it,u,a,b){if(a>b)return 0;let s=0;for(const p of this.buyList(it,u))if(p.date>=a&&p.date<=b)s+=p.qty;return q3(s);},
  price(pid){return this.m().price.get(pid)||null;},
  start(it,u){return q3((it.start||{})[u]||0);},
  /* every saved day for one item+unit, oldest first, with the full calculation */
  chain(it,u){const M=this.m(),k=it.id+"|"+u;if(M.chains.has(k))return M.chains.get(k);
    const out=[],sd=it.startDate||"0000-00-00",start=this.start(it,u);let prevD=null,prevEnd=null;
    for(const r of this.recs(it.id)){const L=(r.lines||{})[u]||{};
      const open=prevD==null?(r.date>=sd?q3(start+this.bought(it,u,sd,addDays(r.date,-1))):start)
                            :q3(prevEnd+this.bought(it,u,addDays(prevD,1),addDays(r.date,-1)));
      const bought=this.bought(it,u,r.date,r.date),rx=q3(L.rx||0),used=q3(L.us||0),waste=q3(L.ws||0),recv=q3(bought+rx);
      const exp=q3(open+recv-used-waste),close=L.cl==null?null:q3(L.cl),end=close==null?exp:close;
      out.push({date:r.date,rec:r,open,bought,rx,recv,used,waste,exp,close,end,disc:close==null?null:q3(close-exp)});
      prevD=r.date;prevEnd=end;}
    M.chains.set(k,out);return out;},
  entry(it,u,date){return this.chain(it,u).find(e=>e.date===date)||null;},
  /* stock at the END of a day */
  stockAt(it,u,D){const c=this.chain(it,u);let e=null;for(let i=c.length-1;i>=0;i--)if(c[i].date<=D){e=c[i];break;}
    if(e)return q3(e.end+this.bought(it,u,addDays(e.date,1),D));
    const sd=it.startDate||"0000-00-00";return D>=sd?q3(this.start(it,u)+this.bought(it,u,sd,D)):this.start(it,u);},
  openFor(it,u,date){return this.stockAt(it,u,addDays(date,-1));},
  cur(it,u){return this.stockAt(it,u,"9999-12-31");},
  conv(it){return it.mode!=="status"&&(it.units||[]).length>1&&it.units.slice(1).every(x=>x.per>0);},
  statusAt(it,D){const rs=this.recs(it.id);for(let i=rs.length-1;i>=0;i--)if(rs[i].date<=D&&rs[i].st)return rs[i].st;return it.startStatus||"available";},
  /* ok / low / out for an item */
  state(it){const M=this.m();if(M.states.has(it.id))return M.states.get(it.id);let r;
    if(it.mode==="status"){const st=this.statusAt(it,"9999-12-31");r={level:st==="out"?"out":st==="low"?"low":"ok",st,lines:[],minSet:true};}
    else{const lines=(it.units||[]).map((u,i)=>{const qty=this.cur(it,u.id),min=u.min==null?null:u.min;return{u,i,qty,min,low:min!=null&&qty<=min,out:qty<=0};});
      if(this.conv(it)){const total=q3(lines.reduce((a,l)=>a+(l.i?l.qty*l.u.per:l.qty),0)),min=lines[0].min;
        r={lines,total,combined:true,minSet:min!=null,level:total<=0?"out":min!=null&&total<=min?"low":"ok"};}
      else r={lines,minSet:lines.some(l=>l.min!=null),level:!lines.length?"ok":lines.every(l=>l.out)?"out":lines.some(l=>l.low)?"low":"ok"};}
    M.states.set(it.id,r);return r;},
  stockText(it){const S=this.state(it);if(it.mode==="status")return INV_ST[S.st]||S.st;
    const t=S.lines.map(l=>qu(l.qty,l.u.name)).join(" + ");return S.combined?`${t} (= ${qu(S.total,it.units[0].name)})`:t;},
  lastUpdate(){let r=null;DB.invCounts.forEach(x=>{if(!r||x.at>r.at)r=x;});return r;},
  /* ---------- restock list ---------- */
  restock(){const out=[],rows=new Map(DB.invRestock.map(r=>[r.id,r]));
    this.items().forEach(it=>{const S=this.state(it);
      const push=(u,qty,min,target)=>{const id=it.id+"|"+(u?u.id:"-");out.push({id,it,u,qty,min,target,auto:true,level:S.level,row:rows.get(id)});rows.delete(id);};
      if(it.mode==="status"){if(S.level!=="ok")push(null,null,null,null);}
      else if(S.combined){if(S.level!=="ok")push(it.units[0],S.total,S.lines[0].min,it.units[0].target??null);}
      else S.lines.forEach(l=>{if(l.low||(S.level==="out"&&l.i===0))push(l.u,l.qty,l.min,l.u.target??null);});});
    rows.forEach(row=>{if(!row.manual)return;const it=this.item(row.itemId);if(!it||it.active===false)return;
      const u=row.unitId==="-"?null:this.unit(it,row.unitId);if(row.unitId!=="-"&&!u)return;
      const S=this.state(it),qty=!u?null:S.combined&&u.id===it.units[0].id?S.total:this.cur(it,u.id);
      out.push({id:row.id,it,u,qty,min:u?u.min??null:null,target:u?u.target??null:null,auto:false,level:S.level,row});});
    out.forEach(l=>{l.def=this.suggest(l);l.sug=l.row&&l.row.qty!=null?l.row.qty:l.def;l.done=!!(l.row&&l.row.done);
      const lp=l.u?this.lastPrice(l.it,l.u.id):null;l.lp=lp;l.cost=lp?Math.round(lp.pr.up*l.sug):null;
      l.supplier=l.it.supId&&this.sup(l.it.supId)?this.sup(l.it.supId).name:(lp?this.supName(lp.p):"");});
    return out;},
  suggest(l){if(!l.u)return 1;const c=Math.max(0,l.qty||0);
    if(l.target!=null)return Math.max(0,Math.ceil(q3(l.target-c)));
    if(l.min!=null)return Math.max(1,Math.ceil(q3(l.min*2-c)));return 1;},
  /* ---------- prices ---------- */
  priced(it,u){return this.buyList(it,u).map(p=>({p,pr:this.price(p.id)})).filter(x=>x.pr&&x.pr.up!=null);},
  lastPrice(it,u,supId){const l=this.priced(it,u).filter(x=>!supId||x.p.supId===supId);return l.length?l[l.length-1]:null;},
  prevPrice(p){const it=this.item(p.itemId);if(!it)return null;const l=this.priced(it,p.unitId),i=l.findIndex(x=>x.p.id===p.id);return i>0?l[i-1]:null;},
  change(a,b){const d=a-b;return{d,pct:b?Math.round(d/b*10000)/100:null,dir:d>0?"up":d<0?"down":"same"};},
  suppliers(it,u){const by=new Map();
    this.priced(it,u).forEach(x=>{const k=x.p.supId||("n:"+(x.p.supName||"").trim().toLowerCase());if(!by.has(k))by.set(k,[]);by.get(k).push(x);});
    const rows=[...by.values()].map(l=>({name:this.supName(l[0].p)||"(no supplier)",latest:l[l.length-1],prev:l.length>1?l[l.length-2]:null,n:l.length}));
    if(!rows.length)return rows;const min=Math.min(...rows.map(r=>r.latest.pr.up));
    rows.forEach(r=>{r.cheapest=r.latest.pr.up===min;r.vsCheap=r.latest.pr.up-min;});return rows.sort((a,b)=>a.latest.pr.up-b.latest.pr.up||a.name.localeCompare(b.name));},
  spend(from,to){const L=DB.invBuys.filter(p=>p.date>=from&&p.date<=to);let total=0,unpriced=0;const byCat={},bySup={};
    L.forEach(p=>{const pr=this.price(p.id);if(!pr||pr.total==null){unpriced++;return;}total+=pr.total;const it=this.item(p.itemId),c=it?it.cat:"other";
      byCat[c]=(byCat[c]||0)+pr.total;const s=this.supName(p)||"(no supplier)";bySup[s]=(bySup[s]||0)+pr.total;});
    return{total,unpriced,byCat,bySup,n:L.length,list:L};},
  /* ---------- recipes (owner-configured; nothing is ever assumed) ---------- */
  estimate(date){const P=this.m().prod.get(date),est=new Map();if(!P)return est;
    DB.invRecipes.forEach(rc=>{const n=q3((P.qty||{})[rc.id]||0);if(!n)return;(rc.ing||[]).forEach(g=>{const k=g.itemId+"|"+g.unitId;est.set(k,q3((est.get(k)||0)+g.qty*n));});});
    return est;},
  /* ---------- server check: has someone else saved this record meanwhile? ---------- */
  async remote(table,ids){if(!Sync.sb||!Sync.online||!ids.length)return new Map();
    try{const{data,error}=await Sync.sb.from(table).select("id,data").in("id",ids);if(error)return new Map();return new Map((data||[]).map(r=>[r.id,r.data]));}catch(e){return new Map();}},
  adopt(coll,rec){const arr=DB[coll],i=arr.findIndex(x=>x.id===rec.id);if(i>=0)arr[i]=rec;else arr.push(rec);
    Sync.snap[coll]=Sync.snap[coll]||{};Sync.snap[coll][rec.id]=JSON.stringify(rec);this.bump();Sync.cache();},

  /* =================== DAILY STOCK RECORDS =================== */
  /* patch = {lines:{unitId:{rx,us,ws,cl}}, st, rm}; a field left out keeps its saved value */
  changesSaved(r,patch){if(!r)return false;const pl=r.lines||{};
    for(const u in patch.lines||{}){const o=pl[u]||{},n=patch.lines[u];for(const k of["rx","us","ws","cl"]){if(!(k in n))continue;if(o[k]!=null&&o[k]!==n[k])return true;}}
    return patch.st!==undefined&&!!r.st&&r.st!==patch.st;},
  check(it,date,patch){const r=this.rec(date,it.id);if(it.mode==="status")return null;
    for(const u of it.units){const n=(patch.lines||{})[u.id];if(!n)continue;const o=(r&&r.lines&&r.lines[u.id])||{},L=Object.assign({},o,n);
      const avail=q3(this.openFor(it,u.id,date)+this.bought(it,u.id,date,date)+(L.rx||0));
      if(q3((L.us||0)+(L.ws||0))>avail)return`${it.name} (${u.name}): used + wastage (${fq(q3((L.us||0)+(L.ws||0)))}) is more than opening + received (${fq(avail)}). Please check the figures.`;}
    return null;},
  apply(date,it,patch,why){const now=Date.now(),me=this.me();let r=this.rec(date,it.id),lines={};
    const op={};(it.units||[]).forEach(u=>{op[u.id]=this.openFor(it,u.id,date);});
    if(r){r.hist=r.hist||[];r.hist.push({v:r.v,at:r.at,by:r.by,lines:r.lines,st:r.st||null,rm:r.rm||"",chAt:now,chBy:me,why:why||""});lines=JSON.parse(JSON.stringify(r.lines||{}));}
    else{r={id:date+"_"+it.id,date,itemId:it.id,cAt:now,cBy:me,hist:[],v:0,lines:{}};DB.invCounts.push(r);}
    for(const u in patch.lines||{}){lines[u]=Object.assign(lines[u]||{},patch.lines[u]);if(lines[u].cl===null)delete lines[u].cl;}
    r.lines=lines;if(patch.st!==undefined)r.st=patch.st;if(patch.rm!==undefined)r.rm=patch.rm;r.op=op;r.v=(r.v||0)+1;r.at=now;r.by=me;
    this.bump();return r;},
  summary(it,r){if(it.mode==="status")return INV_ST[r.st]||"";
    return it.units.map(u=>{const L=(r.lines||{})[u.id];if(!L)return"";return`${u.name}: used ${fq(L.us||0)}, waste ${fq(L.ws||0)}${L.rx?`, other in ${fq(L.rx)}`:""}, closing ${L.cl==null?"not counted":fq(L.cl)}`;}).filter(Boolean).join("; ");},
  async saveCount(date,itemId,patch,why){const it=this.item(itemId);if(!it)return invFail("Item not found");
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return invFail("Choose the date");
    if(date>today())return invFail("You can't record stock for a future date");
    if(!this.canEdit(date))return invFail("Only the owner can change records from earlier days. Ask the owner to correct it.");
    const id=date+"_"+itemId,rem=(await this.remote("inv_counts",[id])).get(id),loc=this.rec(date,itemId);
    if(rem&&(rem.v||0)>(loc?loc.v||0:0)){this.adopt("invCounts",rem);return invFail(`${rem.by} saved ${it.name} at ${fmtT(rem.at)}. Their figures are now shown, please check and save again.`,{reload:true});}
    const bad=this.check(it,date,patch);if(bad)return invFail(bad);
    if(this.changesSaved(this.rec(date,itemId),patch)&&!String(why||"").trim())return invFail("You changed figures that were already saved. Please write the reason for the correction.",{why:true});
    const r=this.apply(date,it,patch,String(why||"").trim());
    API.log(r.v>1?"Stock corrected":"Stock updated",`${it.name} ${fmtD(date)}: ${this.summary(it,r)}${why?` · reason: ${why}`:""}`);save();return ok(r);},
  /* usage tracker: {itemId:{unitId:used}} for one day, saved into the same daily records */
  async saveUsage(date,used,why){if(date>today())return invFail("You can't record usage for a future date");
    if(!this.canEdit(date))return invFail("Only the owner can change records from earlier days.");
    const todo=[];
    for(const iid in used){const it=this.item(iid);if(!it)continue;const r=this.rec(date,iid),lines={};
      for(const u in used[iid]){const n=used[iid][u],o=r&&r.lines&&r.lines[u]?r.lines[u].us:undefined;if(n===(o??0)&&(o!=null||n===0))continue;lines[u]={us:n};}
      if(Object.keys(lines).length)todo.push({it,patch:{lines}});}
    if(!todo.length)return invFail("Nothing changed. Enter the quantity used.");
    const rem=await this.remote("inv_counts",todo.map(t=>date+"_"+t.it.id));
    for(const t of todo){const rr=rem.get(date+"_"+t.it.id),loc=this.rec(date,t.it.id);
      if(rr&&(rr.v||0)>(loc?loc.v||0:0)){rem.forEach(x=>{const l=this.rec(x.date,x.itemId);if((x.v||0)>(l?l.v||0:0))this.adopt("invCounts",x);});
        return invFail(`${rr.by} updated ${t.it.name} at ${fmtT(rr.at)}. Their figures are now shown, please check and save again.`,{reload:true});}}
    for(const t of todo){const bad=this.check(t.it,date,t.patch);if(bad)return invFail(bad);}
    if(todo.some(t=>this.changesSaved(this.rec(date,t.it.id),t.patch))&&!String(why||"").trim())return invFail("You changed usage that was already saved. Please write the reason for the correction.",{why:true});
    todo.forEach(t=>{const r=this.apply(date,t.it,t.patch,String(why||"").trim());
      API.log(r.v>1?"Usage corrected":"Usage recorded",`${t.it.name} ${fmtD(date)}: ${Object.entries(t.patch.lines).map(([u,l])=>qu(l.us,this.unit(t.it,u).name)).join(", ")}${why?` · reason: ${why}`:""}`);});
    save();return ok(todo.length);},

  /* =================== PURCHASES / STOCK RECEIVED =================== */
  async savePurchase(id,f){const owner=API.isOwner(),it=this.item(f.itemId);
    if(!it)return invFail("Choose the item");const u=this.unit(it,f.unitId);
    if(!u)return invFail(it.units.length?"Choose the unit":"This item has no units yet. The owner can add a unit (e.g. pack) in the item settings.");
    if(!/^\d{4}-\d{2}-\d{2}$/.test(f.date||""))return invFail("Choose the purchase date");
    if(f.date>today())return invFail("The date can't be in the future");
    if(!owner&&f.date!==today())return invFail("Staff can only record stock received today");
    const qty=parseQ(f.qty);if(qty===""||qty==null||qty<=0)return invFail("Enter the quantity received (e.g. 2 or 1.5)");
    const sup=f.supId&&f.supId!=="other"?this.sup(f.supId):null,supName=sup?"":String(f.supName||"").trim();
    let up=null,total=null;
    if(owner){if(String(f.up||"").trim()!==""){up=toSen(f.up);if(up==null)return invFail("Unit price: enter an amount like 15.00");}
      if(String(f.total||"").trim()!==""){total=toSen(f.total);if(total==null)return invFail("Total: enter an amount like 30.00");}
      if(up!=null&&total==null)total=Math.round(up*qty);else if(total!=null&&up==null)up=Math.round(total/qty);
      else if(up!=null&&total!=null&&Math.abs(Math.round(up*qty)-total)>Math.max(1,Math.round(qty))*1)return invFail(`Unit price × quantity (${RM(Math.round(up*qty))}) doesn't match the total (${RM(total)}). Clear one of them.`);}
    const now=Date.now(),me=this.me(),inv=String(f.inv||"").trim(),rm=String(f.rm||"").trim();
    let p=id?DB.invBuys.find(x=>x.id===id):null;
    if(id&&!p)return invFail("This purchase was deleted");
    if(p&&!owner&&p.date!==today())return invFail("Only the owner can change earlier records");
    if(!p&&!f.dupOk){const d=DB.invBuys.find(x=>x.date===f.date&&x.itemId===it.id&&x.unitId===u.id&&x.qty===qty&&(x.supId||"")===(sup?sup.id:"")&&(x.supName||"").toLowerCase()===supName.toLowerCase());
      if(d)return invFail(`${qu(qty,u.name)} of ${it.name}${supName||sup?" from "+(sup?sup.name:supName):""} was already recorded on ${fmtD(f.date)} by ${d.by}. Is this a different purchase?`,{dup:true});
      if(inv){const d2=DB.invBuys.find(x=>x.inv&&x.inv.toLowerCase()===inv.toLowerCase()&&x.itemId===it.id&&x.unitId===u.id);
        if(d2)return invFail(`Receipt "${inv}" was already used for ${it.name} on ${fmtD(d2.date)}. Is this a different purchase?`,{dup:true});}}
    if(p){const rem=(await this.remote("inv_purchases",[p.id])).get(p.id);
      if(rem&&(rem.v||0)>(p.v||0)){this.adopt("invBuys",rem);return invFail(`${rem.by} changed this purchase just now. The latest is shown, please check again.`,{reload:true});}
      const op=this.price(p.id),changed=p.date!==f.date||p.itemId!==it.id||p.unitId!==u.id||p.qty!==qty||(p.supId||"")!==(sup?sup.id:"")||(p.supName||"")!==supName||(owner&&op&&(op.up!==up||op.total!==total));
      if(changed&&!String(f.why||"").trim())return invFail("Please write the reason for changing this purchase.",{why:true});
      p.hist=p.hist||[];p.hist.push({v:p.v,at:p.at,by:p.by,date:p.date,itemId:p.itemId,unitId:p.unitId,qty:p.qty,supId:p.supId||"",supName:p.supName||"",inv:p.inv||"",rm:p.rm||"",up:op?op.up:null,total:op?op.total:null,chAt:now,chBy:me,why:String(f.why||"").trim()});
      Object.assign(p,{date:f.date,itemId:it.id,unitId:u.id,qty,supId:sup?sup.id:"",supName,inv,rm,v:(p.v||0)+1,at:now,by:me});}
    else{p={id:"p"+uid(),date:f.date,itemId:it.id,unitId:u.id,qty,supId:sup?sup.id:"",supName,inv,rm,v:1,cAt:now,cBy:me,at:now,by:me,hist:[]};DB.invBuys.push(p);}
    if(owner){const i=DB.invPrices.findIndex(x=>x.id===p.id);
      if(up==null){if(i>=0)DB.invPrices.splice(i,1);}else if(i>=0)Object.assign(DB.invPrices[i],{up,total,at:now,by:me});else DB.invPrices.push({id:p.id,up,total,at:now,by:me});}
    /* stock has arrived: reset the restock tick for this item */
    const rr=DB.invRestock.find(x=>x.id===it.id+"|"+u.id);if(rr&&(rr.done||rr.qty!=null||rr.manual))Object.assign(rr,{done:false,qty:null,manual:false,at:now,by:me});
    this.bump();
    API.log(p.v>1?"Purchase changed":"Stock received",`${it.name}: ${qu(qty,u.name)} on ${fmtD(f.date)}${sup||supName?" from "+(sup?sup.name:supName):""}${owner&&up!=null?` @ ${RM(up)}/${u.name} = ${RM(total)}`:""}${inv?` · ref ${inv}`:""}${f.why?` · reason: ${f.why}`:""}`);
    save();return ok(p);},
  deletePurchase(id){if(!API.isOwner())return invFail("Owner only");const p=DB.invBuys.find(x=>x.id===id);if(!p)return invFail("Already deleted");
    const it=this.item(p.itemId),u=it&&this.unit(it,p.unitId),pr=this.price(p.id);
    DB.invBuys=DB.invBuys.filter(x=>x.id!==id);DB.invPrices=DB.invPrices.filter(x=>x.id!==id);this.bump();
    API.log("Purchase deleted",`${it?it.name:"?"}: ${qu(p.qty,u?u.name:"")} on ${fmtD(p.date)}${pr?` (${RM(pr.total)})`:""}, recorded by ${p.cBy}`);save();return ok();},

  /* =================== ITEMS, SUPPLIERS, LEVELS =================== */
  saveItem(id,f){if(!API.isOwner())return invFail("Owner only");
    const name=String(f.name||"").trim();if(name.length<2)return invFail("Enter the item name");
    if(DB.invItems.some(i=>i.id!==id&&i.active!==false&&i.name.toLowerCase()===name.toLowerCase()))return invFail("An item with this name already exists");
    if(!INV_CAT[f.cat])return invFail("Choose the category");const mode=f.mode==="status"?"status":"count";
    const old=id?this.item(id):null,units=[],start={},names=new Set();
    for(const [i,x] of (f.units||[]).entries()){const nm=String(x.name||"").trim();if(!nm)return invFail(`Unit ${i+1}: enter the unit name (e.g. pack, tray, large sack)`);
      if(names.has(nm.toLowerCase()))return invFail(`Unit "${nm}" is listed twice`);names.add(nm.toLowerCase());
      const min=parseQ(x.min),target=parseQ(x.target),per=parseQ(x.per),st=parseQ(x.start);
      if(min==null||target==null||st==null||per==null)return invFail(`${nm}: use numbers only (e.g. 3 or 1.5)`);
      if(i>0&&x.per!==""&&x.per!=null&&!(per>0))return invFail(`${nm}: the conversion must be more than 0, or leave it empty`);
      if(target!==""&&min!==""&&target<min)return invFail(`${nm}: the restock target should not be below the minimum`);
      const uidv=x.id||("u"+uid().slice(0,8));
      units.push({id:uidv,name:nm,min:min===""?null:min,target:target===""?null:target,per:i>0&&per!==""?per:null});
      start[uidv]=st===""?0:st;}
    if(mode==="count"&&!units.length)return invFail("Add at least one unit (e.g. pack)");
    if(old){const used=new Set();this.recs(old.id).forEach(r=>Object.keys(r.lines||{}).forEach(k=>used.add(k)));DB.invBuys.filter(p=>p.itemId===old.id).forEach(p=>used.add(p.unitId));
      const gone=(old.units||[]).filter(u=>!units.some(n=>n.id===u.id)&&used.has(u.id));
      if(gone.length)return invFail(`"${gone[0].name}" already has stock records, so it can't be removed. Keep it, or archive the whole item.`);}
    const data={name,en:String(f.en||"").trim(),cat:f.cat,mode,raw:!!f.raw,units,start,startStatus:f.startStatus||"available",supId:f.supId||"",note:String(f.note||"").trim()};
    if(old){const ch=[];if(old.name!==name)ch.push(`name ${old.name}→${name}`);if(JSON.stringify(old.start||{})!==JSON.stringify(start))ch.push("opening stock changed");
      if(JSON.stringify(old.units)!==JSON.stringify(units))ch.push("units/levels changed");if(old.mode!==mode)ch.push(`tracking → ${mode}`);
      Object.assign(old,data,{active:f.active!==false});this.bump();API.log("Inventory item changed",`${name}${ch.length?": "+ch.join(", "):""}`);save();return ok(old.id);}
    const it={id:"i"+uid(),...data,startDate:today(),active:true,cAt:Date.now(),cBy:this.me()};DB.invItems.push(it);this.bump();
    API.log("Inventory item added",`${name} (${INV_CAT[f.cat].en}): ${mode==="status"?INV_ST[it.startStatus]:units.map(u=>qu(start[u.id],u.name)).join(" + ")}`);save();return ok(it.id);},
  deleteItem(id){if(!API.isOwner())return invFail("Owner only");const it=this.item(id);if(!it)return invFail("Not found");
    const has=this.recs(id).length||DB.invBuys.some(p=>p.itemId===id);
    if(has){it.active=false;this.bump();API.log("Inventory item archived",`${it.name} (has stock history, kept for reports)`);save();return ok("archived");}
    DB.invItems=DB.invItems.filter(i=>i.id!==id);DB.invRestock=DB.invRestock.filter(r=>r.itemId!==id);this.bump();API.log("Inventory item deleted",it.name);save();return ok("deleted");},
  saveSup(id,f){if(!API.isOwner())return invFail("Owner only");const name=String(f.name||"").trim();if(name.length<2)return invFail("Enter the supplier name");
    if(DB.invSup.some(s=>s.id!==id&&s.name.toLowerCase()===name.toLowerCase()))return invFail("This supplier already exists");
    const data={name,phone:String(f.phone||"").trim(),note:String(f.note||"").trim(),active:f.active!==false};
    if(id){const s=this.sup(id);API.log("Supplier changed",`${s.name} → ${name}`);Object.assign(s,data);}
    else{id="s"+uid();DB.invSup.push({id,...data});API.log("Supplier added",name);}this.bump();save();return ok(id);},
  saveLevels(map){if(!API.isOwner())return invFail("Owner only");const ch=[];
    for(const iid in map){const it=this.item(iid);if(!it)continue;for(const uid2 in map[iid]){const u=this.unit(it,uid2);if(!u)continue;const v=map[iid][uid2];
      const min=parseQ(v.min),target=parseQ(v.target);if(min==null||target==null)return invFail(`${it.name} (${u.name}): use numbers only`);
      if(min!==""&&target!==""&&target<min)return invFail(`${it.name} (${u.name}): the restock target should not be below the minimum`);
      const nm=min===""?null:min,nt=target===""?null:target;if((u.min??null)!==nm||(u.target??null)!==nt){ch.push(`${it.name} ${u.name}: min ${fq(u.min)}→${fq(nm)}, target ${fq(u.target)}→${fq(nt)}`);u.min=nm;u.target=nt;}}}
    if(!ch.length)return invFail("Nothing changed");this.bump();API.log("Minimum stock levels changed",ch.join("; "));save();return ok(ch.length);},
  /* restock list ticks */
  rsRow(id,itemId,unitId){let r=DB.invRestock.find(x=>x.id===id);if(!r){r={id,itemId,unitId,done:false,qty:null,manual:false};DB.invRestock.push(r);}return r;},
  tick(id,itemId,unitId){const r=this.rsRow(id,itemId,unitId);r.done=!r.done;r.at=Date.now();r.by=this.me();const it=this.item(itemId);
    API.log(r.done?"Restock ticked":"Restock unticked",`${it?it.name:""}`);this.bump();save();return ok(r.done);},
  setSug(id,itemId,unitId,v){if(!API.isOwner())return invFail("Owner only");const q=parseQ(v);if(q==null)return invFail("Suggested quantity: numbers only");
    const r=this.rsRow(id,itemId,unitId);r.qty=q===""?null:q;r.at=Date.now();r.by=this.me();this.bump();save();return ok();},
  addManual(itemId,unitId){if(!API.isOwner())return invFail("Owner only");const it=this.item(itemId);if(!it)return invFail("Choose the item");
    if(it.mode!=="status"&&!this.unit(it,unitId))return invFail("Choose the unit");const id=itemId+"|"+(it.mode==="status"?"-":unitId);
    if(this.restock().some(l=>l.id===id))return invFail("This item is already on the restock list");
    const r=this.rsRow(id,itemId,it.mode==="status"?"-":unitId);r.manual=true;r.done=false;r.at=Date.now();r.by=this.me();this.bump();API.log("Added to restock list",it.name);save();return ok();},
  removeManual(id){if(!API.isOwner())return invFail("Owner only");const r=DB.invRestock.find(x=>x.id===id);if(r){r.manual=false;r.done=false;r.qty=null;}this.bump();save();return ok();},
  /* recipes & production */
  saveRecipe(id,f){if(!API.isOwner())return invFail("Owner only");const name=String(f.name||"").trim();if(name.length<2)return invFail("Enter the recipe / product name");
    const out=String(f.out||"").trim()||"batch",ing=[];
    for(const g of f.ing||[]){const it=this.item(g.itemId);if(!it)return invFail("Choose the ingredient for every row (or remove the empty row)");
      const u=this.unit(it,g.unitId);if(!u)return invFail(`${it.name}: choose the unit`);const q=parseQ(g.qty);if(q===""||q==null||q<=0)return invFail(`${it.name}: enter the quantity used for 1 ${out}`);
      ing.push({itemId:it.id,unitId:u.id,qty:q});}
    if(!ing.length)return invFail("Add at least one ingredient");
    if(id){const r=DB.invRecipes.find(x=>x.id===id);Object.assign(r,{name,out,ing,active:f.active!==false});API.log("Recipe changed",name);}
    else{id="r"+uid();DB.invRecipes.push({id,name,out,ing,active:true});API.log("Recipe added",name);}this.bump();save();return ok(id);},
  deleteRecipe(id){if(!API.isOwner())return invFail("Owner only");const r=DB.invRecipes.find(x=>x.id===id);if(!r)return ok();
    if(DB.invProd.some(p=>(p.qty||{})[id])){r.active=false;API.log("Recipe archived",r.name);}else{DB.invRecipes=DB.invRecipes.filter(x=>x.id!==id);API.log("Recipe deleted",r.name);}this.bump();save();return ok();},
  async saveProd(date,qty,why){if(date>today())return invFail("Can't record production for a future date");if(!this.canEdit(date))return invFail("Only the owner can change earlier days");
    const id="prod_"+date,rem=(await this.remote("inv_production",[id])).get(id);let p=DB.invProd.find(x=>x.id===id);
    if(rem&&(rem.v||0)>(p?p.v||0:0)){this.adopt("invProd",rem);return invFail(`${rem.by} saved production at ${fmtT(rem.at)}. Their figures are now shown.`,{reload:true});}
    const clean={};for(const k in qty){const q=parseQ(qty[k]);if(q==null)return invFail("Production: numbers only");if(q)clean[k]=q;}
    const now=Date.now(),me=this.me();
    if(p){const changed=Object.keys({...p.qty,...clean}).some(k=>(p.qty[k]||0)!==(clean[k]||0)&&p.qty[k]!=null);if(changed&&!String(why||"").trim())return invFail("Please write the reason for changing saved production.",{why:true});
      p.hist=p.hist||[];p.hist.push({v:p.v,at:p.at,by:p.by,qty:p.qty,chAt:now,chBy:me,why:String(why||"").trim()});Object.assign(p,{qty:clean,v:(p.v||0)+1,at:now,by:me});}
    else{p={id,date,qty:clean,v:1,at:now,by:me,cAt:now,cBy:me,hist:[]};DB.invProd.push(p);}
    this.bump();API.log("Production recorded",`${fmtD(date)}: ${DB.invRecipes.filter(r=>clean[r.id]).map(r=>`${fq(clean[r.id])} ${plur(r.out,clean[r.id])} ${r.name}`).join(", ")||"none"}`);save();return ok(p);},
};

/* =====================================================================
   REPORT DATA
   ===================================================================== */
function invRange(R){const d=R.d||today(),D=new Date(d+"T00:00:00");
  if(R.mode==="day")return[d,d];
  if(R.mode==="week"){const m=monday(d);return[m,addDays(m,6)];}
  if(R.mode==="month")return[iso(new Date(D.getFullYear(),D.getMonth(),1)),iso(new Date(D.getFullYear(),D.getMonth()+1,0))];
  return[R.from||addDays(today(),-29),R.to||today()];}
function invPrevRange(R){const[f,t]=invRange(R);
  if(R.mode==="month"){const D=new Date(f+"T00:00:00");return[iso(new Date(D.getFullYear(),D.getMonth()-1,1)),iso(new Date(D.getFullYear(),D.getMonth(),0))];}
  const n=Math.round((new Date(t+"T00:00:00")-new Date(f+"T00:00:00"))/864e5)+1;return[addDays(f,-n),addDays(f,-1)];}
const invRangeTxt=(f,t)=>f===t?`${dayName(f)}, ${fmtD(f)}`:`${fmtD(f)} – ${fmtD(t)}`;
function invMove(it,u,from,to){const c=Inv.chain(it,u).filter(e=>e.date>=from&&e.date<=to);
  const opening=Inv.stockAt(it,u,addDays(from,-1)),closing=Inv.stockAt(it,u,to);
  const bought=Inv.bought(it,u,from,to),rx=q3(c.reduce((a,e)=>a+e.rx,0)),used=q3(c.reduce((a,e)=>a+e.used,0)),waste=q3(c.reduce((a,e)=>a+e.waste,0));
  const inn=q3(bought+rx);return{opening,bought,rx,in:inn,used,waste,closing,variance:q3(closing-(opening+inn-used-waste)),days:c.length,
    disc:q3(c.reduce((a,e)=>a+(e.disc||0),0))};}
function invMoveRows(from,to){const rows=[];Inv.items(true).forEach(it=>{if(it.mode==="status")return;
  if(it.active===false&&!Inv.recs(it.id).some(r=>r.date>=from&&r.date<=to))return;
  it.units.forEach(u=>rows.push({it,u,...invMove(it,u.id,from,to)}));});return rows;}
function invUsageRows(from,to,pf,pt){const rows=[];Inv.items(true).forEach(it=>{if(it.mode==="status")return;
  it.units.forEach(u=>{const used=invMove(it,u.id,from,to).used,prev=invMove(it,u.id,pf,pt).used;if(it.active===false&&!used&&!prev)return;rows.push({it,u,used,prev});});});return rows;}

/* =====================================================================
   SMALL HELPERS: charts, export
   ===================================================================== */
const INV_COLORS=["#15213a","#c25e00","#2e7d4f","#7b4fa0","#b3261e","#0f7c8c"];
function invLine(series,labels,o={}){const W=340,H=o.h||170,pl=34,pr=10,pt=12,pb=26,n=labels.length;
  const all=series.flatMap(s=>s.vals.filter(v=>v!=null));if(!all.length||!n)return`<div class="empty">No data for this period.</div>`;
  let mx=Math.max(...all),mn=o.zero===false?Math.min(...all):Math.min(0,...all);if(mx===mn){mx+=1;mn=Math.max(0,mn-1);}
  const x=i=>pl+(W-pl-pr)*(n<2?.5:i/(n-1)),y=v=>pt+(H-pt-pb)*(1-(v-mn)/(mx-mn));const fy=o.fmt||fq;
  let g=`<line x1="${pl}" y1="${y(mn)}" x2="${W-pr}" y2="${y(mn)}" stroke="#dccbab"/>`;
  [mn,(mn+mx)/2,mx].forEach(v=>{g+=`<text x="${pl-4}" y="${y(v)+3}" font-size="9" text-anchor="end" fill="#6b6f78">${esc(fy(v))}</text><line x1="${pl}" y1="${y(v)}" x2="${W-pr}" y2="${y(v)}" stroke="#ece2cf" stroke-dasharray="2 3"/>`;});
  const li=n<=2?[...Array(n).keys()]:[0,Math.floor((n-1)/2),n-1];
  li.forEach(i=>{g+=`<text x="${x(i)}" y="${H-8}" font-size="9" text-anchor="${i===0?"start":i===n-1?"end":"middle"}" fill="#6b6f78">${esc(labels[i])}</text>`;});
  series.forEach((s,si)=>{const c=s.color||INV_COLORS[si%INV_COLORS.length];let d="",pen=false;
    s.vals.forEach((v,i)=>{if(v==null){pen=false;return;}d+=(pen?"L":"M")+x(i).toFixed(1)+" "+y(v).toFixed(1);pen=true;});
    g+=`<path d="${d}" fill="none" stroke="${c}" stroke-width="2.2" stroke-linejoin="round"/>`;
    s.vals.forEach((v,i)=>{if(v!=null&&(n<=31||s.dots))g+=`<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${s.mark&&s.mark[i]?3.4:2.2}" fill="${s.mark&&s.mark[i]?"#fff":c}" stroke="${c}" stroke-width="1.5"/>`;});});
  return`<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="chart">${g}</svg>${series.length>1||o.legend?`<div class="row" style="flex-wrap:wrap;gap:10px;font-size:12px">${series.map((s,i)=>`<span><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${s.color||INV_COLORS[i%INV_COLORS.length]};margin-right:4px"></i>${esc(s.name)}</span>`).join("")}</div>`:""}`;}
function invBars(bars,fmt){const mx=Math.max(1,...bars.map(b=>b.v));
  return`<div class="bars">${bars.map(b=>`<div class="b ${b.cur?"cur":""}"><span>${b.v?esc(fmt?fmt(b.v):b.v):""}</span><i style="height:${Math.round(b.v/mx*100)}%"></i><span style="white-space:pre;text-align:center">${esc(b.l)}</span></div>`).join("")}</div>`;}
function invCsv(rows){const q=v=>{v=v==null?"":String(v);if(/^[=+\-@]/.test(v)&&isNaN(Number(v)))v="'"+v;return'"'+v.replace(/"/g,'""')+'"';};return"﻿"+rows.map(r=>r.map(q).join(",")).join("\r\n");}
/* minimal .xlsx writer (zip, no compression) — opens in Excel, Numbers and Google Sheets */
const INV_CRC=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
function invCrc(b){let c=0xFFFFFFFF;for(let i=0;i<b.length;i++)c=INV_CRC[(c^b[i])&255]^(c>>>8);return(c^0xFFFFFFFF)>>>0;}
function invZip(files){const enc=new TextEncoder(),parts=[],cen=[];let off=0;
  const u16=v=>[v&255,(v>>>8)&255],u32=v=>[v&255,(v>>>8)&255,(v>>>16)&255,(v>>>24)&255];
  files.forEach(f=>{const name=enc.encode(f.name),data=typeof f.data==="string"?enc.encode(f.data):f.data,crc=invCrc(data);
    const head=new Uint8Array([...u32(0x04034b50),...u16(20),...u16(0x0800),...u16(0),...u16(0),...u16(0x21),...u32(crc),...u32(data.length),...u32(data.length),...u16(name.length),...u16(0)]);
    parts.push(head,name,data);
    cen.push(new Uint8Array([...u32(0x02014b50),...u16(20),...u16(20),...u16(0x0800),...u16(0),...u16(0),...u16(0x21),...u32(crc),...u32(data.length),...u32(data.length),...u16(name.length),...u16(0),...u16(0),...u16(0),...u16(0),...u32(0),...u32(off)]),name);
    off+=head.length+name.length+data.length;});
  const cs=cen.reduce((a,b)=>a+b.length,0);
  const end=new Uint8Array([...u32(0x06054b50),...u16(0),...u16(0),...u16(files.length),...u16(files.length),...u32(cs),...u32(off),...u16(0)]);
  const all=[...parts,...cen,end],out=new Uint8Array(all.reduce((a,b)=>a+b.length,0));let p=0;all.forEach(b=>{out.set(b,p);p+=b.length;});return out;}
function invXlsx(sheets){const x=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,"");
  const col=n=>{let s="";n++;while(n){const m=(n-1)%26;s=String.fromCharCode(65+m)+s;n=Math.floor((n-1)/26);}return s;};
  const ws=rows=>`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${rows.map((r,i)=>`<row r="${i+1}">${r.map((v,j)=>{const ref=col(j)+(i+1),st=i===0?' s="1"':"";if(v==null||v==="")return"";
    if(typeof v==="number"&&isFinite(v))return`<c r="${ref}"${st}><v>${v}</v></c>`;return`<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${x(v)}</t></is></c>`;}).join("")}</row>`).join("")}</sheetData></worksheet>`;
  const nm=s=>s.replace(/[\[\]:*?\/\\]/g," ").slice(0,31);
  const files=[{name:"[Content_Types].xml",data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`},
    {name:"_rels/.rels",data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`},
    {name:"xl/workbook.xml",data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s,i)=>`<sheet name="${x(nm(s.name))}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join("")}</sheets></workbook>`},
    {name:"xl/_rels/workbook.xml.rels",data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`},
    {name:"xl/styles.xml",data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`},
    ...sheets.map((s,i)=>({name:`xl/worksheets/sheet${i+1}.xml`,data:ws(s.rows)}))];
  return invZip(files);}
const senN=s=>s==null?"":Math.round(s)/100;

/* export tables */
function invExportSheets(from,to){const owner=API.isOwner(),[pf,pt]=invPrevRange(ui.ir);const sheets=[];
  sheets.push({name:"Stock movement",rows:[["Category","Item","Unit","Opening","Purchased","Other received","Used","Wastage","Closing","Unexplained difference","Days updated"],
    ...invMoveRows(from,to).map(r=>[INV_CAT[r.it.cat]?INV_CAT[r.it.cat].en:r.it.cat,r.it.name,r.u.name,r.opening,r.bought,r.rx,r.used,r.waste,r.closing,r.variance,r.days])]});
  sheets.push({name:"Raw material usage",rows:[["Item","Unit",`Used ${from} to ${to}`,`Previous period ${pf} to ${pt}`,"Change","Change %"],
    ...invUsageRows(from,to,pf,pt).filter(r=>r.it.raw).map(r=>[Inv.label(r.it),r.u.name,r.used,r.prev,q3(r.used-r.prev),r.prev?Math.round((r.used-r.prev)/r.prev*10000)/100:""])]});
  const daily=[["Date","Item","Unit","Opening","Purchased","Other received","Used","Wastage","Expected closing","Physical closing","Discrepancy","Status","Remarks","Updated by","Updated at","Version"]];
  Inv.items(true).forEach(it=>{if(it.mode==="status"){Inv.recs(it.id).filter(r=>r.date>=from&&r.date<=to).forEach(r=>daily.push([r.date,it.name,"","","","","","","","","",INV_ST[r.st]||"",r.rm||"",r.by,new Date(r.at).toLocaleString("en-GB"),r.v]));return;}
    it.units.forEach(u=>Inv.chain(it,u.id).filter(e=>e.date>=from&&e.date<=to).forEach(e=>daily.push([e.date,it.name,u.name,e.open,e.bought,e.rx,e.used,e.waste,e.exp,e.close==null?"":e.close,e.disc==null?"":e.disc,"",e.rec.rm||"",e.rec.by,new Date(e.rec.at).toLocaleString("en-GB"),e.rec.v])));});
  daily.splice(1,daily.length-1,...daily.slice(1).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))||String(a[1]).localeCompare(String(b[1]))));
  sheets.push({name:"Daily stock records",rows:daily});
  const buys=[["Date","Item","Unit","Quantity","Supplier",...(owner?["Unit price (RM)","Total (RM)","Previous unit price (RM)","Change (RM)","Change %"]:[]),"Invoice / receipt","Remarks","Recorded by"]];
  DB.invBuys.filter(p=>p.date>=from&&p.date<=to).sort((a,b)=>a.date.localeCompare(b.date)).forEach(p=>{const it=Inv.item(p.itemId),u=it&&Inv.unit(it,p.unitId),pr=Inv.price(p.id),pv=pr?Inv.prevPrice(p):null,c=pr&&pv?Inv.change(pr.up,pv.pr.up):null;
    buys.push([p.date,it?it.name:"?",u?u.name:"?",p.qty,Inv.supName(p),...(owner?[senN(pr&&pr.up),senN(pr&&pr.total),senN(pv&&pv.pr.up),c?senN(c.d):"",c&&c.pct!=null?c.pct:""]:[]),p.inv||"",p.rm||"",p.cBy]);});
  sheets.push({name:"Purchases",rows:buys});
  if(owner){const S=Inv.spend(from,to);sheets.push({name:"Spending",rows:[["Group","Name","Total (RM)"],["Total","All purchases",senN(S.total)],
    ...Object.entries(S.byCat).map(([c,v])=>["Category",INV_CAT[c]?INV_CAT[c].en:c,senN(v)]),...Object.entries(S.bySup).sort((a,b)=>b[1]-a[1]).map(([s,v])=>["Supplier",s,senN(v)])]});}
  return sheets;}

/* =====================================================================
   UI
   ===================================================================== */
(function(){const st=document.createElement("style");st.textContent=`
.invnav{margin:-2px -14px 12px;padding:0 14px 4px}
.invnav .chip{font-weight:600}
.lowrow{background:#fff3e6!important;border-left:4px solid #c25e00!important;padding-left:8px!important}
.outrow{background:var(--red-bg)!important;border-left:4px solid var(--red)!important;padding-left:8px!important}
.b-orange{background:#ffe8d1;color:#a14d00}
.stat.red{border-color:#f0b8b3;background:var(--red-bg)}.stat.red .v{color:var(--red)}
.stat.orange{border-color:#f5c99a;background:#fff3e6}.stat.orange .v{color:#a14d00}
.ucard h4{margin:0 0 8px;font-size:15px;color:var(--brown-900)}
.ucard .grid2 .field{margin-bottom:8px}
.ucard .field input{font-size:17px;font-weight:600}
.disc{border-radius:10px;padding:8px 10px;font-weight:700;margin-top:6px;font-size:14px}
.disc.ok{background:var(--green-bg);color:var(--green)}.disc.neg{background:var(--red-bg);color:var(--red)}.disc.pos{background:#fff3e6;color:#a14d00}.disc.none{background:var(--b100);color:#6b6f78;font-weight:600}
.catcard{background:var(--navy);color:#fff;border:0;border-radius:14px;padding:12px;text-align:left;min-height:86px}
.catcard:nth-child(2){background:var(--brown)}.catcard:nth-child(3){background:#2c3b57}.catcard:nth-child(4){background:var(--brown-900)}
.catcard b{display:block;font-size:15px}.catcard small{opacity:.75;display:block}.catcard .n{font-size:22px;font-weight:800;margin-top:4px}
.catcard .al{font-size:11px;margin-top:2px}
table.tight{font-size:12px}table.tight th,table.tight td{padding:6px 3px}
.chk{width:34px;height:34px;border-radius:9px;border:2px solid var(--b300);background:#fff;flex:none;font-size:20px;line-height:1;color:#fff;font-weight:800}
.chk.on{background:var(--green);border-color:var(--green)}
.done-row{opacity:.6}.done-row b{text-decoration:line-through}
.hist{font-size:12px;color:#6b6f78;border-left:3px solid var(--b300);padding:4px 0 4px 8px;margin:6px 0}
details summary{cursor:pointer;font-weight:600;color:var(--navy2);padding:6px 0}
.uline{display:flex;justify-content:space-between;gap:8px;padding:2px 0}
.pill{display:inline-block;border-radius:999px;padding:2px 9px;font-size:12px;font-weight:700}
.unitrow{border:1px solid var(--b200);border-radius:12px;padding:10px;margin-bottom:8px;background:#fff}
.invnav{position:sticky;top:var(--hh,64px);z-index:15;background:var(--b50);margin:-14px -14px 12px!important;padding:10px 14px 9px!important;border-bottom:1px solid var(--b200)}
.invnav .chip{display:inline-flex;align-items:center;gap:6px;padding:7px 12px 7px 10px}.invnav svg{width:17px;height:17px;flex:none}
.irow{align-items:center!important;gap:10px!important}
.irow .nm{font-weight:700;font-size:16px;line-height:1.25;color:#0e1726}
.irow .muted{font-size:12.5px;margin-top:1px}
.tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.qty{text-align:right;flex:none;max-width:48%}
.ql{line-height:1.1}.ql+.ql{margin-top:7px}.ql b{font-size:20px;font-weight:800;color:var(--navy)}.ql small{display:block;font-size:11.5px;color:#6b6f78;margin-top:1px}
.ql.q-low b{color:#a14d00}.ql.q-out b{color:var(--red)}.ql.q-ok b{color:var(--green)}
.qsum{font-size:11px;color:#6b6f78;margin-top:5px}
.stpill{display:inline-block;border-radius:999px;padding:5px 10px;font-size:12.5px;font-weight:700;white-space:nowrap}
.st-available{background:var(--green-bg);color:var(--green)}.st-low{background:#ffe8d1;color:#a14d00}.st-out{background:var(--red-bg);color:var(--red)}.st-none{background:var(--navy-100);color:var(--navy2)}
.chev{color:#b5aa92;font-size:22px;flex:none;margin-left:-2px}
.irow.todo .nm{color:#3b3f48}
.lhead{display:flex;justify-content:space-between;align-items:baseline;margin:18px 0 8px}.lhead h3{margin:0}.lhead h3 span{text-transform:none;font-weight:400;letter-spacing:0}.lhead>span{font-size:12px;color:#6b6f78;font-weight:600}
.pbar{height:8px;background:var(--b200);border-radius:99px;overflow:hidden;margin-top:10px}.pbar i{display:block;height:100%;background:var(--green);border-radius:99px}
.big{font-size:28px;font-weight:800;color:var(--navy);line-height:1.1}.big small{font-size:15px;color:#6b6f78;font-weight:600}.big.g{color:var(--green)}.big.r{color:var(--red)}
.todaycard{width:100%;text-align:left;border:2px solid var(--sand)!important;display:block}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.tile{background:#fff;border:1px solid var(--b200);border-radius:14px;padding:14px 4px 12px;display:flex;flex-direction:column;align-items:center;gap:7px;font-size:12.5px;font-weight:600;color:var(--navy);min-height:84px;text-align:center}
.tile svg{width:28px;height:28px;color:var(--brown)}.tn{background:#c25e00;color:#fff;border-radius:99px;padding:0 6px;font-size:11px}
.mv{padding:11px 0;border-bottom:1px solid var(--b200)}.mv:last-child{border-bottom:0}
.strip{display:grid;grid-template-columns:repeat(5,1fr);gap:4px;margin-top:7px}
.strip div{background:var(--b100);border-radius:9px;padding:6px 2px;text-align:center}.strip small{display:block;font-size:9.5px;color:#6b6f78;text-transform:uppercase;letter-spacing:.4px}.strip b{font-size:15px}
.strip .cl{background:var(--navy);color:#fff}.strip .cl small{color:#c8d0e0}
.sitem{padding:12px 0;border-bottom:1px solid var(--b200)}.sitem:last-child{border-bottom:0}.sitem .nm{font-weight:800;font-size:16.5px}
.srow{margin-top:8px}.su{font-size:12px;font-weight:700;color:var(--brown);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px}
.sg{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px}
.sbox{background:#fff;border:1px solid var(--b300);border-radius:12px;padding:6px 8px 4px}
.sbox small{display:block;font-size:11px;color:#6b6f78;font-weight:600}
.sbox b{display:block;font-size:22px;font-weight:800;color:var(--navy);padding:2px 0 3px}
.sbox input{width:100%;border:0;background:none;font-size:22px;font-weight:800;padding:2px 0 3px;color:#0e1726;outline:none}
.sbox.ro{background:var(--b100);border-color:var(--b100)}.sbox.cl{border-color:var(--navy);border-width:2px}
.sbox:focus-within{box-shadow:0 0 0 3px rgba(21,33,58,.15)}
.sfoot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:6px;font-size:13px}
.sprice{margin-left:auto;display:flex;align-items:center;gap:6px;font-size:12px;color:#6b6f78;font-weight:600}
.sprice input{width:76px;border:1px solid var(--b300);border-radius:8px;padding:5px 6px;font-size:15px;text-align:right}
.sbar{position:sticky;bottom:calc(64px + var(--sb));padding:10px 0;background:linear-gradient(transparent,var(--b50) 30%);z-index:5}
.seg .sst-available.on{background:var(--green-bg);color:var(--green)}.seg .sst-low.on{background:#ffe8d1;color:#a14d00}.seg .sst-out.on{background:var(--red-bg);color:var(--red)}
.tile.on{border:2px solid var(--navy)}
.eq{font-size:12px;color:#6b6f78;margin-top:4px}.eqv{font-size:14px;color:#0e1726}
`;document.head.appendChild(st);})();

const invLevelBadge=l=>l==="out"?`<span class="badge b-red">OUT OF STOCK</span>`:l==="low"?`<span class="badge b-orange">LOW STOCK</span>`:"";
const invRowCls=l=>l==="out"?"outrow":l==="low"?"lowrow":"";
const fv=(s,k,d)=>s.f&&k in s.f?s.f[k]:d;
function invDiscBox(exp,cl){if(cl===""||cl==null)return`<div class="disc none">Expected closing ${fq(exp)}. Enter the physical count to check.</div>`;
  if(cl===null||typeof cl!=="number")return`<div class="disc neg">Physical closing: numbers only</div>`;
  const d=q3(cl-exp);return d===0?`<div class="disc ok">✓ Stock reconciled</div>`:d<0?`<div class="disc neg">Short by ${fq(-d)}: ${fq(-d)} less than expected</div>`:`<div class="disc pos">Over by ${fq(d)}: ${fq(d)} more than expected</div>`;}
function invChangeBadge(c,unitName){if(!c)return"";const t=`${c.d>0?"+":c.d<0?"−":""}${RM(Math.abs(c.d)).replace("-","")}${c.pct!=null?` (${c.pct>0?"+":""}${c.pct.toFixed(2)}%)`:""}`;
  return c.dir==="up"?`<span class="badge b-red">▲ ${t}</span>`:c.dir==="down"?`<span class="badge b-green">▼ ${t}</span>`:`<span class="badge b-navy">No change</span>`;}
const invCanSeeMoney=()=>API.isOwner();
function invPages(){return API.isOwner()?[["simple","Daily stock"],["items","Stock list"],["reports","Reports"],["dash","Dashboard"],["prices","Prices"],["restock","Restock list"],["buys","Purchases"],["daily","Detailed count"],["usage","Usage"],["settings","Settings"]]
  :[["simple","Daily stock"],["items","Stock list"],["restock","Restock list"],["buys","Stock received"],["daily","Detailed count"],["usage","Usage"],["dash","Dashboard"]];}
const invMain=()=>API.isOwner()?["simple","items","reports"]:["simple","items","restock"];
/* ---------- shared pieces for a clear phone layout ---------- */
const INV_ICON={dash:'<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',items:'<path d="M3 8l9-5 9 5v9l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v9"/>',
  simple:'<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>',daily:'<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',usage:'<path d="M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z"/>',
  buys:'<path d="M5 8h14l-1.5 12h-11z"/><path d="M9 8a3 3 0 0 1 6 0"/>',prices:'<path d="M20 12l-8 8-9-9V3h8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  reports:'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',restock:'<path d="M4 6h16M4 12h10M4 18h7"/><path d="M15 17l2.5 2.5L22 15"/>',
  settings:'<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>'};
const invIco=k=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${INV_ICON[k]||""}</svg>`;
const invStPill=st=>`<span class="stpill st-${st}">${st==="none"?"Not updated":INV_ST[st]||st}</span>`;
/* left side of a row: name, small line, status tags */
const invHead=(it,tags,sub)=>`<div class="grow"><div class="nm">${esc(it.name)}</div>${it.en||sub?`<div class="muted">${[it.en?esc(it.en):"",sub||""].filter(Boolean).join(" · ")}</div>`:""}${tags?`<div class="tags">${tags}</div>`:""}</div>`;
/* right side: current stock, big */
function invQtyBox(it){const S=Inv.state(it);if(it.mode==="status")return`<div class="qty">${invStPill(S.st)}</div>`;
  return`<div class="qty">${S.lines.map(l=>`<div class="ql ${l.out?"q-out":l.low?"q-low":""}"><b>${fq(l.qty)}</b><small>${esc(plur(l.u.name,l.qty))}</small></div>`).join("")}${S.combined?`<div class="qsum">= ${qu(S.total,it.units[0].name)}</div>`:""}</div>`;}
const invChev=`<span class="chev">›</span>`;
const invEq=(open,inn,us,ws,exp)=>`${fq(open)} + ${fq(inn)} − ${fq(us)} − ${fq(ws)} = <b>${fq(exp)}</b>`;
function invView(){
  if(DB.invMissing)return API.isOwner()?`<h2>Stock: one step left</h2><div class="card"><b>Inventory tables are not in Supabase yet.</b><ol style="margin:10px 0 0;padding-left:20px;line-height:1.6"><li>Open supabase.com → your project → <b>SQL Editor</b> → New query</li><li>Paste all of <b>supabase/schema.sql</b> and tap <b>Run</b></li><li>Come back here and tap <b>Sync</b> at the top</li></ol><p class="muted" style="margin-bottom:0">Booths, vendors and orders work as normal meanwhile.</p></div>`
    :`<div class="card empty">Stock is not switched on yet. Please ask the owner.</div>`;
  const P=invPages();if(!ui.inv||!P.some(p=>p[0]===ui.inv))ui.inv=P[0][0];
  const body={simple:invSimple,dash:invDash,items:invItemsView,daily:invDaily,usage:invUsage,buys:invBuysView,prices:invPricesView,reports:invReports,restock:invRestockView,settings:invSettings}[ui.inv]();
  setTimeout(()=>{const h=document.querySelector("header");if(h)document.documentElement.style.setProperty("--hh",h.offsetHeight+"px");},0);
  const M=invMain(),more=!M.includes(ui.inv),cur=P.find(p=>p[0]===ui.inv);
  return`<div class="chips invnav" id="invnav">${P.filter(p=>M.includes(p[0])).map(([k,l])=>`<button class="chip ${ui.inv===k?"on":""}" data-a="invPage" data-id="${k}">${invIco(k)}${l}</button>`).join("")}<button class="chip ${more?"on":""}" data-a="invMore">${more?invIco(ui.inv)+cur[1]:"More"} ▾</button></div>${body}`;}

/* ----- DASHBOARD ----- */
function invDash(){const owner=API.isOwner(),its=Inv.items(),S=its.map(it=>({it,S:Inv.state(it)})),t=today();
  const low=S.filter(x=>x.S.level==="low"),out=S.filter(x=>x.S.level==="out"),need=Inv.restock().filter(l=>!l.done),noMin=S.filter(x=>x.it.mode!=="status"&&!x.S.minSet);
  const last=Inv.lastUpdate(),done=its.filter(it=>Inv.rec(t,it.id)).length,sp=owner?Inv.spend(t.slice(0,8)+"01",t):null,pct=its.length?Math.round(done/its.length*100):0;
  const tiles=invPages().filter(p=>p[0]!=="dash"&&p[0]!=="restock").map(([k,l])=>`<button class="tile" data-a="invPage" data-id="${k}">${invIco(k)}<span>${l}</span></button>`).join("");
  return`<h2>Stock dashboard</h2>
  <button class="card todaycard" data-a="invPage" data-id="daily"><div class="row between"><div><b style="font-size:16px">Today's stock update</b><div class="muted">${fmtD(t)}</div></div><div class="big ${done===its.length?"g":""}">${done}<small>/${its.length}</small></div></div>
   <div class="pbar"><i style="width:${pct}%"></i></div><div class="row between" style="margin-top:8px"><span class="muted">${done===its.length?"All items done":`${its.length-done} item${its.length-done>1?"s":""} left`}</span><span class="badge ${done===its.length?"b-green":"b-amber"}">${done===its.length?"Done ✓":"Update now ›"}</span></div></button>
  <div class="grid2">
   <button class="stat ${out.length?"red":""}" style="text-align:left" data-a="invPage" data-id="restock"><div class="l">Out of stock</div><div class="v">${out.length}</div></button>
   <button class="stat ${low.length?"orange":""}" style="text-align:left" data-a="invPage" data-id="restock"><div class="l">Running low</div><div class="v">${low.length}</div></button>
   <button class="stat" style="text-align:left" data-a="invPage" data-id="restock"><div class="l">Need purchasing</div><div class="v">${need.length}</div></button>
   <div class="stat"><div class="l">Total items</div><div class="v">${its.length}</div></div>
   <div class="stat" ${owner?"":'style="grid-column:1/-1"'}><div class="l">Last stock update</div><div class="v" style="font-size:15px">${last?`${fmtDs(last.date)} · ${esc(last.by)}`:"None yet"}</div>${last?`<div class="muted">${new Date(last.at).toLocaleString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}</div>`:""}</div>
   ${owner?`<button class="stat hl" style="text-align:left" data-a="invPage" data-id="reports" data-view="spend"><div class="l">Spent this month</div><div class="v">${RM(sp.total)}</div>${sp.unpriced?`<div class="muted" style="color:#ffd48a">${sp.unpriced} without price</div>`:""}</button>`:""}
  </div>
  ${out.length||low.length?`<h3>Alerts (${out.length+low.length})</h3><div class="card list">${[...out,...low].map(({it,S})=>`<button class="item irow ${invRowCls(S.level)}" data-a="invItem" data-id="${it.id}">${invHead(it,invLevelBadge(S.level))}${invQtyBox(it)}${invChev}</button>`).join("")}</div>`:""}
  <h3>Categories</h3><div class="grid2">${INV_CATS.map(c=>{const l=S.filter(x=>x.it.cat===c.id),lo=l.filter(x=>x.S.level==="low").length,ou=l.filter(x=>x.S.level==="out").length;
    return`<button class="catcard" data-a="invCat" data-id="${c.id}"><b>${c.en}</b><div class="n">${l.length} items</div><div class="al">${ou?`<span class="pill" style="background:#fbe9e7;color:#b3261e">${ou} out</span> `:""}${lo?`<span class="pill" style="background:#ffe8d1;color:#a14d00">${lo} low</span>`:""}${!ou&&!lo?"All OK":""}</div></button>`;}).join("")}</div>
  ${owner&&noMin.length?`<div class="note" style="margin-top:12px"><b>${noMin.length} item${noMin.length>1?"s have":" has"} no minimum level</b>, so ${noMin.length>1?"they":"it"} can't warn you before running low (out of stock still shows).<br><button class="btn sm brown" style="margin-top:8px" data-a="invLevels">Set minimum levels</button></div>`:""}
  <h3>Stock menu</h3><div class="tiles">${tiles}<button class="tile" data-a="invPage" data-id="restock">${invIco("restock")}<span>Restock list${need.length?` <b class="tn">${need.length}</b>`:""}</span></button></div>
  <button class="btn brown block" style="margin-top:12px" data-a="invBuy">${owner?"+ Record purchase":"+ Record stock received"}</button>`;}

/* ----- INVENTORY LIST ----- */
function invItemsView(){const owner=API.isOwner(),c=ui.invCat||"all",its=Inv.items().filter(it=>c==="all"||it.cat===c);
  const arch=owner?DB.invItems.filter(i=>i.active===false):[];
  return`<div class="row between"><h2 style="margin:0">Inventory</h2>${owner?`<button class="btn sm brown" data-a="invItemEdit" data-id="">+ Add item</button>`:""}</div>
  <div class="chips" style="margin-top:10px"><button class="chip ${c==="all"?"on":""}" data-a="invCat" data-id="all">All (${Inv.items().length})</button>${INV_CATS.map(k=>`<button class="chip ${c===k.id?"on":""}" data-a="invCat" data-id="${k.id}">${k.en} (${Inv.items().filter(i=>i.cat===k.id).length})</button>`).join("")}</div>
  <input class="search" type="search" placeholder="Search item" data-filter="invList" autocomplete="off">
  <div id="invList">${INV_CATS.filter(k=>c==="all"||c===k.id).map(k=>{const l=its.filter(i=>i.cat===k.id);if(!l.length)return"";
    return`<div class="lhead"><h3>${k.en} </h3><span>Stock now</span></div><div class="card list">${l.map(it=>{const S=Inv.state(it);
      const tags=invLevelBadge(S.level);
      return`<button class="item irow ${invRowCls(S.level)}" data-a="invItem" data-id="${it.id}" data-name="${esc((it.name+" "+(it.en||"")).toLowerCase())}">${invHead(it,tags,it.note?esc(it.note):"")}${invQtyBox(it)}${invChev}</button>`;}).join("")}</div>`;}).join("")}
   <div class="empty" data-none style="display:none">No item matches.</div></div>
  ${!its.length?`<div class="empty">No items in this category.</div>`:""}
  ${arch.length?`<h3>Archived (${arch.length})</h3><div class="card list">${arch.map(it=>`<button class="item irow" data-a="invItemEdit" data-id="${it.id}">${invHead(it,"","Archived · history kept")}${invChev}</button>`).join("")}</div>`:""}`;}
function invItemSheet(s){const it=Inv.item(s.id),owner=API.isOwner();if(!it)return`<div class="empty">Item not found.</div>`;const S=Inv.state(it),t=today();
  const recent=Inv.recs(it.id).slice(-10).reverse();
  return`<div class="row between"><h2 style="margin:0">${esc(it.name)}</h2>${owner?`<button class="btn sm ghost" data-a="invItemEdit" data-id="${it.id}">Edit</button>`:""}</div>
  <p class="muted" style="margin-top:4px">${INV_CAT[it.cat].en}${it.en?` · ${esc(it.en)}`:""}${it.note?` · ${esc(it.note)}`:""}</p>
  <div class="card ${invRowCls(S.level)}"><div class="row between"><b>Current stock</b>${invLevelBadge(S.level)||(S.minSet?`<span class="badge b-green">OK</span>`:"")}</div>
   ${it.mode==="status"?`<div style="font-size:20px;font-weight:700;margin-top:6px">${INV_ST[S.st]}</div>`:S.lines.map(l=>`<div class="uline"><span>${esc(l.u.name)}</span><span><b style="font-size:18px">${fq(l.qty)}</b> <span class="muted">${l.min!=null?`min ${fq(l.min)}`:"no min"}${l.u.target!=null?` · target ${fq(l.u.target)}`:""}</span></span></div>`).join("")}
   ${S.combined?`<div class="muted" style="margin-top:4px">Combined: ${qu(S.total,it.units[0].name)} (${it.units.slice(1).map(u=>`1 ${u.name} = ${fq(u.per)} ${it.units[0].name}`).join(", ")})</div>`:""}</div>
  <div class="grid2"><button class="btn" data-a="invCount" data-id="${it.id}" data-date="${t}">Today's update</button>${it.mode!=="status"||it.units.length?`<button class="btn brown" data-a="invBuy" data-item="${it.id}">${owner?"Record purchase":"Stock received"}</button>`:"<span></span>"}</div>
  ${owner&&it.units.length?`<h3>Latest prices</h3><div class="card">${it.units.map(u=>{const l=Inv.priced(it,u.id);if(!l.length)return`<div class="uline"><span>${esc(u.name)}</span><span class="muted">No price yet</span></div>`;
    const a=l[l.length-1],b=l.length>1?l[l.length-2]:null;return`<button class="uline" style="width:100%;background:none;border:0;padding:6px 0" data-a="invPriceItem" data-id="${it.id}|${u.id}"><span>${esc(u.name)}</span><span><b>${RM(a.pr.up)}</b> ${b?invChangeBadge(Inv.change(a.pr.up,b.pr.up)):""} ›</span></button>`;}).join("")}</div>`:""}
  <h3>Recent stock updates</h3>
  ${recent.length?`<div class="card">${it.mode==="status"?`<table class="tight"><thead><tr><th>Date</th><th>Status</th><th>By</th></tr></thead><tbody>${recent.map(r=>`<tr><td>${fmtDs(r.date)}</td><td>${INV_ST[r.st]||""}</td><td>${esc(r.by)}</td></tr>`).join("")}</tbody></table>`
    :it.units.map(u=>{const c=Inv.chain(it,u.id).slice(-10).reverse();return`${it.units.length>1?`<b>${esc(u.name)}</b>`:""}<table class="tight"><thead><tr><th>Date</th><th>Open</th><th>In</th><th>Used</th><th>Waste</th><th>Close</th><th>Diff</th></tr></thead><tbody>${c.map(e=>`<tr><td>${fmtDs(e.date)}</td><td>${fq(e.open)}</td><td>${fq(e.recv)}</td><td>${fq(e.used)}</td><td>${fq(e.waste)}</td><td>${e.close==null?`<span class="muted">${fq(e.exp)}*</span>`:fq(e.close)}</td><td>${e.disc==null?"":e.disc===0?`<span class="up">✓</span>`:`<span class="${e.disc<0?"down":""}" style="${e.disc>0?"color:#a14d00;font-weight:700":""}">${signed(e.disc)}</span>`}</td></tr>`).join("")}</tbody></table>`;}).join("")}
    <div class="muted" style="margin-top:6px">* not counted, expected figure used.</div></div>`:`<div class="card empty">No daily updates yet. Opening stock: ${esc(Inv.stockText(it))} (from ${fmtD(it.startDate)}).</div>`}
  ${owner?`<button class="btn ghost block" data-a="invHistItem" data-id="${it.id}">Stock history chart</button>`:""}`;}

/* ----- DAILY UPDATE ----- */
function invDayStatus(it,d){const r=Inv.rec(d,it.id);
  if(!r)return{done:false,tag:"",right:`<div class="qty">${invStPill("none")}</div>`,sub:`Opening ${it.mode==="status"?INV_ST[Inv.statusAt(it,addDays(d,-1))]:it.units.map(u=>qu(Inv.openFor(it,u.id,d),u.name)).join(" + ")}`};
  const by=`${esc(r.by)} ${fmtT(r.at)}${r.v>1?` · corrected ${r.v-1}×`:""}`;
  if(it.mode==="status")return{done:true,tag:"",right:`<div class="qty">${invStPill(r.st||"available")}</div>`,sub:by};
  const es=it.units.map(u=>({u,e:Inv.entry(it,u.id,d)})).filter(x=>x.e&&r.lines[x.u.id]),nc=es.filter(x=>x.e.close==null),bad=es.filter(x=>x.e.disc);
  const tag=bad.length?`<span class="badge ${bad.some(x=>x.e.disc<0)?"b-red":"b-orange"}">Discrepancy ${bad.map(x=>signed(x.e.disc)).join(", ")}</span>`
    :nc.length===es.length?`<span class="badge b-amber">Not counted</span>`:nc.length?`<span class="badge b-amber">Partly counted</span>`:`<span class="badge b-green">✓ Reconciled</span>`;
  const right=`<div class="qty">${es.map(x=>`<div class="ql ${x.e.disc<0?"q-out":x.e.disc>0?"q-low":x.e.close!=null?"q-ok":""}"><b>${fq(x.e.close==null?x.e.exp:x.e.close)}</b><small>${esc(plur(x.u.name,x.e.end))}${x.e.close==null?" (exp.)":""}</small></div>`).join("")}</div>`;
  return{done:true,disc:bad.length>0,tag,right,sub:by};}
function invDaily(){const d=ui.invDate||(ui.invDate=today()),edit=Inv.canEdit(d),c=ui.invDCat||"all",all=Inv.items(),its=all.filter(it=>c==="all"||it.cat===c);
  const st=new Map(all.map(it=>[it.id,invDayStatus(it,d)])),done=all.filter(it=>st.get(it.id).done).length,disc=all.filter(it=>st.get(it.id).disc).length,pct=all.length?Math.round(done/all.length*100):0;
  const row=it=>{const x=st.get(it.id);return`<button class="item irow ${x.done?"":"todo"}" data-a="invCount" data-id="${it.id}" data-date="${d}" data-name="${esc((it.name+" "+(it.en||"")).toLowerCase())}">${invHead(it,x.tag,x.sub)}${x.right}${invChev}</button>`;};
  const list=INV_CATS.filter(k=>c==="all"||c===k.id).map(k=>{const l=its.filter(i=>i.cat===k.id);if(!l.length)return"";const n=l.filter(i=>st.get(i.id).done).length;
    return`<div class="lhead"><h3>${k.en} </h3><span>${n}/${l.length} done</span></div><div class="card list">${l.map(row).join("")}</div>`;}).join("");
  return`<div class="datebar"><button data-a="invDay" data-id="-1">‹</button><div class="d">${dayName(d)}, ${fmtD(d)}<small>${d===today()?"Today":`<span data-a="invDayToday" style="text-decoration:underline">Go to today</span>`}</small></div><button data-a="invDay" data-id="1" ${d>=today()?"disabled style='opacity:.3'":""}>›</button></div>
  <div class="card" style="padding:12px 14px"><div class="row between"><div><div class="muted">Items updated</div><div class="big ${done===all.length?"g":""}">${done}<small>/${all.length}</small></div></div>
   <div class="right"><div class="muted">Discrepancies</div><div class="big ${disc?"r":""}">${disc}</div></div></div><div class="pbar"><i style="width:${pct}%"></i></div></div>
  ${edit?"":`<div class="note">View only. Only the owner can change records from earlier days.</div>`}
  <div class="chips"><button class="chip ${c==="all"?"on":""}" data-a="invDCat" data-id="all">All</button>${INV_CATS.map(k=>`<button class="chip ${c===k.id?"on":""}" data-a="invDCat" data-id="${k.id}">${k.en}</button>`).join("")}</div>
  <input class="search" type="search" placeholder="Search item" data-filter="invDList" autocomplete="off">
  <div id="invDList">${list}<div class="empty" data-none style="display:none">No item matches.</div></div>
  <p class="muted">Tap an item: enter what was used and wasted, then count what is left. Yesterday's closing and today's purchases fill in automatically. Right side = closing stock (exp. = expected, not counted yet).</p>`;}
function invCountSheet(s,err){const it=Inv.item(s.id);if(!it)return`<div class="empty">Item not found.</div>`;const d=s.date,r=Inv.rec(d,it.id),edit=Inv.canEdit(d)&&it.active!==false;s.f=s.f||{};const dis=edit?"":"disabled";
  let h=`<h2 style="margin-bottom:2px">${esc(it.name)}</h2><p class="muted" style="margin-top:0">${INV_CAT[it.cat].en}${it.en?` · ${esc(it.en)}`:""} · ${dayName(d)}, ${fmtD(d)}</p>${err}
  ${edit?"":`<div class="note">${it.active===false?"This item is archived.":"View only. Only the owner can change records from earlier days."}</div>`}`;
  if(it.mode==="status"){const cur=fv(s,"st",r&&r.st?r.st:Inv.statusAt(it,addDays(d,-1)));s.f.st=cur;
    h+=`<div class="card"><b>Status today</b><div class="seg" style="margin:10px 0 0">${Object.entries(INV_ST).map(([k,l])=>`<button class="${cur===k?"on":""}" data-a="invSt" data-id="${k}" ${dis}>${l}</button>`).join("")}</div></div>`;}
  else it.units.forEach(u=>{const L=(r&&r.lines&&r.lines[u.id])||{},open=Inv.openFor(it,u.id,d),bought=Inv.bought(it,u.id,d,d);
    const v=k=>fv(s,`${u.id}.${k}`,L[k]==null?"":String(L[k]));
    const rx=parseQ(v("rx"))||0,us=parseQ(v("us"))||0,ws=parseQ(v("ws"))||0,exp=q3(open+bought+rx-us-ws),cl=parseQ(v("cl"));
    const prevE=Inv.chain(it,u.id).filter(e=>e.date<d).pop();
    h+=`<div class="card ucard" data-u="${u.id}" data-open="${open}" data-bought="${bought}"><h4>${esc(u.name[0].toUpperCase()+u.name.slice(1))}</h4>
     <div class="calc"><div class="r"><span>Opening stock</span><b>${fq(open)}</b></div><div class="muted" style="margin:-2px 0 4px">${prevE?`Closing of ${fmtDs(prevE.date)}${prevE.close==null?" (expected, not counted)":""}`:`Starting stock`}${q3(open-(prevE?prevE.end:Inv.start(it,u.id)))?" + purchases since":""}</div>
     <div class="r"><span>Purchased today (Purchases page)</span><b>${fq(bought)}</b></div></div>
     <div class="grid2" style="margin-top:8px">
      <div class="field"><label>Other stock received</label><input id="ic_${u.id}_rx" data-k="${u.id}.rx" inputmode="decimal" placeholder="0" value="${esc(v("rx"))}" ${dis}></div>
      <div class="field"><label>Used for production</label><input id="ic_${u.id}_us" data-k="${u.id}.us" inputmode="decimal" placeholder="0" value="${esc(v("us"))}" ${dis}></div>
      <div class="field"><label>Wastage / damaged</label><input id="ic_${u.id}_ws" data-k="${u.id}.ws" inputmode="decimal" placeholder="0" value="${esc(v("ws"))}" ${dis}></div>
      <div class="field"><label>Physical closing</label><input id="ic_${u.id}_cl" data-k="${u.id}.cl" inputmode="decimal" placeholder="count" value="${esc(v("cl"))}" ${dis} style="border-color:var(--navy)"></div></div>
     <div class="calc"><div class="r t" style="font-size:16px"><span>Expected closing</span><span class="exp">${fq(exp)}</span></div><div class="eq">Opening + received − used − wastage<br><span class="eqv">${invEq(open,q3(bought+rx),us,ws,exp)}</span></div></div>
     <div class="discbox">${invDiscBox(exp,cl)}</div></div>`;});
  if(it.mode!=="status"&&edit)h+=`<button class="btn ghost block" style="margin-bottom:12px" data-a="invBuy" data-item="${it.id}" data-date="${d}">+ Record a purchase for ${esc(it.name)}</button>`;
  h+=`<div class="field"><label>Remarks</label><input id="icRm" data-k="rm" value="${esc(fv(s,"rm",r?r.rm||"":""))}" placeholder="optional" ${dis}></div>
  <div class="field"><label>Updated by</label><input value="${esc(Inv.me())}" disabled></div>`;
  if(r){h+=`${edit?`<div class="field"><label>Reason for correction ${s.needWhy?"(required)":"(only if you change saved figures)"}</label><input id="icWhy" data-k="why" value="${esc(fv(s,"why",""))}" placeholder="e.g. miscounted eggs" ${s.needWhy?'style="border-color:var(--red)"':""}></div>`:""}
    <p class="muted">Saved by ${esc(r.cBy)} ${new Date(r.cAt).toLocaleString("en-GB")}${r.v>1?` · last change by ${esc(r.by)} ${new Date(r.at).toLocaleString("en-GB")}`:""}</p>`;
    if(r.hist&&r.hist.length)h+=`<details><summary>Correction history (${r.hist.length})</summary>${r.hist.slice().reverse().map(x=>`<div class="hist"><b>${new Date(x.chAt).toLocaleString("en-GB")} · ${esc(x.chBy)}</b>${x.why?` · reason: ${esc(x.why)}`:""}<br>Before: ${esc(Inv.summary(it,x))||"—"}</div>`).join("")}</details>`;}
  if(edit)h+=`<div class="totalbar"><div class="grid2"><button class="btn" data-a="invSaveCount">${r?"Save changes":"Save"}</button><button class="btn brown" data-a="invSaveCount" data-id="next">Save & next ›</button></div></div>`;
  return h;}
function invCountPatch(it){const lines={};
  if(it.mode==="status")return{patch:{st:ui.sheet.f.st,rm:val("icRm")}};
  for(const u of it.units){const L={};for(const k of["rx","us","ws","cl"]){const v=parseQ(val(`ic_${u.id}_${k}`));
    if(v==null)return{err:`${u.name}: "${({rx:"Other received",us:"Used",ws:"Wastage",cl:"Physical closing"})[k]}" must be a number (e.g. 3 or 1.5)`};
    L[k]=k==="cl"?(v===""?null:v):(v===""?0:v);}lines[u.id]=L;}
  return{patch:{lines,rm:val("icRm")}};}

/* ----- USAGE TRACKER ----- */
function invUsage(){const d=ui.invUDate||(ui.invUDate=today()),edit=Inv.canEdit(d),raw=Inv.items(true).filter(it=>it.raw&&it.mode!=="status"),est=Inv.estimate(d),P=Inv.m().prod.get(d);
  const lines=[];raw.forEach(it=>it.units.forEach(u=>{const e=Inv.entry(it,u.id,d);if(e&&e.used)lines.push({it,u,used:e.used});}));
  const wk=monday(d),wl=[];raw.forEach(it=>it.units.forEach(u=>{const m=invMove(it,u.id,wk,d);if(m.used)wl.push({it,u,used:m.used});}));
  const recs=DB.invRecipes.filter(r=>r.active!==false);
  return`<div class="datebar"><button data-a="invUDay" data-id="-1">‹</button><div class="d">${dayName(d)}, ${fmtD(d)}<small>${d===today()?"Today":`<span data-a="invUDayToday" style="text-decoration:underline">Go to today</span>`}</small></div><button data-a="invUDay" data-id="1" ${d>=today()?"disabled style='opacity:.3'":""}>›</button></div>
  <div class="card" style="border:2px solid var(--sand)"><b style="font-size:16px">Production Usage – ${new Date(d+"T00:00:00").getDate()} ${["January","February","March","April","May","June","July","August","September","October","November","December"][new Date(d+"T00:00:00").getMonth()]}</b>
   ${lines.length?`<div style="margin-top:8px">${lines.map(l=>`<div class="uline"><span>${esc(Inv.label(l.it))}${l.it.units.length>1?` · ${esc(l.u.name)}`:""}</span><b>${qu(l.used,l.u.name)}</b></div>`).join("")}</div>`:`<div class="empty" style="padding:12px 0">No usage recorded for this day yet.</div>`}
   ${edit?`<button class="btn block" style="margin-top:10px" data-a="invUsageForm">${lines.length?"Change usage":"Record usage"}</button>`:`<div class="muted" style="margin-top:8px">View only. Only the owner can change earlier days.</div>`}</div>
  ${recs.length?`<h3>Production & recipe estimate</h3><div class="card">${P&&Object.keys(P.qty||{}).length?`<div class="muted" style="margin-bottom:6px">Produced: ${recs.filter(r=>P.qty[r.id]).map(r=>`${fq(P.qty[r.id])} ${plur(r.out,P.qty[r.id])} ${esc(r.name)}`).join(", ")}</div>
    <table class="tight"><thead><tr><th>Ingredient</th><th>Estimated</th><th>Actual</th><th>Diff</th></tr></thead><tbody>${[...est.entries()].map(([k,v])=>{const[iid,uidv]=k.split("|"),it=Inv.item(iid),u=it&&Inv.unit(it,uidv);if(!u)return"";const e=Inv.entry(it,uidv,d),a=e?e.used:0;
      return`<tr><td>${esc(it.name)} <span class="muted">${esc(u.name)}</span></td><td>${fq(v)}</td><td>${fq(a)}</td><td>${a?`<span style="color:${q3(a-v)>0?"var(--red)":q3(a-v)<0?"var(--green)":"inherit"};font-weight:700">${signed(q3(a-v))}</span>`:""}</td></tr>`;}).join("")}</tbody></table>
    <div class="muted" style="margin-top:6px">Estimated = production × your recipe quantities. Actual = usage recorded.</div>`:`<div class="muted">No production recorded for this day.</div>`}
    ${edit?`<button class="btn sec block" style="margin-top:10px" data-a="invProdForm">Record production</button>`:""}</div>`
   :API.isOwner()?`<p class="muted">Tip: set up recipes in Stock → Settings to estimate ingredient use from production. Nothing is estimated until you set them up.</p>`:""}
  <h3>This week so far (${fmtDs(wk)} – ${fmtDs(d)})</h3><div class="card">${wl.length?wl.map(l=>`<div class="uline"><span>${esc(Inv.label(l.it))}${l.it.units.length>1?` · ${esc(l.u.name)}`:""}</span><b>${qu(l.used,l.u.name)}</b></div>`).join(""):`<div class="empty" style="padding:8px 0">No usage this week yet.</div>`}</div>
  ${API.isOwner()?`<button class="btn ghost block" data-a="invPage" data-id="reports" data-view="usage">Daily / weekly / monthly usage report</button>`:""}`;}
function invUsageSheet(s,err){const d=ui.invUDate,raw=Inv.items().filter(it=>it.raw&&it.mode!=="status");s.f=s.f||{};let anySaved=false;
  const rows=INV_CATS.map(k=>{const l=raw.filter(i=>i.cat===k.id);if(!l.length)return"";return`<h3>${k.en}</h3>`+l.map(it=>it.units.map(u=>{const r=Inv.rec(d,it.id),o=r&&r.lines&&r.lines[u.id]?r.lines[u.id].us:undefined;if(o!=null)anySaved=true;
    return`<div class="step"><div class="lbl"><b>${esc(Inv.label(it))}</b><span class="muted">${esc(u.name)}${o!=null?` · saved ${fq(o)}`:""}</span></div><div class="ctl"><input style="width:84px" id="iu_${it.id}_${u.id}" data-k="${it.id}.${u.id}" inputmode="decimal" placeholder="0" value="${esc(fv(s,`${it.id}.${u.id}`,o!=null?String(o):""))}"></div></div>`;}).join("")).join("");}).join("");
  return`<h2>Record usage</h2><p class="muted" style="margin-top:-8px">${dayName(d)}, ${fmtD(d)} · quantity used for production</p>${err}${rows||`<div class="empty">No raw materials set up. The owner can tick "Raw material" on an item.</div>`}
  ${anySaved?`<div class="field" style="margin-top:12px"><label>Reason for correction ${s.needWhy?"(required)":"(only if you change saved figures)"}</label><input id="iuWhy" data-k="why" value="${esc(fv(s,"why",""))}" ${s.needWhy?'style="border-color:var(--red)"':""}></div>`:""}
  <p class="muted">Saved into the same daily stock record, so the daily update and reports always match. Recorded as ${esc(Inv.me())}.</p>
  <div class="totalbar"><button class="btn block" data-a="invSaveUsage">Save usage</button></div>`;}
function invProdSheet(s,err){const d=ui.invUDate,P=Inv.m().prod.get(d),recs=DB.invRecipes.filter(r=>r.active!==false);s.f=s.f||{};
  return`<h2>Production</h2><p class="muted" style="margin-top:-8px">${dayName(d)}, ${fmtD(d)}</p>${err}
  ${recs.map(r=>`<div class="step"><div class="lbl"><b>${esc(r.name)}</b><span class="muted">${esc(r.out)}s produced</span></div><div class="ctl"><input style="width:84px" id="ip_${r.id}" data-k="${r.id}" inputmode="decimal" placeholder="0" value="${esc(fv(s,r.id,P&&P.qty[r.id]!=null?String(P.qty[r.id]):""))}"></div></div>`).join("")}
  ${P?`<div class="field"><label>Reason for correction ${s.needWhy?"(required)":"(only if you change saved figures)"}</label><input id="ipWhy" data-k="why" value="${esc(fv(s,"why",""))}"></div>`:""}
  <p class="muted">Used only to estimate ingredient use from your recipes. Actual usage still comes from the usage you record.</p>
  <button class="btn block" data-a="invSaveProd">Save production</button>`;}

/* ----- PURCHASES / STOCK RECEIVED ----- */
function invBuysView(){const owner=API.isOwner(),t=today(),f=ui.invBP||(owner?"month":"week");
  const ranges={today:[t,t],week:[addDays(t,-6),t],month:[t.slice(0,8)+"01",t],lastmonth:(()=>{const D=new Date(t+"T00:00:00");return[iso(new Date(D.getFullYear(),D.getMonth()-1,1)),iso(new Date(D.getFullYear(),D.getMonth(),0))];})(),all:["0000-00-00","9999-12-31"]};
  const[a,b]=ranges[f]||ranges.month,L=DB.invBuys.filter(p=>p.date>=a&&p.date<=b).sort((x,y)=>y.date.localeCompare(x.date)||(y.cAt||0)-(x.cAt||0));
  let tot=0,miss=0;L.forEach(p=>{const pr=Inv.price(p.id);if(pr&&pr.total!=null)tot+=pr.total;else miss++;});
  return`<div class="row between"><h2 style="margin:0">${owner?"Purchases":"Stock received"}</h2><button class="btn sm brown" data-a="invBuy">+ ${owner?"Record purchase":"Record received"}</button></div>
  <div class="chips" style="margin-top:10px">${(owner?[["today","Today"],["week","Last 7 days"],["month","This month"],["lastmonth","Last month"],["all","All"]]:[["today","Today"],["week","Last 7 days"]]).map(([k,l])=>`<button class="chip ${f===k?"on":""}" data-a="invBP" data-id="${k}">${l}</button>`).join("")}</div>
  ${owner?`<div class="grid2"><div class="stat hl"><div class="l">Total spent</div><div class="v">${RM(tot)}</div></div><div class="stat ${miss?"orange":""}"><div class="l">Purchases / without price</div><div class="v">${L.length} / ${miss}</div></div></div>`:""}
  <input class="search" style="margin-top:12px" type="search" placeholder="Search item or supplier" data-filter="invBList" autocomplete="off">
  <div id="invBList">${L.length?(()=>{const days=[];L.forEach(p=>{let g=days.find(x=>x.d===p.date);if(!g)days.push(g={d:p.date,l:[]});g.l.push(p);});
    return days.map(g=>{const sum=g.l.reduce((a,p)=>{const pr=Inv.price(p.id);return a+(pr&&pr.total!=null?pr.total:0);},0);
      return`<div class="lhead"><h3>${dayName(g.d)}, ${fmtD(g.d)}</h3><span>${owner?RM(sum):g.l.length+" received"}</span></div><div class="card list">${g.l.map(p=>{const it=Inv.item(p.itemId),u=it&&Inv.unit(it,p.unitId),pr=owner?Inv.price(p.id):null,pv=pr?Inv.prevPrice(p):null;
        const tags=owner?(pr?(pv?invChangeBadge(Inv.change(pr.up,pv.pr.up)):`<span class="badge b-navy">First price</span>`):`<span class="badge b-amber">Price missing</span>`):"";
        const sub=[Inv.supName(p)?esc(Inv.supName(p)):"",p.inv?"ref "+esc(p.inv):"",esc(p.cBy)+(p.v>1?" (edited)":"")].filter(Boolean).join(" · ");
        return`<button class="item irow" data-a="invBuy" data-id="${p.id}" data-name="${esc(((it?it.name+" "+(it.en||""):"")+" "+Inv.supName(p)+" "+(p.inv||"")).toLowerCase())}"><div class="grow"><div class="nm">${esc(it?it.name:"(deleted item)")}</div><div class="muted">${sub}</div>${tags?`<div class="tags">${tags}</div>`:""}</div>
          <div class="qty">${owner&&pr?`<div class="ql"><b>${RM(pr.total)}</b><small>${qu(p.qty,u?u.name:"")} × ${RM(pr.up)}</small></div>`:`<div class="ql"><b>${fq(p.qty)}</b><small>${esc(plur(u?u.name:"",p.qty))}</small></div>`}</div>${invChev}</button>`;}).join("")}</div>`;}).join("");})()+`<div class="empty" data-none style="display:none">No match.</div>`:`<div class="card empty">Nothing recorded in this period.</div>`}</div>
  <p class="muted">${owner?"Purchases add to stock automatically on their date. Staff can record stock received without prices; add the price later by tapping the purchase.":"Stock received adds to stock automatically. The owner adds the price."}</p>`;}
function invBuySheet(s,err){const owner=API.isOwner();s.f=s.f||{};const p=s.id?DB.invBuys.find(x=>x.id===s.id):null,pr=p&&owner?Inv.price(p.id):null;
  if(s.id&&!p)return`<div class="empty">This purchase was deleted.</div>`;
  const edit=!p||owner||p.date===today();const dis=edit?"":"disabled";
  const itemId=fv(s,"itemId",p?p.itemId:(s.item||"")),it=itemId?Inv.item(itemId):null,units=it?it.units:[];
  let unitId=fv(s,"unitId",p?p.unitId:(units[0]?units[0].id:""));if(it&&!units.some(u=>u.id===unitId))unitId=units[0]?units[0].id:"";s.f.itemId=itemId;s.f.unitId=unitId;
  const u=it?Inv.unit(it,unitId):null,sups=DB.invSup.filter(x=>x.active!==false||(p&&p.supId===x.id));
  const supId=fv(s,"supId",p?(p.supId||(p.supName?"other":"")):(it&&it.supId?it.supId:""));
  const qty=fv(s,"qty",p?String(p.qty):""),up=fv(s,"up",pr&&pr.up!=null?s2d(pr.up):""),total=fv(s,"total",pr&&pr.total!=null?s2d(pr.total):"");
  const last=owner&&it&&u?Inv.priced(it,u.id).filter(x=>!p||x.p.id!==p.id).filter(x=>!p||x.p.date<p.date||(x.p.date===p.date&&(x.p.cAt||0)<(p.cAt||0))).pop():null;
  const items=Inv.items().filter(i=>i.units.length||(p&&p.itemId===i.id));
  const upS=toSen(up);
  return`<h2>${p?(owner?"Purchase":"Stock received"):owner?"Record purchase":"Record stock received"}</h2>${err}
  ${s.dup?`<div class="note"><b>Possible duplicate.</b> Tap <b>Save anyway</b> only if this is a separate purchase.</div>`:""}
  ${!edit?`<div class="note">View only. Only the owner can change earlier records.</div>`:""}
  <div class="field"><label>Purchase date</label><input type="date" id="ibDate" data-k="date" value="${esc(fv(s,"date",p?p.date:(s.date||today())))}" max="${today()}" ${owner?dis:"disabled"}></div>
  <div class="field"><label>Item</label><select id="ibItem" data-k="itemId" data-rr="1" ${dis}><option value="">Choose item…</option>${INV_CATS.map(k=>`<optgroup label="${k.en}">${items.filter(i=>i.cat===k.id).map(i=>`<option value="${i.id}" ${i.id===itemId?"selected":""}>${esc(i.name)}${i.en?" · "+esc(i.en):""}</option>`).join("")}</optgroup>`).join("")}</select></div>
  ${it&&!units.length?`<div class="note">${esc(it.name)} has no units yet. ${owner?"Add one (e.g. bundle) in the item settings first.":"Ask the owner to add a unit."}</div>`:""}
  <div class="grid2"><div class="field"><label>Quantity</label><input id="ibQty" data-k="qty" inputmode="decimal" value="${esc(qty)}" placeholder="e.g. 2" ${dis}></div>
  <div class="field"><label>Unit</label><select id="ibUnit" data-k="unitId" data-rr="1" ${dis}>${units.map(x=>`<option value="${x.id}" ${x.id===unitId?"selected":""}>${esc(x.name)}</option>`).join("")}</select></div></div>
  <div class="field"><label>Supplier</label><select id="ibSup" data-k="supId" data-rr="1" ${dis}><option value="">— none —</option>${sups.map(x=>`<option value="${x.id}" ${x.id===supId?"selected":""}>${esc(x.name)}</option>`).join("")}<option value="other" ${supId==="other"?"selected":""}>Other (type name)</option></select>
   ${owner&&!sups.length?`<div class="hint">Add your regular suppliers in Stock → Settings.</div>`:""}</div>
  ${supId==="other"?`<div class="field"><label>Supplier name</label><input id="ibSupN" data-k="supName" value="${esc(fv(s,"supName",p?p.supName||"":""))}" placeholder="e.g. Pasar Selayang" ${dis}></div>`:""}
  ${owner?`<div class="grid2"><div class="field"><label>Unit price (RM${u?" / "+esc(u.name):""})</label><input id="ibUp" data-k="up" inputmode="decimal" value="${esc(up)}" placeholder="e.g. 15.00" ${dis}></div>
   <div class="field"><label>Total amount (RM)</label><input id="ibTot" data-k="total" inputmode="decimal" value="${esc(total)}" placeholder="auto" ${dis}></div></div>
   <div class="muted" id="ibCalc" style="margin:-4px 0 10px">${invBuyCalcText(qty,up,total,u)}</div>
   ${last?`<div class="card" style="padding:10px"><div class="muted">Previous purchase of ${esc(it.name)} (${esc(u.name)})</div><div class="row between"><b>${RM(last.pr.up)} / ${esc(u.name)}</b><span class="muted">${fmtDs(last.p.date)}${Inv.supName(last.p)?" · "+esc(Inv.supName(last.p)):""}</span></div><div id="ibCmp" style="margin-top:4px">${upS!=null&&up!==""?invChangeBadge(Inv.change(upS,last.pr.up)):""}</div></div>`:it&&u?`<div class="muted" style="margin-bottom:10px">No earlier price for ${esc(it.name)} per ${esc(u.name)}.</div>`:""}`:""}
  <div class="field"><label>Invoice / receipt no.</label><input id="ibInv" data-k="inv" value="${esc(fv(s,"inv",p?p.inv||"":""))}" placeholder="optional" ${dis}></div>
  <div class="field"><label>Remarks</label><input id="ibRm" data-k="rm" value="${esc(fv(s,"rm",p?p.rm||"":""))}" placeholder="optional" ${dis}></div>
  ${p&&edit?`<div class="field"><label>Reason for change ${s.needWhy?"(required)":"(if you change quantity, date, item or price)"}</label><input id="ibWhy" data-k="why" value="${esc(fv(s,"why",""))}" ${s.needWhy?'style="border-color:var(--red)"':""}></div>`:""}
  ${p?`<p class="muted">Recorded by ${esc(p.cBy)} ${new Date(p.cAt).toLocaleString("en-GB")}${p.v>1?` · changed by ${esc(p.by)} ${new Date(p.at).toLocaleString("en-GB")}`:""}</p>
   ${p.hist&&p.hist.length?`<details><summary>Change history (${p.hist.length})</summary>${p.hist.slice().reverse().map(x=>{const xi=Inv.item(x.itemId),xu=xi&&Inv.unit(xi,x.unitId);return`<div class="hist"><b>${new Date(x.chAt).toLocaleString("en-GB")} · ${esc(x.chBy)}</b>${x.why?` · ${esc(x.why)}`:""}<br>Before: ${fmtDs(x.date)} · ${qu(x.qty,xu?xu.name:"")} ${esc(xi?xi.name:"")}${owner&&x.up!=null?` @ ${RM(x.up)}`:""}</div>`;}).join("")}</details>`:""}`:""}
  ${edit?`<div class="totalbar"><button class="btn block brown" data-a="invSaveBuy">${s.dup?"Save anyway":p?"Save changes":"Save"}</button>${p&&owner?`<button class="btn ghost block" style="margin-top:8px;color:var(--red)" data-a="invDelBuy">Delete purchase</button>`:""}</div>`:""}`;}
function invBuyCalcText(qty,up,total,u,drive){const q=parseQ(qty),a=toSen(up),t=toSen(total);if(!q)return"";
  if(drive==="total"&&t!=null)return`Unit price = ${RM(t)} ÷ ${fq(q)} = <b>${RM(Math.round(t/q))}</b>${u?" / "+esc(u.name):""}`;
  if(a!=null)return`Total = ${fq(q)} × ${RM(a)} = <b>${RM(Math.round(a*q))}</b>`;
  if(t!=null)return`Unit price = ${RM(t)} ÷ ${fq(q)} = <b>${RM(Math.round(t/q))}</b>${u?" / "+esc(u.name):""}`;return"";}

/* ----- PRICE HISTORY ----- */
function invPricesView(){const rows=[],none=[];Inv.items(true).forEach(it=>(it.units||[]).forEach(u=>{const l=Inv.priced(it,u.id);if(!l.length){if(it.active!==false)none.push({it,u});return;}
  const a=l[l.length-1],b=l.length>1?l[l.length-2]:null;rows.push({it,u,a,b,c:b?Inv.change(a.pr.up,b.pr.up):null});}));
  const up=rows.filter(r=>r.c&&r.c.dir==="up").length,dn=rows.filter(r=>r.c&&r.c.dir==="down").length;
  return`<h2>Price history</h2>
  <div class="grid3"><div class="stat red"><div class="l">Increased</div><div class="v">${up}</div></div><div class="stat" style="background:var(--green-bg)"><div class="l">Decreased</div><div class="v" style="color:var(--green)">${dn}</div></div><div class="stat"><div class="l">Items priced</div><div class="v">${rows.length}</div></div></div>
  <p class="muted">Latest vs previous purchase, always per the same unit (a sack is only compared with a sack).</p>
  <div class="card list">${rows.length?rows.map(r=>`<button class="item irow" data-a="invPriceItem" data-id="${r.it.id}|${r.u.id}"><div class="grow"><div class="nm">${esc(r.it.name)}</div><div class="muted">${r.b?`was ${RM(r.b.pr.up)} · `:""}latest ${fmtDs(r.a.p.date)}</div><div class="tags">${r.c?invChangeBadge(r.c):`<span class="badge b-navy">First price</span>`}</div></div>
    <div class="qty"><div class="ql ${r.c&&r.c.dir==="up"?"q-out":r.c&&r.c.dir==="down"?"q-ok":""}"><b>${RM(r.a.pr.up)}</b><small>per ${esc(r.u.name)}</small></div></div>${invChev}</button>`).join(""):`<div class="empty">No purchase prices yet. Record a purchase with its price to start the history.</div>`}</div>
  ${none.length?`<details><summary>No price yet (${none.length})</summary><div class="muted">${none.map(x=>`${esc(x.it.name)} (${esc(x.u.name)})`).join(", ")}</div></details>`:""}`;}
function invPriceSheet(s){const[iid,uidv]=s.id.split("|"),it=Inv.item(iid),u=it&&Inv.unit(it,uidv);if(!u)return`<div class="empty">Not found.</div>`;
  const l=Inv.priced(it,u.id),a=l[l.length-1],b=l.length>1?l[l.length-2]:null,c=b?Inv.change(a.pr.up,b.pr.up):null,sups=Inv.suppliers(it,u.id);
  const names=[...new Set(l.map(x=>Inv.supName(x.p)||"(no supplier)"))],labels=l.map(x=>fmtDs(x.p.date));
  const series=names.length>1?names.map(n=>({name:n,vals:l.map(x=>(Inv.supName(x.p)||"(no supplier)")===n?x.pr.up:null),dots:true})):[{name:"Unit price",vals:l.map(x=>x.pr.up)}];
  const qWarn=a&&b&&(a.p.qty>=b.p.qty*3||b.p.qty>=a.p.qty*3);
  return`<h2 style="margin-bottom:2px">${esc((it.en||it.name).toUpperCase())} PRICE HISTORY</h2><p class="muted" style="margin-top:0">${esc(it.name)} · per ${esc(u.name)}</p>
  ${a?`<div class="card calc">${b?`<div class="r"><span>Previous purchase</span><b>${RM(b.pr.up)} / ${esc(u.name)}</b></div><div class="muted" style="margin-top:-2px">${fmtD(b.p.date)} · ${qu(b.p.qty,u.name)}${Inv.supName(b.p)?" · "+esc(Inv.supName(b.p)):""}</div>`:""}
   <div class="r"><span>Latest purchase</span><b>${RM(a.pr.up)} / ${esc(u.name)}</b></div><div class="muted" style="margin-top:-2px">${fmtD(a.p.date)} · ${qu(a.p.qty,u.name)}${Inv.supName(a.p)?" · "+esc(Inv.supName(a.p)):""}</div>
   ${c?`<div class="r t"><span>Difference</span><span style="color:${c.dir==="up"?"var(--red)":c.dir==="down"?"var(--green)":"inherit"}">${c.d>0?"+":c.d<0?"−":""}${RM(Math.abs(c.d))}</span></div>
   <div class="r"><span>Percentage change</span><b style="color:${c.dir==="up"?"var(--red)":c.dir==="down"?"var(--green)":"inherit"}">${c.pct==null?"–":(c.pct>0?"+":"")+c.pct.toFixed(2)+"%"}</b></div>
   <div style="margin-top:6px">${c.dir==="up"?`<span class="badge b-red">Price increased</span>`:c.dir==="down"?`<span class="badge b-green">Price decreased</span>`:`<span class="badge b-navy">Price unchanged</span>`}</div>`:""}
   ${qWarn?`<div class="note" style="margin:8px 0 0">The two purchases were very different sizes (${fq(b.p.qty)} vs ${fq(a.p.qty)} ${plur(u.name,2)}). Bulk prices are often lower, so compare with care.</div>`:""}</div>`:""}
  <h3>Price over time</h3><div class="card">${invLine(series,labels,{fmt:v=>(v/100).toFixed(v>=1000?0:2),zero:false})}</div>
  <h3>Supplier comparison</h3><div class="card">${sups.length?`<table class="tight"><thead><tr><th>Supplier</th><th>Latest</th><th>Previous</th><th>vs cheapest</th></tr></thead><tbody>${sups.map(r=>`<tr><td><b>${esc(r.name)}</b>${r.cheapest?` <span class="badge b-green">Cheapest</span>`:""}<div class="muted">${fmtDs(r.latest.p.date)} · ${r.n} buy${r.n>1?"s":""}</div></td><td>${RM(r.latest.pr.up)}</td><td>${r.prev?RM(r.prev.pr.up):"–"}</td><td>${r.vsCheap?`<span class="down">+${RM(r.vsCheap)}</span>`:"–"}</td></tr>`).join("")}</tbody></table>`:`<div class="empty">No supplier prices.</div>`}</div>
  <h3>All purchases</h3><div class="card"><table class="tight"><thead><tr><th>Date</th><th>Qty</th><th>Supplier</th><th>Price</th><th>Change</th></tr></thead><tbody>${l.slice().reverse().map((x,i,arr)=>{const nx=arr[i+1],cc=nx?Inv.change(x.pr.up,nx.pr.up):null;
    return`<tr><td>${fmtDs(x.p.date)}</td><td>${fq(x.p.qty)}</td><td>${esc(Inv.supName(x.p))}</td><td><b>${RM(x.pr.up)}</b></td><td>${cc?`<span style="color:${cc.dir==="up"?"var(--red)":cc.dir==="down"?"var(--green)":"#6b6f78"};font-weight:700">${cc.dir==="same"?"=":(cc.d>0?"+":"−")+(cc.pct!=null?Math.abs(cc.pct).toFixed(1)+"%":"")}</span>`:""}</td></tr>`;}).join("")}</tbody></table></div>`;}

/* ----- RESTOCK LIST ----- */
function invRestockView(){const owner=API.isOwner(),L=Inv.restock(),todo=L.filter(l=>!l.done),done=L.filter(l=>l.done);
  const est=todo.reduce((a,l)=>a+(l.cost||0),0),noP=todo.filter(l=>l.u&&l.cost==null).length;
  const row=l=>`<div class="item ${l.done?"done-row":invRowCls(l.level)}" style="align-items:flex-start"><button class="chk ${l.done?"on":""}" data-a="invTick" data-id="${esc(l.id)}" aria-label="Purchased">${l.done?"✓":""}</button>
    <div class="grow"><b>${esc(l.it.name)}</b>${l.u&&l.it.units.length>1?` <span class="muted">(${esc(l.u.name)})</span>`:""} ${l.auto?invLevelBadge(l.level):`<span class="badge b-navy">Added</span>`}
     <div class="muted">${l.u?`Current ${qu(l.qty,l.u.name)} · minimum ${l.min!=null?fq(l.min):"not set"}`:`Status: ${INV_ST[Inv.state(l.it).st]}`}</div>
     ${l.u?`<div class="row" style="gap:6px;margin-top:6px"><span class="muted">Buy</span>${owner&&!l.done?`<input class="rsq" data-rs="${esc(l.id)}" inputmode="decimal" value="${fq(l.sug)}" style="width:70px;border:1px solid var(--b300);border-radius:8px;padding:6px;font-size:16px;font-weight:700;text-align:center">`:`<b>${fq(l.sug)}</b>`}<span>${esc(plur(l.u.name,l.sug))}</span></div>`:""}
     <div class="muted" style="margin-top:4px">${l.supplier?`Supplier: ${esc(l.supplier)}`:"Supplier: –"}${owner&&l.u?` · ${l.cost!=null?`est. <b style="color:#0e1726">${RM(l.cost)}</b> (${RM(l.lp.pr.up)}/${esc(l.u.name)})`:"no price yet"}`:""}</div>
     ${l.done&&l.row?`<div class="muted">Ticked by ${esc(l.row.by)} ${l.row.at?new Date(l.row.at).toLocaleString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}):""}</div>`:""}
     ${owner&&!l.auto?`<button class="btn sm ghost" style="margin-top:6px" data-a="invRsRm" data-id="${esc(l.id)}">Remove from list</button>`:""}</div></div>`;
  return`<div class="row between"><h2 style="margin:0">Restock list</h2>${owner?`<button class="btn sm sec" data-a="invRsAdd">+ Add item</button>`:""}</div>
  <div class="grid2" style="margin-top:12px"><div class="stat ${todo.length?"orange":""}"><div class="l">To buy</div><div class="v">${todo.length}</div></div>${owner?`<div class="stat hl"><div class="l">Estimated cost</div><div class="v">${RM(est)}</div>${noP?`<div class="muted" style="color:#ffd48a">${noP} without price</div>`:""}</div>`:`<div class="stat"><div class="l">Ticked</div><div class="v">${done.length}</div></div>`}</div>
  <div class="card list" style="margin-top:12px">${todo.length?todo.map(row).join(""):`<div class="empty">Nothing to buy. Items appear here automatically when they reach their minimum level or run out.</div>`}</div>
  ${done.length?`<h3>Ticked as purchased (${done.length})</h3><div class="card list">${done.map(row).join("")}</div><p class="muted">A tick clears automatically when the purchase is recorded.</p>`:""}
  ${todo.length?`<button class="btn sec block" data-a="invRsShare">Copy shopping list (WhatsApp)</button>`:""}
  <p class="muted">${owner?"Suggested quantity tops up to the item's restock target (or 2× the minimum when no target is set). Change it in the box, it saves automatically.":"Tick an item when you have bought it."}</p>`;}
function invRsText(){const L=Inv.restock().filter(l=>!l.done);return`*Aunty Tauhu shopping list* (${fmtD(today())})\n`+L.map(l=>`☐ ${l.it.name}${l.u?`: ${qu(l.sug,l.u.name)}`:""}${l.supplier?` (${l.supplier})`:""}`).join("\n");}
function invRsAddSheet(s,err){s.f=s.f||{};const itemId=fv(s,"itemId",""),it=itemId?Inv.item(itemId):null,unitId=fv(s,"unitId",it&&it.units[0]?it.units[0].id:"");s.f.itemId=itemId;s.f.unitId=unitId;
  return`<h2>Add to restock list</h2>${err}<div class="field"><label>Item</label><select id="raItem" data-k="itemId" data-rr="1"><option value="">Choose item…</option>${Inv.items().map(i=>`<option value="${i.id}" ${i.id===itemId?"selected":""}>${esc(i.name)}</option>`).join("")}</select></div>
  ${it&&it.mode!=="status"?`<div class="field"><label>Unit</label><select id="raUnit" data-k="unitId">${it.units.map(u=>`<option value="${u.id}" ${u.id===unitId?"selected":""}>${esc(u.name)}</option>`).join("")}</select></div>`:""}
  <button class="btn block" data-a="invRsSave">Add</button>`;}

/* ----- REPORTS ----- */
function invReports(){const R=ui.ir||(ui.ir={mode:"week",d:today(),view:"move"}),[from,to]=invRange(R),[pf,pt]=invPrevRange(R);
  const nav=R.mode==="custom"?`<div class="grid2"><div class="field"><label>From</label><input type="date" id="irFrom" value="${from}"></div><div class="field"><label>To</label><input type="date" id="irTo" value="${to}"></div></div>`
    :`<div class="datebar"><button data-a="invIrNav" data-id="-1">‹</button><div class="d">${invRangeTxt(from,to)}<small>${R.mode==="day"?"Daily":R.mode==="week"?"Weekly (Mon–Sun)":"Monthly"}</small></div><button data-a="invIrNav" data-id="1">›</button></div>`;
  const views=[["move","Stock movement"],["usage","Usage"],["hist","Stock history"],["spend","Spending"]];
  const body={move:invRepMove,usage:invRepUsage,hist:invRepHist,spend:invRepSpend}[R.view]||invRepMove;
  return`<h2>Inventory reports</h2>
  <div class="chips">${[["day","Daily"],["week","Weekly"],["month","Monthly"],["custom","Custom dates"]].map(([k,l])=>`<button class="chip ${R.mode===k?"on":""}" data-a="invIrMode" data-id="${k}">${l}</button>`).join("")}</div>${nav}
  <div class="seg">${views.map(([k,l])=>`<button class="${R.view===k?"on":""}" data-a="invIrView" data-id="${k}" style="font-size:12px;padding:8px 4px">${l}</button>`).join("")}</div>
  ${body(from,to,pf,pt)}
  <div class="card" style="margin-top:12px"><b>Export</b><p class="muted" style="margin:4px 0 8px">${invRangeTxt(from,to)}. Excel includes stock movement, usage, daily records, purchases and spending.</p>
   <div class="grid2"><button class="btn" data-a="invExportX">Excel (.xlsx)</button><button class="btn sec" data-a="invExportC">CSV (this view)</button></div></div>`;}
function invRepMove(from,to){const rows=invMoveRows(from,to);
  return`<p class="muted" style="margin-top:0">Open = stock at the start of ${fmtDs(from)} · Close = stock at the end of ${fmtDs(to)}. A red or orange figure means the counts didn't match (stock missing or extra).</p>
  ${INV_CATS.map(k=>{const l=rows.filter(r=>r.it.cat===k.id);if(!l.length)return"";return`<div class="lhead"><h3>${k.en} </h3></div><div class="card" style="padding:4px 14px">${l.map(r=>`<div class="mv">
    <div class="row between"><div><b>${esc(r.it.name)}</b> <span class="muted">${esc(plur(r.u.name,2))}</span></div>${r.variance?`<span class="badge ${r.variance<0?"b-red":"b-orange"}">${r.variance<0?"Missing":"Extra"} ${fq(Math.abs(r.variance))}</span>`:r.days?`<span class="badge b-green">✓ Matched</span>`:`<span class="muted" style="font-size:12px">no updates</span>`}</div>
    <div class="strip"><div><small>Open</small><b>${fq(r.opening)}</b></div><div><small>In</small><b class="${r.in?"up":""}">${r.in?"+"+fq(r.in):"0"}</b></div><div><small>Used</small><b>${r.used?"−"+fq(r.used):"0"}</b></div><div><small>Waste</small><b class="${r.waste?"down":""}">${r.waste?"−"+fq(r.waste):"0"}</b></div><div class="cl"><small>Close</small><b>${fq(r.closing)}</b></div></div></div>`).join("")}</div>`;}).join("")}`;}
function invRepUsage(from,to,pf,pt){const rows=invUsageRows(from,to,pf,pt),raw=rows.filter(r=>r.it.raw),chg=(a,b)=>!a&&!b?"–":!b?`<span class="muted">new</span>`:`<span style="color:${a>b?"var(--red)":a<b?"var(--green)":"#6b6f78"};font-weight:700">${a===b?"0%":((a-b)/b*100>0?"+":"")+Math.round((a-b)/b*100)+"%"}</span>`;
  const pot=rows.filter(r=>/kentang|potato/i.test(r.it.name+" "+(r.it.en||"")));
  const tbl=l=>`<table class="tight"><thead><tr><th>Item</th><th>This</th><th>Before</th><th>Change</th></tr></thead><tbody>${l.map(r=>`<tr><td><b>${esc(r.it.en||r.it.name)}</b><div class="muted" style="font-size:11px">${r.it.en?esc(r.it.name)+" · ":""}${esc(r.u.name)}</div></td><td><b>${fq(r.used)}</b></td><td>${fq(r.prev)}</td><td>${chg(r.used,r.prev)}</td></tr>`).join("")}</tbody></table>`;
  return`<p class="muted" style="margin-top:0">Compared with ${invRangeTxt(pf,pt)}.</p>
  ${pot.length?`<div class="card" style="border:2px solid var(--sand)"><b>Total potatoes used</b>${pot.map(r=>`<div class="uline"><span>${esc(r.u.name)}</span><span><b style="font-size:18px">${fq(r.used)}</b> <span class="muted">(before ${fq(r.prev)})</span></span></div>`).join("")}
   ${(()=>{const it=pot[0].it;if(!Inv.conv(it))return`<div class="muted">Large and small sacks are kept separate. Set a conversion in the item to see one combined total.</div>`;const t=pot.reduce((a,r)=>a+(r.u.id===it.units[0].id?r.used:r.used*r.u.per),0);return`<div class="muted">Combined: ${qu(t,it.units[0].name)}</div>`;})()}</div>`:""}
  ${INV_CATS.map(k=>{const l=(k.id==="pack"?rows:raw).filter(r=>r.it.cat===k.id);if(!l.length)return"";return`<h3>Total ${k.en.toLowerCase()} used</h3><div class="card">${tbl(l)}</div>`;}).join("")}
  ${(()=>{const other=rows.filter(r=>!r.it.raw&&r.it.cat!=="pack");return other.length?`<h3>Other items used</h3><div class="card">${tbl(other)}</div>`:"";})()}
  <p class="muted">Different units are never added together (3 sacks and 15 trays stay separate).</p>`;}
function invRepHist(from,to){const its=Inv.items(true).filter(i=>i.mode!=="status");const sel=ui.irItem&&Inv.item(ui.irItem)?ui.irItem:(its.find(i=>/kentang/i.test(i.name))||its[0]||{}).id;if(!sel)return`<div class="empty">No items.</div>`;
  const it=Inv.item(sel),days=[];for(let d=from;d<=to&&days.length<370;d=addDays(d,1))days.push(d);const lim=days.filter(d=>d<=today());
  const series=it.units.map(u=>({name:u.name,vals:lim.map(d=>Inv.stockAt(it,u.id,d)),mark:lim.map(d=>!!Inv.entry(it,u.id,d))}));
  const rowsH=it.units.flatMap(u=>Inv.chain(it,u.id).filter(e=>e.date>=from&&e.date<=to).map(e=>({u,e}))).sort((a,b)=>a.e.date.localeCompare(b.e.date));
  return`<div class="field"><label>Item</label><select id="irItem">${its.map(i=>`<option value="${i.id}" ${i.id===sel?"selected":""}>${esc(i.name)}${i.en?" · "+esc(i.en):""}</option>`).join("")}</select></div>
  <div class="card"><b>${esc(it.name)}: stock at the end of each day</b>${invLine(series,lim.map(d=>lim.length<=8?dayName(d)+" "+new Date(d+"T00:00:00").getDate():fmtDs(d)),{legend:it.units.length>1})}<div class="muted">Hollow dots = days with a stock update.</div></div>
  <div class="card">${rowsH.length?`<table class="tight"><thead><tr><th>Day</th>${it.units.length>1?"<th>Unit</th>":""}<th>Open</th><th>In</th><th>Used</th><th>Waste</th><th>Close</th></tr></thead><tbody>${rowsH.map(({u,e})=>`<tr><td>${dayName(e.date)} ${fmtDs(e.date)}</td>${it.units.length>1?`<td>${esc(u.name)}</td>`:""}<td>${fq(e.open)}</td><td>${e.recv?`<b class="up">+${fq(e.recv)}</b>`:"0"}</td><td>${fq(e.used)}</td><td>${fq(e.waste)}</td><td><b>${e.close==null?fq(e.exp)+"*":fq(e.close)}</b>${e.disc?` <span style="color:${e.disc<0?"var(--red)":"#a14d00"}">(${signed(e.disc)})</span>`:""}</td></tr>`).join("")}</tbody></table><div class="muted" style="margin-top:6px">* not counted, expected figure.</div>`:`<div class="empty">No stock updates in this period.</div>`}</div>`;}
function invRepSpend(from,to){if(!API.isOwner())return"";const d=ui.ir.d||today(),D=new Date(d+"T00:00:00"),wk=monday(d);
  const day=Inv.spend(d,d),week=Inv.spend(wk,addDays(wk,6)),month=Inv.spend(iso(new Date(D.getFullYear(),D.getMonth(),1)),iso(new Date(D.getFullYear(),D.getMonth()+1,0))),S=Inv.spend(from,to);
  const bars=[];for(let i=11;i>=0;i--){const a=new Date(D.getFullYear(),D.getMonth()-i,1),b=new Date(D.getFullYear(),D.getMonth()-i+1,0);bars.push({l:MONTHS[a.getMonth()]+"\n"+String(a.getFullYear()).slice(2),v:Inv.spend(iso(a),iso(b)).total,cur:i===0});}
  const inc=[];S.list.forEach(p=>{const pr=Inv.price(p.id);if(!pr)return;const pv=Inv.prevPrice(p);if(!pv)return;const c=Inv.change(pr.up,pv.pr.up);if(c.dir==="up")inc.push({p,pr,pv,c});});
  const cats=Object.entries(S.byCat).sort((a,b)=>b[1]-a[1]),sups=Object.entries(S.bySup).sort((a,b)=>b[1]-a[1]);
  return`<div class="grid3"><div class="stat"><div class="l">Day (${fmtDs(d)})</div><div class="v" style="font-size:16px">${RM(day.total)}</div></div><div class="stat"><div class="l">Week</div><div class="v" style="font-size:16px">${RM(week.total)}</div></div><div class="stat hl"><div class="l">${MONTHS[D.getMonth()]}</div><div class="v" style="font-size:16px">${RM(month.total)}</div></div></div>
  <div class="stat" style="margin-top:10px"><div class="l">Selected period: ${invRangeTxt(from,to)}</div><div class="v">${RM(S.total)}</div><div class="muted">${S.n} purchase${S.n===1?"":"s"}${S.unpriced?` · <span style="color:var(--red)">${S.unpriced} without price (not counted)</span>`:""}</div></div>
  <h3>Monthly raw material purchasing</h3><div class="card">${invBars(bars,v=>Math.round(v/100))}<div class="muted" style="margin-top:6px">Numbers above bars are RM.</div></div>
  <h3>Spending by category</h3><div class="card">${cats.length?cats.map(([c,v])=>`<div class="uline"><span>${INV_CAT[c]?INV_CAT[c].en:esc(c)}</span><span><b>${RM(v)}</b> <span class="muted">${S.total?Math.round(v/S.total*100):0}%</span></span></div>`).join(""):`<div class="empty">No priced purchases.</div>`}</div>
  <h3>Spending by supplier</h3><div class="card">${sups.length?sups.map(([n,v])=>`<div class="uline"><span>${esc(n)}</span><span><b>${RM(v)}</b> <span class="muted">${S.total?Math.round(v/S.total*100):0}%</span></span></div>`).join(""):`<div class="empty">No priced purchases.</div>`}</div>
  <h3>Price increases (vs previous purchase)</h3><div class="card list">${inc.length?inc.map(x=>{const it=Inv.item(x.p.itemId),u=it&&Inv.unit(it,x.p.unitId);return`<button class="item" data-a="invPriceItem" data-id="${x.p.itemId}|${x.p.unitId}"><div class="grow"><b>${esc(it?it.name:"")}</b> <span class="muted">per ${esc(u?u.name:"")}</span><div class="muted">${RM(x.pv.pr.up)} → ${RM(x.pr.up)} · ${fmtDs(x.p.date)}</div></div>${invChangeBadge(x.c)}</button>`;}).join(""):`<div class="empty">No price increases in this period.</div>`}</div>`;}
function invReportCsv(from,to){const v=ui.ir.view,[pf,pt]=invPrevRange(ui.ir);
  if(v==="usage")return[["Item","Unit",`Used ${from} to ${to}`,`Previous ${pf} to ${pt}`,"Change"],...invUsageRows(from,to,pf,pt).map(r=>[Inv.label(r.it),r.u.name,r.used,r.prev,q3(r.used-r.prev)])];
  if(v==="spend"){const S=Inv.spend(from,to);return[["Date","Item","Unit","Qty","Supplier","Unit price (RM)","Total (RM)","Invoice"],...S.list.sort((a,b)=>a.date.localeCompare(b.date)).map(p=>{const it=Inv.item(p.itemId),u=it&&Inv.unit(it,p.unitId),pr=Inv.price(p.id);return[p.date,it?it.name:"",u?u.name:"",p.qty,Inv.supName(p),senN(pr&&pr.up),senN(pr&&pr.total),p.inv||""];})];}
  if(v==="hist"){const it=Inv.item(ui.irItem)||Inv.items(true).find(i=>i.mode!=="status");const rows=[["Date","Item","Unit","Opening","Received","Used","Wastage","Expected","Physical closing","Discrepancy"]];
    if(it)it.units.forEach(u=>Inv.chain(it,u.id).filter(e=>e.date>=from&&e.date<=to).forEach(e=>rows.push([e.date,it.name,u.name,e.open,e.recv,e.used,e.waste,e.exp,e.close==null?"":e.close,e.disc==null?"":e.disc])));return rows;}
  return[["Category","Item","Unit","Opening","Purchased","Other received","Used","Wastage","Closing","Unexplained difference"],...invMoveRows(from,to).map(r=>[INV_CAT[r.it.cat].en,r.it.name,r.u.name,r.opening,r.bought,r.rx,r.used,r.waste,r.closing,r.variance])];}

/* ----- SETTINGS (owner) ----- */
function invSettings(){const sups=DB.invSup.slice().sort((a,b)=>(b.active!==false)-(a.active!==false)||a.name.localeCompare(b.name)),recs=DB.invRecipes;
  return`<h2>Inventory settings</h2>
  <div class="card"><b>Minimum stock & restock targets</b><p class="muted" style="margin:4px 0 10px">When stock reaches the minimum, the item shows LOW STOCK and goes on the restock list.</p><button class="btn block" data-a="invLevels">Set minimum levels</button></div>
  <div class="row between"><h3>Suppliers (${sups.length})</h3><button class="btn sm sec" data-a="invSup" data-id="">+ Add supplier</button></div>
  <div class="card list">${sups.length?sups.map(x=>`<button class="item" data-a="invSup" data-id="${x.id}"><div class="grow"><b>${esc(x.name)}</b>${x.active===false?` <span class="badge b-navy">Inactive</span>`:""}<div class="muted">${esc(x.phone||"")}${x.note?" · "+esc(x.note):""} · ${DB.invBuys.filter(p=>p.supId===x.id).length} purchases</div></div><span class="muted">›</span></button>`).join(""):`<div class="empty">No suppliers yet.</div>`}</div>
  <div class="row between"><h3>Recipes / bill of materials</h3><button class="btn sm sec" data-a="invRecipe" data-id="">+ Add recipe</button></div>
  <div class="card list">${recs.length?recs.map(r=>`<button class="item" data-a="invRecipe" data-id="${r.id}"><div class="grow"><b>${esc(r.name)}</b>${r.active===false?` <span class="badge b-navy">Archived</span>`:""}<div class="muted">Per 1 ${esc(r.out)}: ${r.ing.map(g=>{const it=Inv.item(g.itemId),u=it&&Inv.unit(it,g.unitId);return`${fq(g.qty)} ${esc(u?plur(u.name,g.qty):"")} ${esc(it?it.name:"?")}`;}).join(", ")}</div></div><span class="muted">›</span></button>`).join(""):`<div class="empty">No recipes. Optional: add one (e.g. "1 batch tauhu uses 2 packs tahu, 1 bottle oil") to estimate ingredient use from production. Nothing is assumed until you set it.</div>`}</div>
  <h3>Who can do what</h3><div class="card"><div class="uline"><b>Owner</b><span class="muted" style="text-align:right">Everything: items, suppliers, minimum levels, purchase prices, reports, staff, and correcting any day</span></div>
   <div class="uline" style="margin-top:6px"><b>Kitchen staff</b><span class="muted" style="text-align:right">Daily stock update, usage, stock received (no prices), restock list. Today only; earlier days need the owner</span></div>
   <p class="muted" style="margin:8px 0 0">Add staff and PINs in the main Settings tab. Every update records who did it.</p></div>`;}
function invItemEditSheet(s,err){const it=s.id?Inv.item(s.id):null;s.f=s.f||{};
  if(!s.units)s.units=it?it.units.map(u=>({id:u.id,name:u.name,min:u.min==null?"":String(u.min),target:u.target==null?"":String(u.target),per:u.per==null?"":String(u.per),start:String((it.start||{})[u.id]??0)})):[{id:"",name:"pack",min:"",target:"",per:"",start:""}];
  const mode=fv(s,"mode",it?it.mode:"count"),raw=fv(s,"raw",it?!!it.raw:true),hasRec=it&&(Inv.recs(it.id).length||DB.invBuys.some(p=>p.itemId===it.id));
  const base=s.units[0]?s.units[0].name||"base unit":"base unit";
  return`<h2>${it?"Edit item":"Add inventory item"}</h2>${err}
  <div class="field"><label>Item name</label><input id="ieN" data-k="name" value="${esc(fv(s,"name",it?it.name:""))}" placeholder="e.g. Kentang"></div>
  <div class="field"><label>English name (optional, used in reports)</label><input id="ieE" data-k="en" value="${esc(fv(s,"en",it?it.en||"":""))}" placeholder="e.g. Potatoes"></div>
  <div class="field"><label>Category</label><select id="ieC" data-k="cat">${INV_CATS.map(c=>`<option value="${c.id}" ${fv(s,"cat",it?it.cat:(ui.invCat&&ui.invCat!=="all"?ui.invCat:"dry"))===c.id?"selected":""}>${c.en}</option>`).join("")}</select></div>
  <div class="field"><label>How is stock tracked?</label><div class="seg" style="margin:0"><button class="${mode==="count"?"on":""}" data-a="invMode" data-id="count">Count quantity</button><button class="${mode==="status"?"on":""}" data-a="invMode" data-id="status">Available / low / out</button></div>
   <div class="hint">${mode==="status"?"For things you don't count, like daun sup. Staff choose Available, Running low or Out of stock each day.":"Staff enter quantities each day."}</div></div>
  ${mode==="status"?`<div class="field"><label>Status now</label><select id="ieSS" data-k="startStatus">${Object.entries(INV_ST).map(([k,l])=>`<option value="${k}" ${fv(s,"startStatus",it?it.startStatus||"available":"available")===k?"selected":""}>${l}</option>`).join("")}</select></div>`:""}
  <h3>${mode==="status"?"Purchase units (optional, for price tracking)":"Units"}</h3>
  ${mode==="count"?`<p class="muted" style="margin-top:-4px">Add every unit you count in, e.g. large sack and small sack. They are kept separate unless you fill in the conversion.</p>`:""}
  ${s.units.map((u,i)=>`<div class="unitrow"><div class="row between"><b>${i===0?"Main unit":"Unit "+(i+1)}</b>${s.units.length>1||mode==="status"?`<button class="x" data-a="invUnitRm" data-id="${i}" aria-label="Remove">×</button>`:""}</div>
    <div class="grid2"><div class="field"><label>Unit name</label><input id="ue_${i}_name" value="${esc(u.name)}" placeholder="e.g. tray"></div>
    ${mode==="count"?`<div class="field"><label>${hasRec?"Starting stock":"Stock now"}</label><input id="ue_${i}_start" inputmode="decimal" value="${esc(u.start)}" placeholder="0"></div>`:"<div></div>"}</div>
    ${mode==="count"?`<div class="grid2"><div class="field"><label>Minimum level</label><input id="ue_${i}_min" inputmode="decimal" value="${esc(u.min)}" placeholder="not set"></div><div class="field"><label>Restock target</label><input id="ue_${i}_target" inputmode="decimal" value="${esc(u.target)}" placeholder="optional"></div></div>
    ${i>0?`<div class="field" style="margin:0"><label>Conversion (optional)</label><div class="row" style="gap:6px"><span>1 ${esc(u.name||"unit")} =</span><input id="ue_${i}_per" inputmode="decimal" value="${esc(u.per)}" placeholder="e.g. 0.5" style="width:90px"><span>${esc(base)}</span></div><div class="hint">Leave empty to keep this unit separate.</div></div>`:""}`:""}</div>`).join("")}
  <button class="btn sec block" style="margin-bottom:12px" data-a="invUnitAdd">+ Add unit</button>
  ${hasRec&&mode==="count"?`<div class="note">This item has records. "Starting stock" is the stock on ${fmtD(it.startDate)}; changing it shifts every later figure.</div>`:""}
  <div class="card switch"><div><b>Raw material</b><div class="muted">Shows in the Usage Tracker and raw material reports.</div></div><button class="${raw?"on":""}" data-a="invRaw"></button></div>
  <div class="field"><label>Usual supplier (optional)</label><select id="ieSup" data-k="supId"><option value="">—</option>${DB.invSup.filter(x=>x.active!==false).map(x=>`<option value="${x.id}" ${fv(s,"supId",it?it.supId||"":"")===x.id?"selected":""}>${esc(x.name)}</option>`).join("")}</select></div>
  <div class="field"><label>Note (optional)</label><input id="ieNote" data-k="note" value="${esc(fv(s,"note",it?it.note||"":""))}" placeholder="e.g. daging"></div>
  ${it?`<div class="card switch"><div><b>Active</b><div class="muted">Archived items are hidden but their history stays in reports.</div></div><button class="${fv(s,"active",it.active!==false)?"on":""}" data-a="invActive"></button></div>`:""}
  <button class="btn block" data-a="invSaveItem">Save item</button>
  ${it?`<button class="btn ghost block" style="margin-top:8px;color:var(--red)" data-a="invDelItem">${hasRec?"Archive item":"Delete item"}</button>`:""}`;}
function invReadUnits(s){s.units=s.units.map((u,i)=>({id:u.id,name:val(`ue_${i}_name`),start:document.getElementById(`ue_${i}_start`)?val(`ue_${i}_start`):u.start,min:document.getElementById(`ue_${i}_min`)?val(`ue_${i}_min`):u.min,target:document.getElementById(`ue_${i}_target`)?val(`ue_${i}_target`):u.target,per:document.getElementById(`ue_${i}_per`)?val(`ue_${i}_per`):u.per}));}
function invLevelsSheet(s,err){const its=Inv.items().filter(i=>i.mode!=="status");
  return`<h2>Minimum & restock levels</h2><p class="muted" style="margin-top:-8px">Leave empty if you don't want a warning for that unit. Target = how much to top up to when restocking.</p>${err}
  ${INV_CATS.map(k=>{const l=its.filter(i=>i.cat===k.id);if(!l.length)return"";return`<h3>${k.en}</h3>`+l.map(it=>{const conv=Inv.conv(it);return`<div class="unitrow"><b>${esc(it.name)}</b> <span class="muted">now: ${esc(Inv.stockText(it))}</span>
    ${(conv?it.units.slice(0,1):it.units).map(u=>`<div class="grid3" style="align-items:end;margin-top:6px"><div class="muted" style="padding-bottom:12px">${esc(u.name)}${conv?" (combined)":""}</div><div class="field" style="margin:0"><label>Minimum</label><input id="lv_${it.id}_${u.id}_min" inputmode="decimal" value="${u.min==null?"":fq(u.min)}" placeholder="–"></div><div class="field" style="margin:0"><label>Target</label><input id="lv_${it.id}_${u.id}_target" inputmode="decimal" value="${u.target==null?"":fq(u.target)}" placeholder="–"></div></div>`).join("")}</div>`;}).join("");}).join("")}
  <div class="totalbar"><button class="btn block" data-a="invSaveLevels">Save levels</button></div>`;}
function invSupSheet(s,err){const x=s.id?Inv.sup(s.id):{name:"",phone:"",note:"",active:true};s.f=s.f||{};
  return`<h2>${s.id?"Edit supplier":"Add supplier"}</h2>${err}<div class="field"><label>Supplier name</label><input id="spN" data-k="name" value="${esc(fv(s,"name",x.name))}" placeholder="e.g. Pasar Borong Selayang"></div>
  <div class="field"><label>Phone (optional)</label><input id="spP" data-k="phone" inputmode="tel" value="${esc(fv(s,"phone",x.phone||""))}"></div>
  <div class="field"><label>Note (optional)</label><input id="spNo" data-k="note" value="${esc(fv(s,"note",x.note||""))}" placeholder="e.g. delivers Tue & Fri"></div>
  ${s.id?`<div class="card switch"><div><b>Active</b><div class="muted">Inactive suppliers are hidden from new purchases.</div></div><button class="${fv(s,"active",x.active!==false)?"on":""}" data-a="invActive"></button></div>`:""}
  <button class="btn block" data-a="invSaveSup">Save supplier</button>`;}
function invRecipeSheet(s,err){const r=s.id?DB.invRecipes.find(x=>x.id===s.id):null;s.f=s.f||{};if(!s.ing)s.ing=r?r.ing.map(g=>({...g,qty:String(g.qty)})):[{itemId:"",unitId:"",qty:""}];
  const its=Inv.items().filter(i=>i.units.length);
  return`<h2>${r?"Edit recipe":"Add recipe"}</h2>${err}
  <div class="field"><label>Product / recipe name</label><input id="rcN" data-k="name" value="${esc(fv(s,"name",r?r.name:""))}" placeholder="e.g. Tauhu bakar batch"></div>
  <div class="field"><label>Counted in</label><input id="rcO" data-k="out" value="${esc(fv(s,"out",r?r.out:"batch"))}" placeholder="e.g. batch, tray, pack"></div>
  <h3>Ingredients for 1 ${esc(fv(s,"out",r?r.out:"batch")||"batch")}</h3>
  ${s.ing.map((g,i)=>{const it=g.itemId?Inv.item(g.itemId):null;return`<div class="unitrow"><div class="row between"><b>Ingredient ${i+1}</b><button class="x" data-a="invIngRm" data-id="${i}">×</button></div>
    <div class="field"><select id="rg_${i}_item" data-ing="${i}" data-rr="1"><option value="">Choose…</option>${its.map(x=>`<option value="${x.id}" ${x.id===g.itemId?"selected":""}>${esc(x.name)}</option>`).join("")}</select></div>
    <div class="grid2"><div class="field" style="margin:0"><input id="rg_${i}_qty" inputmode="decimal" value="${esc(g.qty)}" placeholder="quantity"></div><div class="field" style="margin:0"><select id="rg_${i}_unit">${it?it.units.map(u=>`<option value="${u.id}" ${u.id===g.unitId?"selected":""}>${esc(u.name)}</option>`).join(""):""}</select></div></div></div>`;}).join("")}
  <button class="btn sec block" style="margin-bottom:12px" data-a="invIngAdd">+ Add ingredient</button>
  <button class="btn block" data-a="invSaveRecipe">Save recipe</button>${r?`<button class="btn ghost block" style="margin-top:8px;color:var(--red)" data-a="invDelRecipe">Delete recipe</button>`:""}`;}
function invReadIng(s){s.ing=s.ing.map((g,i)=>({itemId:val(`rg_${i}_item`),unitId:val(`rg_${i}_unit`),qty:val(`rg_${i}_qty`)}));}


/* =====================================================================
   SIMPLE DAILY STOCK ("Daily stock"): per item and size, only
   stock today (automatic) · added · closing · optional price.
   Used = stock today + added − closing (worked out, never typed).
   "Added" is kept as one purchase record per item/size/day, so it adds
   to stock exactly once and can carry the current price.
   ===================================================================== */
const invAddId=(d,iid,uidv)=>`pa_${d}_${iid}_${uidv}`;
Inv.addRec=function(d,iid,uidv){return DB.invBuys.find(p=>p.id===invAddId(d,iid,uidv))||null;};
Inv.otherBought=function(it,uidv,d){const a=this.addRec(d,it.id,uidv);return q3(this.bought(it,uidv,d,d)-(a?a.qty:0));};
Inv.saveSimple=async function(date,rows,stats,why){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return invFail("Choose the date");
  if(date>today())return invFail("You can't record stock for a future date");
  if(!this.canEdit(date))return invFail("Only the owner can change records from earlier days.");
  const owner=API.isOwner(),plan=[];
  for(const r of rows){const it=this.item(r.itemId),u=it&&this.unit(it,r.unitId);if(!u)continue;const nm=it.name+(it.units.length>1?` (${u.name})`:"");
    const add=parseQ(r.add),cl=parseQ(r.cl);if(add==null)return invFail(`${nm}: "Added" must be a number (e.g. 2 or 1.5)`);if(cl==null)return invFail(`${nm}: "Closing" must be a number`);
    let up=null;if(owner&&String(r.price||"").trim()!==""){up=toSen(r.price);if(up==null)return invFail(`${nm}: enter the price like 15.00`);}
    const open=this.openFor(it,u.id,date),other=this.otherBought(it,u.id,date),avail=q3(open+other+(add||0));
    if(cl!==""&&cl>avail)return invFail(`${nm}: closing (${fq(cl)}) is more than stock today + added (${fq(avail)}). If stock came in, enter it under "Added".`);
    const ar=this.addRec(date,it.id,u.id),rec=this.rec(date,it.id),L=rec&&rec.lines&&rec.lines[u.id]||{};
    const addCh=(add||0)!==(ar?ar.qty:0),clCh=(cl===""?null:cl)!==(L.cl==null?null:L.cl),priceCh=up!=null&&!(ar&&this.price(ar.id)&&this.price(ar.id).up===up);
    if(!addCh&&!clCh&&!priceCh)continue;
    plan.push({it,u,nm,add:add||0,cl,up,avail,ar,addCh,clCh,priceCh,needWhy:(clCh&&L.cl!=null)||(addCh&&ar&&ar.qty>0)});}
  const st=[];for(const s of stats||[]){const it=this.item(s.itemId);if(!it)continue;const rec=this.rec(date,it.id);if(rec&&rec.st===s.st)continue;if(!rec&&s.st===this.statusAt(it,addDays(date,-1)))continue;st.push({it,st:s.st,needWhy:!!(rec&&rec.st)});}
  if(!plan.length&&!st.length)return invFail("Nothing to save. No changes were made.");
  if([...plan,...st].some(x=>x.needWhy)&&!String(why||"").trim())return invFail("Some figures that were already saved have changed. Please write the reason below.",{why:true});
  /* someone else saved the same items meanwhile? */
  const ids=[...new Set([...plan,...st].map(x=>date+"_"+x.it.id))],rem=await this.remote("inv_counts",ids);
  for(const [id,rr] of rem){const l=DB.invCounts.find(x=>x.id===id);if((rr.v||0)>(l?l.v||0:0)){rem.forEach(x=>{const ll=DB.invCounts.find(y=>y.id===x.id);if((x.v||0)>(ll?ll.v||0:0))this.adopt("invCounts",x);});
    return invFail(`${rr.by} just saved ${this.item(rr.itemId).name} (${fmtT(rr.at)}). The latest figures are now shown, please check and save again.`,{reload:true});}}
  const now=Date.now(),me=this.me(),W=String(why||"").trim();
  /* 1) stock added (+ price) */
  for(const x of plan){if(!x.addCh&&!x.priceCh)continue;let p=x.ar;
    if(p){p.hist=p.hist||[];const op=this.price(p.id);p.hist.push({v:p.v,at:p.at,by:p.by,date:p.date,itemId:p.itemId,unitId:p.unitId,qty:p.qty,supId:p.supId||"",supName:p.supName||"",inv:"",rm:"",up:op?op.up:null,total:op?op.total:null,chAt:now,chBy:me,why:W});Object.assign(p,{qty:x.add,v:(p.v||0)+1,at:now,by:me});}
    else{p={id:invAddId(date,x.it.id,x.u.id),date,itemId:x.it.id,unitId:x.u.id,qty:x.add,supId:"",supName:"",inv:"",rm:"Daily stock",v:1,cAt:now,cBy:me,at:now,by:me,hist:[]};DB.invBuys.push(p);}
    if(owner&&x.up!=null){const i=DB.invPrices.findIndex(q=>q.id===p.id),pr={id:p.id,up:x.up,total:Math.round(x.up*x.add),at:now,by:me};if(i>=0)DB.invPrices[i]=pr;else DB.invPrices.push(pr);}
    else if(owner&&i0(p.id)){const pr=DB.invPrices.find(q=>q.id===p.id);pr.total=Math.round(pr.up*x.add);}
    if(x.add>0){const rr=DB.invRestock.find(r=>r.id===x.it.id+"|"+x.u.id);if(rr&&(rr.done||rr.qty!=null||rr.manual))Object.assign(rr,{done:false,qty:null,manual:false,at:now,by:me});}}
  this.bump();
  /* 2) closing counts (used = stock today + added − closing) */
  const byItem=new Map();plan.filter(x=>x.clCh||(x.addCh&&x.cl!=="")).forEach(x=>{if(!byItem.has(x.it.id))byItem.set(x.it.id,{it:x.it,lines:{}});
    byItem.get(x.it.id).lines[x.u.id]=x.cl===""?{cl:null,us:0,ws:0,rx:0}:{cl:x.cl,us:q3(x.avail-x.cl),ws:0,rx:0};});
  st.forEach(x=>{if(!byItem.has(x.it.id))byItem.set(x.it.id,{it:x.it,lines:{}});byItem.get(x.it.id).st=x.st;});
  byItem.forEach(g=>{const patch={lines:g.lines};if(g.st)patch.st=g.st;this.apply(date,g.it,patch,W);});
  this.bump();
  const txt=[...plan.map(x=>`${x.nm}: ${x.addCh?"added "+fq(x.add)+", ":""}${x.cl!==""?"closing "+fq(x.cl)+" (used "+fq(q3(x.avail-x.cl))+")":"closing not counted"}${x.up!=null?` @ ${RM(x.up)}`:""}`),...st.map(x=>`${x.it.name}: ${INV_ST[x.st]}`)];
  API.log(W?"Daily stock corrected":"Daily stock",`${fmtD(date)}: ${txt.join("; ")}${W?` · reason: ${W}`:""}`);save();return ok(plan.length+st.length);};
const i0=pid=>DB.invPrices.some(q=>q.id===pid);
const INV_SST={available:"Available",low:"Low",out:"Out"};
function invSimple(){const d=ui.invSDate||(ui.invSDate=today()),edit=Inv.canEdit(d),owner=API.isOwner(),all=Inv.items();ui.sd=ui.sd||{};if(ui.sdDate!==d){ui.sd={};ui.sdDate=d;}
  const D=ui.sd,dv=(k,def)=>k in D?D[k]:def,dis=edit?"":"disabled";
  const done=all.filter(it=>Inv.rec(d,it.id)).length,pct=all.length?Math.round(done/all.length*100):0;
  const card=it=>{const rec=Inv.rec(d,it.id);
    const saved=rec?`<span class="badge b-green">✓ Saved · ${esc(rec.by)} ${fmtT(rec.at)}</span>`:"";
    if(it.mode==="status"){const cur=dv(`${it.id}.st`,rec&&rec.st?rec.st:Inv.statusAt(it,addDays(d,-1)));
      return`<div class="sitem" data-name="${esc((it.name+" "+(it.en||"")).toLowerCase())}"><div class="row between"><div class="nm">${esc(it.name)}</div>${saved}</div>
        <div class="seg" style="margin:8px 0 0">${Object.entries(INV_SST).map(([k,l])=>`<button class="${cur===k?"on":""} sst-${k}" data-a="invSSt" data-id="${it.id}:${k}" ${dis}>${l}</button>`).join("")}</div></div>`;}
    return`<div class="sitem" data-name="${esc((it.name+" "+(it.en||"")).toLowerCase())}"><div class="row between"><div class="nm">${esc(it.name)}${it.en?` <span class="muted">${esc(it.en)}</span>`:""}</div>${saved}</div>
      ${it.units.map(u=>{const k=`${it.id}.${u.id}`,open=Inv.openFor(it,u.id,d),other=Inv.otherBought(it,u.id,d),ar=Inv.addRec(d,it.id,u.id),L=rec&&rec.lines&&rec.lines[u.id]||{};
        const add=dv(k+".a",ar&&ar.qty?String(ar.qty):""),cl=dv(k+".c",L.cl==null?"":String(L.cl)),pr=dv(k+".p",""),lp=owner?Inv.lastPrice(it,u.id):null;
        const used=invSUsed(open,other,add,cl);
        return`<div class="srow" data-k="${k}" data-open="${open}" data-other="${other}">${it.units.length>1?`<div class="su">${esc(u.name)}</div>`:""}
          <div class="sg"><div class="sbox ro"><small>Stock today</small><b>${fq(open)}</b></div>
            <div class="sbox"><small>Added</small><input id="sa_${it.id}_${u.id}" data-sk="${k}.a" inputmode="decimal" placeholder="0" value="${esc(add)}" ${dis}></div>
            <div class="sbox cl"><small>Closing</small><input id="sc_${it.id}_${u.id}" data-sk="${k}.c" inputmode="decimal" placeholder="count" value="${esc(cl)}" ${dis}></div></div>
          <div class="sfoot"><span class="sused">${used}</span>${other?`<span class="muted">+${fq(other)} from Purchases</span>`:""}
            ${owner&&edit?`<label class="sprice">Price RM<input id="sp_${it.id}_${u.id}" data-sk="${k}.p" inputmode="decimal" placeholder="${lp?s2d(lp.pr.up):"optional"}" value="${esc(pr)}"></label>`:""}</div></div>`;}).join("")}</div>`;};
  const list=INV_CATS.map(c=>{const l=all.filter(i=>i.cat===c.id);return l.length?`<div class="lhead"><h3>${c.en}</h3><span>${l.filter(i=>Inv.rec(d,i.id)).length}/${l.length}</span></div><div class="card list">${l.map(card).join("")}</div>`:"";}).join("");
  return`<div class="datebar"><button data-a="invSDay" data-id="-1">‹</button><div class="d">${dayName(d)}, ${fmtD(d)}<small>${d===today()?"Today":`<span data-a="invSDayToday" style="text-decoration:underline">Go to today</span>`}</small></div><button data-a="invSDay" data-id="1" ${d>=today()?"disabled style='opacity:.3'":""}>›</button></div>
  <div class="card" style="padding:12px 14px"><div class="row between"><div><b>Daily stock</b><div class="muted">Fill in <b>Added</b> (if any) and <b>Closing</b>. Stock today comes from yesterday's closing.</div></div><div class="big ${done===all.length?"g":""}" style="flex:none">${done}<small>/${all.length}</small></div></div><div class="pbar"><i style="width:${pct}%"></i></div></div>
  ${edit?"":`<div class="note">View only. Only the owner can change earlier days.</div>`}
  <input class="search" type="search" placeholder="Search item" data-filter="invSList" autocomplete="off">
  <div id="invSList">${list}<div class="empty" data-none style="display:none">No item matches.</div></div>
  ${edit?`${ui.sdWhy?`<div class="field" style="margin-top:12px"><label>Reason for changing saved figures</label><input id="sWhy" data-sk="why" value="${esc(dv("why",""))}" placeholder="e.g. miscounted" style="border-color:var(--red)"></div>`:""}
  <div class="sbar"><button class="btn brown block" data-a="invSaveSimple">Save all</button></div>`:""}
  <p class="muted">Used = stock today + added − closing (worked out automatically). Items with an empty closing are not saved as a count.</p>`;}
function invSUsed(open,other,add,cl){const a=parseQ(add),c=parseQ(cl);if(c===""||c==null)return`<span class="muted">Used: –</span>`;if(a==null)return"";
  const u=q3(open+other+(a||0)-c);return u<0?`<span class="down">Closing is more than stock!</span>`:`Used: <b>${fq(u)}</b>`;}
function invSimpleCollect(){const d=ui.invSDate,D=ui.sd||{},rows=[],stats=[];
  Inv.items().forEach(it=>{if(it.mode==="status"){if(`${it.id}.st` in D)stats.push({itemId:it.id,st:D[`${it.id}.st`]});return;}
    it.units.forEach(u=>{const k=`${it.id}.${u.id}`,ar=Inv.addRec(d,it.id,u.id),rec=Inv.rec(d,it.id),L=rec&&rec.lines&&rec.lines[u.id]||{};
      if(!(k+".a" in D)&&!(k+".c" in D)&&!(k+".p" in D))return;
      rows.push({itemId:it.id,unitId:u.id,add:k+".a" in D?D[k+".a"]:(ar&&ar.qty?String(ar.qty):""),cl:k+".c" in D?D[k+".c"]:(L.cl==null?"":String(L.cl)),price:D[k+".p"]||""});});});
  return{rows,stats};}

/* ----- sheet router ----- */
function invSheet(s,err){switch(s.type){
  case"invCount":return invCountSheet(s,err);case"invItem":return invItemSheet(s);case"invItemEdit":return invItemEditSheet(s,err);
  case"invUsage":return invUsageSheet(s,err);case"invProd":return invProdSheet(s,err);case"invBuy":return invBuySheet(s,err);
  case"invPrice":return invPriceSheet(s);case"invRsAdd":return invRsAddSheet(s,err);case"invLevels":return invLevelsSheet(s,err);
  case"invMore":return`<h2>Stock menu</h2><div class="tiles">${invPages().filter(p=>!invMain().includes(p[0])).map(([k,l])=>`<button class="tile ${ui.inv===k?"on":""}" data-a="invPage" data-id="${k}">${invIco(k)}<span>${l}</span></button>`).join("")}</div>`;
  case"invSup":return invSupSheet(s,err);case"invRecipe":return invRecipeSheet(s,err);case"invDelBuy":{const p=DB.invBuys.find(x=>x.id===s.id),it=p&&Inv.item(p.itemId);
    return`<h2>Delete this purchase?</h2><p>${p?`${esc(it?it.name:"")} · ${fmtD(p.date)}`:""}. Stock and spending will be recalculated. The deletion is written to the activity log.</p><div class="grid2"><button class="btn sec" data-a="invBuy" data-id="${s.id}">Cancel</button><button class="btn danger" data-a="invDelBuyYes" data-id="${s.id}">Delete</button></div>`;}}
  return"";}

/* =====================================================================
   EVENTS (called from the main click / input / change handlers)
   return false = handled here (no re-render by main)
   ===================================================================== */
function invBusy(el,p,then){el.disabled=true;const t=el.textContent;el.textContent="Saving…";p.then(r=>{el.disabled=false;el.textContent=t;then(r);}).catch(e=>{console.error(e);el.disabled=false;el.textContent=t;toast("Something went wrong. Please try again.",true);});}
function invFailed(r){if(r.ok)return false;if(ui.sheet){ui.sheet.needWhy=!!r.why||ui.sheet.needWhy;ui.sheet.dup=!!r.dup;if(r.reload)ui.sheet.f={};}return failed(r);}
function invClick(a,id,el,s){
  switch(a){
    case"invPage":ui.inv=id;ui.sheet=null;if(el.dataset.view){ui.ir=ui.ir||{mode:"week",d:today(),view:"move"};ui.ir.view=el.dataset.view;}scrollTo(0,0);
      requestAnimationFrame(()=>{const c=document.querySelector("#invnav .chip.on");if(c)c.scrollIntoView({inline:"center",block:"nearest"});});return;
    case"invMore":return open({type:"invMore"}),false;
    case"invSDay":{const n=addDays(ui.invSDate||today(),+id);if(n<=today())ui.invSDate=n;ui.sdWhy=false;return;}
    case"invSDayToday":ui.invSDate=today();ui.sdWhy=false;return;
    case"invSSt":{const[iid,stv]=id.split(":");ui.sd=ui.sd||{};ui.sd[iid+".st"]=stv;return;}
    case"invSaveSimple":{const{rows,stats}=invSimpleCollect();
      invBusy(el,Inv.saveSimple(ui.invSDate,rows,stats,(ui.sd||{}).why),r=>{if(!r.ok){if(r.why)ui.sdWhy=true;if(r.reload)ui.sd={};render();toast(r.error,true);return;}
        ui.sd={};ui.sdWhy=false;toast(`Saved (${r.data} item${r.data>1?"s":""})`);render();});return false;}
    case"invCat":ui.inv="items";ui.invCat=id;return;
    case"invDCat":ui.invDCat=id;return;
    case"invDay":{const n=addDays(ui.invDate||today(),+id);if(n<=today())ui.invDate=n;return;}
    case"invDayToday":ui.invDate=today();return;
    case"invUDay":{const n=addDays(ui.invUDate||today(),+id);if(n<=today())ui.invUDate=n;return;}
    case"invUDayToday":ui.invUDate=today();return;
    case"invCount":return open({type:"invCount",id,date:el.dataset.date||ui.invDate||today(),f:{}}),false;
    case"invSt":s.f.st=id;return;
    case"invSaveCount":{const it=Inv.item(s.id),P=invCountPatch(it);if(P.err){failed(invFail(P.err));return false;}const next=id==="next";
      invBusy(el,Inv.saveCount(s.date,s.id,P.patch,val("icWhy")),r=>{if(invFailed(r))return;toast(r.data.v>1?"Correction saved":"Stock saved");
        if(next){const c=ui.invDCat||"all",l=Inv.items().filter(i=>c==="all"||i.cat===c),i=l.findIndex(x=>x.id===s.id),n=l.slice(i+1).find(x=>!Inv.rec(s.date,x.id))||l[i+1];
          ui.sheet=n?{type:"invCount",id:n.id,date:s.date,f:{}}:null;if(!n)toast("All items done for this category");}
        else ui.sheet=null;render();if(ui.sheet&&$(".sheet"))$(".sheet").scrollTop=0;});return false;}
    case"invItem":return open({type:"invItem",id}),false;
    case"invItemEdit":return open({type:"invItemEdit",id,f:{}}),false;
    case"invMode":invReadUnits(s);s.f.mode=id;if(id==="count"&&!s.units.length)s.units=[{id:"",name:"pack",min:"",target:"",per:"",start:""}];return;
    case"invRaw":s.f.raw=!fv(s,"raw",s.id?!!Inv.item(s.id).raw:true);el.classList.toggle("on");return false;
    case"invActive":{const cur=s.type==="invSup"?(s.id?Inv.sup(s.id).active!==false:true):(s.id?Inv.item(s.id).active!==false:true);s.f.active=!fv(s,"active",cur);el.classList.toggle("on");return false;}
    case"invUnitAdd":invReadUnits(s);s.units.push({id:"",name:"",min:"",target:"",per:"",start:""});return;
    case"invUnitRm":invReadUnits(s);s.units.splice(+id,1);return;
    case"invSaveItem":{invReadUnits(s);const it=s.id?Inv.item(s.id):null;
      const r=Inv.saveItem(s.id||null,{name:val("ieN"),en:val("ieE"),cat:val("ieC"),mode:fv(s,"mode",it?it.mode:"count"),raw:fv(s,"raw",it?!!it.raw:true),units:s.units,startStatus:val("ieSS")||(it&&it.startStatus)||"available",supId:val("ieSup"),note:val("ieNote"),active:fv(s,"active",it?it.active!==false:true)});
      if(invFailed(r))return false;toast("Item saved");ui.sheet={type:"invItem",id:r.data};return;}
    case"invDelItem":{const r=Inv.deleteItem(s.id);if(invFailed(r))return false;toast(r.data==="archived"?"Item archived (history kept)":"Item deleted");ui.sheet=null;return;}
    case"invUsageForm":return open({type:"invUsage",f:{}}),false;
    case"invSaveUsage":{const used={};for(const inp of document.querySelectorAll('.sheet input[id^="iu_"]')){const[iid,uidv]=inp.dataset.k.split(".");const v=parseQ(inp.value);
        if(v==null){failed(invFail(`${Inv.item(iid).name}: numbers only (e.g. 3 or 1.5)`));return false;}if(v===""&&!(Inv.rec(ui.invUDate,iid)||{lines:{}}).lines?.[uidv])continue;(used[iid]=used[iid]||{})[uidv]=v===""?0:v;}
      invBusy(el,Inv.saveUsage(ui.invUDate,used,val("iuWhy")),r=>{if(invFailed(r))return;toast(`Usage saved (${r.data} item${r.data>1?"s":""})`);ui.sheet=null;render();});return false;}
    case"invProdForm":return open({type:"invProd",f:{}}),false;
    case"invSaveProd":{const q={};document.querySelectorAll('.sheet input[id^="ip_"]').forEach(i=>{if(i.id!=="ipWhy")q[i.dataset.k]=i.value;});
      invBusy(el,Inv.saveProd(ui.invUDate,q,val("ipWhy")),r=>{if(invFailed(r))return;toast("Production saved");ui.sheet=null;render();});return false;}
    case"invBuy":return open({type:"invBuy",id:id||null,item:el.dataset.item||"",date:el.dataset.date||"",f:{}}),false;
    case"invSaveBuy":{const f={date:val("ibDate"),itemId:val("ibItem"),unitId:val("ibUnit"),qty:val("ibQty"),supId:val("ibSup"),supName:val("ibSupN"),up:val("ibUp"),total:val("ibTot"),inv:val("ibInv"),rm:val("ibRm"),why:val("ibWhy"),dupOk:!!s.dup};
      invBusy(el,Inv.savePurchase(s.id,f),r=>{if(invFailed(r))return;toast(s.id?"Purchase updated":API.isOwner()?"Purchase saved, stock updated":"Stock received saved");ui.sheet=null;render();});return false;}
    case"invDelBuy":return open({type:"invDelBuy",id:s.id}),false;
    case"invDelBuyYes":{const r=Inv.deletePurchase(id);if(invFailed(r))return false;toast("Purchase deleted");ui.sheet=null;return;}
    case"invBP":ui.invBP=id;return;
    case"invPriceItem":return open({type:"invPrice",id}),false;
    case"invHistItem":ui.inv="reports";ui.ir=ui.ir||{mode:"month",d:today()};ui.ir.view="hist";ui.irItem=id;ui.sheet=null;scrollTo(0,0);return;
    case"invIrMode":if(id==="custom"&&ui.ir.mode!=="custom"){const[f,t]=invRange(ui.ir);ui.ir.from=f;ui.ir.to=t>today()?today():t;}ui.ir.mode=id;return;
    case"invIrNav":{const R=ui.ir,n=+id;if(R.mode==="day")R.d=addDays(R.d,n);else if(R.mode==="week")R.d=addDays(R.d,7*n);else{const D=new Date(R.d+"T00:00:00");R.d=iso(new Date(D.getFullYear(),D.getMonth()+n,1));}return;}
    case"invIrView":ui.ir.view=id;return;
    case"invExportX":{const[f,t]=invRange(ui.ir);saveFile(`Aunty-Tauhu-inventory-${f}${f!==t?"_to_"+t:""}.xlsx`,invXlsx(invExportSheets(f,t)));return false;}
    case"invExportC":{const[f,t]=invRange(ui.ir);saveFile(`Aunty-Tauhu-inventory-${ui.ir.view}-${f}${f!==t?"_to_"+t:""}.csv`,invCsv(invReportCsv(f,t)));return false;}
    case"invTick":{const l=Inv.restock().find(x=>x.id===id);if(!l)return;const r=Inv.tick(id,l.it.id,l.u?l.u.id:"-");toast(r.data?"Ticked as purchased":"Unticked");return;}
    case"invRsAdd":return open({type:"invRsAdd",f:{}}),false;
    case"invRsSave":{const it=Inv.item(val("raItem"));const r=Inv.addManual(val("raItem"),it&&it.mode!=="status"?val("raUnit"):"-");if(invFailed(r))return false;toast("Added to restock list");ui.sheet=null;return;}
    case"invRsRm":Inv.removeManual(id);return;
    case"invRsShare":copyText(invRsText());return false;
    case"invLevels":return open({type:"invLevels"}),false;
    case"invSaveLevels":{const map={};document.querySelectorAll('.sheet input[id^="lv_"]').forEach(i=>{const[,iid,uidv,k]=i.id.match(/^lv_(.+?)_(.+)_(min|target)$/);((map[iid]=map[iid]||{})[uidv]=map[iid][uidv]||{})[k]=i.value;});
      const r=Inv.saveLevels(map);if(invFailed(r))return false;toast(`Saved (${r.data} change${r.data>1?"s":""})`);ui.sheet=null;return;}
    case"invSup":return open({type:"invSup",id:id||null,f:{}}),false;
    case"invSaveSup":{const x=s.id?Inv.sup(s.id):null;const r=Inv.saveSup(s.id,{name:val("spN"),phone:val("spP"),note:val("spNo"),active:fv(s,"active",x?x.active!==false:true)});if(invFailed(r))return false;toast("Supplier saved");ui.sheet=null;return;}
    case"invRecipe":return open({type:"invRecipe",id:id||null,f:{}}),false;
    case"invIngAdd":invReadIng(s);s.ing.push({itemId:"",unitId:"",qty:""});return;
    case"invIngRm":invReadIng(s);s.ing.splice(+id,1);return;
    case"invSaveRecipe":{invReadIng(s);const r=Inv.saveRecipe(s.id,{name:val("rcN"),out:val("rcO"),ing:s.ing.filter(g=>g.itemId||g.qty)});if(invFailed(r))return false;toast("Recipe saved");ui.sheet=null;return;}
    case"invDelRecipe":Inv.deleteRecipe(s.id);toast("Recipe removed");ui.sheet=null;return;
  }}
/* typing: keep values in the sheet state (so an error message never wipes them) + live calculations */
function invInput(ev){const t=ev.target,s=ui.sheet;
  if(t.dataset&&t.dataset.sk){ui.sd=ui.sd||{};ui.sd[t.dataset.sk]=t.value;const row=t.closest(".srow");
    if(row){const k=row.dataset.k,g=x=>{const e=document.getElementById(`s${x}_${k.replace(".","_")}`);return e?e.value:"";};row.querySelector(".sused").innerHTML=invSUsed(+row.dataset.open,+row.dataset.other,g("a"),g("c"));}return true;}
  if(!s||!String(s.type).startsWith("inv")||!t.dataset)return false;
  if(t.dataset.k){s.f=s.f||{};s.f[t.dataset.k]=t.value;}
  if(s.type==="invCount"&&t.dataset.k&&/\.(rx|us|ws|cl)$/.test(t.dataset.k)){const card=t.closest(".ucard");if(!card)return true;const u=card.dataset.u;
    const g=k=>parseQ(val(`ic_${u}_${k}`)),rx=g("rx")||0,us=g("us")||0,ws=g("ws")||0,cl=g("cl");
    const exp=q3(+card.dataset.open+ +card.dataset.bought+rx-us-ws);card.querySelector(".exp").textContent=fq(exp);card.querySelector(".eqv").innerHTML=invEq(+card.dataset.open,q3(+card.dataset.bought+rx),us,ws,exp);card.querySelector(".discbox").innerHTML=invDiscBox(exp,cl);}
  if(s.type==="invBuy"&&(t.id==="ibQty"||t.id==="ibUp"||t.id==="ibTot")){const it=Inv.item(val("ibItem")),u=it&&Inv.unit(it,val("ibUnit"));
    /* whichever was typed last fills in the other, so price and total always agree */
    const q=parseQ(val("ibQty")),up=toSen(val("ibUp")),tot=toSen(val("ibTot")),U=document.getElementById("ibUp"),T=document.getElementById("ibTot");
    if(U&&T&&q){if((t.id==="ibUp"||(t.id==="ibQty"&&s.drive!=="total"))&&up!=null){T.value=s2d(Math.round(up*q));s.f.total=T.value;s.drive="up";}
      else if((t.id==="ibTot"||t.id==="ibQty")&&tot!=null){U.value=s2d(Math.round(tot/q));s.f.up=U.value;s.drive="total";}}
    const c=document.getElementById("ibCalc");if(c)c.innerHTML=invBuyCalcText(val("ibQty"),val("ibUp"),val("ibTot"),u,s.drive);
    const cmp=document.getElementById("ibCmp");if(cmp&&it&&u){const last=Inv.priced(it,u.id).filter(x=>x.p.id!==s.id).pop(),a=toSen(val("ibUp"));cmp.innerHTML=last&&a!=null&&val("ibUp")!==""?invChangeBadge(Inv.change(a,last.pr.up)):"";}}
  return true;}
/* a "change" can fire while the page is being redrawn (input losing focus), so redraw just after */
function invLater(){setTimeout(render,0);}
function invChange(ev){const t=ev.target,s=ui.sheet;
  if(t.classList&&t.classList.contains("rsq")){const l=Inv.restock().find(x=>x.id===t.dataset.rs);if(l){const r=Inv.setSug(l.id,l.it.id,l.u?l.u.id:"-",t.value);if(!r.ok)toast(r.error,true);else toast("Saved");invLater();}return true;}
  if(t.id==="irFrom"||t.id==="irTo"){ui.ir.from=val("irFrom");ui.ir.to=val("irTo");if(ui.ir.from>ui.ir.to)[ui.ir.from,ui.ir.to]=[ui.ir.to,ui.ir.from];invLater();return true;}
  if(t.id==="irItem"){ui.irItem=t.value;invLater();return true;}
  if(s&&String(s.type).startsWith("inv")&&t.dataset&&t.dataset.rr){
    if(t.dataset.ing!=null){invReadIng(s);s.ing[+t.dataset.ing].unitId="";}
    else{s.f=s.f||{};s.f[t.dataset.k]=t.value;if(t.dataset.k==="itemId")s.f.unitId="";
      document.querySelectorAll(".sheet [data-k]").forEach(i=>{if(i!==t&&!i.disabled)s.f[i.dataset.k]=i.value;});if(t.dataset.k==="itemId")s.f.unitId="";}
    invLater();return true;}
  return false;}
