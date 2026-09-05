# Vault Atlas: the allocator front end

Dependency-free, no build step. Open `index.html`, or serve the directory
(`npx --yes http-server apps/web -p 8791 -c-1`) and the ES-module imports resolve.

Four flows: **discover** vaults, **inspect** one, **deposit** into it, **exit** it.

## Shape

`index.html` is render, event wiring and focus management. Every figure a user acts on is derived
in a pure module under `src/`, with a test under `test/`, so the numbers can be checked without a
browser. Run them with `npm run test:backend` from the repo root.

| Module | What it owns |
| --- | --- |
| `format.mjs` | Exact 6dp/18dp fixed-point from BigInt. Lossy renderings are opt-in and marked `≈`. |
| `exit-preview.mjs` | `VaultCore._settleExit` / `_exitFeeBps`, mirrored term for term. The performance fee is a bound, not a number; see below. |
| `deposit-preview.mjs` | `_deposit` / `_mintShares`: capacity, entry path, indicative shares, tenure reset. |
| `governance.mjs` | Proposal phase, and a mirror of `Governance.hasPendingExecution`. |
| `vault-state.mjs` | The one action-permission gate every button in the app reads. |
| `vault-view.mjs` | Per-asset oracle health, position valuation, discovery sorts. |
| `freshness.mjs` | Staleness tiers, and the loading / empty / error / ready union. |
| `fees.mjs` | SV-4 stacked fee math (unchanged, mirrors `SubVaultRegistry`). |
| `api-client.mjs` | The x402 402 → authorize → retry loop (unchanged). |
| `live-adapter.mjs` | API JSON → UI shapes. `mapVaults` unchanged; `mapVaultRecords` added. |
| `fixtures.mjs` | The labelled demo dataset. Nothing in it has ever been on-chain. |

**This interface never connects a wallet, holds a key, or signs anything.** Confirming an action
shows the transaction that would be requested; nothing is broadcast.

## Where the mirrored logic diverges from the prose specs

Three places the contracts say something narrower or wider than `docs/ARCHITECTURE.md` and
`docs/design/CONSUMER-UX-SPEC.md`. The app follows the contracts.

1. **Mode F begins at the commit deadline, not at passage.** `Governance.hasPendingExecution` is
   `(Active && now >= commitDeadline) || (Passed && now <= expiresAt)`; it flips when the reveal
   phase opens, because the outcome leaks on-chain from that point (Governance.sol:27–30). The
   docs describe it as "a rebalance has passed and is pending", which is later.
2. **Mode F is not rebalance-specific.** `activeProposalOf` holds one proposal of any type and
   `hasPendingExecution` never reads `ptype`, so a `RuleChange` in its reveal phase forward-prices
   exits identically.
3. **Capacity counts escrowed pending deposits.** `_deposit` checks
   `navUsdc + totalPendingUsdc + amount <= capacityCapUsdc`. A utilisation figure drawn from NAV
   alone under-reports it and promises headroom that other people's escrow has already taken.

Two contract behaviours the app is deliberately **stricter** than, both documented in
`vault-state.mjs`:

- A **Mode-F exit can be queued while the vault is frozen**. That path reads no oracle. The app
  withholds it, because its whole effect is harm: irrevocable, strips voting eligibility at once,
  and cannot settle until both the proposal resolves and the oracle recovers.
- **`skipWindow()` succeeds with no pending deposit**, permanently burning the once-per-vault
  opt-in for nothing. The app only ever offers skip as a branch inside a deposit.

And one behaviour that is easy to miss and expensive: **`lastDepositTime` resets on every
deposit**, so a top-up restores the full exit fee across the member's entire position. The deposit
flow quantifies that before the confirm.

## Three things this app refuses to state as a number

1. **The performance fee is a range.** `_settleExit` withholds it uniformly across the USDC leg and
   every token slice (VaultCore.sol:660-704), and `perfFee` is whatever `FeeEngine.onRealize`
   returns, clamped to `gain / 10`. It depends on the per-`(member, operator)` high-water-mark loss
   carry, which no projection exposes. Only the ceiling is computable, so every payout leg renders
   as `min to max` and the panel says which end is which. There is no exact receipt to show, so
   none is shown.
2. **A share count is never a promise.** Both entry paths are forward-priced: the window path mints
   at activation NAV four hours out, the immediate path at the NAV of the block the transaction
   lands in. Both render through `approx()`.
3. **Unknown is a value.** `null` already means *known-absent* to these modules. `proposal: null`
   resolves to Mode I, `frozen: false` renders a green "Open". A source that simply has no
   proposal or oracle data emits `PROPOSAL_UNKNOWN` and `frozen: null` instead. `frozen` is a
   tri-state everywhere downstream, and `capacity()` reports `determinable: false` rather than
   drawing a 0%-used meter out of two missing numbers.

And one thing nothing invokes for you: **`settleQueuedExit(member)` is an ordinary external call.**
A queued Mode-F exit does not settle as a side effect of execution or expiry. It becomes
*settleable*, and somebody has to make the call. Anybody can, but until they do the shares stay
locked and do not vote. The app says that, and offers the action.

## What the metered API does not expose

`?api=<url>` reads the live indexer. The URL is attacker-controllable and `boot()` runs an x402
handshake against whatever it names, so a **non-localhost origin is not contacted at all** until the
person has read what would be requested and said yes. It serves **event-derived projections only**, so live mode
fills the rest with `null` and says which fields; it does not invent them. In priority order:

| Missing | Why | Consequence |
| --- | --- | --- |
| **Proposal deadlines** | `Governance.Proposed` emits `(pid, vault, ptype, proposer, actionHash)` and no times. | **Exit mode is not derivable at all.** Mode I vs Mode F turns on `commitDeadline`. The app renders `unknown` and warns the exit may be irrevocable; it never assumes Mode I. This is the highest-value gap to close. |
| NAV, NAV/share, basket composition | Events carry no post-swap balances or prices. | No valuation, no weights, no in-kind exit preview. |
| Oracle freshness / frozen | `OracleAggregator` is read directly, never emitted. | The frozen state (the most important state in the product) cannot be detected. `frozen: null`, and the card reads "Freeze state unknown", never "Open". |
| `exitFeeMaxBps`, `exitFeeDecayPeriodSec`, `minDepositUsdc` | Immutable `VaultCore` constructor args; no event carries them. | No exit-fee number, no decay readout. *Not exposed* renders as such, never as a vault that charges nothing. |
| Per-member pending deposit | **Indexable today.** `DepositPending(member, amountUsdc, availableAt)` is emitted and folded, but `projections.mjs` reduces it to an aggregate `pendingCount` and drops both the member and the activation time. | The observation-window countdown has no source. Cheapest gap to close; the data is already arriving. |
| Mode-F queue state | `ExitQueued` is not in `HANDLED_EVENTS` at all. | A queued exit is invisible; a member could queue a second one from a UI that cannot see the first. |
| Per-`(member, operator)` HWM carry | No projection. | Net-of-fee P&L is unanswerable; the app shows gross and states the rule. |
| Operator display names | Only `operatorId`. | Registry identity is shown as primary, which is the safer default anyway. |

`operators[].vaultCount` is **no longer broken**. `projections.mjs` increments it on
`VaultAttested`. The UX spec's OQ-4 ("hide the column") is stale; the column is shown.

## Design tokens

No `design/system-foundation` branch existed when this was written, so `index.html` carries a flat
custom-property block at the top of its `<style>`: colours, type, radii, and a `--tap` target-size
token. It is deliberately the minimum needed and is swappable wholesale. No rule below it hard-codes
a colour. `--faint` was darkened from the previous `#8a8a9e`, which did not reach 4.5:1 on
`--surface`.

## Accessibility

WCAG 2.2 AA, keyboard-operable throughout. Specifically: real `<button>`/`<a>` for every action (no
`div` click handlers), a skip link, focus trapped in dialogs and restored on close, Escape to
dismiss, `aria-labelledby`/`aria-describedby` on every dialog, `<th scope>` on every table header,
status carried by text + glyph and never by colour alone, and countdowns announced through a single
polite live region **at thresholds only** (1h / 15m / 5m / 1m / elapsed) rather than every second.
`crossedThreshold` in `format.mjs` picks the smallest threshold crossed, so each fires exactly once
and *elapsed* is reachable at all.

Three more, each a measured failure rather than a theoretical one:

- **`--crit-ink`.** `.btn.danger` was `#fff` on `--crit`, which is `#ff8b83` in dark: **2.26:1** on
  "Queue irrevocable exit" and "Permanently skip and deposit". The token is `#fff` in light (6.85:1)
  and `#210b09` in dark (8.31:1).
- **Blocked buttons use `aria-disabled`, not `disabled`,** with `aria-describedby` pointing at their
  reason. `disabled` removes a control from the tab order, so a keyboard-only user never reached it
  and never heard why. In-dialog gates keep real `disabled`; the click handler refuses
  `aria-disabled` centrally.
- **`<main>` is `inert` and `aria-hidden` behind an open dialog**; focus lands on the dialog itself
  rather than on the first input *below* the irrevocability warnings, and each step announces what
  it is. A live region handed an identical string twice announces it once.

Countdowns are protocol deadlines driven by `block.timestamp`, so they take WCAG 2.2's real-time
exception to 2.2.1. No extend or dismiss control is offered, because the protocol could not honour
one and a false "extend" would be worse than none.
