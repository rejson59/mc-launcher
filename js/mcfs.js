/**
 * mcfs.js – migracja danych gry do mountu /files (IndexedDB) CheerpJ-a.
 *
 * Dlaczego: CheerpJ 4 czyta /app/ przez HTTP do ROOTA serwera (docs:
 * „/app/ is the root of your web server"), a my siedzimy w podkatalogu
 * GitHub Pages → scope Service Workera nie sięga origin-root, a opcji
 * `fetch` w cheerpjInit już nie ma → client.jar =404 („Could not find or
 * load main class"). Jedyny kanał pewny niezależnie od hosta to /files/ –
 * trwały IndexedDB czytany przez VFS CheerpJ-a wprost, bez HTTP.
 *
 * Zapis (trzy warstwy, bo cheerpOSOpen na zagnieżdżonej ścieżce bez katalogów
 * rodziców zwraca fd=-1 – stock 4.3 nie tworzy rodziców sam):
 *   1. katalogi: java.io.File.mkdirs przez library mode (nio z bugiem na 4.3),
 *   2. plik: cheerpOSOpen/Write/Close (wzorzec browsercraft, root /files ✓),
 *   3. fallback: cheerpOSAddStringFile → /str (dokumentowany, Uint8Array)
 *      + kopiowanie JAVĄ (FileInputStream → FileOutputStream, bufor 64 KB)
 *      i weryfikacja length() == spodziewany rozmiar.
 * Znacznik .ready (cjFileBlob, JSON installedAt/patched) = kopia jednorazowa.
 */
import { MOJANG_CACHE } from "./mojang.js";

export const MC_ROOT = "/files/minecraft";

const NATIVES = [
  { name: "liblwjgl.so", url: "vendor/lwjgl/liblwjgl.so" },
  { name: "gl4es.wasm", url: "vendor/lwjgl/gl4es.wasm" },
];
const STR_TMP = "/str/mcfs.tmp";
const COPY_BUF = 65536;

function withTimeout(p, ms, label) {
  let timer;
  return Promise.race([
    p,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout ${ms} ms: ${label}`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// library-mode: boolean Javy przechodzi jako 1/0 (a stare API jako {value0}).
function truthy(v) {
  if (v === true || v === 1) return true;
  return v?.value0 === true || v?.value0 === 1;
}

let libJava = null;
async function javaLib() {
  if (!libJava) {
    if (typeof window.cheerpjRunLibrary !== "function") {
      throw new Error("brak cheerpjRunLibrary (CheerpJ niezainicjowany?)");
    }
    libJava = await window.cheerpjRunLibrary("");
  }
  return libJava;
}

/** Zapis bajtów do VFS (stare API JS → /files; benchmark: browsercraft). */
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

/** Tworzy katalogi (java.io.File.mkdirs – rekurencyjnie, idempotentnie). */
async function ensureDirs(dirs) {
  const lib = await javaLib();
  const File = await lib.java.io.File;
  let created = 0;
  for (const d of dirs) {
    const f = await new File(d);
    const ok = await f.mkdirs();
    if (truthy(ok)) { created++; continue; } // utworzony
    const ex = await f.exists(); // 0 = istniał wcześniej albo realna awaria
    if (!truthy(ex)) throw new Error(`mkdirs: ${d} (ok=${String(ok)}, exists=${String(ex)})`);
  }
  return created;
}

/** Fallback: kopiowanie /str → /str→/files JAVĄ (czyste java.io). */
async function javaCopyFromStr(dstPath, expected) {
  const lib = await javaLib();
  const File = await lib.java.io.File;
  const FileInputStream = await lib.java.io.FileInputStream;
  const FileOutputStream = await lib.java.io.FileOutputStream;
  const parent = dstPath.slice(0, dstPath.lastIndexOf("/")) || "/files";
  const df = await new File(parent);
  const okM = await df.mkdirs();
  if (!truthy(okM) && !truthy(await df.exists())) {
    throw new Error(`mkdirs: ${parent} (ok=${String(okM)})`);
  }
  const fin = await new FileInputStream(STR_TMP);
  try {
    const out = await new FileOutputStream(dstPath);
    try {
      const ArrayCls = await lib.java.lang.reflect.Array;
      const Byte = await lib.java.lang.Byte;
      const buf = await ArrayCls.newInstance(await Byte.TYPE, COPY_BUF);
      let guard = Math.ceil(expected / COPY_BUF) + 16;
      while (guard-- > 0) {
        const n = await fin.read(buf);
        if (typeof n !== "number") throw new Error(`read zwróciło ${typeof n}, nie number`);
        if (n <= 0) break;
        await out.write(buf, 0, n);
      }
      if (guard < 0) throw new Error("pętla kopiowania przekroczyła gwarancję");
    } finally { await out.close(); }
  } finally { await fin.close(); }
  const got = Number(await new File(dstPath).length());
  if (got !== expected) throw new Error(`rozmiar po kopiowaniu ${got} ≠ ${expected}`);
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
    v: 2, natives: 1, installedAt: meta.installedAt, patched: !!meta.patched,
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

  /* --- katalogi rodzice (bez nich cheerpOSOpen daje fd=-1) --- */
  const dirs = new Set([MC_ROOT, `${MC_ROOT}/natives`, base]);
  for (const j of jobs) dirs.add(j.dst.slice(0, j.dst.lastIndexOf("/")) || MC_ROOT);
  try {
    log?.(`katalogi: ${dirs.size} – mkdirs…`);
    const created = await withTimeout(ensureDirs([...dirs]), 60000, "mkdirs");
    log?.(`katalogi: ${dirs.size} (nowe: ${created})`);
  } catch (e) {
    log?.(`mkdirs nie doszedł (${e?.message || e}) – piszę mimo to`);
  }

  const total = jobs.length;
  log?.(`zadań kopiowania: ${total}`);
  let done = 0;
  let bytes = 0;
  let fallback = 0;
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
    try {
      await withTimeout(cjWrite(j.dst, data), 30000, j.dst);
    } catch (e) {
      fallback++;
      if (fallback <= 3) log?.(`cjWrite: ${e?.message} → fallback /str+java.io`);
      window.cheerpOSAddStringFile(STR_TMP, data);
      await withTimeout(javaCopyFromStr(j.dst, data.byteLength), 60000, "javaCopy " + j.dst);
    }
    done++;
    bytes += data.byteLength;
    if (done % 100 === 0 || done === total) {
      log?.(`${done}/${total} plików · ${(bytes / 1048576).toFixed(1)} MB`);
      report();
    }
  }
  await withTimeout(cjWrite(stampPath, new TextEncoder().encode(stampWant)), 8000, "stamp");
  report();
  log?.(`gotowe: ${total} plików · ${(bytes / 1048576).toFixed(1)} MB → ${MC_ROOT} (fallback: ${fallback})`);
  return { total, bytes, fallback };
}
