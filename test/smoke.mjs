/**
 * Test dymny: ładuje index.html w jsdom, importuje całą aplikację,
 * przechodzi po wszystkich ekranach i sprawdza kluczowe reguły portu
 * logiki MojoLauncher (AutoRAM, filtry argumentów JVM).
 *
 * Uruchomienie: node test/smoke.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { JSDOM } from "jsdom";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "index.html"), "utf8");

const dom = new JSDOM(html, {
  url: "http://localhost:8080/",
  pretendToBeVisual: true,
  runScripts: "outside-only",
});

const w = dom.window;
for (const k of [
  "window", "document", "navigator", "location", "history", "localStorage",
  "sessionStorage", "HTMLElement", "Element", "Node", "Event", "CustomEvent",
  "KeyboardEvent", "MouseEvent", "Response", "Request", "Cache", "caches",
  "DOMParser", "getComputedStyle", "prompt", "confirm", "Blob", "FileReader",
  "screen", "scrollTo", "fetch", "Headers", "FormData", "URL", "URLSearchParams",
]) {
  if (w[k] === undefined) continue;
  try {
    Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true });
  } catch { /* zostawiamy oryginał, jeśli nie da się podmienić */ }
}
if (!globalThis.matchMedia) {
  globalThis.matchMedia = w.matchMedia = () => ({
    matches: false, addEventListener() {}, removeEventListener() {},
  });
}
w.matchMedia = globalThis.matchMedia;

const failures = [];
const check = (name, cond) => {
  if (cond) console.log(`  ok  ${name}`);
  else { failures.push(name); console.log(`FAIL  ${name}`); }
};

/* ---- reguły przeniesione z MojoLaunchera ---- */
const mojo = await import(path.join(root, "js/mojo.js"));

check("AutoRAM: <1024 MB → 296 MB", mojo.findBestRAMAllocation(768) === 296);
check("AutoRAM: 1024-1535 → 448", mojo.findBestRAMAllocation(1280) === 448);
check("AutoRAM: 1536-2047 → 656", mojo.findBestRAMAllocation(2000) === 656);
check("AutoRAM: 3064-4095 → 1144", mojo.findBestRAMAllocation(3500) === 1144);
check("AutoRAM: >=6144 → 2048", mojo.findBestRAMAllocation(8192) === 2048);

check("findBestResolution: słabe 1080p → 70% (cel 720p, skok co 5)",
  mojo.findBestResolution(1080, false) === 70);
check("findBestResolution: słabe 720p → 100% (bez skalowania)",
  mojo.findBestResolution(720, false) === 100);
check("findBestResolution: mocne 1080p → 100% (cel 1080p)",
  mojo.findBestResolution(1080, true) === 100);
check("findBestResolution: mocne 1440p → 75%",
  mojo.findBestResolution(1440, true) === 75);

const args = mojo.buildJvmArgs({
  userArgs: ["-Xmx9999M", "-Xint", "-cp", "garbage", "-XX:+UseZGC", "-javaagent:foo.jar"],
  ramMb: 296, cores: 4,
});
check("preprocess: zrzucono -Xmx użytkownika", !args.some((a) => a.startsWith("-Xmx9999")));
check("preprocess: zrzucono -Xint i -cp", !args.includes("-Xint") && !args.includes("-cp"));
check("użytkownik: -XX:+UseZGC zachowane", args.includes("-XX:+UseZGC"));
check("auto: -Xms296M dodane", args.includes("-Xms296M"));
check("auto: -Xmx296M dodane", args.includes("-Xmx296M"));
check("auto: ActiveProcessorCount=4", args.includes("-XX:ActiveProcessorCount=4"));
check("auto: flaga log4j obecna", args.includes("-Dlog4j2.formatMsgNoLookups=true"));
check("nadpisanie prefiksu: userArgs z -Djava.io.tmpdir=x blokuje domyślną",
  !mojo.buildJvmArgs({ userArgs: ["-Djava.io.tmpdir=/x"], ramMb: 296, cores: 2 })
    .some((a) => a.startsWith("-Djava.io.tmpdir=") && a !== "-Djava.io.tmpdir=/x"));

/* ---- import aplikacji (bootstrap + routery) ---- */
let appOk = true;
try {
  await import(path.join(root, "js/main.js"));
} catch (e) {
  appOk = false;
  failures.push("import main.js: " + e.message);
  console.error(e);
}
check("import main.js bez wyjątków", appOk);

const ui = await import(path.join(root, "js/ui.js"));
const view = w.document.getElementById("view");
check("widok niepusty po starcie (home)", view.innerHTML.includes("Mojo") || view.innerHTML.length > 400);

const screens = [
  ["instances", () => ui.renderInstances(), "Instancje"],
  ["settings", () => ui.renderSettings(), "Ustawienia"],
  ["java", () => ui.renderJava(), "Java args"],
  ["about", () => ui.renderAbout(), "MojoLauncher"],
  ["home", () => ui.renderHome(), "AutoRAM"],
];
for (const [name, fn, needle] of screens) {
  let ok = true, msg = "";
  try { fn(); } catch (e) { ok = false; msg = e.message; }
  const has = view.innerHTML.includes(needle);
  check(`ekran ${name} renderuje się${msg ? " – " + msg : ""}`, ok && has);
}

const cat = await import(path.join(root, "js/catalog.js"));
check("katalog ma ≥5 wersji", cat.CATALOG.length >= 5);
check("każda pozycja ma entry i repo", cat.CATALOG.every((c) => c.src?.entry && c.src?.repo && c.src?.ref));

console.log(failures.length ? `\n${failures.length} BŁĘD(Y)` : "\nWSZYSTKO OK");
process.exit(failures.length ? 1 : 0);
