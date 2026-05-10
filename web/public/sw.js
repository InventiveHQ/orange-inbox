// orange mail service worker.
// VERSION is the source of truth for the cache key; rewritten by
// scripts/bump-version.mjs alongside src/lib/version.ts.
const VERSION = 'v0.2.0';
const CACHE = `orange-${VERSION}`;
const SHELL = [
  '/',
  '/inbox/all',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-icon.png',
  '/favicon-32.png',
];

self.addEventListener('install', (e) => {
  // Best-effort precache; if any URL 401s behind Access we still want install
  // to succeed so push handlers can register.
  e.waitUntil(
    caches.open(CACHE).then(async (c) => {
      await Promise.allSettled(SHELL.map((u) => c.add(u)));
    }),
  );
  // Don't auto-skipWaiting — the page opts in via SKIP_WAITING postMessage.
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // never cache API
  if (url.pathname.startsWith('/_next/')) return; // bypass Next.js build assets
  if (req.mode === 'navigate') {
    // Network-first for HTML so a fresh deploy is picked up immediately.
    e.respondWith(fetch(req).catch(() => caches.match('/inbox/all') || caches.match('/')));
    return;
  }
  // Cache-first for static assets we precached.
  e.respondWith(caches.match(req).then((r) => r || fetch(req)));
});

self.addEventListener('push', (e) => {
  if (!e.data) return;
  let p;
  try {
    p = e.data.json();
  } catch {
    p = { title: 'orange mail', body: e.data.text() };
  }
  const title = p.title || 'orange mail';
  const body = p.body || '';
  const url = p.url || '/inbox/all';
  const threadId = p.threadId || null;
  const tag = threadId ? `thread-${threadId}` : `msg-${p.messageId || Date.now()}`;

  // Badging: only set when the payload carries a fresh unread total. If
  // missing (older payloads in flight), skip rather than guess — drift is
  // worse than a stale badge.
  if (typeof p.unreadTotal === 'number') {
    try {
      if (typeof self.navigator.setAppBadge === 'function') {
        self.navigator.setAppBadge(p.unreadTotal).catch(() => {});
      }
    } catch {
      // setAppBadge unsupported — ignore.
    }
  }

  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url, threadId },
      tag,
      renotify: true,
      actions: [
        { action: 'open', title: 'Open' },
        { action: 'archive', title: 'Archive' },
      ],
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const url = data.url || '/inbox/all';
  const threadId = data.threadId || null;

  if (e.action === 'archive' && threadId) {
    // Archive the thread server-side; don't open a window.
    e.waitUntil(
      fetch(`/api/threads/${encodeURIComponent(threadId)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      }).catch(() => {
        // Network/auth failure — best-effort; the client will catch up later.
      }),
    );
    return;
  }

  // Default: open or no action — focus/navigate to the thread URL.
  e.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const target = new URL(url, self.location.origin).pathname;
      const existing = all.find((c) => new URL(c.url).pathname === target);
      if (existing) {
        existing.focus();
        return;
      }
      if (all[0]) {
        all[0].navigate(url).catch(() => self.clients.openWindow(url));
        all[0].focus();
        return;
      }
      self.clients.openWindow(url);
    })(),
  );
});
