const CACHE = 'alaminut-v12';
const SHELL = [
  './', './index.html', './app.css', './manifest.json',
  './js/app.js', './js/config.js', './js/supabase.js', './js/util.js',
  './js/ui.js', './js/auth.js', './js/api.js', './js/orders.js',
  './js/admin-day.js', './js/admin-week.js', './js/admin-alaminut.js',
  './js/admin-people.js', './js/settings.js',
  './icons/icon-192.svg', './icons/icon-512.svg',
];

self.addEventListener('install', e => {
  // addAll fails the whole install if one entry 404s; tolerate that.
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never cache Supabase or the CDN — a stale order list is worse than an error.
  if (url.hostname.endsWith('supabase.co') || url.hostname === 'esm.sh') return;
  if (e.request.method !== 'GET') return;

  // Network-first so a deploy is picked up immediately, cache as the offline
  // fallback for the shell.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
