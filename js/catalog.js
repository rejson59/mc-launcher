/**
 * catalog.js – katalog WERSJI z oficjalnego manifestu Mojang.
 * Żadnych portów/podrób: lista = to, co Mojang wydał, przefiltrowane do ery
 * LWJGL 2 (do 1.12.2), czyli zakresu, który niezmodyfikowany klient obsługuje
 * w przeglądarce (CheerpJ + gl4es, jak MojoLauncher na Androidzie).
 */
import { listVersions, getManifest } from "./mojang.js";

let cached = null;

export async function getCatalog() {
  if (cached) return cached;
  const list = await listVersions();
  cached = list.map((v) => ({
    id: v.id,
    type: v.type,
    time: v.releaseTime,
    title: titleOf(v),
    era: eraOf(v),
  }));
  return cached;
}

export function titleOf(v) {
  if (v.type === "old_beta") return "Beta " + v.id.replace(/^b/, "");
  if (v.type === "old_alpha") return "Alpha " + v.id.replace(/^a/, "");
  return v.id;
}
export function eraOf(v) {
  if (v.type === "old_beta") return "beta";
  if (v.type === "old_alpha") return "alfa";
  const n = (v.id.match(/^\d+\.\d+/) || ["?"])[0];
  return n;
}

/** Popularne wersje na start (dla domyślnej karty i filtrów). */
export const FEATURED = ["1.12.2", "1.8.9", "1.7.10", "1.5.2", "b1.7.3", "1.0"];

export async function getCatalogItem(id) {
  const list = await getCatalog();
  return list.find((c) => c.id === id) || null;
}

/** Awaryjna lista, gdy manifest niedostępny (tylko identyfikatory). */
export async function manifestHealthy() {
  try { await getManifest(); return true; } catch { return false; }
}
