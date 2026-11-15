/* Browser side of lock-screen notifications. Talks to the push service (push-worker/) with the signed-in
 * user's Firebase ID token; nothing here can read or send anything without that. */
const urlBase64ToUint8Array = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0));

export function createPush({workerUrl, vapidPublicKey, getIdToken}) {
  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const configured = !!(workerUrl && vapidPublicKey);
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const ios = /iPad|iPhone|iPod/.test(ua) || (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = typeof window !== 'undefined' && ((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true);

  async function post(path, body) {
    const token = await getIdToken();
    if (!token) throw new Error('Chưa đăng nhập.');
    const res = await fetch(workerUrl + path, {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer ' + token}, body: JSON.stringify(body)});
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Không kết nối được dịch vụ thông báo.');
    return data;
  }
  async function currentSub() {
    if (!supported) return null;
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }

  return {
    supported, configured, ios, standalone,
    async state() {
      let sub = null;
      try { sub = supported && Notification.permission === 'granted' ? await currentSub() : null; } catch (_) { /* ignore */ }
      return {supported, configured, ios, standalone, needsInstall: ios && !standalone, permission: supported ? Notification.permission : 'unsupported', subscribed: !!sub};
    },
    /** Must run from a tap (iOS asks for permission only on a user gesture). */
    async enable() {
      if (!configured) throw new Error('Thông báo chưa được cấu hình.');
      if (!supported) throw new Error('Trình duyệt này không hỗ trợ thông báo.');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Bạn chưa cho phép thông báo. Có thể bật lại trong Cài đặt của điện thoại.');
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)});
      await post('/subscribe', {subscription: sub.toJSON()});
      return true;
    },
    async disable() {
      try {
        const sub = await currentSub();
        if (sub) { try { await post('/unsubscribe', {endpoint: sub.endpoint}); } catch (_) { /* offline or signed out: still drop it locally */ } await sub.unsubscribe(); }
      } catch (_) { /* ignore */ }
    },
    /** After sign-in: keep this phone's registration in step with the account (role, e-mail). */
    async refresh(opts = {}) {
      try { const sub = supported && configured && Notification.permission === 'granted' ? await currentSub() : null; if (sub) await post('/subscribe', {subscription: sub.toJSON(), clocked: opts.clocked !== false}); } catch (_) { /* best effort */ }
    },
    /** The person clocked in or out: new-order alerts follow (the owner is always notified). `email` is only for the owner clocking someone else out. */
    async presence(clocked, email) {
      if (!configured) return null;
      try { return await post('/presence', {clocked: clocked !== false, ...(email ? {email} : {})}); } catch (_) { return null; }
    },
    /** Owner only: stop sending notifications to a removed or locked account. Best effort. */
    async revoke(email) {
      if (!configured) return null;
      try { return await post('/revoke', {email}); } catch (_) { return null; }
    },
    /** Tell the other phones about an event. Best effort: never blocks or breaks selling. */
    async notify(evt) {
      if (!configured || (typeof navigator !== 'undefined' && navigator.onLine === false)) return null;
      try {
        const sub = supported ? await currentSub().catch(() => null) : null;
        return await post('/notify', {...evt, exclude: sub ? sub.endpoint : undefined});
      } catch (_) { return null; }
    }
  };
}
