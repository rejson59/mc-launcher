/**
 * ui.js – ekrany launchera (hash-routery), toasty, modal instalacji.
 * Wersje pochodzą z manifestu Mojang (js/mojang.js), nie z ręcznej listy portów.
 */

import { store } from "./store.js";
import { getCatalog, FEATURED, getCatalogItem } from "./catalog.js";
import {
  installInstance, uninstallInstance, instancesBytes, listInstalledIds,
  installedInfo, resolvePlan, buildArgs, buildOptionsPreset,
} from "./mojang.js";
import { detectDevice, findBestRAMAllocation } from "./mojo.js";
import { launchInstance } from "./game.js";

export const view = document.getElementById("view");

/* ---------------- helpers ---------------- */

export function fmtBytes(n) {
  if (!n) return "0 MB";
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + " GB";
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  return Math.round(n / 1024) + " kB";
}

export function esc(s) {
  return String(s).replace(/[&<>\"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function toast(msg, kind = "") {
  const stack = document.getElementById("toast-stack");
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .4s"; }, 4200);
  setTimeout(() => el.remove(), 4700);
}

/* ---------------- modal instalacji ---------------- */

const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modal-title");
const modalFill = document.getElementById("modal-fill");
const modalStatus = document.getElementById("modal-status");
const modalLog = document.getElementById("modal-log");
const modalCancel = document.getElementById("modal-cancel");
let abortCtl = null;

function modalOpen(title) {
  abortCtl = new AbortController();
  modalTitle.textContent = title;
  modalFill.style.width = "0%";
  modalStatus.textContent = "Przygotowanie…";
  modalLog.textContent = "";
  modalCancel.hidden = false;
  modal.hidden = false;
  return abortCtl;
}
function modalClose() { modal.hidden = true; abortCtl = null; }
function modalProgress(phase, done, total, bytes) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  modalFill.style.width = pct + "%";
  modalStatus.textContent = `${phase} · ${done}/${total} · ${fmtBytes(bytes)}`;
}

export function askCancelInstall() { abortCtl?.abort(); }

/** Czeka na aktywny Service Worker z limitem czasu. */
export async function swReady(timeout = 3500) {
  if (!("serviceWorker" in navigator)) return false;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready.then(() => true, () => false),
      new Promise((r) => setTimeout(() => r(false), timeout)),
    ]);
  } catch { return false; }
}

/* ---------------- instalacja / start ---------------- */

export async function ensureInstalled(catalogId, { autoLaunch = false } = {}) {
  const item = await getCatalogItem(catalogId).catch(() => null);
  if (!item && !(await installedInfo(catalogId))) {
    toast("Nieznana wersja: " + catalogId, "err");
    return;
  }
  const existing = await installedInfo(catalogId);
  if (existing) {
    store.select(catalogId);
    if (autoLaunch) await launchInstance({ id: catalogId });
    return;
  }
  await swReady();
  if (await installedInfo(catalogId)) return;
  const ctl = modalOpen(`Instalacja: ${item?.title || catalogId}`);
  modalCancel.hidden = false;
  try {
    const info = await installInstance(catalogId, {
      signal: ctl.signal,
      onProgress: modalProgress,
    });
    modalClose();
    store.select(catalogId);
    document.getElementById("sb-bufor").textContent = `Bufor: ${fmtBytes(info.bytes)}`;
    toast(`Zainstalowano ${catalogId} · ${fmtBytes(info.bytes)}`
      + (info.patched ? " · poprawki klienta" : ""));
    if (autoLaunch) await launchInstance({ id: catalogId });
    else location.hash = "#/instances";
  } catch (e) {
    modalClose();
    if (e.name === "AbortError") toast("Instalacja anulowana.", "warn");
    else toast("Instalacja nieudana: " + e.message, "err");
  }
}

export async function removeInstance(id) {
  const n = await uninstallInstance(id);
  toast(`Usunięto ${n} plików wersji ${id}.`);
  refreshStatusbar();
  renderInstances();
}

export function refreshStatusbar() {
  const dev = detectDevice();
  document.getElementById("sb-ram").textContent =
    `RAM ${dev.deviceRamMB ? (dev.deviceRamMB / 1024).toFixed(1) + " GB" : "?"} → preset ${findBestRAMAllocation(dev.deviceRamMB || 4096)} MB`;
  const r = document.getElementById("sb-renderer");
  if (r) r.textContent = `CheerpJ + gl4es · ${dev.renderer?.short || "?"}`;
  document.getElementById("sb-bufor") && instancesBytes().then((b) => {
    document.getElementById("sb-bufor").textContent = `Bufor: ${fmtBytes(b)}`;
  }).catch(() => {});
}

/* ---------------- ekran: start ---------------- */

function spinner(text) {
  view.innerHTML = `<div class="panel spinner-p"><div class="spinner"></div><p>${esc(text)}</p></div>`;
}

export function renderHome() {
  spinner("Ładowanie katalogu wersji Mojang…");
  (async () => {
    const dev = detectDevice();
    let catalog;
    try { catalog = await getCatalog(); }
    catch (e) {
      view.innerHTML = `<div class="panel"><h2>Brak katalogu</h2>
        <p>Nie udało się pobrać manifestu wersji Mojang (${esc(e.message)}).
        Sprawdź połączenie i odśwież stronę.</p></div>`;
      return;
    }
    const installed = new Set(await listInstalledIds());
    const sel = store.state.selected && installed.has(store.state.selected)
      ? store.state.selected
      : ([...installed][0] || FEATURED.find((f) => catalog.some((c) => c.id === f)) || catalog[0]?.id);

    const selItem = catalog.find((c) => c.id === sel);
    const ram = findBestRAMAllocation(dev.deviceRamMB || 4096);
    const scale = dev.powerful ? "skaler 720p/1080p" : "skaler 720p (oszczędny)";

    view.innerHTML = `
      <section class="hero">
        <div>
          <span class="pill ok">oryginalny klient · pliki prosto z Mojang</span>
          <h1>Zagraj w <b>ORYGINALNEGO</b> Minecrafta<br>w przeglądarce</h1>
          <p>Ten sam launcher co na Androidzie: AutoRAM (${ram} MB), skaler
             rozdzielczości, weryfikacja SHA-1 plików i niezmodyfikowany client.jar
             (era do 1.12.2) na JVM w WebAssembly + gl4es.</p>
          <div class="cta-row">
            <button class="btn primary big" id="cta-play" ${selItem ? "" : "disabled"}>
              Graj: ${esc(selItem?.title || "wybierz wersję")}</button>
            <span class="pill ${installed.size ? "ok" : "warn"}">
              ${installed.size ? `zainstalowane: ${installed.size}` : "pierwsze uruchomienie pobierze pliki gry"}</span>
          </div>
          <div class="mini-stats">
            <span>${scale}</span><span>${dev.renderer?.short || "brak GL"}</span>
            <span>${dev.cores} rdzeni</span><span>${catalog.length} wersji</span>
          </div>
        </div>
        <div class="hero-art"><img src="assets/hero.png" alt="" onerror="this.style.display='none'"></div>
      </section>

      <section class="panel">
        <div class="row head">
          <h2>Wersje gry (oficjalny manifest Mojang)</h2>
          <input id="ver-filter" class="input" placeholder="szukaj: 1.8.9, b1.7.3, alpha…" />
        </div>
        <div class="inst-grid" id="ver-grid"></div>
      </section>`;

    const grid = document.getElementById("ver-grid");
    const draw = (q) => {
      const needle = (q || "").trim().toLowerCase();
      const list = catalog.filter((c) =>
        !needle || c.id.includes(needle) || c.title.toLowerCase().includes(needle));
      grid.innerHTML = "";
      for (const c of list.slice(0, 400)) {
        const card = document.createElement("button");
        card.className = "inst-card" + (installed.has(c.id) ? " inst-ok" : "");
        card.innerHTML = `
          <div class="inst-top"><b>${esc(c.title)}</b>
            <span class="badge-era">${esc(String(c.era))}</span></div>
          <div class="inst-meta">${esc(c.type === "release" ? "wydanie" : c.type === "old_beta" ? "stara beta" : "stara alfa")}
            ${installed.has(c.id) ? " · <i>na dysku</i>" : " · pobierze się przy starcie"}</div>`;
        card.addEventListener("click", () => ensureInstalled(c.id, { autoLaunch: true }));
        grid.appendChild(card);
      }
      if (!list.length) grid.innerHTML = `<p class="dim">Brak wyników.</p>`;
    };
    draw("");
    document.getElementById("ver-filter").addEventListener("input", (e) => draw(e.target.value));
    document.getElementById("cta-play")?.addEventListener("click", () => {
      if (sel) ensureInstalled(sel, { autoLaunch: true });
    });
  })().catch((e) => { console.error(e); toast("Błąd katalogu: " + e.message, "err"); });
}

/* ---------------- ekran: instancje ---------------- */

export function renderInstances() {
  spinner("Sprawdzanie zainstalowanych wersji…");
  (async () => {
    const ids = await listInstalledIds();
    const rows = [];
    for (const id of ids) {
      const info = await installedInfo(id);
      rows.push({ id, info });
    }
    if (!rows.length) {
      view.innerHTML = `<section class="panel"><h2>Instancje</h2>
        <p class="dim">Nie zainstalowano jeszcze żadnej wersji gry.</p>
        <button class="btn primary" id="go-home">Przeglądaj wersje</button></section>`;
      document.getElementById("go-home").addEventListener("click", () => { location.hash = "#/home"; });
      return;
    }
    view.innerHTML = `<section class="panel">
      <h2>Instancje (pliki w Cache Storage)</h2>
      <div class="inst-grid" id="inst-list"></div></section>`;
    const list = document.getElementById("inst-list");
    for (const { id, info } of rows) {
      const el = document.createElement("div");
      el.className = "inst-card static inst-ok";
      el.innerHTML = `<div class="inst-top"><b>${esc(id)}</b>
          <span class="badge-era">${info?.patched ? "patched" : "vanilla"}</span></div>
        <div class="inst-meta">${info?.files || "?"} plików · ${fmtBytes(info?.bytes)}
          · assety: ${info?.assets ?? "?"}</div>
        <div class="row gap">
          <button class="btn primary" data-play="${esc(id)}">Graj</button>
          <button class="btn danger" data-del="${esc(id)}">Usuń</button>
        </div>`;
      list.appendChild(el);
    }
    list.querySelectorAll("[data-play]").forEach((b) =>
      b.addEventListener("click", () => ensureInstalled(b.dataset.play, { autoLaunch: true })));
    list.querySelectorAll("[data-del]").forEach((b) =>
      b.addEventListener("click", () => { if (confirm(`Usunąć pliki wersji ${b.dataset.del}?`)) removeInstance(b.dataset.del); }));
  })().catch((e) => toast("Błąd: " + e.message, "err"));
}

/* ---------------- ekran: ustawienia ---------------- */

export function renderSettings() {
  const p = store.state.prefs;
  const dev = detectDevice();
  const ram = findBestRAMAllocation(dev.deviceRamMB || 4096);
  view.innerHTML = `<section class="panel">
    <h2>Ustawienia</h2>
    <div class="form-grid">
      <label>Skalowanie rozdzielczości
        <select class="input" data-pref="renderScale">
          ${opt(p.renderScale, [["auto", `auto (cel 720p/1080p jak Mojo)`], ["100", "100%"], ["75", "75%"], ["50", "50%"], ["30", "30%"]])}
        </select></label>
      <label>Render distance (options.txt)
        <select class="input" data-pref="rd">
          ${opt(p.rd, [["auto", "auto wg urządzenia"], ["2", "2 chunki"], ["4", "4 chunki"], ["6", "6 chunków"], ["8", "8 chunków"]])}
        </select></label>
      <label>Maks. FPS (options.txt)
        <select class="input" data-pref="maxFps">
          ${opt(p.maxFps, [["auto", "auto (60/120)"], ["30", "30"], ["60", "60"], ["120", "120"]])}
        </select></label>
      <label class="chk"><input type="checkbox" data-pref="fancy" ${p.fancy ? "checked" : ""}> Fancy graphics</label>
      <label class="chk"><input type="checkbox" data-pref="hud" ${p.hud ? "checked" : ""}> HUD (FPS/heap)</label>
      <label>Nakładka dotykowa
        <select class="input" data-pref="touch">
          ${opt(p.touch, [["auto", "auto (ekrany dotykowe)"], ["on", "zawsze"], ["off", "wyłączona"]])}
        </select></label>
    </div>
    <div class="note">
      <b>AutoRAM po naszej stronie:</b> CheerpJ trzyma heap WASM-a sam
      (limit „-Xmx" nie istnieje w przeglądarce), więc odpowiednik AutoRAM
      MojoLaunchera w tej wersji steruje <i>options.txt</i> (render distance,
      FPS, fancy) + skalerem rozdzielczości. Karta startowa podaje, ile
      RAM-u widzi przeglądarka (${ram} MB wg tabeli Mojo) – to wpływa na
      dobór presetu, a nie na flagi JVM.
    </div>
  </section>`;
  view.querySelectorAll("[data-pref]").forEach((el) => {
    el.addEventListener("change", () => {
      const k = el.dataset.pref;
      const v = el.type === "checkbox" ? el.checked : el.value;
      store.setPref(k, k === "rd" || k === "maxFps" ? (v === "auto" ? null : Number(v)) : v);
      toast("Zapisano: " + k);
    });
  });
}
function opt(cur, pairs) {
  return pairs.map(([v, label]) =>
    `<option value="${v}" ${String(cur ?? "auto") === String(v) ? "selected" : ""}>${label}</option>`).join("");
}

/* ---------------- ekran: args startowe ---------------- */

export function renderJava() {
  spinner("Budowanie listy argumentów startowych…");
  (async () => {
    const installed = await listInstalledIds();
    const id = (store.state.selected && installed.includes(store.state.selected))
      ? store.state.selected
      : installed[0] || "1.12.2";
    const plan = await resolvePlan(id);
    const args = buildArgs(plan, {
      name: store.state.profile.name,
      uuid: store.state.profile.uuid,
      accessToken: "0",
      userType: "legacy",
    }, plan.type);
    const base = `/app/data/vanilla/${id}`;
    const cp = [
      ...plan.libs.map((l) => `${base}/libraries/${l.path}`),
      `${base}/client.jar`,
    ];
    const cmd = `cheerpjRunMain(${plan.mainClass},\n  classpath: ${cp.length} plików,\n  args:\n    ${args.join("\n    ") || "(brak – bardzo stare wersje)"})`;
    const preset = buildOptionsPreset(store.state.prefs);

    view.innerHTML = `<section class="panel">
      <h2>Args startowe · ${esc(id)}</h2>
      <p class="dim">Składnia uruchomienia niezmodyfikowanego klienta
        (jak w oficjalnym launcherze; nasza warstwa AutoRAM ≡ preset options.txt poniżej).</p>
      <pre class="code" id="args-block">${esc(cmd)}</pre>
      <div class="row gap"><button class="btn" id="copy-args">Kopiuj</button>
        <button class="btn" id="reload-args">Inna wersja…</button></div>
      <h3>options.txt (presety startowe)</h3>
      <pre class="code">${esc(preset)}</pre>
      <div class="form-grid">
        <div><b>mainClass:</b> ${esc(plan.mainClass)}</div>
        <div><b>Java:</b> ${plan.javaMajor} (CheerpJ: ${plan.javaMajor >= 17 ? "17" : "8"})</div>
        <div><b>biblioteki:</b> ${plan.libs.length}</div>
        <div><b>szablon args:</b> ${plan.hasArgsTemplate ? "minecraftArguments (legacy)" : "współczesny"}</div>
      </div>
      <div class="note">Wersja1.12.2 startuje znanym zestawem poprawek klienta
        (crash-report, NIO lokalnej sieci, hasResource, modele) – nakładane
        lokalnie na Twoim pobranym pliku, bez redystrybucji. Inne wersje:
        vanillowo, o ile mapowania Mojang pozwolą dołożyć poprawki.</div>
    </section>`;
    document.getElementById("copy-args").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(cmd); toast("Skopiowano."); }
      catch { toast("Schowek niedostępny.", "warn"); }
    });
    document.getElementById("reload-args").addEventListener("click", () => { location.hash = "#/home"; });
  })().catch((e) => {
    view.innerHTML = `<section class="panel"><h2>Args</h2><p>Błąd: ${esc(e.message)}</p></section>`;
  });
}

/* ---------------- ekran: o projekcie ---------------- */

export function renderAbout() {
  const dev = detectDevice();
  view.innerHTML = `<section class="panel">
    <h2>O projekcie</h2>
    <p>Launcher na bazie analizy <b>MojoLauncher/MJLauncher</b> – jego pomysły
      przeniesione do przeglądarki: AutoRAM (widoczny RAM: ${dev.deviceRamMB || "?"} MB →
      preset oszczędny), skaler rozdzielczości do celu 720p/1080p, warstwa
      ustawień startowych.</p>
    <h3>Jak działa „oryginał"</h3>
    <ul>
      <li><b>client.jar, biblioteki i assety</b> pobiera Twoja przeglądarka
        <u>bezpośrednio z serwerów Mojang</u> (piston-meta/piston-data,
        weryfikacja SHA-1). W repozytorium nie ma ani jednego pliku gry.</li>
      <li><b>JVM w WASM:</b> CheerpJ (Leaning Technologies) – CheerpJ Community
        Edition, bezpłatna do zastosowań niekomercyjnych.</li>
      <li><b>OpenGL:</b> gl4es (LGPL) → WebGL – dokładnie jak w MojoLauncherze
        na Androidzie; warstwa LWJGL = wasm z projektu Browsercraft (Apache-2.0).</li>
      <li><b>Sieć:</b> przeglądarka nie ma TCP, więc multiplayer idzie przez
        nasz gateway WebSocket↔TCP (endpoint <code>/gw</code>). Zasięg:
        wersje do 1.6 = pełny zestaw gniazdec; 1.7+ (Netty/NIO) =
        <b>eksperymentalny</b> – selector CheerpJ dopiero ogarniamy na podglądzie.</li>
      <li><b>Logowanie:</b> tryb offline (nick bez konta) – serwery
        <i>online-mode=off</i> działają od razu; premium (Hypixel) wymaga
        logowania Microsoft, którego nie da się zrobić tu bez Twojej aplikacji Azure.</li>
    </ul>
    <h3>Zakres wersji</h3>
    <p>Wszystkie wydania do <b>1.12.2</b> włącznie + stare beta/alfa – bo tyle
      obejmuje niezmodyfikowany klient na LWJGL 2. Nowsze (1.13+) wymagają
      warstwy LWJGL3, której w ekosystemie jeszcze nie ma.</p>
    <h3>Prawne</h3>
    <p>Kod: ten repozytorium. Inspiracja analizą MojoLauncher (LGPL-3.0) –
      cytujemy reguły, nie kod. Minecraft © Mojang/Microsoft; nie jesteśmy
      z nimi powiązani. Pliki gry: pobierane przez Ciebie, na Twój użytek.</p>
    <p class="dim">Źródła techniczne: leaningtech/browsercraft (Apache-2.0),
      mandoof1/browser-minecraft-official, AmphibianDev/webmc-port, dokumentacja
      CheerpJ – szczegóły w <code>vendor/LICENSES.md</code> i README.</p>
  </section>`;
}

/* ---------------- profil ---------------- */

export function syncProfileChip() {
  const chip = document.getElementById("profile-chip");
  if (chip) chip.textContent = store.state.profile.name;
}
