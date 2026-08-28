# SafeTransferLib (and BoundedCall)

The vendored `lib/` primitives for hostile-token and hostile-module safety: bounded ERC-20 transfer
helpers (`SafeTransferLib`) and gas/returndata-bounded external calls (`BoundedCall`).
`contracts/src/lib/SafeTransferLib.sol`, `contracts/src/lib/BoundedCall.sol`. Both are vendored
rather than imported to keep the dependency surface auditable in one sitting.

## Why it matters

Every fund movement and every creator-chosen bookkeeping module call passes through these two
libraries, so they are the enforcement point for two whole finding classes: a **returndata bomb**
must not OOG the caller, and a **reverting / gas-guzzling** token or module must degrade to escrow or
lost-bookkeeping rather than bricking an exit. A single unbounded call shape anywhere in these
libraries reopens the exit-liveness risk the rest of the design works to close. (BoundedCall has no
note of its own — it is folded in here because both are `lib/` returndata/gas hardening of the same
H-1 / H-2 / M-11 class.)

## SafeTransferLib

- `safeTransfer` / `safeTransferFrom` / `safeApprove` — **reverting** helpers (propagate a genuine
  failure) that tolerate missing return values (USDT-style).
- `tryTransfer(token, to, amount, gasLimit)` — **non-reverting**, gas-capped, for the in-kind
  redemption escrow path (EE-6): one blacklisted/reverting basket asset must not block the whole
  redemption; a failure returns `false` and the caller escrows the slice.

### M-11

The three reverting helpers used to do `(bool ok, bytes memory ret) = token.call(...)`, which copies
the **entire** returndata buffer into memory — so a returndata-bombing token OOG'd every one of them.
A second, quieter defect: for a token returning 1-31 bytes, `abi.decode(ret, (bool))` reverts with a
decoder panic, making the intended `TransferFailed` error **unreachable** for exactly the
malformed-return case it exists to report. All three now use a **bounded** assembly call copying at
most one word, and report the intended named error. The bomb costs the callee its own memory
expansion and this frame nothing (a buffer never copied is never paid for). `tryTransfer` was already
bounded (H-2); M-11 brought the other three call shapes up to it.

**Cross-note consequence:** the bounded assembly is *smaller* than `abi.decode`, and these helpers
inline at every call site, so **M-11 returned ~336 B of EIP-170 headroom** — which is precisely what
made M-2's 504 B escrow-routing fix in [[vaultcore]] affordable. Reachable call sites included
`claimEscrowed` (so an asset that degraded to escrow could otherwise be made permanently
unclaimable) and both [[execution-adapters]].

## BoundedCall

Gas- and returndata-bounded `boundedCall` / `boundedStaticCall` for creator-chosen bookkeeping
modules ([[feeengine]], [[operatorregistry]]) and the governance `hasPendingExecution` read. Copies
at most one word of returndata, so a bomb costs the callee its gas allowance and nothing else. This
is the mechanism behind VaultCore's **H-1** posture (a reverting / gas-guzzling / returndata-bombing
module loses its own bookkeeping, event-logged, but never blocks an exit) and behind
`_pendingExecution` falling back to **Mode I** on any governance failure.

### L-3

The scratch word is now zeroed **before** `returndatacopy`. For 1-31 bytes of returndata the copy
filled only the high bytes and the remainder was whatever sat at the free-memory pointer, so `word`
carried **uninitialised memory**. Two of the five call sites gate on `retSize >= 32`; VaultCore's
`perfFee` read did **not** — so an uninitialised word could have been read as a fee. Fixed by the
`mstore(ptr, 0)` before the copy in both `boundedCall` and `boundedStaticCall`.

## Findings summary

- **M-11** — returndata-bounded reverting helpers (SafeTransferLib).
- **H-2** — `tryTransfer` gas cap + returndata bound (the escrow path; also the TWAP finding number,
  unrelated — see [[oracle-sources]]).
- **H-1** — `BoundedCall` is the bounded-module-call mechanism (see [[vaultcore]]).
- **L-3** — `BoundedCall`'s uninitialised-word fix.

## Links

- [[contracts-index]] · [[vaultcore]] · [[feeengine]] · [[operatorregistry]] · [[execution-adapters]]
- Findings: [[highs]] · [[mediums-and-lows]] · [[threat-model-commitments]]
