// Service Worker do portal do cliente — só a casca (o dado é sempre da rede).
//
// Estratégia: cache-first para os ficheiros da app com revalidação em
// segundo plano (a próxima visita recebe a versão nova); o Supabase nunca
// entra na cache (o fetch handler só intercepta a própria origem).

const CACHE = 'ende-portal-v2';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './sw.js',
  './src/portal.js',
  './src/portal-data.js',
  '../app/icons/icon.svg',
  '../app/icons/icon-192.png',
  '../app/icons/icon-512.png',
  '../app/icons/icon-maskable-512.png',
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
      return cached || (await network) || Response.error();
    })(),
  );
});
