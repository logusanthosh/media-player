const CACHE_NAME = 'soniq-shell-v36';
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
  const response = fetch(request);
  const cacheUpdate = response.then(
    result => result.ok && result.type === 'basic'
      ? caches.open(CACHE_NAME).then(cache => cache.put(request, result.clone()))
      : undefined,
    () => undefined
  );
  event.waitUntil(cacheUpdate.catch(error => console.error('Could not update the SONIQ app shell cache:', error)));
  event.respondWith(response.catch(networkError => caches.match(request).then(cached => {
    if (cached) return cached;
    throw networkError;
  })));
});
