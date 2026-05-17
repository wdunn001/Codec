"""Discovery tests — mirror packages/web/test/discover.test.ts."""
from __future__ import annotations

import hashlib
import json

import httpx
import pytest

from codecai import (
    MapDiscoveryError,
    MapDiscoveryNotFoundError,
    MemoryMapCache,
    TokenizerMapHashMismatchError,
    ZstdDictDiscoveryError,
    ZstdDictHashMismatchError,
    discover_index,
    discover_map,
    discover_zstd_dict,
    well_known_dict_url,
    well_known_index_url,
    well_known_map_url,
)
from .fixtures import TINY_MAP

ORIGIN = "https://qwen.test"
TINY_ID = TINY_MAP.id  # "test-tiny-v1"


def _serialise_map() -> bytes:
    """Render TINY_MAP back to the on-the-wire JSON form."""
    obj = {
        "id": TINY_MAP.id,
        "version": TINY_MAP.version,
        "vocab_size": TINY_MAP.vocab_size,
    }
    if TINY_MAP.tokens is not None:
        obj["tokens"] = TINY_MAP.tokens
    if TINY_MAP.special_tokens is not None:
        obj["special_tokens"] = TINY_MAP.special_tokens
    if TINY_MAP.byte_fallback_start is not None:
        obj["byte_fallback_start"] = TINY_MAP.byte_fallback_start
        obj["byte_fallback_end"] = TINY_MAP.byte_fallback_end
    return json.dumps(obj).encode()


def _route_handler(routes: dict[str, bytes | tuple[int, bytes]]):
    """Build an httpx.MockTransport handler that serves a fixed routing table."""

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url not in routes:
            return httpx.Response(404, content=f"no route for {url}".encode())
        entry = routes[url]
        if isinstance(entry, tuple):
            status, body = entry
            return httpx.Response(status, content=body)
        return httpx.Response(
            200,
            content=entry,
            headers={"content-type": "application/json"},
        )

    return handler


def _client(routes: dict[str, bytes | tuple[int, bytes]]) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(_route_handler(routes)))


# ── URL builders ───────────────────────────────────────────────────────────


def test_well_known_map_url_preserves_slashes() -> None:
    assert (
        well_known_map_url("https://qwen.io", "qwen/qwen2")
        == "https://qwen.io/.well-known/codec/maps/qwen/qwen2.json"
    )


def test_well_known_map_url_strips_trailing_slash() -> None:
    assert (
        well_known_map_url("https://qwen.io/", "qwen/qwen2")
        == "https://qwen.io/.well-known/codec/maps/qwen/qwen2.json"
    )


def test_well_known_index_url() -> None:
    assert well_known_index_url("https://qwen.io") == "https://qwen.io/.well-known/codec/index.json"


def test_well_known_map_url_rejects_traversal() -> None:
    with pytest.raises(MapDiscoveryError):
        well_known_map_url("https://qwen.io", "../etc")
    with pytest.raises(MapDiscoveryError):
        well_known_map_url("https://qwen.io", "/abs")
    with pytest.raises(MapDiscoveryError):
        well_known_map_url("https://qwen.io", "trailing/")


def test_well_known_map_url_rejects_invalid_charset() -> None:
    with pytest.raises(MapDiscoveryError):
        well_known_map_url("https://qwen.io", "Qwen/Qwen2")
    with pytest.raises(MapDiscoveryError):
        well_known_map_url("https://qwen.io", "qwen qwen2")


# ── Inline map (Form B) ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_discover_map_inline() -> None:
    inline = _serialise_map()
    async with _client({well_known_map_url(ORIGIN, TINY_ID): inline}) as client:
        m = await discover_map(origin=ORIGIN, id=TINY_ID, client=client)
    assert m.id == TINY_ID
    assert m.vocab_size == TINY_MAP.vocab_size


@pytest.mark.asyncio
async def test_discover_map_inline_id_mismatch_rejected() -> None:
    obj = json.loads(_serialise_map())
    obj["id"] = "something-else"
    body = json.dumps(obj).encode()
    async with _client({well_known_map_url(ORIGIN, TINY_ID): body}) as client:
        with pytest.raises(MapDiscoveryError):
            await discover_map(origin=ORIGIN, id=TINY_ID, client=client)


# ── Pointer (Form A) ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_discover_map_pointer_followed_and_hash_verified() -> None:
    cdn_url = "https://cdn.example.test/qwen2.json"
    body = _serialise_map()
    expected_hash = "sha256:" + hashlib.sha256(body).hexdigest()
    pointer = json.dumps({"id": TINY_ID, "url": cdn_url, "hash": expected_hash}).encode()

    routes = {well_known_map_url(ORIGIN, TINY_ID): pointer, cdn_url: body}
    async with _client(routes) as client:
        m = await discover_map(
            origin=ORIGIN,
            id=TINY_ID,
            client=client,
            cache=MemoryMapCache(),
        )
    assert m.id == TINY_ID


@pytest.mark.asyncio
async def test_discover_map_pointer_hash_mismatch_raises() -> None:
    cdn_url = "https://cdn.example.test/qwen2.json"
    body = _serialise_map()
    wrong_hash = "sha256:" + ("0" * 64)
    pointer = json.dumps({"id": TINY_ID, "url": cdn_url, "hash": wrong_hash}).encode()

    routes = {well_known_map_url(ORIGIN, TINY_ID): pointer, cdn_url: body}
    async with _client(routes) as client:
        with pytest.raises(TokenizerMapHashMismatchError):
            await discover_map(origin=ORIGIN, id=TINY_ID, client=client)


@pytest.mark.asyncio
async def test_discover_map_pointer_id_mismatch_rejected_before_cdn_fetch() -> None:
    cdn_url = "https://cdn.example.test/qwen2.json"
    pointer = json.dumps(
        {"id": "wrong-id", "url": cdn_url, "hash": "sha256:" + "a" * 64}
    ).encode()

    cdn_hits = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == well_known_map_url(ORIGIN, TINY_ID):
            return httpx.Response(200, content=pointer)
        if url == cdn_url:
            cdn_hits["n"] += 1
            return httpx.Response(200, content=_serialise_map())
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(MapDiscoveryError):
            await discover_map(origin=ORIGIN, id=TINY_ID, client=client)
    assert cdn_hits["n"] == 0


@pytest.mark.asyncio
async def test_discover_map_pointer_malformed_hash_rejected() -> None:
    pointer = json.dumps(
        {"id": TINY_ID, "url": "https://cdn.example.test/qwen2.json", "hash": "md5:abcd"}
    ).encode()
    async with _client({well_known_map_url(ORIGIN, TINY_ID): pointer}) as client:
        with pytest.raises(MapDiscoveryError, match="sha256"):
            await discover_map(origin=ORIGIN, id=TINY_ID, client=client)


@pytest.mark.asyncio
async def test_discover_map_404_raises_not_found() -> None:
    routes = {well_known_map_url(ORIGIN, TINY_ID): (404, b"missing")}
    async with _client(routes) as client:
        with pytest.raises(MapDiscoveryNotFoundError):
            await discover_map(origin=ORIGIN, id=TINY_ID, client=client)


# ── Index ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_discover_index_returns_pointers() -> None:
    index = {
        "codec_version": "0.2",
        "maps": [
            {
                "id": "qwen/qwen2",
                "url": "https://cdn.example.test/qwen2.json",
                "hash": "sha256:" + "a" * 64,
            }
        ],
    }
    body = json.dumps(index).encode()
    async with _client({well_known_index_url(ORIGIN): body}) as client:
        got = await discover_index(origin=ORIGIN, client=client)
    assert got.codec_version == "0.2"
    assert len(got.maps) == 1
    assert got.maps[0].id == "qwen/qwen2"


@pytest.mark.asyncio
async def test_discover_index_404_raises_not_found() -> None:
    async with _client({well_known_index_url(ORIGIN): (404, b"")}) as client:
        with pytest.raises(MapDiscoveryNotFoundError):
            await discover_index(origin=ORIGIN, client=client)


@pytest.mark.asyncio
async def test_discover_index_malformed_entries_rejected() -> None:
    bad = {"codec_version": "0.2", "maps": [{"id": "x"}]}
    body = json.dumps(bad).encode()
    async with _client({well_known_index_url(ORIGIN): body}) as client:
        with pytest.raises(MapDiscoveryError):
            await discover_index(origin=ORIGIN, client=client)


# ── Zstd dict (v0.5+) ──────────────────────────────────────────────────────


def test_well_known_dict_url_strips_sha256_prefix() -> None:
    h = "a" * 64
    assert (
        well_known_dict_url("https://codec.example", f"sha256:{h}")
        == f"https://codec.example/.well-known/codec/dicts/{h}.zstd"
    )


def test_well_known_dict_url_accepts_bare_hex() -> None:
    h = "b" * 64
    assert (
        well_known_dict_url("https://codec.example", h)
        == f"https://codec.example/.well-known/codec/dicts/{h}.zstd"
    )


def test_well_known_dict_url_strips_trailing_slash() -> None:
    h = "c" * 64
    assert (
        well_known_dict_url("https://codec.example/", h)
        == f"https://codec.example/.well-known/codec/dicts/{h}.zstd"
    )


def test_well_known_dict_url_normalises_uppercase_hex() -> None:
    h_upper = "D" * 64
    expected = "d" * 64
    assert (
        well_known_dict_url("https://codec.example", h_upper)
        == f"https://codec.example/.well-known/codec/dicts/{expected}.zstd"
    )


def test_well_known_dict_url_rejects_short_hash() -> None:
    with pytest.raises(ZstdDictDiscoveryError, match="64 hex"):
        well_known_dict_url("https://codec.example", "deadbeef")


def test_well_known_dict_url_rejects_wrong_algorithm() -> None:
    with pytest.raises(ZstdDictDiscoveryError):
        well_known_dict_url("https://codec.example", "md5:" + "a" * 32)


def test_well_known_dict_url_rejects_nonhex_chars() -> None:
    with pytest.raises(ZstdDictDiscoveryError):
        well_known_dict_url("https://codec.example", "z" * 64)


@pytest.mark.asyncio
async def test_discover_zstd_dict_returns_bytes_when_hash_matches() -> None:
    dict_bytes = b"\x28\xb5\x2f\xfd" + b"fake-zstd-dict-payload-bytes-for-test"
    hash_hex = hashlib.sha256(dict_bytes).hexdigest()
    url = well_known_dict_url(ORIGIN, hash_hex)

    async with _client({url: dict_bytes}) as client:
        got = await discover_zstd_dict(
            origin=ORIGIN, hash=f"sha256:{hash_hex}", client=client
        )
    assert got == dict_bytes


@pytest.mark.asyncio
async def test_discover_zstd_dict_accepts_bare_hex() -> None:
    dict_bytes = b"another-payload"
    hash_hex = hashlib.sha256(dict_bytes).hexdigest()
    url = well_known_dict_url(ORIGIN, hash_hex)

    async with _client({url: dict_bytes}) as client:
        got = await discover_zstd_dict(origin=ORIGIN, hash=hash_hex, client=client)
    assert got == dict_bytes


@pytest.mark.asyncio
async def test_discover_zstd_dict_404_raises_discovery_error() -> None:
    hash_hex = "f" * 64
    url = well_known_dict_url(ORIGIN, hash_hex)
    async with _client({url: (404, b"missing")}) as client:
        with pytest.raises(ZstdDictDiscoveryError, match="404"):
            await discover_zstd_dict(origin=ORIGIN, hash=hash_hex, client=client)


@pytest.mark.asyncio
async def test_discover_zstd_dict_hash_mismatch_raises() -> None:
    """Origin serves bytes that don't hash to the URL's path component — never trust them."""
    declared_hex = "0" * 64
    url = well_known_dict_url(ORIGIN, declared_hex)
    wrong_bytes = b"this-payload-does-not-hash-to-zeros"

    async with _client({url: wrong_bytes}) as client:
        with pytest.raises(ZstdDictHashMismatchError) as exc_info:
            await discover_zstd_dict(origin=ORIGIN, hash=declared_hex, client=client)
    assert exc_info.value.expected == declared_hex
    assert exc_info.value.actual == hashlib.sha256(wrong_bytes).hexdigest()


@pytest.mark.asyncio
async def test_discover_zstd_dict_rejects_malformed_hash_before_fetch() -> None:
    # No HTTP routes registered — if we fetched we'd get a 404. Reject up front.
    async with _client({}) as client:
        with pytest.raises(ZstdDictDiscoveryError, match="64 hex"):
            await discover_zstd_dict(origin=ORIGIN, hash="not-a-real-hash", client=client)
