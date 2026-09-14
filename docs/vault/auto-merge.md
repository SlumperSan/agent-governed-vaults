# Auto-Merge

Remediation work flows to `protocol/main` through per-finding PRs, rather than accumulating on a single long-lived branch. **OPERATING CONVENTION.**

## This page decides the branching model, not the merge condition

**Read the merge condition in [`docs/reviews/MERGE-POLICY.md`](../reviews/MERGE-POLICY.md), and check a PR against it with `node scripts/merge-preflight.mjs <n>`.** It is deliberately not restated here. `scripts/lib/merge-policy.json` is the single machine-readable source of truth, `MERGE-POLICY.md` embeds it verbatim, and `scripts/test/merge-preflight.test.mjs` asserts the two are byte-identical; a third copy on this page could not be held to that and would drift.

> **SUPERSEDED 2026-09-01.** Until that date this page said remediation PRs merge "once CI is green", unqualified, and that sentence was the whole of the rule an agent had. `MERGE-POLICY.md` names it as the root of the incident that follows. What went wrong was the *merge condition*; the per-finding branching model below was never in question and is unchanged.

On 2026-09-01 four pull requests landed across review verdicts that were never addressed, putting two HIGH findings on `protocol/main`. The reason this page is the one being corrected rather than a footnote in the incident write-up: the corrected rule existed only in machine-local memory, so no fresh clone, no other machine and no CI check could read it, while the tracked file an agent would actually open went on asserting the rule that had already failed. **A rule nobody can read from a fresh clone is not an interlock.** `MERGE-POLICY.md` §"Why this exists" holds the five failure modes and the timestamps.

## Why it matters

The Phase-2 remediation produced a steady stream of focused, single-finding fixes (C-1, H-8, M-15, C-6 re-verification, ChainlinkOracle, plus the disposition sweep). Landing each one as its own PR to `protocol/main`, instead of batching, keeps the live branch continuously in the best-known state, keeps each diff reviewable in isolation, and means the "what is true right now" snapshot ([[current-state]]) is always the tip of `protocol/main`, not a branch waiting to be integrated.

## The decision and rationale

Each finding gets its own `security/*` branch and PR, and CI runs the full battery (`forge fmt --check`, `forge build --sizes`, `forge test`, `forge snapshot --check`, backend tests). Whether that PR may then land is the question `MERGE-POLICY.md` answers and this page does not. Recent examples visible in history: #43 (C-1, `security/c1-root-vaults-only`), #44 (H-8, `security/h8-quorum-regime`), #45 (M-15, `security/m15-slippage`), #46 (dispositions, `security/sprint20-dispositions`), #47 (C-6 re-verification, `security/oracle-reverification-c6`), #49 (ChainlinkOracle, `security/chainlink-oracle`).

This pairs with [[continuous-autonomous-mode]]: parallel workers each own a finding, and the merge queue serializes their output onto the live branch without a human gate per PR. **That "without a human gate" is the default and not a universal:** `MERGE-POLICY.md` §"Classes that never self-merge" names the change classes that go to the owner regardless of how the board looks. **Caveat, learned the hard way:** the worktree is shared across concurrent sessions, so `git add -A` is banned here; it once swept another sprint's contracts into an unrelated PR. Stage explicitly.

Because the fixes are additive and gated by CI, gate 8 ("all CI gates green at the candidate ref") stays GO throughout, though a green board certifies the gates *ran*, not that the protocol is *safe* ([[launch-readiness-gates]]).

## Links

- **The merge condition: [`docs/reviews/MERGE-POLICY.md`](../reviews/MERGE-POLICY.md) · `scripts/lib/merge-policy.json` · `node scripts/merge-preflight.mjs <n>`**
- Operating model: [[continuous-autonomous-mode]] · [[decisions-index]]
- Where the merges land: [[current-state]] · [[prs-and-issues]] · [[remediation-history]]
- Gate context: [[launch-readiness-gates]] · [[audit-reverification]]
