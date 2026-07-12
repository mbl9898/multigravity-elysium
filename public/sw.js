// sw.js — Multigravity Elysium Service Worker
// Strategy:
//   - On install: pre-cache the offline fallback page
//   - On fetch:
//       • API routes (/api/*): always network-only, never intercept
//       • Navigation requests: network-first; if the network fails, serve offline.html
//       • Everything else: network-only (no caching of app shell — Next.js handles its own chunks)

const CACHE_NAME = 'multigravity-offline-v1';
const OFFLINE_URL = '/offline.html';

// ── Install: pre-cache the offline page ───────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll([OFFLINE_URL]))
  );
  // Activate immediately — don't wait for old tabs to close
  self.skipWaiting();
});

// ── Activate: purge old caches ────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  // Take control of all existing clients immediately
  self.clients.claim();
});

// ── Fetch: network-first with offline fallback ────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Skip cross-origin requests entirely
  if (url.origin !== self.location.origin) return;

  // 2. Skip API routes — never intercept, always go to network
  if (url.pathname.startsWith('/api/')) return;

  // 3. For navigation requests (page loads), use network-first with offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.open(CACHE_NAME).then((cache) => cache.match(OFFLINE_URL))
      )
    );
    return;
  }

  // 4. For all other requests (Next.js chunks, fonts, icons): network only
  //    Let the browser and Next.js manage their own caching.
});
