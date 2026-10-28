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
  path = decodeURIComponent(path);
  if (path.startsWith("/app/data/vanilla/")) {
    const cache = await caches.open(MOJANG_CACHE);
    const headers = new Headers(init?.headers || {});
    let hit = await cache.match(path);
    if (!hit) hit = await virtualLookup(cache, path);
    if (hit) return await rangeResponse(hit, headers);
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

function phase(text, sub) {
  if (phaseEl) {
    phaseEl.innerHTML = text ? `<div class="phase-t">${text}</div>${sub ? `<div class="phase-s">${sub}</div>` : ""}` : "";
    phaseEl.hidden = !text;
  }
}

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
  phase("Przygotowanie…", id);

  try {
    const plan = await resolvePlan(id);
    const args = buildArgs(plan, {
      name: store.state.profile.name,
      uuid: store.state.profile.uuid,
      accessToken: "0",
      userType: "legacy",
    }, meta.type);

    if (!inited) {
      phase("Runtime CheerpJ…", "JVM WebAssembly + gl4es");
      await ensureLoader();

      const { socketNativesWrapped } = await import("./netshim.js");
      await window.cheerpjInit({
        fetch: cjFetch,
        version: plan.javaMajor >= 17 ? 17 : 8,
        status: "none",
        javaProperties: [
          "java.library.path=/vendor/lwjgl/",
          "sun.java2d.opengl=false",
        ],
        libraries: { "libGL.so.1": "/vendor/lwjgl/gl4es.wasm" },
        enableX11: true,
        preloadResources: BASE_PRELOAD,
        natives: socketNativesWrapped(),
      });
      inited = true;
      await window.cheerpjCreateDisplay(-1, -1, frameEl);
      window.cheerpjDisplaySetCursorCallback?.((c) => { frameEl.style.cursor = c; });
    }

    phase("Start gry…", `${meta.mainClass || plan.mainClass} · ${args.length} arg.`);
    await seedOptionsCheerpJ(id);

    const base = `/app/data/vanilla/${id}`;
    const cp = [
      ...plan.libs.map((l) => `${base}/libraries/${l.path}`),
      `${base}/${meta.patched ? "client-patched.jar" : "client.jar"}`,
    ].join(":");

    applyScale(resolveRenderScale());
    phase(null);
    const mainClass = plan.mainClass;
    const code = await window.cheerpjRunMain(mainClass, cp, ...args);
    toast(`Gra zakończyła się (kod ${code}).`, code === 0 ? "ok" : "warn");
  } catch (e) {
    console.error("[launch]", e);
    toast("Start nieudany: " + e.message, "err");
    phase("Błąd startu", e.message);
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
  cancelAnimationFrame(rafId);
  // CheerpJ nie pozwala „zatrzymać" JVM – czyścimy przez przeładowanie strony
  location.hash = "#/home";
  location.reload();
}

/** Odświeżenie HUD-u bufora z wiadomości SW (jeśli SW jeszcze rozsyła). */
window.addEventListener("message", (e) => {
  const d = e.data;
  if (d?.src === "mcw-sw" && d.ev === "bytes" && playing && hudBufor) {
    hudBufor.textContent = `Bufor +${(d.added / 1048576).toFixed(1)} MB`;
  }
});
