"""Map discovery via the ``.well-known/codec/`` convention.

Given an HTTPS origin and a Codec map ID, fetch the per-map document at::

    <origin>/.well-known/codec/maps/<id>.json

and return a verified :class:`TokenizerMap`. The document is one of two shapes
(the loader auto-detects):

  * **Pointer**: ``{"id", "url", "hash"}`` referencing the actual map JSON.
  * **Inline**: the full :class:`TokenizerMap` directly.

See ``spec/WELL_KNOWN_DISCOVERY.md`` for the full convention.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

import httpx

from .map_loader import load_map
from .types import MapCache, TokenizerMap, validate

WELL_KNOWN_BASE = "/.well-known/codec"
"""Fixed base path under which Codec discovery documents live."""

_VALID_ID_RE = re.compile(r"^[a-z0-9._/\-]+$")
_HASH_RE = re.compile(r"^sha256:[0-9a-fA-F]{64}$")


def well_known_map_url(origin: str, id: str) -> str:
    """Per-map document URL for an origin + id."""
    return f"{_strip_trailing_slash(origin)}{WELL_KNOWN_BASE}/maps/{_encode_map_id(id)}.json"


def well_known_index_url(origin: str) -> str:
    """Index document URL for an origin."""
    return f"{_strip_trailing_slash(origin)}{WELL_KNOWN_BASE}/index.json"


def _strip_trailing_slash(s: str) -> str:
    return s[:-1] if s.endswith("/") else s


def _encode_map_id(id: str) -> str:
    """Validate the map id and return the URL-safe form (slashes preserved)."""
    if not _VALID_ID_RE.match(id):
        raise MapDiscoveryError(
            f"Invalid map id {id!r}: must match [a-z0-9._/-]+"
        )
    if ".." in id or id.startswith("/") or id.endswith("/"):
        raise MapDiscoveryError(
            f"Invalid map id {id!r}: path traversal or empty segment"
        )
    return id


# ── Errors ──────────────────────────────────────────────────────────────────


class MapDiscoveryError(ValueError):
    """Raised when a discovery document is malformed or absent."""


class MapDiscoveryNotFoundError(MapDiscoveryError):
    """Raised when ``.well-known/codec/...`` returns 404."""

    def __init__(self, url: str, status: int) -> None:
        super().__init__(f"No map document at {url} (HTTP {status})")
        self.url = url
        self.status = status


# ── Pointer / index dataclasses ─────────────────────────────────────────────


@dataclass(frozen=True)
class MapPointer:
    """Pointer document at ``.well-known/codec/maps/<id>.json`` (Form A)."""

    id: str
    url: str
    hash: str
    published_at: str | None = None


@dataclass(frozen=True)
class MapIndex:
    """Directory document at ``.well-known/codec/index.json``."""

    codec_version: str
    maps: tuple[MapPointer, ...]


def _is_pointer_shape(obj: Any) -> bool:
    return (
        isinstance(obj, dict)
        and isinstance(obj.get("id"), str)
        and isinstance(obj.get("url"), str)
        and isinstance(obj.get("hash"), str)
        # Inline maps always carry vocab/tokens; pointers never do.
        and "vocab" not in obj
        and "tokens" not in obj
    )


def _validate_pointer(obj: dict[str, Any], expected_id: str) -> MapPointer:
    if obj["id"] != expected_id:
        raise MapDiscoveryError(
            f"Pointer id {obj['id']!r} does not match requested id {expected_id!r}"
        )
    url = obj["url"]
    if not (url.startswith("https://") or url.startswith("http://")):
        raise MapDiscoveryError(f"Pointer url must be http(s): got {url!r}")
    if not _HASH_RE.match(obj["hash"]):
        raise MapDiscoveryError(
            f"Pointer hash must be sha256:<64 hex chars>: got {obj['hash']!r}"
        )
    return MapPointer(
        id=obj["id"],
        url=url,
        hash=obj["hash"],
        published_at=obj.get("published_at"),
    )


# ── Public API ──────────────────────────────────────────────────────────────


async def discover_map(
    *,
    origin: str,
    id: str,
    cache: MapCache | None = None,
    client: httpx.AsyncClient | None = None,
    timeout: float = 30.0,
) -> TokenizerMap:
    """Resolve a tokenizer map via the ``.well-known/codec/`` convention.

    Fetches ``<origin>/.well-known/codec/maps/<id>.json``, then either follows
    the pointer's ``url`` and verifies its bytes hash to ``hash`` (Form A), or
    validates and returns the inline map directly (Form B).

    Example::

        from codecai import discover_map

        m = await discover_map(origin="https://qwen.io", id="qwen/qwen2")

    Raises :class:`MapDiscoveryNotFoundError` for HTTP 404,
    :class:`MapDiscoveryError` for malformed pointers, and
    :class:`TokenizerMapHashMismatchError` if the CDN bytes don't match the
    pointer hash.
    """
    url = well_known_map_url(origin, id)
    own_client = client is None
    used_client = client or httpx.AsyncClient(timeout=timeout, follow_redirects=True)
    try:
        resp = await used_client.get(url)
        if resp.status_code == 404:
            raise MapDiscoveryNotFoundError(url, resp.status_code)
        resp.raise_for_status()
        body = resp.content
    finally:
        if own_client:
            await used_client.aclose()

    parsed = json.loads(body)
    if _is_pointer_shape(parsed):
        pointer = _validate_pointer(parsed, id)
        return await load_map(
            url=pointer.url,
            hash=pointer.hash,
            cache=cache,
            client=client,
            cache_key=f"well-known:{origin}#{id}#{pointer.hash}",
            timeout=timeout,
        )

    # Otherwise: inline TokenizerMap. Validate, sanity-check id, return.
    validate(parsed)
    if parsed.get("id") != id:
        raise MapDiscoveryError(
            f"Inline map id {parsed.get('id')!r} does not match requested id {id!r}"
        )
    return TokenizerMap.from_json(parsed)


async def discover_index(
    *,
    origin: str,
    client: httpx.AsyncClient | None = None,
    timeout: float = 30.0,
) -> MapIndex:
    """Fetch the optional ``.well-known/codec/index.json`` directory document.

    Raises :class:`MapDiscoveryNotFoundError` if the origin doesn't publish one.
    """
    url = well_known_index_url(origin)
    own_client = client is None
    used_client = client or httpx.AsyncClient(timeout=timeout, follow_redirects=True)
    try:
        resp = await used_client.get(url)
        if resp.status_code == 404:
            raise MapDiscoveryNotFoundError(url, resp.status_code)
        resp.raise_for_status()
        body = resp.content
    finally:
        if own_client:
            await used_client.aclose()

    parsed = json.loads(body)
    if (
        not isinstance(parsed, dict)
        or not isinstance(parsed.get("codec_version"), str)
        or not isinstance(parsed.get("maps"), list)
    ):
        raise MapDiscoveryError(f"Index at {url} is not a valid MapIndex document")

    pointers: list[MapPointer] = []
    for entry in parsed["maps"]:
        if not _is_pointer_shape(entry):
            raise MapDiscoveryError(
                f"Index entry at {url} is missing required pointer fields"
            )
        pointers.append(
            MapPointer(
                id=entry["id"],
                url=entry["url"],
                hash=entry["hash"],
                published_at=entry.get("published_at"),
            )
        )
    return MapIndex(codec_version=parsed["codec_version"], maps=tuple(pointers))
