// Service worker mínimo: cachea los assets locales para arranque instantáneo
// y para que el navegador ofrezca instalar la app.
const CACHE = 'guia-v69';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './favicon.svg',
  './icon.svg',
  './assets/styles.css',
  './assets/app.js',
  './assets/defaults.js',
  './assets/santoral.js',
  './assets/private.js',
  './assets/logo-light.png',
  './assets/logo-dark.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Solo cacheamos same-origin: APIs externas (clima, indicadores, iconos) van directo a red.
  if (url.origin !== self.location.origin) return;
  // proxy.php devuelve contenido dinámico (RSS, etc), no debe cachearse aquí
  // porque dejaría a los usuarios con noticias viejas. La capa de cache de
  // localStorage (30 min) ya maneja la frescura.
  if (url.pathname.endsWith('/proxy.php')) return;
  if (url.pathname.endsWith('/shared.json')) return;

  // Estrategia: stale-while-revalidate para que cargue rápido pero se actualice silenciosamente.
  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(req).then(cached => {
        const network = fetch(req).then(resp => {
          if (resp && resp.ok) cache.put(req, resp.clone());
          return resp;
        }).catch(() => cached);
        return cached || network;
      })
    )
  );
});
