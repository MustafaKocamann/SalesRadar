# SalesRadar — API reference

HTTP contract for the SalesRadar backend host (`main.py`). The UI is
**contract-first**: it calls `GET /health` on load and renders honest
"capability unavailable" states for anything the backend does not implement.
Nothing in this API is simulated — the research pipeline does not exist yet, so
the endpoints that would run it answer `501` with a machine-readable `code`.

- Base URL (local): `http://127.0.0.1:8000`
- Interactive docs: `GET /docs` (Swagger UI), `GET /openapi.json`
- Content type: `application/json` for every endpoint except `GET /`
- No authentication: this host is local-only and binds `127.0.0.1`

## Status summary

| Capability | Implemented | Reported as |
| --- | --- | --- |
| HTTP host, health, static UI | ✅ | — |
| `POST /research` (run pipeline) | ❌ (501) | `capabilities.research = false` |
| `POST /research/stream` (SSE) | ❌ (501) | `capabilities.streaming = false` |
| Report persistence `GET /reports/{id}` | ❌ (not routed) | `capabilities.history = false` |
| Citations | ❌ | `capabilities.citations = false` |
| Cost / duration telemetry | ❌ | `capabilities.cost_reporting = false` |

## Endpoints

### `GET /`

Renders `templates/index.html` with Jinja2 (`TemplateResponse`). The template
context contains no environment values, so credentials can never reach the
browser.

- **200** `text/html` — the workspace UI
- **503** `application/json` — only if `templates/index.html` is missing:

```json
{
  "detail": "The UI template is not available on this deployment.",
  "code": "ui_template_missing"
}
```

Cache: `Cache-Control: no-store`.

### `GET /health`

Source of truth for the UI. Every value reflects real configuration: credential
checks use a boolean presence test (`bool(os.getenv(...))`) and the values are
never returned or logged.

**200** `application/json` (example from a configured environment):

```json
{
  "status": "ok",
  "service": "salesradar",
  "version": "0.1.0",
  "time": "2026-11-27T08:30:41Z",
  "model": { "id": "openai/gpt-oss-120b", "provider": "Groq" },
  "checks": [
    {
      "id": "api",
      "label": "API",
      "state": "ok",
      "detail": "FastAPI host responding"
    },
    {
      "id": "llm",
      "label": "Language model",
      "state": "ok",
      "detail": "openai/gpt-oss-120b configured via GROQ_MODEL"
    },
    {
      "id": "research",
      "label": "Research tools",
      "state": "ok",
      "detail": "Treg credentials configured"
    },
    {
      "id": "pipeline",
      "label": "Agent pipeline",
      "state": "unavailable",
      "detail": "LangGraph research pipeline is not implemented yet"
    }
  ],
  "capabilities": {
    "research": false,
    "streaming": false,
    "history": false,
    "citations": false,
    "cost_reporting": false
  },
  "limits": { "max_query_chars": 600, "min_query_chars": 2 }
}
```

Field rules:

- `checks[]`: exactly `{id, label, state, detail}` with
  `id ∈ {api, llm, research, pipeline}` and
  `state ∈ {ok, degraded, unavailable}`.
  - `llm.state = "ok"` when `GROQ_API_KEY` is present, otherwise `"degraded"`
    with detail `"GROQ_API_KEY not configured"`.
  - `research.state = "ok"` when `TREG_API_KEY` is present, otherwise
    `"degraded"` with detail `"TREG_API_KEY not configured"`.
  - `pipeline.state` is **always** `"unavailable"` until the LangGraph graph is
    implemented. This report never claims the pipeline works.
- `model.id` comes from `GROQ_MODEL` (default `openai/gpt-oss-120b`);
  `model.provider` is `"Groq"`.
- `version` is read from `pyproject.toml` (fallback `"0.1.0"`).
- `time` is UTC ISO-8601 with a `Z` suffix.
- `capabilities` are all `false` today; they flip only when the corresponding
  implementation ships.

Cache: `Cache-Control: no-store`.

### `POST /research`

Validates a research request and **honestly** reports that the pipeline cannot
run yet. There is no fabricated report, citation, stage list, cost, or metric.

Request body:

```json
{
  "query": "Find decision-makers at Notion who own developer tooling",
  "company_name": "Notion",
  "focus": "developer tooling"
}
```

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `query` | string | yes | 2–600 chars after trimming; whitespace-only rejected |
| `company_name` | string \| null | no | max 200 chars; blank collapses to `null` |
| `focus` | string \| null | no | max 200 chars; blank collapses to `null` |

Responses:

- **501 Not Implemented** — the pipeline is absent:

```json
{
  "detail": "The research pipeline is not implemented on this backend yet. The interface is wired to this contract and will render a run as soon as the agent pipeline is available.",
  "code": "pipeline_not_implemented",
  "required_capabilities": [
    "POST /research returning a RunResult (see docs/API.md)",
    "Server-Sent Events progress on POST /research/stream",
    "Server-side report persistence (GET /reports/{id})",
    "Per-run cost + duration telemetry"
  ]
}
```

- **422 Unprocessable Entity** — FastAPI/Pydantic validation error
  (`"detail": [{...}]`). No `code` field; this is a request-shape failure.
- **500** — unexpected server error (should not occur for valid input).

Cache: `Cache-Control: no-store`.

### `POST /research/stream`

Same request body and validation as `POST /research`. The UI calls this only
when `/health` reports `capabilities.streaming = true` (it does not today).
Until then it returns the same honest shape with a different code:

```json
{
  "detail": "The research pipeline is not implemented on this backend yet. The interface is wired to this contract and will render a run as soon as the agent pipeline is available.",
  "code": "streaming_not_implemented",
  "required_capabilities": ["...same list as POST /research..."]
}
```

- **501 Not Implemented**
- **422 Unprocessable Entity** (validation)

### `GET /static/{path}`

Static file mount for `static/`. Existing assets resolve with
`Cache-Control: public, max-age=3600`; unknown files return the JSON `404` below.

### `GET /favicon.ico`

Not a noisy `404`. Redirects (`307`) to `/static/favicon.svg` when that asset
exists, otherwise returns `204 No Content`.

### `/docs`, `/redoc`, `/openapi.json`

FastAPI's interactive documentation and schema. `GET /openapi.json` is
available for client generation.

- **200** for all three.

## Error codes

Machine-readable errors always carry a `code` string:

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 404 | `not_found` | Unknown path |
| 501 | `pipeline_not_implemented` | `POST /research` — agent pipeline missing |
| 501 | `streaming_not_implemented` | `POST /research/stream` — SSE missing |
| 503 | `ui_template_missing` | `GET /` — `templates/index.html` absent |

```json
{ "detail": "Not Found", "code": "not_found", "path": "/does-not-exist" }
```

## Security headers

Applied by middleware to every response:

| Header | Value |
| --- | --- |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | `DENY` |
| `Permissions-Policy` | `interest-cohort=()` |
| `Content-Security-Policy` | `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` |

**CSP exception.** The strict CSP is skipped for `/docs`, `/redoc` and
`/openapi.json` because Swagger UI and ReDoc load CSS/JS from
`cdn.jsdelivr.net`; the policy would otherwise break the interactive
documentation. All application routes (including `/` and `/health`) keep the
strict policy. The frontend loads only same-origin `/static/...` assets, so the
strict policy is correct for it.

The remaining headers are applied to the documentation routes as well.

## Cache headers

- HTML (`GET /`) and JSON (`/health`, `/research*`, errors): `Cache-Control: no-store`
- Static assets: `Cache-Control: public, max-age=3600`

## Not yet implemented — required capabilities

These are the capabilities a real run needs before `capabilities.research` can
flip to `true`. The 501 payload enumerates them.

1. `POST /research` returning a `RunResult`.
2. Server-Sent Events progress on `POST /research/stream`.
3. Server-side report persistence (`GET /reports/{id}`).
4. Per-run cost and duration telemetry.

### Proposed `RunResult` shape (not yet served)

The frontend is written against this shape; it is documented so implementing
the pipeline is a drop-in change:

```json
{
  "run_id": "run_...",
  "status": "complete",
  "query": "Find decision-makers at Notion who own developer tooling",
  "company": "Notion",
  "focus": "developer tooling",
  "report": {
    "title": "Notion — go-to-market brief",
    "markdown": "## Summary\n..."
  },
  "sources": [
    {
      "index": 1,
      "title": "Notion pricing",
      "url": "https://www.notion.so/pricing",
      "host": "notion.so",
      "snippet": "..."
    }
  ],
  "stages": [
    { "id": "web", "label": "Web research", "state": "complete", "duration_ms": 4200 }
  ],
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "cost_usd": 0.0,
    "duration_ms": 0
  },
  "warnings": []
}
```

### Proposed SSE event schema (not yet served)

`POST /research/stream` would return `text/event-stream` with JSON payloads:

```json
{"event": "stage", "stage": "web|company|people|writer", "state": "queued|running|complete|failed", "detail": "Searching the public web"}
```

```json
{"event": "delta", "text": "Notion is a productivity ..."}
```

```json
{"event": "citation", "index": 1, "title": "Notion pricing", "url": "https://www.notion.so/pricing", "host": "notion.so"}
```

```json
{"event": "done", "usage": {"cost_usd": 0.0, "duration_ms": 0, "input_tokens": 0, "output_tokens": 0}}
```

```json
{"event": "error", "code": "pipeline_failed", "detail": "..."}
```

Until this ships, `capabilities.streaming` remains `false` and the UI must not
call the streaming route.

## Configuration

Configuration is read from the process environment and from `.env` via
`python-dotenv` (`load_dotenv`, existing process env wins). Only presence is
inspected; values are never returned, logged, or templated.

| Variable | Used for |
| --- | --- |
| `GROQ_API_KEY` | `checks[llm].state` (presence only) |
| `GROQ_MODEL` | `model.id` and the LLM check detail (default `openai/gpt-oss-120b`) |
| `TREG_API_KEY` | `checks[research].state` (presence only) |
| `TREG_MAX_USD`, `TREG_SEARCH_*`, `TREG_PEOPLE_*` | reserved for the future Treg client; not read by the host yet |

## Running and verifying

```powershell
# run the host
.venv\Scripts\python.exe main.py
# or
.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000

# contract tests (dependency-free: plain Python + FastAPI TestClient)
.venv\Scripts\python.exe tests\test_api.py
```

The `if __name__ == "__main__"` entrypoint binds `127.0.0.1:8000` with
`reload=False`.

## Known limitations

- No persistence: nothing is written to disk or a database.
- No authentication or rate limiting; the host is intended for local use.
- No research pipeline: the two research routes are contract stubs that return
  `501` by design.
- `GET /reports/{id}` is deliberately not routed (it would have nothing to
  serve); it is listed in `required_capabilities` instead.
