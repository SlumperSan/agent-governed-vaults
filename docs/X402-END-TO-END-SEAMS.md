# The FACILITATOR=http x402 loop, exercised whole: what `scripts/test/x402-end-to-end-loop.test.mjs` found

This records what changed by adding one test file: `scripts/test/x402-end-to-end-loop.test.mjs`,
picked up by `npm run test:backend`'s existing `scripts/test/*.test.mjs` glob with no wiring change.
It boots the real API (`createApi` from `apps/api/src/server.mjs`) and the real bespoke facilitator
process (`startFacilitatorServer` from `apps/api/src/facilitator-server.mjs`) as two independent
`node:http` servers on two ephemeral loopback ports, and drives them with a real buyer
(`createProtocolClient` from `packages/agent-sdk`) signing with a throwaway key generated inside the
test. The only fakes are the settling facilitator's `publicClient`/`walletClient` (viem's chain-client
shape — no RPC, no key, no broadcast); everything above that boundary is the production module.

**Scope, stated precisely because a review caught the title over-reaching.** `bootApi` in the test
file constructs `createHttpFacilitator` (`apps/api/src/facilitator.mjs`) directly rather than going
through `serve.mjs`'s `FACILITATOR=` mode selection. This file exercises the `FACILITATOR=http`
loop — this repo's own client talking to this repo's own bespoke `/settle` server — and the two
agree with each other by construction, because they are the same wire contract. It does not touch
`FACILITATOR=standard` (`createStandardHttpFacilitator`, merged as PR #272) at all, so a defect in
which a route ends up wired to the wrong facilitator CLIENT for the facilitator it actually talks to
is invisible to this file. That is a real gap, not claimed as covered.

## This document was rewritten mid-review — read this before the rest

The first version of this test and doc was written and verified against `protocol/main` at
`fe87e30f`. While it was in review, the reviewer ran `gh pr update-branch`, merging
`dded7cf7` — `fix(x402): emit v2-conformant 402/payload shapes, accept both` (#269) — into this
branch. That merge changed the two files this test is about, `apps/api/src/x402.mjs` and
`apps/api/src/facilitator-server.mjs`, and it falsified three of this document's original claims and
three of the test file's assertions:

- The claim that `decodeSignatureHeader` does not decode a spec-nested envelope. `decodeSignatureHeader`
  at `apps/api/src/x402.mjs:210-223` now hoists `payload.signature`/`payload.authorization` (and
  backfills `authorization.asset` from `accepted.asset`) before anything downstream sees the envelope.
- The claim that `checkEnvelopeAgainstPrice` and `checkChallengePrice` were "symmetric, no asymmetry
  exists yet." `apps/api/src/facilitator-server.mjs:56` now imports `networksEqual` from `apps/api/src/x402.mjs` and
  `apps/api/src/facilitator-server.mjs:149` uses it in place of the bare string compare — a "MAJOR-1 FIX (x402 v2
  PR review)" comment directly above that line names exactly the defect this PR's test was written
  to find, and states it is fixed.

The three tests built on those claims were **characterization tests asserting the absence of a fix**.
A reviewer who reverted `checkChallengePrice` at `apps/api/src/facilitator-server.mjs:149` back
to the bare string compare — reintroducing
the exact defect this suite exists to catch, in their own scratchpad, not in this PR — measured the
suite getting GREENER on the bug (`pass 4 / fail 2` with the defect vs. `pass 3 / fail 3` with the
fix). That is backwards, and it shipped that way because those three tests were only ever checked
against the pre-#269 world. Every one of those tests, and every affected paragraph in this document,
was rewritten below against the source as merged, not carried over.

## Result 1: the FACILITATOR=http loop itself has no defect

`the real loop over real sockets: unpaid -> 402, signed -> 200 + receipt, replayed -> refused at
BOTH layers` passes. Unpaid gets a 402 with a challenge; a genuinely signed EIP-3009 authorization
settles and returns the real fake-chain receipt; the same envelope replayed through the API is
refused by `gate()`'s in-process nonce guard, and — bypassing the API entirely to hit the facilitator
directly — the same envelope is independently refused by `createSettlingFacilitator`'s own
`authorizationState` pre-flight (`apps/api/src/facilitator.mjs:452`; recovery itself is real
production crypto via viem's `recoverTypedDataAddress`, `apps/api/src/facilitator.mjs:127-140`) — the "defense in
depth" the module header of `apps/api/src/facilitator-server.mjs` describes. Two more tests confirm
a facilitator that fails to broadcast, and one that returns malformed JSON, both degrade to an
ordinary 402 rather than a crash or a false-positive 200.

## Result 2: the MAJOR-1 fix, pinned with a positive case, a negative case, and a real-wire case

The originating report cited `checkChallengePrice` for a spec-nested envelope that passes `gate()`
and is then refused at settlement with `network-mismatch` because of a bare string compare with no
notion of CAIP-2. That defect is real and is now fixed on `protocol/main`: `checkChallengePrice`
at `apps/api/src/facilitator-server.mjs:149` now uses `networksEqual` at
`apps/api/src/x402.mjs:94`, which itself calls `toCaip2` at `apps/api/src/x402.mjs:86`. Four
tests pin the fix from four angles:

1. **The loop test itself cannot see this seam.** `PRICE.network` is `'base-sepolia'` on both sides
   of every other test in this file, and the agent SDK's `buildEnvelope`
   (`packages/agent-sdk/src/eip3009.mjs`) echoes `challenge.network` verbatim, so the two sides
   always agree by construction — reintroducing the bug would not turn Result 1's test red. The
   `MAJOR-1 regression, exercised on the real wire` test fixes this: it signs a normal envelope,
   then rewrites the ALREADY-SIGNED envelope's `network` field to the CAIP-2 spelling for the same
   chain before it goes on the wire (`network` is not part of the signed EIP-712 struct, so this
   does not invalidate the signature), and asserts the payment still settles across both real HTTP
   hops.
2. **`checkChallengePrice` in isolation.** Accepts `eip155:84532`/`base-sepolia` in both argument
   orders (the fix), and still refuses `eip155:8453` (Base mainnet) against `base-sepolia` (a
   genuinely different chain) — proving the fix is an equivalence check, not a bypass.
3. **`checkEnvelopeAgainstPrice` and `checkChallengePrice` agreeing**, on both the accept and the
   reject case, confirming the two now use the one shared `networksEqual` rather than two
   independently hand-rolled comparisons — which is exactly what `apps/api/src/x402.mjs`'s own comment on
   `toCaip2` says must hold.
4. **A genuine spec-nested envelope settling end to end.** Built by hand (nothing in this repo's own
   client emits the nested shape yet), signed for real, and settled through both real HTTP hops —
   proving the `decodeSignatureHeader` hoist at `apps/api/src/x402.mjs:210-223` is not just
   correct in isolation but reaches all the way through a real settlement.

**Verified by inverting the reviewer's own check**: reverting `checkChallengePrice` at
`apps/api/src/facilitator-server.mjs:149` to the bare string compare locally turns tests 1 and 2-3
above red (`pass 5 / fail 3`, the same three every time), while the rest of the suite stays green —
the opposite of what the pre-rewrite version of
this file did. Restoring the merged source returns the suite to all-green.

## Other seams pushed on, and what was found

- **Both envelope shapes.** Both settle through the real loop today (Result 1's flat envelope;
  Result 2 item 4's spec-nested one).
- **Both network spellings.** Covered in Result 2.
- **A facilitator that verifies OK then fails to settle.** Tested by forcing the fake chain's
  `writeContract` to throw after a successful `simulateContract`. Surfaces as a 402 whose error
  matches `settlement failed:.*settle-failed`, propagated correctly through both hops
  (facilitator → API → agent-sdk client, which raises a `ProtocolError` with `status === 402`). No
  defect: this is `apps/api/src/facilitator.mjs`'s `createSettlingFacilitator` catch block working as
  designed.
- **A facilitator that returns a malformed 200.** A raw `node:http` server returning `200 not json`
  (not `createSettleHandler` — deliberately not the repo's own wire contract, to see what happens
  when the remote does not speak it at all). `createHttpFacilitator`'s `res.json().catch(() => ({}))`
  (`apps/api/src/facilitator.mjs:173`) silently becomes `{}`, so the client-side result is
  `{ok:false, reason:undefined}` — a real, present-day observability gap: a broken facilitator is
  indistinguishable from one that declined with no reason given. This is scoped to `createHttpFacilitator`
  specifically; `createStandardHttpFacilitator` (the `FACILITATOR=standard` client, PR #272,
  `apps/api/src/facilitator.mjs:187-203`'s `postStandardFacilitatorRequest`) already classifies a malformed
  response into its own transport-failure bucket rather than folding it into a payment verdict. Worth
  the same treatment in `createHttpFacilitator`, but that file is out of this lane's scope.
- **An underpaying envelope that passes local checks but should die at the relay guard.** Already
  covered by existing tests: `checkChallengePrice rejects underpayment but allows overpayment` and
  `the price re-check runs BEFORE the facilitator is called` in
  `apps/api/test/facilitator-server.test.mjs`. This file adds nothing new on that specific axis.
- **The x402 spec's actual `/verify` + `/settle` two-endpoint shape.** `createStandardHttpFacilitator`
  implements this (PR #272, merged). It is a separate client (`FACILITATOR=standard`) from the one
  this file exercises (`FACILITATOR=http`, the repo's own bespoke single-POST shape that only
  `facilitator-server.mjs` understands); the two do not share a wire contract. Pushing on the spec's
  two-endpoint shape, or on the "wrong client wired to a route" failure mode noted in Scope above,
  would mean widening this file's fakes to a second kind of remote facilitator server — left as a
  follow-up, out of scope for a test of the `FACILITATOR=http` loop this file names in its title.

## Running it

```
node --test scripts/test/x402-end-to-end-loop.test.mjs
```

No network: run under a preload that throws on any `net.Socket`/`dns.lookup`/`tls.connect` to a
non-loopback host. This suite was run under exactly that preload (kept in a scratch directory, not
committed — it has no place in `scripts/test/`, which is walked by
`scripts/test/test-wiring-truth.test.mjs` as production test wiring) and the preload reported itself
"armed for the whole run, never fired."

## Test count — a warning about this section, then the number

An earlier version of this section stated a total re-derived at a commit two merges behind the one
it shipped in (`c004b32f`, not the actual landing `b1adcacc`), because `protocol/main` moved twice
more while this PR was in review and the figure was carried forward instead of re-checked. That is
the exact failure this document's own methodology claims to guard against — a number attributed to
"this doc's own head" that was true of an earlier head, made worse by "this doc's own head" being a
self-referential phrase that cannot describe the commit containing the phrase itself. This section
does not repeat that mistake: it cites a SPECIFIC, already-existing commit SHA rather than "this
doc's own head", and notes plainly that no code changes after it, so the number cannot go stale
underneath a doc-only follow-up commit the way the original did underneath two merges.

At `2dd1e8dd` — the merge of `protocol/main` (through `#267`) that this PR's code last changed
under; every commit after it, including the one that added this paragraph, touches only this
document — the full `npm run test:backend` run (every workspace's `test/*.test.mjs` plus
`scripts/test/*.test.mjs`), measured locally with `contracts/out` present (`npm run gate` builds it
first; without it, six `contracts/out`-dependent guards fail closed rather than skip, which is a
correct local artifact of this checkout and not a defect in the suite):

**1366 tests, 1364 pass, 0 fail, 2 skipped.**

Re-derive rather than trust this if `protocol/main` has moved again: `gh run list --branch
test/x402-end-to-end-loop --json headSha,conclusion` for CI's figure at the actual landing SHA, or
`node --test --test-reporter=tap` over the same file list locally. The skip count is expected to
read one lower in CI than locally: one test (`SIGTERM to the real API entrypoint drains and exits
0`) skips only on Windows, because `kill()` there is `TerminateProcess`, not a deliverable signal,
and CI runs on Linux. The other skip — a live-indexer-snapshot test needing a fixture this checkout
does not carry — is environment-independent and present either way.
