/**
 * UI primitives: toasts, confirmation dialogs, dialogs, and small DOM effects.
 */

import { el, byId, prefersReducedMotion } from "./util.js";

/* ==========================================================================
   Toasts
   ========================================================================== */

const TOAST_ICONS = {
  info: "i-info",
  success: "i-check",
  warning: "i-alert-triangle",
  danger: "i-alert-circle",
};

/**
 * Show a transient message.
 * @param {string} message
 * @param {{tone?: "info"|"success"|"warning"|"danger", duration?: number}} [options]
 */
export function toast(message, options = {}) {
  const region = byId("toast-region");
  if (!region) return;

  const tone = options.tone || "info";
  const node = el("div", { class: "toast", dataset: { tone } }, [
    el("svg", { class: "icon toast__icon", "aria-hidden": "true" }, [
      el("use", { href: `#${TOAST_ICONS[tone] || TOAST_ICONS.info}` }),
    ]),
    el("span", { class: "toast__message", text: message }),
  ]);

  region.append(node);

  // Keep at most three stacked toasts.
  while (region.children.length > 3) {
    region.firstElementChild?.remove();
  }

  const duration = options.duration ?? 3800;
  const remove = () => {
    if (!node.isConnected) return;
    node.dataset.leaving = "true";
    const delay = prefersReducedMotion() ? 0 : 140;
    window.setTimeout(() => node.remove(), delay);
  };

  const timer = window.setTimeout(remove, duration);
  node.addEventListener("click", () => {
    window.clearTimeout(timer);
    remove();
  });
}

/* ==========================================================================
   Dialogs
   ========================================================================== */

/**
 * Open a native dialog, restoring focus on close.
 * @param {HTMLDialogElement} dialog
 * @param {HTMLElement|null} [focusTarget]
 */
export function openDialog(dialog, focusTarget = null) {
  if (!(dialog instanceof HTMLDialogElement)) return;
  if (dialog.open) dialog.close();

  dialog.showModal();

  const target =
    focusTarget ||
    dialog.querySelector("[autofocus]") ||
    dialog.querySelector(
      "select, input, textarea, button:not([data-close-dialog]), [href]"
    );

  window.setTimeout(() => target?.focus({ preventScroll: true }), 20);
}

/** @param {HTMLDialogElement} dialog */
export function closeDialog(dialog) {
  if (dialog?.open) dialog.close();
}

/** @param {string} id */
export function getDialog(id) {
  const node = byId(id);
  return node instanceof HTMLDialogElement ? node : null;
}

/**
 * Promise-based confirmation dialog.
 * @param {{title: string, text: string, confirmLabel?: string, cancelLabel?: string, danger?: boolean}} options
 * @returns {Promise<boolean>}
 */
export function confirmAction(options) {
  const dialog = getDialog("confirm-dialog");
  const accept = byId("confirm-accept");
  const title = byId("confirm-title");
  const text = byId("confirm-text");

  if (!dialog || !accept || !title || !text) {
    return Promise.resolve(window.confirm(options.title));
  }

  title.textContent = options.title;
  text.textContent = options.text;
  accept.textContent = options.confirmLabel || "Confirm";
  accept.className = options.danger === false ? "btn btn--primary" : "btn btn--danger";

  const cancel = dialog.querySelector("[data-close-dialog]");
  if (cancel instanceof HTMLElement) cancel.textContent = options.cancelLabel || "Cancel";

  return new Promise((resolve) => {
    /** @param {boolean} value */
    const settle = (value) => {
      cleanup();
      if (dialog.open) dialog.close();
      resolve(value);
    };

    /** @param {MouseEvent} event */
    const onAccept = () => settle(true);
    const onClose = () => settle(false);
    const onBackdrop = (event) => {
      if (event.target === dialog) settle(false);
    };

    function cleanup() {
      accept.removeEventListener("click", onAccept);
      dialog.removeEventListener("close", onClose);
      dialog.removeEventListener("click", onBackdrop);
    }

    accept.addEventListener("click", onAccept);
    dialog.addEventListener("close", onClose, { once: false });
    dialog.addEventListener("click", onBackdrop);

    dialog.showModal();
    window.setTimeout(() => accept.focus({ preventScroll: true }), 20);
  });
}

/* ==========================================================================
   Textarea autosize
   ========================================================================== */

/**
 * Grow a textarea with its content, capped by CSS `max-height`.
 * @param {HTMLTextAreaElement} textarea
 */
export function autosize(textarea) {
  textarea.style.height = "auto";
  const next = Math.min(textarea.scrollHeight, Math.round(window.innerHeight * 0.36));
  textarea.style.height = `${next}px`;
}

/* ==========================================================================
   Clipboard feedback
   ========================================================================== */

/**
 * Swap a button's icon to a checkmark for a moment to confirm a copy.
 * @param {HTMLElement} button
 * @param {string} [restoreIcon]
 */
export function flashCopied(button, restoreIcon = "i-copy") {
  const use = button.querySelector("use");
  if (!use) return;
  const original = use.getAttribute("href") || `#${restoreIcon}`;
  use.setAttribute("href", "#i-check");
  button.dataset.copied = "true";

  window.setTimeout(() => {
    use.setAttribute("href", original);
    delete button.dataset.copied;
  }, 1500);
}

/* ==========================================================================
   Scroll helpers
   ========================================================================== */

/**
 * Scroll a container to the bottom, honouring reduced-motion preferences.
 * @param {HTMLElement} container
 * @param {boolean} [smooth]
 */
export function scrollToBottom(container, smooth = true) {
  if (!container) return;
  container.scrollTo({
    top: container.scrollHeight,
    behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto",
  });
}

/**
 * True when the container is scrolled near its bottom (autoscroll guard).
 * @param {HTMLElement} container
 * @param {number} [threshold]
 */
export function isNearBottom(container, threshold = 120) {
  if (!container) return true;
  return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
}
