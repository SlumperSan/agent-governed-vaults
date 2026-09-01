# @vault/canary

Read-only post-launch watcher for a deployed vault set. Silent while healthy; one line per signal
transition otherwise. ("Silent" is about transition lines specifically — an hourly liveness
heartbeat is on by default; see [sinks and paging](#sinks-and-paging) below.)

Full operator guide — what each signal means, its threshold, and what to do when it fires — is in
[docs/CANARY.md](../../docs/CANARY.md). This file is the code map.

```bash
RPC_URL=… OPERATOR_REGISTRY_ADDRESS=… STATE_PATH=./data/indexer-state.json npm run start:canary
```

## Non-custodial, and read-only on top of that

The indexer and API are non-custodial (no keys). The canary is that **plus** read-only against the
chain: it builds a viem *public* client and issues only `eth_blockNumber`, `eth_getBlockByNumber`,
`eth_call`, and `eth_getLogs`. There is no wallet client, no account, no `PRIVATE_KEY` read, and no
ABI fragment for a state-changing function anywhere in this package — `requestExit` appears solely to
build calldata for `eth_call`, which never touches a key.

Both claims are tested rather than asserted: `test/reader.test.mjs` checks the reader exposes no
send/sign surface, and `test/abis.test.mjs` checks every declared function fragment is `view`.

It also never writes the indexer's snapshot. That file is opened read-only; transition state lives at
its own `CANARY_STATE_PATH`.

## Layout

| File | Role |
|---|---|
| `src/canary-runner.mjs` | entrypoint: env config, the sweep, the poll loop |
| `src/reader.mjs` | the only file that talks to an RPC; lazy/optional viem, same pattern as the indexer's `rpc.mjs` |
| `src/abis.mjs` | views, watched events, and the embedded revert selectors — kept separate from the indexer's table on purpose (see the file header) |
| `src/signal.mjs` | the `ok` / `alert` / `skipped` result vocabulary, the `detectorBroken` marker, and integer bps math |
| `src/transitions.mjs` | pure transition detection — the piece that makes the canary quiet, and the one rule that keeps a blind detector loud |
| `src/sinks.mjs` | console + tiered webhook (PAGE vs LOG) + off-host dead-man ping; a sink failure never propagates |
| `src/signals/*.mjs` | one file per signal, each a pure function over an injected reader |
| `src/signals/oracle-health.mjs` | signal (a) against the LIVE `ChainlinkOracle`, plus the flavor probe that dispatches to it or to the retired `oracle-freshness.mjs` |
| `src/signals/feed-identity.mjs` | signal (g): the feed's live `decimals()` against the oracle's CACHED `scale`, its `description()` against the constructor's own USD predicate, and the aggregator behind the proxy. The one signal that owns persistent state (`feedIdentity` in the canary state file) |

## Design notes

**Every signal is a pure function over an injected reader.** Nothing reaches for a global client, so
every test injects a plain object literal and the suite needs no RPC. The reader interface is the
five methods documented at the top of `src/reader.mjs`.

**Three statuses, not two.** `skipped` exists because a check that *cannot run* has not passed. The
exit-liveness sentinel with no member to probe with, or a NAV check behind a tripped oracle breaker,
reports DEGRADED — never a false OK.

**A blind detector is not a degraded check.** `skipped` results carrying `detail.detectorBroken`
render as DETECTOR BROKEN and are re-asserted on a doubling backoff instead of being reported once.
Report-once is right for a problem in the system; for a problem in the monitor it manufactures
confidence, which is how the pre-pivot oracle signal stayed dead for a whole deployment after one
startup line. Things that set the flag: an oracle answering neither known ABI, an unreadable vault, a
signal that threw, and every branch of `feed-identity` that could not read the feed. That last group
is the only one that damps — each is an `eth_call` coming back empty, so they carry
`minConsecutive: 3` (one empty return is RPC noise, three consecutive is the feed), except on a first
sighting, which reports at once because a monitor that has never succeeded must not look like silence.

**One root cause, one page.** A tripped oracle breaker makes `navWad()` and `requestExit` revert too.
Those two attribute their `StaleOracle` reverts to the oracle signal and go DEGRADED, so the operator
gets one alert instead of three.

## Sinks and paging

Closes the Monitoring Gap Analysis' G6 — `sinks.mjs` used to be console + one generic webhook,
every transition, same channel, no severity. Full env reference is in
[docs/CANARY.md](../../docs/CANARY.md); the shape of it:

- **Tiered webhooks.** `PAGE_WEBHOOK_URL` gets only ALERT transitions on `nav-backing`,
  `share-conservation`, `fee-routing`, `exit-liveness`, `oracle-freshness` — the signals Operations'
  Severity Ladder puts at SEV-1/2 and worth waking for. `LOG_WEBHOOK_URL` gets everything else:
  recoveries, every DEGRADED/DETECTOR BROKEN line, and `feed-identity` (its own ALERT self-clears or
  is caught at the weekly ops review by design). `ALERT_WEBHOOK_URL` is the backwards-compatible
  fallback for whichever of the two is unset; set only that one and behaviour is exactly what it was
  before tiering existed.
- **Off-host dead-man's switch.** `DEADMAN_PING_URL` is pinged once per successful sweep. `ops-check`
  (`packages/oplog`) already detects a stalled canary, but it runs on the *same host* — this ping is
  the thing that notices from outside it. Off by default; provisioning the external check account
  (e.g. Healthchecks.io) is a human task, not something this package does.
- **Alert self-test.** `CANARY_TEST_ALERT_ON_START=1` fires one synthetic PAGE and one synthetic LOG
  transition through the real sinks right after startup — the "the first real page must not be the
  first test" requirement (security-ops.md §5.3). Same thing on demand, without starting the sweep
  loop: `node packages/canary/src/canary-runner.mjs test-alert`. Never touches transition state.

## Tests

```bash
node --test packages/canary/test/*.test.mjs
```

247 tests, all mocked. `test/helpers.mjs` carries the shared fixtures: `healthyVault()` (retired
multi-source oracle) and `chainlinkVault()` (the live single-feed one) are healthy on every signal,
so each test perturbs exactly one thing and proves the signal reacts to that and nothing else.
