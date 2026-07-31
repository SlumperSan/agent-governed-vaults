#!/usr/bin/env python3
"""Merge agent-written backlog rows from notes/backlog-inbox/ into idea-backlog.md.

WHY THIS EXISTS — it is a context-budget fix, not a tidiness one.

The loop's harvest step used to work like this: an agent returned a long prose
report, the coordinator read it, then re-typed a backlog row into a bash heredoc.
That pays for the same text THREE times in the coordinator's context - once in the
agent's return payload, once in the tool call writing it, once in the echoed result.
On a long session that is tens of thousands of tokens spent transcribing.

Now: the agent writes its own row straight to `notes/backlog-inbox/<slug>.md` and
returns a short summary. This script moves those rows into the real backlog. The
coordinator never holds the row text at all.

    python scripts/backlog-merge.py            # merge, then delete the inbox files
    python scripts/backlog-merge.py --dry-run  # show what would merge

Inbox file format - a heading line, then the row(s):

    ## <section heading the row belongs under>
    | Idea | Source | Why it matters | Status |
    |---|---|---|---|
    | ... | ... | ... | ... |

A file whose heading already exists in the backlog has its rows appended under
that heading. A new heading is inserted near the top, after the baselines block,
where recent work lives.
"""

from __future__ import annotations

import shutil
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKLOG = ROOT / "ORG-BACKLOG.md"
INBOX = ROOT / "inbox"

# New sections land directly after this marker, so the newest work reads first
# and the file stays roughly reverse-chronological.
ANCHOR = "Status: `open` · `building` · `shipped` · `parked` · `blocked`"


def read_inbox() -> list[tuple[Path, str, str]]:
    """-> [(path, heading, body)] for every .md in the inbox, oldest first."""
    if not INBOX.exists():
        return []
    out = []
    for f in sorted(INBOX.glob("*.md"), key=lambda p: p.stat().st_mtime):
        text = f.read_text(encoding="utf-8").strip()
        if not text:
            continue
        lines = text.splitlines()
        heading = next((l for l in lines if l.startswith("## ")), None)
        if heading is None:
            # No heading supplied - give it one rather than dropping the row.
            heading = f"## Harvested {date.today().isoformat()} ({f.stem})"
            body = text
        else:
            body = "\n".join(lines[lines.index(heading) + 1 :]).strip()
        out.append((f, heading.strip(), body))
    return out


def merge(dry: bool) -> int:
    items = read_inbox()
    if not items:
        print("inbox empty - nothing to merge")
        return 0

    s = BACKLOG.read_text(encoding="utf-8")
    if not dry:
        shutil.copy2(BACKLOG, BACKLOG.with_suffix(".md.bak"))

    merged, appended = [], []
    for path, heading, body in items:
        if heading in s:
            # Append under the existing heading: insert just before the next
            # "## " so the rows join that section's table rather than starting
            # a duplicate one.
            start = s.index(heading)
            nxt = s.find("\n## ", start + 1)
            cut = nxt if nxt != -1 else len(s)
            # Drop a repeated table header - the section already has one.
            rows = "\n".join(
                l for l in body.splitlines() if not set(l.strip()) <= {"|", "-", ":", " "} and l.strip()
            )
            rows = "\n".join(l for l in rows.splitlines() if not l.strip().startswith("| Idea |"))
            s = s[:cut].rstrip() + "\n" + rows + "\n\n" + s[cut:].lstrip("\n")
            appended.append(heading)
        else:
            if ANCHOR not in s:
                print(f"ERROR: anchor not found in {BACKLOG.name}", file=sys.stderr)
                return 2
            i = s.index(ANCHOR)
            j = s.index("\n---", i)
            block = f"\n\n{heading}\n\n{body}\n"
            s = s[: j + 4] + block + s[j + 4 :]
            merged.append(heading)
        if not dry:
            path.unlink()

    if dry:
        print("DRY RUN - nothing written")
    else:
        BACKLOG.write_text(s, encoding="utf-8")
    for h in merged:
        print(f"  new section : {h[:88]}")
    for h in appended:
        print(f"  appended to : {h[:88]}")
    print(f"{len(items)} inbox file(s) {'would be ' if dry else ''}merged")
    return 0


if __name__ == "__main__":
    INBOX.mkdir(parents=True, exist_ok=True)
    raise SystemExit(merge("--dry-run" in sys.argv))
