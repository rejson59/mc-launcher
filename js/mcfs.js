/**
 * mcfs.js – migracja danych gry do mountu /files (IndexedDB) CheerpJ-a.
 *
 * Dlaczego: CheerpJ 4 czyta /app/ przez HTTP do ROOTA serwera (docs:
 * „/app/ is the root of your web server"), a my siedzimy w podkatalogu
 * GitHub Pages → scope Service Workera nie sięga origin-root, a opcji
 * `fetch` w cheerpjInit już nie ma → client.jar =404 („Could not find or
 * load main class"). Jedyny kanał pewny niezależnie od hosta to /files/ –
 * trwały IndexedDB czytany przez VFS CheerpJ-a wprost, bez HTTP.
 * Wzorzec: leaningtech/browsercraft trzyma client.jar właśnie w /files/.
 *
 * Przenosimy jednorazowo (ze znacznikiem .ready porównywanym z installedAt):
 *  - natywy + gl4es → /files/minecraft/natives/ (pod java.library.path i `libraries`),
 *  - client.jar + biblioteki (źródło: Cache Storage instalacji),
 *  - assety w wariancie właściwym dla wersji: objects+indexes (domyślnie),
 *    virtual/ (idx.virtual) lub resources/ (idx.map_to_resources ≤1.5).
 * Odczyt znacznika przez cjFileBlob; brak/zmiana = pełna kopia ponownie.
 */
import { MOJANG_CACHE } from "./mojang.js";

export const MC_ROOT = "/files/minecraft";

const NATIVES = [
  { name: "liblwjgl.so", url: "vendor/lwjgl/liblwjgl.so" },
  { name: "gl4es.wasm", url: "vendor/lwjgl/gl4es.wasm" },
];

function withTimeout(p, ms, label) {
  let timer;
  return Promise.race([
    p,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout ${ms} ms: ${label}`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Zapis bajtów do VFS CheerpJ (wzorzec browsercraft: Open/Write/Close). */
function cjWrite(path, bytes) {
  return new Promise((resolve, reject) => {
    try {
      const fds = [];
      window.cheerpOSOpen(fds, path, "w", (fd) => {
        if (fd == null || fd < 0) { reject(new Error(`cheerpOSOpen fd=${fd} (${path})`)); return; }
        window.cheerpOSWrite(fds, fd, bytes, 0, bytes.length, () => {
          window.cheerpOSClose(fds, fd, () => resolve());
        });
      });
    } catch (e) { reject(e); }
  });
}

async function stampMatches(path, want) {
  if (typeof window.cjFileBlob !== "function") return false;
  try {
    const b = await withTimeout(window.cjFileBlob(path), 8000, "cjFileBlob " + path);
    if (!b || !b.size) return false;
    return (await b.text()) === want;
  } catch { return false; }
}

/**
 * Kopiuje dane wersji z Cache Storage (i pliki natywne z repo) do /files.
 * Zwraca {skipped} gdy znacznik .ready jest zgodny.
 */
export async function ensureGameFiles(id, meta, plan, { log, onProgress } = {}) {
  const base = `${MC_ROOT}/vanilla/${id}`;
  const stampPath = `${base}/.ready`;
  const stampWant = JSON.stringify({
    v: 1, natives: 1, installedAt: meta.installedAt, patched: !!meta.patched,
  });

  if (await stampMatches(stampPath, stampWant)) {
    log?.("znacznik .ready zgodny – kopia pominięta");
    return { skipped: true };
  }
  log?.("kopiuję dane wersji Cache → /files (jednorazowo)");

  const cache = await caches.open(MOJANG_CACHE);
  const vsrc = (p) => `/app/data/vanilla/${id}/${p}`; // klucze z instalacji
  const jobs = [];
  const add = (dst, src, url) => jobs.push({ dst, src, url });

  for (const n of NATIVES) add(`${MC_ROOT}/natives/${n.name}`, null, n.url);
  const jar = meta.patched ? "client-patched.jar" : "client.jar";
  add(`${base}/${jar}`, vsrc(jar));
  for (const l of plan.libs) add(`${base}/libraries/${l.path}`, vsrc(`libraries/${l.path}`));

  const idxKey = vsrc(`assets/indexes/${plan.assetIndex.id}.json`);
  const idxResp = await cache.match(idxKey);
  if (!idxResp) throw new Error(`brak indeksu assetów w cache (${idxKey})`);
  const idx = await idxResp.json();
  const flags = meta.assetIndexFlags || {};
  add(`${base}/assets/indexes/${plan.assetIndex.id}.json`, idxKey);
  const objs = idx.objects || {};
  const objSrc = (o) => vsrc(`assets/objects/${o.hash.slice(0, 2)}/${o.hash}`);
  if (flags.virtual) {
    const vbase = `${base}/assets/virtual/${plan.assetIndex.id}`;
    for (const [rel, o] of Object.entries(objs)) add(`${vbase}/${rel}`, objSrc(o));
  } else if (flags.mapToResources) {
    for (const [rel, o] of Object.entries(objs)) add(`${MC_ROOT}/resources/${rel}`, objSrc(o));
  } else {
    for (const o of Object.values(objs)) {
      add(`${base}/assets/objects/${o.hash.slice(0, 2)}/${o.hash}`, objSrc(o));
    }
  }

  const total = jobs.length;
  log?.(`zadań kopiowania: ${total}`);
  let done = 0;
  let bytes = 0;
  const report = () => onProgress?.(done, total, bytes);
  report();

  for (const j of jobs) {
    let data;
    if (j.url) {
      const r = await fetch(j.url, { cache: "no-cache" });
      if (!r.ok) throw new Error(`${j.url} → HTTP ${r.status}`);
      data = new Uint8Array(await r.arrayBuffer());
    } else {
      const resp = await cache.match(j.src);
      if (!resp) throw new Error(`brak w cache: ${j.src}`);
      data = new Uint8Array(await resp.arrayBuffer());
    }
    await withTimeout(cjWrite(j.dst, data), 30000, j.dst);
    done++;
    bytes += data.byteLength;
    if (done % 100 === 0 || done === total) {
      log?.(`${done}/${total} plików · ${(bytes / 1048576).toFixed(1)} MB`);
      report();
    }
  }
  await withTimeout(cjWrite(stampPath, new TextEncoder().encode(stampWant)), 8000, "stamp");
  report();
  log?.(`gotowe: ${total} plików · ${(bytes / 1048576).toFixed(1)} MB → ${MC_ROOT}`);
  return { total, bytes };
}
