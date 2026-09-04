---
name: rwally-claims-contract
description: The wording contract every public surface of rwally.com must satisfy. Load this BEFORE writing or editing any user-facing copy, component text, meta description, alt text, or llms.txt for the site or the app. It encodes the claims guards, the pinned verbatim strings, the banned claim shapes, and the one rule this project has paid for most — enumerate, never universalise.
---

# rwally claims contract

Every public claim must be **literally true against the contracts, verified by reading the
source** — not by assertion, not by paraphrasing another document. This is enforced in CI by
`scripts/test/claims-lede-truth.test.mjs` (walks every `.md`/`.html`/`.txt`/`.json` it finds) and
`apps/site/test/site.test.mjs` (36 tests, pinning wording).
A redesign does not relax any of it, and it does not inherit it for free either: the guards walk
source files by extension (`.md`, `.html`, `.txt`, `.json`) and never the JS bundle, and the
`dist/index.html` of a client-rendered React app is an empty root `<div>` with no prose in it. A
banned shape inside a component therefore reds **nothing** today. Until a prerender step exists (the
scaffold has none), the check that stands in for the guards is step 4 of `visual-verify-loop`:
banned shapes must be absent from the **rendered DOM** of the running page, read with `read_page`.
Re-pointing the 36 pinned-wording tests at build output requires that prerender step first, and this
paragraph will say so when it is true.

## Before writing a sentence

1. Read `scripts/test/claims-lede-truth.test.mjs` — it documents each banned shape, why it is
   false, and the approved replacement wording.
2. Read `apps/site/test/site.test.mjs` — it pins the strings below.
3. If a sentence is about what a contract does, open the contract and read the function. Cite
   `file:line` in a comment beside the copy. "The docs say so" is not a source.

## Strings that are pinned verbatim (do not paraphrase, do not re-punctuate)

- Both pre-launch **banner** sentences, on every page.
- Both **footer** sentences, at exactly the permitted count per page:
  `No token. No points. No airdrop. No presale.` and
  `Source-available under BUSL-1.1 — not open source.` (that em-dash is pinned; leave it).
- `open source`, `airdrop`, `presale` may appear **only** inside those footer sentences.
- The security-review attestation paragraph — byte-identical across every page that carries it.
- The launch-status paragraph naming the open High — byte-identical across pages.
- The operator capital obligation sentence (2,500 USDC, 5%, both mechanisms named).
- Every occurrence of the word **deployed** must sit inside a sentence that negates it. No page may
  imply a live mainnet deployment.
- At least one `<!-- COUNSEL: … -->` marker per page. Keep them; they are the review record.

If two pages carried a passage byte-identically before your edit, they must carry it byte-identically
after. A COUNSEL-marked passage rendered two ways is a rejection.

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
  `false`; `DeployTestnet.s.sol` passes `true`; the live Base Sepolia factory reads `true`. Write
  "on the mainnet launch factory" / "every vault *it* deploys", never "the protocol ships with".
- **"Stake-weighted"** is true only at five or more members. Qualify it or do not use it.
- **"Guarantee"** — only inside the permitted fragments `no guarantee of any outcome` and
  `a good-faith measure and not a guarantee`.
- **'Reverts without a sequencer feed.'** `ChainlinkOracle._requireSequencerUp` returns early on
  `address(0)`. It fails OPEN at price time; enforcement is at deploy time.
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

Green is necessary, not sufficient — the "open High is named" guard passed on two divergent
renderings. After the suites, grep the output yourself for the pinned strings and their counts.
