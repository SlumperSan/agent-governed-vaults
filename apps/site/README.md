# apps/site: public marketing site

Eight static HTML pages for Rwally, the Agent-Governed Vaults protocol: `index.html`,
`how-it-works.html`, `agents.html`, `who-its-for.html`, `operators.html`, `disclaimers.html`,
`faq.html` and `status.html`.

`risks.html` was retired on 2026-09-05 and `disclaimers.html` took its slot. The owner's
instruction is that every negative statement on this site lives on one page, so the fifteen risks
moved across intact, and so did every caveat that used to sit at the bottom of one of the other
seven pages. `/risks` redirects to `/disclaimers` with a 301 in `_redirects`; the reason is written
above the rule there.

`status.html` and `disclaimers.html` are both deliberately absent from the header nav and reached
from the footer of every page. For `status.html` that is the shape the owner asked for on
2026-09-04: *"Claims should not be a header page, it should be a link in the footer."* It carries
the address ledger for Robinhood Chain mainnet and the recipe for checking any of it.
`disclaimers.html` carries the risks, the legal position and the two standing sentences that used
to be repeated in eight footers. Every page's footer links to both, with both link texts pinned by
the test, because the link is now the only route a reader has to either.

No build step. No framework. **Zero JavaScript**. There is not a single `<script>` tag, so "works
with JavaScript disabled" is true by construction rather than by testing. No external requests of
any kind: no webfonts, no CDN, no analytics, no trackers, no remote images. System font stacks only.
The only off-site link a reader can follow is the project's own GitHub repository.

Two kinds of absolute URL do appear in each `<head>`, and neither is a request or a link: the social
preview tags (`og:`/`twitter:`), which are `content` attributes, and each page's own
`rel="canonical"`, which points at this site's public host `rwally.com`. A canonical fetches nothing
and navigates nowhere; it is metadata that happens to be spelled with an `href`. It is the single
exemption to the no-external-host rule below, and it is written down in the test beside the code
that grants it.

There is deliberately **no `package.json` in this directory**. `apps/*` is an npm workspace glob and
adding one changes what `npm ci` installs at the root.

## Preview

Any static file server. Do not add a dependency for this.

```
python -m http.server 8000 --directory apps/site
```

Then open `http://localhost:8000/`. Opening the `.html` files directly from disk also works, because
nothing on the page needs an origin.

## Design tokens: the swap contract

`assets/tokens.css` is a placeholder with a contract. `design/system-foundation` does not exist yet;
when a real design system lands, **replace `assets/tokens.css` wholesale** and change nothing else.

- The custom-property **names** are the interface, and they are the same names `apps/web/index.html`
  already uses: `--ground --surface --surface-2 --line --line-soft --ink --muted --faint --accent
  --accent-soft --accent-ink --good --good-soft --warn --warn-soft --crit --crit-soft --shadow-1
  --shadow-2 --display --sans --mono --r-sm --r-md --r-lg --maxw`.
- `assets/site.css` references those names and **contains no raw colour literal**. The claims test
  enforces that, so a token swap re-themes the entire site with no markup churn.
- Three inherited values were overridden here because they fail WCAG 2.2 AA, with the measured
  ratios recorded in comments beside them: light `--faint` (3.03:1 → 4.66:1), dark `--faint`
  (2.96:1 → 4.84:1 worst case) and light `--good` (4.40:1 → 6.16:1); light `--warn` and `--crit`
  were darkened for the same reason. A replacement tokens file inherits that obligation.
- Webfont names are dropped and their existing fallbacks kept. Do not reintroduce an `@import` or a
  font-host `<link>`.
- All three theme states are supported the way `apps/web` does it: bare `:root` for light, a
  `prefers-color-scheme: dark` block guarded with `:root:not([data-theme="light"])`, and an explicit
  `:root[data-theme="dark"]`. The last two are duplicates on purpose: edit both or the forced-dark
  path silently drifts.

## Every claim here is the owner's call, and the test is what enforces it

The launch constraint on this project is legal, not engineering, and that has not changed. What
changed on 2026-09-04 is how it is recorded. The owner's decision, verbatim: *"The audit counsel is
now becoming an issue with repetitiveness. Remove them entirely so that we can work faster."*

Eighty HTML review markers used to sit beside the load-bearing claims on these pages, one per
claim, as a grep-able queue. They are deleted, the rendered prose of every page was byte-identical
before and after, and `test/site.test.mjs` now reds if the string comes back anywhere under
`apps/site`.

**The obligation they carried did not go with them.** A claim about custody, fees, deployment
status, jurisdiction, the security review, the operator's obligations or what a depositor's
position is must still be literally true against the contracts. Establish that by opening the
function and citing `file:line`, never by paraphrasing another document that says it. The checks
below are what stop a claim that is not; the owner is who decides.

## The claims test is what stops a banned claim from shipping

`test/site.test.mjs` runs in `npm run test:backend` and therefore in `npm run gate` and in CI. Prose
has no compiler; that file is the compiler. It asserts, across all eight pages:

- **Absence** of banned claim phrases: word-boundary-anchored phrases, never bare words, because a
  test that bans single words gets neutered by its first false positive and then protects nothing.
  The same list is applied to this README and to both stylesheets, not only to the eight pages.
- **Presence** of the pinned sentences at the permitted count per page, and inside `<main>` rather
  than in a footer. Since 2026-09-05 that is `Deployed on Robinhood Chain mainnet, chain id 4663.`
  once on `status.html` and once on `disclaimers.html`, the not-an-offer sentence once on
  `disclaimers.html`, and the licence sentence once on `disclaimers.html`, zero
  everywhere else, which is stricter than the old per-page count and not looser: with nothing
  permitted on the other seven pages, `open source` is banned outright there, and since the
  no-token sentence was retired on 2026-09-05 `airdrop` and `presale` are banned on all nine. What
  the repeated footer disclosure protected is carried by a mandatory footer link to
  `disclaimers.html` on every page, with the link text pinned. Also exactly one `<h1>`, `lang="en"`,
  a skip link to `#main`, `<main id="main">`, a meta description, a title ending in ` | Rwally`, and
  no surviving review marker anywhere under `apps/site`.
- **Position** of the status block: absent from all seven other pages, present exactly once on
  `status.html` inside `<main>`, and `status.html` linked from every footer and from no header nav.
  The same two properties are asserted for `disclaimers.html`'s footer link.
- **Zero JavaScript**: no `<script` tag and no inline event-handler attribute.
- **No external host** in any `src`/`href` other than the project's GitHub repository, with explicit
  checks against `fonts.googleapis.com` and `fonts.gstatic.com`. Exactly one exemption:
  `rel="canonical"` pointing at `rwally.com`, which loads no resource and is not a link a reader can
  follow. Any other `rel` still fails, and so does a canonical pointing at any other host.
- No raw hex colour in `site.css`, and the full token set present in `tokens.css`. `site.css` may not
  set `display:none`, `visibility:hidden`, `height:0` or `font-size:0` on `.pre-launch`: the class
  that now styles the status block on `status.html` and nothing else.
- Every internal `.html` link resolves to a file on disk.
- The operator page states `2,500 USDG` and `5%`, names both distinct 5% mechanisms, and never
  claims the operator's capital cost is nil.

### The site is pinned to the repository, not to itself

`contracts/config/robinhood-mainnet.json` is read by the test, and every row of the
reference-configuration table on `how-it-works.html` is compared to it: the commit and reveal durations, the timelock, the
execution window, the quorum, the proposal threshold, the concentration cap, the cooldown, the
minimum deposit, the exit-fee maximum and decay period, the staleness bound, and both price bands.
The figures the copy *derives* from that config are pinned too: the length of the Mode-F exit
window (timelock plus execution window) and the cost of flipping the small-member quorum regime
(four seats at the minimum deposit), because arithmetic on a config value is the number that goes
stale most quietly. An edit to that config now turns the gate red instead of silently
desynchronizing the site. Every failure message in that block says the SITE is stale: the config is
the source of truth.

`CONFIG_PATH` was `contracts/config/base-mainnet.json` until 2026-09-05, when the owner directed
the Base launch language removed and Robinhood Chain named as the target. The repoint is small on
purpose: the two files are numerically identical for every value this site renders except the
oracle staleness bound, which is `3600` on Base and `86400` (`ChainlinkOracle.MAX_HEARTBEAT`
exactly) on chain 4663. So exactly one table row and one prose figure moved with it.
`base-mainnet.json` stays in the repository: `scripts/test/config-doc-truth.test.mjs` reads it
directly and asserts its sequencer uptime feed is still a real address.

The settlement-asset LABEL moved with the config. Chain 4663 settles in USDG (Global Dollar), not
Circle USDC, so the test's `usdg()` helper renders ` USDG` and three site figures changed with it:
the `Minimum deposit` row, and `disclaimers.html`'s `reference 100 USDG minimum deposit` and
`about 400 USDG`. The third of those is spelled out inline in the test rather than built by the helper,
which is exactly how half a rename ships; it is named in a comment there for that reason. The
field names in the config still read `usdc` / `minDepositUsdc` because the config keeps them, and
nothing in `contracts/` reads a symbol: the settlement token is identified by address and
measured with `decimals()`. The numbers did not change at all.

Three checks that used to be page-scoped are now scoped to the sentence or block they belong to,
because a page-scoped check is satisfied by a disclaimer thousands of characters away:

- every occurrence of `deployed` must sit inside a sentence that negates it, **or** name Robinhood
  Chain, the chain id `4663` or the path `contracts/config/deployments/robinhood-mainnet.json` in
  that same sentence. The rule changed shape on 2026-09-05 rather than loosening: requiring a
  negation was a proxy for requiring truth, and it worked only while nothing was deployed. Naming
  where, in the same sentence, is stricter. A vague "it is deployed" fails now where before it only
  had to avoid the word "not";
- the `no public report` qualifier must sit in the same paragraph or list item as the phrase
  `external security review`, wherever that phrase appears;
- the Disclaimers page's stated count of unmitigated risks is derived from the page itself: the
  number of `What is done` cells whose text begins with `Nothing`. Change an entry and the gate
  names the lede. The `who-its-for.html` half of this was dropped with the consolidation: that page
  no longer restates a number it does not own;
- every address `status.html` publishes must appear in `contracts/config/deployments/robinhood-mainnet.json`
  or in `contracts/config/robinhood-mainnet.json`. It is the only page that carries addresses, and a
  twenty-byte hex string is the one figure on this site a reader cannot sanity-check by eye;
- the basket is written as ETH and BTC because that is what people call them, so `status.html` and
  `disclaimers.html` must each carry one sentence naming the ERC-20s those words stand for:
  `WETH` and `cbBTC`, with the addresses the chain configuration records. A simplification about
  what a vault holds is only honest while it is anchored.

### RWLY launched 2026-09-05, and every mention of it has to be anchored (flipped the same day)

RWLY was created at 2026-09-05T21:51:57Z, so the rule this section used to describe reversed inside
a day. What it required was `does not exist` within **160 characters** of every `RWLY` anywhere
under `apps/site`. What it requires now is an anchor to a checkable launch fact within the same
window: the address stem `0x2eed8ae7`, the words `fixed supply`, `launched 2026-09-05`, or a
design-intent hedge (`design intent`, `designed to`, `not built`). The floor on the number of
mentions is unchanged in purpose and re-measured in value, so the rule still cannot be satisfied by
deleting the mentions.

The reasoning behind the old rule survives the flip and is why the replacement is an anchor rather
than nothing: a named token is the easiest thing on these pages to quote out of context into a
claim that something is buyable. A mention that travels alone is a mention that gets quoted alone.

The window is a character count rather than a sentence or a block, and both alternatives were
tried first. The approved lede is two sentences: one names RWLY as design intent, the next states
the launch facts, so a sentence-scoped rule reds the copy the owner directed. Block scoping does not reach the
three mentions that live inside `content="…"` meta attributes, which sit in no `<p>`, `<dd>` or
`<li>`.

`vision.html` is a whole page of design intent, `stRWLY` contains `RWLY`, and the page produces
eighteen matches. It uses a section-scoped chip instead of the window: every `<section>` that names
RWLY carries the exact string `Designed, not built. RWLY launched 2026-09-05.` The chip flipped
with everything else and kept its two-sentence shape, one clause about the section and one about
the token, so only the false clause moved.

The sentence `No token. No points. No airdrop. No presale.` is **retired**, not reworded: the whole
sentence exists to say a thing does not exist. It is pinned at zero on every page, so restoring it
from an old copy reds. Retiring it also removed the only exemption that made `airdrop` and
`presale` legal anywhere under `apps/site`, which is a tightening: those two words are now banned
outright on all nine pages.

### The negation exceptions

A few banned words have exactly one legitimate use here, and it is always inside a negation: the
geofencing clause and the no-outcome sentence on `disclaimers.html`, the invariant/parameter split
on `how-it-works.html`, the one place the site denies having anything to join
(`who-its-for.html`), and the two standing sentences. Those exact clauses (never bare words) are
enumerated in `PERMITTED` and in `FOOTER_SENTENCE_COUNTS` in the test, stripped before the absence
checks run, and the presence checks run against the unstripped source. Two rules keep that from
becoming a loophole: every entry in `PERMITTED` is itself asserted to be in use, and the two
standing sentences are counted rather than blanket-stripped: one occurrence on
`disclaimers.html`, zero everywhere else.

One `PERMITTED` entry was DELETED on 2026-09-05 rather than left standing: the old `index.html`
"Next" heading, whose wording is not quoted here for the same reason `CLAUDE.md` gives about
quoting a banned shape in order to prohibit it: this file is scanned by the same ban list, and
with the exemption gone the quotation would trip it. The heading is now
`There is nothing to claim here.`, so the entry covered nothing, and an exemption covering nothing
is a hole a banned word walks through later. The rot test names that case; deleting the entry is
the remedy it asks for. If you change any of these sentences, or repeat one somewhere new, change
the test in the same commit.

### It also guards the claim surface outside this directory (added 2026-09-01)

A claims test protects the files it reads and nothing else. The 2026-09-01 audit found claims this
file already bans alive in repository prose that publishes on the same day the site does, so three
rules now reach past `apps/site`. Scope is per-rule and deliberately narrow: the engineering docs
have legitimate uses for several words on the `BANNED` list, so that list is *not* run over them.
(This README is itself scanned by it: the first draft of this paragraph quoted three of those words
as examples and turned the gate red, which is the check working.)

- **Mode F opens at the reveal phase, not at passage.** Five phrasings that place the trigger at
  passage are banned across `README.md`, `llms.txt`, `docs/AGENT-QUICKSTART.md` and the eight pages,
  and each of those three files must positively name the reveal phase. Otherwise the ban is
  satisfiable by deleting the sentence. Ground truth: `Governance.hasPendingExecution` is true from
  `p.commitDeadline` onward (`Governance.sol:648-659`). The site-only ban on *one* phrasing had
  existed since 2026-08-29 and did not stop the same claim shipping three other ways.
- **The open High is named wherever it is claimed.** Any sentence saying a High "remains open at
  the launch configuration" must name it in that same sentence: it is **H-8**, the purchasable
  member count in the `<5`-member quorum regime. H-5/H-6/H-7/H-9 are *unreachable* at launch, not open: each needs a
  funded child and `allowSubVaults = false`. At least three surfaces must carry the claim, so it
  cannot be quietly deleted instead of qualified.
- **No demo name implies an outcome.** Every vault and operator name in `apps/web/src/fixtures.mjs`
  is imported and checked against outcome vocabulary, by substring rather than word boundary: the
  case that got through was a compound, `AlphaSeek`. The line: a name may say what a vault *holds*
  or how it is *built* (`cbBTC Micro`, `Base Blue-Chip 5`, `Momentum Majors`), never what it
  *earns*. `apps/web` previously had no claims coverage at all, which is how `AlphaSeek Index`
  survived the rename of `Stable Yield Micro`.

Run it alone while editing copy:

```
node --test apps/site/test/site.test.mjs
```
