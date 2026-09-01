"""Client-side helpers for the Codec compression contract.

Pairs with the server-side ``codec_compression`` modules in sglang/vLLM:
the server emits ``Codec-Zstd-Dict: sha256:<hex>`` on every zstd
response, the client validates that header against locally-loaded dicts
before decompressing. See spec/PROTOCOL.md "Codec-Zstd-Dict response
header" for the full contract.

The actual zstd decompression is intentionally out of scope here:
``httpx`` and ``aiohttp`` both auto-handle gzip/brotli transparently,
zstd needs the optional ``zstandard`` package, and either way the
caller usually already has its own HTTP plumbing. This module just
gives you the small piece that's specific to Codec: matching a
response's declared dict hash to the dict you've loaded.
"""
from __future__ import annotations

import hashlib
from collections.abc import Mapping
from typing import Optional


class CodecZstdDictError(Exception):
    """Raised when the server's Codec-Zstd-Dict header doesn't match
    any dict the client has loaded, or is missing on a zstd response.

    A wrong-dict decompression would produce garbage bytes that
    downstream parsers would misinterpret: fail fast instead.
    """


def hash_zstd_dict(dict_bytes: bytes) -> str:
    """Compute the canonical Codec-Zstd-Dict hash for ``dict_bytes``.

    Returns ``sha256:<lowercase hex>``: same shape as the server-side
    header value and the ``hash`` field in tokenizer-map
    ``zstd_dictionaries[]`` entries.
    """
    return "sha256:" + hashlib.sha256(dict_bytes).hexdigest()


def select_zstd_dict_for_response(
    response_headers: Mapping[str, str],
    *,
    loaded_dicts: Mapping[str, bytes],
) -> Optional[bytes]:
    """Pick the zstd dict to decompress this response with.

    Args:
      response_headers: case-insensitive header mapping from the HTTP
        response. Most HTTP clients (httpx, aiohttp, urllib3) provide
        this directly; for a plain ``dict`` of headers, normalise keys
        to lowercase before passing in.
      loaded_dicts: ``{sha256_hash: dict_bytes}``: the dicts the client
        has loaded locally. Hashes follow the same ``sha256:<hex>``
        format the server emits.

    Returns:
      - the matching dict's bytes when the response is
        ``Content-Encoding: zstd`` and the server's ``Codec-Zstd-Dict``
        header points at a loaded dict
      - ``None`` when the response isn't zstd (caller should pass
        through identity / let httpx auto-decompress gzip/br)

    Raises:
      CodecZstdDictError when the response is zstd but:
        - the ``Codec-Zstd-Dict`` header is missing (per spec, the
          server MUST emit it on every zstd response)
        - the header names a hash we haven't loaded: caller should
          fetch the dict from the tokenizer map's
          ``zstd_dictionaries[]`` entry whose ``hash`` matches, or
          retry the request with ``Accept-Encoding: gzip`` to
          downgrade to a no-dict path
        - the header is malformed (not ``sha256:<hex>``)
    """
    enc = _header(response_headers, "content-encoding")
    if enc is None or enc.strip().lower() != "zstd":
        return None  # caller's HTTP stack handles gzip/br/identity

    declared = _header(response_headers, "codec-zstd-dict")
    if not declared:
        raise CodecZstdDictError(
            "Response is Content-Encoding: zstd but no Codec-Zstd-Dict "
            "header was present. Per spec/PROTOCOL.md the server MUST "
            "name the dict it used. Refusing to guess."
        )

    declared = declared.strip()
    if not declared.startswith("sha256:") or len(declared) != len("sha256:") + 64:
        raise CodecZstdDictError(
            f"Malformed Codec-Zstd-Dict value: {declared!r}. Expected "
            f"'sha256:<64 hex chars>'."
        )

    if declared not in loaded_dicts:
        raise CodecZstdDictError(
            f"Server used zstd dict {declared} but it isn't loaded "
            f"locally. Fetch it from the tokenizer map's zstd_dictionaries[] "
            f"entry (the entry whose hash matches), or send "
            f"Accept-Encoding: gzip to downgrade."
        )
    return loaded_dicts[declared]


def _header(headers: Mapping[str, str], name: str) -> Optional[str]:
    """Case-insensitive header lookup. Most HTTP libraries return a
    case-insensitive multi-dict already; this is a defensive fallback
    for callers that pass a plain ``dict``."""
    if name in headers:
        return headers[name]
    lower = name.lower()
    for k, v in headers.items():
        if k.lower() == lower:
            return v
    return None
