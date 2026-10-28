# Analiza MojoLauncher (MJLauncher) – jak to działa i co przenieśliśmy do launchera web

Ten dokument opisuje **jak działa MojoLauncher** na podstawie:

1. **Oficjalnego buildu aplikacji** – `mojo-apk/mojo-launcher-official.aab`
   (Android App Bundle, 73 MB, wyciągnięty z historii oficjalnego repozytorium
   `MojoLauncher/MojoLauncher`, commit `a9322ffe0` z 8 marca 2021 r. – plik
   `app_pojavlauncher/release/app_pojavlauncher-release.aab`, później usunięty
   z gałęzi z komentarzem „Remove the AAB release because it's useless for non-gplay").
   Rozłożony do: `mojo-apk/unpacked/`.
2. **Aktualnych źródeł projektu** (gałąź `v3_openjdk`, LGPL-3.0) – kod Javy/C,
   `AGENTS.md` z opisem architektury, preferencje, renderer, JRE.
3. Strony mojolauncher.net i release-ów na GitHubie (wersja „Justicia", 19.10.2026).

> **Uwaga o pobieraniu APK.** Sandbox ma zablokowany ruch do `mojolauncher.net`,
> `release-assets.githubusercontent.com` i `blob.core.windows.net` (skąd GitHub
> serwuje release'y i artifacty CI), więc najnowszy plik `MojoLauncher-release.apk`
> (87,2 MiB) nie był stąd pobieralny. Próba pobrania „APK z GitHuba" z losowego
> fork-u (`Adriyache32/moto-launcher-port`) trafiła w **fałszywkę** – plik
> `MotoLauncher3.apk` to tak naprawdę launcher domowy Motoroli
> (`com.motorola.launcher3`, „Moto App Launcher", ikony kalendarza, workflowy
> wyszukiwarki – zero śladów Pojav/Mojo). Został usunięty. Prawdziwy oficjalny
> build (AAB) zdobyty z historii gita spełnia rolę „rozłożonego APK" – to ten sam
> kod aplikacji, w formacie wewnętrznym dla Google Play.

---

## 1. Czym MojoLauncher jest

* Fork **PojavLauncher** (project artdeell), nazwa robocza MJLauncher,
  package id: `git.artdeell.mojo` (dawniej `net.kdt.pojavlaunch` – w AAB z 2021 r.
  widać jeszcze starą nazwę).
* Uruchamia **Minecraft: Java Edition** (od `rd-132211` do snapshotów 26.x)
  na Androidzie **od wersji 5.0 (SDK 21)**, także na urządzeniach z samym
  **OpenGL ES 2.0** i tylko **1 GB RAM** (a nawet mniej).
* W pakiecie jest **własny JRE** (rozwinięty z `assets/components/jre/*.tar.xz`),
  podmiana **AWT = caciocavallo**, biblioteki **LWJGL3** oraz **JNI** (`libpojavexec.so`)
  spinające wszystko z Androidem.

## 2. Stos „graficzny" – dlaczego to się uruchamia wszędzie

Z `AGENTS.md` i `app_mojo/.../game/renderer/def/Renderers.java`:

| Wybór w UI | Co realnie robi |
|---|---|
| **GL4ES (OpenGL ES 2)** – domyślny (`PREF_RENDERER="opengles2"`) | tłumaczy desktopowe OpenGL (kompatybilność, fixed-function) na GLES2 – działa na każdym starym telefonie |
| **LTW (OpenGL ES 3)** (`opengles3_ltw`) | nowoczesna ścieżka: konteksty core na GLES3, dla MC 1.17+ |
| **Zink / Legacy Zink** | Vulkan przez Mesa3D |
| **Freedreno (KGSL)** | sterownik Mesa dla Adreno (Qualcomm), wariant system memory |
| **Mesa (DRM)** | desktopowy render na telefonie |

Do tego w AAB/źródłach są: `libgl4es_114.so`, `libgl4es_115.so`, `liblwjgl*.so`,
`libawt_headless.so`, `libpojavexec(_awt).so`, a Vulkan na Qualcu można podmienić
na **Turnip** (Mesa) przez `mojoexec`. Gra widzi „desktopowy" Linuxa:
`-Dos.name=Linux`, `-Dos.version=Android-<wersja>`.

W grze dodawane jest jeszcze `-Dorg.lwjgl.opengl.libname=libGLMojo.so` – ich
własna warstwa pośrednicząca GL.

## 3. „Geniusz" niskiego RAM-u – AutoRAM

Sedno w `app_mojo/src/main/java/git/artdeell/mojo/prefs/LauncherPreferences.java`,
funckja `findBestRAMAllocation()` – **domyślny heap jest sztywno dopasowany do
pamięci urządzenia** (Xms = Xmx, bez auto-procdu, żeby GC nie skakał):

| Pamięć urządzenia | `Xms`/`Xmx` |
|---|---|
| **< 1024 MB** | **296 MB** |
| < 1536 MB | 448 MB |
| < 2048 MB | 656 MB |
| urządzenie 32-bitowe | 696 MB (twardy limit) |
| < 3064 MB | 936 MB |
| < 4096 MB | 1144 MB |
| < 6144 MB | 1536 MB |
| ≥ 6144 MB | 2048 MB |

Komentarz w kodzie wprost tłumaczy filozofię: *za mało RAM → lag i crashy;
za dużo RAM → GC muli, Android nie może oddychać*. Dlatego na telefonie
z <1 GB gra dostaje **296 MB** – stały, mały heap = szybkie kolekcje
i spora część pamięci zostaje dla systemu.

Do tego:

* **`findBestResolution()`** – ekrany są absurdalnie ostre (1440p+), więc
  launcher **skaluje rozdzielczość gry**: cel = min. bok **720p dla słabych**
  urządzeń i 1080p dla mocnych, wynik zaokrąglany w górę do skoku suwaka
  (`resolutionRatio`, np. 56 % dla 2560 px). Mniej pikseli = mniej pracy GPU.
* **`isDevicePowerful()`** – „mocny" = Android Q+, >4 GB RAM, ≥1080p,
  >4 rdzeni **i** rdzenie o różnych taktach (big.LITTLE). Dla pozostałych
  domyślnie włączone oszczędności: `sustainedPerformance`, `alternate_surface`,
  vsync wyłączony, skaler rozdzielczości itp.
* Preferencja `javaArgs` (domyślnie pusta) – użytkownik dokłada własne flagi.

## 4. Potrójna warstwa argumentów JVM

`utils/jre/JavaRunner.java` + `utils/jre/GameRunner.java` – argumenty są
składane w trzech warstwach:

1. **Użytkownik / instancja** (`Instance.getLaunchArgs()` + globalne `javaArgs`).
   Filtr `preprocessUserArgs()` wymusza porządek: z listy wylatują `-Xms`, `-Xmx`,
   `-XX:ActiveProcessorCount` (bo dodaje je launcher), `-d32/-d64/-Xint`,
   `UseLargePages*`, klasyczny `-cp`, a opcje modularne (`--add-exports`, `-p`…)
   są sklejane do postaci `--flaga=wartość`.
2. **Domyślne „nakładki"** (`getJavaArgs()`) – dokładane tylko wtedy, gdy
   użytkownik nie podał własnej wartości o tym samym prefiksie:
   * `-Xms{AutoRAM}M` i `-Xmx{AutoRAM}M` (te same!),
   * `-Djava.home`, `-Djava.io.tmpdir`, `-Duser.home`, `-Duser.language=en`,
     `-Duser.country=US`, `-Dos.name=Linux`, `-Dos.version=Android-…`,
   * `-Dorg.lwjgl.vulkan.libname=libvulkan.so`, `org.lwjgl.sdl.libname`,
     `org.lwjgl.system.allocator=system`,
   * **`-Dlog4j2.formatMsgNoLookups=true`** (łatka na Log4Shell),
   * `-Dfml.earlyprogresswindow=false` (Forge bez okienka progressu),
   * `-Dloader.disable_forked_guis=true`,
   * `-Djdk.lang.Process.launchMechanism=FORK` (na Androidzie `POSIX_SPAWN`
     nie działa z `jspawnhelper`),
   * `-Dmojo.path.game`, `-Dmojo.path.account`, strefa czasowa, resolv.conf.
3. **Warstwa „mojson"** (`GameRunner.mergeMoJsonArgs`) – argumenty JVM z JSON-a
   wersji gry (np. dodatkowe flagi Forge 1.17+) z podstawieniem zmiennych
   `${library_directory}`, `${natives_directory}`, `${version_name}`.

Do tego maszyna startowa dokłada:

* `-XX:ActiveProcessorCount=<ile rdzeni>` (bez tego JVM na big.LITTLE widzi
  wszystkie rdzenie jako równe i się dusi),
* `-Xrs` na niektórych device’ach (aby sygnały nie leciały do uszkodzonego
  łańcucha sygnałów ART – workaround x86/Marshmallow),
* caciocavallo przez `-Xbootclasspath/p` (JRE 8) albo `--add-exports/--add-opens`
  + `javaagent` (nowsze JRE),
* pełne podmiany ścieżek natywnych (`LD_LIBRARY_PATH`, `JAVA_HOME`, `TMPDIR`),
  a sam JVM jest **ładowany in-process** (`nativeLoadJVM`) zamiast procesu potomnego.

## 5. AWT bez Androida

Ekosystem `caciocavallo` (`assets/components/caciocavallo/*.jar` + `ResConfHack.jar`)
podmienia pakiet `java.desktop` na implementację działającą na Androidzie –
dzięki temu działają instalatory Forge/Fabric/OptiFine ( Swing), zanim gra
przejmie ekran przez SDL3/GLFW (submoduły `sdl`, `glfw`, most `mojoexec`).
W AAB są też `libawt_headless.so`/`libawt_xawt.so`.

## 6. Domyślne ustawienia gry pod słaby sprzęt

Z `mojo-apk/unpacked/base/assets/options.txt` (wbudowane domyślne opcje):

```
renderDistance:2        ←2 chunki!
fancyGraphics:false     ← prosta grafika
ao:0                    ← bez ambient occlusion
mipmapLevels:0
particles:1             ← mniej cząsteczek
guiScale:3
maxFps:260
enableVsync:false
```

Czyli launcher startuje grę w trybie „minimal" – szczegóły dopiesza się
w ustawieniach. Współczesny build ma też tryb **AutoRAM** (toast
`autoram_info_msg` informuje, ile MB przydzielono) i `PREF_VERIFY_FILES=true`
(sprawdzanie SHA pobranych plików gry).

## 7. Mapa na launcher web (co przenieśliśmy)

| MojoLauncher (Android) | mc-launcher (przeglądarka) |
|---|---|
| AutoRAM `findBestRAMAllocation` | identyczna tabela w `js/mojo.js`, na bazie `navigator.deviceMemory` |
| `isDevicePowerful` | port z `deviceMemory`, `hardwareConcurrency`, rozdzielczości ekranu |
| skaler rozdzielczości `findBestResolution` (720p/1080p) | skalowanie framebuffera iframa gry (render scale %, skok co 5) |
| renderer GL4ES/LTW/Zink | detekcja WebGL1 vs WebGL2 (analog GLES2/GLES3) + etykiety z ich UI |
| `Xms=Xmx`, `ActiveProcessorCount`, warstwa domyślnych `-D…` | `js/mojo.js → buildJvmArgs()` + ekran „Java args" z podglądem i eksportem |
| weryfikacja plików (SHA-1/SHA-256) | weryfikacja `sha256` z `manifest.json` buildu 1.8.8 |
| pobieranie plików gry przy pierwszym uruchomieniu | instalacja instancji: pobranie buildu z GitHuba do Cache Storage |
| instancje (`Instance`, własny katalog, własne `jvmArgs`) | system instancji w `js/store.js` |
| tryb offline/demografika konta | profil lokalny (nick), worldy trzymane przez grę w IndexedDB |
| touch control overlay | nakładka dotykowa (D-pad + skok/Esc/E) |
| toast AutoRAM przy starcie | toast startowy z przydzielonym budżetem RAM |

Silnikiem gry są **oryginalne wersje Minecrafta** przepakowane do JS/WASM
przez projekty typu Eaglercraft/TeaVM (katalog w `js/catalog.js`): Classic,
Beta, 1.5.2, 1.8.8 (WebAssembly GC). Launcher pobiera je przy „instalacji"
instancji i serwuje lokalnie przez Service Workera – dokładnie tak, jak
MojoLauncher pobiera oryginalne pliki gry z serwerów Mojang.
