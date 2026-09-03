#!/usr/bin/env python3
"""CI wrapper around prose-lint.py that applies the serial-list exception.

prose-lint.py exits 1 on any finding, including the serial lists of three or
more items that the house rules explicitly permit. A gate built directly on its
exit code can therefore never go green, so the wrapper classifies findings
first.

Blocking:
    dash-glyph       em/en dash, figure dash, horizontal bar. No exception.
    this-not-that    a clause defined against its opposite. No exception.
    count-predicate  announcing a count before a list. No exception.
    clause-join      when joined with ", so", ", which", or ", because".
                     Those forms have no serial-list reading.

Advisory:
    clause-join joined with ", and". A serial list of three or more items is
    permitted, and telling one apart from two joined clauses needs to know
    where the sentence starts. The linter returns a fixed-width window with
    links and code spans already stripped, so that boundary is not recoverable
    here. Guessing produced false failures on real copy, so these are reported
    for a human to judge.

Point this at prose. The linter's dash-delimiter rule flags a spaced hyphen,
which is right for a sentence and wrong for `a - b`, so every subtraction in a
source file reports as a finding. The CI jobs pass only markdown for that
reason. Running it over code wastes the reader's time on arithmetic.

Usage:
    python scripts/prose-gate.py FILE [FILE...]
"""
import os
import re
import subprocess
import sys
from pathlib import Path

# Findings quote the prose verbatim, so arrows, curly quotes, and other
# non-ASCII reach stdout. A Windows console defaults to cp1252 and raises
# UnicodeEncodeError on the first one, which killed the run after the work was
# already done. Reconfigure both streams before anything prints.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):  # pragma: no cover - non-tty stream
        pass

HERE = Path(__file__).resolve().parent
LINTER = HERE / "prose-lint.py"

# Everything blocks except one case, so there is no blocking-rule set to keep
# in sync. An earlier version carried a BLOCKING_RULES set that read as the
# switch and was not: every rule outside "clause-join" reached the same
# blocking branch through the catch-all, so removing a rule from the set
# changed nothing. That is a trap for whoever edits this next, and the honest
# shape is to say plainly that the gate fails closed. A rule this file has
# never seen blocks too, so a new rule added to prose-lint.py surfaces here
# rather than passing in silence.
NO_EXCEPTION_JOINS = (", so ", ", which ", ", because ")

files = sys.argv[1:]
if not files:
    print("usage: prose-gate.py FILE [FILE...]", file=sys.stderr)
    sys.exit(2)

# The linter echoes source snippets, which carry any non-ASCII the prose
# contains. Windows decodes a subprocess pipe as cp1252 by default and raises
# UnicodeDecodeError on the first byte outside that range, which left
# proc.stdout as None. Pin UTF-8 on both ends and never fail on a stray byte.
env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
proc = subprocess.run(
    [sys.executable, str(LINTER), *files],
    capture_output=True,
    text=True,
    encoding="utf-8",
    errors="replace",
    env=env,
)
lines = (proc.stdout or "").splitlines()

header = re.compile(r"^(?P<file>.+?):(?P<line>\d+): (?P<rule>[a-z-]+)$")
blocking, advisory = [], []

i = 0
while i < len(lines):
    m = header.match(lines[i])
    if not m:
        i += 1
        continue
    snippet = lines[i + 1].strip() if i + 1 < len(lines) else ""
    finding = (m["file"], m["line"], m["rule"], snippet)
    rule = m["rule"]

    if rule == "clause-join":
        if any(j in snippet for j in NO_EXCEPTION_JOINS):
            blocking.append(finding)
        else:
            # The ", and" form is the only one with a permitted reading, since
            # a serial list of three or more items is allowed. Telling a list
            # apart from two joined clauses needs to know where the sentence
            # starts, and the linter hands back a fixed-width window with
            # links and code spans already stripped, so that boundary is not
            # recoverable here. Guessing produced false failures on real copy.
            # These are reported for a human instead of failing the build.
            advisory.append(finding)
    else:
        blocking.append(finding)
    i += 2

if advisory:
    print(f"{len(advisory)} advisory (serial-list shape, allowed):")
    for f, ln, rule, snip in advisory:
        print(f"  {f}:{ln} {rule}")
        print(f"      {snip}")
    print()

if blocking:
    print(f"prose gate FAILED: {len(blocking)} blocking findings.\n")
    for f, ln, rule, snip in blocking:
        print(f"  {f}:{ln} {rule}")
        print(f"      {snip}")
    print("\nHouse rules: no dash glyphs, one statement per sentence, no clause")
    print("defined against its opposite. Serial lists of three or more are the")
    print("only exception.")
    sys.exit(1)

print(f"prose gate OK across {len(files)} files ({len(advisory)} advisory).")
