/* Tiemvio POS UI; talks to window.tiemvioBackend (see main.js). */
import {runTurn,createToolRunner,listModels,PROVIDERS} from './ai.js';
import {parseVietQR,readQrFromImage} from './vietqr.js';
import {LEGAL_SECTIONS,LEGAL_UPDATED,LEGAL_VERSION,LEGAL_SOURCES} from './legal.js';
import {appDownloads} from './app-downloads.js';
import {canApplyUpdate} from './update-policy.js';
// These listeners affect only this page; browser/OS accessibility controls may override viewport policy.
function blockTiemvioZoom(e){if(e.cancelable)e.preventDefault();}
['gesturestart','gesturechange','gestureend'].forEach(type=>document.addEventListener(type,blockTiemvioZoom,{passive:false}));
// No copying of what is on screen (typing fields are left alone so people can type and paste into them).
const tiemvioTyping=t=>!!(t&&t.closest&&t.closest('input,textarea,[contenteditable="true"]'));
['copy','cut','contextmenu','selectstart','dragstart'].forEach(type=>document.addEventListener(type,e=>{if(!tiemvioTyping(e.target)&&e.cancelable)e.preventDefault()},{capture:true}));
// iOS Safari can still zoom on a quick second tap: swallow the second tap's touchend (not on buttons, links or typing fields, so fast taps still register) and any dblclick.
let tiemvioLastTap=0;
document.addEventListener('touchend',e=>{const now=Date.now();if(now-tiemvioLastTap<350&&!tiemvioTyping(e.target)&&!(e.target.closest&&e.target.closest('button,a,select,label,summary,[role=button]'))&&e.cancelable)e.preventDefault();tiemvioLastTap=now},{passive:false,capture:true});
document.addEventListener('dblclick',e=>{if(!tiemvioTyping(e.target)&&e.cancelable)e.preventDefault()},{capture:true});
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&['c','x','a','s','u'].includes((e.key||'').toLowerCase())&&!tiemvioTyping(e.target))e.preventDefault()},{capture:true});
let tiemvioMultiTouch=false;
document.addEventListener('touchstart',e=>{if(e.touches.length>1){tiemvioMultiTouch=true;blockTiemvioZoom(e);}},{passive:false});
document.addEventListener('touchmove',e=>{if(tiemvioMultiTouch||e.touches.length>1)blockTiemvioZoom(e);},{passive:false});
document.addEventListener('touchend',e=>{if(e.touches.length===0)tiemvioMultiTouch=false;},{passive:true});
document.addEventListener('touchcancel',()=>{tiemvioMultiTouch=false;},{passive:true});

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => new Intl.NumberFormat('vi-VN').format(n || 0) + 'đ';
const labels = {split:'Tiền mặt + chuyển khoản',reconcile:'Đối soát',refund:'Hoàn tiền',owner:'Chủ quán',support:'Hỗ trợ phần mềm',sales:'Bán hàng',waiting:'Chờ làm',making:'Đang làm',ready:'Chờ giao',delivered:'Đã giao',cancelled:'Đã hủy',none:'Không đá',less:'Ít đá',normal:'Đá vừa',cash:'Tiền mặt',transfer:'Chuyển khoản'};
const orderNo=o=>o.seq?'#'+o.seq:'#'+o.id.slice(-6).toUpperCase();
const iceList=()=>(S.data&&S.data.iceOptions)||[{id:'normal',name:'Đá vừa',price:0},{id:'less',name:'Ít đá',price:0},{id:'none',name:'Không đá',price:0},{id:'extra',name:'Thêm đá',price:0}];
const sugarList=()=>(S.data&&S.data.sugarOptions)||[100,70,50,30,0].map(n=>({id:String(n),name:n+'% đường',percent:n,price:0}));
const extra=n=>n>0?' (+'+money(n)+')':'';
const iceText=(i,withPrice)=>i.iceName||(iceList().find(o=>o.id===i.ice)||{}).name||labels[i.ice]||'';
const sugarText=(i,withPrice)=>(i.sugarName||(i.sugar+'% đường'))+(withPrice?extra(i.sugarPrice):'');
const tempText=(i,withPrice)=>i.temp==='hot'?'Nóng':iceText(i)+(withPrice?extra(i.icePrice):'');
const tierBadge=t=>t&&t.id!=='member'?`<span class="tier" style="background:${t.id==='gold'?'#fdf0c8':'#e6ecef'};color:${t.id==='gold'?'#8a6200':'#44525a'}">${esc(t.name)}</span>`:'';
const channelName=id=>((S.data&&S.data.channels)||[]).find(c=>c.id===id)?.name||id;
const LOGO='<img src="/icons/logo.svg" alt="Tiemvio POS " style="height:86px;width:auto;display:block;margin:0 auto">';
const dmy=iso=>/^\d{4}-\d{2}-\d{2}$/.test(iso||'')?iso.slice(8,10)+'-'+iso.slice(5,7)+'-'+iso.slice(0,4):'';
const isoOf=v=>{const m=String(v||'').trim().match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);if(!m)return '';const iso=m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0');const t=new Date(iso+'T00:00:00Z');return !isNaN(t)&&t.toISOString().slice(0,10)===iso?iso:''};
const dateParts=(iso,opt)=>Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:S.data.timezone,...opt}).formatToParts(new Date(iso)).map(p=>[p.type,p.value]));
const fmtDate=iso=>{const p=dateParts(iso,{day:'2-digit',month:'2-digit',year:'numeric'});return p.day+'-'+p.month+'-'+p.year};
const fmtDateTime=iso=>{const p=dateParts(iso,{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});return p.hour+':'+p.minute+' '+p.day+'-'+p.month+'-'+p.year};
/** A date box that always reads and shows dd-mm-yyyy (the phone's own date control follows the phone's language). */
const dateField=(id,iso,style='')=>`<span class="datefield"><input id="${id}" aria-label="Ngày (dd-mm-yyyy)" inputmode="numeric" maxlength="10" placeholder="dd-mm-yyyy" autocomplete="off" value="${dmy(iso)}" style="${style}"><label class="date-trigger" id="${id}Btn"><span aria-hidden="true">📅</span><input type="date" id="${id}Pick" class="datepick" aria-label="Chọn ngày từ lịch" value="${iso||''}"></label></span>`;
const readDate=id=>isoOf($(id).value);
function wireDate(id,onValid){
  const t=$(id),pk=$(id+'Pick');
  t.oninput=()=>{const d=t.value.replace(/\D/g,'').slice(0,8);t.value=d.length>4?d.slice(0,2)+'-'+d.slice(2,4)+'-'+d.slice(4):d.length>2?d.slice(0,2)+'-'+d.slice(2):d;if(t.value.length===10&&isoOf(t.value)&&onValid)onValid(isoOf(t.value))};
  pk.onchange=()=>{if(pk.value){t.value=dmy(pk.value);if(onValid)onValid(pk.value)}};
  // Keep the native input directly under the finger: iOS date pickers cannot rely on synthetic clicks.
  const syncPicker=()=>{pk.value=readDate(id)||pk.value;};
  pk.onpointerdown=syncPicker;pk.onfocus=syncPicker;
}
const SIZE_LIST=['S','M','L','XL'];
const sizesOf=m=>(m&&m.sizes&&Object.keys(m.sizes).length)?m.sizes:{M:m?m.priceM:0};
const sizeKeys=m=>SIZE_LIST.filter(z=>sizesOf(m)[z]!==undefined);
const lowestPrice=m=>Math.min(...Object.values(sizesOf(m)));
const sizeTag=i=>{const m=((S.data&&S.data.menu)||[]).find(x=>x.id===i.productId);return m&&sizeKeys(m).length>1?i.size:''};
const hhmm=iso=>new Date(iso).toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit',timeZone:S.data.timezone});
const S = {adminSearch:'',adminSearchDraft:'',adminCat:'Tất cả',ai:{log:[],messages:[],busy:false,pending:null,draft:''},sorting:false,token:'',user:null,data:null,view:'sales',category:'Tất cả',search:'',filter:'active',cart:[],held:[],pending:null,day:'',busy:false,syncing:false,mutationRetry:null};
// Updates come from the service worker (see main.js). The banner appears when a new version is ready.
const updates={
  apply:null,
  offer(apply){this.apply=apply;$('updateBanner').classList.remove('hidden')},
  tryApply(){
    if(!this.apply)return false;
    if(!canApplyUpdate(S,!$('modal').classList.contains('hidden'))){$('updateReason').textContent='Bản mới sẽ tự áp dụng sau khi hoàn tất đơn, biểu mẫu hoặc trợ lý AI.';return false}
    this.apply();return true;
  }
};
window.addEventListener('tiemvio:update-ready',e=>updates.offer(e.detail.apply));
let lastInteraction=Date.now();
['pointerdown','keydown','input'].forEach(type=>document.addEventListener(type,()=>{lastInteraction=Date.now()},{capture:true,passive:true}));
setInterval(()=>{
 if(!updates.apply&&window.tiemvioPendingUpdate)updates.offer(window.tiemvioPendingUpdate);
 if(updates.apply&&!document.hidden&&Date.now()-lastInteraction>30000&&!tiemvioTyping(document.activeElement)&&canApplyUpdate(S,!$('modal').classList.contains('hidden')))updates.tryApply();
},5000);
let toastTimer, pollTimer;
const store = {get(k){try{return localStorage.getItem('tiemvio:'+k)}catch(e){return null}},set(k,v){try{localStorage.setItem('tiemvio:'+k,v);return true}catch(e){return false}},remove(k){try{localStorage.removeItem('tiemvio:'+k)}catch(e){}}};
function uid(){return crypto.randomUUID()}
function notify(message){$('toast').textContent=message;$('toast').classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.add('hidden'),5500)}
async function rpc(action,data={}){
  try{return await window.tiemvioBackend.call(action,data)}
  catch(e){const error=new Error(e.message);error.rejected=e.rejected;throw error}
}
// A sale that was shown as saved but that the server later refused: say so, loudly, so it is made again.
window.addEventListener('tiemvio:problem',e=>{notify('⚠ '+(e.detail||'Có thao tác chưa được lưu lên máy chủ.')+' Hãy kiểm tra lại đơn vừa tạo.');try{refresh(true)}catch(_){}});
function connection(text,warn=false){$('connection').textContent=text;$('connection').classList.toggle('warn',warn)}
function draftKey(){return 'draft:'+S.user.email+':'+(S.data?.database?.id||'unknown')}
function persistCart(){if(S.editing)return true;return store.set(draftKey(),JSON.stringify({cart:S.cart,pending:S.pending,held:S.held}))}
function restoreCart(){try{const d=JSON.parse(store.get(draftKey())||'{}');S.cart=d.cart||[];S.pending=d.pending||null;S.held=Array.isArray(d.held)?d.held:[]}catch(e){S.cart=[];S.pending=null;S.held=[]}}
/** Pack price × number of pieces ÷ pack size (10.000đ / 4 viên, 6 viên = 15.000đ; weighed items use the weight). */
/** Payment as shown to people: a split order spells out both parts. */
const payText=o=>o.paymentMethod==='split'?'Tiền mặt '+money(o.cashPart)+' + chuyển khoản '+money(o.total-o.cashPart):labels[o.paymentMethod];
const digitsOf=v=>{const r=String(v||'').replace(/\D/g,'');return r?Number(r):null};
const lineOf=i=>Math.round(i.unitPrice*i.quantity/(i.packQty||1));
const unitName=m=>m.unit||(m.kind==='food'?'phần':'ly');
const isCounted=i=>i.byWeight||(i.packQty||1)>1;
const itemsCount=items=>items.reduce((n,i)=>n+(isCounted(i)?1:i.quantity),0);
const qtyLabel=i=>{const q=Number.isInteger(i.quantity)?String(i.quantity):String(i.quantity).replace('.',',');const u=i.unitName;return u&&!['ly','phần'].includes(u)?q+' '+u:q};
const priceText=m=>m.kind==='food'&&(m.unit&&m.unit!=='phần'||(m.packQty||1)>1||m.note)?money(lowestPrice(m))+' / '+((m.packQty||1)>1?m.packQty+' ':'')+unitName(m)+(m.note?' · '+m.note:''):(sizeKeys(m).length>1?'Từ ':'')+money(lowestPrice(m));
function cartTotal(){return S.cart.reduce((n,i)=>n+lineOf(i),0)}
// The read-only support account can look at the app as the owner or as a staff member. This only changes what is drawn:
// the backend still sees the real role, so nothing can be written.
const VIEW_AS_LABELS={support:'Hỗ trợ',owner:'Chủ quán',sales:'Nhân viên'};
function asView(u){if(!u||u.role!=='support')return u;const v=store.get('viewAs')||(u.canEdit?'owner':'support');return {...u,realRole:'support',role:VIEW_AS_LABELS[v]&&v!=='support'?v:'support'}}
const realRole=()=>(S.user&&S.user.realRole)||(S.user&&S.user.role);
function viewAsModal(){
  openModal(`<h2>Xem app như…</h2><p class="muted" style="margin-top:4px">${S.data.user.canEdit?'Tài khoản hỗ trợ được sửa dữ liệu vận hành. Chỉ chủ quán được đổi cài đặt AI và quản lý tài khoản.':'Tài khoản này chỉ xem dữ liệu.'}</p>${Object.entries(VIEW_AS_LABELS).map(([k,t])=>`<button class="wide ${(S.user.role===k)?'primary':'soft'}" data-viewas="${k}" style="margin-top:10px">${t}${k==='support'?' (mặc định)':''}</button>`).join('')}`);
  $('modal').querySelectorAll('[data-viewas]').forEach(b=>b.onclick=()=>{store.set('viewAs',b.dataset.viewas);S.user=asView({...S.data.user});S.view='sales';S.sched={from:'',data:null,loading:false,person:'',weeks:{}};S.report=null;closeModal();render()});
}
function isViewer(){return ['owner','support'].includes(S.user?.role)}
function isSales(){return ['owner','sales'].includes(S.user?.role)}
const canOperate=()=>isSales()&&realRole()!=='support'||isSales()&&S.data?.user?.canEdit===true;

function loginScreen(message=''){
  $('nav').classList.add('hidden');$('cartbar').classList.add('hidden');$('logout').classList.add('hidden');$('bell').classList.add('hidden');$('viewAs').classList.add('hidden');
  $('app').innerHTML=`<section class="card login"><div class="mark">${LOGO}</div><h1>Chào ca làm mới</h1><p class="muted" style="margin-top:8px">Hệ thống bán hàng và kiểm soát thu chi trực quan.</p><div style="margin:24px 0"><button id="login" class="primary wide" style="display:block;width:100%;text-align:center;padding:14px;border-radius:14px;font-weight:600">Tiếp tục với Google</button></div><p class="muted" style="font-size:12.5px">Chỉ tài khoản được chủ quán cấp quyền mới truy cập được. Dữ liệu bán hàng lưu trữ an toàn trên Firebase.</p><p class="muted" style="font-size:12px;margin-top:8px">Bằng việc đăng nhập, bạn đồng ý với <a href="#" id="legalLink">giấy phép và điều khoản sử dụng</a>.</p><div id="loginError" class="error" role="alert" style="margin-top:12px">${esc(message)}</div></section>`;
  $('legalLink').onclick=e=>{e.preventDefault();legalModal()};
  const button=$('login');
  button.onclick=async()=>{
    button.disabled=true;button.textContent='Đang mở Google…';
    try{await window.tiemvioBackend.signIn()}
    catch(e){button.disabled=false;button.textContent='Tiếp tục với Google';$('loginError').textContent=e.message}
  };
}
function endSession(message=''){clearTimeout(pollTimer);S.pruned=false;S.report=null;S.ai={log:[],messages:[],busy:false,pending:null,draft:''};S.sched={from:'',data:null,loading:false,person:'',weeks:{},started:false};S.busy=false;S.editing=null;S.token='';S.user=null;S.data=null;S.cart=[];S.held=[];S.pending=null;closeModal();connection('Chưa đăng nhập');loginScreen(message)}
S.images={};S.imagesRev='';
// Photos are fetched separately and only when the server's imagesRev changes, so polling stays light.
async function syncImages(){
  const rev=S.data?.imagesRev||'';
  if(rev===S.imagesRev)return false;
  if(!rev){S.images={};S.imagesRev='';return true}
  try{const r=await rpc('menuImages');S.images=r.images||{};S.imagesRev=r.rev||rev;return true}catch(e){return false}
}
async function start(){
  try{S.data=await rpc('snapshot');S.user=asView(S.data.user);S.day=S.data.day;S.view='sales';restoreCart();render();navigator.onLine?connection('Đã kết nối · '+labels[S.user.role]):connection('Mất mạng · Đơn chưa gửi được giữ trên máy',true);schedulePoll()}
  catch(e){loginScreen(e.message)}
}
async function refresh(renderContent=true){
  if(S.syncing||!S.token)return;S.syncing=true;
  try{const data=await rpc('snapshot',{day:S.day});if(!S.token)return;S.data=data;S.user=asView(data.user);const imagesChanged=await syncImages();connection('Đã kết nối · '+new Date().toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'}));
    if((renderContent||(imagesChanged&&S.view==='sales'))&&!S.busy&&$('modal').classList.contains('hidden'))render();
  }catch(e){connection('Chưa đồng bộ · Nhấn làm mới',true)}finally{S.syncing=false}
}
window.tiemvioBackend.onChange(()=>{if(S.token)refresh(S.view==='orders')});
window.tiemvioBackend.onSignedOut(message=>{if(S.token)endSession(message||'Phiên đăng nhập đã kết thúc.')});
// The "đang làm" bar of someone still clocked in grows with the time: redraw the Schedule tab once a minute while it is open.
setInterval(()=>{const Z=S.sched;if(S.view==='schedule'&&Z&&Z.data&&!document.hidden&&$('modal').className==='hidden'&&Z.data.clock.some(c=>!c.outAt))schedLoad(Z.from,true)},60000);
function schedulePoll(){clearTimeout(pollTimer);pollTimer=setTimeout(async()=>{if(!document.hidden)await refresh(S.view==='orders');schedulePoll()},30000)}

const NAV_ICONS = {
  clock: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  schedule: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`,
  ai: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>`,
  sales: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>`,
  orders: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
  report: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>`,
  admin: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`
};

function render(){
  if(!S.user)return;
  if(S.user.role==='owner'&&!S.pruned){S.pruned=true;rpc('pruneSchedule',{}).catch(()=>{})}   // shifts older than 60 days are removed when the owner opens the app
  if(!isViewer()&&['admin','report','ai'].includes(S.view))S.view='sales';if(S.user.role!=='sales'&&S.view==='clock')S.view='sales';if(S.user.role==='support'&&S.view==='ai')S.view='orders';
  $('logout').classList.remove('hidden');$('bell').classList.toggle('hidden',realRole()==='support');$('viewAs').classList.toggle('hidden',realRole()!=='support');$('viewAs').textContent=VIEW_AS_LABELS[S.user.role]+' ▾';$('viewAs').style.cssText='white-space:nowrap;padding:6px 8px;font-size:12px;min-width:0';$('nav').classList.remove('hidden');
  const nav=[['sales','Bán hàng'],['orders','Đơn hàng']];if(S.user.role==='sales')nav.push(['clock','Chấm công']);nav.push(['schedule','Lịch làm']);if(isViewer()){nav.push(['report','Doanh thu']);if(S.user.role==='owner'&&(realRole()!=='support'||S.data.user.canEdit))nav.push(['ai','Trợ lý AI']);nav.push(['admin','Quản lý'])}
  $('nav').innerHTML=nav.map(([v,t])=>`<button data-view="${v}" class="${v===S.view?'active':''}"><span class="nav-icon" aria-hidden="true">${NAV_ICONS[v]||''}</span><span class="nav-label">${t}</span></button>`).join('');
  $('nav').querySelectorAll('button').forEach(b=>b.onclick=()=>{S.view=b.dataset.view;render()});
  if(S.view==='sales')renderSales();if(S.view==='orders')renderOrders();if(S.view==='report')renderReport();if(S.view==='admin')renderAdmin();if(S.view==='ai')renderAI();if(S.view==='schedule')renderSchedule();if(S.view==='clock')renderClock();
  const n=itemsCount(S.cart);$('cartbar').classList.toggle('hidden',S.view!=='sales'||(!n&&!S.pending));
  $('cartbar').innerHTML=`<span>${S.pending?'⚠️ Đơn chưa xác nhận':`<strong style="font-size:16px">${n}</strong> món trong đơn`}</span><span>${money(cartTotal())} &nbsp;→</span>`;
}

function drinkCup(category,kind){
  if(kind==='food')return '🍿';
  if(category==='Trà trái cây')return '🍊';
  if(category==='Topping')return '✨';
  if(category==='Cà phê')return '☕';
  if(category==='Matcha')return '🍵';
  if(category==='Cacao')return '🍫';
  return '🧋';
}

function renderSales(){
  const menu=S.data.menu.filter(m=>(m.kind==='drink'||m.kind==='food')&&m.active===true);
  const present=new Set(menu.map(m=>m.category));
  const cats=['Tất cả',...(S.data.menuCategories||[]).filter(c=>present.has(c)),...[...present].filter(c=>!(S.data.menuCategories||[]).includes(c))];
  const filtered=menu.filter(m=>(S.category==='Tất cả'||m.category===S.category)&&m.name.toLowerCase().includes(S.search.toLowerCase()));
  const n=itemsCount(S.cart);

  $('app').innerHTML=`
    <div class="split">
      <section>
        <div class="section-head">
          <div class="eyebrow">QUẦY BÁN HÀNG · POS</div>
          <h1>Hôm nay uống gì?</h1>
          <p class="muted">Chọn món nước và tùy chỉnh đường, đá, topping theo sở thích của khách.</p>
        </div>
        ${shiftBar()}
        ${S.editing?`<div class="notice row" style="background:#fff3e0;border-color:#f0c58a"><span>✏️ Đang sửa đơn <strong>${esc(S.editing.seq)}</strong>. Thêm hoặc bớt món, rồi bấm giỏ hàng để <strong>Lưu thay đổi</strong>.</span><button id="cancelEdit" class="small">Hủy sửa</button></div>`:''}
        ${S.pending?'<div class="notice">⚠️ Có đơn chưa nhận được xác nhận từ máy chủ. Bấm vào giỏ hàng để kiểm tra và gửi lại an toàn.</div>':''}
        <div class="row" style="margin-bottom:14px">
          <button id="heldBaskets" class="small soft">📦 Giỏ đang giữ (${S.held.length})</button>
          <span class="muted" style="font-size:13px">${filtered.length} món sẵn sàng</span>
          ${S.user.role==='owner'?`<button id="sortToggle" class="small ${S.sorting?'primary':'soft'}">${S.sorting?'✔ Xong':'↕ Sắp xếp món'}</button>`:''}
        </div>
        ${S.sorting?'<div class="notice">Bấm <strong>⤒</strong> để đưa món lên đầu, hoặc giữ <strong>⠿</strong> rồi kéo để đổi chỗ.</div>':''}
        <input class="search" id="search" placeholder="Tìm cà phê, matcha, cacao…" aria-label="Tìm món" value="${esc(S.search)}">
        <div class="tabs">
          ${cats.map(c=>`<button class="${S.category===c?'selected':''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
        </div>
        <div class="products">
          ${filtered.map(m=>`
            <button class="product${S.sorting?' sorting':''}" data-product="${esc(m.id)}" data-id="${esc(m.id)}">
              ${S.sorting?`<span class="sort-top" data-top="${esc(m.id)}" role="button" aria-label="Đưa lên đầu">⤒</span><span class="sort-grip" data-grip="${esc(m.id)}" aria-label="Kéo để đổi chỗ">⠿</span>`:''}
              ${S.images[m.id]?`<span class="cup photo"><img src="${S.images[m.id]}" alt="${esc(m.name)}" loading="lazy"></span>`:`<span class="cup" aria-hidden="true">${drinkCup(m.category,m.kind)}</span>`}
              <div>
                <h3>${esc(m.name)}</h3>
                <div class="muted" style="font-size:12px;margin-top:2px">${esc(m.category)}${sizeKeys(m).length>1?' · '+sizeKeys(m).join(' / '):''}</div>
                <div class="price">${priceText(m)}</div>
              </div>
              <span class="add" aria-hidden="true">＋</span>
            </button>
          `).join('')||'<p class="empty">Không tìm thấy món phù hợp với từ khóa.</p>'}
        </div>
      </section>

      <aside class="side-note">
        <div class="eyebrow">CA LÀM HIỆN TẠI</div>
        <div class="row" style="margin:10px 0 14px">
          <div>
            <h2 style="font-size:18px">${esc(S.user.name)}</h2>
            <div class="muted" style="font-size:12.5px">${labels[S.user.role]}</div>
          </div>
          <span class="badge ready">Đang trực ca</span>
        </div>

        <div style="border-top:1px solid var(--line-subtle);padding-top:14px;margin-top:14px">
          <div class="eyebrow">GIỎ HÀNG NHANH</div>
          ${n > 0 ? `
            <div style="margin:10px 0">
              <div class="row">
                <span>Số lượng món:</span>
                <strong>${n} món</strong>
              </div>
              <div class="row" style="margin-top:6px">
                <span>Tổng tiền:</span>
                <strong style="color:var(--green);font-size:18px">${money(cartTotal())}</strong>
              </div>
              <button id="sideCartBtn" class="primary wide" style="margin-top:14px">Xem giỏ & Thanh toán →</button>
            </div>
          ` : `
            <p class="muted" style="font-size:13.5px;margin-top:8px">Chưa chọn món nào. Hãy chạm vào món bên trái để bắt đầu tạo đơn mới.</p>
          `}
        </div>

        <div style="border-top:1px solid var(--line-subtle);padding-top:14px;margin-top:14px">
          <div class="eyebrow">MẸO BÁN HÀNG</div>
          <p class="muted" style="font-size:13px;line-height:1.5">Nhập số điện thoại khách hàng khi thanh toán để tích điểm (1 điểm = 1.000đ giảm giá).</p>
        </div>
      </aside>
    </div>
  `;

  $('shiftBtn')&&($('shiftBtn').onclick=shiftModal);
  $('cancelEdit')&&($('cancelEdit').onclick=()=>{S.editing=null;S.cart=[];render();notify('Đã hủy sửa đơn. Đơn giữ nguyên như cũ.')});
  $('heldBaskets').onclick=heldModal;
  $('sideCartBtn')&&($('sideCartBtn').onclick=cartModal);
  $('search').oninput=e=>{const pos=e.target.selectionStart;S.search=e.target.value;renderSales();$('search').focus();$('search').setSelectionRange(pos,pos)};
  $('app').querySelectorAll('[data-cat]').forEach(b=>b.onclick=()=>{S.category=b.dataset.cat;renderSales()});
  $('sortToggle')&&($('sortToggle').onclick=()=>{S.sorting=!S.sorting;renderSales()});
  if(S.sorting)wireSorting(filtered.map(m=>m.id));
  $('app').querySelectorAll('[data-product]').forEach(b=>b.onclick=()=>{if(S.sorting)return;if(S.pending)return notify('Hãy xác nhận đơn đang chờ trước khi tạo đơn mới.');productModal(b.dataset.product)});
}

// Owner-only ordering of the sales grid. `subset` is what is on screen; items outside it keep their slots.
async function saveOrder(subset,newSubset){
  const all=S.data.menu.map(m=>m.id),inSub=new Set(subset);let k=0;
  const ids=all.map(id=>inSub.has(id)?newSubset[k++]:id);
  try{await rpc('reorderMenu',{ids});await refresh(false);renderSales()}
  catch(e){notify(e.message);renderSales()}
}
function wireSorting(subset){
  const grid=document.querySelector('.products');if(!grid)return;
  grid.querySelectorAll('[data-top]').forEach(b=>b.onclick=e=>{e.stopPropagation();const id=b.dataset.top;saveOrder(subset,[id,...subset.filter(x=>x!==id)])});
  grid.querySelectorAll('[data-grip]').forEach(g=>{
    g.addEventListener('pointerdown',e=>{
      e.preventDefault();const card=g.closest('.product');card.classList.add('dragging');g.setPointerCapture(e.pointerId);
      const move=ev=>{
        const el=document.elementFromPoint(ev.clientX,ev.clientY),over=el&&el.closest&&el.closest('.product');
        if(!over||over===card||over.parentNode!==grid)return;
        const before=card.compareDocumentPosition(over)&Node.DOCUMENT_POSITION_FOLLOWING;
        grid.insertBefore(card,before?over.nextSibling:over);
      };
      const up=()=>{
        g.removeEventListener('pointermove',move);g.removeEventListener('pointerup',up);g.removeEventListener('pointercancel',up);
        card.classList.remove('dragging');
        const now=[...grid.querySelectorAll('.product')].map(c=>c.dataset.id);
        if(now.join()!==subset.join())saveOrder(subset,now);
      };
      g.addEventListener('pointermove',move);g.addEventListener('pointerup',up);g.addEventListener('pointercancel',up);
    });
  });
}

/* ---------- Trợ lý AI (owner only; key and model live on this device, not in the shop database) ---------- */
// API keys and models are kept online (Firestore doc readable only by the owner account), so every device has them.
const aiOnline=()=>S.ai.cfg||{provider:'',keys:{},models:{}};
const aiCfg=()=>{
  const o=aiOnline(),provider=PROVIDERS[o.provider]?o.provider:'anthropic';
  return {provider,key:(o.keys||{})[provider]||'',model:(o.models||{})[provider]||PROVIDERS[provider].model};
};
async function aiLoad(){
  if(S.ai.cfg||S.ai.loading)return;
  S.ai.loading=true;
  try{
    const c=await rpc('getAiConfig',{});c.keys=c.keys||{};c.models=c.models||{};
    // One-time move of a key saved on this device by the earlier version.
    const old=store.get('ai:key:anthropic')||store.get('ai:key'),oldOr=store.get('ai:key:openrouter');
    if(realRole()!=='support'&&((old&&!c.keys.anthropic)||(oldOr&&!c.keys.openrouter))){
      if(old&&!c.keys.anthropic)c.keys.anthropic=old;if(oldOr&&!c.keys.openrouter)c.keys.openrouter=oldOr;
      c.provider=c.provider||store.get('ai:provider')||'anthropic';
      await rpc('saveAiConfig',c);
    }
    ['ai:key','ai:key:anthropic','ai:key:openrouter'].forEach(k=>store.remove(k));
    S.ai.cfg=c;
  }catch(e){S.ai.cfgError=e.message}
  S.ai.loading=false;if(S.view==='ai')renderAI();
}
async function aiPersist(next){
  await rpc('saveAiConfig',next);S.ai.cfg=next;
}

const aiPendingKey=email=>'ai:pending:'+email;
function aiNewChat(){const A=S.ai;if(A.busy||A.loadingChat)return;if(A.unsaved)return notify('Hãy lưu lại lượt chat chưa đồng bộ trước.');A.chatId='';A.expiresAt=0;A.log=[];A.messages=[];A.saveError='';renderAI();}
async function aiHistoryLoad(){
 const A=S.ai;if(A.historyLoading)return;A.historyLoading=true;
 try{
  const r=await rpc('listAiChats');A.chats=r.chats;A.historyError='';
  if(A.chatId&&!A.chats.some(c=>c.id===A.chatId)&&!A.busy&&!A.unsaved){A.chatId='';A.log=[];A.messages=[];A.expiresAt=0;}
  if(!A.restored){
   A.restored=true;let pending;try{pending=JSON.parse(store.get(aiPendingKey(S.user.email))||'null')}catch(_){}
   if(pending&&Date.now()-pending.at<7*86400000){
    A.unsaved=pending;A.chatId=pending.chatId;
    try{const chat=await rpc('loadAiChat',{id:pending.chatId});A.expiresAt=chat.expiresAt;A.log=chat.turns.flatMap(t=>t.log);A.messages=chat.turns.flatMap(t=>t.messages);if(!chat.turns.some(t=>t.id===pending.id)){A.log.push(...pending.log);A.messages.push(...pending.messages)}}catch(_){A.log=pending.log;A.messages=pending.messages}
    A.saveError='Có lượt chat chưa đồng bộ từ lần trước. Bấm Lưu lại lịch sử để gửi lên.';
   }else store.remove(aiPendingKey(S.user.email));
  }
 }catch(e){A.historyError=e.message}
 A.historyLoaded=true;A.historyLoading=false;if(S.ai===A&&S.view==='ai')renderAI();
}
async function aiOpenChat(id){
 const A=S.ai;if(A.busy||A.loadingChat)return;if(A.unsaved)return notify('Hãy lưu lại lượt chat chưa đồng bộ trước.');if(!id)return aiNewChat();
 A.loadingChat=true;renderAI();
 try{const c=await rpc('loadAiChat',{id});A.chatId=c.id;A.expiresAt=c.expiresAt;A.messages=c.turns.flatMap(t=>t.messages);A.log=c.turns.flatMap(t=>t.log);A.saveError='';}
 catch(e){notify(e.message);A.historyLoaded=false;}
 A.loadingChat=false;if(S.ai===A&&S.view==='ai')renderAI();
}
async function aiSaveHistory(A,payload){
 try{
  await rpc('createAiChat',{id:payload.chatId,title:payload.title});
  await rpc('saveAiTurn',payload);A.unsaved=null;A.saveError='';A.historyLoaded=false;store.remove(aiPendingKey(payload.email));
 }catch(e){A.unsaved=payload;A.saveError='Chưa lưu được lịch sử: '+e.message;store.set(aiPendingKey(payload.email),JSON.stringify(payload));}
}

setInterval(()=>{const A=S.ai;if(S.view!=='ai'||document.hidden||A.busy||A.loadingChat||A.unsaved)return;if(A.expiresAt&&A.expiresAt<=Date.now()){renderAI();return;}if(!A.draft){if(A.chatId)aiOpenChat(A.chatId);aiHistoryLoad();}},30000);
const AI_IDEAS=['Tóm tắt doanh thu và lợi nhuận tuần này','Tính lương nhân viên tháng này, lương giờ 25.000đ','Món nào bán chạy nhất? Món nào ế?','Nguyên liệu nào sắp hết?','Thêm khuyến mãi giảm 10% từ 14h đến 17h'];
function renderAI(){
  const A=S.ai,cfg=aiCfg();if(A.expiresAt&&A.expiresAt<=Date.now()&&!A.busy){if(A.unsaved)store.remove(aiPendingKey(A.unsaved.email));A.unsaved=null;A.saveError='';A.chatId='';A.expiresAt=0;A.log=[];A.messages=[];A.historyLoaded=false;}aiLoad();if(!A.historyLoaded&&!A.historyLoading)aiHistoryLoad();
  const bubble=e=>{
    if(e.type==='user')return `<div class="ai-msg user">${e.author?`<div style="font-size:11px;opacity:.8">${esc(e.author)}</div>`:''}${esc(e.text)}</div>`;
    if(e.type==='text')return `<div class="ai-msg bot">${esc(e.text)}</div>`;
    if(e.type==='tool')return e.write?`<div class="ai-act">${esc(e.text)}</div>`:'';
    if(e.type==='result')return e.text?`<div class="ai-act ${e.ok?'ok':'bad'}">${e.ok?'✔ Đã thực hiện':'✖ Không thực hiện được'}${e.error?': '+esc(e.error):''}</div>`:'';
    if(e.type==='denied')return `<div class="ai-act bad">✖ Bạn đã từ chối</div>`;
    if(e.type==='error')return `<div class="notice">${esc(e.text)}</div>`;
    return '';
  };
  $('app').innerHTML=`
    <section class="ai-wrap">
      <div class="row">
        <div><div class="eyebrow">CHỈ CHỦ QUÁN</div><h1 style="margin:2px 0 0">Trợ lý AI</h1></div>
        ${realRole()!=='support'?'<button id="aiSettings" class="small soft" aria-label="Cài đặt AI">⚙ Cài đặt AI</button>':''}
      </div>
      <p class="muted" style="font-size:13px;margin:6px 0 12px">Hỏi hoặc nhờ trợ lý quản lý quán. Mọi thao tác thay đổi dữ liệu đều chờ bạn bấm <strong>Cho phép</strong>. Trợ lý chỉ đọc doanh thu, chi phí và chấm công, không xóa hay sửa được.</p>
      ${A.loading&&!A.cfg?'<div class="muted" style="font-size:13px;margin-bottom:8px">Đang tải cài đặt AI…</div>':''}${A.cfgError?`<div class="notice">${esc(A.cfgError)}</div>`:''}${cfg.key||A.loading?'':realRole()==='support'?'<div class="notice">Chủ quán cần cấu hình khóa AI trước khi sử dụng.</div>':'<div class="notice">Chưa có API key. Bấm <strong>⚙ Cài đặt AI</strong> để nhập key của bạn.</div>'}
      <div class="row" style="gap:8px;margin:10px 0">
        <select id="aiHistory" aria-label="Lịch sử chat dùng chung" ${A.busy||A.loadingChat||A.unsaved?'disabled':''}><option value="">Cuộc trò chuyện mới</option>${(A.chats||[]).map(c=>`<option value="${esc(c.id)}" ${A.chatId===c.id?'selected':''}>${esc(c.title)} · ${esc(c.createdByName||'')} · ${esc(fmtDateTime(new Date(c.createdAt).toISOString()))}</option>`).join('')}</select>
        <button id="aiHistoryRefresh" class="small" ${A.busy||A.loadingChat||A.historyLoading?'disabled':''}>Làm mới</button>
      </div>
      <p class="muted" style="font-size:12px">Lịch sử dùng chung cho các chủ quán và tài khoản hỗ trợ được cấp quyền. Mỗi cuộc trò chuyện lưu 7 ngày từ lúc tạo.</p>
      ${A.historyLoading||A.loadingChat?'<p class="muted">Đang tải lịch sử…</p>':''}
      ${A.historyError?`<p class="error">${esc(A.historyError)}</p>`:''}
      ${A.saveError?`<div class="notice">${esc(A.saveError)} <button id="aiRetrySave" class="small" ${A.busy?'disabled':''}>Lưu lại lịch sử</button><button id="aiDiscardSave" class="small" ${A.busy?'disabled':''}>Bỏ bản lưu chưa gửi</button></div>`:''}
      <div id="aiLog" class="ai-log">
        ${A.log.length?A.log.map(bubble).join(''):`<div class="muted" style="font-size:13px">Gợi ý:</div><div class="ai-ideas">${AI_IDEAS.map((t,i)=>`<button class="small soft" data-idea="${i}">${esc(t)}</button>`).join('')}</div>`}
        ${A.pending?`<div class="ai-confirm"><strong>Trợ lý muốn:</strong><div style="margin:6px 0 10px">${esc(A.pending.text)}</div><div class="row" style="gap:8px"><button id="aiAllow" class="primary">Cho phép</button><button id="aiDeny" class="small">Từ chối</button></div></div>`:''}
        ${A.busy&&!A.pending?`<div class="muted" style="font-size:13px" id="aiWait">${esc(A.status||'Đang suy nghĩ…')} <span id="aiSecs">${A.t0?Math.round((Date.now()-A.t0)/1000):0}</span>s</div>`:''}
      </div>
      <form id="aiForm" class="ai-form">
        <textarea id="aiInput" rows="2" maxlength="2000" placeholder="Nhờ trợ lý: thêm món, sửa giá, tính lương…" ${A.busy?'disabled':''}>${esc(A.draft||'')}</textarea>
        <button class="primary" id="aiSend" ${A.busy?'disabled':''}>Gửi</button>
      </form>
      ${A.log.length?'<button id="aiClear" type="button" class="small" style="margin-top:10px">Cuộc trò chuyện mới</button>':''}
    </section>`;
  const log=$('aiLog');log.scrollTop=log.scrollHeight;
  if($('aiSettings'))$('aiSettings').onclick=aiSettingsModal;
  $('aiHistory').onchange=e=>aiOpenChat(e.target.value);$('aiHistoryRefresh').onclick=()=>{if(A.chatId&&!A.unsaved)aiOpenChat(A.chatId);aiHistoryLoad()};
  if($('aiRetrySave'))$('aiRetrySave').onclick=async()=>{if(A.busy||!A.unsaved)return;A.busy=true;renderAI();await aiSaveHistory(A,A.unsaved);A.busy=false;if(S.ai===A&&S.view==='ai')renderAI()};
  if($('aiDiscardSave'))$('aiDiscardSave').onclick=()=>{if(A.busy||!confirm('Bỏ bản lịch sử chưa gửi trên máy này? Thao tác đã thực hiện bởi AI vẫn được giữ.'))return;store.remove(aiPendingKey(A.unsaved.email));A.unsaved=null;A.saveError='';renderAI()};
  $('aiInput').oninput=e=>{A.draft=e.target.value};
  $('app').querySelectorAll('[data-idea]').forEach(b=>b.onclick=()=>{A.draft=AI_IDEAS[+b.dataset.idea];renderAI();$('aiInput').focus()});
  $('aiClear')&&($('aiClear').onclick=aiNewChat);
  if(A.pending){$('aiAllow').onclick=()=>A.pending.resolve(true);$('aiDeny').onclick=()=>A.pending.resolve(false)}
  $('aiForm').onsubmit=e=>{e.preventDefault();aiSend()};
}
async function aiSend(){
  const A=S.ai,cfg=aiCfg(),text=(A.draft||'').trim();
  if(A.busy||A.loadingChat||!text)return;
  if(A.historyLoading||!A.historyLoaded)return notify('Đang tải lịch sử chat, hãy đợi một chút.');
  if(A.unsaved)return notify('Hãy lưu lại lượt chat chưa đồng bộ trước.');
  if(A.expiresAt&&A.expiresAt<=Date.now())return notify('Cuộc trò chuyện đã hết hạn. Hãy tạo cuộc trò chuyện mới.');
  if(!cfg.key){if(realRole()==='support')notify('Chủ quán cần cấu hình khóa AI trước khi sử dụng.');else aiSettingsModal();return}
  const logMark=A.log.length,turnId=uid(),email=S.user.email;
  A.draft='';A.busy=true;A.t0=Date.now();A.status='Đang suy nghĩ…';clearInterval(A.tick);A.tick=setInterval(()=>{const el=document.getElementById('aiSecs');if(el&&A.t0)el.textContent=Math.round((Date.now()-A.t0)/1000);if(!A.busy)clearInterval(A.tick)},1000);A.log.push({type:'user',text,author:S.user.name||S.user.email});A.messages.push({role:'user',content:text});renderAI();
  const run=createToolRunner((a,d)=>window.tiemvioBackend.call(a,d));
  const mark=A.messages.length-1;
  try{
    if(!A.chatId){A.chatId=uid();A.expiresAt=Date.now()+7*86400000;}
    await rpc('createAiChat',{id:A.chatId,title:text});
    await runTurn({provider:cfg.provider,apiKey:cfg.key,model:cfg.model,messages:A.messages,run,
      confirm:(name,input,t)=>new Promise(resolve=>{A.pending={text:t,resolve:ok=>{A.pending=null;resolve(ok);if(S.view==='ai')renderAI()}};if(S.view==='ai')renderAI()}),
      onEvent:e=>{if(e.type==='tool'&&!e.write)A.status={get_shop_data:'Đang đọc dữ liệu cửa hàng…',get_report:'Đang đọc báo cáo…',list_orders:'Đang đọc đơn hàng…',calculate_payroll:'Đang tính lương…'}[e.name]||'Đang đọc dữ liệu…';else if(e.type==='result'||e.type==='text')A.status='Đang suy nghĩ…';A.log.push(e);if(S.view==='ai')renderAI()}});
    refresh(false);
  }catch(e){A.messages.length=mark;A.log.push({type:'error',text:e.message||'Có lỗi xảy ra.'})}
  if(A.chatId)await aiSaveHistory(A,{chatId:A.chatId,id:turnId,title:text,email,at:Date.now(),messages:A.messages.slice(mark),log:A.log.slice(logMark).filter(e=>e.type!=='tool'||e.write).map(e=>{const {input,...safe}=e;return safe})});
  A.busy=false;A.pending=null;clearInterval(A.tick);if(S.ai===A&&S.view==='ai')renderAI();
}
function aiSettingsModal(){
  const o=aiOnline();let c=aiCfg();const models={};
  const sel=p=>({provider:p,key:(o.keys||{})[p]||'',model:(o.models||{})[p]||PROVIDERS[p].model});
  const body=()=>{
    const P=PROVIDERS[c.provider];
    return `
    <label for="aiProvider">Nhà cung cấp</label>
    <select id="aiProvider">${Object.entries(PROVIDERS).map(([k,v])=>`<option value="${k}" ${k===c.provider?'selected':''}>${esc(v.label)}</option>`).join('')}</select>
    <label for="aiKey">API key</label>
    <input id="aiKey" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${c.key?'Đã lưu (••••'+esc(c.key.slice(-4))+'). Nhập key mới để thay':esc(P.keyHint)}">
    <p class="muted" style="font-size:12.5px">Lấy key tại ${esc(P.site)}. Chi phí tính vào tài khoản API của bạn.</p>
    <label for="aiModel">Mô hình</label>
    <input id="aiModel" list="aiModels" autocapitalize="off" spellcheck="false" value="${esc(c.model)}">
    <datalist id="aiModels">${(models[c.provider]||[]).map(m=>`<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</datalist>
    <button id="aiLoadModels" type="button" class="small soft" style="margin-top:8px">↻ Tải danh sách mô hình</button> <span id="aiModelsInfo" class="muted" style="font-size:12.5px">${(models[c.provider]||[]).length?(models[c.provider].length+' mô hình. Bấm vào ô trên để chọn.'):''}</span>
    <p class="muted" style="font-size:12.5px">Mặc định ${esc(P.model)}. ${c.provider==='openrouter'?'Với OpenRouter, chọn mô hình có hỗ trợ gọi công cụ (tools), ví dụ dòng Claude, GPT, Gemini. Mô hình "suy luận/thinking" trả lời chậm hơn nhiều (có thể 10 giây trở lên); chọn bản nhanh (flash, haiku, mini) cho việc quản lý hằng ngày. Tên mô hình xem trên openrouter.ai/models.':'Có thể đổi sang mô hình khác của Claude. Bản Haiku trả lời nhanh nhất.'}</p>
    ${c.key?'<button id="aiForget" type="button" class="wide" style="margin-top:6px;color:#a32020;border-color:#e3b4b4">Xóa API key này</button>':''}`;
  };
  openModal(`
    <h2>Cài đặt trợ lý AI</h2>
    <p class="muted" style="font-size:13px">Cài đặt này dùng riêng cho trợ lý, lưu online trong tài khoản chủ quán của bạn nên dùng được trên mọi máy sau khi đăng nhập. Chủ quán và tài khoản hỗ trợ được cấp quyền sử dụng khóa chung; chỉ chủ quán đổi cài đặt. Nhân viên không thấy.</p>
    <div id="aiBody">${body()}</div>
    <div class="modal-foot">
      <button id="aiSave" class="primary wide">Lưu</button>
      <p id="formError" class="error" role="alert" style="margin-top:8px"></p>
    </div>`);
  const next=(p,patch)=>({provider:p,keys:{...(o.keys||{}),...(patch.keys||{})},models:{...(o.models||{}),...(patch.models||{})}});
  const loadModels=async()=>{
    const p=$('aiProvider').value,typed=$('aiKey').value.trim(),key=typed||(o.keys||{})[p]||'';
    if(p==='anthropic'&&!key)return $('formError').textContent='Hãy nhập API key trước để tải danh sách mô hình.';
    $('formError').textContent='';$('aiLoadModels').disabled=true;$('aiModelsInfo').textContent='Đang tải…';
    try{
      models[p]=await listModels({provider:p,apiKey:key});
      const cur=$('aiModel').value,k=$('aiKey').value;c={...c,provider:p,model:cur};$('aiBody').innerHTML=body();$('aiKey').value=k;wire();
    }catch(e){$('aiLoadModels').disabled=false;$('aiModelsInfo').textContent='';$('formError').textContent=e.message}
  };
  const wire=()=>{
    $('aiLoadModels').onclick=loadModels;
    $('aiProvider').onchange=e=>{c=sel(e.target.value);$('aiBody').innerHTML=body();wire();if(c.key||e.target.value==='openrouter')loadModels()};
    $('aiForget')&&($('aiForget').onclick=async()=>{
      const keys={...(o.keys||{})};delete keys[c.provider];
      try{await aiPersist({provider:c.provider,keys,models:o.models||{}});closeModal();notify('Đã xóa API key.');renderAI()}catch(e){$('formError').textContent=e.message}
    });
  };
  wire();if(c.key)loadModels();
  $('aiSave').onclick=async()=>{
    const p=$('aiProvider').value,P=PROVIDERS[p],k=$('aiKey').value.trim(),m=$('aiModel').value.trim()||P.model;
    if(k&&!P.keyRe.test(k))return $('formError').textContent='API key '+P.label+' bắt đầu bằng '+P.keyHint.replace('…','')+'. Hãy kiểm tra lại.';
    if(!/^[\w.:\/-]{3,80}$/.test(m))return $('formError').textContent='Tên mô hình không hợp lệ.';
    $('aiSave').disabled=true;
    try{await aiPersist(next(p,{keys:k?{[p]:k}:{},models:{[p]:m}}));closeModal();notify('Đã lưu cài đặt AI (dùng được trên mọi máy).');renderAI()}
    catch(e){$('aiSave').disabled=false;$('formError').textContent=e.message}
  };
}

/* ---------- Lịch làm nhân viên: the week at a glance; the owner plans, everyone can look ---------- */
const SCHED_COLORS=['#c0392b','#2471a3','#1e8449','#7d3c98','#d68910','#117a65','#a04000','#2c3e50','#cb4335','#5d6d7e'];
const WEEKDAYS=['Chủ nhật','Thứ hai','Thứ ba','Thứ tư','Thứ năm','Thứ sáu','Thứ bảy'];
const dayShift=(day,n)=>{const t=new Date(day+'T00:00:00Z');t.setUTCDate(t.getUTCDate()+n);return t.toISOString().slice(0,10)};
const planDMY=day=>day.split('-').reverse().join('-');
const dm=day=>day.slice(8)+'-'+day.slice(5,7);
const toMin=t=>Number(t.slice(0,2))*60+Number(t.slice(3));
const dur=m=>{m=Math.max(0,Math.round(m));return Math.floor(m/60)+'g'+String(m%60).padStart(2,'0')};
S.sched={from:'',data:null,loading:false,person:'',weeks:{},started:false};
const schedColor=(email)=>{const c=S.sched.data&&S.sched.data.colors&&S.sched.data.colors[email];if(c!==undefined)return SCHED_COLORS[c%SCHED_COLORS.length];let h=0;for(const ch of email)h=(h*31+ch.charCodeAt(0))>>>0;return SCHED_COLORS[h%SCHED_COLORS.length]};
// The week is kept so coming back to the tab (or to a week already seen) shows it at once; fresh data replaces it a moment later.
const schedKey=()=>'sched:'+(S.user?S.user.email:'');
function schedRemember(){try{if(S.sched.data)store.set(schedKey(),JSON.stringify(S.sched.data))}catch(e){}}
async function schedLoad(from,silent){
  const Z=S.sched;
  if(!isViewer())Z.person=S.user.email;      // staff only ever see their own shifts
  const want=from||Z.from||'';
  const kept=Z.weeks&&Z.weeks[want];
  if(kept){Z.data=kept;Z.from=kept.from;if(S.view==='schedule')renderSchedule()}   // a week seen before shows at once
  else if(!silent){Z.loading=true;if(S.view==='schedule'&&Z.data)renderSchedule()}
  try{
    const fresh=await rpc('scheduleWeek',{from:want});
    (Z.weeks=Z.weeks||{})[fresh.from]=fresh;
    if(!silent||fresh.from===Z.from){Z.data=fresh;Z.from=fresh.from}
    Z.error='';schedRemember();
  }catch(e){if(!Z.data)Z.error=e.message;else if(!silent)notify(e.message)}
  Z.loading=false;Z.at=Date.now();if(S.view==='schedule')renderSchedule();
}
function renderSchedule(){
  const Z=S.sched,owner=S.user.role==='owner',viewer=isViewer();
  if(!Z.data&&!Z.started&&!Z.error){
    Z.started=true;
    // last time's week, straight from the phone, while the current one loads
    try{const old=JSON.parse(store.get(schedKey())||'null');if(old&&old.from&&Array.isArray(old.shifts)){Z.data=old;Z.from=old.from;(Z.weeks=Z.weeks||{})[old.from]=old}}catch(e){}
    Z.at=Date.now();schedLoad('',!!Z.data);
  }else if(Z.data&&!Z.loading&&Date.now()-(Z.at||0)>4000){Z.at=Date.now();schedLoad(Z.from,true)}   // opening the tab again: refresh quietly
  const D=Z.data;
  if(!D){
    $('app').innerHTML=`<section class="ai-wrap"><h1>Lịch làm nhân viên</h1><p class="muted">${Z.error?esc(Z.error):'Đang tải lịch…'}</p>${Z.error?'<button id="schedRetry" class="small primary">Thử lại</button>':''}<p class="muted" style="font-size:12px;margin-top:14px">Phiên bản ${esc(typeof __APP_VERSION__==='string'?__APP_VERSION__:'')}</p></section>`;
    $('schedRetry')&&($('schedRetry').onclick=()=>{Z.error='';renderSchedule()});
    return}
  const days=Array.from({length:7},(_,i)=>dayShift(D.from,i));
  // everyone who appears this week (the owner also sees staff without a shift yet, so they can be added)
  const people=new Map();
  D.shifts.forEach(x=>people.set(x.email,x.name));D.clock.forEach(x=>{if(!people.has(x.email))people.set(x.email,x.name)});
  if(viewer)(S.data.users||[]).filter(u=>u.active).forEach(u=>people.set(u.email,u.name||u.email));
  if(!viewer&&!people.has(S.user.email))people.set(S.user.email,S.user.name||S.user.email);
  if(Z.person&&!people.has(Z.person))Z.person='';
  const pick=Z.person,shiftsOf=day=>D.shifts.filter(x=>x.day===day&&(!pick||x.email===pick));
  const clocksOf=day=>D.clock.filter(x=>x.day===day&&(!pick||x.email===pick));
  // one shared time scale for the whole week so days line up
  let lo=6*60,hi=22*60;
  D.shifts.forEach(x=>{lo=Math.min(lo,Math.floor(toMin(x.start)/60)*60);hi=Math.max(hi,Math.ceil(toMin(x.end)/60)*60)});
  D.clock.filter(x=>!pick||x.email===pick).forEach(c=>{const a=toMin(hhmm(c.inAt)),b=c.outAt?toMin(hhmm(c.outAt)):a;lo=Math.min(lo,Math.floor(a/60)*60);hi=Math.max(hi,Math.min(24*60,Math.ceil(b/60)*60))});
  const span=hi-lo,pct=m=>((m-lo)/span*100).toFixed(2);
  const lanes=list=>{const rows=[];list.forEach(x=>{const a=toMin(x.start);let r=rows.findIndex(l=>l[l.length-1]&&toMin(l[l.length-1].end)<=a);if(r<0){rows.push([]);r=rows.length-1}rows[r].push(x)});return rows};
  const ticks=[];for(let h=lo/60;h<=hi/60;h+=(span/60>12?3:2))ticks.push(h);
  const timeline=(day,list,clocks)=>{
    const rows=lanes(list),n=Math.max(1,rows.length);
    const bars=rows.map((row,ri)=>row.map(x=>`<div class="tl-bar" style="left:${pct(toMin(x.start))}%;width:${(toMin(x.end)-toMin(x.start))/span*100}%;top:${ri*26}px;background:${schedColor(x.email)}" title="${esc(x.name)} ${x.start}–${x.end}">${esc(x.name)}</div>`).join('')).join('');
    // actual clock-in/out, laid out in rows like the planned shifts so several people never hide each other
    const nowM=toMin(hhmm(new Date().toISOString()));
    // true to the clock: the bar runs from the real clock-in to the real clock-out (or to now while still working)
    const items=clocks.map(c=>{const a=toMin(hhmm(c.inAt)),e=c.outAt?toMin(hhmm(c.outAt)):(day===D.today?Math.max(a,toMin(hhmm(new Date().toISOString()))):a);
      const f=m=>String(Math.floor(m/60)).padStart(2,'0')+':'+String(Math.round(m%60)).padStart(2,'0');
      return {...c,start:f(a),end:f(e)}});
    // rows are decided by the real span plus a small margin, so two people who are close in time do not sit on top of each other
    const crows=lanes(items.map(x=>({...x,end:String(Math.floor(Math.min(24*60-1,toMin(x.end)+Math.round(span*0.12))/60)).padStart(2,'0')+':'+String(Math.min(24*60-1,toMin(x.end)+Math.round(span*0.12))%60).padStart(2,'0')})));
    const act=crows.map((row,ri)=>row.map(c=>{const it=items.find(i=>i.inAt===c.inAt&&i.email===c.email),a=toMin(it.start),e=toMin(it.end);return `<div class="tl-bar actual" style="left:${pct(a)}%;width:${((e-a)/span*100).toFixed(2)}%;top:${n*26+8+ri*26}px;border-color:${schedColor(c.email)};color:${schedColor(c.email)}" title="${esc(c.name)} chấm công ${hhmm(c.inAt)}–${c.outAt?hhmm(c.outAt):'đang làm'}">${esc(c.name)}${c.outAt?'':' ●'}</div>`}).join('')).join('');
    void nowM;
    const h=n*26+(clocks.length?8+crows.length*26:0);
    return `<div class="tl" style="height:${Math.max(h,26)}px">${ticks.map(t=>`<span class="tl-tick" style="left:${pct(t*60)}%"></span>`).join('')}${bars}${act}</div>`;
  };
  const compare=(day,list,clocks)=>{
    if(!pick||(!list.length&&!clocks.length))return '';
    const planned=list.reduce((n,x)=>n+toMin(x.end)-toMin(x.start),0);
    const worked=clocks.reduce((n,c)=>n+c.minutes,0);
    const notes=[];
    if(list.length&&clocks.length){
      const ps=Math.min(...list.map(x=>toMin(x.start))),pe=Math.max(...list.map(x=>toMin(x.end)));
      const cs=toMin(hhmm(clocks[0].inAt)),last=clocks[clocks.length-1],ce=last.outAt?toMin(hhmm(last.outAt)):null;
      const dIn=cs-ps;notes.push(dIn>5?`<span class="late">vào trễ ${dur(dIn)}</span>`:dIn<-5?`vào sớm ${dur(-dIn)}`:'vào đúng giờ');
      if(ce!==null){const dOut=ce-pe;notes.push(dOut<-5?`<span class="late">tan sớm ${dur(-dOut)}</span>`:dOut>5?`tan muộn ${dur(dOut)}`:'tan đúng giờ')}
    }else if(list.length&&!clocks.length&&day<=D.today){notes.push('<span class="late">không có chấm công</span>')}
    else if(!list.length&&clocks.length)notes.push('làm ngoài lịch');
    return `<div class="sched-cmp"><div>Lịch: <strong>${planned?dur(planned):'—'}</strong> · Thực tế: <strong>${clocks.length?dur(worked):'—'}</strong></div>
      ${clocks.map(c=>`<div class="muted">Chấm công vào ${hhmm(c.inAt)} → ${c.outAt?'tan ca '+hhmm(c.outAt):'<strong>đang làm</strong>'} (${dur(c.minutes)})</div>`).join('')}
      ${notes.length?`<div class="muted">${notes.join(' · ')}</div>`:''}</div>`;
  };
  const weekPlanned=pick?D.shifts.filter(x=>x.email===pick).reduce((n,x)=>n+toMin(x.end)-toMin(x.start),0):0;
  const weekWorked=pick?D.clock.filter(c=>c.email===pick).reduce((n,c)=>n+c.minutes,0):0;
  $('app').innerHTML=`
    <section class="ai-wrap sched">
      <div class="row">
        <div><div class="eyebrow">NHÂN VIÊN</div><h1 style="margin:2px 0 0">Lịch làm</h1></div>
        ${owner?`<div class="row" style="gap:6px"><button id="schedAdd" class="small primary">+ Thêm ca</button></div>`:''}
      </div>
      <div class="row" style="margin:10px 0;gap:6px">
        <button id="schedPrev" class="small">‹ Tuần trước</button>
        <button id="schedNow" class="small soft">Tuần này</button>
        <button id="schedNext" class="small">Tuần sau ›</button>
      </div>
      <div class="muted" style="margin-bottom:8px">${planDMY(D.from)} → ${planDMY(D.to)}${owner?' · <button id="schedCopy" class="small" style="margin-left:6px">Sao chép từ tuần trước</button>':''}</div>
      ${owner?`<div class="sched-people">
        <button class="chip ${pick?'':'on'}" data-person="">Tất cả</button>
        ${[...people].map(([em,nm])=>`<button class="chip ${pick===em?'on':''}" data-person="${esc(em)}" style="--c:${schedColor(em)}"><i style="background:${schedColor(em)}"></i>${esc(nm)}</button>`).join('')}
      </div>`:''}
      ${pick?`<div class="card" style="margin:10px 0"><strong>${esc(people.get(pick))}</strong> · tuần này: lịch <strong>${dur(weekPlanned)}</strong> · thực tế chấm công <strong>${dur(weekWorked)}</strong>${weekWorked-weekPlanned>5?` <span class="muted">(+${dur(weekWorked-weekPlanned)})</span>`:weekPlanned-weekWorked>5?` <span class="muted">(−${dur(weekPlanned-weekWorked)})</span>`:''}</div>`:''}
      ${Z.loading?'<p class="muted">Đang cập nhật…</p>':''}${Z.error?`<div class="notice">${esc(Z.error)}</div>`:''}
      <div class="sched-days">
        ${days.map(day=>{const list=shiftsOf(day),clocks=clocksOf(day),wd=WEEKDAYS[new Date(day+'T00:00:00Z').getUTCDay()];
          return `<article class="card sched-day ${day===D.today?'today':''}">
            <div class="row"><strong>${wd} <span class="muted">${dm(day)}</span>${day===D.today?' <span class="badge ready">Hôm nay</span>':''}</strong>${owner?`<button class="small" data-addday="${day}">+ Ca</button>`:''}</div>
            ${list.length||clocks.length?timeline(day,list,clocks):'<div class="muted" style="font-size:13px;margin:6px 0">Chưa có ca</div>'}
            ${list.length?`<div class="sched-list">${list.map(x=>`<${owner?'button':'div'} class="sched-chip" ${owner?`data-edit="${x.id}"`:''} style="border-left-color:${schedColor(x.email)}"><strong>${x.start}–${x.end}</strong> ${esc(x.name)}${x.note?` <span class="muted">· ${esc(x.note)}</span>`:''}</${owner?'button':'div'}>`).join('')}</div>`:''}
            ${list.length>1&&new Set(list.map(x=>x.email)).size>1&&list.some((x,i)=>list.some((y,j)=>i<j&&x.email!==y.email&&toMin(x.start)<toMin(y.end)&&toMin(y.start)<toMin(x.end)))?'<div class="muted" style="font-size:12px;margin-top:4px">👥 Có giờ 2 người làm cùng ca</div>':''}
            ${!pick&&clocks.length?`<div class="sched-cmp">${clocks.map(c=>`<div class="muted"><span class="dot" style="background:${schedColor(c.email)}"></span> ${esc(c.name)}: vào ${hhmm(c.inAt)} → ${c.outAt?'tan ca '+hhmm(c.outAt):'<strong>đang làm</strong>'} (${dur(c.minutes)})${D.shifts.some(x=>x.email===c.email&&x.day===day)?'':' <span class="badge waiting" style="font-size:11px;padding:1px 7px">ngoài lịch</span>'}</div>`).join('')}</div>`:''}
            ${compare(day,list,clocks)}
          </article>`}).join('')}
      </div>
      <p class="muted" style="font-size:12px">Phiên bản ${esc(typeof __APP_VERSION__==='string'?__APP_VERSION__:'')}</p>
      <p class="muted" style="font-size:12.5px">Thanh màu đặc là lịch làm. Thanh viền sọc là giờ chấm công thực tế (vào ca đến tan ca; ● là đang làm).${owner&&!pick?' Chọn một nhân viên để xem chi tiết lệch giờ.':''}</p>
    </section>`;
  $('schedPrev').onclick=()=>schedLoad(dayShift(D.from,-7));
  $('schedNext').onclick=()=>schedLoad(dayShift(D.from,7));
  $('schedNow').onclick=()=>schedLoad(dayShift(D.today,-((new Date(D.today+'T00:00:00Z').getUTCDay()+6)%7)));   // the Monday of today's week (an empty date would mean "stay on the week being shown")
  $('app').querySelectorAll('[data-person]').forEach(b=>b.onclick=()=>{Z.person=b.dataset.person;Z.pickedAll=!b.dataset.person;renderSchedule()});
  if(owner){
    $('schedAdd').onclick=()=>planShiftModal(null,null);
    $('app').querySelectorAll('[data-addday]').forEach(b=>b.onclick=()=>planShiftModal(null,b.dataset.addday));
    $('app').querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>planShiftModal(D.shifts.find(x=>x.id===b.dataset.edit),null));
    $('schedCopy').onclick=async()=>{
      try{const r=await rpc('copyWeek',{from:D.from});notify(r.copied?'Đã sao chép '+r.copied+' ca từ tuần trước.':'Không có ca nào để sao chép (tuần trước trống hoặc đã có đủ).');await schedLoad(D.from)}
      catch(e){notify(e.message)}
    };
  }
}
function planShiftModal(x,day){
  const D=S.sched.data,users=(S.data.users||[]).filter(u=>u.active);
  const week=Array.from({length:7},(_,i)=>dayShift(D.from,i));
  const pre=x?x.day:(day||D.today>=D.from&&D.today<=D.to?D.today:D.from);
  openModal(`
    <h2>${x?'Sửa ca làm':'Thêm ca làm'}</h2>
    <label for="shEmail">Nhân viên</label>
    <select id="shEmail">${users.map(u=>`<option value="${esc(u.email)}" ${x&&x.email===u.email||(!x&&S.sched.person===u.email)?'selected':''}>${esc(u.name||u.email)}${u.role==='owner'?' (chủ quán)':''}</option>`).join('')}</select>
    ${x?`<label for="shDay">Ngày</label><input id="shDay" type="date" value="${x.day}">`:`
    <label>Ngày làm (chọn nhiều ngày nếu giống nhau)</label>
    <div class="sched-days-pick">${week.map(d=>`<label class="check"><input type="checkbox" data-d="${d}" ${d===pre?'checked':''}> ${WEEKDAYS[new Date(d+'T00:00:00Z').getUTCDay()]} ${dm(d)}</label>`).join('')}</div>`}
    <div class="two" style="margin-top:8px">
      <div><label for="shStart">Từ giờ</label><input id="shStart" type="time" value="${x?x.start:'07:00'}"></div>
      <div><label for="shEnd">Đến giờ</label><input id="shEnd" type="time" value="${x?x.end:'12:00'}"></div>
    </div>
    <div class="row wrap" style="justify-content:flex-start;gap:6px;margin-top:8px">
      <button type="button" class="small" data-preset="07:00-12:00">Sáng 7–12</button>
      <button type="button" class="small" data-preset="12:00-17:00">Chiều 12–17</button>
      <button type="button" class="small" data-preset="17:00-22:00">Tối 17–22</button>
    </div>
    <label for="shNote">Ghi chú (không bắt buộc)</label>
    <input id="shNote" maxlength="60" value="${esc(x?x.note:'')}" placeholder="Ví dụ: phụ bar, mở cửa…">
    <p class="muted" style="font-size:12.5px;margin-top:6px">Hai nhân viên khác nhau có thể làm cùng giờ. Một người không thể có hai ca trùng giờ.</p>
    <div class="modal-foot">
      <button id="shSave" class="primary wide">${x?'Lưu thay đổi':'Thêm ca'}</button>
      <p id="formError" class="error" role="alert" style="margin-top:8px"></p>
    </div>`);
  document.querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>{const [a,c]=b.dataset.preset.split('-');$('shStart').value=a;$('shEnd').value=c});
  if(x)addDeleteButton('deleteShift',{id:x.id},'ca làm','Ca này sẽ bị xóa khỏi lịch. Lịch sử chấm công không bị ảnh hưởng.');
  $('shSave').onclick=async()=>{
    const data={email:$('shEmail').value,start:$('shStart').value,end:$('shEnd').value,note:$('shNote').value};
    if(x){data.id=x.id;data.day=$('shDay').value}
    else{data.days=[...document.querySelectorAll('[data-d]:checked')].map(c=>c.dataset.d);if(!data.days.length)return $('formError').textContent='Hãy chọn ít nhất một ngày.'}
    $('shSave').disabled=true;
    try{await rpc('saveShift',data);closeModal();notify(x?'Đã lưu ca làm.':'Đã thêm '+data.days.length+' ca làm.');await schedLoad(D.from)}
    catch(e){$('shSave').disabled=false;$('formError').textContent=e.message}
  };
}

/* Staff page: clock in/out, the cash shift (open / close), today's plan and hours. The owner keeps the shift button on the Sales page. */
function renderClock(){
  const C=S.data.clock||{},c=C.mine,sh=S.data.shift,m=S.data.mine,plan=C.plan||[];
  const since=c?Math.max(0,Math.round((Date.now()-Date.parse(c.inAt))/1000)):0;
  const clockText=s=>String(Math.floor(s/3600)).padStart(2,'0')+':'+String(Math.floor(s%3600/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
  const late=c&&plan.length?(()=>{const d=toMin(hhmm(c.inAt))-toMin(plan[0].start);return d>5?`vào trễ ${dur(d)}`:d<-5?`vào sớm ${dur(-d)}`:'vào đúng giờ'})():'';
  $('app').innerHTML=`<section class="ai-wrap clockpage">
    <div class="eyebrow">NHÂN VIÊN</div><h1 style="margin:2px 0 12px">Chấm công</h1>
    <div class="card" style="text-align:center;${c?'background:var(--mint-subtle)':''}">
      <div class="muted">${c?'Đang làm · vào ca '+hhmm(c.inAt):'Chưa chấm công vào ca'}</div>
      <div id="clockTimer" style="font-size:34px;font-weight:600;margin:4px 0">${c?clockText(since):'--:--:--'}</div>
      ${late?`<div class="muted">${late}</div>`:''}
      <button id="clockBtn" class="wide ${c?'danger':'primary'}" style="margin-top:10px;min-height:52px;font-size:16px">${c?'Tan ca':'Vào ca'}</button>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="row"><strong>Ca tiền mặt</strong><span class="badge ${sh?'ready':''}">${sh?'Đang mở':'Chưa mở'}</span></div>
      ${sh?`<table style="width:100%;margin-top:8px;font-size:14px"><tr><td class="muted">Tiền đầu ca</td><td style="text-align:right">${money(sh.openingCash)}</td></tr><tr><td class="muted">Mở lúc</td><td style="text-align:right">${hhmm(sh.openedAt)}</td></tr><tr><td><strong>Dự kiến trong két</strong></td><td style="text-align:right"><strong>${money(sh.expectedCash)}</strong></td></tr></table>`
        :'<p class="muted" style="margin:6px 0 0">Mở ca để quản lý tiền két và kiểm kê tiền mặt cuối ca.</p>'}
      <button id="shiftBtn" class="wide ${sh?'soft':'primary'}" style="margin-top:10px">${sh?'Chốt ca tiền mặt':'Mở ca'}</button>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="muted">Lịch hôm nay</div>
      <div style="font-size:15px;margin-top:2px"><strong>${plan.length?plan.map(x=>x.start+' – '+x.end).join(' · '):'Không có ca trong lịch'}</strong></div>
      <div class="row" style="margin-top:10px;gap:10px"><div style="flex:1"><div class="muted">Hôm nay</div><strong style="font-size:20px">${dur(C.todayMinutes||0)}</strong></div><div style="flex:1"><div class="muted">Tuần này</div><strong style="font-size:20px">${dur(C.weekMinutes||0)}</strong></div></div>
      ${m?`<p class="muted" style="margin:8px 0 0">Hôm nay bạn bán <strong>${m.orders}</strong> đơn / <strong>${m.cups}</strong> ly</p>`:''}
    </div>
    <div class="card" style="margin-top:12px">
      <div class="muted" style="margin-bottom:4px">Lịch sử chấm công</div>
      ${(C.recent||[]).length?C.recent.map(x=>`<div class="row" style="padding:8px 0;border-top:1px solid var(--line)"><span>${dm(x.day)}<br><span class="muted" style="font-size:12.5px">${hhmm(x.inAt)} → ${hhmm(x.outAt)}</span></span><strong>${dur(x.minutes)}</strong></div>`).join(''):'<p class="muted" style="margin:6px 0 0">Chưa có ca nào.</p>'}
    </div>
    ${appDownloads()}
  </section>`;
  $('shiftBtn').onclick=shiftModal;
  $('clockBtn').onclick=async()=>{
    if(S.busy)return;S.busy=true;$('clockBtn').disabled=true;const was=!!S.data.clock.mine;
    try{await rpc(was?'clockOut':'clockIn',{});S.busy=false;await refresh(false);render();notify(was?'Đã tan ca. Cảm ơn bạn!':'Đã chấm công vào ca.')}
    catch(e){S.busy=false;if(!S.user)return;$('clockBtn').disabled=false;notify(e.message)}
  };
  clearInterval(S.clockTick);
  if(c)S.clockTick=setInterval(()=>{const el=$('clockTimer');if(!el||S.view!=='clock'){clearInterval(S.clockTick);return}el.textContent=clockText(Math.max(0,Math.round((Date.now()-Date.parse(c.inAt))/1000)))},1000);
}

function shiftBar(){
  if(S.user.role!=='owner')return '';const sh=S.data.shift;
  return sh?`<div class="notice row" style="background:var(--mint-subtle);border-color:#e4cfbd;color:var(--green-dark)"><span>🟢 <strong>Ca đang mở</strong> từ ${new Date(sh.openedAt).toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit',timeZone:S.data.timezone})} · Tiền mặt dự kiến: <strong style="color:var(--green)">${money(sh.expectedCash)}</strong></span><button id="shiftBtn" class="small soft">Chốt ca</button></div>`:`<div class="notice row"><span>Chưa mở ca làm việc. Mở ca để quản lý tiền két và kiểm kê tiền mặt cuối ca.</span><button id="shiftBtn" class="small primary">Mở ca ngay</button></div>`;
}

function shiftModal(){
  const sh=S.data.shift;
  openModal(sh?`<h2>Chốt ca làm việc</h2><p class="muted" style="margin-top:4px">Tiền đầu ca ${money(sh.openingCash)} · Tiền mặt dự kiến trong két: <strong>${money(sh.expectedCash)}</strong></p><label for="cashCount">Tiền mặt thực tế đếm được trong két (đ)</label><input id="cashCount" type="number" min="0" inputmode="numeric" placeholder="Ví dụ: 1250000"><label for="shiftNote">Ghi chú bàn giao</label><input id="shiftNote" maxlength="120" placeholder="Thiếu tiền thừa, bù tiền lẻ…"><div class="modal-foot"><button id="saveShift" class="primary wide">Xác nhận chốt ca</button><p id="formError" class="error" role="alert" style="margin-top:8px"></p></div>`:`<h2>Mở ca làm mới</h2><p class="muted" style="margin-top:4px">Nhập số tiền mặt có sẵn trong két để đối soát khi hết ca.</p><label for="cashCount">Tiền mặt đầu ca trong két (đ)</label><input id="cashCount" type="number" min="0" inputmode="numeric" value="0"><div class="modal-foot"><button id="saveShift" class="primary wide">Mở ca làm việc</button><p id="formError" class="error" role="alert" style="margin-top:8px"></p></div>`);
  $('saveShift').onclick=async()=>{
    const n=Number($('cashCount').value);if($('cashCount').value===''||!(n>=0))return $('formError').textContent='Nhập số tiền hợp lệ.';
    S.busy=true;$('saveShift').disabled=true;
    try{const r=await rpc(sh?'closeShift':'openShift',sh?{closingCash:n,note:$('shiftNote').value}:{openingCash:n});S.busy=false;closeModal();await refresh(false);render();
      notify(sh?(r.difference===0?'Đã chốt ca · Khớp tiền tuyệt đối!':'Đã chốt ca · '+(r.difference>0?'Dư ':'Thiếu ')+money(Math.abs(r.difference))):'Đã mở ca làm thành công!')}
    catch(e){S.busy=false;if(!S.user)return;$('saveShift').disabled=false;$('formError').textContent=e.message}
  };
}

function openModal(html){
  $('modal').className='modal-back';
  $('modal').innerHTML=`<section class="modal" role="dialog" aria-modal="true" aria-label="Chi tiết"><div class="row" style="margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid var(--line-subtle)"><span class="eyebrow">Tiemvio POS · COFFEE & TEA POS</span><button id="closeModal" class="small" aria-label="Đóng" style="padding:6px 10px;min-height:32px;border-radius:8px">✕</button></div>${html}</section>`;
  $('closeModal').onclick=closeModal;
  $('modal').querySelector('input,select,button')?.focus();
}

function closeModal(){
  if(S.busy)return;
  $('modal').className='hidden';
  $('modal').innerHTML='';
}

function productModal(id,index=-1){
  const m=S.data.menu.find(m=>m.id===id);if(!m)return;
  const old=index>=0?S.cart[index]:{size:sizeKeys(m).includes('M')?'M':sizeKeys(m)[0],sugarId:(sugarList()[0]||{}).id,ice:(iceList()[0]||{}).id,quantity:1,toppings:[],note:''};
  const toppings=S.data.menu.filter(m=>m.kind==='topping'&&m.active===true);
  openModal(`
    <h2>${esc(m.name)}</h2>
    <div class="two">
      <div>
        <label for="size">Kích cỡ (Size)</label>
        ${sizeKeys(m).length===1?`<div class="muted" style="padding:12px 0">${m.kind==='food'?'Phần'+(m.note?' ('+esc(m.note)+')':''):'Một cỡ ly'} · ${money(sizesOf(m)[sizeKeys(m)[0]])}</div><select id="size" class="hidden"><option value="${sizeKeys(m)[0]}">${sizeKeys(m)[0]}</option></select>`:`<select id="size">
          ${sizeKeys(m).map(z=>`<option value="${z}">Size ${z} · ${money(sizesOf(m)[z])}</option>`).join('')}
        </select>`}
      </div>
      <div>
        <label for="quantity">${m.byWeight?'Số '+esc(unitName(m))+' (bán nguyên '+esc(unitName(m))+')':(m.packQty||1)>1?'Số '+esc(unitName(m)):'Số lượng'}</label>
        <input id="quantity" type="number" min="1" max="${(m.packQty||1)>1?200:200}" step="1" value="${old.quantity}" inputmode="numeric">
      </div>
    </div>
    ${m.byWeight||(m.packQty||1)>1?`<div class="row wrap" id="qtyQuick" style="justify-content:flex-start;gap:8px;margin:14px 0 14px">${(m.byWeight?[1,2,3,4,5]:[1,2,3,4,6].map(k=>k*m.packQty)).map(v=>`<button type="button" class="small" data-q="${v}">${String(v).replace('.',',')} ${esc(unitName(m))}</button>`).join('')}<span class="muted" style="font-size:12.5px">Giá ${money(lowestPrice(m))} / ${(m.packQty||1)>1?m.packQty+' ':''}${esc(unitName(m))}</span></div>`:''}
    <div class="two ${m.kind==='food'?'hidden':''}">
      <div>
        <label for="sugar">Lượng đường</label>
        <select id="sugar">
          ${sugarList().map(o=>`<option value="${esc(o.id)}">${esc(o.name)}${extra(o.price)}</option>`).join('')}
        </select>
      </div>
      <div>
        <label for="ice">Lượng đá</label>
        <select id="ice">
          ${iceList().map(o=>`<option value="${esc(o.id)}">${esc(o.name)}${extra(o.price)}</option>`).join('')}
        </select>
      </div>
    </div>
    ${m.allowHot?`<label for="temp">Nhiệt độ</label><select id="temp"><option value="cold">Lạnh</option><option value="hot">Nóng (không đá)</option></select>`:''}
    <label class="${m.kind==='food'?'hidden':''}" style="margin-top:16px">Thêm topping</label>
    <div class="${m.kind==='food'?'hidden':''}" style="background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:8px 12px;margin-bottom:12px">
      ${toppings.map(t=>`
        <label class="check" style="border-bottom:1px solid var(--line-subtle);padding:8px 0">
          <input type="checkbox" data-top="${esc(t.id)}" ${old.toppings.includes(t.id)?'checked':''}>
          <span class="grow">${esc(t.name)}</span>
          <span class="price" style="font-size:13.5px">+${money(t.priceM)}</span>
        </label>
      `).join('')||'<p class="muted" style="padding:4px 0">Không có topping khả dụng.</p>'}
    </div>
    <label for="note">Ghi chú cho món</label>
    <input id="note" maxlength="120" value="${esc(old.note)}" placeholder="Ví dụ: Để riêng trân châu, ít ngọt hơn…">
    <div class="modal-foot">
      <button id="addItem" class="primary wide" style="padding:13px;font-size:15px">Thêm vào đơn</button>
    </div>
  `);

  $('size').value=sizeKeys(m).includes(old.size)?old.size:sizeKeys(m)[0];{const sg=sugarList().find(o=>o.id===old.sugarId)||sugarList().find(o=>o.percent===old.sugar)||sugarList()[0];$('sugar').value=sg?sg.id:'';const ic=iceList().find(o=>o.id===old.ice)||iceList()[0];$('ice').value=ic?ic.id:''}
  if($('temp')){$('temp').value=old.temp||'cold';const syncTemp=()=>{const hot=$('temp').value==='hot';$('ice').disabled=hot;if(hot){const none=iceList().find(o=>o.id==='none'||/không đá/i.test(o.name));if(none)$('ice').value=none.id}update()};$('temp').addEventListener('change',syncTemp);syncTemp()}
  const sugarPick=()=>sugarList().find(o=>o.id===$('sugar').value)||{},icePick=()=>$('temp')&&$('temp').value==='hot'?{price:0}:(iceList().find(o=>o.id===$('ice').value)||{});
  const calculate=()=>Number(sizesOf(m)[$('size').value])+(m.kind==='food'?0:(Number(sugarPick().price)||0)+(Number(icePick().price)||0))+Array.from($('modal').querySelectorAll('[data-top]:checked')).reduce((n,e)=>n+Number(toppings.find(t=>t.id===e.dataset.top).priceM),0);
  const qtyNow=()=>Number(String($('quantity').value||'').replace(',','.'));
  const update=()=>$('addItem').textContent=(index>=0?'Lưu thay đổi':'Thêm vào đơn')+' · '+money(Math.round(calculate()*(qtyNow()||1)/(m.packQty||1)));
  $('modal').querySelectorAll('[data-q]').forEach(b=>b.onclick=()=>{$('quantity').value=b.dataset.q;update()});$('quantity').addEventListener('input',update);
  $('modal').querySelectorAll('input,select').forEach(e=>e.addEventListener('change',update));update();
  $('addItem').onclick=()=>{
    const quantity=qtyNow();
    if(m.byWeight){if(!Number.isInteger(quantity)||quantity<1||quantity>200)return notify('Chỉ bán nguyên '+unitName(m)+': nhập 1, 2, 3, 4…')}
    else if((m.packQty||1)>1){if(!Number.isInteger(quantity)||quantity<1||quantity>200)return notify('Số '+unitName(m)+' từ 1 đến 200.')}
    else if(!Number.isInteger(quantity)||quantity<1||quantity>200)return notify('Số lượng từ 1 đến 200.');
    const item={productId:id,kind:m.kind,name:m.name,size:$('size').value,sugar:(sugarPick().percent!==undefined?sugarPick().percent:100),sugarId:$('sugar').value,sugarName:sugarPick().name||'',sugarPrice:Number(sugarPick().price)||0,ice:$('ice').value,iceName:icePick().name||'',icePrice:Number(icePick().price)||0,temp:$('temp')?$('temp').value:'cold',quantity,unitName:unitName(m),packQty:m.packQty||1,byWeight:!!m.byWeight,
      toppings:Array.from($('modal').querySelectorAll('[data-top]:checked')).map(e=>e.dataset.top),note:$('note').value,unitPrice:calculate()};
    if(index>=0)S.cart[index]=item;else S.cart.push(item);persistCart();closeModal();render();
  };
}

function itemText(i){if(i.kind==='food')return sizeTag(i);return `${sizeTag(i)?sizeTag(i)+' · ':''}${sugarText(i,true)} · ${tempText(i,true)}`}

function cartModal(){
  const p=S.pending,E=S.editing;
  openModal(`
    <h2>${E?'Sửa đơn '+esc(E.seq):p?'Đơn chờ máy chủ xác nhận':'Kiểm tra & Thanh toán'}</h2>
    ${E?'<div class="notice">Sửa được món, số lượng, khách, kênh bán, khuyến mãi và giảm giá. Số điện thoại và điểm đã đổi giữ nguyên. Kho tự cộng/trừ phần chênh lệch.</div>':''}
    ${E?`<details class="card" style="margin-top:12px"><summary>Lịch sử chỉnh sửa (${(E.editHistory||[]).length})</summary>${(E.editHistory||[]).length?(E.editHistory||[]).slice().reverse().map(h=>`<div style="padding:8px 0;border-top:1px solid var(--line-subtle);margin-top:6px"><strong>${esc(h.name||h.by||'Không rõ người sửa')}</strong><div class="muted">${h.at?esc(fmtDateTime(h.at)):''}</div><div style="font-size:13px">${esc(h.detail)}</div></div>`).join(''):'<p class="muted" style="margin-top:6px">Đơn chưa có lần chỉnh sửa nào.</p>'}</details>`:''}
    ${p?'<div class="notice">⚠️ Đơn hàng đã được lưu cục bộ và đang chờ máy chủ ghi nhận. Bấm "Gửi lại đơn" bên dưới để hoàn tất.</div>':''}
    <div style="margin:14px 0">
      ${S.cart.map((i,n)=>`
        <div class="order-line">
          <div class="row">
            <strong>${qtyLabel(i)} × ${esc(i.name)}</strong>
            <span class="tabular" style="font-weight:700;color:var(--green)">${money(lineOf(i))}</span>
          </div>
          <div class="muted" style="margin-top:2px">${itemText(i)}${i.note?' · <span style="color:var(--orange)">'+esc(i.note)+'</span>':''}</div>
          ${!p?`
            <div style="margin-top:6px;display:flex;gap:6px">
              <button class="small" data-edit="${n}">Sửa</button>
              <button class="small danger" data-remove="${n}">Bỏ món</button>
            </div>
          `:''}
        </div>
      `).join('')||'<p class="empty">Giỏ hàng đang trống.</p>'}
    </div>

    <div class="two">
      <div>
        <label for="service">Hình thức phục vụ</label>
        <select id="service" ${p?'disabled':''}>
          <option value="takeaway">Mang đi</option>
          <option value="dinein">Tại quán</option>
        </select>
      </div>
      <div>
        <label for="customer">Khách / Số bàn</label>
        <input id="customer" maxlength="60" placeholder="Bàn 1, Khách áo đen…" ${p?'disabled':''}>
      </div>
    </div>

    <div class="two">
      <div>
        <label for="channel">Kênh bán</label>
        <select id="channel" ${p?'disabled':''}>${S.data.channels.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select>
      </div>
      <div>
        <label for="promo">Khuyến mãi</label>
        <select id="promo" ${p?'disabled':''}>
          <option value="">Không áp dụng</option>
          ${S.data.promos.filter(x=>x.validNow).map(x=>`<option value="${esc(x.id)}">${esc(x.name)} (${x.type==='percent'?x.value+'%':money(x.value)}${x.minTotal?' · từ '+money(x.minTotal):''})</option>`).join('')}
        </select>
      </div>
    </div>
    <p id="promoInfo" class="muted" style="margin-top:4px"></p>

    <label for="phone">Số điện thoại (tích điểm khách hàng)</label>
    <div class="row">
      <input id="phone" inputmode="tel" maxlength="14" placeholder="Nhập số điện thoại khách…" ${p||E?'disabled':''}>
      <button id="lookupPhone" class="small soft ${E?'hidden':''}" ${p?'disabled':''}>Tra điểm</button>
    </div>
    <p id="pointsInfo" class="muted" style="margin-top:4px"></p>
    <p class="muted ${E?'hidden':''}" style="font-size:12px;margin-top:2px">Chỉ nhập số điện thoại khi khách đồng ý để quán lưu và tích điểm.</p>
    <div id="redeemBox"></div>

    <label for="discountReason" style="margin-top:10px">Giảm giá</label>
    <select id="discountReason" ${p?'disabled':''}>
      <option value="">Không</option>
      ${(S.data.discountReasons||[]).map(r=>`<option value="${esc(r)}">${esc(r)}</option>`).join('')}
      <option value="__other">Khác…</option>
    </select>
    <input id="discountOther" class="hidden" maxlength="80" placeholder="Nhập lý do giảm giá (ít nhất 3 ký tự)" style="margin-top:8px" ${p?'disabled':''}>
    <div class="two" style="margin-top:8px;align-items:end">
      <div>
        <label for="manualDiscount">Số tiền giảm (đ)</label>
        <input id="manualDiscount" type="number" min="0" step="1000" inputmode="numeric" value="0" placeholder="Tối đa 30%" disabled>
      </div>
    </div>

    <div class="${E?'hidden':''}">
    <p class="muted" style="font-size:12.5px;margin-top:10px">Thu tiền và chọn phương thức thanh toán (tiền mặt, chuyển khoản hoặc chia) ở mục <strong>Đơn hàng</strong> sau khi tạo đơn.</p>
    </div>

    <div class="row card" style="margin:18px 0;background:var(--mint-subtle);border-color:#e4cfbd">
      <div>
        <span class="eyebrow">TỔNG THANH TOÁN</span>
        <div style="font-size:13px;color:var(--muted)">Đã tính giảm giá và điểm</div>
      </div>
      <strong id="cartTotal" style="font-size:24px;color:var(--green)" class="tabular">${money(cartTotal())}</strong>
    </div>


    <div class="modal-foot">
      <button id="sendOrder" class="primary wide" style="padding:14px;font-size:15px" ${!S.cart.length?'disabled':''}>
        ${E?'Lưu thay đổi':p?'Kiểm tra & gửi lại đơn':'Xác nhận tạo đơn'}
      </button>
      <p id="sendError" class="error" role="alert" style="margin-top:8px;text-align:center"></p>
    </div>
  `);

  const src=p||E;
  if(E){$('phone').value=E.phone||'';if(E.redeemed)$('pointsInfo').textContent='Đã đổi '+E.redeemed+' điểm khi tạo đơn (giữ nguyên).'}
  if(src){const p=src;$('channel').value=p.channel||'store';$('promo').value=p.promoId||'';$('service').value=p.service;$('customer').value=p.customer;$('phone').value=p.phone||'';{const dr=p.discountReason||'';if(dr.startsWith('Khác: ')){$('discountReason').value='__other';$('discountOther').value=dr.slice(6);$('discountOther').classList.remove('hidden')}else{if(dr&&![...$('discountReason').options].some(o=>o.value===dr))$('discountReason').add(new Option(dr,dr));$('discountReason').value=dr}}$('manualDiscount').value=p.manualDiscount||0;if(E&&E.discountReason)$('manualDiscount').disabled=false}
  const L=S.data.loyalty;let cust=null;
  const maxRedeem=()=>cust?Math.min(cust.points,Math.floor(cartTotal()*L.maxRedeemShare/L.pointValue)):0;
  const redeemValue=()=>p?(p.redeem||0):E?E.redeemed:Math.max(0,Math.min(Math.floor(Number($('redeem')?.value||0)),maxRedeem()));
  const manualValue=()=>p?(p.manualDiscount||0):($('discountReason').value?Math.max(0,Math.floor(Number($('manualDiscount').value||0))):0);
  const promoOf=()=>S.data.promos.find(x=>x.id===(p?p.promoId:$('promo').value)&&x.validNow)||null;
  const promoValue=()=>{const pr=promoOf();if(!pr||cartTotal()<(pr.minTotal||0))return 0;return pr.type==='percent'?Math.floor(cartTotal()*pr.value/100):Math.min(pr.value,cartTotal())};
  const recalc=()=>{
    const pr=promoOf();$('promoInfo').textContent=pr?(cartTotal()<(pr.minTotal||0)?'Chưa đủ ĐK: đơn tối thiểu '+money(pr.minTotal)+' để áp dụng.':'Giảm '+money(promoValue())+' ('+pr.name+')'):'';
    const total=Math.max(0,cartTotal()-promoValue()-redeemValue()*L.pointValue-manualValue());
    $('cartTotal').textContent=money(total);
  };

  $('promo').addEventListener('change',recalc);$('manualDiscount').addEventListener('input',recalc);$('discountReason').addEventListener('change',()=>{const on=!!$('discountReason').value;$('discountOther').classList.toggle('hidden',$('discountReason').value!=='__other');$('manualDiscount').disabled=!on;if(!on)$('manualDiscount').value=0;else $('manualDiscount').focus();recalc()});recalc();
  $('lookupPhone').onclick=async()=>{
    $('pointsInfo').textContent='Đang tra cứu dữ liệu tích điểm…';
    try{cust=await rpc('lookupCustomer',{phone:$('phone').value.trim()});const n=maxRedeem();
      $('pointsInfo').innerHTML=esc((cust.name?cust.name+' · ':'')+cust.points+' điểm · '+cust.visits+' lần mua')+' '+tierBadge(cust.tier)+(cust.tier&&cust.tier.mult>1?' <span class="muted">tích điểm ×'+cust.tier.mult+'</span>':'');
      $('redeemBox').innerHTML=n>0?`<label for="redeem">Dùng điểm thưởng (1 điểm = ${money(L.pointValue)}, tối đa ${n} điểm)</label><input id="redeem" type="number" min="0" max="${n}" value="0" inputmode="numeric">`:'';
      $('redeem')?.addEventListener('input',recalc);recalc();
    }catch(e){cust=null;$('pointsInfo').textContent=e.message}
  };
  $('modal').querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>productModal(S.cart[Number(b.dataset.edit)].productId,Number(b.dataset.edit)));
  $('modal').querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{S.cart.splice(Number(b.dataset.remove),1);persistCart();cartModal();render()});
  $('sendOrder').onclick=async()=>{
    if(S.busy)return;
    if(E){
      if($('discountReason').value==='__other'&&$('discountOther').value.trim().length<3){$('sendError').textContent='Chọn "Khác" thì hãy nhập lý do giảm giá (ít nhất 3 ký tự).';return}
      const mv=manualValue();
      S.busy=true;$('sendOrder').disabled=true;$('sendError').textContent='Đang lưu thay đổi…';
      try{
        const result=await rpc('editOrder',{id:E.id,version:E.version,mutationId:E.mutationId,items:S.cart.map(i=>({...i})),service:$('service').value,channel:$('channel').value,promoId:$('promo').value,customer:$('customer').value,manualDiscount:mv,discountReason:mv?($('discountReason').value==='__other'?'Khác: '+$('discountOther').value.trim():$('discountReason').value):''});
        S.editing=null;S.cart=[];S.busy=false;closeModal();S.view='orders';await refresh(false);render();notify('Đã cập nhật đơn '+orderNo(result)+' · '+money(result.total));
      }catch(e){S.busy=false;if(!S.user)return;$('sendOrder').disabled=false;$('sendError').textContent=e.message}
      return;
    }
    if(!S.pending&&$('discountReason').value==='__other'&&$('discountOther').value.trim().length<3){$('sendError').textContent='Chọn "Khác" thì hãy nhập lý do giảm giá (ít nhất 3 ký tự).';return}
    if(!S.pending){S.pending={requestKey:uid(),items:S.cart.map(i=>({...i})),service:$('service').value,channel:$('channel').value,promoId:$('promo').value,customer:$('customer').value,phone:$('phone').value.trim(),redeem:redeemValue(),manualDiscount:manualValue(),discountReason:manualValue()?($('discountReason').value==='__other'?'Khác: '+$('discountOther').value.trim():$('discountReason').value):'',paymentMethod:'cash',paid:false};persistCart()}
    S.busy=true;$('sendOrder').disabled=true;$('sendError').textContent='Đang gửi đơn lên máy chủ, vui lòng chờ…';
    try{const result=await rpc('createOrder',S.pending);S.pending=null;S.cart=[];persistCart();S.busy=false;closeModal();await refresh(false);render();notify('Đã gửi đơn '+orderNo(result)+' · '+money(result.total))}
    catch(e){S.busy=false;if(!S.user)return;if(e.rejected){S.pending=null;persistCart()}else if(S.pending){S.pending.attempts=(S.pending.attempts||0)+1;persistCart()}cartModal();$('sendError').textContent=e.message+' Giỏ hàng được giữ lại.';connection(e.rejected?'Đơn bị từ chối · Có thể sửa giỏ':'Đơn chưa xác nhận',true);}
  };
}

/** Edit an order that has not been paid: its items go into the cart, the cart screen turns into an editor. */
/** Lock-screen notifications for this phone: turn on/off, send a test. */
async function pushModal(){
  const st=await window.tiemvioPush.state();
  const events=S.user.role==='owner'?['Đơn mới từ các máy khác','Đơn bị hủy hoặc hoàn tiền','Nguyên liệu sắp hết']:['Đơn mới từ các máy khác'];
  let main;
  if(!st.configured)main='<div class="notice">Thông báo chưa được cấu hình cho cửa hàng này. Chủ quán xem hướng dẫn trong docs/PUSH-SETUP.md.</div>';
  else if(st.needsInstall)main='<div class="notice">iPhone chỉ nhận thông báo khi ứng dụng đã được <strong>thêm vào Màn hình chính</strong>. Mở bằng Safari → nút Chia sẻ → <strong>Thêm vào Màn hình chính</strong>, mở ứng dụng từ biểu tượng mới rồi bật thông báo ở đây.</div>';
  else if(!st.supported)main='<div class="notice">Trình duyệt này không hỗ trợ thông báo. Hãy dùng Safari (iPhone, iOS 16.4 trở lên) hoặc Chrome.</div>';
  else if(st.permission==='denied')main='<div class="notice">Thông báo đang bị chặn cho ứng dụng này. Vào <strong>Cài đặt → Thông báo → Tiemvio POS</strong> (hoặc cài đặt trang web trong Chrome) để cho phép, rồi tiemvio lại đây.</div>';
  else if(st.subscribed)main='<p class="badge ready" style="display:inline-block;margin:10px 0">Đang bật trên máy này</p><div class="row wrap" style="gap:8px;justify-content:flex-start"><button id="pushTest" class="small primary">Gửi thông báo thử</button><button id="pushOff" class="small danger">Tắt trên máy này</button></div>';
  else main='<button id="pushOn" class="primary wide" style="margin-top:12px">Bật thông báo trên máy này</button>';
  openModal(`<h2>🔔 Thông báo khi khóa màn hình</h2>
    <p class="muted" style="margin-top:6px">Máy này sẽ báo ngay cả khi màn hình đang khóa. Bạn nhận:</p>
    <ul style="margin:8px 0 4px 18px;line-height:1.7">${events.map(e=>'<li>'+esc(e)+'</li>').join('')}</ul>
    ${main}<p id="pushMsg" class="muted" role="status" style="margin-top:10px"></p>`);
  const msg=t=>{if($('pushMsg'))$('pushMsg').textContent=t};
  $('pushOn')&&($('pushOn').onclick=async()=>{$('pushOn').disabled=true;msg('Đang bật…');try{await window.tiemvioPush.enable();await pushModal();msg('Đã bật thông báo trên máy này.')}catch(e){$('pushOn').disabled=false;msg(e.message)}});
  $('pushOff')&&($('pushOff').onclick=async()=>{await window.tiemvioPush.disable();await pushModal();msg('Đã tắt thông báo trên máy này.')});
  $('pushTest')&&($('pushTest').onclick=async()=>{$('pushTest').disabled=true;msg('Đang gửi thử…');const r=await window.tiemvioPush.notify({type:'test',title:'Thông báo thử',body:'Nếu bạn thấy dòng này trên màn hình khóa là đã hoạt động.',tag:'test'});$('pushTest').disabled=false;msg(r&&r.sent?'Đã gửi. Hãy khóa màn hình và đợi vài giây.':'Chưa gửi được. Kiểm tra mạng rồi thử lại.')});
}

function startEdit(id){
  const o=S.data.orders.find(x=>x.id===id);if(!o)return;
  if(o.paid||!['waiting','making','ready'].includes(o.status))return notify('Chỉ sửa được đơn chưa thu tiền. Đơn đã thu cần hoàn tiền rồi tạo lại.');
  if(S.editing)return notify('Đang sửa một đơn khác. Hãy lưu hoặc hủy sửa trước.');
  if(S.cart.length||S.pending)return notify('Hãy hoàn tất hoặc giữ giỏ hiện tại trước khi sửa đơn.');
  S.cart=o.items.map(i=>{
    const m=S.data.menu.find(x=>x.id===i.productId),tops=i.toppings.map(t=>S.data.menu.find(x=>x.id===t.id));
    const price=m&&sizesOf(m)[i.size]!==undefined&&tops.every(Boolean)?Number(sizesOf(m)[i.size])+tops.reduce((n,t)=>n+Number(t.priceM),0)+(i.kind==='food'?0:(i.sugarPrice||0)+(i.icePrice||0)):i.unitPrice;
    return {productId:i.productId,name:i.name,kind:i.kind,size:i.size,sugar:i.sugar,sugarId:i.sugarId,sugarName:i.sugarName,sugarPrice:i.sugarPrice||0,ice:i.ice,iceName:i.iceName,icePrice:i.icePrice||0,temp:i.temp||'cold',quantity:i.quantity,unitName:i.unitName,packQty:i.packQty||1,byWeight:!!i.byWeight,toppings:i.toppings.map(t=>t.id),note:i.note||'',unitPrice:price};
  });
  S.editing={editHistory:o.editHistory||[],id:o.id,version:o.version,mutationId:uid(),seq:orderNo(o),phone:o.phone||'',redeemed:o.redeemed||0,service:o.service,customer:o.customer||'',channel:o.channel||'store',promoId:o.promoId||'',
    manualDiscount:o.manualDiscount||0,discountReason:o.discountReason||'',paymentMethod:o.paymentMethod,paid:false};
  S.view='sales';render();notify('Đang sửa đơn '+orderNo(o)+'.');
}

function renderOrders(){
  let orders=S.data.orders.filter(o=>S.filter==='active'?!['delivered','cancelled'].includes(o.status):S.filter==='unpaid'?!o.paid&&o.status!=='cancelled':S.filter==='all'||o.status===S.filter);
  orders.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  $('app').innerHTML=`
    <div class="section-head row">
      <div>
        <div class="eyebrow">THEO DÕI ĐƠN HÀNG</div>
        <h1>Danh sách đơn hàng</h1>
        <p class="muted">Theo dõi tiến độ và thu tiền đơn hàng.</p>
      </div>
      <button id="refresh" class="small soft">🔄 Làm mới</button>
    </div>
    <div class="row wrap" style="margin-bottom:18px">
        ${dateField('orderDay',S.day,'max-width:130px')}
        <select id="orderFilter" style="max-width:200px">
          <option value="active">Đang xử lý</option>
          <option value="unpaid">Chưa thanh toán</option>
          <option value="delivered">Đã giao khách</option>
          <option value="cancelled">Đã hủy / hoàn tiền</option>
          <option value="all">Tất cả đơn</option>
        </select>
        <span class="muted" style="font-size:13px">${orders.length} đơn hiển thị</span>
      </div>
    <div class="order-grid">
      ${orders.map(o=>orderCard(o)).join('')||'<div class="card empty">Chưa có đơn hàng nào trong mục này.</div>'}
    </div>
  `;
  $('refresh').onclick=()=>refresh();$('orderFilter').value=S.filter;$('orderFilter').onchange=e=>{S.filter=e.target.value;renderOrders()};wireDate('orderDay',async iso=>{S.day=iso;await refresh()});
  $('app').querySelectorAll('[data-change]').forEach(b=>b.onclick=()=>changeModal(b.dataset.id,b.dataset.change));
  $('app').querySelectorAll('[data-splitorder]').forEach(b=>b.onclick=()=>splitOrderModal(b.dataset.splitorder));
  $('app').querySelectorAll('[data-mergeorder]').forEach(b=>b.onclick=()=>mergeOrdersModal(b.dataset.mergeorder));
  $('app').querySelectorAll('[data-editorder]').forEach(b=>b.onclick=()=>startEdit(b.dataset.editorder));
}


// Merge/split always uses the versions shown at opening; concurrent payment or editing is rejected atomically.
function eligibleOrders(){return S.data.orders.filter(o=>!o.paid&&!o.restructured&&['waiting','making','ready'].includes(o.status))}
async function submitRestructure(data,button,error){
  S.busy=true;$(button).disabled=true;
  try{
    const r=await rpc('restructureOrders',data);S.busy=false;closeModal();await refresh(false);render();
    notify(data.mode==='merge'?'Đã gộp thành một đơn · '+money(r.orders[0].total):'Đã tách thành '+r.orders.length+' đơn.');
  }catch(e){S.busy=false;if(!S.user)return;$(button).disabled=false;$(error).textContent=e.message}
}
function mergeOrdersModal(id){
  const available=eligibleOrders(),base=available.find(o=>o.id===id);if(!base)return;
  if(available.length<2)return notify('Cần ít nhất hai đơn đang mở và chưa thu tiền.');
  const mutationId=uid();
  openModal('<h2>Gộp đơn</h2><p class="muted">Chọn từ 2 đến 8 đơn chưa thu tiền. Giá, giảm giá, điểm đã đổi và kho được giữ nguyên. Các đơn phải có cùng số điện thoại tích điểm (hoặc cùng để trống).</p><div id="mergeChoices">'+available.map(o=>'<label class="check"><input type="checkbox" data-merge="'+esc(o.id)+'" '+(o.id===id?'checked':'')+'><span>'+esc(orderNo(o))+' · '+esc(o.customer||'Khách lẻ')+' · '+money(o.total)+'<br><small>'+esc(o.items.map(i=>qtyLabel(i)+' × '+i.name).join(', '))+'</small></span></label>').join('')+'</div><p id="mergeTotal" class="notice"></p><div class="modal-foot"><button id="doMerge" class="primary wide">Xác nhận gộp đơn</button><p id="mergeError" class="error" role="alert"></p></div>');
  const picked=()=>[...$('mergeChoices').querySelectorAll('[data-merge]:checked')].map(b=>available.find(o=>o.id===b.dataset.merge));
  const draw=()=>{const list=picked();$('mergeTotal').textContent=list.length+' đơn · Tổng '+money(list.reduce((n,o)=>n+o.total,0));$('doMerge').disabled=list.length<2||list.length>8};
  $('mergeChoices').onchange=draw;draw();
  $('doMerge').onclick=()=>submitRestructure({mode:'merge',sources:picked().map(o=>({id:o.id,version:o.version})),mutationId},'doMerge','mergeError');
}
function splitOrderModal(id){
  const o=eligibleOrders().find(x=>x.id===id);if(!o)return;
  const units=o.items.reduce((n,i)=>n+i.quantity,0);if(units<2)return notify('Đơn cần ít nhất hai đơn vị món để tách.');
  const mutationId=uid();let count=2;
  const selections=Array.from({length:8},(_,part)=>o.items.map(i=>part===0?i.quantity:0));
  openModal('<h2>Tách đơn '+esc(orderNo(o))+'</h2><p class="muted">Chia số lượng món cho từng đơn. Mỗi đơn phải có món; tổng số lượng phải khớp đơn gốc. Tổng tiền, giảm giá, điểm và kho được giữ nguyên.</p><label for="splitCount">Số đơn mới</label><select id="splitCount">'+Array.from({length:Math.min(8,units)-1},(_,i)=>'<option value="'+(i+2)+'">'+(i+2)+' đơn</option>').join('')+'</select><div id="splitLines"></div><p id="splitSummary" class="notice"></p><div class="modal-foot"><button id="doSplit" class="primary wide">Xác nhận tách đơn</button><p id="splitError" class="error" role="alert"></p></div>');
  const check=()=>{
    const totals=o.items.map((_,line)=>selections.slice(0,count).reduce((n,row)=>n+row[line],0));
    const valid=totals.every((n,i)=>n===o.items[i].quantity)&&selections.slice(0,count).every(row=>row.some(n=>n>0));
    $('splitSummary').textContent=valid?'Đã chia đủ món · Tổng giữ nguyên '+money(o.total):'Hãy chia đủ số lượng của từng món và bảo đảm mỗi đơn đều có món.';
    $('doSplit').disabled=!valid;
  };
  const draw=()=>{
    $('splitLines').innerHTML=o.items.map((item,line)=>'<div class="card" style="margin-top:10px"><strong>'+esc(item.name)+' · '+esc(qtyLabel(item))+'</strong><p class="muted">'+esc(itemText(item))+(item.toppings?.length?' · '+item.toppings.map(t=>esc(t.name)).join(', '):'')+(item.note?' · '+esc(item.note):'')+'</p><div class="two">'+Array.from({length:count},(_,part)=>'<div><label>Đơn '+(part+1)+'</label><input type="number" inputmode="numeric" min="0" max="'+item.quantity+'" step="1" data-part="'+part+'" data-line="'+line+'" value="'+selections[part][line]+'"></div>').join('')+'</div></div>').join('');
    $('splitLines').querySelectorAll('input').forEach(el=>el.oninput=()=>{const n=Number(el.value);selections[+el.dataset.part][+el.dataset.line]=Number.isInteger(n)&&n>=0?n:NaN;check()});check();
  };
  $('splitCount').onchange=()=>{const next=Number($('splitCount').value);if(next<count)for(let p=next;p<count;p++)o.items.forEach((_,line)=>{selections[0][line]+=selections[p][line];selections[p][line]=0});count=next;draw()};
  draw();
  $('doSplit').onclick=()=>submitRestructure({mode:'split',sources:[{id:o.id,version:o.version}],groups:selections.slice(0,count).map(row=>row.flatMap((quantity,line)=>quantity>0?[{line,quantity}]:[])),mutationId},'doSplit','splitError');
}

function orderCard(o){
  const canAdvance=isSales()&&['waiting','making','ready'].includes(o.status);
  const nextLabel={waiting:'Bắt đầu làm',making:'Làm xong',ready:o.paid?'Giao khách':'Giao khách & Thu tiền'}[o.status];
  return `
    <article class="card">
      <div class="row order-top">
        <div>
          <strong>${esc(orderNo(o))}</strong>
          <span class="badge ${o.status}" style="margin-left:6px">${labels[o.status]}</span>${o.channel&&o.channel!=='store'?`<span class="badge waiting" style="margin-left:6px">${esc(channelName(o.channel))}</span>`:''}
          <div class="muted" style="margin-top:4px;font-size:13px">
            <strong>${esc(o.customer||'Khách lẻ')}</strong> · ${o.service==='dinein'?'Tại quán':'Mang đi'} · ${new Date(o.createdAt).toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit',timeZone:S.data.timezone})}
          </div>
          <div class="muted" style="font-size:12.5px;margin-top:3px">Người bán: <strong>${esc(o.creatorName||o.creator||'—')}</strong> · ${esc(fmtDateTime(o.createdAt))}${o.paid&&o.paidAt?'<br>Thu tiền: <strong>'+esc(o.paidByName||o.paidBy||'—')+'</strong> · '+esc(fmtDateTime(o.paidAt)):''}</div>
        </div>
        <span class="badge ${o.paid?'ready':'waiting'}">${o.paid?'Đã thu tiền':'Chưa thu'}</span>
      </div>

      ${o.origin?`<div class="muted" style="font-size:12px;margin:6px 0">${o.origin.type==='merge'?'Đơn gộp':'Đơn tách'} · mã ${esc(o.id.slice(-8))}</div>`:''}
      ${o.stop?`<div class="notice" style="background:#fdecec;border-color:#f4c2c2;color:#8a1f1f;margin:8px 0"><strong>${o.stop.kind==='refund'?'Đã hoàn tiền':'Đã hủy'}</strong>${o.stop.reason?' · Lý do: <strong>'+esc(o.stop.reason)+'</strong>':''}<div style="font-size:12.5px;margin-top:2px">${o.stop.by?esc(o.stop.byName||o.stop.by)+' · ':''}${o.stop.at?fmtDateTime(o.stop.at):''}</div></div>`:''}
      <div style="margin:8px 0">
        ${o.items.map(i=>`
          <div class="order-line">
            <div class="row">
              <strong>${qtyLabel(i)} × ${esc(i.name)}</strong>
              <span class="muted">${i.kind==='food'?'':sizeTag(i)}</span>
            </div>
            <div class="muted" style="font-size:13px">${itemText(i)}</div>
            ${i.toppings.length?'<div class="muted" style="font-size:12.5px">+ '+i.toppings.map(t=>esc(t.name)).join(', ')+'</div>':''}
            ${i.note?'<div style="color:var(--orange);font-weight:600;font-size:13px">Ghi chú: '+esc(i.note)+'</div>':''}
          </div>
        `).join('')}
      </div>

      <div class="row" style="padding-top:10px;border-top:1px solid var(--line-subtle)">
        <strong style="font-size:17px;color:var(--green)" class="tabular">${money(o.total)}</strong>
        <span class="muted" style="font-size:12.5px">
          ${o.promoDiscount?esc(o.promoName||'KM')+' -'+money(o.promoDiscount)+' · ':''}
          ${o.discount?'Điểm -'+money(o.discount)+' · ':''}
          ${o.manualDiscount?'Giảm -'+money(o.manualDiscount)+' · ':''}
          ${payText(o)}
          ${o.paid&&['transfer','split'].includes(o.paymentMethod)?(o.reconciled?' (đã khớp)':' (chưa khớp)'):''}
          ${o.cashReceived!=null?'<br>Khách đưa '+money(o.cashReceived)+' · Thối lại '+money(o.changeGiven):''}
        </span>
      </div>

      <div class="order-actions">
        ${canAdvance?`<button class="primary small" data-id="${o.id}" data-change="advance">${nextLabel}</button>`:''}
        ${isSales()&&!o.paid&&['waiting','making'].includes(o.status)?`<button class="primary small" data-id="${o.id}" data-change="pay">💵 Thu tiền</button>`:''}
        ${isSales()&&!o.paid&&!['cancelled','delivered'].includes(o.status)?`<button class="danger small" data-id="${o.id}" data-change="cancel">Hủy đơn</button>`:''}
        ${S.user.role==='owner'&&o.paid&&o.status!=='cancelled'?`<button class="small" data-id="${o.id}" data-change="repay">✏️ Sửa đơn (thanh toán)</button>`:''}
        ${S.user.role==='owner'&&o.paid&&o.status!=='cancelled'?`<button class="danger small" data-id="${o.id}" data-change="refund">Hoàn tiền</button>`:''}
        ${isSales()&&!o.paid&&['waiting','making','ready'].includes(o.status)?`<button class="small" data-editorder="${o.id}">✏️ Sửa đơn</button>`:''}
        ${canOperate()&&!o.paid&&['waiting','making','ready'].includes(o.status)?`<button class="small" data-splitorder="${o.id}">Tách đơn</button><button class="small" data-mergeorder="${o.id}">Gộp đơn</button>`:''}
      </div>
    </article>
  `;
}

function changeModal(id,change){
  const o=S.data.orders.find(o=>o.id===id);if(!o)return;
  const deliveryPayment=(change==='advance'&&o.status==='ready'&&!o.paid)||change==='pay'||change==='repay';
  const noCash=change==='repay';   // fixing the method of a paid order: the cash handed over was already recorded
  const title={advance:{waiting:'Bắt đầu làm món?',making:'Đã hoàn thành các món?',ready:'Giao khách & Xác nhận thu tiền?'}[o.status],pay:'Thu tiền đơn',repay:'Sửa phương thức thanh toán',cancel:'Hủy đơn chưa thanh toán',refund:'Hoàn tiền đơn đã thu'}[change];
  openModal(`
    <h2>${title}</h2>
    <p class="muted" style="margin-top:6px">Đơn ${esc(orderNo(o))} · Tổng tiền: <strong style="color:var(--green)">${money(o.total)}</strong></p>
    ${deliveryPayment?`
      <label for="payMethod">Phương thức thanh toán đã nhận</label>
      <select id="payMethod">
        <option value="cash">Tiền mặt</option>
        <option value="transfer">Chuyển khoản</option>
        <option value="split">Chia: tiền mặt + chuyển khoản</option>
      </select>
      <div id="splitBox" class="hidden">
        <label for="payCash">Khách trả tiền mặt (đ)</label>
        <input id="payCash" inputmode="numeric" autocomplete="off" placeholder="Ví dụ: 100.000">
        <div class="notice" id="splitInfo" aria-live="polite" style="margin-top:8px"></div>
      </div>
      <div id="qrBox"></div>
      <div id="cashBox" class="${noCash?'hidden':''}">
        <label for="received">Số tiền khách đưa (đ)</label>
        <input id="received" inputmode="numeric" autocomplete="off" placeholder="Nhập số tiền khách đưa">
        <div class="row wrap" style="justify-content:flex-start;margin-top:8px">
          <button type="button" class="small" data-cash="exact">Đủ tiền</button>
          <button type="button" class="small" data-cash="50000">50.000đ</button>
          <button type="button" class="small" data-cash="100000">100.000đ</button>
          <button type="button" class="small" data-cash="200000">200.000đ</button>
          <button type="button" class="small" data-cash="500000">500.000đ</button>
        </div>
        <div class="notice" id="changeDue" aria-live="polite" style="margin-top:10px">Tiền thối lại cho khách: —</div>
      </div>
      <p class="muted" style="margin-top:8px">${change==='advance'?'Đơn hàng sẽ chuyển sang trạng thái "Đã giao" và tự động ghi nhận doanh thu.':change==='repay'?'Chỉ đổi cách khách đã trả. Tổng tiền và món giữ nguyên; báo cáo, két và đối soát được cập nhật theo.':'Ghi nhận khách đã trả tiền. Món vẫn tiếp tục được làm và giao như bình thường.'}</p>
    `:''}
    ${change==='cancel'||change==='refund'?`
      <label for="cancelReason">Lý do ${change==='refund'?'hoàn tiền':'hủy đơn'}</label>
      <select id="cancelReason">
        <option value="">— Chọn lý do —</option>
        ${(S.data.cancelReasons||[]).map(r=>`<option value="${esc(r)}">${esc(r)}</option>`).join('')}
        <option value="__other">Khác…</option>
      </select>
      <input id="cancelOther" class="hidden" maxlength="80" placeholder="Nhập lý do (ít nhất 3 ký tự)" style="margin-top:8px">
      ${change==='refund'?'<p class="muted" style="margin-top:8px">Đơn sẽ được chuyển sang "Đã hủy" và trừ khỏi doanh thu ngày. Kho nguyên liệu sẽ tự động hoàn lại số lượng đã xuất.</p>':''}
    `:''}
    <div class="modal-foot">
      <button id="confirmChange" class="primary wide">Xác nhận thực hiện</button>
      <p id="changeError" class="error" style="margin-top:8px;text-align:center" role="alert"></p>
    </div>
  `);

  // Cash handed over by the customer is sent with the hand-off and stored in the order's audit trail.
  const fmt=n=>new Intl.NumberFormat('vi-VN').format(n);
  const receivedAmount=()=>{const raw=($('received')?.value||'').replace(/\D/g,'');return raw?Number(raw):null};
  // What the customer hands over in cash: the whole bill, or just the cash part of a split payment.
  const cashDue=()=>{const m=$('payMethod').value;if(m==='cash')return o.total;if(m==='split'){const c=digitsOf($('payCash')?.value);return c!==null&&c>=1&&c<o.total?c:null}return 0};
  const showChange=()=>{
    const r=receivedAmount(),box=$('changeDue');if(!box)return;
    const due=cashDue();
    if(r===null||due===null){box.textContent='Tiền thối lại cho khách: —';box.classList.remove('error');return}
    const diff=r-due;
    box.textContent=diff>=0?'Tiền thối lại cho khách: '+money(diff):'Còn thiếu: '+money(-diff);
    box.classList.toggle('error',diff<0);
  };
  const syncCashBox=()=>{
    const m=$('payMethod').value,cash=m==='cash'||m==='split';$('changeError').textContent='';
    $('splitBox').classList.toggle('hidden',m!=='split');
    if(m==='split'){const c=cashDue();$('splitInfo').innerHTML=c===null?(digitsOf($('payCash').value)===null?'Nhập số tiền khách trả bằng tiền mặt, phần còn lại là chuyển khoản.':'Tiền mặt phải từ 1đ và nhỏ hơn tổng '+money(o.total)+'.'):'Tiền mặt <strong>'+money(c)+'</strong> + chuyển khoản <strong>'+money(o.total-c)+'</strong>'}
    $('cashBox').classList.toggle('hidden',!cash||noCash);if(cash&&!noCash)showChange();
    const c2=m==='split'?cashDue():null,bank=S.data.bank,amt=m==='transfer'?o.total:(m==='split'&&c2!==null?o.total-c2:0);
    $('qrBox').innerHTML=bank&&amt>0&&!noCash?`
      <div class="card" style="margin-top:12px;text-align:center;background:var(--paper)">
        <div class="eyebrow" style="margin-bottom:8px">MÃ VIETQR CHUYỂN KHOẢN</div>
        <img alt="Mã VietQR chuyển khoản" src="https://img.vietqr.io/image/${bank.bin}-${bank.account}-compact2.png?amount=${amt}&addInfo=${encodeURIComponent('TIEMVIO')}&accountName=${encodeURIComponent(bank.name)}" style="width:100%;max-width:240px;display:block;margin:0 auto 8px;border-radius:12px">
        <p class="muted" style="font-size:12.5px">Quét mã bằng ứng dụng ngân hàng để chuyển khoản <strong>${money(amt)}</strong></p>
      </div>`:'';
  };
  if(deliveryPayment){
    $('payMethod').value=o.paymentMethod;if(o.paymentMethod==='split')$('payCash').value=fmt(o.cashPart);
    $('payMethod').onchange=syncCashBox;
    $('payCash').oninput=e=>{const d=digitsOf(e.target.value);e.target.value=d===null?'':fmt(d);syncCashBox()};
    $('received').oninput=e=>{const d=e.target.value.replace(/\D/g,'');e.target.value=d?fmt(Number(d)):'';showChange()};
    $('cashBox').querySelectorAll('[data-cash]').forEach(b=>b.onclick=()=>{$('received').value=fmt(b.dataset.cash==='exact'?(cashDue()||o.total):Number(b.dataset.cash));showChange()});
    syncCashBox();
  }
  if($('cancelReason'))$('cancelReason').onchange=e=>$('cancelOther').classList.toggle('hidden',e.target.value!=='__other');
  let mutationId=uid();
  $('confirmChange').onclick=async()=>{
    let cashReceived;
    let cashPart;
    if(deliveryPayment&&$('payMethod').value==='split'){
      cashPart=cashDue();
      if(cashPart===null){$('changeError').textContent='Chia thanh toán: nhập tiền mặt từ 1đ đến dưới '+money(o.total)+'; phần còn lại là chuyển khoản.';return}
    }
    if(deliveryPayment&&!noCash&&['cash','split'].includes($('payMethod').value)){
      const due=cashDue();
      cashReceived=receivedAmount();
      if(cashReceived===null){$('changeError').textContent='Hãy nhập số tiền khách đưa.';return}
      if(cashReceived<due){$('changeError').textContent='Khách đưa chưa đủ: còn thiếu '+money(due-cashReceived)+'.';return}
    }
    let reason;
    if($('cancelReason')){
      reason=$('cancelReason').value;
      if(!reason){$('changeError').textContent='Hãy chọn lý do.';return}
      if(reason==='__other'){const t=$('cancelOther').value.trim();if(t.length<3){$('changeError').textContent='Hãy nhập lý do (ít nhất 3 ký tự).';return}reason='Khác: '+t}
    }
    const data={id,version:o.version,change,mutationId,paymentMethod:$('payMethod')?.value,cashPart,cashReceived,reason};
    S.busy=true;$('confirmChange').disabled=true;
    try{await rpc('updateOrder',data);S.busy=false;closeModal();await refresh(false);render();notify('Đã cập nhật đơn hàng thành công')}
    catch(e){S.busy=false;if(!S.user)return;$('confirmChange').disabled=false;$('changeError').textContent=e.message;}
  };
}

let reportCache=null;
async function renderReport(){
  if(!S.report)S.report={from:S.day,to:S.day};
  const rg=S.report;
  $('app').innerHTML=`
    <div class="section-head">
      <div class="eyebrow">CHỦ QUÁN Tiemvio POS · BÁO CÁO</div>
      <h1>Báo cáo doanh thu</h1>
      <p class="muted">Theo ngày ghi nhận tiền · Múi giờ: ${esc(S.data.timezone)}</p>
    </div>
    <div class="row wrap" style="justify-content:flex-start;margin-bottom:16px;gap:8px">
      ${dateField('reportFrom',rg.from,'max-width:130px')}
      <span class="muted">đến</span>
      ${dateField('reportTo',rg.to,'max-width:130px')}
      <button id="refreshReport" class="small primary">Xem báo cáo</button>
      <button id="rangeToday" class="small">Hôm nay</button>
      <button id="rangeWeek" class="small">7 ngày</button>
      <button id="rangeMonth" class="small">30 ngày</button>
    </div>
    <div id="reportBody"><div class="empty">Đang tổng hợp số liệu…</div></div>
  `;

  const load=async()=>{
    const f=readDate('reportFrom'),t2=readDate('reportTo');if(!f||!t2){$('reportBody').innerHTML='<div class="card error" role="alert">Ngày không hợp lệ. Nhập theo dạng dd-mm-yyyy, ví dụ 04-11-2026.</div>';return}
    rg.from=f;rg.to=t2;S.day=rg.to||S.day;
    try{
      const r=await rpc('report',{from:rg.from,to:rg.to});reportCache=r;if(S.view!=='report')return;
      $('reportBody').innerHTML=`
        <div class="metrics">
          <div class="card metric">
            <span class="muted">Tổng tiền đã thu</span>
            <strong>${money(r.total)}</strong>
          </div>
          <div class="card metric">
            <span class="muted">Số đơn hoàn tất</span>
            <strong>${r.count} đơn${r.cups?' · '+r.cups+' ly':''}</strong>
          </div>
          <div class="card metric">
            <span class="muted">Thu tiền mặt</span>
            <strong style="color:#0f766e">${money(r.cash)}</strong>
          </div>
          <div class="card metric">
            <span class="muted">Thu chuyển khoản</span>
            <strong style="color:#1d4ed8">${money(r.transfer)}</strong>
          </div>
        </div>

        <div class="card stack" style="margin-bottom:18px">
          <div class="row">
            <span>Giảm giá bằng điểm / giảm giá tay:</span>
            <strong class="tabular">${money(r.discount)} / ${money(r.manualDiscount)}</strong>
          </div>
          <div class="row">
            <span>Chi phí hoạt động đã ghi:</span>
            <strong class="tabular" style="color:var(--red)">-${money(r.expenses)}</strong>
          </div>
          <div class="row" style="border-top:1px solid var(--line-subtle);padding-top:10px">
            <strong style="font-size:16px">Lãi tạm tính (Thu − Chi phí):</strong>
            <strong style="font-size:18px;color:var(--green)" class="tabular">${money(r.profit)}</strong>
          </div>
          ${r.cogs>0?`<div class="row"><span>Giá vốn nguyên liệu ước tính:</span><strong class="tabular" style="color:var(--red)">-${money(r.cogs)}</strong></div>
          <div class="row"><strong>Lãi gộp (Thu − Giá vốn):</strong><strong class="tabular" style="color:var(--green)">${money(r.grossProfit)}</strong></div>`:'<p class="muted" style="font-size:12.5px">Nhập giá vốn cho nguyên liệu (Quản lý → Kho) để xem giá vốn và lãi gộp.</p>'}
          ${r.promoDiscount?`<div class="row"><span>Đã giảm bằng khuyến mãi:</span><strong class="tabular">${money(r.promoDiscount)}</strong></div>`:''}
          <div class="row" style="border-top:1px solid var(--line-subtle);padding-top:10px">
            <span class="muted">Đơn hoàn tiền (${r.refundCount} đơn):</span>
            <span class="tabular">${money(r.refundTotal)}</span>
          </div>
        </div>

        <div class="row" style="margin:28px 0 12px">
          <h2>Chuyển khoản chưa đối soát (${r.unreconciled.length})</h2>
          ${r.unreconciled.length&&(S.user.role==='owner')&&(realRole()!=='support'||S.data.user.canEdit)?'<button id="reconcileAll" class="small primary">Đối soát toàn bộ</button>':''}
        </div>
        <p class="muted" style="margin-bottom:12px">Đối chiếu với thông báo biến động số dư ngân hàng rồi bấm "Đã khớp".</p>
        <div class="admin-list">
          ${r.unreconciled.map(t=>`
            <div class="card row">
              <div>
                <strong>${t.seq?'#'+t.seq:'#'+esc(t.id.slice(-6).toUpperCase())}</strong> · ${esc(t.customer||'Khách lẻ')}
                <div class="muted" style="font-size:12.5px">${fmtDateTime(t.paidAt)}</div>
                <strong style="color:var(--green)">${money(t.total)}</strong>
              </div>
              <button class="small primary" data-reconcile="${esc(t.id)}" data-v="${t.version}">Đã khớp</button>
            </div>
          `).join('')||'<div class="card empty">Tất cả giao dịch chuyển khoản đã được đối soát.</div>'}
        </div>

        <div class="row" style="margin:28px 0 12px">
          <h2>Chi phí vận hành</h2>
          <button id="newExpense" class="small primary">+ Thêm khoản chi</button>
        </div>
        <div class="admin-list">
          ${r.expenseList.map(x=>`
            <div class="card row">
              <div>
                <strong>${esc(x.category)}</strong> · <span class="muted">${fmtDate(x.at)}</span>
                <div class="muted">${esc(x.note)}</div>
              </div>
              <div>
                <strong style="margin-right:12px">${money(x.amount)}</strong>
                <button class="small danger" data-void="${esc(x.id)}">Xóa</button>
              </div>
            </div>
          `).join('')||'<div class="card empty">Chưa có chi phí phát sinh trong khoảng thời gian này.</div>'}
        </div>

        <h2 style="margin:28px 0 12px">Ca làm việc gần nhất</h2>
        <div class="admin-list">
          ${(S.data.shifts||[]).map(x=>`
            <div class="card row">
              <div>
                <strong>${fmtDateTime(x.openedAt)}</strong>
                <div class="muted">${esc(x.openedByName||x.openedBy)} · Đầu ca: ${money(x.openingCash)} · Dự kiến: ${money(x.expectedCash)}</div>
              </div>
              <strong class="${x.difference<0?'error':''}" style="font-size:15px">
                ${x.difference===0?'🟢 Khớp':(x.difference>0?'Dư ':'Thiếu ')+money(Math.abs(x.difference))}
              </strong>
            </div>
          `).join('')||'<div class="card empty">Chưa có dữ liệu ca làm việc.</div>'}
        </div>

        <h2 style="margin:28px 0 12px">Theo kênh bán</h2>
        <div class="admin-list">
          ${r.channels.map(c=>`<div class="card row"><span><strong>${esc(c.name)}</strong> · ${c.count} đơn${c.cups?' · '+c.cups+' ly':''}</span><strong style="color:var(--green)">${money(c.total)}</strong></div>`).join('')||'<div class="card empty">Chưa có dữ liệu kênh bán.</div>'}
        </div>

        <h2 style="margin:28px 0 12px">Theo nhân viên (người thu tiền)</h2>
        <div class="admin-list">
          ${r.staff.map(x=>`<button type="button" class="card row" data-staff="${esc(x.email||x.name)}" data-sname="${esc(x.name)}" style="width:100%;text-align:left;cursor:pointer"><span><strong>${esc(x.name)}</strong> · ${x.count} đơn${x.cups?' · '+x.cups+' ly':''}</span><span style="display:flex;gap:8px;align-items:center"><strong style="color:var(--green)">${money(x.total)}</strong><span class="muted">›</span></span></button>`).join('')||'<div class="card empty">Chưa có dữ liệu.</div>'}
        </div>

        <h2 style="margin:28px 0 12px">Theo giờ bán</h2>
        <div class="card hourly-scroll">
          ${(()=>{const mx=Math.max(1,...r.hours.map(h=>h.total));return r.hours.length?`<table class="hourly-chart tabular" aria-label="Doanh thu, số đơn và số ly theo giờ bán"><thead><tr><th scope="col">Giờ</th><th scope="col" aria-label="Biểu đồ doanh thu"></th><th scope="col">Doanh thu</th><th scope="col">Đơn</th><th scope="col">Ly</th></tr></thead><tbody>${r.hours.map(h=>`<tr><th scope="row">${String(h.hour).padStart(2,'0')}h</th><td class="hourly-track"><span class="hourly-bar" aria-hidden="true" style="width:${Math.max(0,Math.min(100,h.total/mx*100))}%"></span></td><td>${money(h.total)}</td><td>${h.count}</td><td>${h.cups??0}</td></tr>`).join('')}</tbody></table>`:'<p class="muted">Chưa có dữ liệu.</p>'})()}
        </div>

        <h2 style="margin:28px 0 12px">Giờ làm của nhân viên</h2>
        <div class="admin-list">
          ${r.worked.map(w=>`<div class="card row"><span><strong>${esc(w.name||w.email)}</strong> · ${w.shifts} ca${w.open?' · <span class="badge ready">đang làm</span>':''}</span><strong>${Math.floor(w.minutes/60)}g ${String(w.minutes%60).padStart(2,'0')}p</strong></div>`).join('')||'<div class="card empty">Chưa có dữ liệu chấm công.</div>'}
        </div>

        <h2 style="margin:28px 0 12px">Doanh thu theo ngày</h2>
        <div class="admin-list">
          ${r.days.map(d=>`
            <div class="card row">
              <span><strong>${dmy(d.day)}</strong> · ${d.count} đơn${d.cups?' · '+d.cups+' ly':''}</span>
              <strong style="color:var(--green)">${money(d.total)}</strong>
            </div>
          `).join('')||'<div class="card empty">Chưa có dữ liệu doanh thu.</div>'}
        </div>

        ${(()=>{
          const g=r.groups||{drink:{total:0,count:0,cups:0},food:{total:0,count:0}};
          const block=(icon,title,grp,list,extraText)=>`
            <h2 style="margin:28px 0 12px">${icon} ${title}</h2>
            <div class="card row" style="margin-bottom:10px"><span class="muted">Doanh thu · ${grp.count} đơn${extraText}</span><strong style="color:var(--green);font-size:18px">${money(grp.total)}</strong></div>
            <div class="admin-list">
              ${list.map((t,n)=>`
                <div class="card row">
                  <span><strong>${n+1}. ${esc(t.name)}</strong> · ${String(t.quantity).replace('.',',')} ${esc(t.unit||'ly')}</span>
                  <strong style="color:var(--green)">${money(t.revenue)}</strong>
                </div>`).join('')||'<div class="card empty">Chưa có dữ liệu bán chạy.</div>'}
            </div>`;
          return block('🥤','Đồ uống',g.drink,r.topDrinks||[],g.drink.cups?' · '+g.drink.cups+' ly':'')+block('🍟','Ăn vặt',g.food,r.topFood||[],'')
            +`<p class="muted" style="font-size:12.5px;margin-top:10px">Giảm giá và khuyến mãi được chia theo tỷ lệ giữa đồ uống và ăn vặt trong từng đơn, nên hai nhóm cộng lại bằng tổng doanh thu. Một đơn có cả hai loại được tính vào cả hai nhóm khi đếm đơn.${r.groupsComplete===false?' <strong>Một số ngày cũ chưa có số liệu theo nhóm nên hai nhóm có thể nhỏ hơn tổng.</strong>':''}</p>`;
        })()}

        <div style="margin:24px 0">
          <button id="exportCsv" class="small soft">📥 Xuất file danh sách đơn (CSV)</button>
        </div>
      `;

      $('exportCsv').onclick=exportCsv;
      $('newExpense').onclick=expenseModal;
      $('reportBody').querySelectorAll('[data-void]').forEach(b=>b.onclick=async()=>{if(!confirm('Xóa khoản chi này?'))return;b.disabled=true;try{await rpc('saveExpense',{requestKey:uid(),void:true,id:b.dataset.void});await load();notify('Đã xóa khoản chi')}catch(e){b.disabled=false;notify(e.message)}});
      $('reportBody').querySelectorAll('[data-staff]').forEach(b=>b.onclick=()=>staffSalesModal(b.dataset.staff,b.dataset.sname));
      if($('reconcileAll'))$('reconcileAll').onclick=async()=>{
        if(S.busy)return;
        const orders=r.unreconciled.map(o=>({id:o.id,version:o.version}));
        const total=r.unreconciled.reduce((n,o)=>n+o.total,0);
        if(!confirm('Đánh dấu đã khớp cho '+orders.length+' giao dịch chuyển khoản, tổng '+money(total)+', từ '+dmy(r.from)+' đến '+dmy(r.to)+'? Chỉ xác nhận sau khi đã đối chiếu với ngân hàng.'))return;
        S.busy=true;$('reconcileAll').disabled=true;$('reconcileAll').textContent='Đang đối soát…';
        $('reportBody').querySelectorAll('[data-reconcile]').forEach(b=>b.disabled=true);
        try{
          const result=await rpc('reconcileAll',{orders,mutationId:uid()});
          S.busy=false;await refresh(false);if(S.view==='report')await load();
          notify('Đã đối soát '+result.reconciled+'/'+result.total+' giao dịch.'+(result.failed.length?' '+result.failed.length+' giao dịch chưa xử lý được; hãy kiểm tra danh sách còn lại.':''));
        }catch(e){S.busy=false;if(S.view==='report')await load();notify(e.message+' Hãy kiểm tra danh sách còn lại trước khi thử lại.');}
      };
      $('reportBody').querySelectorAll('[data-reconcile]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await rpc('updateOrder',{id:b.dataset.reconcile,version:Number(b.dataset.v),change:'reconcile',mutationId:uid()});await refresh(false);await load();notify('Đã đối soát')}catch(e){b.disabled=false;notify(e.message)}});
    }catch(e){if(S.user&&$('reportBody'))$('reportBody').innerHTML='<div class="card error" role="alert">'+esc(e.message)+'</div>'}
  };

  const setRange=days=>{const t=S.data.day;const d=new Date(t+'T00:00:00Z');d.setUTCDate(d.getUTCDate()-days+1);$('reportFrom').value=dmy(d.toISOString().slice(0,10));$('reportTo').value=dmy(t);load()};
  wireDate('reportFrom');wireDate('reportTo');
  $('refreshReport').onclick=load;$('rangeToday').onclick=()=>setRange(1);$('rangeWeek').onclick=()=>setRange(7);$('rangeMonth').onclick=()=>setRange(30);
  await load();
}

function exportCsv(){
  const safe=v=>{let s=String(v??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"'};
  const rows=[['Mã đơn','Tạo lúc (UTC)','Khách / bàn','Trạng thái','Đã thu','Phương thức','Tổng tiền','Thu lúc (UTC)'],...S.data.orders.map(o=>[o.id,o.createdAt,o.customer,labels[o.status],o.paid?'Có':'Chưa',payText(o),o.total,o.paidAt])];
  const url=URL.createObjectURL(new Blob(['\uFEFF'+rows.map(r=>r.map(safe).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='TIEMVIO-don-hang-'+S.day+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

// Vietnamese A–Z and accent-insensitive search are limited to the management list.
const menuSearchKey=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/gi,'d').toLocaleLowerCase('vi').trim();
const adminMenuItems=()=>S.data.menu.filter(m=>(S.adminCat==='Tất cả'||m.category===S.adminCat)&&menuSearchKey(m.name).includes(menuSearchKey(S.adminSearch))).sort((a,b)=>a.name.localeCompare(b.name,'vi',{sensitivity:'base',numeric:true})||a.id.localeCompare(b.id));

function renderAdmin(){
  const $=id=>document.getElementById(id)||{}; // buttons of the tabs that are not shown simply do not exist
  const tabs=[['menu','Thực đơn'],['categories','Phân loại món'],['stock','Kho'],['staff','Nhân viên'],['promo','Khuyến mãi'],['settings','Cài đặt']];
  if(!tabs.some(t=>t[0]===S.adminTab))S.adminTab='menu';
  const panels={
    menu:()=>`
        <div class="row">
          <h2>Thực đơn quán</h2>
          <button id="newMenu" class="primary small">+ Thêm món mới</button>
        </div>
        <form id="adminMenuSearch" class="row" role="search" style="margin-top:12px;gap:8px">
          <input type="search" id="adminMenuQuery" aria-label="Tìm món trong thực đơn" placeholder="Tìm tên món…" value="${esc(S.adminSearchDraft)}">
          <button type="submit" class="small primary" style="white-space:nowrap">Tìm kiếm</button>
          ${S.adminSearch?'<button id="clearMenuSearch" type="button" class="small" style="white-space:nowrap">Xóa tìm</button>':''}
        </form>
        ${(()=>{
          // the same category buttons as on the sales screen, with how many items each holds
          const have=new Set(S.data.menu.map(m=>m.category)),cats=[...(S.data.menuCategories||[]).filter(c=>have.has(c)),...[...have].filter(c=>!(S.data.menuCategories||[]).includes(c))];
          if(S.adminCat!=='Tất cả'&&!have.has(S.adminCat))S.adminCat='Tất cả';
          const n=c=>c==='Tất cả'?S.data.menu.length:S.data.menu.filter(m=>m.category===c).length;
          return `<div class="tabs">${['Tất cả',...cats].map(c=>`<button class="${S.adminCat===c?'selected':''}" data-acat="${esc(c)}">${esc(c)} (${n(c)})</button>`).join('')}</div>`;
        })()}
        <div class="admin-list">
          ${adminMenuItems().map(m=>`
            <div class="card row">
              <div>
                <strong>${esc(m.name)}</strong>
                <div class="muted">${esc(m.category)} · ${m.kind==='topping'?'Topping · Giá: '+money(m.priceM):(m.kind==='food'?'Đồ ăn · ':'')+sizeKeys(m).map(z=>'Size '+z+': '+money(sizesOf(m)[z])).join(' / ')+(m.kind==='food'&&(m.byWeight||(m.packQty||1)>1||(m.unit&&m.unit!=='phần'))?' / '+((m.packQty||1)>1?m.packQty+' ':'')+unitName(m)+(m.byWeight?' (cân)':'')+(m.note?' · '+m.note:''):'')} · ${m.active?'Đang bán':'Tạm hết'}${m.allowHot?' · Có bán nóng':''}</div>
                ${(()=>{const c=(S.data.menuCosts||{})[m.id];if(!c)return '';const parts=sizeKeys(m).filter(z=>c[z]>0).map(z=>{const price=sizesOf(m)[z];return z+': vốn '+money(c[z])+' · lãi '+money(price-c[z])+' ('+Math.round((price-c[z])/Math.max(1,price)*100)+'%)'});return parts.length?`<div class="muted" style="font-size:12.5px">Giá vốn → ${parts.join(' | ')}</div>`:''})()}
              </div>
              <div style="display:flex;gap:6px">
                <button class="small" data-recipe="${esc(m.id)}">Công thức</button>
                <button class="small" data-menu="${esc(m.id)}">Sửa</button>
              </div>
            </div>
          `).join('')||'<div class="card empty">Không tìm thấy món phù hợp.</div>'}
        </div>




    `,
    categories:()=>`
        <div class="row"><h2>Phân loại món</h2><button id="categorySettings" class="small primary">Thêm / bớt phân loại</button></div>
        <p class="muted">Quản lý danh sách phân loại và thứ tự hiển thị ở quầy bán hàng.</p>
        <div class="admin-list">${(S.data.menuCategories||[]).map(c=>`<div class="card row"><strong>${esc(c)}</strong><span class="muted">${S.data.menu.filter(m=>m.category===c).length} món</span></div>`).join('')||'<div class="card empty">Chưa có phân loại món.</div>'}</div>
    `,
    stock:()=>`
        <div class="row" style="margin-top:20px">
          <h2>Kho nguyên liệu</h2>
          <button id="newIngredient" class="small soft">+ Thêm nguyên liệu</button>
        </div>
        <div class="admin-list">
          ${S.data.inventory.map(i=>`
            <div class="card row">
              <div>
                <strong>${esc(i.name)}</strong>
                ${i.active&&i.stock<=i.minStock?'<span class="badge cancelled" style="margin-left:6px">Sắp hết</span>':''}
                <div class="muted">Tồn: <strong>${i.stock} ${esc(i.unit)}</strong> · Mức báo: ${i.minStock}${i.cost>0?' · Giá vốn '+money(i.cost)+'/'+esc(i.unit):''}${i.active?'':' · (Đã ngừng dùng)'}</div>
              </div>
              <div style="display:flex;gap:6px">
                <button class="small" data-stock="${esc(i.id)}">Nhập/xuất</button>
                <button class="small" data-ing="${esc(i.id)}">Sửa</button>
              </div>
            </div>
          `).join('')||'<div class="card empty">Chưa có nguyên liệu. Thêm nguyên liệu và gán công thức để hệ thống tự trừ kho khi bán.</div>'}
        </div>

        <div class="row" style="margin-top:20px"><h2>Lịch sử kho</h2></div>
        <div class="admin-list">
          ${(S.data.stockLog||[]).map(x=>`<div class="card row"><div><strong>${esc(x.name)}</strong> <span class="${x.delta<0?'error':''}" style="font-weight:700">${x.delta>0?'+':''}${x.delta} ${esc(x.unit)}</span><div class="muted" style="font-size:12.5px">${esc(x.reason)} · ${esc(x.byName||x.by)} · ${fmtDateTime(x.at)}</div></div></div>`).join('')||'<div class="card empty">Chưa có điều chỉnh kho thủ công nào.</div>'}
        </div>
    `,
    staff:()=>`
        <div class="row" style="margin-top:20px"><h2>Đang chấm công</h2></div>
        <div class="admin-list">
          ${(S.data.clockedIn||[]).map(x=>`<div class="card row"><div><strong>${esc(x.name||x.email)}</strong><div class="muted" style="font-size:12.5px">Vào lúc ${hhmm(x.inAt)}</div></div><button class="small" data-clockout="${esc(x.id)}">Tan ca hộ</button></div>`).join('')||'<div class="card empty">Hiện không ai đang chấm công.</div>'}
        </div>

        <div class="row" style="margin-top:20px">
          <h2>Nhân viên quán</h2>
          ${realRole()!=='support'?'<button id="newUser" class="small soft">+ Thêm</button>':''}
        </div>
        <div class="admin-list">
          ${S.data.users.map(u=>`
            <div class="card">
              <strong>${esc(u.name)}</strong>
              <div class="muted" style="font-size:12.5px">${esc(u.email)}</div>
              <div class="row" style="margin-top:10px">
                <span class="badge ${u.active?'ready':'cancelled'}">${labels[u.role]||u.role} · ${u.active?'Được truy cập':'Bị khóa'}</span>
                ${realRole()!=='support'&&u.email!==S.user.email?`<button class="small" data-user="${esc(u.email)}">Sửa quyền</button>`:''}
              </div>
            </div>
          `).join('')}
        </div>

    `,
    promo:()=>`
        <div class="row">
          <h2>Khuyến mãi</h2>
          <button id="newPromo" class="small soft">+ Thêm</button>
        </div>
        <div class="admin-list">
          ${S.data.promos.map(x=>`<div class="card row"><div><strong>${esc(x.name)}</strong> <span class="badge ${x.active?'ready':'cancelled'}">${x.active?(x.validNow?'Đang áp dụng':'Ngoài giờ'):'Tạm dừng'}</span><div class="muted" style="font-size:12.5px">${x.type==='percent'?'Giảm '+x.value+'%':'Giảm '+money(x.value)}${x.minTotal?' · đơn từ '+money(x.minTotal):''} · ${x.startHour}h–${x.endHour}h</div></div><button class="small" data-promo="${esc(x.id)}">Sửa</button></div>`).join('')||'<div class="card empty">Chưa có khuyến mãi. Nhân viên chọn khuyến mãi khi thanh toán.</div>'}
        </div>

        <div class="card">
          <h3>Khách hàng thân thiết</h3>
          <p class="muted" style="margin-top:4px">Cứ ${money(S.data.loyalty.earnPerVnd)} thu được 1 điểm; 1 điểm = ${money(S.data.loyalty.pointValue)} khi giảm giá. Hạng theo tổng chi tiêu: ${S.data.tiers.map(t=>t.name+(t.min?' từ '+money(t.min):'')+(t.mult>1?' (×'+t.mult+')':'')).join(' · ')}.</p>
          <div style="margin-top:12px">
            ${S.data.customers.slice(0,6).map(c=>`
              <div class="row" style="margin-top:8px;padding-top:6px;border-top:1px solid var(--line-subtle)">
                <span>${esc(c.name||c.phone)} <span class="muted">${esc(c.phone)}</span> ${tierBadge(c.tier)}</span>
                <strong style="color:var(--green)">${c.points} điểm</strong>
              </div>
            `).join('')||'<p class="muted" style="font-size:13px">Chưa có thông tin khách hàng. Nhập số điện thoại khi tạo đơn để tự động ghi điểm.</p>'}
          </div>
        </div>

    `,
    settings:()=>`
        <div class="card">
          <h3>Lý do hủy đơn / hoàn tiền</h3>
          <p class="muted" style="margin:6px 0 10px">${(S.data.cancelReasons||[]).length?(S.data.cancelReasons||[]).map(esc).join(' · '):'Chưa có lý do soạn sẵn. Nhân viên vẫn chọn được "Khác" và tự nhập.'}</p>
          <button id="cancelSettings" class="small wide">Soạn danh sách lý do hủy đơn</button>
        </div>

        <div class="card">
          <h3>Lý do giảm giá</h3>
          <p class="muted" style="margin:6px 0 10px">${(S.data.discountReasons||[]).length?(S.data.discountReasons||[]).map(esc).join(' · '):'Chưa có lý do soạn sẵn. Nhân viên vẫn chọn được "Khác" và tự nhập.'}</p>
          <button id="discountSettings" class="small wide">Soạn danh sách lý do giảm giá</button>
        </div>

        <div class="card">
          <h3>Lượng đá</h3>
          <p class="muted" style="margin:6px 0 10px">${iceList().map(o=>esc(o.name)+extra(o.price)).join(' · ')}</p>
          <button id="iceSettings" class="small wide">Sửa lượng đá và giá thêm</button>
        </div>

        <div class="card">
          <h3>Lượng đường</h3>
          <p class="muted" style="margin:6px 0 10px">${sugarList().map(o=>esc(o.name)+extra(o.price)).join(' · ')}</p>
          <button id="sugarSettings" class="small wide">Sửa lượng đường và giá thêm</button>
        </div>

        <div class="card">
          <h3>Tài khoản VietQR</h3>
          <p class="muted" style="margin:6px 0 10px">${S.data.bank?esc(S.data.bank.account)+' · '+esc(S.data.bank.name):'Chưa cấu hình tài khoản ngân hàng. Cấu hình để hiển thị mã QR khi khách chuyển khoản.'}</p>
          <button id="bankSettings" class="small wide">Cấu hình tài khoản VietQR</button>
        </div>

        <div class="card">
          <h3>Dữ liệu và sao lưu</h3>
          <p class="muted" style="margin:6px 0 10px">Dữ liệu lưu trên Firebase, đồng bộ giữa mọi điện thoại. Nên tải bản sao lưu định kỳ.</p>
          <button id="exportBackup" class="small wide">📥 Tải bản sao lưu (JSON)</button>
          <a href="${esc(S.data.database.url)}" target="_blank" rel="noopener" style="display:block;margin-top:10px;word-break:break-all;font-size:13px">Mở Firebase Console ↗</a>
        </div>

        <div class="card">
          <h3>Dung lượng và dọn dữ liệu cũ</h3>
          <p class="muted" style="margin:6px 0 10px">Xem dung lượng Firebase đã dùng và còn lại (gói miễn phí 1 GB). Có thể xóa đơn hàng, giờ làm và chi phí cũ. Thực đơn, công thức, kho và nhân viên luôn được giữ nguyên.</p>
          <button id="storageBtn" class="small wide">📊 Xem dung lượng và dọn dữ liệu</button>
        </div>

        <div class="card">
          <h3>Thông tin ứng dụng</h3>
          <div class="row" style="margin-top:8px"><span class="muted">Ứng dụng</span><strong>Tiemvio POS  POS</strong></div>
          <div class="row" style="margin-top:6px"><span class="muted">Phiên bản</span><strong id="appVersion">${esc(typeof __APP_VERSION__==='string'?__APP_VERSION__:'')}</strong></div>
          <div class="row" style="margin-top:6px"><span class="muted">Tác giả</span><strong>Nguyễn Giang Bảo</strong></div>
          <div class="row" style="margin-top:6px"><span class="muted">Email tác giả</span><a href="mailto:support-editor@example.invalid" style="word-break:break-all">support-editor@example.invalid</a></div>
        </div>

        ${appDownloads()}
        <div class="card">
          <h3>Giấy phép và miễn trừ trách nhiệm</h3>
          <p class="muted" style="margin:6px 0 10px">Bản quyền © 2026 Nguyễn Giang Bảo. Giấy phép sử dụng, điều khoản về dữ liệu cá nhân, trợ lý AI, thuế và hóa đơn.</p>
          <button id="legalBtn" class="small wide">📄 Đọc giấy phép và miễn trừ trách nhiệm</button>
        </div>
    `
  };
  document.getElementById('app').innerHTML=`
    <div class="section-head">
      <div class="eyebrow">CHỦ QUÁN Tiemvio POS · THIẾT LẬP</div>
      <h1>Quản lý hệ thống</h1>
    </div>
    <div class="tabs" role="tablist">${tabs.map(([k,t])=>`<button role="tab" aria-selected="${k===S.adminTab}" class="${k===S.adminTab?'selected':''}" data-admintab="${k}">${t}</button>`).join('')}</div>
    <section class="stack admin-panel">${panels[S.adminTab]()}</section>
  `;
  document.getElementById('app').querySelectorAll('[data-admintab]').forEach(b=>b.onclick=()=>{S.adminTab=b.dataset.admintab;renderAdmin()});
  document.getElementById('app').querySelectorAll('[data-acat]').forEach(b=>b.onclick=()=>{S.adminCat=b.dataset.acat;renderAdmin()});
  if(document.getElementById('adminMenuSearch')){
    $('adminMenuQuery').oninput=e=>{S.adminSearchDraft=e.target.value};
    $('adminMenuSearch').onsubmit=e=>{e.preventDefault();S.adminSearch=S.adminSearchDraft.trim();renderAdmin()};
    $('clearMenuSearch').onclick=()=>{S.adminSearch='';S.adminSearchDraft='';renderAdmin()};
  }
  $('legalBtn').onclick=legalModal;$('exportBackup').onclick=exportBackup;$('storageBtn').onclick=storageModal;$('newIngredient').onclick=()=>ingredientModal();$('bankSettings').onclick=bankModal;$('discountSettings').onclick=()=>reasonsModal('discountReasons','saveDiscountReasons','Lý do giảm giá','Khách quen&#10;Sinh nhật&#10;Nhân viên','Nhân viên chọn lý do trong danh sách này hoặc "Khác" để tự nhập; mặc định là "Không" (không giảm giá).');$('cancelSettings').onclick=()=>reasonsModal('cancelReasons','saveCancelReasons','Lý do hủy đơn / hoàn tiền','Khách đổi ý&#10;Nhầm món&#10;Làm sai món','Khi hủy đơn hoặc hoàn tiền, chọn lý do trong danh sách này hoặc "Khác" để tự nhập.');$('categorySettings').onclick=categoriesModal;$('iceSettings').onclick=()=>optionsModal('ice');$('sugarSettings').onclick=()=>optionsModal('sugar');
  $('app').querySelectorAll('[data-recipe]').forEach(b=>b.onclick=()=>recipeModal(b.dataset.recipe));
  $('app').querySelectorAll('[data-stock]').forEach(b=>b.onclick=()=>stockModal(b.dataset.stock));
  $('app').querySelectorAll('[data-ing]').forEach(b=>b.onclick=()=>ingredientModal(b.dataset.ing));
  $('newMenu').onclick=()=>menuModal();$('newUser').onclick=()=>userModal();$('newPromo').onclick=()=>promoModal();
  $('app').querySelectorAll('[data-promo]').forEach(b=>b.onclick=()=>promoModal(b.dataset.promo));
  $('app').querySelectorAll('[data-clockout]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await rpc('clockOut',{id:b.dataset.clockout});await refresh(false);render();notify('Đã chốt tan ca.')}catch(e){b.disabled=false;notify(e.message)}});
  $('app').querySelectorAll('[data-menu]').forEach(b=>b.onclick=()=>menuModal(b.dataset.menu));
  $('app').querySelectorAll('[data-user]').forEach(b=>b.onclick=()=>userModal(b.dataset.user));
}

async function exportBackup(){
  if(S.busy)return;S.busy=true;$('exportBackup').disabled=true;
  try{
    const data=await rpc('exportAll');
    const url=URL.createObjectURL(new Blob([JSON.stringify(data)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='TIEMVIO-sao-luu-'+S.day+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    notify('Đã tải bản sao lưu.');
  }catch(e){notify(e.message)}
  finally{S.busy=false;if($('exportBackup'))$('exportBackup').disabled=false}
}

function menuModal(id){
  const m=S.data.menu.find(m=>m.id===id)||{name:'',category:'Cà phê',priceM:20000,priceL:20000,sizes:{M:20000},active:true,kind:'drink'};
  const curSizes=sizesOf(m);
  openModal(`
    <h2>${id?'Chỉnh sửa món':'Thêm món mới'}</h2>
    <label for="menuName">Tên món</label>
    <input id="menuName" maxlength="70" value="${esc(m.name)}" placeholder="Ví dụ: Cà phê dừa">
    <div class="two">
      <div>
        <label for="menuKind">Phân loại</label>
        <select id="menuKind">
          <option value="drink">Đồ uống</option>
          <option value="topping">Topping</option>
          <option value="food">Đồ ăn vặt</option>
        </select>
      </div>
      <div>
        <label for="menuCategory">Nhóm danh mục</label>
        <select id="menuCategory">
          ${[...new Set([...(S.data.menuCategories||[]),m.category])].map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div id="sizeBlock">
      <label>Kích cỡ bán · bật size nào thì nhập giá size đó</label>
      <div class="row wrap" id="sizeToggles" style="justify-content:flex-start;gap:8px;margin-bottom:10px">
        ${SIZE_LIST.map(z=>`<button type="button" class="small size-toggle ${curSizes[z]!==undefined?'on':''}" data-size="${z}" aria-pressed="${curSizes[z]!==undefined}">${z}</button>`).join('')}
      </div>
      <div class="two" id="sizePrices">
        ${SIZE_LIST.map(z=>`<div data-pricebox="${z}" class="${curSizes[z]!==undefined?'':'hidden'}"><label for="price_${z}">Giá size ${z} (đ)</label><input id="price_${z}" type="number" min="0" max="1000000" step="500" inputmode="numeric" value="${curSizes[z]!==undefined?curSizes[z]:''}" placeholder="Ví dụ: 25000"></div>`).join('')}
      </div>
    </div>
    <div id="toppingPrice" class="hidden">
      <label for="priceTop">Giá bán (đ)</label>
      <input id="priceTop" type="number" min="0" max="1000000" step="500" inputmode="numeric" value="${m.kind==='topping'?m.priceM:''}" placeholder="Ví dụ: 7000">
    </div>
    <label>Ảnh món</label>
    <div class="photo-edit">
      <div class="preview" id="photoPreview">Chưa có ảnh</div>
      <div class="stack" style="gap:8px">
        <button type="button" class="small" id="pickPhoto">Chọn ảnh</button>
        <button type="button" class="small danger hidden" id="removePhoto">Xóa ảnh</button>
        <input type="file" id="photoFile" accept="image/*" class="hidden">
      </div>
    </div>
    <p class="muted" style="font-size:12.5px">Ảnh được tự cắt vuông và thu nhỏ để tải nhanh.</p>
    <label class="check" style="margin-top:14px">
      <input type="checkbox" id="menuActive" ${m.active?'checked':''}> Món đang được mở bán tại quầy
    </label>
    <div id="foodRow" class="hidden">
      <div class="two">
        <div><label for="menuUnit">Đơn vị bán</label><input id="menuUnit" list="unitList" maxlength="16" value="${esc(m.kind==='food'?(m.unit||'phần'):'phần')}" placeholder="phần, cây, viên, lạng"><datalist id="unitList"><option value="phần"><option value="cây"><option value="viên"><option value="lạng"></datalist></div>
        <div><label for="menuPack">Giá tính cho (số đơn vị)</label><input id="menuPack" type="number" min="1" max="100" step="1" value="${m.packQty||1}" inputmode="numeric"></div>
      </div>
      <p class="muted" style="font-size:12.5px">Bán nguyên phần (không bán lẻ): đơn vị <strong>phần</strong>, giá tính cho <strong>1</strong>, ghi chú <strong>4 viên</strong>. Muốn cho nhân viên nhập số viên lẻ: đơn vị <strong>viên</strong>, giá tính cho <strong>4</strong> (6 viên = 15.000đ).</p>
      <label for="menuNote">Một phần gồm (ghi chú, không bắt buộc)</label>
      <input id="menuNote" maxlength="24" value="${esc(m.note||'')}" placeholder="Ví dụ: 4 viên, 2 cây">
      <label class="check"><input type="checkbox" id="menuWeigh" ${m.byWeight?'checked':''}> Bán theo cân nặng (nhân viên nhập số lạng khi tạo đơn, chỉ bán nguyên lạng 1, 2, 3…; giá tính cho 1 lạng)</label>
    </div>
    <label class="check" id="hotRow" style="margin-top:8px">
      <input type="checkbox" id="menuHot" ${m.allowHot?'checked':''}> Có bán nóng (hiện lựa chọn "Nóng" khi bán, không đá)
    </label>
    <div class="modal-foot">
      <button id="saveMenu" class="primary wide">Lưu thông tin món</button>
      <p id="formError" class="error" role="alert" style="margin-top:8px"></p>
    </div>
  `);
  $('menuKind').value=m.kind;$('menuCategory').value=m.category;const syncHot=()=>{const kind=$('menuKind').value,sized=kind!=='topping';$('foodRow').classList.toggle('hidden',kind!=='food');$('hotRow').classList.toggle('hidden',kind!=='drink');$('sizeBlock').classList.toggle('hidden',!sized);$('toppingPrice').classList.toggle('hidden',sized)};$('menuKind').addEventListener('change',syncHot);syncHot();
  $('menuWeigh').onchange=()=>{if($('menuWeigh').checked){$('menuUnit').value='lạng';$('menuPack').value=1}$('menuPack').disabled=$('menuWeigh').checked};$('menuPack').disabled=$('menuWeigh').checked;
  $('sizeToggles').querySelectorAll('[data-size]').forEach(b=>b.onclick=()=>{const on=!b.classList.contains('on');b.classList.toggle('on',on);b.setAttribute('aria-pressed',on);$('sizePrices').querySelector(`[data-pricebox="${b.dataset.size}"]`).classList.toggle('hidden',!on);if(on)$('price_'+b.dataset.size).focus()});
  // pendingPhoto: undefined = unchanged, '' = remove, data URL = new photo.
  let pendingPhoto;
  const showPhoto=()=>{
    const current=pendingPhoto!==undefined?pendingPhoto:(id&&S.images[id])||'';
    $('photoPreview').innerHTML=current?`<img src="${current}" alt="Ảnh món">`:'Chưa có ảnh';
    $('removePhoto').classList.toggle('hidden',!current);
  };
  showPhoto();
  $('pickPhoto').onclick=()=>$('photoFile').click();
  $('photoFile').onchange=async e=>{
    const file=e.target.files&&e.target.files[0];e.target.value='';if(!file)return;
    $('formError').textContent='';
    try{pendingPhoto=await photoToJpeg(file);showPhoto()}catch(err){$('formError').textContent=err.message}
  };
  $('removePhoto').onclick=()=>{pendingPhoto='';showPhoto()};
  const menuSizesFromForm=()=>{
    if($('menuKind').value==='topping')return {M:$('priceTop').value===''?undefined:Number($('priceTop').value)};
    const out={};$('sizeToggles').querySelectorAll('.on').forEach(b=>{const v=$('price_'+b.dataset.size).value;out[b.dataset.size]=v===''?undefined:Number(v)});return out;
  };
  if(id)addDeleteButton('deleteMenu',{id},'món','Món sẽ biến mất khỏi menu, kèm ảnh và công thức. Đơn đã bán vẫn giữ nguyên. Nếu chỉ muốn tạm ngưng bán, hãy tắt "đang bán" thay vì xóa.');
  $('saveMenu').onclick=async()=>{
    const sz=menuSizesFromForm(),filled=Object.values(sz).filter(v=>v!==undefined);
    if(!filled.length)return $('formError').textContent=$('menuKind').value!=='drink'?'Nhập giá bán.':'Hãy bật ít nhất một size và nhập giá cho size đó.';
    if(Object.values(sz).some(v=>v===undefined))return $('formError').textContent='Size đã bật cần có giá. Nhập giá hoặc tắt size đó.';
    $('formError').textContent='';
    S.busy=true;$('saveMenu').disabled=true;
    try{
      const saved=await rpc('saveMenu',{id,name:$('menuName').value,category:$('menuCategory').value,kind:$('menuKind').value,sizes:menuSizesFromForm(),unit:$('menuUnit').value,unitNote:$('menuNote').value,packQty:Number($('menuPack').value||1),byWeight:$('menuWeigh').checked,active:$('menuActive').checked,allowHot:$('menuHot').checked});
      if(pendingPhoto!==undefined&&!(pendingPhoto===''&&!(id&&S.images[id])))await rpc('saveMenuImage',{productId:saved.id,image:pendingPhoto});
      S.busy=false;closeModal();await refresh(false);render();notify('Đã lưu thành công!');
    }catch(err){S.busy=false;if(!S.user)return;$('saveMenu').disabled=false;$('formError').textContent=err.message}
  };
}
// Crops to a square, shrinks and re-encodes as JPEG until it fits in about 45k characters.
function photoToJpeg(file){
  return new Promise((resolve,reject)=>{
    if((file.type||'').indexOf('image/')!==0)return reject(new Error('Hãy chọn một file ảnh.'));
    const url=URL.createObjectURL(file),img=new Image();
    img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('Không đọc được ảnh này. Hãy thử ảnh JPG hoặc PNG khác.'))};
    img.onload=()=>{
      URL.revokeObjectURL(url);
      const side=Math.min(img.naturalWidth,img.naturalHeight),sx=(img.naturalWidth-side)/2,sy=(img.naturalHeight-side)/2;
      for(const size of [360,300,240,180]){
        const canvas=document.createElement('canvas');canvas.width=canvas.height=size;
        const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,size,size);ctx.drawImage(img,sx,sy,side,side,0,0,size,size);
        for(const q of [.82,.7,.58,.46]){const out=canvas.toDataURL('image/jpeg',q);if(out.length<=44000)return resolve(out)}
      }
      reject(new Error('Ảnh quá phức tạp để thu nhỏ. Hãy chọn ảnh khác.'));
    };
    img.src=url;
  });
}

function userModal(email){
  const u=S.data.users.find(u=>u.email===email)||{email:'',name:'',role:'sales',active:true};
  openModal(`
    <h2>${email?'Sửa tài khoản nhân viên':'Thêm nhân viên mới'}</h2>
    <label for="userEmail">Email Google</label>
    <input id="userEmail" type="email" value="${esc(u.email)}" ${email?'disabled':''} placeholder="nhanvien@gmail.com">
    <label for="userName">Tên hiển thị</label>
    <input id="userName" maxlength="60" value="${esc(u.name)}" placeholder="Thu Ngân 01, Nhân viên Minh…">
    <label for="userRole">Vai trò trong cửa hàng</label>
    <select id="userRole">
      <option value="sales">Bán hàng (Order, thu tiền, in bill)</option>
      <option value="owner">Chủ quán (Toàn quyền quản trị & doanh thu)</option>
    </select>
    <label class="check" style="margin-top:14px">
      <input type="checkbox" id="userActive" ${u.active?'checked':''}> Cho phép đăng nhập vào ứng dụng
    </label>
    <div class="modal-foot">
      <button id="saveUser" class="primary wide">Lưu tài khoản</button>
      <p id="formError" class="error" role="alert" style="margin-top:8px"></p>
    </div>
  `);
  $('userRole').value=u.role;
  if(email&&u.role!=='owner')addDeleteButton('deleteUser',{email},'nhân viên','Nhân viên này sẽ không đăng nhập được nữa. Lịch sử bán hàng và chấm công vẫn được giữ.');
  $('saveUser').onclick=()=>submitAdmin('saveUser',{email:$('userEmail').value,name:$('userName').value,role:$('userRole').value,active:$('userActive').checked},'saveUser');
}

function ingredientModal(id){
  const m=S.data.inventory.find(i=>i.id===id)||{name:'',unit:'g',stock:0,minStock:0,active:true};
  openModal(`
    <h2>${id?'Sửa nguyên liệu':'Thêm nguyên liệu mới'}</h2>
    <label for="ingName">Tên nguyên liệu</label>
    <input id="ingName" maxlength="60" value="${esc(m.name)}" placeholder="Trà đen, Sữa tươi, Trân châu…">
    <div class="two">
      <div>
        <label for="ingUnit">Đơn vị đo</label>
        <input id="ingUnit" maxlength="12" value="${esc(m.unit)}" placeholder="g, ml, cái, kg">
      </div>
      <div>
        <label for="ingMin">Mức tồn tối thiểu</label>
        <input id="ingMin" type="number" min="0" step="any" value="${m.minStock}">
      </div>
    </div>
    <label for="ingCost">Giá vốn mỗi đơn vị (đ) · chỉ chủ quán thấy</label>
    <input id="ingCost" type="number" min="0" step="any" value="${m.cost||0}" inputmode="decimal" placeholder="Ví dụ: 0.2 đ/g trà, 45 đ/ml sữa">
    ${id?'':`<label for="ingStock">Số lượng tồn ban đầu</label><input id="ingStock" type="number" min="0" step="any" value="0">`}
    <label class="check" style="margin-top:14px">
      <input type="checkbox" id="ingActive" ${m.active?'checked':''}> Nguyên liệu đang được sử dụng
    </label>
    <div class="modal-foot">
      <button id="saveIng" class="primary wide">Lưu nguyên liệu</button>
      <p id="formError" class="error" role="alert" style="margin-top:8px"></p>
    </div>
  `);
  if(id)addDeleteButton('deleteIngredient',{id},'nguyên liệu','Nguyên liệu sẽ bị gỡ khỏi kho và khỏi mọi công thức đang dùng nó. Lịch sử kho vẫn giữ.');
  $('saveIng').onclick=()=>submitAdmin('saveIngredient',{id,name:$('ingName').value,unit:$('ingUnit').value,minStock:Number($('ingMin').value),cost:Number($('ingCost').value||0),stock:$('ingStock')?Number($('ingStock').value):undefined,active:$('ingActive').checked},'saveIng');
}

function stockModal(id){
  const m=S.data.inventory.find(i=>i.id===id);if(!m)return;
  openModal(`
    <h2>Điều chỉnh kho: ${esc(m.name)}</h2>
    <p class="muted" style="margin-top:4px">Tồn hiện tại: <strong style="color:var(--green)">${m.stock} ${esc(m.unit)}</strong></p>
    <label for="stockDelta">Số lượng thay đổi (+ nhập hàng, − xuất kho / hao hụt)</label>
    <input id="stockDelta" type="number" step="any" placeholder="Ví dụ: 1000 hoặc -50">
    <label for="stockReason">Lý do điều chỉnh (bắt buộc, lưu vào lịch sử kho)</label>
    <input id="stockReason" maxlength="80" placeholder="Nhập hàng sáng, kiểm kê cuối ngày, đổ bỏ…">
    <div class="modal-foot">
      <button id="saveStock" class="primary wide">Cập nhật kho</button>
      <p id="formError" class="error" role="alert" style="margin-top:8px"></p>
    </div>
  `);
  $('saveStock').onclick=()=>submitAdmin('adjustStock',{id,delta:Number($('stockDelta').value),reason:$('stockReason').value},'saveStock');
}

function recipeModal(productId,size='M'){
  const m=S.data.menu.find(i=>i.id===productId);if(!m)return;
  if(!S.data.inventory.length)return notify('Hãy thêm nguyên liệu trước khi tạo công thức.');
  const key=productId+(size&&size!=='M'?'@'+size:'');
  const cur=S.data.recipes.filter(r=>r.productId===key);
  openModal(`
    <h2>Công thức định lượng: ${esc(m.name)}</h2>
    <label for="recipeSize">Size áp dụng</label>
    <select id="recipeSize">
      <option value="M">Công thức tiêu chuẩn (dùng cho mọi size chưa có công thức riêng)</option>
      ${sizeKeys(m).filter(z=>z!=='M').map(z=>`<option value="${z}">Ghi đè định lượng riêng cho size ${z}</option>`).join('')}
    </select>
    <p class="muted" style="font-size:12.5px;margin:6px 0 14px">Khi bán 1 ly, kho nguyên liệu sẽ tự động trừ đúng định lượng này.</p>
    <div style="background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:8px 14px">
      ${S.data.inventory.filter(i=>i.active).map(i=>`
        <div class="row" style="padding:8px 0;border-bottom:1px solid var(--line-subtle)">
          <span class="grow">${esc(i.name)} (${esc(i.unit)})</span>
          <input type="number" min="0" step="0.01" style="max-width:110px;min-height:38px" aria-label="Định lượng ${esc(i.name)} (${esc(i.unit)})" data-ing="${esc(i.id)}" value="${cur.find(r=>r.ingredientId===i.id)?.qty||''}" placeholder="0">
        </div>
      `).join('')}
    </div>
    <div class="modal-foot">
      <button id="saveRecipe" class="primary wide">Lưu công thức định lượng</button>
      <p id="formError" class="error" role="alert" style="margin-top:8px"></p>
    </div>
  `);
  $('recipeSize').value=size;$('recipeSize').onchange=()=>recipeModal(productId,$('recipeSize').value);
  $('saveRecipe').onclick=()=>submitAdmin('saveRecipe',{productId,size,lines:Array.from($('modal').querySelectorAll('input[data-ing]')).filter(e=>Number(e.value)>0).map(e=>({ingredientId:e.dataset.ing,qty:Number(e.value)}))},'saveRecipe');
}

function promoModal(id){
  const x=S.data.promos.find(p=>p.id===id)||{name:'',type:'percent',value:10,minTotal:0,startHour:0,endHour:24,active:true};
  const hours=(sel)=>Array.from({length:25},(_,h)=>`<option value="${h}" ${h===sel?'selected':''}>${h}h</option>`).join('');
  openModal(`
    <h2>${id?'Sửa khuyến mãi':'Thêm khuyến mãi'}</h2>
    <label for="promoName">Tên khuyến mãi</label>
    <input id="promoName" maxlength="40" value="${esc(x.name)}" placeholder="Giờ vàng, Sinh viên, Khai trương…">
    <div class="two">
      <div><label for="promoType">Kiểu giảm</label><select id="promoType"><option value="percent">Theo phần trăm (%)</option><option value="amount">Theo số tiền (đ)</option></select></div>
      <div><label for="promoValue">Mức giảm</label><input id="promoValue" type="number" min="1" inputmode="numeric" value="${x.value}"></div>
    </div>
    <p class="muted" style="font-size:12.5px">Giới hạn: tối đa ${S.data.promoLimits.maxPercent}% hoặc ${money(S.data.promoLimits.maxAmount)} mỗi đơn.</p>
    <label for="promoMin">Đơn tối thiểu (đ, 0 = không yêu cầu)</label>
    <input id="promoMin" type="number" min="0" step="1000" inputmode="numeric" value="${x.minTotal||0}">
    <div class="two">
      <div><label for="promoFrom">Từ giờ</label><select id="promoFrom">${hours(x.startHour)}</select></div>
      <div><label for="promoTo">Đến giờ</label><select id="promoTo">${hours(x.endHour)}</select></div>
    </div>
    <label class="check" style="margin-top:14px"><input type="checkbox" id="promoActive" ${x.active?'checked':''}> Đang áp dụng</label>
    <div class="modal-foot">
      <button id="savePromo" class="primary wide">Lưu khuyến mãi</button>
      <p id="formError" class="error" role="alert" style="margin-top:8px"></p>
    </div>
  `);
  $('promoType').value=x.type;
  if(id)addDeleteButton('deletePromo',{id},'khuyến mãi','Khuyến mãi sẽ không còn để chọn khi thanh toán. Đơn đã bán vẫn giữ nguyên.');
  $('savePromo').onclick=()=>submitAdmin('savePromo',{id,name:$('promoName').value,type:$('promoType').value,value:Number($('promoValue').value),minTotal:Number($('promoMin').value||0),startHour:Number($('promoFrom').value),endHour:Number($('promoTo').value),active:$('promoActive').checked},'savePromo');
}

function expenseModal(){
  openModal(`
    <h2>Thêm chi phí vận hành</h2>
    <label for="expCat">Danh mục chi</label>
    <input id="expCat" maxlength="30" list="expCats" placeholder="Nguyên liệu, mặt bằng, điện nước, lương…">
    <datalist id="expCats">
      <option>Nguyên liệu</option>
      <option>Mặt bằng</option>
      <option>Lương nhân viên</option>
      <option>Điện nước & Internet</option>
      <option>Dụng cụ & Đồ dùng</option>
      <option>Khác</option>
    </datalist>
    <label for="expAmount">Số tiền chi (đ)</label>
    <input id="expAmount" type="number" min="1" inputmode="numeric" placeholder="Ví dụ: 150000">
    <label for="expNote">Ghi chú chi tiết</label>
    <input id="expNote" maxlength="120" placeholder="Mua đá viên, mua túi nilon…">
    <div class="modal-foot">
      <button id="saveExp" class="primary wide">Ghi nhận chi phí</button>
      <p id="formError" class="error" role="alert" style="margin-top:8px"></p>
    </div>
  `);
  const key=uid();
  $('saveExp').onclick=async()=>{
    S.busy=true;$('saveExp').disabled=true;
    try{await rpc('saveExpense',{requestKey:key,category:$('expCat').value,amount:Number($('expAmount').value),note:$('expNote').value});S.busy=false;closeModal();notify('Đã lưu chi phí');if(S.view==='report')renderReport()}
    catch(e){S.busy=false;if(!S.user)return;$('saveExp').disabled=false;$('formError').textContent=e.message}
  };
}

function reasonsModal(field,action,title,example,hint){
  openModal(`
    <h2>${title}</h2>
    <p class="muted" style="margin-top:4px">Mỗi dòng một lý do. ${hint}</p>
    <label for="reasonList">Danh sách lý do</label>
    <textarea id="reasonList" rows="8" maxlength="900" placeholder="${example}">${esc((S.data[field]||[]).join('\n'))}</textarea>
    <p class="muted" style="font-size:12.5px">Tối đa 20 lý do, mỗi lý do 3–40 ký tự. Đơn cũ giữ nguyên lý do đã ghi.</p>
    <div class="modal-foot">
      <button id="saveReasons" class="primary wide">Lưu danh sách</button>
      <p id="formError" class="error" role="alert" style="margin-top:8px"></p>
    </div>
  `);
  $('saveReasons').onclick=()=>submitAdmin(action,{reasons:$('reasonList').value.split('\n')},'saveReasons');
}

// Editor for the ice / sugar choices: one row per choice (name, optional % for sugar, extra price); the first row is the default.
function optionsModal(kind){
  const sugar=kind==='sugar',rows=(sugar?sugarList():iceList()).map(o=>({...o}));
  const draw=()=>{
    $('optRows').innerHTML=rows.map((o,i)=>`
      <div class="card" style="padding:10px 12px;margin-top:8px">
        <div class="row" style="gap:8px"><strong>${i===0?'Mặc định':'Lựa chọn '+(i+1)}</strong>
          <span><button type="button" class="small" data-up="${i}" ${i===0?'disabled':''} aria-label="Lên">↑</button> <button type="button" class="small" data-down="${i}" ${i===rows.length-1?'disabled':''} aria-label="Xuống">↓</button> <button type="button" class="small danger" data-del="${i}" ${rows.length<=1?'disabled':''} aria-label="Xóa">✕</button></span></div>
        <label>Tên</label><input data-f="name" data-i="${i}" maxlength="24" value="${esc(o.name)}">
        <div class="two">
          ${sugar?`<div><label>Phần trăm đường</label><input data-f="percent" data-i="${i}" type="number" min="0" max="200" inputmode="numeric" value="${o.percent}"></div>`:''}
          <div><label>Giá thêm (đ)</label><input data-f="price" data-i="${i}" type="number" min="0" max="50000" step="500" inputmode="numeric" value="${o.price||0}"></div>
        </div>
      </div>`).join('');
    $('optRows').querySelectorAll('[data-f]').forEach(e=>e.oninput=()=>{rows[+e.dataset.i][e.dataset.f]=e.dataset.f==='name'?e.value:e.value===''?'':Number(e.value)});
    $('optRows').querySelectorAll('[data-up]').forEach(b=>b.onclick=()=>{const i=+b.dataset.up;[rows[i-1],rows[i]]=[rows[i],rows[i-1]];draw()});
    $('optRows').querySelectorAll('[data-down]').forEach(b=>b.onclick=()=>{const i=+b.dataset.down;[rows[i+1],rows[i]]=[rows[i],rows[i+1]];draw()});
    $('optRows').querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{rows.splice(+b.dataset.del,1);draw()});
    $('optAdd').disabled=rows.length>=8;
  };
  openModal(`
    <h2>${sugar?'Lượng đường':'Lượng đá'}</h2>
    <p class="muted" style="margin-top:4px">Đây là các lựa chọn nhân viên thấy khi chọn món. Lựa chọn đầu tiên là mặc định. Nhập <strong>giá thêm</strong> nếu khách phải trả thêm (ví dụ "Thêm đá" +3.000đ); để 0 nếu không tính thêm. Tối đa 8 lựa chọn.</p>
    <div id="optRows"></div>
    <button id="optAdd" type="button" class="small soft" style="margin-top:10px">+ Thêm lựa chọn</button>
    <p class="muted" style="font-size:12.5px;margin-top:10px">Đơn đã bán giữ nguyên tên và giá lúc bán. Lựa chọn bị xóa không còn bán được; giỏ đang giữ sẽ tự chuyển về lựa chọn mặc định.</p>
    <div class="modal-foot">
      <button id="optSave" class="primary wide">Lưu</button>
      ${''}<button id="optReset" type="button" class="wide" style="margin-top:8px">Đặt lại về mặc định</button>
      <p id="formError" class="error" role="alert" style="margin-top:8px"></p>
    </div>`);
  draw();
  $('optAdd').onclick=()=>{rows.push(sugar?{id:'',name:'',percent:100,price:0}:{id:'',name:'',price:0});draw();const last=$('optRows').querySelector('[data-f="name"][data-i="'+(rows.length-1)+'"]');last&&last.focus()};
  $('optReset').onclick=()=>{rows.length=0;(sugar?[100,70,50,30,0].map(n=>({id:String(n),name:n+'% đường',percent:n,price:0})):[{id:'normal',name:'Đá vừa',price:0},{id:'less',name:'Ít đá',price:0},{id:'none',name:'Không đá',price:0},{id:'extra',name:'Thêm đá',price:0}]).forEach(o=>rows.push(o));draw()};
  $('optSave').onclick=()=>submitAdmin(sugar?'saveSugarOptions':'saveIceOptions',{options:rows.map(o=>({id:o.id,name:o.name,price:o.price,percent:o.percent}))},'optSave');
}

function categoriesModal(){
  openModal(`
    <h2>Phân loại món</h2>
    <p class="muted" style="margin-top:4px">Mỗi dòng một phân loại, hiện thành các nút lọc ở màn bán hàng theo đúng thứ tự này. Ví dụ thêm "Đồ ăn vặt" để bán snack (khi thêm món chọn loại "Đồ ăn vặt": không có đường, đá, topping).</p>
    <label for="categoryList">Danh sách phân loại</label>
    <textarea id="categoryList" rows="10" maxlength="900">${esc((S.data.menuCategories||[]).join('\n'))}</textarea>
    <p class="muted" style="font-size:12.5px">Không xóa được phân loại còn món đang thuộc về nó: hãy chuyển món sang phân loại khác trước. Tối đa 30 phân loại.</p>
    <div class="modal-foot">
      <button id="saveCategories" class="primary wide">Lưu phân loại</button>
      <p id="formError" class="error" role="alert" style="margin-top:8px"></p>
    </div>
  `);
  $('saveCategories').onclick=()=>submitAdmin('saveMenuCategories',{categories:$('categoryList').value.split('\n')},'saveCategories');
}

const fmtBytes=n=>n>=1073741824?(n/1073741824).toFixed(2)+' GB':n>=1048576?(n/1048576).toFixed(1)+' MB':Math.max(1,Math.round(n/1024))+' KB';
async function storageModal(){
  openModal(`<h2>Dung lượng Firebase</h2><p id="stInfo" class="muted">Đang tính dung lượng…</p><div id="stBody"></div>`);
  let u;
  try{u=await rpc('storageUsage',{})}catch(e){$('stInfo').textContent=e.message;return}
  const pct=Math.min(100,u.usedBytes/u.quotaBytes*100);
  const rows=u.collections.filter(r=>r.count).sort((a,b)=>b.bytes-a.bytes);
  $('stInfo').remove();
  $('stBody').innerHTML=`
    <div class="card" style="margin:10px 0">
      <div class="row"><span>Đã dùng (ước tính)</span><strong>${fmtBytes(u.usedBytes)}</strong></div>
      <div class="row" style="margin-top:4px"><span>Còn lại</span><strong style="color:var(--green)">${fmtBytes(u.freeBytes)}</strong></div>
      <div style="height:10px;background:#eadfce;border-radius:6px;margin:10px 0 6px;overflow:hidden"><div style="height:100%;width:${Math.max(1.5,pct).toFixed(1)}%;background:${pct>80?'#a32020':pct>50?'#d38b1f':'#3a7d44'}"></div></div>
      <div class="muted" style="font-size:12.5px">${pct.toFixed(2)}% của 1 GB miễn phí. Đây là số ước tính từ số lượng và kích thước dữ liệu; Firebase không cung cấp số chính xác cho ứng dụng. Mức đọc/ghi mỗi ngày (50.000 đọc, 20.000 ghi) xem trong Firebase Console → Usage.</div>
    </div>
    <details style="margin-bottom:12px"><summary class="muted" style="cursor:pointer">Chi tiết theo loại dữ liệu</summary>
      ${rows.map(r=>`<div class="row" style="margin-top:6px;font-size:13.5px"><span>${esc(r.label)} <span class="muted">(${r.count})</span></span><span>${fmtBytes(r.bytes)}</span></div>`).join('')}
    </details>
    <h3>Xóa dữ liệu cũ</h3>
    <p class="muted" style="font-size:12.5px;margin:4px 0 8px">Luôn giữ lại ít nhất 30 ngày gần nhất. Đơn chưa hoàn tất, chưa đối soát, ca đang mở và người đang chấm công không bao giờ bị xóa. Thực đơn, công thức, kho, khuyến mãi, khách hàng, nhân viên và báo cáo doanh thu theo ngày được giữ nguyên.</p>
    <label for="keepDays">Giữ lại bao nhiêu ngày gần nhất (tối thiểu 30)</label>
    <input id="keepDays" type="number" min="30" max="3650" step="1" inputmode="numeric" value="30">
    <label class="check" style="margin-top:10px"><input type="checkbox" id="kOrders" checked> Đơn hàng mua bán cũ</label>
    <label class="check"><input type="checkbox" id="kClock" checked> Giờ làm của nhân viên (chấm công) cũ</label>
    <label class="check"><input type="checkbox" id="kExp" checked> Chi phí cũ <span class="muted" style="font-size:12px">(lợi nhuận các ngày đó sẽ không còn trừ chi phí)</span></label>
    <label class="check"><input type="checkbox" id="kOther"> Khác: ca tiền mặt, lịch sử kho, bộ đếm số đơn cũ</label>
    <div class="row" style="gap:8px;margin-top:12px"><button id="stBackup" type="button" class="small">📥 Tải bản sao lưu trước</button><button id="stPreview" type="button" class="small soft">Xem trước sẽ xóa gì</button></div>
    <p id="stResult" class="muted" style="font-size:13px;margin-top:10px"></p>
    <div class="modal-foot"><p id="formError" class="error" role="alert"></p></div>`;
  const args=()=>({keepDays:Number($('keepDays').value),kinds:[['kOrders','orders'],['kClock','timeclock'],['kExp','expenses'],['kOther','other']].filter(([id])=>$(id).checked).map(([,k])=>k)});
  const names={orders:'đơn hàng',timeclock:'lượt chấm công',expenses:'khoản chi',shifts:'ca tiền mặt',stockLog:'dòng lịch sử kho',counters:'bộ đếm'};
  $('stBackup').onclick=()=>exportBackup&&exportBackup();
  $('stPreview').onclick=async()=>{
    $('formError').textContent='';$('stResult').textContent='Đang kiểm tra…';const old=$('stDelete');if(old)old.remove();
    try{
      const r=await rpc('cleanupOldData',{...args(),dryRun:true});
      if(!r.total){$('stResult').textContent='Không có dữ liệu nào cũ hơn '+r.keepDays+' ngày (trước '+fmtDate(r.before)+') để xóa.';return}
      $('stResult').innerHTML='Sẽ xóa <strong>'+r.total+'</strong> mục cũ hơn '+r.keepDays+' ngày (trước '+esc(fmtDate(r.before))+'): '+Object.entries(r.counts).filter(([,n])=>n).map(([k,n])=>n+' '+names[k]).join(', ')+'. Không thể khôi phục.';
      const b=document.createElement('button');b.id='stDelete';b.type='button';b.className='wide';b.style.cssText='margin-top:10px;color:#a32020;border-color:#e3b4b4';b.textContent='🗑 Xóa '+r.total+' mục';
      let armed=false,t=null;
      b.onclick=async()=>{
        if(!armed){armed=true;b.textContent='Bấm lần nữa để xóa vĩnh viễn';b.style.background='#a32020';b.style.color='#fff';t=setTimeout(()=>{armed=false;b.textContent='🗑 Xóa '+r.total+' mục';b.style.background='';b.style.color='#a32020'},6000);return}
        clearTimeout(t);b.disabled=true;$('stResult').textContent='Đang xóa…';
        try{const d=await rpc('cleanupOldData',{...args(),dryRun:false});b.remove();$('stResult').textContent='✔ Đã xóa '+d.total+' mục. Hãy mở lại cửa sổ này để xem dung lượng mới.';await refresh(false)}
        catch(e){b.disabled=false;$('formError').textContent=e.message;$('stResult').textContent=''}
      };
      $('stResult').after(b);
    }catch(e){$('stResult').textContent='';$('formError').textContent=e.message}
  };
}

// The orders one person collected in the date range chosen on the revenue screen.
async function staffSalesModal(email,name){
  const rg=S.report||{from:S.day,to:S.day};
  openModal(`<h2>${esc(name)}</h2><p class="muted" id="ssInfo">Đang tải các đơn…</p><div id="ssBody"></div><div class="modal-foot"><button id="ssClose" class="primary wide">Đóng</button></div>`);
  $('ssClose').onclick=closeModal;
  let r;
  try{r=await rpc('staffOrders',{email,from:rg.from,to:rg.to})}
  catch(e){$('ssInfo').textContent=/index|chỉ mục/i.test(e.message)?'Hệ thống đang tạo chỉ mục cho tính năng này, hãy thử lại sau vài phút.':e.message;return}
  const range=r.from===r.to?planDMY(r.from):planDMY(r.from)+' → '+planDMY(r.to);
  $('ssInfo').innerHTML=`${range} · <strong>${r.count} đơn</strong> · <strong style="color:var(--green)">${money(r.total)}</strong>${r.refunded?` · ${r.refunded} đơn đã hoàn tiền (không tính)`:''}`;
  $('ssBody').innerHTML=r.orders.map(o=>`
    <div class="card" style="margin-top:8px;padding:12px 14px;${o.status==='cancelled'?'opacity:.7':''}">
      <div class="row"><strong>${o.seq?'#'+o.seq:'#'+esc(String(o.id).slice(-6).toUpperCase())}${o.status==='cancelled'?' <span class="badge cancelled">Đã hoàn tiền</span>':''}</strong><strong style="color:var(--green)">${money(o.total)}</strong></div>
      <div class="muted" style="font-size:12.5px;margin-top:2px">Thu lúc ${esc(fmtDateTime(o.paidAt))} · ${esc(payText(o))}${o.customer?' · '+esc(o.customer):''}${o.channel&&o.channel!=='store'?' · '+esc(channelName(o.channel)):''}</div>
      <div style="font-size:13.5px;margin-top:6px">${o.items.map(i=>`${esc(qtyLabel(i))} × ${esc(i.name)}`).join(', ')}</div>
      ${o.creatorName&&o.creatorName!==o.paidByName?`<div class="muted" style="font-size:12.5px;margin-top:2px">Tạo đơn: ${esc(o.creatorName)} lúc ${esc(fmtDateTime(o.createdAt))}</div>`:''}
      ${o.stop?`<div style="font-size:12.5px;color:#8a1f1f;margin-top:4px">${o.stop.kind==='refund'?'Hoàn tiền':'Hủy'}${o.stop.reason?': '+esc(o.stop.reason):''}</div>`:''}
    </div>`).join('')||'<div class="card empty">Không có đơn nào trong khoảng thời gian này.</div>';
}

function legalModal(){
  openModal(`
    <h2>Giấy phép và miễn trừ trách nhiệm</h2>
    <p class="muted" style="font-size:12.5px;margin-top:4px">Cập nhật ${LEGAL_UPDATED} · phiên bản ứng dụng ${esc(typeof __APP_VERSION__==='string'?__APP_VERSION__:'')}</p>
    <p class="notice">Phần mềm POS hiện chưa phát hành hóa đơn điện tử kết nối cơ quan thuế. Điều khoản không thay hồ sơ tuân thủ hoặc hợp đồng dịch vụ riêng.</p>
    <p><a href="/legal.txt" target="_blank" rel="noopener" download="Tiemvio-POS-Dieu-khoan-${LEGAL_VERSION}.txt">Tải toàn bộ điều khoản (.txt)</a></p>
    <details style="margin-top:12px"><summary>Mục lục · ${LEGAL_SECTIONS.length} mục</summary><ol>${LEGAL_SECTIONS.map(([t],i)=>`<li><a href="#legal-${i}">${esc(t.replace(/^\d+\.\s*/,''))}</a></li>`).join('')}</ol></details>
    ${LEGAL_SECTIONS.map(([t,ps],i)=>`<h3 id="legal-${i}" style="margin:16px 0 6px">${esc(t)}</h3>${ps.map(p=>`<p style="font-size:13.5px;line-height:1.5;margin-top:6px">${esc(p)}</p>`).join('')}`).join('')}
    <h3 style="margin-top:20px">Nguồn pháp luật chính thức đã đối chiếu</h3><ul>${LEGAL_SOURCES.map(([title,url])=>`<li style="margin-top:8px"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(title)}</a></li>`).join('')}</ul>
    <p class="muted" style="font-size:12px">Đã đọc chỉ đóng tài liệu, không thay thế việc giao kết hợp đồng hoặc xin đồng ý xử lý dữ liệu.</p>
    <div class="modal-foot"><button id="legalClose" class="primary wide">Đã đọc</button></div>
  `);
  $('legalClose').onclick=closeModal;
}

function bankModal(){
  const b=S.data.bank||{bin:'',account:'',name:''};
  openModal(`
    <h2>Tài khoản VietQR nhận chuyển khoản</h2>
    <p class="muted" style="margin-top:4px">Hệ thống tạo mã VietQR động theo số tiền của từng đơn để khách quét mã nhanh.</p>
    <div class="card" style="margin:12px 0;background:var(--paper)">
      <strong>Cách nhanh nhất: tải lên mã QR nhận tiền của bạn</strong>
      <p class="muted" style="font-size:12.5px;margin:4px 0 10px">Chọn ảnh mã QR từ app ngân hàng (ảnh chụp màn hình cũng được). App tự đọc mã ngân hàng và số tài khoản, bạn chỉ cần kiểm tra rồi lưu.</p>
      <input type="file" id="qrFile" accept="image/*" class="hidden">
      <button id="qrPick" type="button" class="small soft">📷 Tải lên mã QR</button>
      <p id="qrInfo" class="muted" style="font-size:12.5px;margin-top:8px"></p>
    </div>
    <label for="bankBin">Mã BIN ngân hàng (6 số)</label>
    <input id="bankBin" inputmode="numeric" maxlength="6" value="${esc(b.bin)}" placeholder="970436 (Vietcombank), 970422 (MBBank)…">
    <label for="bankAccount">Số tài khoản ngân hàng</label>
    <input id="bankAccount" maxlength="30" autocapitalize="off" spellcheck="false" value="${esc(b.account)}" placeholder="Ví dụ: 1029384756">
    <label for="bankName">Tên chủ tài khoản (in hoa không dấu)</label>
    <input id="bankName" maxlength="50" value="${esc(b.name)}" placeholder="NGUYEN VAN A">
    <div class="modal-foot">
      <button id="saveBank" class="primary wide">Lưu thông tin ngân hàng</button>
      <p id="formError" class="error" role="alert" style="margin-top:8px"></p>
    </div>
  `);
  $('qrPick').onclick=()=>$('qrFile').click();
  $('qrFile').onchange=async e=>{
    const f=e.target.files&&e.target.files[0];e.target.value='';if(!f)return;
    $('formError').textContent='';$('qrInfo').textContent='Đang đọc mã QR…';
    try{
      const r=parseVietQR(await readQrFromImage(f));
      $('bankBin').value=r.bin;$('bankAccount').value=r.account;if(r.name)$('bankName').value=r.name;
      $('qrInfo').textContent='✔ Đã đọc: ngân hàng '+r.bin+' · số tài khoản '+r.account+(r.name?' · '+r.name:'')+'. Hãy kiểm tra '+(r.name?'':'và nhập tên chủ tài khoản, ')+'rồi bấm Lưu.'+(r.hasAmount?' (Mã có sẵn số tiền, app bỏ qua số tiền này.)':'')+(r.alias?' ℹ Ngân hàng này (ví dụ MB) ghi mã định danh thay cho số tài khoản trong mã QR. App dùng đúng mã đó, giống hệt mã QR gốc của ngân hàng nên khách vẫn chuyển đúng tài khoản của bạn. Bạn nhập tên chủ tài khoản nếu ô tên còn trống.':'')+(r.crcWarning?' ⚠ Mã kiểm tra của mã QR không khớp, hãy so lại số tài khoản với app ngân hàng trước khi lưu.':'');
    }catch(err){$('qrInfo').textContent='';$('formError').textContent=err.message}
  };
  $('saveBank').onclick=()=>submitAdmin('saveSettings',{bankBin:$('bankBin').value,bankAccount:$('bankAccount').value,bankName:$('bankName').value},'saveBank');
}

// Two-step delete button added to the foot of an edit modal: first tap asks, second tap deletes.
function addDeleteButton(action,data,what,note){
  const foot=document.querySelector('.modal-foot');if(!foot)return;
  const b=document.createElement('button');b.type='button';b.className='wide';b.id='deleteBtn';b.style.cssText='margin-top:10px;color:#a32020;border-color:#e3b4b4';b.textContent='🗑 Xóa '+what;
  let armed=false,timer=null;
  b.onclick=async()=>{
    if(!armed){armed=true;b.textContent='Bấm lần nữa để xóa '+what;b.style.background='#a32020';b.style.color='#fff';
      const n=document.createElement('p');n.id='deleteNote';n.className='muted';n.style.cssText='font-size:12.5px;margin-top:6px';n.textContent=note;b.after(n);
      timer=setTimeout(()=>{armed=false;b.textContent='🗑 Xóa '+what;b.style.background='';b.style.color='#a32020';n.remove()},6000);return}
    clearTimeout(timer);if(S.busy)return;S.busy=true;b.disabled=true;
    try{await rpc(action,data);S.busy=false;closeModal();await refresh(false);render();notify('Đã xóa '+what+'.')}
    catch(e){S.busy=false;if(!S.user)return;b.disabled=false;$('formError').textContent=e.message}
  };
  foot.appendChild(b);
}

async function submitAdmin(action,data,button){
  S.busy=true;$(button).disabled=true;
  try{await rpc(action,data);S.busy=false;closeModal();await refresh(false);render();notify('Đã lưu thành công!')}
  catch(e){S.busy=false;if(!S.user)return;$(button).disabled=false;$('formError').textContent=e.message}
}

function saveDraftState(cart,held){
  const oldCart=S.cart,oldHeld=S.held;S.cart=cart;S.held=held;
  if(persistCart())return true;
  S.cart=oldCart;S.held=oldHeld;notify('Không lưu được giỏ trên thiết bị. Giữ nguyên giỏ để tránh mất đơn.');return false;
}

function heldModal(){
  if(S.editing)return notify('Đang sửa đơn: hãy lưu hoặc hủy sửa trước khi giữ hoặc mở giỏ khác.');
  if(S.busy||S.pending)return notify('Hãy xác nhận đơn đang chờ trước.');
  openModal(`
    <h2>Giỏ hàng đang giữ (${S.held.length}/10)</h2>
    <p class="muted" style="margin-top:4px">Giữ giỏ tạm thời khi khách đang chờ chọn món hoặc chưa thanh toán, để phục vụ khách tiếp theo.</p>
    ${S.cart.length?`
      <div style="background:var(--mint-subtle);border:1px solid #e4cfbd;border-radius:14px;padding:12px;margin:14px 0">
        <label for="holdName" style="margin:0 0 6px">Tên khách / Bàn để ghi nhớ</label>
        <input id="holdName" maxlength="60" placeholder="Bàn 2, Khách áo xanh…">
        <button id="holdCurrent" class="primary wide" style="margin-top:10px">Giữ giỏ hiện tại, phục vụ khách tiếp</button>
      </div>
    `:''}
    <div class="stack" style="margin-top:14px">
      ${S.held.map(h=>`
        <div class="card row">
          <div>
            <strong>${esc(h.name)}</strong>
            <p class="muted" style="font-size:12.5px">${itemsCount(h.items)} món · ${new Date(h.at).toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'})}</p>
          </div>
          <div style="display:flex;gap:6px">
            <button class="small soft" data-resume="${esc(h.id)}">Mở lại</button>
            <button class="small danger" data-discard="${esc(h.id)}">Bỏ giỏ</button>
          </div>
        </div>
      `).join('')||'<p class="empty">Chưa có giỏ nào đang giữ.</p>'}
    </div>
  `);

  if($('holdCurrent'))$('holdCurrent').onclick=()=>{
    if(S.held.length>=10)return notify('Đã đủ 10 giỏ. Hãy xử lý bớt trước.');
    const held=S.held.concat({id:uid(),name:$('holdName').value.trim()||'Khách đang chờ',at:new Date().toISOString(),items:JSON.parse(JSON.stringify(S.cart))});
    if(saveDraftState([],held)){closeModal();render();notify('Đã giữ giỏ trên thiết bị này.');}
  };
  $('modal').querySelectorAll('[data-discard]').forEach(b=>b.onclick=()=>{
    const id=b.dataset.discard,h=S.held.find(x=>x.id===id);if(!h)return;
    openModal(`
      <h2>Bỏ giỏ đang giữ?</h2>
      <p style="margin-top:6px">${esc(h.name)}</p>
      <p class="muted" style="margin:6px 0 16px">Giỏ chưa thanh toán này sẽ được xóa khỏi thiết bị.</p>
      <button id="confirmDiscard" class="danger wide">Xác nhận bỏ giỏ này</button>
    `);
    $('confirmDiscard').onclick=()=>{if(saveDraftState(S.cart,S.held.filter(x=>x.id!==id))){closeModal();render();}};
  });
  $('modal').querySelectorAll('[data-resume]').forEach(b=>b.onclick=()=>{
    if(S.cart.length)return notify('Hãy giữ hoặc hoàn tất giỏ hiện tại trước khi mở giỏ khác.');
    const h=S.held.find(x=>x.id===b.dataset.resume);if(!h)return;
    let items;try{items=h.items.map(i=>{
      const product=S.data.menu.find(m=>m.id===i.productId),tops=(i.toppings||[]).map(id=>S.data.menu.find(m=>m.id===id));
      if(!product||!product.active||sizesOf(product)[i.size]===undefined||tops.some(t=>!t||!t.active))throw new Error('Có món/topping ngừng bán');
      const sg=sugarList().find(o=>o.id===i.sugarId)||sugarList().find(o=>o.percent===i.sugar)||sugarList()[0],ic=iceList().find(o=>o.id===i.ice)||iceList()[0],hot=i.temp==='hot',fd=product.kind==='food';
      return {...i,name:product.name,sugar:sg.percent,sugarId:sg.id,sugarName:sg.name,sugarPrice:sg.price||0,ice:hot?'none':ic.id,iceName:hot?'':ic.name,icePrice:hot?0:(ic.price||0),unitPrice:Number(sizesOf(product)[i.size])+(fd?0:(sg.price||0)+(hot?0:(ic.price||0)))+tops.reduce((n,t)=>n+Number(t.priceM),0)};
    });}catch(e){return notify('Có món/topping đã ngừng bán. Giỏ đang giữ được giữ nguyên.');}
    if(saveDraftState(items,S.held.filter(x=>x.id!==h.id))){closeModal();render();notify('Đã mở lại giỏ với giá menu hiện tại.');}
  });
}

$('cartbar').onclick=cartModal;
$('bell').onclick=pushModal;$('viewAs').onclick=viewAsModal;
$('logout').onclick=async()=>{try{await window.tiemvioBackend.signOut()}catch(e){}endSession()};
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&S.token)refresh(S.view!=='sales'&&S.view!=='admin')});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal()});
window.addEventListener('offline',()=>connection('Mất mạng · Đơn chưa gửi được giữ trên máy',true));
window.addEventListener('online',()=>{if(S.token){connection('Đã kết nối · '+labels[S.user.role]);refresh()}});

async function init(){
  const auth=await window.tiemvioBackend.init();
  if(auth.signedIn){S.token='firebase';await start()}else loginScreen(auth.error||'');
}
init();
$('reloadUpdate').onclick=()=>updates.tryApply();
