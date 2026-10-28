# mc-launcher

**Zagraj w ORYGINALNEGO Minecrafta w przeglądarce** – launcher zbudowany na
podstawie analizy [MojoLauncher (MJLauncher)](https://github.com/MojoLauncher/MojoLauncher)
(przez AutoRAM, skaler rozdzielczości po warstwę ustawień startowych).

> **Nie Eaglercraft, nie podróbka.** Klient gry to **niezmodyfikowany
> `client.jar` Mojang** (do wersji 1.12.2), pobierany przez Twoją przeglądarkę
> prosto z `piston-meta`/`piston-data.mojang.com` (weryfikacja SHA-1) i
> uruchamiany na prawdziwym JVM w WebAssembly (**CheerpJ**) z warstwą GL
> **gl4es → WebGL** – dokładnie tej samej, którą MojoLauncher używa na Androidzie.

## Uruchomienie

```bash
npm start            # node server.js → http://0.0.0.0:8080
# lub: node server.js
```

Wymagania przeglądarki: WebGL, Service Worker, ES modules (Chrome/Edge/Firefox).
Serwer jest potrzebny (zakres `Range` + gateway multiplayer), sam `index.html`
z `file://` nie wystarczy.

## Jak to działa

| Warstwa | Co robi |
|---|---|
| `js/mojang.js` | manifest wersji, reguły bibliotek, plan plików, pobranie ze SHA-1 do Cache Storage, ekspansja `minecraftArguments`, offline-UUID, preset `options.txt` (AutoRAM) |
| `js/game.js` | `cheerpjInit` (fetch-hook serwuje pliki gry z cache z **Range**), `cheerpjCreateDisplay`, `cheerpjRunMain(mainClass, classpath, …args)` |
| `js/patcher.js` | lokalne poprawki client.jar (zip+class od zera): dla 1.12.2 znany zestaw pod CheerpJ; dla innych wersji – przez oficjalne mapowania Mojang. Nigdzie nie redystrybuujemy zmodyfikowanych plików |
| `js/netshim.js` + `server.js` | **multiplayer**: natives `java.net`/`sun.nio.ch` → WebSocket → gateway TCP (`/gw`) na naszym serwerze; DNS przez `/resolve` |
| `js/mojo.js` | port logiki MojoLauncher: `findBestRAMAllocation`, `findBestResolution`, `isDevicePowerful`, `preprocessUserArgs` |
| `vendor/lwjgl/` | gl4es.wasm + wasm-LWJGL + jar-y (z browsercraft, Apache-2.0; patrz `vendor/LICENSES.md`) |
| `sw.js` | powłoka aplikacji offline; dane gry żyją w `mcl-data-v1` (Cache Storage) |

### Zakres i limity (uczciwie)

* **Wersje:** wszystkie wydania **≤ 1.12.2** + stare beta/alfa (era LWJGL 2).
  1.13+ wymaga warstwy LWJGL3, której jeszcze nie ma w ekosystemie.
* **Multiplayer:** wersje do 1.6 = pełny zestaw gniazdec przez gateway
  (przetestowany: TCP do `hypixel.net:25565` działa z tego środowiska);
  **1.7+ (Netty/NIO) = eksperymentalne** – selector NIO pod CheerpJ wymaga
  dalszych nativesów (`EPoll*` są zaimplementowane szacunkowo, do ogarnięcia
  na podglądzie).
* **Logowanie:** tryb offline (nick). Serwery `online-mode=off` działają;
  premium (Hypixel) wymaga logowania Microsoft – potrzebna własna aplikacja
  Azure, więc poza zakresem tej wersji.
* **Dźwięk:** OpenAL nie jest zaimplementowany w warstwie wasm-LWJGL – gra
  startuje w ciszy (jak w referencyjnym portcie „Could not locate OpenAL").
* **Pamięć:** CheerpJ zarządza heapem WASM-a sam – odpowiednik AutoRAM
  MojoLaunchera steruje `options.txt` + skalerem rozdzielczości, nie `-Xmx`.

## Testy

```bash
npm run check        # node --check wszystkich plików
node test/smoke.mjs  # mock manifestu: katalog, reguły, args, UUID, patcher, netshim
```

## Prawne

* Kod: ten repozytorium. Analiza i przeniesienie reguł: na podstawie
  MojoLauncher (LGPL-3.0) – cytujemy reguły, nie kod.
* Gra: **żadnych plików gry w repo**; pobierane z Mojang na użytek użytkownika
  (wzorzec zgodny z COMPLIANCE projektów referencyjnych). Minecraft ©
  Mojang/Microsoft – nie jesteśmy powiązani.
* Komponenty trzecie: CheerpJ (Leaning Technologies, community),
  gl4es (LGPL), LWJGL (BSD-2), browsercraft (Apache-2.0) – szczegóły w
  `vendor/LICENSES.md`.
* Analiza AAB/source launchera: `docs/analiza-mojolauncher.md`.
