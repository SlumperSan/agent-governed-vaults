---
name: rwally-claims-contract
description: The wording contract every public surface of rwally.com must satisfy. Load this BEFORE writing or editing any user-facing copy, component text, meta description, alt text, or llms.txt for the site or the app. It encodes the claims guards, what they pin, the banned claim shapes, and the one rule this project has paid for most — enumerate, never universalise.
---

# rwally claims contract

Every public claim must be **literally true against the contracts, verified by reading the
source**, not by assertion, not by paraphrasing another document. This is enforced in CI by
`scripts/test/claims-lede-truth.test.mjs` (walks every `.md`/`.html`/`.txt`/`.json` it finds,
including the prerendered pages in `apps/site/dist`), `scripts/test/claims-site-ts-truth.test.mjs`
(walks the string literals of every `.ts` module directly inside `apps/site/src`, which is where
`copy.ts`, `disclaimers-copy.ts`, `terms-copy.ts` and `nav.ts` hold the rendered text) and
`apps/site/test/site.test.mjs` (four tests, reading the built pages).
A redesign does not relax any of it, and it does not inherit it for free either. `apps/site` is
prerendered: `npm run build --workspace apps/site` writes one `dist/<page>` per entry of
`apps/site/src/pages.ts` (`apps/site/scripts/prerender.mjs`), and that built HTML is what a reader
receives. `dist/` is git-ignored, so build before you test: `claims-lede-truth` throws when the
pages are missing, and `site.test.mjs` skips its tests. Text written in a `.tsx` component reaches
the guards only through the built HTML, so read the built page. A surface with no prerender step has
no built HTML to walk, and the check that stands in for the guards is step 4 of
`visual-verify-loop`: banned shapes must be absent from the **rendered DOM** of the running page,
read with `read_page`.

## Before writing a sentence

1. Read `scripts/test/claims-lede-truth.test.mjs`: it documents each banned shape, why it is
   false, and the approved replacement wording.
2. Read `apps/site/test/site.test.mjs`: it pins that the prerender ran, that every single-quoted
   string literal of `copy.ts` of 25 or more characters (a URL excluded) appears in some built page,
   the deployment status the deployment record gives, and the product phrase unbroken in the
   rendered HTML. It does not check where a string lands, that a sentence is true, or any `.tsx`
   text; shorter literals and double-quoted or template literals are not read at all.
3. If a sentence is about what a contract does, open the contract and read the function. Cite
   `file:line` in a comment beside the copy. "The docs say so" is not a source.
4. If a sentence is about a DEPLOYMENT (a date, an address, a parameter a vault was created with),
   the source is that chain's address book under `contracts/config/deployments/`, and the sentence
   must cite it. Do not restate a deployed parameter from a reference configuration:
   `contracts/config/base-mainnet.json` is a worked example that binds no vault.

## What the guards pin, and where the footer lives

Nothing below is pinned by a string compare unless it says so. Older versions of this file listed
footer sentences, a status band and a status page; none of them exists in the tree now, so do not
write copy, tests or reviews on the strength of that older list.

- **The footer is defined once**, in `apps/site/src/nav.ts` (`FOOTER_LEGAL` and `FOOTER_LINKS`) and
  rendered by `Footer` in `apps/site/src/Shell.tsx`, which `Page` puts on every page. Today it
  carries the legal line and five links: Terms of Use, Disclaimers, Docs, GitHub, For agents. Edit it
  in `nav.ts`, never per page. No test pins its wording by string; `claims-site-ts-truth` checks the
  `nav.ts` strings for banned shapes and `claims-lede-truth` checks the built pages.
- **There is no status page and no status band.** `apps/site/src/pages.ts` lists six pages (home,
  how it works, about, docs, disclaimers, terms) and no `status.html`; `BANNER_STATUS` does not exist in
  `apps/site/test/site.test.mjs`. The deployment status is stated in `apps/site/src/copy.ts` and
  `apps/site/src/disclaimers-copy.ts` and checked by the deployment-record test described under
  *deployed* below.
- **The footer no longer carries the token and licence sentences.** The sentence that began "No
  token. No points." appears nowhere in `apps/site`. `Open source under the MIT licence.` is
  `HERO.licence` in `apps/site/src/disclaimers-copy.ts`, rendered once in the hero of the disclaimers
  page, inside `<main>`; no test pins it by string. The older rule that confined `open source`,
  `airdrop` and `presale` to those sentences has no guard behind it today. A token is a different
  matter: `scripts/test/claims-token-absence.test.mjs` still bans naming one on any public surface.
- **Pinned by string:** `scripts/test/disclaimers-doc.test.mjs` requires `HERO.bannerOffer`,
  `HERO.totalLossParagraph` and `HERO.jurisdictionParagraph` of `disclaimers-copy.ts` to appear
  verbatim in `docs/DISCLAIMERS.md`, and the risk register's headings and severity labels to match
  the doc's index, in order. Change one side and the test reds until the other follows.
- **The security-review attestation** is `REVIEW.attestation` in `disclaimers-copy.ts`; it names the
  open High, and it renders once, on the disclaimers page. No test pins it byte-for-byte. The
  operator capital obligation sentence an older version of this file listed is not in
  `apps/site/src`.
- **deployed** may be stated positively about **Arc** and nothing else, and only where the reader
  can check it. Since 2026-09-24 the protocol is deployed on Arc mainnet (chain 5042) and its record
  is `contracts/config/deployments/arc-mainnet.json`. A positive sentence names Arc, and its page
  carries the anchor that makes it checkable: the first vault's address (`firstVault.address` in that
  record) or a link to the record itself. About any other chain, "deployed" is still negated or
  conditioned. This bullet is pinned in lockstep with the `apps/site/test/site.test.mjs` test "the
  site states the deployment status the deployment record gives it", which reads the record, requires
  the address on the homepage and the disclaimers page, and fails any page that still says it is not
  deployed.

  *Why the rule was negation-only until then, kept because it will matter again for the next chain:
  a positive "deployed" is only safe while the record it points at exists. An earlier exemption for a
  chain that was later abandoned outlived that chain by a day, because nobody who retired the chain
  retired the exemption. Whoever retires a deployment retires this bullet's permission with it.*
- No page may imply a live deployment in the OUTCOME or INVITATION sense: "is live", "mainnet is
  up", "launched on", "now trading", "goes live". That guard was kept intact through the 2026-09-04
  rewrite; stating a deployment and citing its record is not the same act as promising one.

If two pages carry a passage byte-identically before your edit, keep them byte-identical after. No
guard enforces this today, so diff the built pages yourself.

**The per-claim review markers are gone and must not come back.** Owner decision, 2026-09-04: *"The
audit counsel is now becoming an issue with repetitiveness. Remove them entirely so that we can work
faster."* Eighty HTML comments annotating individual claims were deleted from the seven pages (the
rendered prose was byte-identical before and after). `apps/site/test/site.test.mjs` no longer carries
the test that redded on the marker string, so this rule is held by review and by the owner's
decision, not by a guard. Do not reintroduce a per-claim annotation scheme in any spelling. Everything else in this file still binds: the truth obligation was in the guards, never in
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
- **A universal about `allowSubVaults`.** It is a constructor immutable. `DeployTestnet.s.sol`
  constructs a `VaultFactory` with `true`; `Deploy.s.sol` takes its factory from
  `ProtocolCreate2.createAll()`, which embeds `ALLOW_SUB_VAULTS = false` in the factory initcode
  (`contracts/script/lib/ProtocolCreate2.sol`); the Base Sepolia
  factory reads `true` and the Arc mainnet factory reads `false`
  (`verifiedWiring["factory.allowSubVaults()"]` in `contracts/config/deployments/base-sepolia.json`
  and `arc-mainnet.json`). Scope a sentence to one named factory or script, never to "the
  mainnet factory" or "every factory"; best of all, write the instruction: read
  `VaultFactory.allowSubVaults()` on the factory you integrate against.
- **"Stake-weighted"** is true only at five or more members. Qualify it or do not use it. A vault
  below five members sits in the regime the word misdescribes; read `holderCount()` on the vault you
  mean rather than assume it. This bullet once asserted a first vault did not exist yet when it
  already did, and the false sentence survived four review rounds. The reason is worth keeping,
  because it is the failure mode this whole file exists to prevent: the guard over that claim tests
  for one exact sentence, and this bullet was a paraphrase of it, so the sweep that enumerated files
  from the guard could not see it. Write a claim so that a reader can check it, not so that a string
  match passes.
- **A bare answer to "is it deployed?"** Name the chain, and say what is deployed.
  **The protocol is deployed on Arc mainnet (5042) since 2026-09-24** (`contracts/config/deployments/arc-mainnet.json`)
  and is not a target on any other mainnet: the contracts left on Robinhood Chain (4663) are
  immutable, hold nothing, and that chain is abandoned (`docs/INCIDENTS.md` §0). Say with any "live" claim that the soak (gate 3) and canary (gate 6) were
  not re-run on the Arc source commit; `docs/LAUNCH-READINESS.md` has the wording. Base
  is paused. Base Sepolia (84532): a testnet trial with no value at stake.

  **Robinhood Chain (4663) is abandoned** — owner decision 2026-09-18. The seven contracts remain
  deployed and immutable there and cannot be removed, but **no vault holds value**: both read zero
  across `totalShares`, `navWad`, `holderCount` and `idleUsdc`, and zero of every basket token,
  re-read on-chain at block 66,743,764 (Engineering, PR 316). The chain's config and both deployment
  records are out of this repository.

  **Two sentences that are NOT the same, and copy must not merge them:** "no funds are at stake" is
  true; "nothing exists there" is false. Nothing prevents a deposit into either vault, and the first
  one would make the first sentence false. Say the end state, never the mechanism — how the vaults
  came to be empty is not something this contract has verified.

  *Corrected 2026-09-19. This bullet instructed copy to say "two vaults exist there and both hold
  real funds, so 'deployed' there now DOES mean member funds are at stake". That was the same false
  claim Engineering removed from `docs/INCIDENTS.md`, `SECURITY.md` and `LAUNCH-READINESS.md` §0 —
  sitting in the document that governs what public copy may assert. A claims contract that has gone
  stale does not merely fail to catch a falsehood; it licenses one.*
- **"Guarantee"**: only inside the permitted fragments `no guarantee of any outcome` and
  `a good-faith measure and not a guarantee`.
- **'Reverts without a sequencer feed.'** `ChainlinkOracle._requireSequencerUp` returns early on
  `address(0)`. It fails OPEN at price time; enforcement is at deploy time: **on the chains
  `DeployChainlinkOracle.requiresSequencerUptimeFeed` covers, which is an enumeration and not all of
  them.** A local node, Base Sepolia and Robinhood Chain 4663 are exempt, so on chain
  4663 there is no deploy-time refusal either and nothing enforces the feed at all. "Mandatory,
  enforced at deploy time" unqualified is a false claim about any exempt chain — and **Arc is
  exempt in substance for a different reason: Chainlink publishes no L2 Sequencer Uptime Feed for
  Arc at all, because Arc is an L1.** So on Arc the gate never runs at price time and only the
  heartbeat and the sane-price band carry that risk,
  and `config-doc-truth`'s deploy-time exemption will wave it straight through. That exemption
  named `scripts/test/claims-robinhood-deployment.test.mjs` as the guard that closes it; the file
  is not in the tree, so no test does, and a sentence crediting deploy-time enforcement needs a
  human read for the exempt chains.
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

From the repo root, building the site first because `dist/` is not committed:

```
npm run build --workspace apps/site
node --test apps/site/test/site.test.mjs
node --test scripts/test/claims-lede-truth.test.mjs
node --test scripts/test/claims-site-ts-truth.test.mjs
node --test scripts/test/config-doc-truth.test.mjs
```

Green is necessary, not sufficient: the guards match shapes, and a sentence can pass them while
being false. After the suites, read the built page in `apps/site/dist` for each sentence you
changed.
