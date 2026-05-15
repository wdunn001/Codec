"""Tests for codecai.version_signaling — mirrors @codecai/web's
version-signaling.test.ts so both sides of the wire stay in step.

Run::

    pytest -xvs packages/python/tests/test_version_signaling.py
"""

from __future__ import annotations

import json

import pytest

from codecai.version_signaling import (
    CODEC_CLIENT_VERSION,
    CODEC_CLIENT_VERSION_HEADER,
    CodecVersionPolicyDocument,
    CodecVersionRequiredError,
    parse_version_policy_document,
    parse_version_required,
    well_known_version_policy_url,
    with_codec_client_version,
)


# ── with_codec_client_version ────────────────────────────────────────────────


def test_with_codec_client_version_adds_header_when_absent():
    h = with_codec_client_version()
    assert h[CODEC_CLIENT_VERSION_HEADER] == CODEC_CLIENT_VERSION


def test_with_codec_client_version_preserves_caller_set_header():
    h = with_codec_client_version({CODEC_CLIENT_VERSION_HEADER: "0.3"})
    assert h[CODEC_CLIENT_VERSION_HEADER] == "0.3"


def test_with_codec_client_version_preserves_case_insensitive_caller_set():
    """If caller used a different casing, we must not duplicate the header."""
    h = with_codec_client_version({"codec-client-version": "0.3"})
    # Exactly one header set, regardless of casing.
    keys_lower = [k.lower() for k in h]
    assert keys_lower.count(CODEC_CLIENT_VERSION_HEADER.lower()) == 1


def test_with_codec_client_version_respects_override():
    h = with_codec_client_version(override_version="0.2")
    assert h[CODEC_CLIENT_VERSION_HEADER] == "0.2"


def test_with_codec_client_version_merges_existing_headers():
    h = with_codec_client_version({"X-Custom": "foo"})
    assert h["X-Custom"] == "foo"
    assert h[CODEC_CLIENT_VERSION_HEADER] == CODEC_CLIENT_VERSION


# ── parse_version_required ──────────────────────────────────────────────────


class _FakeResp:
    def __init__(self, status_code: int, body: object):
        self.status_code = status_code
        self.text = json.dumps(body) if not isinstance(body, str) else body

    def json(self):
        return json.loads(self.text)


VALID_BODY = {
    "error": "codec_version_required",
    "minimum_version": "0.4",
    "required_features": ["safety-policy-enforcement"],
    "client_version": "0.3",
    "docs_url": "https://codecai.net/docs/version-negotiation/",
    "deployment_id": "lab-test",
}


def test_parse_version_required_returns_none_for_non_426():
    assert parse_version_required(_FakeResp(200, {"ok": True})) is None


def test_parse_version_required_returns_typed_error_for_valid_body():
    err = parse_version_required(_FakeResp(426, VALID_BODY))
    assert isinstance(err, CodecVersionRequiredError)
    assert err.minimum_version == "0.4"
    assert err.client_version == "0.3"
    assert err.required_features == ("safety-policy-enforcement",)
    assert err.docs_url == "https://codecai.net/docs/version-negotiation/"
    assert err.deployment_id == "lab-test"


def test_error_message_names_required_features():
    err = parse_version_required(_FakeResp(426, VALID_BODY))
    msg = str(err)
    assert "requires v0.4" in msg
    assert "safety-policy-enforcement" in msg
    assert "speaks v0.3" in msg


def test_parse_version_required_raises_on_non_json_body():
    with pytest.raises(ValueError, match="was not JSON"):
        parse_version_required(_FakeResp(426, "plain text refusal"))


def test_parse_version_required_raises_on_unrecognized_shape():
    with pytest.raises(ValueError, match="unrecognized body"):
        parse_version_required(_FakeResp(426, {"error": "something_else", "foo": 1}))


def test_parse_version_required_handles_empty_required_features():
    body = dict(VALID_BODY, required_features=[])
    err = parse_version_required(_FakeResp(426, body))
    assert err is not None
    assert err.required_features == ()
    assert "requires:" not in str(err)


# ── parse_version_policy_document ────────────────────────────────────────────


def test_parse_version_policy_document_valid():
    doc = parse_version_policy_document(
        {
            "minimum_version": "0.4",
            "required_features": ["safety-policy-enforcement"],
            "deployment_id": "acme-prod",
            "docs_url": "https://codecai.net/docs/version-negotiation/",
            "valid_until": "2026-12-31T23:59:59Z",
        }
    )
    assert isinstance(doc, CodecVersionPolicyDocument)
    assert doc.minimum_version == "0.4"
    assert doc.required_features == ("safety-policy-enforcement",)
    assert doc.deployment_id == "acme-prod"


def test_parse_version_policy_document_rejects_missing_min_version():
    with pytest.raises(ValueError):
        parse_version_policy_document({"required_features": []})


def test_parse_version_policy_document_rejects_malformed_features():
    with pytest.raises(ValueError, match="required_features"):
        parse_version_policy_document(
            {"minimum_version": "0.4", "required_features": "not a list"}
        )


def test_well_known_url_helper():
    assert (
        well_known_version_policy_url("https://x.test/")
        == "https://x.test/.well-known/codec/version-policy.json"
    )


# ── Matrix: full client × server combinations ────────────────────────────────


CLIENT_VERSIONS = ["0.2", "0.3", "0.4", "0.5"]

SERVER_CONFIGS = [
    {
        "name": "default-off",
        "well_known": None,  # 404
        "refused": {v: False for v in CLIENT_VERSIONS},
    },
    {
        "name": "safety-enabled-not-enforced",
        "well_known": None,
        "refused": {v: False for v in CLIENT_VERSIONS},
    },
    {
        "name": "safety-enforced",
        "well_known": {
            "minimum_version": "0.4",
            "required_features": ["safety-policy-enforcement"],
        },
        "refused": {"0.2": True, "0.3": True, "0.4": False, "0.5": False},
    },
    {
        "name": "version-policy-strict",
        "well_known": {"minimum_version": "0.4", "required_features": []},
        "refused": {"0.2": True, "0.3": True, "0.4": False, "0.5": False},
    },
]


@pytest.mark.parametrize("cfg", SERVER_CONFIGS, ids=lambda c: c["name"])
@pytest.mark.parametrize("client_version", CLIENT_VERSIONS)
def test_matrix_refusal_and_body(cfg, client_version):
    """Simulate the server's behavior per (config × client). When the
    server would 426, the client's parse_version_required produces the
    correct typed error."""
    if cfg["refused"][client_version]:
        body = {
            "error": "codec_version_required",
            "minimum_version": cfg["well_known"]["minimum_version"],
            "required_features": cfg["well_known"]["required_features"],
            "client_version": client_version,
            "docs_url": "https://codecai.net/docs/version-negotiation/",
        }
        err = parse_version_required(_FakeResp(426, body))
        assert err is not None
        assert err.minimum_version == "0.4"
        assert err.client_version == client_version
        assert err.required_features == tuple(cfg["well_known"]["required_features"])
    else:
        err = parse_version_required(_FakeResp(200, {"ok": True}))
        assert err is None


@pytest.mark.parametrize("cfg", SERVER_CONFIGS, ids=lambda c: c["name"])
def test_matrix_well_known_doc(cfg):
    """When the server publishes a well-known doc, parse it. When it
    returns 404, we'd see ``None`` upstream — exercise only the parse
    path here."""
    if cfg["well_known"] is None:
        # Nothing to parse.
        return
    doc = parse_version_policy_document(cfg["well_known"])
    assert doc.minimum_version == "0.4"
    assert doc.required_features == tuple(cfg["well_known"]["required_features"])
