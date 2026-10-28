/**
 * sw.js – serwer instancji gry.
 *
 * Mapuje /rt/<instId>/<ścieżka> na Cache Storage instancji.
 * Pudło (pierwsze uruchomienie / leniwe pliki) → pobranie z mirrorów
 * GitHuba (raw.githubusercontent → jsdelivr), z wymuszeniem poprawnego
 * Content-Type i opcjonalnym spławianiem ścieżek absolutnych (/app, /build).
 * Wszystko serwowane jest z originu launchera – gra myśli, że jest offline.
 */

const CACHE_PREFIX = "mcw-inst-";
const META_KEY = "__meta.json";

const MIME = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  css: "text/css; charset=utf-8",
  wasm: "application/wasm",
  epk: "application/octet-stream",
  epw: "application/octet-stream",
  map: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  ogg: "audio/ogg",
  txt: "text/plain; charset=utf-8",
  lang: "text/plain; charset=utf-8",
};

function contentTypeFor(path) {
  const ext = (path.split(".").pop() || "").toLowerCase();
  return MIME[ext] || "application/octet-stream";
}

function patchText(relPath, text) {
  if (!/\.(html?|js|json)$/i.test(relPath)) return text;
  const allow = relPath === "index.html" || /^app\/[^/]+\.js$/.test(relPath)
    || relPath === "build/manifest.json";
  if (!allow) return text;
  return text.replace(/(["'(])\/(app|build)\//g, "$1$2/");
}

function encPath(rel) {
  return rel.split("/").map(encodeURIComponent).join("/");
}

/* liczniki bajtów: instancja -> { n } (trzymane w pamięci SW, sumy
   odtwarzane z content-length przy zapytaniu stats) */
const inflight = new Map();

async function getMeta(cache, instId) {
  const res = await cache.match(`/rt/${encodeURIComponent(instId)}/${META_KEY}`);
  if (!res) return null;
  try { return await res.json(); } catch { return null; }
}

async function upstreamFetch(meta, relPath) {
  const rel = encPath(relPath);
  const bases = [
    `https://raw.githubusercontent.com/${meta.repo}/${meta.ref}/${meta.dir}/${rel}`,
    `https://cdn.jsdelivr.net/gh/${meta.repo}@${meta.ref}/${meta.dir}/${rel}`,
  ];
  let lastErr = "";
  for (const url of bases) {
    try {
      const res = await fetch(url, { mode: "cors", credentials: "omit" });
      if (!res.ok) { lastErr = `${res.status} (${url.includes("jsdelivr") ? "jsdelivr" : "raw"})`; continue; }
      return res;
    } catch (e) { lastErr = e.message; }
  }
  return new Response(
    `<!doctype html><meta charset="utf-8"><body style="background:#14150f;color:#e7e6d8;font-family:monospace;padding:2em">
     <h1>Plik niedostępny</h1><p>Nie udało się pobrać <b>${relPath}</b> z mirrorów: ${lastErr}</p>
     <p>Spróbuj ponownie – repozytorium źródłowe mogło zostać zablokowane (DMCA) lub sieć nie odpowiada.</p>`,
    { status: 502, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

async function serveFromCacheOrNetwork(event) {
  const url = new URL(event.request.url);
  const parts = url.pathname.split("/").filter(Boolean); // ['rt', instId, ...rel]
  if (parts[0] !== "rt" || !parts[1]) return null;
  const instId = decodeURIComponent(parts[1]);
  let relPath = parts.slice(2).map(decodeURIComponent).join("/");

  const cache = await caches.open(CACHE_PREFIX + instId);
  const meta = await getMeta(cache, instId);
  if (!meta) {
    return new Response(
      `<!doctype html><meta charset="utf-8"><body style="background:#14150f;color:#e7e6d8;font-family:monospace;padding:2em">
       <h1>Instancja nie jest zainstalowana</h1><p>Wróć do launchera i uruchom instalację.</p>`,
      { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
  if (!relPath || relPath.endsWith("/")) relPath = (relPath + meta.entry).replace(/^\/+/, "");

  const cacheKey = new Request(url.origin + "/rt/" + encodeURIComponent(instId) + "/" + encPath(relPath));
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  // leniwe pobranie (duże klasy, assety…) – deduplikacja równoległych żądań
  const dedupKey = instId + "::" + relPath;
  if (!inflight.has(dedupKey)) {
    inflight.set(dedupKey, (async () => {
      const up = await upstreamFetch(meta, relPath);
      const buf = await up.arrayBuffer();
      let body = buf;
      if (meta.patch && /\.(html?|js|json)$/i.test(relPath)) {
        body = new TextEncoder().encode(patchText(relPath, new TextDecoder().decode(buf)));
      }
      const headers = {
        "Content-Type": contentTypeFor(relPath),
        "Content-Length": String(buf.byteLength),
        "Cache-Control": "no-store",
      };
      const resp = new Response(body, { status: 200, headers });
      await cache.put(cacheKey, resp.clone());
      broadcastBytes(instId, buf.byteLength);
      return resp;
    })().finally(() => inflight.delete(dedupKey)));
  }
  return inflight.get(dedupKey);
}

async function broadcastBytes(instId, added) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const c of clients) c.postMessage({ src: "mcw-sw", ev: "bytes", instId, added });
}

self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith("/rt/")) return;
  if (event.request.method !== "GET") return;
  event.respondWith((async () => {
    const r = await serveFromCacheOrNetwork(event);
    return r || new Response("Brak", { status: 404 });
  })());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.t === "purge") {
    event.waitUntil(caches.delete(CACHE_PREFIX + data.instId));
  }
  if (data.t === "purge-all") {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX)).map((k) => caches.delete(k)));
    })());
  }
});
