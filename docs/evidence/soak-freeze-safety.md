# Freeze safety — `cancelPending` observed callable against a real pending deposit

**Base Sepolia, 2026-09-04.** Gate 3 (`docs/LAUNCH-READINESS.md`) requires evidence for the one
member-capital path that must survive an oracle freeze. This is that evidence, and the series it
was reduced from is committed alongside it.

## The property

SF-2/K-4 freeze every NAV path on a stale oracle — deposits, exits and rebalances alike, with no
hatch. `cancelPending` is the exception that must hold: a **pending deposit has not been priced
yet**, so returning the escrowed USDC needs no oracle at all. If that path froze too, a depositor's
capital would be trapped for the length of an outage with no recourse.

## What was measured

| | |
|---|---|
| Vault | `0xd9d386dd76d802e5e1ce3fc53d0e104217fd686a` |
| Member | `0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35` |
| Pending deposit | `5000000` base units (5.000000 USDC), unchanged across all 31 rows that saw a live deposit |
| `cancelPending()` verdict | **162 probe rows; 31 probed a real pending deposit and all 31 returned `callable`; 0 `BLOCKED`; 131 `n/a-no-pending`** |
| Probe window | `2026-09-04T01:35:36Z` → `2026-09-04T02:08:16Z` (32.7 minutes) |
| Series file | [`soak-freeze-safety-series.jsonl`](soak-freeze-safety-series.jsonl) — a snapshot taken at `02:33:18Z`: 54 samples, `01:35:36Z` → `02:33:18Z`, verdicts `{"callable": 31, "n/a-no-pending": 131}` |

The series is a **snapshot of a sampler that was still running**, not a closed file. Only the
`n/a-no-pending` count grows after `02:08:16Z` — the `callable` total is fixed at 31 because the
deposit that produced those rows was consumed at that point (see below).

The probe is a **static call** (`cast call … --from <member>`). It signs nothing, sends nothing and
needs no key, which is deliberate: a freeze-safety check that had to transact would be unable to
run during the very condition it exists to observe.

Two other soak vaults — `0xb940d71b0d695e2ba2b5853bf565c69daa3e3c98` and
`0xa576189710dc28958e3cb857e8ef5f530d4f54a0` — were probed in the same samples and returned
`n/a-no-pending` (revert selector `0xda7557bc`), the honest result for a vault with nothing to
cancel. Those rows are **not** counted as passes: `summarizeFreezeSafety` counts them separately
and they can never raise `demonstrated`.

## Why the count stops at 31 and not at 42

The pending deposit was **activated when its observation window closed** at approximately
`02:08Z`, after which `pendingDeposit` reads `0` and the probe correctly returns
`n/a-no-pending` for all three vaults. The truncation is the deposit completing its normal
lifecycle, not the probe failing or the sampler stopping — the sampler kept running and kept
recording, which is why the later `n/a` rows are present in the series rather than absent from it.

**This measurement is not reproducible from the committed tree.** Regenerating it requires a fresh
pending deposit and a probe running inside that deposit's window. That is why the raw series is
committed rather than only the verdict.

## How this series was produced — read this before citing it

It did **not** come from the soak harness running normally. The running soak was the *pre-fix*
sampler, and its own series (`data/oracle-series.jsonl`) recorded `freezeSafety: []` in every one
of its samples for the whole run. This series came from a **second sampler started by hand** with
the vault list supplied explicitly, alongside the running one, in the ~40 minutes remaining before
the observation window closed.

So what this record establishes is that **the property holds**, measured on a live deployment. What
it does not establish is that the *harness* now produces this evidence unattended — that re-earns
on the next soak run with the fixed sampler, which discovers its vaults from the indexer
projection instead of from an environment variable nothing set.

## Drill 4's verdict over this series

Produced by pointing drill 4 at this file (`SOAK_SERIES=<this series> node
scripts/soak/drill4-oraclefreeze.mjs`) rather than at the default `data/oracle-series.jsonl`,
which is the pre-fix run and carries no freeze-safety rows at all:

```
freeze-safety verdicts: {"callable":31,"n/a-no-pending":95}
  cancelPending stayed callable in all 31 probed sample(s) — freeze safety held
```

(The `n/a` count in that line is from the reduction run at `02:21Z`; the committed snapshot goes to
`02:33Z` and so carries 131. The `callable` figure — the one the verdict turns on — is identical.)

`summarizeFreezeSafety` reports `demonstrated` only when at least one sample probed a **real**
pending deposit and none was blocked. Before this run it returned `false` for every soak: not
because the property failed, but because nothing had ever exercised it.

## What this does NOT show

- **No oracle freeze occurred during the window.** `cancelPending` was callable while the oracle
  was *healthy*. The path is oracle-independent by construction — `VaultCore.cancelPending` reads
  no price — so a freeze cannot reach it; but this run observed the property, it did not observe it
  *under* a freeze. Drill 4 records the same distinction for the staleness leg, where the verdict
  was `NO_EVENT_WORST_CASE_DOCUMENTED`.
- **The sequencer leg was not exercised.** The testnet oracle leaves `sequencerUptimeFeed` at
  `address(0)` by design, so `_requireSequencerUp` returns early and its first real execution is
  mainnet. An unexecuted path, not a passing sub-check.

## Why this evidence did not exist until now

The probe had been **inert for the whole soak**. `run-soak.ps1` set `SOAK_PROBE_MEMBER` and never
set `SOAK_VAULTS`; `oracle-sampler.mjs` derived its probe set from that variable alone, so it
mapped over an empty list and wrote `freezeSafety: []` every sample — no rows, no error, no trace.
Drill 4 correctly refused to claim the property, but reported the reason as "every sample was
`n/a-no-pending`", a statement about pending deposits rather than about the probe.

**Not yet fixed in this tree.** The fix — indexer-projection discovery plus a `not-configured`
sentinel row, so an unconfigured probe records its own absence instead of leaving a gap — is in
PR #170, which is open and unmerged as of this record. On the commit this record lands on,
`scripts/soak/oracle-sampler.mjs` still derives its probe set from `SOAK_VAULTS` alone. Do not read
the paragraph above as describing current behaviour; it describes the defect this evidence was
captured in spite of.

## This does not move gate 3

Gate 3 asks for the **five soak drills executing against the current deployment**. This is the
freeze-safety leg of drill 4 only, from a hand-started sampler. **Gate 3 remains STALE**, and
`docs/LAUNCH-READINESS.md` is deliberately not edited by the change that adds this file — evidence
accumulating is not a gate being earned, and the row should move only when the whole battery has
run on the fixed harness.
