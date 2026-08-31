"""Codec version negotiation: client-side surface for the v0.4 wire contract.

Mirror of `packages/web/src/version-signaling.ts` and the engine-side
`sglang.srt.entrypoints.codec_version` from the patched sglang fork.

See `spec/versions/v0.4.md`:

  - § Version Compatibility Signaling (Codec-Client-Version, 426 path)
  - § Capabilities are opt-on at the server (two-stage)
  - § Graceful downgrade (response shaping)

Typical usage::

    import httpx
    from codecai.version_signaling import (
        with_codec_client_version,
        parse_version_required,
        CodecVersionRequiredError,
    )

    async with httpx.AsyncClient() as client:
        resp = await client.post(url, json=body,
                                 headers=with_codec_client_version({}))
        if resp.status_code == 426:
            err = parse_version_required(resp)
            raise err  # CodecVersionRequiredError
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Protocol


# The protocol version this package speaks. Bumped when the package
# implements support for a new minor protocol version.
CODEC_CLIENT_VERSION = "0.4"

#: Request header name (canonical case).
CODEC_CLIENT_VERSION_HEADER = "Codec-Client-Version"

#: Response header name; advisory on 2xx, load-bearing on 426.
CODEC_MIN_VERSION_HEADER = "Codec-Min-Version"

#: Response header name; emitted on 426.
CODEC_REQUIRED_FEATURES_HEADER = "Codec-Required-Features"


# ── Outbound: stamp the client version on requests ──────────────────────────


def with_codec_client_version(
    headers: Optional[Mapping[str, str]] = None,
    override_version: Optional[str] = None,
) -> dict[str, str]:
    """Return a new headers dict with ``Codec-Client-Version`` set.

    If the caller already passed the header, it's left alone: useful for
    test harnesses that want to simulate a v0.3 client. Otherwise the
    package constant ``CODEC_CLIENT_VERSION`` is set.
    """
    out: dict[str, str] = dict(headers or {})
    # Header-name lookup is case-insensitive on the HTTP wire but Python
    # dicts are case-sensitive; check both common casings.
    if CODEC_CLIENT_VERSION_HEADER not in out and CODEC_CLIENT_VERSION_HEADER.lower() not in {
        k.lower() for k in out
    }:
        out[CODEC_CLIENT_VERSION_HEADER] = override_version or CODEC_CLIENT_VERSION
    return out


# ── Inbound: structured 426 response ────────────────────────────────────────


@dataclass(frozen=True)
class CodecVersionRequiredBody:
    """Shape of the JSON body on a v0.4 server's 426 response.

    Pre-v0.4 clients that parse this as a generic JSON error can still
    render ``error`` + ``minimum_version`` as a string: the structure
    degrades gracefully.
    """

    error: str  # always "codec_version_required" for valid bodies
    minimum_version: str
    required_features: tuple[str, ...]
    client_version: str
    docs_url: Optional[str] = None
    deployment_id: Optional[str] = None


class CodecVersionRequiredError(Exception):
    """Raised when a v0.4-mandating server refuses with a 426.

    Carries the structured fields so application code can render an
    upgrade prompt or take corrective action.
    """

    def __init__(self, body: CodecVersionRequiredBody) -> None:
        features = (
            f" (requires: {', '.join(body.required_features)})"
            if body.required_features
            else ""
        )
        docs = f" See {body.docs_url}" if body.docs_url else ""
        super().__init__(
            f"Codec server requires v{body.minimum_version}{features}; "
            f"this client speaks v{body.client_version}.{docs}".strip()
        )
        self.minimum_version = body.minimum_version
        self.required_features = body.required_features
        self.client_version = body.client_version
        self.docs_url = body.docs_url
        self.deployment_id = body.deployment_id
        self.body = body


class _RespLike(Protocol):
    """Duck-typed response interface: works with httpx.Response,
    requests.Response, urllib3.HTTPResponse-with-body, or any object
    exposing ``status_code`` + ``content``/``text``/``json()``."""

    status_code: int

    def json(self) -> Any: ...

    @property
    def text(self) -> str: ...


def parse_version_required(resp: _RespLike) -> Optional[CodecVersionRequiredError]:
    """Parse a 426 Upgrade Required response into a typed error.

    Returns ``None`` if the response is not a 426: caller continues with
    its usual response handling. Returns a ``CodecVersionRequiredError``
    instance ready to ``raise`` when it is a 426 with a valid v0.4 body.

    Raises ``ValueError`` if the response is 426 but the body isn't a
    recognized v0.4 shape: never silently swallows a 426.
    """
    if resp.status_code != 426:
        return None

    # Try the JSON body. Read text first so a non-JSON body can be
    # surfaced in the error message.
    text = resp.text if isinstance(resp.text, str) else str(resp.text)
    try:
        raw = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        raise ValueError(
            f"Codec server returned 426 Upgrade Required but body was not JSON: "
            f"{text[:200]}"
        )

    if not _is_version_required_body(raw):
        raise ValueError(
            f"Codec server returned 426 Upgrade Required with an unrecognized body: "
            f"{text[:200]}"
        )

    body = CodecVersionRequiredBody(
        error=raw["error"],
        minimum_version=raw["minimum_version"],
        required_features=tuple(raw["required_features"]),
        client_version=raw["client_version"],
        docs_url=raw.get("docs_url"),
        deployment_id=raw.get("deployment_id"),
    )
    return CodecVersionRequiredError(body)


def _is_version_required_body(raw: Any) -> bool:
    if not isinstance(raw, dict):
        return False
    return (
        raw.get("error") == "codec_version_required"
        and isinstance(raw.get("minimum_version"), str)
        and isinstance(raw.get("client_version"), str)
        and isinstance(raw.get("required_features"), list)
        and all(isinstance(v, str) for v in raw["required_features"])
    )


# ── Pre-flight: well-known/codec/version-policy.json ────────────────────────


@dataclass(frozen=True)
class CodecVersionPolicyDocument:
    """Shape of ``.well-known/codec/version-policy.json``.

    Returned by deployments that mandate v0.4+ features. Deployments
    without mandatory features SHOULD NOT publish this document.
    """

    minimum_version: str
    required_features: tuple[str, ...]
    deployment_id: Optional[str] = None
    docs_url: Optional[str] = None
    valid_until: Optional[str] = None


def parse_version_policy_document(raw: Any) -> CodecVersionPolicyDocument:
    """Validate and parse a version-policy.json body."""
    if not isinstance(raw, dict):
        raise ValueError(f"version-policy doc is not a JSON object: {type(raw).__name__}")
    if not isinstance(raw.get("minimum_version"), str):
        raise ValueError("version-policy doc missing/invalid `minimum_version`")
    rf = raw.get("required_features")
    if not isinstance(rf, list) or not all(isinstance(v, str) for v in rf):
        raise ValueError("version-policy doc has malformed `required_features`")
    return CodecVersionPolicyDocument(
        minimum_version=raw["minimum_version"],
        required_features=tuple(rf),
        deployment_id=raw.get("deployment_id"),
        docs_url=raw.get("docs_url"),
        valid_until=raw.get("valid_until"),
    )


def well_known_version_policy_url(origin: str) -> str:
    """Build the well-known URL for an origin."""
    return f"{origin.rstrip('/')}/.well-known/codec/version-policy.json"


async def discover_version_policy(
    origin: str,
    *,
    client: Any = None,  # httpx.AsyncClient | None
) -> Optional[CodecVersionPolicyDocument]:
    """Pre-flight fetch of the deployment's minimum-version policy.

    Returns the parsed document when the well-known path exists, or
    ``None`` when the server returns 404 (the normal state for an
    unrestricted deployment). Raises on non-404 errors or malformed
    body: never silently skips.

    Defaults to httpx. Pass any object with an async ``get(url, headers)``
    that returns something with ``status_code`` + ``json()`` to use a
    different transport (e.g. aiohttp, custom fetch).
    """
    url = well_known_version_policy_url(origin)
    headers = with_codec_client_version()

    if client is None:
        import httpx  # local import: keep httpx optional at import time

        async with httpx.AsyncClient() as c:
            resp = await c.get(url, headers=headers)
    else:
        resp = await client.get(url, headers=headers)

    if resp.status_code == 404:
        return None
    if resp.status_code >= 400:
        raise RuntimeError(f"Failed to fetch version policy from {url}: HTTP {resp.status_code}")

    return parse_version_policy_document(resp.json())
