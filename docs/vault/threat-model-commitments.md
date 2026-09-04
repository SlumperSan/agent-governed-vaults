# Threat-model commitments

The protocol's threat model ([THREAT-MODEL.md](../THREAT-MODEL.md)) is a 45-row traceability matrix.
The audit's most important finding is not any single bug but that **eight documented mitigations do
not hold as written** — the property that makes an unusually thorough threat model dangerous, because
a reviewer who trusts the rows will not look.

## Why it matters

Each falsified row names the exact attack that defeats it. A green threat model plus 189 passing
tests concealed five Criticals. These are the rows to re-verify against the corrected tree, not
trust.

## The eight mitigations that did not hold (report §4.2)

- **EX-2** — "minOut bound from oracle median ± tolerance" was **NOT IMPLEMENTED** (H-4); the oracle
  was never consulted on the execution path. Now IMPLEMENTED (2% `MAX_REBALANCE_SLIPPAGE_BPS`).
- **CM-7** — "regime snapshotted per proposal" binds the wrong side of creation (H-8). **PARTIALLY
  REMEDIATED**: the signer regime now also requires FOR-stake quorum and passes on an outright
  FOR-stake majority; the regime-flip residual is config-mitigated (meaningful `minDepositUsdc`).
- **EE-10** — "no indefinite lock; Mode-F shares lose eligibility at queue time" **DOES NOT HOLD** on
  three counts: C-2 (no bounded deadline), C-5 (exited and Mode-F-queued shares both keep weight on
  the in-flight proposal), M-7 (~31-day repeatable lock even at a compliant config).
- **VO-7** — "commit binds direction, no last-mover advantage" — **residual materially larger** (M-10;
  direction-binding is per address, not per actor).
- **MO-1** — "a broken governance loses forward pricing, never liveness" — **scope claim falsified**
  (C-2; the Mode-I fallback covers a *broken* module, not a correct governance answering `true`
  forever).
- **MO-2** — "malformed transfers degrade to escrow, never revert" — **partially falsified** (M-11;
  returndata bounding covers `tryTransfer` only, one of four call shapes).
- **SF-1** — "multi-source median; no single source can move an asset" — **NOT UPHELD** (M-1
  independence unenforced; H-1 median fails at the documented quorum). Then **quantified by C-6**: the
  "5 sources / quorum 3" prescription is a fault-tolerance floor, silent on the Byzantine floor
  `quorum ≥ 2a+1`; the cheapest adversary is the creator listing two sources they control.
  **RESOLVED — the commitment was retired, not repaired.** Chainlink Data Feeds are now consumed
  directly (Byzantine-tolerant at the node-operator layer), so there is no median and no quorum to
  uphold; the multi-source aggregator lives at `contracts/test/retired/` and is non-selectable. The
  commitment that replaces SF-1 is threat-model row **SF-6**, whose named residual is
  single-provider dependency.
- **PX-1** — "in-kind escrow keeps non-USDC assets exitable" — **partially false** (M-2; the reverting
  USDC leg takes the whole settlement down).

Also: **SV-1 / SV-7** — look-through *pricing* is correct, but child *governance* is not upheld (C-1).

## Rows that held

EE-1 (NAV never reads `balanceOf` — donation defence holds), VO-9 (upheld in the deposit direction;
silent on withdrawal — C-5), EE-7 (shares non-transferable), MO-3/MO-4 (queue-time gate + uniform fee
withholding), PX-4 (upheld as to authority). The §5 accepted-row challenge agreed with K-2, G3/CM-5,
EE-8, EE-9, CM-4 and disagreed with E7/EE-5, PX-1, E4, E5, VO-7 (residuals larger than stated).

## Sub-vault rows disabled at launch

The entire **SV** section (SV-1..SV-7) is unreachable on the mainnet launch factory — `Deploy.s.sol`
constructs `VaultFactory` with `allowSubVaults = false` (see [[root-vaults-only]]). It is a
constructor immutable, so those rows ARE reachable on a factory built with `true`, which is why the
SV-* soak drills run against the testnet deployment. They remain the threat model for the future
sub-vault release, resolved with the parent-casts-child-vote mechanism.

## Links

- [[c1-empty-electorate]] · [[c2-unbounded-governance]] · [[c5-vote-after-exit]] ·
  [[c6-oracle-byzantine]] · [[highs]] (H-4, H-8) · [[mediums-and-lows]] (M-1, M-2, M-7, M-10, M-11)
- [[root-vaults-only]] · [[chainlink-direct-pivot]] · [[oracleaggregator]] · [[oracle-layer]] ·
  [[governance]] · [[sub-vaults]] · [[slither-triage]] · [[security-index]]
