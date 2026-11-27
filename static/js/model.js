/**
 * Response model.
 *
 * Converts untrusted API payloads into the flat view-models the renderer
 * consumes. Every accessor is defensive: missing fields stay missing rather
 * than being invented, so the UI can say "not reported" honestly.
 */

import { AGENTS, AGENT_BY_ID } from "./config.js";
import { safeUrl, hostOf, formatCost, formatCount, formatDuration } from "./util.js";

/**
 * @typedef {Object} RunViewModel
 * @property {string} id
 * @property {"queued"|"running"|"complete"|"partial"|"failed"|"unavailable"} status
 * @property {string} company
 * @property {string} subtitle
 * @property {string} query
 * @property {string} focus
 * @property {StageViewModel[]} stages
 * @property {string} report
 * @property {CitationViewModel[]} citations
 * @property {MetricViewModel[]} metrics
 * @property {FactViewModel[]} facts
 * @property {PersonViewModel[]} people
 * @property {OpportunityViewModel[]} opportunities
 * @property {string[]} warnings
 * @property {NoticeViewModel|null} notice
 * @property {unknown[]} calls
 * @property {unknown[]} evidence
 * @property {number} startedAt
 * @property {number|null} completedAt
 * @property {number|null} durationMs
 * @property {boolean} isSample
 */

/**
 * @typedef {Object} StageViewModel
 * @property {string} agent
 * @property {string} name
 * @property {string} description
 * @property {"waiting"|"queued"|"running"|"complete"|"failed"|"skipped"|"unavailable"} state
 * @property {string} detail
 * @property {number|null} durationMs
 */

const STAGE_STATES = new Set([
  "waiting",
  "queued",
  "running",
  "complete",
  "failed",
  "skipped",
  "unavailable",
]);

/** How each API stage state is described to a human. */
export const STAGE_STATE_LABEL = Object.freeze({
  waiting: "Waiting",
  queued: "Queued",
  running: "Running",
  complete: "Complete",
  failed: "Failed",
  skipped: "Skipped",
  unavailable: "Unavailable",
});

/**
 * Fresh stage list for a newly created run. All stages start as `waiting`:
 * the interface never implies an agent ran before the backend says so.
 * @param {"waiting"|"queued"} [initialState]
 * @returns {StageViewModel[]}
 */
export function createStages(initialState = "waiting") {
  return AGENTS.map((agent) => ({
    agent: agent.id,
    name: agent.name,
    description: agent.description,
    state: initialState,
    detail: "",
    durationMs: null,
  }));
}

/**
 * Apply a single stage event (SSE or final payload) onto a stage list.
 * @param {StageViewModel[]} stages
 * @param {{agent?: string, stage?: string, state?: string, detail?: string, duration_ms?: number}} event
 */
export function applyStageEvent(stages, event) {
  const agentId = String(event.agent || event.stage || "").toLowerCase();
  const stage = stages.find((candidate) => candidate.agent === agentId);
  if (!stage) return stages;

  const state = String(event.state || "").toLowerCase();
  if (STAGE_STATES.has(state)) stage.state = state;
  if (typeof event.detail === "string") stage.detail = event.detail;
  if (Number.isFinite(Number(event.duration_ms))) stage.durationMs = Number(event.duration_ms);

  return stages;
}

/**
 * Normalise a full `/research` payload into a view model.
 *
 * @param {unknown} payload
 * @param {{query: string, focus?: string, startedAt?: number, durationMs?: number}} context
 * @returns {RunViewModel}
 */
export function normaliseRunResult(payload, context) {
  const raw = payload && typeof payload === "object" ? payload : {};

  const company = resolveCompany(raw);
  const report = resolveReport(raw);
  const citations = resolveCitations(raw);
  const stages = resolveStages(raw);

  const startedAt = Number(context.startedAt) || Date.now();
  const completedAt = Date.now();
  const durationMs =
    pickNumber(raw.usage?.duration_ms, raw.duration_ms, context.durationMs) ?? null;

  const usage = raw.usage && typeof raw.usage === "object" ? raw.usage : {};

  return {
    id: String(raw.id || raw.run_id || `run_${startedAt.toString(36)}`),
    status: resolveStatus(raw),
    company: company.name,
    subtitle: company.subtitle,
    query: String(raw.query ?? context.query ?? ""),
    focus: String(raw.focus ?? context.focus ?? ""),
    stages,
    report,
    citations,
    metrics: resolveMetrics(raw, usage, durationMs, citations),
    facts: resolveFacts(company, raw),
    people: resolvePeople(raw),
    opportunities: resolveOpportunities(raw),
    warnings: Array.isArray(raw.warnings)
      ? raw.warnings.filter((warning) => typeof warning === "string" && warning.trim())
      : [],
    notice: null,
    calls: Array.isArray(raw.calls) ? raw.calls : [],
    evidence: Array.isArray(raw.evidence) ? raw.evidence : [],
    startedAt,
    completedAt,
    durationMs,
    isSample: false,
  };
}

/**
 * Explain why a run could not be produced, using the backend's own words.
 *
 * @param {unknown} payload
 * @param {{query: string, focus?: string, startedAt?: number}} context
 * @param {{message: string, code: string, status: number}} error
 * @returns {RunViewModel}
 */
export function createUnavailableRun(payload, context, error) {
  const body = payload && typeof payload === "object" ? payload : {};
  const required = Array.isArray(body.required_capabilities)
    ? body.required_capabilities.filter((item) => typeof item === "string")
    : [];

  const isNotImplemented = error.code === "pipeline_not_implemented" || error.status === 501;

  return {
    id: `run_${Date.now().toString(36)}`,
    status: isNotImplemented ? "unavailable" : "failed",
    company: "",
    subtitle: "",
    query: context.query,
    focus: context.focus || "",
    stages: createStages("unavailable"),
    report: "",
    citations: [],
    metrics: [],
    facts: [],
    people: [],
    opportunities: [],
    warnings: [],
    notice: {
      tone: isNotImplemented ? "info" : "danger",
      title: isNotImplemented ? "Research pipeline not connected" : "Research run failed",
      text:
        typeof body.detail === "string" && body.detail
          ? body.detail
          : error.message || "The request could not be completed.",
      list: required,
    },
    calls: [],
    evidence: [],
    startedAt: context.startedAt || Date.now(),
    completedAt: Date.now(),
    durationMs: null,
    isSample: false,
  };
}

/* ==========================================================================
   Field resolvers
   ========================================================================== */

/** @param {Record<string, any>} raw */
function resolveCompany(raw) {
  const source = raw.company && typeof raw.company === "object" ? raw.company : {};

  const name =
    firstString(source.name, raw.company_name, typeof raw.company === "string" ? raw.company : "");

  const bits = [
    firstString(source.industry),
    firstString(source.headquarters, source.hq, source.location),
    firstString(source.size, source.employees),
    firstString(source.founded ? `Founded ${source.founded}` : ""),
  ].filter(Boolean);

  return {
    name,
    subtitle: bits.join(" · "),
    domain: firstString(source.domain, source.website),
    description: firstString(source.description, source.summary),
    industry: firstString(source.industry),
    hq: firstString(source.headquarters, source.hq, source.location),
    size: firstString(source.size, source.employees),
    founded: firstString(source.founded),
    website: safeUrl(firstString(source.website, source.domain)),
  };
}

/** @param {Record<string, any>} raw */
function resolveReport(raw) {
  const candidates = [raw.report_markdown, raw.report, raw.markdown, raw.summary];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return "";
}

/** @param {Record<string, any>} raw */
function resolveCitations(raw) {
  const list = firstArray(raw.citations, raw.sources, raw.references);
  const seen = new Set();

  return list
    .map((entry, index) => {
      if (typeof entry === "string") {
        const url = safeUrl(entry);
        return url
          ? { id: String(index + 1), title: hostOf(url) || entry, url, host: hostOf(url), snippet: "" }
          : null;
      }
      if (!entry || typeof entry !== "object") return null;

      const url = safeUrl(firstString(entry.url, entry.link, entry.href));
      const id = firstString(entry.id, entry.index, String(index + 1));
      if (!url || seen.has(id)) return null;
      seen.add(id);

      return {
        id,
        title: firstString(entry.title, entry.name, hostOf(url) || url),
        url,
        host: hostOf(url),
        snippet: firstString(entry.snippet, entry.excerpt, entry.description),
        retrievedAt: firstString(entry.retrieved_at, entry.retrievedAt, entry.date),
      };
    })
    .filter(Boolean);
}

/** @param {Record<string, any>} raw */
function resolveStages(raw) {
  const list = firstArray(raw.stages, raw.agents, raw.completed_stages);
  const stages = createStages("waiting");

  // Legacy contract: an array of completed agent ids.
  if (Array.isArray(raw.completed)) {
    for (const id of raw.completed) {
      const stage = stages.find((candidate) => candidate.agent === String(id));
      if (stage) stage.state = "complete";
    }
    return stages;
  }

  if (!list.length) {
    // No stage telemetry: if a report exists the pipeline clearly finished.
    const finished = Boolean(resolveReport(raw));
    for (const stage of stages) stage.state = finished ? "complete" : "waiting";
    return stages;
  }

  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const agentId = String(entry.agent || entry.id || entry.stage || "").toLowerCase();
    const stage = stages.find((candidate) => candidate.agent === agentId);
    if (!stage) continue;

    const state = String(entry.state || entry.status || "").toLowerCase();
    if (state === "done" || state === "ok" || state === "success") stage.state = "complete";
    else if (STAGE_STATES.has(state)) stage.state = state;
    else stage.state = "complete";

    stage.detail = firstString(entry.detail, entry.message, entry.summary);
    const duration = pickNumber(entry.duration_ms, entry.durationMs, entry.duration);
    stage.durationMs = duration;
  }

  // A stage that never reported while the run completed is reported as skipped.
  const completedRun = resolveStatus(raw) === "complete" || resolveStatus(raw) === "partial";
  if (completedRun) {
    for (const stage of stages) {
      if (stage.state === "waiting") stage.state = "skipped";
    }
  }

  return stages;
}

/** @param {Record<string, any>} raw */
function resolveStatus(raw) {
  const status = String(raw.status || "").toLowerCase();
  if (["complete", "completed", "success", "ok", "done"].includes(status)) {
    return firstArray(raw.warnings).length ? "partial" : "complete";
  }
  if (["partial", "incomplete"].includes(status)) return "partial";
  if (["failed", "error"].includes(status)) return "failed";
  if (status === "running") return "running";
  if (resolveReport(raw)) return firstArray(raw.warnings).length ? "partial" : "complete";
  return "failed";
}

/**
 * Metrics are only added when the backend actually reports the value.
 * @param {Record<string, any>} raw
 * @param {Record<string, any>} usage
 * @param {number|null} durationMs
 * @param {ReturnType<typeof resolveCitations>} citations
 */
function resolveMetrics(raw, usage, durationMs, citations) {
  /** @type {MetricViewModel[]} */
  const metrics = [];

  const cost = pickNumber(
    usage.cost_usd,
    usage.total_cost_usd,
    raw.treg_cost_usd,
    raw.cost_usd,
    raw.cost
  );
  if (cost !== null) metrics.push({ label: "API cost", value: formatCost(cost) });

  if (durationMs !== null) metrics.push({ label: "Duration", value: formatDuration(durationMs) });

  const inputTokens = pickNumber(usage.prompt_tokens, usage.input_tokens, usage.tokens_in);
  const outputTokens = pickNumber(usage.completion_tokens, usage.output_tokens, usage.tokens_out);
  if (inputTokens !== null) metrics.push({ label: "Input tokens", value: formatCount(inputTokens) });
  if (outputTokens !== null) metrics.push({ label: "Output tokens", value: formatCount(outputTokens) });

  if (citations.length) metrics.push({ label: "Sources", value: String(citations.length) });

  const model = firstString(usage.model, raw.model);
  if (model) metrics.push({ label: "Model", value: model });

  return metrics;
}

/** @param {ReturnType<typeof resolveCompany>} company @param {Record<string, any>} raw */
function resolveFacts(company, raw) {
  const facts = [
    { label: "Industry", value: company.industry },
    { label: "Headquarters", value: company.hq },
    { label: "Employees", value: company.size },
    { label: "Founded", value: company.founded },
    { label: "Website", value: company.domain },
  ];

  const extra = raw.facts && typeof raw.facts === "object" && !Array.isArray(raw.facts)
    ? raw.facts
    : {};

  for (const [key, value] of Object.entries(extra)) {
    if (typeof value !== "string" || !value.trim()) continue;
    if (facts.some((fact) => fact.label.toLowerCase() === key.toLowerCase())) continue;
    facts.push({ label: titleCase(key), value });
  }

  return facts.filter((fact) => fact.value);
}

/** @param {Record<string, any>} raw */
function resolvePeople(raw) {
  return firstArray(raw.people, raw.decision_makers, raw.contacts)
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const name = firstString(entry.name, entry.full_name);
      if (!name) return null;
      return {
        name,
        title: firstString(entry.title, entry.role, entry.position),
        why: firstString(entry.why, entry.rationale, entry.relevance, entry.notes),
        linkedin: safeUrl(firstString(entry.linkedin, entry.linkedin_url, entry.url)),
      };
    })
    .filter(Boolean);
}

/** @param {Record<string, any>} raw */
function resolveOpportunities(raw) {
  return firstArray(raw.opportunities, raw.sales_opportunities, raw.angles)
    .map((entry) => {
      if (typeof entry === "string") return entry.trim() ? { title: entry, detail: "" } : null;
      if (!entry || typeof entry !== "object") return null;
      return {
        title: firstString(entry.title, entry.name, entry.headline),
        detail: firstString(entry.detail, entry.description, entry.rationale, entry.why),
        confidence: firstString(entry.confidence),
      };
    })
    .filter((entry) => entry && (entry.title || entry.detail));
}

/* ==========================================================================
   Small typed helpers
   ========================================================================== */

/** @param {...unknown} values */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

/** @param {...unknown} values @returns {number|null} */
function pickNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

/** @param {...unknown} values @returns {unknown[]} */
function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

/** @param {string} value */
function titleCase(value) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * @typedef {Object} MetricViewModel
 * @property {string} label
 * @property {string} value
 */

/**
 * @typedef {Object} FactViewModel
 * @property {string} label
 * @property {string} value
 */

/**
 * @typedef {Object} CitationViewModel
 * @property {string} id
 * @property {string} title
 * @property {string} url
 * @property {string} host
 * @property {string} snippet
 */

/**
 * @typedef {Object} PersonViewModel
 * @property {string} name
 * @property {string} title
 * @property {string} why
 * @property {string|null} linkedin
 */

/**
 * @typedef {Object} OpportunityViewModel
 * @property {string} title
 * @property {string} detail
 * @property {string} [confidence]
 */

/**
 * @typedef {Object} NoticeViewModel
 * @property {"info"|"warning"|"danger"|"success"} tone
 * @property {string} title
 * @property {string} text
 * @property {string[]} list
 */

/** Agent lookup re-exported for renderers. */
export { AGENT_BY_ID };
