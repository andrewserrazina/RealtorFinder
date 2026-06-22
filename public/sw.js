const CACHE = 'rf-v3';
const PRECACHE = [
  '/', '/about', '/features', '/offline.html',
  '/manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (!e.request.url.startsWith('http')) return;
  if (e.request.url.includes('/api/')) return;
  // Never cache authenticated or dynamic pages — always hit the server
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/dashboard') || url.pathname === '/login' || url.pathname === '/waitlist') return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match('/offline.html'));
    })
  );
});

self.addEventListener('push', e => {
  let data = { title: 'RealtorFinder', body: 'You have a new notification.', url: '/dashboard/realtor' };
  if (e.data) {
    try { data = { ...data, ...e.data.json() }; } catch (_) {}
  }
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url },
      vibrate: [200, 100, 200]
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/dashboard/realtor';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if (client.url.includes('/dashboard/realtor') && 'focus' in client) {
          client.postMessage({ type: 'navigate', url: target });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});


self.addEventListener('push', e => {
  let data = { title: 'RealtorFinder', body: 'You have a new notification.', url: '/dashboard/realtor' };
  if (e.data) {
    try { data = { ...data, ...e.data.json() }; } catch (_) {}
  }
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url },
      vibrate: [200, 100, 200]
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/dashboard/realtor';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if (client.url.includes('/dashboard/realtor') && 'focus' in client) {
          client.postMessage({ type: 'navigate', url: target });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
