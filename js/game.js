/**
 * game.js – uruchomienie instancji: iframe z grą serwowany z /rt/…,
 * skaler rozdzielczości (jak `resolutionRatio` w MojoLauncherze),
 * HUD (FPS/heap/bufor) i nakładka dotykowa (klawy wysyłane do iframa).
 */

import { store } from "./store.js";
import { getCatalogItem } from "./catalog.js";
import { detectDevice, findBestResolution, findBestRAMAllocation, detectMinSidePx, detectCores, detectDeviceMemoryMB, autoRamToast } from "./mojo.js";
import { toast, swReady } from "./ui.js";

const view = document.getElementById("gameview");
const wrap = document.getElementById("game-wrap");
const scaleBox = document.getElementById("game-scale");
const frame = document.getElementById("game-frame");
const hudName = document.getElementById("hud-name");
const hudFps = document.getElementById("hud-fps");
const hudHeap = document.getElementById("hud-heap");
const hudBufor = document.getElementById("hud-bufor");
const touchPad = document.getElementById("touch-pad");

let current = null; // { instId, item, startedAt, bytes0 }
let rafHandle = 0;
let heapTimer = 0;
let bytesSince = 0;
let swHandler = null;

/* ---------- skaler rozdzielczości ---------- */

export function resolveRenderScale(device = detectDevice()) {
  const pref = store.state.prefs.renderScale;
  if (typeof pref === "number" && pref >= 25 && pref <= 100) return pref;
  if (pref === "auto") return device.resolutionPct;
  return device.resolutionPct;
}

function applyScale(pct) {
  const vw = wrap.clientWidth || window.innerWidth;
  const vh = wrap.clientHeight || window.innerHeight;
  const k = pct / 100;
  const gw = Math.max(320, Math.round(vw / k));
  const gh = Math.max(240, Math.round(vh / k));
  frame.style.width = gw + "px";
  frame.style.height = gh + "px";
  scaleBox.style.width = vw + "px";
  scaleBox.style.height = vh + "px";
  scaleBox.style.transform = `scale(${k})`;
}

/* ---------- touch ---------- */

const pressed = new Set();

const KEYCODE = {
  Space: 32, ShiftLeft: 16, ShiftRight: 16, Escape: 27, Tab: 9,
  ControlLeft: 17, ControlRight: 17, AltLeft: 18, AltRight: 18,
  Enter: 13, Backquote: 192,
};
function keyCodeFor(code, k) {
  if (KEYCODE[code]) return KEYCODE[code];
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  if (k && k.length === 1) return k.toUpperCase().charCodeAt(0);
  return 0;
}

function sendKey(type, code, key) {
  const w = frame.contentWindow;
  if (!w) return;
  try {
    const kc = keyCodeFor(code, key);
    w.dispatchEvent(new w.KeyboardEvent(type, {
      key, code, keyCode: kc, which: kc, bubbles: true, cancelable: true,
    }));
  } catch { /* ignore */ }
}

function setupTouch() {
  touchPad.querySelectorAll(".tp").forEach((btn) => {
    const code = btn.dataset.key;
    const k = btn.dataset.k;
    const down = (ev) => {
      ev.preventDefault();
      if (pressed.has(code)) return;
      pressed.add(code);
      btn.classList.add("on");
      sendKey("keydown", code, k);
    };
    const up = (ev) => {
      ev.preventDefault();
      if (!pressed.has(code)) return;
      pressed.delete(code);
      btn.classList.remove("on");
      sendKey("keyup", code, k);
    };
    btn.addEventListener("pointerdown", down);
    btn.addEventListener("pointerup", up);
    btn.addEventListener("pointercancel", up);
    btn.addEventListener("pointerleave", up);
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
  });
}

function touchEnabled() {
  const pref = store.state.prefs.touch;
  if (pref === "on") return true;
  if (pref === "off") return false;
  return matchMedia("(pointer: coarse)").matches;
}

/* ---------- HUD ---------- */

let fpsPatchTimer = 0;

function startHud() {
  stopHud();
  const device = detectDevice();
  const scale = resolveRenderScale(device);

  if (store.state.prefs.hud) {
    hudName.textContent = `${current.item.title}`;
    updateHeap();
    heapTimer = setInterval(updateHeap, 1000);
    // FPS:1) przeczytaj z harnessa gry (jeśli jest),2) zmierz przez rAF w iframie
    fpsPatchTimer = setInterval(() => {
      const doc = frame.contentDocument;
      const stats = doc && doc.getElementById("stats");
      if (stats && stats.textContent) { hudFps.textContent = "FPS " + stats.textContent.slice(0, 24); return; }
      hudFps.textContent = frame.contentWindow && frame.contentWindow.__mcwFps
        ? `FPS ${Math.round(frame.contentWindow.__mcwFps)}`
        : "FPS –";
    }, 1000);
    injectFpsMeter();
  } else {
    document.getElementById("hud").style.display = "none";
  }

  hudBufor.textContent = `bufor ${fmt(bytesSince)}`;
}

function injectFpsMeter() {
  // licznik FPS w kontekście iframa (ten sam origin po instalacji)
  try {
    const w = frame.contentWindow;
    if (!w || w.__mcwHooked) return;
    w.__mcwHooked = true;
    const orig = w.requestAnimationFrame.bind(w);
    let frames = 0, t0 = performance.now();
    w.requestAnimationFrame = (cb) => orig((t) => { frames++; return cb(t); });
    setInterval(() => {
      const now = performance.now();
      w.__mcwFps = (frames * 1000) / (now - t0);
      frames = 0; t0 = now;
    }, 1000);
  } catch { /* cross-origin albo brak dostępu */ }
}

function updateHeap() {
  const m = performance.memory;
  const budget = current ? resolveRamMb() : 0;
  if (m) {
    const used = m.usedJSHeapSize / 1048576;
    hudHeap.textContent = `heap ${used.toFixed(0)} MB / ~${Math.round(m.jsHeapSizeLimit / 1048576)} MB`;
    if (budget && used > budget * 0.92) hudHeap.textContent += " ⚠";
  } else {
    hudHeap.textContent = `budżet ${budget} MB`;
  }
}

function resolveRamMb() {
  const p = store.state.prefs;
  if (p.ramMode === "custom" && p.ramMb) return p.ramMb;
  return findBestRAMAllocation(detectDeviceMemoryMB());
}

function stopHud() {
  clearInterval(heapTimer);
  clearInterval(fpsPatchTimer);
  heapTimer = fpsPatchTimer = 0;
  document.getElementById("hud").style.display = "";
}

function fmt(n) {
  if (!n) return "–";
  if (n > 1048576) return (n / 1073741824).toFixed(1) + " GB";
  if (n > 1024 * 1200) return (n / 1048576).toFixed(1) + " MB";
  return Math.round(n / 1024) + " kB";
}

/* ---------- SW byte counter ---------- */

function attachSwCounter() {
  swHandler = (e) => {
    const d = e.data;
    if (d && d.src === "mcw-sw" && d.ev === "bytes" && current && d.instId === current.instId) {
      bytesSince += d.added;
      hudBufor.textContent = `bufor ${fmt(bytesSince)}`;
    }
  };
  navigator.serviceWorker.addEventListener("message", swHandler);
}

/* ---------- start / stop ---------- */

export async function launchInstance(inst) {
  const item = getCatalogItem(inst.catalogId);
  if (!item) { toast("Brak pozycji katalogu dla tej instancji.", "err"); return; }
  if (!("serviceWorker" in navigator)) {
    toast("Ta przeglądarka nie wspiera Service Worker – pliki gry nie zostaną podmienione na lokalne.", "err");
    return;
  }
  if (!(await swReady(6000))) {
    toast("Service Worker nie wystartował – odśwież stronę i spróbuj ponownie.", "err");
    return;
  }

  current = { instId: inst.instId, item, startedAt: Date.now(), bytes0: 0 };
  bytesSince = 0;

  const device = detectDevice();
  const scale = resolveRenderScale(device);
  applyScale(scale);

  view.hidden = false;
  document.body.classList.add("playing");
  hudName.textContent = item.title;
  hudFps.textContent = "FPS –";
  touchPad.hidden = !touchEnabled();
  if (touchPad.hidden === false) setupTouch();

  const src = `/rt/${encodeURIComponent(inst.instId)}/${item.src.entry.split("/").map(encodeURIComponent).join("/")}${item.bootParams || ""}`;
  frame.src = src;

  attachSwCounter();
  startHud();

  // toast w stylu autoram_info_msg z MojoLaunchera
  toast(autoRamToast({ ...device, ramMb: resolveRamMb(), resolutionPct: scale }));
  if (scale < 100) {
    setTimeout(() => toast(`Skalowanie rozdzielczości: ${scale}% (cel 720p/1080p jak w findBestResolution)`), 900);
  }

  frame.addEventListener("load", injectFpsMeter, { once: true });
}

export function exitGame() {
  if (!current) return;
  const ms = Date.now() - current.startedAt;
  store.markPlayed(current.instId, ms);
  try {
    const w = frame.contentWindow;
    if (w && w.document) w.document.body.innerHTML = "";
  } catch { /* ignore */ }
  frame.src = "about:blank";
  view.hidden = true;
  document.body.classList.remove("playing");
  stopHud();
  if (swHandler) { navigator.serviceWorker.removeEventListener("message", swHandler); swHandler = null; }
  for (const code of [...pressed]) { pressed.delete(code); }
  current = null;
}

export function isPlaying() { return !!current; }

window.addEventListener("resize", () => {
  if (!current) return;
  applyScale(resolveRenderScale());
});

document.getElementById("hud-exit").addEventListener("click", exitGame);
document.getElementById("hud-full").addEventListener("click", () => {
  const el = document.getElementById("gameview");
  if (document.fullscreenElement) document.exitFullscreen();
  else el.requestFullscreen?.();
});

window.__resolveRenderScale = resolveRenderScale;
window.__findBestResolution = findBestResolution;
window.__detectMinSidePx = detectMinSidePx;
window.__detectCores = detectCores;
