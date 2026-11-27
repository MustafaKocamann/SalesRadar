/**
 * SalesIntel AI — application controller.
 *
 * Wires the DOM shell to the API client, thread store and renderer.
 * The interface is contract-first: it adapts to what `GET /health` reports and
 * never displays a capability, metric or citation the backend did not return.
 */

import { CAPABILITY_META, DEFAULT_MODEL, LIMITS } from "./config.js";
import {
  ApiError,
  EMPTY_HEALTH,
  normaliseHealth,
  fetchHealth,
  runResearch,
  streamResearch,
} from "./api.js";
import {
  applyStageEvent,
  createStages,
  createUnavailableRun,
  normaliseRunResult,
} from "./model.js";
import { ThreadStore } from "./threads.js";
import {
  buildMarkdown,
  renderCapabilities,
  renderChecks,
  renderFacts,
  renderHistory,
  renderRunDetails,
  renderSuggestions,
  renderSystemChecks,
  renderThread,
  updateRunCard,
} from "./render.js";
import { cloneSampleRun } from "./sample.js";
import {
  DEFAULT_SETTINGS,
  clearSettings,
  clearThreads,
  loadSettings,
  loadThreads,
  saveSettings,
  storageFootprint,
} from "./store.js";
import {
  autosize,
  closeDialog,
  confirmAction,
  flashCopied,
  getDialog,
  isNearBottom,
  openDialog,
  scrollToBottom,
  toast,
} from "./ui.js";
import {
  byId,
  clamp,
  copyText,
  debounce,
  downloadFile,
  el,
  formatDuration,
  plural,
  qs,
  qsa,
  replace,
  slug,
  truncate,
} from "./util.js";

/* ==========================================================================
   State
   ========================================================================== */

const settings = loadSettings();
/** @type {ReturnType<typeof normaliseHealth>} */
let health = { ...EMPTY_HEALTH };
let healthLoaded = false;
let activeRun = null; // AbortController for the in-flight request
let activeEntryId = null;
let elapsedTimer = 0;
let runStartedAt = 0;

const store = new ThreadStore({ onChange: () => onStoreChange() });

/** @type {ReturnType<typeof buildRefs>} */
const refs = buildRefs();

const dom = {
  app: byId("app"),
  empty: byId("empty-state"),
  thread: byId("thread-section"),
  threadList: byId("thread-list"),
  threadTitle: byId("thread-title"),
  threadState: byId("thread-state"),
  composer: byId("composer"),
  input: /** @type {HTMLTextAreaElement} */ (byId("composer-input")),
  submit: byId("composer-submit"),
  submitLabel: qs(".composer__submit-label"),
  count: byId("composer-count"),
  focus: /** @type {HTMLSelectElement} */ (byId("focus-select")),
  hint: byId("composer-hint"),
  suggestions: byId("suggestions"),
  historyList: byId("history-list"),
  historyEmpty: byId("history-empty"),
  historyCount: byId("history-count"),
  historyScroll: byId("history-scroll"),
  historyFilter: /** @type {HTMLInputElement} */ (byId("history-filter")),
  clearFilter: qs("[data-action='clear-filter']"),
  checks: byId("capability-checks"),
  buildNote: byId("build-note"),
  buildNoteText: byId("build-note-text"),
  modelChip: byId("model-chip"),
  modelChipLabel: byId("model-chip-label"),
  composerModel: byId("composer-model-label"),
  footDot: byId("foot-status-dot"),
  footTitle: byId("foot-status-title"),
  footSub: byId("foot-status-sub"),
  sidebarScrim: byId("sidebar-scrim"),
  stageArea: byId("stage-area"),
  themeButton: qs('[data-action="toggle-theme-menu"]'),
};

/* ==========================================================================
   Bootstrap
   ========================================================================== */

function init() {
  applySettings();
  bindComposer();
  bindGlobalActions();
  bindKeyboard();
  bindDialogs();
  bindSidebar();
  bindMediaQueries();

  renderSuggestions(dom.suggestions, (query) => {
    dom.input.value = query;
    syncComposer();
    dom.input.focus();
    dom.input.setSelectionRange(query.length, query.length);
  });

  store.activeId = store.list()[0]?.id || "";
  onStoreChange({ skipTranscript: true });

  // Restore the most recent thread if it has content, otherwise show the
  // empty state. Persisted history is local, so this never implies server data.
  const mostRecent = store.active();
  if (mostRecent?.entries.length) {
    activateThread(mostRecent.id, { restore: true });
  } else {
    showEmptyState();
  }

  checkHealth();

  // Re-check health when the tab regains focus after a long absence.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && healthLoaded) {
      const lastCheck = Number(document.body.dataset.healthAt || 0);
      if (Date.now() - lastCheck > 120000) checkHealth({ silent: true });
    }
  });
}

/* ==========================================================================
   DOM references
   ========================================================================== */

function buildRefs() {
  return {
    detailsDialog: /** @type {HTMLDialogElement|null} */ (getDialog("details-dialog")),
    settingsDialog: /** @type {HTMLDialogElement|null} */ (getDialog("settings-dialog")),
    shortcutsDialog: /** @type {HTMLDialogElement|null} */ (getDialog("shortcuts-dialog")),
    detailsSubtitle: byId("details-subtitle"),
    detailsStages: byId("details-stages"),
    detailsMetrics: byId("details-metrics"),
    detailsCallsSection: byId("details-calls-section"),
    detailsCalls: byId("details-calls"),
    detailsEvidenceSection: byId("details-evidence-section"),
    detailsEvidence: byId("details-evidence"),
    systemChecks: byId("system-checks"),
    systemFacts: byId("system-facts"),
    capabilityList: byId("capability-list"),
    storageFacts: byId("storage-facts"),
  };
}

/* ==========================================================================
   Health & capability reporting
   ========================================================================== */

/**
 * @param {{silent?: boolean}} [options]
 */
async function checkHealth(options = {}) {
  setEnvironmentStatus("unknown", "Checking environment", "Connecting to API…");

  try {
    health = await fetchHealth();
    healthLoaded = true;
    document.body.dataset.healthAt = String(Date.now());
    applyHealth();
    if (!options.silent) {
      // Only surfaced when something is genuinely degraded.
      const degraded = health.checks.filter((check) => check.state === "degraded");
      if (degraded.length) {
        toast(`${degraded.length} environment check${degraded.length === 1 ? "" : "s"} degraded — see System status`, {
          tone: "warning",
        });
      }
    }
  } catch (error) {
    healthLoaded = false;
    health = { ...EMPTY_HEALTH };
    applyHealth();
    const message = error instanceof ApiError ? error.message : "The API is unreachable.";
    setEnvironmentStatus("error", "API unreachable", "Check that the FastAPI server is running");
    renderChecks(dom.checks, health);
    if (!options.silent) toast(message, { tone: "danger", duration: 6000 });
  }
}

function applyHealth() {
  const modelLabel = displayModel(health.model?.id);
  if (modelLabel) {
    dom.modelChipLabel.textContent = modelLabel;
    dom.composerModel.textContent = modelLabel;
    dom.modelChip.title = health.model.provider
      ? `${health.model.provider} · ${health.model.id}`
      : modelLabel;
  }

  // Composer limits are the backend's contract, not a guess.
  const max = clamp(health.limits?.max_query_chars || LIMITS.maxQueryChars, 10, 20000);
  dom.input.maxLength = max;
  dom.count.textContent = `0/${max}`;

  renderChecks(dom.checks, health);
  refreshSystemPanel();
  refreshBuildNote();
  updateEnvironmentFooter();
  syncComposer();
}

/** @param {string} id */
function displayModel(id) {
  if (!id) return "";
  // `openai/gpt-oss-120b` reads better as `GPT-OSS-120B`.
  const tail = id.split("/").pop() || id;
  return tail.toUpperCase().replace(/\s+/g, "-");
}

function updateEnvironmentFooter() {
  if (!healthLoaded) {
    setEnvironmentStatus("error", "API unreachable", "Check that the FastAPI server is running");
    return;
  }

  const degraded = health.checks.filter((check) => check.state === "degraded");
  const unavailable = health.checks.filter((check) => check.state === "unavailable");
  const model = displayModel(health.model?.id) || DEFAULT_MODEL;

  if (degraded.length) {
    setEnvironmentStatus(
      "degraded",
      "Environment degraded",
      `${degraded.map((check) => check.label).join(", ")} not fully configured`
    );
  } else if (health.capabilities.research) {
    setEnvironmentStatus("ok", "All systems operational", `${model} · research pipeline ready`);
  } else if (unavailable.length) {
    setEnvironmentStatus(
      "idle",
      "Interface ready",
      `${model} configured · pipeline unavailable`
    );
  } else {
    setEnvironmentStatus("ok", "API connected", `${model} · ${health.version || "v0.1.0"}`);
  }
}

/**
 * @param {"ok"|"degraded"|"error"|"idle"|"unknown"} state
 * @param {string} title
 * @param {string} subtitle
 */
function setEnvironmentStatus(state, title, subtitle) {
  dom.footDot.dataset.state = state === "idle" ? "ok" : state;
  dom.footTitle.textContent = title;
  dom.footSub.textContent = subtitle;
}

/** Replace `{model}` and capability facts in the sample/build note. */
function refreshBuildNote() {
  const researchAvailable = health.capabilities?.research === true;
  if (researchAvailable) {
    dom.buildNote.hidden = true;
    dom.buildNoteText.textContent = "";
    return;
  }

  dom.buildNote.hidden = false;
  const detail = healthLoaded
    ? "The FastAPI host is running and reports the agent pipeline as unavailable, so a run returns an explanatory response instead of a fabricated report."
    : "The API is not reachable, so runs cannot start. Start the FastAPI server to enable research.";

  replace(dom.buildNoteText, [
    el("strong", { text: "Preview build. " }),
    document.createTextNode(detail),
  ]);
}

/* ==========================================================================
   System settings panel
   ========================================================================== */

function refreshSystemPanel() {
  renderSystemChecks(
    refs.systemChecks,
    health.checks.length
      ? health.checks
      : [
          {
            id: "api",
            label: "API",
            state: healthLoaded ? "ok" : "error",
            detail: healthLoaded
              ? "Connected to the FastAPI host"
              : "No response from the API",
          },
        ]
  );

  const facts = [
    { label: "Service", value: health.service || "salesintel-ai" },
    { label: "Version", value: health.version || "not reported" },
    { label: "Model", value: health.model?.id || "not reported" },
    { label: "Provider", value: health.model?.provider || "not reported" },
    { label: "Query limit", value: `${health.limits?.min_query_chars ?? 2}–${health.limits?.max_query_chars ?? 600} characters` },
  ];
  renderFacts(refs.systemFacts, facts);

  renderCapabilities(refs.capabilityList, health.capabilities || {}, CAPABILITY_META);
  refreshStorageFacts();
}

function refreshStorageFacts() {
  const footprint = storageFootprint();
  const threads = loadThreads().length;
  const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

  renderFacts(refs.storageFacts, [
    {
      label: "Browser storage",
      value: footprint.available ? "Available" : "Unavailable (private mode)",
    },
    { label: "Conversations", value: plural(threads, "thread") },
    { label: "History size", value: footprint.available ? kb(footprint.threads) : "—" },
    { label: "Preferences size", value: footprint.available ? kb(footprint.settings) : "—" },
    {
      label: "Server persistence",
      value: health.capabilities?.history ? "Enabled" : "Not provided by this backend",
    },
  ]);
}

/* ==========================================================================
   Composer
   ========================================================================== */

function bindComposer() {
  dom.input.addEventListener("input", syncComposer);

  dom.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submitResearch();
    }
  });

  // Paste and drop handlers keep content plain text.
  dom.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    if (activeRun) {
      // The same control doubles as a stop button while a run is in flight.
      activeRun.abort();
      return;
    }
    submitResearch();
  });

  dom.focus.addEventListener("change", () => {
    settings.defaultFocus = dom.focus.value;
    saveSettings(settings);
  });
}

function syncComposer() {
  const value = dom.input.value;
  const max = Number(dom.input.maxLength) || LIMITS.maxQueryChars;
  const trimmed = value.trim();
  const valid = trimmed.length >= LIMITS.minQueryChars && trimmed.length <= max;
  const running = Boolean(activeRun);

  // While running the button becomes an enabled "stop" control.
  dom.submit.disabled = running ? false : !valid;
  dom.count.textContent = `${value.length}/${max}`;
  dom.count.dataset.nearLimit = String(value.length > max * 0.9);

  autosize(dom.input);

  if (running) {
    dom.submitLabel.textContent = "Stop";
    dom.submit.dataset.mode = "running";
    dom.submit.setAttribute("aria-label", "Stop research");
    dom.submit.title = "Stop the current research run";
    const use = dom.submit.querySelector("use");
    if (use) use.setAttribute("href", "#i-stop");
  } else {
    dom.submitLabel.textContent = "Research";
    dom.submit.dataset.mode = "idle";
    dom.submit.setAttribute("aria-label", "Run research");
    dom.submit.title = "Run research (Ctrl+Enter)";
    const use = dom.submit.querySelector("use");
    if (use) use.setAttribute("href", "#i-arrow-up");
  }

  // The hint reflects real capability state rather than a generic promise.
  if (running) {
    dom.hint.lastChild.textContent = " · press Stop to cancel the run";
  } else if (!healthLoaded) {
    dom.hint.lastChild.textContent = " · API unreachable — runs will not start";
  } else if (!health.capabilities.research) {
    dom.hint.lastChild.textContent = " · pipeline unavailable on this backend";
  } else {
    dom.hint.lastChild.textContent = " · Answers cite sources or state their limits";
  }
}

/* ==========================================================================
   Research execution
   ========================================================================== */

async function submitResearch() {
  if (activeRun) {
    activeRun.abort();
    return;
  }

  const query = dom.input.value.trim();
  if (query.length < LIMITS.minQueryChars) {
    toast(`Enter at least ${LIMITS.minQueryChars} characters.`, { tone: "warning" });
    dom.input.focus();
    return;
  }

  if (!healthLoaded) {
    toast("The API is unreachable. Start the FastAPI server and retry.", { tone: "danger", duration: 6000 });
    return;
  }

  const focus = dom.focus.value || "";
  const thread = store.active() || store.create();
  const startedAt = Date.now();

  // 1. Persist the question.
  const userEntry = store.addEntry(thread.id, {
    kind: "user",
    text: query,
    focus,
    createdAt: startedAt,
  });
  store.retitle(thread.id, query);

  // 2. Create the run entry in a queued state — no progress is claimed yet.
  const stages = createStages("waiting");
  const queuedRun = {
    id: `run_${startedAt.toString(36)}`,
    status: "queued",
    company: "",
    subtitle: "",
    query,
    focus,
    stages,
    report: "",
    citations: [],
    metrics: [],
    facts: [],
    people: [],
    opportunities: [],
    warnings: [],
    notice: null,
    calls: [],
    evidence: [],
    startedAt,
    completedAt: null,
    durationMs: null,
    isSample: false,
  };

  const runEntry = store.addEntry(thread.id, { kind: "run", text: query, focus, run: queuedRun });

  dom.input.value = "";
  syncComposer();
  showThreadView();
  activateThread(thread.id, { restore: false });
  scrollToBottom(dom.thread);

  // 3. Execute against whichever transport the backend advertises.
  activeRun = new AbortController();
  activeEntryId = runEntry.id;
  runStartedAt = startedAt;
  updateThreadState("running");
  syncComposer();
  startElapsedTimer();

  try {
    if (health.capabilities.streaming) {
      await executeStreaming(thread.id, runEntry.id, {
        query,
        focus,
        startedAt,
        signal: activeRun.signal,
      });
    } else {
      await executeBlocking(thread.id, runEntry.id, {
        query,
        focus,
        startedAt,
        signal: activeRun.signal,
      });
    }
  } finally {
    stopElapsedTimer();
    activeRun = null;
    activeEntryId = null;
    syncComposer();
  }
}

/**
 * @param {string} threadId
 * @param {string} entryId
 * @param {{query: string, focus: string, startedAt: number, signal: AbortSignal}} context
 */
async function executeBlocking(threadId, entryId, context) {
  try {
    const { result, durationMs } = await runResearch(
      { query: context.query, focus: context.focus || undefined },
      { signal: context.signal }
    );

    const run = normaliseRunResult(result, {
      query: context.query,
      focus: context.focus,
      startedAt: context.startedAt,
      durationMs,
    });

    finishRun(threadId, entryId, run);
  } catch (error) {
    handleRunError(threadId, entryId, error, context);
  }
}

/**
 * @param {string} threadId
 * @param {string} entryId
 * @param {{query: string, focus: string, startedAt: number, signal: AbortSignal}} context
 */
async function executeStreaming(threadId, entryId, context) {
  /** @type {import("./model.js").StageViewModel[]} */
  let stages = createStages("waiting");
  let streamedText = "";

  const paint = () => {
    const entry = store.find(threadId)?.entries.find((candidate) => candidate.id === entryId);
    if (!entry?.run) return;
    entry.run = {
      ...entry.run,
      status: "running",
      stages: stages.map((stage) => ({ ...stage })),
      report: streamedText,
    };
    store.updateEntry(threadId, entryId, { run: entry.run }, { persist: false });
    patchRunCard(entryId, entry.run);
  };

  try {
    const { result, durationMs } = await streamResearch(
      { query: context.query, focus: context.focus || undefined },
      {
        signal: context.signal,
        onEvent: (event) => {
          switch (event.event) {
            case "stage":
              stages = applyStageEvent(stages, event);
              paint();
              break;

            case "delta":
              if (typeof event.text === "string") {
                streamedText += event.text;
                paint();
              }
              break;

            case "notice":
              toast(String(event.text || event.message || "Pipeline notice"), {
                tone: event.tone === "danger" ? "danger" : event.tone === "warning" ? "warning" : "info",
              });
              break;

            case "error":
              throw new ApiError(String(event.detail || event.message || "Streaming failed"), {
                code: String(event.code || "stream_error"),
                payload: event,
              });

            default:
              break;
          }
        },
      }
    );

    const run = result
      ? normaliseRunResult(result, {
          query: context.query,
          focus: context.focus,
          startedAt: context.startedAt,
          durationMs,
        })
      : normaliseRunResult({ report: streamedText, stages }, {
          query: context.query,
          focus: context.focus,
          startedAt: context.startedAt,
          durationMs,
        });

    finishRun(threadId, entryId, run);
  } catch (error) {
    handleRunError(threadId, entryId, error, context);
  }
}

/**
 * @param {string} threadId
 * @param {string} entryId
 * @param {import("./model.js").RunViewModel} run
 */
function finishRun(threadId, entryId, run) {
  const entry = store.find(threadId)?.entries.find((candidate) => candidate.id === entryId);
  if (entry) entry.run = run;

  store.completeRun(threadId, entryId, run);
  patchRunCard(entryId, run);
  updateThreadState(run.status);

  if (run.status === "partial") {
    toast("Research finished with warnings — review the sources.", { tone: "warning" });
  } else if (run.status === "complete") {
    toast("Research brief ready.", { tone: "success" });
  }

  scrollToBottom(dom.thread);
}

/**
 * @param {string} threadId
 * @param {string} entryId
 * @param {unknown} error
 * @param {{query: string, focus: string, startedAt: number}} context
 */
function handleRunError(threadId, entryId, error, context) {
  const apiError =
    error instanceof ApiError
      ? error
      : new ApiError("The research run failed unexpectedly.", { code: "unexpected_error" });

  if (apiError.code === "aborted") {
    const run = {
      ...createUnavailableRun(null, context, apiError),
      status: "failed",
      notice: {
        tone: "info",
        title: "Run cancelled",
        text: "The request was cancelled before the pipeline returned a result.",
        list: [],
      },
    };
    finishRun(threadId, entryId, run);
    return;
  }

  const run = createUnavailableRun(apiError.payload, context, {
    message: apiError.message,
    code: apiError.code,
    status: apiError.status,
  });

  finishRun(threadId, entryId, run);

  // A 501 is an expected state in this build, not an unexpected failure:
  // explain it once via the card, not with a scary toast.
  if (apiError.status !== 501) {
    toast(apiError.message, { tone: "danger", duration: 6000 });
  }
}

/** Patch a single run card in the DOM without re-rendering the thread. */
function patchRunCard(entryId, run) {
  const node = dom.threadList.querySelector(`[data-entry-id="${cssEscape(entryId)}"]`);
  if (!node) return;
  const shouldStick = isNearBottom(dom.thread);
  updateRunCard(node, run);
  if (shouldStick) scrollToBottom(dom.thread, false);
}

/** @param {string} value */
function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, "\\$&");
}

function startElapsedTimer() {
  stopElapsedTimer();
  if (!settings.showTimer) return;

  elapsedTimer = window.setInterval(() => {
    const host = swappableElapsed();
    if (!host) return;
    host.hidden = false;
    host.textContent = formatDuration(Date.now() - runStartedAt);
  }, 500);
}

function stopElapsedTimer() {
  if (elapsedTimer) {
    window.clearInterval(elapsedTimer);
    elapsedTimer = 0;
  }
}

function swappableElapsed() {
  if (!activeEntryId) return null;
  return dom.threadList.querySelector(
    `[data-entry-id="${cssEscape(activeEntryId)}"] [data-run-elapsed]`
  );
}

/* ==========================================================================
   Thread rendering
   ========================================================================== */

function onStoreChange(options = {}) {
  renderHistoryPanel();

  if (options.skipTranscript) return;

  const thread = store.active();
  if (thread && thread.entries.length && dom.thread.hidden === false) {
    // Full re-render is avoided during streaming (see patchRunCard).
  }

  dom.threadTitle.textContent = thread?.title || "New research";
}

function renderHistoryPanel() {
  const total = store.list().length;
  const count = renderHistory(
    dom.historyList,
    store.list(),
    store.activeId,
    {
      onOpen: (id) => activateThread(id),
      onDelete: (id) => deleteThread(id),
    },
    dom.historyFilter.value
  );

  const filtering = Boolean(dom.historyFilter.value.trim());

  if (total === 0) {
    dom.historyEmpty.hidden = false;
    dom.historyEmpty.textContent =
      "Research runs you start will appear here. History is stored locally in this browser.";
  } else if (count === 0) {
    dom.historyEmpty.hidden = false;
    dom.historyEmpty.textContent = filtering
      ? "No conversations match this filter."
      : "No conversations to show.";
  } else {
    dom.historyEmpty.hidden = true;
  }

  dom.historyCount.hidden = total === 0;
  dom.historyCount.textContent = String(filtering ? count : total);
  dom.clearFilter.hidden = !filtering;
}

/**
 * @param {string} id
 * @param {{restore?: boolean}} [options]
 */
function activateThread(id, options = {}) {
  const thread = store.find(id);
  if (!thread) return;

  store.setActive(id);

  // An untouched thread has nothing to show — fall back to the empty state.
  if (!thread.entries.length) {
    dom.threadTitle.textContent = thread.title;
    showEmptyState();
    renderHistoryPanel();
    return;
  }

  showThreadView();
  dom.threadTitle.textContent = thread.title;

  renderThread(dom.threadList, thread, {
    onDetails: openRunDetails,
    onCopyRun: copyRun,
    onExportRun: exportRun,
    onRetryRun: retryRun,
    onCopyText: (text) => copyWithFeedback(text, "Question copied"),
  });

  const lastRun = [...thread.entries].reverse().find((entry) => entry.kind === "run")?.run;
  updateThreadState(lastRun?.status || "idle");

  if (!options.restore) scrollToBottom(dom.thread, false);
  renderHistoryPanel();
  closeMobileSidebar();
}

function showEmptyState() {
  dom.empty.hidden = false;
  dom.thread.hidden = true;
  dom.threadTitle.textContent = "New research";
  updateThreadState("idle");
  dom.input.focus({ preventScroll: true });
}

function showThreadView() {
  dom.empty.hidden = true;
  dom.thread.hidden = false;
}

/** @param {string} status */
function updateThreadState(status) {
  const map = {
    running: { label: "Researching", tone: "info", dot: "running" },
    queued: { label: "Queued", tone: "info", dot: "running" },
    complete: { label: "Complete", tone: "success", dot: "ok" },
    partial: { label: "Partial", tone: "warning", dot: "degraded" },
    failed: { label: "Failed", tone: "danger", dot: "error" },
    unavailable: { label: "Unavailable", tone: "neutral", dot: "unavailable" },
    idle: null,
  };

  const config = map[status] || null;
  if (!config) {
    dom.threadState.hidden = true;
    return;
  }

  dom.threadState.hidden = false;
  dom.threadState.dataset.tone = config.tone;
  dom.threadState.querySelector(".pill__label").textContent = config.label;
  dom.threadState.querySelector(".status-dot").dataset.state = config.dot;
}

async function deleteThread(id) {
  const thread = store.find(id);
  if (!thread) return;

  const confirmed = await confirmAction({
    title: "Delete conversation",
    text: `"${truncate(thread.title, 70)}" will be removed from this browser. This cannot be undone.`,
    confirmLabel: "Delete",
  });

  if (!confirmed) return;

  store.delete(id);
  const next = store.active();
  if (next?.entries.length) {
    activateThread(next.id);
  } else {
    showEmptyState();
  }
  toast("Conversation deleted.", { tone: "info" });
}

/* ==========================================================================
   Run actions
   ========================================================================== */

/** @param {import("./model.js").RunViewModel} run */
function openRunDetails(run) {
  if (!refs.detailsDialog) return;
  renderRunDetails(run, {
    subtitle: refs.detailsSubtitle,
    stagesHost: refs.detailsStages,
    metricsHost: refs.detailsMetrics,
    callsSection: refs.detailsCallsSection,
    calls: refs.detailsCalls,
    evidenceSection: refs.detailsEvidenceSection,
    evidenceHost: refs.detailsEvidence,
  });
  openDialog(refs.detailsDialog);
}

/** @param {import("./model.js").RunViewModel} run */
async function copyRun(run) {
  if (!run.report && !run.citations.length) {
    toast("Nothing to copy — this run returned no report.", { tone: "warning" });
    return;
  }
  await copyWithFeedback(buildMarkdown(run), "Report copied as Markdown");
}

/** @param {import("./model.js").RunViewModel} run */
function exportRun(run) {
  if (!run.report && !run.citations.length) {
    toast("Nothing to export — this run returned no report.", { tone: "warning" });
    return;
  }
  const name = `${slug(run.company || run.query || "sales-research")}-brief.md`;
  downloadFile(name, buildMarkdown(run, true));
  toast(`Downloaded ${name}`, { tone: "success" });
}

/** @param {import("./model.js").RunViewModel} run */
function retryRun(run) {
  if (activeRun) {
    toast("A research run is already in progress.", { tone: "info" });
    return;
  }
  dom.input.value = run.query || "";
  syncComposer();
  dom.input.focus();
  toast("Question restored to the composer.", { tone: "info" });
}

/**
 * @param {string} text
 * @param {string} [message]
 * @param {HTMLElement} [button]
 */
async function copyWithFeedback(text, message = "Copied to clipboard", button = null) {
  const ok = await copyText(text);
  if (ok) {
    toast(message, { tone: "success", duration: 2200 });
    if (button) flashCopied(button);
  } else {
    toast("Could not access the clipboard. Select the text and copy manually.", {
      tone: "danger",
    });
  }
}

function previewSample() {
  const thread = store.create();
  const run = cloneSampleRun();

  store.addEntry(thread.id, {
    kind: "run",
    text: run.query,
    focus: "",
    run,
  });

  thread.title = "Sample report layout";
  thread.updatedAt = Date.now();

  activateThread(thread.id);
  toast("Sample layout loaded. It is not a real research run.", {
    tone: "warning",
    duration: 5000,
  });
}

/* ==========================================================================
   Global actions
   ========================================================================== */

function bindGlobalActions() {
  document.addEventListener("click", (event) => {
    const trigger = event.target instanceof Element ? event.target.closest("[data-action]") : null;
    if (!trigger) return;

    const action = trigger.getAttribute("data-action");

    switch (action) {
      case "new-thread":
        newThread();
        break;
      case "toggle-sidebar":
        toggleSidebar();
        break;
      case "close-sidebar":
        closeMobileSidebar();
        break;
      case "clear-filter":
        dom.historyFilter.value = "";
        renderHistoryPanel();
        dom.historyFilter.focus();
        break;
      case "open-settings":
        openSettings(trigger.getAttribute("data-section") || "appearance");
        break;
      case "open-shortcuts":
        if (refs.shortcutsDialog) openDialog(refs.shortcutsDialog);
        break;
      case "toggle-theme-menu":
        toggleThemeMenu(trigger);
        break;
      case "refresh-health":
        checkHealth();
        break;
      case "clear-history":
        clearAllHistory();
        break;
      case "reset-settings":
        resetSettings();
        break;
      case "preview-sample":
        previewSample();
        break;
      default:
        break;
    }
  });

  // Theme choices appear in both the topbar menu and the settings dialog.
  for (const button of qsa("[data-theme-choice]")) {
    button.addEventListener("click", () => {
      setTheme(/** @type {string} */ (button.dataset.themeChoice));
    });
  }

  for (const button of qsa("[data-density-choice]")) {
    button.addEventListener("click", () => setDensity(button.dataset.densityChoice));
  }

  for (const button of qsa("[data-motion-choice]")) {
    button.addEventListener("click", () => setMotion(button.dataset.motionChoice));
  }

  for (const tab of qsa("[data-settings-tab]")) {
    tab.addEventListener("click", () => showSettingsTab(tab.dataset.settingsTab));
  }

  dom.historyFilter.addEventListener(
    "input",
    debounce(() => renderHistoryPanel(), 120)
  );

  // Click-away for the theme popover.
  document.addEventListener("click", (event) => {
    const popover = document.querySelector('[data-popover="theme"]');
    if (!popover || !popover.classList.contains("is-open")) return;
    if (event.target instanceof Node && popover.contains(event.target)) return;
    closeThemeMenu();
  });
}

function newThread() {
  const current = store.active();
  // Reuse an untouched empty thread instead of piling up blanks.
  if (current && current.entries.length === 0) {
    store.setActive(current.id);
    showEmptyState();
    renderHistoryPanel();
  } else {
    const thread = store.create();
    store.activeId = thread.id;
    showEmptyState();
    renderHistoryPanel();
  }
  dom.input.value = "";
  syncComposer();
  dom.input.focus();
  closeMobileSidebar();
}

/* ==========================================================================
   Sidebar
   ========================================================================== */

function bindSidebar() {
  const stored = window.localStorage.getItem("salesintel.sidebar.v1");
  if (window.matchMedia("(max-width: 980px)").matches) {
    setSidebarState("closed", { persist: false });
  } else if (stored === "closed") {
    setSidebarState("closed", { persist: false });
  }

  dom.sidebarScrim?.addEventListener("click", () => closeMobileSidebar());
}

/** @param {"open"|"closed"} state @param {{persist?: boolean}} [options] */
function setSidebarState(state, options = {}) {
  dom.app.dataset.sidebar = state;
  const isMobile = window.matchMedia("(max-width: 980px)").matches;

  qsa('[data-action="toggle-sidebar"]').forEach((button) => {
    button.setAttribute("aria-expanded", String(state === "open"));
    button.setAttribute(
      "aria-label",
      state === "open" ? "Collapse sidebar" : "Show sidebar"
    );
  });

  if (dom.sidebarScrim) dom.sidebarScrim.hidden = !(isMobile && state === "open");

  if (options.persist !== false) {
    try {
      window.localStorage.setItem("salesintel.sidebar.v1", state);
    } catch {
      /* storage may be unavailable */
    }
  }
}

function toggleSidebar() {
  setSidebarState(dom.app.dataset.sidebar === "open" ? "closed" : "open");
}

function closeMobileSidebar() {
  if (window.matchMedia("(max-width: 980px)").matches && dom.app.dataset.sidebar === "open") {
    setSidebarState("closed", { persist: false });
  }
}

/* ==========================================================================
   Theme menu
   ========================================================================== */

function toggleThemeMenu(trigger) {
  const popover = trigger.closest('[data-popover="theme"]');
  const menu = popover?.querySelector(".menu");
  if (!menu) return;

  const open = popover.classList.contains("is-open");
  if (open) {
    closeThemeMenu();
  } else {
    popover.classList.add("is-open");
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    menu.querySelector('[aria-checked="true"]')?.focus();
  }
}

function closeThemeMenu() {
  for (const popover of qsa('[data-popover="theme"]')) {
    popover.classList.remove("is-open");
    const menu = popover.querySelector(".menu");
    if (menu) menu.hidden = true;
    popover.querySelector("[aria-expanded]")?.setAttribute("aria-expanded", "false");
  }
}

/* ==========================================================================
   Settings
   ========================================================================== */

function applySettings() {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = settings.theme === "system" ? (prefersDark ? "dark" : "light") : settings.theme;

  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.setAttribute("data-theme-preference", settings.theme);
  document.documentElement.setAttribute("data-density", settings.density);
  document.documentElement.setAttribute(
    "data-motion",
    settings.motion || (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduced" : "full")
  );

  dom.focus.value = settings.defaultFocus;
  const timerToggle = byId("setting-show-timer");
  if (timerToggle instanceof HTMLInputElement) timerToggle.checked = settings.showTimer;
  const focusSetting = byId("setting-default-focus");
  if (focusSetting instanceof HTMLSelectElement) focusSetting.value = settings.defaultFocus;

  syncThemeChoices();
  syncDensityChoices();
  syncMotionChoices();
  updateThemeColor(resolved);
}

/** @param {string} theme */
function setTheme(theme) {
  settings.theme = ["light", "dark", "system"].includes(theme) ? theme : "system";
  saveSettings(settings);
  applySettings();
  closeThemeMenu();
}

/** @param {"comfortable"|"compact"} density */
function setDensity(density) {
  settings.density = density === "compact" ? "compact" : "comfortable";
  saveSettings(settings);
  applySettings();
}

/** @param {"full"|"reduced"} motion */
function setMotion(motion) {
  settings.motion = motion === "reduced" ? "reduced" : "full";
  saveSettings(settings);
  applySettings();
}

function syncThemeChoices() {
  for (const button of qsa("[data-theme-choice]")) {
    const active = button.dataset.themeChoice === settings.theme;
    button.setAttribute("aria-checked", String(active));
    if (button.getAttribute("role") === "radio") {
      button.tabIndex = active ? 0 : -1;
    }
  }
}

function syncDensityChoices() {
  for (const button of qsa("[data-density-choice]")) {
    button.setAttribute("aria-checked", String(button.dataset.densityChoice === settings.density));
  }
}

function syncMotionChoices() {
  const effective =
    settings.motion ||
    (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduced" : "full");
  for (const button of qsa("[data-motion-choice]")) {
    button.setAttribute("aria-checked", String(button.dataset.motionChoice === effective));
  }
}

/** @param {string} resolved */
function updateThemeColor(resolved) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolved === "dark" ? "#0a0c0e" : "#f6f7f8");
}

/** @param {string} section */
function openSettings(section) {
  if (!refs.settingsDialog) return;
  showSettingsTab(section || "appearance");
  refreshSystemPanel();
  openDialog(refs.settingsDialog);
}

/** @param {string} section */
function showSettingsTab(section) {
  for (const tab of qsa("[data-settings-tab]")) {
    tab.setAttribute("aria-current", String(tab.dataset.settingsTab === section));
  }
  for (const panel of qsa(".settings-panel")) {
    panel.hidden = panel.id !== `settings-${section}`;
  }
}

async function clearAllHistory() {
  const confirmed = await confirmAction({
    title: "Delete all conversations",
    text: "Every conversation stored in this browser will be removed. Settings are kept.",
    confirmLabel: "Delete everything",
  });

  if (!confirmed) return;

  store.clear();
  clearThreads();
  showEmptyState();
  renderHistoryPanel();
  refreshStorageFacts();
  toast("All conversations deleted.", { tone: "info" });
}

async function resetSettings() {
  const confirmed = await confirmAction({
    title: "Reset preferences",
    text: "Theme, density, motion and research defaults return to their original values.",
    confirmLabel: "Reset",
    danger: false,
  });

  if (!confirmed) return;

  Object.assign(settings, DEFAULT_SETTINGS);
  saveSettings(settings);
  clearSettings();
  applySettings();
  refreshStorageFacts();
  toast("Preferences reset.", { tone: "success" });
}

function bindDialogs() {
  for (const button of qsa("[data-close-dialog]")) {
    button.addEventListener("click", () => {
      const dialog = button.closest("dialog");
      if (dialog) closeDialog(/** @type {HTMLDialogElement} */ (dialog));
    });
  }

  // Clicking the backdrop closes the dialog (native dialogs do not do this).
  for (const dialog of qsa("dialog.dialog")) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeDialog(/** @type {HTMLDialogElement} */ (dialog));
    });
  }

  const focusSetting = byId("setting-default-focus");
  focusSetting?.addEventListener("change", () => {
    settings.defaultFocus = /** @type {HTMLSelectElement} */ (focusSetting).value;
    dom.focus.value = settings.defaultFocus;
    saveSettings(settings);
  });

  const timerToggle = byId("setting-show-timer");
  timerToggle?.addEventListener("change", () => {
    settings.showTimer = /** @type {HTMLInputElement} */ (timerToggle).checked;
    saveSettings(settings);
  });

  // Keep the confirmation dialog accurate even when closed via Escape.
  const confirmDialog = getDialog("confirm-dialog");
  confirmDialog?.addEventListener("close", () => {
    const accept = byId("confirm-accept");
    if (accept) accept.className = "btn btn--danger";
  });
}

/* ==========================================================================
   Keyboard
   ========================================================================== */

function bindKeyboard() {
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const typing =
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable);

    const modifier = event.ctrlKey || event.metaKey;
    const openDialogEl = document.querySelector("dialog[open]");

    if (event.key === "Escape") {
      if (openDialogEl) return; // native dialog handles it
      closeThemeMenu();
      return;
    }

    if (openDialogEl) return;

    if (modifier && event.key.toLowerCase() === "k") {
      event.preventDefault();
      newThread();
      return;
    }

    if (modifier && event.key.toLowerCase() === "b") {
      event.preventDefault();
      toggleSidebar();
      return;
    }

    if (modifier && event.key === ",") {
      event.preventDefault();
      openSettings("appearance");
      return;
    }

    if (!typing && event.key === "/") {
      event.preventDefault();
      dom.input.focus();
      return;
    }

    if (!typing && event.key === "?") {
      event.preventDefault();
      if (refs.shortcutsDialog) openDialog(refs.shortcutsDialog);
    }
  });
}

/* ==========================================================================
   Media queries
   ========================================================================== */

function bindMediaQueries() {
  const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
  const onSchemeChange = () => {
    if (settings.theme === "system") applySettings();
  };
  colorScheme.addEventListener?.("change", onSchemeChange);

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  reducedMotion.addEventListener?.("change", () => {
    if (!settings.motion) applySettings();
  });

  const mobile = window.matchMedia("(max-width: 980px)");
  mobile.addEventListener?.("change", (event) => {
    if (event.matches) {
      setSidebarState("closed", { persist: false });
    } else {
      const stored = window.localStorage.getItem("salesintel.sidebar.v1");
      setSidebarState(stored === "closed" ? "closed" : "open", { persist: false });
    }
  });
}

/* ==========================================================================
   Start
   ========================================================================== */

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
