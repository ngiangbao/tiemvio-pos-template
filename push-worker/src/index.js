/* Tiemvio POS push service – runs free on Cloudflare Workers.
 *
 * The POS phones cannot receive anything while iOS has suspended the app (screen locked), so a tiny always-on
 * service sends Web Push messages. It never trusts a caller: every request carries the caller's Firebase ID token,
 * which is verified here, and the caller's role is read from Firestore with that same token (so the Firestore
 * security rules decide who counts as staff). Message text is plain text only and length limited.
 *
 *   POST /subscribe    {subscription}                 remember this phone for the signed-in staff member
 *   POST /unsubscribe  {endpoint}                     forget it
 *   POST /presence     {clocked, email?}              the owner of a phone clocked in or out (the owner may set it for someone else)
 *   POST /notify       {type, title, body, tag, url, exclude}
 *        type "order"    -> the owner's phones and the phones of staff who are clocked in      type "cancel", "lowstock" -> the owner's phones
 *        type "test"     -> the caller's own phones
 *   GET  /health
 */
import {buildPushPayload} from '@block65/webcrypto-web-push';

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const TYPES = {order: ['owner', 'sales'], cancel: ['owner'], lowstock: ['owner'], test: null};
const MAX_PER_HOUR = 200;       // notifications one account may trigger per hour
const MAX_RECIPIENTS = 40;

const enc = new TextEncoder();
const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(s).length / 4) * 4, '=')), c => c.charCodeAt(0));
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Verifies a Firebase Auth ID token (RS256) and returns its claims. */
export async function verifyIdToken(token, {projectId, fetchImpl = fetch, now = () => Date.now(), jwksCache = verifyIdToken.cache}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Thiếu hoặc sai mã đăng nhập.');
  let header, claims;
  try { header = JSON.parse(new TextDecoder().decode(unb64u(parts[0]))); claims = JSON.parse(new TextDecoder().decode(unb64u(parts[1]))); }
  catch (_) { throw new HttpError(401, 'Mã đăng nhập không đọc được.'); }
  if (header.alg !== 'RS256' || !header.kid) throw new HttpError(401, 'Mã đăng nhập không hợp lệ.');
  let keys = jwksCache.keys;
  if (!keys || jwksCache.expires < now() || !keys.some(k => k.kid === header.kid)) {
    const res = await fetchImpl(JWKS_URL);
    if (!res.ok) throw new HttpError(503, 'Không lấy được khóa xác thực.');
    keys = (await res.json()).keys || [];
    jwksCache.keys = keys; jwksCache.expires = now() + 60 * 60 * 1000;
  }
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new HttpError(401, 'Mã đăng nhập không hợp lệ.');
  const key = await crypto.subtle.importKey('jwk', jwk, {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64u(parts[2]), enc.encode(parts[0] + '.' + parts[1]));
  if (!ok) throw new HttpError(401, 'Mã đăng nhập không hợp lệ.');
  const t = Math.floor(now() / 1000);
  if (claims.aud !== projectId || claims.iss !== 'https://securetoken.google.com/' + projectId) throw new HttpError(401, 'Mã đăng nhập thuộc dự án khác.');
  if (!claims.exp || claims.exp < t || (claims.iat && claims.iat > t + 300)) throw new HttpError(401, 'Mã đăng nhập đã hết hạn. Hãy mở lại ứng dụng.');
  if (!claims.sub || claims.email_verified !== true || !claims.email) throw new HttpError(401, 'Tài khoản Google chưa được xác minh.');
  return {...claims, email: String(claims.email).toLowerCase()};
}
verifyIdToken.cache = {keys: null, expires: 0};

/** Reads users/{email} with the caller's own token: Firestore rules allow it only for signed-in staff themselves. */
export async function staffRole(email, token, {projectId, fetchImpl = fetch}) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${encodeURIComponent(email)}`;
  const res = await fetchImpl(url, {headers: {authorization: 'Bearer ' + token}});
  if (!res.ok) throw new HttpError(403, 'Tài khoản chưa được chủ quán cấp quyền.');
  const f = (await res.json()).fields || {};
  const role = f.role && f.role.stringValue;
  if (!(f.active && f.active.booleanValue === true) || !['owner', 'sales'].includes(role)) throw new HttpError(403, 'Tài khoản chưa được chủ quán cấp quyền hoặc đã bị khóa.');
  return role;
}

async function hashEndpoint(endpoint) { return b64u(await crypto.subtle.digest('SHA-256', enc.encode(endpoint))).slice(0, 32); }

function validSubscription(s) {
  try {
    const u = new URL(s.endpoint);
    return u.protocol === 'https:' && s.endpoint.length < 600 && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string'
      && unb64u(s.keys.p256dh).length === 65 && unb64u(s.keys.auth).length >= 16 && s.keys.p256dh.length < 200 && s.keys.auth.length < 100;
  } catch (_) { return false; }
}

function cors(env, request) {
  const origin = request.headers.get('origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin);
  return {ok, headers: {'access-control-allow-origin': ok ? origin : allowed[0] || 'null', 'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-max-age': '86400', vary: 'origin'}};
}
const json = (status, body, headers) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json; charset=utf-8', ...headers}});

async function listSubs(env) {
  const out = []; let cursor;
  do {
    const page = await env.SUBS.list({prefix: 'sub:', cursor});
    for (const k of page.keys) { const v = await env.SUBS.get(k.name, 'json'); if (v) out.push({key: k.name, ...v}); }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

async function rateLimit(env, email, now) {
  const key = 'rl:' + email + ':' + Math.floor(now() / 3600000);
  const n = Number(await env.SUBS.get(key)) || 0;
  if (n >= MAX_PER_HOUR) throw new HttpError(429, 'Gửi thông báo quá nhiều trong một giờ.');
  await env.SUBS.put(key, String(n + 1), {expirationTtl: 7200});
}

export async function handle(request, env, deps = {}) {
  const fetchImpl = deps.fetch || fetch, now = deps.now || (() => Date.now());
  const c = cors(env, request);
  if (request.method === 'OPTIONS') return new Response(null, {status: c.ok ? 204 : 403, headers: c.headers});
  const url = new URL(request.url);
  try {
    if (url.pathname === '/health') return json(200, {ok: true}, c.headers);
    if (request.method !== 'POST') throw new HttpError(405, 'Phương thức không hợp lệ.');
    if (!c.ok) throw new HttpError(403, 'Nguồn truy cập không được phép.');
    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const projectId = env.FIREBASE_PROJECT_ID;
    const claims = await verifyIdToken(token, {projectId, fetchImpl, now});
    const role = await staffRole(claims.email, token, {projectId, fetchImpl});
    let body; try { body = await request.json(); } catch (_) { throw new HttpError(400, 'Dữ liệu gửi lên không hợp lệ.'); }

    if (url.pathname === '/subscribe') {
      const sub = body.subscription;
      if (!validSubscription(sub || {})) throw new HttpError(400, 'Thông tin đăng ký thông báo không hợp lệ.');
      const id = await hashEndpoint(sub.endpoint);
      // `clocked` is what the phone says about its owner (new-order alerts go to staff who are clocked in); unknown counts as clocked in
      await env.SUBS.put('sub:' + id, JSON.stringify({endpoint: sub.endpoint, keys: {p256dh: sub.keys.p256dh, auth: sub.keys.auth}, email: claims.email, role, clocked: body.clocked !== false, at: now()}));
      return json(200, {ok: true, id, role}, c.headers);
    }
    if (url.pathname === '/unsubscribe') {
      const endpoint = String(body.endpoint || '');
      const id = await hashEndpoint(endpoint);
      const cur = await env.SUBS.get('sub:' + id, 'json');
      if (cur && cur.email === claims.email) await env.SUBS.delete('sub:' + id);
      return json(200, {ok: true}, c.headers);
    }
    if (url.pathname === '/presence') {
      // A person clocked in or out: their phones start or stop receiving new-order alerts. Only the owner may change someone else's.
      const target = body.email ? String(body.email).toLowerCase() : claims.email;
      if (target !== claims.email && role !== 'owner') throw new HttpError(403, 'Chỉ chủ quán được đổi trạng thái chấm công của người khác.');
      const clocked = body.clocked !== false;
      const mine = (await listSubs(env)).filter(x => x.email === target);
      await Promise.all(mine.map(x => { const {key, ...rest} = x; return env.SUBS.put(key, JSON.stringify({...rest, clocked})); }));
      return json(200, {ok: true, updated: mine.length}, c.headers);
    }
    if (url.pathname === '/revoke') {
      // The owner removes or locks someone: drop every phone registered to that account.
      if (role !== 'owner') throw new HttpError(403, 'Chỉ chủ quán được thu hồi thông báo.');
      const email = String(body.email || '').toLowerCase();
      if (!email || email === claims.email) throw new HttpError(400, 'Địa chỉ email không hợp lệ.');
      const doomed = (await listSubs(env)).filter(x => x.email === email);
      await Promise.all(doomed.map(x => env.SUBS.delete(x.key)));
      return json(200, {ok: true, removed: doomed.length}, c.headers);
    }
    if (url.pathname === '/notify') {
      const type = String(body.type || '');
      if (!(type in TYPES)) throw new HttpError(400, 'Loại thông báo không hợp lệ.');
      await rateLimit(env, claims.email, now);
      const message = {title: clip(body.title, 80) || 'Tiemvio POS', body: clip(body.body, 160), tag: clip(body.tag, 60) || type, url: /^\/[\w\-/?=&#.]*$/.test(String(body.url || '')) ? String(body.url) : '/'};
      const excludeId = body.exclude ? await hashEndpoint(String(body.exclude)) : '';
      const subs = (await listSubs(env)).filter(s => {
        if (type === 'test') return s.email === claims.email;
        if (!TYPES[type].includes(s.role) || s.key === 'sub:' + excludeId) return false;
        // new-order alerts: the owner always, staff only while clocked in (a phone that never reported counts as clocked in)
        return !(type === 'order' && s.role !== 'owner' && s.clocked === false);
      }).slice(0, MAX_RECIPIENTS);
      const vapid = {subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY};
      let sent = 0, removed = 0, failed = 0;
      await Promise.all(subs.map(async s => {
        try {
          const payload = await buildPushPayload({data: JSON.stringify(message), options: {ttl: 600, urgency: 'high'}}, {endpoint: s.endpoint, expirationTime: null, keys: s.keys}, vapid);
          const res = await fetchImpl(s.endpoint, payload);
          if (res.status === 404 || res.status === 410) { await env.SUBS.delete(s.key); removed++; }
          else if (res.ok) sent++; else failed++;
        } catch (_) { failed++; }
      }));
      return json(200, {ok: true, sent, removed, failed}, c.headers);
    }
    throw new HttpError(404, 'Không tìm thấy.');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json(status, {ok: false, error: e instanceof HttpError ? e.message : 'Lỗi hệ thống.'}, c.headers);
  }
}

export default {fetch: (request, env) => handle(request, env)};
