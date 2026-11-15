// Runs the real Firestore backend + the real Security Rules against the Firebase emulator.
//   npm run test:web      (starts the emulator, needs Java 21+)
import test, {before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import fsys from 'node:fs';
import {initializeTestEnvironment, assertFails, assertSucceeds} from '@firebase/rules-unit-testing';
import * as F from 'firebase/firestore';
import {createBackend, DEFAULT_MENU} from '../web/src/backend.js';
import {runTurn, createToolRunner, TOOLS, toOpenAI, fromOpenAI, listModels} from '../web/src/ai.js';

// Fixed menu for the logic tests (so prices stay put); the shop's real menu has its own test below.
const TEST_MENU = [
  ['milk', 'Trà sữa truyền thống', 'Trà sữa', 25000, 30000, 'drink'],
  ['oolong', 'Trà sữa ô long', 'Trà sữa', 30000, 35000, 'drink'],
  ['peach', 'Trà đào cam sả', 'Trà trái cây', 30000, 35000, 'drink'],
  ['lychee', 'Trà vải', 'Trà trái cây', 28000, 33000, 'drink'],
  ['matcha', 'Matcha sữa', 'Đặc biệt', 35000, 40000, 'drink'],
  ['pearl', 'Trân châu đen', 'Topping', 5000, 5000, 'topping'],
  ['pudding', 'Pudding trứng', 'Topping', 7000, 7000, 'topping']
];

const OWNER = 'owner@test.com', SALES = 'sales@test.com', STRANGER = 'stranger@test.com';
const rules = fsys.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8')
  .replace(/function ownerEmail\(\) \{ return '[^']*'; \}/, `function ownerEmail() { return '${OWNER}'; }`);
const fs = {
  collection: F.collection, doc: F.doc, getDoc: F.getDoc, getDocs: F.getDocs, getCountFromServer: F.getCountFromServer, onSnapshot: F.onSnapshot, query: F.query,
  where: F.where, orderBy: F.orderBy, limit: F.limit, writeBatch: F.writeBatch, runTransaction: F.runTransaction, increment: F.increment, arrayUnion: F.arrayUnion
};

let env;
const open = [];
before(async () => { env = await initializeTestEnvironment({projectId: 'demo-tiemvio', firestore: {rules}}); });
after(async () => { await env.cleanup(); });
beforeEach(async () => {
  await Promise.all(open.splice(0).map(b => b.detach()));
  // Each test gets fresh SDK clients: an old menu listener/seed must not repopulate the next test's database.
  await env.cleanup();
  env = await initializeTestEnvironment({projectId: 'demo-tiemvio', firestore: {rules}});
  await env.clearFirestore();
});

const rawDb = email => env.authenticatedContext('uid-' + email, {email, email_verified: true}).firestore();
async function phone(email, name = '', seedMenu = TEST_MENU) {
  const b = createBackend({fs, db: rawDb(email), projectId: 'demo-tiemvio', seedMenu});
  open.push(b);
  const r = await b.attach(email, name);
  return {b, r, call: (a, d) => b.call(a, d)};
}
async function seedUser(email, role, active = true) {
  await env.withSecurityRulesDisabled(async ctx => {
    await F.setDoc(F.doc(ctx.firestore(), 'users', email), {email, name: email, role, active});
  });
}
const key = () => crypto.randomUUID();
const addCategory = async (o, name) => { const cur = (await o.call('snapshot', {})).menuCategories; if (!cur.includes(name)) await o.call('saveMenuCategories', {categories: [...cur, name]}); };
const drink = (extra = {}) => ({productId: 'milk', size: 'M', sugar: 50, ice: 'less', quantity: 1, toppings: [], note: '', ...extra});
const order = (over = {}) => ({requestKey: key(), items: [drink()], customer: 'Khách', service: 'takeaway', paymentMethod: 'cash', paid: true, ...over});
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) { try { const v = await fn(); if (v) return v; } catch (_) { /* retry */ } if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 40)); }
};

test('loyalty program is shared, reassigns tiers without rewriting balances, and staff cannot edit it', async()=>{
 const o=await phone(OWNER);await seedUser(SALES,'sales');const s=await phone(SALES);
 const phoneNumber='0900000888';await o.call('createOrder',order({phone:phoneNumber,items:[drink({quantity:4})]}));
 const config={earnPerVnd:5000,pointValue:2000,maxRedeemShare:0.8,tiers:[{id:'vip',name:'VIP',min:50000,mult:2},{id:'member',name:'Khách mới',min:0,mult:1}]};
 await assert.rejects(s.call('saveLoyalty',config),/quyền/);
 await o.call('saveLoyalty',config);
 const c=await o.call('lookupCustomer',{phone:phoneNumber});assert.equal(c.points,10);assert.equal(c.spent,100000);assert.equal(c.tier.id,'vip');
 await until(async()=> (await s.call('snapshot',{})).loyalty.earnPerVnd===5000);
 assert.equal((await s.call('snapshot',{})).tiers[1].name,'VIP');
 const paid=await s.call('createOrder',order({phone:phoneNumber}));assert.equal(paid.audit[0].earned,10);
 await o.call('saveLoyalty',{...config,earnPerVnd:1000});
 await o.call('updateOrder',{id:paid.id,version:1,change:'refund',reason:'Khác: Kiểm thử',mutationId:key()});
 assert.equal((await o.call('lookupCustomer',{phone:phoneNumber})).points,10);
});

test('loyalty rejects invalid rates, duplicate thresholds and a missing zero-spend tier',async()=>{
 const o=await phone(OWNER),good={earnPerVnd:10000,pointValue:1000,maxRedeemShare:0.5,tiers:[{id:'member',name:'Thành viên',min:0,mult:1}]};
 for(const bad of [{earnPerVnd:0},{pointValue:-1},{maxRedeemShare:2},{tiers:[]},{tiers:[{...good.tiers[0],min:1}]},{tiers:[good.tiers[0],{id:'vip',name:'VIP',min:0,mult:2}]},{tiers:[{...good.tiers[0],mult:0}]}])await assert.rejects(o.call('saveLoyalty',{...good,...bad}));
 assert.equal((await o.call('snapshot',{})).loyalty.earnPerVnd,10000);
});

test('editing and cancelling a redeemed order retain its original discount after policy changes',async()=>{
 const o=await phone(OWNER),phoneNumber='0900000889';
 await o.call('createOrder',order({phone:phoneNumber,items:[drink({quantity:4})]}));
 const made=await o.call('createOrder',order({phone:phoneNumber,paid:false,redeem:10,items:[drink({quantity:2})]}));assert.equal(made.total,40000);
 await o.call('saveLoyalty',{earnPerVnd:5000,pointValue:5000,maxRedeemShare:0.1,tiers:[{id:'member',name:'Thành viên',min:0,mult:1}]});
 const edited=await o.call('editOrder',{id:made.id,version:1,mutationId:key(),service:'takeaway',items:[drink({quantity:3})]});
 assert.equal(edited.total,65000);assert.equal(edited.discount,10000);
 await o.call('updateOrder',{id:made.id,version:2,change:'cancel',reason:'Khác: Kiểm thử',mutationId:key()});
 assert.equal((await o.call('lookupCustomer',{phone:phoneNumber})).points,10);
});

/* ---------------- sign-in and roles ---------------- */
test('owner signs in the first time, gets the default menu; strangers and locked users are refused', async () => {
  const o = await phone(OWNER, 'Chủ');
  assert.equal(o.r.ok, true);
  const snap = await o.call('snapshot', {});
  assert.equal(snap.user.role, 'owner');
  assert.equal(snap.menu.length, 7);
  assert.deepEqual(snap.menu.map(m => m.id).slice(0, 2), ['milk', 'oolong']);

  const s = await phone(STRANGER);
  assert.equal(s.r.ok, false);
  assert.match(s.r.error, /chưa được chủ quán cấp quyền/);

  await seedUser('locked@test.com', 'sales', false);
  const l = await phone('locked@test.com');
  assert.equal(l.r.ok, false);
});

test('owner can add staff and lock them; a locked phone is signed out at once', async () => {
  const o = await phone(OWNER);
  await o.call('saveUser', {email: 'Sales@Test.com', name: 'Lan', role: 'sales', active: true});
  const s = await phone(SALES);
  assert.equal(s.r.ok, true);
  let message = '';
  s.b.onSignedOut(m => { message = m; });
  await o.call('saveUser', {email: SALES, name: 'Lan', role: 'sales', active: false});
  await until(() => message);
  assert.match(message, /bị khóa|không còn quyền/);
  await assert.rejects(o.call('saveUser', {email: OWNER, role: 'sales', active: true}), /tự khóa/);
});

test('staff who sign in before being added get a clear message, and can sign in once added (no restart needed)', async () => {
  const o = await phone(OWNER);
  const early = await phone('Minh@Test.com'); // Google may report any capitalisation
  assert.equal(early.r.ok, false);
  assert.match(early.r.error, /minh@test\.com/, 'the message names the account that signed in');
  await o.call('saveUser', {email: '  MINH@test.com ', name: 'Minh', role: 'sales', active: true}); // owner typed spaces/capitals
  const retry = await phone('minh@test.com');
  assert.equal(retry.r.ok, true);
  const made = await retry.call('createOrder', order());
  assert.equal(made.creator, 'minh@test.com');
});

test('a locked staff member can be unlocked again and works normally', async () => {
  const o = await phone(OWNER);
  await o.call('saveUser', {email: SALES, name: 'Lan', role: 'sales', active: true});
  await o.call('saveUser', {email: SALES, name: 'Lan', role: 'sales', active: false});
  assert.equal((await phone(SALES)).r.ok, false);
  await o.call('saveUser', {email: SALES, name: 'Lan', role: 'sales', active: true});
  const back = await phone(SALES);
  assert.equal(back.r.ok, true);
  assert.equal((await back.call('snapshot', {})).user.role, 'sales');
});

test('changing a role signs the phone out so the next sign-in uses the new role', async () => {
  const o = await phone(OWNER);
  await o.call('saveUser', {email: SALES, name: 'Lan', role: 'sales', active: true});
  const s = await phone(SALES);
  let message = '';
  s.b.onSignedOut(m => { message = m; });
  await o.call('saveUser', {email: SALES, name: 'Lan', role: 'owner', active: true});
  await until(() => message);
  assert.match(message, /thay đổi/);
  const again = await phone(SALES);
  assert.equal((await again.call('snapshot', {})).user.role, 'owner');
});

/* ---------------- selling ---------------- */
test('a sale is priced on the phone, saved once, and reflected in the report totals', async () => {
  const o = await phone(OWNER);
  await seedUser(SALES, 'sales');
  const s = await phone(SALES);
  const req = key();
  const first = await s.call('createOrder', order({requestKey: req, items: [drink({size: 'L', quantity: 2, toppings: ['pearl']})]}));
  assert.equal(first.total, (30000 + 5000) * 2);
  const again = await s.call('createOrder', order({requestKey: req, items: [drink({quantity: 9})]}));
  assert.equal(again.id, first.id);
  assert.equal(again.total, first.total, 'a retry must not create or change the order');

  const snap = await o.call('snapshot', {});
  await until(async () => (await o.call('snapshot', {})).orders.length === 1);
  const day = snap.day;
  const rep = await o.call('report', {from: day, to: day});
  assert.equal(rep.total, 70000);
  assert.equal(rep.cash, 70000);
  assert.equal(rep.count, 1);
  assert.equal(rep.top[0].name, 'Trà sữa truyền thống');
  assert.equal(rep.top[0].quantity, 2);
});

test('prices come from the menu, not from the phone; bad input is rejected', async () => {
  const owner = await phone(OWNER);
  await seedUser(SALES, 'sales');
  await owner.call('saveDiscountReasons', {reasons: ['khách quen', 'Sinh nhật', 'khách quen', ' ', 'Khác']});
  const s = await phone(SALES);
  assert.deepEqual((await s.call('snapshot')).discountReasons, ['khách quen', 'Sinh nhật']);
  await assert.rejects(s.call('saveDiscountReasons', {reasons: ['tự thêm']}));
  await assert.rejects(s.call('createOrder', order({manualDiscount: 1000, discountReason: 'bạn bè'})), /chọn lý do/);
  await assert.rejects(s.call('createOrder', order({items: [drink({productId: 'nope'})]})), /không còn bán/);
  await assert.rejects(s.call('createOrder', order({items: [drink({size: 'XL'})]})), /không có size XL/);
  await assert.rejects(s.call('createOrder', order({items: [drink({quantity: 0})]})), /Số lượng/);
  await assert.rejects(s.call('createOrder', order({items: [drink({toppings: ['milk']})]})), /Topping/);
  await assert.rejects(s.call('createOrder', order({manualDiscount: 1000})), /lý do/);
  await assert.rejects(s.call('createOrder', order({manualDiscount: 20000, discountReason: 'bạn bè'})), /tối đa 30%/);
  await assert.rejects(s.call('createOrder', order({manualDiscount: 1000, discountReason: 'Khác: ab'})), /ít nhất 3 ký tự/);
  const other = await s.call('createOrder', order({manualDiscount: 1000, discountReason: 'Khác: bạn của chủ quán'}));
  assert.equal(other.manualDiscount, 1000);
  const ok = await s.call('createOrder', order({manualDiscount: 3000, discountReason: 'khách quen'}));
  assert.equal(ok.total, 22000);
  assert.equal(ok.manualDiscount, 3000);
});

test('a second phone sees an order from the first one without refreshing (live sync)', async () => {
  const owner = await phone(OWNER);
  await seedUser(SALES, 'sales');
  const cashier = await phone(SALES);
  let pings = 0;
  owner.b.onChange(() => { pings++; });
  const created = await cashier.call('createOrder', order({paid: false}));
  const seen = await until(async () => (await owner.call('snapshot', {})).orders.find(o => o.id === created.id));
  assert.equal(seen.paid, false);
  await until(() => pings > 0); // the UI is told when data changes
});

test('delivering an unpaid order collects payment, records change, earns points once', async () => {
  const o = await phone(OWNER);
  const created = await o.call('createOrder', order({paid: false, phone: '0901234567', customer: 'An', items: [drink({quantity: 4})]}));
  assert.equal(created.total, 100000);
  const done = await o.call('updateOrder', {id: created.id, version: 1, change: 'advance', mutationId: key(), paymentMethod: 'cash', cashReceived: 120000});
  assert.equal(done.status, 'delivered');
  assert.equal(done.paid, true);
  assert.equal(done.changeGiven, 20000);
  assert.equal(done.version, 2);
  const c = await o.call('lookupCustomer', {phone: '0901234567'});
  assert.equal(c.points, 10);

  const m = key();
  const sameAgain = await o.call('updateOrder', {id: created.id, version: 1, change: 'advance', mutationId: done.audit[1].key});
  assert.equal(sameAgain.version, 2, 'replaying the same mutation changes nothing');
  await assert.rejects(o.call('updateOrder', {id: created.id, version: 1, change: 'pay', mutationId: m, paymentMethod: 'cash'}), /cập nhật|đã thanh toán/);
  const rep = await o.call('report', {from: o.b.dayOf(new Date()), to: o.b.dayOf(new Date())});
  assert.equal(rep.total, 100000);
  assert.equal((await o.call('lookupCustomer', {phone: '0901234567'})).points, 10);
});

test('refund (owner only) takes the sale back out of totals, stock and points', async () => {
  const o = await phone(OWNER);
  await seedUser(SALES, 'sales');
  await o.call('saveIngredient', {id: 'tea', name: 'Trà', unit: 'g', minStock: 10, stock: 1000, active: true});
  await o.call('saveRecipe', {productId: 'milk', lines: [{ingredientId: 'tea', qty: 20}]});
  const s = await phone(SALES); // joins after the recipe exists, like a phone opened later in the day
  const snap = () => o.call('snapshot', {});
  const made = await s.call('createOrder', order({phone: '0911222333', items: [drink({quantity: 2}), drink({quantity: 1})]}));
  await until(async () => (await snap()).inventory[0].stock === 940);
  assert.equal((await o.call('lookupCustomer', {phone: '0911222333'})).points, 7);

  await assert.rejects(s.call('updateOrder', {id: made.id, version: 1, change: 'refund', reason: 'nhầm', mutationId: key()}), /quyền/);
  await assert.rejects(o.call('updateOrder', {id: made.id, version: 1, change: 'refund', reason: 'Khách đổi ý', mutationId: key()}), /trong danh sách/);
  await o.call('saveCancelReasons', {reasons: ['Khách đổi ý', 'Nhầm món']});
  await assert.rejects(o.call('updateOrder', {id: made.id, version: 1, change: 'refund', reason: 'tự gõ', mutationId: key()}), /trong danh sách/);
  await assert.rejects(o.call('updateOrder', {id: made.id, version: 1, change: 'refund', reason: 'Khác: ab', mutationId: key()}), /ít nhất 3 ký tự/);
  const refunded = await o.call('updateOrder', {id: made.id, version: 1, change: 'refund', reason: 'Khác: khách bỏ về', mutationId: key()});
  assert.equal(refunded.status, 'cancelled');
  await until(async () => (await snap()).inventory[0].stock === 1000);
  const day = o.b.dayOf(new Date());
  const rep = await o.call('report', {from: day, to: day});
  assert.equal(rep.total, 0);
  assert.equal(rep.refundTotal, 75000);
  assert.equal(rep.refundCount, 1);
  assert.equal((await o.call('lookupCustomer', {phone: '0911222333'})).points, 0);
});

test('loyalty: points can be redeemed up to 50% and not beyond the balance', async () => {
  const o = await phone(OWNER);
  await o.call('createOrder', order({phone: '0900000001', items: [drink({quantity: 10})]})); // 250.000đ -> 25 điểm
  assert.equal((await o.call('lookupCustomer', {phone: '0900000001'})).points, 25);
  await assert.rejects(o.call('createOrder', order({phone: '0900000001', redeem: 30})), /tối đa 50%/);
  await assert.rejects(o.call('createOrder', order({phone: '0900000001', redeem: 26, items: [drink({quantity: 20})]})), /không đủ điểm/);
  const r = await o.call('createOrder', order({phone: '0900000001', redeem: 10, items: [drink({quantity: 4})]}));
  assert.equal(r.total, 100000 - 10000);
  assert.equal((await o.call('lookupCustomer', {phone: '0900000001'})).points, 25 - 10 + 9);
});

test('bank transfers need reconciling, once, by the owner', async () => {
  const o = await phone(OWNER);
  const t = await o.call('createOrder', order({paymentMethod: 'transfer'}));
  const day = o.b.dayOf(new Date());
  let rep = await o.call('report', {from: day, to: day});
  assert.equal(rep.transfer, 25000);
  assert.equal(rep.unreconciled.length, 1);
  await o.call('updateOrder', {id: t.id, version: 1, change: 'reconcile', reason: 'khớp sao kê', mutationId: key()});
  rep = await o.call('report', {from: day, to: day});
  assert.equal(rep.unreconciled.length, 0);
});

test('support role: reads shop data but cannot change it, and cannot read the AI key', async () => {
  const o = await phone(OWNER);
  await o.call('createOrder', order());
  await o.call('saveAiConfig', {provider: 'openrouter', keys: {openrouter: 'sk-secret'}, models: {openrouter: 'x/y'}});
  await seedUser('help@test.com', 'support');
  const h = await phone('help@test.com');
  assert.equal(h.r.ok, true);
  const snap = await h.call('snapshot', {});
  assert.equal(snap.orders.length, 1);
  assert.ok((await h.call('report', {from: snap.day, to: snap.day})).total > 0);
  await assert.rejects(h.call('createOrder', order()), /quyền/);
  await assert.rejects(h.call('openShift', {openingCash: 1}), /quyền|permission/i);
  await assert.rejects(h.call('saveExpense', {category: 'x', amount: 1000}), /quyền/);
  await assert.rejects(h.call('saveMenu', {id: 'milk', name: 'x', category: 'Trà sữa', priceM: 1, priceL: 1, kind: 'drink', active: true}), /quyền/);
  assert.ok(!(await o.call('snapshot', {})).users.some(u => u.email === 'help@test.com'));   // not listed in the app
  const db = rawDb('help@test.com');
  await assertFails(F.setDoc(F.doc(db, 'orders', 'zzz'), {total: 1}));
  await assertFails(F.setDoc(F.doc(db, 'settings', 'shop'), {x: 1}));
  await assertFails(F.getDoc(F.doc(db, 'aiConfig', 'shared')));
  await assertSucceeds(F.getDocs(F.collection(db, 'stats')));
  await assertSucceeds(F.getDocs(F.collection(db, 'expenses')));
});

test('cash shift: opening and closing cash are not capped at 1,000,000', async () => {
  const o = await phone(OWNER);
  await o.call('openShift', {openingCash: 5000000});
  const closed = await o.call('closeShift', {closingCash: 7500000});
  assert.equal(closed.closingCash, 7500000);
  assert.equal(closed.difference, 2500000);
});

test('cash shift: expected cash = opening + cash sales; difference is recorded on close', async () => {
  const o = await phone(OWNER);
  await o.call('openShift', {openingCash: 500000});
  await assert.rejects(o.call('openShift', {openingCash: 1}), /ca mở/);
  await o.call('createOrder', order({items: [drink({quantity: 2})]}));
  await o.call('createOrder', order({paymentMethod: 'transfer'}));
  const closed = await o.call('closeShift', {closingCash: 540000, note: 'thiếu 10k'});
  assert.equal(closed.expectedCash, 550000);
  assert.equal(closed.difference, -10000);
  assert.equal((await o.call('snapshot', {})).shift, null);
});

test('expenses reduce the estimated profit; a voided expense does not count', async () => {
  const o = await phone(OWNER);
  await o.call('createOrder', order({items: [drink({quantity: 4})]}));
  const e = await o.call('saveExpense', {requestKey: key(), category: 'Nguyên liệu', amount: 30000, note: 'sữa'});
  const e2 = await o.call('saveExpense', {requestKey: key(), category: 'Khác', amount: 5000});
  await o.call('saveExpense', {requestKey: key(), void: true, id: e2.id});
  const day = o.b.dayOf(new Date());
  const rep = await o.call('report', {from: day, to: day});
  assert.equal(rep.expenses, 30000);
  assert.equal(rep.profit, 70000);
  assert.equal(rep.expenseList.length, 1);
  assert.equal(rep.expenseList[0].id, e.id);
});

test('menu photos are shared and the revision changes when one is replaced', async () => {
  const o = await phone(OWNER);
  const jpeg = 'data:image/jpeg;base64,' + 'A'.repeat(64);
  const before = (await o.call('snapshot', {})).imagesRev;
  await o.call('saveMenuImage', {productId: 'milk', image: jpeg});
  await until(async () => (await o.call('snapshot', {})).imagesRev !== before);
  assert.equal((await o.call('menuImages')).images.milk, jpeg);
  await assert.rejects(o.call('saveMenuImage', {productId: 'milk', image: 'data:image/png;base64,AAAA'}), /JPEG/);
});

test('backup export contains every collection', async () => {
  const o = await phone(OWNER);
  await o.call('createOrder', order());
  const data = await o.call('exportAll');
  assert.equal(data.app, 'tiemvio-pos');
  assert.equal(data.collections.orders.length, 1);
  assert.equal(data.collections.menu.length, 7);
});

/* ---------------- Security Rules, bypassing the app code ---------------- */
test('rules: signed-out and unlisted accounts see and write nothing', async () => {
  await phone(OWNER);
  const anon = env.unauthenticatedContext().firestore();
  await assertFails(F.getDoc(F.doc(anon, 'menu', 'milk')));
  const stranger = rawDb(STRANGER);
  await assertFails(F.getDoc(F.doc(stranger, 'menu', 'milk')));
  await assertFails(F.setDoc(F.doc(stranger, 'users', STRANGER), {email: STRANGER, name: 'x', role: 'owner', active: true}));
});

test('rules: a sales account cannot edit menu, users, expenses, stats or delete orders', async () => {
  const o = await phone(OWNER);
  await seedUser(SALES, 'sales');
  const made = await o.call('createOrder', order());
  const db = rawDb(SALES);
  await assertFails(F.setDoc(F.doc(db, 'menu', 'milk'), {id: 'milk', name: 'Rẻ', category: 'x', priceM: 1, priceL: 1, active: true, kind: 'drink'}));
  await assertFails(F.setDoc(F.doc(db, 'users', 'evil@test.com'), {email: 'evil@test.com', name: 'e', role: 'owner', active: true}));
  await assertFails(F.getDocs(F.collection(db, 'expenses')));
  await assertFails(F.getDoc(F.doc(db, 'stats', '2026-01-01')));
  await assertFails(F.deleteDoc(F.doc(db, 'orders', made.id)));
  await assertSucceeds(F.getDoc(F.doc(db, 'orders', made.id)));
});

test('rules: staff cannot tamper with an existing order total or skip the version', async () => {
  const o = await phone(OWNER);
  await seedUser(SALES, 'sales');
  const made = await o.call('createOrder', order({paid: false}));
  const db = rawDb(SALES);
  const ref = F.doc(db, 'orders', made.id);
  await assertFails(F.updateDoc(ref, {total: 1, version: 2}));
  await assertFails(F.updateDoc(ref, {status: 'delivered'}));
  // An unpaid order may be cancelled by staff, but not while flipping it to paid, and a paid order only by the owner.
  await assertFails(F.updateDoc(ref, {status: 'cancelled', paid: true, version: 2, audit: [...made.audit, {at: 'x'}]}));
  await assertSucceeds(F.updateDoc(ref, {status: 'cancelled', version: 2, audit: [...made.audit, {at: 'x'}]}));
  const paid = await o.call('createOrder', order({paid: true}));
  await assertFails(F.updateDoc(F.doc(db, 'orders', paid.id), {status: 'cancelled', version: 2, audit: [...paid.audit, {at: 'x'}]}));
});

test('rules: sales may change stock but nothing else on an ingredient', async () => {
  const o = await phone(OWNER);
  await seedUser(SALES, 'sales');
  await o.call('saveIngredient', {id: 'tea', name: 'Trà', unit: 'g', minStock: 1, stock: 100, active: true});
  const ref = F.doc(rawDb(SALES), 'inventory', 'tea');
  await assertSucceeds(F.updateDoc(ref, {stock: F.increment(-5)}));
  await assertFails(F.updateDoc(ref, {name: 'Đổi tên'}));
  await assertFails(F.updateDoc(ref, {minStock: 9999}));
});

test('rules: only the configured owner address may create the first owner record', async () => {
  const ok = rawDb(OWNER);
  await assertSucceeds(F.setDoc(F.doc(ok, 'users', OWNER), {email: OWNER, name: 'Chủ', role: 'owner', active: true}));
  await env.clearFirestore();
  const bad = rawDb(STRANGER);
  await assertFails(F.setDoc(F.doc(bad, 'users', STRANGER), {email: STRANGER, name: 'x', role: 'owner', active: true}));
});

/* ---------------- shop features: order number, channels, promos, tiers, hot, cost, history, time clock ---------------- */
const today = o => o.b.dayOf(new Date());
const localHour = () => Number(new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', hour12: false}).format(new Date())) % 24;

test('orders get a running number for the day (1, 2, 3 …)', async () => {
  const o = await phone(OWNER);
  const a = await o.call('createOrder', order());
  const b = await o.call('createOrder', order());
  const c = await o.call('createOrder', order());
  assert.deepEqual([a.seq, b.seq, c.seq], [1, 2, 3]);
});

test('sales channel is recorded and the owner report splits revenue by channel', async () => {
  const o = await phone(OWNER);
  await o.call('createOrder', order({channel: 'grab', items: [drink({quantity: 2})]}));   // 50.000
  await o.call('createOrder', order());                                                   // 25.000 (store)
  await assert.rejects(o.call('createOrder', order({channel: 'zalo'})), /Kênh bán/);
  const rep = await o.call('report', {from: today(o), to: today(o)});
  const by = Object.fromEntries(rep.channels.map(c => [c.id, c.total]));
  assert.deepEqual(by, {store: 25000, grab: 50000});
});

test('promotions: owner defines, staff apply; limits, minimum, hours and activity are enforced', async () => {
  const o = await phone(OWNER);
  await seedUser(SALES, 'sales');
  const s = await phone(SALES);
  await assert.rejects(s.call('savePromo', {name: 'x', type: 'percent', value: 10, active: true}), /quyền/);
  await assert.rejects(o.call('savePromo', {name: 'Quá tay', type: 'percent', value: 80, active: true}), /1 đến 50/);
  await assert.rejects(o.call('savePromo', {name: 'Quá tay', type: 'amount', value: 500000, active: true}), /1\.000đ đến/);
  await assert.rejects(o.call('savePromo', {name: 'Giờ sai', type: 'amount', value: 5000, startHour: 10, endHour: 9, active: true}), /khung giờ/i);
  const ten = await o.call('savePromo', {name: 'Giảm 10%', type: 'percent', value: 10, minTotal: 50000, active: true});
  const h = localHour();
  const off = await o.call('savePromo', {name: 'Ngoài giờ', type: 'amount', value: 5000, active: true, ...(h >= 2 ? {startHour: 0, endHour: h - 1} : {startHour: h + 2, endHour: 24})});
  const paused = await o.call('savePromo', {name: 'Tạm dừng', type: 'amount', value: 5000, active: false});
  await until(async () => (await s.call('snapshot', {})).promos.some(p => p.id === ten.id));

  const snap = await s.call('snapshot', {});
  assert.ok(snap.promos.find(p => p.id === ten.id).validNow);
  assert.ok(!snap.promos.find(p => p.id === off.id).validNow);
  assert.ok(!snap.promos.some(p => p.id === paused.id), 'staff do not even see paused promotions');

  const big = items => ({items, promoId: ten.id});
  const ok = await s.call('createOrder', order(big([drink({quantity: 4})])));            // 100.000 − 10%
  assert.equal(ok.total, 90000);
  assert.equal(ok.promoName, 'Giảm 10%');
  await assert.rejects(s.call('createOrder', order(big([drink()]))), /tối thiểu/);       // 25.000 < 50.000
  await assert.rejects(s.call('createOrder', order({promoId: off.id})), /khung giờ/);
  await assert.rejects(s.call('createOrder', order({promoId: paused.id})), /không còn áp dụng/);
  const rep = await o.call('report', {from: today(o), to: today(o)});
  assert.equal(rep.promoDiscount, 10000);
});

test('membership tiers: lifetime spend unlocks a faster points rate; staff and owner both see the tier', async () => {
  const o = await phone(OWNER);
  await o.call('createOrder', order({phone: '0900000009', items: [drink({quantity: 40})]})); // 1.000.000đ
  const c = await o.call('lookupCustomer', {phone: '0900000009'});
  assert.equal(c.points, 100);
  assert.equal(c.tier.id, 'silver');
  await o.call('createOrder', order({phone: '0900000009', items: [drink({quantity: 4})]})); // 100.000đ, ×1.2
  assert.equal((await o.call('lookupCustomer', {phone: '0900000009'})).points, 100 + 12);
  const fresh = await o.call('lookupCustomer', {phone: '0911111111'});
  assert.equal(fresh.tier.id, 'member');
});

test('hot drinks: only items the owner marked as hot can be sold hot, and hot never has ice', async () => {
  const o = await phone(OWNER);
  await assert.rejects(o.call('createOrder', order({items: [drink({temp: 'hot'})]})), /không bán nóng/);
  await o.call('saveMenu', {id: 'milk', name: 'Trà sữa truyền thống', category: 'Trà sữa', kind: 'drink', priceM: 25000, priceL: 30000, active: true, allowHot: true});
  await until(async () => (await o.call('snapshot', {})).menu.find(m => m.id === 'milk').allowHot);
  const made = await o.call('createOrder', order({items: [drink({temp: 'hot', ice: 'normal'})]}));
  assert.equal(made.items[0].temp, 'hot');
  assert.equal(made.items[0].ice, 'none');
});

test('ingredient cost gives cost of goods and gross profit; costs per drink are owner-only data', async () => {
  const o = await phone(OWNER);
  await seedUser(SALES, 'sales');
  await o.call('saveIngredient', {id: 'tea', name: 'Trà', unit: 'g', minStock: 1, stock: 1000, cost: 10, active: true});
  await o.call('saveRecipe', {productId: 'milk', lines: [{ingredientId: 'tea', qty: 20}]});
  const s = await phone(SALES);
  await s.call('createOrder', order({items: [drink({quantity: 2})]}));  // 50.000đ revenue, 2×20g×10 = 400đ cost
  const day = today(o);
  await until(async () => (await o.call('report', {from: day, to: day})).cogs === 400);
  const rep = await o.call('report', {from: day, to: day});
  assert.equal(rep.grossProfit, 50000 - 400);
  assert.equal((await o.call('snapshot', {})).menuCosts.milk.M, 200);
  const staffSnap = await s.call('snapshot', {});
  assert.equal(staffSnap.menuCosts, undefined, 'the cost table is never sent to the sales view');
  await assert.rejects(s.call('report', {from: day, to: day}), /quyền/);
});

test('stock history: every manual change needs a reason and is listed for the owner only', async () => {
  const o = await phone(OWNER);
  await seedUser(SALES, 'sales');
  await o.call('saveIngredient', {id: 'tea', name: 'Trà', unit: 'g', minStock: 1, stock: 100, active: true});
  await assert.rejects(o.call('adjustStock', {id: 'tea', delta: 500}), /lý do/);
  await o.call('adjustStock', {id: 'tea', delta: 500, reason: 'Nhập hàng sáng'});
  await o.call('adjustStock', {id: 'tea', delta: -20, reason: 'Đổ bỏ'});
  await until(async () => (await o.call('snapshot', {})).stockLog.length === 2);
  const log = (await o.call('snapshot', {})).stockLog;
  assert.deepEqual(log.map(x => x.reason).sort(), ['Nhập hàng sáng', 'Đổ bỏ'].sort());
  await assertFails(F.getDocs(F.collection(rawDb(SALES), 'stockLog')));
  assert.equal((await (await phone(SALES)).call('snapshot', {})).stockLog, undefined);
});

test('time clock: staff clock themselves in/out and see only their own; the owner sees everyone and can close a forgotten one', async () => {
  const o = await phone(OWNER);
  await seedUser(SALES, 'sales'); await seedUser('b@test.com', 'sales');
  const s = await phone(SALES), b = await phone('b@test.com');
  await s.call('clockIn', {});
  await assert.rejects(s.call('clockIn', {}), /đang trong ca/);
  await b.call('clockIn', {});
  await until(async () => (await o.call('snapshot', {})).clockedIn.length === 2);
  assert.equal((await s.call('snapshot', {})).clock.mine.email, SALES);

  const db = rawDb(SALES); // rules, bypassing the app
  await assertFails(F.getDocs(F.collection(db, 'timeclock')));
  await assertSucceeds(F.getDocs(F.query(F.collection(db, 'timeclock'), F.where('email', '==', SALES))));
  await assertFails(F.getDocs(F.query(F.collection(db, 'timeclock'), F.where('email', '==', 'b@test.com'))));

  const theirs = (await o.call('snapshot', {})).clockedIn.find(x => x.email === 'b@test.com');
  await assert.rejects(s.call('clockOut', {id: theirs.id}), /Không có ca|quyền/);
  await o.call('clockOut', {id: theirs.id});               // owner closes a forgotten clock-out
  await s.call('clockOut', {});
  await until(async () => (await o.call('snapshot', {})).clockedIn.length === 0);
  const rep = await o.call('report', {from: today(o), to: today(o)});
  assert.deepEqual(rep.worked.map(w => w.email).sort(), [SALES, 'b@test.com'].sort());
  assert.ok(rep.worked.every(w => w.shifts === 1 && w.open === false));
});

test('owner report shows revenue by staff member and by hour; staff get a count-only "my shift" summary', async () => {
  const o = await phone(OWNER);
  await seedUser(SALES, 'sales');
  const s = await phone(SALES);
  await s.call('createOrder', order({items: [drink({quantity: 3})]}));    // collected by sales: 75.000
  await o.call('createOrder', order());                                   // collected by owner: 25.000
  const day = today(o);
  const rep = await o.call('report', {from: day, to: day});
  const by = Object.fromEntries(rep.staff.map(x => [x.name, x.total]));
  assert.deepEqual(by, {[SALES]: 75000, 'Chủ quán Tiemvio POS': 25000});            // the owner shows by name; a person added without a name falls back to the e-mail
  assert.equal(rep.hours.length, 1);
  assert.equal(rep.hours[0].hour, localHour());
  assert.equal(rep.hours[0].total, 100000);

  await until(async () => (await s.call('snapshot', {})).mine.cups === 3);
  const mine = (await s.call('snapshot', {})).mine;
  assert.deepEqual(mine, {orders: 1, cups: 3});
  assert.equal((await o.call('snapshot', {})).mine, undefined);
});

test('rules: staff can read promotions but not change them, and cannot touch other days\' counters with bad data', async () => {
  const o = await phone(OWNER);
  await seedUser(SALES, 'sales');
  const p = await o.call('savePromo', {name: 'KM', type: 'amount', value: 5000, active: true});
  const db = rawDb(SALES);
  await assertSucceeds(F.getDoc(F.doc(db, 'promos', p.id)));
  await assertFails(F.updateDoc(F.doc(db, 'promos', p.id), {value: 100000}));
  await assertFails(F.setDoc(F.doc(db, 'counters', 'not-a-day'), {n: 1}));
  await assertFails(F.setDoc(F.doc(db, 'counters', '2026-01-01'), {n: 'x'}));
});

test('a new shop starts empty and has no banking or customer data',async()=>{
 const o=await phone(OWNER,'Chủ',DEFAULT_MENU);const data=await o.call('snapshot',{});assert.equal(data.menu.length,0);assert.equal(data.customers.length,0);assert.equal(data.inventory.length,0);assert.ok(!data.bank||!data.bank.account);
});

/* ---------------- sizes S / M / L / XL ---------------- */
test('the owner switches sizes on per item and prices them separately; only enabled sizes can be sold', async () => {
  const o = await phone(OWNER);
  await until(async () => { const m = (await o.call('snapshot', {})).menu; return TEST_MENU.every(([id]) => m.some(x => x.id === id && x.active)); });
  await addCategory(o, 'Cà phê');
  const saved = await o.call('saveMenu', {id: 'cf', name: 'Cà phê thử', category: 'Cà phê', kind: 'drink', active: true, sizes: {S: 15000, M: 20000, XL: 30000, L: ''}});
  assert.deepEqual(saved.sizes, {S: 15000, M: 20000, XL: 30000});     // blank price = size not offered
  await until(async () => (await o.call('snapshot', {})).menu.find(m => m.id === 'cf'));
  const item = size => ({productId: 'cf', size, sugar: 50, ice: 'less', quantity: 1, toppings: ['pearl'], note: ''});
  assert.equal((await o.call('createOrder', order({items: [item('S')]}))).total, 15000 + 5000);
  assert.equal((await o.call('createOrder', order({items: [item('XL')]}))).total, 30000 + 5000);
  await assert.rejects(o.call('createOrder', order({items: [item('L')]})), /không có size L/);
  await assert.rejects(o.call('saveMenu', {id: 'cf', name: 'x', category: 'x', kind: 'drink', sizes: {}}), /ít nhất một size/);
  await assert.rejects(o.call('saveMenu', {id: 'cf', name: 'x', category: 'x', kind: 'drink', sizes: {XXL: 1000}}), /Size không hợp lệ/);
  await assert.rejects(o.call('saveMenu', {id: 'cf', name: 'x', category: 'x', kind: 'drink', sizes: {M: 2000000}}), /Giá tiền/);
  // switching a size off stops it being sold
  await o.call('saveMenu', {id: 'cf', name: 'Cà phê thử', category: 'Cà phê', kind: 'drink', active: true, sizes: {M: 20000}});
  await until(async () => Object.keys((await o.call('snapshot', {})).menu.find(m => m.id === 'cf').sizes).length === 1);
  await assert.rejects(o.call('createOrder', order({items: [item('XL')]})), /không có size XL/);
});

test('menu items saved before sizes existed (priceM/priceL only) keep working', async () => {
  const o = await phone(OWNER);
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await F.setDoc(F.doc(db, 'menu', 'old-two'), {id: 'old-two', name: 'Cũ hai cỡ', category: 'Cũ', priceM: 20000, priceL: 25000, active: true, kind: 'drink', sort: 90});
    await F.setDoc(F.doc(db, 'menu', 'old-one'), {id: 'old-one', name: 'Cũ một cỡ', category: 'Cũ', priceM: 18000, priceL: 18000, active: true, kind: 'drink', sort: 91});
  });
  await until(async () => (await o.call('snapshot', {})).menu.some(m => m.id === 'old-one'));
  const snap = await o.call('snapshot', {});
  assert.deepEqual(snap.menu.find(m => m.id === 'old-two').sizes, {M: 20000, L: 25000});
  assert.deepEqual(snap.menu.find(m => m.id === 'old-one').sizes, {M: 18000});
  const it = (productId, size) => ({productId, size, sugar: 50, ice: 'less', quantity: 1, toppings: [], note: ''});
  assert.equal((await o.call('createOrder', order({items: [it('old-two', 'L')]}))).total, 25000);
  assert.equal((await o.call('createOrder', order({items: [it('old-one', 'M')]}))).total, 18000);
  await assert.rejects(o.call('createOrder', order({items: [it('old-one', 'L')]})), /không có size L/);
});

test('recipes and costs follow each size: a size with its own recipe uses it, others use the standard one', async () => {
  const o = await phone(OWNER);
  await addCategory(o, 'Cà phê');
  await o.call('saveMenu', {id: 'cf', name: 'Cà phê thử', category: 'Cà phê', kind: 'drink', active: true, sizes: {S: 15000, M: 20000, XL: 30000}});
  await o.call('saveIngredient', {id: 'cof', name: 'Cà phê', unit: 'g', minStock: 1, stock: 1000, cost: 10, active: true});
  await o.call('saveRecipe', {productId: 'cf', lines: [{ingredientId: 'cof', qty: 20}]});                  // standard (S and M)
  await o.call('saveRecipe', {productId: 'cf', size: 'XL', lines: [{ingredientId: 'cof', qty: 40}]});       // XL has its own
  await until(async () => (await o.call('snapshot', {})).menuCosts?.cf?.XL === 400);
  assert.deepEqual((await o.call('snapshot', {})).menuCosts.cf, {S: 200, M: 200, XL: 400});
  const it = size => ({productId: 'cf', size, sugar: 50, ice: 'less', quantity: 1, toppings: [], note: ''});
  await o.call('createOrder', order({items: [it('S')]}));    // −20
  await o.call('createOrder', order({items: [it('XL')]}));   // −40
  await until(async () => (await o.call('snapshot', {})).inventory.find(i => i.id === 'cof').stock === 940);
  await assert.rejects(o.call('saveRecipe', {productId: 'cf', size: 'XXL', lines: []}), /Size công thức/);
});

test('a topping has one price', async () => {
  const o = await phone(OWNER);
  const t = await o.call('saveMenu', {id: 'top1', name: 'Thạch', category: 'Topping', kind: 'topping', active: true, sizes: {M: 6000, L: 9999}});
  assert.deepEqual(t.sizes, {M: 6000});
  await assert.rejects(o.call('saveMenu', {id: 'top2', name: 'Thạch 2', category: 'Topping', kind: 'topping', sizes: {}}), /giá bán/i);
});

test('the owner manages menu categories and can sell snacks (no sugar, ice or toppings)', async () => {
  const o = await phone(OWNER);
  await seedUser(SALES, 'sales');
  const base = await o.call('snapshot', {});
  assert.ok(base.menuCategories.includes('Topping'));
  await assert.rejects(o.call('saveMenu', {id: 'snk', name: 'Khoai tây chiên', category: 'Đồ ăn vặt', kind: 'food', active: true, sizes: {M: 25000}}), /chưa có trong danh sách/);
  await assert.rejects(o.call('saveMenuCategories', {categories: ['Trà sữa']}), /Còn món thuộc/);
  await assert.rejects(o.call('saveMenuCategories', {categories: [...base.menuCategories, 'Tất cả']}), /Tất cả/);
  await o.call('saveMenuCategories', {categories: [...base.menuCategories, 'Đồ ăn vặt']});
  await o.call('saveMenu', {id: 'snk', name: 'Khoai tây chiên', category: 'Đồ ăn vặt', kind: 'food', active: true, sizes: {M: 25000, L: 99999}});
  const s = await phone(SALES);
  await assert.rejects(s.call('saveMenuCategories', {categories: ['x']}));
  assert.ok((await s.call('snapshot', {})).menuCategories.includes('Đồ ăn vặt'));
  await assert.rejects(s.call('createOrder', order({items: [{productId: 'snk', size: 'M', sugar: 100, ice: 'normal', quantity: 1, toppings: ['pearl']}]})), /không có topping/);
  const made = await s.call('createOrder', order({items: [{productId: 'snk', size: 'M', sugar: 30, ice: 'normal', quantity: 2, toppings: []}]}));
  assert.equal(made.total, 50000);
  assert.equal(made.items[0].kind, 'food');
  assert.equal(made.items[0].sugar, 0);
  assert.equal(made.items[0].ice, 'none');
});

test('any seller may cancel an unpaid order with a prepared or "Khác" reason; paid orders still need the owner to refund', async () => {
  const o = await phone(OWNER);
  await seedUser(SALES, 'sales');
  await o.call('saveCancelReasons', {reasons: ['Nhầm món']});
  const s = await phone(SALES);
  const unpaid = await s.call('createOrder', order({paid: false}));
  await assert.rejects(s.call('updateOrder', {id: unpaid.id, version: 1, change: 'cancel', reason: 'tự gõ', mutationId: key()}), /trong danh sách/);
  await assert.rejects(s.call('updateOrder', {id: unpaid.id, version: 1, change: 'cancel', reason: 'Khác: ab', mutationId: key()}), /ít nhất 3 ký tự/);
  const cancelled = await s.call('updateOrder', {id: unpaid.id, version: 1, change: 'cancel', reason: 'Nhầm món', mutationId: key()});
  assert.equal(cancelled.status, 'cancelled');
  const second = await s.call('createOrder', order({paid: false}));
  const other = await s.call('updateOrder', {id: second.id, version: 1, change: 'cancel', reason: 'Khác: khách bỏ về', mutationId: key()});
  assert.equal(other.status, 'cancelled');
  const paid = await s.call('createOrder', order({paid: true}));
  await assert.rejects(s.call('updateOrder', {id: paid.id, version: 1, change: 'cancel', reason: 'Nhầm món', mutationId: key()}), /đã thu tiền/);
  await assert.rejects(s.call('updateOrder', {id: paid.id, version: 1, change: 'refund', reason: 'Nhầm món', mutationId: key()}), /quyền/);
});

test('when the owner signs in, the menu is already there once sign-in finishes (no half-seeded start)', async () => {
  for (let i = 0; i < 12; i++) {
    await Promise.all(open.splice(0).map(b => b.detach()));
    await env.clearFirestore();
    const o = await phone(OWNER);
    const names = (await o.call('snapshot', {})).menu.map(m => m.id);
    assert.equal(names.length, TEST_MENU.length, `run ${i + 1}: menu had ${names.length} of ${TEST_MENU.length} items right after sign-in`);
    assert.ok(names.includes('pearl'));
  }
});

/* ---------------- editing an unpaid order ---------------- */
const stockOf = async (o, id) => (await o.call('snapshot', {})).inventory.find(i => i.id === id).stock;

test('staff can edit an unpaid order: items, total and stock are corrected by the difference, and a later cancel restores the right amount', async () => {
  const o = await phone(OWNER);
  await seedUser(SALES, 'sales');
  await o.call('saveIngredient', {id: 'tea', name: 'Trà', unit: 'g', minStock: 1, stock: 1000, cost: 10, active: true});
  await o.call('saveRecipe', {productId: 'milk', lines: [{ingredientId: 'tea', qty: 20}]});
  await o.call('saveCancelReasons', {reasons: ['Khách bỏ']});
  const s = await phone(SALES);
  const made = await s.call('createOrder', order({paid: false, customer: 'Bàn 3', items: [drink({quantity: 2})]}));    // 50.000đ, −40g
  await until(async () => (await stockOf(o, 'tea')) === 960);

  const edited = await s.call('editOrder', {id: made.id, version: 1, mutationId: key(), service: 'dinein', channel: 'grab', customer: 'Bàn 5',
    items: [drink({quantity: 5, toppings: ['pearl']})]});                                                                // 5×(25.000+5.000)
  assert.equal(edited.total, 150000);
  assert.equal(edited.version, 2);
  assert.equal(edited.seq, made.seq);
  assert.equal(edited.customer, 'Bàn 5');
  assert.equal(edited.channel, 'grab');
  assert.equal(edited.service, 'dinein');
  assert.equal(edited.cogs, 1000);
  assert.match(edited.audit.at(-1).detail, /2 → 5 ly/);
  await until(async () => (await stockOf(o, 'tea')) === 900);                                                            // 1000 − 5×20

  await s.call('editOrder', {id: made.id, version: 2, mutationId: key(), service: 'takeaway', customer: 'Bàn 5', items: [drink({quantity: 1})]});
  await until(async () => (await stockOf(o, 'tea')) === 980);
  await o.call('updateOrder', {id: made.id, version: 3, change: 'cancel', reason: 'Khách bỏ', mutationId: key()});
  await until(async () => (await stockOf(o, 'tea')) === 1000);                                                           // cancel gives back exactly what is used now
});

test('editing keeps the points already redeemed, re-checks promotions and discounts, and never touches paid, cancelled or stale orders', async () => {
  const o = await phone(OWNER);
  await o.call('createOrder', order({phone: '0900000077', items: [drink({quantity: 10})]}));            // 250.000đ paid → 25 points
  const promo = await o.call('savePromo', {name: 'Giảm 10%', type: 'percent', value: 10, minTotal: 100000, active: true});
  await until(async () => (await o.call('snapshot', {})).promos.some(p => p.id === promo.id));
  const made = await o.call('createOrder', order({paid: false, phone: '0900000077', redeem: 13, promoId: promo.id, items: [drink({quantity: 8})]})); // 200.000 −10% −13.000đ
  assert.equal(made.total, 200000 - 20000 - 13000);

  // fewer cups: the promotion minimum is no longer met, and 13 points are more than half of a single cup
  await assert.rejects(o.call('editOrder', {id: made.id, version: 1, mutationId: key(), service: 'takeaway', promoId: promo.id, items: [drink({quantity: 2})]}), /tối thiểu/);
  await assert.rejects(o.call('editOrder', {id: made.id, version: 1, mutationId: key(), service: 'takeaway', items: [drink({quantity: 1})]}), /quá nhỏ để giữ 13 điểm/);
  const ok = await o.call('editOrder', {id: made.id, version: 1, mutationId: key(), service: 'takeaway', items: [drink({quantity: 4})]}); // promo dropped by the editor
  assert.equal(ok.total, 100000 - 13000);
  assert.equal(ok.redeemed, 13);
  assert.equal(ok.phone, '0900000077');
  assert.equal(ok.promoDiscount, 0);

  // a stale version is refused, the same mutation id twice changes nothing
  await assert.rejects(o.call('editOrder', {id: made.id, version: 1, mutationId: key(), service: 'takeaway', items: [drink({quantity: 5})]}), /vừa được người khác/);
  const m = key();
  const first = await o.call('editOrder', {id: made.id, version: 2, mutationId: m, service: 'takeaway', items: [drink({quantity: 5})]});
  const again = await o.call('editOrder', {id: made.id, version: 2, mutationId: m, service: 'takeaway', items: [drink({quantity: 9})]});
  assert.equal(again.version, first.version);
  assert.equal(again.total, first.total);

  // paid and cancelled orders cannot be edited
  const paid = await o.call('createOrder', order());
  await assert.rejects(o.call('editOrder', {id: paid.id, version: 1, mutationId: key(), service: 'takeaway', items: [drink({quantity: 3})]}), /chưa thu tiền/);
  await o.call('saveCancelReasons', {reasons: ['Khách bỏ']});
  await o.call('updateOrder', {id: made.id, version: 3, change: 'cancel', reason: 'Khách bỏ', mutationId: key()});
  await assert.rejects(o.call('editOrder', {id: made.id, version: 4, mutationId: key(), service: 'takeaway', items: [drink({quantity: 3})]}), /chưa thu tiền/);
  await assert.rejects(o.call('editOrder', {id: made.id, version: 4, mutationId: key(), service: 'takeaway', items: []}), /1 đến 40 dòng/);
});

test('rules: the items of an order can change only while it is open and unpaid, and never together with a status or payment change', async () => {
  const o = await phone(OWNER);
  await seedUser(SALES, 'sales');
  const open = await o.call('createOrder', order({paid: false}));
  const paid = await o.call('createOrder', order());
  const db = rawDb(SALES);
  const audit = (m, extra = {}) => [...m.audit, {at: 'x', by: SALES, action: 'edit', key: key(), ...extra}];
  const newItems = open.items.map(i => ({...i, quantity: 2, lineTotal: i.unitPrice * 2}));
  await assertFails(F.updateDoc(F.doc(db, 'orders', paid.id), {items: newItems, total: 50000, version: 2, audit: audit(paid)}));                  // paid
  await assertFails(F.updateDoc(F.doc(db, 'orders', open.id), {items: newItems, total: 50000, version: 2, status: 'delivered', audit: audit(open)})); // + status
  await assertFails(F.updateDoc(F.doc(db, 'orders', open.id), {items: newItems, total: 50000, version: 2, paid: true, audit: audit(open)}));         // + payment
  await assertFails(F.updateDoc(F.doc(db, 'orders', open.id), {items: newItems, total: 50000, version: 5, audit: audit(open)}));                    // wrong version
  await assertFails(F.updateDoc(F.doc(db, 'orders', open.id), {items: newItems, total: 50000, version: 2}));                                         // no history entry
  await assertSucceeds(F.updateDoc(F.doc(db, 'orders', open.id), {items: newItems, total: 50000, version: 2, audit: audit(open)}));
});

/* ---------------- sizes for snacks ---------------- */
test('snacks have sizes just like drinks: each enabled size has its own price, and snack rules (no sugar, ice or toppings) stay', async () => {
  const o = await phone(OWNER);
  await o.call('saveMenuCategories', {categories: [...(await o.call('snapshot', {})).menuCategories, 'Đồ ăn vặt']});
  const saved = await o.call('saveMenu', {id: 'fry', name: 'Khoai tây chiên', category: 'Đồ ăn vặt', kind: 'food', active: true, sizes: {S: 20000, L: 35000}});
  assert.deepEqual(saved.sizes, {S: 20000, L: 35000});
  await until(async () => (await o.call('snapshot', {})).menu.find(m => m.id === 'fry'));
  const it = (size, extra = {}) => ({productId: 'fry', size, sugar: 100, ice: 'normal', quantity: 2, toppings: [], note: '', ...extra});
  const small = await o.call('createOrder', order({items: [it('S')]}));
  assert.equal(small.total, 40000);
  assert.equal(small.items[0].kind, 'food');
  assert.equal(small.items[0].sugar, 0);
  assert.equal((await o.call('createOrder', order({items: [it('L')]}))).total, 70000);
  await assert.rejects(o.call('createOrder', order({items: [it('M')]})), /không có size M/);
  await assert.rejects(o.call('createOrder', order({items: [it('S', {toppings: ['pearl']})]})), /không có topping/);
  await assert.rejects(o.call('saveMenu', {id: 'fry', name: 'x', category: 'Đồ ăn vặt', kind: 'food', sizes: {}}), /ít nhất một size/);
  // a topping still has exactly one price
  const t = await o.call('saveMenu', {id: 'top9', name: 'Thạch', category: 'Topping', kind: 'topping', active: true, sizes: {M: 6000, L: 9999}});
  assert.deepEqual(t.sizes, {M: 6000});
});

/* ---------------- selling units: weight (lạng), pieces (viên), sticks (cây) ---------------- */
test('snacks sold by weight: staff enter whole lạng (1, 2, 3…), the price follows, and fractions are refused', async () => {
  const o = await phone(OWNER);
  await o.call('saveMenuCategories', {categories: [...(await o.call('snapshot', {})).menuCategories, 'Ăn vặt']});
  await assert.rejects(o.call('saveMenu', {id: 'ca-xu', name: 'Cá xù', category: 'Ăn vặt', kind: 'food', unit: 'lạng', byWeight: true, packQty: 4, sizes: {M: 10000}}), /1 đơn vị/);
  const saved = await o.call('saveMenu', {id: 'ca-xu', name: 'Cá xù', category: 'Ăn vặt', kind: 'food', active: true, byWeight: true, sizes: {M: 10000}});
  assert.deepEqual([saved.unit, saved.packQty, saved.byWeight], ['lạng', 1, true]);
  await until(async () => (await o.call('snapshot', {})).menu.find(m => m.id === 'ca-xu')?.byWeight);
  const it = quantity => ({productId: 'ca-xu', size: 'M', sugar: 0, ice: 'none', quantity, toppings: [], note: ''});
  const a = await o.call('createOrder', order({items: [it(3)]}));
  assert.equal(a.total, 30000);
  assert.equal(a.items[0].quantity, 3);
  assert.equal(a.items[0].unitName, 'lạng');
  assert.equal((await o.call('createOrder', order({items: [it(1)]}))).total, 10000);
  for (const bad of [0, 0.5, 1.5, 2.5, 0.3, 201, -1, NaN]) await assert.rejects(o.call('createOrder', order({items: [it(bad)]})), /Số lạng từ 1 đến 200 \(chỉ bán nguyên lạng\)/);
  const rep = await o.call('report', {from: today(o), to: today(o)});
  assert.deepEqual([rep.top[0].name, rep.top[0].quantity, rep.top[0].unit], ['Cá xù', 4, 'lạng']);
  // editing keeps working with decimals
  const unpaid = await o.call('createOrder', order({paid: false, items: [it(2)]}));
  const edited = await o.call('editOrder', {id: unpaid.id, version: 1, mutationId: key(), service: 'takeaway', items: [it(4)]});
  assert.equal(edited.total, 40000);
});

test('snacks priced per pack ("10.000đ / 4 viên", "10.000đ / 2 cây") are sold by the piece: 6 viên = 15.000đ', async () => {
  const o = await phone(OWNER);
  await seedUser(SALES, 'sales');
  await o.call('saveMenuCategories', {categories: [...(await o.call('snapshot', {})).menuCategories, 'Ăn vặt']});
  await assert.rejects(o.call('saveMenu', {id: 'bad', name: 'x', category: 'Ăn vặt', kind: 'food', unit: 'viên', packQty: 0, sizes: {M: 1000}}), /Giá tính cho/);
  await assert.rejects(o.call('saveMenu', {id: 'bad', name: 'x', category: 'Ăn vặt', kind: 'food', unit: 'viên', packQty: 2.5, sizes: {M: 1000}}), /Giá tính cho/);
  await o.call('saveMenu', {id: 'muc-vien', name: 'Mực viên Hàn Quốc', category: 'Ăn vặt', kind: 'food', active: true, unit: 'viên', packQty: 4, sizes: {M: 10000}});
  await o.call('saveMenu', {id: 'xx-nho', name: 'Xúc xích nhỏ', category: 'Ăn vặt', kind: 'food', active: true, unit: 'cây', packQty: 2, sizes: {M: 10000}});
  await o.call('saveMenu', {id: 'xx-lon', name: 'Xúc xích lớn', category: 'Ăn vặt', kind: 'food', active: true, unit: 'cây', sizes: {M: 10000}});
  await until(async () => (await o.call('snapshot', {})).menu.find(m => m.id === 'xx-lon'));
  const s = await phone(SALES);
  const it = (productId, quantity) => ({productId, size: 'M', sugar: 0, ice: 'none', quantity, toppings: [], note: ''});
  assert.equal((await s.call('createOrder', order({items: [it('muc-vien', 6)]}))).total, 15000);
  assert.equal((await s.call('createOrder', order({items: [it('muc-vien', 4)]}))).total, 10000);
  assert.equal((await s.call('createOrder', order({items: [it('muc-vien', 3)]}))).total, 7500);
  assert.equal((await s.call('createOrder', order({items: [it('xx-nho', 3)]}))).total, 15000);
  assert.equal((await s.call('createOrder', order({items: [it('xx-lon', 3)]}))).total, 30000);        // one price per stick
  await assert.rejects(s.call('createOrder', order({items: [it('muc-vien', 2.5)]})), /Số viên từ 1 đến 200/);
  await assert.rejects(s.call('createOrder', order({items: [it('muc-vien', 201)]})), /Số viên từ 1 đến 200/);
  await assert.rejects(s.call('createOrder', order({items: [it('xx-lon', 201)]})), /Số lượng từ 1 đến 200/);
  // staff summary counts drinks only (snack pieces and weights are not "cups")
  await until(async () => (await s.call('snapshot', {})).mine.orders === 5);
  assert.equal((await s.call('snapshot', {})).mine.cups, 0);
  const rep = await o.call('report', {from: today(o), to: today(o)});
  assert.equal(rep.top.find(t => t.name === 'Mực viên Hàn Quốc').unit, 'viên');
  assert.equal(rep.top.find(t => t.name === 'Mực viên Hàn Quốc').quantity, 13);
});

/* ---------------- notification events (sent to other phones by the app) ---------------- */
test('events for lock-screen notifications: new order, cancel, refund, and low stock only when an ingredient first drops to its alert level', async () => {
  const o = await phone(OWNER);
  await seedUser(SALES, 'sales');
  await o.call('saveIngredient', {id: 'tea', name: 'Trà đen', unit: 'g', minStock: 90, stock: 100, active: true});
  await o.call('saveRecipe', {productId: 'milk', lines: [{ingredientId: 'tea', qty: 20}]});
  await o.call('saveCancelReasons', {reasons: ['Khách bỏ']});
  const s = await phone(SALES);
  await until(async () => (await s.call('snapshot', {})).menu.length > 0);
  const events = []; s.b.onNotify(e => events.push(e));
  const first = await s.call('createOrder', order({paid: false, customer: 'Bàn 5', items: [drink()]}));
  assert.equal(events[0].type, 'order');
  assert.match(events[0].title, /^Đơn mới #\d+$/);
  assert.match(events[0].body, /1 món · 25\.000đ · Bàn 5 · sales@test\.com/);
  assert.equal(events[0].tag, 'order-' + first.id);
  const low = events.filter(e => e.type === 'lowstock');
  assert.equal(low.length, 1, 'stock fell from 100 to 80, below the alert level of 90');
  assert.match(low[0].body, /Trà đen: còn 80 g \(mức báo 90\)/);
  await until(async () => (await o.call('snapshot', {})).inventory.find(i => i.id === 'tea').stock === 80);
  await until(async () => events.length >= 2 || true);
  events.length = 0;
  await s.call('createOrder', order({items: [drink()]}));                       // already below the level: no second low-stock alert
  assert.deepEqual(events.map(e => e.type), ['order']);
  events.length = 0;
  await s.call('updateOrder', {id: first.id, version: 1, change: 'cancel', reason: 'Khách bỏ', mutationId: key()});
  assert.equal(events[0].type, 'cancel');
  assert.match(events[0].title, /^Đơn bị hủy #/);
  assert.match(events[0].body, /25\.000đ · Khách bỏ/);
  // owner refunds a paid order
  const paid = await o.call('createOrder', order());
  const ownerEvents = []; o.b.onNotify(e => ownerEvents.push(e));
  await o.call('updateOrder', {id: paid.id, version: 1, change: 'refund', reason: 'Khách bỏ', mutationId: key()});
  assert.match(ownerEvents[0].title, /^Hoàn tiền đơn #/);
  // a failing notifier never breaks a sale
  s.b.onNotify(() => { throw new Error('boom'); });
  assert.ok((await s.call('createOrder', order())).id);
});

test('a snack portion can describe its contents ("1 phần = 4 viên") and is sold whole, never by the piece', async () => {
  const o = await phone(OWNER);
  await o.call('saveMenuCategories', {categories: [...(await o.call('snapshot', {})).menuCategories, 'Ăn vặt']});
  const saved = await o.call('saveMenu', {id: 'com-hong', name: 'Cốm hồng', category: 'Ăn vặt', kind: 'food', active: true, unit: 'phần', packQty: 1, unitNote: '  4 viên  ', sizes: {M: 10000}});
  assert.deepEqual([saved.unit, saved.packQty, saved.note], ['phần', 1, '4 viên']);
  await until(async () => (await o.call('snapshot', {})).menu.find(m => m.id === 'com-hong')?.note === '4 viên');
  const it = quantity => ({productId: 'com-hong', size: 'M', sugar: 0, ice: 'none', quantity, toppings: [], note: ''});
  const made = await o.call('createOrder', order({items: [it(2)]}));
  assert.equal(made.total, 20000);
  assert.equal(made.items[0].portion, '4 viên');
  await assert.rejects(o.call('createOrder', order({items: [it(1.5)]})), /Số lượng từ 1 đến 200/);   // no half portions, no single pieces
  // drinks and toppings never carry a portion note
  const drinkSaved = await o.call('saveMenu', {id: 'dr', name: 'Trà thử', category: 'Trà sữa', kind: 'drink', unitNote: '4 viên', sizes: {M: 15000}});
  assert.equal(drinkSaved.note, '');
});

test('owner can reorder the menu; staff cannot; unlisted items keep their relative order', async () => {
  const o = await phone(OWNER, 'Chủ');
  await o.call('reorderMenu', {ids: ['lychee', 'matcha']});
  let ids = (await o.call('snapshot', {})).menu.map(m => m.id);
  assert.deepEqual(ids.slice(0, 2), ['lychee', 'matcha']);
  assert.deepEqual(ids.slice(2), ['milk', 'oolong', 'peach', 'pearl', 'pudding']);
  await o.call('reorderMenu', {ids});
  await assert.rejects(o.call('reorderMenu', {ids: ['nope']}), /không còn trong menu/);
  await o.call('saveMenuCategories', {categories: (await o.call('snapshot', {})).menuCategories});
  const s = await phone(SALES, 'Nhân viên');
  await assert.rejects(s.call('reorderMenu', {ids: ['peach']}), /quyền/i);
});

test('owner can delete menu items, ingredients, staff and promos; recipes follow; staff and self cannot', async () => {
  const o = await phone(OWNER, 'Chủ');
  const s = await phone(SALES, 'Nhân viên');
  await o.call('saveUser', {email: 'temp@test.com', name: 'Tạm', role: 'sales', active: true});
  await o.call('saveIngredient', {name: 'Sữa', unit: 'ml', stock: 1000, minStock: 10, active: true});
  const ing = (await o.call('snapshot', {})).inventory[0];
  await o.call('saveRecipe', {productId: 'milk', lines: [{ingredientId: ing.id, qty: 50}]});
  await o.call('savePromo', {id: 'p1', name: 'KM', type: 'percent', value: 10, active: true});
  await assert.rejects(s.call('deleteMenu', {id: 'milk'}), /quyền/i);
  await assert.rejects(o.call('deleteUser', {email: OWNER}), /đang đăng nhập/);
  await o.call('deleteIngredient', {id: ing.id});
  let snap = await o.call('snapshot', {});
  assert.equal(snap.inventory.length, 0);
  assert.equal(snap.recipes.length, 0);
  await o.call('deleteMenu', {id: 'milk'});
  await o.call('deletePromo', {id: 'p1'});
  await o.call('deleteUser', {email: 'temp@test.com'});
  snap = await o.call('snapshot', {});
  assert.ok(!snap.menu.some(m => m.id === 'milk'));
  assert.equal(snap.promos.length, 0);
  assert.ok(!snap.users.some(u => u.email === 'temp@test.com'));
  await assert.rejects(o.call('deleteMenu', {id: 'milk'}), /Không tìm thấy/);
});

// A scripted "model": each reply is a list of content blocks. Lets us test the AI loop against the real backend and rules.
const scripted = replies => { const sent = []; return {sent, fetchImpl: async (url, opts) => { sent.push(JSON.parse(opts.body)); return {ok: true, status: 200, json: async () => ({content: replies.shift()})}; }}; };
const use = (id, name, input) => ({type: 'tool_use', id, name, input});

test('AI assistant: reads freely, changes only after the owner allows, can do payroll maths, has no way to touch history', async () => {
  const o = await phone(OWNER, 'Chủ');
  const run = createToolRunner((a, d) => o.b.call(a, d));
  assert.ok(!TOOLS.some(t => /expense|order_history|delete_order|clear|shift/.test(t.name)), 'no tool may delete history or expenses');
  assert.ok(TOOLS.filter(t => !t.write).every(t => /^(get_|list_|calculate_)/.test(t.name)));
  const confirms = [];
  const base = {apiKey: 'sk-ant-test', run, onEvent: () => {}};
  // 1) read, then add a promo, owner allows
  let m = [{role: 'user', content: 'thêm khuyến mãi'}];
  let fake = scripted([[use('a', 'get_shop_data', {})], [use('b', 'save_promo', {name: 'Giờ vàng', type: 'percent', value: 10, startHour: 14, endHour: 17})], [{type: 'text', text: 'Xong'}]]);
  await runTurn({...base, messages: m, fetchImpl: fake.fetchImpl, confirm: async (n, i, t) => { confirms.push(t); return true; }});
  assert.equal(confirms.length, 1); assert.match(confirms[0], /Giờ vàng/);
  assert.deepEqual((await o.call('snapshot', {})).promos.map(p => p.name), ['Giờ vàng']);
  assert.equal(fake.sent[0].tools.length, TOOLS.length);
  // 2) owner denies a delete: nothing happens and the model is told
  const id = (await o.call('snapshot', {})).menu[0].id;
  m = [{role: 'user', content: 'xóa món đầu'}];
  fake = scripted([[use('c', 'delete_menu_item', {id})], [{type: 'text', text: 'Ok, không xóa'}]]);
  await runTurn({...base, messages: m, fetchImpl: fake.fetchImpl, confirm: async () => false});
  assert.ok((await o.call('snapshot', {})).menu.some(x => x.id === id));
  assert.match(JSON.stringify(m), /TỪ CHỐI/);
  // 3) partial edit keeps the other fields; payroll is computed from time clock without confirmation
  fake = scripted([[use('d', 'save_menu_item', {id, active: false})], [use('e', 'calculate_payroll', {hourlyRate: 25000})], [{type: 'text', text: 'ok'}]]);
  m = [{role: 'user', content: 'x'}];
  let asked = 0;
  await runTurn({...base, messages: m, fetchImpl: fake.fetchImpl, confirm: async () => { asked++; return true; }});
  assert.equal(asked, 1);
  const edited = (await o.call('snapshot', {})).menu.find(x => x.id === id);
  assert.equal(edited.active, false); assert.ok(Object.keys(edited.sizes).length >= 1);
  assert.match(JSON.stringify(m), /totalPay/);
  // 4) bad key gives a clear message; a staff phone cannot use the tools (rules)
  await assert.rejects(runTurn({...base, messages: [{role: 'user', content: 'x'}], confirm: async () => true, fetchImpl: async () => ({ok: false, status: 401, json: async () => ({})})}), /API key/);
  const s = await phone(SALES, 'NV');
  await assert.rejects(createToolRunner((a, d) => s.b.call(a, d))('save_promo', {name: 'Lậu', type: 'percent', value: 5}), /quyền/i);
});

test('AI assistant also works through OpenRouter (OpenAI format) with the same confirmation rule', async () => {
  const o = await phone(OWNER, 'Chủ');
  const run = createToolRunner((a, d) => o.b.call(a, d));
  const sent = [];
  const replies = [
    {choices: [{message: {content: null, tool_calls: [{id: 't1', type: 'function', function: {name: 'save_promo', arguments: JSON.stringify({name: 'Cuối tuần', type: 'amount', value: 5000})}}]}}]},
    {choices: [{message: {content: 'Đã thêm'}}]}
  ];
  const fetchImpl = async (url, opts) => { sent.push({url, headers: opts.headers, body: JSON.parse(opts.body)}); return {ok: true, status: 200, json: async () => replies.shift()}; };
  const m = [{role: 'user', content: 'thêm KM cuối tuần'}];
  let asked = 0;
  await runTurn({provider: 'openrouter', apiKey: 'sk-or-test', messages: m, run, fetchImpl, onEvent: () => {}, confirm: async () => { asked++; return true; }});
  assert.equal(asked, 1);
  assert.equal(sent[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(sent[0].headers.authorization, 'Bearer sk-or-test');
  assert.equal(sent[0].body.tools[0].type, 'function');
  assert.equal(sent[1].body.messages.at(-1).role, 'tool');            // the result went back as an OpenAI tool message
  assert.equal(sent[1].body.messages.at(-2).tool_calls[0].function.name, 'save_promo');
  assert.deepEqual((await o.call('snapshot', {})).promos.map(p => p.name), ['Cuối tuần']);
  assert.equal(fromOpenAI({choices: [{message: {content: 'x', tool_calls: [{id: 'a', function: {name: 'n', arguments: '{bad'}}]}}]})[1].input.constructor, Object);
  await assert.rejects(runTurn({provider: 'openrouter', apiKey: 'k', messages: [{role: 'user', content: 'x'}], run, confirm: async () => true, fetchImpl: async () => ({ok: false, status: 402, json: async () => ({})})}), /hết số dư/);
});

test('AI settings are stored online for the owner only and follow them to another phone', async () => {
  const o = await phone(OWNER, 'Chủ');
  assert.deepEqual(await o.call('getAiConfig', {}), {provider: '', keys: {}, models: {}});
  await o.call('saveAiConfig', {provider: 'openrouter', keys: {openrouter: 'sk-or-abc', anthropic: ''}, models: {openrouter: 'anthropic/claude-sonnet-4.5'}});
  const o2 = await phone(OWNER, 'Chủ');            // a second device
  assert.equal((await o2.call('getAiConfig', {})).keys.openrouter, 'sk-or-abc');
  await assert.rejects(o.call('saveAiConfig', {provider: 'evil', keys: {}, models: {}}), /không hợp lệ/);
  const s = await phone(SALES, 'NV');
  await assert.rejects(s.call('getAiConfig', {}), /quyền/i);
  // even straight against the database a staff account cannot read it, and the shop backup never contains it
  await assertFails(F.getDoc(F.doc(rawDb(SALES), 'aiConfig', OWNER)));
  await assertFails(F.getDoc(F.doc(rawDb(SALES), 'aiConfig', SALES)));
  assert.ok(!JSON.stringify(await o.call('exportAll', {})).includes('sk-or-abc'));
});

test('model lists are loaded from the key: Anthropic as is, OpenRouter only models that support tools', async () => {
  let seen;
  const a = await listModels({provider: 'anthropic', apiKey: 'sk-ant-x', fetchImpl: async (u, o) => { seen = {u, h: o.headers}; return {ok: true, status: 200, json: async () => ({data: [{id: 'claude-b', display_name: 'B'}, {id: 'claude-a', display_name: 'A'}]})}; }});
  assert.deepEqual(a.map(x => x.id), ['claude-a', 'claude-b']); assert.equal(seen.h['x-api-key'], 'sk-ant-x');
  const r = await listModels({provider: 'openrouter', apiKey: '', fetchImpl: async () => ({ok: true, status: 200, json: async () => ({data: [{id: 'x/t', name: 'T', supported_parameters: ['tools']}, {id: 'x/n', name: 'N', supported_parameters: ['temperature']}]})})});
  assert.deepEqual(r.map(x => x.id), ['x/t']);
  await assert.rejects(listModels({provider: 'anthropic', apiKey: 'bad', fetchImpl: async () => ({ok: false, status: 401, json: async () => ({})})}), /API key/);
});

test('AI settings are shared by every owner account but never by staff', async () => {
  const o = await phone(OWNER, 'Chủ');
  await o.call('saveUser', {email: 'owner2@test.com', name: 'Chủ 2', role: 'owner', active: true});
  await o.call('saveAiConfig', {provider: 'anthropic', keys: {anthropic: 'sk-ant-shared'}, models: {anthropic: 'claude-x'}});
  const o2 = await phone('owner2@test.com', 'Chủ 2');
  assert.deepEqual(await o2.call('getAiConfig', {}), {provider: 'anthropic', keys: {anthropic: 'sk-ant-shared'}, models: {anthropic: 'claude-x'}});
  await o2.call('saveAiConfig', {provider: 'anthropic', keys: {anthropic: 'sk-ant-shared'}, models: {anthropic: 'claude-y'}});
  assert.equal((await o.call('getAiConfig', {})).models.anthropic, 'claude-y');
  const s = await phone(SALES, 'NV');
  await assert.rejects(s.call('getAiConfig', {}), /quyền/i);
  await assertFails(F.getDoc(F.doc(rawDb(SALES), 'aiConfig', 'shared')));
  await assertFails(F.setDoc(F.doc(rawDb(SALES), 'aiConfig', 'shared'), {provider: 'anthropic', keys: {}, models: {}}));
});

// VietQR scanning: build a real bank-style payload, render it as a QR bitmap, decode it and parse it.
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {parseVietQR} from '../web/src/vietqr.js';
const emv = (tag, v) => tag + String(Buffer.byteLength(v)).padStart(2, '0') + v;
const crc = s => { let c = 0xFFFF; for (const ch of Buffer.from(s)) { c ^= ch << 8; for (let i = 0; i < 8; i++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF; } return c.toString(16).toUpperCase().padStart(4, '0'); };
const vietqr = ({bin = '970422', account = '0123456789', name = 'NGUYEN VAN A', amount = ''} = {}) => {
  const body = emv('00', '01') + emv('01', amount ? '12' : '11')
    + emv('38', emv('00', 'A000000727') + emv('01', emv('00', bin) + emv('01', account)) + emv('02', 'QRIBFTTA'))
    + emv('53', '704') + (amount ? emv('54', amount) : '') + emv('58', 'VN') + emv('59', name) + '6304';
  return body + crc(body);
};

test('VietQR: reads bin, account and name from a real QR image; rejects other QR codes and damaged ones', async () => {
  const text = vietqr();
  const qr = QRCode.create(text, {errorCorrectionLevel: 'M'}), n = qr.modules.size, scale = 6, quiet = 4, W = (n + quiet * 2) * scale;
  const px = new Uint8ClampedArray(W * W * 4).fill(255);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.modules.get(x, y)) for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) { const o = (((y + quiet) * scale + dy) * W + (x + quiet) * scale + dx) * 4; px[o] = px[o + 1] = px[o + 2] = 0; }
  const hit = jsQR(px, W, W);
  assert.equal(hit.data, text);
  assert.deepEqual(parseVietQR(hit.data), {bin: '970422', account: '0123456789', name: 'NGUYEN VAN A'});
  assert.equal(parseVietQR(vietqr({name: 'Nguyễn Văn Đạt', amount: '50000'})).name, 'NGUYEN VAN DAT');
  assert.equal(parseVietQR(vietqr({amount: '50000'})).hasAmount, true);
  assert.throws(() => parseVietQR('https://example.com'), /không phải mã VietQR/);
  assert.equal(parseVietQR(text.slice(0, -4) + '0000').crcWarning, true);
  assert.throws(() => parseVietQR(vietqr({bin: '12'})), /đủ mã ngân hàng/);
});

test('storage usage is estimated; old orders, clock-ins and expenses can be cleared but never the last 30 days, the menu or recipes', async () => {
  const o = await phone(OWNER, 'Chủ');
  const old = '2020-01-05', recent = new Date().toISOString().slice(0, 10);
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    const put = (c, id, data) => F.setDoc(F.doc(db, c, id), data);
    await put('orders', 'o-old', {id: 'o-old', createdAt: old + 'T02:00:00.000Z', createdDay: old, status: 'delivered', paid: true, paidAt: '2020-01-05T03:00:00.000Z', paidDay: '2020-01-05', paymentMethod: 'cash', total: 25000, items: [], audit: []});
    await put('orders', 'o-open', {id: 'o-open', createdAt: old + 'T02:00:00.000Z', createdDay: old, status: 'ready', paid: false, total: 25000, items: [], audit: []});
    await put('orders', 'o-unrec', {id: 'o-unrec', createdAt: old + 'T02:00:00.000Z', createdDay: old, status: 'delivered', paid: true, paidAt: '2020-01-05T03:00:00.000Z', paidDay: '2020-01-05', paymentMethod: 'cash', unreconciled: true, total: 25000, items: [], audit: []});
    await put('orders', 'o-new', {id: 'o-new', createdAt: recent + 'T02:00:00.000Z', createdDay: recent, status: 'delivered', paid: true, paidAt: new Date().toISOString(), paidDay: recent, paymentMethod: 'cash', total: 25000, items: [], audit: []});
    await put('timeclock', 'c-old', {email: SALES, inAt: old + 'T01:00:00.000Z', outAt: old + 'T09:00:00.000Z'});
    await put('timeclock', 'c-open', {email: SALES, inAt: old + 'T01:00:00.000Z', outAt: ''});
    await put('expenses', 'e-old', {id: 'e-old', day: old, amount: 1000, voided: false});
    await put('expenses', 'e-new', {id: 'e-new', day: recent, amount: 1000, voided: false});
    await put('stats', old, {day: old, total: 25000, count: 1});
  });
  const u = await o.call('storageUsage', {});
  assert.equal(u.quotaBytes, 1024 ** 3); assert.ok(u.usedBytes > 0 && u.freeBytes < u.quotaBytes);
  assert.equal(u.collections.find(c => c.name === 'orders').count, 4);
  await assert.rejects(o.call('cleanupOldData', {keepDays: 29, kinds: ['orders']}), /ít nhất 30 ngày/);
  await assert.rejects(o.call('cleanupOldData', {keepDays: 30, kinds: ['menu']}), /chọn loại/);
  const prev = await o.call('cleanupOldData', {keepDays: 30, kinds: ['orders', 'timeclock', 'expenses'], dryRun: true});
  assert.deepEqual(prev.counts, {orders: 1, expenses: 1, timeclock: 1}); assert.equal(prev.total, 3);
  assert.equal((await o.call('storageUsage', {})).collections.find(c => c.name === 'orders').count, 4);   // preview deleted nothing
  const s = await phone(SALES, 'NV');
  await assert.rejects(s.call('cleanupOldData', {keepDays: 30, kinds: ['orders']}), /quyền/i);
  await assertFails(F.deleteDoc(F.doc(rawDb(SALES), 'orders', 'o-old')));
  const menuBefore = (await o.call('snapshot', {})).menu.length;
  const done = await o.call('cleanupOldData', {keepDays: 30, kinds: ['orders', 'timeclock', 'expenses']});
  assert.equal(done.total, 3);
  const after = await o.call('storageUsage', {});
  const n = name => after.collections.find(c => c.name === name).count;
  assert.deepEqual([n('orders'), n('timeclock'), n('expenses'), n('stats')], [3, 1, 1, 1]);   // open/unreconciled/recent orders, open clock-in, recent expense, stats all kept
  assert.equal((await o.call('snapshot', {})).menu.length, menuBefore);
});

test('split payment: part cash, part transfer — totals, shift cash, reconciling and refund all follow the split', async () => {
  const o = await phone(OWNER);
  const day = o.b.dayOf(new Date());
  await o.call('openShift', {openingCash: 100000});
  // a 50.000đ sale: 30.000 cash + 20.000 transfer
  for (const bad of [0, 50000, 20000.5, -5]) await assert.rejects(o.call('createOrder', order({items: [drink({quantity: 2})], paymentMethod: 'split', cashPart: bad})), /Chia thanh toán/);
  const s = await o.call('createOrder', order({items: [drink({quantity: 2})], paymentMethod: 'split', cashPart: 30000}));
  assert.equal(s.paymentMethod, 'split'); assert.equal(s.cashPart, 30000);
  let rep = await o.call('report', {from: day, to: day});
  assert.deepEqual([rep.total, rep.cash, rep.transfer], [50000, 30000, 20000]);
  assert.deepEqual(rep.unreconciled.map(u => u.total), [20000]);            // only the transferred part needs matching
  await o.call('updateOrder', {id: s.id, version: 1, change: 'reconcile', reason: 'khớp sao kê', mutationId: key()});
  assert.equal((await o.call('report', {from: day, to: day})).unreconciled.length, 0);
  // an unpaid order paid later by split, with the cash part tendered as 50.000 -> change 20.000
  const u = await o.call('createOrder', order({items: [drink({quantity: 2})], paid: false}));
  await assert.rejects(o.call('updateOrder', {id: u.id, version: 1, change: 'pay', paymentMethod: 'split', cashPart: 30000, cashReceived: 20000, mutationId: key()}), /không ít hơn phần tiền mặt/);
  const paid = await o.call('updateOrder', {id: u.id, version: 1, change: 'pay', paymentMethod: 'split', cashPart: 30000, cashReceived: 50000, mutationId: key()});
  const entry = paid.audit.at(-1);
  assert.deepEqual([paid.paid, paid.cashPart, entry.cashReceived, entry.changeGiven], [true, 30000, 50000, 20000]);
  rep = await o.call('report', {from: day, to: day});
  assert.deepEqual([rep.total, rep.cash, rep.transfer], [100000, 60000, 40000]);
  // shift: opening + only the cash parts
  const closed = await o.call('closeShift', {closingCash: 160000});
  assert.equal(closed.expectedCash, 160000); assert.equal(closed.difference, 0);
  // refunding a split order takes both parts back out
  await o.call('updateOrder', {id: s.id, version: 2, change: 'refund', reason: 'Khác: khách đổi ý', mutationId: key()});
  rep = await o.call('report', {from: day, to: day});
  assert.deepEqual([rep.total, rep.cash, rep.transfer], [50000, 30000, 20000]);
});

test('owner can correct how a paid order was paid; totals, shift cash and reconciling follow; staff cannot', async () => {
  const o = await phone(OWNER);
  const day = o.b.dayOf(new Date());
  await o.call('openShift', {openingCash: 0});
  const a = await o.call('createOrder', order({items: [drink({quantity: 2})]}));              // 50.000 cash
  let rep = await o.call('report', {from: day, to: day});
  assert.deepEqual([rep.cash, rep.transfer, rep.unreconciled.length], [50000, 0, 0]);
  const s = await phone(SALES);
  await assert.rejects(s.call('updateOrder', {id: a.id, version: 1, change: 'repay', paymentMethod: 'transfer', mutationId: key()}), /quyền/);
  await assert.rejects(o.call('updateOrder', {id: a.id, version: 1, change: 'repay', paymentMethod: 'cash', mutationId: key()}), /không thay đổi/);
  await assert.rejects(o.call('updateOrder', {id: a.id, version: 1, change: 'repay', paymentMethod: 'split', cashPart: 50000, mutationId: key()}), /Chia thanh toán/);
  let r = await o.call('updateOrder', {id: a.id, version: 1, change: 'repay', paymentMethod: 'split', cashPart: 30000, mutationId: key()});
  assert.deepEqual([r.paymentMethod, r.cashPart, r.total], ['split', 30000, 50000]);
  rep = await o.call('report', {from: day, to: day});
  assert.deepEqual([rep.total, rep.cash, rep.transfer, rep.unreconciled.map(x => x.total)], [50000, 30000, 20000, [20000]]);
  await o.call('updateOrder', {id: a.id, version: 2, change: 'reconcile', reason: 'khớp', mutationId: key()});
  r = await o.call('updateOrder', {id: a.id, version: 3, change: 'repay', paymentMethod: 'split', cashPart: 10000, mutationId: key()});   // transfer part changed
  assert.equal(r.reconciled, false);
  rep = await o.call('report', {from: day, to: day});
  assert.deepEqual([rep.cash, rep.transfer, rep.unreconciled.length], [10000, 40000, 1]);
  const closed = await o.call('closeShift', {closingCash: 10000});
  assert.equal(closed.expectedCash, 10000);
  await o.call('updateOrder', {id: a.id, version: 4, change: 'refund', reason: 'Khác: thử', mutationId: key()});
  rep = await o.call('report', {from: day, to: day});
  assert.deepEqual([rep.total, rep.cash, rep.transfer], [0, 0, 0]);
});

test('an order made without payment can be paid later from the orders list, by cash, transfer or split', async () => {
  const o = await phone(OWNER);
  const day = o.b.dayOf(new Date());
  const u = await o.call('createOrder', order({paid: false}));
  const paid = await o.call('updateOrder', {id: u.id, version: 1, change: 'pay', paymentMethod: 'transfer', mutationId: key()});
  assert.equal(paid.paid, true);
  const rep = await o.call('report', {from: day, to: day});
  assert.deepEqual([rep.cash, rep.transfer], [0, 25000]);
});

test('VietQR: names with accents (byte lengths), a wrong check code and non-bank codes are handled with clear results', async () => {
  const r = parseVietQR(vietqr({name: 'Nguyễn Giang Bảo'}));
  assert.deepEqual(r, {bin: '970422', account: '0123456789', name: 'NGUYEN GIANG BAO'});
  const good = vietqr();
  const off = parseVietQR(good.slice(0, -4) + '0000');                      // damaged check code: still offered, with a warning
  assert.equal(off.crcWarning, true); assert.equal(off.account, '0123456789');
  assert.throws(() => parseVietQR('https://momo.vn/pay/abc'), /Nội dung đọc được: "https:\/\/momo\.vn/);
  assert.throws(() => parseVietQR(vietqr({bin: '12'})), /đủ mã ngân hàng/);
});

test('VietQR: MB-style QR carries an identifier (VQRQ…) instead of the account number; it is accepted and saved', async () => {
  const body = emv('00', '01') + emv('01', '11') + emv('38', emv('00', 'A000000727') + emv('01', emv('00', '970422') + emv('01', 'VQRQ00012c080')) + emv('02', 'QRIBFTTA')) + emv('53', '704') + emv('58', 'VN') + '6304';
  const r = parseVietQR(body + crc(body));
  assert.deepEqual(r, {bin: '970422', account: 'VQRQ00012c080', name: '', alias: true});
  const o = await phone(OWNER, 'Chủ');
  const saved = await o.call('saveSettings', {bankBin: r.bin, bankAccount: r.account, bankName: 'NGUYEN GIANG BAO'});
  assert.equal(saved.bank.account, 'VQRQ00012c080');
  await assert.rejects(o.call('saveSettings', {bankBin: '970422', bankAccount: 'ab', bankName: ''}), /Số tài khoản/);
});

test('VietQR: payload variants used by Vietnamese banks (BIN, account length, card service, amount, extra blocks, name) all parse', async () => {
  const banks = [['Vietcombank', '970436', '0071001234567'], ['VietinBank', '970415', '107869912345'], ['BIDV', '970418', '31410001234567'], ['Agribank', '970405', '1503205123456'],
    ['Techcombank', '970407', '19036123456789'], ['MB', '970422', '889308886'], ['ACB', '970416', '12345678'], ['VPBank', '970432', '0123456789'], ['TPBank', '970423', '00012345678'],
    ['Sacombank', '970403', '060123456789'], ['HDBank', '970437', '012704060123456'], ['SHB', '970443', '1234567890'], ['VIB', '970441', '123456789'], ['OCB', '970448', '0004100012345678'],
    ['MSB', '970426', '12501012345678'], ['Eximbank', '970431', '200014123456'], ['SeABank', '970440', '000012345678'], ['LPBank', '970449', '0123456789012'], ['Nam A Bank', '970428', '1234567890123'], ['Bac A Bank', '970409', '9876543210']];
  for (const [bank, bin, account] of banks) {
    // plain static account QR
    assert.deepEqual(parseVietQR(vietqr({bin, account, name: 'TRAN THI HOA'})), {bin, account, name: 'TRAN THI HOA'}, bank);
  }
  const wrap = (acct, extra = '', crcCase = 'up') => {
    const body = emv('00', '01') + emv('01', '12') + extra + emv('38', emv('00', 'A000000727') + emv('01', acct) + emv('02', 'QRIBFTTC')) + emv('53', '704') + emv('54', '150000') + emv('58', 'VN') + emv('59', 'Lê Văn Đức') + emv('62', emv('01', 'HD001') + emv('08', 'Thanh toan')) + '6304';
    const c = crc(body); return body + (crcCase === 'low' ? c.toLowerCase() : c);
  };
  // card number service, amount present, bill number, accents, another merchant block first, lowercase CRC
  const r = parseVietQR(wrap(emv('00', '970436') + emv('01', '9704361234567890'), emv('26', emv('00', 'com.example') + emv('01', 'x')), 'low'));
  assert.deepEqual(r, {bin: '970436', account: '9704361234567890', name: 'LE VAN DUC', hasAmount: true});
  // the identifier style (MB, and any bank that uses one)
  assert.equal(parseVietQR(wrap(emv('00', '970422') + emv('01', 'VQRQ00012c080'))).alias, true);
  // codes that are not bank transfers say what they are
  assert.throws(() => parseVietQR('00020101021126430010A0000007270127000697041601131234567890208QRIBFTTA5303704630400'), /bị lỗi|không phải|đủ/);
  assert.throws(() => parseVietQR('MOMO|0912345678|0'), /Nội dung đọc được/);
});

test('clock page data: today and week minutes, today plan and recent entries come with the snapshot', async () => {
  const o = await phone(OWNER);
  await o.call('saveUser', {email: SALES, name: 'Minh', role: 'sales', active: true});
  const day = (await o.call('snapshot', {})).day;
  await o.call('saveShift', {email: SALES, days: [day], start: '07:00', end: '12:00'});
  const s = await phone(SALES);
  await s.call('clockIn', {});
  const c = (await s.call('snapshot', {})).clock;
  assert.ok(c.mine);
  assert.deepEqual(c.plan, [{start: '07:00', end: '12:00'}]);
  assert.ok(c.todayMinutes >= 0 && c.weekMinutes >= c.todayMinutes);
  await s.call('clockOut', {});
  assert.equal((await s.call('snapshot', {})).clock.recent.length, 1);
});

test('large amounts: rent-sized expenses, big stock numbers and 120-cup orders are accepted', async () => {
  const o = await phone(OWNER);
  await o.call('saveExpense', {requestKey: key(), category: 'Thuê mặt bằng', amount: 15000000});
  await o.call('createOrder', order({items: [drink({quantity: 120})]}));
  const day = (await o.call('snapshot', {})).day;
  const rep = await o.call('report', {from: day, to: day});
  assert.equal(rep.total, 120 * 25000);
});

test('support account sees the live schedule and sees it empty after the owner deletes it', async () => {
  const o = await phone(OWNER, 'Chủ');
  await o.call('saveUser', {email: SALES, name: 'Minh', role: 'sales', active: true});
  const today = (await o.call('snapshot', {})).day;
  await o.call('saveShift', {email: SALES, days: [today], start: '07:00', end: '12:00'});
  await seedUser('help@test.com', 'support');
  const h = await phone('help@test.com');
  assert.equal((await h.call('scheduleWeek', {from: today})).shifts.length, 1);
  const sh = (await o.call('scheduleWeek', {from: today})).shifts[0];
  await o.call('deleteShift', {id: sh.id});
  await until(async () => (await h.call('scheduleWeek', {from: today})).shifts.length === 0);
});

test('staff schedule: owner plans shifts (several days at once, two people can share a shift), staff see the week, colours are stable', async () => {
  const o = await phone(OWNER, 'Chủ');
  await o.call('saveUser', {email: SALES, name: 'Minh', role: 'sales', active: true});
  await o.call('saveUser', {email: 'lan@test.com', name: 'Lan', role: 'sales', active: true});
  const monday = '2030-01-07';                                   // a Monday
  const days = ['2030-01-07', '2030-01-08', '2030-01-09'];
  await o.call('saveShift', {email: SALES, days, start: '07:00', end: '12:00', note: 'sáng'});
  await o.call('saveShift', {email: 'lan@test.com', days: ['2030-01-07'], start: '09:00', end: '14:00'});   // overlaps Minh: allowed
  await assert.rejects(o.call('saveShift', {email: SALES, days: ['2030-01-07'], start: '11:00', end: '13:00'}), /trùng giờ/);      // same person, overlapping
  await assert.rejects(o.call('saveShift', {email: SALES, days: ['2030-01-10'], start: '12:00', end: '12:00'}), /sau giờ bắt đầu/);
  await assert.rejects(o.call('saveShift', {email: SALES, days: ['2030-01-10'], start: '7:00', end: '12:00'}), /không hợp lệ/);
  await assert.rejects(o.call('saveShift', {email: 'ghost@test.com', days: ['2030-01-10'], start: '07:00', end: '12:00'}), /nhân viên/);
  const s = await phone(SALES, 'Minh');
  const mine = await s.call('scheduleWeek', {from: '2030-01-09'});         // a staff member gets only their own shifts
  assert.equal(mine.from, monday); assert.equal(mine.to, '2030-01-13');
  assert.deepEqual(mine.shifts.map(x => x.name), ['Minh', 'Minh', 'Minh']);
  const week = await o.call('scheduleWeek', {from: '2030-01-09'});          // the owner sees everyone; any day of the week gives its Monday
  assert.equal(week.shifts.length, 4);
  assert.deepEqual(week.shifts.filter(x => x.day === monday).map(x => x.name), ['Minh', 'Lan']);
  assert.notEqual(week.colors[SALES], week.colors['lan@test.com']);          // different colours
  // straight against the database: another person's shift and a whole-week query are refused, one's own is fine
  const lan = week.shifts.find(x => x.email === 'lan@test.com');
  await assertFails(F.getDoc(F.doc(rawDb(SALES), 'schedule', lan.id)));
  await assertFails(F.getDocs(F.query(F.collection(rawDb(SALES), 'schedule'), F.where('day', '>=', '2030-01-07'), F.where('day', '<=', '2030-01-13'))));
  await assertSucceeds(F.getDocs(F.query(F.collection(rawDb(SALES), 'schedule'), F.where('email', '==', SALES))));
  await assert.rejects(s.call('saveShift', {email: SALES, days: ['2030-01-11'], start: '07:00', end: '12:00'}), /quyền/);
  await assertFails(F.setDoc(F.doc(rawDb(SALES), 'schedule', 'x'), {email: SALES, day: '2030-01-11', start: '07:00', end: '12:00'}));
  // edit one shift, move it to another day; then delete
  const first = mine.shifts.find(x => x.day === monday);
  await o.call('saveShift', {id: first.id, email: SALES, day: '2030-01-11', start: '08:00', end: '11:30', note: ''});
  let w2 = await o.call('scheduleWeek', {from: monday});
  assert.ok(w2.shifts.some(x => x.id === first.id && x.day === '2030-01-11' && x.start === '08:00'));
  await o.call('deleteShift', {id: first.id});
  w2 = await o.call('scheduleWeek', {from: monday});
  assert.equal(w2.shifts.length, 3);
  // copy the week forward: copies shifts, skips what already exists
  const c1 = await o.call('copyWeek', {from: '2030-01-14'});
  assert.equal(c1.copied, 3);
  assert.equal((await o.call('copyWeek', {from: '2030-01-14'})).copied, 0);
  assert.equal((await o.call('scheduleWeek', {from: '2030-01-14'})).shifts.length, 3);
});

test('schedule shows actual clock-in/out per day: owner sees everyone, staff only themselves', async () => {
  const o = await phone(OWNER, 'Chủ');
  await o.call('saveUser', {email: SALES, name: 'Minh', role: 'sales', active: true});
  const s = await phone(SALES, 'Minh');
  await s.call('clockIn', {});
  await o.call('clockIn', {});
  const day = o.b.dayOf(new Date());
  const ow = await until(async () => { const r = await o.call('scheduleWeek', {from: day}); return r.clock.length === 2 && r; });   // the owner's live copy catches up
  assert.deepEqual(ow.clock.map(c => c.email).sort(), [OWNER, SALES].sort());
  assert.ok(ow.clock.every(c => c.day === day && c.outAt === '' && c.minutes >= 0));
  const st = await s.call('scheduleWeek', {from: day});
  assert.deepEqual(st.clock.map(c => c.email), [SALES]);
  await s.call('clockOut', {});
  await until(async () => (await o.call('scheduleWeek', {from: day})).clock.find(c => c.email === SALES).outAt !== '');
});

test('schedule entries older than 60 days are removed by the owner app; staff cannot delete', async () => {
  const o = await phone(OWNER, 'Chủ');
  await o.call('saveUser', {email: SALES, name: 'Minh', role: 'sales', active: true});
  await o.call('saveShift', {email: SALES, days: ['2030-03-01'], start: '08:00', end: '12:00'});
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    // an old shift and a recent one
    await F.setDoc(F.doc(db, 'schedule', 'old1'), {id: 'old1', email: SALES, name: 'Minh', day: '2020-01-06', start: '08:00', end: '12:00'});
    const today = new Date().toISOString().slice(0, 10);
    await F.setDoc(F.doc(db, 'schedule', 'new1'), {id: 'new1', email: SALES, name: 'Minh', day: today, start: '08:00', end: '12:00'});
  });
  const s = await phone(SALES, 'Minh');
  await assert.rejects(s.call('pruneSchedule', {}), /quyền/);
  await assertFails(F.deleteDoc(F.doc(rawDb(SALES), 'schedule', 'old1')));
  assert.equal((await o.call('pruneSchedule', {})).removed, 1);
  await env.withSecurityRulesDisabled(async ctx => {
    const ids = (await F.getDocs(F.collection(ctx.firestore(), 'schedule'))).docs.map(x => x.id);
    assert.ok(!ids.includes('old1') && ids.includes('new1') && ids.length === 2);   // the future 2030 shift and today's stay
  });
});

test('creating an order does not wait for extra server reads: no duplicate lookup, customer read runs alongside the order number', async () => {
  const counts = {getDoc: 0, runTransaction: 0};
  const fsCount = {...fs, getDoc: (...a) => { counts.getDoc++; return fs.getDoc(...a); }, runTransaction: (...a) => { counts.runTransaction++; return fs.runTransaction(...a); }};
  const b = createBackend({fs: fsCount, db: rawDb(OWNER), projectId: 'demo-tiemvio', seedMenu: TEST_MENU});
  open.push(b);
  await b.attach(OWNER, 'Chủ');
  counts.getDoc = 0; counts.runTransaction = 0;
  const made = await b.call('createOrder', order({}));
  assert.deepEqual([counts.getDoc, counts.runTransaction], [0, 1]);          // only the order-number transaction (was: a duplicate lookup too)
  assert.equal(made.seq, 1);
  // with a customer phone: one customer read, still no duplicate lookup, numbers stay in sequence
  counts.getDoc = 0;
  const second = await b.call('createOrder', order({phone: '0912345678'}));
  assert.equal(counts.getDoc, 1); assert.equal(second.seq, 2);
  // the same request sent again returns the same order from the live copy, creating nothing new
  const req = order({});
  const first = await b.call('createOrder', req);
  const again = await b.call('createOrder', req);
  assert.equal(again.id, first.id); assert.equal(again.seq, first.seq);
  // an unconfirmed attempt that is re-sent asks the server once
  counts.getDoc = 0;
  const retry = order({attempts: 1});
  const r1 = await b.call('createOrder', retry);
  assert.equal((await b.call('createOrder', {...retry, attempts: 1})).id, r1.id);
});

test('rules: staff cannot rewrite how a paid order was paid, un-pay it, or delete daily totals; they can still hand it over', async () => {
  const o = await phone(OWNER, 'Chủ');
  await o.call('saveUser', {email: SALES, name: 'Minh', role: 'sales', active: true});
  const made = await o.call('createOrder', order({items: [drink({quantity: 2})]}));           // paid in cash by the owner
  const day = o.b.dayOf(new Date());
  const staff = rawDb(SALES);
  let raw;
  await env.withSecurityRulesDisabled(async ctx => { raw = (await F.getDoc(F.doc(ctx.firestore(), 'orders', made.id))).data(); });
  const step = patch => ({...raw, ...patch, version: raw.version + 1, audit: [...raw.audit, {at: raw.createdAt, by: SALES, action: 'advance', detail: 'delivered', key: 'k' + Math.random()}]});
  await assertFails(F.setDoc(F.doc(staff, 'orders', made.id), step({paymentMethod: 'transfer'})));        // skim the cash
  await assertFails(F.setDoc(F.doc(staff, 'orders', made.id), step({paymentMethod: 'split', cashPart: 1000})));
  await assertFails(F.setDoc(F.doc(staff, 'orders', made.id), step({paid: false})));                      // un-pay
  await assertSucceeds(F.setDoc(F.doc(staff, 'orders', made.id), step({status: 'delivered'})));           // the normal hand-over
  await assertFails(F.deleteDoc(F.doc(staff, 'stats', day)));
  await assertSucceeds(F.deleteDoc(F.doc(rawDb(OWNER), 'stats', day)));
});

test('ice and sugar options are editable by the owner and can add to the price; old numeric orders keep working', async () => {
  const o = await phone(OWNER, 'Chủ');
  const base = await o.call('snapshot', {});
  assert.deepEqual(base.iceOptions.map(x => x.name), ['Đá vừa', 'Ít đá', 'Không đá', 'Thêm đá']);   // standard list until changed
  assert.deepEqual(base.sugarOptions.map(x => x.percent), [100, 70, 50, 30, 0]);
  // a sale with the standard values (the way older phones send it) still prices at the menu price
  const plain = await o.call('createOrder', order({items: [drink({sugar: 50, ice: 'less'})]}));
  assert.equal(plain.total, 25000);
  assert.equal(plain.items[0].iceName, 'Ít đá'); assert.equal(plain.items[0].sugarName, '50% đường');
  // the owner edits the lists: extra ice and extra sweet cost more
  const saved = await o.call('saveIceOptions', {options: [{id: 'normal', name: 'Đá vừa'}, {name: 'Ít đá'}, {name: 'Không đá'}, {name: 'Thêm đá', price: 3000}]});
  const extraIce = saved.options.find(x => x.name === 'Thêm đá');
  const sugar = await o.call('saveSugarOptions', {options: [{id: '100', name: 'Bình thường', percent: 100}, {name: 'Ít ngọt', percent: 50}, {name: 'Thêm ngọt', percent: 130, price: 2000}]});
  const sweet = sugar.options.find(x => x.name === 'Thêm ngọt');
  const snap = await o.call('snapshot', {});
  assert.equal(snap.iceOptions.length, 4); assert.equal(snap.sugarOptions[2].price, 2000);
  const sale = await o.call('createOrder', order({items: [drink({quantity: 2, ice: extraIce.id, sugarId: sweet.id, sugar: 130})]}));
  assert.equal(sale.items[0].unitPrice, 25000 + 3000 + 2000);
  assert.equal(sale.total, 2 * 30000);
  assert.deepEqual([sale.items[0].iceName, sale.items[0].icePrice, sale.items[0].sugarName, sale.items[0].sugarPrice], ['Thêm đá', 3000, 'Thêm ngọt', 2000]);
  // an option the owner removed can no longer be sold; hot drinks and snacks carry no ice
  await assert.rejects(o.call('createOrder', order({items: [drink({ice: 'less', sugarId: 'gone'})]})), /Mức đường/);
  await o.call('saveIceOptions', {options: [{id: 'normal', name: 'Đá vừa'}]});
  await assert.rejects(o.call('createOrder', order({items: [drink({ice: extraIce.id})]})), /Mức đá/);
  // rules of the lists
  await assert.rejects(o.call('saveIceOptions', {options: []}), /từ 1 đến 8/);
  await assert.rejects(o.call('saveIceOptions', {options: [{name: 'A'}]}), /ít nhất 2 ký tự/);
  await assert.rejects(o.call('saveIceOptions', {options: [{name: 'Đá'}, {name: 'đá'}]}), /trùng/);
  await assert.rejects(o.call('saveIceOptions', {options: [{name: 'Đá nhiều', price: 60000}]}), /0 đến 50\.000/);
  await assert.rejects(o.call('saveSugarOptions', {options: [{name: 'Ngọt', percent: 250}]}), /0 đến 200/);
  const s = await phone(SALES, 'NV');
  await assert.rejects(s.call('saveIceOptions', {options: [{name: 'Đá vừa'}]}), /quyền/);
});

test('reports count cups (drinks only) next to orders: totals, per hour, per channel and per staff; refunds take them back', async () => {
  const o = await phone(OWNER, 'Chủ');
  const day = o.b.dayOf(new Date());
  await o.call('createOrder', order({items: [drink({quantity: 2}), drink({productId: 'oolong', quantity: 1})]}));      // 3 cups, 1 order
  const second = await o.call('createOrder', order({items: [drink({quantity: 4})]}));                                  // 4 cups
  let rep = await o.call('report', {from: day, to: day});
  assert.deepEqual([rep.count, rep.cups], [2, 7]);
  assert.deepEqual([rep.hours[0].count, rep.hours[0].cups], [2, 7]);
  assert.deepEqual([rep.channels[0].count, rep.channels[0].cups], [2, 7]);
  assert.equal(rep.staff[0].cups, 7); assert.equal(rep.days[0].cups, 7);
  await o.call('saveCancelReasons', {reasons: ['Khách đổi ý']});
  await o.call('updateOrder', {id: second.id, version: 1, change: 'refund', reason: 'Khách đổi ý', mutationId: key()});
  rep = await o.call('report', {from: day, to: day});
  assert.deepEqual([rep.count, rep.cups, rep.hours[0].cups], [1, 3, 3]);
});

test('revenue is split into drinks and snacks; a discount is shared out so the two add up to the total', async () => {
  const o = await phone(OWNER, 'Chủ');
  const day = o.b.dayOf(new Date());
  await addCategory(o, 'Ăn vặt');
  const snack = await o.call('saveMenu', {name: 'Cá xù', category: 'Ăn vặt', kind: 'food', sizes: {M: 10000}, active: true, unit: 'phần'});
  await o.call('savePromo', {id: 'p10', name: '10%', type: 'percent', value: 10, active: true});
  const food = {productId: snack.id, size: 'M', sugar: 0, ice: 'none', quantity: 1, toppings: [], note: ''};
  await o.call('createOrder', order({items: [drink({quantity: 1})], promoId: 'p10'}));                      // drink only: 25.000 - 10% = 22.500
  await o.call('createOrder', order({items: [drink({quantity: 1}), food], promoId: 'p10'}));                // 35.000 - 10% = 31.500 -> 22.500 drinks + 9.000 snack
  await o.call('createOrder', order({items: [food]}));                                                      // snack only: 10.000
  const rep = await o.call('report', {from: day, to: day});
  assert.equal(rep.total, 22500 + 31500 + 10000);
  assert.deepEqual([rep.groups.drink.total, rep.groups.food.total], [22500 + 22500, 9000 + 10000]);
  assert.equal(rep.groups.drink.total + rep.groups.food.total, rep.total);
  assert.deepEqual([rep.groups.drink.count, rep.groups.food.count, rep.groups.drink.cups], [2, 2, 2]);       // orders that contain each side; 2 cups
  assert.equal(rep.groupsComplete, true);
  assert.deepEqual(rep.topDrinks.map(t => t.name), ['Trà sữa truyền thống']);
  assert.deepEqual(rep.topFood.map(t => [t.name, t.quantity]), [['Cá xù', 2]]);
  // a refund takes its share back from the right side
  const snackOnly = (await o.call('snapshot', {})).orders.find(x => x.items.length === 1 && x.items[0].kind === 'food');
  await o.call('saveCancelReasons', {reasons: ['Khách đổi ý']});
  await o.call('updateOrder', {id: snackOnly.id, version: snackOnly.version, change: 'refund', reason: 'Khách đổi ý', mutationId: key()});
  const after = await o.call('report', {from: day, to: day});
  assert.deepEqual([after.groups.drink.total, after.groups.food.total], [45000, 9000]);
});

test('a cancelled or refunded order shows why, who did it and when, to staff as well', async () => {
  const o = await phone(OWNER, 'Chủ');
  await o.call('saveCancelReasons', {reasons: ['Khách đổi ý', 'Nhầm món']});
  await o.call('saveUser', {email: SALES, name: 'Minh', role: 'sales', active: true});
  const s = await phone(SALES, 'Minh');
  const a = await s.call('createOrder', order({paid: false}));
  await s.call('updateOrder', {id: a.id, version: 1, change: 'cancel', reason: 'Nhầm món', mutationId: key()});
  const b = await o.call('createOrder', order({}));
  await o.call('updateOrder', {id: b.id, version: 1, change: 'refund', reason: 'Khách đổi ý', mutationId: key()});
  const seen = await until(async () => { const r = (await s.call('snapshot', {})).orders; return r.filter(x => x.status === 'cancelled').length === 2 && r; });
  const byId = Object.fromEntries(seen.map(x => [x.id, x]));
  assert.deepEqual([byId[a.id].stop.kind, byId[a.id].stop.reason, byId[a.id].stop.by], ['cancel', 'Nhầm món', SALES]);
  assert.deepEqual([byId[b.id].stop.kind, byId[b.id].stop.reason, byId[b.id].stop.by], ['refund', 'Khách đổi ý', OWNER]);
  assert.ok(byId[a.id].stop.at);
  assert.equal(byId[a.id].audit, undefined);                       // staff still do not get the audit trail itself
});

test('people are shown by the name typed when they were added (not their e-mail): reports, cancel reasons, logs, schedule — also on staff phones', async () => {
  const o = await phone(OWNER, 'Chủ');
  await o.call('saveUser', {email: SALES, name: 'Cô Lan', role: 'sales', active: true});
  await o.call('saveCancelReasons', {reasons: ['Nhầm món']});
  const s = await phone(SALES, 'Cô Lan');
  const day = o.b.dayOf(new Date());
  const made = await s.call('createOrder', order({paid: false}));
  await s.call('updateOrder', {id: made.id, version: 1, change: 'cancel', reason: 'Nhầm món', mutationId: key()});
  await o.call('createOrder', order({}));                                                   // paid by the owner
  await o.call('openShift', {openingCash: 1000});
  await o.call('saveShift', {email: SALES, days: [day], start: '07:00', end: '11:00'});
  await o.call('clockIn', {});
  const staffSees = await until(async () => { const snap = await s.call('snapshot', {}); const x = snap.orders.find(y => y.id === made.id); return x && x.stop && snap.staffNames && x.stop.byName === 'Cô Lan' && snap; });
  assert.equal(staffSees.orders.find(y => y.id === made.id).stop.byName, 'Cô Lan');            // a staff phone cannot read users, yet sees the name
  assert.equal(Object.values(staffSees.staffNames).includes('Cô Lan'), true);
  const rep = await o.call('report', {from: day, to: day});
  assert.ok(rep.staff.every(x => !x.name.includes('@')), 'no e-mail in "by staff": ' + rep.staff.map(x => x.name));
  assert.ok(rep.staff.some(x => x.name === 'Chủ'));
  assert.deepEqual((await o.call('scheduleWeek', {from: day})).shifts.map(x => x.name), ['Cô Lan']);
  const snap = await o.call('snapshot', {});
  assert.equal(snap.shift.openedByName, 'Chủ');
  // a rename shows everywhere at once; a removed person keeps their name in old records
  await o.call('saveUser', {email: SALES, name: 'Cô Lan A', role: 'sales', active: true});
  assert.deepEqual((await o.call('scheduleWeek', {from: day})).shifts.map(x => x.name), ['Cô Lan A']);
  await o.call('deleteUser', {email: SALES});
  const after = await o.call('snapshot', {});
  assert.equal(after.orders.find(y => y.id === made.id).stop.byName, 'Cô Lan A');
});

test('clocking in and out tells the notification service (staff are alerted about new orders only while clocked in)', async () => {
  const o = await phone(OWNER, 'Chủ');
  await o.call('saveUser', {email: SALES, name: 'Minh', role: 'sales', active: true});
  const s = await phone(SALES, 'Minh');
  const events = [];
  s.b.onNotify(e => events.push(e));
  o.b.onNotify(e => events.push({...e, from: 'owner'}));
  assert.equal(s.b.clocked(), false);
  const inn = await s.call('clockIn', {});
  assert.equal(s.b.clocked(), true);
  await s.call('clockOut', {});
  assert.equal(s.b.clocked(), false);
  assert.deepEqual(events.filter(e => e.type === 'presence').map(e => e.clocked), [true, false]);
  // the owner clocking a forgotten colleague out names them
  const again = await s.call('clockIn', {});
  await until(async () => (await o.call('snapshot', {})).clockedIn.some(x => x.id === again.id));
  events.length = 0;
  await o.call('clockOut', {id: again.id});
  const e = events.find(x => x.type === 'presence' && x.from === 'owner');
  assert.deepEqual([e.clocked, e.email], [false, SALES]);
});

test('menu photos are kept on the phone and fetched again only when the photo revision changes', async () => {
  const mem = {saved: null, get: async () => mem.saved, set: async (rev, images) => { mem.saved = {rev, images}; }};
  const reads = {photos: 0};
  const fsCount = {...fs, getDocs: (...a) => { if (a[0] && a[0].path === 'menuImages') reads.photos++; return fs.getDocs(...a); }};
  const jpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const o = await phone(OWNER, 'Chủ');
  const id = (await o.call('snapshot', {})).menu[0].id;
  const saved = await o.call('saveMenuImage', {productId: id, image: jpeg});
  assert.ok(saved.hasImage);
  const snap = await o.call('snapshot', {});
  assert.ok(snap.imagesRev);
  // a phone that opens the app later with an empty store has to read the photos once and keeps them
  const first = createBackend({fs: fsCount, db: rawDb(OWNER), projectId: 'demo-tiemvio', seedMenu: TEST_MENU, imageStore: mem});
  open.push(first); await first.attach(OWNER, 'Chủ');
  await until(async () => Object.keys((await first.call('menuImages', {})).images).length === 1);
  assert.equal(reads.photos, 1); assert.equal(mem.saved.rev !== undefined, true);
  // the next opening finds the same revision on the phone: no photo reads at all
  reads.photos = 0;
  const again = createBackend({fs: fsCount, db: rawDb(OWNER), projectId: 'demo-tiemvio', seedMenu: TEST_MENU, imageStore: mem});
  open.push(again); await again.attach(OWNER, 'Chủ');
  await until(async () => Object.keys((await again.call('menuImages', {})).images).length === 1);
  assert.equal(reads.photos, 0);
  assert.equal((await again.call('menuImages', {})).images[id], jpeg);
  // a changed photo bumps the revision, so the other phone fetches again
  await o.call('saveMenuImage', {productId: id, image: jpeg + ''.padEnd(0)});
  const other = (await o.call('snapshot', {})).menu[1].id;
  await o.call('saveMenuImage', {productId: other, image: jpeg});
  await until(async () => Object.keys((await again.call('menuImages', {})).images).length === 2);
  assert.ok(reads.photos >= 1);
});

test('the owner can list the orders one person collected in a date range; refunded ones are shown but not counted; names, not e-mails', async () => {
  const o = await phone(OWNER, 'Chủ');
  await o.call('saveUser', {email: SALES, name: 'Cô Lan', role: 'sales', active: true});
  await o.call('saveCancelReasons', {reasons: ['Nhầm món']});
  const s = await phone(SALES, 'Cô Lan');
  const day = o.b.dayOf(new Date());
  const a = await s.call('createOrder', order({items: [drink({quantity: 2})]}));                  // 50.000 collected by Lan
  const b = await s.call('createOrder', order({}));                                               // 25.000, then refunded
  await o.call('createOrder', order({}));                                                         // collected by the owner
  await until(async () => (await o.call('snapshot', {})).orders.some(x => x.id === b.id));
  await o.call('updateOrder', {id: b.id, version: 1, change: 'refund', reason: 'Nhầm món', mutationId: key()});
  const r = await o.call('staffOrders', {email: SALES, from: day, to: day});
  assert.deepEqual([r.name, r.count, r.total, r.refunded], ['Cô Lan', 1, 50000, 1]);
  assert.equal(r.orders.length, 2);
  assert.deepEqual(r.orders.map(x => x.creatorName), ['Cô Lan', 'Cô Lan']);
  assert.ok(r.orders.find(x => x.id === a.id).items[0].quantity === 2);
  assert.equal(r.orders.find(x => x.id === b.id).stop.reason, 'Nhầm món');
  assert.deepEqual((await o.call('staffOrders', {email: OWNER, from: day, to: day})).count, 1);
  assert.equal((await o.call('staffOrders', {email: SALES, from: '2000-01-01', to: '2000-01-02'})).orders.length, 0);
  await assert.rejects(o.call('staffOrders', {email: SALES, from: '2020-01-01', to: '2021-01-01'}), /93 ngày/);
  await assert.rejects(s.call('staffOrders', {email: OWNER, from: day, to: day}), /quyền/);
  // every order in the lists carries who rang it up and who collected it
  const seen = (await o.call('snapshot', {})).orders.find(x => x.id === a.id);
  assert.deepEqual([seen.creatorName, seen.paidByName], ['Cô Lan', 'Cô Lan']);
});

test('clocking in works with no scheduled shift (swapped shifts, helping out): it is recorded and counted everywhere', async () => {
  const o = await phone(OWNER, 'Chủ');
  await o.call('saveUser', {email: SALES, name: 'Cô Lan', role: 'sales', active: true});
  const s = await phone(SALES, 'Cô Lan');
  const day = o.b.dayOf(new Date());
  assert.equal((await o.call('scheduleWeek', {from: day})).shifts.length, 0);                    // nobody is scheduled at all
  const inn = await s.call('clockIn', {});
  assert.equal(s.b.clocked(), true);
  await s.call('clockOut', {});
  // the owner covers a colleague's planned shift: a shift for Lan, but the owner is the one who works
  await o.call('saveShift', {email: SALES, days: [day], start: '07:00', end: '11:00'});
  await o.call('clockIn', {});
  const week = await until(async () => { const w = await o.call('scheduleWeek', {from: day}); return w.clock.length === 2 && w; });
  assert.deepEqual(week.clock.map(c => c.name).sort(), ['Chủ', 'Cô Lan']);
  assert.equal(week.shifts.length, 1);                                                            // only Lan was planned
  const rep = await o.call('report', {from: day, to: day});
  assert.deepEqual(rep.worked.map(w => w.name).sort(), ['Chủ', 'Cô Lan']);
  const pay = await createToolRunner((a, d) => o.b.call(a, d))('calculate_payroll', {hourlyRate: 25000, from: day, to: day});
  assert.equal(pay.rows.length, 2);
  assert.equal(inn.outAt, '');
});

/* ---------------- merge / split unpaid orders ---------------- */
test('merge: staff atomically combine unpaid orders without changing inventory, points or reports; retry is idempotent', async () => {
  const o=await phone(OWNER);await seedUser(SALES,'sales');
  await o.call('saveIngredient',{id:'tea',name:'Trà',unit:'g',minStock:1,stock:1000,cost:10,active:true});
  await o.call('saveRecipe',{productId:'milk',lines:[{ingredientId:'tea',qty:20}]});
  const s=await phone(SALES);
  const a=await s.call('createOrder',order({paid:false,items:[drink({quantity:2})]}));
  const b=await s.call('createOrder',order({paid:false,items:[drink()]}));
  await until(async()=>await stockOf(o,'tea')===940);
  const data={mode:'merge',sources:[{id:a.id,version:a.version},{id:b.id,version:b.version}],mutationId:key()};
  const r=await s.call('restructureOrders',data),m=r.orders[0];
  assert.equal(m.total,75000);assert.equal(m.items.length,2);assert.equal(m.origin.type,'merge');
  assert.equal((await s.call('restructureOrders',data)).orders[0].id,m.id);
  await until(async()=>!(await o.call('snapshot',{})).orders.some(x=>x.id===a.id||x.id===b.id));
  assert.equal(await stockOf(o,'tea'),940);
  assert.equal((await o.call('report',{from:today(o),to:today(o)})).total,0);
  const paid=await s.call('updateOrder',{id:m.id,version:1,change:'pay',paymentMethod:'cash',mutationId:key()});
  assert.equal(paid.paid,true);assert.equal((await o.call('report',{from:today(o),to:today(o)})).total,75000);
  await assert.rejects(s.call('updateOrder',{id:a.id,version:2,change:'pay',paymentMethod:'cash',mutationId:key()}),/gộp hoặc tách/);
  await assertFails(F.updateDoc(F.doc(rawDb(SALES),'orders',a.id),{status:'ready',unpaid:true,version:3,audit:[...a.audit,{action:'merge'},{action:'advance'}]}));
});

test('split: staff divide quantities while conserving discounts, redeemed points, cost and stock; cancellation restores only that part',async()=>{
  const o=await phone(OWNER);await seedUser(SALES,'sales');
  await o.call('saveIngredient',{id:'tea',name:'Trà',unit:'g',minStock:1,stock:1000,cost:10,active:true});
  await o.call('saveRecipe',{productId:'milk',lines:[{ingredientId:'tea',qty:20}]});
  await o.call('createOrder',order({phone:'0901234567',items:[drink({quantity:8})]}));
  await o.call('savePromo',{id:'ten',name:'10%',type:'percent',value:10,active:true});
  const s=await phone(SALES);
  const a=await s.call('createOrder',order({paid:false,phone:'0901234567',redeem:10,promoId:'ten',manualDiscount:1000,discountReason:'Khác: khách quen',items:[drink({quantity:3})]}));
  const before=await o.call('lookupCustomer',{phone:'0901234567'});
  const data={mode:'split',sources:[{id:a.id,version:1}],groups:[[{line:0,quantity:1}],[{line:0,quantity:1}],[{line:0,quantity:1}]],mutationId:key()};
  const parts=(await s.call('restructureOrders',data)).orders;
  assert.equal(parts.length,3);assert.equal(parts.reduce((n,x)=>n+x.total,0),a.total);
  assert.equal(parts.reduce((n,x)=>n+x.redeemed,0),10);assert.equal(parts.reduce((n,x)=>n+x.cogs,0),a.cogs);
  assert.equal(parts.reduce((n,x)=>n+x.audit[0].stockUsage.tea,0),60);
  assert.equal((await o.call('lookupCustomer',{phone:'0901234567'})).points,before.points);
  assert.deepEqual((await s.call('restructureOrders',data)).orders.map(x=>x.id),parts.map(x=>x.id));
  await s.call('updateOrder',{id:parts[0].id,version:1,change:'cancel',reason:'Khác: khách bỏ',mutationId:key()});
  await until(async()=>await stockOf(o,'tea')===800); // 1000 - 8*20 - 2*20
});

test('restructure refuses stale, paid, empty, duplicate, mismatched customer and incorrect quantity inputs',async()=>{
  const o=await phone(OWNER);
  const a=await o.call('createOrder',order({paid:false,items:[drink({quantity:2})]}));
  const paid=await o.call('createOrder',order());
  const other=await o.call('createOrder',order({paid:false,phone:'0901111111'}));
  const call=d=>o.call('restructureOrders',{mutationId:key(),...d});
  await assert.rejects(call({mode:'merge',sources:[{id:a.id,version:1},{id:paid.id,version:1}]}),/chưa thu tiền/);
  await assert.rejects(call({mode:'merge',sources:[{id:a.id,version:1},{id:a.id,version:1}]}),/Danh sách/);
  await assert.rejects(call({mode:'merge',sources:[{id:a.id,version:1},{id:other.id,version:1}]}),/số điện thoại/);
  for(const groups of [[[],[{line:0,quantity:2}]],[[{line:0,quantity:1}],[{line:0,quantity:2}]],[[{line:0,quantity:0.5}],[{line:0,quantity:1.5}]]]) await assert.rejects(call({mode:'split',sources:[{id:a.id,version:1}],groups}));
  await assert.rejects(call({mode:'split',sources:[{id:a.id,version:0}],groups:[[{line:0,quantity:1}],[{line:0,quantity:1}]]}),/thay đổi/);
  assert.equal((await o.call('snapshot',{})).orders.find(x=>x.id===a.id).status,'ready');
});

test('named maintainer can edit operational data, merge and split; other support accounts stay read-only; AI keys remain private',async()=>{
  const o=await phone(OWNER);await seedUser('support-editor@example.invalid','support');await seedUser('help@test.com','support');
  const h=await phone('support-editor@example.invalid'),read=await phone('help@test.com');
  assert.equal((await h.call('snapshot',{})).user.canEdit,true);
  assert.equal((await read.call('snapshot',{})).user.canEdit,false);
  await h.call('saveMenu',{id:'milk',name:'Trà sữa',category:'Trà sữa',kind:'drink',sizes:{M:25000},active:true});
  const a=await h.call('createOrder',order({paid:false,items:[drink({quantity:2})]}));
  const parts=(await h.call('restructureOrders',{mode:'split',sources:[{id:a.id,version:1}],groups:[[{line:0,quantity:1}],[{line:0,quantity:1}]],mutationId:key()})).orders;
  assert.equal(parts.length,2);
  await h.call('restructureOrders',{mode:'merge',sources:parts.map(x=>({id:x.id,version:x.version})),mutationId:key()});
  assert.ok(await h.call('getAiConfig',{}));
  await assert.rejects(h.call('saveAiConfig',{provider:'anthropic',keys:{},models:{}}));
  await assert.rejects(h.call('saveUser',{email:'x@test.com',role:'owner',active:true}));
  await assertSucceeds(F.getDoc(F.doc(rawDb('support-editor@example.invalid'),'aiConfig','shared')));
  await assertFails(F.setDoc(F.doc(rawDb('support-editor@example.invalid'),'users','x@test.com'),{role:'owner',active:true}));
  await assert.rejects(read.call('createOrder',order()));
});

test('two cashiers cannot merge the same source orders twice',async()=>{
 const o=await phone(OWNER);await seedUser(SALES,'sales');const s=await phone(SALES);
 const a=await o.call('createOrder',order({paid:false})),b=await o.call('createOrder',order({paid:false}));
 const input={mode:'merge',sources:[{id:a.id,version:1},{id:b.id,version:1}]};
 const outcomes=await Promise.allSettled([o.call('restructureOrders',{...input,mutationId:key()}),s.call('restructureOrders',{...input,mutationId:key()})]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
 const orders=(await o.call('exportAll',{})).collections.orders;
 assert.equal(orders.filter(x=>!x.restructured).length,1);
 assert.equal(orders.filter(x=>x.restructured).length,2);
});

test('edit history exposes editor name, time and summary to staff without exposing the audit trail',async()=>{
 const o=await phone(OWNER,'Chủ');await o.call('saveUser',{email:SALES,name:'Lan',role:'sales',active:true});const s=await phone(SALES,'Lan');
 const a=await o.call('createOrder',order({paid:false}));
 const one=await s.call('editOrder',{id:a.id,version:1,mutationId:key(),service:'takeaway',items:[drink({quantity:2})]});
 const two=await o.call('editOrder',{id:a.id,version:2,mutationId:key(),service:'takeaway',items:[drink({quantity:3})]});
 assert.equal(one.editHistory.length,1);assert.equal(two.editHistory.length,2);
 const view=await until(async()=>{const x=(await s.call('snapshot',{})).orders.find(x=>x.id===a.id);return x?.editHistory.length===2&&x});
 assert.equal(view.audit,undefined);assert.deepEqual(view.editHistory.map(h=>h.name),['Lan','Chủ']);
 assert.deepEqual(view.editHistory.map(h=>h.by),[SALES,OWNER]);assert.ok(view.editHistory.every(h=>h.at&&h.detail.includes('Sửa đơn')));
});

test('maximum eight-way split and eight-order merge succeed under the real rules',async()=>{
 const o=await phone(OWNER);await seedUser(SALES,'sales');const s=await phone(SALES);
 const a=await s.call('createOrder',order({paid:false,items:[drink({quantity:8})]}));
 const parts=(await s.call('restructureOrders',{mode:'split',sources:[{id:a.id,version:1}],groups:Array.from({length:8},()=>[{line:0,quantity:1}]),mutationId:key()})).orders;
 assert.equal(parts.length,8);
 const merged=(await s.call('restructureOrders',{mode:'merge',sources:parts.map(x=>({id:x.id,version:x.version})),mutationId:key()})).orders[0];
 assert.equal(merged.total,a.total);assert.equal(merged.items.length,8);
});

test('bulk reconciliation handles more than 100 selected transfers, keeps other orders and totals unchanged, rejects sales, reports stale orders and supports retries',async()=>{
 const o=await phone(OWNER);await seedUser(SALES,'sales');
 const seed=await o.call('createOrder',order({paymentMethod:'transfer'}));
 const cash=await o.call('createOrder',order({paymentMethod:'cash'}));
 const untouched=await o.call('createOrder',order({paymentMethod:'transfer'}));
 await env.withSecurityRulesDisabled(async ctx=>{const db=ctx.firestore();const batch=F.writeBatch(db);for(let i=0;i<100;i++){const id='bulk-'+i;batch.set(F.doc(db,'orders',id),{...seed,id,createdDay:today(o),paidDay:today(o),unreconciled:true,unpaid:false,requestKey:key()});}await batch.commit();});
 const before=await o.call('report',{from:today(o),to:today(o)});assert.equal(before.unreconciled.length,102);
 const selected=before.unreconciled.filter(x=>x.id!==untouched.id).map(x=>({id:x.id,version:x.version}));
 const data={orders:[...selected,{id:cash.id,version:999}],mutationId:key()};
 const s=await phone(SALES);await assert.rejects(s.call('reconcileAll',data),/quyền/);
 const result=await o.call('reconcileAll',data);assert.equal(result.reconciled,101);assert.equal(result.failed.length,1);assert.equal(result.failed[0].id,cash.id);
 const retry=await o.call('reconcileAll',data);assert.equal(retry.reconciled,101);
 const after=await o.call('report',{from:today(o),to:today(o)});assert.equal(after.total,before.total);assert.equal(after.transfer,before.transfer);assert.deepEqual(after.unreconciled.map(x=>x.id),[untouched.id]);
 const raw=await F.getDoc(F.doc(rawDb(OWNER),'orders',seed.id));assert.equal(raw.data().audit.at(-1).by,OWNER);assert.equal(raw.data().audit.at(-1).detail,'Đối soát toàn bộ');
});

/* Shared seven-day AI history. No live provider is called by these tests. */
test('owners and the named support account share AI threads and append concurrent turns without overwriting; staff and other support cannot access them',async()=>{
 const o=await phone(OWNER);await o.call('saveUser',{email:'owner2@test.com',name:'Chủ 2',role:'owner',active:true});await seedUser(SALES,'sales');await seedUser('support-editor@example.invalid','support');await seedUser('help@test.com','support');
 await o.call('saveAiConfig',{provider:'openrouter',keys:{openrouter:'sk-or-shared'},models:{}});
 const h=await phone('support-editor@example.invalid'),other=await phone('owner2@test.com'),sales=await phone(SALES),read=await phone('help@test.com');
 assert.equal((await h.call('getAiConfig',{})).keys.openrouter,'sk-or-shared');await assert.rejects(h.call('saveAiConfig',{provider:'openrouter',keys:{},models:{}}));
 const id=key();await h.call('createAiChat',{id,title:'Doanh thu tuần này'});
 const turn=(text)=>({chatId:id,id:key(),messages:[{role:'user',content:text},{role:'assistant',content:[{type:'text',text:'Trả lời'}]}],log:[{type:'user',text},{type:'text',text:'Trả lời'}]});
 const a=turn('A'),b=turn('B');assert.equal(other.r.ok,true);await assertSucceeds(F.getDoc(F.doc(rawDb('owner2@test.com'),'aiChats',id)));await assertSucceeds(F.getDoc(F.doc(rawDb('owner2@test.com'),'aiChats',id,'turns',b.id)));await Promise.all([o.call('saveAiTurn',a),other.call('saveAiTurn',b)]);await o.call('saveAiTurn',a);
 const loaded=await h.call('loadAiChat',{id});assert.equal(loaded.turns.length,2);assert.deepEqual(loaded.turns.map(x=>x.messages[0].content).sort(),['A','B']);assert.equal(loaded.expiresAt-loaded.createdAt,7*86400000);
 assert.ok((await other.call('listAiChats')).chats.some(x=>x.id===id));
 for(const user of [sales,read]){await assert.rejects(user.call('loadAiChat',{id}));await assert.rejects(user.call('listAiChats'));await assert.rejects(user.call('saveAiTurn',turn('denied')));}
 await assertFails(F.getDoc(F.doc(rawDb(SALES),'aiChats',id)));await assertFails(F.getDocs(F.collection(rawDb(SALES),'aiChats',id,'turns')));
 const db=rawDb(OWNER);await assertFails(F.updateDoc(F.doc(db,'aiChats',id),{expiresAt:Date.now()+100*86400000}));await assertFails(F.updateDoc(F.doc(db,'aiChats',id,'turns',a.id),{log:'[]'}));
});
test('AI bodies are inaccessible at seven days and expired threads including all turn documents are removed on history access',async()=>{
 const o=await phone(OWNER),id=key(),turn=key(),now=Date.now();
 await env.withSecurityRulesDisabled(async ctx=>{const db=ctx.firestore();await F.setDoc(F.doc(db,'aiChats',id),{title:'expired',createdAt:now-8*86400000,expiresAt:now-86400000,createdBy:OWNER,createdByName:'Chủ',updatedAt:now-86400000,turnIds:[turn]});await F.setDoc(F.doc(db,'aiChats',id,'turns',turn),{createdAt:now-8*86400000,by:OWNER,name:'Chủ',log:'[]',messages:'[]'});});
 await assertFails(F.getDoc(F.doc(rawDb(OWNER),'aiChats',id,'turns',turn)));await assert.rejects(o.call('loadAiChat',{id}),/hết hạn/);
 assert.equal((await o.call('listAiChats')).chats.length,0);
 await env.withSecurityRulesDisabled(async ctx=>{assert.equal((await F.getDoc(F.doc(ctx.firestore(),'aiChats',id))).exists(),false);assert.equal((await F.getDoc(F.doc(ctx.firestore(),'aiChats',id,'turns',turn))).exists(),false);});
});
