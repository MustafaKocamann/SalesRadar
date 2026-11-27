/**
 * Static application configuration.
 *
 * Everything here is presentation-level metadata: labels, agent descriptions
 * and prompt suggestions. No data that should come from the API lives here.
 */

export const STORAGE_KEYS = Object.freeze({
  settings: "salesradar.settings.v1",
  threads: "salesradar.threads.v1",
});

export const LIMITS = Object.freeze({
  minQueryChars: 2,
  maxQueryChars: 600,
  maxThreads: 60,
  maxEntriesPerThread: 24,
});

/**
 * The four LangGraph agents, in execution order. `id` values are the contract
 * used by the backend in `stages[].agent` and by SSE `event: stage` payloads.
 */
export const AGENTS = Object.freeze([
  {
    id: "web",
    name: "Web research",
    short: "Web research",
    description: "Crawls public sources for company facts, news and signals.",
    icon: "i-globe",
  },
  {
    id: "company",
    name: "Company intelligence",
    short: "Company intel",
    description: "Consolidates firmographics, products and positioning.",
    icon: "i-building",
  },
  {
    id: "people",
    name: "People research",
    short: "People research",
    description: "Identifies decision-makers and the buying committee.",
    icon: "i-users",
  },
  {
    id: "writer",
    name: "Report writer",
    short: "Report writer",
    description: "Synthesises an evidence-backed sales brief.",
    icon: "i-file-text",
  },
]);

export const AGENT_BY_ID = Object.freeze(
  Object.fromEntries(AGENTS.map((agent) => [agent.id, agent]))
);

/**
 * Query starters. These are prompts, not answers — the UI never implies a
 * result exists before the pipeline returns one.
 */
export const SUGGESTIONS = Object.freeze([
  {
    title: "Map the buying committee",
    query: "Who are the decision-makers for a data platform purchase at Stripe?",
    icon: "i-users",
  },
  {
    title: "Find expansion signals",
    query: "What expansion or hiring signals suggest Figma is investing in enterprise security?",
    icon: "i-trend",
  },
  {
    title: "Build a competitive brief",
    query: "Build a sales brief on Linear covering products, ICP and competitive positioning.",
    icon: "i-scale",
  },
  {
    title: "Qualify a target account",
    query: "Is Ramp a good fit for an AI customer-support platform? Research size, stack and priorities.",
    icon: "i-target",
  },
]);

export const FOCUS_LABELS = Object.freeze({
  "": "Full brief",
  "decision-makers": "Decision-makers",
  competitive: "Competitive landscape",
  expansion: "Expansion signals",
  risk: "Risk & compliance",
});

/** Capability metadata for the settings panel. Keys mirror GET /health. */
export const CAPABILITY_META = Object.freeze({
  research: {
    label: "Research pipeline",
    available: "Runs the LangGraph agent pipeline",
    unavailable: "Not implemented on this backend — requests return an explanatory error",
  },
  streaming: {
    label: "Streaming progress",
    available: "Stage events stream over server-sent events",
    unavailable: "Progress arrives only when the request completes",
  },
  history: {
    label: "Server-side history",
    available: "Runs are persisted by the API",
    unavailable: "Conversations are stored in this browser only",
  },
  citations: {
    label: "Source citations",
    available: "Reports include traceable citations",
    unavailable: "No citation data is returned",
  },
  cost_reporting: {
    label: "Cost telemetry",
    available: "Per-run API cost is reported",
    unavailable: "Cost is not reported by the backend",
  },
});

export const STATE_LABELS = Object.freeze({
  ok: "Operational",
  degraded: "Degraded",
  unavailable: "Unavailable",
  error: "Error",
  unknown: "Unknown",
  running: "Running",
});

/** Payment-free fallback labels when /health does not provide a model id. */
export const DEFAULT_MODEL = "GPT-OSS-120B";

export const ROUTES = Object.freeze({
  health: "/health",
  research: "/research",
  researchStream: "/research/stream",
});

export const TIMING = Object.freeze({
  toastDuration: 4200,
  copyFeedback: 1600,
  healthTimeout: 8000,
  researchTimeout: 180000,
});
