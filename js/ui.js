/**
 * ui.js – ekrany launchera (hash-routery), toasty, modal instalacji.
 */

import { store } from "./store.js";
import { CATALOG, getCatalogItem } from "./catalog.js";
import {
  detectDevice, findBestRAMAllocation, buildJvmArgs, autoRamToast,
} from "./mojo.js";
import { installInstance, uninstallInstance, instanceBytes, InstallCancelled } from "./installer.js";
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
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
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
  modalTitle.textContent = title;
  modalFill.style.width = "0%";
  modalStatus.textContent = "Przygotowywanie…";
  modalLog.textContent = "";
  modal.hidden = false;
  abortCtl = new AbortController();
  return abortCtl;
}
function modalClose() { modal.hidden = true; abortCtl = null; }

function modalProgress(p) {
  const pct = p.total ? Math.round((p.done / p.total) * 100) : (p.phase === "listing" ? 8 : 0);
  modalFill.style.width = Math.max(pct, p.phase === "listing" ? 4 : 0) + "%";
  if (p.phase === "listing") modalStatus.textContent = "Pobieranie listy plików buildu…";
  else if (p.phase === "downloading") {
    modalStatus.textContent = `${p.done}/${p.total} plików · ${fmtBytes(p.bytes)} · ${p.file}`;
  } else if (p.phase === "done") {
    modalStatus.textContent = `Gotowe: ${p.total} plików · ${fmtBytes(p.bytes)}`
      + (p.verified ? ` · SHA-256 OK (${p.verified})` : "");
    modalFill.style.width = "100%";
  }
  if (p.log?.length) modalLog.textContent = p.log.slice(-12).join("\n");
}

export function askCancelInstall() {
  abortCtl?.abort();
}

/**
 * Czeka na aktywny Service Worker, ale maksymalnie `timeout` ms –
 * bez tego nieudana rejestracja zawiesiłaby instalację/launch.
 */
export async function swReady(timeout = 3500) {
  if (!("serviceWorker" in navigator)) return false;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready.then(() => true, () => false),
      new Promise((r) => setTimeout(() => r(false), timeout)),
    ]);
  } catch { return false; }
}

/* ---------------- przepływ instalacji ---------------- */

export async function ensureInstalled(catalogId, { autoLaunch = false } = {}) {
  const item = getCatalogItem(catalogId);
  if (!item) { toast("Nieznana pozycja katalogu.", "err"); return; }
  const existing = store.findByCatalog(catalogId);
  if (existing) {
    store.select(existing.instId);
    if (autoLaunch) launchInstance(existing);
    return;
  }

  const instId = `i-${catalogId}`;
  await swReady();
  if (store.findByCatalog(catalogId)) return; // drugi klik w międzyczasie
  const ctl = modalOpen(`Instalacja: ${item.title}`);
  modalCancel.hidden = false;
  try {
    const stats = await installInstance(instId, item, {
      signal: ctl.signal,
      mirror: store.state.prefs.mirror || "auto",
      onProgress: modalProgress,
    });
    const inst = {
      instId, catalogId, name: item.title,
      installedAt: Date.now(), bytes: stats.bytes, verified: stats.verified || 0,
    };
    store.upsertInstance(inst);
    store.select(instId);
    modalClose();
    document.getElementById("sb-bufor").textContent = `Bufor: ${fmtBytes(stats.bytes)}`;
    toast(`Zainstalowano: ${item.title} (${fmtBytes(stats.bytes)})`
      + (stats.verified ? ` · SHA-256 OK` : ""));
    if (autoLaunch) launchInstance(inst);
    else location.hash = "#/instances";
  } catch (e) {
    modalClose();
    if (e instanceof InstallCancelled || e.name === "AbortError") toast("Instalacja anulowana.", "warn");
    else toast(`Instalacja nieudana: ${e.message}`, "err");
  }
}

export async function removeInstance(instId) {
  await uninstallInstance(instId);
  store.removeInstance(instId);
  toast("Instancja usunięta (pliki gry wyczyszczone).", "warn");
}

/* ---------------- statusbar ---------------- */

export function refreshStatusbar() {
  const d = detectDevice();
  document.getElementById("sb-ram").textContent =
    `AutoRAM: ${d.ramMb} MB heap (urządzenie ${d.deviceRamMB >= 1024 ? (d.deviceRamMB / 1024).toFixed(1) + " GB" : d.deviceRamMB + " MB"})`;
  document.getElementById("sb-renderer").textContent = `Renderer: ${d.renderer.short} · skala ${d.resolutionPct}%`;
}

/* =========================================================
   EKRANY
   ========================================================= */

function instState(catalogId) {
  const inst = store.findByCatalog(catalogId);
  return inst && inst.installed !== false ? inst : null;
}

function selectedOrDefault() {
  const sel = store.state.selected && store.findInstance(store.state.selected);
  if (sel) return sel;
  const installed = store.state.instances[0];
  return installed || null;
}

function recommendedItem(device) {
  if (device.lowRam) return getCatalogItem("classic-0017a");
  if (device.deviceRamMB < 2048 || device.cores <= 2) return getCatalogItem("release-152");
  return getCatalogItem("release-188-wasm");
}

/* ---------------- HOME ---------------- */

export function renderHome() {
  const d = detectDevice();
  const rec = recommendedItem(d);
  const sel = selectedOrDefault();
  const selItem = (sel ? getCatalogItem(sel.catalogId) : null) || rec;
  const installed = sel ? instState(sel.catalogId) : instState(rec.id);

  const recent = [...store.state.instances]
    .filter((i) => i.lastPlayed)
    .sort((a, b) => b.lastPlayed - a.lastPlayed)
    .slice(0, 4);

  view.innerHTML = `
  <section class="hero">
    <img src="assets/hero.png" alt="" onerror="this.style.display='none'">
    <div class="hero-shade"></div>
    <div class="hero-txt">
      <h1>Oryginalny Minecraft<br><b>w przeglądarce</b></h1>
      <p>Launcher zbudowany według idei MojoLauncher: AutoRAM dla maszyn poniżej 1 GB,
         skalowanie rozdzielczości, weryfikacja SHA plików i instancje oryginalnych
         wersji gry – bez instalacji, prosto z sieci.</p>
      <button class="btn big" data-act="play">▶ Graj teraz</button>
      <span class="pill ${installed ? "ok" : "warn"}" style="margin-left:12px">
        ${installed ? "zainstalowana" : "wymaga instalacji · " + fmtBytes(selItem.sizeBytes)}
      </span>
    </div>
  </section>

  <div class="home-grid">
    <section class="panel play-card">
      <div class="inst-icon ${selItem.eraClass}"></div>
      <div class="play-meta">
        <div class="era">${esc(selItem.era)}</div>
        <div class="title">${esc(selItem.title)}</div>
        <div class="hint">${esc(selItem.desc)}</div>
        ${recent.length ? `<div class="hint">Ostatnio grane: ${recent.map((r) => esc(r.name)).join(" · ")}</div>` : ""}
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn" data-act="play">Uruchom</button>
        <a class="btn ghost" href="#/instances" style="color:inherit">Zmień</a>
      </div>
    </section>

    <section class="panel mojo-card">
      <div class="label">Tryb Mojo · AutoRAM</div>
      <div class="big-num">${d.ramMb}<small> MB heap</small></div>
      <div class="mojo-row"><span>Pamięć urządzenia</span><span class="v">${d.deviceRamMB} MB</span></div>
      <div class="mojo-row"><span>Rdzenie CPU</span><span class="v">${d.cores}</span></div>
      <div class="mojo-row"><span>Min. bok ekranu</span><span class="v">${d.minSidePx} px</span></div>
      <div class="mojo-row"><span>Skaler rozdzielczości</span><span class="v hi">${d.resolutionPct} % (cel 720p/1080p)</span></div>
      <div class="mojo-row"><span>Renderer</span><span class="v">${esc(d.renderer.label)}</span></div>
      <div class="mojo-row"><span>Klasa urządzenia</span>
        <span class="v ${d.powerful ? "" : "hi"}">${d.powerful ? "mocne" : "zwykłe → tryb oszczędny"}</span></div>
      ${d.lowRam ? `<div class="rec-note">⚠ Wykryto &lt;1 GB RAM – dokładnie ten przypadek MojoLauncher obsługuje flagą 296 MB.
         Polecana lekka instancja: <b>${esc(rec.title)}</b></div>` : ""}
      ${d.lowRam ? `<div style="margin-top:10px"><button class="btn ghost" data-act="rec">Zainstaluj polecane (${esc(rec.title)})</button></div>` : ""}
    </section>
  </div>

  <h2>Jak to działa</h2>
  <div class="home-grid" style="grid-template-columns:repeat(auto-fit,minmax(230px,1fr))">
    <section class="panel"><h3>1 · Wykrywanie sprzętu</h3>
      <p class="sub" style="margin:0">Te same tabele co w MojoLauncherze: RAM → heap,
      mocne urządzenie → skaler rozdzielczości, WebGL2 → tryb LTW.</p></section>
    <section class="panel"><h3>2 · Instalacja instancji</h3>
      <p class="sub" style="margin:0">Build wersji ląduje w Cache Storage z weryfikacją
      SHA-256 (jak PREF_VERIFY_FILES). Potem gra działa z Twojej pamięci podręcznej.</p></section>
    <section class="panel"><h3>3 · Uruchomienie</h3>
      <p class="sub" style="margin:0">Gra startuje w iframe z ustawioną skalą
      i HUD-em (FPS/heap/bufor) – bez chmury i bez konta Microsoft.</p></section>
    <section class="panel"><h3>4 · Java args</h3>
      <p class="sub" style="margin:0">Podgląd flag JVM złożonych dokładnie jak
      w JavaRunner: Xms=Xmx, ActiveProcessorCount, filtry preprocessUserArgs.</p></section>
  </div>`;

  view.querySelectorAll('[data-act="play"]').forEach((b) => b.addEventListener("click", () => {
    ensureInstalled(selItem.id, { autoLaunch: true });
  }));
  view.querySelector('[data-act="rec"]')?.addEventListener("click", () => {
    ensureInstalled(rec.id, { autoLaunch: true });
  });
}

/* ---------------- INSTANCJE ---------------- */

export function renderInstances() {
  const cards = CATALOG.map((c) => {
    const inst = instState(c.id);
    const size = inst?.bytes || c.sizeBytes;
    return `
    <section class="panel inst-card" data-id="${c.id}">
      <div class="row">
        <div class="inst-icon ${c.eraClass}" style="width:52px;height:52px"></div>
        <div>
          <span class="badge-era ${c.eraClass}">${esc(c.era)}</span>
          <div class="title" style="font-weight:800;font-size:16px;margin-top:4px">${esc(c.title)}</div>
        </div>
      </div>
      <div class="desc">${esc(c.desc)}</div>
      <div class="desc" style="font-family:var(--mono);font-size:11.5px">
        ${esc(c.src.repo)}@${esc(c.src.ref)}<br>${esc(c.src.entry)}
      </div>
      <div class="foot">
        <span class="pill ${inst ? "ok" : ""}">${inst ? "✓ " + fmtBytes(size) : fmtBytes(size)}</span>
        ${inst?.verified ? `<span class="pill info" title="Weryfikacja SHA-256 z manifestu buildu">sha ok</span>` : ""}
        <span class="grow"></span>
        ${inst ? `
          <button class="btn" data-launch="${c.id}">Graj</button>
          <button class="btn ghost" data-remove="${c.id}" title="Usuń pliki">✕</button>
        ` : `
          <button class="btn blue" data-install="${c.id}">Zainstaluj</button>
        `}
      </div>
    </section>`;
  }).join("");

  view.innerHTML = `
    <h1>Instancje</h1>
    <p class="sub">Oryginalne wersje Minecrafta przepakowane do JS/WASM
    (Eaglercraft/TeaVM). Launcher pobiera je z GitHuba przy instalacji –
    dokładnie tak jak MojoLauncher pobiera oryginalne pliki gry przy pierwszym starcie.</p>
    <div class="inst-grid">${cards}</div>
    <div class="note">Część źródłowych portów bywa usuwana na żądanie Mojang (DMCA) –
    jeśli instalacja nie przejdzie, spróbuj innej instancji; wpisy w katalogu są na bieżąco weryfikowane.</div>`;

  view.querySelectorAll("[data-install]").forEach((b) =>
    b.addEventListener("click", () => ensureInstalled(b.dataset.install)));
  view.querySelectorAll("[data-launch]").forEach((b) =>
    b.addEventListener("click", () => {
      const inst = instState(b.dataset.launch);
      if (inst) { store.select(inst.instId); launchInstance(inst); }
    }));
  view.querySelectorAll("[data-remove]").forEach((b) =>
    b.addEventListener("click", async () => {
      const inst = instState(b.dataset.remove);
      if (inst) { await removeInstance(inst.instId); renderInstances(); }
    }));
}

/* ---------------- USTAWIENIA ---------------- */

export function renderSettings() {
  const p = store.state.prefs;
  const d = detectDevice();
  const autoRam = findBestRAMAllocation(d.deviceRamMB);
  const ramValue = p.ramMode === "custom" && p.ramMb ? p.ramMb : autoRam;
  const scaleValue = typeof p.renderScale === "number" ? p.renderScale : d.resolutionPct;

  view.innerHTML = `
    <h1>Ustawienia</h1>
    <p class="sub">Profile, AutoRAM i preferencje launchera – te same suwaki co w
    MojoLauncherze, przeniesione na przeglądarkę.</p>

    <section class="panel">
      <h2 style="margin-top:0">Profil</h2>
      <div class="form-row">
        <div class="fl"><div class="t">Nick gracza</div>
          <div class="d">Widoczny w launcherze; worldy i tak trzyma gra (IndexedDB).</div></div>
        <input type="text" id="set-nick" maxlength="24" value="${esc(store.state.profile.name)}">
      </div>
      <div class="form-row">
        <div class="fl"><div class="t">UUID profilu</div><div class="d">Losowo wygenerowane, lokalne.</div></div>
        <code style="font-size:11px;color:var(--muted)">${esc(store.state.profile.uuid)}</code>
      </div>
    </section>

    <section class="panel">
      <h2 style="margin-top:0">Pamięć (AutoRAM)</h2>
      <div class="form-row">
        <div class="fl"><div class="t">Tryb przydziału</div>
          <div class="d">Auto = tabela z findBestRAMAllocation(): &lt;1 GB → 296 MB,
          &lt;1,5 GB → 448 MB, &lt;2 GB → 656 MB … ≥6 GB → 2048 MB.</div></div>
        <div class="seg" id="seg-ram">
          <button data-v="auto" class="${p.ramMode === "auto" ? "on" : ""}">Auto</button>
          <button data-v="custom" class="${p.ramMode === "custom" ? "on" : ""}">Ręcznie</button>
        </div>
      </div>
      <div class="form-row">
        <div class="fl"><div class="t">Xms = Xmx: <span id="ram-out">${ramValue}</span> MB</div>
          <div class="d">Tak jak w MojoLauncherze heap jest stały – bez skoków GC.</div></div>
        <input type="range" id="set-ram" min="192" max="2048" step="32" value="${ramValue}"
          ${p.ramMode === "auto" ? "disabled" : ""}>
      </div>
    </section>

    <section class="panel">
      <h2 style="margin-top:0">Wideo</h2>
      <div class="form-row">
        <div class="fl"><div class="t">Skaler rozdzielczości: <span id="scale-out">${scaleValue}</span>%</div>
          <div class="d">Auto = findBestResolution(): cel 720p dla zwykłych urządzeń,
          1080p dla mocnych, skok co 5%.</div></div>
        <div class="seg" id="seg-scale">
          <button data-v="auto" class="${p.renderScale === "auto" ? "on" : ""}">Auto</button>
          <button data-v="custom" class="${typeof p.renderScale === "number" ? "on" : ""}">Ręcznie</button>
        </div>
        <input type="range" id="set-scale" min="30" max="100" step="5" value="${scaleValue}"
          ${p.renderScale === "auto" ? "disabled" : ""}>
      </div>
      <div class="form-row">
        <div class="fl"><div class="t">Renderer (wykrywany)</div>
          <div class="d">${esc(d.renderer.label)} – ${esc(d.renderer.note)}</div></div>
        <span class="pill info">${esc(d.renderer.short)}</span>
      </div>
      <div class="form-row">
        <div class="fl"><div class="t">HUD (FPS / heap / bufor)</div>
          <div class="d">Metryki startu gry w stylu debug MCP.</div></div>
        <label class="switch"><input type="checkbox" id="set-hud" ${p.hud ? "checked" : ""}><i></i></label>
      </div>
      <div class="form-row">
        <div class="fl"><div class="t">Sterowanie dotykowe</div>
          <div class="d">Nakładka D-pad + przyciski (jak custom controls w Pojav/Mojo).</div></div>
        <div class="seg" id="seg-touch">
          <button data-v="auto" class="${p.touch === "auto" ? "on" : ""}">Auto</button>
          <button data-v="on" class="${p.touch === "on" ? "on" : ""}">Wł.</button>
          <button data-v="off" class="${p.touch === "off" ? "on" : ""}">Wył.</button>
        </div>
      </div>
    </section>

    <section class="panel">
      <h2 style="margin-top:0">Pobieranie</h2>
      <div class="form-row">
        <div class="fl"><div class="t">Mirror źródłowy</div>
          <div class="d">Skąd ciągniemy buildy: raw.githubusercontent ↔ jsdelivr.</div></div>
        <div class="seg" id="seg-mirror">
          <button data-v="auto" class="${p.mirror === "auto" ? "on" : ""}">Auto</button>
          <button data-v="raw" class="${p.mirror === "raw" ? "on" : ""}">Raw</button>
          <button data-v="jsdelivr" class="${p.mirror === "jsdelivr" ? "on" : ""}">jsDelivr</button>
        </div>
      </div>
      <div class="form-row">
        <div class="fl"><div class="t">Dane gry w przeglądarce</div>
          <div class="d" id="storage-info">liczenie…</div></div>
        <button class="btn danger" id="btn-clear">Wyczyść wszystko</button>
      </div>
    </section>`;

  // — nick
  view.querySelector("#set-nick").addEventListener("change", (e) => {
    store.setProfileName(e.target.value);
    syncProfileChip();
    toast("Profil zapisany.");
  });

  // — ram
  view.querySelectorAll("#seg-ram button").forEach((b) => b.addEventListener("click", () => {
    store.setPref("ramMode", b.dataset.v);
    renderSettings();
  }));
  view.querySelector("#set-ram").addEventListener("input", (e) => {
    view.querySelector("#ram-out").textContent = e.target.value;
  });
  view.querySelector("#set-ram").addEventListener("change", (e) => {
    store.setPref("ramMb", Number(e.target.value));
    refreshStatusbar();
  });

  // — skala
  view.querySelectorAll("#seg-scale button").forEach((b) => b.addEventListener("click", () => {
    store.setPref("renderScale", b.dataset.v === "auto" ? "auto" : Number(view.querySelector("#set-scale").value));
    renderSettings();
  }));
  view.querySelector("#set-scale").addEventListener("input", (e) => {
    view.querySelector("#scale-out").textContent = e.target.value;
  });
  view.querySelector("#set-scale").addEventListener("change", (e) => {
    store.setPref("renderScale", Number(e.target.value));
    refreshStatusbar();
  });

  // — toggles / segmenty
  view.querySelector("#set-hud").addEventListener("change", (e) => store.setPref("hud", e.target.checked));
  for (const [sel, key] of [["#seg-touch", "touch"], ["#seg-mirror", "mirror"]]) {
    view.querySelectorAll(`${sel} button`).forEach((b) => b.addEventListener("click", () => {
      store.setPref(key, b.dataset.v);
      renderSettings();
    }));
  }

  // — storage
  (async () => {
    const el = view.querySelector("#storage-info");
    if (!el) return;
    const parts = [];
    for (const i of store.state.instances) {
      const b = await instanceBytes(i.instId);
      parts.push(`${esc(i.name)}: ${fmtBytes(b)}`);
    }
    el.innerHTML = parts.length
      ? parts.join("<br>")
      : "Brak zainstalowanych instancji – gry ważą 1–50 MB w Cache Storage.";
  })();

  view.querySelector("#btn-clear").addEventListener("click", async () => {
    if (!confirm("Usunąć WSZYSTKIE zainstalowane instancje i worldy trzymane przez gry?")) return;
    for (const i of store.state.instances) await uninstallInstance(i.instId);
    store.state.instances = [];
    store.select(null);
    store.save();
    toast("Wyczyszczono pamięć gier.", "warn");
    renderSettings();
  });
}

/* ---------------- JAVA ARGS ---------------- */

export function renderJava() {
  const p = store.state.prefs;
  const d = detectDevice();
  const ramMb = p.ramMode === "custom" && p.ramMb ? p.ramMb : d.ramMb;
  const userArgs = (p.userArgs || "").split(/\s+/).filter(Boolean);
  const args = buildJvmArgs({ userArgs, ramMb, cores: d.cores, gameDir: "./game", tmpDir: "./tmp" });
  const joined = args.join(" \\\n  ");

  view.innerHTML = `
    <h1>Java args</h1>
    <p class="sub">Argumenty JVM składane dokładnie jak w
    <code>JavaRunner.getJavaArgs()</code> MojoLaunchera: najpierw filtr
    <code>preprocessUserArgs</code>, potem domyślne flagi niedostarczone przez
    użytkownika. Ten podgląd możesz skopiować i użyć przy prawdziwym JRE.</p>

    <section class="panel">
      <h2 style="margin-top:0">Twoje flagi (dokładane na wierzch)</h2>
      <div class="form-row">
        <div class="fl"><div class="t">userArgs</div>
          <div class="d">np. <code>-XX:+UseZGC -Dmojo.custom=1</code> – flagi startowe
          użytkownika; Xms/Xmx/ActiveProcessorCount z tej listy są odsiewane (jak u nich).</div></div>
      </div>
      <textarea class="code" id="user-args" spellcheck="false"
        placeholder="-XX:+UseG1GC -Dtwoja.flaga=1">${esc(p.userArgs || "")}</textarea>
      <div style="margin-top:10px;display:flex;gap:10px">
        <button class="btn" id="save-args">Przebuduj podgląd</button>
        <button class="btn ghost" id="copy-args">Kopiuj gotową komendę</button>
      </div>
    </section>

    <section class="panel" style="margin-top:16px">
      <h2 style="margin-top:0">Wygenerowane argumenty startowe</h2>
      <textarea class="code" id="gen-args" readonly spellcheck="false">${esc(joined)}</textarea>
      <div class="note green" style="margin-bottom:0">
        ${esc(autoRamToast({ ...d, ramMb, resolutionPct: d.resolutionPct }))}
      </div>
    </section>

    <section class="panel" style="margin-top:16px">
      <h2 style="margin-top:0">Parity z MojoLauncherem</h2>
      <table class="kv-table">
        <thead><tr><th>Flaga / reguła</th><th>U nich (Android)</th><th>Tu (web)</th></tr></thead>
        <tbody>
          <tr><td class="mono">-Xms / -Xmx</td><td>AutoRAM: 296…2048 MB, Xms=Xmx</td><td class="mono">-Xms${ramMb}M -Xmx${ramMb}M</td></tr>
          <tr><td class="mono">ActiveProcessorCount</td><td>dodawany na końcu startJvm</td><td class="mono">-XX:ActiveProcessorCount=${d.cores}</td></tr>
          <tr><td class="mono">filtr użytkownika</td><td>preprocessUserArgs() zdejmuje Xms/Xmx/-cp/-Xint…</td><td>ta sama reguła w buildJvmArgs()</td></tr>
          <tr><td class="mono">-Dlog4j2.formatMsgNoLookups</td><td>tak (ochrona Log4Shell)</td><td>tak</td></tr>
          <tr><td class="mono">-Dfml.earlyprogresswindow</td><td>false (Forge 1.14+)</td><td>false</td></tr>
          <tr><td class="mono">-Dloader.disable_forked_guis</td><td>true</td><td>true</td></tr>
          <tr><td class="mono">-Dos.name / Process.launchMechanism</td><td>Linux + FORK (Android)</td><td>tylko w trybie androidExtras</td></tr>
          <tr><td class="mono">warstwa „mojson"</td><td>argumenty JVM z JSON-a wersji gry</td><td>odpowiednik: bootParams instancji</td></tr>
        </tbody>
      </table>
    </section>`;

  view.querySelector("#save-args").addEventListener("click", () => {
    store.setPref("userArgs", view.querySelector("#user-args").value.trim());
    renderJava();
    toast("Przebudowano podgląd argumentów.");
  });
  view.querySelector("#copy-args").addEventListener("click", async () => {
    const text = "java " + view.querySelector("#gen-args").value.replace(/\\\n\s+/g, " ") + " net.minecraft.client.main.Main";
    try { await navigator.clipboard.writeText(text); toast("Skopiowano komendę."); }
    catch { toast("Kopiowanie zablokowane przez przeglądarkę.", "warn"); }
  });
}

/* ---------------- O PROJEKCIE ---------------- */

export function renderAbout() {
  view.innerHTML = `
    <h1>O projekcie</h1>
    <p class="sub"><b>mc-launcher</b> to przeglądarkowy launcher Minecrafta
    zbudowany na podstawie analizy <b>MojoLauncher (MJLauncher)</b> –
    launchera Androidowego (fork PojavLaunchera), który potrafi uruchomić
    Minecrafta na urządzeniu z mniej niż 1 GB RAM-u.</p>

    <section class="panel">
      <h2 style="margin-top:0">Co przejęliśmy z analizy</h2>
      <ul style="line-height:1.7">
        <li><b>AutoRAM</b> – tabelę przydziału heap-u (296/448/656/936/1144/1536/2048 MB)
            i zasadę „Xms = Xmx, bez skoków GC";</li>
        <li><b>findBestResolution</b> – skaler rozdzielczości do celu 720p/1080p, skok co 5%;</li>
        <li><b>isDevicePowerful</b> – klasyfikacja sprzętu i tryb oszczędny;</li>
        <li><b>Java args</b> – filtr preprocessUserArgs i warstwa domyślnych flag
            (Log4Shell, Forge, wykrywanie javaagent);</li>
        <li><b>Renderer</b> – mapa GL4ES→WebGL1, LTW→WebGL2 (odpowiedniki ich wyboru
            OpenGL ES 2/3);</li>
        <li><b>Instalacja plików gry + SHA-256</b> – jak ich pobieranie plików
            i PREF_VERIFY_FILES.</li>
      </ul>
    </section>

    <section class="panel" style="margin-top:16px">
      <h2 style="margin-top:0">Źródła i podziękowania</h2>
      <ul style="line-height:1.7">
        <li><a href="https://github.com/MojoLauncher/MojoLauncher" target="_blank" rel="noopener">MojoLauncher/MojoLauncher</a>
            – kod źródłowy (LGPL-3.0), z którego czytaliśmy logikę launchera;</li>
        <li>build AAB z historii repozytorium (2021) – rozłożony w <code>mojo-apk/</code>
            wraz z <a href="docs/analiza-mojolauncher.md">pełną analizą</a>;</li>
        <li>porty gry: <a href="https://github.com/lDEVinux/eaglercraft" target="_blank" rel="noopener">Eaglercraft</a>,
            <a href="https://github.com/PeytonPlayz595" target="_blank" rel="noopener">PeytonPlayz595</a>,
            <a href="https://github.com/radmanplays" target="_blank" rel="noopener">radmanplays</a>,
            <a href="https://github.com/mandoof1/browser-minecraft" target="_blank" rel="noopener">browser-minecraft</a>;</li>
        <li><a href="docs/analiza-mojolauncher.md">Dokument analizy (Markdown)</a>.</li>
      </ul>
      <div class="note">Nie jesteśmy powiązani z Mojang ani z projektem MojoLauncher.
      Minecraft jest znakiem towarowym Mojang/Microsoft – porty w katalogu to
      społeczne kompilacje oryginalnego kodu gry do JS/WASM, a sam launcher nie
      zawiera żadnych plików gry. Do zabawy na serwerach sieciowych potrzebujesz
      własnej, legalnej kopii gry – tryb offline działa bez konta.</div>
    </section>`;
}

/* ---------------- profil w topbarze ---------------- */

export function syncProfileChip() {
  document.getElementById("profile-name").textContent = store.state.profile.name;
  const face = document.getElementById("profile-face");
  const hue = [...store.state.profile.uuid].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  face.style.filter = `hue-rotate(${hue}deg)`;
}
