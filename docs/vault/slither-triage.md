# Slither triage

The disposition of record for every Slither detector that fired ([SLITHER-TRIAGE.md](../reviews/SLITHER-TRIAGE.md)):
fixed, or accepted with a reason. The AI audit checked it and found **four dispositions that
generalize too far** — each "accepted" for the case it was written for while missing an adjacent one.

## Why it matters

CI runs Slither as an advisory (`continue-on-error: true`, non-blocking), so a new high-severity
result does not turn CI red — this document is the human triage. Three of the four incorrect
dispositions coincide with the analyser's own blind spots, so neither Slither nor the triage caught
them.

## The filter bug (fixed Sprint 10)

The `--filter-paths` regex was **unanchored**, so `src/lib/` matched alongside Foundry's
`contracts/lib/` — `SafeTransferLib`, `BoundedCall`, and `Checkpoints` were excluded from every
Slither run until Sprint 10. Two detectors confirmed it (`assembly` fired zero times despite
`SafeTransferLib`'s assembly). Anchored form: `slither . --filter-paths "^lib/|^test/|^script/"`. The
widened run went 245 → 254 results with **no new detector class**.

## Four incorrect dispositions (report §4.5)

- **`calls-loop` / `costly-loop`** — the "~237k gas" bound was measured on a 1-child/1-grandchild
  fixture (6 `priceWad` calls); the caps permit ~730 calls. `navWad` is bounded in *shape*, unbounded
  in *cost* → **M-5** (~12M gas). (M-5 needs sub-vaults → dormant at launch.)
- **`reentrancy-*`** — sound for same-contract reentrancy, incomplete for cross-contract: a
  `VaultCore`'s public views are read as an oracle by its *parent* mid-mutation, and a per-contract
  mutex is definitionally no defence against a different contract reading it → **H-9**. Slither does
  not model this either, so the row's reasoning and the analyser's blind spot coincide.
  **Corrected again 2026-09-01:** "false positive" is disproved for this class twice over — #98
  gave H-9 the executing test it had been filed without (a parent prices a mid-swap child and mints
  **2,000e18 shares for 1,000 USDC**), and the sibling `reentrancy-balance` row hid an outright
  theft at `AggregationRouterAdapter.executeSwap` (#101). "Dormant at launch" under
  [[root-vaults-only]] remains true as a *deployment-config* mitigation — undone by the first
  sub-vault — not as a reason the detector was wrong. **Status:** #101 is merged; **#98 is still
  open, so H-9 is UNFIXED on `protocol/main`** — do not cite its guard or its coverage test as
  present.
- **`timestamp`** — **superseded 2026-09-01: triaged row by row, and one of the thirty is real.**
  The old bullet was sound for `Governance` and `Checkpoints` as far as it went, and its only stated
  gap (`UniswapV3TwapSource.sol:255` → **H-2**) is doubly closed: H-2 was fixed, and that contract
  has since been pruned from the tree. The gap it never named was the one that mattered — it asked
  whether the windows are wide enough to survive miner skew (they are; the smallest shipped window
  is an hour) and never asked whether the two comparisons on either side of a deadline **agree about
  the boundary second**. They do, everywhere: every deadline with two or more comparisons partitions
  the timeline exactly, including the Mode I / Mode F seam that makes **EE-10** true
  (`hasPendingExecution` uses `<= p.expiresAt`, the same comparison `execute` uses). That is now
  pinned by tests rather than argued. **The real one is T-1:** `applyStandingDefault` is callable
  only in the reveal phase, so `Governance.sol:470`'s TTL check runs no earlier than
  `createdAt + commitDuration` — a standing default's usable life is `DEFAULT_TTL - commitDuration`,
  and `_validateConfig` bounds `commitDuration` to `[1h, 30 days]` without ever relating it to the
  72h TTL, so `commitDuration >= 72h` silently kills VO-3 for that vault. **Low** (defaults never
  count toward quorum) and **not reachable at launch** (both shipped configs use 3600). Also
  measured: **13 of the 30 rows list no timestamp comparison at all** — established by ablating the
  seeds and re-counting, not by arguing each row. Full table in
  [SLITHER-TRIAGE](../reviews/SLITHER-TRIAGE.md).
- **`divide-before-multiply`** — correct for the payout legs, but "rounds in the vault's favour" was
  generalized to "safe"; the same pattern at `:557` is what makes `:576`'s shortfall dust check
  unsatisfiable and reverts a member's child-backed exit → **H-6**. Dormant at launch.

Also noted (benign): **`missing-zero-check`** — `VaultCore`'s constructor zero-checks none of its
module addresses; a zero `governance` makes `_pendingExecution` return `false` permanently, silently
masking a mis-wired vault as "always Mode I." The canonical factory always wires real modules, so this
bites only a hand-rolled deployment.

## `incorrect-equality` x13 — triaged per row, 2026-09-01

The one-line "Safe" that used to cover this detector reached the right verdict on the wrong
evidence: it cited "NAV never reads `balanceOf`, EE-1" as though that argument covered all thirteen
rows, when only four of them (`ts == 0`) are about NAV at all — and said nothing about the three
whose invariant is the share-accounting identity, nor about the one (`Governance._isSettled`) whose
real risk is a permanent-freeze DoS rather than a donation. Same shape as the `reentrancy-balance`
line #101 disproved, so every row now carries its own argument.

**Tally: REAL 0 · BENIGN-BY-DESIGN 10 · STYLE 3.** Nothing needs a fix. Per-row table in
[SLITHER-TRIAGE.md](../reviews/SLITHER-TRIAGE.md#incorrect-equality-thirteen-rows-triaged-2026-09-01).

The three arguments that were load-bearing enough to execute now do, in
`contracts/test/audit/AuditIncorrectEqualityRows.t.sol`, each verified against the mutation that
would make its row real:

- **`ts == 0`** (`_mintShares`, `navPerShareWad`, both `convertTo*`) — `totalShares == 0` implies
  `navWad() == 0`, because the last exiter is by construction the sole holder and their pro-rata
  legs collapse to identities; and donation cannot move NAV (EE-1 checked for these rows, not
  cited). Mutating `navWad` to read `balanceOf` turns it red.
- **`Checkpoints.push`'s same-second overwrite** — still the OZ idiom, and it cannot backfill a
  vote because governance reads `createdAt - 1`. Pinned at the **Governance** level, not as a
  `Checkpoints` unit test: mutating `p.createdAt - 1` to `p.createdAt` in `_boundedWeight` buys a
  same-second depositor 9x weight, and a unit test on `push` would not notice.
- **`_isSettled`** — every non-settled `Status` has a permissionless, external-call-free exit
  (`finalize` makes no external call; `markExpired` drains `Passed`), so the freeze DoS documented
  at `Governance.sol:57-67` cannot be reached through this equality.

Out of scope but recorded: EE-8's squatter economics are a `minDepositUsdc` **launch-parameter**
question — "bounded at 1%" is true per-exit, but the squatter's cost is one minimum deposit while
the prize is up to 1% of a recently-topped-up whale's whole exit.

## Rows checked and found correct

`unused-return`, `uninitialized-local`, `low-level-calls`, `assembly` (all six sites reviewed opcode
by opcode), `too-many-digits`, `missing-inheritance`. The Sprint-10 anchor fix is genuinely good
work.

## Links

- [[highs]] (H-2, H-6, H-9) · [[mediums-and-lows]] (M-5) · [[c1-empty-electorate]] ·
  [[root-vaults-only]]
- [[vaultcore]] · [[oracle-sources]] · [[safetransferlib]] · [[governance]] ·
  [[threat-model-commitments]] · [[audit-reverification]] · [[security-index]]
