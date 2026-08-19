# @vault/canary

Read-only post-launch watcher for a deployed vault set. Silent while healthy; one line per signal
transition otherwise.

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
| `src/signal.mjs` | the `ok` / `alert` / `skipped` result vocabulary and integer bps math |
| `src/transitions.mjs` | pure transition detection — the piece that makes the canary quiet |
| `src/sinks.mjs` | console + optional webhook; a sink failure never propagates |
| `src/signals/*.mjs` | one file per signal, each a pure function over an injected reader |

## Design notes

**Every signal is a pure function over an injected reader.** Nothing reaches for a global client, so
every test injects a plain object literal and the suite needs no RPC. The reader interface is the
five methods documented at the top of `src/reader.mjs`.

**Three statuses, not two.** `skipped` exists because a check that *cannot run* has not passed. The
exit-liveness sentinel with no member to probe with, or a NAV check behind a tripped oracle breaker,
reports DEGRADED — never a false OK.

**One root cause, one page.** A tripped oracle breaker makes `navWad()` and `requestExit` revert too.
Those two attribute their `StaleOracle` reverts to the oracle signal and go DEGRADED, so the operator
gets one alert instead of three.

## Tests

```bash
node --test packages/canary/test/*.test.mjs
```

113 tests, all mocked. `test/helpers.mjs` carries the shared fixture: `healthyVault()` is healthy on
every signal, so each test perturbs exactly one thing and proves the signal reacts to that and
nothing else.
