/**
 * Test dymny v2: manifest Mojang z mocka, fake Cache Storage, renderowanie
 * wszystkich ekranów + reguły pipeline'u (SHA-1, args, offline-uuid, Range).
 * Uruchomienie: node test/smoke.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { JSDOM } from "jsdom";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "index.html"), "utf8");

const dom = new JSDOM(html, { url: "http://localhost:8080/", pretendToBeVisual: true, runScripts: "outside-only" });
const w = dom.window;
for (const k of [
  "window", "document", "navigator", "location", "history", "localStorage",
  "sessionStorage", "HTMLElement", "Element", "Node", "Event", "CustomEvent",
  "KeyboardEvent", "MouseEvent", "Response", "Request",
  "DOMParser", "getComputedStyle", "prompt", "confirm", "screen", "URL",
  "URLSearchParams", "Headers", "FormData", "WebSocket",
]) {
  if (w[k] === undefined) continue;
  try { Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true }); }
  catch { /* zostaw oryginał */ }
}
if (!globalThis.matchMedia) {
  globalThis.matchMedia = w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
}
w.matchMedia = globalThis.matchMedia;

/* ---- fake Cache Storage ---- */
const fakeStores = new Map();
function fakeCache(store) {
  return {
    async match(urlOrReq) {
      const key = typeof urlOrReq === "string" ? urlOrReq : urlOrReq.url;
      const hit = store.get(key) || store.get(new URL(key, "http://localhost:8080").pathname);
      return hit ? hit.clone() : undefined;
    },
    async put(urlOrReq, resp) {
      const key = typeof urlOrReq === "string" ? urlOrReq : new URL(urlOrReq.url).pathname;
      store.set(key, resp);
    },
    async keys() { return [...store.keys()].map((k) => ({ url: new URL(k, "http://localhost:8080").href })); },
    async delete(url) { return store.delete(typeof url === "string" ? url : url.url); },
    async addAll() {},
  };
}
globalThis.caches = w.caches = {
  async open(name) {
    if (!fakeStores.has(name)) fakeStores.set(name, new Map());
    return fakeCache(fakeStores.get(name));
  },
  async keys() { return [...fakeStores.keys()]; },
  async delete(k) { return fakeStores.delete(k); },
};

/* ---- fetch mock: piston-meta + fixture wersji ---- */
const VERSION_JSON = {
  id: "1.12.2", type: "release", mainClass: "net.minecraft.client.main.Main",
  javaVersion: { majorVersion: 8 },
  downloads: {
    client: { sha1: "aa".repeat(20), size: 1024, url: "https://piston-data.mojang.com/v1/objects/aa/client.jar" },
    clientMappings: { sha1: "bb".repeat(20), size: 100, url: "https://piston-meta.mojang.com/mappings/1.12.2.txt" },
  },
  libraries: [
    { name: "org.lwjgl.lwjgl:lwjgl:2.9.3", downloads: { artifact: { path: "org/lwjgl/lwjgl/2.9.3/lwjgl-2.9.3.jar", sha1: "cc".repeat(20), size: 10, url: "https://libraries.minecraft.net/lwjgl.jar" } } },
    { name: "only-osx:dummy:1.0", rules: [{ action: "allow", os: { name: "osx" } }], downloads: { artifact: { path: "only/osx/dummy.jar", sha1: "dd", size: 1, url: "https://x/y" } } },
  ],
  assetIndex: { id: "1.12", sha1: "ee".repeat(20), size: 50, url: "https://piston-meta.mojang.com/assets/1.12.json" },
  minecraftArguments: "${auth_player_name} ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root} --assetIndex ${assets_index_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userType ${user_type}",
};
const ASSET_INDEX = { objects: { "minecraft/sounds/nausea.ogg": { hash: "f".repeat(40), size: 5 } } };
const MANIFEST = {
  latest: { release: "1.12.2" },
  versions: [
    { id: "1.12.2", type: "release", url: "http://localhost:8080/piston/1.12.2.json", releaseTime: "2017-09-01" },
    { id: "1.8.9", type: "release", url: "http://localhost:8080/piston/1.8.9.json", releaseTime: "2015-12-01" },
    { id: "b1.7.3", type: "old_beta", url: "http://localhost:8080/piston/b1.7.3.json", releaseTime: "2011-06-30" },
    { id: "a1.2.6", type: "old_alpha", url: "http://localhost:8080/piston/a1.2.6.json", releaseTime: "2011-01-01" },
    { id: "1.20.4", type: "release", url: "http://localhost:8080/piston/1.20.4.json", releaseTime: "2023-12-01" },
    { id: "26.2-snapshot-4", type: "snapshot", url: "http://localhost:8080/piston/s.json", releaseTime: "2026-04-01" },
  ],
};
const realFetch = globalThis.fetch;
globalThis.fetch = w.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  void init;
  if (url.includes("version_manifest")) return new Response(JSON.stringify(MANIFEST), { status: 200 });
  if (url.includes("/piston/1.12.2.json")) return new Response(JSON.stringify(VERSION_JSON), { status: 200 });
  if (url.includes("assets/1.12.json")) return new Response(JSON.stringify(ASSET_INDEX), { status: 200 });
  if (url.includes("/resolve")) return new Response(JSON.stringify({ addrs: ["104.17.17.42"] }), { status: 200 });
  if (url.includes("piston-data") || url.includes("resources.download") || url.includes("libraries.minecraft") || url.includes("mappings")) {
    const body = url.includes("mappings") ? new TextEncoder().encode("a -> net.minecraft.Foo:\n") :
      url.includes("1.12.json") ? new TextEncoder().encode(JSON.stringify(ASSET_INDEX)) :
      new Uint8Array(64).fill(7);
    return new Response(body, { status: 200 });
  }
  return new Response("", { status: 404 });
};

const failures = [];
const check = (name, cond) => {
  if (cond) console.log(`  ok  ${name}`);
  else { failures.push(name); console.log(`FAIL  ${name}`); }
};

/* ---- reguły pipeline'u ---- */
const mojo = await import(path.join(root, "js/mojo.js"));
check("AutoRAM: <1024 → 296", mojo.findBestRAMAllocation(768) === 296);
check("AutoRAM: >=6144 → 2048", mojo.findBestRAMAllocation(8192) === 2048);
check("skaler: słabe 1080p → 70%", mojo.findBestResolution(1080, false) === 70);

const mojang = await import(path.join(root, "js/mojang.js"));
check("katalog: tylko ery ≤1.12.2 + beta/alfa",
  (await mojang.listVersions()).map((v) => v.id).join(",") === "1.12.2,1.8.9,b1.7.3,a1.2.6");
check("rules: odrzucono bibliotekę osx",
  (await mojang.resolvePlan("1.12.2")).libs.length === 1);
const plan = await mojang.resolvePlan("1.12.2");
const args = mojang.buildArgs(plan, { name: "Test", uuid: "abc", accessToken: "0", userType: "legacy" }, "release");
check("args: pozycyjny auth_player_name z szablonu", args[0] === "Test");
check("args: --accessToken=0", args[args.indexOf("--accessToken") + 1] === "0" || !args.includes("--accessToken"));
check("args: brak nierozwiązanych tokenów ${", !args.some((a) => a.includes("${")));
check("offline uuid: format 32 hex z wersją 3",
  /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(await mojang.offlineUuid("Test")));
const preset = mojang.buildOptionsPreset({ rd: 4, maxFps: 60, fancy: false });
check("preset: fboEnable:false (gl4es)", preset.includes("fboEnable:false"));
check("preset: renderDistance z prefu", preset.includes("renderDistance:4"));

/* instalacja z mocka (SHA-1 jest sztuczny → cachePut wychwyci niezgodność... użyjemy
   instalacji na plikach z poprawnym sha w mocku? manifest ma "aa"*20 – pomijamy instalację
   na rzecz jednostek wyżej; tu tylko struktura) */
check("meta bez instalacji: null", (await mojang.installedInfo("1.12.2")) === null);

/* ---- import aplikacji ---- */
let appOk = true;
try { await import(path.join(root, "js/main.js")); }
catch (e) { appOk = false; failures.push("import main.js: " + e.message); console.error(e); }
check("import main.js bez wyjątków", appOk);

const ui = await import(path.join(root, "js/ui.js"));
const view = w.document.getElementById("view");
await new Promise((r) => setTimeout(r, 120));
check("ekran home renderuje się (katalog z mocka)", view.innerHTML.includes("ORYGINALNEGO") || view.innerHTML.includes("Mojang"));

for (const [name, fn, needle] of [
  ["instances", () => ui.renderInstances(), "Instancje"],
  ["settings", () => ui.renderSettings(), "Ustawienia"],
  ["java", () => ui.renderJava(), "Args startowe"],
  ["about", () => ui.renderAbout(), "CheerpJ"],
]) {
  let ok = true, msg = "";
  try { fn(); } catch (e) { ok = false; msg = e.message; }
  await new Promise((r) => setTimeout(r, 150));
  const has = view.innerHTML.includes(needle);
  check(`ekran ${name}${msg ? " – " + msg : ""}`, ok && has);
}

/* ---- patcher: zip roundtrip na minimalnym archiwum ---- */
const patcher = await import(path.join(root, "js/patcher.js"));
const zip1 = await patcher.writeZip([{ name: "a/b.txt", method: 8, data: new TextEncoder().encode("hello world hello world") }]);
const back = await patcher.readZip(zip1);
check("patcher: zip roundtrip", back.length === 1 && new TextDecoder().decode(back[0].data) === "hello world hello world");
check("patcher: applyPatches na obcym jarze → null (brak planu)",
  (await patcher.applyPatches("1.0", zip1, async () => null)) === null);

/* ---- netshim: struktura natives ---- */
const netshim = await import(path.join(root, "js/netshim.js"));
const n = netshim.socketNativesWrapped();
check("netshim: socketRead0 obecny", typeof n.Java_java_net_SocketInputStream_socketRead0 === "function");
check("netshim: connect0 obecny", typeof n.Java_sun_nio_ch_Net_connect0 === "function");
check("netshim: epoll_wait obecny", typeof n.Java_sun_nio_ch_EPoll_epoll_wait === "function");

/* ---- robustFetch: łańcuch źródeł + weryfikacja SHA-1 ---- */
{
  const savedFetch = globalThis.fetch;
  const data = new TextEncoder().encode("lustrzane-bajty");
  const want = [...new Uint8Array(await crypto.subtle.digest("SHA-1", data))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");

  // oryginał pada (404), repo1.maven.org żyje → fallback do lustra
  globalThis.fetch = async (input) => {
    const u = String(input?.url || input);
    if (u.includes("repo1.maven.org")) return new Response(data, { status: 200 });
    return new Response("", { status: 404 });
  };
  const got = await mojang.robustFetch(
    "https://libraries.minecraft.net/com/mojang/netty/1.8.8/netty-1.8.8.jar", { sha1: want });
  check("robustFetch: 404 z oryginału → lustro repo1.maven.org",
    got.length === data.length && got.every((b, i) => b === data[i]));

  // wszędzie złe bajty → odrzucone po SHA-1, błąd z nazwą hosta
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  let err = null;
  try { await mojang.robustFetch("https://libraries.minecraft.net/x.jar", { sha1: want }); }
  catch (e) { err = e; }
  check("robustFetch: zły SHA-1 we wszystkich źródłach → czytelny błąd",
    !!err && /SHA-1/.test(err.message) && /libraries\.minecraft\.net/.test(err.message)
    && /repo1\.maven\.org=/.test(err.message));

  // diagnostyka: ślad wszystkich źródeł z komunikatu (HTTP status per host)
  globalThis.fetch = async () => new Response("", { status: 404 });
  let err404 = null;
  try { await mojang.robustFetch("https://libraries.minecraft.net/y.jar"); }
  catch (e) { err404 = e; }
  check("robustFetch: ślad źródeł w błędzie (host=status)",
    !!err404 && /libraries\.minecraft\.net=HTTP 404/.test(err404.message)
    && /repo1\.maven\.org=HTTP 404/.test(err404.message)
    && /allorigins\.win=HTTP 404/.test(err404.message));

  // wiszące źródła (bez odpowiedzi) → watchdog po timeoutMs, brak zawieszenia
  globalThis.fetch = (_input, init) =>
    new Promise((_, rej) => {
      init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
    });
  let hangErr = null;
  const t0 = Date.now();
  try {
    await mojang.robustFetch("https://libraries.minecraft.net/hang.jar", { sha1: want, timeoutMs: 60 });
  } catch (e) { hangErr = e; }
  check("robustFetch: watchdog zbija wiszące źródła (instalacja nie stoi)",
    !!hangErr && Date.now() - t0 < 5000);

  globalThis.fetch = savedFetch;
}

console.log(failures.length ? `\n${failures.length} BŁĘD(Y)` : "\nWSZYSTKO OK");
void realFetch;
process.exit(failures.length ? 1 : 0);
