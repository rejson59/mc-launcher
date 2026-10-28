/**
 * installer.js – „pierwsze uruchomienie" jak w MojoLauncherze:
 * pobiera build wersji (z mirrorów GitHub) do Cache Storage,
 * weryfikuje SHA-256 z manifest.json (odpowiednik PREF_VERIFY_FILES),
 * trzyma metadane instancji w cache (serde: __meta.json).
 */

import { getCatalogItem, upstreamUrls } from "./catalog.js";

export const CACHE_PREFIX = "mcw-inst-";
const META_KEY = "__meta.json";

export class InstallCancelled extends Error {
  constructor() { super("Anulowano"); this.name = "InstallCancelled"; }
}

function cacheName(instId) { return CACHE_PREFIX + instId; }

/** Absolutny klucz cache dla pliku instancji – identyczny w stronie i w SW. */
export function cacheKeyFor(instId, relPath) {
  const rel = relPath.split("/").map(encodeURIComponent).join("/");
  return `/rt/${encodeURIComponent(instId)}/${rel}`;
}

async function fetchWithMirror(item, relPath, { signal, mirror = "auto" } = {}) {
  const { raw, jsdelivr } = upstreamUrls(item, relPath);
  const order = mirror === "raw" ? ["raw", "jsdelivr"]
    : mirror === "jsdelivr" ? ["jsdelivr", "raw"]
    : ["raw", "jsdelivr"];
  const errors = [];
  for (const key of order) {
    try {
      const res = await fetch(key === "raw" ? raw : jsdelivr, {
        signal, mode: "cors", credentials: "omit", cache: "no-store",
      });
      if (!res.ok) { errors.push(`${key}: HTTP ${res.status}`); continue; }
      const buf = await res.arrayBuffer();
      return { buf, via: key };
    } catch (e) {
      if (e.name === "AbortError") throw e;
      errors.push(`${key}: ${e.message}`);
    }
  }
  throw new Error(`Nie udało się pobrać ${relPath} (${errors.join(" | ")})`);
}

/** Lista plików multi-Instancji: GitHub API, potem data.jsdelivr.com. */
async function listFiles(item, { signal } = {}) {
  const { repo, ref } = item.src;
  const dir = item.src.dirPath.replace(/\/+$/, "");
  // 1) GitHub trees API (CORS: * )
  try {
    const u = `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
    const res = await fetch(u, { signal, headers: { Accept: "application/vnd.github+json" } });
    if (res.ok) {
      const data = await res.json();
      const prefix = dir + "/";
      const files = (data.tree || [])
        .filter((t) => t.type === "blob" && t.path.startsWith(prefix))
        .map((t) => ({ path: t.path.slice(prefix.length), bytes: t.size || 0 }));
      if (files.length) return { files, via: "github" };
    }
  } catch (e) { if (e.name === "AbortError") throw e; }
  // 2) data.jsdelivr.com
  const [owner, name] = repo.split("/");
  const u = `https://data.jsdelivr.com/v1/packages/gh/${owner}/${name}@${ref}?structure=flat`;
  const res = await fetch(u, { signal });
  if (!res.ok) throw new Error(`Lista plików niedostępna (GitHub i jsdelivr): ${res.status}`);
  const data = await res.json();
  const files = (data.files || [])
    .filter((f) => f.name.startsWith(dir + "/"))
    .map((f) => ({ path: f.name.slice(dir.length + 1), bytes: f.size || 0 }));
  if (!files.length) throw new Error("Pusta lista plików buildu.");
  return { files, via: "jsdelivr" };
}

async function sha256(buf) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Nadpisanie ścieżek absolutnych buildu mandoof1 (/app, /build) na relatywne. */
function patchText(relPath, text) {
  if (!/\.(html?|js|json)$/i.test(relPath)) return text;
  // tylko dokumenty wejścia i skrypty hatchera, nie payload gry
  const allow = relPath === "index.html" || /^app\/[^/]+\.js$/.test(relPath)
    || relPath === "build/manifest.json";
  if (!allow) return text;
  return text.replace(/(["'(])\/(app|build)\//g, "$1$2/");
}

function pickMirror(pref) {
  return pref === "auto" ? "raw" : pref;
}

/**
 * Instaluje instancję. Zwraca statystyki { files, bytes, verified }.
 * cb({ phase, done, total, bytes, file }) – pasek postępu.
 */
export async function installInstance(instId, item, {
  signal, mirror = "auto", full = false, onProgress = () => {},
} = {}) {
  if (!item) throw new Error("Brak pozycji katalogu");
  const cache = await caches.open(cacheName(instId));
  onProgress({ phase: "listing", file: item.src.entry });

  let files;
  if (item.kind === "single") {
    files = [{ path: item.src.entry, bytes: item.sizeBytes || 0 }];
  } else {
    const listed = await listFiles(item, { signal });
    files = listed.files;
  }

  // Zawsze pobierzmy też metadane (potrzebne SW do serwowania).
  const meta = {
    catalogId: item.id,
    repo: item.src.repo, ref: item.src.ref, dir: item.src.dirPath,
    entry: item.src.entry, patch: !!item.patch,
    installedAt: Date.now(),
  };
  await cache.put(cacheKeyFor(instId, META_KEY), new Response(JSON.stringify(meta), {
    headers: { "Content-Type": "application/json" },
  }));

  // Zakres pobierania: „pełny" = wszystko; domyślnie – wejście, skrypty
  // hatchera i lekkie pliki (duży payload i tak dociągnie się leniwie
  // przez Service Workera przy starcie gry – licznik widać w HUD-zie).
  const eager = full ? files : files.filter((f) => {
    if (f.path === item.src.entry || f.path === item.manifest) return true;
    if (/^app\//.test(f.path)) return true;
    if (/\.json$/i.test(f.path) && f.bytes < 1_500_000) return true;
    if (/\.(html?|txt|png|css)$/i.test(f.path) && f.bytes < 1_500_000) return true;
    if (/\.js$/i.test(f.path) && f.bytes < 1_500_000) return true;
    return false;
  });

  // weryfikacja SHA-256 z manifestu buildu (jeśli wersja go ma)
  let manifest = null;
  if (item.manifest && item.verifySha256) {
    try {
      const { buf } = await fetchWithMirror(item, item.manifest, { signal, mirror });
      manifest = JSON.parse(new TextDecoder().decode(buf));
      await cache.put(cacheKeyFor(instId, item.manifest), new Response(buf, {
        headers: { "Content-Type": "application/json" },
      }));
    } catch { manifest = null; } // brak manifestu nie blokuje instalacji
  }

  let done = 0, bytes = 0, verified = 0;
  const total = eager.length;
  const log = [];
  for (const f of eager) {
    if (signal?.aborted) throw new InstallCancelled();
    onProgress({ phase: "downloading", done, total, bytes, file: f.path });
    const fkey = cacheKeyFor(instId, f.path);
    const already = await cache.match(fkey);
    if (already && !full) { done++; continue; }
    const { buf, via } = await fetchWithMirror(item, f.path, { signal, mirror: pickMirror(mirror) });
    let out = buf;
    if (manifest?.artifacts?.[f.path]?.sha256) {
      const want = manifest.artifacts[f.path].sha256;
      const got = await sha256(buf);
      if (got !== want) throw new Error(`SHA-256 NIE ZGODNY dla ${f.path}`);
      verified++;
    }
    let body = out;
    const type = contentTypeFor(f.path);
    if (item.patch && /\.(html?|js|json)$/i.test(f.path)) {
      const text = patchText(f.path, new TextDecoder().decode(out));
      body = new TextEncoder().encode(text);
    }
    await cache.put(fkey, new Response(body, {
      headers: { "Content-Type": type || "application/octet-stream", "Content-Length": String(buf.byteLength) },
    }));
    bytes += buf.byteLength;
    done++;
    log.push(`${f.path} (${(buf.byteLength / 1048576).toFixed(1)} MB, ${via})`);
    onProgress({ phase: "downloading", done, total, bytes, file: f.path, log });
  }
  onProgress({ phase: "done", done: total, total, bytes, verified });
  return { files: total, bytes, verified, entry: item.src.entry };
}

/** Czyści cache instancji (odpowiednik usuwania plików gry). */
export async function uninstallInstance(instId) {
  return caches.delete(cacheName(instId));
}

/** Ile bajtów leży w cache instancji (do ekranu ustawień). */
export async function instanceBytes(instId) {
  try {
    const cache = await caches.open(cacheName(instId));
    const keys = await cache.keys();
    let sum = 0;
    for (const req of keys) {
      const res = await cache.match(req);
      if (res) {
        const bl = res.headers.get("content-length");
        if (bl) sum += Number(bl);
        else { try { sum += (await res.clone().arrayBuffer()).byteLength; } catch { /* ignore */ } }
      }
    }
    return sum;
  } catch { return 0; }
}

export function contentTypeFor(path) {
  const ext = (path.split(".").pop() || "").toLowerCase();
  return ({
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
    ogg: "audio/ogg",
    txt: "text/plain; charset=utf-8",
    lang: "text/plain; charset=utf-8",
  })[ext] || "application/octet-stream";
}
