/**
 * sw.js – skromny Service Worker: powłoka aplikacji do offline + stary
 * porządek czyszczony. Pliki gry CheerpJ-owi serwuje hook `fetch`
 * z js/game.js prosto z Cache Storage (z obsługą Range), więc tutaj
 * NIC nie ruszamy dla /app/data/* (przepuszczenie = serwer/strona robi swoje).
 */
const SHELL = "mcl-shell-v4";

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
      if (k !== SHELL && k !== "mcl-data-v1") await caches.delete(k);
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

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // POST /resolve i inne – serwer
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // piston-mojang itd. idą wprost

  // gry: /app/data/* obsługuje strona (cjFetch) – przepuść
  if (url.pathname.startsWith("/app/")) return;
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
