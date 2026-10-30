/**
 * mojang.js – pipeline oryginalnego klienta Minecrafta:
 *  manifest wersji (piston-meta) → plan plików (client, biblioteki, assety)
 *  → pobranie PRZEZ PRZEGLĄDARKĘ (CORS Mojang) ze sprawdzeniem SHA-1
 *  → Cache Storage pod ścieżkami /app/data/vanilla/... (CheerpJ czyta je
 *    przez własny hook fetch i Range).
 *
 * Tu też: ekspansja minecraftArguments (szablony ${auth_player_name}…),
 * offline-UUID, preset options.txt wg AutoRAM (jak MojoLauncher).
 */
import { detectDevice } from "./mojo.js";

export const MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
/**
 * Własny relay na Vercel (api/relay.js w tym repo, projekt mc-launcher-relay):
 * serwer Mojang pobiera po stronie konta Vercel i dokleja CORS `*`.
 * Omija blokady sieciowe ORAZ brak nagłówków CORS na źródle – dlatego jest
 * drugim kandydatem (zaraz po oryginale), a publiczne proxy zostają na szary
 * koniec łańcucha. Nadal obowiązuje weryfikacja SHA-1 po stronie klienta.
 */
const RELAY_BASE = "https://mc-launcher-relay.vercel.app/api/relay?url=";
const RESOLVE_URL = "/resolve?host="; // nasz serwer robi DNS (przeglądarka nie umie)
const CACHE_NAME = "mcl-data-v1";

export const OFFLINE_PROFILE = {
  name: "Gracz",
  accessToken: "0",
  userType: "legacy",
};

/* ---------------- manifest i katalog ---------------- */

let manifestPromise = null;

export async function getManifest() {
  if (manifestPromise) return manifestPromise;
  manifestPromise = (async () => {
    let data = null;
    try {
      const r = await fetchOnce(MANIFEST_URL, { timeoutMs: 12000, cache: "no-cache" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      data = await r.json();
      try { localStorage.setItem("mcw.manifest.v1", JSON.stringify(data)); } catch { /* prywatny tryb */ }
    } catch (e) {
      const fallback = localStorage.getItem("mcw.manifest.v1");
      if (!fallback) throw new Error("Brak manifestu Mojang: " + e.message);
      data = JSON.parse(fallback);
    }
    return data;
  })();
  return manifestPromise;
}

/** Sortowanie po wersji (release rosnąco, bety/alfy najniżej). */
function versionKey(id) {
  const text = id.toLowerCase();
  let kind = 0;
  if (/^[ab]\d/.test(text)) kind = -3;
  else if (/^\d+w/.test(text)) kind = -2;
  const nums = (text.match(/\d+/g) || []).map(Number);
  while (nums.length < 4) nums.push(0);
  return [nums.slice(0, 4), kind];
}
function cmpVersion(a, b) {
  const [na, ka] = versionKey(a), [nb, kb] = versionKey(b);
  for (let i = 0; i < 4; i++) if (na[i] !== nb[i]) return na[i] - nb[i];
  return ka - kb;
}

/** Wersje, które obsługuje nasz silnik (era LWJGL 2 = CheerpJ): do 1.12.2. */
export function supportedVersion(entry) {
  if (entry.type === "old_beta" || entry.type === "old_alpha") return true;
  if (entry.type !== "release") return false;
  const n = entry.id.split(".").map((x) => Number.parseInt(x, 10)).filter((x) => Number.isFinite(x));
  if (n[0] !== 1) return n[0] < 1;
  return (Number.isFinite(n[1]) ? n[1] : 0) <= 12;
}

/** Lista wspieranych wersji, od najnowszej. */
export async function listVersions() {
  const m = await getManifest();
  return m.versions
    .filter(supportedVersion)
    .sort((a, b) => cmpVersion(b.id, a.id));
}

export async function getVersionJson(id) {
  const m = await getManifest();
  const entry = m.versions.find((v) => v.id === id);
  if (!entry) throw new Error("Nieznana wersja: " + id);
  const cache = await caches.open(CACHE_NAME);
  const key = `/app/data/vanilla/${id}/version.json`;
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const vbytes = await robustFetch(entry.url, { sha1: entry.sha1 });
  const data = JSON.parse(new TextDecoder().decode(vbytes));
  await cache.put(key, new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } }));
  return data;
}

/* ---------------- reguły bibliotek (jak w oficjalnym launcherze) ---------------- */

export function rulesAllow(rules) {
  if (!rules || !rules.length) return true;
  let allowed = false;
  for (const rule of rules) {
    let ok = true;
    if (rule.os) ok = ok && (rule.os.name === "linux");
    if (rule.features) ok = false; // demo_user, has_custom_resolution… nie ustawiamy
    if (ok) allowed = rule.action === "allow";
  }
  return allowed;
}

/* ---------------- offline UUID (wersja 3, jak launcher offline) ---------------- */

export async function offlineUuid(name) {
  const enc = new TextEncoder().encode("OfflinePlayer:" + name);
  void crypto;
  return md5Hex(enc);
}

/* md5 dla offline-uuid (RFC1321, cztery rundy z właściwymi rotacjami) */
function md5Hex(bytes) {
  const rot = (x, c) => (x << c) | (x >>> (32 - c));
  const F = (x, y, z) => (x & y) | (~x & z);
  const G = (x, y, z) => (x & z) | (y & ~z);
  const H = (x, y, z) => x ^ y ^ z;
  const I = (x, y, z) => y ^ (x | ~z);
  const wordsLE = (n) => {
    const a = [];
    for (let i = 0; i < 4; i++) a.push((n >>> (8 * i)) & 0xff);
    return a;
  };
  const ml = bytes.length;
  const padded = new Uint8Array((((ml + 8) >> 6) + 1) * 64);
  padded.set(bytes);
  padded[ml] = 0x80;
  const bits = ml * 8;
  padded[padded.length - 8] = bits & 0xff;
  padded[padded.length - 7] = (bits >>> 8) & 0xff;
  padded[padded.length - 6] = (bits >>> 16) & 0xff;
  padded[padded.length - 5] = (bits >>> 24) & 0xff;
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const SHIFTS = [
    [7, 12, 17, 22], [5, 9, 14, 20], [4, 11, 16, 23], [6, 10, 15, 21],
  ];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0;
  const M = new Int32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      M[i] = padded[off + i * 4] | (padded[off + i * 4 + 1] << 8) |
             (padded[off + i * 4 + 2] << 16) | (padded[off + i * 4 + 3] << 24);
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      const round = i >> 4;
      let f, g;
      if (round === 0) { f = F(B, C, D); g = i; }
      else if (round === 1) { f = G(B, C, D); g = (5 * i + 1) % 16; }
      else if (round === 2) { f = H(B, C, D); g = (3 * i + 5) % 16; }
      else { f = I(B, C, D); g = (7 * i) % 16; }
      const tmp = D;
      D = C; C = B;
      const r = (A + f + K[i] + M[g]) | 0;
      B = (B + rot(r, SHIFTS[round][i % 4])) | 0;
      A = tmp;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const hexLE = (n) => wordsLE(n).map((x) => x.toString(16).padStart(2, "0")).join("");
  const raw = hexLE(a0) + hexLE(b0) + hexLE(c0) + hexLE(d0);
  const b = raw.match(/../g).map((x) => parseInt(x, 16)); // 16 bajtów
  b[6] = (b[6] & 0x0f) | 0x30; // wariant 3
  b[8] = (b[8] & 0x3f) | 0x80; // RFC4122
  const h = (i, len) => b.slice(i, i + len).map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h(0, 4)}-${h(4, 2)}-${h(6, 2)}-${h(8, 2)}-${h(10, 6)}`;
}

/* ---------------- pobieranie odporne (lustra + proxy CORS) ---------------- */

/**
 * Kolejka źródeł pliku: oryginał (https), lustro Maven Central (jeśli ścieżka
 * mavenowa), mirror BMCLAPI, a na końcu publiczne proxy dodające CORS.
 * libraries.minecraft.net bywa nieosiągalny z przeglądarki (CORS/sieć) —
 * wtedy ratują proxy, a SHA-1 z manifestu gwarantuje identyczność bajtów.
 */
function fetchCandidates(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl, location.href);
    if (u.protocol === "http:") u.protocol = "https:"; // mixed content na HTTPS
  } catch {
    return [String(rawUrl)]; // URL względny – bez kandydatów zewnętrznych
  }
  const origin = u.toString();
  const list = [origin, RELAY_BASE + encodeURIComponent(origin)];
  if (u.hostname === "libraries.minecraft.net") {
    const path = u.pathname.replace(/^\//, "");
    list.push("https://repo1.maven.org/maven2/" + path);
    list.push("https://bmclapi2.bangbang93.com/maven/" + path);
  }
  list.push(
    "https://api.allorigins.win/raw?url=" + encodeURIComponent(origin),
    "https://proxy.corsfix.com/?" + origin,
    "https://api.codetabs.com/v1/proxy/?quest=" + encodeURIComponent(origin),
    "https://api.cors.lol/?url=" + encodeURIComponent(origin),
  );
  return list;
}

/**
 * Jedno pobranie z twardym watchdogiem: po `timeoutMs` (liczone od wysłania
 * zapytania do końca odczytu ciała) abortujemy – żadne źródło nie zawiesi
 * instalacji w nieskończoności. Własny sygnał anulowania propaguje się od razu.
 */
async function fetchOnce(url, { signal, timeoutMs = 30000, cache = "no-store" } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); throw new DOMException("Anulowano", "AbortError"); }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await fetch(url, { signal: ctrl.signal, cache });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

/**
 * Pobranie bajtów z łańcuchem fallbacku: po 2 próby na źródło (błąd sieci
 * lub timeout = powtórka), HTTP 4xx/5xx lub zły SHA-1 = natychmiast następne
 * źródło. Anulowanie instalacji propaguje się od razu. Zwraca Uint8Array
 * gotowy do Cache Storage.
 */
export async function robustFetch(rawUrl, { signal, sha1, timeoutMs } = {}) {
  const label = (() => {
    try { return new URL(rawUrl, location.href).host; } catch { return "?"; }
  })();
  const trail = new Map(); // host → ostatni błąd (diagnostyka w komunikacie)
  const note = (tag, msg) => {
    const prev = trail.get(tag);
    trail.set(tag, prev ? `${prev}×2` : msg);
  };
  let last = null;
  for (const url of fetchCandidates(rawUrl)) {
    const tag = (() => {
      try { return new URL(url).host; } catch { return "?"; }
    })();
    const isProxy = /allorigins|corsfix|codetabs|cors\.lol|vercel\.app/.test(url);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetchOnce(url, {
          signal,
          timeoutMs: timeoutMs ?? (isProxy ? 60000 : 30000),
        });
        if (!r.ok) { note(tag, `HTTP ${r.status}`); last = new Error(`HTTP ${r.status} (${tag})`); break; }
        const body = new Uint8Array(await r.arrayBuffer());
        if (sha1) {
          const got = await sha1Hex(body);
          if (got !== sha1) { note(tag, "SHA-1 nie zgadza się"); last = new Error(`SHA-1 nie zgadza się (${tag})`); break; }
        }
        if (tag !== label) console.debug("robustFetch", label, "←", tag);
        return body;
      } catch (e) {
        // tylko anulowanie przez użytkownika przerywa łańcuch;
        // timeout watchdogu (AbortError) = to źródło nie żyje, jedziemy dalej
        if (signal?.aborted) throw e;
        note(tag, e?.message || String(e));
        last = e;
      }
    }
  }
  const detail = [...trail].map(([t, m]) => `${t}=${m}`).join(" | ").slice(0, 400);
  throw new Error(`${label}: ${detail || last?.message || "nie udało się pobrać"}`);
}

/* ---------------- plan startu ---------------- */

/** Rozwiązuje reguły/biblioteki/assety – czyste dane do instalacji i startu. */
export async function resolvePlan(id) {
  const ver = await getVersionJson(id);
  const libs = [];
  for (const lib of ver.libraries || []) {
    if (!rulesAllow(lib.rules)) continue;
    const art = lib.downloads?.artifact;
    if (art) libs.push({ name: lib.name, path: art.path, url: art.url, sha1: art.sha1, size: art.size });
  }
  const client = ver.downloads?.client;
  if (!client) throw new Error("Brak pliku client dla " + id);
  const ai = ver.assetIndex;
  return {
    id,
    type: ver.type || "release",
    mainClass: ver.mainClass,
    javaMajor: ver.javaVersion?.majorVersion || 8,
    client,
    libs,
    assetIndex: ai,
    mappings: ver.downloads?.clientMappings || null,
    hasArgsTemplate: Boolean(ver.minecraftArguments),
    minecraftArguments: ver.minecraftArguments || "",
    time: ver.time,
  };
}

async function sha1Hex(buf) {
  const d = await crypto.subtle.digest("SHA-1", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function cachePut(cache, key, body, sha1) {
  const bytes = new Uint8Array(body);
  if (sha1) {
    const got = await sha1Hex(bytes);
    if (got !== sha1) throw new Error(`SHA-1 nie zgadza się dla ${key} (${got} ≠ ${sha1})`);
  }
  await cache.put(key, new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } }));
  return bytes.length;
}

/** Czy wersja jest już w cache (client + biblioteki + indeks assetów). */
export async function installedInfo(id) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const meta = await cache.match(`/app/data/vanilla/${id}/__meta.json`);
    if (!meta) return null;
    return await meta.json();
  } catch { return null; }
}

/**
 * Instalacja: pobiera wszystko, pilnuje SHA-1, zapisuje w cache.
 * onProgress(faza, zrobione, wszystko, bajty).
 */
export async function installInstance(id, { signal, onProgress } = {}) {
  const plan = await resolvePlan(id);
  const cache = await caches.open(CACHE_NAME);
  const base = `/app/data/vanilla/${id}`;
  const report = (phase, done, total, bytes) => onProgress?.(phase, done, total, bytes || 0);

  const jobs = [];
  const state = { bytes: 0, done: 0 };
  const addJob = (key, url, sha1, size, phase) => jobs.push({ key, url, sha1, size, phase });
  addJob(`${base}/client.jar`, plan.client.url, plan.client.sha1, plan.client.size, "klient");
  for (const lib of plan.libs) addJob(`${base}/libraries/${lib.path}`, lib.url, lib.sha1, lib.size, "biblioteki");

  // asset index najpierw (weryfikowany od razu), bo dopiero on znamy obiekty
  const idxBody = await robustFetch(plan.assetIndex.url, { signal, sha1: plan.assetIndex.sha1 });
  state.bytes += await cachePut(cache, `${base}/assets/indexes/${plan.assetIndex.id}.json`,
    idxBody, plan.assetIndex.sha1);
  state.done++;
  report("indeks assetów", state.done, jobs.length + 1, state.bytes);
  const idx = JSON.parse(new TextDecoder().decode(idxBody));

  const objects = Object.values(idx.objects || {});
  for (const o of objects) {
    const h = o.hash;
    addJob(`${base}/assets/objects/${h.slice(0, 2)}/${h}`,
      `https://resources.download.minecraft.net/${h.slice(0, 2)}/${h}`, h, o.size, "assety");
  }
  if (plan.mappings) addJob(`${base}/client.mappings`, plan.mappings.url, plan.mappings.sha1, plan.mappings.size, "mapowania");

  const total = jobs.length + 1;
  let cursor = 0;
  const workers = [];
  const fail = [];
  const runOne = async () => {
    while (true) {
      if (signal?.aborted) throw new DOMException("Anulowano", "AbortError");
      const i = cursor++;
      if (i >= jobs.length) return;
      const j = jobs[i];
      try {
        const hit = await cache.match(j.key);
        if (hit) {
          const buf = await hit.arrayBuffer();
          if (j.sha1 && (await sha1Hex(buf)) === j.sha1) {
            state.done++; state.bytes += buf.byteLength;
            report(j.phase, state.done, total, state.bytes);
            continue;
          }
        }
        const body = await robustFetch(j.url, { signal, sha1: j.sha1 });
        state.bytes += await cachePut(cache, j.key, body, j.sha1);
        state.done++;
        report(j.phase, state.done, total, state.bytes);
      } catch (e) {
        if (e.name === "AbortError") throw e;
        fail.push(`${j.key}: ${e.message}`);
        if (fail.length > 6) throw new Error(fail.slice(0, 3).join("; ")); // prefiks daje ui.js
      }
    }
  };
  for (let i = 0; i < 6; i++) workers.push(runOne());
  await Promise.all(workers);
  if (fail.length) throw new Error(`Nieudane pliki (${fail.length}): ${fail[0]}`);

  /* --- poprawki klienta (dla1.12.2: zestaw znany z testów portu) --- */
  let patched = false;
  try {
    const { applyPatches } = await import("./patcher.js");
    const clientHit = await cache.match(`${base}/client.jar`);
    const bytes = new Uint8Array(await clientHit.arrayBuffer());
    const result = await applyPatches(id, bytes, async () => {
      const m = await cache.match(`${base}/client.mappings`);
      return m ? await m.text() : null;
    });
    if (result) {
      await cache.put(`${base}/client-patched.jar`,
        new Response(result, { headers: { "Content-Type": "application/octet-stream" } }));
      patched = true;
    }
  } catch (e) {
    console.warn("[mojang] patching pominięty:", e);
  }

  const info = {
    id, files: total, bytes: state.bytes, patched,
    installedAt: Date.now(), mainClass: plan.mainClass,
    assetIndexId: plan.assetIndex.id, assetIndexFlags: {
      virtual: !!idx.virtual, mapToResources: !!idx.map_to_resources,
    },
    assets: objects.length,
  };
  await cache.put(`${base}/__meta.json`, new Response(JSON.stringify(info), { headers: { "Content-Type": "application/json" } }));
  return info;
}

/** Identyfikatory zainstalowanych wersji (po meta-plikach w cache). */
export async function listInstalledIds() {
  const cache = await caches.open(CACHE_NAME);
  const ids = new Set();
  for (const r of await cache.keys()) {
    const m = /\/app\/data\/vanilla\/([^/]+)\/__meta\.json$/.exec(new URL(r.url).pathname);
    if (m) ids.add(decodeURIComponent(m[1]));
  }
  return [...ids];
}

export async function uninstallInstance(id) {
  const cache = await caches.open(CACHE_NAME);
  const keys = (await cache.keys()).map((r) => r.url);
  const prefix = new URL(`/app/data/vanilla/${id}/`, location.href).href;
  let n = 0;
  for (const u of keys) if (u.startsWith(prefix)) { await cache.delete(u); n++; }
  return n;
}

export async function instancesBytes() {
  const cache = await caches.open(CACHE_NAME);
  let total = 0;
  for (const r of await cache.keys()) {
    if (!/\/app\/data\/vanilla\//.test(r.url)) continue;
    const h = await (await cache.match(r)).arrayBuffer();
    total += h.byteLength;
  }
  return total;
}

/* ---------------- argumenty startu ---------------- */

const DEFAULT_ARGS = [
  "--username", "${auth_player_name}", "--version", "${version_name}",
  "--gameDir", "${game_directory}", "--assetsDir", "${assets_root}",
  "--assetIndex", "${assets_index_name}", "--uuid", "${auth_uuid}",
  "--accessToken", "${auth_access_token}", "--userType", "${user_type}",
  "--versionType", "${version_type}",
];

export function buildArgs(plan, profile, verType) {
  const tpl = plan.hasArgsTemplate ? plan.minecraftArguments.split(/\s+/) : DEFAULT_ARGS;
  const tokens = {
    auth_player_name: profile.name,
    version_name: plan.id,
    game_directory: "/files/minecraft",
    assets_root: `/files/minecraft/vanilla/${plan.id}/assets`,
    assets_index_name: plan.assetIndex.id,
    auth_uuid: profile.uuid,
    auth_access_token: profile.accessToken,
    auth_session: profile.accessToken + ":" + profile.userType,
    user_properties: "{}",
    user_type: profile.userType,
    version_type: verType || plan.type || "release",
    game_assets: `/files/minecraft/vanilla/${plan.id}/assets/virtual/${plan.assetIndex.id}`,
    resolution_width: "1280", resolution_height: "720",
    launcher_name: "mc-launcher-web", launcher_version: "1.0",
    clientid: "0", auth_xuid: "0",
  };
  const out = [];
  for (const raw of tpl) {
    if (!raw.includes("${")) { out.push(raw); continue; }
    const filled = raw.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (_, k) => (k in tokens ? tokens[k] : "\u0000"));
    if (filled.includes("\u0000")) continue; // niewypełniony token → wyrzucamy całe słowo
    out.push(filled);
  }
  // bardzo stare wersje bez szablonu i z mainClass net.minecraft.client.Minecraft
  if (!plan.hasArgsTemplate && plan.mainClass === "net.minecraft.client.Minecraft") return [];
  return out;
}

/** Preset options.txt w duchu AutoRAM MojoLaunchera (rd, fps, fancy, fbo). */
export function buildOptionsPreset(prefs) {
  const dev = detectDevice();
  const rd = prefs.rd ?? (dev.powerful ? 6 : dev.mid ? 4 : 2);
  const fps = prefs.maxFps ?? (dev.powerful ? 120 : 60);
  const fancy = prefs.fancy ?? false;
  return [
    "ao:0", `renderDistance:${rd}`, "enableVsync:false", "guiScale:0",
    `maxFps:${fps}`, `fancyGraphics:${fancy ? "true" : "false"}`,
    "mipmapLevels:0", "particles:1", "fboEnable:false", "useVbo:false",
    "renderClouds:false", "lang:pl_PL", "autoJump:true", "mouseSensitivity:0.5",
    "gamma:0.15",
  ].join("\n") + "\n";
}

export { RESOLVE_URL, CACHE_NAME as MOJANG_CACHE };
