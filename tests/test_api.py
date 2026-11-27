"""Contract tests for the SalesIntel AI FastAPI host (dependency-free).

``pytest`` is not installed in this project and adding dependencies is out of
scope, so this module is a plain-Python test runner built on FastAPI's
``TestClient`` (backed by the already-installed ``httpx``).

Run with::

    .venv\\Scripts\\python.exe tests\\test_api.py

It exits non-zero and prints every failure if any assertion does not hold.
The assertions encode the *honest* contract: real health reporting and explicit
501s — never fabricated research output.
"""

from __future__ import annotations

import re
import sys
import traceback
from pathlib import Path
from typing import Any, Callable

# Allow `python tests/test_api.py` from the project root.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402

client = TestClient(app)

EXPECTED_CAPABILITIES: dict[str, bool] = {
    "research": False,
    "streaming": False,
    "history": False,
    "citations": False,
    "cost_reporting": False,
}
EXPECTED_CHECK_IDS: list[str] = ["api", "llm", "research", "pipeline"]
REQUIRED_HEADERS: dict[str, str] = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-frame-options": "DENY",
    "permissions-policy": "interest-cohort=()",
}


# --------------------------------------------------------------------------- #
# Test cases
# --------------------------------------------------------------------------- #


def test_index_renders_html() -> None:
    """`GET /` renders the workspace template with HTML and no-store caching."""
    response = client.get("/")
    assert response.status_code == 200, response.status_code
    assert response.headers["content-type"].startswith("text/html")
    assert "SalesIntel" in response.text
    assert response.headers["cache-control"] == "no-store"


def test_index_headers() -> None:
    """`GET /` carries the full strict security header set."""
    headers = client.get("/").headers
    for name, value in REQUIRED_HEADERS.items():
        assert headers[name] == value, name
    csp = headers["content-security-policy"]
    assert "default-src 'self'" in csp
    assert "frame-ancestors 'none'" in csp


def test_health_shape() -> None:
    """`GET /health` returns the full honest shape the UI relies on."""
    response = client.get("/health")
    assert response.status_code == 200
    body: dict[str, Any] = response.json()

    assert body["status"] == "ok"
    assert body["service"] == "salesintel-ai"
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
    assert checks["pipeline"]["state"] == "unavailable"

    assert body["capabilities"] == EXPECTED_CAPABILITIES
    assert body["limits"] == {"max_query_chars": 600, "min_query_chars": 2}
    assert response.headers["cache-control"] == "no-store"


def test_health_never_leaks_secrets() -> None:
    """Health output must never echo credential values."""
    body = client.get("/health").text
    assert "GROQ_API_KEY" not in body
    assert "TREG_API_KEY" not in body
    assert "gsk_" not in body


def test_research_returns_honest_501() -> None:
    """`POST /research` answers 501 with a machine-readable code."""
    response = client.post("/research", json={"query": "Research Notion GTM"})
    assert response.status_code == 501, response.status_code
    body = response.json()
    assert body["code"] == "pipeline_not_implemented"
    assert body["detail"].startswith("The research pipeline is not implemented")
    assert len(body["required_capabilities"]) == 4
    assert response.headers["cache-control"] == "no-store"
    for forbidden in ("report", "citations", "stages", "usage", "cost"):
        assert forbidden not in body


def test_stream_returns_honest_501() -> None:
    """`POST /research/stream` answers 501 with the streaming code."""
    response = client.post("/research/stream", json={"query": "Research Notion GTM"})
    assert response.status_code == 501, response.status_code
    body = response.json()
    assert body["code"] == "streaming_not_implemented"
    assert len(body["required_capabilities"]) == 4


def test_research_rejects_invalid_bodies() -> None:
    """Pydantic rejects malformed bodies with 422, not a fake success."""
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


def test_research_accepts_full_contract_body() -> None:
    """All optional contract fields are accepted (still 501, never fabricated)."""
    response = client.post(
        "/research",
        json={
            "query": "Find decision-makers at Notion who own developer tooling",
            "company_name": "Notion",
            "focus": "developer tooling",
        },
    )
    assert response.status_code == 501


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
    """The `/static` mount resolves real files with a cache header.

    The asset is discovered dynamically because `static/` is owned and rewritten
    by the frontend team.
    """
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
