/**
 * sw.js – skromny Service Worker: powłoka aplikacji do offline + stary
 * porządek czyszczony.
 *
 * KANAŁ DANYCH GRY (krytyczny): CheerpJ NIE ma hooka `fetch` w v4 – mount
 * `/app/` to zwykły HTTP do roota serwera, a `overrideDocumentBase`/baza
 * dokumentu sprawiają, że żądanie leci w naszą podstronę
 * (`/mc-launcher/data/vanilla/...`). Tylko SW (scope podstrony) może je
 * obsłużyć z Cache Storage z obsługą Range (206) – inaczej GitHub Pages
 * zwraca 04 i JVM nie wczytuje client.jar („Could not find main class").
 * Hook w js/game.js (cjFetch) zostaje jako pas bezpieczeństwa dla form
 * ścieżek, które trafiają do okna.
 */
const SHELL = "mcl-shell-v7";
const GAME_DATA = "mcl-data-v1";

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll([
      "./", "./index.html", "./css/style.css",
      "./js/main.js", "./js/ui.js", "./js/game.js", "./js/mojo.js",
      "./js/catalog.js", "./js/mojang.js", "./js/store.js",
      "./js/netshim.js", "./js/patcher.js",
      "./assets/hero.png",
    ]).catch(() => {/* część plików może nie mieć dopasowania – nie blokuj */});
    // sprzątanie po starym Eagler-podejściu
    for (const k of await caches.keys()) {
      if (k !== SHELL && k !== GAME_DATA) await caches.delete(k);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.purge) caches.delete(SHELL);
  if (d["purge-all"]) caches.keys().then((ks) => ks.forEach((k) => caches.delete(k)));
});

/* ---------------- dane gry: /app/ (virtual) → Cache Storage + Range ------------- */

const gameBuffers = new Map(); // ścieżka → ArrayBuffer (unikat Range bez czytania całości co raz)

/** Normalizacja dowolnej formy żądania do klucza z instalacji: /app/data/vanilla/… */
function gameKey(pathname) {
  let p = pathname;
  const i = p.search(/\/(?:app\/)?data\/vanilla\//);
  if (i < 0) return null;
  p = p.slice(i);
  try { p = decodeURIComponent(p); } catch { /* jw */ }
  return p.startsWith("/app/") ? p : "/app" + p;
}

function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;
  let start, end;
  if (!m[1]) { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
  if (start > end || start >= size) return "unsat";
  return { start, end };
}

let logBudget = 100; // ile linii diagnostyki wydać na logi żądań gry
function swLog(msg) {
  if (logBudget-- <= 0) return;
  self.clients.matchAll()
    .then((cs) => cs.forEach((c) => c.postMessage({ src: "mcw-sw", ev: "fetchlog", msg })))
    .catch(() => {});
}

async function serveGame(req, url) {
  const key = gameKey(url.pathname);
  if (!key) return fetch(req); // spoza danych – nie ruszamy
  const cache = await caches.open(GAME_DATA);
  let hit = await cache.match(key);
  if (!hit) {
    swLog(`MISS ${key} (żądano ${url.pathname})`);
    return fetch(req); // brak pliku = prawdziwe 404 (Java dostaje FileNotFoundException)
  }
  swLog(`HIT  ${key}`);
  let buf = gameBuffers.get(key);
  if (!buf) {
    buf = await hit.arrayBuffer();
    if (gameBuffers.size > 12) gameBuffers.clear();
    gameBuffers.set(key, buf);
  }
  if (req.method === "HEAD") {
    return new Response(null, { status: 200, headers: { "Content-Length": String(buf.byteLength), "Accept-Ranges": "bytes" } });
  }
  const range = parseRange(req.headers.get("Range"), buf.byteLength);
  if (range === "unsat") {
    return new Response("", { status: 416, headers: { "Content-Range": `bytes */${buf.byteLength}` } });
  }
  if (!range) {
    return new Response(buf, { status: 200, headers: { "Content-Length": String(buf.byteLength), "Accept-Ranges": "bytes" } });
  }
  const slice = buf.slice(range.start, range.end + 1);
  return new Response(slice, {
    status: 206,
    headers: {
      "Content-Range": `bytes ${range.start}-${range.end}/${buf.byteLength}`,
      "Content-Length": String(slice.byteLength),
      "Accept-Ranges": "bytes",
    },
  });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" && req.method !== "HEAD") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // dane gry CheerpJ-a (bez względu na to, czy przyszło z prefiksem /app/)
  if (/\/(?:app\/)?data\/vanilla\//.test(url.pathname)) {
    e.respondWith(serveGame(req, url).catch((err) => {
      swLog(`ERR  ${url.pathname}: ${err && err.message}`);
      return new Response("", { status: 500 });
    }));
    return;
  }
  if (req.method === "HEAD") return;

  // pliki origin: zwykły fetch (serwer ma Range + MIME) – cache strony powłoki
  const isShell = /\.(js|css|png|html)$/.test(url.pathname) || url.pathname === "/";
  if (!isShell) return;

  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(req, { ignoreSearch: url.pathname === "/" });
    if (hit) {
      // revaliduj w tle (stale-while-revalidate)
      fetch(req).then((r) => r.ok && cache.put(req, r.clone())).catch(() => {});
      return hit;
    }
    try {
      const r = await fetch(req);
      if (r.ok) cache.put(req, r.clone());
      return r;
    } catch (err) {
      const fallback = await cache.match("./index.html");
      if (fallback && req.mode === "navigate") return fallback;
      throw err;
    }
  })());
});
