"""SalesIntel AI — FastAPI host for the SalesRadar research workspace.

This module intentionally implements *only* the HTTP host and its honest
capability reporting. The LangGraph research pipeline (web research, company
intelligence, people research, report writer) does not exist yet, so every
endpoint that would run it returns an explicit HTTP 501 with a machine-readable
``code`` field instead of fabricated reports, citations, stages, costs or
metrics.

Run locally::

    .venv\\Scripts\\python.exe main.py
    # or: .venv\\Scripts\\python.exe -m uvicorn main:app --port 8000

The frontend is contract-first: it reads ``/health`` and disables features whose
capabilities are reported as unavailable, so this file must never overstate
what the backend can do.
"""

from __future__ import annotations

import logging
import os
import tomllib
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Final

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from jinja2 import TemplateNotFound
from pydantic import BaseModel, Field, field_validator

logger = logging.getLogger("salesintel")

# --------------------------------------------------------------------------- #
# Paths, constants
# --------------------------------------------------------------------------- #

BASE_DIR: Final[Path] = Path(__file__).resolve().parent
TEMPLATES_DIR: Final[Path] = BASE_DIR / "templates"
STATIC_DIR: Final[Path] = BASE_DIR / "static"
ENV_FILE: Final[Path] = BASE_DIR / ".env"
PYPROJECT_FILE: Final[Path] = BASE_DIR / "pyproject.toml"

SERVICE_NAME: Final[str] = "salesintel-ai"
DEFAULT_VERSION: Final[str] = "0.1.0"
DEFAULT_MODEL_ID: Final[str] = "openai/gpt-oss-120b"

MIN_QUERY_CHARS: Final[int] = 2
MAX_QUERY_CHARS: Final[int] = 600

PIPELINE_UNAVAILABLE_DETAIL: Final[str] = (
    "The research pipeline is not implemented on this backend yet. "
    "The interface is wired to this contract and will render a run as soon as "
    "the agent pipeline is available."
)

# Capabilities a real run would need that this host does not provide yet.
REQUIRED_PIPELINE_CAPABILITIES: Final[list[str]] = [
    "POST /research returning a RunResult (see docs/API.md)",
    "Server-Sent Events progress on POST /research/stream",
    "Server-side report persistence (GET /reports/{id})",
    "Per-run cost + duration telemetry",
]

# Browser-hardening headers applied to every response except the CSP-exempt
# interactive API documentation routes (Swagger UI / ReDoc load CDN assets).
_SECURITY_HEADERS: Final[dict[str, str]] = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "interest-cohort=()",
}

# Matches the frontend, which serves its own CSS/JS from /static only.
_CONTENT_SECURITY_POLICY: Final[str] = (
    "default-src 'self'; "
    "img-src 'self' data:; "
    "style-src 'self'; "
    "script-src 'self'; "
    "connect-src 'self'; "
    "base-uri 'none'; "
    "form-action 'self'; "
    "frame-ancestors 'none'"
)
_CSP_EXEMPT_PREFIXES: Final[tuple[str, ...]] = ("/docs", "/redoc", "/openapi.json")

_STATIC_CACHE_CONTROL: Final[str] = "public, max-age=3600"
_NO_STORE: Final[str] = "no-store"

# Load the environment once at import time (idempotent, existing process env
# wins) so that configuration-dependent reporting is deterministic even when
# the ASGI app is imported without the lifespan handler running.
load_dotenv(dotenv_path=ENV_FILE, override=False)


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #


def _read_project_version() -> str:
    """Return the project version from ``pyproject.toml`` (fallback: 0.1.0)."""
    try:
        with PYPROJECT_FILE.open("rb") as handle:
            data = tomllib.load(handle)
        version = data["project"]["version"]
        return str(version) if version else DEFAULT_VERSION
    except (OSError, KeyError, TypeError, tomllib.TOMLDecodeError):
        return DEFAULT_VERSION


def _configured_model_id() -> str:
    """Return the configured Groq model id, defaulting to GPT-OSS-120B."""
    return os.getenv("GROQ_MODEL", "").strip() or DEFAULT_MODEL_ID


def _env_present(var_name: str) -> bool:
    """Return whether an environment variable is set and non-blank.

    Only presence is ever inspected — values are never read into logs,
    responses, or templates.
    """
    return bool(os.getenv(var_name, "").strip())


def _utc_now_iso() -> str:
    """Return the current UTC time as ISO-8601 with a trailing ``Z``."""
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def _build_checks() -> list[dict[str, str]]:
    """Build the honest health check list from real environment presence.

    The pipeline check is always ``unavailable``: no agent graph is implemented.
    """
    model_id = _configured_model_id()
    llm_ok = _env_present("GROQ_API_KEY")
    research_ok = _env_present("TREG_API_KEY")

    return [
        {
            "id": "api",
            "label": "API",
            "state": "ok",
            "detail": "FastAPI host responding",
        },
        {
            "id": "llm",
            "label": "Language model",
            "state": "ok" if llm_ok else "degraded",
            "detail": (
                f"{model_id} configured via GROQ_MODEL"
                if llm_ok
                else "GROQ_API_KEY not configured"
            ),
        },
        {
            "id": "research",
            "label": "Research tools",
            "state": "ok" if research_ok else "degraded",
            "detail": (
                "Treg credentials configured"
                if research_ok
                else "TREG_API_KEY not configured"
            ),
        },
        {
            "id": "pipeline",
            "label": "Agent pipeline",
            "state": "unavailable",
            "detail": "LangGraph research pipeline is not implemented yet",
        },
    ]


def _health_payload() -> dict[str, Any]:
    """Build the complete, honest ``GET /health`` response body."""
    return {
        "status": "ok",
        "service": SERVICE_NAME,
        "version": _read_project_version(),
        "time": _utc_now_iso(),
        "model": {"id": _configured_model_id(), "provider": "Groq"},
        "checks": _build_checks(),
        "capabilities": {
            "research": False,
            "streaming": False,
            "history": False,
            "citations": False,
            "cost_reporting": False,
        },
        "limits": {
            "max_query_chars": MAX_QUERY_CHARS,
            "min_query_chars": MIN_QUERY_CHARS,
        },
    }


def _not_implemented_payload(code: str) -> dict[str, Any]:
    """Build the shared honest 501 body used by both research endpoints."""
    return {
        "detail": PIPELINE_UNAVAILABLE_DETAIL,
        "code": code,
        "required_capabilities": list(REQUIRED_PIPELINE_CAPABILITIES),
    }


def _is_csp_exempt(path: str) -> bool:
    """Return True for documentation routes that legitimately need CDN assets."""
    return path.startswith(_CSP_EXEMPT_PREFIXES)


def _apply_cache_headers(request: Request, response: Response) -> None:
    """Apply cache policy: HTML/JSON never cached, static assets cached briefly."""
    path = request.url.path
    content_type = response.headers.get("content-type", "")

    if path.startswith("/static") and response.status_code < 400:
        response.headers.setdefault("Cache-Control", _STATIC_CACHE_CONTROL)
    elif content_type.startswith(("text/html", "application/json")):
        response.headers.setdefault("Cache-Control", _NO_STORE)


# --------------------------------------------------------------------------- #
# Request models
# --------------------------------------------------------------------------- #


class ResearchRequest(BaseModel):
    """Body for ``POST /research`` (and, later, ``POST /research/stream``).

    Mirrors the frontend contract: a required query plus optional narrowing
    hints. Nothing is executed today — validation is wired so that a future
    pipeline receives a well-formed, bounded request.
    """

    query: str = Field(
        min_length=MIN_QUERY_CHARS,
        max_length=MAX_QUERY_CHARS,
        description=(
            "What to research, e.g. 'Find decision-makers at Notion who own "
            "developer tooling'."
        ),
        examples=["Find decision-makers at Notion who own developer tooling."],
    )
    company_name: str | None = Field(
        default=None,
        max_length=200,
        description="Optional company name to anchor the research.",
    )
    focus: str | None = Field(
        default=None,
        max_length=200,
        description="Optional focus area, e.g. 'pricing' or 'hiring'.",
    )

    @field_validator("query")
    @classmethod
    def _strip_and_validate_query(cls, value: str) -> str:
        """Trim the query and reject whitespace-only submissions."""
        stripped = value.strip()
        if len(stripped) < MIN_QUERY_CHARS:
            raise ValueError(
                f"query must contain at least {MIN_QUERY_CHARS} "
                "non-whitespace characters"
            )
        return stripped

    @field_validator("company_name", "focus")
    @classmethod
    def _normalise_optional_text(cls, value: str | None) -> str | None:
        """Trim optional strings and collapse blank ones to ``None``."""
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None


# --------------------------------------------------------------------------- #
# Application
# --------------------------------------------------------------------------- #


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Manage startup/shutdown state.

    Loads ``.env`` (existing process environment wins) and reports only the
    *presence* of credentials — never their values.
    """
    load_dotenv(dotenv_path=ENV_FILE, override=False)
    logger.info(
        "SalesIntel AI host starting | llm_configured=%s research_configured=%s "
        "pipeline=unavailable",
        _env_present("GROQ_API_KEY"),
        _env_present("TREG_API_KEY"),
    )
    try:
        yield
    finally:
        logger.info("SalesIntel AI host stopped")


app = FastAPI(
    title="SalesIntel AI API",
    description=(
        "FastAPI host for the SalesRadar sales-intelligence workspace.\n\n"
        "**Status:** the HTTP host and honest capability reporting are "
        "implemented. The LangGraph research pipeline is not: `POST /research` "
        "and `POST /research/stream` currently answer `501` with "
        "`code: \"pipeline_not_implemented\"` / `\"streaming_not_implemented\"`."
    ),
    version=_read_project_version(),
    lifespan=lifespan,
)

templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


# --------------------------------------------------------------------------- #
# Middleware
# --------------------------------------------------------------------------- #


@app.middleware("http")
async def security_and_cache_headers(request: Request, call_next: Any) -> Response:
    """Attach security and cache headers to every response.

    CSP is skipped for ``/docs``, ``/redoc`` and ``/openapi.json`` because
    Swagger UI and ReDoc load their assets from a CDN; the strict policy would
    break that interactive documentation. All application routes (including
    ``/`` and ``/health``) keep the strict ``default-src 'self'`` policy.
    """
    response = await call_next(request)
    for header_name, header_value in _SECURITY_HEADERS.items():
        response.headers.setdefault(header_name, header_value)
    if not _is_csp_exempt(request.url.path):
        response.headers.setdefault("Content-Security-Policy", _CONTENT_SECURITY_POLICY)
    _apply_cache_headers(request, response)
    return response


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #


@app.get("/", response_class=Response, tags=["ui"], summary="Research workspace UI")
async def index(request: Request) -> Response:
    """Render the single-page research workspace from ``templates/index.html``.

    No environment values are placed in the template context, so credentials can
    never leak into rendered HTML. If the template is missing the host answers
    with an honest ``503`` instead of an unhandled exception.
    """
    try:
        return templates.TemplateResponse(
            request=request,
            name="index.html",
            context={"request": request},
        )
    except TemplateNotFound:
        logger.error("templates/index.html is missing; UI cannot be rendered")
        return JSONResponse(
            status_code=503,
            content={
                "detail": "The UI template is not available on this deployment.",
                "code": "ui_template_missing",
            },
        )


@app.get("/health", tags=["health"], summary="Honest service health & capabilities")
async def health() -> dict[str, Any]:
    """Report real service health, configured model, and capability flags.

    ``checks`` reflect only the presence of credentials in the environment.
    ``capabilities`` are all ``false`` because the research pipeline, streaming,
    report persistence, citations and cost telemetry are not implemented.
    """
    return _health_payload()


@app.post("/research", tags=["research"], summary="Run research (not implemented)")
async def research(payload: ResearchRequest) -> Response:
    """Validate a research request and honestly report it cannot run yet.

    The body is fully validated (so the contract is executable today), then the
    endpoint returns ``501`` — never a fabricated run, report or citation.
    """
    logger.info(
        "POST /research rejected: pipeline not implemented "
        "(query_chars=%d, company_name=%s, focus=%s)",
        len(payload.query),
        bool(payload.company_name),
        bool(payload.focus),
    )
    return JSONResponse(
        status_code=501,
        content=_not_implemented_payload("pipeline_not_implemented"),
    )


@app.post(
    "/research/stream",
    tags=["research"],
    summary="Stream research progress over SSE (not implemented)",
)
async def research_stream(payload: ResearchRequest) -> Response:
    """Validate a streaming research request and return the honest 501.

    The frontend only calls this route when ``/health`` reports
    ``capabilities.streaming = true``, which it does not.
    """
    logger.info(
        "POST /research/stream rejected: streaming not implemented "
        "(query_chars=%d)",
        len(payload.query),
    )
    return JSONResponse(
        status_code=501,
        content=_not_implemented_payload("streaming_not_implemented"),
    )


@app.get("/favicon.ico", include_in_schema=False)
async def favicon() -> Response:
    """Serve a favicon without 404 noise.

    Redirects to ``/static/favicon.svg`` when the asset exists (the UI may add
    it), otherwise answers ``204 No Content``.
    """
    favicon_svg = STATIC_DIR / "favicon.svg"
    if favicon_svg.is_file():
        return RedirectResponse(url="/static/favicon.svg", status_code=307)
    return Response(status_code=204)


# Mount last so explicit routes above always win.
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.exception_handler(404)
async def not_found_handler(request: Request, exc: Any) -> JSONResponse:
    """Return a machine-readable JSON 404 instead of HTML for unknown paths."""
    return JSONResponse(
        status_code=404,
        content={
            "detail": "Not Found",
            "code": "not_found",
            "path": request.url.path,
        },
    )


# --------------------------------------------------------------------------- #
# Entrypoint
# --------------------------------------------------------------------------- #


if __name__ == "__main__":
    import uvicorn

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=False)
