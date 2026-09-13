---
name: rwally-claims-contract
description: The wording contract every public surface of rwally.com must satisfy. Load this BEFORE writing or editing any user-facing copy, component text, meta description, alt text, or llms.txt for the site or the app. It encodes the claims guards, the pinned verbatim strings, the banned claim shapes, and the one rule this project has paid for most — enumerate, never universalise.
---

# rwally claims contract

Every public claim must be **literally true against the contracts, verified by reading the
source**, not by assertion, not by paraphrasing another document. This is enforced in CI by
`scripts/test/claims-lede-truth.test.mjs` (walks every `.md`/`.html`/`.txt`/`.json` it finds) and
`apps/site/test/site.test.mjs` (39 tests, pinning wording across eight pages).
A redesign does not relax any of it, and it does not inherit it for free either: the guards walk
source files by extension (`.md`, `.html`, `.txt`, `.json`) and never the JS bundle, and the
`dist/index.html` of a client-rendered React app is an empty root `<div>` with no prose in it. A
banned shape inside a component therefore reds **nothing** today. Until a prerender step exists (the
scaffold has none), the check that stands in for the guards is step 4 of `visual-verify-loop`:
banned shapes must be absent from the **rendered DOM** of the running page, read with `read_page`.
Re-pointing the 39 pinned-wording tests at build output requires that prerender step first, and this
paragraph will say so when it is true.

## Before writing a sentence

1. Read `scripts/test/claims-lede-truth.test.mjs`: it documents each banned shape, why it is
   false, and the approved replacement wording.
2. Read `apps/site/test/site.test.mjs`: it pins the strings below.
3. If a sentence is about what a contract does, open the contract and read the function. Cite
   `file:line` in a comment beside the copy. "The docs say so" is not a source.
4. If a sentence is about a DEPLOYMENT (a date, an address, a parameter a vault was created with),
   the source is that chain's address book under `contracts/config/deployments/`, and the sentence
   must cite it. Do not restate a deployed parameter from a reference configuration:
   `contracts/config/base-mainnet.json` is a worked example that binds no vault.

## Strings that are pinned verbatim (do not paraphrase, do not re-punctuate)

- Both **status** sentences -- the deployment-status one and the not-an-offer one -- at the
  permitted count per page, and with the LAST occurrence of each inside the `<footer>`. Owner
  decision 2026-09-04: *"Claims should not be a header page, it should be a link in the footer."*
  The band that used to sit above the nav on all seven pages now appears once, on `status.html`,
  inside `<main>`; every page still states both sentences in its own footer, and `status.html` is
  linked from every footer and from no header nav. The deployment-status half was rewritten on
  2026-09-04 and its exact text is `BANNER_STATUS` in `apps/site/test/site.test.mjs`: read it
  there rather than from memory. It states the deployment and cites the address book it can be
  checked against, and it is byte-identical on all eight pages.
- Both **footer** sentences, at exactly the permitted count per page:
  `No token. No points. No airdrop. No presale.` and
  `Open source under the MIT licence.` (the repository was relicensed from BUSL-1.1 to MIT on
  2026-09-05; the sentence that replaced the source-available one carries no dash).
- `open source`, `airdrop`, `presale` may appear **only** inside those footer sentences.
- The security-review attestation paragraph: byte-identical across every page that carries it.
- The launch-status paragraph naming the open High: byte-identical across pages.
- The operator capital obligation sentence (2,500 USDC, 5%, both mechanisms named).
- Every occurrence of the word **deployed** must sit inside a sentence that negates it, **unless the
  sentence names Robinhood Chain and cites the record**: the chain id `4663` or
  `contracts/config/deployments/robinhood-mainnet.json`. This changed on 2026-09-04 and the reason
  matters more than the rule: the protocol IS deployed, on Robinhood Chain mainnet, so a contract
  that permits "deployed" only inside a negation is a contract that requires writing falsehoods.
  The replacement is not a loosening: a positive "deployed" must now be CHECKABLE, which the
  absolute it replaced never was. Base mainnet sentences still take the negation, because there is
  still no Base mainnet deployment. Pinned by the "every deployed" test in
  `apps/site/test/site.test.mjs`, in lockstep with this bullet.
- No page may imply a live deployment in the OUTCOME or INVITATION sense: "is live", "mainnet is
  up", "launched on", "now trading", "goes live". That guard was kept intact through the 2026-09-04
  rewrite; stating a deployment and citing its record is not the same act as promising one.

If two pages carried a passage byte-identically before your edit, they must carry it byte-identically
after. A pinned passage rendered two ways is a rejection.

**The per-claim review markers are gone and must not come back.** Owner decision, 2026-09-04: *"The
audit counsel is now becoming an issue with repetitiveness. Remove them entirely so that we can work
faster."* Eighty HTML comments annotating individual claims were deleted from the seven pages (the
rendered prose was byte-identical before and after) and `apps/site/test/site.test.mjs` reds on the
marker string anywhere under `apps/site`. Do not reintroduce a per-claim annotation scheme in any
spelling. Everything else in this file still binds: the truth obligation was in the guards, never in
the comments, and the owner is who decides a claim.

## Banned shapes (the guard matches SHAPE, not phrasing)

- **A blanket negative about the operator.** Guard 6 of `claims-lede-truth` matches the *shape* of
  a universal negation of operator power (a negative, a scope-widening modifier, a power noun), and
  it matches inside a quotation that exists only to prohibit the form, so this bullet does not quote
  it; `CLAUDE.md` is written the long way round for the same reason. The operator is the sole
  recipient of the 10% performance fee (`FeeEngine.onFeeCollected` →
  `claimableFees[operatorAddressOf(opId)]`), so any universal is falsifiable in one transaction.
  Write the enumeration: *operatorship confers no authority to
  vote, execute, pause, reprice, or move member funds.*
- **A universal about `allowSubVaults`.** It is a constructor immutable. `Deploy.s.sol` passes
  `false`; `DeployTestnet.s.sol` passes `true`; the live Base Sepolia factory reads `true`; what the
  live Robinhood Chain factory reads is in `verifiedWiring["factory.allowSubVaults()"]` of its
  address book. **"On the mainnet launch factory" is no longer an adequate scope**: it was the
  approved wording while no mainnet factory existed, and now that one does it reads as a claim about
  that factory rather than about the script. Write `Deploy.s.sol` by name, or "every vault *it* deploys", or "on that
  factory"; best of all, write the instruction: read `VaultFactory.allowSubVaults()` on the factory
  you integrate against.
- **"Stake-weighted"** is true only at five or more members. Qualify it or do not use it. The first
  vault on Robinhood Chain has not been created yet and is planned to launch small, so it sits
  squarely in the sub-five regime the word misdescribes.
- **A bare answer to "is it deployed?"** Name the chain, and say what is deployed. Robinhood Chain
  mainnet (4663): the seven contracts are, since 2026-09-05, with gates 3 and 6 unrun there or
  anywhere; no vault has been created on it yet, so "deployed" there does not mean anyone can
  deposit and does not mean member funds are at stake. `smokeVault` null and
  `verifiedWiring["factory.vaultCount()"]` 0 in that chain+s record are the two fields that say so,
  and both are chain reads. Base Sepolia
  (84532): yes, a testnet trial with no value at stake. No other chain: no. Settlement is USDG (6 dp)
  on 4663, and x402 metered reads still run on Base Sepolia only, with no facilitator for 4663, so
  a sentence about settlement and a sentence about metered reads are about different chains.
- **"Guarantee"**: only inside the permitted fragments `no guarantee of any outcome` and
  `a good-faith measure and not a guarantee`.
- **'Reverts without a sequencer feed.'** `ChainlinkOracle._requireSequencerUp` returns early on
  `address(0)`. It fails OPEN at price time; enforcement is at deploy time: **on the chains
  `DeployChainlinkOracle.requiresSequencerUptimeFeed` covers, which is an enumeration and not all of
  them.** A local node, Base Sepolia and Robinhood Chain 4663 are exempt, so on chain
  4663 there is no deploy-time refusal either and nothing enforces the feed at all. "Mandatory,
  enforced at deploy time" unqualified is now a false claim about the chain the protocol is deployed
  on,
  and `config-doc-truth`'s deploy-time exemption will wave it straight through: the leg that
  catches it is in `scripts/test/claims-robinhood-deployment.test.mjs`.
- **Uniqueness → existence.** "The one thing that stays reclaimable during a freeze" is a
  contract property (`cancelPending` reads no oracle). Do not weaken it to "one thing".

## The rule that keeps recurring

**Punctuation changes scope.** An em-dash pair can be *restrictive*:

> everything else — pausing, upgrading, repricing, touching another member's funds — is not a
> power any address in this system has

Replace the dashes with a colon and the clause before it becomes a standalone universal — and
false. Before removing any dash, comma, or parenthesis around a list, ask whether the list is
restricting the claim. If it is, the punctuation is load-bearing. Leave it.

## Verify, do not assert

From the app or site directory:

```
node --test apps/site/test/site.test.mjs
node --test scripts/test/claims-lede-truth.test.mjs
node --test scripts/test/config-doc-truth.test.mjs
```

Green is necessary, not sufficient: the "open High is named" guard passed on two divergent
renderings. After the suites, grep the output yourself for the pinned strings and their counts.
