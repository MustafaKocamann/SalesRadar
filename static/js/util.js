/**
 * Small, dependency-free helpers shared across modules.
 * DOM helpers use `textContent` by default so untrusted strings can never be
 * interpreted as markup.
 */

/** @param {string} selector @param {ParentNode} [root] */
export const qs = (selector, root = document) => root.querySelector(selector);

/** @param {string} selector @param {ParentNode} [root] */
export const qsa = (selector, root = document) =>
  Array.from(root.querySelectorAll(selector));

/** @param {string} id */
export const byId = (id) => document.getElementById(id);

/**
 * Create an element with attributes and children.
 * Strings become text nodes; null/undefined/false children are skipped.
 *
 * @param {string} tag
 * @param {Record<string, unknown>} [attrs]
 * @param {Node|string|Array<Node|string|null|undefined|false>} [children]
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === "class") {
      node.className = String(value);
    } else if (key === "text") {
      node.textContent = String(value);
    } else if (key === "dataset") {
      for (const [dataKey, dataValue] of Object.entries(value)) {
        if (dataValue !== null && dataValue !== undefined) {
          node.dataset[dataKey] = String(dataValue);
        }
      }
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, String(value));
    }
  }

  append(node, children);
  return node;
}

/** @param {Node} parent @param {unknown} children */
export function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];

  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return parent;
}

/** Replace all children of a node. @param {Node} node @param {unknown} children */
export function replace(node, children = []) {
  node.replaceChildren();
  append(node, children);
  return node;
}

/** Clone a <template> by id. @param {string} id @returns {HTMLElement} */
export function fromTemplate(id) {
  const template = byId(id);
  if (!template) throw new Error(`Missing template #${id}`);
  return /** @type {HTMLElement} */ (template.content.firstElementChild.cloneNode(true));
}

/** Fill `[data-bind]` descendants from a plain object. @param {HTMLElement} root */
export function bindText(root, values) {
  for (const [key, value] of Object.entries(values)) {
    const target = root.querySelector(`[data-bind="${key}"]`);
    if (target) target.textContent = value == null ? "" : String(value);
  }
  return root;
}

/** Safe URL for anchors — only http(s) and mailto survive. @param {unknown} value */
export function safeUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
    return null;
  } catch {
    return null;
  }
}

/** Hostname without `www.` for compact display. @param {unknown} url */
export function hostOf(url) {
  const safe = safeUrl(url);
  if (!safe) return "";
  try {
    return new URL(safe).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Human readable date/time. @param {number|string|Date} value */
export function formatTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Relative "2 hours ago" label, with graceful fallback. @param {number} timestamp */
export function formatRelative(timestamp) {
  const delta = Date.now() - Number(timestamp);
  if (!Number.isFinite(delta) || delta < 0) return "Just now";

  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(timestamp)
  );
}

/** Day bucket for history grouping. @param {number} timestamp */
export function dayBucket(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((startOfToday - startOfDate) / 86400000);

  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return "Previous 7 days";
  if (diffDays < 30) return "Previous 30 days";
  return "Older";
}

/** Duration formatting for stage timings. @param {number} ms */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** USD formatting for API cost. Never invents a value. @param {unknown} value */
export function formatCost(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "";
  if (amount === 0) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

/** Compact integer/token counts. @param {unknown} value */
export function formatCount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "";
  return new Intl.NumberFormat(undefined, { notation: amount >= 10000 ? "compact" : "standard" }).format(amount);
}

/** @param {string} value @param {number} [max] */
export function truncate(value, max = 64) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Debounce that preserves the latest arguments. */
export function debounce(fn, wait = 160) {
  let timer = 0;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}

/** Pluralise simply. @param {number} count @param {string} singular @param {string} [plural] */
export function plural(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural || `${singular}s`}`;
}

/** Trigger a client-side file download. @param {string} filename @param {string} content @param {string} type */
export function downloadFile(filename, content, type = "text/markdown;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: filename, rel: "noopener" });
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Copy text to the clipboard with a legacy fallback.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }

  try {
    const area = el("textarea", {
      value: text,
      readonly: true,
      class: "visually-hidden",
      "aria-hidden": "true",
      tabindex: "-1",
    });
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Clamp helper. */
export const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** True when the user asked for reduced motion. */
export function prefersReducedMotion() {
  return document.documentElement.getAttribute("data-motion") === "reduced";
}

/** Slug for filenames. @param {string} value */
export function slug(value) {
  return (
    String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "research"
  );
}

/** Generate a short unique id without external dependencies. */
export function uid(prefix = "id") {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return `${prefix}_${window.crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Stable initials for avatars. @param {string} name */
export function initials(name) {
  return String(name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}

/** Resolve CSS custom property. @param {string} name */
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
