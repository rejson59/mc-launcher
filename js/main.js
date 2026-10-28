/**
 * main.js – bootstrap: rejestracja Service Workera, router hash,
 * pasek statusu, profil, anulowanie instalacji.
 */

import { store } from "./store.js";
import {
  view, renderHome, renderInstances, renderSettings, renderJava, renderAbout,
  refreshStatusbar, syncProfileChip, askCancelInstall, toast, fmtBytes,
} from "./ui.js";
import { isPlaying, exitGame } from "./game.js";

/**
 * Baza ścieżki (GitHub Pages serwuje pod /<repo>/): przepisujemy lokalne
 * root-absolute fetch-e (/vendor/, /lwjgl/…) na base+ścieżkę. /app/ ZOSTAJE
 * root-absolute – tamte URL-e to klucze Cache Storage (cjFetch je obsługuje).
 */
window.__MCL_BASE__ = location.pathname.replace(/[^/]*$/, "");
{
  const base = window.__MCL_BASE__;
  const origFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (base !== "/" && url.startsWith("/") && !url.startsWith("//") && !url.startsWith("/app/")) {
        if (/^\/(vendor|lwjgl|assets|css|js|docs)\//.test(url)) {
          input = base + url.slice(1);
        }
      }
    } catch { /* zostaw jak było */ }
    return origFetch(input, init);
  };
}

/* ---------- Service Worker ---------- */

async function registerSw() {
  if (!("serviceWorker" in navigator)) {
    toast("Przeglądarka bez Service Workera – tryb offline niedostępny.", "warn");
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register("sw.js", { scope: "./" });
    await reg.ready;
    navigator.serviceWorker.addEventListener("message", (e) => {
      const d = e.data;
      if (d?.src === "mcw-sw" && d.ev === "bytes" && !isPlaying()) {
        document.getElementById("sb-bufor").textContent = `Bufor: +${fmtBytes(d.added)}`;
      }
    });
  } catch (e) {
    console.error("SW", e);
    toast("Nie udało się zarejestrować Service Workera: " + e.message, "err");
  }
}

/* ---------- router ---------- */

const ROUTES = {
  home: renderHome,
  instances: renderInstances,
  settings: renderSettings,
  java: renderJava,
  about: renderAbout,
};

function route() {
  const hash = (location.hash || "#/home").replace(/^#\/?/, "") || "home";
  const name = ROUTES[hash] ? hash : "home";
  if (isPlaying()) exitGame();
  ROUTES[name]();
  document.querySelectorAll("#mainnav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.nav === name);
  });
  view.scrollTop = 0;
  refreshStatusbar();
}

window.addEventListener("hashchange", route);

/* ---------- profil ---------- */

document.getElementById("profile-chip").addEventListener("click", () => {
  const nick = prompt("Twój nick w launcherze:", store.state.profile.name);
  if (nick != null) {
    store.setProfileName(nick.trim() || "Gracz");
    syncProfileChip();
    toast(`Profil: ${store.state.profile.name}`);
    if ((location.hash || "").includes("settings")) route();
  }
});

/* ---------- anulowanie instalacji ---------- */

document.getElementById("modal-cancel").addEventListener("click", askCancelInstall);

/* ---------- Esc zamyka grę ---------- */

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isPlaying()) {
    // pozwól grze przetworzyć Esc (menu), dopiero podwójne = wyjście
    if (e.repeat) return;
  }
});

/* ---------- start ---------- */

registerSw();
syncProfileChip();
route();
refreshStatusbar();
console.log("%cMC Launcher Web", "color:#8ddc6a;font-weight:bold", {
  state: store.state,
});
