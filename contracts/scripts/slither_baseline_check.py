#!/usr/bin/env python3
"""Card 134. Compares a Slither JSON report against contracts/slither-baseline.json and fails on
anything the baseline does not already cover.

WHY NOT SLITHER'S OWN --triage-mode / --triage-database. That mechanism (see
docs/reviews/SLITHER-TRIAGE.md's history for the measurement) matches on Slither's own per-finding
`id`, a hash of the finding's description text -- which, for "dangerous comparisons" style
detectors (`timestamp`, `incorrect-equality`, the `reentrancy-*` family), is a hash over WHICHEVER
subset of comparisons/reads Slither happened to bundle into that particular run. Measured directly:
adding one unrelated new contract elsewhere in contracts/src, with VaultCore.sol byte-for-byte
unchanged, changed VaultCore._mintShares's reported `timestamp` and `incorrect-equality` ids -- not
because the finding is new, but because Slither picked a different representative comparison to
name in the description. A baseline keyed on that id would have reintroduced exactly the
self-disarming-guard problem this card exists to close: a required check that reds on routine,
unrelated PRs until someone reflexively regenerates the baseline (silently re-accepting whatever is
in the tree at that moment, including a real new finding).

THE KEY THIS SCRIPT USES INSTEAD never includes a line number, a column, or a specific comparison
expression: `<check>::<Contract>.<function>` (or `<check>::<Contract>` for a contract-level finding,
derived by walking each finding's first element's `type_specific_fields.parent` chain up to the
nearest `function` and `contract` nodes). This makes a bundling CHOICE stop looking like a new site,
but it does not make Slither itself deterministic: two clean back-to-back runs from the SAME
installation were byte-identical (242/242, zero drift), but a run from a freshly created venv
against the SAME tree reported `incorrect-equality::VaultCore._mintShares` twice instead of once --
same key, count moved 1 -> 2, nothing in contracts/src changed. See FUZZY_COUNT_KEYS below for how
that residual is handled without opening the door to a real new finding.

Comparison is a MULTISET by key: for each key the current report produces N times, the baseline
must cover at least N (its own `count`). More is a new (or newly-recurring) finding under that key
and fails the check; fewer is fine (something got fixed) and is reported, not failed, so a fix does
not itself require a baseline edit.
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path


# `incorrect-equality::VaultCore._mintShares` bundles that function's two `==` comparisons into
# either one finding or two, and which it picks is not stable: measured on THIS EXACT key, twice,
# by two different causes -- an unrelated new contract added elsewhere in contracts/src (VaultCore
# untouched), and the SAME tree analyzed from a freshly created venv instead of the ambient install.
# Both moved it from count 1 to count 2. Every other `incorrect-equality` key (there are 7 -- Sub
# VaultCore._settleExit alone carries 6 of that detector's comparisons) held its count exactly
# across both perturbations, as did every OTHER multi-element detector mutation-tested alongside it
# (`timestamp`, and the `reentrancy-balance`/`reentrancy-events`/`reentrancy-benign`/
# `reentrancy-no-eth` family) -- so the tolerance below is scoped to the ONE key actually observed
# to drift, not to its whole detector class: a genuinely new `==` comparison anywhere else,
# including a second one added to _settleExit, still fails this check. Widen this set only by
# measuring a new drift the same way, never by "this looks like the same shape".
FUZZY_COUNT_KEYS = frozenset({"incorrect-equality::VaultCore._mintShares"})


def _nearest(kind: str, elem: dict) -> str | None:
    """Walk `elem` and its `type_specific_fields.parent` chain for the nearest node of `kind`
    ('contract' or 'function'). Returns its `name`, or None if the chain never has one."""
    node = elem
    while node is not None:
        if node.get("type") == kind:
            return node.get("name")
        node = (node.get("type_specific_fields") or {}).get("parent")
    return None


def derive_key(finding: dict) -> str:
    """`<check>::<Contract>.<function>` / `<check>::<Contract>` / `<check>::<name>` -- see the
    module docstring for why this deliberately carries no line number or expression text."""
    check = finding["check"]
    elements = finding.get("elements") or []
    if not elements:
        return f"{check}::(no-elements)"
    elem = elements[0]
    contract = _nearest("contract", elem)
    function = _nearest("function", elem)
    if contract and function and elem.get("type") != "contract":
        return f"{check}::{contract}.{function}"
    if contract:
        return f"{check}::{contract}"
    # No contract in the parent chain at all (e.g. a free function, a pragma-level finding):
    # fall back to the element's own name. Still no line number.
    return f"{check}::{elem.get('name', '(unnamed)')}"


def load_report(path: Path) -> Counter:
    data = json.loads(path.read_text(encoding="utf8"))
    if not data.get("success", False):
        raise SystemExit(f"slither_baseline_check: {path} is not a successful Slither report: {data.get('error')}")
    detectors = (data.get("results") or {}).get("detectors") or []
    return Counter(derive_key(f) for f in detectors)


def load_baseline(path: Path) -> dict[str, dict]:
    if not path.is_file():
        raise SystemExit(f"slither_baseline_check: baseline file missing: {path}. Never skip this check for a missing file -- generate one.")
    data = json.loads(path.read_text(encoding="utf8"))
    if not isinstance(data, dict) or "entries" not in data:
        raise SystemExit(f"slither_baseline_check: {path} is not shaped like a baseline (expected a top-level 'entries' object)")
    return data["entries"]


def check(report_path: Path, baseline_path: Path) -> int:
    current = load_report(report_path)
    baseline = load_baseline(baseline_path)

    new_or_grown = []
    for key, n in sorted(current.items()):
        allowed = baseline.get(key, {}).get("count", 0)
        if key in FUZZY_COUNT_KEYS:
            if allowed <= 0:
                new_or_grown.append((key, allowed, n))
        elif n > allowed:
            new_or_grown.append((key, allowed, n))

    shrunk = [
        (key, entry["count"], current.get(key, 0))
        for key, entry in sorted(baseline.items())
        if current.get(key, 0) < entry["count"]
    ]

    if shrunk:
        print("slither_baseline_check: baselined finding(s) that no longer reproduce (informational, not a failure):")
        for key, was, now in shrunk:
            print(f"  {key}: baseline {was} -> now {now}")

    if new_or_grown:
        print("slither_baseline_check: FAIL -- finding(s) not covered by contracts/slither-baseline.json:")
        for key, allowed, now in new_or_grown:
            print(f"  {key}: baseline allows {allowed}, this run has {now}")
        print(
            "\nEvery one of these needs a fix, or a one-line reason added to docs/reviews/SLITHER-TRIAGE.md "
            "and to contracts/slither-baseline.json (regenerate with:\n"
            f"  python3 {Path(__file__).name} --generate <slither-report.json> contracts/slither-baseline.json\n"
            "then diff it and keep only the entries you actually reviewed)."
        )
        return 1

    print(f"slither_baseline_check: OK -- {sum(current.values())} finding(s), all covered by the baseline.")
    return 0


def generate(report_path: Path, baseline_path: Path) -> int:
    """Rewrite `baseline_path` from `report_path`, keeping every existing `reason` for a key that
    still appears and defaulting a brand-new key's reason to a TODO that the check step's own
    output would otherwise never force anyone to look at twice."""
    current = load_report(report_path)
    existing = load_baseline(baseline_path) if baseline_path.is_file() else {}
    entries = {}
    for key in sorted(current):
        reason = existing.get(key, {}).get("reason", "TODO: disposition this finding in docs/reviews/SLITHER-TRIAGE.md, then replace this TODO")
        entries[key] = {"count": current[key], "reason": reason}
    baseline_path.write_text(
        json.dumps({"$schema": "card 134 -- see contracts/scripts/slither_baseline_check.py", "entries": entries}, indent=2, sort_keys=True) + "\n",
        encoding="utf8",
    )
    print(f"slither_baseline_check: wrote {len(entries)} key(s) to {baseline_path}")
    return 0


def main(argv: list[str]) -> int:
    if argv and argv[0] == "--generate":
        if len(argv) != 3:
            print("usage: slither_baseline_check.py --generate <slither-report.json> <baseline.json>", file=sys.stderr)
            return 2
        return generate(Path(argv[1]), Path(argv[2]))
    if len(argv) != 2:
        print("usage: slither_baseline_check.py <slither-report.json> <baseline.json>", file=sys.stderr)
        return 2
    return check(Path(argv[0]), Path(argv[1]))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
