#!/usr/bin/env python3
"""Check prose against the house writing rules.

Written after a session where the same rules were violated repeatedly despite
being recorded in memory. A note was not enough, so this is the mechanical
check. Run it on anything user-facing before shipping: articles, commit
messages, PR bodies, docs, code comments.

    python prose-lint.py FILE [FILE...]
    python prose-lint.py --stdin < message.txt
    git log -1 --format=%B | python prose-lint.py --stdin

Exit code is 1 when anything is found, so it can gate a commit.

The rules come from these memories:
    feedback-plain-sentences-no-duality   one statement per sentence
    feedback-no-antithesis-tic            no clause defined against its opposite
    feedback-no-fancy-dashes              no em/en dash glyphs
    no-emdash-ai-tell

Why it flattens whitespace first: the earlier hand-rolled checks were
line-based and silently missed every violation that wrapped across a newline,
which is most of them in hard-wrapped prose. Flattening is the whole point.
"""

import argparse
import io
import re
import sys

# Windows consoles default to cp1252, which cannot encode the very glyphs this
# tool exists to report. Force UTF-8 on both streams.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(encoding='utf-8', errors='replace')

# (pattern, label, note). Patterns run against whitespace-flattened text.
RULES = [
    (r',\s+and\s+', 'clause-join',
     'Two independent clauses joined with ", and". Split into two sentences. '
     'A serial list of three or more items is fine.'),
    (r',\s+so\s+', 'clause-join',
     'Two independent clauses joined with ", so". Split into two sentences.'),
    (r',\s+which\s+', 'clause-join',
     'Trailing ", which" clause. Start a new sentence with "That".'),
    (r',\s+because\s+', 'clause-join',
     'Trailing ", because" clause. Split, or lead with the reason.'),
    (r',\s+not\s+', 'this-not-that',
     'Clause defined against its opposite. State the true half only.'),
    (r'\bnot\s+\w+[^.]{0,40}\bbut\s+', 'this-not-that',
     '"not X but Y". State the true half only.'),
    (r'\bis\s+not\s+[^.]{0,40}\bit\s+is\b', 'this-not-that',
     '"it is not X, it is Y". State the true half only.'),
    (r'\brather\s+than\b', 'this-not-that',
     '"rather than" defines by contrast. Survives only when defining a term.'),
    (r'\binstead\s+of\b', 'this-not-that',
     '"instead of" defines by contrast. Usually cuttable.'),
    (r'\bless\s+a\b[^.]{0,40}\bthan\s+a\b', 'this-not-that',
     '"less a X than a Y". State the true half only.'),
    (r'(?<![\w-])(Two|Three|Four|Five|Six)\s+\w+[^.]{0,24}\b(follow|are|apply|remain)\b',
     'count-predicate',
     'Counting things before listing them. Just list them.'),
    ('—', 'dash-glyph', 'Em-dash. Use a period, comma, colon or parentheses.'),
    ('–', 'dash-glyph', 'En-dash. Use "to" for ranges.'),
    ('―', 'dash-glyph', 'Horizontal bar.'),
    ('−', 'dash-glyph', 'Minus sign glyph. Use a plain hyphen.'),
    (r'\s-{1,2}\s', 'dash-delimiter',
     'Spaced hyphen used as a dash. Recast the sentence.'),
    (r'(?m)^\s*And\s+', 'and-opener', 'Sentence opening with "And".'),
]


def strip_uninteresting(text, is_markdown):
    """Blank out regions where the rules do not apply.

    Fenced code, inline code, link targets and table rows are not prose. They
    are replaced with spaces so reported offsets stay meaningful.
    """
    def blank(m):
        # Replace every character except a newline. Blanking the newlines too
        # collapsed a fenced block onto one line, so the line counter stopped
        # advancing and every finding after the first fence in a file was
        # reported at the wrong line. Measured on codec-website: findings at
        # true lines 262, 264, 269 and 270 were reported as 112, 114, 118, 119.
        return re.sub(r'[^\n]', ' ', m.group(0))

    text = re.sub(r'```.*?```', blank, text, flags=re.S)
    text = re.sub(r'`[^`\n]*`', blank, text)
    text = re.sub(r'\]\([^)]*\)', blank, text)
    text = re.sub(r'https?://\S+', blank, text)
    if is_markdown:
        text = re.sub(r'(?m)^\s*\|.*$', blank, text)
        # A leading "- " is a list bullet. Flattening whitespace would splice it
        # onto the previous line and the dash-delimiter rule would fire on it.
        # m.end() is an absolute offset into the document, not the match
        # length, so this emitted one space per character preceding the bullet.
        # One file grew from 10,084 characters to 105,013. Use the same
        # length-preserving blank as everything else.
        text = re.sub(r'(?m)^(\s*)([-*+]|\d+\.)\s', blank, text)
    return text


def check(text, name, is_markdown):
    cleaned = strip_uninteresting(text, is_markdown)

    # Map every offset in the flattened string back to a source line.
    flat_chars, line_of = [], []
    line = 1
    prev_space = False
    for ch in cleaned:
        if ch == '\n':
            line += 1
        if ch.isspace():
            if prev_space:
                continue
            flat_chars.append(' ')
            line_of.append(line)
            prev_space = True
        else:
            flat_chars.append(ch)
            line_of.append(line)
            prev_space = False
    flat = ''.join(flat_chars)

    hits = []
    for pattern, label, note in RULES:
        for m in re.finditer(pattern, flat):
            i = m.start()
            hits.append((line_of[i] if i < len(line_of) else 0, label, note,
                         flat[max(0, i - 46):i + 44].strip()))
    hits.sort()
    for ln, label, note, ctx in hits:
        print('%s:%d: %s' % (name, ln, label))
        print('    ...%s...' % ctx)
        print('    %s' % note)
    return len(hits)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('files', nargs='*')
    ap.add_argument('--stdin', action='store_true', help='read prose from stdin')
    ap.add_argument('--quiet', action='store_true', help='only print the count')
    ap.add_argument('--markdown', action='store_true',
                    help='treat every input as markdown regardless of its name. '
                         'Use it for commit messages, which carry list bullets '
                         'but have no .md extension.')
    args = ap.parse_args()

    total = 0
    if args.stdin or not args.files:
        text = sys.stdin.read()
        total += check(text, '<stdin>', True)
    for path in args.files:
        with io.open(path, encoding='utf-8', errors='replace') as fh:
            text = fh.read()
        is_md = args.markdown or path.lower().endswith(('.md', '.markdown'))
        total += check(text, path, is_md)

    if total:
        print()
        print('%d issue%s. Serial lists of three or more items are allowed; '
              'ignore those.' % (total, '' if total == 1 else 's'))
    elif not args.quiet:
        print('clean')
    return 1 if total else 0


if __name__ == '__main__':
    sys.exit(main())
