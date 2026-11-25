const CACHE_NAME = 'studio-carifi-memo-v9';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './styles.css',
  './scadenziario_data.js',
  './app.js',
  './manifest.json',
  './icon.svg',
  './logo.jpg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const reqUrl = new URL(event.request.url);

  // Non cachare richieste verso servizi esterni (ntfy, CDN dinamici, API)
  if (reqUrl.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Supporto nativo Web Push (iOS 16.4+ PWA & Desktop Chrome/Edge/Firefox)
self.addEventListener('push', (event) => {
  let payload = {
    title: 'Studio Carifi Commercialista',
    body: 'Nuovo avviso di scadenza o appuntamento in agenda.',
    itemId: null,
    urgent: true
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      payload = { ...payload, ...parsed };
    } catch (_) {
      payload.body = event.data.text() || payload.body;
    }
  }

  const options = {
    body: payload.body,
    icon: './logo.jpg',
    badge: './icon.svg',
    vibrate: payload.urgent ? [300, 120, 300, 120, 450] : [200, 100, 200],
    requireInteraction: Boolean(payload.urgent),
    renotify: true,
    tag: payload.itemId ? `carifi-${payload.itemId}` : `carifi-push-${Date.now()}`,
    data: { itemId: payload.itemId || null },
    actions: payload.itemId
      ? [
          { action: 'ack', title: '✓ Preso in Carico' },
          { action: 'snooze15', title: '⏰ Posponi 15m' }
        ]
      : []
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

// Messaggi diretti dall'app verso il Service Worker
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Gestione click sulle notifiche (PC Windows e iOS PWA)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const itemId = event.notification.data?.itemId || null;
  const action = event.action || 'open';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          client.postMessage({
            type: 'NOTIFICATION_ACTION',
            itemId,
            action
          });
          return;
        }
      }
      if (self.clients.openWindow) {
        let hash = '';
        if (itemId) {
          if (action === 'ack') hash = `#ack=${encodeURIComponent(itemId)}`;
          else if (action === 'snooze15') hash = `#snooze15=${encodeURIComponent(itemId)}`;
          else hash = `#item-${encodeURIComponent(itemId)}`;
        }
        return self.clients.openWindow('./index.html' + hash);
      }
    })
  );
});
