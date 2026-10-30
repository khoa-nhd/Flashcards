/*
 * The offline shell for the vocabulary app.
 *
 * The app keeps its own data in IndexedDB; this worker only has to make the
 * page load without a connection, so the app can open and then read that data.
 * Pages are network-first, so a fresh deployment is picked up whenever there
 * is a connection; the built assets are cache-first, since their names carry a
 * content hash. /api/ is never touched: requests to the server have to fail
 * honestly, because that is how the app knows it is offline.
 */
const CACHE = 'flashcards-shell-v1';
const SHELL = ['/', '/index.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The app's own server, never cached. An unreachable request must look unreachable.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put('/index.html', copy)).catch(() => undefined);
          return response;
        })
        .catch(() => caches.match('/index.html').then((cached) => cached ?? Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
          }
          return response;
        }),
    ),
  );
});

// ---- Reminders (web push, phase 4) ----
// The server sends { title, body, url, tag }; a tap opens the app at `url`.

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Vocabulary', {
      body: data.body || '',
      tag: data.tag || 'reminder',
      icon: '/icon.svg',
      badge: '/icon.svg',
      data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open) return open.focus().then(() => open.navigate(url));
      return self.clients.openWindow(url);
    }),
  );
});
