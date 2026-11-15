// Service Worker do ENDE CONTROL.
//
// Estratégia:
//   * Casca (HTML/JS/CSS/ícones): cache-first, guardada no install. É isto que
//     permite abrir a app sem rede.
//   * Rede sempre que possível para actualizar a casca em background (stale-while-revalidate).
//   * Petições a outros domínios (Supabase) não são interceptadas: o RLS e a
//     sessão não podem ser servidos da cache, e guardá-las só atrasa a sync.

const CACHE = 'ende-control-v1';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './sw.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './src/app.js',
  './src/auth.js',
  './src/config.js',
  './src/remote-supabase.js',
  './src/core/sync-engine.js',
  './src/core/idb-store.js',
  './src/core/ids.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Só a própria app: o Supabase tem de ir sempre à rede.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => null);

      if (cached) {
        // Actualiza a cache em silêncio; responde já com o que temos.
        event.waitUntil(network);
        return cached;
      }

      const res = await network;
      if (res) return res;

      // Sem cache e sem rede: devolve o index para navegação, para a app abrir.
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      return Response.error();
    })(),
  );
});
