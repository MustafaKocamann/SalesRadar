/**
 * Minimal, safe Markdown renderer.
 *
 * Model output is untrusted, so this module never assigns HTML strings:
 * every node is created through the DOM and all text becomes text nodes.
 * Supported syntax: headings, paragraphs, emphasis, inline/fenced code,
 * links, lists (nested), blockquotes, tables, horizontal rules and numeric
 * citation markers (`[1]`, `[1,2]`, `[1-3]`) resolved against a source list.
 */

import { el, safeUrl } from "./util.js";

/**
 * @typedef {Object} CitationRef
 * @property {string|number} id
 * @property {string} [url]
 * @property {string} [title]
 */

/**
 * Render Markdown into a DocumentFragment.
 * @param {unknown} markdown
 * @param {{citations?: CitationRef[]}} [options]
 * @returns {DocumentFragment}
 */
export function renderMarkdown(markdown, options = {}) {
  const fragment = document.createDocumentFragment();
  const text = typeof markdown === "string" ? markdown.replace(/\r\n?/g, "\n") : "";
  if (!text.trim()) return fragment;

  const lines = text.split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    // Fenced code block
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)\s*$/);
    if (fence) {
      const marker = fence[1];
      const language = fence[2] || "";
      const body = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(marker)) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // closing fence

      const code = el("code", { text: body.join("\n") });
      if (language) code.dataset.language = language;
      fragment.append(el("pre", {}, [code]));
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 6);
      const node = el(`h${level}`);
      appendInline(node, heading[2].trim(), options);
      fragment.append(node);
      index += 1;
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      fragment.append(el("hr"));
      index += 1;
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      fragment.append(el("blockquote", {}, [renderMarkdown(quoteLines.join("\n"), options)]));
      continue;
    }

    // Table
    if (isTableStart(lines, index)) {
      const { node, nextIndex } = buildTable(lines, index, options);
      fragment.append(node);
      index = nextIndex;
      continue;
    }

    // Lists
    if (/^\s*(?:[-*+]|\d{1,9}[.)])\s+/.test(line)) {
      const { node, nextIndex } = buildList(lines, index, options);
      fragment.append(node);
      index = nextIndex;
      continue;
    }

    // Paragraph — consume until a blank line or the start of another block
    const paragraph = [];
    while (index < lines.length) {
      const current = lines[index];
      if (!current.trim()) break;
      if (/^\s*(?:[-*+]|\d{1,9}[.)])\s+/.test(current)) break;
      if (/^#{1,6}\s+/.test(current)) break;
      if (/^\s*(?:```|~~~)/.test(current)) break;
      if (/^\s*>\s?/.test(current)) break;
      if (isTableStart(lines, index)) break;
      paragraph.push(current.trim());
      index += 1;
    }

    if (paragraph.length) {
      const node = el("p");
      appendInline(node, paragraph.join(" "), options);
      fragment.append(node);
    }
  }

  return fragment;
}

/**
 * Render an inline-only string (used by table cells and list items).
 * @param {unknown} text
 * @param {{citations?: CitationRef[]}} [options]
 * @returns {DocumentFragment}
 */
export function renderInline(text, options = {}) {
  const fragment = document.createDocumentFragment();
  appendInline(fragment, String(text ?? ""), options);
  return fragment;
}

/* ==========================================================================
   Inline parsing
   ========================================================================== */

/**
 * Single-pass tokeniser. Groups are ordered by precedence: code and links win
 * over emphasis so `**\`**\`` never mis-parses.
 *
 * NOTE: kept as a source string, not a shared `RegExp` object. `appendInline`
 * recurses for nested emphasis, and a shared `lastIndex` would make the outer
 * loop restart — an infinite loop. Each invocation therefore builds its own
 * matcher. This regex must never be reused across calls.
 */
const INLINE_SOURCE = [
  "`([^`\\n]+)`", // 1 inline code
  "\\[([^\\]\\n]+)\\]\\(([^)\\s]+)(?:\\s+[\"'][^\"']*[\"'])?\\)", // 2 label, 3 href
  "<((?:https?:\\/\\/)[^>\\s]+)>", // 4 autolink
  "\\*\\*(?=\\S)([\\s\\S]*?\\S)\\*\\*", // 5 bold
  "__(?=\\S)([\\s\\S]*?\\S)__", // 6 bold
  "~~(?=\\S)([\\s\\S]*?\\S)~~", // 7 strike
  "\\*(?=\\S)([\\s\\S]*?\\S)\\*", // 8 italic
  "_(?=\\S)([\\s\\S]*?\\S)_", // 9 italic
  "\\[((?:\\d{1,3})(?:\\s*[,;\\-–]\\s*\\d{1,3})*)\\]", // 10 citation
].join("|");

/**
 * @param {Node} parent
 * @param {string} text
 * @param {{citations?: CitationRef[]}} options
 */
function appendInline(parent, text, options) {
  const source = typeof text === "string" ? text : String(text ?? "");
  if (!source) return;

  // A private matcher per call keeps recursion safe (see INLINE_SOURCE note).
  const pattern = new RegExp(INLINE_SOURCE, "g");
  let cursor = 0;
  let match;

  while ((match = pattern.exec(source)) !== null) {
    if (match[0] === "") {
      pattern.lastIndex += 1; // defensive: never allow a zero-width match to stall
      continue;
    }

    const [full, code, linkLabel, linkHref, autoHref, boldA, boldB, strike, italicA, italicB, citation] =
      match;

    if (match.index > cursor) {
      parent.append(document.createTextNode(source.slice(cursor, match.index)));
    }
    cursor = match.index + full.length;

    if (code !== undefined) {
      parent.append(el("code", { text: code }));
      continue;
    }

    if (linkLabel !== undefined) {
      const href = safeUrl(decodeEntities(linkHref));
      const label = decodeEntities(linkLabel);
      if (href) {
        const anchor = el("a", { href, target: "_blank", rel: "noopener noreferrer" });
        appendInline(anchor, label, options);
        parent.append(anchor);
      } else {
        parent.append(document.createTextNode(label));
      }
      continue;
    }

    if (autoHref !== undefined) {
      const href = safeUrl(autoHref);
      if (href) {
        parent.append(
          el("a", { href, target: "_blank", rel: "noopener noreferrer", text: autoHref })
        );
      } else {
        parent.append(document.createTextNode(autoHref));
      }
      continue;
    }

    if (boldA !== undefined || boldB !== undefined) {
      const strong = el("strong");
      appendInline(strong, decodeEntities(boldA ?? boldB), options);
      parent.append(strong);
      continue;
    }

    if (strike !== undefined) {
      const del = el("del");
      appendInline(del, decodeEntities(strike), options);
      parent.append(del);
      continue;
    }

    if (italicA !== undefined || italicB !== undefined) {
      const em = el("em");
      appendInline(em, decodeEntities(italicA ?? italicB), options);
      parent.append(em);
      continue;
    }

    if (citation !== undefined) {
      appendCitation(parent, citation, options);
      continue;
    }
  }

  if (cursor < source.length) {
    parent.append(document.createTextNode(source.slice(cursor)));
  }
}

/**
 * Numeric citation markers become accessible links to the source list.
 * Unresolvable markers are rendered as quiet plain text rather than a dead link.
 *
 * @param {Node} parent
 * @param {string} group
 * @param {{citations?: CitationRef[]}} options
 */
function appendCitation(parent, group, options) {
  const ids = parseCitationIds(group);
  const available = new Set(
    (options.citations || []).map((citation) => String(citation.id))
  );

  const resolved = available.size ? ids.filter((id) => available.has(id)) : [];
  if (!resolved.length) {
    parent.append(document.createTextNode(`[${group.trim()}]`));
    return;
  }

  for (const id of resolved) {
    const marker = el("a", {
      class: "citation",
      href: `#source-${id}`,
      dataset: { cite: id },
      "aria-label": `Jump to source ${id}`,
      text: id,
    });
    marker.addEventListener("click", (event) => {
      event.preventDefault();
      const target = document.querySelector(`[data-cite-id="${cssEscape(id)}"]`);
      if (!target) return;
      target.scrollIntoView({ block: "nearest", behavior: "smooth" });
      target.classList.remove("source--flash");
      // Force a reflow so repeated clicks restart the highlight.
      void target.offsetWidth;
      target.classList.add("source--flash");
      window.setTimeout(() => target.classList.remove("source--flash"), 1400);
    });
    parent.append(marker);
  }
}

/** @param {string} group @returns {string[]} */
function parseCitationIds(group) {
  const ids = [];
  for (const part of group.split(/[,;]/)) {
    const range = part.split(/\s*[-–]\s*/);
    if (range.length === 2) {
      const start = Number(range[0]);
      const end = Number(range[1]);
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start && end - start <= 20) {
        for (let value = start; value <= end; value += 1) ids.push(String(value));
        continue;
      }
    }
    const single = Number(range[0]);
    if (Number.isFinite(single)) ids.push(String(single));
  }
  return ids;
}

/** Escape a value for use inside an attribute selector. @param {string} value */
function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, "\\$&");
}

/** Decode the handful of entities a model may emit inside link text. */
function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/* ==========================================================================
   Lists
   ========================================================================== */

const LIST_ITEM = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;

/**
 * @param {string[]} lines
 * @param {number} startIndex
 * @param {{citations?: CitationRef[]}} options
 */
function buildList(lines, startIndex, options) {
  /** @type {{indent: number, ordered: boolean, text: string}[]} */
  const items = [];
  let index = startIndex;

  while (index < lines.length) {
    const match = lines[index].match(LIST_ITEM);
    if (!match) {
      // Allow continuation lines indented under the previous item.
      if (items.length && lines[index].trim() && /^\s{2,}\S/.test(lines[index])) {
        items[items.length - 1].text += ` ${lines[index].trim()}`;
        index += 1;
        continue;
      }
      break;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[index])) break;

    items.push({
      indent: match[1].replace(/\t/g, "  ").length,
      ordered: match[3] !== undefined,
      text: match[4],
    });
    index += 1;
  }

  const root = el(items[0]?.ordered ? "ol" : "ul");
  if (items[0]?.ordered) {
    const start = Number(LIST_ITEM.exec(lines[startIndex])?.[3]);
    if (Number.isFinite(start) && start !== 1) root.setAttribute("start", String(start));
  }

  /** @type {{list: HTMLElement, indent: number, lastItem: HTMLElement|null}[]} */
  const stack = [{ list: root, indent: items[0]?.indent ?? 0, lastItem: null }];

  for (const item of items) {
    while (stack.length > 1 && item.indent < stack[stack.length - 1].indent) {
      stack.pop();
    }

    const current = stack[stack.length - 1];

    if (item.indent > current.indent && current.lastItem) {
      const nested = el(item.ordered ? "ol" : "ul");
      current.lastItem.append(nested);
      stack.push({ list: nested, indent: item.indent, lastItem: null });
    }

    const level = stack[stack.length - 1];
    const isTask = /^\[( |x|X)\]\s+/.test(item.text);

    if (isTask) {
      const checked = /^\[(x|X)\]/.test(item.text);
      const label = el("label", { class: "task" });
      const input = el("input", { type: "checkbox", disabled: true });
      input.checked = checked;
      label.append(input, el("span", { text: item.text.replace(/^\[( |x|X)\]\s+/, "") }));
      const li = el("li", { class: "task-item" }, [label]);
      level.list.append(li);
      level.lastItem = li;
    } else {
      const li = el("li");
      appendInline(li, item.text, options);
      level.list.append(li);
      level.lastItem = li;
    }
  }

  return { node: root, nextIndex: index };
}

/* ==========================================================================
   Tables
   ========================================================================== */

/** @param {string[]} lines @param {number} index */
function isTableStart(lines, index) {
  if (index + 1 >= lines.length) return false;
  const header = lines[index];
  const divider = lines[index + 1];
  if (!header.includes("|") || !divider.includes("-")) return false;
  if (!/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(divider)) return false;
  const headerCells = splitRow(header);
  const dividerCells = splitRow(divider);
  return headerCells.length > 0 && headerCells.length === dividerCells.length;
}

/** @param {string} line @returns {string[]} */
function splitRow(line) {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);
  return value.split("|").map((cell) => cell.trim());
}

/**
 * @param {string[]} lines
 * @param {number} startIndex
 * @param {{citations?: CitationRef[]}} options
 */
function buildTable(lines, startIndex, options) {
  const header = splitRow(lines[startIndex]);
  const dividerCells = splitRow(lines[startIndex + 1]);
  const alignments = dividerCells.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });

  const alignmentAt = (column) => alignments[column] || "left";

  const thead = el("thead", {}, [
    el(
      "tr",
      {},
      header.map((cell, column) => el("th", { style: `text-align:${alignmentAt(column)}` }, [renderInline(cell, options)]))
    ),
  ]);

  const tbody = el("tbody");
  let index = startIndex + 2;

  while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
    const cells = splitRow(lines[index]);
    const row = el(
      "tr",
      {},
      cells.map((cell, column) => el("td", { style: `text-align:${alignmentAt(column)}` }, [renderInline(cell, options)]))
    );
    tbody.append(row);
    index += 1;
  }

  return {
    node: el("table", {}, [thead, tbody]),
    nextIndex: index,
  };
}
