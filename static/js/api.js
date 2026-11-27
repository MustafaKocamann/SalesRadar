/**
 * API client for the FastAPI backend.
 *
 * Responsibilities:
 *  - normalise network/HTTP failures into a single `ApiError` shape
 *  - read the health contract without assuming optional fields exist
 *  - never fabricate a result: every value returned here originates from the API
 */

import { ROUTES, TIMING } from "./config.js";

/** Error carrying the machine-readable `code` returned by the backend. */
export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, status?: number, payload?: unknown, cause?: unknown}} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = "ApiError";
    this.code = meta.code || "request_failed";
    this.status = meta.status ?? 0;
    this.payload = meta.payload ?? null;
    this.cause = meta.cause;
  }
}

/** Subset of the backend health payload the UI relies on. */
export const EMPTY_HEALTH = Object.freeze({
  ok: false,
  service: "",
  version: "",
  model: { id: "", provider: "" },
  checks: [],
  capabilities: {
    research: false,
    streaming: false,
    history: false,
    citations: false,
    cost_reporting: false,
  },
  limits: { min_query_chars: 2, max_query_chars: 600 },
});

/**
 * @param {Response} response
 * @returns {Promise<unknown>}
 */
async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text.slice(0, 400) };
  }
}

/**
 * Read the backend health/capability descriptor.
 * @param {{signal?: AbortSignal}} [options]
 */
export async function fetchHealth(options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), TIMING.healthTimeout);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetch(ROUTES.health, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });

    const payload = await readJson(response);

    if (!response.ok) {
      throw new ApiError(
        (payload && typeof payload.detail === "string" && payload.detail) ||
          `Health check failed with HTTP ${response.status}`,
        { code: "health_failed", status: response.status, payload }
      );
    }

    return normaliseHealth(payload);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const aborted = error?.name === "AbortError";
    throw new ApiError(
      aborted
        ? "The API did not respond in time. Start the FastAPI server and try again."
        : "Cannot reach the API. Check that the FastAPI server is running.",
      { code: aborted ? "health_timeout" : "network_error", cause: error }
    );
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Normalise a health payload defensively — every field is optional on the wire.
 * @param {unknown} payload
 */
export function normaliseHealth(payload) {
  const raw = payload && typeof payload === "object" ? payload : {};
  const checks = Array.isArray(raw.checks)
    ? raw.checks
        .filter((check) => check && typeof check === "object")
        .map((check) => ({
          id: String(check.id ?? ""),
          label: String(check.label ?? check.id ?? "Check"),
          state: normaliseState(check.state),
          detail: String(check.detail ?? ""),
        }))
    : [];

  const capabilities = { ...EMPTY_HEALTH.capabilities };
  if (raw.capabilities && typeof raw.capabilities === "object") {
    for (const key of Object.keys(capabilities)) {
      capabilities[key] = raw.capabilities[key] === true;
    }
  }

  const model = raw.model && typeof raw.model === "object" ? raw.model : {};

  return {
    ok: true,
    service: String(raw.service ?? ""),
    version: String(raw.version ?? ""),
    status: String(raw.status ?? ""),
    time: String(raw.time ?? ""),
    model: {
      id: String(model.id ?? ""),
      provider: String(model.provider ?? ""),
    },
    checks,
    capabilities,
    limits: {
      min_query_chars: clampLimit(raw.limits?.min_query_chars, 2, 1, 600),
      max_query_chars: clampLimit(raw.limits?.max_query_chars, 600, 2, 20000),
    },
  };
}

/**
 * @param {unknown} value @param {number} fallback @param {number} min @param {number} max
 */
function clampLimit(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}

/** @param {unknown} value */
function normaliseState(value) {
  const state = String(value ?? "").toLowerCase();
  return ["ok", "degraded", "unavailable", "error", "unknown"].includes(state) ? state : "unknown";
}

/**
 * Build the /research request body. The contract allows `query`, `company_name`
 * and `focus`; only the fields the user actually supplied are sent.
 * @param {{query: string, focus?: string}} input
 */
export function buildResearchPayload(input) {
  const payload = { query: input.query.trim() };
  if (input.focus) payload.focus = input.focus;
  return payload;
}

/**
 * Run a blocking research request.
 *
 * @param {{query: string, focus?: string}} input
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{result: unknown, durationMs: number}>}
 */
export async function runResearch(input, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), TIMING.researchTimeout);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const startedAt = performance.now();

  try {
    const response = await fetch(ROUTES.research, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(buildResearchPayload(input)),
      signal: controller.signal,
    });

    const payload = await readJson(response);
    const durationMs = performance.now() - startedAt;

    if (!response.ok) {
      const detail =
        payload && typeof payload.detail === "string" && payload.detail
          ? payload.detail
          : `Research request failed with HTTP ${response.status}`;
      throw new ApiError(detail, {
        code: String(payload?.code || "research_failed"),
        status: response.status,
        payload,
      });
    }

    return { result: payload, durationMs };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const abortedByUser = options.signal?.aborted === true;
    const timedOut = error?.name === "AbortError" && !abortedByUser;

    throw new ApiError(
      abortedByUser
        ? "Research cancelled."
        : timedOut
          ? "The research run timed out before the API responded."
          : "The research request could not be completed. Check the connection and server logs.",
      {
        code: abortedByUser ? "aborted" : timedOut ? "research_timeout" : "network_error",
        cause: error,
      }
    );
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Stream a research run over server-sent events (fetch + ReadableStream,
 * because EventSource cannot POST).
 *
 * The backend is expected to emit JSON events with an `event` discriminator:
 *   {event:"stage", stage, state, detail?}
 *   {event:"delta", text}
 *   {event:"notice", tone?, title?, text?}
 *   {event:"done", result}
 *   {event:"error", detail?, code?}
 *
 * @param {{query: string, focus?: string}} input
 * @param {{signal?: AbortSignal, onEvent: (event: {event: string, [key: string]: unknown}) => void}} options
 * @returns {Promise<{result: unknown|null, durationMs: number}>}
 */
export async function streamResearch(input, options) {
  const startedAt = performance.now();
  let response;

  try {
    response = await fetch(ROUTES.researchStream, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(buildResearchPayload(input)),
      signal: options.signal,
    });
  } catch (error) {
    throw new ApiError(
      options.signal?.aborted ? "Research cancelled." : "The streaming request could not be started.",
      {
        code: options.signal?.aborted ? "aborted" : "network_error",
        cause: error,
      }
    );
  }

  if (!response.ok) {
    const payload = await readJson(response);
    throw new ApiError(
      (payload && typeof payload.detail === "string" && payload.detail) ||
        `Streaming request failed with HTTP ${response.status}`,
      { code: String(payload?.code || "stream_failed"), status: response.status, payload }
    );
  }

  if (!response.body) {
    throw new ApiError("This browser cannot read a streaming response.", {
      code: "stream_unsupported",
      status: response.status,
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseChunk(chunk);

        if (parsed) {
          if (parsed.event === "done" && parsed.result) result = parsed.result;
          options.onEvent(parsed);
        }

        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { result, durationMs: performance.now() - startedAt };
}

/**
 * @param {string} chunk
 * @returns {{event: string, [key: string]: unknown}|null}
 */
function parseSseChunk(chunk) {
  const dataLines = [];
  let eventName = "message";

  for (const line of chunk.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (!dataLines.length) return null;

  try {
    const data = JSON.parse(dataLines.join("\n"));
    if (data && typeof data === "object") {
      return { ...data, event: String(data.event || eventName) };
    }
    return { event: eventName, value: data };
  } catch {
    return { event: eventName, text: dataLines.join("\n") };
  }
}
