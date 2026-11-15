import {registerSW} from 'virtual:pwa-register';
import {initializeApp} from 'firebase/app';
import {
  getAuth, GoogleAuthProvider, signInWithRedirect, signInWithCredential, getRedirectResult, onAuthStateChanged, signOut, connectAuthEmulator
} from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator,
  collection, doc, getDoc, getDocs, getCountFromServer, onSnapshot, query, where, orderBy, limit, writeBatch, runTransaction, increment, arrayUnion
} from 'firebase/firestore';
import {createBackend} from './backend.js';
import {firebaseConfig} from './firebase-config.js';
import {pushConfig} from './push-config.js';
import {createPush} from './push.js';
import {createImageStore} from './image-store.js';

const emulator = import.meta.env.VITE_USE_EMULATOR === '1';
const configured = emulator || !/YOUR_/.test(JSON.stringify(firebaseConfig));
const SETUP_MESSAGE = 'Chưa cấu hình Firebase. Làm theo docs/FIREBASE-SETUP.md rồi điền web/src/firebase-config.js.';

let backend = null, auth = null, provider = null;
if (configured) {
  const app = initializeApp(emulator ? {apiKey: 'demo', projectId: 'demo-tiemvio', appId: 'demo', authDomain: 'localhost'} : firebaseConfig);
  auth = getAuth(app);
  // Keeps a copy of the data on the phone: the shop keeps selling offline and everything syncs when the network returns.
  const db = initializeFirestore(app, {localCache: persistentLocalCache({tabManager: persistentMultipleTabManager()})});
  if (emulator) { connectAuthEmulator(auth, 'http://127.0.0.1:9099', {disableWarnings: true}); connectFirestoreEmulator(db, '127.0.0.1', Number(import.meta.env.VITE_FS_PORT) || 8080); }
  provider = new GoogleAuthProvider();
  provider.setCustomParameters({prompt: 'select_account'});
  backend = createBackend({
    fs: {collection, doc, getDoc, getDocs, getCountFromServer, onSnapshot, query, where, orderBy, limit, writeBatch, runTransaction, increment, arrayUnion},
    db, projectId: app.options.projectId, imageStore: createImageStore(app.options.projectId)
  });
}

const push = createPush({...pushConfig, getIdToken: async () => (auth && auth.currentUser ? auth.currentUser.getIdToken() : '')});
window.tiemvioPush = push;
if (backend) backend.onProblem(msg => window.dispatchEvent(new CustomEvent('tiemvio:problem', {detail: msg})));
if (backend) backend.onNotify(evt => {
  if (evt && evt.type === 'revoke') push.revoke(evt.email);
  else if (evt && evt.type === 'presence') push.presence(evt.clocked, evt.email);
  else push.notify(evt);
});

function authMessage(e) {
  const code = e && e.code;
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return '';
  if (code === 'auth/network-request-failed') return 'Không kết nối được mạng để đăng nhập Google.';
  if (code === 'auth/unauthorized-domain') return 'Tên miền này chưa được thêm vào Authorized domains của Firebase Authentication.';
  return 'Đăng nhập Google không thành công. Hãy thử lại.';
}

let firstAuth = null;
window.tiemvioBackend = {
  async init() {
    if (!configured) return {signedIn: false, error: SETUP_MESSAGE};
    let error = '';
    try { await getRedirectResult(auth); } catch (e) { error = authMessage(e); }
    firstAuth = firstAuth || new Promise(resolve => { const off = onAuthStateChanged(auth, u => { off(); resolve(u); }); });
    const user = await firstAuth;
    if (!user) return {signedIn: false, error};
    const r = await backend.attach(user.email, user.displayName || '');
    if (!r.ok) { backend.detach(); await signOut(auth).catch(() => {}); return {signedIn: false, error: r.error}; }
    push.refresh({clocked: backend ? backend.clocked() : true});
    return {signedIn: true};
  },
  async signIn() {
    if (!configured) throw new Error(SETUP_MESSAGE);
    try {
      // The home-screen app on iPhone needs a same-site redirect. Local emulator runs sign in with a fake Google
      // identity instead (pick the account with ?as=email), so tests need no popup.
      if (emulator) {
        const email = new URLSearchParams(location.search).get('as') || 'owner@example.com';
        await signInWithCredential(auth, GoogleAuthProvider.credential(JSON.stringify({sub: email, email, email_verified: true})));
        location.reload();
      } else await signInWithRedirect(auth, provider);
    } catch (e) { throw new Error(authMessage(e) || e.message || 'Đăng nhập không thành công.'); }
  },
  async signOut() { await push.disable(); if (backend) backend.detach(); if (auth) await signOut(auth); },
  call: (action, data) => backend ? backend.call(action, data) : Promise.reject(new Error(SETUP_MESSAGE)),
  onChange: fn => backend && backend.onChange(fn),
  onSignedOut: fn => backend && backend.onSignedOut(message => { push.disable(); fn(message); })
};

// UI owns the reload gate: idle with no cart, modal, edit, uncertain write or running AI.
const applyNow = () => updateSW(true);
const updateSW = registerSW({
  onNeedRefresh() {
    window.tiemvioPendingUpdate=applyNow;
    window.dispatchEvent(new CustomEvent('tiemvio:update-ready', {detail: {apply: applyNow}}));
  }
});
// Refresh the worker on resume without bypassing the UI's transaction guard.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (navigator.onLine) navigator.serviceWorker?.getRegistration().then(r => r && r.update()).catch(() => {});
});
setInterval(()=>{if(!document.hidden&&navigator.onLine)navigator.serviceWorker?.getRegistration().then(r=>r&&r.update()).catch(()=>{});},5*60*1000);

import('./ui.js');
