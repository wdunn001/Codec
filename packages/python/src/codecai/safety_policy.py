"""Safety-policy descriptor loading, validation, and discovery.

Python twin of ``@codecai/web``'s ``safety-policy.ts`` (slice 1). Same
shapes, same errors, same canonical JSON form for hashing: a
descriptor that hashes to ``sha256:abc…`` in the TS client hashes to
the identical digest here.

Used by clients that received ``safety_policy_id`` + ``safety_policy_hash``
in ``READY`` and want to fetch and surface what the server is enforcing.
The descriptor is the *sanitized*, publishable shape: categories,
actions, classifier family, summary stats: never the operator's
internal banned token IDs / classifier thresholds / regex patterns.

Discovery follows the existing tokenizer-map convention:

  * ``<origin>/.well-known/codec/policies/<id>.json``      (mutable)
  * ``<origin>/.well-known/codec/policies/sha256/<hex>.json`` (immutable)

A client that received a hash in ``READY`` SHOULD prefer the
content-addressed sibling: it's provably immutable and skips the
mutable indirection.
"""
from __future__ import annotations

import dataclasses
import hashlib
import json
import re
from collections.abc import Awaitable
from dataclasses import dataclass
from typing import Any, Literal

import httpx


POLICY_WELL_KNOWN_BASE = "/.well-known/codec/policies"
"""Fixed base path under which Codec safety-policy documents live."""


# ── Types ────────────────────────────────────────────────────────────────────


CategoryAction = Literal["stop", "redact", "regenerate", "flag"]
ClassifierHost = Literal["server", "client", "both"]
EngineFeature = Literal["logits_processor", "hidden_states", "sampling_chain"]


@dataclass(frozen=True, slots=True)
class Category:
    """Per-category enforcement entry on the descriptor."""

    name: str
    """Lowercase ASCII matching ``[a-z0-9_-]+``."""

    action: CategoryAction
    """What the server does when this category fires."""

    description: str | None = None


@dataclass(frozen=True, slots=True)
class ClassifierBlock:
    """Disclosed half of the classifier spec.

    ``family`` is a free-form lowercase identifier (e.g. ``llama-guard-3-1b``,
    ``shield-gemma-2b``, ``embedding-space-v1``, ``none``). New families
    don't require a schema bump: this is descriptive metadata, not a
    closed enum.
    """

    family: str
    host: ClassifierHost | None = None
    requires_engine_features: tuple[EngineFeature, ...] | None = None


@dataclass(frozen=True, slots=True)
class RulesSummary:
    """Aggregate counts over the operator's internal enforcement surface.

    Each field is the size of the corresponding internal-only list, but
    the lists themselves are NEVER published (they would form an
    enumeration map for evasion).
    """

    banned_token_id_count: int | None = None
    regex_pattern_count: int | None = None
    grammar_constraint_count: int | None = None
    multi_token_pattern_count: int | None = None


@dataclass(frozen=True, slots=True)
class ClientHooksBlock:
    """Optional hints to clients about their participation in enforcement."""

    prefilter_categories: tuple[str, ...] | None = None
    client_classifier_family: str | None = None


@dataclass(frozen=True, slots=True)
class PublisherBlock:
    """Optional human-readable publisher metadata.

    Non-load-bearing: the trust anchor is the origin's TLS cert plus
    the descriptor's content hash, not this field.
    """

    name: str | None = None
    url: str | None = None
    contact: str | None = None


@dataclass(frozen=True, slots=True)
class SafetyPolicyDescriptor:
    """The sanitized, publishable safety-policy descriptor.

    Matches ``spec/safety-policy.schema.json`` v1. This is what gets
    fetched at ``.well-known/codec/policies/<id>.json``; the operator's
    full-detail internal config is NEVER published.
    """

    id: str
    version: str
    tokenizers: tuple[str, ...]
    categories: tuple[Category, ...]
    classifier: ClassifierBlock
    category_registry: str | None = None
    rules_summary: RulesSummary | None = None
    client_hooks: ClientHooksBlock | None = None
    published_at: str | None = None
    publisher: PublisherBlock | None = None


# ── Cache + errors ───────────────────────────────────────────────────────────


class SafetyPolicyCache:
    """Pluggable cache for descriptors. Default impl is in-memory."""

    async def get(self, key: str) -> SafetyPolicyDescriptor | None:
        raise NotImplementedError

    async def set(self, key: str, descriptor: SafetyPolicyDescriptor) -> None:
        raise NotImplementedError


class MemorySafetyPolicyCache(SafetyPolicyCache):
    """In-process cache. Descriptors are immutable per-(id, hash) so
    cache hits are always valid."""

    def __init__(self) -> None:
        self._store: dict[str, SafetyPolicyDescriptor] = {}

    async def get(self, key: str) -> SafetyPolicyDescriptor | None:
        return self._store.get(key)

    async def set(self, key: str, descriptor: SafetyPolicyDescriptor) -> None:
        self._store[key] = descriptor


_DEFAULT_CACHE = MemorySafetyPolicyCache()


class SafetyPolicyValidationError(ValueError):
    def __init__(self, message: str) -> None:
        super().__init__(f"SafetyPolicyDescriptor validation failed: {message}")


class SafetyPolicyHashMismatchError(Exception):
    def __init__(self, expected: str, actual: str) -> None:
        super().__init__(
            f"SafetyPolicyDescriptor hash mismatch.\n"
            f"  expected: {expected}\n"
            f"  actual:   {actual}"
        )
        self.expected = expected
        self.actual = actual


class SafetyPolicyDiscoveryError(ValueError):
    """Raised when a descriptor document is malformed or absent."""


class SafetyPolicyDiscoveryNotFoundError(SafetyPolicyDiscoveryError):
    """Raised when ``.well-known/codec/policies/...`` returns 404."""

    def __init__(self, url: str, status: int) -> None:
        super().__init__(f"No safety-policy document at {url} (HTTP {status})")
        self.url = url
        self.status = status


# ── Validation ───────────────────────────────────────────────────────────────
#
# Hand-written shape check matching the TS twin. We don't pull a
# JSON-Schema validator into the wire path; the contract is small enough
# that an explicit check is honest about what we actually require.


_CATEGORY_NAME_RE = re.compile(r"^[a-z0-9_-]+$")
_VALID_ACTIONS = frozenset({"stop", "redact", "regenerate", "flag"})
_VALID_HOSTS = frozenset({"server", "client", "both"})
_VALID_ENGINE_FEATURES = frozenset(
    {"logits_processor", "hidden_states", "sampling_chain"}
)


def validate_safety_policy(value: Any) -> None:
    """Raise :class:`SafetyPolicyValidationError` if ``value`` doesn't
    match the descriptor schema. Returns ``None`` on success.

    Mirrors the TS validator exactly: same checks, same messages.
    """
    if not isinstance(value, dict):
        raise SafetyPolicyValidationError("not an object")

    p = value
    if not isinstance(p.get("id"), str) or not p["id"]:
        raise SafetyPolicyValidationError("id must be a non-empty string")
    if not isinstance(p.get("version"), str):
        raise SafetyPolicyValidationError("version must be a string")

    tokenizers = p.get("tokenizers")
    if not isinstance(tokenizers, list) or len(tokenizers) == 0:
        raise SafetyPolicyValidationError(
            "tokenizers must be a non-empty array of tokenizer ids"
        )
    for t in tokenizers:
        if not isinstance(t, str):
            raise SafetyPolicyValidationError("tokenizers entries must be strings")

    categories = p.get("categories")
    if not isinstance(categories, list) or len(categories) == 0:
        raise SafetyPolicyValidationError("categories must be a non-empty array")
    for c in categories:
        if not isinstance(c, dict):
            raise SafetyPolicyValidationError("category entry must be an object")
        name = c.get("name")
        if not isinstance(name, str) or not _CATEGORY_NAME_RE.match(name):
            raise SafetyPolicyValidationError(
                f"category.name must match {_CATEGORY_NAME_RE.pattern!r} "
                f"(got {name!r})"
            )
        action = c.get("action")
        if not isinstance(action, str) or action not in _VALID_ACTIONS:
            raise SafetyPolicyValidationError(
                f"category.action for {name!r} must be one of "
                f"stop|redact|regenerate|flag"
            )
        desc = c.get("description")
        if desc is not None and not isinstance(desc, str):
            raise SafetyPolicyValidationError(
                f"category.description for {name!r} must be a string when present"
            )

    classifier = p.get("classifier")
    if not isinstance(classifier, dict):
        raise SafetyPolicyValidationError("classifier must be an object")
    family = classifier.get("family")
    if not isinstance(family, str) or not family:
        raise SafetyPolicyValidationError(
            "classifier.family must be a non-empty string"
        )
    host = classifier.get("host")
    if host is not None and (not isinstance(host, str) or host not in _VALID_HOSTS):
        raise SafetyPolicyValidationError(
            f"classifier.host must be one of server|client|both (got {host!r})"
        )
    feats = classifier.get("requires_engine_features")
    if feats is not None:
        if not isinstance(feats, list):
            raise SafetyPolicyValidationError(
                "classifier.requires_engine_features must be an array"
            )
        for f in feats:
            if not isinstance(f, str) or f not in _VALID_ENGINE_FEATURES:
                raise SafetyPolicyValidationError(
                    f"classifier.requires_engine_features entry must be "
                    f"one of logits_processor|hidden_states|sampling_chain "
                    f"(got {f!r})"
                )

    rs = p.get("rules_summary")
    if rs is not None:
        if not isinstance(rs, dict):
            raise SafetyPolicyValidationError(
                "rules_summary must be an object when present"
            )
        for key in (
            "banned_token_id_count",
            "regex_pattern_count",
            "grammar_constraint_count",
            "multi_token_pattern_count",
        ):
            v = rs.get(key)
            if v is not None and (not isinstance(v, int) or v < 0):
                raise SafetyPolicyValidationError(
                    f"rules_summary.{key} must be a non-negative integer when present"
                )

    ch = p.get("client_hooks")
    if ch is not None:
        if not isinstance(ch, dict):
            raise SafetyPolicyValidationError(
                "client_hooks must be an object when present"
            )
        cats = ch.get("prefilter_categories")
        if cats is not None:
            if not isinstance(cats, list):
                raise SafetyPolicyValidationError(
                    "client_hooks.prefilter_categories must be an array of strings"
                )
            for c in cats:
                if not isinstance(c, str):
                    raise SafetyPolicyValidationError(
                        "client_hooks.prefilter_categories entries must be strings"
                    )
        ccf = ch.get("client_classifier_family")
        if ccf is not None and not isinstance(ccf, str):
            raise SafetyPolicyValidationError(
                "client_hooks.client_classifier_family must be a string when present"
            )

    cr = p.get("category_registry")
    if cr is not None and not isinstance(cr, str):
        raise SafetyPolicyValidationError(
            "category_registry must be a string when present"
        )

    pa = p.get("published_at")
    if pa is not None and not isinstance(pa, str):
        raise SafetyPolicyValidationError(
            "published_at must be an ISO 8601 string when present"
        )

    pub = p.get("publisher")
    if pub is not None:
        if not isinstance(pub, dict):
            raise SafetyPolicyValidationError(
                "publisher must be an object when present"
            )
        for key in ("name", "url", "contact"):
            v = pub.get(key)
            if v is not None and not isinstance(v, str):
                raise SafetyPolicyValidationError(
                    f"publisher.{key} must be a string when present"
                )


def descriptor_from_json(raw: dict[str, Any]) -> SafetyPolicyDescriptor:
    """Build a :class:`SafetyPolicyDescriptor` from a parsed JSON dict.

    Validates first; raises :class:`SafetyPolicyValidationError` on bad
    shape. Pass-through for fields that are already validated.
    """
    validate_safety_policy(raw)

    cls_raw = raw["classifier"]
    classifier = ClassifierBlock(
        family=cls_raw["family"],
        host=cls_raw.get("host"),
        requires_engine_features=(
            tuple(cls_raw["requires_engine_features"])
            if cls_raw.get("requires_engine_features") is not None
            else None
        ),
    )

    rs_raw = raw.get("rules_summary")
    rules_summary = (
        RulesSummary(
            banned_token_id_count=rs_raw.get("banned_token_id_count"),
            regex_pattern_count=rs_raw.get("regex_pattern_count"),
            grammar_constraint_count=rs_raw.get("grammar_constraint_count"),
            multi_token_pattern_count=rs_raw.get("multi_token_pattern_count"),
        )
        if rs_raw is not None
        else None
    )

    ch_raw = raw.get("client_hooks")
    client_hooks = (
        ClientHooksBlock(
            prefilter_categories=(
                tuple(ch_raw["prefilter_categories"])
                if ch_raw.get("prefilter_categories") is not None
                else None
            ),
            client_classifier_family=ch_raw.get("client_classifier_family"),
        )
        if ch_raw is not None
        else None
    )

    pub_raw = raw.get("publisher")
    publisher = (
        PublisherBlock(
            name=pub_raw.get("name"),
            url=pub_raw.get("url"),
            contact=pub_raw.get("contact"),
        )
        if pub_raw is not None
        else None
    )

    return SafetyPolicyDescriptor(
        id=raw["id"],
        version=raw["version"],
        tokenizers=tuple(raw["tokenizers"]),
        categories=tuple(
            Category(
                name=c["name"],
                action=c["action"],
                description=c.get("description"),
            )
            for c in raw["categories"]
        ),
        category_registry=raw.get("category_registry"),
        classifier=classifier,
        rules_summary=rules_summary,
        client_hooks=client_hooks,
        published_at=raw.get("published_at"),
        publisher=publisher,
    )


# ── Hashing ──────────────────────────────────────────────────────────────────
#
# Canonical bytes match @codecai/maps-cli's `policies hash` output:
# 2-space indent + trailing newline. The `safety_policy_hash` value the
# wire carries is computed over EXACTLY these bytes, so a CLI-emitted
# descriptor and a Python-loaded descriptor produce identical hashes.


def descriptor_canonical_bytes(descriptor: SafetyPolicyDescriptor) -> bytes:
    """Canonical JSON serialization for hashing + well-known publish.

    Matches the TS / CLI format: 2-space indent + trailing newline.
    Fields with ``None`` values are omitted (matching ``exclude_none=True``
    on the supervisor side).
    """
    payload = _to_dict_omit_none(descriptor)
    return (json.dumps(payload, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def hash_safety_policy(descriptor: SafetyPolicyDescriptor) -> str:
    """Canonical sha256 hash of a descriptor.

    Returns ``sha256:<64 hex chars>`` matching what
    ``codecai-maps policies hash`` emits and what servers should publish
    in ``READY.safety_policy_hash``.
    """
    validate_safety_policy(_to_dict_omit_none(descriptor))
    return f"sha256:{hashlib.sha256(descriptor_canonical_bytes(descriptor)).hexdigest()}"


def _to_dict_omit_none(descriptor: SafetyPolicyDescriptor) -> dict[str, Any]:
    """Convert a descriptor to a dict mirroring ``model_dump(exclude_none=True)``
    on the supervisor's Pydantic side. Nested optional blocks become
    plain dicts; absent fields are dropped entirely so the canonical
    JSON shape matches.
    """
    def _block(obj: Any) -> dict[str, Any] | None:
        # The descriptor's nested blocks use `slots=True` so `__dict__`
        # is absent; iterate via `dataclasses.fields` instead.
        if obj is None:
            return None
        d = {
            f.name: getattr(obj, f.name)
            for f in dataclasses.fields(obj)
            if getattr(obj, f.name) is not None
        }
        if not d:
            return None
        return d

    out: dict[str, Any] = {
        "id": descriptor.id,
        "version": descriptor.version,
        "tokenizers": list(descriptor.tokenizers),
        "categories": [
            {k: v for k, v in (
                ("name", c.name),
                ("action", c.action),
                ("description", c.description),
            ) if v is not None}
            for c in descriptor.categories
        ],
        "classifier": _block(descriptor.classifier),
    }

    if descriptor.category_registry is not None:
        out["category_registry"] = descriptor.category_registry

    rs_block = _block(descriptor.rules_summary)
    if rs_block is not None:
        out["rules_summary"] = rs_block

    ch_block = _block(descriptor.client_hooks)
    if ch_block is not None:
        # Convert any tuple back to list for JSON-canonical form.
        if "prefilter_categories" in ch_block and isinstance(
            ch_block["prefilter_categories"], tuple
        ):
            ch_block["prefilter_categories"] = list(ch_block["prefilter_categories"])
        out["client_hooks"] = ch_block

    if descriptor.published_at is not None:
        out["published_at"] = descriptor.published_at

    pub_block = _block(descriptor.publisher)
    if pub_block is not None:
        out["publisher"] = pub_block

    # Reconstruct the classifier block's optional list field.
    if (
        out["classifier"] is not None
        and "requires_engine_features" in out["classifier"]
        and isinstance(out["classifier"]["requires_engine_features"], tuple)
    ):
        out["classifier"]["requires_engine_features"] = list(
            out["classifier"]["requires_engine_features"]
        )

    return out


def _parse_hash(hash_str: str) -> str:
    if ":" in hash_str:
        algo, _, hex_part = hash_str.partition(":")
        if algo.lower() != "sha256":
            raise ValueError(
                f"Unsupported hash algorithm: {algo} (only sha256 supported)"
            )
        return hex_part.lower()
    return hash_str.lower()


# ── URL builders ─────────────────────────────────────────────────────────────


_ID_RE = re.compile(r"^[a-z0-9._/\-]+$")
_HEX_RE = re.compile(r"^[0-9a-f]{64}$", re.IGNORECASE)


def well_known_policy_url(origin: str, policy_id: str) -> str:
    """Per-policy URL by mutable id (e.g. ``acme/strict-v3``)."""
    return (
        f"{_strip_trailing_slash(origin)}{POLICY_WELL_KNOWN_BASE}"
        f"/{_encode_policy_id(policy_id)}.json"
    )


def well_known_policy_hash_url(origin: str, hash_hex: str) -> str:
    """Content-addressed URL by sha256 hex (no ``sha256:`` prefix)."""
    if not _HEX_RE.match(hash_hex):
        raise SafetyPolicyDiscoveryError(
            f"Invalid policy hash hex: must be 64-char lowercase hex "
            f"(got {hash_hex!r})"
        )
    return (
        f"{_strip_trailing_slash(origin)}{POLICY_WELL_KNOWN_BASE}"
        f"/sha256/{hash_hex.lower()}.json"
    )


def _strip_trailing_slash(s: str) -> str:
    return s[:-1] if s.endswith("/") else s


def _encode_policy_id(policy_id: str) -> str:
    if not _ID_RE.match(policy_id):
        raise SafetyPolicyDiscoveryError(
            f"Invalid policy id {policy_id!r}: must match [a-z0-9._/-]+"
        )
    if (
        ".." in policy_id
        or policy_id.startswith("/")
        or policy_id.endswith("/")
    ):
        raise SafetyPolicyDiscoveryError(
            f"Invalid policy id {policy_id!r}: path traversal or empty segment"
        )
    return policy_id


# ── Pointer ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class SafetyPolicyPointer:
    """Pointer document at ``.well-known/codec/policies/<id>.json`` (Form A)."""

    id: str
    url: str
    hash: str
    published_at: str | None = None


def _is_pointer_shape(obj: Any) -> bool:
    return (
        isinstance(obj, dict)
        and isinstance(obj.get("id"), str)
        and isinstance(obj.get("url"), str)
        and isinstance(obj.get("hash"), str)
        # Inline descriptors always carry `categories`; pointers never do.
        and "categories" not in obj
    )


def _validate_pointer(obj: dict[str, Any], expected_id: str) -> SafetyPolicyPointer:
    if obj["id"] != expected_id:
        raise SafetyPolicyDiscoveryError(
            f"Pointer id {obj['id']!r} does not match requested id {expected_id!r}"
        )
    url = obj["url"]
    if not (url.startswith("https://") or url.startswith("http://")):
        raise SafetyPolicyDiscoveryError(
            f"Pointer url must be http(s): got {url!r}"
        )
    if not re.match(r"^sha256:[0-9a-fA-F]{64}$", obj["hash"]):
        raise SafetyPolicyDiscoveryError(
            f"Pointer hash must be sha256:<64 hex chars>: got {obj['hash']!r}"
        )
    return SafetyPolicyPointer(
        id=obj["id"],
        url=url,
        hash=obj["hash"],
        published_at=obj.get("published_at"),
    )


# ── Loader + discovery ──────────────────────────────────────────────────────


async def load_safety_policy(
    *,
    url: str,
    hash: str | None = None,
    cache: SafetyPolicyCache | None = None,
    client: httpx.AsyncClient | None = None,
    cache_key: str | None = None,
    timeout: float = 30.0,
) -> SafetyPolicyDescriptor:
    """Fetch + verify + cache a safety-policy descriptor.

    If ``hash`` is provided, the fetched bytes MUST hash to it
    (raises :class:`SafetyPolicyHashMismatchError` otherwise).

    Cache hits skip the network. Default cache is process-wide
    in-memory; pass a custom :class:`SafetyPolicyCache` to share with
    other Codec calls.
    """
    cache = cache or _DEFAULT_CACHE
    key = cache_key or f"{url}#{hash or ''}"

    cached = await cache.get(key)
    if cached is not None:
        return cached

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
            raise SafetyPolicyHashMismatchError(expected, actual)

    parsed = json.loads(body)
    descriptor = descriptor_from_json(parsed)
    await cache.set(key, descriptor)
    return descriptor


async def discover_safety_policy(
    *,
    origin: str,
    id: str,
    hash: str | None = None,
    cache: SafetyPolicyCache | None = None,
    client: httpx.AsyncClient | None = None,
    timeout: float = 30.0,
) -> SafetyPolicyDescriptor:
    """Resolve a safety-policy descriptor via ``.well-known/codec/policies/``.

    If ``hash`` is provided, fetches the immutable content-addressed
    sibling at ``<origin>/.well-known/codec/policies/sha256/<hex>.json``
    and verifies the bytes match. Otherwise fetches the mutable per-id
    document and follows a pointer if present.

    Example::

        from codecai import discover_safety_policy

        policy = await discover_safety_policy(
            origin="https://acme.example",
            id="acme/strict-v3",
            hash="sha256:abc...",
        )

    Raises :class:`SafetyPolicyDiscoveryNotFoundError` for HTTP 404,
    :class:`SafetyPolicyDiscoveryError` for malformed pointers /
    mismatched ids, and :class:`SafetyPolicyHashMismatchError` if the
    fetched bytes don't hash to the expected value.
    """
    own_client = client is None
    used_client = client or httpx.AsyncClient(timeout=timeout, follow_redirects=True)

    try:
        if hash is not None:
            hash_hex = _parse_hash(hash)
            url = well_known_policy_hash_url(origin, hash_hex)
            resp = await used_client.get(url)
            if resp.status_code == 404:
                raise SafetyPolicyDiscoveryNotFoundError(url, resp.status_code)
            resp.raise_for_status()
            body = resp.content
            actual = hashlib.sha256(body).hexdigest()
            if actual != hash_hex:
                raise SafetyPolicyHashMismatchError(hash_hex, actual)
            parsed = json.loads(body)
            if _is_pointer_shape(parsed):
                pointer = _validate_pointer(parsed, id)
                return await load_safety_policy(
                    url=pointer.url,
                    hash=pointer.hash,
                    cache=cache,
                    client=client,
                    cache_key=f"well-known:{origin}#{id}#{pointer.hash}",
                    timeout=timeout,
                )
            descriptor = descriptor_from_json(parsed)
            if descriptor.id != id:
                raise SafetyPolicyDiscoveryError(
                    f"Inline descriptor id {descriptor.id!r} does not "
                    f"match requested id {id!r}"
                )
            return descriptor

        url = well_known_policy_url(origin, id)
        resp = await used_client.get(url)
        if resp.status_code == 404:
            raise SafetyPolicyDiscoveryNotFoundError(url, resp.status_code)
        resp.raise_for_status()
        parsed = json.loads(resp.content)
        if _is_pointer_shape(parsed):
            pointer = _validate_pointer(parsed, id)
            return await load_safety_policy(
                url=pointer.url,
                hash=pointer.hash,
                cache=cache,
                client=client,
                cache_key=f"well-known:{origin}#{id}#{pointer.hash}",
                timeout=timeout,
            )
        descriptor = descriptor_from_json(parsed)
        if descriptor.id != id:
            raise SafetyPolicyDiscoveryError(
                f"Inline descriptor id {descriptor.id!r} does not "
                f"match requested id {id!r}"
            )
        return descriptor
    finally:
        if own_client:
            await used_client.aclose()


__all__ = [
    "POLICY_WELL_KNOWN_BASE",
    "Category",
    "ClassifierBlock",
    "ClientHooksBlock",
    "MemorySafetyPolicyCache",
    "PublisherBlock",
    "RulesSummary",
    "SafetyPolicyCache",
    "SafetyPolicyDescriptor",
    "SafetyPolicyDiscoveryError",
    "SafetyPolicyDiscoveryNotFoundError",
    "SafetyPolicyHashMismatchError",
    "SafetyPolicyPointer",
    "SafetyPolicyValidationError",
    "descriptor_canonical_bytes",
    "descriptor_from_json",
    "discover_safety_policy",
    "hash_safety_policy",
    "load_safety_policy",
    "validate_safety_policy",
    "well_known_policy_hash_url",
    "well_known_policy_url",
]


# Public type alias kept narrow for callers preferring a function signature.
LoadSafetyPolicy = Awaitable[SafetyPolicyDescriptor]
