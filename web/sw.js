/* ============================================================
   SinglePoint Calls — Service Worker
   Handles Web Push notifications and offline caching (PWA).
   ============================================================ */
'use strict';

const CACHE_NAME = 'spc-v2';
const STATIC_SHELL = ['/', '/app.js', '/manifest.json'];

// ── Install: cache static shell for offline ────────────────
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((c) => c.addAll(STATIC_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

// ── Activate: purge old caches ─────────────────────────────
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: network-first for API, cache-first for static ───
self.addEventListener('fetch', (e) => {
  const { pathname } = new URL(e.request.url);
  if (pathname.startsWith('/api/') || pathname.startsWith('/socket.io/')) return;
  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fromNetwork = fetch(e.request).then((res) => {
        if (res.ok) caches.open(CACHE_NAME).then((c) => c.put(e.request, res.clone()));
        return res;
      });
      return cached || fromNetwork;
    })
  );
});

// ── Push event ─────────────────────────────────────────────
self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { title: 'New notification', body: e.data ? e.data.text() : '' };
  }

  const title   = data.title  || 'SinglePoint Calls';
  const options = {
    body:    data.body    || '',
    icon:    data.icon    || '/icon-192.png',
    badge:   data.badge   || '/icon-192.png',
    tag:     data.tag     || 'spc-notification',
    data:    { url: data.url || '/' },
    // requireInteraction keeps it on screen until dismissed (useful for operators)
    requireInteraction: data.requireInteraction === true,
    vibrate: [200, 100, 200],
    actions: data.actions || [],
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

// ── Notification click — focus or open the app ─────────────
self.addEventListener('notificationclick', (e) => {
  e.notification.close();

  const targetUrl = e.notification.data?.url || '/';

  e.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        // Focus existing tab if already open
        for (const client of windowClients) {
          if (new URL(client.url).pathname.startsWith(new URL(targetUrl, self.location.origin).pathname)) {
            return client.focus();
          }
        }
        // Otherwise open a new window
        return self.clients.openWindow(targetUrl);
      })
  );
});

// ── Push subscription change (browser renews endpoint) ─────
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil(
    self.registration.pushManager.subscribe(e.oldSubscription.options)
      .then((subscription) => {
        // Re-register the new subscription with the server
        return fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subscription,
            // token passed via URL hash when page is open — best effort
            token: e.oldSubscription?.endpoint,
          }),
        });
      })
  );
});
