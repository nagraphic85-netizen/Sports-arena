/* Sports Arena service worker — অফলাইনে অ্যাপ খোলার জন্য */
const CACHE = 'sports-arena-v3';
const CORE = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './supabase-config.js', './supabase-sync.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(CORE.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.hostname.endsWith('supabase.co')) return;           // ডেটা সবসময় নেটওয়ার্ক থেকে
  e.respondWith(
    fetch(r).then(res => {                                   // আগে নেটওয়ার্ক, না পেলে ক্যাশ
      if (res && res.status === 200 && (u.origin === location.origin || res.type === 'cors')) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(r, copy));
      }
      return res;
    }).catch(() => caches.match(r).then(m => m || caches.match('./index.html')))
  );
});
