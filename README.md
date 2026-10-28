# mc-launcher

**Zagraj w ORYGINALNEGO Minecrafta w przeglądarce** – launcher zbudowany na
podstawie analizy [MojoLauncher (MJLauncher)](https://github.com/MojoLauncher/MojoLauncher),
który słynie z tego, że uruchamia Minecrafta nawet na telefonie z mniej niż
1 GB RAM-u.

## Uruchomienie

```bash
python3 server.py          # http://0.0.0.0:8080
# albo
npm start
```

Otwórz adres w przeglądarce (Chrome/Edge/Firefox, wymagany WebGL + Service Worker).

## Co jest w środku

| Element | Opis |
|---|---|
| `docs/analiza-mojolauncher.md` | **Pełna analiza MojoLaunchera**: jak zdobyty build (AAB z historii git), AutoRAM, tabele RAM, renderery (GL4ES/LTW/Zink), caciocavallo, warstwy argumentów JVM |
| `mojo-apk/` *(gitignored)* | Rozłożony oficjalny build AAB (dex, JRE, GL4ES, options.txt…) |
| `js/mojo.js` | Port logiki MojoLauncher na JS: `findBestRAMAllocation`, `findBestResolution`, `isDevicePowerful`, `preprocessUserArgs`, `buildJvmArgs` |
| `js/catalog.js` | Katalog oryginalnych wersji gry (Classic 0.0.17a → 1.8.8 WASM) |
| `js/installer.js` + `sw.js` | „Pierwsze uruchomienie": pobranie buildu do Cache Storage, weryfikacja SHA-256, leniwe dociąganie dużych plików |
| `js/game.js` | Uruchomienie gry: skaler rozdzielczości, HUD (FPS/heap/bufor), nakładka dotykowa |

## Jak to działa (krótko)

1. **Wykrywanie sprzętu** – te tabele co w MojoLauncherze: `navigator.deviceMemory`
   → heap 296…2048 MB (`Xms = Xmx`), mocne urządzenie → skaler rozdzielczości
   do celu 720p/1080p, WebGL2 → analog trybu LTW, WebGL1 → analog GL4ES.
2. **Instalacja instancji** – build oryginalnej wersji gry (port Eaglercraft/TeaVM
   z GitHuba) trafia do Cache Storage; pliki z manifestem mają sprawdzane SHA-256
   (jak `PREF_VERIFY_FILES` u nich).
3. **Uruchomienie** – gra startuje lokalnie w iframe, z ustawioną skalą
   i HUD-em; duże pliki dociągają się „leniwie" przez Service Workera.
4. **Java args** – ekran z argumentami JVM złożonymi dokładnie jak
   w `JavaRunner` (filtr + warstwa domyślnych flag) – gotowe do skopiowania.

## Prawne

* Kod launchera: ten repozytorium.
* Analiza i port logiki: na podstawie MojoLauncher (LGPL-3.0) – cytujemy
  reguły, nie kopiujemy kodu.
* Gra: społeczne porty oryginalnego kodu Minecrafta do JS/WASM; w repo nie ma
  żadnych plików gry. Minecraft © Mojang/Microsoft – nie jesteśmy z nimi powiązani.
