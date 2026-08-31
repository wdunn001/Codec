"""Map discovery via the ``.well-known/codec/`` convention.

Given an HTTPS origin and a Codec map ID, fetch the per-map document at::

    <origin>/.well-known/codec/maps/<id>.json

and return a verified :class:`TokenizerMap`. The document is one of two shapes
(the loader auto-detects):

  * **Pointer**: ``{"id", "url", "hash"}`` referencing the actual map JSON.
  * **Inline**: the full :class:`TokenizerMap` directly.

This module also covers the content-addressed sibling surfaces at
``.well-known/codec/policies/sha256/<hex>.json`` and (v0.5+)
``.well-known/codec/dicts/<sha256-hex>.zstd``. See
``spec/WELL_KNOWN_DISCOVERY.md`` for the full convention.
"""
from __future__ import annotations

import hashlib
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


_DICT_HASH_RE = re.compile(r"^[0-9a-f]{64}$")


def well_known_dict_url(origin: str, hash: str) -> str:
    """Per-dict document URL for an origin + sha256 hash (v0.5+).

    Accepts either ``sha256:<hex>`` or bare ``<hex>``. The returned URL
    follows the v0.5 surface at
    ``<origin>/.well-known/codec/dicts/<sha256-hex>.zstd``.
    """
    hex_part = _parse_dict_hash(hash)
    return f"{_strip_trailing_slash(origin)}{WELL_KNOWN_BASE}/dicts/{hex_part}.zstd"


def _parse_dict_hash(hash_str: str) -> str:
    """Validate + normalise an sha256 dict hash to bare lowercase hex."""
    s = hash_str.strip()
    if s.startswith("sha256:"):
        s = s[len("sha256:") :]
    s = s.lower()
    if not _DICT_HASH_RE.match(s):
        raise ZstdDictDiscoveryError(
            f"Invalid dict hash {hash_str!r}: expected 'sha256:<64 hex>' or '<64 hex>'"
        )
    return s


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


class ZstdDictDiscoveryError(ValueError):
    """Raised when ``.well-known/codec/dicts/<hex>.zstd`` discovery fails (v0.5+).

    Failure modes covered by this error type:

    - 404 on the discovery URL
    - hash mismatch between fetched bytes and the ``<hex>`` in the URL path
    - malformed hash input (not 64 lowercase hex chars, with or without
      the ``sha256:`` prefix)

    The dictionary discovery surface is hard-fail by design: see
    ``spec/WELL_KNOWN_DISCOVERY.md § Resolution failures``. Silent
    fallback to identity bytes is what motivated the v0.5 surface in the
    first place (the v0.4.1 sglang COPY-dicts regression).
    """

    def __init__(self, message: str, *, url: str | None = None) -> None:
        super().__init__(message)
        self.url = url


class ZstdDictHashMismatchError(ZstdDictDiscoveryError):
    """Raised when fetched dict bytes don't hash to the URL's path component."""

    def __init__(self, url: str, expected: str, actual: str) -> None:
        super().__init__(
            f"Zstd dict hash mismatch at {url}\n  expected: {expected}\n  actual:   {actual}",
            url=url,
        )
        self.expected = expected
        self.actual = actual


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


async def discover_zstd_dict(
    *,
    origin: str,
    hash: str,
    client: httpx.AsyncClient | None = None,
    timeout: float = 30.0,
) -> bytes:
    """Resolve a zstd dictionary via ``.well-known/codec/dicts/<hex>.zstd`` (v0.5+).

    Fetches ``<origin>/.well-known/codec/dicts/<sha256-hex>.zstd``, verifies
    that the fetched bytes hash to ``<hex>``, and returns the raw dict bytes
    ready to feed into a ``ZstdDecompressor(dict_data=ZstdCompressionDict(...))``.

    Example::

        from codecai import discover_zstd_dict

        dict_bytes = await discover_zstd_dict(
            origin="https://codec.example",
            hash="sha256:abc123…",  # full hash, typically taken from the
                                    # tokenizer map's zstd_dictionaries[]
                                    # entry or a cohort registry
        )

    The URL is constructed from the hash deterministically: there is no
    mutable per-id form for dictionaries (unlike tokenizer maps). The
    sha-keyed URL is the only surface.

    Raises:
        ZstdDictDiscoveryError: 404 from the origin, or the hash input was
            not a valid sha256 hex form.
        ZstdDictHashMismatchError: fetched bytes did not hash to the URL's
            path component (origin served wrong bytes: never trust them).
    """
    url = well_known_dict_url(origin, hash)
    expected_hex = _parse_dict_hash(hash)

    own_client = client is None
    used_client = client or httpx.AsyncClient(timeout=timeout, follow_redirects=True)
    try:
        resp = await used_client.get(url)
        if resp.status_code == 404:
            raise ZstdDictDiscoveryError(
                f"No zstd dict at {url} (HTTP 404)", url=url
            )
        resp.raise_for_status()
        body = resp.content
    finally:
        if own_client:
            await used_client.aclose()

    actual_hex = hashlib.sha256(body).hexdigest()
    if actual_hex != expected_hex:
        raise ZstdDictHashMismatchError(url, expected_hex, actual_hex)
    return body


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
