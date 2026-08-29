// Gulv Master Enterprise — service worker til push-notifikationer.
// Ingen offline-caching her med vilje: appen skal altid vise friske data (planer,
// bookinger osv.), så denne service worker har KUN ét formål — modtage og vise
// push-beskeder fra serveren, samt sende brugeren det rigtige sted hen ved klik.

self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
  let data = { title: 'Gulv Master', body: '', url: '/employee' };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (e) {
    if (event.data) data.body = event.data.text();
  }
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/employee' },
    tag: data.tag || 'gulvmaster-besked'
  };
  event.waitUntil(self.registration.showNotification(data.title || 'Gulv Master', options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/employee';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
