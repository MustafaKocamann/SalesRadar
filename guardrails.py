"""Input, URL, and evidence guardrails for SalesRadar."""

import re
from urllib.parse import urlsplit

_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def valid_company(name: str) -> str:
    """Validate and normalise a company name (2-100 safe characters)."""
    name = name.strip()
    if not 2 <= len(name) <= 100 or not re.fullmatch(r"[\w .,&'()\-+]+", name):
        raise ValueError("Enter a company name (2–100 characters).")
    return name


def valid_query(query: str) -> str:
    """Validate and normalise a general research query (2-600 characters)."""
    cleaned = _CONTROL_CHARS_RE.sub("", query).strip()
    if not 2 <= len(cleaned) <= 600:
        raise ValueError("Enter a research query between 2 and 600 characters.")
    return cleaned


def safe_url(url: str) -> bool:
    """Return True only for public HTTPS URLs without embedded credentials."""
    try:
        p = urlsplit(url)
        host = p.hostname or ""
        return (
            p.scheme == "https"
            and "." in host
            and not p.username
            and not p.password
            and not re.fullmatch(r"[\d.]+", host)
            and not host.endswith((".local", ".internal", ".localhost"))
            and p.port in (None, 443)
        )
    except (ValueError, TypeError):
        return False


def public_data(value):
    """Remove common contact fields before passing evidence to a model."""
    if isinstance(value, dict):
        return {
            k: public_data(v)
            for k, v in value.items()
            if not any(
                s in k.lower()
                for s in ("email", "phone", "mobile", "address", "contact", "password", "token")
            )
        }
    if isinstance(value, list):
        return [public_data(v) for v in value[:15]]
    if isinstance(value, str):
        return re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[redacted]", value)[:10000]
    return value
