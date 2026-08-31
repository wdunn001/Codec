"""Python parity tests for slice 11.

Mirrors `packages/web/test/safety-policy.test.ts`: same shape, same
assertions, so a regression on either side surfaces.
"""
from __future__ import annotations

import hashlib
import json

import httpx
import pytest

from codecai.safety_policy import (
    Category,
    ClassifierBlock,
    ClientHooksBlock,
    MemorySafetyPolicyCache,
    RulesSummary,
    SafetyPolicyDescriptor,
    SafetyPolicyDiscoveryError,
    SafetyPolicyDiscoveryNotFoundError,
    SafetyPolicyHashMismatchError,
    SafetyPolicyValidationError,
    descriptor_canonical_bytes,
    descriptor_from_json,
    discover_safety_policy,
    hash_safety_policy,
    load_safety_policy,
    validate_safety_policy,
    well_known_policy_hash_url,
    well_known_policy_url,
)


ORIGIN = "https://acme.test"


VALID_DICT = {
    "id": "acme/strict-v3",
    "version": "1",
    "tokenizers": ["meta-llama/llama-3"],
    "categories": [
        {"name": "secrets", "action": "stop"},
        {"name": "pii", "action": "redact", "description": "Email and phone."},
    ],
    "classifier": {
        "family": "llama-guard-3-1b",
        "host": "server",
        "requires_engine_features": ["logits_processor", "sampling_chain"],
    },
    "rules_summary": {
        "banned_token_id_count": 4128,
        "regex_pattern_count": 47,
    },
    "client_hooks": {
        "prefilter_categories": ["secrets", "pii"],
        "client_classifier_family": "prompt-guard-86m",
    },
    "published_at": "2026-05-09T00:00:00Z",
}


def _build_descriptor() -> SafetyPolicyDescriptor:
    return descriptor_from_json(VALID_DICT)


# ── Validation ──────────────────────────────────────────────────────────────


def test_validate_accepts_minimal_valid_descriptor():
    validate_safety_policy(VALID_DICT)


def test_validate_rejects_missing_required_fields():
    with pytest.raises(SafetyPolicyValidationError):
        validate_safety_policy({})
    with pytest.raises(SafetyPolicyValidationError):
        validate_safety_policy({**VALID_DICT, "id": ""})
    with pytest.raises(SafetyPolicyValidationError):
        validate_safety_policy({**VALID_DICT, "tokenizers": []})
    with pytest.raises(SafetyPolicyValidationError):
        validate_safety_policy({**VALID_DICT, "categories": []})


def test_validate_rejects_bad_category_names():
    bad = {**VALID_DICT, "categories": [{"name": "BadCaps", "action": "stop"}]}
    with pytest.raises(SafetyPolicyValidationError):
        validate_safety_policy(bad)


def test_validate_rejects_unknown_actions():
    bad = {**VALID_DICT, "categories": [{"name": "secrets", "action": "banhammer"}]}
    with pytest.raises(SafetyPolicyValidationError):
        validate_safety_policy(bad)


def test_validate_rejects_negative_summary_counts():
    bad = {
        **VALID_DICT,
        "rules_summary": {"banned_token_id_count": -5},
    }
    with pytest.raises(SafetyPolicyValidationError):
        validate_safety_policy(bad)


def test_validate_rejects_unknown_engine_features():
    bad = {
        **VALID_DICT,
        "classifier": {
            "family": "llama-guard-3-1b",
            "requires_engine_features": ["weather_api"],
        },
    }
    with pytest.raises(SafetyPolicyValidationError):
        validate_safety_policy(bad)


# ── Hash determinism ────────────────────────────────────────────────────────


def test_hash_is_deterministic_for_identical_input():
    d = _build_descriptor()
    a = hash_safety_policy(d)
    b = hash_safety_policy(d)
    assert a == b
    assert a.startswith("sha256:")
    assert len(a.split(":", 1)[1]) == 64


def test_hash_differs_when_category_action_changes():
    d1 = _build_descriptor()
    d2 = descriptor_from_json({
        **VALID_DICT,
        "categories": [
            {"name": "secrets", "action": "flag"},
            {"name": "pii", "action": "redact", "description": "Email and phone."},
        ],
    })
    assert hash_safety_policy(d1) != hash_safety_policy(d2)


def test_canonical_bytes_match_2_space_indent_with_trailing_newline():
    raw = descriptor_canonical_bytes(_build_descriptor())
    text = raw.decode("utf-8")
    assert text.endswith("\n")
    json.loads(text)
    assert "\n  " in text


def test_canonical_bytes_match_supervisor_format():
    """The Python client and the supervisor (pydantic + json.dumps)
    MUST emit identical canonical bytes: that's the contract that
    makes safety_policy_hash interoperable across stacks."""
    descriptor = _build_descriptor()
    raw = descriptor_canonical_bytes(descriptor)
    # Same JSON, hashed independently: should match.
    direct_hash = hashlib.sha256(raw).hexdigest()
    via_function = hash_safety_policy(descriptor).split(":", 1)[1]
    assert direct_hash == via_function


# ── URL builders ────────────────────────────────────────────────────────────


def test_well_known_policy_url_preserves_slashes():
    assert (
        well_known_policy_url("https://acme.example/", "acme/strict-v3")
        == "https://acme.example/.well-known/codec/policies/acme/strict-v3.json"
    )


def test_well_known_policy_url_rejects_traversal():
    with pytest.raises(SafetyPolicyDiscoveryError):
        well_known_policy_url("https://acme.example", "../etc")


def test_well_known_policy_url_rejects_bad_charset():
    with pytest.raises(SafetyPolicyDiscoveryError):
        well_known_policy_url("https://acme.example", "Acme/Strict")


def test_well_known_policy_hash_url_uses_sha256_path():
    hex_str = "a" * 64
    assert (
        well_known_policy_hash_url("https://acme.example", hex_str)
        == f"https://acme.example/.well-known/codec/policies/sha256/{hex_str}.json"
    )


def test_well_known_policy_hash_url_rejects_malformed_hex():
    with pytest.raises(SafetyPolicyDiscoveryError):
        well_known_policy_hash_url("https://acme.example", "not-hex")


# ── Loader ──────────────────────────────────────────────────────────────────


def _make_mock_client(routes: dict[str, bytes | tuple[int, bytes]]) -> httpx.AsyncClient:
    """Build an httpx.AsyncClient backed by an in-memory mock transport."""

    def _handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url not in routes:
            return httpx.Response(404, content=f"no route for {url}".encode())
        route = routes[url]
        if isinstance(route, tuple):
            status, body = route
            return httpx.Response(status, content=body)
        return httpx.Response(200, content=route)

    return httpx.AsyncClient(transport=httpx.MockTransport(_handler))


@pytest.mark.asyncio
async def test_load_safety_policy_fetches_validates_caches():
    url = f"{ORIGIN}/policies/acme-strict-v3.json"
    body = json.dumps(VALID_DICT).encode("utf-8")
    cache = MemorySafetyPolicyCache()

    async with _make_mock_client({url: body}) as client:
        descriptor = await load_safety_policy(url=url, client=client, cache=cache)

    assert descriptor.id == VALID_DICT["id"]
    # Second call hits cache; even with an empty mock, it should succeed.
    async with _make_mock_client({}) as client:
        cached = await load_safety_policy(url=url, client=client, cache=cache)
    assert cached.id == VALID_DICT["id"]


@pytest.mark.asyncio
async def test_load_safety_policy_verifies_hash():
    url = f"{ORIGIN}/policies/acme-strict-v3.json"
    body = (json.dumps(VALID_DICT, indent=2) + "\n").encode("utf-8")
    good_hash = f"sha256:{hashlib.sha256(body).hexdigest()}"

    async with _make_mock_client({url: body}) as client:
        descriptor = await load_safety_policy(url=url, hash=good_hash, client=client)
    assert descriptor.id == VALID_DICT["id"]

    wrong = "sha256:" + ("b" * 64)
    async with _make_mock_client({url: body}) as client:
        with pytest.raises(SafetyPolicyHashMismatchError):
            await load_safety_policy(url=url, hash=wrong, client=client)


# ── Discovery ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_discover_safety_policy_resolves_inline_descriptor():
    url = well_known_policy_url(ORIGIN, VALID_DICT["id"])
    body = json.dumps(VALID_DICT).encode("utf-8")
    async with _make_mock_client({url: body}) as client:
        d = await discover_safety_policy(
            origin=ORIGIN, id=VALID_DICT["id"], client=client,
        )
    assert d.id == VALID_DICT["id"]


@pytest.mark.asyncio
async def test_discover_safety_policy_follows_pointer():
    id_url = well_known_policy_url(ORIGIN, VALID_DICT["id"])
    cdn_url = "https://cdn.example/acme-strict-v3.json"
    body = (json.dumps(VALID_DICT, indent=2) + "\n").encode("utf-8")
    cdn_hash = f"sha256:{hashlib.sha256(body).hexdigest()}"
    pointer_body = json.dumps({
        "id": VALID_DICT["id"],
        "url": cdn_url,
        "hash": cdn_hash,
    }).encode("utf-8")
    async with _make_mock_client({id_url: pointer_body, cdn_url: body}) as client:
        d = await discover_safety_policy(
            origin=ORIGIN, id=VALID_DICT["id"], client=client,
        )
    assert d.id == VALID_DICT["id"]


@pytest.mark.asyncio
async def test_discover_safety_policy_with_hash_hits_content_addressed_sibling():
    body = (json.dumps(VALID_DICT, indent=2) + "\n").encode("utf-8")
    hash_hex = hashlib.sha256(body).hexdigest()
    hash_url = well_known_policy_hash_url(ORIGIN, hash_hex)
    async with _make_mock_client({hash_url: body}) as client:
        d = await discover_safety_policy(
            origin=ORIGIN,
            id=VALID_DICT["id"],
            hash=f"sha256:{hash_hex}",
            client=client,
        )
    assert d.id == VALID_DICT["id"]


@pytest.mark.asyncio
async def test_discover_safety_policy_with_hash_rejects_byte_mismatch():
    """The hash-keyed endpoint serves bytes that don't match the
    requested hex: the loader MUST reject."""
    body = b"different content than expected"
    wrong_hex = "c" * 64
    hash_url = well_known_policy_hash_url(ORIGIN, wrong_hex)
    async with _make_mock_client({hash_url: body}) as client:
        with pytest.raises(SafetyPolicyHashMismatchError):
            await discover_safety_policy(
                origin=ORIGIN,
                id=VALID_DICT["id"],
                hash=f"sha256:{wrong_hex}",
                client=client,
            )


@pytest.mark.asyncio
async def test_discover_safety_policy_404_raises_not_found():
    async with _make_mock_client({}) as client:
        with pytest.raises(SafetyPolicyDiscoveryNotFoundError):
            await discover_safety_policy(
                origin=ORIGIN, id=VALID_DICT["id"], client=client,
            )


@pytest.mark.asyncio
async def test_discover_safety_policy_rejects_inline_id_mismatch():
    url = well_known_policy_url(ORIGIN, VALID_DICT["id"])
    body = json.dumps({**VALID_DICT, "id": "someone-else/v1"}).encode("utf-8")
    async with _make_mock_client({url: body}) as client:
        with pytest.raises(SafetyPolicyDiscoveryError):
            await discover_safety_policy(
                origin=ORIGIN, id=VALID_DICT["id"], client=client,
            )


# ── Cross-language interop sanity ──────────────────────────────────────────


def test_descriptor_dataclasses_round_trip():
    """Build a descriptor, serialize, parse, compare."""
    d = SafetyPolicyDescriptor(
        id="acme/v1",
        version="1",
        tokenizers=("meta-llama/llama-3",),
        categories=(Category(name="hate", action="stop"),),
        classifier=ClassifierBlock(family="llama-guard-3-1b"),
        rules_summary=RulesSummary(banned_token_id_count=10),
        client_hooks=ClientHooksBlock(prefilter_categories=("secrets",)),
    )
    raw = descriptor_canonical_bytes(d)
    parsed = json.loads(raw)
    d2 = descriptor_from_json(parsed)
    assert d2.id == d.id
    assert d2.categories[0].name == "hate"
    assert d2.rules_summary is not None
    assert d2.rules_summary.banned_token_id_count == 10
