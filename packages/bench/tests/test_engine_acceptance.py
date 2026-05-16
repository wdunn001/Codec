"""Engine-image acceptance probes — the gate that runs BEFORE the cross-stack bench.

Encoded from the manual probe sequence the v0.4.1 post-mortem developed
after a stale-Dockerfile codec-sglang image silently shipped with brotli +
zstandard not installed AND the v0.4 safety admin surface absent. The
bench's headline aggregator caught one symptom by accident; these probes
catch the whole regression class in ~15 seconds before the bench runs.

Per docs/RELEASE_CHECKLIST.md §3 (Engine image acceptance):

    The bench scripts MUST gate on this pytest passing before invoking
    run-all-langs.sh. Catches the entire "image was built from a stale
    tree" regression class with one CI run.

Usage:

    CODEC_ENGINE_URL=http://localhost:30002 \\
    CODEC_ENGINE_NAME=sglang \\
    CODEC_ENGINE_MODEL=Qwen/Qwen2.5-0.5B-Instruct \\
        pytest packages/bench/tests/test_engine_acceptance.py -v

Fail-fast: a single test failure here means the engine image is broken and
the bench MUST NOT run. The acceptance check ships exit-code 1; the bench
driver checks that exit code before proceeding.
"""
from __future__ import annotations

import json
import os
import subprocess

import httpx
import msgpack
import pytest


ENGINE_URL = os.environ.get("CODEC_ENGINE_URL", "http://localhost:30002")
ENGINE_NAME = os.environ.get("CODEC_ENGINE_NAME", "sglang")
ENGINE_MODEL = os.environ.get("CODEC_ENGINE_MODEL", "Qwen/Qwen2.5-0.5B-Instruct")
ENGINE_CONTAINER = os.environ.get("CODEC_ENGINE_CONTAINER", "")  # e.g. codec-deployable
ENGINE_FORK_SRC = os.environ.get("CODEC_ENGINE_FORK_SRC", "")    # e.g. /opt/codec/sglang


# Required codec endpoints — fork-engine-side. Codec patches add a small surface
# above the engine's own routes. The supervisor's /openapi.json typically only
# enumerates admin endpoints (the codec routes are mounted on the engine side
# and proxied), so we probe each path with a real GET rather than reading
# openapi.json — that's the contract that matters operationally anyway.
REQUIRED_CODEC_ENDPOINTS = [
    ("GET", "/codec/schema", {200}),
]


@pytest.fixture(scope="module")
def http() -> httpx.Client:
    """HTTP client used for endpoint-existence probes only (GET /openapi.json etc).

    For probes that need to inspect the raw Content-Encoding negotiation,
    use `raw_post` instead — httpx auto-decompresses zstd via the
    `zstandard` package (without knowing about our dict) and dies with
    "Dictionary mismatch" before we can inspect the response. We need the
    bytes raw to test negotiation behavior.
    """
    with httpx.Client(timeout=30.0) as c:
        yield c


def raw_post(url: str, accept_encoding: str, body: dict) -> tuple[int, dict[str, str], bytes]:
    """POST with raw response bytes (no client-side decompression).

    Returns (status_code, lowercased response headers dict, raw body bytes).
    Uses httpx.Client with stream-mode + iter_raw so the response body
    bypasses the decoder pipeline entirely.
    """
    with httpx.Client(timeout=30.0) as client:
        req = client.build_request(
            "POST", url,
            headers={
                "Content-Type": "application/json",
                "Accept-Encoding": accept_encoding,
            },
            json=body,
        )
        resp = client.send(req, stream=True)
        try:
            body_bytes = b"".join(resp.iter_raw())
            headers = {k.lower(): v for k, v in resp.headers.items()}
            return resp.status_code, headers, body_bytes
        finally:
            resp.close()


# ── Probe 1: fork pytest inside the running container ──────────────────────


@pytest.mark.skipif(
    not ENGINE_CONTAINER or not ENGINE_FORK_SRC,
    reason="CODEC_ENGINE_CONTAINER + CODEC_ENGINE_FORK_SRC not set; skipping in-container fork pytest",
)
def test_fork_pytest_inside_container():
    """The fork source's own codec_* unit tests pass inside the running container.

    Confirms the codec patches survived the upstream merge AND the image has
    a working pytest. If this fails, the upstream merge corrupted the codec
    surface and the rest of the bench is meaningless.
    """
    # Discover the test files under the fork's entrypoints directory.
    discover = subprocess.run(
        ["docker", "exec", ENGINE_CONTAINER, "bash", "-c",
         f"ls {ENGINE_FORK_SRC}/python/sglang/srt/entrypoints/test_codec_*.py 2>/dev/null || "
         f"ls {ENGINE_FORK_SRC}/vllm/entrypoints/test_codec_*.py 2>/dev/null || true"],
        capture_output=True, text=True, timeout=10,
    )
    test_paths = [p.strip() for p in discover.stdout.splitlines() if p.strip()]
    assert test_paths, f"No test_codec_*.py files found under {ENGINE_FORK_SRC} in {ENGINE_CONTAINER}"

    rel_paths = [p.split(ENGINE_FORK_SRC + "/")[-1] for p in test_paths]
    result = subprocess.run(
        ["docker", "exec", ENGINE_CONTAINER, "bash", "-c",
         f"cd {ENGINE_FORK_SRC} && pip install --quiet pytest >/dev/null 2>&1; "
         f"python3 -m pytest {' '.join(rel_paths)} --tb=short"],
        capture_output=True, text=True, timeout=120,
    )
    assert result.returncode == 0, (
        f"Fork pytest FAILED in {ENGINE_CONTAINER}:\n{result.stdout[-2000:]}\n{result.stderr[-1000:]}"
    )


# ── Probe 2: endpoint surface enumeration ──────────────────────────────────


@pytest.mark.parametrize("method, path, allowed_codes", REQUIRED_CODEC_ENDPOINTS)
def test_codec_endpoint_present(http: httpx.Client, method: str, path: str, allowed_codes: set[int]):
    """Required codec routes respond with an expected status.

    A 404 on /codec/schema means the codec patches aren't loaded into the
    image — the build was from a tree without our entrypoints integration.
    """
    url = f"{ENGINE_URL}{path}"
    if method == "GET":
        r = http.get(url)
    else:
        r = http.request(method, url)
    assert r.status_code in allowed_codes, (
        f"Engine {ENGINE_NAME} at {url} returned {r.status_code} (expected one of {sorted(allowed_codes)}). "
        f"Body sample: {r.text[:300]!r}"
    )


# ── Probe 3: transport-compression preference order ────────────────────────


@pytest.mark.parametrize(
    "accept_encoding, expected_content_encoding",
    [
        # Spec §Transport-Compression preference: zstd > br > gzip > identity.
        # When all four offered, server picks zstd (assuming dict loaded).
        ("zstd, br, gzip, identity", "zstd"),
        # When zstd offered alone, server picks zstd.
        ("zstd", "zstd"),
        # br alone → br.
        ("br", "br"),
        # gzip alone → gzip.
        ("gzip", "gzip"),
        # identity alone → no Content-Encoding header.
        ("identity", None),
    ],
)
def test_compression_negotiation_per_spec_preference_order(
    accept_encoding: str, expected_content_encoding: str | None
):
    """For each Accept-Encoding combination, server picks per spec preference order.

    Catches: (a) brotli/zstandard module missing in image (br/zstd silently
    fall through to identity instead of being honored), (b) preference-order
    bugs in the negotiator (server picks gzip when zstd+dict available).

    Uses raw_post() to avoid httpx's auto-decompression — we need to see the
    raw Content-Encoding header and dict-zstd would fail mid-decompress otherwise.
    """
    body = {
        "model": ENGINE_MODEL,
        "prompt": "Hi",
        "max_tokens": 4,
        "stream": True,
        "stream_format": "msgpack",
    }
    status, headers, _ = raw_post(f"{ENGINE_URL}/v1/completions", accept_encoding, body)
    assert status == 200, f"Engine returned {status}"
    actual = headers.get("content-encoding")
    if expected_content_encoding is None:
        assert actual is None or actual == "identity", (
            f"Accept-Encoding: {accept_encoding!r} should have no Content-Encoding "
            f"(or 'identity'), got {actual!r}"
        )
    else:
        assert actual == expected_content_encoding, (
            f"Accept-Encoding: {accept_encoding!r} → expected Content-Encoding={expected_content_encoding!r}, "
            f"got {actual!r}. If zstd/br fell through to identity, the brotli/zstandard "
            f"python modules are likely missing from the engine image."
        )


def test_zstd_response_includes_codec_zstd_dict_header():
    """Per v0.4 §Codec-Zstd-Dict, every zstd response MUST emit the dict hash.

    Catches: server has zstd module but no dict loaded — wire is technically
    valid plain-zstd but operationally misleading vs the spec MUST.
    """
    body = {
        "model": ENGINE_MODEL,
        "prompt": "Hi",
        "max_tokens": 4,
        "stream": True,
        "stream_format": "msgpack",
    }
    _, headers, _ = raw_post(f"{ENGINE_URL}/v1/completions", "zstd", body)
    if headers.get("content-encoding") != "zstd":
        pytest.skip("Server did not honor Accept-Encoding: zstd (zstd module + dict required)")
    dict_hdr = headers.get("codec-zstd-dict")
    assert dict_hdr, (
        "Response is Content-Encoding: zstd but no Codec-Zstd-Dict header. "
        "Per spec §Codec-Zstd-Dict, every zstd response MUST emit the dict hash."
    )
    assert dict_hdr.startswith("sha256:") and len(dict_hdr) == len("sha256:") + 64, (
        f"Malformed Codec-Zstd-Dict header: {dict_hdr!r}"
    )


# ── Probe 4: detokenize-bypass on binary streams ───────────────────────────


def test_msgpack_response_has_no_text_field():
    """Per v0.4 §Bidirectional + §Mode-A, msgpack frames carry token IDs only,
    NOT detokenized text. Confirms the engine bypasses the JSON-SSE detokenizer
    when stream_format is binary."""
    body = {
        "model": ENGINE_MODEL,
        "prompt": "Hello",
        "max_tokens": 4,
        "stream": True,
        "stream_format": "msgpack",
    }
    status, _, body_bytes = raw_post(f"{ENGINE_URL}/v1/completions", "identity", body)
    assert status == 200
    unpacker = msgpack.Unpacker(raw=False)
    unpacker.feed(body_bytes)
    frames = list(unpacker)
    assert frames, "msgpack stream was empty"
    for frame in frames:
        assert isinstance(frame, dict), f"frame not a map: {frame!r}"
        assert "ids" in frame, f"frame missing 'ids' key: {frame!r}"
        forbidden = set(frame.keys()) & {"text", "content", "delta"}
        assert not forbidden, (
            f"msgpack frame leaked text fields {forbidden} — engine did NOT bypass "
            f"the JSON-SSE detokenizer for stream_format=msgpack. Spec violation. "
            f"Full frame: {frame!r}"
        )
