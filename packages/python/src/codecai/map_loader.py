"""Tokenizer map loader. Fetch + sha256-verify + cache."""
from __future__ import annotations

import hashlib
from dataclasses import dataclass

import httpx

from .types import MapCache, MemoryMapCache, TokenizerMap


class TokenizerMapHashMismatchError(ValueError):
    """Raised when a fetched map doesn't match the expected hash."""

    def __init__(self, expected: str, actual: str) -> None:
        super().__init__(
            f"TokenizerMap hash mismatch.\n  expected: {expected}\n  actual:   {actual}"
        )
        self.expected = expected
        self.actual = actual


@dataclass
class LoadOptions:
    """Options for :func:`load_map`."""

    url: str
    """URL to fetch the map from."""

    hash: str | None = None
    """Optional sha256 hex digest to verify the fetched map against.

    Accepts ``sha256:<hex>`` or bare ``<hex>``. If omitted, no verification.
    """

    cache: MapCache | None = None
    """Pluggable cache. Defaults to a process-wide in-memory cache."""

    client: httpx.AsyncClient | None = None
    """Custom httpx client. If omitted, a default is used per call."""

    cache_key: str | None = None
    """Cache key. Defaults to ``{url}#{hash}``."""

    timeout: float = 30.0
    """Request timeout in seconds."""


_default_cache = MemoryMapCache()


async def load_map(
    *,
    url: str,
    hash: str | None = None,
    cache: MapCache | None = None,
    client: httpx.AsyncClient | None = None,
    cache_key: str | None = None,
    timeout: float = 30.0,
) -> TokenizerMap:
    """Fetch, verify, and cache a tokenizer map. Cache hits skip the network.

    Example::

        map = await load_map(
            url="https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/qwen/qwen2.json",
            hash="sha256:c73972f7a580…",
        )
    """
    used_cache = cache or _default_cache
    key = cache_key or f"{url}#{hash or ''}"

    cached = await used_cache.get(key)
    if cached is not None:
        return cached

    # httpx auto-decompresses gzip and brotli (via brotli/brotlicffi if installed).
    own_client = client is None
    used_client = client or httpx.AsyncClient(timeout=timeout, follow_redirects=True)
    try:
        resp = await used_client.get(url)
        resp.raise_for_status()
        body = resp.content
    finally:
        if own_client:
            await used_client.aclose()

    if hash is not None:
        expected = _parse_hash(hash)
        actual = hashlib.sha256(body).hexdigest()
        if expected != actual:
            raise TokenizerMapHashMismatchError(expected, actual)

    m = TokenizerMap.from_json(body)
    await used_cache.set(key, m)
    return m


def _parse_hash(hash_str: str) -> str:
    """Parse ``sha256:<hex>`` or bare ``<hex>`` to lowercase hex."""
    if ":" not in hash_str:
        return hash_str.lower()
    algo, _, hex_part = hash_str.partition(":")
    if algo.lower() != "sha256":
        raise ValueError(f"Unsupported hash algorithm: {algo} (only sha256 supported)")
    return hex_part.lower()
