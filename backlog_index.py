#!/usr/bin/env python3
"""Generate a compact, machine-readable index of notes/idea-backlog.md.

Why this exists: the backlog is the loop's step-(1) input on every tick, but it
has grown past 60k tokens because shipped rows keep their full evidence-bearing
status essays forever (deliberately - that history is the point). Reading the
whole file just to answer "what is still open and not waiting on Michael?" costs
more than the work the answer unlocks. This regenerates a ~2k-token answer to
exactly that question.

The index is DERIVED, never authoritative - idea-backlog.md stays the source of
truth. Regenerate after every harvest:

    python scripts/backlog-index.py

Classification reads only the first CLASSIFY_WINDOW characters of a status cell,
because the backlog's own convention is to lead every cell with its verdict
("**shipped 2026-07-25** - ...", "open, low priority", "**open - needs Michael.**").
Scanning the whole cell would misfile every shipped row that mentions a remaining
open follow-up in its body, which is most of them.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "ORG-BACKLOG.md"
OUTPUT = ROOT / "ORG-BACKLOG-INDEX.md"

CLASSIFY_WINDOW = 90
LEAD_WINDOW = 40

# Order matters: BLOCKED wins over OPEN, and both win over CLOSED, because a
# blocked row's cell nearly always says "open - needs Michael" and we must not
# hand it to an autonomous tick.
BLOCKED_MARKERS = (
    "needs michael",
    "michael's call",
    "michael's go-ahead",
    "michael's decision",
    "michael's approval",
    "awaiting michael",
    "pending michael",
    "blocked on michael",
    # 402cap's own vocabulary (ORG-CHARTER.md): a bare "blocked" cell means
    # blocked on Michael, and "parked" means deliberately stopped pending a
    # decision. Without these the org's own backlog reads as unclassified.
    "blocked",
    "parked",
    "michael, 2026",  # a rejection recorded in his own words
    # Code is written and tested but the deploy itself is Michael's call, so
    # this belongs with the blocked items, not the closed ones - a tick that
    # saw it in the closed count could not tell it still needs a decision.
    "built, not deployed",
)

# Phrases that make a nearby closed marker mean its opposite.
NEGATED_CLOSED_MARKERS = ("not fixed", "not done", "not started", "not shipped")

# Real closure decisions that happen to read like a negation.
DECIDED_AGAINST_MARKERS = ("not recommended to fix", "checked, nothing to fix")

CLOSED_MARKERS = (
    "shipped",
    # Verdicts introduced by later harvests. Each was an UNKNOWN until added;
    # the index degrades quietly when a real verdict isn't recognised, so
    # extend this list rather than rewording a status cell to suit the tool.
    "decided",
    "corrected",
    "refuted",
    "not available",
    "fixed",
    "verified",
    "done",
    "closed",
    "rejected",
    "cleared",
    "mitigated",
    "no action needed",
    "standing rule",
    "not recommended to fix",
    "checked, nothing to fix",
)

# Deliberately NOT a closed marker: "triaged". Those cells genuinely mix a
# resolved half with a still-blocked half (e.g. M4's REDIS_URL confirmation),
# so they should land in UNKNOWN and force a human read rather than quietly
# disappearing into the closed count.

OPEN_MARKERS = (
    "open",
    "not started",
    "planned",
    "building",
    "built, partially open",
    "draft written",   # written but not adopted -> still live work
    "partial",         # explicitly half-done
    "obtainable",      # feasibility verdict: reachable but NOT yet built
)


def classify(status: str) -> str:
    """Classify a status cell from its LEADING verdict only.

    Only the lead is trusted. A closed row's evidence prose routinely contains
    "still", "needs", "remains open" and even "fixed" while describing what it
    did or deferred, so any wide-window keyword scan mislabels rows in both
    directions. When the lead is unrecognised the answer is UNKNOWN, which
    surfaces the row for a human read - never a guess.
    """
    head = strip_md(status)[:CLASSIFY_WINDOW].lower()
    lead = head[:LEAD_WINDOW]

    # Explicit closure verdicts that happen to contain a negation, checked
    # before the negation guard below would veto them.
    if any(m in lead for m in DECIDED_AGAINST_MARKERS):
        return "CLOSED"

    # The backlog's convention is verdict-FIRST, so a cell that OPENS with an
    # open marker is open, full stop - whatever else the lead goes on to say.
    # Without this, a live row reading "open - ratio half verified 2026-07-27"
    # is filed closed on the word "verified" sitting in its evidence, which is
    # the same silent-burial failure the "not fixed" guard exists to prevent.
    # Blocked still wins, because "open - needs Michael" opens with "open" too.
    if any(lead.startswith(m) for m in OPEN_MARKERS):
        return "BLOCKED" if any(m in head for m in BLOCKED_MARKERS) else "OPEN"
    # "open - recommendation, not fixed" must never read as fixed. This was a
    # real misfile: the wide-window scan matched "fixed" inside "not fixed" and
    # buried a live item in the closed count, where no tick would ever see it.
    negated = any(m in lead for m in NEGATED_CLOSED_MARKERS)

    # A leading closed verdict settles it, and must beat the blocked markers:
    # several rows read "shipped ... mislabeled as needing Michael's call",
    # which describes a corrected mislabel, not a live block.
    if not negated and any(m in lead for m in CLOSED_MARKERS):
        return "CLOSED"
    if any(m in head for m in BLOCKED_MARKERS):
        return "BLOCKED"
    if any(m in lead for m in OPEN_MARKERS):
        return "OPEN"
    return "UNKNOWN"


def split_row(raw: str) -> list[str]:
    """Split a markdown table row into its cells.

    Cells here legitimately contain unescaped `|` (query strings like
    `kind=potential|bonus-potential`, regex snippets), so a naive split
    over-shards the row and shifts every column after the offender. Callers
    recombine the tail via the header-derived column count instead of
    assuming the status cell is at a fixed index.
    """
    cells = raw.split("|")
    if cells and not cells[0].strip():
        cells = cells[1:]
    if cells and not cells[-1].strip():
        cells = cells[:-1]
    return cells


def row_status(cells: list[str], status_idx: int, ncols: int) -> str:
    """Pull the status cell out of a row, tolerating two real defects.

    Status is the last column of every table in the backlog, so in a well-formed
    row it is simply `cells[status_idx]`. Two things break that:

    1. **Stray pipes.** Status cells contain unescaped `|` (query strings like
       `kind=potential|bonus-potential`), which over-shards the row. The fix is
       to rejoin everything from `status_idx` onward.
    2. **Extra columns.** Some hand-written rows carry more real columns than
       their table's header declares - a 4-column row under an `Item | Source |
       Status` header. Rejoining from `status_idx` then prepends the preceding
       column's prose, and that prose has twice now contained a verdict word
       ("...pulls in FIXED vite/esbuild...") that classified the whole row wrong.

    The two are told apart by whether the row's LAST cell classifies on its own:
    a genuine extra column ends with a real verdict, whereas a stray-pipe shard
    ends mid-sentence and classifies as UNKNOWN.
    """
    if status_idx >= len(cells):
        return ""
    if len(cells) > ncols:
        last = cells[-1].strip()
        if last and classify(last) != "UNKNOWN":
            return last
    joined = "|".join(cells[status_idx:]).strip()
    if classify(joined) != "UNKNOWN":
        return joined
    # Last resort: walk the start index forward looking for any recognisable
    # verdict, rather than reporting UNKNOWN on a row we could have read.
    for j in range(status_idx + 1, len(cells)):
        candidate = "|".join(cells[j:]).strip()
        if classify(candidate) != "UNKNOWN":
            return candidate
    return joined


def strip_md(text: str) -> str:
    """Flatten a cell to plain-ish text so the index stays scannable."""
    text = re.sub(r"\*\*|`|\*", "", text)
    return re.sub(r"\s+", " ", text).strip()


def clip(text: str, n: int) -> str:
    text = strip_md(text)
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


# Every case here is a real status cell (or a faithful shortening of one) that
# the classifier got WRONG at some point. Run with --selftest after touching the
# marker lists; a regression here silently hides live work from the loop.
SELFTEST_CASES = (
    ("open — recommendation, not fixed. Timing is a product call", "OPEN"),
    # Harvest verdicts that were silently UNKNOWN until the marker lists grew.
    ("**draft written 2026-07-27, NOT lawyer-reviewed, NOT adopted.** 17 sections", "OPEN"),
    ("**PARTIAL, corrected 2026-07-27** — 3 categories confirmed on-chain", "OPEN"),
    ("**OBTAINABLE 2026-07-27** — two Glacier calls, demonstrated end-to-end", "OPEN"),
    ("**NOT AVAILABLE — blocked, not merely undone.** No bulk endpoint exists", "CLOSED"),
    ("**refuted 2026-07-27, independently re-verified.** Listings are off-chain", "CLOSED"),
    ("**decided 2026-07-27.** Age is a fact about the person", "CLOSED"),
    ("**corrected 2026-07-27** — the right field is enablePotential", "CLOSED"),
    ("**built, partially open.** Source is msu.io's listing-level tiers", "OPEN"),
    ("**shipped 2026-07-26** — mislabeled as needing Michael's call", "CLOSED"),
    ("**open — needs Michael.** Requires a real off-site target", "BLOCKED"),
    ("open, low priority — swap to an async/non-blocking SQLite read", "OPEN"),
    ("not recommended to fix — cost exceeds the value of closing it", "CLOSED"),
    ("**built, not deployed, 2026-07-24** — all three functions fixed", "BLOCKED"),
    ("**shipped 2026-07-25** — still uses the old path, needs a follow-up", "CLOSED"),
    ("**verified-clean**, no action needed", "CLOSED"),
    ("open — Michael's call on outreach/timing", "BLOCKED"),
    ("standing rule", "CLOSED"),
    ("open, not started", "OPEN"),
    # An open row whose own evidence contains closure words. Real row: the
    # Henesys ratio recheck, half-confirmed with the whitepaper half still 403ing.
    ("**open — ratio half verified 2026-07-27, whitepaper half unverified**", "OPEN"),
    ("open — fixed the easy half, the rest is not done", "OPEN"),
    ("**cleared 2026-07-27** — all 46 removed (46 → 0)", "CLOSED"),
    # "mitigated" is a real closure verdict, but the row it closes usually spawns
    # a narrower open follow-up - that follow-up must be its own row, not implied.
    ("**mitigated 2026-07-27 (not fully closed — see the row below)**", "CLOSED"),
)


# Real malformed rows from the backlog, reduced to their shape. Both defects
# below produced a WRONG verdict rather than an unreadable one, which is the
# dangerous kind: the row still landed in a bucket, just not the right one.
ROW_SELFTEST_CASES = (
    # Extra column - a 4-cell row under a 3-column `Item | Source | Status`
    # header. Joining from status_idx picks up the why-column's prose, whose
    # "pulls in fixed vite" once classified this live row as CLOSED.
    (
        ["npm audit bumps", "triage", "Backend: vitest 4.x pulls in fixed vite", "open"],
        2,
        3,
        "OPEN",
    ),
    # Stray pipe INSIDE the status cell - the row over-shards, but the status
    # still starts at status_idx and must be rejoined, not truncated.
    (
        [
            "Calculators",
            "research",
            "why",
            "**shipped** — GET /calc?kind=potential",
            "bonus-potential",
        ],
        3,
        4,
        "CLOSED",
    ),
    # Well-formed row - nothing clever should happen.
    (["Backups off-machine", "DR review", "why", "**open — needs Michael.**"], 3, 4, "BLOCKED"),
)


def selftest() -> int:
    failures = 0
    for text, want in SELFTEST_CASES:
        got = classify(text)
        if got != want:
            failures += 1
            print(f"FAIL classify want={want} got={got} :: {text}", file=sys.stderr)
    for cells, idx, ncols, want in ROW_SELFTEST_CASES:
        got = classify(row_status(list(cells), idx, ncols))
        if got != want:
            failures += 1
            print(f"FAIL row want={want} got={got} :: {cells}", file=sys.stderr)
    total = len(SELFTEST_CASES) + len(ROW_SELFTEST_CASES)
    print(f"backlog-index selftest: {total - failures}/{total} pass")
    return 1 if failures else 0


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    if not SOURCE.exists():
        print(f"missing source: {SOURCE}", file=sys.stderr)
        return 1

    lines = SOURCE.read_text(encoding="utf-8").splitlines()

    buckets: dict[str, list[tuple[int, str, str, str]]] = {
        "OPEN": [],
        "BLOCKED": [],
        "UNKNOWN": [],
    }
    closed_count = 0
    section = "(top of file)"
    # Learned per-table from its header row. The backlog holds tables of
    # differing shapes (the 4-column Idea/Source/Why/Status grid, plus a
    # 3-column Item/Source/Status list under "Open loose threads"), so a
    # hardcoded index silently reads the wrong column in one of them.
    status_idx: int | None = None
    ncols = 0
    # Accounting. A row that silently vanishes is worse than one misfiled: the
    # output gives no hint it ever existed. Every data row must land in exactly
    # one bucket or be named in `dropped`.
    seen_rows = 0
    # Section headings can carry their own verdict ("## Foo. Status: `building`")
    # and land in a bucket too, so they must be counted or the totals never
    # reconcile - this is exactly what the accounting check caught.
    seen_headings = 0
    dropped: list[tuple[int, str, str]] = []

    for i, raw in enumerate(lines, start=1):
        if raw.startswith("## "):
            section = strip_md(raw[3:])
            status_idx, ncols = None, 0
            # A section heading can itself carry a status ("Status: `building`").
            m = re.search(r"Status:\s*(.+)$", raw)
            if m:
                seen_headings += 1
                kind = classify(strip_md(m.group(1)))
                if kind == "CLOSED":
                    closed_count += 1
                elif kind in buckets:
                    buckets[kind].append(
                        (i, section, clip(section, 110), clip(m.group(1), 170))
                    )
            continue

        if not raw.startswith("|"):
            continue
        cells = split_row(raw)
        if not cells:
            continue

        # Header row: learn this table's shape, then skip it.
        lowered = [c.strip().lower() for c in cells]
        if "status" in lowered:
            status_idx, ncols = lowered.index("status"), len(cells)
            continue
        # Separator row (`|---|---|`).
        if all(set(c.strip()) <= {"-", ":"} and c.strip() for c in cells):
            continue
        seen_rows += 1
        if status_idx is None:
            # The "Rejected / parked" table is `Idea | Reason` by design - a
            # rejection's verdict IS the section it sits in. Count these closed
            # rather than parading two standing prohibitions (no GitHub, no
            # automated sniping) through the unreadable list on every run.
            if "rejected" in section.lower() or "parked" in section.lower():
                closed_count += 1
                continue
            # Any other table whose header has no literal "Status" column. Its
            # rows are unreadable here, but must still be visible in the output.
            dropped.append((i, clip(cells[0], 90), "table header has no Status column"))
            continue

        idea = cells[0].strip()
        if not idea:
            dropped.append((i, "(blank first cell)", "no idea text"))
            continue
        status = row_status(cells, status_idx, ncols)
        if not status:
            dropped.append((i, clip(idea, 90), "empty status cell"))
            continue
        kind = classify(status)
        if kind == "CLOSED":
            closed_count += 1
        else:
            buckets[kind].append((i, section, clip(idea, 110), clip(status, 170)))

    out: list[str] = [
        "# Backlog open-items index (DERIVED - do not edit by hand)",
        "",
        f"Generated from `notes/idea-backlog.md` by `scripts/backlog-index.py`. "
        f"Source is {len(lines)} lines; this index exists so a loop tick can answer "
        f'"what is unblocked?" without reading all of it.',
        "",
        "**`notes/idea-backlog.md` remains the source of truth.** Regenerate this "
        "file after every harvest; never edit it directly, and never treat a "
        "one-line summary here as sufficient context to start building - open the "
        "cited line in the real backlog first.",
        "",
        f"Counts: **{len(buckets['OPEN'])} unblocked** · "
        f"{len(buckets['BLOCKED'])} blocked on Michael · "
        f"{closed_count} closed · {len(buckets['UNKNOWN'])} unclassified",
        "",
        f"Row accounting: {seen_rows} data rows + {seen_headings} statused "
        f"headings seen, {seen_rows + seen_headings - len(dropped)} classified, "
        f"{len(dropped)} unreadable"
        + (" — listed at the bottom." if dropped else "."),
        "",
        "---",
        "",
        "## Unblocked - eligible for an autonomous tick",
        "",
    ]

    def emit(rows: list[tuple[int, str, str, str]]) -> None:
        if not rows:
            out.append("_(none)_")
            out.append("")
            return
        for line_no, sect, idea, status in rows:
            out.append(f"- **L{line_no}** — {idea}")
            out.append(f"  - status: {status}")
            out.append(f"  - section: {sect}")
        out.append("")

    emit(buckets["OPEN"])
    out += [
        "---",
        "",
        "## Blocked on Michael - DO NOT start these autonomously",
        "",
    ]
    emit(buckets["BLOCKED"])
    out += [
        "---",
        "",
        "## Unclassified - the status cell did not lead with a recognised verdict",
        "",
        "These need a human read. An unrecognised verdict is more often a badly "
        "worded status cell than a new category, so fixing the cell in the real "
        "backlog is usually the right response.",
        "",
    ]
    emit(buckets["UNKNOWN"])

    if dropped:
        out += [
            "---",
            "",
            "## Unreadable rows - present in the backlog, absent from every bucket",
            "",
            "The parser could not find a verdict for these. They are listed so a "
            "row can never disappear silently; fix the row in the real backlog.",
            "",
        ]
        for line_no, idea, why in dropped:
            out.append(f"- **L{line_no}** — {idea} _({why})_")
        out.append("")

    classified = len(buckets["OPEN"]) + len(buckets["BLOCKED"]) + len(buckets["UNKNOWN"]) + closed_count
    expected = seen_rows + seen_headings
    if classified + len(dropped) != expected:
        print(
            f"ACCOUNTING BUG: saw {seen_rows} data rows + {seen_headings} "
            f"statused headings ({expected}) but accounted for "
            f"{classified + len(dropped)} - entries are being lost",
            file=sys.stderr,
        )
        return 2

    OUTPUT.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(
        f"wrote {OUTPUT.relative_to(ROOT)}: "
        f"{len(buckets['OPEN'])} open, {len(buckets['BLOCKED'])} blocked, "
        f"{closed_count} closed, {len(buckets['UNKNOWN'])} unclassified, "
        f"{len(dropped)} unreadable ({expected} entries accounted for)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
