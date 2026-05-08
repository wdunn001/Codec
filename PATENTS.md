# Patent Policy

## Status

Quasarke LLC, the Licensor of Codec, is pursuing patent protection on
certain mechanisms disclosed in this repository and on the codecai.net
specification, including (but not limited to) novel control-plane primitives
for AI inference interoperation. As of this notice, no patents have issued;
applications are in preparation or filed.

## Intent

Quasarke's intent is to operate a hybrid licensing model:

1. **Spec-required mechanisms** — the wire format, session handshake,
   content-addressed tokenizer-map distribution, bidirectional binary
   endpoint, and reserved control-token address-space convention as
   described in `spec/PROTOCOL.md` — are intended to be made available
   under royalty-free or fair, reasonable, and non-discriminatory (FRAND)
   terms to any implementer of a published version of the Codec
   specification, when and if patents issue covering these mechanisms.

2. **Adjacent improvements** — including specific implementations of
   ToolWatcher, Translator, the pre-trained dictionary system, the
   `Codec-Zstd-Dict` response-header negotiation, and the dual-gate
   compression-selection logic — may be commercially licensed separately
   from the spec. A Codec-compliant implementation does not require these
   modules.

A formal patent license commitment will be published when patents issue
or when the corresponding non-provisional applications are filed,
whichever is sooner.

## Contributions

By contributing to this repository, you agree that your contributions are
licensed under the same terms as the project (BSL 1.1) and that you grant
Quasarke LLC a perpetual, worldwide, non-exclusive, royalty-free license
to use, modify, and sublicense your contributions, including the right to
include them in any future patent license commitment.

## Defensive Termination

Any patent license that Quasarke LLC ultimately grants to implementers of
the Codec specification will include a defensive termination clause:
the license terminates automatically as to any party that initiates patent
litigation against Quasarke LLC, its affiliates, or other Codec
implementers alleging that any portion of the Codec specification or a
compliant implementation thereof infringes a patent.

## Questions

For any specific patent question — including concerns about a particular
implementation, a request for clarification on the spec/adjacent
boundary, or a license inquiry — contact:

**licensing@quasarke.com**

We respond within a few business days and are happy to engage in good
faith with implementers, standards bodies, and prospective licensees.

---

This notice is informational and does not itself grant any patent license.
It is intended to clarify Quasarke's posture so that implementers and
contributors can plan accordingly.
