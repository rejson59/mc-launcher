/**
 * game.js – uruchomienie NIEZMODYFIKOWANEGO klienta Mojang w przeglądarce:
 *   CheerpJ (JVM w WASM) + gl4es (GL→WebGL, jak w MojoLauncherze) +
 *   wasm-LWJGL z browsercraft (Apache-2.0).
 *
 * Klient, biblioteki i assety są pobierane z serwerów Mojang przez instalację
 * (js/mojang.js) i serwowane CheerpJ-owi z Cache Storage przez hook `fetch`.
 * Multiplayer idzie przez nasz gateway (/gw) podłączony nativesami z netshim.
 */
import { toast, swReady } from "./ui.js";
import {
  resolvePlan, buildArgs, buildOptionsPreset, installedInfo, MOJANG_CACHE,
} from "./mojang.js";
import { ensureGameFiles, MC_ROOT } from "./mcfs.js";
import { store } from "./store.js";

const CJ_LOADER = "https://cjrtnc.leaningtech.com/4.3/loader.js";
const BASE_PRELOAD = {
  "/lt/8/jre/lib/rt.jar": [0, 131072, 1310720, 1572864, 4456448, 4849664, 5111808, 5505024, 7995392, 8126464, 9699328, 9830400, 9961472, 11534336, 11665408, 12189696, 12320768, 12582912, 13238272, 13369344, 15073280, 15335424, 15466496, 15597568, 15990784, 16121856, 16252928, 16384000, 16777216, 16908288, 17039360, 17563648, 17694720, 17956864, 18087936, 18612224, 18743296, 18874368, 19005440, 19136512, 19398656, 19791872, 20054016, 20709376, 20840448, 21757952, 21889024, 26869760],
  "/lt/etc/users": [0, 131072],
  "/lt/etc/localtime": [],
  "/lt/8/jre/lib/cheerpj-awt.jar": [0, 131072],
  "/lt/8/lib/ext/meta-index": [0, 131072],
  "/lt/8/lib/ext": [],
  "/lt/8/lib/ext/index.list": [],
  "/lt/8/lib/ext/localedata.jar": [],
  "/lt/8/jre/lib/jsse.jar": [0, 131072, 786432, 917504],
  "/lt/8/jre/lib/jce.jar": [0, 131072],
  "/lt/8/jre/lib/charsets.jar": [0, 131072, 1703936, 1835008],
  "/lt/8/jre/lib/resources.jar": [0, 131072, 917504, 1179648],
  "/lt/8/jre/lib/javaws.jar": [0, 131072, 1441792, 1703936],
  "/lt/8/lib/ext/sunjce_provider.jar": [],
  "/lt/8/lib/security/java.security": [0, 131072],
  "/lt/8/jre/lib/meta-index": [0, 131072],
  "/lt/8/jre/lib": [],
  "/lt/8/lib/accessibility.properties": [],
  "/lt/8/lib/fonts/LucidaSansRegular.ttf": [],
  "/lt/libraries/libGLESv2.so.1": [0, 262144],
  "/lt/libraries/libEGL.so.1": [0, 262144],
  "/lt/etc/hosts": [],
  "/lt/etc/resolv.conf": [0, 131072],
  "/lt/8/lib/fonts/fallback": [],
  "/lt/fc/fonts/fonts.conf": [0, 131072],
  "/lt/fc/ttf": [],
  "/lt/fc/cache/e21edda6a7db77f35ca341e0c3cb2a22-le32d8.cache-7": [0, 131072],
  "/lt/fc/ttf/LiberationSans-Regular.ttf": [0, 131072, 262144, 393216],
  "/lt/8/lib/jaxp.properties": [],
  "/lt/etc/timezone": [],
  "/lt/8/lib/tzdb.dat": [0, 131072],
};

/* ---------------- hook fetch dla CheerpJ: /app/data/* z Cache Storage + Range ---------------- */

const virtualIndexes = new Map();

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

async function rangeResponse(resp, headers) {
  const buf = new Uint8Array(await resp.arrayBuffer());
  const range = parseRange(headers?.get?.("Range") || headers?.range, buf.length);
  if (range === "unsat") return new Response("", { status: 416, headers: { "Content-Range": `bytes */${buf.length}` } });
  if (!range) return new Response(buf, { status: 200, headers: { "Content-Length": String(buf.length) } });
  const slice = buf.subarray(range.start, range.end + 1);
  return new Response(slice, {
    status: 206,
    headers: {
      "Content-Range": `bytes ${range.start}-${range.end}/${buf.length}`,
      "Content-Length": String(slice.length),
      "Accept-Ranges": "bytes",
    },
  });
}

async function virtualLookup(cache, path) {
  // /app/data/vanilla/<id>/assets/virtual/<idx>/<rel>  oraz wariant resources/
  const m = /^\/app\/data\/vanilla\/([^/]+)\/assets\/virtual\/([^/]+)\/(.+)$/.exec(path)
    || /^\/app\/data\/vanilla\/([^/]+)\/assets\/resources\/(.+)\/(.+)$/.exec(path.replace(/\/resources\/([^/]+)\//, "/resources/idx/"));
  const mm = /^\/app\/data\/vanilla\/([^/]+)\/assets\/virtual\/([^/]+)\/(.+)$/.exec(path);
  void m;
  if (!mm) return null;
  const [, id, idxId, rel] = mm;
  let idx = virtualIndexes.get(idxId);
  if (!idx) {
    const r = await cache.match(`/app/data/vanilla/${id}/assets/indexes/${idxId}.json`);
    if (!r) return null;
    idx = await r.json();
    virtualIndexes.set(idxId, idx);
  }
  const obj = idx.objects?.[rel];
  if (!obj) return null;
  const h = obj.hash;
  return await cache.match(`/app/data/vanilla/${id}/assets/objects/${h.slice(0, 2)}/${h}`);
}

async function cjFetch(input, init) {
  const url = typeof input === "string" ? input : (input && input.url) || "";
  if (/realms\.minecraft\.net/.test(url)) {
    return new Response("", { status: 502, statusText: "realms not served here" });
  }
  let path = url;
  try { if (/^https?:/.test(url)) path = new URL(url, location.href).pathname; } catch { /* jw */ }
  try { path = decodeURIComponent(path); } catch { /* jw */ }
  // kanon: każda forma (z/prefiksem /app, względna) → klucz instalacji
  const gi = path.search(/\/(?:app\/)?data\/vanilla\//);
  if (gi >= 0) {
    path = path.slice(gi);
    if (!path.startsWith("/app/")) path = "/app" + path;
  }
  if (path.startsWith("/app/data/vanilla/")) {
    const cache = await caches.open(MOJANG_CACHE);
    const headers = new Headers(init?.headers || {});
    if (typeof input === "object" && input?.headers) {
      new Headers(input.headers).forEach((v, k) => headers.set(k, v));
    }
    let hit = await cache.match(path);
    if (!hit) hit = await virtualLookup(cache, path);
    if (hit) {
      if (/\.jar$/.test(path)) bootNote(`hook HIT ${path}`);
      return await rangeResponse(hit, headers);
    }
    bootNote(`hook MISS ${path}`); // hook może być nieaktywny (CheerpJ 4 bez fetch) – linia i tak nie zaszkodzi
    return new Response("", { status: 204 }); // brak pliku = po cichu (reguła CheerpJ)
  }
  // zwykłe pliki origin (vendor/, lwjgl/) z lekkim retry
  let last;
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, init);
      if (r.ok || r.status === 204 || r.status === 304) return r;
      last = new Error("HTTP " + r.status);
    } catch (e) { last = e; }
    await new Promise((res) => setTimeout(res, 200 * 2 ** a));
  }
  throw last;
}

/* ---------------- HUD / skalowanie / touch ---------------- */

const view = document.getElementById("gameview");
const wrap = document.getElementById("game-scale");
const frameEl = document.getElementById("game-frame");
const hudFps = document.getElementById("hud-fps");
const hudHeap = document.getElementById("hud-heap");
const hudBufor = document.getElementById("hud-bufor");
const phaseEl = document.getElementById("game-phase");

let playing = false;
let inited = false;
let rafId = 0;
let frames = 0;
let lastFpsAt = 0;
let scaleApplied = null;

export function isPlaying() { return playing; }

/* przyciski HUDu i touch-pad (elementy statyczne w index.html) */
document.getElementById("hud-exit")?.addEventListener("click", () => {
  if (confirm("Zakończyć grę? (strona się przeładuje)")) exitGame();
});
(() => {
  const b = document.createElement("button");
  b.type = "button";
  b.id = "hud-log";
  b.textContent = "Log";
  b.addEventListener("click", () => {
    if (!bootLog.length) { toast("Brak logu uruchomienia.", ""); return; }
    showCrashDialog("Log uruchomienia", `${bootLog.length} wierszy`);
  });
  document.getElementById("hud-exit")?.before(b);
})();
function bindTouchPad() {
  const pad = document.getElementById("touch-pad");
  if (!pad || pad.dataset.bound) return;
  pad.dataset.bound = "1";
  const press = (el, down) => {
    const k = el.dataset.k ?? el.dataset.key;
    if (k == null || k === "") return;
    sendKey(k, down);
  };
  pad.querySelectorAll("[data-key]").forEach((el) => {
    el.addEventListener("pointerdown", (e) => { e.preventDefault(); el.classList.add("on"); press(el, true); });
    const up = (e) => { e.preventDefault(); el.classList.remove("on"); press(el, false); };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", up);
  });
}
bindTouchPad();

/* ---------------- zapis wyjścia gry (diagnostyka kodu ≠ 0) ----------------
 * CheerpJ wypisuje stdout/stderr JVM przez console.log/error do DevTools.
 * Ring buffer przechwytuje te wyjścia, żeby po „kod 1" pokazać stos wyjątku
 * w okienku (użytkownik nie musi otwierać DevTools).                 */

const bootLog = [];
const BOOT_LOG_MAX = 400;
let consoleHooked = false;
let launchT0 = Date.now();

function bootNote(text) {
  try {
    const s = String(text);
    const line = `[+${Date.now() - launchT0}ms] ${s.length > 500 ? s.slice(0, 500) + " …" : s}`;
    bootLog.push(line);
    if (bootLog.length > BOOT_LOG_MAX) bootLog.splice(0, bootLog.length - BOOT_LOG_MAX);
    lastBootAt = Date.now();
    tailDirty = true;
    persistBootLog();
  } catch { /* diagnostyka nigdy nie może przerwać gry */ }
}

let persistTimer = 0;
function persistBootLog() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = 0;
    try { sessionStorage.setItem("mcw.boot.v1", JSON.stringify(bootLog.slice(-160))); } catch { /* jw */ }
  }, 500);
}

function fmtLogArg(v) {
  if (typeof v === "string") return v;
  if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack || ""}`; // Firefox: stack bez treści
  if (v && typeof v === "object") { try { return JSON.stringify(v); } catch { /* jw */ } }
  return String(v);
}

function hookConsoleOnce() {
  if (consoleHooked) return;
  consoleHooked = true;
  for (const lvl of ["log", "info", "warn", "error", "debug"]) {
    const orig = console[lvl] ? console[lvl].bind(console) : null;
    console[lvl] = (...a) => {
      const line = a.map(fmtLogArg).join(" ");
      bootNote((lvl === "warn" || lvl === "error") ? `[${lvl}] ${line}` : line);
      if (orig) orig(...a);
    };
  }
}

/** Okienko z logiem ostatniego uruchomienia (kod ≠ 0 lub błąd startu). */
function showCrashDialog(title, context) {
  document.getElementById("crash-ov")?.remove();
  const ov = document.createElement("div");
  ov.id = "crash-ov";
  ov.className = "crash-ov";
  const box = document.createElement("div");
  box.className = "crash-box";
  const h = document.createElement("div");
  h.className = "crash-h";
  h.textContent = title;
  const metaEl = document.createElement("div");
  metaEl.className = "crash-meta";
  metaEl.textContent = [context, navigator.userAgent].filter(Boolean).join(" · ");
  const pre = document.createElement("pre");
  pre.className = "crash-log";
  pre.textContent = bootLog.length
    ? bootLog.join("\n")
    : "(brak wyjścia w buforze – otwórz DevTools i sprawdź zakładkę Console)";
  const row = document.createElement("div");
  row.className = "crash-actions";
  const copyBtn = document.createElement("button");
  copyBtn.className = "btn ghost";
  copyBtn.textContent = "Kopiuj log";
  copyBtn.addEventListener("click", async () => {
    const txt = [title, metaEl.textContent, "", ...bootLog].join("\n");
    try { await navigator.clipboard.writeText(txt); toast("Log skopiowany – wklej go na czat.", "ok"); }
    catch { toast("Schowek zabroniony – zaznacz tekst w oknie i kopiuj ręcznie.", "warn"); }
  });
  const closeBtn = document.createElement("button");
  closeBtn.className = "btn danger";
  closeBtn.textContent = "Zamknij";
  closeBtn.addEventListener("click", () => ov.remove());
  ov.addEventListener("click", (e) => { if (e.target === ov) ov.remove(); });
  row.append(copyBtn, closeBtn);
  box.append(h, metaEl, pre, row);
  ov.appendChild(box);
  document.body.appendChild(ov);
}

function copyLog(title) {
  const txt = [title, navigator.userAgent, "", ...bootLog].join("\n");
  return navigator.clipboard?.writeText(txt)
    .then(() => toast("Log skopiowany – wklej go na czat.", "ok"))
    .catch(() => toast("Schowek zabroniony – zaznacz tekst i kopiuj ręcznie.", "warn"));
}

/* Odzysk logu, gdy poprzednie uruchomienie padło bez okienka (OOM, crash karty). */
try {
  if (sessionStorage.getItem("mcw.booting") === "1") {
    sessionStorage.removeItem("mcw.booting");
    const saved = JSON.parse(sessionStorage.getItem("mcw.boot.v1") || "null");
    if (Array.isArray(saved) && saved.length) {
      bootLog.push(...saved.slice(-200));
      if (bootLog.length > BOOT_LOG_MAX) bootLog.splice(0, bootLog.length - BOOT_LOG_MAX);
      setTimeout(() => showCrashDialog("Poprzednie uruchomienie nie dokończyło się",
        "log odzyskany po przeładowaniu strony"), 700);
    }
  }
} catch { /* jw */ }

/* ---------------- faza startu: karta z ŻYWYM logiem ---------------- */
let tailOn = false;
let launchPending = false;
let copying = false;
let lastBootAt = Date.now();
let tailDirty = false;
let lastTailText = "";
let phaseSubBase = "";
let cursorSeenAt = 0;
let lastPreloadPct = -1;
let phaseT = null, phaseS = null, phaseLogEl = null;

function tailText() { return bootLog.slice(-14).join("\n"); }

function phase(text, sub) {
  if (!phaseEl) return;
  phaseSubBase = sub || "";
  if (!text) {
    phaseEl.hidden = true;
    phaseEl.classList.remove("tail");
    phaseEl.innerHTML = "";
    phaseT = phaseS = phaseLogEl = null;
    return;
  }
  phaseEl.hidden = false;
  phaseEl.classList.toggle("tail", tailOn);
  phaseEl.innerHTML = "";
  phaseT = document.createElement("div");
  phaseT.className = "phase-t";
  phaseT.textContent = text;
  phaseS = document.createElement("div");
  phaseS.className = "phase-s";
  phaseS.textContent = phaseSubBase;
  phaseEl.append(phaseT, phaseS);
  if (tailOn) {
    phaseLogEl = document.createElement("pre");
    phaseLogEl.className = "phase-log";
    lastTailText = tailText();
    phaseLogEl.textContent = lastTailText || "(czekam na wyjście JVM…)";
    const row = document.createElement("div");
    row.className = "phase-actions";
    const hideBtn = document.createElement("button");
    hideBtn.type = "button";
    hideBtn.textContent = "Ukryj";
    hideBtn.addEventListener("click", () => { tailOn = false; launchPending = false; phase(null); });
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.textContent = "Kopiuj log";
    copyBtn.addEventListener("click", () => copyLog("Log uruchomienia"));
    row.append(hideBtn, copyBtn);
    phaseEl.append(phaseLogEl, row);
  } else {
    phaseLogEl = null;
  }
}

function tailHide() { tailOn = false; launchPending = false; phase(null); }

/* Ticker: odświeża ogon logu, licznik sekund i sam chowa kartę, gdy gra
 * wystartowała (cursor Javy albo \`ucichnięcie\` logu po postępach). */
setInterval(() => {
  if (!tailOn || !phaseLogEl) return;
  tailDirty = false;
  const t = tailText();
  if (t !== lastTailText) {
    lastTailText = t;
    phaseLogEl.textContent = t || "(czekam na wyjście JVM…)";
  }
  if (phaseS && launchPending) {
    const secs = Math.round((Date.now() - launchT0) / 1000);
    phaseS.textContent = phaseSubBase + ` · ${secs} s`
      + (secs >= 20 && !bootLog.length ? " – brak wyjścia; F12 → Console" : "");
  }
  if (!launchPending || copying) return; // podczas kopiowania karta ma zostać
  const now = Date.now();
  if (cursorSeenAt) return tailHide(); // Java ustawia kursor = interfejs żyje
  if (bootLog.length && now - launchT0 > 10000 && now - lastBootAt > 6000) return tailHide(); // postęp i cisza
  if (now - launchT0 > 90000 && now - lastBootAt > 2000) return tailHide(); // dłużej niż90 s
}, 300);

function applyScale(pct) {
  const target = document.getElementById("game-wrap") || wrap;
  if (!target) return;
  if (!pct || pct >= 100) { target.style.transform = ""; scaleApplied = null; return; }
  const vw = target.clientWidth || window.innerWidth;
  const vh = target.clientHeight || window.innerHeight;
  target.style.transformOrigin = "0 0";
  target.style.transform = `scale(${pct / 100})`;
  target.style.width = `${Math.round(vw / (pct / 100))}px`;
  target.style.height = `${Math.round(vh / (pct / 100))}px`;
  scaleApplied = pct;
}

function fpsLoop(ts) {
  frames++;
  if (!lastFpsAt) lastFpsAt = ts;
  if (ts - lastFpsAt >= 1000) {
    if (hudFps) hudFps.textContent = `FPS ${Math.round((frames * 1000) / (ts - lastFpsAt))}`;
    frames = 0; lastFpsAt = ts;
  }
  const mem = performance.memory;
  if (hudHeap && mem) hudHeap.textContent = `Heap ${Math.round(mem.usedJSHeapSize / 1048576)} MB`;
  rafId = requestAnimationFrame(fpsLoop);
}

function startHud() {
  cancelAnimationFrame(rafId);
  frames = 0; lastFpsAt = 0;
  rafId = requestAnimationFrame(fpsLoop);
}

/* ---------------- touch pad ---------------- */

const KEYCODE = {
  space: 32, " ": 32, shift: 16, escape: 27, esc: 27,
  w: 87, a: 65, s: 83, d: 68, e: 69, q: 81, f: 70, r: 82,
};
export function sendKey(key, down) {
  const low = String(key).toLowerCase();
  const code = KEYCODE[low] ?? (low.length === 1 ? low.toUpperCase().charCodeAt(0) : 0);
  const name = low === " " ? "Space" : low.length === 1 ? "Key" + low.toUpperCase()
    : low === "escape" ? "Escape" : low === "shift" ? "ShiftLeft" : low;
  const ev = new KeyboardEvent(down ? "keydown" : "keyup", {
    key: low === " " ? " " : low, code: name,
    keyCode: code, which: code, bubbles: true, cancelable: true,
  });
  (document.activeElement || document.body).dispatchEvent(ev);
  window.dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", {
    key: low === " " ? " " : low, keyCode: code, which: code, bubbles: true,
  }));
}

/* ---------------- seed options.txt (pierwsze uruchomienie wersji) ---------------- */

async function seedOptionsCheerpJ(id) {
  const flagKey = `mcw.opts.${id}`;
  if (localStorage.getItem(flagKey)) return;
  const text = buildOptionsPreset(store.state.prefs);
  const bytes = new TextEncoder().encode(text);
  await new Promise((resolve) => {
    const fds = [];
    try {
      window.cheerpOSOpen(fds, "/files/minecraft/options.txt", "w", (fd) => {
        if (fd < 0) { resolve(); return; }
        window.cheerpOSWrite(fds, fd, bytes, 0, bytes.length, () => {
          window.cheerpOSClose(fds, fd, () => resolve());
        });
      });
    } catch (e) { console.warn("cheerpOS", e); resolve(); }
  });
  localStorage.setItem(flagKey, "1");
}

/* ---------------- główny przebieg ---------------- */

async function ensureLoader() {
  if (typeof window.cheerpjInit === "function") return;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = CJ_LOADER;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Nie udało się pobrać runtime CheerpJ (cjrtnc.leaningtech.com)."));
    document.head.appendChild(s);
  });
}

export async function launchInstance(inst) {
  bootLog.length = 0;
  launchT0 = Date.now();
  hookConsoleOnce();
  const id = inst.id || inst.catalogId || inst.instId?.replace(/^i-/, "");
  if (!id) { toast("Brak wersji do uruchomienia.", "err"); return; }
  const meta = await installedInfo(id);
  if (!meta) { toast("Wersja nie jest zainstalowana.", "err"); return; }
  if (!("serviceWorker" in navigator) || !(await swReady(6000))) {
    toast("Service Worker nie wystartował – odśwież stronę.", "err");
    return;
  }

  playing = true;
  view.hidden = false;
  document.body.classList.add("playing");
  const touchPref = store.state.prefs.touch;
  const touchOn = touchPref === "on" || (touchPref !== "off" && matchMedia("(pointer: coarse)").matches);
  const pad = document.getElementById("touch-pad");
  if (pad) pad.hidden = !touchOn;
  const hudEl = document.getElementById("hud");
  if (hudEl) hudEl.hidden = store.state.prefs.hud === false;
  document.getElementById("hud-name") && (document.getElementById("hud-name").textContent = id);
  hudBufor && (hudBufor.textContent = "");
  startHud();
  tailOn = true;
  launchPending = true;
  lastBootAt = Date.now();
  cursorSeenAt = 0;
  lastPreloadPct = -1;
  try { sessionStorage.setItem("mcw.booting", "1"); } catch { /* jw */ }
  phase("Przygotowanie…", id);

  let plan;
  try {
    plan = await resolvePlan(id);
    const args = buildArgs(plan, {
      name: store.state.profile.name,
      uuid: store.state.profile.uuid,
      accessToken: "0",
      userType: "legacy",
    }, meta.type);
    bootNote(`start ${id} · java${plan.javaMajor} · patched=${meta.patched} · libs=${plan.libs.length} · args=${args.length}`);
    bootNote(`${plan.mainClass} ${args.slice(0, 16).join(" ")}${args.length > 16 ? " …" : ""}`);

    if (!inited) {
      phase("Runtime CheerpJ…", "JVM WebAssembly + gl4es");
      await ensureLoader();

      const { socketNativesWrapped } = await import("./netshim.js");
      await window.cheerpjInit({
        fetch: cjFetch, // CheerpJ 4 formalnie bez hooka – trzymamy jako pas; priorytet: SW (patrz sw.js)
        overrideDocumentBase: new URL("./", location.href).href, // /app/ → HTTP względem BAZY strony (scope SW)
        version: plan.javaMajor >= 17 ? 17 : 8,
        status: "none",
        javaProperties: [
          `java.library.path=${MC_ROOT}/natives/`,
          "sun.java2d.opengl=false",
        ],
        libraries: { "libGL.so.1": `${MC_ROOT}/natives/gl4es.wasm` },
        enableX11: true,
        preloadResources: BASE_PRELOAD,
        preloadProgress: (done, total) => {
          if (!total) return;
          const pct = Math.floor((done / total) * 100);
          if (pct === lastPreloadPct) return;
          lastPreloadPct = pct;
          phase("Runtime CheerpJ…", `pliki runtime ${pct}% (${done}/${total})`);
        },
        natives: socketNativesWrapped(),
      });
      inited = true;
      await window.cheerpjCreateDisplay(-1, -1, frameEl);
      window.cheerpjDisplaySetCursorCallback?.((c) => {
        frameEl.style.cursor = c;
        if (Date.now() - launchT0 > 5000) cursorSeenAt = Date.now();
      });
    }

    phase("Start gry…", `${meta.mainClass || plan.mainClass} · ${args.length} arg.`);
    phase("Przenoszenie plików…", "Cache → /files (IndexedDB) – jednorazowo dla tej wersji");
    copying = true;
    try {
      const mig = await ensureGameFiles(id, meta, plan, {
        log: (m) => bootNote("files: " + m),
        onProgress: (done, total, b) => phase("Przenoszenie plików…",
          `${done}/${total} · ${(b / 1048576).toFixed(1)} MB · Cache → /files`),
      });
      bootNote(mig.skipped ? "files: /files gotowe (znacznik .ready)" : "files: kopia zakończona");
    } finally {
      copying = false;
    }
    await seedOptionsCheerpJ(id);

    const base = `${MC_ROOT}/vanilla/${id}`;
    const cp = [
      ...plan.libs.map((l) => `${base}/libraries/${l.path}`),
      `${base}/${meta.patched ? "client-patched.jar" : "client.jar"}`,
    ].join(":");

    applyScale(resolveRenderScale());
    phase("Uruchomianie gry…", "JVM wczytuje biblioteki i klienta – na telefonie potrafi zająć 0,5–1,5 min. Log rośnie poniżej; jeśli ucichnie, gra wystartowała – przycisk Ukryj.");
    const mainClass = plan.mainClass;
    const code = await window.cheerpjRunMain(mainClass, cp, ...args);
    launchPending = false;
    tailOn = false;
    try { sessionStorage.removeItem("mcw.booting"); } catch { /* jw */ }
    phase(null);
    toast(`Gra zakończyła się (kod ${code}).`, code === 0 ? "ok" : "warn");
    if (code !== 0) {
      showCrashDialog(`Gra zakończyła się (kod ${code})`,
        `${id} · java${plan.javaMajor} · patched=${meta.patched} · libs=${plan.libs.length} · cp=${plan.libs.length + 1}`);
    }
  } catch (e) {
    console.error("[launch]", e);
    launchPending = false;
    tailOn = false;
    try { sessionStorage.removeItem("mcw.booting"); } catch { /* jw */ }
    toast("Start nieudany: " + e.message, "err");
    phase("Błąd startu", e.message);
    showCrashDialog("Start nieudany: " + e.message, `${id} · ${plan?.mainClass || ""}`);
  }
}

function resolveRenderScale() {
  const pref = store.state.prefs.renderScale;
  if (pref && pref !== "auto") return Number(pref);
  return null;
}

export function exitGame() {
  if (!playing) return;
  playing = false;
  launchPending = false;
  tailOn = false;
  try { sessionStorage.removeItem("mcw.booting"); } catch { /* jw */ }
  cancelAnimationFrame(rafId);
  // CheerpJ nie pozwala „zatrzymać" JVM – czyścimy przez przeładowanie strony
  location.hash = "#/home";
  location.reload();
}

/** Odświeżenie HUD-u bufora z wiadomości SW (jeśli SW jeszcze rozsyła). */
window.addEventListener("message", (e) => {
  const d = e.data;
  if (d?.src === "mcw-sw" && d.ev === "fetchlog") { bootNote("sw " + d.msg); return; }
  if (d?.src === "mcw-sw" && d.ev === "bytes" && playing && hudBufor) {
    hudBufor.textContent = `Bufor +${(d.added / 1048576).toFixed(1)} MB`;
  }
});
