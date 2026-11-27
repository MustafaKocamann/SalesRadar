"""SalesRadar — FastAPI host for the SalesRadar research workspace.

Connects the contract-first frontend (`templates/index.html` + `static/`) to
the LangGraph multi-agent research pipeline (`graph.py`, `guardrails.py`,
`treg_tools.py`).

Run locally::

    .venv\\Scripts\\python.exe main.py
    # or: .venv\\Scripts\\python.exe -m uvicorn main:app --port 8000
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tomllib
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Final

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from jinja2 import TemplateNotFound
from pydantic import BaseModel, Field, field_validator

from graph import run_research

logger = logging.getLogger("salesradar")

# --------------------------------------------------------------------------- #
# Paths, constants
# --------------------------------------------------------------------------- #

BASE_DIR: Final[Path] = Path(__file__).resolve().parent
TEMPLATES_DIR: Final[Path] = BASE_DIR / "templates"
STATIC_DIR: Final[Path] = BASE_DIR / "static"
ENV_FILE: Final[Path] = BASE_DIR / ".env"
PYPROJECT_FILE: Final[Path] = BASE_DIR / "pyproject.toml"

SERVICE_NAME: Final[str] = "salesradar"
DEFAULT_VERSION: Final[str] = "0.1.0"
DEFAULT_MODEL_ID: Final[str] = "openai/gpt-oss-120b"

MIN_QUERY_CHARS: Final[int] = 2
MAX_QUERY_CHARS: Final[int] = 600

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


def _pipeline_ready() -> bool:
    """Return True when both LLM and Treg credentials are configured."""
    return _env_present("GROQ_API_KEY") and _env_present("TREG_API_KEY")


def _utc_now_iso() -> str:
    """Return the current UTC time as ISO-8601 with a trailing ``Z``."""
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def _build_checks() -> list[dict[str, str]]:
    """Build the honest health check list from real environment presence."""
    model_id = _configured_model_id()
    llm_ok = _env_present("GROQ_API_KEY")
    research_ok = _env_present("TREG_API_KEY")
    pipeline_ok = llm_ok and research_ok

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
            "state": "ok" if pipeline_ok else "degraded",
            "detail": (
                "LangGraph multi-agent pipeline ready"
                if pipeline_ok
                else "Requires GROQ_API_KEY and TREG_API_KEY"
            ),
        },
    ]


def _health_payload() -> dict[str, Any]:
    """Build the complete, honest ``GET /health`` response body."""
    ready = _pipeline_ready()
    return {
        "status": "ok",
        "service": SERVICE_NAME,
        "version": _read_project_version(),
        "time": _utc_now_iso(),
        "model": {"id": _configured_model_id(), "provider": "Groq"},
        "checks": _build_checks(),
        "capabilities": {
            "research": ready,
            "streaming": ready,
            "history": False,
            "citations": ready,
            "cost_reporting": ready,
        },
        "limits": {
            "max_query_chars": MAX_QUERY_CHARS,
            "min_query_chars": MIN_QUERY_CHARS,
        },
    }


def _not_configured_response() -> JSONResponse:
    """Return an explicit 503 when required API credentials are absent."""
    missing: list[str] = []
    if not _env_present("GROQ_API_KEY"):
        missing.append("GROQ_API_KEY")
    if not _env_present("TREG_API_KEY"):
        missing.append("TREG_API_KEY")
    return JSONResponse(
        status_code=503,
        content={
            "detail": (
                "The research pipeline requires credentials that are not configured: "
                + ", ".join(missing)
            ),
            "code": "pipeline_not_configured",
            "required_capabilities": [f"Configure {name} in .env" for name in missing],
        },
    )


def _is_csp_exempt(path: str) -> bool:
    """Return True for documentation routes that legitimately need CDN assets."""
    return path.startswith(_CSP_EXEMPT_PREFIXES)


def _apply_cache_headers(request: Request, response: Response) -> None:
    """Apply cache policy: HTML/JSON/SSE never cached, static assets cached briefly."""
    path = request.url.path
    content_type = response.headers.get("content-type", "")

    if path.startswith("/static") and response.status_code < 400:
        response.headers.setdefault("Cache-Control", _STATIC_CACHE_CONTROL)
    elif content_type.startswith(("text/html", "application/json", "text/event-stream")):
        response.headers.setdefault("Cache-Control", _NO_STORE)


# --------------------------------------------------------------------------- #
# Request models
# --------------------------------------------------------------------------- #


class ResearchRequest(BaseModel):
    """Body for ``POST /research`` and ``POST /research/stream``."""

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
        "SalesRadar host starting | llm_configured=%s research_configured=%s "
        "pipeline_ready=%s",
        _env_present("GROQ_API_KEY"),
        _env_present("TREG_API_KEY"),
        _pipeline_ready(),
    )
    try:
        yield
    finally:
        logger.info("SalesRadar host stopped")


app = FastAPI(
    title="SalesRadar API",
    description=(
        "FastAPI host for the SalesRadar multi-agent sales-intelligence workspace."
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
    """Attach security and cache headers to every response."""
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
    """Render the single-page research workspace from ``templates/index.html``."""
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
    """Report real service health, configured model, and capability flags."""
    return _health_payload()


@app.post("/research", tags=["research"], summary="Run multi-agent sales research")
async def research(payload: ResearchRequest) -> Response:
    """Run the 4-agent LangGraph research pipeline and return a ``RunResult``."""
    if not _pipeline_ready():
        return _not_configured_response()

    logger.info(
        "POST /research started (query_chars=%d, company_name=%s, focus=%s)",
        len(payload.query),
        bool(payload.company_name),
        bool(payload.focus),
    )
    try:
        result = await asyncio.to_thread(
            run_research,
            payload.query,
            company_name=payload.company_name,
            focus=payload.focus,
            demo=False,
        )
    except ValueError as exc:
        return JSONResponse(
            status_code=422,
            content={"detail": str(exc), "code": "invalid_input"},
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("POST /research failed: %s", type(exc).__name__)
        return JSONResponse(
            status_code=502,
            content={
                "detail": str(exc) or "Research pipeline execution failed.",
                "code": "pipeline_failed",
            },
        )

    return JSONResponse(status_code=200, content=result)


@app.post(
    "/research/stream",
    tags=["research"],
    summary="Stream research progress over SSE",
)
async def research_stream(payload: ResearchRequest) -> Response:
    """Run the research pipeline and stream stage/completion events over SSE."""
    if not _pipeline_ready():
        return _not_configured_response()

    logger.info(
        "POST /research/stream started (query_chars=%d, company_name=%s, focus=%s)",
        len(payload.query),
        bool(payload.company_name),
        bool(payload.focus),
    )

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()

    def on_event(event: dict[str, Any]) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, event)

    async def worker() -> None:
        try:
            result = await asyncio.to_thread(
                run_research,
                payload.query,
                company_name=payload.company_name,
                focus=payload.focus,
                demo=False,
                on_event=on_event,
            )
            await queue.put({"event": "done", "result": result})
        except ValueError as exc:
            await queue.put({"event": "error", "code": "invalid_input", "detail": str(exc)})
        except Exception as exc:  # noqa: BLE001
            logger.exception("POST /research/stream failed: %s", type(exc).__name__)
            await queue.put(
                {
                    "event": "error",
                    "code": "pipeline_failed",
                    "detail": str(exc) or "Research pipeline execution failed.",
                }
            )
        finally:
            await queue.put(None)

    task = asyncio.create_task(worker())

    async def event_stream() -> AsyncIterator[str]:
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                event_name = str(item.get("event") or "message")
                yield f"event: {event_name}\ndata: {json.dumps(item, ensure_ascii=False)}\n\n"
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": _NO_STORE,
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/favicon.ico", include_in_schema=False)
async def favicon() -> Response:
    """Serve a favicon without 404 noise."""
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
