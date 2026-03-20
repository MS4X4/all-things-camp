// ============================================================
// ALL THINGS CAMP — Service Worker  (sw.js)
// Place this file in the same root directory as index.html.
//
// Caching strategy:
//   App shell   → stale-while-revalidate (always loads fast)
//   OSM tiles   → cache-first, 7-day expiry  (offline maps)
//   Nominatim   → network-only  (geocoding needs fresh data)
//   Supabase    → network-only  (live auth + database calls)
// ============================================================

const CACHE_APP   = 'atc-app-v1';
const CACHE_TILES = 'atc-tiles-v1';
const TILE_TTL    = 7 * 24 * 60 * 60; // seconds

// App shell files to pre-cache on install
const PRECACHE = [
  '/',
  '/index.html',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js',
];

// ── Install ───────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_APP).then(cache =>
      Promise.allSettled(PRECACHE.map(url =>
        cache.add(new Request(url, { mode:'no-cors' }))
      ))
    ).then(() => self.skipWaiting())
  );
});

// ── Activate: remove stale caches ────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_APP && k !== CACHE_TILES).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch routing ─────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // OSM tiles → cache-first with 7-day TTL
  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    event.respondWith(tileStrategy(event.request));
    return;
  }

  // Nominatim (geocoding) → network-only; fall back to empty JSON if offline
  if (url.hostname === 'nominatim.openstreetmap.org') {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response('[]', { headers:{ 'Content-Type':'application/json' } })
      )
    );
    return;
  }

  // Supabase / CDN fonts → network-only (live data)
  if (
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('supabase.com') ||
    url.hostname.includes('fonts.bunny.net')
  ) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Everything else (app shell) → stale-while-revalidate
  event.respondWith(staleWhileRevalidate(event.request));
});

// ── Stale-while-revalidate (app shell) ───────────────────────
async function staleWhileRevalidate(req) {
  const cache   = await caches.open(CACHE_APP);
  const cached  = await cache.match(req);
  const network = fetch(req).then(res => {
    if (res && res.status === 200) cache.put(req, res.clone());
    return res;
  }).catch(() => cached);
  return cached || network;
}

// ── Cache-first with TTL (map tiles) ─────────────────────────
async function tileStrategy(req) {
  const cache  = await caches.open(CACHE_TILES);
  const cached = await cache.match(req);

  if (cached) {
    const age = cached.headers.get('x-cached-at');
    if (!age || (Date.now() - parseInt(age)) / 1000 < TILE_TTL) return cached;
  }

  try {
    const res  = await fetch(req);
    if (res && res.status === 200) {
      const hdrs = new Headers(res.headers);
      hdrs.set('x-cached-at', Date.now().toString());
      const body = await res.arrayBuffer();
      cache.put(req, new Response(body, { status:res.status, statusText:res.statusText, headers:hdrs }));
      return new Response(body, { status:res.status, statusText:res.statusText, headers:hdrs });
    }
    return res;
  } catch {
    return cached || new Response('', { status:503 });
  }
}
