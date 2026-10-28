/**
 * catalog.js – katalog „sklejonych" oryginalnych wersji Minecrafta
 * przepakowanych do JS/WASM (Eaglercraft/TeaVM). Launcher pobiera buildy
 * z repozytoriów GitHub przy instalacji instancji – tak jak MojoLauncher
 * pobiera oryginalne pliki gry przy pierwszym uruchomieniu.
 *
 * Wpisy sprawdzone: plik źródłowy (entry) + payload (classes/assets)
 * istnieją w drzewach gałęzi `ref`.
 */

/** Zakodowany sufiks ścieżki (spacje w nazwach plików itp.). */
function encPath(relPath) {
  return relPath.split("/").map(encodeURIComponent).join("/");
}

export const CATALOG = [
  {
    id: "classic-0017a",
    title: "Minecraft Classic 0.0.17a",
    era: "Classic · 2009",
    eraClass: "classic",
    year: 2009,
    tier: "light",
    kind: "single",
    sizeBytes: 1147755,
    desc: "Jedna z pierwszych publicznych wersji Classic. Cały klient waży ~1,1 MB –startuje w kilka sekund i mieści się w każdym budżecie RAM.",
    src: {
      repo: "radmanplays/classic-0.0.17a",
      ref: "main",
      dirPath: "target_teavm_javascript/javascript",
      entry: "Classic 0.0.17a-JS.html",
    },
    bootParams: "",
    patch: false,
  },
  {
    id: "classic-030",
    title: "Minecraft Classic 0.30 (Survival Test)",
    era: "Classic · 2010",
    eraClass: "classic",
    year: 2010,
    tier: "light",
    kind: "single",
    sizeBytes: 4223889,
    desc: "Słynny Survival Test – pierwsze potwory, zdrowie i eksperymenty z przetrwaniem. Lekki build offline (~4 MB).",
    src: {
      repo: "PeytonPlayz595/0.30-remake",
      ref: "main",
      dirPath: "javascript",
      entry: "Eaglercraft_0.30_Offline_en_US.html",
    },
    bootParams: "",
    patch: false,
  },
  {
    id: "beta-173",
    title: "Minecraft Beta 1.7.3",
    era: "Beta · 2011",
    eraClass: "beta",
    year: 2011,
    tier: "medium",
    kind: "single",
    sizeBytes: 16376788,
    desc: "Ostatnia duża Beta przed Idącym Kosturem – klimat, który pamięta całe pokolenie. Build offline ~16 MB.",
    src: {
      repo: "PeytonPlayz595/Beta-1.7.3",
      ref: "main",
      dirPath: "offline_download",
      entry: "Beta_1.7.3_Offline_Download.html",
    },
    bootParams: "",
    patch: false,
  },
  {
    id: "beta-1102",
    title: "Minecraft Beta 1.1_02",
    era: "Beta · 2011",
    eraClass: "beta",
    year: 2011,
    tier: "medium",
    kind: "single",
    sizeBytes: 24413663,
    desc: "Bardzo wczesna Beta –worldy bez biomy, proste recipes, klimat pierwszych dni gry.",
    src: {
      repo: "PeytonPlayz595/Beta-1.1_02",
      ref: "main",
      dirPath: "javascript",
      entry: "Eaglercraft_Beta_1.1_02_Offline_Download.html",
    },
    bootParams: "",
    patch: false,
  },
  {
    id: "release-152",
    title: "Minecraft 1.5.2",
    era: "Release · 2013",
    eraClass: "release",
    year: 2013,
    tier: "medium",
    kind: "single",
    sizeBytes: 16523010,
    desc: "Oryginalny Eaglercraft (lDEVinux) – wersja, na której wyrosła cała scena portów 1.5.2. Singleplayer + serwery Eagler.",
    src: {
      repo: "lDEVinux/eaglercraft",
      ref: "main",
      dirPath: "stable-download",
      entry: "Offline_Download_Version.html",
    },
    bootParams: "",
    patch: false,
  },
  {
    id: "release-188-wasm",
    title: "Minecraft 1.8.8 (WebAssembly GC)",
    era: "Release · 2016",
    eraClass: "release",
    year: 2016,
    tier: "heavy",
    kind: "multi",
    sizeBytes: 31_000_000,
    desc: "Nowoczesny build: pełny 1.8.8 skompilowany do WASM z weryfikacją SHA-256 plików (jak PREF_VERIFY_FILES w MojoLauncher).",
    src: {
      repo: "mandoof1/browser-minecraft",
      ref: "main",
      dirPath: "web",
      entry: "index.html",
    },
    bootParams: "?build=wasm&theater=1",
    patch: true, // build używa ścieżek absolutnych /app, /build – spławiamy na relatywne
    manifest: "build/manifest.json",
    verifySha256: true,
  },
];

export function getCatalogItem(id) {
  return CATALOG.find((c) => c.id === id) || null;
}

/**
 * Pełne URL-e pliku na obu mirrorach.
 * Kolejność prób zależy od prefiksu `mirror` (auto → raw, potem jsdelivr).
 */
export function upstreamUrls(item, relPath) {
  const { repo, ref, dirPath } = item.src;
  const rel = encPath(relPath);
  const raw = `https://raw.githubusercontent.com/${repo}/${ref}/${dirPath}/${rel}`;
  const jsdelivr = `https://cdn.jsdelivr.net/gh/${repo}@${ref}/${dirPath}/${rel}`;
  return { raw, jsdelivr };
}
