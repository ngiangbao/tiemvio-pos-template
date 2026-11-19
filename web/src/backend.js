import {splitHistorical, mergeHistorical} from './restructure.js';
import {clockWarning} from './timeclock.js';
/* Tiemvio POS backend on Firestore: all shop rules (pricing, stock, loyalty, reports) behind one `call(action, data)` entry point.
 *
 * Firebase's free (Spark) plan has no server code, so business rules run here in the client and Firestore Security
 * Rules (firestore.rules) enforce who may write what. Everything that must stay correct under concurrency uses atomic
 * increments (stock, points, daily stats) or transactions (order status changes, version check).
 *
 * `fs` is the Firestore function set (firebase/firestore, or the in-memory fake used by tests), `db` its handle. */

export const TIEMVIO = {
  version: '1.20.5',
  roles: ['owner', 'sales', 'support'],
  transitions: {waiting: 'making', making: 'ready', ready: 'delivered'},
  open: ['waiting', 'making', 'ready'],
  maxManualDiscountShare: 0.3,
  loyalty: {earnPerVnd: 10000, pointValue: 1000, maxRedeemShare: 0.5},
  // Membership tiers follow lifetime spend. Higher tiers earn points faster.
  tiers: [
    {id: 'member', name: 'Thành viên', min: 0, mult: 1},
    {id: 'silver', name: 'Bạc', min: 1000000, mult: 1.2},
    {id: 'gold', name: 'Vàng', min: 3000000, mult: 1.5}
  ],
  channels: [
    {id: 'store', name: 'Tại quầy'},
    {id: 'grab', name: 'GrabFood'},
    {id: 'shopee', name: 'ShopeeFood'},
    {id: 'other', name: 'Khác (Be, điện thoại…)'}
  ],
  promo: {maxPercent: 50, maxAmount: 100000},
  maxImageChars: 45000,
  writeTimeoutMs: 15000,
  queueTimeoutMs: 400
};

/** New installations start with no menu or business data. */
export const DEFAULT_MENU = [];

export class TiemvioError extends Error {
  constructor(message) { super(message); this.rejected = true; }
}
const assert = (condition, message) => { if (!condition) throw new TiemvioError(message); };
const email_ = s => { const v = String(s || '').trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : ''; };
/** Ice and sugar choices a drink can have. The owner edits them in Settings; each choice can carry an extra price (e.g. extra ice). */
export const DEFAULT_ICE = [{id: 'normal', name: 'Đá vừa', price: 0}, {id: 'less', name: 'Ít đá', price: 0}, {id: 'none', name: 'Không đá', price: 0}, {id: 'extra', name: 'Thêm đá', price: 0}];
export const DEFAULT_SUGAR = [100, 70, 50, 30, 0].map(n => ({id: String(n), name: n + '% đường', percent: n, price: 0}));
const text_ = (s, max) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const cash_ = n => { assert(Number.isSafeInteger(n) && n >= 0 && n <= 100000000000, 'Số tiền phải là số nguyên không âm.'); return n; };
const money_ = n => { assert(Number.isSafeInteger(n) && n >= 0 && n <= 1000000, 'Giá tiền phải là số nguyên từ 0 đến 1.000.000đ.'); return n; };
const round2_ = n => Math.round(n * 100) / 100;
const RE_DAY = /^\d{4}-\d{2}-\d{2}$/;
export const SIZES = ['S', 'M', 'L', 'XL'];
/** How an item is counted when sold. Drinks: cups. Snacks: portions, sticks (cây), pieces (viên) or weight (lạng).
 * `packQty` > 1 means the price is for a pack ("10k / 4 viên"); staff still enter the number of pieces. */
export function unitInfo(m) {
  const food = m && m.kind === 'food';
  return {unit: (m && m.unit ? String(m.unit) : '') || (food ? 'phần' : 'ly'), packQty: Math.max(1, Number(m && m.packQty) || 1), byWeight: !!(m && m.byWeight === true), note: m && m.unitNote ? String(m.unitNote) : ''};
}
/** Prices per size for a menu item, e.g. {S: 15000, M: 20000}. Older items only have priceM/priceL, so those still work. */
export function menuSizes(m) {
  if (m && m.sizes && typeof m.sizes === 'object' && Object.keys(m.sizes).length) {
    const out = {}; SIZES.forEach(z => { if (m.sizes[z] !== undefined) out[z] = Number(m.sizes[z]); }); return out;
  }
  const out = {M: Number(m.priceM)};
  if (m.kind !== 'topping' && m.priceL !== undefined && Number(m.priceL) !== Number(m.priceM)) out.L = Number(m.priceL);
  return out;
}
const RE_KEY = /^[a-f0-9-]{20,80}$/;

/** Drops undefined (Firestore rejects it) from a plain object, one level deep. */
const clean = o => { const r = {}; for (const k of Object.keys(o)) if (o[k] !== undefined) r[k] = o[k]; return r; };

/** How an order's money was received: 'cash', 'transfer', or 'split' (cashPart in cash, the rest by transfer). */
const splitOf = o => {
  const total = Number(o.total) || 0;
  if (o.paymentMethod === 'split') { const cash = Math.max(0, Math.min(Number(o.cashPart) || 0, total)); return {cash, transfer: total - cash}; }
  return o.paymentMethod === 'transfer' ? {cash: 0, transfer: total} : {cash: total, transfer: 0};
};
const payText = o => o.paymentMethod === 'split' ? 'Tiền mặt ' + (Number(o.cashPart) || 0).toLocaleString('vi-VN') + 'đ + chuyển khoản ' + (o.total - (Number(o.cashPart) || 0)).toLocaleString('vi-VN') + 'đ' : o.paymentMethod === 'transfer' ? 'Chuyển khoản' : 'Tiền mặt';
/** Validates the payment choice against the order total. Returns the fields to store. */
function paymentFields(d, total) {
  if (d.paymentMethod === 'split') {
    const cashPart = d.cashPart;
    if (!Number.isSafeInteger(cashPart) || cashPart < 1 || cashPart >= total) throw new TiemvioError('Chia thanh toán: tiền mặt phải từ 1đ và nhỏ hơn tổng ' + total.toLocaleString('vi-VN') + 'đ; phần còn lại là chuyển khoản.');
    return {paymentMethod: 'split', cashPart};
  }
  if (!['cash', 'transfer'].includes(d.paymentMethod)) throw new TiemvioError('Phương thức thanh toán không hợp lệ.');
  return {paymentMethod: d.paymentMethod, cashPart: 0};
}

export function createBackend({fs, db, now = () => new Date(), uuid = () => crypto.randomUUID(), projectId = 'tiemvio', tz = 'Asia/Ho_Chi_Minh', seedMenu = DEFAULT_MENU, imageStore = null}) {
  const dayFmt = new Intl.DateTimeFormat('en-CA', {timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'});
  const dayOf = date => dayFmt.format(date instanceof Date ? date : new Date(date));
  const iso = () => now().toISOString();
  const hex = n => uuid().replace(/-/g, '').slice(0, n);
  const ref = (name, id) => fs.doc(db, name, id);
  const col = name => fs.collection(db, name);

  /* ---------------- session + live caches ---------------- */
  let me = null;               // {email, name, role}
  let day = '';                // day the order listeners are bound to
  let unsubs = [];             // all active listeners
  let userUnsub = null;
  let changeHandler = () => {};
  let signedOutHandler = () => {};
  let notifyHandler = () => {};
  let problemHandler = () => {};
  let notifyTimer = null;

  const cache = {
    menu: new Map(), images: new Map(), inventory: new Map(), recipes: new Map(), users: new Map(), customers: new Map(),
    promos: new Map(), stockLog: [], clock: [], clockRecent: [], clockOpen: [], shifts: [], settings: {}, orders: {}, schedule: new Map(), scheduleReady: null
  };
  const emit = () => { clearTimeout(notifyTimer); notifyTimer = setTimeout(() => changeHandler(), 120); };

  function listen(query, onSnap, emitFirst = false) {
    return new Promise((resolve, reject) => {
      let first = true;
      const unsub = fs.onSnapshot(query, snap => {
        onSnap(snap);
        if (first) { first = false; resolve(); if (emitFirst) emit(); } else emit();
      }, err => {
        if (first) { first = false; reject(err); }
        else if (err && err.code === 'permission-denied') signOutNow('Tài khoản không còn quyền truy cập.');
      });
      unsubs.push(unsub);
    });
  }
  const mapOf = (snap, key = 'id') => { const m = new Map(); snap.docs.forEach(d => m.set(d.id, {...d.data(), [key]: d.id})); return m; };

  async function startListeners(forDay) {
    day = forDay;
    const owner = me.role === 'owner' || me.role === 'support';
    const jobs = [
      listen(col('menu'), s => {
        cache.menu = mapOf(s);
        // The server says the menu is empty (e.g. it was cleared outside the app): the owner's phone loads the official one.
        if (s.empty && s.metadata && !s.metadata.fromCache && me && me.role === 'owner') seedMenuIfEmpty().catch(() => {});
      }),
      listen(col('inventory'), s => { cache.inventory = mapOf(s); }),
      listen(col('recipes'), s => { cache.recipes = mapOf(s, 'key'); }),
      listen(ref('settings', 'shop'), s => { cache.settings = s.exists() ? s.data() : {}; setTimeout(() => loadImages().catch(() => {}), 0); }),
      listen(col('promos'), s => { cache.promos = mapOf(s); }),
      // Time clock: staff only ever read their own entries; the owner reads everyone's recent ones.
      listen(owner
        ? fs.query(col('timeclock'), fs.orderBy('inAt', 'desc'), fs.limit(120))
        : fs.query(col('timeclock'), fs.where('email', '==', me.email), fs.orderBy('inAt', 'desc'), fs.limit(30)),
      s => { cache.clockRecent = s.docs.map(d => ({...d.data(), id: d.id})); mergeClock(); }),
      // An old forgotten clock-in must remain visible even after 120 newer entries.
      listen(owner ? fs.query(col('timeclock'), fs.where('outAt', '==', '')) : fs.query(col('timeclock'), fs.where('email', '==', me.email), fs.where('outAt', '==', '')),
        s => { cache.clockOpen = s.docs.map(d => ({...d.data(), id: d.id})); mergeClock(); }),
      listen(fs.query(col('shifts'), fs.orderBy('openedAt', 'desc'), fs.limit(11)), s => { cache.shifts = s.docs.map(d => ({...d.data(), id: d.id})); }),
      listen(fs.query(col('orders'), fs.where('createdDay', '==', day)), s => { cache.orders.created = mapOf(s); }),
      listen(fs.query(col('orders'), fs.where('status', 'in', TIEMVIO.open)), s => { cache.orders.open = mapOf(s); }),
      listen(fs.query(col('orders'), fs.where('paidDay', '==', day)), s => { cache.orders.paid = mapOf(s); })
    ];
    if (owner) {
      jobs.push(listen(col('users'), s => { cache.users = mapOf(s, 'email'); }));
    }
    await Promise.all(jobs);
    // Heavy or rarely needed data (about 1 MB of menu photos, stock history, customers) must not hold up the first screen:
    // it streams in afterwards and the screen refreshes itself when it arrives.
    const late = [];
    if (owner) late.push(
      listen(fs.query(col('stockLog'), fs.orderBy('at', 'desc'), fs.limit(40)), s => { cache.stockLog = s.docs.map(d => ({...d.data(), id: d.id})); }, true),
      listen(fs.query(col('customers'), fs.orderBy('points', 'desc'), fs.limit(50)), s => { cache.customers = mapOf(s, 'phone'); }, true));
    late.forEach(p => p.catch(() => {}));
    await bindShiftOrders();
    startScheduleWatch(owner);
  }
  // The work schedule is kept live in memory (like everything else), so the Schedule tab opens instantly and stays current.
  // It does not hold up sign-in: if it is slow or fails, the tab falls back to a plain read.
  function startScheduleWatch(owner) {
    cache.schedule = new Map();
    const q = owner
      ? fs.query(col('schedule'), fs.where('day', '>=', addDays(dayOf(now()), -70)))
      : fs.query(col('schedule'), fs.where('email', '==', me.email));          // staff: only their own shifts (the rules require it)
    // The copy kept on the phone can be stale (e.g. shifts the owner deleted while this phone was away), so the first answer from
    // the server is the truth. A cache-only snapshot is used only if the server stays silent for 3.5 s (offline).
    let serverSeen = false, held = null, finish;
    const serverFirst = new Promise(r => { finish = r; });
    const timer = setTimeout(() => { if (!serverSeen && held) cache.schedule = mapOf(held); serverSeen = true; finish(true); }, 3500);
    const live = listen(q, s => {
      if (!s.metadata.fromCache) { serverSeen = true; clearTimeout(timer); cache.schedule = mapOf(s); finish(true); }
      else if (serverSeen) cache.schedule = mapOf(s);
      else held = s;
    });
    cache.scheduleReady = live.then(() => serverFirst, () => { clearTimeout(timer); return false; });
  }

  // Orders touched while the open shift runs (paid after opening, or refunded after opening) for the expected-cash figure.
  let shiftKey = '';
  async function bindShiftOrders() {
    const s = openShiftDoc();
    const key = s ? s.id + '|' + s.openedAt : '';
    if (key === shiftKey) return;
    shiftKey = key;
    unsubs = unsubs.filter(u => { if (u.shift) { u(); return false; } return true; });
    cache.orders.shiftPaid = new Map(); cache.orders.shiftRefund = new Map();
    if (!s) return;
    const a = listen(fs.query(col('orders'), fs.where('paidAt', '>=', s.openedAt)), snap => { cache.orders.shiftPaid = mapOf(snap); });
    const b = listen(fs.query(col('orders'), fs.where('refundedAt', '>=', s.openedAt)), snap => { cache.orders.shiftRefund = mapOf(snap); });
    unsubs[unsubs.length - 1].shift = true; unsubs[unsubs.length - 2].shift = true;
    await Promise.all([a, b]);
  }

  function stopListeners() {
    unsubs.forEach(u => { try { u(); } catch (_) { /* ignore */ } });
    unsubs = []; shiftKey = '';
    if (userUnsub) { try { userUnsub(); } catch (_) { /* ignore */ } userUnsub = null; }
    clearTimeout(notifyTimer);
    cache.menu = new Map(); cache.images = new Map(); loadedImagesRev = null; cache.inventory = new Map(); cache.recipes = new Map();
    cache.users = new Map(); cache.customers = new Map(); cache.promos = new Map(); cache.stockLog = []; cache.clock = [];
    cache.clockRecent = []; cache.clockOpen = [];
    cache.shifts = []; cache.settings = {}; cache.orders = {}; cache.schedule = new Map(); cache.scheduleReady = null;
  }
  function signOutNow(message) { stopListeners(); me = null; signedOutHandler(message); }

  /* ---------------- auth glue ---------------- */
  // Names the Google account that signed in, so the owner can see at once if the address they typed differs
  // (e.g. a Gmail address typed with or without dots).
  const denied = email => 'Tài khoản ' + email + ' chưa được chủ quán cấp quyền hoặc đã bị khóa. Hãy gửi đúng địa chỉ email này cho chủ quán để được thêm.';

  /** Called after Firebase Auth reports a verified Google account. Resolves {ok} or {ok:false,error}. */
  /* Menu photos (about 1 MB) are the heaviest thing a phone downloads. They are no longer listened to: the owner's settings carry a revision
   * (`imagesRev`) that changes whenever a photo changes, and a phone keeps the photos it already has (imageStore, IndexedDB in the app)
   * and fetches them again only when that revision differs. That turns about 70 reads per app opening into none. */
  let loadedImagesRev = null, loadingImages = null;
  const asStored = (k, v, rev) => ({productId: k, image: v, updatedAt: rev});
  async function loadImages() {
    const rev = String(cache.settings.imagesRev || '');
    if (loadedImagesRev === rev && (loadedImagesRev !== '' || cache.images.size)) return;
    if (loadingImages) return loadingImages;
    loadingImages = (async () => {
      try {
        const saved = imageStore && rev ? await imageStore.get().catch(() => null) : null;
        if (saved && saved.rev === rev && saved.images) {
          cache.images = new Map(Object.entries(saved.images).map(([k, v]) => [k, asStored(k, v, rev)]));
        } else {
          cache.images = mapOf(await fs.getDocs(col('menuImages')), 'productId');
          if (imageStore && rev) imageStore.set(rev, Object.fromEntries([...cache.images].map(([k, v]) => [k, v.image]))).catch(() => {});
        }
        loadedImagesRev = rev;
        // photos saved before the revision existed: the owner's phone stamps one so every other phone can stop re-reading them
        if (!rev && me && me.role === 'owner') {
          const stamp = (() => { let latest = ''; cache.images.forEach(i => { if ((i.updatedAt || '') > latest) latest = i.updatedAt || ''; }); return latest || iso(); })();
          const batch = fs.writeBatch(db);
          batch.set(ref('settings', 'shop'), {imagesRev: stamp}, {merge: true});
          await commit(batch);
        }
        emit();
      } finally { loadingImages = null; }
    })();
    return loadingImages;
  }
  // Owner: make sure every person's name is in the map staff phones can read (covers people added before the map existed).
  async function syncStaffNames() {
    const want = {};
    cache.users.forEach(u => { if (u.name && u.name !== u.email) want[staffKey(u.email)] = u.name; });
    if (me && me.name && me.name !== me.email) want[staffKey(me.email)] = me.name;
    const have = cache.settings.staffNames || {};
    if (Object.keys(want).every(k => have[k] === want[k])) return;
    const batch = fs.writeBatch(db);
    batch.set(ref('settings', 'shop'), {staffNames: want}, {merge: true});
    await commit(batch);
  }
  async function attach(rawEmail, displayName = '') {
    const email = email_(rawEmail);
    if (!email) return {ok: false, error: 'Không đọc được email Google.'};
    stopListeners();
    let snap;
    try { snap = await fs.getDoc(ref('users', email)); }
    catch (e) { return {ok: false, error: friendly(e).message}; }
    if (!snap.exists()) {
      // First ever sign-in by the shop owner: the Security Rules only accept this for the configured owner email.
      try {
        const batch = fs.writeBatch(db);
        batch.set(ref('users', email), {email, name: text_(displayName, 60) || 'Chủ quán Tiemvio POS', role: 'owner', active: true});
        await commit(batch);
        snap = await fs.getDoc(ref('users', email));
      } catch (_) { return {ok: false, error: denied(email)}; }
    }
    const u = snap.data();
    if (u.active !== true || !TIEMVIO.roles.includes(u.role)) return {ok: false, error: denied(email)};
    me = {email, name: u.name, role: u.role};
    try {
      await startListeners(dayOf(now()));
      if (me.role === 'owner') { await seedMenuIfEmpty(); syncStaffNames().catch(() => {}); }
    } catch (e) { stopListeners(); me = null; return {ok: false, error: friendly(e).message}; }
    watchOwnUser(email);
    return {ok: true, user: {...me}};
  }

  /** Lock-out and role changes take effect at once: the phone signs out, and the next sign-in loads the new role. */
  function watchOwnUser(email) {
    userUnsub = fs.onSnapshot(ref('users', email), s => {
      const v = s.exists() ? s.data() : null;
      if (!v || v.active !== true) signOutNow('Tài khoản đã bị khóa.');
      else if (me && v.role !== me.role) signOutNow('Quyền của tài khoản vừa thay đổi. Hãy đăng nhập lại.');
    }, () => {});
  }

  // One seed at a time. A second caller waits for the one already running, so sign-in never finishes before the menu exists.
  let seedPromise = null;
  function seedMenuIfEmpty() {
    if (seedPromise) return seedPromise;
    if (cache.menu.size || !seedMenu.length) return Promise.resolve();
    seedPromise = seedNow().finally(() => { seedPromise = null; });
    return seedPromise;
  }
  async function seedNow() {
    const batch = fs.writeBatch(db);
    seedMenu.forEach(([id, name, category, priceM, priceL, kind], i) => {
      batch.set(ref('menu', id), {id, name, category, priceM, priceL, sizes: priceL === priceM || kind === 'topping' ? {M: priceM} : {M: priceM, L: priceL}, active: true, kind, sort: i + 1});
    });
    await commit(batch);
  }

  /* ---------------- low-level write helpers ---------------- */
  const TIMEOUT = Symbol('timeout');
  const race = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(TIMEOUT), ms))]);
  /** Normal write: needs the server. */
  async function commit(batch) {
    const r = await race(batch.commit(), TIEMVIO.writeTimeoutMs);
    if (r === TIMEOUT) throw new Error('Không kết nối được. Chưa xác nhận thao tác; hãy thử lại.');
  }
  /** Sale write: the SDK keeps it on the phone and syncs later, so we do not make the cashier wait forever. */
  async function commitQueued(batch) {
    const r = await race(batch.commit(), TIEMVIO.queueTimeoutMs);
    return r === TIMEOUT ? 'queued' : 'synced';
  }
  /** Like commitQueued, but also hands back the pending commit so a slow acknowledgement can still trigger follow-ups (notifications). */
  const pendingOrders = new Map();                          // order id -> its unconfirmed creation
  /** Later changes to an order read the server, so they must wait until its creation has reached it. */
  const afterPending = async id => { const p = pendingOrders.get(id); if (p) await race(p, TIEMVIO.writeTimeoutMs); };
  async function commitFast(batch, orderId) {
    const done = batch.commit();
    if (orderId) { const settled = done.then(() => {}, () => {}); pendingOrders.set(orderId, settled); settled.then(() => { if (pendingOrders.get(orderId) === settled) pendingOrders.delete(orderId); }); }
    // A confirmation that fails after we already answered must not vanish: the sale is shown on the phone until the server says no.
    done.catch(e => { if (late) problemHandler(friendly(e).message); });
    let late = false;
    const r = await race(done, TIEMVIO.queueTimeoutMs);
    if (r === TIMEOUT) { late = true; return {status: 'queued', done}; }
    return {status: 'synced', done};
  }
  function friendly(e) {
    if (e instanceof TiemvioError) return e;
    const code = e && e.code;
    if (code === 'permission-denied') return new TiemvioError('Bạn không có quyền thực hiện thao tác này.');
    if (code === 'unavailable' || code === 'deadline-exceeded' || /offline|network/i.test(String(e && e.message))) {
      return new Error('Không kết nối được. Chưa xác nhận thao tác; hãy thử lại.');
    }
    if (code === 'aborted' || code === 'failed-precondition') return new TiemvioError('Dữ liệu vừa được người khác thay đổi. Hãy tải lại rồi thử lại.');
    if (e && e.message && !code) return e;
    return new Error('Hệ thống chưa sẵn sàng. Thử lại sau ít phút.');
  }

  const supportEditor = () => me && me.role === 'support' && me.email === 'support-editor@example.invalid';
  const allow = roles => assert(me && (roles.includes(me.role) || supportEditor()), 'Bạn không có quyền thực hiện thao tác này.');
  const inc = fs.increment;

  /* ---------------- order model ---------------- */
  function toOrder(r) {
    const audit = Array.isArray(r.audit) ? r.audit : [];
    const first = audit[0] || {};
    const cash = audit.find(a => a.paidOnDelivery && a.cashReceived !== null && a.cashReceived !== undefined) || {};
    // Why an order was cancelled or refunded (the audit trail is owner-only on the phone, so the reason is lifted out for everyone)
    const stop = [...audit].reverse().find(a => a.action === 'cancel' || a.action === 'refund') || null;
    return {
      editHistory: audit.filter(a => a.action === 'edit').map(a => ({by: a.by || '', name: personName(a.by), at: a.at || '', detail: a.detail || 'Sửa đơn'})),
      id: r.id, requestKey: r.requestKey, creator: r.creator, createdAt: r.createdAt, updatedAt: r.updatedAt,
      restructured: r.restructured || null, origin: r.origin || null, status: r.status, paymentMethod: r.paymentMethod, cashPart: Number(r.cashPart) || 0, paid: r.paid === true, total: Number(r.total), customer: r.customer || '',
      service: r.service, items: r.items || [], version: Number(r.version), audit, paidAt: r.paidAt || '',
      phone: first.phone || '', subtotal: first.subtotal || Number(r.total), discount: first.discount || 0,
      redeemed: first.redeemed || 0, manualDiscount: first.manualDiscount || 0, discountReason: first.discountReason || '',
      // matched with the bank statement: the latest reconcile counts, unless a later payment fix changed what was transferred
      reconciled: (() => { for (let i = audit.length - 1; i >= 0; i--) { if (audit[i].action === 'reconcile') return true; if (audit[i].action === 'repay' && !audit[i].keepReconciled) return false; } return false; })(),
      cashReceived: cash.cashReceived === undefined ? null : cash.cashReceived,
      changeGiven: cash.changeGiven === undefined ? null : cash.changeGiven,
      seq: Number(r.seq) || 0, channel: r.channel || 'store', paidBy: r.paidBy || '', cogs: Number(r.cogs) || 0,
      creatorName: personName(r.creator), paidByName: personName(r.paidBy),
      promoId: first.promoId || '', promoName: first.promoName || '', promoDiscount: first.promoDiscount || 0, tier: first.tier || '',
      stop: stop && r.status === 'cancelled' ? {kind: stop.action, reason: stop.detail || '', by: stop.by || '', byName: personName(stop.by), at: stop.at || ''} : null
    };
  }
  function ordersUnion(...names) {
    const m = new Map();
    names.forEach(n => (cache.orders[n] || new Map()).forEach((o, id) => { const p = m.get(id); if (!p || Number(o.version) >= Number(p.version)) m.set(id, o); }));
    return [...m.values()].map(toOrder).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Daily totals document `stats/{day}` – lets reports read ≤93 documents instead of every order. */
  const hourFmt = new Intl.DateTimeFormat('en-GB', {timeZone: tz, hour: '2-digit', hour12: false});
  const hourOf = at => String(Number(hourFmt.format(new Date(at))) % 24);
  const staffKey = email => String(email || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '_');
  /** The name typed when the person was added (kept in settings so staff phones can read it too), or the e-mail if none is known. */
  const personName = email => {
    if (!email) return '';
    const e = String(email).toLowerCase();
    const known = (cache.settings.staffNames || {})[staffKey(e)];
    const user = [...cache.users.values()].find(u => u.email === e);
    return (user && user.name && user.name !== e ? user.name : '') || known || e;
  };
  /** `meta` = {at, by}: when the money was collected and who collected it (for the hour and staff reports). */
  function statsPatch(o, sign, meta = {}, extra = {}) {
    const top = {};
    o.items.forEach(i => {
      const t = top[i.productId] = top[i.productId] || {name: i.name, kind: i.kind === 'food' ? 'food' : 'drink', unit: i.unitName || (i.kind === 'food' ? 'phần' : 'ly'), quantity: 0, revenue: 0};
      t.quantity += sign * i.quantity; t.revenue += sign * i.lineTotal;
    });
    Object.keys(top).forEach(k => { top[k] = {name: top[k].name, kind: top[k].kind, unit: top[k].unit, quantity: inc(Math.round(top[k].quantity * 10) / 10), revenue: inc(top[k].revenue)}; });
    const cupCount = (o.items || []).filter(i => i.kind !== 'food').reduce((n, i) => n + (Number(i.quantity) || 0), 0);   // drinks only: snacks are sold by the portion
    // Drinks and snacks are reported apart. The order total (after any discount) is shared out by each side's share of the item lines,
    // so the two always add up to the order total.
    const gross = {drink: 0, food: 0};
    (o.items || []).forEach(i => { gross[i.kind === 'food' ? 'food' : 'drink'] += Number(i.lineTotal) || 0; });
    const grossAll = gross.drink + gross.food, foodShare = grossAll > 0 ? Math.round(o.total * gross.food / grossAll) : 0, drinkShare = o.total - foodShare;
    const kinds = {drink: {total: inc(sign * drinkShare), count: inc(gross.drink > 0 ? sign : 0), cups: inc(sign * cupCount)}, food: {total: inc(sign * foodShare), count: inc(gross.food > 0 ? sign : 0)}};
    const bucket = () => ({total: inc(sign * o.total), count: inc(sign), cups: inc(sign * cupCount)});
    const patch = {
      total: inc(sign * o.total), count: inc(sign), cups: inc(sign * cupCount),
      cash: inc(sign * splitOf(o).cash), transfer: inc(sign * splitOf(o).transfer),
      discount: inc(sign * (o.discount || 0)), manualDiscount: inc(sign * (o.manualDiscount || 0)),
      promoDiscount: inc(sign * (o.promoDiscount || 0)), cogs: inc(sign * (o.cogs || 0)),
      channels: {[o.channel || 'store']: bucket()}, kinds, top, ...extra
    };
    if (meta.by) patch.staff = {[staffKey(meta.by)]: {name: meta.by, ...bucket()}};
    if (meta.at) patch.hours = {[hourOf(meta.at)]: bucket()};
    return patch;
  }
  const writeStats = (w, forDay, patch) => w.set(ref('stats', forDay), {day: forDay, ...patch}, {merge: true});

  /* ---------------- stock + loyalty ---------------- */
  function recipeLines(key) { const r = cache.recipes.get(key); return r && Array.isArray(r.lines) ? r.lines : []; }
  function usageFor(items) {
    const usage = {};
    items.forEach(i => {
      [i.productId].concat((i.toppings || []).map(t => t.id)).forEach(pid => {
        const sized = i.size && i.size !== 'M' ? recipeLines(pid + '@' + i.size) : [];
        (sized.length ? sized : recipeLines(pid)).forEach(l => { usage[l.ingredientId] = round2_((usage[l.ingredientId] || 0) + l.qty * i.quantity); });
      });
    });
    return usage;
  }
  /** Ingredient cost of a usage map, in whole đồng. Owner sets `cost` per ingredient unit. */
  const costOf = usage => Math.round(Object.keys(usage).reduce((n, id) => n + usage[id] * (Number((cache.inventory.get(id) || {}).cost) || 0), 0));
  const loyalty = () => cache.settings.loyaltyProgram || TIEMVIO.loyalty;
  const tiers = () => cache.settings.loyaltyProgram?.tiers || TIEMVIO.tiers;
  const tierOf = spent => tiers().reduce((best, t) => (Number(spent) >= t.min ? t : best), tiers()[0]);
  function writeStock(w, usage, sign) {
    Object.keys(usage).forEach(id => {
      if (!cache.inventory.has(id)) return;
      w.update(ref('inventory', id), {stock: inc(round2_(-sign * usage[id]))});
    });
  }
  function writeCustomer(w, phone, name, delta) {
    w.set(ref('customers', phone), clean({
      phone, name: name || undefined, points: inc(delta.points || 0), spent: inc(delta.spent || 0), visits: inc(delta.visits || 0), updatedAt: iso()
    }), {merge: true});
  }
  const earnPoints = (total, mult = 1) => Math.floor(total / loyalty().earnPerVnd * mult);
  function writeReverse(w, o) {
    if (!o.phone) return;
    const earned = o.audit.reduce((n, a) => n + (Number(a.earned) || 0), 0);
    writeCustomer(w, o.phone, '', {points: o.redeemed - earned, spent: o.paid ? -o.total : 0, visits: o.paid ? -1 : 0});
  }

  /* ---------------- snapshot ---------------- */
  function openShiftDoc() { return cache.shifts.find(s => s.id && !s.closedAt) || null; }
  function shiftView(r, expected) {
    return {
      id: r.id, openedAt: r.openedAt, openedBy: r.openedBy, openedByName: personName(r.openedBy), openingCash: Number(r.openingCash), closedAt: r.closedAt || '',
      closedBy: r.closedBy || '', closingCash: r.closedAt ? Number(r.closingCash) : null,
      expectedCash: r.closedAt ? Number(r.expectedCash) : expected, difference: r.closedAt ? Number(r.difference) : null, note: r.note || ''
    };
  }
  function expectedCash(s, paidOrders, refundOrders) {
    const opened = Date.parse(s.openedAt);
    let cash = Number(s.openingCash);
    paidOrders.forEach(o => { if (o.paid && o.status !== 'cancelled' && Date.parse(o.paidAt) >= opened) cash += splitOf(o).cash; });
    refundOrders.forEach(o => {
      if (!(o.paid && splitOf(o).cash > 0 && o.status === 'cancelled' && Date.parse(o.paidAt) < opened)) return;
      const refund = o.audit.find(a => a.action === 'refund');
      if (refund && Date.parse(refund.at) >= opened) cash -= splitOf(o).cash;
    });
    return cash;
  }

  async function snapshot(d) {
    assert(me, 'AUTH:Vui lòng đăng nhập.');
    const want = RE_DAY.test(d.day || '') ? d.day : dayOf(now());
    if (want !== day) { // the Orders tab looked at another day: rebind the day listeners
      await rebindDay(want);
    }
    const all = ordersUnion('created', 'open', 'paid');
    const orders = all.filter(o => !o.restructured && (dayOf(o.createdAt) === day || !['delivered', 'cancelled'].includes(o.status)));
    const owner = me.role === 'owner' || me.role === 'support';
    const result = {
      user: {...me, canEdit: me.role !== 'support' || !!supportEditor()}, day, timezone: tz, database: {id: 'firebase:' + projectId}, serverTime: iso(),
      menu: [...cache.menu.values()].sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name)).map(m => ({id: m.id, name: m.name, category: m.category, priceM: m.priceM, priceL: m.priceL, sizes: menuSizes(m), ...unitInfo(m), active: m.active === true, kind: m.kind, allowHot: m.allowHot === true})),
      orders: orders.map(o => { if (!owner) delete o.audit; return o; })
    };
    if (owner) {
      const paid = all.filter(o => o.paid && o.status !== 'cancelled' && dayOf(o.paidAt) === day);
      const sum = list => list.reduce((n, o) => n + o.total, 0);
      result.report = {
        total: sum(paid), count: paid.length, cash: paid.reduce((n, o) => n + splitOf(o).cash, 0),
        transfer: paid.reduce((n, o) => n + splitOf(o).transfer, 0),
        unpaid: sum(all.filter(o => !o.paid && o.status !== 'cancelled' && dayOf(o.createdAt) === day))
      };
      result.users = [...cache.users.values()].filter(u => u.role !== 'support').map(u => ({email: u.email, name: u.name, role: u.role, active: u.active === true}));
      result.inventory = [...cache.inventory.values()].map(r => ({id: r.id, name: r.name, unit: r.unit, stock: round2_(Number(r.stock)), minStock: Number(r.minStock), cost: Number(r.cost) || 0, active: r.active === true}));
      result.recipes = [...cache.recipes.values()].flatMap(r => (r.lines || []).map(l => ({productId: r.key, ingredientId: l.ingredientId, qty: l.qty})));
      result.customers = [...cache.customers.values()].map(c => ({phone: c.phone, name: c.name || '', points: Math.max(0, Number(c.points)), spent: Math.max(0, Number(c.spent)), visits: Math.max(0, Number(c.visits)), tier: tierOf(c.spent)})).sort((a, b) => b.points - a.points);
      result.database.url = 'https://console.firebase.google.com/project/' + projectId + '/firestore';
      // Owner only: ingredient cost per drink/topping, stock history, who is clocked in right now.
      result.menuCosts = {};
      cache.menu.forEach((m, id) => {
        const one = size => costOf(usageFor([{productId: id, size, quantity: 1, toppings: []}]));
        result.menuCosts[id] = Object.fromEntries(Object.keys(menuSizes(m)).map(z => [z, one(z)]));
      });
      result.stockLog = cache.stockLog.map(x => ({at: x.at, by: x.by, byName: personName(x.by), name: x.name, unit: x.unit, delta: x.delta, reason: x.reason}));
      result.clockEntries = cache.clock.map(x => ({...x, name: personName(x.email) || x.name, warning: warningOf(x)}));
      result.clockedIn = result.clockEntries.filter(x => !x.outAt);
    }
    result.channels = TIEMVIO.channels;
    result.tiers = tiers();
    result.promoLimits = TIEMVIO.promo;
    result.promos = [...cache.promos.values()].filter(p => owner || p.active === true).map(p => ({...p, validNow: p.active === true && promoValidNow(p)}));
    const myClock = myOpenClock();
    const myEntries = cache.clock.filter(x => x.email === me.email && x.inAt);
    const weekFrom = mondayOf(day), minsOf = x => minutesBetween(x.inAt, x.outAt || iso());
    result.clock = {
      mine: myClock ? {...myClock, warning: warningOf(myClock)} : null,
      recent: myEntries.filter(x => x.outAt).slice(0, 7).map(x => ({...x, day: dayOf(x.inAt), minutes: minutesBetween(x.inAt, x.outAt)})),
      todayMinutes: myEntries.filter(x => dayOf(x.inAt) === day).reduce((n, x) => n + minsOf(x), 0),
      weekMinutes: myEntries.filter(x => dayOf(x.inAt) >= weekFrom).reduce((n, x) => n + minsOf(x), 0),
      plan: [...cache.schedule.values()].filter(x => x.email === me.email && x.day === day).map(x => ({start: x.start, end: x.end})).sort((a, b) => a.start.localeCompare(b.start))
    };
    if (!owner) { // staff-only: how many orders/cups I rang up today (cups and counts only, never money)
      const mine = all.filter(o => o.creator === me.email && o.status !== 'cancelled' && dayOf(o.createdAt) === day);
      result.mine = {orders: mine.length, cups: mine.reduce((n, o) => n + o.items.filter(i => i.kind !== 'food').reduce((m, i) => m + i.quantity, 0), 0)};
    }
    const s = cache.settings;
    result.discountReasons = discountReasons();
    result.cancelReasons = cancelReasons();
    result.menuCategories = menuCategories();
    result.iceOptions = iceOptions();
    result.sugarOptions = sugarOptions();
    result.staffNames = {...(cache.settings.staffNames || {})};
    result.staffColors = cache.settings.staffColors && typeof cache.settings.staffColors === 'object' ? cache.settings.staffColors : {};
    result.bank = s.bankBin && s.bankAccount ? {bin: s.bankBin, account: s.bankAccount, name: s.bankName || ''} : null;
    const open = openShiftDoc();
    result.shift = open ? shiftView(open, expectedCash(open, [...(cache.orders.shiftPaid || new Map()).values()].map(toOrder), [...(cache.orders.shiftRefund || new Map()).values()].map(toOrder))) : null;
    if (owner) result.shifts = cache.shifts.filter(r => r.closedAt).slice(0, 10).map(r => shiftView(r));
    const L = loyalty();
    result.loyalty = {earnPerVnd: L.earnPerVnd, pointValue: L.pointValue, maxRedeemShare: L.maxRedeemShare};
    result.imagesRev = imagesRev();
    return result;
  }
  function imagesRev() {
    if (!cache.images.size) return '';
    let latest = '';
    cache.images.forEach(i => { if ((i.updatedAt || '') > latest) latest = i.updatedAt || ''; });
    return cache.images.size + ':' + latest;
  }
  async function rebindDay(nextDay) {
    // Only the three day-scoped order listeners depend on the day; restart everything for simplicity and safety.
    const user = me;
    stopListeners(); me = user;
    await startListeners(nextDay);
    watchOwnUser(me.email);
  }

  /* ---------------- notifications for other phones (sent best-effort by the app, see push.js) ---------------- */
  const orderLabel = o => (o.seq ? '#' + o.seq : '#' + String(o.id).slice(-6).toUpperCase());
  const vnd = n => Number(n).toLocaleString('vi-VN') + 'đ';
  const notify = evt => { try { notifyHandler(evt); } catch (_) { /* never break a sale for a notification */ } };
  /** Ingredients that this sale takes down to or below their alert level (and were above it before). */
  function lowStockCrossings(usage) {
    return Object.keys(usage).map(id => cache.inventory.get(id)).filter(r => r && r.active === true && Number(r.minStock) > 0
      && Number(r.stock) > Number(r.minStock) && Number(r.stock) - usage[r.id] <= Number(r.minStock))
      .map(r => ({name: r.name, unit: r.unit, left: round2_(Number(r.stock) - usage[r.id]), min: Number(r.minStock)}));
  }

  /* ---------------- orders ---------------- */
  function priceItems(items) {
    assert(Array.isArray(items) && items.length > 0 && items.length <= 40, 'Đơn cần có từ 1 đến 40 dòng món.');
    const menu = cache.menu;
    const ices = iceOptions(), sugars = sugarOptions();
    let total = 0;
    const priced = items.map(i => {
      const m = menu.get(i.productId);
      assert(m && m.active === true && (m.kind === 'drink' || m.kind === 'food'), 'Món không còn bán. Hãy cập nhật menu.');
      const food = m.kind === 'food'; // snacks have no sugar, ice, temperature or toppings
      const sizes = menuSizes(m);
      assert(Object.prototype.hasOwnProperty.call(sizes, i.size), 'Món này không có size ' + i.size + '. Hãy cập nhật menu.');
      const temp = i.temp === 'hot' ? 'hot' : 'cold';
      assert(temp === 'cold' || m.allowHot === true, 'Món này không bán nóng.');
      // Sugar and ice come from the owner's lists; an option may add to the price. A hot drink or a snack never has ice.
      const sugarOpt = food ? null : (sugars.find(o => o.id === String(i.sugarId)) || (i.sugarId === undefined ? sugars.find(o => o.percent === i.sugar) : null));
      assert(food || sugarOpt, 'Mức đường không hợp lệ hoặc đã bị chủ quán xóa. Hãy chọn lại món.');
      const iceId = food || temp === 'hot' ? 'none' : i.ice;
      const iceOpt = food || temp === 'hot' ? {id: 'none', name: 'Không đá', price: 0} : ices.find(o => o.id === iceId);
      assert(iceOpt, 'Mức đá không hợp lệ hoặc đã bị chủ quán xóa. Hãy chọn lại món.');
      const ice = iceOpt.id;
      const u = unitInfo(m);
      const q = Number(i.quantity);
      if (u.byWeight) assert(Number.isInteger(q) && q >= 1 && q <= 200, 'Số ' + u.unit + ' từ 1 đến 200 (chỉ bán nguyên ' + u.unit + ').');
      else if (u.packQty > 1) assert(Number.isInteger(q) && q >= 1 && q <= 200, 'Số ' + u.unit + ' từ 1 đến 200.');
      else assert(Number.isInteger(q) && q >= 1 && q <= 200, 'Số lượng từ 1 đến 200.');
      const quantity = q;
      const ids = i.toppings || [];
      assert(Array.isArray(ids) && ids.length <= 10 && new Set(ids).size === ids.length, 'Topping bị trùng hoặc không hợp lệ.');
      assert(!food || ids.length === 0, 'Món ăn không có topping.');
      let unit = money_(sizes[i.size]);
      if (!food) unit += money_(iceOpt.price || 0) + money_(sugarOpt.price || 0);
      const toppings = ids.map(id => {
        const t = menu.get(id);
        assert(t && t.active === true && t.kind === 'topping', 'Topping không còn bán.');
        const price = money_(t.priceM); unit += price;
        return {id: t.id, name: t.name, price};
      });
      const lineTotal = Math.round(unit * quantity / u.packQty); total += lineTotal; // pack price × pieces ÷ pack size
      return {productId: m.id, name: m.name, kind: m.kind, size: i.size, sugar: food ? 0 : sugarOpt.percent, sugarId: food ? '' : sugarOpt.id, sugarName: food ? '' : sugarOpt.name, sugarPrice: food ? 0 : money_(sugarOpt.price || 0), ice, iceName: food ? '' : iceOpt.name, icePrice: food ? 0 : money_(iceOpt.price || 0), temp, quantity, unitName: u.unit, packQty: u.packQty, byWeight: u.byWeight, portion: u.note, toppings, note: text_(i.note, 120), unitPrice: unit, lineTotal};
    });
    assert(total <= 100000000, 'Tổng đơn vượt giới hạn.');
    return {items: priced, total};
  }
  const phone_ = s => {
    const v = String(s || '').replace(/[\s.\-]/g, '');
    assert(/^0\d{9,10}$/.test(v), 'Số điện thoại phải bắt đầu bằng 0 và có 10–11 số.');
    return v;
  };

  async function createOrder(d) {
    allow(['owner', 'sales']);
    assert(RE_KEY.test(d.requestKey || ''), 'Thiếu mã chống trùng đơn.');
    const id = d.requestKey.replace(/-/g, '').slice(0, 16);
    // A retry of the same request must return the first result, never a second order.
    // (the live copy already knows today's orders; the extra server read is only for a re-send after an unconfirmed attempt)
    const have = ordersUnion('created', 'open', 'paid').find(o => o.id === id);
    if (have) { assert(have.creator === me.email, 'Mã yêu cầu đã được sử dụng.'); return have; }
    if (d.attempts > 0) {
      try {
        const prev = await fs.getDoc(ref('orders', id));
        if (prev.exists()) { assert(prev.data().creator === me.email, 'Mã yêu cầu đã được sử dụng.'); return toOrder({...prev.data(), id}); }
      } catch (e) { if (e instanceof TiemvioError) throw e; /* offline: the id is deterministic, a duplicate create is rejected harmlessly */ }
    }
    assert(['takeaway', 'dinein'].includes(d.service), 'Loại phục vụ không hợp lệ.');
    assert(['cash', 'transfer', 'split'].includes(d.paymentMethod), 'Phương thức thanh toán không hợp lệ.');
    assert(typeof d.paid === 'boolean', 'Trạng thái thanh toán không hợp lệ.');
    const channel = d.channel === undefined ? 'store' : d.channel;
    assert(TIEMVIO.channels.some(c => c.id === channel), 'Kênh bán không hợp lệ.');
    const priced = priceItems(d.items);
    const phone = d.phone ? phone_(d.phone) : '';
    const redeem = d.redeem === undefined ? 0 : d.redeem;
    assert(Number.isInteger(redeem) && redeem >= 0, 'Số điểm đổi không hợp lệ.');
    assert(!redeem || phone, 'Phải có số điện thoại khách để đổi điểm.');
    const L = loyalty();
    const discount = redeem * L.pointValue;
    assert(discount <= priced.total * L.maxRedeemShare, 'Chỉ được dùng điểm để giảm tối đa ' + L.maxRedeemShare * 100 + '% đơn.');
    const manual = d.manualDiscount === undefined ? 0 : d.manualDiscount;
    assert(Number.isInteger(manual) && manual >= 0, 'Giảm giá không hợp lệ.');
    const manualReason = manual ? text_(d.discountReason, 90) : '';
    assert(manual <= priced.total * TIEMVIO.maxManualDiscountShare, 'Giảm giá tối đa ' + TIEMVIO.maxManualDiscountShare * 100 + '% đơn.');
    if (manual) checkedReason(manualReason, discountReasons(), 'giảm giá');
    let promo = null, promoDiscount = 0;
    if (d.promoId) {
      promo = cache.promos.get(d.promoId);
      assert(promo && promo.active === true, 'Khuyến mãi không còn áp dụng.');
      assert(promoValidNow(promo), 'Khuyến mãi này chưa tới hoặc đã qua khung giờ áp dụng.');
      assert(priced.total >= (Number(promo.minTotal) || 0), 'Đơn chưa đạt mức tối thiểu ' + (Number(promo.minTotal) || 0).toLocaleString('vi-VN') + 'đ của khuyến mãi.');
      promoDiscount = promoAmount(promo, priced.total);
    }
    const total = priced.total - promoDiscount - discount - manual;
    const pay = paymentFields(d, total);
    assert(total >= 0, 'Tổng giảm giá vượt quá giá trị đơn.');
    const customerName = text_(d.customer, 60);
    let customerDoc = null;
    const seqAhead = !redeem ? allocSeq(dayOf(now())) : null;          // runs while the customer is looked up
    if (phone) {
      try { const c = await fs.getDoc(ref('customers', phone)); customerDoc = c.exists() ? c.data() : null; }
      catch (_) { if (redeem) throw new Error('Cần kết nối mạng để kiểm tra điểm của khách.'); /* offline: sells at base tier */ }
    }
    if (redeem) assert(redeem <= (customerDoc ? Number(customerDoc.points) : 0), 'Khách không đủ điểm.');
    const tier = tierOf(customerDoc ? customerDoc.spent : 0);
    const at = iso();
    const created = {at, by: me.email, action: 'created', phone, subtotal: priced.total, discount, redeemed: redeem, manualDiscount: manual, discountReason: manualReason,
      promoId: promo ? promo.id : '', promoName: promo ? promo.name : '', promoDiscount, tier: tier.id};
    created.loyaltyPointValue = L.pointValue; created.loyaltyMaxRedeemShare = L.maxRedeemShare;
    if (d.paid) created.earned = phone ? earnPoints(total, tier.mult) : 0;
    created.stockUsage = usageFor(priced.items);
    const seq = seqAhead ? await seqAhead : await allocSeq(dayOf(at));
    const doc = {
      id, requestKey: d.requestKey, creator: me.email, createdAt: at, updatedAt: at, createdDay: dayOf(at), status: 'ready',
      paymentMethod: pay.paymentMethod, cashPart: pay.cashPart, paid: d.paid, total, customer: customerName, service: d.service, items: priced.items,
      version: 1, audit: [created], paidAt: d.paid ? at : '', paidDay: d.paid ? dayOf(at) : '',
      unpaid: !d.paid, unreconciled: d.paid && splitOf({...pay, total}).transfer > 0, refundedAt: '',
      channel, seq, paidBy: d.paid ? me.email : '', cogs: costOf(created.stockUsage)
    };
    const batch = fs.writeBatch(db);
    batch.set(ref('orders', id), doc);
    writeStock(batch, created.stockUsage, 1);
    if (phone) {
      if (redeem) writeCustomer(batch, phone, customerName, {points: -redeem});
      if (d.paid) writeCustomer(batch, phone, customerName, {points: created.earned, spent: total, visits: 1});
    }
    if (d.paid) writeStats(batch, dayOf(at), statsPatch(toOrder(doc), 1, {at, by: me.email}));
    const low = lowStockCrossings(created.stockUsage || {});
    const sent = await commitFast(batch, id);
    const made = toOrder(doc);
    const announce = () => { // offline sales are announced once they sync
      notify({type: 'order', title: 'Đơn mới ' + orderLabel(made), body: [made.items.length + ' món', vnd(made.total), made.customer, me.name || me.email].filter(Boolean).join(' · '), tag: 'order-' + made.id, url: '/'});
      if (low.length) notify({type: 'lowstock', title: 'Sắp hết nguyên liệu', body: low.slice(0, 3).map(x => x.name + ': còn ' + x.left + ' ' + x.unit + ' (mức báo ' + x.min + ')').join('; '), tag: 'lowstock'});
    };
    if (sent.status === 'synced') announce();
    else sent.done.then(() => { if (Date.now() - Date.parse(at) < 120000) announce(); }).catch(() => {});   // slow network: announce when it lands, unless it is an old offline sale
    return made;
  }

  /** Daily order number (1, 2, 3 …). Needs the server; offline sales simply have no number and show their short code. */
  async function allocSeq(forDay) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 0;
    const cref = ref('counters', forDay);
    try {
      const n = await race(fs.runTransaction(db, async tx => {
        const snap = await tx.get(cref);
        const next = (snap.exists() ? Number(snap.data().n) : 0) + 1;
        tx.set(cref, {day: forDay, n: next});
        return next;
      }), 3000);
      return n === TIMEOUT ? 0 : n;
    } catch (_) { return 0; }
  }
  function promoValidNow(p) {
    const h = Number(hourOf(now()));
    return h >= (p.startHour === undefined ? 0 : Number(p.startHour)) && h < (p.endHour === undefined ? 24 : Number(p.endHour));
  }
  const promoAmount = (p, subtotal) => (p.type === 'percent' ? Math.floor(subtotal * Number(p.value) / 100) : Math.min(Number(p.value), subtotal));

  async function updateOrder(d) {
    allow(['owner', 'sales']);
    assert(RE_KEY.test(d.mutationId || ''), 'Thiếu mã thao tác.');
    await afterPending(d.id);
    const oref = ref('orders', d.id);
    let order;
    try {
      order = await fs.runTransaction(db, async tx => {
        // The customer is read together with the order (the live copy tells us the phone), saving a round trip when payment is taken.
        const known = ordersUnion('created', 'open', 'paid').find(x => x.id === d.id);
        const guess = known && known.phone && !known.paid && ['pay', 'advance'].includes(d.change) ? known.phone : '';
        const [snap, guessed] = await Promise.all([tx.get(oref), guess ? tx.get(ref('customers', guess)) : Promise.resolve(null)]);
        assert(snap.exists(), 'Không tìm thấy đơn.');
        const raw = {...snap.data(), id: d.id};
        const o = toOrder(raw);
        const repeated = o.audit.find(a => a.key === d.mutationId);
        if (repeated) { assert(repeated.by === me.email, 'Mã thao tác đã được sử dụng.'); return o; }
        assert(!o.restructured, 'Đơn đã được gộp hoặc tách. Hãy mở đơn mới.');
        assert(Number(d.version) === o.version, 'Đơn vừa được người khác cập nhật. Hãy tải lại trước khi thao tác.');
        // Reads must come before writes in a transaction: fetch the customer's lifetime spend when this step collects money.
        const willPay = d.change === 'pay' || (d.change === 'advance' && o.status === 'ready' && !o.paid);
        let spentBefore = 0;
        if (willPay && o.phone) { const cs = guessed && guess === o.phone ? guessed : await tx.get(ref('customers', o.phone)); spentBefore = cs.exists() ? Number(cs.data().spent) : 0; }
        const at = iso();
        const patch = {};
        const entry = {at, by: me.email, action: d.change, detail: '', key: d.mutationId, paidOnDelivery: false, paymentMethod: raw.paymentMethod, earned: 0, reversed: false, cashReceived: null, changeGiven: null};
        const markPaid = (pay, tendered) => {
          const method = pay.paymentMethod, parts = splitOf({...pay, total: o.total});
          patch.paid = true; patch.paymentMethod = method; patch.cashPart = pay.cashPart; patch.paidAt = at; patch.paidDay = dayOf(at); patch.paidBy = me.email;
          patch.unpaid = false; patch.unreconciled = parts.transfer > 0;
          entry.paymentMethod = method;
          if (method === 'split') entry.cashPart = pay.cashPart;
          if (parts.cash > 0 && tendered !== undefined && tendered !== null && tendered !== '') {
            assert(Number.isSafeInteger(tendered) && tendered >= parts.cash && tendered <= 100000000, 'Số tiền khách đưa phải là số nguyên và không ít hơn phần tiền mặt phải trả.');
            entry.cashReceived = tendered; entry.changeGiven = tendered - parts.cash;
          }
          const tier = tierOf(spentBefore);
          entry.tier = tier.id;
          entry.earned = o.phone ? earnPoints(o.total, tier.mult) : 0;
          if (o.phone) writeCustomer(tx, o.phone, '', {points: entry.earned, spent: o.total, visits: 1});
          writeStats(tx, patch.paidDay, statsPatch({...o, paymentMethod: method, cashPart: pay.cashPart}, 1, {at, by: me.email}));
        };
        if (d.change === 'advance') {
          assert(TIEMVIO.transitions[o.status], 'Đơn không thể chuyển trạng thái nữa.');
          patch.status = TIEMVIO.transitions[o.status]; entry.detail = patch.status;
          if (patch.status === 'delivered' && !o.paid) {
            markPaid(paymentFields({...d, paymentMethod: d.paymentMethod || o.paymentMethod, cashPart: d.paymentMethod ? d.cashPart : o.cashPart}, o.total), d.cashReceived);
            entry.paidOnDelivery = true;
          }
        } else if (d.change === 'pay') {
          assert(o.status !== 'cancelled' && !o.paid, 'Đơn đã thanh toán hoặc đã hủy.');
          markPaid(paymentFields(d, o.total), d.cashReceived); entry.detail = d.paymentMethod;
        } else if (d.change === 'refund') {
          allow(['owner']);
          assert(o.paid && o.status !== 'cancelled', 'Chỉ hoàn tiền được cho đơn đã thu tiền và chưa hủy.');
          entry.detail = presetCancelReason(d.reason);
          patch.status = 'cancelled'; patch.refundedAt = at; patch.unreconciled = false;
          writeReverse(tx, o);
          writeStock(tx, (o.audit[0] || {}).stockUsage || usageFor(o.items), -1);
          // A refund reduces the day the money was collected, as the old report did.
          writeStats(tx, dayOf(o.paidAt), statsPatch(o, -1, {at: o.paidAt, by: o.paidBy}, {refundTotal: inc(o.total), refundCount: inc(1)}));
          entry.reversed = true;
        } else if (d.change === 'repay') {
          // Owner corrects how a paid order was paid (cash / transfer / split). Money totals and the items stay the same.
          allow(['owner']);
          assert(o.paid && o.status !== 'cancelled', 'Chỉ sửa được phương thức của đơn đã thu tiền và chưa hủy.');
          const fixed = paymentFields(d, o.total), was = splitOf(o), now = splitOf({...fixed, total: o.total});
          assert(fixed.paymentMethod !== o.paymentMethod || fixed.cashPart !== (o.cashPart || 0), 'Phương thức thanh toán không thay đổi.');
          patch.paymentMethod = fixed.paymentMethod; patch.cashPart = fixed.cashPart;
          // A transfer part that is unchanged and already matched stays matched; anything new needs matching again.
          const keep = now.transfer > 0 && was.transfer === now.transfer && o.reconciled;
          patch.unreconciled = now.transfer > 0 && !keep; entry.keepReconciled = keep;
          entry.detail = payText(o) + ' → ' + payText({...fixed, total: o.total}); entry.paymentMethod = fixed.paymentMethod;
          if (fixed.paymentMethod === 'split') entry.cashPart = fixed.cashPart;
          writeStats(tx, dayOf(o.paidAt), {cash: inc(now.cash - was.cash), transfer: inc(now.transfer - was.transfer)});
        } else if (d.change === 'reconcile') {
          allow(['owner']);
          assert(o.paid && splitOf(o).transfer > 0 && o.status !== 'cancelled', 'Chỉ đối soát đơn có phần chuyển khoản đã thu.');
          assert(!o.reconciled, 'Đơn đã được đối soát.');
          entry.detail = text_(d.reason, 120); patch.unreconciled = false;
        } else if (d.change === 'cancel') {
          allow(['owner', 'sales']); // any seller may cancel an order that is not yet paid; refunds stay owner-only
          assert(!['cancelled', 'delivered'].includes(o.status), 'Đơn đã kết thúc.');
          assert(!o.paid, 'Đơn đã thu tiền. Cần xử lý hoàn tiền riêng, không hủy trực tiếp.');
          entry.detail = presetCancelReason(d.reason);
          patch.status = 'cancelled'; patch.unpaid = false;
          writeReverse(tx, o);
          writeStock(tx, (o.audit[0] || {}).stockUsage || usageFor(o.items), -1);
          entry.reversed = true;
        } else throw new TiemvioError('Thao tác không hợp lệ.');
        patch.version = o.version + 1; patch.updatedAt = at;
        patch.audit = [...o.audit, entry];
        tx.update(oref, patch);
        return toOrder({...raw, ...patch});
      });
    } catch (e) { throw friendly(e); }
    if (['cancel', 'refund'].includes(d.change) && order.version === Number(d.version) + 1) {
      const last = order.audit[order.audit.length - 1] || {};
      notify({type: 'cancel', title: (d.change === 'refund' ? 'Hoàn tiền đơn ' : 'Đơn bị hủy ') + orderLabel(order), body: [vnd(order.total), last.detail, me.name || me.email].filter(Boolean).join(' · '), tag: 'cancel-' + order.id});
    }
    return order;
  }

  /** Edit an open order that has not been paid: items, service, customer, channel, promotion and manual discount.
   * Stock is corrected by the difference, the phone number and points already redeemed stay as they were. */
  async function editOrder(d) {
    allow(['owner', 'sales']);
    assert(RE_KEY.test(d.mutationId || ''), 'Thiếu mã thao tác.');
    await afterPending(d.id);
    assert(['takeaway', 'dinein'].includes(d.service), 'Loại phục vụ không hợp lệ.');
    const channel = d.channel === undefined ? 'store' : d.channel;
    assert(TIEMVIO.channels.some(c => c.id === channel), 'Kênh bán không hợp lệ.');
    const priced = priceItems(d.items);
    const manual = d.manualDiscount === undefined ? 0 : d.manualDiscount;
    assert(Number.isInteger(manual) && manual >= 0, 'Giảm giá không hợp lệ.');
    const manualReason = text_(d.discountReason, 80);
    assert(manual <= priced.total * TIEMVIO.maxManualDiscountShare, 'Giảm giá tối đa ' + TIEMVIO.maxManualDiscountShare * 100 + '% đơn.');
    assert(!manual || manualReason.length >= 3, 'Hãy nhập lý do giảm giá.');
    let promo = null, promoDiscount = 0;
    if (d.promoId) {
      promo = cache.promos.get(d.promoId);
      assert(promo && promo.active === true, 'Khuyến mãi không còn áp dụng.');
      assert(promoValidNow(promo), 'Khuyến mãi này chưa tới hoặc đã qua khung giờ áp dụng.');
      assert(priced.total >= (Number(promo.minTotal) || 0), 'Đơn chưa đạt mức tối thiểu ' + (Number(promo.minTotal) || 0).toLocaleString('vi-VN') + 'đ của khuyến mãi.');
      promoDiscount = promoAmount(promo, priced.total);
    }
    const oref = ref('orders', d.id);
    try {
      return await fs.runTransaction(db, async tx => {
        const snap = await tx.get(oref);
        assert(snap.exists(), 'Không tìm thấy đơn.');
        const raw = {...snap.data(), id: d.id};
        const o = toOrder(raw);
        const repeated = o.audit.find(a => a.key === d.mutationId);
        if (repeated) { assert(repeated.by === me.email, 'Mã thao tác đã được sử dụng.'); return o; }
        assert(!o.restructured, 'Đơn đã được gộp hoặc tách. Hãy mở đơn mới.');
        assert(Number(d.version) === o.version, 'Đơn vừa được người khác cập nhật. Hãy hủy sửa, mở lại đơn rồi sửa lại.');
        assert(!o.paid && ['waiting', 'making', 'ready'].includes(o.status), 'Chỉ sửa được đơn chưa thu tiền và chưa hủy. Đơn đã thu tiền cần hoàn tiền rồi tạo lại.');
        const first = o.audit[0] || {};
        const redeemed = first.redeemed || 0;
        const pointDiscount = Number(first.discount) || 0;
        const redeemShare = first.loyaltyMaxRedeemShare ?? TIEMVIO.loyalty.maxRedeemShare;
        assert(pointDiscount <= priced.total * redeemShare, 'Đơn sau khi sửa quá nhỏ để giữ ' + redeemed + ' điểm đã đổi (tối đa ' + redeemShare * 100 + '% giá trị). Hãy thêm món, hoặc hủy đơn và tạo lại.');
        const total = priced.total - promoDiscount - pointDiscount - manual;
        assert(total >= 0, 'Tổng giảm giá vượt quá giá trị đơn.');
        // Stock: only the difference between what was taken before and what the new items need.
        const before = first.stockUsage || usageFor(o.items);
        const after = usageFor(priced.items);
        const diff = {};
        new Set([...Object.keys(before), ...Object.keys(after)]).forEach(id => {
          const v = round2_((after[id] || 0) - (before[id] || 0));
          if (v !== 0) diff[id] = v;
        });
        writeStock(tx, diff, 1);
        const at = iso();
        const firstNew = {...first, subtotal: priced.total, discount: pointDiscount, redeemed, manualDiscount: manual, discountReason: manualReason,
          promoId: promo ? promo.id : '', promoName: promo ? promo.name : '', promoDiscount, stockUsage: after};
        const cups = list => Math.round(list.reduce((n, i) => n + i.quantity, 0) * 10) / 10;
        const entry = {at, by: me.email, action: 'edit', key: d.mutationId, paidOnDelivery: false, paymentMethod: raw.paymentMethod, earned: 0, reversed: false, cashReceived: null, changeGiven: null,
          detail: 'Sửa đơn: ' + cups(o.items) + ' → ' + cups(priced.items) + ' ly, ' + o.total.toLocaleString('vi-VN') + 'đ → ' + total.toLocaleString('vi-VN') + 'đ'};
        const patch = {items: priced.items, total, customer: text_(d.customer, 60), service: d.service, channel, cogs: costOf(after),
          version: o.version + 1, updatedAt: at, audit: [firstNew, ...o.audit.slice(1), entry]};
        tx.update(oref, patch);
        return toOrder({...raw, ...patch});
      });
    } catch (e) { throw friendly(e); }
  }


  /** Atomically replace unpaid orders. No inventory, loyalty or revenue writes: their ledgers move with the items. */
  async function restructureOrders(d) {
    allow(['owner', 'sales']);
    assert(['merge', 'split'].includes(d.mode), 'Thao tác không hợp lệ.');
    assert(RE_KEY.test(d.mutationId || ''), 'Thiếu mã thao tác.');
    const input = d.sources;
    assert(Array.isArray(input) && input.length >= (d.mode === 'merge' ? 2 : 1) && input.length <= (d.mode === 'merge' ? 8 : 1), 'Gộp từ 2 đến 8 đơn hoặc tách một đơn.');
    assert(input.every(x => x && typeof x.id === 'string' && x.id && Number.isInteger(x.version)) && new Set(input.map(x => x.id)).size === input.length, 'Danh sách đơn không hợp lệ.');
    const count = d.mode === 'merge' ? 1 : (Array.isArray(d.groups) ? d.groups.length : 0);
    assert(count >= 1 && count <= 8 && (d.mode !== 'split' || count >= 2), 'Tách thành từ 2 đến 8 đơn.');
    await Promise.all(input.map(x => afterPending(x.id)));
    const ids = Array.from({length: count}, (_, i) => d.mutationId.replace(/-/g, '') + '-' + i);
    try {
      return await fs.runTransaction(db, async tx => {
        const snaps = await Promise.all(input.map(x => tx.get(ref('orders', x.id))));
        assert(snaps.every(x => x.exists()), 'Không tìm thấy đơn.');
        const sources = snaps.map((s, i) => ({...s.data(), id: input[i].id}));
        // A retry returns the original result, including when the first acknowledgement was lost.
        const repeated = sources.every(s => s.restructured && s.restructured.key === d.mutationId && s.restructured.by === me.email);
        if (repeated) {
          const previousIds = sources[0].restructured.ids;
          const previous = await Promise.all(previousIds.map(id => tx.get(ref('orders', id))));
          assert(previous.every(s => s.exists()), 'Đơn kết quả không còn tồn tại.');
          return {orders: previous.map((s, i) => toOrder({...s.data(), id: previousIds[i]}))};
        }
        sources.forEach((s, i) => {
          assert(!s.restructured && !s.paid && TIEMVIO.open.includes(s.status), 'Chỉ gộp/tách đơn đang mở và chưa thu tiền.');
          assert(s.version === input[i].version, 'Đơn vừa được người khác thay đổi. Hãy mở lại rồi thử.');
        });
        const existing = await Promise.all(ids.map(id => tx.get(ref('orders', id))));
        assert(existing.every(s => !s.exists()), 'Mã thao tác đã được sử dụng.');
        const portions = d.mode === 'merge' ? [mergeHistorical(sources, usageFor)] : splitHistorical(sources[0], d.groups, usageFor);
        const at = iso(), sourceIds = sources.map(s => s.id);
        const orders = portions.map((p, i) => {
          const base = sources[0];
          const first = {...p.first, at, by: me.email, action: 'created', earned: 0};
          const origin = {type: d.mode, ids: sourceIds, key: d.mutationId, by: me.email, at};
          const entry = {at, by: me.email, action: d.mode, key: d.mutationId, detail: (d.mode === 'merge' ? 'Gộp từ: ' : 'Tách từ: ') + sources.map(s => s.seq ? '#' + s.seq : s.id).join(', ')};
          return {id: ids[i], requestKey: d.mutationId + '-' + i, creator: me.email, createdAt: at, updatedAt: at, createdDay: dayOf(at),
            status: 'ready', paymentMethod: 'cash', cashPart: 0, paid: false, total: p.total, customer: d.mode === 'merge' ? sources.map(s => s.customer).filter(Boolean).join(' + ').slice(0, 60) : base.customer || '',
            service: base.service, channel: base.channel || 'store', items: p.items, version: 1, audit: [first, entry], paidAt: '', paidDay: '', paidBy: '',
            unpaid: true, unreconciled: false, refundedAt: '', seq: 0, cogs: p.cogs, origin};
        });
        sources.forEach(s => tx.update(ref('orders', s.id), {status: 'cancelled', unpaid: false, unreconciled: false, version: s.version + 1, updatedAt: at,
          restructured: {type: d.mode, key: d.mutationId, ids, by: me.email, at},
          audit: [...s.audit, {at, by: me.email, action: d.mode, key: d.mutationId, detail: 'Chuyển sang đơn: ' + ids.join(', ')}]}));
        orders.forEach(o => tx.set(ref('orders', o.id), o));
        return {orders: orders.map(toOrder)};
      });
    } catch (e) { throw friendly(e); }
  }


  async function reconcileAll(d) {
    allow(['owner']);
    assert(RE_KEY.test(d.mutationId || ''), 'Thiếu mã thao tác.');
    assert(Array.isArray(d.orders) && d.orders.length <= 10000 && d.orders.every(o => o && typeof o.id === 'string' && o.id && Number.isInteger(o.version)) && new Set(d.orders.map(o => o.id)).size === d.orders.length, 'Danh sách đối soát không hợp lệ.');
    const result = {total: d.orders.length, reconciled: 0, failed: []};
    for (let start = 0; start < d.orders.length; start += 5) {
      await Promise.all(d.orders.slice(start, start + 5).map(async (o, offset) => {
        try {
          await updateOrder({id: o.id, version: o.version, change: 'reconcile', mutationId: d.mutationId + '-' + (start + offset).toString(16), reason: 'Đối soát toàn bộ'});
          result.reconciled++;
        } catch (e) { result.failed.push({id: o.id, error: friendly(e).message}); }
      }));
    }
    return result;
  }

  /* ---------------- menu, users, settings ---------------- */
  async function saveMenu(d) {
    allow(['owner']);
    const m = {id: d.id || hex(12), name: text_(d.name, 70), category: text_(d.category, 30), active: d.active === true, kind: d.kind, allowHot: d.allowHot === true && d.kind === 'drink'};
    assert(m.name && m.category && /^[a-zA-Z0-9_-]{1,40}$/.test(m.id), 'Tên món, nhóm món hoặc mã món không hợp lệ.');
    assert(['drink', 'topping', 'food'].includes(m.kind), 'Loại món không hợp lệ.');
    // Each size the owner switches on has its own price; a size left off is not sold.
    const raw = d.sizes && typeof d.sizes === 'object' ? d.sizes : {M: d.priceM, L: d.priceL};
    Object.keys(raw).forEach(k => assert(SIZES.includes(k), 'Size không hợp lệ.'));
    const sizes = {};
    SIZES.forEach(z => { if (raw[z] !== undefined && raw[z] !== null && raw[z] !== '') sizes[z] = money_(Number(raw[z])); });
    // Drinks and snacks can be sold in several sizes; a topping has one price.
    if (m.kind === 'topping') { assert(sizes.M !== undefined, 'Nhập giá bán.'); m.sizes = {M: sizes.M}; }
    else { assert(Object.keys(sizes).length >= 1, 'Hãy bật ít nhất một size và nhập giá.'); m.sizes = sizes; }
    // Snacks: unit of sale (phần / cây / viên / lạng), price per pack, and optional weighing.
    if (m.kind === 'food') {
      const byWeight = d.byWeight === true;
      const packQty = d.packQty === undefined || d.packQty === '' || d.packQty === null ? 1 : Number(d.packQty);
      assert(Number.isInteger(packQty) && packQty >= 1 && packQty <= 100, 'Giá tính cho từ 1 đến 100 đơn vị.');
      assert(!byWeight || packQty === 1, 'Món bán theo cân nặng được tính giá cho 1 đơn vị (ví dụ 1 lạng).');
      m.unit = text_(d.unit, 16) || (byWeight ? 'lạng' : 'phần'); m.packQty = packQty; m.byWeight = byWeight;
      m.unitNote = text_(d.unitNote, 24); // what one portion contains, e.g. "4 viên" or "2 cây" (sold whole, not retail)
    } else { m.unit = ''; m.packQty = 1; m.byWeight = false; m.unitNote = ''; }
    // priceM / priceL stay filled for older screens and the security rules: base price and the largest size.
    const list = Object.values(m.sizes);
    m.priceM = m.sizes.M !== undefined ? m.sizes.M : list[0];
    m.priceL = m.sizes.L !== undefined ? m.sizes.L : (m.sizes.XL !== undefined ? m.sizes.XL : m.priceM);
    assert(menuCategories().includes(m.category), 'Phân loại chưa có trong danh sách. Thêm ở Quản lý → Phân loại món.');
    const existing = cache.menu.get(m.id);
    m.sort = existing && existing.sort ? existing.sort : Date.now();
    const batch = fs.writeBatch(db);
    batch.set(ref('menu', m.id), m);
    await commit(batch);
    return {id: m.id, name: m.name, category: m.category, priceM: m.priceM, priceL: m.priceL, sizes: m.sizes, ...unitInfo(m), active: m.active, kind: m.kind, allowHot: m.allowHot};
  }
  // Owner drags items into any order: d.ids is the new order of (some of) the menu; the rest keep their relative order after it.
  async function reorderMenu(d) {
    allow(['owner']);
    assert(Array.isArray(d.ids) && d.ids.length <= 400, 'Danh sách sắp xếp không hợp lệ.');
    const ids = [...new Set(d.ids.map(String))];
    ids.forEach(id => assert(cache.menu.has(id), 'Có món không còn trong menu. Hãy tải lại trang.'));
    const rest = [...cache.menu.values()].filter(m => !ids.includes(m.id)).sort((a, b) => (a.sort || 0) - (b.sort || 0)).map(m => m.id);
    const order = [...ids, ...rest];
    const batch = fs.writeBatch(db);
    let changed = 0;
    order.forEach((id, i) => {
      const m = cache.menu.get(id);
      if (m.sort !== i + 1) { batch.set(ref('menu', id), {...m, sort: i + 1}); changed++; }
    });
    if (changed) await commit(batch);
    return {ok: true, changed};
  }
  async function deleteMenu(d) {
    allow(['owner']);
    const id = String(d.id || '');
    assert(cache.menu.has(id), 'Không tìm thấy món.');
    const batch = fs.writeBatch(db);
    batch.delete(ref('menu', id));
    if (cache.images.has(id)) { batch.delete(ref('menuImages', id)); batch.set(ref('settings', 'shop'), {imagesRev: iso()}, {merge: true}); }
    cache.recipes.forEach((r, key) => { if (key === id || key.startsWith(id + '@')) batch.delete(ref('recipes', key)); });
    await commit(batch);
    cache.images.delete(id);
    return {ok: true};
  }
  async function saveMenuImage(d) {
    allow(['owner']);
    const id = String(d.productId || '');
    assert(cache.menu.has(id), 'Không tìm thấy món để gắn ảnh.');
    const image = d.image === '' || d.image === null || d.image === undefined ? '' : String(d.image);
    if (image) {
      assert(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(image), 'Ảnh phải là JPEG hợp lệ.');
      assert(image.length <= TIEMVIO.maxImageChars, 'Ảnh quá lớn. Hãy chọn ảnh khác hoặc cắt nhỏ hơn.');
    }
    const batch = fs.writeBatch(db);
    const rev = iso();
    if (image) batch.set(ref('menuImages', id), {productId: id, image, updatedAt: rev});
    else batch.delete(ref('menuImages', id));
    batch.set(ref('settings', 'shop'), {imagesRev: rev}, {merge: true});
    await commit(batch);
    if (image) cache.images.set(id, asStored(id, image, rev)); else cache.images.delete(id);
    loadedImagesRev = rev;
    if (imageStore) imageStore.set(rev, Object.fromEntries([...cache.images].map(([k, v]) => [k, v.image]))).catch(() => {});
    return {productId: id, hasImage: !!image, imagesRev: imagesRev()};
  }
  function menuImages() {
    const images = {};
    cache.images.forEach((v, k) => { if (v.image) images[k] = v.image; });
    return {images, rev: imagesRev()};
  }
  async function saveUser(d) {
    assert(me && me.role === 'owner', 'Bạn không có quyền quản lý tài khoản và khóa AI. Chỉ chủ quán được thực hiện.');
    const email = email_(d.email);
    assert(email, 'Địa chỉ email không hợp lệ.');
    assert(TIEMVIO.roles.includes(d.role), 'Vai trò không hợp lệ.');
    assert(email !== me.email, 'Không thay đổi tài khoản đang quản trị để tránh tự khóa.');
    const value = {email, name: text_(d.name, 60) || email, role: d.role, active: d.active === true};
    const batch = fs.writeBatch(db);
    batch.set(ref('users', email), value);
    if (value.name && value.name !== email) batch.set(ref('settings', 'shop'), {staffNames: {[staffKey(email)]: value.name}}, {merge: true});
    await commit(batch);
    if (!value.active) notify({type: 'revoke', email});
    return value;
  }
  async function deleteUser(d) {
    assert(me && me.role === 'owner', 'Bạn không có quyền quản lý tài khoản và khóa AI. Chỉ chủ quán được thực hiện.');
    const email = email_(d.email);
    assert(email, 'Địa chỉ email không hợp lệ.');
    assert(email !== me.email, 'Không thể xóa tài khoản đang đăng nhập.');
    const target = [...cache.users.values()].find(u => u.email === email);
    assert(target, 'Không tìm thấy nhân viên.');
    assert(target.role !== 'owner', 'Không thể xóa tài khoản chủ quán. Hãy đổi vai trò trước.');
    const batch = fs.writeBatch(db);
    batch.delete(ref('users', email));
    await commit(batch);
    notify({type: 'revoke', email});
    return {ok: true};
  }
  const reasonList = field => {
    const list = cache.settings[field];
    return Array.isArray(list) ? list.filter(x => typeof x === 'string' && x) : [];
  };
  const discountReasons = () => reasonList('discountReasons');
  const cancelReasons = () => reasonList('cancelReasons');
  async function saveReasonList(field, label, d) {
    allow(['owner']);
    assert(Array.isArray(d.reasons), 'Danh sách lý do không hợp lệ.');
    // "Khác" is always offered to staff with a free-text box, so it never belongs in the owner's list.
    const reasons = [...new Set(d.reasons.map(x => text_(x, 40)).filter(x => x && !/^khác[\s:….]*$/i.test(x)))];
    assert(reasons.length <= 20, 'Tối đa 20 lý do ' + label + '.');
    assert(reasons.every(x => x.length >= 3), 'Mỗi lý do ' + label + ' cần ít nhất 3 ký tự.');
    const batch = fs.writeBatch(db);
    batch.set(ref('settings', 'shop'), {[field]: reasons}, {merge: true});
    await commit(batch);
    return {[field]: reasons};
  }
  const saveDiscountReasons = d => saveReasonList('discountReasons', 'giảm giá', d);
  const saveCancelReasons = d => saveReasonList('cancelReasons', 'hủy đơn', d);
  // A reason is either one the owner prepared or "Khác: <text typed by staff>".
  function checkedReason(value, list, label) {
    const r = text_(value, 120);
    const other = /^Khác: (.*)$/.exec(r);
    if (other) { assert(other[1].trim().length >= 3, 'Chọn "Khác" thì hãy nhập lý do (ít nhất 3 ký tự).'); return r; }
    assert(list.includes(r), 'Hãy chọn lý do ' + label + ' trong danh sách.');
    return r;
  }
  const presetCancelReason = value => checkedReason(value, cancelReasons(), 'hủy đơn/hoàn tiền');
  // Menu groups: the owner's list, or (until one is saved) the groups the menu already uses.
  function menuCategories() {
    const list = cache.settings.menuCategories;
    if (Array.isArray(list) && list.length) return list.filter(x => typeof x === 'string' && x);
    return [...new Set([...cache.menu.values()].sort((a, b) => (a.sort || 0) - (b.sort || 0)).map(m => m.category).filter(Boolean))];
  }
  /** The saved lists, or the standard ones until the owner changes them. */
  const iceOptions = () => { const l = cache.settings.iceOptions; return Array.isArray(l) && l.length ? l.filter(o => o && o.id && o.name).map(o => ({id: String(o.id), name: String(o.name), price: Number(o.price) || 0})) : DEFAULT_ICE; };
  const sugarOptions = () => { const l = cache.settings.sugarOptions; return Array.isArray(l) && l.length ? l.filter(o => o && o.id && o.name).map(o => ({id: String(o.id), name: String(o.name), percent: Number(o.percent) || 0, price: Number(o.price) || 0})) : DEFAULT_SUGAR; };
  function cleanOptions(list, label, withPercent) {
    assert(Array.isArray(list) && list.length >= 1 && list.length <= 8, 'Cần từ 1 đến 8 lựa chọn ' + label + '.');
    const seen = new Set(), ids = new Set();
    return list.map(o => {
      const name = text_(o && o.name, 24);
      assert(name.length >= 2, 'Mỗi lựa chọn ' + label + ' cần tên (ít nhất 2 ký tự).');
      assert(!seen.has(name.toLowerCase()), 'Tên lựa chọn ' + label + ' bị trùng: ' + name + '.');
      seen.add(name.toLowerCase());
      const price = Number(o.price === undefined || o.price === '' ? 0 : o.price);
      assert(Number.isInteger(price) && price >= 0 && price <= 50000, 'Giá thêm của "' + name + '" từ 0 đến 50.000đ.');
      const id = /^[a-zA-Z0-9_-]{1,20}$/.test(String(o.id || '')) && !ids.has(String(o.id)) ? String(o.id) : hex(8);
      ids.add(id);
      const out = {id, name, price};
      if (withPercent) {
        const percent = Number(o.percent);
        assert(Number.isInteger(percent) && percent >= 0 && percent <= 200, 'Phần trăm đường của "' + name + '" từ 0 đến 200.');
        out.percent = percent;
      }
      return out;
    });
  }
  async function saveIceOptions(d) {
    allow(['owner']);
    const list = cleanOptions(d.options, 'lượng đá', false);
    const batch = fs.writeBatch(db);
    batch.set(ref('settings', 'shop'), {iceOptions: list}, {merge: true});
    await commit(batch);
    cache.settings.iceOptions = list; emit();
    return {options: list};
  }
  async function saveSugarOptions(d) {
    allow(['owner']);
    const list = cleanOptions(d.options, 'lượng đường', true);
    const batch = fs.writeBatch(db);
    batch.set(ref('settings', 'shop'), {sugarOptions: list}, {merge: true});
    await commit(batch);
    cache.settings.sugarOptions = list; emit();
    return {options: list};
  }
  async function saveMenuCategories(d) {
    allow(['owner']);
    assert(Array.isArray(d.categories), 'Danh sách phân loại không hợp lệ.');
    const categories = [...new Set(d.categories.map(x => text_(x, 30)).filter(Boolean))];
    assert(categories.length >= 1 && categories.length <= 30, 'Cần từ 1 đến 30 phân loại.');
    assert(categories.every(x => x.length >= 2 && x !== 'Tất cả'), 'Tên phân loại cần ít nhất 2 ký tự và không được là "Tất cả".');
    const used = [...cache.menu.values()].filter(m => !categories.includes(m.category));
    assert(!used.length, 'Còn món thuộc phân loại bị xóa (' + [...new Set(used.map(m => m.category))].join(', ') + '). Hãy chuyển các món đó sang phân loại khác trước.');
    const batch = fs.writeBatch(db);
    batch.set(ref('settings', 'shop'), {menuCategories: categories}, {merge: true});
    await commit(batch);
    return {menuCategories: categories};
  }
  // The AI assistant settings, kept online and shared by every owner account (and every phone they sign in on).
  async function getAiConfig() {
    allow(['owner']);
    let snap;
    try {
      snap = await fs.getDoc(ref('aiConfig', 'shared'));
      if (!snap.exists() && me.role === 'owner') {   // first version kept one document per owner: move it into the shared one
        const legacy = await fs.getDoc(ref('aiConfig', me.email));
        if (legacy.exists()) {
          const v = legacy.data();
          const batch = fs.writeBatch(db);
          batch.set(ref('aiConfig', 'shared'), {provider: v.provider || 'anthropic', keys: v.keys || {}, models: v.models || {}});
          await commit(batch);
          snap = legacy;
        }
      }
    } catch (e) { throw friendly(e); }
    const v = snap.exists() ? snap.data() : {};
    return {provider: v.provider || '', keys: v.keys || {}, models: v.models || {}};
  }

  const AI_KEEP_MS = 7 * 86400000;
  async function pruneAiChats() {
    allow(['owner']);
    const expired = await fs.getDocs(fs.query(col('aiChats'), fs.where('expiresAt', '<=', now().getTime())));
    for (const chat of expired.docs) {
      const ids = chat.data().turnIds || [];
      for (let i = 0; i < ids.length; i += 400) {
        const batch = fs.writeBatch(db);
        ids.slice(i, i + 400).forEach(id => batch.delete(fs.doc(db, 'aiChats', chat.id, 'turns', id)));
        await commit(batch);
      }
      const batch = fs.writeBatch(db); batch.delete(ref('aiChats', chat.id)); await commit(batch);
    }
    return {removed: expired.size};
  }
  async function listAiChats() {
    allow(['owner']); await pruneAiChats();
    const snap = await fs.getDocs(fs.query(col('aiChats'), fs.where('expiresAt', '>', now().getTime())));
    return {chats: snap.docs.map(s => {const v = s.data(); return {id: s.id, title: v.title, createdAt: v.createdAt, expiresAt: v.expiresAt, createdByName: v.createdByName};}).sort((a,b) => b.createdAt - a.createdAt)};
  }
  async function createAiChat(d) {
    allow(['owner']); assert(RE_KEY.test(d.id || ''), 'Mã cuộc trò chuyện không hợp lệ.');
    const at = now().getTime();
    const value = {title: text_(d.title, 100) || 'Cuộc trò chuyện mới', createdAt: at, expiresAt: at + AI_KEEP_MS, updatedAt: at, createdBy: me.email, createdByName: me.name || me.email, turnIds: []};
    await fs.runTransaction(db, async tx => {const s = await tx.get(ref('aiChats', d.id)); if (!s.exists()) tx.set(ref('aiChats', d.id), value);});
    return {id: d.id};
  }
  async function saveAiTurn(d) {
    allow(['owner']);
    assert(RE_KEY.test(d.chatId || '') && RE_KEY.test(d.id || ''), 'Mã lịch sử chat không hợp lệ.');
    assert(Array.isArray(d.messages) && Array.isArray(d.log), 'Nội dung chat không hợp lệ.');
    const messages = JSON.stringify(d.messages), log = JSON.stringify(d.log);
    assert(utf8(messages) + utf8(log) <= 450000, 'Lượt chat quá dài để lưu lịch sử.');
    const at = now().getTime(), parent = ref('aiChats', d.chatId), target = fs.doc(db, 'aiChats', d.chatId, 'turns', d.id);
    await fs.runTransaction(db, async tx => {
      const [chat, existing] = await Promise.all([tx.get(parent), tx.get(target)]);
      assert(chat.exists() && chat.data().expiresAt > at, 'Cuộc trò chuyện đã hết hạn 7 ngày. Hãy tạo cuộc trò chuyện mới.');
      if (existing.exists()) {assert(existing.data().by === me.email, 'Mã lượt chat đã được sử dụng.');return;}
      tx.set(target, {createdAt: at, by: me.email, name: me.name || me.email, messages, log});
      tx.update(parent, {updatedAt: at, turnIds: fs.arrayUnion(d.id)});
    });
    return {ok: true};
  }
  async function loadAiChat(d) {
    allow(['owner']); assert(RE_KEY.test(d.id || ''), 'Mã cuộc trò chuyện không hợp lệ.');
    const chat = await fs.getDoc(ref('aiChats', d.id));
    assert(chat.exists() && chat.data().expiresAt > now().getTime(), 'Cuộc trò chuyện đã hết hạn hoặc không còn tồn tại.');
    const turns = await fs.getDocs(fs.query(fs.collection(db, 'aiChats', d.id, 'turns'), fs.orderBy('createdAt')));
    return {id: d.id, ...chat.data(), turns: turns.docs.map(s => {const t=s.data();return {id:s.id,by:t.by,name:t.name,createdAt:t.createdAt,messages:JSON.parse(t.messages),log:JSON.parse(t.log)};})};
  }

  async function saveAiConfig(d) {
    assert(me && me.role === 'owner', 'Bạn không có quyền quản lý tài khoản và khóa AI. Chỉ chủ quán được thực hiện.');
    const provider = String(d.provider || '');
    assert(['anthropic', 'openrouter'].includes(provider), 'Nhà cung cấp AI không hợp lệ.');
    const clean = (o, max) => { const out = {}; for (const k of ['anthropic', 'openrouter']) { const v = o && typeof o[k] === 'string' ? o[k].trim() : ''; assert(v.length <= max && !/[\s]/.test(v), 'Key hoặc tên mô hình không hợp lệ.'); if (v) out[k] = v; } return out; };
    const batch = fs.writeBatch(db);
    batch.set(ref('aiConfig', 'shared'), {provider, keys: clean(d.keys, 300), models: clean(d.models, 80)});
    await commit(batch);
    return {ok: true};
  }
  async function saveLoyalty(d) {
    allow(['owner']);
    const earnPerVnd = Number(d.earnPerVnd), pointValue = Number(d.pointValue), maxRedeemShare = Number(d.maxRedeemShare);
    assert(Number.isSafeInteger(earnPerVnd) && earnPerVnd >= 1 && earnPerVnd <= 1000000000, 'Số tiền để tích 1 điểm phải là số nguyên từ 1 đến 1.000.000.000đ.');
    assert(Number.isSafeInteger(pointValue) && pointValue >= 1 && pointValue <= 1000000, 'Giá trị 1 điểm phải là số nguyên từ 1 đến 1.000.000đ.');
    assert(Number.isFinite(maxRedeemShare) && maxRedeemShare >= 0 && maxRedeemShare <= 1, 'Mức giảm bằng điểm phải từ 0 đến 100%.');
    assert(Array.isArray(d.tiers) && d.tiers.length >= 1 && d.tiers.length <= 10, 'Cần từ 1 đến 10 bậc thành viên.');
    const list = d.tiers.map(t => ({id: String(t.id || ''), name: text_(t.name, 40), min: Number(t.min), mult: Number(t.mult)})).sort((a,b) => a.min - b.min);
    const ids = new Set(), names = new Set(), mins = new Set();
    for (const t of list) {
      assert(/^[a-zA-Z0-9_-]{1,60}$/.test(t.id) && !ids.has(t.id), 'Mã bậc thành viên không hợp lệ hoặc bị trùng.');
      assert(t.name && !names.has(t.name.toLocaleLowerCase('vi')), 'Tên bậc thành viên phải có nội dung và không trùng nhau.');
      assert(Number.isSafeInteger(t.min) && t.min >= 0 && t.min <= 1000000000000 && !mins.has(t.min), 'Ngưỡng chi tiêu phải là số nguyên không âm, không trùng nhau.');
      assert(Number.isFinite(t.mult) && t.mult >= 0.1 && t.mult <= 100, 'Hệ số tích điểm của mỗi bậc phải từ 0,1 đến 100.');
      ids.add(t.id); names.add(t.name.toLocaleLowerCase('vi')); mins.add(t.min);
    }
    assert(list[0].min === 0, 'Bậc đầu tiên phải có ngưỡng chi tiêu 0đ.');
    const program = {earnPerVnd, pointValue, maxRedeemShare, tiers: list};
    const batch = fs.writeBatch(db); batch.set(ref('settings', 'shop'), {loyaltyProgram: program}, {merge: true});
    await commit(batch); cache.settings = {...cache.settings, loyaltyProgram: program};
    return program;
  }
  async function saveSettings(d) {
    allow(['owner']);
    const bin = String(d.bankBin || '').trim(), account = String(d.bankAccount || '').trim();
    const batch = fs.writeBatch(db);
    if (!bin && !account) {
      batch.set(ref('settings', 'shop'), {bankBin: '', bankAccount: '', bankName: ''}, {merge: true});
      await commit(batch); return {bank: null};
    }
    assert(/^\d{6}$/.test(bin), 'Mã BIN ngân hàng gồm 6 chữ số.');
    assert(/^\d{6,19}$/.test(account) || /^[A-Za-z0-9]{6,30}$/.test(account), 'Số tài khoản gồm 6–19 chữ số (hoặc mã định danh VietQR của ngân hàng, ví dụ MB).');
    const bankName = text_(d.bankName, 50);
    batch.set(ref('settings', 'shop'), {bankBin: bin, bankAccount: account, bankName}, {merge: true});
    await commit(batch);
    return {bank: {bin, account, name: bankName}};
  }

  /* ---------------- inventory ---------------- */
  async function saveIngredient(d) {
    allow(['owner']);
    const known = cache.inventory.get(d.id);
    const m = {id: d.id || hex(12), name: text_(d.name, 60), unit: text_(d.unit, 12), minStock: Number(d.minStock), active: d.active === true,
      cost: d.cost === undefined ? Number(known && known.cost) || 0 : Number(d.cost)};
    assert(m.name && m.unit && /^[a-zA-Z0-9_-]{1,40}$/.test(m.id), 'Tên, đơn vị hoặc mã nguyên liệu không hợp lệ.');
    assert(isFinite(m.cost) && m.cost >= 0 && m.cost <= 1000000, 'Giá vốn mỗi đơn vị phải từ 0 đến 1.000.000đ.');
    assert(isFinite(m.minStock) && m.minStock >= 0 && m.minStock <= 1000000000, 'Mức tồn tối thiểu không hợp lệ.');
    const existing = cache.inventory.get(m.id);
    const batch = fs.writeBatch(db);
    if (!existing) {
      const initial = d.stock === undefined ? 0 : Number(d.stock);
      assert(isFinite(initial) && initial >= 0 && initial <= 1000000000, 'Tồn kho ban đầu không hợp lệ.');
      m.stock = round2_(initial);
      batch.set(ref('inventory', m.id), m);
    } else batch.update(ref('inventory', m.id), {name: m.name, unit: m.unit, minStock: m.minStock, active: m.active, cost: m.cost});
    await commit(batch);
    return {...m, stock: existing ? Number(existing.stock) : m.stock};
  }
  async function deleteIngredient(d) {
    allow(['owner']);
    const id = String(d.id || '');
    assert(cache.inventory.has(id), 'Không tìm thấy nguyên liệu.');
    const batch = fs.writeBatch(db);
    batch.delete(ref('inventory', id));
    // Take the ingredient out of every recipe that used it (a recipe left empty is removed).
    cache.recipes.forEach((r, key) => {
      const lines = (r.lines || []).filter(l => l.ingredientId !== id);
      if (lines.length === (r.lines || []).length) return;
      if (lines.length) batch.set(ref('recipes', key), {key, lines}); else batch.delete(ref('recipes', key));
    });
    await commit(batch);
    return {ok: true};
  }
  async function adjustStock(d) {
    allow(['owner']);
    const delta = Number(d.delta);
    assert(isFinite(delta) && delta !== 0 && Math.abs(delta) <= 1000000000, 'Số lượng điều chỉnh không hợp lệ.');
    const row = cache.inventory.get(d.id);
    assert(row, 'Không tìm thấy nguyên liệu.');
    const reason = text_(d.reason, 80);
    assert(reason.length >= 3, 'Hãy nhập lý do điều chỉnh kho (nhập hàng, kiểm kê, đổ bỏ…).');
    const batch = fs.writeBatch(db);
    batch.update(ref('inventory', d.id), {stock: inc(round2_(delta))});
    batch.set(ref('stockLog', hex(16)), {at: iso(), by: me.email, ingredientId: d.id, name: row.name, unit: row.unit, delta: round2_(delta), reason});
    await commit(batch);
    return {...row, stock: round2_(Number(row.stock) + delta)};
  }
  async function saveRecipe(d) {
    allow(['owner']);
    assert(cache.menu.has(d.productId), 'Món không tồn tại.');
    const lines = d.lines || [];
    assert(Array.isArray(lines) && lines.length <= 20, 'Công thức tối đa 20 nguyên liệu.');
    assert(new Set(lines.map(l => l.ingredientId)).size === lines.length, 'Nguyên liệu bị trùng trong công thức.');
    lines.forEach(l => {
      assert(cache.inventory.has(l.ingredientId), 'Nguyên liệu không tồn tại.');
      assert(isFinite(Number(l.qty)) && Number(l.qty) >= 0.01 && Number(l.qty) <= 100000, 'Định lượng phải lớn hơn 0.');
    });
    assert(d.size === undefined || SIZES.includes(d.size), 'Size công thức không hợp lệ.');
    const key = d.productId + (d.size && d.size !== 'M' ? '@' + d.size : '');
    const out = lines.map(l => ({ingredientId: l.ingredientId, qty: round2_(Number(l.qty))}));
    const batch = fs.writeBatch(db);
    if (out.length) batch.set(ref('recipes', key), {key, lines: out});
    else batch.delete(ref('recipes', key));
    await commit(batch);
    return {productId: d.productId, lines: out.map(l => ({productId: key, ...l}))};
  }

  /* ---------------- expenses, shifts, customers ---------------- */
  async function saveExpense(d) {
    allow(['owner']);
    assert(RE_KEY.test(d.requestKey || ''), 'Thiếu mã chống trùng.');
    const batch = fs.writeBatch(db);
    if (d.void === true) {
      assert(typeof d.id === 'string' && d.id, 'Không tìm thấy khoản chi.');
      batch.update(ref('expenses', d.id), {voided: true});
      try { await commit(batch); } catch (e) { throw friendly(e); }
      return {id: d.id, voided: true};
    }
    const id = d.requestKey.replace(/-/g, '').slice(0, 16);
    const at = iso();
    const e = {id, at, day: dayOf(at), by: me.email, category: text_(d.category, 30), amount: cash_(Number(d.amount)), note: text_(d.note, 120), voided: false};
    assert(e.category && e.amount > 0, 'Nhập nhóm chi phí và số tiền lớn hơn 0.');
    try {
      const prev = await fs.getDoc(ref('expenses', id));
      if (prev.exists()) return {id};
    } catch (_) { /* offline */ }
    batch.set(ref('expenses', id), e);
    await commitQueued(batch);
    return e;
  }
  async function openShift(d) {
    allow(['owner', 'sales']);
    assert(!openShiftDoc(), 'Đang có ca mở. Hãy chốt ca trước.');
    const s = {openedAt: iso(), openedBy: me.email, openingCash: cash_(Number(d.openingCash)), closedAt: '', closedBy: '', closingCash: null, expectedCash: null, difference: null, note: ''};
    const id = hex(16);
    const batch = fs.writeBatch(db);
    batch.set(ref('shifts', id), s);
    await commit(batch);
    cache.shifts.unshift({...s, id});
    await bindShiftOrders();
    return shiftView({...s, id}, Number(s.openingCash));
  }
  async function closeShift(d) {
    allow(['owner', 'sales']);
    const open = openShiftDoc();
    assert(open, 'Không có ca đang mở.');
    const closing = cash_(Number(d.closingCash));
    // Authoritative figure: read from the server rather than trusting the live cache.
    const paid = await fs.getDocs(fs.query(col('orders'), fs.where('paidAt', '>=', open.openedAt)));
    const refunded = await fs.getDocs(fs.query(col('orders'), fs.where('refundedAt', '>=', open.openedAt)));
    const expected = expectedCash(open, paid.docs.map(x => toOrder({...x.data(), id: x.id})), refunded.docs.map(x => toOrder({...x.data(), id: x.id})));
    const upd = {closedAt: iso(), closedBy: me.email, closingCash: closing, expectedCash: expected, difference: closing - expected, note: text_(d.note, 120)};
    const batch = fs.writeBatch(db);
    batch.update(ref('shifts', open.id), upd);
    await commit(batch);
    Object.assign(open, upd);
    await bindShiftOrders();
    return shiftView({...open});
  }
  async function lookupCustomer(d) {
    allow(['owner', 'sales']);
    const phone = phone_(d.phone);
    try {
      const c = await fs.getDoc(ref('customers', phone));
      if (c.exists()) { const v = c.data(); return {phone, name: v.name || '', points: Math.max(0, Number(v.points)), spent: Math.max(0, Number(v.spent)), visits: Math.max(0, Number(v.visits)), tier: tierOf(v.spent)}; }
    } catch (e) { throw friendly(e); }
    return {phone, name: '', points: 0, spent: 0, visits: 0, tier: tierOf(0)};
  }

  /* ---------------- promotions (owner edits, everyone applies) ---------------- */
  async function savePromo(d) {
    allow(['owner']);
    const p = {id: d.id || hex(12), name: text_(d.name, 40), type: d.type, value: Number(d.value), minTotal: Number(d.minTotal || 0),
      startHour: Number(d.startHour === undefined || d.startHour === '' ? 0 : d.startHour), endHour: Number(d.endHour === undefined || d.endHour === '' ? 24 : d.endHour), active: d.active === true};
    assert(p.name && /^[a-zA-Z0-9_-]{1,40}$/.test(p.id), 'Tên hoặc mã khuyến mãi không hợp lệ.');
    assert(['percent', 'amount'].includes(p.type), 'Loại khuyến mãi không hợp lệ.');
    if (p.type === 'percent') assert(Number.isInteger(p.value) && p.value >= 1 && p.value <= TIEMVIO.promo.maxPercent, 'Giảm theo % từ 1 đến ' + TIEMVIO.promo.maxPercent + '.');
    else assert(Number.isInteger(p.value) && p.value >= 1000 && p.value <= TIEMVIO.promo.maxAmount, 'Giảm theo số tiền từ 1.000đ đến ' + TIEMVIO.promo.maxAmount.toLocaleString('vi-VN') + 'đ.');
    assert(Number.isInteger(p.minTotal) && p.minTotal >= 0 && p.minTotal <= 10000000, 'Đơn tối thiểu không hợp lệ.');
    assert(Number.isInteger(p.startHour) && Number.isInteger(p.endHour) && p.startHour >= 0 && p.endHour <= 24 && p.startHour < p.endHour, 'Khung giờ áp dụng không hợp lệ (0–24, giờ bắt đầu nhỏ hơn giờ kết thúc).');
    const batch = fs.writeBatch(db);
    batch.set(ref('promos', p.id), p);
    await commit(batch);
    return p;
  }

  async function deletePromo(d) {
    allow(['owner']);
    const id = String(d.id || '');
    assert(cache.promos.has(id), 'Không tìm thấy khuyến mãi.');
    const batch = fs.writeBatch(db);
    batch.delete(ref('promos', id));
    await commit(batch);
    return {ok: true};
  }

  /* ---------------- time clock: staff see only their own, the owner sees everyone ---------------- */
  function mergeClock() { cache.clock = [...new Map([...cache.clockRecent, ...cache.clockOpen].map(x => [x.id, x])).values()].sort((a,b) => b.inAt.localeCompare(a.inAt)); }
  const warningOf = entry => clockWarning(entry, [...cache.schedule.values()], now().getTime(), tz);
  const myOpenClock = () => cache.clock.find(x => x.email === me.email && !x.outAt) || null;
  async function clockIn() {
    allow(['owner', 'sales']);
    assert(!myOpenClock(), 'Bạn đang trong ca chấm công. Hãy tan ca trước.');
    const id = hex(16);
    const e = {email: me.email, name: me.name || me.email, inAt: iso(), outAt: ''};
    const batch = fs.writeBatch(db);
    batch.set(ref('timeclock', id), e);
    await commit(batch);
    cache.clock.unshift({...e, id});
    notify({type: 'presence', clocked: true});
    return {id, ...e};
  }
  async function clockOut(d) {
    allow(['owner', 'sales']);
    const entry = d.id ? cache.clock.find(x => x.id === d.id) : myOpenClock();
    assert(entry && !entry.outAt, 'Không có ca chấm công đang mở.');
    assert(entry.email === me.email, 'Hãy dùng chấm thoát hộ, chọn giờ thực tế và nhập lý do.');
    const outAt = iso();
    const batch = fs.writeBatch(db);
    batch.update(ref('timeclock', entry.id), {outAt});
    await commit(batch);
    entry.outAt = outAt;
    notify({type: 'presence', clocked: false, email: entry.email === me.email ? undefined : entry.email});
    return {...entry};
  }
  async function adjustClockOut(d) {
    allow(['owner']);
    assert(typeof d.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(d.id), 'Mã chấm công không hợp lệ.');
    assert(typeof d.mutationId === 'string' && /^[a-zA-Z0-9_-]{1,60}$/.test(d.mutationId), 'Mã điều chỉnh không hợp lệ.');
    const reason = text_(d.reason, 300), end = Date.parse(d.outAt);
    assert(reason.length >= 3, 'Hãy nhập lý do điều chỉnh, ít nhất 3 ký tự.');
    assert(Number.isFinite(end) && end <= now().getTime(), 'Giờ tan ca không được ở tương lai.');
    const outAt = new Date(end).toISOString();
    const result = await fs.runTransaction(db, async tx => {
      const doc = await tx.get(ref('timeclock', d.id)); assert(doc.exists(), 'Không tìm thấy lượt chấm công.');
      const entry = doc.data(), edits = entry.adjustments || [];
      const previous = edits.find(e => e.id === d.mutationId);
      if (previous) { assert(previous.by === me.email && previous.toOutAt === outAt && previous.reason === reason, 'Mã điều chỉnh đã được sử dụng.'); return {...entry, id: d.id}; }
      assert(entry.outAt === d.expectedOutAt, 'Ca vừa được thay đổi. Hãy tải lại rồi kiểm tra giờ trước khi sửa.');
      assert(end >= Date.parse(entry.inAt), 'Giờ tan ca phải bằng hoặc sau giờ vào ca.');
      assert(outAt !== entry.outAt, 'Giờ tan ca chưa thay đổi.');
      assert(edits.length < 200, 'Ca này đã đạt giới hạn 200 lần điều chỉnh.');
      const stamp = now().getTime();
      const edit = {id: d.mutationId, by: me.email, byName: text_(me.name || me.email, 100), at: new Date(stamp).toISOString(), atMs: stamp, fromOutAt: entry.outAt, toOutAt: outAt, toOutAtMs: end, reason};
      const adjustments = [...edits, edit]; tx.update(ref('timeclock', d.id), {outAt, adjustments});
      return {...entry, id: d.id, outAt, adjustments};
    });
    cache.clockRecent = cache.clockRecent.map(x => x.id === d.id ? result : x); cache.clockOpen = cache.clockOpen.filter(x => x.id !== d.id); mergeClock();
    // Another active clock-in, if any, must continue receiving staff order notifications.
    try {
      const active = await fs.getDocs(fs.query(col('timeclock'), fs.where('email', '==', result.email), fs.where('outAt', '==', '')));
      notify({type: 'presence', clocked: !active.empty, email: result.email});
    } catch (_) { /* A notification failure must not turn a committed payroll correction into an apparent failure. */ }
    return result;
  }
  const minutesBetween = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000));

  /* ---------------- reports ---------------- */
  async function report(d) {
    allow(['owner', 'support']);
    const from = RE_DAY.test(d.from || '') ? d.from : dayOf(now());
    const to = RE_DAY.test(d.to || '') ? d.to : from;
    assert(to >= from, 'Ngày kết thúc phải sau hoặc bằng ngày bắt đầu.');
    assert((Date.parse(to) - Date.parse(from)) / 86400000 <= 92, 'Khoảng báo cáo tối đa 93 ngày.');
    const r = {from, to, total: 0, count: 0, cash: 0, transfer: 0, refundTotal: 0, refundCount: 0, unpaid: 0, discount: 0, manualDiscount: 0, promoDiscount: 0, cogs: 0, expenses: 0, expenseList: [], profit: 0, unreconciled: []};
    const top = {}, channels = {}, staff = {}, hours = {};
    const groups = {drink: {total: 0, count: 0, cups: 0}, food: {total: 0, count: 0}};
    const add = (map, key, extra, b) => { const t = map[key] = map[key] || {...extra, total: 0, count: 0, cups: 0}; t.total += Number(b.total) || 0; t.count += Number(b.count) || 0; t.cups += Number(b.cups) || 0; };
    const days = [];
    let stats, expenses, unpaid, unrec, clocks;
    try {
      const dayBefore = new Date(Date.parse(from) - 86400000).toISOString(), dayAfter = new Date(Date.parse(to) + 2 * 86400000).toISOString();
      [stats, expenses, unpaid, unrec, clocks] = await Promise.all([
        fs.getDocs(fs.query(col('stats'), fs.where('day', '>=', from), fs.where('day', '<=', to))),
        fs.getDocs(fs.query(col('expenses'), fs.where('day', '>=', from), fs.where('day', '<=', to))),
        fs.getDocs(fs.query(col('orders'), fs.where('unpaid', '==', true))),
        fs.getDocs(fs.query(col('orders'), fs.where('unreconciled', '==', true))),
        fs.getDocs(fs.query(col('timeclock'), fs.where('inAt', '>=', dayBefore), fs.where('inAt', '<=', dayAfter)))
      ]);
      stats.docs.map(x => x.data()).sort((a, b) => a.day.localeCompare(b.day)).forEach(s => {
        ['total', 'count', 'cups', 'cash', 'transfer', 'refundTotal', 'refundCount', 'discount', 'manualDiscount', 'promoDiscount', 'cogs'].forEach(k => { r[k] = (r[k] || 0) + (Number(s[k]) || 0); });
        Object.keys(s.channels || {}).forEach(k => add(channels, k, {}, s.channels[k]));
        Object.keys(s.staff || {}).forEach(k => add(staff, k, {name: s.staff[k].name}, s.staff[k]));
        Object.keys(s.hours || {}).forEach(k => add(hours, k, {}, s.hours[k]));
        ['drink', 'food'].forEach(k => { const g = (s.kinds || {})[k]; if (g) { groups[k].total += Number(g.total) || 0; groups[k].count += Number(g.count) || 0; if (k === 'drink') groups.drink.cups += Number(g.cups) || 0; } });
        if ((s.count || 0) > 0 || (s.total || 0) > 0) days.push({day: s.day, total: Number(s.total) || 0, count: Number(s.count) || 0, cups: Number(s.cups) || 0});
        Object.keys(s.top || {}).forEach(pid => {
          const t = top[pid] = top[pid] || {name: s.top[pid].name, kind: s.top[pid].kind || ((cache.menu.get(pid) || {}).kind === 'food' ? 'food' : 'drink'), unit: s.top[pid].unit || 'ly', quantity: 0, revenue: 0};
          t.quantity += Number(s.top[pid].quantity) || 0; t.revenue += Number(s.top[pid].revenue) || 0;
        });
      });
      expenses.docs.map(x => x.data()).filter(e => e.voided !== true).sort((a, b) => a.at.localeCompare(b.at)).forEach(e => {
        r.expenses += Number(e.amount);
        if (r.expenseList.length < 100) r.expenseList.push({id: e.id, at: e.at, category: e.category, amount: Number(e.amount), note: e.note});
      });
      unpaid.docs.map(x => toOrder({...x.data(), id: x.id})).forEach(o => {
        const created = dayOf(o.createdAt);
        if (o.status !== 'cancelled' && !o.paid && created >= from && created <= to) r.unpaid += o.total;
      });
      unrec.docs.map(x => toOrder({...x.data(), id: x.id})).forEach(o => {
        const paidDay = o.paidAt ? dayOf(o.paidAt) : '';
        if (o.paid && splitOf(o).transfer > 0 && o.status !== 'cancelled' && !o.reconciled && paidDay >= from && paidDay <= to ) {
          r.unreconciled.push({id: o.id, seq: o.seq, total: splitOf(o).transfer, customer: o.customer, paidAt: o.paidAt, version: o.version});
        }
      });
    } catch (e) { throw friendly(e); }
    r.profit = r.total - r.expenses;
    r.grossProfit = r.total - r.cogs;           // revenue minus ingredient cost (only meaningful once ingredient costs are entered)
    r.channels = TIEMVIO.channels.map(c => ({id: c.id, name: c.name, total: (channels[c.id] || {}).total || 0, count: (channels[c.id] || {}).count || 0, cups: (channels[c.id] || {}).cups || 0})).filter(c => c.count > 0 || c.total > 0);
    r.staff = Object.values(staff).filter(x => x.count > 0 || x.total > 0).map(x => ({...x, email: x.name, name: personName(x.name)})).sort((a, b) => b.total - a.total);
    r.hours = Object.keys(hours).map(h => ({hour: Number(h), total: hours[h].total, count: hours[h].count, cups: hours[h].cups})).filter(h => h.count > 0 || h.total > 0).sort((a, b) => a.hour - b.hour);
    const worked = {};
    clocks.docs.map(x => x.data()).filter(x => dayOf(x.inAt) >= from && dayOf(x.inAt) <= to).forEach(x => {
      const w = worked[x.email] = worked[x.email] || {email: x.email, name: x.name, minutes: 0, shifts: 0, open: false};
      w.minutes += minutesBetween(x.inAt, x.outAt || iso()); w.shifts += 1; if (!x.outAt) w.open = true;
    });
    r.worked = Object.values(worked).map(w => ({...w, name: personName(w.email) || w.name})).sort((a, b) => b.minutes - a.minutes);
    r.days = days;
    const ranked = Object.values(top).map(t => ({...t, quantity: Math.round(t.quantity * 10) / 10})).filter(t => t.quantity > 0).sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue);
    r.top = ranked.slice(0, 10);
    r.topDrinks = ranked.filter(t => t.kind !== 'food').slice(0, 10);
    r.topFood = ranked.filter(t => t.kind === 'food').slice(0, 10);
    r.groups = groups;
    r.groupsComplete = groups.drink.total + groups.food.total === r.total;       // false only if some days were stored before the split existed
    return r;
  }

  /** Owner-only full backup (JSON): every collection, for safekeeping. */
  /* ---------------- staff work schedule: the owner plans, every staff member can see the week ---------------- */
  const RE_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
  const SCHEDULE_COLORS = 10;                       // the screen has 10 distinct colours; each person keeps theirs
  const addDays = (day, n) => { const t = new Date(day + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const mondayOf = day => { const t = new Date(day + 'T00:00:00Z'); return addDays(day, -((t.getUTCDay() + 6) % 7)); };
  const mins = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  const SCHEDULE_KEEP_DAYS = 60;                    // shifts older than this are removed automatically (see pruneSchedule)
  const planView = x => ({id: x.id, email: x.email, name: personName(x.email) || x.name, day: x.day, start: x.start, end: x.end, note: x.note || ''});
  // A read that never answers (flaky phone connection, missing index) must not leave a screen on "loading" forever.
  const within = (promise, ms, message) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new TiemvioError(message)), ms))]);
  /** All shifts we hold: from the live copy (instant), or a plain read if the live copy is not ready or failed. */
  async function scheduleDocs(from, to) {
    const ready = cache.scheduleReady ? await Promise.race([cache.scheduleReady, new Promise(r => setTimeout(() => r(false), 4000))]) : false;
    if (ready) return [...cache.schedule.values()];
    const q = (me.role === 'owner' || me.role === 'support')
      ? fs.query(col('schedule'), fs.where('day', '>=', from), fs.where('day', '<=', to))
      : fs.query(col('schedule'), fs.where('email', '==', me.email));
    try { return (await within(fs.getDocs(q), 12000, 'Không tải được lịch làm (mạng chậm hoặc mất kết nối). Hãy thử lại.')).docs.map(x => ({...x.data(), id: x.id})); }
    catch (e) { throw friendly(e); }
  }
  async function scheduleWeek(d) {
    allow(['owner', 'sales', 'support']);
    const from = RE_DAY.test(d.from || '') ? mondayOf(d.from) : mondayOf(dayOf(now()));
    const to = addDays(from, 6);
    // a staff member only ever gets their own shifts
    const shifts = (await scheduleDocs(from, to)).filter(x => x.day >= from && x.day <= to && (me.role !== 'sales' || x.email === me.email))
      .map(planView).sort((a, b) => a.day.localeCompare(b.day) || a.start.localeCompare(b.start) || a.name.localeCompare(b.name));
    // Actual clock-in/out comes from the live time-clock copy: no extra round trip (owner: everyone's recent ones, staff: their own).
    const clock = [...new Map(cache.clock.map(x => [x.id || x.inAt + x.email, x])).values()].filter(x => x.inAt && dayOf(x.inAt) >= from && dayOf(x.inAt) <= to && (me.role !== 'sales' || x.email === me.email))
      .map(x => ({id: x.id, email: x.email, name: personName(x.email) || x.name || x.email, day: dayOf(x.inAt), inAt: x.inAt, outAt: x.outAt || '', adjustments: x.adjustments || [], warning: warningOf(x), minutes: minutesBetween(x.inAt, x.outAt || iso())}))
      .sort((a, b) => a.inAt.localeCompare(b.inAt));
    return {from, to, today: dayOf(now()), shifts, clock, colors: cache.settings.staffColors || {}, colorCount: SCHEDULE_COLORS};
  }
  /** Each person gets the first colour nobody else uses, and keeps it. */
  function colorFor(email, colors) {
    if (colors[email] !== undefined) return {colors, added: false};
    const used = new Set(Object.values(colors));
    let idx = 0; while (used.has(idx) && idx < SCHEDULE_COLORS - 1) idx++;
    if (used.size >= SCHEDULE_COLORS) idx = Object.keys(colors).length % SCHEDULE_COLORS;
    return {colors: {...colors, [email]: idx}, added: true};
  }
  async function saveShift(d) {
    allow(['owner']);
    const email = email_(d.email);
    const person = [...cache.users.values()].find(u => u.email === email);
    assert(person && person.active === true, 'Hãy chọn nhân viên đang hoạt động.');
    assert(RE_TIME.test(d.start || '') && RE_TIME.test(d.end || ''), 'Giờ làm không hợp lệ (dạng 07:30).');
    assert(mins(d.end) > mins(d.start), 'Giờ kết thúc phải sau giờ bắt đầu trong cùng một ngày.');
    const note = text_(d.note, 60);
    const days = d.id ? [d.day] : (Array.isArray(d.days) ? d.days : [d.day]);
    assert(days.length >= 1 && days.length <= 7 && days.every(x => RE_DAY.test(x || '')), 'Hãy chọn ngày làm.');
    const known = d.id && (cache.schedule.has(String(d.id)) || (await fs.getDoc(ref('schedule', String(d.id)))).exists());
    assert(!d.id || known, 'Không tìm thấy ca làm.');
    // the same person cannot be in two overlapping shifts; two different people can share a shift
    const lo = [...days].sort()[0], hi = [...days].sort().slice(-1)[0];
    const mates = (await scheduleDocs(lo, hi)).filter(x => x.day >= lo && x.day <= hi);
    for (const day of new Set(days)) {
      const clash = mates.find(x => x.email === email && x.day === day && x.id !== d.id && mins(x.start) < mins(d.end) && mins(d.start) < mins(x.end));
      assert(!clash, person.name + ' đã có ca ' + clash?.start + '–' + clash?.end + ' ngày ' + day.split('-').reverse().join('-') + ' trùng giờ.');
    }
    const batch = fs.writeBatch(db);
    const ids = [];
    for (const day of new Set(days)) {
      const id = d.id ? String(d.id) : hex(12);
      ids.push(id);
      batch.set(ref('schedule', id), {id, email, name: person.name || email, day, start: d.start, end: d.end, note, by: me.email});
    }
    const c = colorFor(email, cache.settings.staffColors || {});
    if (c.added) batch.set(ref('settings', 'shop'), {staffColors: c.colors}, {merge: true});
    await commit(batch);
    return {ok: true, ids};
  }
  async function deleteShift(d) {
    allow(['owner']);
    const id = String(d.id || '');
    assert(id, 'Không tìm thấy ca làm.');
    const batch = fs.writeBatch(db);
    batch.delete(ref('schedule', id));
    await commit(batch);
    return {ok: true};
  }
  /** Automatic clean-up: shifts more than 60 days old are removed. Spark has no scheduled jobs (and Firestore TTL needs a paid plan),
   *  so the owner's app does it whenever the owner opens the app; staff cannot delete, which the rules enforce. */
  async function pruneSchedule() {
    allow(['owner']);
    const cutoff = addDays(dayOf(now()), -SCHEDULE_KEEP_DAYS);
    let snap;
    try { snap = await fs.getDocs(fs.query(col('schedule'), fs.where('day', '<', cutoff))); } catch (e) { throw friendly(e); }
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = fs.writeBatch(db);
      snap.docs.slice(i, i + 400).forEach(x => batch.delete(ref('schedule', x.id)));
      try { await commit(batch); } catch (e) { throw friendly(e); }
    }
    return {removed: snap.docs.length};
  }
  async function copyWeek(d) {
    allow(['owner']);
    const to = mondayOf(RE_DAY.test(d.from || '') ? d.from : dayOf(now())), prev = addDays(to, -7);
    const both = await scheduleDocs(prev, addDays(to, 6));
    const snap = {docs: both.filter(x => x.day >= prev && x.day <= addDays(prev, 6)).map(x => ({data: () => x}))};
    const cur = {docs: both.filter(x => x.day >= to && x.day <= addDays(to, 6)).map(x => ({data: () => x}))};
    const have = new Set(cur.docs.map(x => { const v = x.data(); return [v.email, v.day, v.start, v.end].join('|'); }));
    const active = new Map([...cache.users.values()].filter(u => u.active === true).map(u => [u.email, u]));
    const batch = fs.writeBatch(db);
    let copied = 0, skipped = 0;
    snap.docs.forEach(x => {
      const v = x.data(), nd = addDays(v.day, 7), key = [v.email, nd, v.start, v.end].join('|');
      if (have.has(key) || !active.has(v.email)) { skipped++; return; }
      const id = hex(12);
      batch.set(ref('schedule', id), {id, email: v.email, name: active.get(v.email).name || v.email, day: nd, start: v.start, end: v.end, note: v.note || '', by: me.email});
      copied++;
    });
    if (copied) await commit(batch);
    return {copied, skipped};
  }

  /* ---------------- storage usage and clearing old data ---------------- */
  const QUOTA_BYTES = 1024 * 1024 * 1024;           // Firestore free (Spark) storage: 1 GiB
  const MIN_KEEP_DAYS = 30;
  const USAGE_COLLECTIONS = [['orders', 'Đơn hàng'], ['stats', 'Thống kê theo ngày'], ['expenses', 'Chi phí'], ['timeclock', 'Giờ làm nhân viên'], ['shifts', 'Ca tiền mặt'], ['stockLog', 'Lịch sử kho'],
    ['customers', 'Khách hàng'], ['menu', 'Thực đơn'], ['menuImages', 'Ảnh món'], ['inventory', 'Kho nguyên liệu'], ['recipes', 'Công thức'], ['users', 'Tài khoản'], ['promos', 'Khuyến mãi'], ['counters', 'Bộ đếm số đơn'], ['schedule', 'Lịch làm nhân viên']];
  const utf8 = s => new TextEncoder().encode(s).length;
  // Firestore does not tell an app how much it stores, so this estimates it: document count x average size of a sample, plus indexes.
  async function storageUsage() {
    allow(['owner', 'support']);
    const rows = [];
    try {
      for (const [name, label] of USAGE_COLLECTIONS) {
        const c = col(name);
        const count = fs.getCountFromServer ? Number((await fs.getCountFromServer(c)).data().count) : (await fs.getDocs(c)).size;
        let avg = 0;
        if (count) {
          const sample = await fs.getDocs(fs.query(c, fs.limit(15)));
          const sizes = sample.docs.map(x => utf8(JSON.stringify(x.data())) + x.id.length + 32);
          avg = sizes.reduce((a, b) => a + b, 0) / Math.max(1, sizes.length);
        }
        rows.push({name, label, count, bytes: Math.round(count * avg * 1.4)});   // x1.4: index entries
      }
    } catch (e) { throw friendly(e); }
    const used = rows.reduce((n, r) => n + r.bytes, 0);
    return {quotaBytes: QUOTA_BYTES, usedBytes: used, freeBytes: Math.max(0, QUOTA_BYTES - used), estimated: true, collections: rows};
  }
  const cutoffDay = keep => dayOf(now() - keep * 86400000);
  /** What the cleanup would remove (or removes). Newest days are always kept: keepDays can never go below 30. */
  async function cleanupOldData(d) {
    allow(['owner']);
    const keep = Number(d.keepDays);
    assert(Number.isInteger(keep) && keep >= MIN_KEEP_DAYS && keep <= 3650, 'Phải giữ lại ít nhất ' + MIN_KEEP_DAYS + ' ngày gần nhất.');
    const kinds = Array.isArray(d.kinds) ? d.kinds : [];
    assert(kinds.length && kinds.every(k => ['orders', 'timeclock', 'expenses', 'other'].includes(k)), 'Hãy chọn loại dữ liệu cần xóa.');
    const cutoff = cutoffDay(keep);
    const targets = [];   // [collection, query, filter]
    if (kinds.includes('orders')) targets.push(['orders', fs.query(col('orders'), fs.where('createdDay', '<', cutoff)), x => ['delivered', 'cancelled'].includes(x.status) && x.unreconciled !== true]);
    if (kinds.includes('expenses')) targets.push(['expenses', fs.query(col('expenses'), fs.where('day', '<', cutoff)), () => true]);
    if (kinds.includes('timeclock')) targets.push(['timeclock', fs.query(col('timeclock'), fs.where('inAt', '<', cutoff)), x => !!x.outAt]);
    if (kinds.includes('other')) {
      targets.push(['shifts', fs.query(col('shifts'), fs.where('openedAt', '<', cutoff)), x => !!x.closedAt]);
      targets.push(['stockLog', fs.query(col('stockLog'), fs.where('at', '<', cutoff)), () => true]);
      targets.push(['counters', fs.query(col('counters'), fs.where('day', '<', cutoff)), () => true]);
    }
    const counts = {}; let total = 0; const doomed = [];
    try {
      for (const [name, q, keepIf] of targets) {
        const snap = await fs.getDocs(q);
        const hit = snap.docs.filter(x => keepIf(x.data()));
        counts[name] = hit.length; total += hit.length;
        if (d.dryRun !== true) hit.forEach(x => doomed.push(x.ref || ref(name, x.id)));
      }
      if (d.dryRun !== true) {
        for (let i = 0; i < doomed.length; i += 400) {
          const batch = fs.writeBatch(db);
          doomed.slice(i, i + 400).forEach(r => batch.delete(r));
          await commit(batch);
        }
      }
    } catch (e) { throw friendly(e); }
    return {dryRun: d.dryRun === true, keepDays: keep, before: cutoff, counts, total};
  }
  /** The orders one person collected in a date range (for the revenue screen). Owner only. */
  async function staffOrders(d) {
    allow(['owner', 'support']);
    const email = email_(d.email);
    assert(email, 'Chưa chọn nhân viên.');
    const from = RE_DAY.test(d.from || '') ? d.from : dayOf(now()), to = RE_DAY.test(d.to || '') ? d.to : from;
    assert(to >= from, 'Ngày kết thúc phải sau hoặc bằng ngày bắt đầu.');
    assert((Date.parse(to) - Date.parse(from)) / 86400000 <= 92, 'Khoảng thời gian tối đa 93 ngày.');
    let snap;
    try { snap = await fs.getDocs(fs.query(col('orders'), fs.where('paidBy', '==', email), fs.where('paidDay', '>=', from), fs.where('paidDay', '<=', to))); }
    catch (e) { if (e && e.code === 'failed-precondition') throw new TiemvioError('Hệ thống đang tạo chỉ mục cho tính năng này, hãy thử lại sau vài phút.'); throw friendly(e); }
    const orders = snap.docs.map(x => toOrder({...x.data(), id: x.id})).sort((a, b) => b.paidAt.localeCompare(a.paidAt));
    const live = orders.filter(o => o.status !== 'cancelled');         // refunded orders are listed but do not count, as in the totals
    return {email, name: personName(email), from, to, count: live.length, total: live.reduce((n, o) => n + o.total, 0), refunded: orders.length - live.length,
      orders: orders.map(o => ({id: o.id, seq: o.seq, status: o.status, paid: o.paid, total: o.total, paymentMethod: o.paymentMethod, cashPart: o.cashPart, customer: o.customer, channel: o.channel,
        createdAt: o.createdAt, paidAt: o.paidAt, creatorName: o.creatorName, paidByName: o.paidByName, items: o.items, stop: o.stop}))};
  }
  async function exportAll() {
    allow(['owner']);
    const out = {app: 'tiemvio-pos', version: TIEMVIO.version, exportedAt: iso(), collections: {}};
    for (const name of ['users', 'menu', 'menuImages', 'inventory', 'recipes', 'customers', 'expenses', 'shifts', 'stats', 'orders', 'promos', 'stockLog', 'timeclock', 'counters', 'schedule']) {
      const s = await fs.getDocs(col(name));
      out.collections[name] = s.docs.map(x => ({id: x.id, ...x.data()}));
    }
    return out;
  }

  /* ---------------- dispatcher ---------------- */
  const handlers = {
    snapshot, createOrder, updateOrder, editOrder, restructureOrders, reconcileAll, saveMenu, deleteMenu, deleteIngredient, deleteUser, deletePromo, reorderMenu, saveMenuImage, menuImages: async () => menuImages(), saveUser, saveSettings, saveLoyalty, staffOrders, saveIceOptions, saveSugarOptions, scheduleWeek, saveShift, deleteShift, copyWeek, pruneSchedule, storageUsage, cleanupOldData, getAiConfig, saveAiConfig, listAiChats, createAiChat, saveAiTurn, loadAiChat, pruneAiChats, saveDiscountReasons, saveCancelReasons, saveMenuCategories,
    saveIngredient, adjustStock, saveRecipe, saveExpense, openShift, closeShift, lookupCustomer, report, exportAll, savePromo, clockIn, clockOut, adjustClockOut,
    version: async () => ({version: TIEMVIO.version}), logout: async () => true
  };
  async function call(action, data = {}) {
    const fn = handlers[action];
    if (!fn) throw new TiemvioError('Chức năng không hợp lệ.');
    try { return await fn(data); }
    catch (e) { throw friendly(e); }
  }

  return {
    attach, call, dayOf,
    detach: () => { stopListeners(); me = null; },
    onChange: fn => { changeHandler = fn; },
    onSignedOut: fn => { signedOutHandler = fn; },
    onNotify: fn => { notifyHandler = fn; },
    onProblem: fn => { problemHandler = fn; },
    clocked: () => !!(me && cache.clock.find(x => x.email === me.email && !x.outAt)),
    user: () => (me ? {...me} : null)
  };
}
