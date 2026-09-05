# Auto-Merge

Remediation work flows to `protocol/main` through per-finding PRs that merge once CI is green, rather than accumulating on a single long-lived branch. **OPERATING CONVENTION.**

## Why it matters

The Phase-2 remediation produced a steady stream of focused, single-finding fixes (C-1, H-8, M-15, C-6 re-verification, ChainlinkOracle, plus the disposition sweep). Landing each one as its own PR to `protocol/main`, instead of batching, keeps the live branch continuously in the best-known state, keeps each diff reviewable in isolation, and means the "what is true right now" snapshot ([[current-state]]) is always the tip of `protocol/main`, not a branch waiting to be integrated.

## The decision and rationale

Each finding gets its own `security/*` branch and PR; CI runs the full battery (`forge fmt --check`, `forge build --sizes`, `forge test`, `forge snapshot --check`, backend tests); on green, the PR merges to `protocol/main`. Recent examples visible in history: #43 (C-1, `security/c1-root-vaults-only`), #44 (H-8, `security/h8-quorum-regime`), #45 (M-15, `security/m15-slippage`), #46 (dispositions, `security/sprint20-dispositions`), #47 (C-6 re-verification, `security/oracle-reverification-c6`), #49 (ChainlinkOracle, `security/chainlink-oracle`).

This pairs with [[continuous-autonomous-mode]]: parallel workers each own a finding, and the merge queue serializes their output onto the live branch without a human gate per PR. **Caveat, learned the hard way:** the worktree is shared across concurrent sessions, so `git add -A` is banned here; it once swept another sprint's contracts into an unrelated PR. Stage explicitly.

Because the fixes are additive and gated by CI, gate 8 ("all CI gates green at the candidate ref") stays GO throughout, though a green board certifies the gates *ran*, not that the protocol is *safe* ([[launch-readiness-gates]]).

## Links

- Operating model: [[continuous-autonomous-mode]] · [[decisions-index]]
- Where the merges land: [[current-state]] · [[prs-and-issues]] · [[remediation-history]]
- Gate context: [[launch-readiness-gates]] · [[audit-reverification]]
