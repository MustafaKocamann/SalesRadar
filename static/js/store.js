/**
 * Persistence layer.
 *
 * Threads, settings and UI preferences are stored in `localStorage` because the
 * backend exposes no persistence capability yet (`capabilities.history`).
 * The UI labels this honestly as local browser history.
 */

import { LIMITS, STORAGE_KEYS } from "./config.js";
import { uid } from "./util.js";

/** @returns {Storage|null} */
function storage() {
  try {
    const probe = "__salesintel_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

const store = storage();

/** True when persistence is actually available. */
export const isPersistent = Boolean(store);

/** @param {string} key @param {unknown} fallback */
function readJson(key, fallback) {
  if (!store) return fallback;
  try {
    const raw = store.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/** @param {string} key @param {unknown} value */
function writeJson(key, value) {
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Approximate bytes used by this app's keys, for the privacy panel. */
export function storageFootprint() {
  if (!store) return { threads: 0, settings: 0, available: false };
  const size = (key) => (store.getItem(key) || "").length * 2;
  return {
    available: true,
    threads: size(STORAGE_KEYS.threads),
    settings: size(STORAGE_KEYS.settings),
  };
}

/* ==========================================================================
   Settings
   ========================================================================== */

export const DEFAULT_SETTINGS = Object.freeze({
  theme: "system",
  density: "comfortable",
  motion: "",
  defaultFocus: "",
  showTimer: true,
});

/** @returns {typeof DEFAULT_SETTINGS} */
export function loadSettings() {
  const raw = readJson(STORAGE_KEYS.settings, {});
  const value = raw && typeof raw === "object" ? raw : {};

  return {
    theme: ["light", "dark", "system"].includes(value.theme) ? value.theme : DEFAULT_SETTINGS.theme,
    density: value.density === "compact" ? "compact" : DEFAULT_SETTINGS.density,
    motion: value.motion === "reduced" || value.motion === "full" ? value.motion : DEFAULT_SETTINGS.motion,
    defaultFocus: typeof value.defaultFocus === "string" ? value.defaultFocus : "",
    showTimer: value.showTimer !== false,
  };
}

/** @param {typeof DEFAULT_SETTINGS} settings */
export function saveSettings(settings) {
  return writeJson(STORAGE_KEYS.settings, settings);
}

/* ==========================================================================
   Threads
   ========================================================================== */

/**
 * @typedef {Object} StoredEntry
 * @property {string} id
 * @property {"user"|"run"} kind
 * @property {string} text
 * @property {string} [focus]
 * @property {number} createdAt
 * @property {import("./model.js").RunViewModel} [run]
 */

/**
 * @typedef {Object} StoredThread
 * @property {string} id
 * @property {string} title
 * @property {string} createdAt
 * @property {number} updatedAt
 * @property {StoredEntry[]} entries
 */

/** @returns {StoredThread[]} */
export function loadThreads() {
  const raw = readJson(STORAGE_KEYS.threads, []);
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((thread) => thread && typeof thread === "object" && thread.id)
    .map((thread) => ({
      id: String(thread.id),
      title: String(thread.title || "Untitled research"),
      createdAt: String(thread.createdAt || new Date().toISOString()),
      updatedAt: Number(thread.updatedAt) || Date.now(),
      entries: Array.isArray(thread.entries)
        ? thread.entries
            .filter((entry) => entry && typeof entry === "object" && entry.kind)
            .slice(-LIMITS.maxEntriesPerThread)
        : [],
    }))
    .slice(0, LIMITS.maxThreads);
}

/** @param {StoredThread[]} threads */
export function saveThreads(threads) {
  return writeJson(
    STORAGE_KEYS.threads,
    threads.slice(0, LIMITS.maxThreads).map((thread) => ({
      ...thread,
      entries: thread.entries.slice(-LIMITS.maxEntriesPerThread),
    }))
  );
}

/** @returns {StoredThread} */
export function createThread() {
  return {
    id: uid("thread"),
    title: "New research",
    createdAt: new Date().toISOString(),
    updatedAt: Date.now(),
    entries: [],
  };
}

/** Remove every stored conversation. */
export function clearThreads() {
  if (!store) return false;
  try {
    store.removeItem(STORAGE_KEYS.threads);
    return true;
  } catch {
    return false;
  }
}

/** Reset preferences only. */
export function clearSettings() {
  if (!store) return false;
  try {
    store.removeItem(STORAGE_KEYS.settings);
    return true;
  } catch {
    return false;
  }
}
