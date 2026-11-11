// Service worker for /noter: app-skallen (siden + notes-ui.js) caches, så
// noteappen åbner med det samme. Data (/api/…) hentes altid fra nettet –
// noter.html har selv en lokal kopi af de senest viste sider til offline.
const CACHE = 'noter-shell-__NV__';
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/noter', '/notes-ui.js?v=__NV__', '/icon-192.png']).catch(() => {})).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('noter-shell-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname === '/noter' || u.pathname === '/notes-ui.js' || u.pathname === '/icon-192.png') {
    // Netværk først (altid nyeste version), cache som hurtig reserve når nettet er langsomt/væk.
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const key = u.pathname === '/noter' ? '/noter' : u.pathname + u.search;
      const cached = await cache.match(key);
      const net = fetch(e.request).then(r => { if (r.ok) cache.put(key, r.clone()); return r; }).catch(() => null);
      if (cached) { const fast = await Promise.race([net, new Promise(r => setTimeout(() => r(null), 1500))]); return fast || cached; }
      return (await net) || new Response('Offline', { status: 503 });
    })());
  }
});
