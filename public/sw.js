/* Monster Pop TD service worker: lets the installed app open with no connection.
   The game page is fetched fresh when online (so updates arrive right away) and
   kept as a fallback for offline play. Account requests (/api/) always go to the
   network and are never stored. The server stamps BUILD with the page version. */
const BUILD = '__BUILD__';
const CACHE = 'mptd-' + BUILD;
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png', '/icons/favicon-32.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('mptd-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

function pageFromNetwork(req) {
  // Give the network a few seconds; a stalled connection falls back to the saved copy.
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('slow')), 6000);
    fetch(req, { cache: 'no-cache' }).then(r => {
      clearTimeout(t);
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put('/', copy)); resolve(r); }
      else caches.match('/').then(saved => resolve(saved || r)); // server hiccup: play the saved copy
    }, e => { clearTimeout(t); reject(e); });
  });
}

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(pageFromNetwork(req).catch(() => caches.match('/').then(r => r || new Response('Monster Pop TD needs a connection the first time it opens.', { status: 503, headers: { 'Content-Type': 'text/plain' } }))));
    return;
  }
  if (SHELL.includes(url.pathname)) e.respondWith(caches.match(url.pathname).then(r => r || fetch(req)));
});
