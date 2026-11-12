const CACHE_NAME = 'soniq-shell-v25';
const APP_SHELL = ['./', './index.html', './video.css', './manifest.json', './icon.svg', './src/video-app.js', './src/db.js', './src/metadata.js'];
const CACHEABLE_URLS = new Set(APP_SHELL.map(asset => new URL(asset, self.location.href).href));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith('soniq-shell-') && key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  if (request.destination === 'audio' || request.headers.has('range')) return;
  if (!CACHEABLE_URLS.has(request.url)) return;
  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
    }
    return response;
  })));
});
