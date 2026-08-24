# x402 live settlement report — Base Sepolia

**Date:** 2026-08-24 · **Chain:** Base Sepolia (84532) · **Issue:** [#23](https://github.com/SlumperSan/agent-governed-vaults/issues/23)

The x402 loop had only ever settled against a stub. This records the first time it settled for
real: an agent signed an EIP-3009 authorization, a facilitator broadcast
`transferWithAuthorization`, USDC moved on Base Sepolia, and the API served the data with the
settlement tx hash as its receipt id. Then the same envelope was resubmitted and rejected by the
chain.

Every on-chain claim below was re-checked with `cast` **after** the run, through a script that
shares no code with the runner ([`scripts/verify-x402-run.sh`](../scripts/verify-x402-run.sh)):
**14 checks, 14 passed, 0 failed.** The raw machine record is
[`docs/evidence/x402-live-run.json`](evidence/x402-live-run.json).

---

## 1. The result

| | |
|---|---|
| **Settlement tx** | [`0xd0a777b7ce011b8085d1f81182bb3d72da4269d6ad4cfc86ffc558a7412c6a84`](https://sepolia.basescan.org/tx/0xd0a777b7ce011b8085d1f81182bb3d72da4269d6ad4cfc86ffc558a7412c6a84) |
| Block | 45,920,839 (timestamp 1787609966) |
| Status | `0x1` success |
| USDC moved | 10,000 base units = **$0.01** |
| Payer → payTo | `0xEFD880BF…e7CC` → `0x0f80606a…9f35` |
| Route served | `GET /vaults` — 3 vaults returned |
| Receipt id | the settlement tx hash |
| **Replay verdict** | `authorization-used` (chain), `replayed-nonce` (API-local) |

The route returned real projected state, not a placeholder: the API loaded a snapshot produced by
the real indexer projections and served three vaults through the normal handler. Only the *events*
behind the snapshot are synthetic — the protocol contracts are deployed but carry no vault history.

## 2. The loop, step by step

| Step | Evidence |
|---|---|
| 1. Unpaid `GET /vaults` | `402` with `PAYMENT-REQUIRED`, challenge nonce `0x7eb1f621…58ff` |
| 2. Agent SDK signs EIP-3009 | authorization nonce `0x86e0df07…85f4`, `v = 0x1b` (27) |
| 3. API (keyless) → facilitator | `POST /settle` `{x402Version:2, challenge:{price}, envelope}` |
| 4. Facilitator recovers payer | recovered address == `authorization.from` |
| 5. `authorizationState` pre-flight | `false` — nonce unused |
| 6. `simulateContract` → `writeContract` | broadcast as `0xd0a777b7…6a84` |
| 7. API serves data | `PAYMENT-RESPONSE` carries the tx hash |
| 8. Replay at facilitator | `200 {"ok":false,"reason":"authorization-used"}` |
| 9. Replay at API | `402 payment invalid: replayed-nonce` |

### Events emitted by the settlement

Both decoded from the receipt with `cast`:

```
AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)
  authorizer  0xefd880bf4e740ff96c41c8b01db1ece64887e7cc   ← the payer
  nonce       0x86e0df07bcd46a3c8acb1362c77f74f3a695aa7682a318e55a15dd277bfe85f4

Transfer(address indexed from, address indexed to, uint256 value)
  from        0xefd880bf4e740ff96c41c8b01db1ece64887e7cc
  to          0x0f80606a2283fd9c67ce2eec79b90e95907f9f35
  value       10000
```

`AuthorizationUsed` is the load-bearing one. A plain `Transfer` would prove only that money moved;
`AuthorizationUsed` proves it moved *because a third party executed a signed authorization* — which
is the entire premise of the scheme.

## 3. Balance deltas — verified independently

Read back with `cast call ... --block N` either side of block 45,920,839, not taken from the
runner's own reporting:

| Account | Before (45,920,838) | After (45,920,839) | Δ |
|---|---:|---:|---:|
| Payer USDC | 50,000 | 40,000 | **−10,000** |
| payTo USDC | 19,950,000 | 19,960,000 | **+10,000** |

Exact, both sides, no rounding. The payer is an ephemeral account generated for this run, so its
entire history is the 0.05 USDC float in and the 0.01 payment out.

## 4. Gas and cost

| Transaction | Gas | L2 exec fee | L1 data fee | Total |
|---|---:|---:|---:|---:|
| Fund payer (ERC-20 `transfer`) | 62,147 | 381,363,573,972 wei | 5,632,978,719 wei | 386,996,552,691 wei |
| **Settlement (`transferWithAuthorization`)** | **85,768** | 518,282,901,496 wei | 11,972,721,644 wei | **530,255,623,140 wei** |

Settlement cost ≈ **0.00000053 ETH** (~5.3 × 10⁻⁷). The settler's measured ETH balance delta was
530,255,623,140 wei — reconciling **to the wei** against L2 exec + L1 data fee.

> **Finding.** That reconciliation only works if you count the L1 data fee. Base is an OP-stack L2
> and charges for calldata posted to L1 *on top of* `gasUsed × effectiveGasPrice`. The runner
> originally recorded only the L2 execution fee, which understated the true cost by 2.3% and did not
> match the balance delta — that mismatch is how it was noticed. Fixed in
> `scripts/live-x402-run.mjs`, which now records `l2ExecFeeWei`, `l1DataFeeWei` and their sum.
> The committed transcript predates the fix, so its `feeWei` field is L2-only; the table above is
> the reconciled truth, taken from `cast`.
>
> The economic point: at $0.01 per read the settlement gas is ~0.005% of revenue on this testnet,
> but the L1 data fee is the volatile component and it scales with calldata, not with compute. A
> `transferWithAuthorization` call carries a 65-byte signature. Budget for L1 fees, not L2 gas.

## 5. Latency

| Segment | Time |
|---|---:|
| Full paid-read loop (402 → sign → settle broadcast → data served) | **289 ms** |
| …plus waiting for the settlement to be mined | 4,598 ms |
| Replay rejection at the facilitator | 121 ms |
| Whole run, funding tx included | 10.2 s |

The 289 ms figure is the one an agent experiences: the facilitator returns the hash on **broadcast**,
not on inclusion, so the API answers while the transfer is still in the mempool. That is a real
design choice with a real consequence — the caller gets its data before settlement is final, and a
reorg could in principle un-settle a read that was already served. On a testnet with 2-second
blocks the exposure is ~4 s. An operator who cannot tolerate that should have the facilitator wait
for a confirmation before returning, and pay for it in latency.

## 6. The USDC EIP-712 domain

Read from the contract, not assumed:

| Field | Value |
|---|---|
| `name()` | **`"USDC"`** |
| `version()` | `"2"` |
| `chainId` | 84532 |
| `verifyingContract` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| `DOMAIN_SEPARATOR()` | `0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818` |

Recomputing the separator locally from those fields reproduces the on-chain value exactly. The
alternatives do not:

| name | version | computed separator | |
|---|---|---|---|
| `"USDC"` | `2` | `0x71f17a3b…9818` | ✅ matches |
| `"USDC"` | `1` | `0x9b1f6b92…3a54` | ✗ |
| `"USD Coin"` | `2` | `0x2f5ab5ee…068b` | ✗ |
| `"USD Coin"` | `1` | `0x7d67d298…3efb` | ✗ |

This is the sprint's most consequential finding and it is covered in §7.

## 7. Bugs found and fixed

### 7.1 Domain name — `"USDC"`, not `"USD Coin"` · *would have blocked every settlement*

`facilitator.mjs` defaulted the EIP-712 domain name to `'USD Coin'`, matching mainnet USDC. Base
Sepolia's token reports `"USDC"`. Signing under the wrong name does not fail loudly — it produces a
structurally valid signature over a *different* struct hash, which recovers to an unrelated address,
and surfaces as `signer-mismatch`. That message points at the signature; the fault is in the config.

**Fix:** not a better constant. `assertUsdcDomain` reads `name()`/`version()` from the token at
boot, recomputes the separator, compares it to the token's own `DOMAIN_SEPARATOR()`, and **refuses
to start on mismatch**, printing both values. Chain-agnostic, so it survives the move to mainnet
where the correct answer flips back to `"USD Coin"`. Regression test:
`an envelope signed under the WRONG domain name recovers to a stranger`.

### 7.2 Challenge nonce was a restart-resetting counter · *would have blocked every retry*

`buildChallenge` used a module-level `__nonceCounter` starting at zero, so the first challenge of
every process carried nonce `0x00…01`. The SDK reuses `challenge.nonce` **as the EIP-3009
authorization nonce**, and EIP-3009 burns nonces permanently per `(authorizer, nonce)`. So the first
paid read after any API restart would present an authorization nonce a previous run had already
spent — reverting as `authorization-used`, permanently, until the counter walked past the burned
range.

This was found before the live run and fixed first, precisely because every retry during the run
would have tripped over it. **Fix:** 32 random bytes. Test:
`buildChallenge issues a unique, unpredictable nonce`.

### 7.3 `validAfter` margin too tight for clock skew

`authorizeFromChallenge` backdated `validAfter` by 5 seconds. EIP-3009 compares `validAfter` against
the timestamp of the block that **mines** the settlement, not the signer's clock, so a payer running
even slightly fast signs an authorization that is not yet valid when it lands. Measured skew was
−1 s against the live chain (and +17 s against a stale fork head), and the observed margin in the
live run was **64 s** — comfortable at the new default, thin at the old one.

**Fix:** default 60 s, configurable via `skewSec`. Tests cover the default, an operator override, and
rejection of a negative value.

### 7.4 Balances read before the settlement was mined · *found by rehearsal*

The runner snapshotted balances as soon as the paid read returned. But the facilitator returns the
hash on broadcast, so the transfer was still in the mempool — the deltas would have read **zero** on
any chain with a real block time. An Anvil fork with instant mining hid this completely; it only
surfaced when the rehearsal was re-run with 3-second blocks.

**Fix:** snapshot after `waitForTransactionReceipt`, and assert the receipt status is `success`.

### 7.5 L1 data fee omitted from cost accounting

See §4. Cost was understated by 2.3% and failed to reconcile with the settler's balance delta.

### 7.6 Reference-agent signed with the mainnet domain on a testnet chain

`DEFAULT_CONFIG` in `packages/reference-agent/src/config.mjs` paired `chainId: 84532` with
`usdcName: 'USD Coin'` — the exact combination §7.1 proves cannot recover. The facilitator and the
payer path were fixed, but this default would have walked a reference-agent operator into the same
opaque `signer-mismatch`. Now `'USDC'`, with a test asserting the domain matches the default chain
and a comment saying to re-read both from the token if `chainId` changes.

### 7.7 `v`-normalization — not a bug, and now genuinely tested

The suspected `v` bug did not materialise. viem's `signTypedData` already returns `v ∈ {27, 28}`
(the live signature ended `…1b` = 27), so `facilitator.mjs`'s `if (v < 27) v += 27` was a no-op in
this run — **the live loop did not exercise that branch.**

The first version of this report claimed the branch was "covered by a unit assertion." It was not:
the assertion checked that the *output* was in `{27, 28}`, which passes whether the normalization
ran or not. The branch had no coverage at all. There is now a test that rewrites a real signature's
trailing byte into the 0/1 convention and asserts the settlement still recovers the same payer —
which only holds if the normalization actually runs. The branch is covered by unit test, still not
by a live signature.

## 8. Spec observations

### 8.1 The challenge nonce does not bind the payment

The challenge that the runner's probe received carried nonce `0x7eb1f621…58ff`; the authorization
that actually paid carried `0x86e0df07…85f4`. Both are legitimate — the SDK issues its own request
and receives its own 402 — but it exposes something worth stating plainly:

**the server never checks that the authorization nonce is one it issued.** `buildChallenge` mints a
nonce and forgets it; `gate()` compares asset, recipient, network, amount and expiry, but not the
nonce. A payer may use any nonce it likes.

This is not exploitable on its own — replay is still stopped by EIP-3009 on-chain and by the local
seen-set — but it means the challenge nonce is **advisory, not a binding correlation** between a
402 and the payment that answers it. Anyone reasoning about the challenge as a per-request
commitment should know it isn't one. Making it binding would require the server to remember issued
nonces, which trades statelessness for a guarantee the chain already provides.

### 8.2 Replay is defended twice, differently

Both layers fired, and they are not interchangeable:

| Layer | Reason returned | Scope |
|---|---|---|
| API, in-memory `seenNonces` | `replayed-nonce` | process-local; lost on restart, not shared across instances |
| Chain, `authorizationState` | `authorization-used` | authoritative; survives restarts, operators and processes |

The API's guard fires *first*, which means a replay through the API never reaches the chain check.
Proving the on-chain rejection therefore required posting the captured envelope **directly to the
facilitator**, bypassing the API. Both are recorded separately in the transcript; conflating them
would have made a process-local `Set` look like a chain guarantee.

### 8.3 Our envelope matches EIP-3009 as deployed

No deviations found between the envelope format and what FiatTokenV2 expects. Field order, types,
the `TransferWithAuthorization` primary type, `bytes32` nonce and `uint256` timestamps all recovered
correctly on the first attempt. The `(v, r, s)` overload was used; the token also exposes a
`bytes signature` overload, which we do not use.

## 9. Non-custodial posture — as run

- The **API server held no key.** It ran with `FACILITATOR=http` and forwarded every payment to a
  separate process. Nothing in it can move funds.
- The **facilitator was the only key-holder**, started knowingly: it refuses to boot without both an
  injected viem account *and* `FACILITATOR_I_UNDERSTAND_THIS_SPENDS_FUNDS=yes`, with no reduced mode
  to fall back to.
- **No raw key entered the environment.** The settler was decrypted from a V3 keystore in-process;
  the runner rejects `SETTLER_PRIVATE_KEY` outright rather than honouring it.
- The **payer was ephemeral** — generated in-process, funded with a capped float, never written down.
- The transcript is guarded by `assertNoSecrets`, which rejects anything with signing capability.

### Deviation from the sprint plan

The plan called for two separate funded accounts. Only one funded account existed, so **the settler
and the `payTo` recipient are the same address** (`0x0f80606a…9f35`). The payer is still fully
separate, so the balance-delta evidence is unaffected — but the gas-payer and the payment recipient
were not independent in this run. A production deployment should separate them; nothing in the code
assumes they are the same.

Residue: the ephemeral payer still holds **0.04 USDC**, permanently stranded (its key existed only
for the duration of the process). The 0.01 payment returned to the operator.

## 10. Reproducing this

```bash
# 1. run it (requires a funded keystore; spends testnet USDC + gas)
FACILITATOR_I_UNDERSTAND_THIS_SPENDS_FUNDS=yes \
SETTLER_KEYSTORE=~/.foundry/keystores/deployer \
SETTLER_KEYSTORE_PASSWORD=… \
node scripts/live-x402-run.mjs --out=docs/evidence/x402-live-run.json

# 2. verify it independently, through cast
scripts/verify-x402-run.sh docs/evidence/x402-live-run.json
```

Run the verifier **promptly** — Base Sepolia public nodes prune historical state (≈50k blocks back
is already gone), and the balance checks read at `block − 1`.

Rehearse against a fork first if you are changing the runner; it costs nothing:

```bash
anvil --fork-url https://base-sepolia-rpc.publicnode.com --port 8545
cast rpc anvil_setIntervalMining 3 --rpc-url http://127.0.0.1:8545   # do NOT skip: instant
                                                                     # mining hides real bugs
```

## 11. What is now proven, and what is not

**Proven live:** the full x402 V2 paid-read loop against real USDC on Base Sepolia; EIP-3009
signature recovery against a real FiatTokenV2 domain; on-chain replay rejection; the keyless-API /
key-holding-facilitator split; the price re-check and consent gate as shipped.

**Not proven:** mainnet (domain name differs — the boot assertion is what makes that safe);
concurrent settlements from one settler (tx-nonce contention is untested); facilitator behaviour
under RPC failure mid-broadcast; the `v ∈ {0,1}` normalization branch against a *real* wallet that
emits it (§7.7 covers it by unit test only); and any load beyond a single request.
