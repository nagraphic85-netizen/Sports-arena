/* Sports Arena service worker — অফলাইনে অ্যাপ খোলার জন্য (v4) */
const CACHE = 'sports-arena-v4';
const CORE = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './supabase-config.js', './supabase-sync.js'];
/* বাইরের লাইব্রেরি/ফন্ট: একবার অনলাইনে লোড হলে ক্যাশে থাকবে */
const EXT = ['https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;600;700&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'];
const EXT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'];
/* রিডাইরেক্ট হয়ে আসা উত্তর (যেমন /index.html → /) ব্রাউজার পেজ হিসেবে দেয় না; তাই সাধারণ উত্তরে বদলে নিই */
const clean = res => (res && res.redirected)
  ? res.blob().then(b => new Response(b, { status: res.status, statusText: res.statusText, headers: res.headers }))
  : Promise.resolve(res);
const WAIT = 4000;   // নেটওয়ার্ক ধীর হলে এতক্ষণ পর ক্যাশ থেকে খুলবে

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(
    CORE.map(u => fetch(u).then(clean).then(r => r && r.ok && c.put(u, r)).catch(() => {})).concat(
      EXT.map(u => fetch(u, { mode: 'no-cors' }).then(r => c.put(u, r)).catch(() => {}))
    )
  )).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.hostname.endsWith('supabase.co')) return;           // ডেটা সবসময় নেটওয়ার্ক থেকে
  const same = u.origin === location.origin;
  if (!same && !EXT_HOSTS.includes(u.hostname)) return;     // অন্য সাইট: ব্রাউজারের নিজের নিয়মে
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const fromCache = () => cache.match(r).then(m => m || (r.mode === 'navigate' ? (cache.match('./index.html').then(x => x || cache.match('./'))) : undefined));
    const net = fetch(r).then(clean).then(res => {
      if (res && (res.status === 200 || res.type === 'opaque')) cache.put(r, res.clone());
      return res;
    });
    const timer = new Promise(ok => setTimeout(ok, WAIT, null));
    try {
      const first = await Promise.race([net, timer]);
      if (first) return first;
      return (await fromCache()) || net;                     // ধীর নেটওয়ার্ক: ক্যাশ থাকলে সেটা, নইলে অপেক্ষা
    } catch (err) {
      return (await fromCache()) || Response.error();        // অফলাইন: ক্যাশ, নইলে ফাঁকা ব্যর্থতা (HTML নয়)
    }
  })());
});
