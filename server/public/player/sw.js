/* KoiSignage – Service Worker des Players.
   Hält den Player selbst und alle Mediendateien der Abspielliste offline bereit. */
const SHELL = 'koisignage-shell-v1';
const MEDIA = 'koisignage-media-v1';
let syncRun = 0;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  // Speicher aus der Zeit vor der Umbenennung der App ("sinage-…") freigeben.
  for (const name of await caches.keys()) if (name.startsWith('sinage-')) await caches.delete(name);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/media/')) return event.respondWith(media(req));
  if (url.pathname.startsWith('/player/') || url.pathname.startsWith('/shared/')) return event.respondWith(shell(req));
});

// Player-Dateien: zuerst das Netz (damit Updates ankommen), sonst aus dem Cache.
async function shell(req) {
  const cache = await caches.open(SHELL);
  const cacheKey = new URL(req.url).pathname;
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(cacheKey, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
    throw e;
  }
}

// Medien: aus dem Cache, auch Teilabrufe (Range) für Videos; sonst aus dem Netz.
async function media(req) {
  const cache = await caches.open(MEDIA);
  const hit = await cache.match(new URL(req.url).pathname);
  if (!hit) return fetch(req);
  const range = req.headers.get('range');
  if (!range) return hit;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m || (!m[1] && !m[2])) return hit;
  const blob = await hit.blob();
  let start, end;
  if (m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), blob.size - 1) : blob.size - 1; }
  else { start = Math.max(0, blob.size - Number(m[2])); end = blob.size - 1; }
  if (start > end || start >= blob.size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': hit.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${blob.size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes'
    }
  });
}

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'sync' && Array.isArray(msg.urls)) event.waitUntil(sync(msg.urls));
});

async function broadcast(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clients) client.postMessage(message);
}

// Lädt alle Dateien der Abspielliste vollständig und entfernt, was nicht mehr gebraucht wird.
async function sync(urls) {
  const run = ++syncRun;
  const cache = await caches.open(MEDIA);
  const wanted = new Set(urls);
  for (const req of await cache.keys()) {
    if (!wanted.has(new URL(req.url).pathname)) await cache.delete(req);
  }
  let done = 0;
  for (const url of urls) {
    if (run !== syncRun) return; // eine neuere Liste ist unterwegs
    if (!(await cache.match(url))) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (res.status === 200) await cache.put(url, res);
        else continue;
      } catch (e) {
        continue; // kein Netz oder kein Platz: beim nächsten Abgleich erneut
      }
    }
    done++;
    if (run === syncRun) await broadcast({ type: 'progress', done, total: urls.length });
  }
  if (run === syncRun) await broadcast({ type: 'progress', done, total: urls.length });
}
