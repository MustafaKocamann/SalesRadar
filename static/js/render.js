/**
 * Renderer — pure DOM construction for every UI surface.
 *
 * Rules enforced here:
 *  - untrusted text always goes through `textContent`/text nodes
 *  - links pass through `safeUrl`
 *  - nothing is shown unless the view model actually contains it
 */

import { AGENT_BY_ID, SUGGESTIONS, FOCUS_LABELS, STATE_LABELS } from "./config.js";
import {
  el,
  fromTemplate,
  hostOf,
  formatTime,
  formatRelative,
  formatDuration,
  truncate,
  initials,
  dayBucket,
  replace,
  plural,
} from "./util.js";
import { renderMarkdown } from "./markdown.js";
import { STAGE_STATE_LABEL } from "./model.js";

const STAGE_ICONS = {
  waiting: "i-clock",
  queued: "i-clock",
  running: "i-refresh",
  complete: "i-check",
  failed: "i-alert-circle",
  skipped: "i-skip",
  unavailable: "i-stop",
};

const RUN_STATUS = {
  queued: { label: "Queued", tone: "info" },
  running: { label: "Researching", tone: "info" },
  complete: { label: "Complete", tone: "success" },
  partial: { label: "Partial", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
  unavailable: { label: "Unavailable", tone: "neutral" },
};

/* ==========================================================================
   Suggestions
   ========================================================================== */

/**
 * @param {HTMLElement} container
 * @param {(query: string) => void} onPick
 * @param {readonly {title: string, query: string, icon: string}[]} [items]
 */
export function renderSuggestions(container, onPick, items = SUGGESTIONS) {
  replace(
    container,
    items.map((item) => {
      const node = fromTemplate("tpl-suggestion");
      const icon = node.querySelector(".suggestion__icon use");
      icon?.setAttribute("href", `#${item.icon}`);
      node.querySelector(".suggestion__title").textContent = item.title;
      node.querySelector(".suggestion__query").textContent = item.query;
      node.setAttribute("aria-label", `${item.title}: ${item.query}`);
      node.addEventListener("click", () => onPick(item.query));
      return node;
    })
  );
}

/* ==========================================================================
   History
   ========================================================================== */

/**
 * @param {HTMLElement} list
 * @param {import("./store.js").StoredThread[]} threads
 * @param {string} activeId
 * @param {{onOpen: (id: string) => void, onDelete: (id: string) => void}} handlers
 * @param {string} [filter]
 */
export function renderHistory(list, threads, activeId, handlers, filter = "") {
  const needle = filter.trim().toLowerCase();

  const visible = threads
    .filter((thread) => {
      if (!needle) return true;
      const haystack = [
        thread.title,
        ...thread.entries.map((entry) => entry.text || ""),
        ...thread.entries.map((entry) => entry.run?.company || ""),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);

  /** @type {DocumentFragment} */
  const fragment = document.createDocumentFragment();
  let currentBucket = "";

  for (const thread of visible) {
    const bucket = dayBucket(thread.updatedAt);
    if (bucket !== currentBucket) {
      currentBucket = bucket;
      const group = fromTemplate("tpl-history-group");
      group.querySelector(".eyebrow").textContent = bucket;
      fragment.append(group);
    }

    const item = fromTemplate("tpl-history-item");
    const open = item.querySelector("[data-thread-open]");
    const remove = item.querySelector("[data-thread-delete]");
    const lastRun = [...thread.entries].reverse().find((entry) => entry.kind === "run")?.run;

    item.dataset.id = thread.id;
    item.dataset.active = String(thread.id === activeId);
    open.querySelector(".history__title").textContent = thread.title;
    open.querySelector(".history__query").textContent = lastRun?.company
      ? `${lastRun.company} · ${formatRelative(thread.updatedAt)}`
      : formatRelative(thread.updatedAt);
    open.setAttribute("aria-current", thread.id === activeId ? "true" : "false");
    open.addEventListener("click", () => handlers.onOpen(thread.id));

    remove.setAttribute("aria-label", `Delete ${thread.title}`);
    remove.title = "Delete conversation";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      handlers.onDelete(thread.id);
    });

    fragment.append(item);
  }

  replace(list, [fragment]);
  return visible.length;
}

/* ==========================================================================
   Messages
   ========================================================================== */

/**
 * @param {import("./store.js").StoredEntry} entry
 * @param {{onCopy: (text: string) => void}} handlers
 */
export function renderUserMessage(entry, handlers) {
  const node = fromTemplate("tpl-user-message");
  node.dataset.entryId = entry.id;
  node.querySelector(".msg__text").textContent = entry.text;

  const focus = node.querySelector(".msg__focus");
  if (entry.focus && FOCUS_LABELS[entry.focus]) {
    focus.hidden = false;
    focus.textContent = FOCUS_LABELS[entry.focus];
  }

  const time = node.querySelector(".msg__time");
  time.textContent = formatTime(entry.createdAt);
  time.setAttribute("datetime", new Date(entry.createdAt).toISOString());

  node.querySelector("[data-action='copy-user-message']").addEventListener("click", () => {
    handlers.onCopy(entry.text);
  });

  return node;
}

/* ==========================================================================
   Run card
   ========================================================================== */

/**
 * Create a run card element.
 * @param {import("./model.js").RunViewModel} run
 * @param {{onDetails: Function, onCopy: Function, onExport: Function, onRetry: Function}} handlers
 */
export function createRunCard(run, handlers) {
  const item = fromTemplate("tpl-run");
  const card = item.querySelector(".run");

  card.dataset.runId = run.id;
  item.dataset.entryId = run.entryId || run.id;

  item
    .querySelectorAll("[data-run-details]")
    .forEach((button) => button.addEventListener("click", () => handlers.onDetails(run)));
  item.querySelector("[data-run-copy]")?.addEventListener("click", () => handlers.onCopy(run));
  item.querySelector("[data-run-export]")?.addEventListener("click", () => handlers.onExport(run));
  item.querySelector("[data-run-retry]")?.addEventListener("click", () => handlers.onRetry(run));

  updateRunCard(item, run);
  return item;
}

/**
 * Patch an existing run card in place.
 * @param {HTMLElement} item
 * @param {import("./model.js").RunViewModel} run
 */
export function updateRunCard(item, run) {
  const card = item.querySelector(".run");
  const status = RUN_STATUS[run.status] || RUN_STATUS.queued;

  card.dataset.runStatus = run.status;
  card.setAttribute("aria-busy", String(run.status === "queued" || run.status === "running"));

  // Title / subtitle
  const title = item.querySelector(".run__title");
  title.textContent = run.company || titleForStatus(run.status);
  item.querySelector("[data-run-sample]").hidden = !run.isSample;

  const subtitle = item.querySelector(".run__subtitle");
  const subtitleText =
    run.company && run.subtitle
      ? run.subtitle
      : run.company
        ? ""
        : run.query
          ? truncate(run.query, 160)
          : "";
  subtitle.textContent = subtitleText;
  subtitle.hidden = !subtitleText;

  // Status pill
  const pill = item.querySelector("[data-run-pill]");
  pill.dataset.tone = status.tone;
  pill.querySelector(".pill__label").textContent = status.label;
  pill.querySelector(".status-dot").dataset.state =
    run.status === "complete" ? "ok" : run.status === "failed" ? "error" : run.status === "running" ? "running" : run.status === "partial" ? "degraded" : "unavailable";

  // Notice — the run's own notice, plus any warnings the pipeline reported.
  const noticeHost = item.querySelector("[data-run-notice]");
  const notices = [];
  if (run.notice) notices.push(buildNotice(run.notice));
  if (run.warnings.length) {
    notices.push(
      buildNotice({
        tone: "warning",
        title: `Completed with ${run.warnings.length} warning${run.warnings.length === 1 ? "" : "s"}`,
        text: "",
        list: run.warnings,
      })
    );
  }
  if (notices.length) {
    noticeHost.hidden = false;
    replace(noticeHost, notices);
  } else {
    noticeHost.hidden = true;
    replace(noticeHost, []);
  }

  // Stages
  const stagesHost = item.querySelector("[data-run-stages]");
  const stagesVisible = run.stages.length > 0;
  item.querySelector(".run__progress").hidden = !stagesVisible;
  if (stagesVisible) {
    replace(stagesHost, run.stages.map((stage) => buildStage(stage)));
  }

  // Report
  const reportHost = item.querySelector("[data-run-report]");
  if (run.report) {
    reportHost.hidden = false;
    replace(reportHost, [renderMarkdown(run.report, { citations: run.citations })]);
  } else {
    reportHost.hidden = true;
    replace(reportHost, []);
  }

  // Sources
  const sourcesBlock = item.querySelector("[data-run-sources-block]");
  if (run.citations.length) {
    sourcesBlock.hidden = false;
    item.querySelector("[data-run-sources-count]").textContent = plural(
      run.citations.length,
      "source"
    );
    replace(
      item.querySelector("[data-run-sources]"),
      run.citations.map((citation, index) => buildSource(citation, index))
    );
  } else {
    sourcesBlock.hidden = true;
    replace(item.querySelector("[data-run-sources]"), []);
  }

  // Structured blocks
  const blocksHost = item.querySelector("[data-run-blocks]");
  const blocks = buildBlocks(run);
  if (blocks.length) {
    blocksHost.hidden = false;
    replace(blocksHost, blocks);
  } else {
    blocksHost.hidden = true;
    replace(blocksHost, []);
  }

  // Footer metrics
  const foot = item.querySelector("[data-run-foot]");
  const metricsHost = item.querySelector("[data-run-metrics]");
  if (run.metrics.length) {
    foot.hidden = false;
    replace(
      metricsHost,
      run.metrics.map((metric) => {
        const node = fromTemplate("tpl-metric");
        node.querySelector(".metric__label").textContent = metric.label;
        node.querySelector(".metric__value").textContent = metric.value;
        return node;
      })
    );
  } else {
    foot.hidden = true;
    replace(metricsHost, []);
  }

  // Retry only makes sense for terminal failures.
  const retry = item.querySelector("[data-run-retry]");
  if (retry) retry.hidden = !(run.status === "failed" || run.status === "unavailable");

  // Copy/export disabled until there is content.
  const hasContent = Boolean(run.report || run.citations.length);
  item.querySelector("[data-run-copy]").disabled = !hasContent;
  item.querySelector("[data-run-export]").disabled = !hasContent;
}

/** @param {string} status */
function titleForStatus(status) {
  if (status === "queued" || status === "running") return "Researching";
  if (status === "failed") return "Research could not run";
  if (status === "unavailable") return "Research unavailable";
  return "Research run";
}

/**
 * @param {import("./model.js").StageViewModel} stage
 */
export function buildStage(stage) {
  const node = fromTemplate("tpl-stage");
  const agent = AGENT_BY_ID[stage.agent];

  node.dataset.state = stage.state;
  node.dataset.agent = stage.agent;

  const use = node.querySelector(".stage__icon use");
  use?.setAttribute("href", `#${STAGE_ICONS[stage.state] || "i-clock"}`);

  node.querySelector(".stage__name").textContent = stage.name || agent?.name || "Stage";

  const meta = node.querySelector(".stage__meta");
  const metaText =
    stage.state === "complete" && stage.durationMs !== null
      ? formatDuration(stage.durationMs)
      : stage.state === "running"
        ? "Running…"
        : stage.state === "waiting"
          ? ""
          : STAGE_STATE_LABEL[stage.state] || "";
  meta.textContent = metaText;

  const desc = node.querySelector(".stage__desc");
  const descText = stage.detail || (stage.state === "waiting" ? "" : "");
  desc.textContent = descText;
  desc.hidden = !descText;

  const stateLabel = STAGE_STATE_LABEL[stage.state] || stage.state;
  node.setAttribute("aria-label", `${stage.name}: ${stateLabel}${metaText ? ` (${metaText})` : ""}`);

  return node;
}

/**
 * @param {import("./model.js").CitationViewModel} citation
 * @param {number} index
 */
function buildSource(citation, index) {
  const node = fromTemplate("tpl-source");
  node.dataset.citeId = citation.id;

  const link = node.querySelector(".source__link");
  link.href = citation.url;
  link.setAttribute("aria-label", `${citation.title} — opens in a new tab`);

  node.querySelector(".source__index").textContent = citation.id || String(index + 1);
  node.querySelector(".source__title").textContent = citation.title || citation.host || citation.url;
  node.querySelector(".source__host").textContent = citation.host || hostOf(citation.url);

  const snippet = node.querySelector(".source__snippet");
  snippet.textContent = citation.snippet || "";
  snippet.hidden = !citation.snippet;

  return node;
}

/**
 * @param {import("./model.js").RunViewModel} run
 * @returns {HTMLElement[]}
 */
function buildBlocks(run) {
  const blocks = [];

  if (run.facts.length) {
    const strip = el("div", { class: "factstrip" });
    for (const fact of run.facts) {
      strip.append(
        el("div", { class: "fact" }, [
          el("span", { class: "fact__label", text: fact.label }),
          el("span", { class: "fact__value", text: fact.value }),
        ])
      );
    }
    blocks.push(strip);
  }

  if (run.people.length) {
    const block = el("section", { class: "block" }, [
      el("div", { class: "block__head" }, [
        el("h4", { class: "block__title" }, [
          icon("i-users"),
          el("span", { text: "Decision-makers" }),
        ]),
        el("span", { class: "eyebrow", text: plural(run.people.length, "contact") }),
      ]),
    ]);

    const grid = el("div", { class: "people" });
    for (const person of run.people) {
      const avatar = el("span", { class: "person__avatar", text: initials(person.name) });
      const top = el("div", { class: "person__top" }, [
        avatar,
        el("span", { class: "person__name", text: person.name }),
      ]);

      const card = el("article", { class: "person" }, [top]);
      if (person.title) card.append(el("p", { class: "person__title", text: person.title }));
      if (person.why) card.append(el("p", { class: "person__why", text: person.why }));
      if (person.linkedin) {
        card.append(
          el("a", {
            class: "person__link",
            href: person.linkedin,
            target: "_blank",
            rel: "noopener noreferrer",
            text: "Profile",
          })
        );
      }
      grid.append(card);
    }
    block.append(grid);
    blocks.push(block);
  }

  if (run.opportunities.length) {
    const block = el("section", { class: "block" }, [
      el("div", { class: "block__head" }, [
        el("h4", { class: "block__title" }, [
          icon("i-target"),
          el("span", { text: "Sales opportunities" }),
        ]),
      ]),
    ]);

    const list = el("div", { class: "opportunities" });
    run.opportunities.forEach((opportunity, index) => {
      const body = el("div", { class: "opportunity__body" }, [
        el("p", { class: "opportunity__title", text: opportunity.title || "Opportunity" }),
      ]);
      if (opportunity.detail) {
        body.append(el("p", { class: "opportunity__detail", text: opportunity.detail }));
      }
      list.append(
        el("article", { class: "opportunity" }, [
          el("span", { class: "opportunity__index", text: String(index + 1) }),
          body,
        ])
      );
    });
    block.append(list);
    blocks.push(block);
  }

  return blocks;
}

/**
 * @param {import("./model.js").NoticeViewModel} notice
 */
export function buildNotice(notice) {
  const root = fromTemplate("tpl-notice");
  root.dataset.tone = notice.tone || "info";

  const use = root.querySelector(".notice__icon use");
  use?.setAttribute(
    "href",
    notice.tone === "danger"
      ? "#i-alert-triangle"
      : notice.tone === "warning"
        ? "#i-alert-triangle"
        : notice.tone === "success"
          ? "#i-check"
          : "#i-info"
  );

  root.querySelector(".notice__title").textContent = notice.title || "";
  root.querySelector(".notice__text").textContent = notice.text || "";

  const list = root.querySelector(".notice__list");
  if (Array.isArray(notice.list) && notice.list.length) {
    replace(
      list,
      notice.list.map((item) => el("li", { text: item }))
    );
  } else {
    replace(list, []);
  }

  return root;
}

/** @param {string} id */
function icon(id, className = "icon icon--sm") {
  return el("svg", { class: className, "aria-hidden": "true" }, [el("use", { href: `#${id}` })]);
}

/* ==========================================================================
   Thread
   ========================================================================== */

/**
 * Render a stored thread into the thread list.
 * @param {HTMLElement} listHost
 * @param {import("./store.js").StoredThread} thread
 * @param {{onDetails: Function, onCopyRun: Function, onExportRun: Function, onRetryRun: Function, onCopyText: (text: string) => void}} handlers
 */
export function renderThread(listHost, thread, handlers) {
  const nodes = thread.entries.map((entry) => {
    if (entry.kind === "user") {
      return renderUserMessage(entry, { onCopy: handlers.onCopyText });
    }
    const run = entry.run;
    if (!run) return document.createComment("empty run");
    const card = createRunCard(run, {
      onDetails: handlers.onDetails,
      onCopy: handlers.onCopyRun,
      onExport: handlers.onExportRun,
      onRetry: handlers.onRetryRun,
    });
    card.dataset.entryId = entry.id;
    return card;
  });

  replace(listHost, nodes);
}

/* ==========================================================================
   Run details dialog
   ========================================================================== */

/**
 * @param {import("./model.js").RunViewModel} run
 * @param {{detailsDialog: HTMLDialogElement|null, openDialog: Function, stagesHost: HTMLElement, metricsHost: HTMLElement, callsSection: HTMLElement, calls: HTMLElement, evidenceSection: HTMLElement, evidenceHost: HTMLElement, subtitle: HTMLElement}} refs
 */
export function renderRunDetails(run, refs) {
  refs.subtitle.textContent = run.company
    ? `${run.company} · run ${run.id}`
    : `Run ${run.id}`;

  replace(
    refs.stagesHost,
    run.stages.map((stage) =>
      el("li", { class: "details-stage" }, [
        (() => {
          const dot = el("span", { class: "status-dot", "aria-hidden": "true" });
          dot.dataset.state =
            stage.state === "complete"
              ? "ok"
              : stage.state === "failed"
                ? "error"
                : stage.state === "running"
                  ? "running"
                  : stage.state === "skipped"
                    ? "degraded"
                    : "unavailable";
          return dot;
        })(),
        el("span", { class: "details-stage__name", text: stage.name }),
        el("span", {
          class: "details-stage__meta",
          text:
            stage.durationMs !== null
              ? formatDuration(stage.durationMs)
              : STAGE_STATE_LABEL[stage.state] || "",
        }),
      ])
    )
  );

  replace(
    refs.metricsHost,
    (run.metrics.length ? run.metrics : [{ label: "Reported metrics", value: "None returned" }]).map(
      (metric) => {
        const node = fromTemplate("tpl-metric");
        node.querySelector(".metric__label").textContent = metric.label;
        node.querySelector(".metric__value").textContent = metric.value;
        return node;
      }
    )
  );

  // Tool calls
  if (run.calls.length) {
    refs.callsSection.hidden = false;
    refs.calls.textContent = safeStringify(run.calls);
  } else {
    refs.callsSection.hidden = true;
    refs.calls.textContent = "";
  }

  // Evidence
  if (run.evidence.length) {
    refs.evidenceSection.hidden = false;
    replace(
      refs.evidenceHost,
      run.evidence.map((row, index) => {
        const entry = row && typeof row === "object" ? row : { value: row };
        const id = String(entry.id ?? index + 1);
        const source = String(entry.source ?? entry.title ?? "Evidence");
        const details = el("details", { class: "evidence-row" }, [
          el("summary", { text: `[${id}] ${source}` }),
          el("pre", { text: safeStringify(entry.data ?? entry) }),
        ]);
        return details;
      })
    );
  } else {
    refs.evidenceSection.hidden = true;
    replace(refs.evidenceHost, []);
  }
}

/**
 * JSON stringify that cannot throw on cycles.
 * @param {unknown} value
 */
export function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[unserialisable value]";
  }
}

/* ==========================================================================
   Markdown export
   ========================================================================== */

/**
 * Build a Markdown document for download/copy from a run view model.
 * @param {import("./model.js").RunViewModel} run
 * @param {boolean} [includeEvidence]
 */
export function buildMarkdown(run, includeEvidence = false) {
  const lines = [];

  lines.push(`# ${run.company || "Sales research brief"}`);
  if (run.subtitle) lines.push("", run.subtitle);
  if (run.query) lines.push("", `> ${run.query}`);

  const meta = [];
  if (run.completedAt) meta.push(`Generated ${new Date(run.completedAt).toISOString()}`);
  meta.push(`Status: ${run.status}`);
  if (run.durationMs !== null) meta.push(`Duration: ${formatDuration(run.durationMs)}`);
  if (run.isSample) meta.push("SAMPLE DATA — static layout reference, not a real research run");
  lines.push("", meta.map((line) => `- ${line}`).join("\n"));

  if (run.report) lines.push("", "---", "", run.report);

  if (run.facts.length) {
    lines.push("", "## Company profile", "");
    for (const fact of run.facts) lines.push(`- **${fact.label}:** ${fact.value}`);
  }

  if (run.people.length) {
    lines.push("", "## Decision-makers", "");
    for (const person of run.people) {
      lines.push(`- **${person.name}**${person.title ? ` — ${person.title}` : ""}`);
      if (person.why) lines.push(`  ${person.why}`);
      if (person.linkedin) lines.push(`  ${person.linkedin}`);
    }
  }

  if (run.opportunities.length) {
    lines.push("", "## Sales opportunities", "");
    run.opportunities.forEach((opportunity, index) => {
      lines.push(`${index + 1}. **${opportunity.title || "Opportunity"}**`);
      if (opportunity.detail) lines.push(`   ${opportunity.detail}`);
    });
  }

  if (run.citations.length) {
    lines.push("", "## Sources", "");
    for (const citation of run.citations) {
      lines.push(`${citation.id}. [${citation.title || citation.host}](${citation.url})`);
      if (citation.snippet) lines.push(`   > ${citation.snippet}`);
    }
  }

  if (run.notice) {
    lines.push("", "## Note", "", `**${run.notice.title}**`, "", run.notice.text);
    for (const item of run.notice.list || []) lines.push(`- ${item}`);
  }

  if (run.warnings.length) {
    lines.push("", "## Warnings", "");
    for (const warning of run.warnings) lines.push(`- ${warning}`);
  }

  if (includeEvidence && run.evidence.length) {
    lines.push("", "## Evidence", "");
    for (const row of run.evidence) {
      const entry = row && typeof row === "object" ? row : { value: row };
      lines.push(`### [${entry.id ?? "-"}] ${entry.source ?? "Evidence"}`, "", "```json");
      lines.push(safeStringify(entry.data ?? entry));
      lines.push("```", "");
    }
  }

  return `${lines.join("\n")}\n`;
}

/* ==========================================================================
   Health / capability surfaces
   ========================================================================== */

/**
 * @param {HTMLElement} root
 * @param {import("./api.js").normaliseHealth extends (p: any) => infer R ? R : never} health
 */
export function renderChecks(root, health) {
  for (const node of root.querySelectorAll(".check")) {
    const id = node.dataset.check;
    const check = health.checks.find((candidate) => candidate.id === id);
    const state = check ? check.state : "unknown";
    node.dataset.state = state;
    node.querySelector(".status-dot").dataset.state = state;
    node.title = check?.detail || (check ? STATE_LABELS[state] || state : "No data returned");
  }
}

/**
 * @param {HTMLElement} host
 * @param {{id: string, label: string, state: string, detail: string}[]} checks
 */
export function renderSystemChecks(host, checks) {
  replace(
    host,
    checks.map((check) =>
      el("li", { class: "system-check", dataset: { state: check.state } }, [
        (() => {
          const dot = el("span", { class: "status-dot", "aria-hidden": "true" });
          dot.dataset.state = check.state;
          return dot;
        })(),
        el("div", { class: "system-check__body" }, [
          el("span", { class: "system-check__label", text: check.label }),
          el("span", { class: "system-check__detail", text: check.detail || "" }),
        ]),
        el("span", {
          class: "system-check__state",
          text: STATE_LABELS[check.state] || check.state,
        }),
      ])
    )
  );
}

/**
 * Honest capability list: available capabilities are stated plainly, missing
 * ones explain exactly what the interface cannot do yet.
 * @param {HTMLElement} host
 * @param {Record<string, boolean>} capabilities
 * @param {Record<string, {label: string, available: string, unavailable: string}>} meta
 */
export function renderCapabilities(host, capabilities, meta) {
  replace(
    host,
    Object.entries(meta).map(([key, info]) => {
      const available = capabilities[key] === true;
      return el("li", { class: "capability", dataset: { available: String(available) } }, [
        icon(available ? "i-check" : "i-x", "icon capability__icon"),
        el("div", {}, [
          el("span", { class: "capability__label", text: info.label }),
          el("span", {
            class: "capability__note",
            text: available ? info.available : info.unavailable,
          }),
        ]),
      ]);
    })
  );
}

/**
 * @param {HTMLElement} host
 * @param {{label: string, value: string}[]} facts
 */
export function renderFacts(host, facts) {
  replace(
    host,
    facts.map((fact) =>
      el("div", {}, [
        el("dt", { class: "system-fact" }, [
          el("span", { class: "system-fact__label", text: fact.label }),
          el("dd", { class: "system-fact__value", text: fact.value }),
        ]),
      ])
    )
  );
}
