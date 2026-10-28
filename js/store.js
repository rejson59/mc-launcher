/**
 * store.js – trwały stan launchera (localStorage):
 * profil, preferencje (AutoRAM/skala/renderer/HUD/dotyk/mirror), instancje.
 */

const KEY = "mcw.state.v1";

function randomUuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const DEFAULTS = {
  profile: { name: "Gracz", uuid: null },
  prefs: {
    ramMode: "auto",      // auto | custom
    ramMb: null,          // nadpisany Xms/Xmx gdy ramMode=custom
    renderScale: "auto",  // auto | liczba %
    rendererTier: "auto", // auto | lt
    hud: true,
    touch: "auto",        // auto | on | off
    mirror: "auto",       // auto | raw | jsdelivr
  },
  instances: [],          // { instId, catalogId, name, installedAt, lastPlayed, playMs, bytes }
  selected: null,
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const s = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULTS),
      ...s,
      profile: { ...DEFAULTS.profile, ...(s.profile || {}) },
      prefs: { ...DEFAULTS.prefs, ...(s.prefs || {}) },
      instances: Array.isArray(s.instances) ? s.instances : [],
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

const state = load();
if (!state.profile.uuid) state.profile.uuid = randomUuid();

const listeners = new Set();

export const store = {
  get state() { return state; },

  save() {
    localStorage.setItem(KEY, JSON.stringify(state));
    for (const fn of listeners) fn(state);
  },

  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  setProfileName(name) {
    state.profile.name = (name || "Gracz").slice(0, 24);
    this.save();
  },

  setPref(key, value) {
    state.prefs[key] = value;
    this.save();
  },

  /* ---- instancje ---- */
  findInstance(instId) {
    return state.instances.find((i) => i.instId === instId) || null;
  },

  findByCatalog(catalogId) {
    return state.instances.find((i) => i.catalogId === catalogId) || null;
  },

  upsertInstance(inst) {
    const i = this.findInstance(inst.instId);
    if (i) Object.assign(i, inst);
    else state.instances.push(inst);
    this.save();
  },

  removeInstance(instId) {
    state.instances = state.instances.filter((i) => i.instId !== instId);
    if (state.selected === instId) {
      state.selected = state.instances[0]?.instId || null;
    }
    this.save();
  },

  select(instId) {
    state.selected = instId;
    this.save();
  },

  markPlayed(instId, ms) {
    const i = this.findInstance(instId);
    if (!i) return;
    i.lastPlayed = Date.now();
    i.playMs = (i.playMs || 0) + ms;
    this.save();
  },
};
