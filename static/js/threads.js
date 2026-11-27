/**
 * Thread store — the single source of truth for conversations.
 *
 * A thread is an ordered list of entries: user questions and run results.
 * Every mutation persists to localStorage and notifies a single listener,
 * which keeps rendering predictable.
 */

import { LIMITS } from "./config.js";
import {
  createThread,
  loadThreads,
  saveThreads,
  isPersistent,
} from "./store.js";
import { uid, truncate } from "./util.js";

export class ThreadStore {
  /**
   * @param {{
   *   onChange?: (store: ThreadStore) => void,
   * }} [options]
   */
  constructor(options = {}) {
    /** @type {import("./store.js").StoredThread[]} */
    this.threads = loadThreads();
    this.activeId = "";
    this.onChange = options.onChange || null;
    this.persistent = isPersistent;
  }

  /** @param {() => void} [silent] */
  notify(silent = false) {
    if (!silent) saveThreads(this.threads);
    this.onChange?.(this);
  }

  /** @returns {import("./store.js").StoredThread[]} */
  list() {
    return [...this.threads].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** @returns {import("./store.js").StoredThread|null} */
  active() {
    return this.threads.find((thread) => thread.id === this.activeId) || null;
  }

  /** @param {string} id */
  find(id) {
    return this.threads.find((thread) => thread.id === id) || null;
  }

  /** @param {string} id */
  setActive(id) {
    this.activeId = id;
    this.notify(true);
  }

  /** Create an empty thread, make it active, and return it. */
  create() {
    const thread = createThread();
    this.threads.unshift(thread);
    this.activeId = thread.id;
    this.notify();
    return thread;
  }

  /**
   * Return the active thread, creating one when needed.
   * @returns {import("./store.js").StoredThread}
   */
  ensureActive() {
    return this.active() || this.create();
  }

  /**
   * @param {string} threadId
   * @param {Omit<import("./store.js").StoredEntry, "id"|"createdAt">} entry
   * @returns {import("./store.js").StoredEntry}
   */
  addEntry(threadId, entry) {
    const thread = this.find(threadId);
    if (!thread) throw new Error("Thread not found");

    const stored = {
      ...entry,
      id: uid("entry"),
      createdAt: Date.now(),
    };

    thread.entries.push(stored);
    thread.entries = thread.entries.slice(-LIMITS.maxEntriesPerThread);
    thread.updatedAt = stored.createdAt;

    this.notify();
    return stored;
  }

  /**
   * Patch a stored entry (used for in-flight run updates).
   * @param {string} threadId
   * @param {string} entryId
   * @param {Partial<import("./store.js").StoredEntry>} patch
   * @param {{persist?: boolean}} [options]
   */
  updateEntry(threadId, entryId, patch, options = {}) {
    const thread = this.find(threadId);
    if (!thread) return null;

    const entry = thread.entries.find((candidate) => candidate.id === entryId);
    if (!entry) return null;

    Object.assign(entry, patch);
    thread.updatedAt = Date.now();

    // In-flight updates are frequent; only persist when the caller says so.
    if (options.persist === false) {
      this.onChange?.(this);
    } else {
      this.notify();
    }
    return entry;
  }

  /**
   * Derive a human title for a thread from its first question.
   * @param {string} threadId
   * @param {string} query
   */
  retitle(threadId, query) {
    const thread = this.find(threadId);
    if (!thread) return;
    if (thread.title !== "New research" && thread.entries.some((entry) => entry.kind === "run")) {
      return;
    }
    thread.title = truncate(query, 58) || "New research";
    this.notify();
  }

  /** @param {string} id */
  delete(id) {
    const index = this.threads.findIndex((thread) => thread.id === id);
    if (index === -1) return false;

    this.threads.splice(index, 1);
    if (this.activeId === id) {
      this.activeId = this.threads[0]?.id || "";
    }
    this.notify();
    return true;
  }

  /** Remove every conversation. */
  clear() {
    this.threads = [];
    this.activeId = "";
    this.notify();
  }

  /**
   * Attach a completed run to an existing run entry.
   * @param {string} threadId
   * @param {string} entryId
   * @param {import("./model.js").RunViewModel} run
   */
  completeRun(threadId, entryId, run) {
    return this.updateEntry(threadId, entryId, { run });
  }
}
