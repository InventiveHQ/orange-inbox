// orange mail service worker.
// VERSION is the source of truth for the cache key; rewritten by
// scripts/bump-version.mjs alongside src/lib/version.ts.
const VERSION = 'v0.2.27';
const CACHE = `orange-${VERSION}`;
// Separate runtime cache for stale-while-revalidate'd thread/message JSON.
// Keeping it out of the precache means a SKIP_WAITING bump doesn't blow away
// the offline read corpus.
const API_CACHE = `orange-api-${VERSION}`;
// Cap on cached thread/message responses. The SW evicts oldest entries (by
// insertion order) once we cross this. 100 by default — tuned for "open the
// app on a plane and still see your recent stuff" without exploding storage.
const API_CACHE_LIMIT = 100;
const SHELL = [
  '/',
  '/inbox/all',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-icon.png',
  '/favicon-32.png',
];

// How long a navigation fetch may run before we fall back to the cached app
// shell. Without this cap a slow or flaky connection leaves the PWA on a
// blank screen until the browser's own (30 s+) network timeout — the
// previous handler used `.catch()` alone, which only fires on a *hard*
// failure, never on a merely-slow connection. 3 s is short enough that a
// stuck launch feels recoverable, long enough that a healthy connection
// almost always wins the race and serves fresh HTML.
const NAV_TIMEOUT_MS = 3000;

// IndexedDB store for queued outbound messages. Schema:
//   { id (autoinc), createdAt, payload, status, lastError, attempts }
// payload is the verbatim JSON body the composer would have POSTed to
// /api/messages. status is 'pending' | 'sending' | 'sent' | 'failed'.
const IDB_NAME = 'orange-outbox';
const IDB_STORE = 'outbox';
const IDB_VERSION = 1;

function openOutboxDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        const store = db.createObjectStore(IDB_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('status', 'status', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function addOutbox(payload) {
  const db = await openOutboxDb();
  try {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    const id = await idbReq(
      store.add({
        createdAt: Date.now(),
        payload,
        status: 'pending',
        lastError: null,
        attempts: 0,
      }),
    );
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return id;
  } finally {
    db.close();
  }
}

async function listOutbox(status) {
  const db = await openOutboxDb();
  try {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const all = await idbReq(store.getAll());
    return status ? all.filter((r) => r.status === status) : all;
  } finally {
    db.close();
  }
}

async function updateOutbox(id, patch) {
  const db = await openOutboxDb();
  try {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    const row = await idbReq(store.get(id));
    if (!row) return;
    Object.assign(row, patch);
    await idbReq(store.put(row));
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function deleteOutbox(id) {
  const db = await openOutboxDb();
  try {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    await idbReq(store.delete(id));
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function broadcast(msg) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of clients) c.postMessage(msg);
}

// Drain pending outbox rows in createdAt order, posting each to /api/messages.
// Concurrency 1 — preserves user-intended order and avoids hammering the API.
//
// Conflict policy: each row is a "send-once" snapshot of the composer state at
// queue time. If the server returns 4xx (the mailbox was deleted, attachment
// IDs no longer resolve, alias was revoked, etc) we mark the row 'failed'
// rather than retrying — replaying a 4xx in a loop won't fix it. 5xx + network
// errors stay 'pending' so a later online/sync event tries again. Failed rows
// surface to the app via the post-flush summary message; the user can decide
// what to do (re-open compose with the saved payload, or discard).
let flushing = false;
async function flushOutbox(reason) {
  if (flushing) return;
  flushing = true;
  try {
    const pending = (await listOutbox('pending')).sort((a, b) => a.createdAt - b.createdAt);
    if (pending.length === 0) {
      await broadcast({ type: 'outbox-flush-done', reason, sent: 0, failed: 0, remaining: 0 });
      return;
    }
    await broadcast({ type: 'outbox-flush-start', reason, total: pending.length });

    let sent = 0;
    let failed = 0;
    for (const row of pending) {
      await updateOutbox(row.id, { status: 'sending', attempts: (row.attempts || 0) + 1 });
      try {
        const res = await fetch('/api/messages', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(row.payload),
        });
        if (res.ok) {
          await deleteOutbox(row.id);
          sent++;
          await broadcast({ type: 'outbox-flush-progress', id: row.id, status: 'sent' });
          continue;
        }
        if (res.status >= 400 && res.status < 500) {
          // Permanent — record the error and stop retrying this row.
          const b = await res.json().catch(() => ({}));
          await updateOutbox(row.id, {
            status: 'failed',
            lastError: b.error || `HTTP ${res.status}`,
          });
          failed++;
          await broadcast({
            type: 'outbox-flush-progress',
            id: row.id,
            status: 'failed',
            error: b.error || `HTTP ${res.status}`,
          });
          continue;
        }
        // 5xx — leave as pending for the next flush cycle.
        await updateOutbox(row.id, { status: 'pending', lastError: `HTTP ${res.status}` });
        await broadcast({ type: 'outbox-flush-progress', id: row.id, status: 'deferred' });
      } catch (e) {
        // Network blip — stay pending.
        await updateOutbox(row.id, {
          status: 'pending',
          lastError: (e && e.message) || 'network error',
        });
        await broadcast({ type: 'outbox-flush-progress', id: row.id, status: 'deferred' });
        // No point hammering the rest if the network just went away again.
        break;
      }
    }

    const remaining = (await listOutbox('pending')).length;
    await broadcast({ type: 'outbox-flush-done', reason, sent, failed, remaining });
  } finally {
    flushing = false;
  }
}

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
      // Keep both the shell and API caches keyed on VERSION; everything else
      // is stale and gets evicted.
      await Promise.all(
        keys.filter((k) => k !== CACHE && k !== API_CACHE).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (e) => {
  const data = e.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'queue-send' && data.payload) {
    e.waitUntil(
      (async () => {
        const id = await addOutbox(data.payload);
        // Reply to the originator so the composer can show "Queued" with the
        // row id (used to retry/edit later if we add that affordance).
        if (e.source && 'postMessage' in e.source) {
          try {
            e.source.postMessage({ type: 'queue-send-ack', id });
          } catch {}
        }
        // Try to flush immediately — covers the case where the original
        // /api/messages POST failed for a transient reason but we're actually
        // online (corporate proxy hiccup, etc).
        if (self.navigator.onLine !== false) {
          flushOutbox('queued').catch(() => {});
        }
      })(),
    );
    return;
  }
  if (data.type === 'flush-outbox') {
    e.waitUntil(flushOutbox(data.reason || 'manual').catch(() => {}));
    return;
  }
  if (data.type === 'list-outbox') {
    e.waitUntil(
      (async () => {
        const rows = await listOutbox();
        if (e.source && 'postMessage' in e.source) {
          try {
            e.source.postMessage({ type: 'outbox-list', rows });
          } catch {}
        }
      })(),
    );
    return;
  }
});

// Online comes through as a window event in clients, but Workers also get
// 'online' on self when the SW thread reconnects. Wire both — the page side
// forwards its own 'online' as a 'flush-outbox' message above.
self.addEventListener('online', () => {
  flushOutbox('online').catch(() => {});
});

// Background Sync (Chromium-only). The composer registers a tag and the SW
// drains the queue when connectivity returns. iOS doesn't fire this but we
// still flush from the page-side 'online' postMessage.
self.addEventListener('sync', (e) => {
  if (e.tag === 'orange-outbox-flush') {
    e.waitUntil(flushOutbox('sync').catch(() => {}));
  }
});

// Trim API_CACHE to N entries, oldest-first. Keyed off the cached Response's
// 'date' header (set by the SW on put — see cacheApiResponse) so we don't
// trust the upstream Date. Called after every put.
async function trimApiCache() {
  const cache = await caches.open(API_CACHE);
  const keys = await cache.keys();
  if (keys.length <= API_CACHE_LIMIT) return;
  // Read the x-orange-cached-at header off each entry; sort ascending and
  // evict the oldest until we're under the cap.
  const stamped = await Promise.all(
    keys.map(async (req) => {
      const res = await cache.match(req);
      const at = Number(res?.headers.get('x-orange-cached-at') || '0');
      return { req, at };
    }),
  );
  stamped.sort((a, b) => a.at - b.at);
  const toEvict = stamped.slice(0, stamped.length - API_CACHE_LIMIT);
  for (const { req } of toEvict) await cache.delete(req);
}

async function cacheApiResponse(req, res) {
  // Clone, restamp with our own freshness header, and store. We can't mutate
  // a Response's headers directly, so rebuild with a fresh init.
  const body = await res.clone().arrayBuffer();
  const headers = new Headers(res.headers);
  headers.set('x-orange-cached-at', String(Date.now()));
  const stamped = new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
  const cache = await caches.open(API_CACHE);
  await cache.put(req, stamped);
  await trimApiCache();
}

// Stale-while-revalidate for read-only thread JSON. Returns the cached copy
// immediately if present, then refreshes in the background. On a cold cache
// miss falls through to the network — and if that fails we still return the
// stale entry (defensive; trimApiCache may have evicted it between the match
// and the fetch).
function staleWhileRevalidate(req) {
  return caches.open(API_CACHE).then(async (cache) => {
    const cached = await cache.match(req);
    const fetchPromise = fetch(req)
      .then((res) => {
        if (res.ok) {
          // Don't block the response on the cache write.
          cacheApiResponse(req, res).catch(() => {});
        }
        return res;
      })
      .catch((e) => {
        if (cached) return cached;
        throw e;
      });
    return cached || fetchPromise;
  });
}

// Should this GET be SWR-cached for offline read? Only the read-only thread
// list + thread/message detail endpoints — never mutations, never list-with-
// query-filters (search), and never user-private stuff like /api/me where a
// stale response would be a footgun.
function isOfflineCacheable(url) {
  if (url.pathname === '/api/threads') return true;
  if (/^\/api\/threads\/[^/]+$/.test(url.pathname)) return true;
  if (/^\/api\/threads\/[^/]+\/messages$/.test(url.pathname)) return true;
  if (/^\/api\/messages\/[^/]+$/.test(url.pathname)) return true;
  return false;
}

// Network-first-with-timeout for HTML navigations. On a healthy connection
// the network fetch wins the race so a fresh deploy is still picked up
// immediately; on a slow/flaky one we stop waiting after NAV_TIMEOUT_MS and
// serve the precached shell, which hydrates and lets the app take over
// client-side rather than the user staring at a blank screen. A hard
// network failure falls back the same way.
async function navigationResponse(event, req) {
  const fallback = () =>
    caches
      .match(req)
      .then((r) => r || caches.match('/inbox/all'))
      .then((r) => r || caches.match('/'));

  const network = fetch(req).then((res) => {
    // Keep the precached shell entries fresh for the next cold start, but
    // only for the fixed SHELL routes so CACHE stays bounded.
    if (res.ok && SHELL.includes(new URL(req.url).pathname)) {
      const copy = res.clone();
      event.waitUntil(
        caches
          .open(CACHE)
          .then((c) => c.put(req, copy))
          .catch(() => {}),
      );
    }
    return res;
  });

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      // Nothing cached yet (first-ever launch) → keep waiting on the network;
      // there's no better answer to give.
      resolve(fallback().then((r) => r || network));
    }, NAV_TIMEOUT_MS);
  });

  try {
    return await Promise.race([network, timeout]);
  } catch {
    // Hard network failure before the timeout fired — serve the shell.
    return (await fallback()) || network;
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/_next/')) return; // bypass Next.js build assets

  // API: stale-while-revalidate for the read-only thread endpoints only.
  // Everything else under /api stays network-only so we don't paper over
  // permission/auth changes with stale data.
  if (url.pathname.startsWith('/api/')) {
    if (req.method === 'GET' && isOfflineCacheable(url)) {
      e.respondWith(staleWhileRevalidate(req));
    }
    return;
  }

  if (req.method !== 'GET') return;

  if (req.mode === 'navigate') {
    e.respondWith(navigationResponse(e, req));
    return;
  }
  // Cache-first for static assets we precached.
  e.respondWith(caches.match(req).then((r) => r || fetch(req)));
});

// Crude iOS sniff used on the *server* side too if we ever need to — but the
// reply action is set client-side here based on what the SW knows. iOS PWAs
// don't surface event.reply, so adding the action button just confuses users.
function isIos() {
  const ua = self.navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ reports as Mac with touch; treat that as iOS too.
  if (/Macintosh/.test(ua) && self.navigator.maxTouchPoints > 1) return true;
  return false;
}

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

  // Calendar reminder branch (#85, snooze in #96). Reminder payloads carry
  // `reminder: true` plus eventId + minutesBefore (see lib/reminders.ts).
  // They never have a threadId, so the mail-thread actions below are
  // irrelevant — fork early and emit reminder-specific UI instead.
  if (p.reminder === true && p.eventId) {
    // One reminder per (event_id, minutes_before) — tag accordingly so a
    // re-fired snoozed reminder *replaces* the original rather than stacks.
    const minutesBefore = typeof p.minutesBefore === 'number' ? p.minutesBefore : 0;
    const tag = `reminder-${p.eventId}-${minutesBefore}`;
    // Snooze + open. iOS Safari ignores `actions` entirely on PWAs (the
    // notification still opens the app on tap, which is the documented
    // graceful-degrade in the design) — keeping the array short avoids
    // the Android UI truncating something useful.
    const actions = [
      { action: 'snooze-reminder', title: 'Snooze 5 min' },
      { action: 'open-reminder', title: 'Open' },
    ];
    e.waitUntil(
      self.registration.showNotification(title, {
        body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: {
          url,
          reminder: true,
          eventId: p.eventId,
          minutesBefore,
        },
        tag,
        renotify: true,
        actions,
      }),
    );
    return;
  }

  // Use threadId as the tag so subsequent pushes from the same conversation
  // *replace* the previous one rather than stacking. Falls back to a per-
  // message tag when threadId is missing (e.g. legacy payloads).
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

  // Inline reply action (Android Chrome only). iOS Safari ignores the
  // 'text' action type and falls back to a regular button that does nothing
  // useful, so omit it there.
  const actions = [{ action: 'open', title: 'Open' }];
  if (threadId && !isIos()) {
    actions.push({
      action: 'reply',
      title: 'Reply',
      type: 'text',
      placeholder: 'Type a reply…',
    });
  }
  actions.push({ action: 'archive', title: 'Archive' });

  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url, threadId },
      tag,
      renotify: true,
      actions,
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const url = data.url || '/inbox/all';
  const threadId = data.threadId || null;

  // Calendar reminder branch (#96). The push handler stamps `reminder: true`
  // + eventId/minutesBefore on the notification's data when the payload was
  // a reminder; both action buttons land here.
  if (data.reminder && data.eventId) {
    if (e.action === 'snooze-reminder') {
      // Fire-and-forget snooze. We deliberately do NOT re-show the
      // notification on success — the dismissed notification + a
      // follow-up push at the snooze target is the user's signal.
      // On failure we surface a follow-up notification so they know
      // their tap didn't take effect.
      const eventId = String(data.eventId);
      const minutesBefore = typeof data.minutesBefore === 'number' ? data.minutesBefore : 0;
      e.waitUntil(
        fetch(`/api/calendar/reminders/${encodeURIComponent(eventId)}/snooze`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ minutes_before: minutesBefore, snooze_for_minutes: 5 }),
        })
          .then(async (res) => {
            if (!res.ok) {
              const detail = await res.text().catch(() => '');
              await self.registration.showNotification('Snooze failed', {
                body: detail.slice(0, 140) || 'Tap to open the calendar.',
                icon: '/icon-192.png',
                badge: '/icon-192.png',
                tag: `reminder-${eventId}-${minutesBefore}-snooze-failed`,
                data: { url },
              });
            }
          })
          .catch(async () => {
            await self.registration.showNotification('Snooze failed', {
              body: 'No network. Tap to open the calendar.',
              icon: '/icon-192.png',
              badge: '/icon-192.png',
              tag: `reminder-${eventId}-${minutesBefore}-snooze-failed`,
              data: { url },
            });
          }),
      );
      return;
    }
    // 'open-reminder' (explicit action) or no action (plain tap on iOS,
    // where action buttons aren't rendered): focus/navigate the calendar.
    e.waitUntil(openThread(url));
    return;
  }

  if (e.action === 'reply' && threadId) {
    // event.reply is the typed text on Android. If empty (user dismissed
    // the input without typing) fall through to opening the thread.
    const replyText = (e.reply || '').trim();
    if (!replyText) {
      e.waitUntil(openThread(url));
      return;
    }
    e.waitUntil(
      fetch('/api/internal/notify-reply', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId, body: replyText }),
      })
        .then(async (res) => {
          if (!res.ok) {
            // Surface failure with a follow-up notification so the user
            // notices their reply didn't go out.
            const detail = await res.text().catch(() => '');
            await self.registration.showNotification('Reply failed', {
              body: detail.slice(0, 140) || 'Tap to open the thread and try again.',
              icon: '/icon-192.png',
              badge: '/icon-192.png',
              tag: `thread-${threadId}-reply-failed`,
              data: { url },
            });
          }
        })
        .catch(async () => {
          await self.registration.showNotification('Reply failed', {
            body: 'No network. Tap to open the thread.',
            icon: '/icon-192.png',
            badge: '/icon-192.png',
            tag: `thread-${threadId}-reply-failed`,
            data: { url },
          });
        }),
    );
    return;
  }

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
  e.waitUntil(openThread(url));
});

async function openThread(url) {
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
}

// ─── Push subscription renewal ──────────────────────────────────────────────
// Browsers — iOS Safari especially — periodically rotate or expire the push
// subscription, particularly after a PWA has sat unused for a while. When
// that happens the old endpoint starts returning 404/410, the server prunes
// the stored row (see api/internal/notify-new-message), and with nothing to
// re-create it, notifications silently stop for good.
//
// This handler re-subscribes and re-registers the fresh subscription with
// the server. iOS doesn't reliably fire `pushsubscriptionchange`, so the app
// also re-syncs on launch from the page side (see usePushResync) — the two
// together cover both engines.

function b64uToBytes(b64u) {
  const pad = b64u.length % 4 === 0 ? '' : '='.repeat(4 - (b64u.length % 4));
  const bin = atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function renewPushSubscription(existing) {
  // Prefer a subscription the event handed us; otherwise re-create one with
  // the server's VAPID key.
  let sub = existing || (await self.registration.pushManager.getSubscription());
  if (!sub) {
    const vapidRes = await fetch('/api/push/vapid', { credentials: 'include' });
    if (!vapidRes.ok) return;
    const { publicKey } = await vapidRes.json();
    sub = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64uToBytes(publicKey),
    });
  }
  await fetch('/api/push/subscribe', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  });
}

self.addEventListener('pushsubscriptionchange', (e) => {
  // `newSubscription` is populated on Chromium; absent on others, where
  // renewPushSubscription re-subscribes from scratch.
  e.waitUntil(renewPushSubscription(e.newSubscription).catch(() => {}));
});
