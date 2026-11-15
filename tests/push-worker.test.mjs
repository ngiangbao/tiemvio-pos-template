// Tests the push service with real WebCrypto: token checks, roles, who gets which message, and that the encrypted
// message really decrypts with a phone's keys (RFC 8291). No emulator or network needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {handle, verifyIdToken} from '../push-worker/src/index.js';

const enc = new TextEncoder(), dec = new TextDecoder();
const b64u = b => Buffer.from(b).toString('base64url');
const unb64u = s => new Uint8Array(Buffer.from(s, 'base64url'));
const PROJECT = 'tiemvio-test';
const ORIGIN = 'https://APP_HOST.invalid';

/* ---- fake Firebase ID tokens ---- */
const rsa = await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify']);
const jwk = {...(await crypto.subtle.exportKey('jwk', rsa.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig'};
async function idToken(email, over = {}, signWith = rsa.privateKey) {
  const t = Math.floor(Date.now() / 1000);
  const header = b64u(enc.encode(JSON.stringify({alg: 'RS256', kid: 'k1', typ: 'JWT'})));
  const claims = b64u(enc.encode(JSON.stringify({iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, sub: 'uid-' + email, iat: t, exp: t + 3600, email, email_verified: true, ...over})));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signWith, enc.encode(header + '.' + claims));
  return header + '.' + claims + '.' + b64u(sig);
}

/* ---- fake world: users in Firestore, push services, KV ---- */
const users = {'owner@t.com': {role: 'owner', active: true}, 'sales@t.com': {role: 'sales', active: true}, 'sales2@t.com': {role: 'sales', active: true}, 'locked@t.com': {role: 'sales', active: false}};
const pushed = [];                      // every message that reached a "push service"
let goneEndpoint = null;                // this endpoint answers 410
function world() {
  return async (url, init = {}) => {
    url = String(url);
    if (url.includes('securetoken@system.gserviceaccount.com')) return new Response(JSON.stringify({keys: [jwk]}), {status: 200});
    if (url.startsWith('https://firestore.googleapis.com/')) {
      const email = decodeURIComponent(url.split('/users/')[1]);
      const u = users[email]; const token = (init.headers || {}).authorization;
      if (!u || !token) return new Response('{}', {status: 403});
      return new Response(JSON.stringify({fields: {role: {stringValue: u.role}, active: {booleanValue: u.active}}}), {status: 200});
    }
    pushed.push({url, headers: init.headers, body: init.body});
    return new Response(null, {status: url === goneEndpoint ? 410 : 201});
  };
}
class KV {
  constructor() { this.m = new Map(); }
  async get(k, type) { const v = this.m.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; }
  async put(k, v) { this.m.set(k, String(v)); }
  async delete(k) { this.m.delete(k); }
  async list({prefix = ''} = {}) { return {keys: [...this.m.keys()].filter(k => k.startsWith(prefix)).map(name => ({name})), list_complete: true}; }
}
const vapidPair = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
const vj = await crypto.subtle.exportKey('jwk', vapidPair.privateKey);
const VAPID_PUBLIC = b64u(Buffer.concat([Buffer.from([4]), unb64u(vj.x), unb64u(vj.y)]));
const newEnv = () => ({SUBS: new KV(), FIREBASE_PROJECT_ID: PROJECT, ALLOWED_ORIGINS: ORIGIN + ',http://localhost:5173', VAPID_SUBJECT: 'mailto:owner@t.com', VAPID_PUBLIC_KEY: VAPID_PUBLIC, VAPID_PRIVATE_KEY: vj.d});

/* ---- a fake phone: keys it would give to PushManager.subscribe ---- */
async function phone(n) {
  const ecdh = await crypto.subtle.generateKey({name: 'ECDH', namedCurve: 'P-256'}, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', ecdh.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {endpoint: 'https://push.example/device/' + n, ecdh, raw, auth, keys: {p256dh: b64u(raw), auth: b64u(auth)}};
}
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name: 'HKDF', hash: 'SHA-256', salt, info}, k, len * 8));
}
/** RFC 8291 aes128gcm decryption, the way a browser does it. */
async function decrypt(ph, body) {
  body = new Uint8Array(body);
  const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), cipher = body.slice(21 + idlen);
  const peer = await crypto.subtle.importKey('raw', asPub, {name: 'ECDH', namedCurve: 'P-256'}, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({name: 'ECDH', public: peer}, ph.ecdh.privateKey, 256));
  const ikm = await hkdf(ph.auth, secret, Buffer.concat([enc.encode('WebPush: info\0'), ph.raw, asPub]), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({name: 'AES-GCM', iv: nonce}, key, cipher));
  let end = plain.length; while (end > 0 && plain[end - 1] === 0) end--;   // padding
  assert.equal(plain[end - 1], 2, 'last record delimiter');
  return JSON.parse(dec.decode(plain.slice(0, end - 1)));
}

async function call(env, path, email, body, {origin = ORIGIN, token, method = 'POST'} = {}) {
  const t = token === undefined ? await idToken(email) : token;
  const req = new Request('https://push.example.workers.dev' + path, {method, headers: {origin, 'content-type': 'application/json', ...(t ? {authorization: 'Bearer ' + t} : {})}, body: method === 'POST' ? JSON.stringify(body || {}) : undefined});
  const res = await handle(req, env, {fetch: world()});
  return {status: res.status, body: await res.json().catch(() => null)};
}
const subscribe = (env, email, ph) => call(env, '/subscribe', email, {subscription: {endpoint: ph.endpoint, keys: ph.keys}});

test('token checks: bad signature, wrong project, expired, unverified e-mail and missing token are all refused', async () => {
  const env = newEnv(); const ph = await phone('a');
  const other = await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify']);
  for (const [label, token] of [['forged signature', await idToken('owner@t.com', {}, other.privateKey)], ['other project', await idToken('owner@t.com', {aud: 'other', iss: 'https://securetoken.google.com/other'})],
    ['expired', await idToken('owner@t.com', {exp: Math.floor(Date.now() / 1000) - 10})], ['unverified', await idToken('owner@t.com', {email_verified: false})], ['no token', ''], ['garbage', 'a.b.c']]) {
    const r = await call(env, '/subscribe', 'owner@t.com', {subscription: {endpoint: ph.endpoint, keys: ph.keys}}, {token});
    assert.equal(r.status, 401, label);
  }
  assert.equal((await env.SUBS.list({prefix: 'sub:'})).keys.length, 0);
});

test('only active staff can subscribe; strangers, locked accounts and foreign origins are refused', async () => {
  const env = newEnv(); const ph = await phone('b');
  assert.equal((await subscribe(env, 'stranger@t.com', ph)).status, 403);
  assert.equal((await subscribe(env, 'locked@t.com', ph)).status, 403);
  const foreign = await call(env, '/subscribe', 'owner@t.com', {subscription: {endpoint: ph.endpoint, keys: ph.keys}}, {origin: 'https://evil.example'});
  assert.equal(foreign.status, 403);
  assert.equal((await subscribe(env, 'sales@t.com', ph)).status, 200);
  const bad = await call(env, '/subscribe', 'sales@t.com', {subscription: {endpoint: 'http://insecure.example/x', keys: ph.keys}});
  assert.equal(bad.status, 400);
  assert.equal((await call(env, '/health', 'x', null, {method: 'GET'})).status, 200);
});

test('a new order reaches the owner and the other staff phones, not the phone that made it, and the message decrypts', async () => {
  const env = newEnv(); pushed.length = 0;
  const [own, mine, other, lock] = [await phone('own'), await phone('mine'), await phone('other'), await phone('lockowner')];
  await subscribe(env, 'owner@t.com', own); await subscribe(env, 'sales@t.com', mine); await subscribe(env, 'sales2@t.com', other);
  const r = await call(env, '/notify', 'sales@t.com', {type: 'order', title: 'Đơn mới #7', body: '3 món · 75.000đ · Bàn 5', tag: 'order-7', url: '/?view=orders', exclude: mine.endpoint});
  assert.deepEqual([r.status, r.body.sent, r.body.failed], [200, 2, 0]);
  const urls = pushed.map(p => p.url).sort();
  assert.deepEqual(urls, [own.endpoint, other.endpoint].sort());
  const toOwner = pushed.find(p => p.url === own.endpoint);
  assert.match(toOwner.headers.authorization, /^vapid t=.+, k=/);
  assert.deepEqual(await decrypt(own, toOwner.body), {title: 'Đơn mới #7', body: '3 món · 75.000đ · Bàn 5', tag: 'order-7', url: '/?view=orders'});
});

test('cancel and low-stock messages go to the owner only; "test" goes to the caller\'s own phones', async () => {
  const env = newEnv(); pushed.length = 0;
  const [own, st, st2] = [await phone('o'), await phone('s'), await phone('s2')];
  await subscribe(env, 'owner@t.com', own); await subscribe(env, 'sales@t.com', st); await subscribe(env, 'sales2@t.com', st2);
  for (const type of ['cancel', 'lowstock']) {
    pushed.length = 0;
    const r = await call(env, '/notify', 'sales@t.com', {type, title: 'x', body: 'y'});
    assert.equal(r.body.sent, 1, type);
    assert.deepEqual(pushed.map(p => p.url), [own.endpoint], type);
  }
  pushed.length = 0;
  const t = await call(env, '/notify', 'sales@t.com', {type: 'test', title: 'Thử', body: 'Thông báo thử'});
  assert.deepEqual([t.body.sent, pushed.map(p => p.url)], [1, [st.endpoint]]);
  assert.equal((await call(env, '/notify', 'sales@t.com', {type: 'broadcast', title: 'x'})).status, 400);
});

test('text is clipped and cleaned; unsubscribing and dead endpoints (410) remove a phone', async () => {
  const env = newEnv(); pushed.length = 0;
  const [a, b] = [await phone('a1'), await phone('b1')];
  await subscribe(env, 'owner@t.com', a); await subscribe(env, 'sales@t.com', b);
  await call(env, '/notify', 'sales@t.com', {type: 'order', title: 'T'.repeat(500), body: 'line1\nline2' + 'x'.repeat(500), url: 'javascript:alert(1)'});
  const msg = await decrypt(a, pushed[0].body);
  assert.equal(msg.title.length, 80); assert.equal(msg.body.length, 160); assert.ok(!msg.body.includes('\n')); assert.equal(msg.url, '/');
  // someone else cannot remove my phone; I can
  await call(env, '/unsubscribe', 'sales@t.com', {endpoint: a.endpoint});
  assert.equal((await env.SUBS.list({prefix: 'sub:'})).keys.length, 2);
  await call(env, '/unsubscribe', 'owner@t.com', {endpoint: a.endpoint});
  assert.equal((await env.SUBS.list({prefix: 'sub:'})).keys.length, 1);
  goneEndpoint = b.endpoint;
  const r = await call(env, '/notify', 'owner@t.com', {type: 'test', title: 'x'});   // owner has no phone left
  assert.equal(r.body.sent, 0);
  await subscribe(env, 'owner@t.com', a);
  const r2 = await call(env, '/notify', 'owner@t.com', {type: 'order', title: 'x', body: 'y'});
  assert.deepEqual([r2.body.sent, r2.body.removed], [1, 1]);   // the owner's phone got it; the dead sales phone was dropped
  goneEndpoint = null;
  assert.equal((await env.SUBS.list({prefix: 'sub:'})).keys.length, 1);
});

test('one account cannot flood: more than 200 notifications an hour are refused', async () => {
  const env = newEnv(); const a = await phone('flood');
  await subscribe(env, 'owner@t.com', a);
  let last;
  for (let i = 0; i < 201; i++) last = await call(env, '/notify', 'sales@t.com', {type: 'order', title: 'x', body: 'y'});
  assert.equal(last.status, 429);
});

test('verifyIdToken caches the signing keys instead of fetching them for every request', async () => {
  let fetches = 0; const f = async (u, i) => { if (String(u).includes('securetoken')) fetches++; return world()(u, i); };
  const cache = {keys: null, expires: 0};
  const t = await idToken('owner@t.com');
  await verifyIdToken(t, {projectId: PROJECT, fetchImpl: f, jwksCache: cache}); await verifyIdToken(t, {projectId: PROJECT, fetchImpl: f, jwksCache: cache});
  assert.equal(fetches, 1);
});

test('only the owner can revoke a removed account\'s phones', async () => {
  const env = newEnv(); pushed.length = 0;
  const [a, b] = [await phone('a2'), await phone('b2')];
  await subscribe(env, 'owner@t.com', a); await subscribe(env, 'sales@t.com', b);
  assert.equal((await call(env, '/revoke', 'sales@t.com', {email: 'owner@t.com'})).status, 403);
  assert.equal((await call(env, '/revoke', 'owner@t.com', {email: 'owner@t.com'})).status, 400);
  const r = await call(env, '/revoke', 'owner@t.com', {email: 'Sales@t.com'});
  assert.deepEqual([r.status, r.body.removed], [200, 1]);
  const n = await call(env, '/notify', 'owner@t.com', {type: 'cancel', title: 'x', body: 'y'});
  assert.equal((await env.SUBS.list({prefix: 'sub:'})).keys.length, 1);
  assert.equal(n.status, 200);
});

test('new-order alerts go to the owner always and to staff only while clocked in; owner-only alerts ignore the clock', async () => {
  const env = newEnv(); pushed.length = 0;
  const [own, st, st2] = [await phone('o3'), await phone('s3'), await phone('s4')];
  await subscribe(env, 'owner@t.com', own); await subscribe(env, 'sales@t.com', st);
  await call(env, '/subscribe', 'sales@t.com', {subscription: {endpoint: st2.endpoint, keys: st2.keys}, clocked: false});     // a second staff phone that says "not clocked in"
  const send = async (who, type) => { pushed.length = 0; const r = await call(env, '/notify', who, {type, title: 'x', body: 'y'}); return {sent: r.body.sent, to: pushed.map(p => p.url).sort()}; };
  // phones that never said anything count as clocked in; the one that said false is skipped
  let r = await send('sales@t.com', 'order');
  assert.deepEqual(r.to, [own.endpoint, st.endpoint].sort());
  // the staff member clocks out: their phone is skipped for orders, the owner still gets them
  assert.equal((await call(env, '/presence', 'sales@t.com', {clocked: false})).body.updated, 2);
  r = await send('owner@t.com', 'order');
  assert.deepEqual(r.to, [own.endpoint]);
  // owner-only alerts do not depend on the clock
  assert.deepEqual((await send('sales@t.com', 'cancel')).to, [own.endpoint]);
  assert.deepEqual((await send('sales@t.com', 'lowstock')).to, [own.endpoint]);
  // clock in again: orders reach them
  await call(env, '/presence', 'sales@t.com', {clocked: true});
  assert.deepEqual((await send('owner@t.com', 'order')).to, [own.endpoint, st.endpoint, st2.endpoint].sort());
  // the owner can set someone else's state (forgotten clock-out), a staff member cannot
  assert.equal((await call(env, '/presence', 'owner@t.com', {email: 'sales@t.com', clocked: false})).status, 200);
  assert.equal((await call(env, '/presence', 'sales@t.com', {email: 'owner@t.com', clocked: false})).status, 403);
  assert.deepEqual((await send('owner@t.com', 'order')).to, [own.endpoint]);
});
