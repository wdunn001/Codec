# Submitting `draft-dunn-codec-00` to the IETF datatracker

Operational guide for moving the markdown source in this directory to
a live Internet-Draft at `https://datatracker.ietf.org/doc/`.

The submission is one-time per `-NN` version. Subsequent revisions
(`-01`, `-02`, ...) re-run the same steps with an incremented version
number; the rest of this guide stays valid.

---

## 0 · Pre-flight checklist

Verify these before doing anything else. **Each is a release-blocker
if missed.**

- [ ] `docs/submissions/draft-dunn-codec-00.md` exists and is the
  intended source.
- [ ] `author:` block in the frontmatter has the actual postal/email
  addresses (the current draft has email only. That is acceptable
  but **not optimal**: IETF prefers a real postal address; see
  RFC 7322 §4.1.2). If you want to keep email-only, leave as is;
  if you want to add a postal address before the first submission,
  edit the `author:` block now.
- [ ] `docname:` matches the filename (`draft-dunn-codec-00`).
- [ ] No bare `[ TBD ]` placeholders remain. Run:
      ```
      grep -nE "\[ ?TBD ?\]|XXX|FIXME" docs/submissions/draft-dunn-codec-00.md
      ```
      Expect zero matches.
- [ ] No standards-status terms used as labels in the body
  ("Proposed Standard", "Draft Standard", "Internet Standard",
  "Historic", "Experimental" referring to *this* document). Run:
      ```
      grep -nwE "Standard|Proposed|Historic|Experimental" docs/submissions/draft-dunn-codec-00.md
      ```
      Inspect each hit; uses of "standard" as a common noun (e.g.
      "the de-facto standard") are fine, references to RFCs by
      their status are fine. Direct claims that this draft is any
      named status are not.
- [ ] Abstract is 50 to 150 words. Count with:
      ```
      sed -n '/^# Abstract/,/^# Status/p' docs/submissions/draft-dunn-codec-00.md | wc -w
      ```
      The current draft is ~120 words.

---

## 1 · Convert markdown to RFCXML

The IETF datatracker accepts `.xml` (RFCXML v3, per RFC 7991) and
`.txt`. The markdown source uses the kramdown-rfc dialect; the
`kdrfc` tool converts it to both.

### Install kdrfc (one-time)

`kdrfc` is a Ruby gem. Requires Ruby 2.7+ available on PATH.

```
gem install kramdown-rfc2629
```

On Debian/Ubuntu without rubygems:
```
sudo apt-get install ruby-full
gem install --user-install kramdown-rfc2629
# add ~/.gem/ruby/<ver>/bin to PATH
```

Verify:
```
kdrfc --version
```

### Generate the XML + text + HTML

```
cd docs/submissions/
kdrfc draft-dunn-codec-00.md
```

`kdrfc` produces three sibling files:

- `draft-dunn-codec-00.xml`: the **submission artefact**.
- `draft-dunn-codec-00.txt`: the canonical plain-text rendering.
- `draft-dunn-codec-00.html`: preview for local review.

The Status-of-Memo and Copyright Notice sections are auto-generated
from the `ipr: trust200902` frontmatter field. The markdown source's
own "Status of This Memo" paragraph is overridden during conversion;
keeping it in the source is harmless and useful for human review.

### Open the HTML preview

```
xdg-open draft-dunn-codec-00.html   # Linux
open  draft-dunn-codec-00.html      # macOS
start draft-dunn-codec-00.html      # Windows
```

Read top-to-bottom. The IETF datatracker submission will reject if the
XML is malformed, but it does not check semantics: readability is on
the author.

---

## 2 · Validate the XML

The IETF runs a public validator at:

> `https://author-tools.ietf.org/`

Upload `draft-dunn-codec-00.xml`. The page reports:

- Whether the XML parses against RFC 7991.
- Whether the references resolve.
- Whether the structure meets the IETF formatting rules.
- A rendering of the document for visual inspection.

If the validator flags errors, fix them in the markdown source,
re-run `kdrfc`, and re-upload. **Do not edit the XML by hand**: the
markdown is the source of truth.

Common validator complaints + fixes:

| Validator says                                               | Fix in markdown source                                |
|--------------------------------------------------------------|-------------------------------------------------------|
| "Reference [Foo] not defined"                                | Add a `Foo:` entry under `normative:` or `informative:` in the frontmatter. |
| "Section reference {{TOOL}} unresolved"                      | Verify the target section has a matching `{#TOOL}` anchor. |
| "Author missing organization"                                | Add `organization:` to the `author:` block.           |
| "Date in past" / "Date too far in future"                    | The `date:` field is optional; remove it to let kdrfc fill in. |

---

## 3 · Datatracker account

If this is your first IETF submission:

> `https://datatracker.ietf.org/accounts/create/`

Provide the same email address listed in the `author:` block of the
frontmatter. The datatracker uses this address to send the submission
confirmation email; if the addresses do not match, the submission
will not complete.

The account is free and requires no IETF membership. The same account
manages all future drafts under any `draft-dunn-*` name.

---

## 4 · Submit

> `https://datatracker.ietf.org/submit/`

1. Click **"Submit a new Internet-Draft"**.
2. Upload `draft-dunn-codec-00.xml`. The submission page accepts the
   `.xml` form directly; the `.txt` form is also accepted and
   regenerated server-side from the XML.
3. The page extracts the document metadata (name, version, abstract,
   authors) and previews them. Verify before continuing.
4. The page asks which stream the draft belongs to:
   - **Independent Submission**: the current frontmatter sets this.
     Pick this option.
   - **IETF Working Group**: only if a WG chair has agreed to adopt
     the draft; not applicable for `-00`.
5. Submit.

The datatracker emails every address listed in the `author:` block.
**Click the confirmation link.** Without the confirmation click the
draft remains in "awaiting confirmation" state and is NOT publicly
listed.

After confirmation the draft is reachable at:

> `https://datatracker.ietf.org/doc/draft-dunn-codec/`

The `-00` suffix is stripped from the canonical URL; the URL always
resolves to the most recent revision.

---

## 5 · Announce

Submission alone does not generate review attention. The recommended
follow-ups:

### 5a · Working-group mailing-list post

If pitching for WG sponsorship (the path from Independent Submission
to standards-track), post to the most relevant WG list with a brief
note + I-D link. Codec is HTTP-adjacent; the two natural targets:

- **HTTPBIS WG**: `ietf-http-wg@w3.org`. Subscribe first at
  `https://www.ietf.org/mailman/listinfo/ietf-http-wg`.
- **AI Preferences WG**: `aipref@ietf.org`. Subscribe at
  `https://www.ietf.org/mailman/listinfo/aipref`.

Format the post as a 3-paragraph introduction:

1. One paragraph: what Codec is, who is using it, and why the WG
   might care.
2. One paragraph: what feedback you want (review, adoption
   consideration, scope question).
3. A link to the datatracker URL.

Do **not** attach the .xml; post the link only.

### 5b · IETF meeting

IETF meets three times per year (March, July, November). Each
meeting publishes its agenda 4 to 6 weeks before; WG chairs accept
new-draft presentation slots until ~2 weeks before the meeting.

- IETF meeting calendar: `https://www.ietf.org/how/meetings/`
- HTTPBIS agenda: announced on the WG mailing list ~4 weeks out.

A 5-minute "this exists, here's the link" slot in a WG session is
the highest-leverage outreach action. If neither WG sponsors
Codec at any meeting cycle, fall back to the Independent
Submission stream.

### 5c · Independent Submission stream

If no WG bites within ~3 months of `-00`, file with the Independent
Submissions Editor (ISE):

> `https://www.rfc-editor.org/about/independent/`

The ISE process is lighter-weight than WG adoption but produces an
Informational RFC rather than a Standards-Track one. For Codec
specifically, Informational is sufficient: the draft is purely
descriptive. It says "here's a thing that exists," never "here's
a thing the IETF endorses."

---

## 6 · Versioning and freshness

An Internet-Draft expires **6 months** after submission. If the
draft has not been revised in that window, the datatracker removes
it from the active listing. The draft remains in the archive
forever, but stops being considered "current work in progress."

To refresh, follow steps 1 to 4 again with the next version number:

- Edit `docname: draft-dunn-codec-01` (increment by 1).
- Rename the markdown source file to match.
- Re-run `kdrfc`.
- Re-submit via the datatracker submission page; the page detects
  the prior version and links them.

Successive revisions are cheap. The convention is to ship `-01`
within 2 to 4 weeks of `-00` to incorporate review feedback; subsequent
revisions every 1 to 3 months as the spec stabilizes.

When a WG adopts the draft (if it ever does), the name changes to
`draft-ietf-<wg>-codec-00`, restarting the version counter. The
prior `draft-dunn-codec-NN` series remains in the archive as the
historical individual-submission lineage.

---

## 7 · Don'ts

The IETF process has a handful of culture rules that are easy to
violate as a first-time submitter:

- **Do not refer to the draft as an RFC** in any external material
  (website, README, blog post, marketing copy). It is an
  Internet-Draft. Internet-Drafts are *not* RFCs.
- **Do not cite the draft except as "work in progress."** RFC 2026
  §2.2 is explicit: an I-D is not a publication and should not be
  cited as a normative reference in other work.
- **Do not let vendors claim "compliance with `draft-dunn-codec-00`."**
  Same rule. Compliance is asserted only against published RFCs.
- **Do not force-push or significantly rewrite a `-NN` after
  publication.** Each `-NN` is immutable once posted; revisions go
  to `-NN+1`. The datatracker enforces this.
- **Do not use status-implying words ("Proposed", "Draft", "Standard",
  "Experimental", "Historic") as labels for *this* draft.** Refer to
  it as "this document" or "this draft."
- **Do not skip the email-confirmation step after submission.** A
  large fraction of first-time submissions never become public
  because the author missed the confirmation email.

---

## 8 · One-shot command

For the experienced operator with kdrfc already installed and the
pre-flight checklist green:

```
cd docs/submissions/
kdrfc draft-dunn-codec-00.md
# upload draft-dunn-codec-00.xml at:
#   https://author-tools.ietf.org/     (validate)
#   https://datatracker.ietf.org/submit/   (submit)
# click the confirmation email
# done
```

The total wall-clock time from a green checklist to a live draft URL
is approximately 15 minutes, dominated by the email-confirmation
round-trip.
