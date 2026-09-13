# Walkthrough: OperatorRegistry.sol

**Risk: High.** ~150 LoC. `contracts/src/OperatorRegistry.sol`.

## Purpose

The C-3 load-bearing reference: operator identity, the cross-vault (member, operator) USDC
loss carryforward (the portable HWM), and the monotone aggregate leaderboard. Three
requirements meet here:

1. **HWM portability (§7):** a member who realized a loss under operator X in vault A pays no
   performance fee under X in vault B until made whole.
2. **Leaderboard integrity (SF-4/SF-5):** lifetime gain/loss/fee accumulators per operator,
   monotone: nothing ever decrements or restates, so closed-vault history is permanent and
   cherry-picking is impossible.
3. **Anti-Sybil (CM-4):** identity is the registry id. A fresh identity sheds its loss carry
   but restarts at zero track record, visible and reputation-costly by construction (the
   enforcement is reputational, an accepted residual).

## Trust position

Carry and stats mutate **only through attested vaults**, and attestation flows **only from
the canonical factory** (CM-5). `wire(factory, feeEngine)` is one-shot deploy-time
configuration by the deployer, permanently locked after (`AlreadyWired`), not an admin power.
Like the FeeEngine, this contract is treated as potentially faulty on the exit path: VaultCore
calls `recordRealization` bounded and non-blocking (a failing registry loses the mark,
event-logged, never the member's exit).

## State

- Identity: `operatorIdOf` / `operatorAddressOf` (ids from 1; 0 = unregistered),
  `operatorCount`.
- Attestation: `_vaultOperator[vault] → opId` (0 = unattested).
- Marks: `carryOf[member][opId]`, the USDC loss carryforward.
- Stats: `statsOf[opId]` = lifetime gain / loss / fees collected / vault count, all
  write-once-additive.

## External entry points

| Function | Caller | Notes |
| --- | --- | --- |
| `wire(factory, feeEngine)` | deployer, once | Zero-address-guarded (Slither pass) |
| `registerOperator(operator)` | anyone | Mints a fresh id for a not-yet-registered address only (`AlreadyOperator`). Grants no authority; harmless permissionless (verified in S6 review) |
| `attestVault(vault, operator)` | **factory only** | Auto-registers the operator if needed; increments `vaultCount` |
| `recordRealization(member, gain, loss)` | **attested vaults only** | Loss builds carry (+= loss); gain consumes it (saturating to 0). Called AFTER the FeeEngine read the pre-update carry (order fixed in `_settleExit`) |
| `recordFeeCollected(opId, amount)` | **feeEngine only** | Stats-only |
| `operatorOf`, `leaderboardEntry`, `carryOf`, … | views | Ranking/weighting is an indexer concern (S7) |

## Invariants (fuzz-tested)

- `carryOf` matches an independent ghost model across arbitrary gain/loss sequences
  (`invariant_carryMatchesGhost`).
- All `OperatorStats` fields are monotone non-decreasing (`invariant_lifetimeMonotone`);
  regression `test_statsAreMonotone_closedVaultHistoryRetained`.
- Carry is strictly per-(member, opId): a fresh identity gets no offset
  (`test_carryIsPerOperator_freshIdentityGetsNoOffset`).

## Review focus

1. **Attestation authorization chain:** factory → `attestVault` → `_vaultOperator`. Can a
   non-factory path ever set `_vaultOperator`? Can an operator front-run `registerOperator`
   to grab someone's address? (Ids bind to `msg.sender`-independent addresses; rebinding is
   impossible, but confirm the auto-register-inside-attest path.)
2. **Carry ordering within a settlement:** `recordRealization` runs after `onRealize` reads
   carry; both are best-effort bounded calls (G5; see FeeEngine walkthrough).
3. **Same-block cross-vault interleavings** of two attested vaults mutating one
   (member, opId) carry.

## Accepted risks here (do not re-report)

- **CM-4 residual:** identity reset escapes carry; reputation (zero track record) is the
  enforcement, not funds.
- **G3/CM-5:** carry farming economics (see FeeEngine walkthrough).
- **SF-4 residual:** reputation systems are gameable at the margin; the leaderboard shows
  TVL- and member-weighted views off-chain to bound dust-vault inflation.
