// Service Worker do Shithead! Mobile
// Estratégia "rede primeiro": sempre tenta baixar a versão mais nova do GitHub Pages
// e só usa o cache quando estiver offline. Assim, cada atualização publicada
// aparece para os jogadores sem precisar limpar o cache do navegador.
//
// O jogo oficial (/shithead-mobile/) e o beta (/shithead-mobile-beta/) ficam no mesmo
// endereço do GitHub (duassi94-cmyk.github.io): cada um usa caches com o próprio
// prefixo e só apaga os seus, para um não derrubar os arquivos do outro.
const ENV = /-beta\//.test(self.location.pathname) ? 'beta'
  : (['localhost', '127.0.0.1', '[::1]'].includes(self.location.hostname) ? 'local' : 'prod');
const CACHE_PREFIX = 'shithead-' + ENV + '-';
const CACHE_NAME = CACHE_PREFIX + 'b11';
// Caches de versões antigas (antes do prefixo por ambiente) pertencem ao jogo oficial
const LEGACY_PREFIX = 'shithead-mobile-v5';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './engine.js',
  './core.js',
  './game.js',
  './manifest.json',
  './vendor/peerjs.min.js',
  './vendor/qrcode.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(ASSETS.map((url) => cache.add(url).catch(() => {}))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys
        .filter((key) => key !== CACHE_NAME &&
          (key.startsWith(CACHE_PREFIX) || (ENV === 'prod' && key.startsWith(LEGACY_PREFIX))))
        .map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Outros sites (servidor de salas etc.): não passa pelo cache
  if (url.origin !== self.location.origin) return;
  // Arquivos do jogo: rede primeiro, cache como reserva offline
  // cache: 'no-cache' = sempre confere no servidor se há versão nova (evita misturar
  // index.html novo com game.js antigo depois de uma atualização)
  event.respondWith(
    fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((resp) => {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return resp;
      })
      .catch(() =>
        caches.open(CACHE_NAME).then((cache) =>
          cache.match(req, { ignoreSearch: true })
            .then((cached) => cached || (req.mode === 'navigate' ? cache.match('./index.html') : undefined)))
      )
  );
});
