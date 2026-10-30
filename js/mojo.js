/**
 * mojo.js – port logiki MojoLauncher na JS.
 *
 * Odpowiedniki z_androidowego źródła (LGPL-3.0, MojoLauncher/MojoLauncher):
 *  - LauncherPreferences.findBestRAMAllocation()  → findBestRAMAllocation()
 *  - LauncherPreferences.isDevicePowerful()       → isDevicePowerful()
 *  - LauncherPreferences.findBestResolution()     → findBestResolution()
 *  - JavaRunner.getJavaArgs() / preprocessUserArgs() → buildJvmArgs()
 *
 * To nie jest kopia kodu – to ta sama reguła wyrażona w JavaScript.
 */

/** Tabela AutoRAM jak w findBestRAMAllocation(): wejście = MB pamięci urządzenia. */
const RAM_TABLE = [
  { under: 1024, mb: 296 },
  { under: 1536, mb: 448 },
  { under: 2048, mb: 656 },
  { under: 3064, mb: 936 },
  { under: 4096, mb: 1144 },
  { under: 6144, mb: 1536 },
];
export const RAM_32BIT_LIMIT_MB = 696; // w Androidzie dla urządzeń 32-bit
export const RAM_DEFAULT_64_MB = 2048;

/**
 * findBestRAMAllocation(): dispatchuje jaka ma być pamięć Xms/Xmx
 * dla danej pojemności urządzenia. Na urządzeniach <1 GB → 296 MB.
 */
export function findBestRAMAllocation(deviceRamMB) {
  for (const row of RAM_TABLE) {
    if (deviceRamMB < row.under) return row.mb;
  }
  return RAM_DEFAULT_64_MB;
}

/** Prosty odczyt ile „GB" ma urządzenie (navigator.deviceMemory jest zaokrąglone). */
export function detectDeviceMemoryMB() {
  const nav = navigator;
  if (typeof nav.deviceMemory === "number" && nav.deviceMemory > 0) {
    return Math.round(nav.deviceMemory * 1024);
  }
  // Fallback: spróbuj wywnioskować z performance.memory (Chromium) – tylko dla UI.
  if (performance.memory && performance.memory.jsHeapSizeLimit) {
    const heapMB = performance.memory.jsHeapSizeLimit / 1048576;
    // Heap limit JVM-jakości ≈ 1/4 RAM – szacujemy ostrożnie w górę.
    return Math.min(8192, Math.max(512, Math.round(heapMB * 4 / 256) * 256));
  }
  return 4096; // bez danych – traktuj jak przeciętne
}

export function detectCores() {
  return navigator.hardwareConcurrency || 2;
}

export function detectMinSidePx() {
  return Math.min(screen.width, screen.height);
}

/**
 * isDevicePowerful() – ich warunki: Android Q+, >4 GB RAM, min. bok >=1080,
 * >4 rdzeni i rdzenie o różnych taktach. W przeglądarce nie odczytamy
 * big.LITTLE ani wersji Androida, więc przyjmujemy: >=4 GB, >=5 rdzeni,
 * min. bok >=1080 i traktujemy to jako warunek „mocny".
 */
export function isDevicePowerful(info) {
  if (info.deviceRamMB <= 4096) return false;
  if (info.minSidePx < 1080) return false;
  if (info.cores <= 4) return false;
  return true;
}

/**
 * findBestResolution() – zwraca procent rozdzielczości gry:
 * celujemy w min. bok 720p dla zwykłych urządzeń i 1080p dla mocnych,
 * wynik zaokrąglony w górę do skoku co 5% (jak suwak `resolutionRatio`).
 * Telefony/tablety (touch): 640p – GL4ES liczy piksele na CPU, wyższa
 * rozdzielczość = otwarta lodówka i slajdy zamiast gry.
 */
export function findBestResolution(minSidePx, powerful, increment = 5, touch = false) {
  const targetSide = touch ? 640 : powerful ? 1080 : 720;
  if (minSidePx <= targetSide) return 100;
  const ratio = (100 * targetSide) / minSidePx;
  return Math.min(100, Math.ceil(ratio / increment) * increment);
}

/** Etykiety rendererów z ich UI: GL4ES (GLES2), LTW (GLES3), Zink… – mapujemy na WebGL. */
export function detectRendererTier() {
  try {
    const c = document.createElement("canvas");
    const gl2 = c.getContext("webgl2");
    if (gl2) {
      return {
        id: "ltw",
        label: "LTW-owy tryb (WebGL2 / analog OpenGL ES 3)",
        short: "WebGL2 · LTW",
        note: "Odpowiednik LTW w MojoLauncher: nowoczesna ścieżka renderowania, MC 1.17+.",
      };
    }
    const gl1 = c.getContext("webgl") || c.getContext("experimental-webgl");
    if (gl1) {
      return {
        id: "gl4es",
        label: "GL4ES-owy tryb (WebGL1 / analog OpenGL ES 2)",
        short: "WebGL1 · GL4ES",
        note: "Odpowiednik GL4ES w MojoLauncher: tryb zgodności dla starych urządzeń.",
      };
    }
  } catch { /* brak WebGL */ }
  return { id: "none", label: "Brak WebGL", short: "brak", note: "Gra nie wystartuje." };
}

/** Pełny odczyt urządzenia w stylu karty „Tryb Mojo" z launchera. */
export function detectDevice() {
  const deviceRamMB = detectDeviceMemoryMB();
  const cores = detectCores();
  const minSidePx = detectMinSidePx();
  const touch = matchMedia("(pointer: coarse)").matches;
  const powerful = isDevicePowerful({ deviceRamMB, cores, minSidePx });
  const resolutionPct = findBestResolution(minSidePx, powerful, 5, touch);
  const renderer = detectRendererTier();
  const ramMb = findBestRAMAllocation(deviceRamMB);
  return {
    deviceRamMB, cores, minSidePx, powerful, resolutionPct, renderer, ramMb,
    lowRam: deviceRamMB < 1024,
    dpr: window.devicePixelRatio || 1,
    touch,
  };
}

/* ------------------------------------------------------------------ */
/*  Argumenty JVM – odpowiednik JavaRunner.getJavaArgs() + warstwy      */
/* ------------------------------------------------------------------ */

/**
 * Domyślne flagi startowe (odpowiednik overridableArguments z JavaRunner):
 * przenosimy tylko te, które mają sens poza Androidem. Użytkownik może
 * podpisać własną wartością o tym samym prefiksie – wtedy domyślna nie
 * jest doklejana (dokładnie ta reguła co u nich).
 */
export function defaultJvmArgs({ ramMb, cores, gameDir = "./game", tmpDir = "./tmp" }) {
  return [
    `-Xms${ramMb}M`,
    `-Xmx${ramMb}M`,
    `-XX:ActiveProcessorCount=${cores}`,
    `-Djava.io.tmpdir=${tmpDir}`,
    `-Duser.home=${gameDir}`,
    `-Duser.language=en`,
    `-Duser.country=US`,
    // poniższe przeniesione 1:1 z ich listy (security + workaroundy Forge):
    `-Dlog4j2.formatMsgNoLookups=true`,   // ochrona Log4Shell
    `-Dfml.earlyprogresswindow=false`,    // Forge 1.14+ bez okienka progressu
    `-Dloader.disable_forked_guis=true`,
    // Android-specific (jak u nich, ale pomijane w eksporcie desktop):
    //   -Dos.name=Linux, -Djdk.lang.Process.launchMechanism=FORK itd.
  ];
}

/**
 * preprocessUserArgs() – port filtrów z JavaRunner.preprocessUserArgs():
 *  - zdejmuje z listy użytkownika -Xms/-Xmx/-XX:ActiveProcessorCount
 *    (bo dodaje je launcher),
 *  - usuwa -d32/-d64/-Xint, UseLargePages*, klasyczny -cp,
 *  - skleja opcje modularne do --flaga=wartość,
 *  - wykrywa -javaagent (gra może potrzebować agenta).
 * Zwraca { args, hasJavaAgent }.
 */
export function preprocessUserArgs(userArgs) {
  const out = [];
  let hasJavaAgent = false;
  const pairwise = new Set([
    "--add-reads", "--add-exports", "--add-opens", "--add-modules",
    "--limit-modules", "--module-path", "--patch-module", "--upgrade-module-path",
  ]);
  for (let i = 0; i < userArgs.length; i++) {
    let arg = userArgs[i];
    if (arg === "-p") arg = "--module-path";
    if (pairwise.has(arg)) {
      const v = userArgs[++i];
      out.push(`${arg}=${v ?? ""}`);
      continue;
    }
    if (["-d32", "-d64", "-Xint", "-XX:+UseTransparentHugePages",
         "-XX:+UseLargePagesInMetaspace", "-XX:+UseLargePages"].includes(arg)) {
      continue;
    }
    if (arg === "-cp") { i++; continue; } // klasa startowa i tak idzie osobno
    if (arg.startsWith("-Xms") || arg.startsWith("-Xmx") ||
        arg.startsWith("-XX:ActiveProcessorCount")) {
      continue;
    }
    if (arg.startsWith("-javaagent:")) hasJavaAgent = true;
    out.push(arg);
  }
  return { args: out, hasJavaAgent };
}

/**
 * buildJvmArgs() – jak u nich: [użytkownik] → filtr → [domyślne nie nadpisane].
 * Zwraca gotową listę argumentów JVM.
 */
export function buildJvmArgs({ userArgs = [], ramMb, cores, gameDir, tmpDir, androidExtras = false }) {
  const pre = preprocessUserArgs(userArgs);
  const merged = [...pre.args];
  const defaults = defaultJvmArgs({ ramMb, cores, gameDir, tmpDir });
  for (const def of defaults) {
    const prefix = def.slice(0, def.indexOf("="));
    const taken = merged.some((u) => u.startsWith(prefix));
    if (!taken) merged.push(def);
  }
  if (androidExtras) {
    merged.push("-Dos.name=Linux");
    merged.push("-Dos.version=Android-web");
    merged.push("-Djdk.lang.Process.launchMechanism=FORK");
  }
  // ActiveProcessorCount na końcu jak u nich (runtimeArgs.add)
  if (!merged.some((a) => a.startsWith("-XX:ActiveProcessorCount"))) {
    merged.push(`-XX:ActiveProcessorCount=${cores}`);
  }
  return merged;
}

/** Krótki raport startowy – jak toast `autoram_info_msg` w MojoLauncherze. */
export function autoRamToast(device) {
  if (device.lowRam) {
    return `AutoRAM: wykryto <1 GB RAM – przydzielono ${device.ramMb} MB heap (jak MojoLauncher)`;
  }
  return `AutoRAM: przydzielono ${device.ramMb} MB heap · skala ${device.resolutionPct}% · ${device.renderer.short}`;
}
