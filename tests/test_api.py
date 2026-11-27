"""Contract tests for the SalesRadar FastAPI host, guardrails, and pipeline wiring."""

from __future__ import annotations

import json
import os
import re
import sys
import traceback
from pathlib import Path
from typing import Any, Callable
from unittest.mock import patch

# Allow `python tests/test_api.py` from the project root.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from fastapi.testclient import TestClient  # noqa: E402

import main as app_module  # noqa: E402
from graph import run_research  # noqa: E402
from guardrails import public_data, safe_url, valid_company, valid_query  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)

EXPECTED_CHECK_IDS: list[str] = ["api", "llm", "research", "pipeline"]
REQUIRED_HEADERS: dict[str, str] = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-frame-options": "DENY",
    "permissions-policy": "interest-cohort=()",
}


def _fake_run_result(
    query: str,
    *,
    company_name: str | None = None,
    focus: str | None = None,
    demo: bool = False,
    on_event: Any = None,
) -> dict[str, Any]:
    if on_event is not None:
        on_event({"event": "stage", "stage": "web", "state": "running", "detail": "Searching"})
        on_event({"event": "stage", "stage": "web", "state": "complete", "detail": "Done", "duration_ms": 12})
    return run_research(
        query,
        company_name=company_name,
        focus=focus,
        demo=True,
        on_event=on_event,
    )


# --------------------------------------------------------------------------- #
# Test cases
# --------------------------------------------------------------------------- #


def test_index_renders_html() -> None:
    """`GET /` renders the workspace template with HTML and no-store caching."""
    response = client.get("/")
    assert response.status_code == 200, response.status_code
    assert response.headers["content-type"].startswith("text/html")
    assert "SalesRadar" in response.text
    assert response.headers["cache-control"] == "no-store"


def test_index_headers() -> None:
    """`GET /` carries the full strict security header set."""
    headers = client.get("/").headers
    for name, value in REQUIRED_HEADERS.items():
        assert headers[name] == value, name
    csp = headers["content-security-policy"]
    assert "default-src 'self'" in csp
    assert "frame-ancestors 'none'" in csp


def test_health_shape_reflects_env() -> None:
    """`GET /health` returns real env status and matching capabilities."""
    with patch.dict(os.environ, {"GROQ_API_KEY": "test-groq", "TREG_API_KEY": "test-treg"}):
        response = client.get("/health")
    assert response.status_code == 200
    body: dict[str, Any] = response.json()

    assert body["status"] == "ok"
    assert body["service"] == "salesradar"
    assert isinstance(body["version"], str) and body["version"]
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", body["time"])

    assert body["model"]["provider"] == "Groq"
    assert isinstance(body["model"]["id"], str) and body["model"]["id"]

    checks = {check["id"]: check for check in body["checks"]}
    assert list(checks) == EXPECTED_CHECK_IDS
    for check in checks.values():
        assert set(check) == {"id", "label", "state", "detail"}
        assert check["state"] in {"ok", "degraded", "unavailable"}
    assert checks["api"]["state"] == "ok"
    assert checks["pipeline"]["state"] == "ok"

    assert body["capabilities"] == {
        "research": True,
        "streaming": True,
        "history": False,
        "citations": True,
        "cost_reporting": True,
    }
    assert body["limits"] == {"max_query_chars": 600, "min_query_chars": 2}
    assert response.headers["cache-control"] == "no-store"


def test_health_degraded_without_keys() -> None:
    """`GET /health` reports degraded and false capabilities when keys are absent."""
    with patch.dict(os.environ, {"GROQ_API_KEY": "", "TREG_API_KEY": ""}):
        response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    checks = {check["id"]: check for check in body["checks"]}
    assert checks["llm"]["state"] == "degraded"
    assert checks["research"]["state"] == "degraded"
    assert checks["pipeline"]["state"] == "degraded"
    assert body["capabilities"]["research"] is False
    assert body["capabilities"]["streaming"] is False


def test_health_never_leaks_secrets() -> None:
    """Health output must never echo credential values."""
    body = client.get("/health").text
    assert "GROQ_API_KEY" not in body or "not configured" in body
    assert "TREG_API_KEY" not in body or "not configured" in body
    assert "gsk_" not in body


def test_research_returns_503_when_unconfigured() -> None:
    """`POST /research` answers 503 when credentials are missing."""
    with patch.dict(os.environ, {"GROQ_API_KEY": "", "TREG_API_KEY": ""}):
        response = client.post("/research", json={"query": "Huawei"})
    assert response.status_code == 503, response.status_code
    body = response.json()
    assert body["code"] == "pipeline_not_configured"


def test_research_runs_pipeline_contract() -> None:
    """`POST /research` returns the normalised RunResult contract."""
    with (
        patch.dict(os.environ, {"GROQ_API_KEY": "test-groq", "TREG_API_KEY": "test-treg"}),
        patch.object(app_module, "run_research", side_effect=_fake_run_result),
    ):
        response = client.post(
            "/research",
            json={"query": "Huawei", "focus": "decision-makers"},
        )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "complete"
    assert body["company"]["name"] == "Huawei"
    assert body["focus"] == "decision-makers"
    assert "DEMO ONLY" in body["report"]
    assert len(body["stages"]) == 4
    assert "cost_usd" in body["usage"]
    assert "duration_ms" in body["usage"]


def test_stream_emits_sse_events() -> None:
    """`POST /research/stream` streams stage events and a final done payload."""
    with (
        patch.dict(os.environ, {"GROQ_API_KEY": "test-groq", "TREG_API_KEY": "test-treg"}),
        patch.object(app_module, "run_research", side_effect=_fake_run_result),
    ):
        response = client.post("/research/stream", json={"query": "Stripe"})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/event-stream")
    events: list[dict[str, Any]] = []
    for line in response.text.splitlines():
        if line.startswith("data: "):
            events.append(json.loads(line[6:]))
    assert any(ev.get("event") == "stage" for ev in events)
    done_events = [ev for ev in events if ev.get("event") == "done"]
    assert len(done_events) == 1
    assert done_events[0]["result"]["company"]["name"] == "Stripe"


def test_research_rejects_invalid_bodies() -> None:
    """Pydantic rejects malformed bodies with 422."""
    invalid_payloads: list[dict[str, Any]] = [
        {},
        {"query": ""},
        {"query": "a"},
        {"query": "  "},
        {"query": "x" * 601},
    ]
    for payload in invalid_payloads:
        status = client.post("/research", json=payload).status_code
        assert status == 422, f"{payload!r} -> {status}"


def test_guardrails_helpers() -> None:
    """Guardrail helpers validate inputs, HTTPS URLs, and strip PII."""
    assert valid_company("  Stripe, Inc. ") == "Stripe, Inc."
    assert valid_query("Who are the decision-makers at Stripe?") == "Who are the decision-makers at Stripe?"
    assert safe_url("https://stripe.com/docs") is True
    assert safe_url("http://stripe.com") is False
    assert safe_url("https://127.0.0.1/admin") is False
    assert safe_url("https://user:pass@stripe.com") is False
    cleaned = public_data({"name": "Ada", "email": "ada@example.com", "bio": "Reach ada@example.com"})
    assert "email" not in cleaned
    assert cleaned["bio"] == "Reach [redacted]"


def test_docs_available_and_csp_exempt() -> None:
    """Swagger UI stays reachable and is exempt from the strict CSP."""
    response = client.get("/docs")
    assert response.status_code == 200
    assert "swagger-ui" in response.text
    assert "content-security-policy" not in response.headers
    assert response.headers["x-frame-options"] == "DENY"

    openapi = client.get("/openapi.json")
    assert openapi.status_code == 200
    assert "content-security-policy" not in openapi.headers


def test_unknown_path_returns_json_404() -> None:
    """Unknown paths return a machine-readable JSON 404."""
    response = client.get("/does-not-exist")
    assert response.status_code == 404
    body = response.json()
    assert body["code"] == "not_found"
    assert body["path"] == "/does-not-exist"


def test_static_mount_serves_existing_assets() -> None:
    """The `/static` mount resolves real files with a cache header."""
    static_dir = PROJECT_ROOT / "static"
    assets = sorted(path for path in static_dir.rglob("*") if path.is_file())
    assert assets, "static/ contains no files to probe the /static mount with"

    relative = assets[0].relative_to(static_dir).as_posix()
    response = client.get(f"/static/{relative}")
    assert response.status_code == 200, relative
    assert response.headers["cache-control"] == "public, max-age=3600"
    assert response.headers["x-content-type-options"] == "nosniff"


def test_static_missing_asset_is_404() -> None:
    """A missing static asset is a clean 404, not a crash."""
    assert client.get("/static/definitely-not-a-file.css").status_code == 404


def test_favicon_is_not_a_noisy_404() -> None:
    """`/favicon.ico` answers 204 or a redirect, never 404."""
    response = client.get("/favicon.ico", follow_redirects=False)
    assert response.status_code in {204, 307}


def test_openapi_documents_research_endpoints() -> None:
    """The OpenAPI schema advertises the real routes."""
    schema = client.get("/openapi.json").json()
    assert "/health" in schema["paths"]
    assert "/research" in schema["paths"]
    assert "/research/stream" in schema["paths"]


# --------------------------------------------------------------------------- #
# Minimal runner
# --------------------------------------------------------------------------- #


def main() -> int:
    """Run every ``test_*`` function in this module and report results."""
    tests: list[Callable[[], None]] = [
        value
        for name, value in sorted(globals().items())
        if name.startswith("test_") and callable(value)
    ]
    failures: list[tuple[str, str]] = []

    for test in tests:
        try:
            test()
        except Exception:  # noqa: BLE001 - a failing test must not stop the run
            failures.append((test.__name__, traceback.format_exc()))
            print(f"FAIL {test.__name__}")
        else:
            print(f"ok   {test.__name__}")

    print(f"\n{len(tests) - len(failures)}/{len(tests)} passed")
    for name, detail in failures:
        print(f"\n--- {name} ---\n{detail}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
