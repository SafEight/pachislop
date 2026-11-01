// Offline service worker (production builds only; registered by src/io/pwa.ts as `sw.js?v=<build>`).
// Install precaches the app shell, the bundled fonts and the HDRI listed in the build's
// precache-manifest.json into a cache named after the build; activate drops older builds' caches.
// Same-origin GETs are served cache-first (everything is content-hashed or immutable); page
// navigations go to the network first so a new build is picked up, falling back to the cached
// shell offline. Nothing is ever sent anywhere: the app makes no cross-origin requests.

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = `pslot-${VERSION}`;
const SCOPE = new URL(self.registration.scope);
const SHELL = new URL('./', SCOPE).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const res = await fetch(new URL(`precache-manifest.json?v=${VERSION}`, SCOPE), { cache: 'no-cache' });
      const { files } = await res.json();
      const cache = await caches.open(CACHE);
      await cache.addAll(files.map((f) => new URL(f, SCOPE).href));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('pslot-') && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== SCOPE.origin) return;
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          const cache = await caches.open(CACHE);
          await cache.put(SHELL, res.clone());
          return res;
        } catch {
          return (await caches.match(SHELL)) || Response.error();
        }
      })(),
    );
    return;
  }
  event.respondWith(
    (async () => {
      // ignoreVary: servers may answer `Vary: Origin`, and module scripts (crossorigin) carry an
      // Origin header the precache requests lacked; without it a lazy chunk never loaded online
      // under this worker (export, PS import…) would miss the cache offline. Files are immutable.
      const hit = await caches.match(req, { ignoreVary: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') (await caches.open(CACHE)).put(req, res.clone());
      return res;
    })(),
  );
});
