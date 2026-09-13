# Auto-Merge

Remediation work flows to `protocol/main` through per-finding PRs that merge once CI is green, rather than accumulating on a single long-lived branch. **OPERATING CONVENTION.**

## Why it matters

The Phase-2 remediation produced a steady stream of focused, single-finding fixes (C-1, H-8, M-15, C-6 re-verification, ChainlinkOracle, plus the disposition sweep). Landing each one as its own PR to `protocol/main`, instead of batching, keeps the live branch continuously in the best-known state, keeps each diff reviewable in isolation, and means the "what is true right now" snapshot ([[current-state]]) is always the tip of `protocol/main`, not a branch waiting to be integrated.

## The decision and rationale

Each finding gets its own `security/*` branch and PR; CI runs the full battery (`forge fmt --check`, `forge build --sizes`, `forge test`, `forge snapshot --check`, backend tests); on green, the PR merges to `protocol/main`. Recent examples visible in history: #43 (C-1, `security/c1-root-vaults-only`), #44 (H-8, `security/h8-quorum-regime`), #45 (M-15, `security/m15-slippage`), #46 (dispositions, `security/sprint20-dispositions`), #47 (C-6 re-verification, `security/oracle-reverification-c6`), #49 (ChainlinkOracle, `security/chainlink-oracle`).

This pairs with [[continuous-autonomous-mode]]: parallel workers each own a finding, and the merge queue serializes their output onto the live branch without a human gate per PR. **Caveat, learned the hard way:** the worktree is shared across concurrent sessions, so `git add -A` is banned here; it once swept another sprint's contracts into an unrelated PR. Stage explicitly.

**Standing exceptions (security-ops §3, launch gate 10).** Two cases never auto-merge, however green the board:

- **Any `viem` or `@noble/*` version bump gets a human review gate.** A human reads the diff, or at minimum the release provenance, before it lands. These are the signing-path dependencies; no agent merges them on CI alone. `@noble/ciphers`, `@noble/curves` and `@noble/hashes` are all installed by `npm ci --omit=dev` against this lockfile, so this is not a hypothetical class.
- **No new runtime dependency without an explicit, recorded decision.** There are three declared runtime dependencies — `viem`, `@solana/web3.js`, `@solana/spl-token` — and each one spends a budget measured in packages rather than in names. Do not take a figure from this paragraph; run one of these, which answer two different questions:

  ```
  npm ci --omit=dev --no-audit --no-fund --dry-run
  node -e "const d=require('./package-lock.json');console.log(Object.entries(d.packages).filter(([k,v])=>k&&!v.dev&&!v.devOptional).length)"
  ```

  The first is what the Dockerfile actually installs. The second counts every non-dev entry in the lockfile, which is a LARGER set: it includes the `apps/site-next` workspace and its tree (`react`, `framer-motion`, the `@fontsource/*` faces, and `typescript`), none of which is reachable from the three runtime roots. An earlier version of this bullet quoted the second number and described it as the closure "behind three direct dependencies", which is false — the two figures differ by roughly twenty packages, and a review that treats them as the same thing will wave through a dependency the image does install or block one it does not. The figure before that read 13 and was simply stale.

  A PR that grows `dependencies` in `package.json` waits for that decision; it is not a CI question.

Because the fixes are additive and gated by CI, gate 8 ("all CI gates green at the candidate ref") stays GO throughout, though a green board certifies the gates *ran*, not that the protocol is *safe* ([[launch-readiness-gates]]).

## Links

- Operating model: [[continuous-autonomous-mode]] · [[decisions-index]]
- Where the merges land: [[current-state]] · [[prs-and-issues]] · [[remediation-history]]
- Gate context: [[launch-readiness-gates]] · [[audit-reverification]]
