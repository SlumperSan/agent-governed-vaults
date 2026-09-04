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
  not model this either, so the row's reasoning and the analyser's blind spot coincide. Dormant at
  launch under [[root-vaults-only]], **and separately FIXED IN CODE 2026-09-01** —
  `require(!v.locked(), Reentrancy())` in `VaultCore._fullNavWad`, unconditional, so it does not
  depend on the sub-vault gate. See [[highs]].
- **`timestamp`** — sound for `Governance` and `Checkpoints`, but omitted
  `UniswapV3TwapSource._observe`, the one timestamp use with a security consequence → **H-2** (since
  FIXED, and the contract itself deleted by the Chainlink-direct pivot; the omission is closed). The per-row re-triage (2026-09-01) then found a second real
  one the class verdict had covered for: `Governance.applyStandingDefault`'s VO-3 TTL is compared
  against `block.timestamp` during the reveal phase, so the commit phase eats into it → **T-1**
  (Low, since FIXED — `COMMIT_HARD_CAP = DEFAULT_TTL - 1`). Note what "sound for `Governance`" was
  and was not: every comparison IS outside miner tolerance, which is what the row asserted; T-1 is
  about which clock the comparison uses, a question the class verdict never asked. See
  [[mediums-and-lows]].
- **`divide-before-multiply`** — correct for the payout legs, but "rounds in the vault's favour" was
  generalized to "safe"; the same pattern at `:557` is what makes `:576`'s shortfall dust check
  unsatisfiable and reverts a member's child-backed exit → **H-6**. Dormant at launch.

Also noted (benign): **`missing-zero-check`** — `VaultCore`'s constructor zero-checks none of its
module addresses; a zero `governance` makes `_pendingExecution` return `false` permanently, silently
masking a mis-wired vault as "always Mode I." The canonical factory always wires real modules, so this
bites only a hand-rolled deployment.

## Rows checked and found correct

`unused-return`, `incorrect-equality` (including the load-bearing same-second `Checkpoints.push`
overwrite), `uninitialized-local`, `low-level-calls`, `assembly` (all six sites reviewed opcode by
opcode), `too-many-digits`, `missing-inheritance`. The Sprint-10 anchor fix is genuinely good work.

## Links

- [[highs]] (H-2, H-6, H-9) · [[mediums-and-lows]] (M-5) · [[c1-empty-electorate]] ·
  [[root-vaults-only]]
- [[vaultcore]] · [[oracle-sources]] · [[safetransferlib]] · [[governance]] ·
  [[threat-model-commitments]] · [[audit-reverification]] · [[security-index]]
