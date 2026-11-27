/**
 * Static layout reference.
 *
 * This is NOT an API response and must never be presented as one. It exists so
 * the report layout can be reviewed while the LangGraph pipeline is not yet
 * implemented. Every surface that renders it is labelled "Sample", and the
 * company and people below are fictional.
 *
 * Deliberately excluded: API cost, token counts and any telemetry values that
 * could be mistaken for measured data.
 */

/** @type {import("./model.js").RunViewModel} */
export const SAMPLE_RUN = {
  id: "sample_layout_reference",
  status: "complete",
  company: "Northwind Analytics (sample)",
  subtitle: "Data & analytics platform · Seattle, WA · 480 employees · Founded 2016",
  query:
    "Build a sales brief on Northwind Analytics covering products, buying committee and expansion signals.",
  focus: "",
  stages: [
    {
      agent: "web",
      name: "Web research",
      description: "Crawls public sources for company facts, news and signals.",
      state: "complete",
      detail: "8 pages retrieved · 2 press releases · careers page",
      durationMs: 12400,
    },
    {
      agent: "company",
      name: "Company intelligence",
      description: "Consolidates firmographics, products and positioning.",
      state: "complete",
      detail: "Product line and pricing model resolved",
      durationMs: 8100,
    },
    {
      agent: "people",
      name: "People research",
      description: "Identifies decision-makers and the buying committee.",
      state: "complete",
      detail: "4 contacts matched across 3 buying roles",
      durationMs: 9600,
    },
    {
      agent: "writer",
      name: "Report writer",
      description: "Synthesises an evidence-backed sales brief.",
      state: "complete",
      detail: "Brief composed with 6 citations",
      durationMs: 7200,
    },
  ],
  report: `## Overview

Northwind Analytics sells a warehouse-native analytics layer for mid-market SaaS
companies. The platform reads directly from customer data warehouses and exposes
a semantic modelling layer on top [1], which positions it against traditional BI
suites rather than against focused dashboard tools.

### Products

- **Semantic layer** — metric definitions versioned alongside dbt models [2].
- **Embedded analytics** — customer-facing dashboards for SaaS resellers.
- **Governance add-on** — lineage, access policies and audit trails [5].

### Buying committee

The purchase decision is split across analytics engineering, finance and
security. Prior public references indicate that the analytics engineering lead
usually drives evaluation, while security sign-off is a common late-stage
blocker for regulated customers [5].

### Why now

Two signals suggest an active evaluation cycle: a public job posting for a
"Director of Analytics Platform" role [3], and a recent partnership announcement
with a cloud data warehouse vendor [4]. Both are consistent with consolidation of
an internally built toolchain.

> Treat the hiring signal as directional only — a single posting is weak
> evidence of a funded programme.`,

  citations: [
    {
      id: "1",
      title: "Northwind Analytics — company overview",
      url: "https://example.com/northwind/about",
      host: "example.com",
      snippet: "Warehouse-native analytics for mid-market SaaS teams.",
    },
    {
      id: "2",
      title: "Product documentation — semantic layer",
      url: "https://example.com/northwind/docs/semantic-layer",
      host: "example.com",
      snippet: "Versioned metric definitions compiled from dbt models.",
    },
    {
      id: "3",
      title: "Careers — Director, Analytics Platform",
      url: "https://example.com/northwind/careers",
      host: "example.com",
      snippet: "Own the long-term platform roadmap across analytics surfaces.",
    },
    {
      id: "4",
      title: "Partnership announcement",
      url: "https://example.com/news/northwind-partnership",
      host: "example.com",
      snippet: "Joint go-to-market with a cloud data warehouse vendor.",
    },
    {
      id: "5",
      title: "Security and compliance page",
      url: "https://example.com/northwind/security",
      host: "example.com",
      snippet: "SOC 2 Type II, annual penetration testing, regional data residency.",
    },
    {
      id: "6",
      title: "Pricing model overview",
      url: "https://example.com/northwind/pricing",
      host: "example.com",
      snippet: "Consumption-based pricing with a platform fee.",
    },
  ],

  metrics: [
    { label: "Duration", value: "37.3s" },
    { label: "Sources", value: "6" },
    { label: "Model", value: "GPT-OSS-120B" },
  ],

  facts: [
    { label: "Industry", value: "Data & analytics" },
    { label: "Headquarters", value: "Seattle, WA" },
    { label: "Employees", value: "480" },
    { label: "Founded", value: "2016" },
    { label: "Website", value: "example.com" },
  ],

  people: [
    {
      name: "Dana Whitfield",
      title: "VP, Analytics Engineering",
      why: "Owns the semantic layer roadmap and is the most likely technical evaluator.",
      linkedin: null,
    },
    {
      name: "Marcus Oyelaran",
      title: "Director, Analytics Platform",
      why: "Newly created role; joining scope typically signals tooling consolidation.",
      linkedin: null,
    },
    {
      name: "Priya Raghunathan",
      title: "Chief Information Security Officer",
      why: "Signs off on data residency and access governance for regulated accounts.",
      linkedin: null,
    },
    {
      name: "Elliot Vance",
      title: "FP&A Lead",
      why: "Economic buyer for spend tied to analytics headcount and tooling renewal.",
      linkedin: null,
    },
  ],

  opportunities: [
    {
      title: "Displace the internally built dashboard stack",
      detail:
        "The open platform role and warehouse partnership both point to a rebuild rather than an incremental purchase. Lead with migration effort and metric-definition drift.",
    },
    {
      title: "Position governance as the security answer",
      detail:
        "Security sign-off is the likely late-stage blocker. Bring lineage and audit evidence into the first technical conversation rather than the final review.",
    },
    {
      title: "Target the embedded analytics reseller motion",
      detail:
        "SaaS resellers need customer-facing dashboards. Offer a pilot scoped to one reseller tier to keep the initial commitment small.",
    },
  ],

  warnings: [],
  notice: {
    tone: "warning",
    title: "Sample layout reference",
    text: "This is a static design preview rendered from local sample data. No agent ran, no API was called, and no cost was incurred. The company, people and sources are fictional.",
    list: [],
  },
  calls: [],
  evidence: [
    {
      id: 1,
      source: "example.com/northwind/about",
      data: {
        note: "Sample evidence payload — not retrieved from any real request.",
        fields: ["industry", "headquarters", "employees", "founded"],
      },
    },
  ],
  startedAt: Date.now() - 37300,
  completedAt: Date.now(),
  durationMs: 37300,
  isSample: true,
};

/**
 * A fresh copy so callers can mutate freely.
 * @returns {import("./model.js").RunViewModel}
 */
export function cloneSampleRun() {
  return {
    ...SAMPLE_RUN,
    id: `sample_${Date.now().toString(36)}`,
    stages: SAMPLE_RUN.stages.map((stage) => ({ ...stage })),
    citations: SAMPLE_RUN.citations.map((citation) => ({ ...citation })),
    metrics: SAMPLE_RUN.metrics.map((metric) => ({ ...metric })),
    facts: SAMPLE_RUN.facts.map((fact) => ({ ...fact })),
    people: SAMPLE_RUN.people.map((person) => ({ ...person })),
    opportunities: SAMPLE_RUN.opportunities.map((item) => ({ ...item })),
    warnings: [],
    notice: { ...SAMPLE_RUN.notice, list: [] },
    calls: [],
    evidence: SAMPLE_RUN.evidence.map((row) => ({ ...row, data: JSON.parse(JSON.stringify(row.data)) })),
    startedAt: Date.now() - (SAMPLE_RUN.durationMs || 0),
    completedAt: Date.now(),
  };
}
