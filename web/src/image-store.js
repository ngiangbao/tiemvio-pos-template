/* Keeps the menu photos on the phone (IndexedDB) so they are not downloaded again at every opening: see loadImages() in backend.js. */
export function createImageStore(name) {
  if (typeof indexedDB === 'undefined') return null;
  const open = () => new Promise((resolve, reject) => {
    const r = indexedDB.open('tiemvio-images:' + name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const run = (mode, fn) => open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode), req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => { db.close(); resolve(req && req.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  }));
  return {
    get: () => run('readonly', st => st.get('photos')),
    set: (rev, images) => run('readwrite', st => st.put({rev, images}, 'photos'))
  };
}
