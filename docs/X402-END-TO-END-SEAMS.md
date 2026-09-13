# The x402 loop, exercised whole: what `scripts/test/x402-end-to-end-loop.test.mjs` found

This records what changed by adding one test file: `scripts/test/x402-end-to-end-loop.test.mjs`,
picked up by `npm run test:backend`'s existing `scripts/test/*.test.mjs` glob with no wiring change.
It boots the real API (`createApi` from `apps/api/src/server.mjs`) and the real bespoke facilitator
process (`startFacilitatorServer` from `apps/api/src/facilitator-server.mjs`) as two independent
`node:http` servers on two ephemeral loopback ports, and drives them with a real buyer
(`createProtocolClient` from `packages/agent-sdk`) signing with a throwaway key generated inside the
test. The only fakes are the settling facilitator's `publicClient`/`walletClient` (viem's chain-client
shape — no RPC, no key, no broadcast); everything above that boundary is the production module.

## Why this test did not exist before

`apps/api/test/integration.test.mjs`'s "agent SDK drives the live HTTP server through the x402 loop
end to end" test stubs the whole API↔facilitator leg with
`{ async verifyAndSettle() { return { ok: true, receiptId: 'wire_rcpt' } } }`.
`apps/api/test/facilitator-server.test.mjs`'s "createHttpFacilitator and the handler agree on the
wire, end to end through gate()" drives the real `createHttpFacilitator` against the real
`createSettleHandler`, but with a `fetchImpl` that calls the handler function directly (no socket)
and a fixed, never-recovered garbage signature. Neither test puts both halves on real sockets with a
signature that has to actually recover. `scripts/test/x402-end-to-end-loop.test.mjs` does.

## Result 1: the loop itself has no defect

`the real loop over real sockets: unpaid -> 402, signed -> 200 + receipt, replayed -> refused at
BOTH layers` passes on `protocol/main` as it stands. Unpaid gets a 402 with a challenge; a genuinely
signed EIP-3009 authorization settles and returns the real fake-chain receipt; the same envelope
replayed through the API is refused by `gate()`'s in-process nonce guard, and — bypassing the API
entirely to hit the facilitator directly — the same envelope is independently refused by
`createSettlingFacilitator`'s own `authorizationState` pre-flight (the "defense in depth" the module
header of `apps/api/src/facilitator-server.mjs` describes). Two additional tests confirm a facilitator
that fails to broadcast, and one that returns malformed JSON, both degrade to an ordinary 402 rather
than a crash or a false-positive 200.

## Result 2: the brief's described defect is real, but is not reachable on `protocol/main` today

The originating report described a spec-nested v2 envelope passing `gate()` and then being refused
at settlement with `network-mismatch`, citing `` `checkChallengePrice` `` at
`apps/api/src/facilitator-server.mjs:137`. That citation is exactly right — the comparison is
`String(envelope?.network ?? '').toLowerCase() !== String(price.network).toLowerCase()`, a bare
string equality with no notion of CAIP-2. But on `protocol/main` as it stands, this defect is not
reachable through the described path, for two independent reasons, both proved by tests in this
file rather than asserted:

1. `decodeSignatureHeader` (`apps/api/src/x402.mjs:110-112`) accepts only a top-level
   `{signature, authorization}` (`evmShape`) or the SVM shape (`svmShape`). A spec-nested envelope
   (`payload:{signature,authorization}` under a top-level `accepted`/`resource` — confirmed against
   the OPEN #269 `feat/x402-v2-conformance` PR's diff of this file, which is what teaches this
   function to unwrap that shape; it does not exist on `protocol/main`) satisfies neither, so
   `decodeSignatureHeader` returns `null` and `gate()` treats the request as simply unpaid. It never
   reaches `checkEnvelopeAgainstPrice`, let alone settlement. See the `CHARACTERIZATION` test.
2. On network spelling, the two checks are symmetric today. `checkEnvelopeAgainstPrice`
   (`apps/api/src/x402.mjs`, both the `price.svm` and EVM branches) and `checkChallengePrice`
   (`apps/api/src/facilitator-server.mjs:137`) both do the identical bare `.toLowerCase()` compare —
   confirmed by the `SEAM` and the "no asymmetry exists YET" tests, which feed the same
   `eip155:84532` / `base-sepolia` pair to both functions directly and get the same
   `network-mismatch` from each. A client presenting `eip155:84532` is refused at the FIRST gate; the
   facilitator is never reached.

### Where the defect actually lives: at the merge of #269 and this repo's facilitator-server.mjs

`feat/x402-v2-conformance` (#269, open as of this writing) adds `networksEqual`/`toCaip2` to
`apps/api/src/x402.mjs` and applies it in `checkEnvelopeAgainstPrice`, so a `eip155:84532` envelope
against a `base-sepolia` price now passes the LOCAL gate — but forwards the envelope's network field
unchanged (`gate()` never rewrites it) to `facilitator.verifyAndSettle({price}, env)`, and from there,
over the wire, to `checkChallengePrice` on the facilitator side — which #269 does not touch, and which
still does the bare string compare. #269's own comment on `toCaip2` names this directly: `` `checkChallengePrice`
re-checks the same envelope's network against the same challenge's price server-side ... and needs
the identical equality, not a second hand-rolled one``. That is the brief's defect, confirmed to be
real, but it is a **cross-branch** defect — introduced when #269 merges without a matching change to
`facilitator-server.mjs` (out of this lane's scope: `apps/api/src/**` is owned by other lanes) — not
one present on `protocol/main` today. Whichever lane owns `facilitator-server.mjs` when #269 merges
should re-run `checkChallengePrice`'s network comparison through the same `networksEqual` #269 adds
to `x402.mjs`, rather than leaving the two independently maintained.

## Other seams pushed on, and what was found

- **Both envelope shapes.** Flat (legacy) goes through the full loop today (Result 1). Spec-nested
  degrades to a fresh 402 with no diagnosable reason (Result 2, item 1) — not a crash, but silent.
- **Both network spellings.** Covered above (Result 2, item 2).
- **A facilitator that verifies OK then fails to settle.** Tested by forcing the fake chain's
  `writeContract` to throw after a successful `simulateContract`. Surfaces as a 402 whose error
  matches `settlement failed:.*settle-failed`, propagated correctly through both hops
  (facilitator → API → agent-sdk client, which raises a `ProtocolError` with `status === 402`). No
  defect: this is `apps/api/src/facilitator.mjs`'s `createSettlingFacilitator` catch block working as
  designed.
- **A facilitator that returns a malformed 200.** A raw `node:http` server returning `200 not json`
  (not `createSettleHandler` — deliberately not the repo's own wire contract, to see what happens
  when the remote does not speak it at all). `createHttpFacilitator`'s
  `res.json().catch(() => ({}))` silently becomes `{}`, so the client-side result is
  `{ok:false, reason:undefined}`. This is a real, present-day observability gap, not a crash: a
  facilitator that is simply broken (wrong content-type, a proxy error page, a truncated response) is
  indistinguishable — to the API, and therefore to the payer — from a facilitator that understood the
  request and declined it with no reason given. Worth a distinct reason string
  (e.g. `facilitator-malformed-response`) in `apps/api/src/facilitator.mjs`'s `createHttpFacilitator`,
  but that file is out of this lane's scope.
- **An underpaying envelope that passes local checks but should die at the relay guard.** Already
  covered by existing tests: `checkChallengePrice rejects underpayment but allows overpayment` and
  `the price re-check runs BEFORE the facilitator is called` in
  `apps/api/test/facilitator-server.test.mjs`. Read both before concluding this was untested; it
  is not, and this file adds nothing new on that specific axis.
- **The x402 spec's actual `/verify` + `/settle` two-endpoint shape.** `createStandardHttpFacilitator`
  (`apps/api/src/facilitator.mjs`) implements this and merged into `protocol/main` as PR #272 while
  this test was being written — re-fetch and re-check before assuming any file list in an older
  briefing is still accurate. It is a separate client (`FACILITATOR=standard`) from the one this test
  exercises (`FACILITATOR=http`, the repo's own bespoke single-POST shape that only
  `facilitator-server.mjs` understands); the two do not share a wire contract, so pushing on the
  spec's two-endpoint shape would mean faking a *second* kind of remote facilitator server, which is
  out of scope for a test of the bespoke loop this repo actually runs today at
  `FACILITATOR=http`.

## Running it

```
node --test scripts/test/x402-end-to-end-loop.test.mjs
```

No network: run under a preload that throws on any `net.Socket`/`dns.lookup`/`tls.connect` to a
non-loopback host. This suite was run under exactly that preload (kept in a scratch directory, not
committed — it has no place in `scripts/test/`, which is walked by
`scripts/test/test-wiring-truth.test.mjs` as production test wiring) and the preload reported itself
"armed for the whole run, never fired."

Test count at this doc's own head, the full `npm run test:backend` run (every workspace's
`test/*.test.mjs` plus `scripts/test/*.test.mjs`): **1334 tests, 1332 pass, 2 skipped, 0 fail.** The
two skips are pre-existing and unrelated to this file: one SIGTERM test that cannot run on Windows
(`kill()` there is `TerminateProcess`, not a deliverable signal), and one live-indexer-snapshot test
that skips when no live snapshot fixture is present in the checkout.
