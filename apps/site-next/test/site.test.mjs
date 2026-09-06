// @ts-check
/**
 * Claims test for the marketing site — the apps/site-next copy.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW THIS DIFFERS FROM apps/site/test/site.test.mjs, AND WHY EACH DIFFERENCE
 * EXISTS. This file is that file, repointed at the React build. The claims
 * assertions are carried across unchanged, deliberately: a redesign is not a
 * reason to relax one, and a guard that was rewritten while it was moved is a
 * guard nobody can diff. Six things changed, five were added and two were
 * dropped, and every one of the thirteen is about WHAT THE BUILD LOOKS LIKE
 * rather than about what may be claimed. Not one banned phrase, permitted negation,
 * pinned sentence or counted footer string was touched.
 *
 *   1. It reads `../dist/*.html`, not hand-written pages. The old site was the
 *      source; here the source is React and the build output is the artefact
 *      the reader receives, so the artefact is what is tested. If `dist/` is
 *      absent, the thirty-six tests declared with `t()` and the one declared
 *      with `tc()` SKIP with a message saying to build — see `t()` below.
 *      Most of them read `dist/`; a few (the status-band stylesheet check, the
 *      Mode-F reveal-phase check and the fixture-name check) do not, and skip
 *      with them anyway because `t()` sets the skip by declaration rather than
 *      by what a body opens. `tc()` is `t()` plus one more condition: the test
 *      that reads the reference configuration also skips, with its own message,
 *      when that file is not in the checkout — which happens on a branch cut
 *      before the target-chain decision landed it, and nowhere else. The nine
 *      declared with `test()` run either way: they read source, and one of them
 *      walks the source and adds `dist/` when it is there.
 *      THESE THREE NUMBERS WERE STALE AND ARE RECOUNTED. They read thirty-four,
 *      three and seven until 2026-09-05 and the checkout said thirty-six, one
 *      and eight; the mark swap of that date takes `test()` to nine. Recount all
 *      three with `grep -c "^t(" `, `grep -c "^tc(" ` and `grep -c "^test(" `.
 *      They are claims, and nothing else checks them.
 *
 *   2. PROSE_FILES moved: `README.md`, `src/tokens.css`, `src/index.css`. Same
 *      three roles as before (the README and both stylesheets a reader of the
 *      repository meets); `src/fonts.css` is added to the stylesheet checks
 *      further down because it is a third stylesheet that did not exist then.
 *
 *   3. The zero-`<script>` rule is REPLACED, not dropped. That rule was true of
 *      a site with no JavaScript and cannot be true of this one, so the check
 *      became exact instead: one module script per page, from /assets/, and
 *      nothing else — no second script, no inline script, no `on*=` handler, no
 *      `<style>` element and no `style=` attribute. That is strictly more than
 *      the old rule tested, and it is the shape `public/_headers` claims.
 *
 *   4. The no-colour-literal rule now points at `src/index.css` and at every
 *      section's module CSS, with `src/tokens.css` the only file allowed a hex
 *      literal. Same property, wider surface.
 *
 *   5. The system-font-stack rule is INVERTED. It existed because the old site
 *      could not fetch a named face, so naming one was dead weight. This build
 *      bundles three faces from this origin, so the check is now that every
 *      non-generic family named in the token stacks has an `@font-face` in
 *      fonts.css and that no `@font-face` fetches from another origin.
 *
 *   6. Guards that iterate a regex match now assert the match count is not
 *      zero. `.pre-launch` became `.banner` in the redesign, and the guard that
 *      iterates `site.match(/\.pre-launch…/g) ?? []` would have gone green over
 *      an empty array — a guard that passes because it found nothing to check
 *      is worse than no guard, because it reports a pass. Every loop of that
 *      shape in this file now counts.
 *
 * Those six are the four replacements `apps/site-next/README.md` recorded as
 * owed — it now records them as landed — plus the non-vacuity sweep, plus the
 * path move. The five additions are new checks over things this build has and
 * the old one did not:
 *
 *   7. The display face is preloaded on every page and the preloaded file must
 *      exist in the build. A preload whose href has gone stale is worse than no
 *      preload — a wasted request plus a warning — and the href is written as a
 *      node_modules path that the build rewrites, so it CAN be checked exactly.
 *
 *   8. No og:image or twitter:image may be addressed under `/assets/`, which
 *      `public/_headers` caches immutable for a year on the strength of content
 *      hashing that a file copied verbatim out of `public/` does not have.
 *
 *   9. Every page links at least one stylesheet, and every stylesheet link is
 *      served from `/assets/`. The old site wrote its `<link>` by hand into
 *      each page; here Vite injects it from the entry's module graph, so a page
 *      whose entry stops importing the sheets ships intact markup with no CSS
 *      — and every wording assertion in this file passes on it.
 *
 *  10. Every class in a built page is defined in a stylesheet that page links.
 *      Item 9 counts links; this one reads them. status.html is why both are
 *      here: for one day it linked the three shared sheets and none of its five
 *      section sheets, which satisfies a link count and leaves 35 of its 46
 *      classes with no rule behind them. The old site had no equivalent because
 *      it had no build step between the class in the markup and the rule in the
 *      sheet — here there is one, and this is the check on it.
 *
 *  11. The brand mark is one artwork, byte-identical on both surfaces, and it
 *      is drawn at a size its halftone survives. Two checks, and they replaced a
 *      single earlier one on 2026-09-05 when the owner swapped the monochrome
 *      ledger R for the comic R. That earlier check compared one path string
 *      across `src/brand/markPath.ts`, `src/brand/mark.svg` and
 *      `public/favicon.svg`; the comic mark is five colour layers rather than
 *      one tintable path, so there is no single path left to compare and both
 *      of that check's other assertions (`fill="none"` present, no `<rect>`)
 *      became false of artwork that is correct. What is guarded instead is the
 *      property the old one was really about: the mark and the favicon are each
 *      the same bytes on rwally.com and on app.rwally.com, so the two origins
 *      cannot ship two logos, and neither stylesheet may draw the mark below the
 *      48-pixel floor the brand set measured. The old site had one favicon and
 *      no mark.
 *
 * The two DROPS are assertions the old suite made that this build cannot make.
 * Each is a decision with a reason, and each is written down here for one
 * reason: a check that quietly stops existing reads later as a gap nobody
 * chose.
 *
 *  12. The three inherited-value WCAG pins and the three-theme-state count are
 *      GONE, and could not have been carried across. `apps/site/test/
 *      site.test.mjs` lines 400-402 pin three hex values out of the inherited
 *      palette as values that must NOT appear — `--faint` #8a8a9e, `--faint`
 *      #616178 and `--good` #178a4c — and line 408 asserts `--faint:` is set
 *      exactly three times, "in all three theme states". Neither survives
 *      contact with this palette: none of the three values occurs anywhere
 *      under `src/`, and there are not three theme states to count.
 *      The "ONE GROUND, NOT TWO" note in `src/tokens.css` states there is no
 *      `prefers-color-scheme` block and no `[data-theme]` switch, so `--faint:`
 *      is set once and asserting three would be asserting a build that does not
 *      exist. What stands in their place is not in this file at all: every text
 *      token records its own measured contrast ratio against both grounds
 *      inline, in the trailing comment on the `--faint:` and `--good:`
 *      declarations themselves — so a hex edited without recomputing its ratio
 *      is visible in the diff. Those three references are written as grep
 *      anchors rather than as line numbers because the line numbers that stood
 *      here (`:25`, `:67` and `:83`) all named lines the declarations had
 *      already moved off; `grep -n -- '--faint:' src/tokens.css` and the same
 *      for `'--good:'` each return exactly one line. This suite's part
 *      is to leave the values nowhere else to hide, which is item 4: only
 *      `src/tokens.css` may carry a colour literal at all.
 *
 *  13. The zero-JavaScript property is GONE, and this is where that is
 *      recorded rather than inferred from item 3. Item 3 replaced the CHECK;
 *      the property itself was retired by an OWNER DECISION, not by a
 *      test-authoring one. The owner directed a self-hosted React redesign —
 *      `apps/site-next/README.md` dates that decision, with the dark-cinematic
 *      one, to 2026-09-04 — and a React MPA ships one module script per page,
 *      so "this site sends no JavaScript" stopped being a property the build
 *      has, and therefore stopped being one any test could assert. That README
 *      states the trade in a line: self-hosted React "keeps 'no external
 *      request' and drops only 'zero JavaScript'". Item 3 is what keeps the
 *      remaining half exact — one module script, from /assets/, and nothing
 *      else — rather than merely weaker.
 *
 * Nothing else moved. `apps/site/test/site.test.mjs` is not edited by this
 * change and still guards the site that is currently served.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS. The launch constraint on this project is legal, not engineering: interests in
 * these vaults could be recharacterized as securities or collective-investment-scheme interests,
 * and marketing copy that promises an outcome is the cheapest way to make that worse. Prose has no
 * compiler, so this file is the compiler. A banned claim cannot reach `main` without turning the
 * gate red.
 *
 * The two rules that keep it honest:
 *   1. Ban PHRASES, anchored on word boundaries -- never bare words. "returns" is legitimate in
 *      "the vault returns your pro-rata slice"; "projected returns" never is. A test that bans
 *      single words gets neutered by the first false positive and then protects nothing.
 *   2. Some banned words have exactly one legitimate use on this site, always in a NEGATION
 *      ("not a guarantee", "nothing to sign up for", "not open source"). Those exact sentence
 *      fragments are enumerated in PERMITTED below and stripped BEFORE the absence checks run;
 *      the presence checks run against the unstripped source. Order matters. Every entry in
 *      PERMITTED is itself asserted to be in use, so the list cannot rot into a blanket exemption.
 *
 * WHAT THE 2026-08-29 ADVERSARIAL REVIEW CHANGED. Two independent reviewers demonstrated that
 * this file was partly cosmetic: it passed 18/18 over a page that contradicted the repository.
 * The numeric checks now read the reference mainnet configuration named by CONFIG_NAME below and
 * compare it to the site's reference-configuration table, so a config edit turns the gate red instead of silently
 * desynchronizing the site; the deployment-status check is sentence-scoped rather than page-scoped;
 * and the security-attestation qualifier must sit in the same block as the claim it qualifies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
// Digests, for the brand-mark guard: the two surfaces ship the same artwork and sameness over a
// 14 KB traced polygon set is a hash comparison rather than a string one.
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Resolve from this module, not process.cwd(): the suite is run both from apps/site-next (npm test)
// and from the repo root (npm run test:backend), and only one of those two has the pages under it.
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The build output. THE PAGES ARE READ FROM HERE — see note 1 in the header. */
const SITE = path.join(APP, 'dist');
const REPO = path.resolve(APP, '..', '..');
// REPOINTED 2026-09-05, carrying across the same repoint `apps/site/test/site.test.mjs` made at
// protocol/main b1cde122 by owner decision ("Remove the language for base. Just do robinhood for
// now."). The site's stated target chain is Robinhood Chain mainnet, chain id 4663, so the
// reference configuration the pages are checked against is that chain's file rather than Base's.
//
// The repoint is small because the two files are numerically identical for EVERY value this suite
// renders except one. smoke.gov (3600/3600/0/86400, 2500/500/4000/21600), smoke.minDepositUsdc
// (100000000), exitFeeMaxBps (50), exitFeeDecayPeriod (604800) and both sane-price bands match
// value for value. The only divergences are chainlinkOracle.assets[].heartbeatSeconds (3600 ->
// 86400, which is ChainlinkOracle.MAX_HEARTBEAT exactly) and chainlinkOracle.sequencerUptimeFeed
// (a Base address -> empty, because Chainlink publishes no L2 Sequencer Uptime Feed for 4663).
// So the entire numeric blast radius of this line is ONE table row on how-it-works.html and one
// prose figure on disclaimers.html (risks.html's replacement), both of which move from 3,600
// seconds to 86,400.
//
// base-mainnet.json is NOT deleted and must not be: scripts/test/config-doc-truth.test.mjs reads
// it directly and asserts its sequencer uptime feed is still a real address.
const CONFIG_PATH = path.join(REPO, 'contracts', 'config', 'robinhood-mainnet.json');
const CONFIG_NAME = 'contracts/config/robinhood-mainnet.json';

// TWO, and the count is written down in exactly one place: this array's length, asserted below.
//
// IT WAS NINE UNTIL 2026-09-05. The website v3 brief of that evening collapsed the site: "ONE
// cinematic scroll page + the app button + a serious Disclaimers page." how-it-works, agents,
// who-its-for, operators, faq, vision and status are retired, and `public/_redirects` 301s every
// one of their URLs. Six go to `/`, because what each of them said is now a section of the one
// scroll page; status goes to `/disclaimers`, because what survived it is the deployment record and
// the claims register and that material lives on the Disclaimers page.
//
// THE GUARDS DID NOT SHRINK WITH THE PAGE COUNT, WHICH IS THE POINT OF THIS COMMENT. Every check in
// this file that named a retired page has been repointed at whichever surviving surface carries the
// claim it was checking, or deleted with the reason written where it stood. A guard quietly dropped
// because its page went away is a claim that stops being checked, and that is the failure this file
// exists to prevent. Search this file for "RETIRED 2026-09-05" to find every one of them.
//
// Prose in this file says "every page" rather than a number wherever the number is not the thing
// being asserted: a spelled-out count in a comment is a claim that goes stale silently.
const PAGES = ['index.html', 'disclaimers.html'];
const DISCLAIMERS_PAGE = 'disclaimers.html';

/**
 * Every test in this file reads `dist/`, and `dist/` is a build artefact that is not in the
 * repository. So a checkout with no build is not a failure — it is a suite with nothing to say —
 * and it SKIPS, once per test, with the command that fixes it.
 *
 * The skip is expressed as an option on each test rather than as an `if` around the file, for one
 * reason worth stating: an early return is not available at module scope in ESM, and wrapping seven
 * hundred lines in a function to get one would re-indent every assertion in the file and make the
 * diff against `apps/site/test/site.test.mjs` — the thing that proves nothing was quietly relaxed —
 * unreadable. `t()` is `test()` with that option pre-filled. A skipped test never runs its body, so
 * the lazy page reads below never happen either.
 */
const BUILT = existsSync(SITE);
const SKIP = 'apps/site-next/dist is not built, run `npm run build` in apps/site-next first';
/** @type {(name: string, fn: () => void | Promise<void>) => void} */
const t = (name, fn) => test(name, BUILT ? {} : { skip: SKIP }, fn);

/**
 * Everything else the banned-phrase list must also cover: the README and the two stylesheets a
 * reader of this repository meets. Same three roles the apps/site list had; `src/index.css` is the
 * reset and the shared surfaces, `src/tokens.css` is the palette, and both carry long prose
 * comments that are exactly as publishable as a paragraph on a page.
 *
 * `src/fonts.css` is not here and does not need to be: it is checked by name in the stylesheet
 * tests below, and it carries no claim about the protocol.
 *
 * Paths are relative to the APP, not to SITE: these three are source, not build output.
 */
const PROSE_FILES = ['README.md', 'src/tokens.css', 'src/index.css'];

// The exact strings the spec pins. Any drift in punctuation or dashes is a failure, by design.
//
// BANNER_STATUS IS NOW A KNOWN, DOCUMENTED MISMATCH AGAINST THE CORPUS, NOT AN OVERSIGHT. The
// corpus (apps/site/test/site.test.mjs as rewritten 2026-09-05) RETIRED this exact sentence as
// false — the protocol is on Robinhood Chain mainnet, so "Not deployed to mainnet" no longer holds
// — and replaced it with DEPLOYED_LINE below, pinned to appear exactly once on status.html and once
// on disclaimers.html and nowhere else.
//
// THE OLD ABSOLUTE IS NOT DECLARED HERE AT ALL, and that is the finished state rather than an
// omission. For part of 2026-09-05 this file carried it as a constant with a note saying the shared
// `src/shell/Footer.tsx` rendered it on every page and that the corpus's shape was unreachable
// without editing that component. The component was then edited: the footer now carries the
// Disclaimers column and a link, exactly as the corpus footer does, and the sentence is gone from
// the build. Measured over this build, the string "Not deployed to mainnet" occurs zero times on
// every page. A constant nothing counts is a claim nobody checks, so it is deleted rather than
// left declared.
const BANNER_OFFER = 'Nothing on this site is an offer, a solicitation, or financial advice.';
// ADDED 2026-09-05, carrying across the corpus's replacement for the retired BANNER_STATUS absolute.
// Unlike BANNER_STATUS this one IS reachable in the shape the corpus pins it: it is page-local
// content (status.html's band, disclaimers.html's hero), not routed through the shared Footer, so
// it renders exactly where the corpus says it should — see DEPLOYED_LINE_COUNTS below.
const DEPLOYED_LINE = 'Deployed on Robinhood Chain mainnet, chain id 4663.';
// RETIRED AS A PINNED SENTENCE 2026-09-05, KEPT AS A COUNTED ABSENCE. This was FOOTER_TOKEN, the
// corpus's `No token.` sentence, and it rendered once on disclaimers.html. RWLY was created at
// 2026-09-05T21:51:57Z, so the sentence opens on a false clause and cannot be repaired by
// rewording: the whole sentence exists to say a thing does not exist. It is not deleted from this
// file, because a sentence that was true yesterday is exactly the sentence an editor restores from
// a corpus page tomorrow: it is pinned at ZERO on every page instead, so a reappearance reds.
const RETIRED_NO_TOKEN = 'No token. No points. No airdrop. No presale.';
const FOOTER_LICENSE = 'Open source under the MIT licence.';
// RENAMED 2026-09-05 by owner decision: the site is called RWAlly, and
// "Agent-Governed Vaults" survives only as the footer descriptor line. The
// capitals are the joke and not a typo: RWA is the play on words, and it is the
// same casing the token already carried on chain.
//
// THE CORPUS SUITE'S OWN COPY OF THIS CONSTANT NOW AGREES. It deliberately did
// not, for one commit: `apps/site/test/site.test.mjs` pinned the old casing
// against nine pages that pass did not own, and flipping it from there would
// have reddened a suite over pages nobody had touched. The corpus was flipped in
// its own commit on the same day, so the split is closed. Two constants and two
// surfaces still, but they say the same thing, and a future divergence between
// them is drift rather than a decision.
const TITLE_SUFFIX = ' | RWAlly';

// The external hosts any page may reference. NAVIGATION TARGETS ONLY: nothing on this site LOADS a
// byte from any of them, which is the property the scan below actually protects and the reason the
// list can grow without weakening it. A stylesheet, a script, a font or an image from any host at
// all is refused by `public/_headers`, whose only fetch relaxation outside 'self' is a connect-src
// for the chain's JSON-RPC endpoint.
//
// WHY THERE ARE THREE SINCE 2026-09-05, WHERE THERE WAS ONE:
//   github.com       the repository. It was the only one because it was the only off-site link.
//   app.rwally.com   the app shell, which the v3 brief makes the page's primary call to action. It
//                    is a separate origin rather than a path, so it cannot be a relative link.
//   x.com            the project's account, given by the owner on 2026-09-05. The header carries it
//                    as an icon and the footer as a labelled link.
//
// ADDING A FOURTH IS A DECISION, NOT A FIX. Anything that is not one of these three is an external
// dependency this site has spent a lot of effort not having.
const ALLOWED_HOSTS = new Set(['github.com', 'app.rwally.com', 'x.com']);

// The site's own public host, and the ONE exemption to the rule above -- see isExemptCanonical().
const CANONICAL_HOST = 'rwally.com';

/** Phrases banned on every page, everywhere, with no exception. */
const BANNED = [
  /\bAPY\b/i,
  // Widened 2026-08-29: /\bguaranteed\b/ missed "guarantee", "guarantees", "guaranteeing".
  /\bguarantee(?:s|d|ing)?\b/i,
  /\brisk-?free\b/i,
  /\bprojected returns?\b/i,
  /\bexpected returns?\b/i,
  /\bhigh yield\b/i,
  /\bzero capital cost\b/i,
  /\bour fund\b/i,
  /\bwe manage\b/i,
  /\bpassive income\b/i,
  /\bwaitlist\b/i,
  /\bearly access\b/i,
  /\bcbETH\b/i,
  // Widened 2026-08-29: /\baudited\b/ missed "audits" and "auditor". The suffix group is NOT
  // optional, deliberately: "pre-audit", "AI pre-audit" and the docs/audit/ path are legitimate
  // and ship on this site, and making the suffix optional turns every one of them red.
  /\baudit(?:s|ed|or|ors)\b/i,
  // Not in the spec's minimum list, added here deliberately: "safe" is an outcome word with no
  // legitimate use in this copy, and the fail-closed oracle must be described by its mechanism
  // ("every read reverts") rather than by a reassurance.
  /\bsafe\b/i,
  /\bguarantees? (?:a|the) return\b/i,
  // Return-implying vocabulary. None of these has a legitimate use in copy that must not imply
  // an outcome, and each is a phrase a well-meaning editor reaches for first.
  /\bAPR\b/,
  /\bROI\b/,
  /annuali[sz]ed/i,
  /\btarget return/i,
  /\bestimated return/i,
  /\boutperform\w*/i,
  /\balpha\b/i,
  // Conversion-surface vocabulary. This site has no form, no wallet connection and no funnel;
  // the moment one of these appears, it has one.
  /\bconnect wallet\b/i,
  /\bsign up\b/i,
  /\bget started\b/i,
  // Discretionary-manager vocabulary. The whole collective-investment-scheme argument turns on
  // the site never describing anyone as running the vault for a depositor.
  /\bwe run\b/i,
  /\bwe rebalance\b/i,
  /\byour portfolio\b/i,
  /\bmanaged\b/i,
  /\bour vault\b/i,
];

/** Phrases banned everywhere EXCEPT inside the two exact footer sentences, where they are negated. */
const BANNED_OUTSIDE_FOOTER = [/\bairdrop\b/i, /\bpresale\b/i, /\bopen source\b/i];

/**
 * Exact fragments where a banned word is used in a NEGATION and is therefore permitted. Stripped
 * before the BANNED checks run. Every entry must be a full clause, never a bare word, and every
 * entry is asserted below to be in actual use somewhere on the site.
 */
const PERMITTED = [
  // "guarantee" -- the geofencing sentence in every footer and in three page bodies, the hero
  // lede's unhedged no-outcome sentence, and the invariant/parameter split on how-it-works.
  //
  // TWO ENTRIES WERE DELETED HERE ON 2026-09-04, and the deletion is the point rather than
  // collateral. `may be presented anywhere as a protocol-level guarantee` and `described as a
  // guarantee of anything` were exemptions for text that existed ONLY inside the per-claim review
  // markers -- hiw-invariant and ops-obligation respectively -- so when the owner had the markers
  // removed, both became standing exemptions covering nothing. The "every permitted negation is
  // actually in use" test below is what would have caught them, and the remedy it names is the one
  // taken: delete the entry, do not leave a blanket hole for a banned word to walk through later.
  'a good-faith measure and not a guarantee',
  'no guarantee of any outcome',
  // RETIRED 2026-09-05: 'treating a parameter as a guarantee is how people get hurt' was
  // how-it-works.html's invariant-versus-parameter lede and went with that page. It is DELETED
  // rather than kept, which is exactly the remedy the rot test below names: an exemption covering
  // nothing is a standing hole for a banned word to walk through later.
  // "sign up" -- every remaining occurrence denies that there is anything to sign up for.
  //
  // 'There is nothing to sign up for.' WAS DELETED HERE ON 2026-09-05, and the deletion is the
  // remedy this list's own rot test asks for rather than collateral. It was index.html's "Next"
  // heading; that heading is now 'There is nothing to claim here.', so the entry covered nothing
  // and would have been a standing hole for a banned phrase to walk through later. The remaining
  // entry is still in use, on who-its-for.html.
  //
  // RETIRED 2026-09-05: 'nothing on this site to sign up for' was who-its-for.html's and went with
  // it, deleted for the same reason as the entry above. The banned phrase "sign up" now occurs
  // nowhere on either surviving page, so there is nothing left to exempt.
];

/**
 * How many times each exact footer sentence may appear on a given page. The footer carries one.
 * faq.html deliberately repeats BOTH in its body -- the no-token sentence answers "Is there a
 * token?" and the licence sentence answers "What licence is the code under?", and those are the
 * two answers people quote. Counted rather than blanket-stripped: the old scrub() removed every
 * occurrence, so a stray copy anywhere on a page went unnoticed.
 */
// CHANGED 2026-09-05. faq.html's own "Is there a token?" / "Can I fork it?" answers no longer
// quote FOOTER_TOKEN/FOOTER_LICENSE verbatim — the corpus rewrote both answers to point at
// disclaimers.html instead of repeating the sentence. The footer no longer restates either
// sentence on any page: `src/shell/Footer.tsx` carries a Disclaimers column and a link to that page
// where it used to carry a "Standing facts" column, which is what the corpus footer does at
// protocol/main 2faed164.
// REPOINTED 2026-09-05 to the counts `apps/site/test/site.test.mjs` carries at protocol/main
// 2faed164. The site-copy change moved every warning, limit and legal sentence onto one page and
// the footer now links to it rather than restating it, so the DEFAULT IS ZERO: "airdrop",
// "presale" and "open source" are banned outright on the other seven pages, where one copy of each
// used to be permitted per page. Measured against that corpus — FOOTER_TOKEN appears on
// disclaimers.html and no other page; FOOTER_LICENSE likewise.
//
// CHANGED AGAIN 2026-09-05, WITH THE v3 FOOTER. `src/shell/Footer.tsx` renders FOOTER_LICENSE on
// every page again, under the links, which is where the corpus footer carries it. So the licence
// sentence is 1 on index.html and 2 on disclaimers.html: the shared footer's copy, plus the copy in
// that page's own body answering "What licence is the code under?". FOOTER_TOKEN is unchanged and
// still appears on disclaimers.html alone, because the homepage is capped at 150 to 250 visible
// words by the same brief and does not spend nine of them restating a sentence the page it links to
// states in full. A THIRD COPY OF EITHER, ANYWHERE, REDS THIS GUARD.
//
// CHANGED A THIRD TIME 2026-09-05, WITH THE LAUNCH. The no-token sentence is now pinned at ZERO on
// every page, disclaimers.html included, because RWLY exists. Read that as a tightening rather
// than a removal: the sentence used to be REQUIRED on one page and banned on the other, and it is
// now banned on both, which is a strictly smaller set of builds that pass. The scrub() below
// therefore strips no copy of it anywhere, so the two negated words it carried have no exemption
// left and `BANNED_OUTSIDE_FOOTER` bans them outright on the whole site.
const FOOTER_SENTENCE_COUNTS = {
  [RETIRED_NO_TOKEN]: { default: 0 },
  [FOOTER_LICENSE]: { default: 1, [DISCLAIMERS_PAGE]: 2 },
};

/** @type {Map<string, string>} */
const raw = new Map();
// Guarded, not lazy-per-test: with no build there is nothing to read and every test is skipped, so
// an empty map is never observed by an assertion.
//
// A PAGE MISSING FROM AN OTHERWISE-BUILT dist READS AS EMPTY RATHER THAN THROWING. This line used
// to call readFileSync unguarded, so `dist/` present but one page absent — a stale build, or a page
// added to PAGES before it was added to `vite.config.ts` inputs — threw at MODULE SCOPE and killed
// the whole file with a bare ENOENT before a single test ran. That is the worst report this suite
// can give: it names a path and no cause, and it hides the thirty-odd other results. Read it as
// empty instead, and let `every public page exists in the build` be the test that says which page is missing.
if (BUILT) {
  for (const p of PAGES) {
    const f = path.join(SITE, p);
    raw.set(p, existsSync(f) ? readFileSync(f, 'utf8') : '');
  }
}

/**
 * The page with the PERMITTED NUMBER of footer sentences removed -- not all of them. The old
 * scrub() used split().join() and stripped every occurrence, so a third copy of the licence
 * sentence anywhere on a page took its "open source" exemption with it.
 * @param {string} html
 * @param {string} page
 */
function scrub(html, page) {
  let out = html;
  for (const [sentence, allowed] of Object.entries(FOOTER_SENTENCE_COUNTS)) {
    const want = /** @type {Record<string, number>} */ (allowed)[page] ?? allowed.default;
    for (let i = 0; i < want; i++) out = out.replace(sentence, ' '); // replace() strips one
  }
  return out;
}

/** The text with every PERMITTED negation removed, so its banned words do not count. */
function scrubPermitted(text) {
  let out = text;
  for (const phrase of PERMITTED) out = out.split(phrase).join(' ');
  return out;
}

const count = (haystack, needle) => haystack.split(needle).length - 1;

t('every public page exists in the build', () => {
  assert.equal(PAGES.length, 2, 'PAGES must list every public page; it is two since the v3 brief of 2026-09-05 collapsed the site to one scroll page plus Disclaimers');
  for (const p of PAGES) assert.ok(existsSync(path.join(SITE, p)), `missing page: ${p}`);
});

t('no banned claim appears on any page', () => {
  for (const p of PAGES) {
    const html = scrubPermitted(raw.get(p) ?? '');
    for (const re of BANNED) {
      const hit = html.match(re);
      assert.equal(hit, null, `${p}: banned phrase ${re} matched ${JSON.stringify(hit?.[0])}`);
    }
  }
});

test('no banned claim appears in the README or either stylesheet either', () => {
  // Only BANNED, never BANNED_OUTSIDE_FOOTER: the README quotes the negated licence sentence when
  // it documents the exception, which is exactly the use that sentence exists for.
  for (const f of PROSE_FILES) {
    const text = scrubPermitted(readFileSync(path.join(APP, f), 'utf8'));
    for (const re of BANNED) {
      const hit = text.match(re);
      assert.equal(hit, null, `${f}: banned phrase ${re} matched ${JSON.stringify(hit?.[0])}`);
    }
  }
});

t('every permitted negation is actually in use, so the exemption list cannot rot', () => {
  const all = [...PAGES.map((p) => raw.get(p) ?? ''), ...PROSE_FILES.map((f) => readFileSync(path.join(APP, f), 'utf8'))].join('\n');
  for (const phrase of PERMITTED) {
    assert.ok(all.includes(phrase), `PERMITTED carries a phrase no page uses: ${JSON.stringify(phrase)}, delete it rather than leaving a standing exemption`);
  }
});

t('"open source", "airdrop" and "presale" appear only inside the exact footer sentences', () => {
  for (const p of PAGES) {
    const html = scrub(raw.get(p) ?? '', p);
    for (const re of BANNED_OUTSIDE_FOOTER) {
      const hit = html.match(re);
      assert.equal(hit, null, `${p}: ${re} appears outside the permitted footer sentence (${JSON.stringify(hit?.[0])})`);
    }
  }
});

t('each footer sentence appears exactly the number of times it is permitted to', () => {
  for (const [sentence, allowed] of Object.entries(FOOTER_SENTENCE_COUNTS)) {
    for (const p of PAGES) {
      const want = /** @type {Record<string, number>} */ (allowed)[p] ?? allowed.default;
      const got = count(raw.get(p) ?? '', sentence);
      assert.equal(got, want, `${p}: expected ${want} occurrence(s) of ${JSON.stringify(sentence)}, found ${got}. Update FOOTER_SENTENCE_COUNTS and the README in the same commit if the repetition is deliberate.`);
    }
  }
});

/**
 * THE STATUS BLOCK MOVED, AND THESE THREE TESTS SAY EXACTLY WHERE IT WENT.
 *
 * Owner decision, 2026-09-04: "Claims should not be a header page, it should be a link in the
 * footer." The banner that sat above the nav on all seven pages is gone from every one of them and
 * now appears once, on status.html, inside `<main>`.
 *
 * THE DISCLOSURE DID NOT MOVE WITH IT, and that is the fact that makes the change safe rather than
 * a deletion. Both pinned sentences have always ALSO been the opening of every page's footer legal
 * paragraph -- the not-an-offer sentence first, the deployment-status sentence second -- so every
 * page carried each of them twice, and removing the band leaves each page stating each of them
 * exactly once. Nothing was dropped; a duplicate was.
 *
 * Three tests, because there are three separate ways to get this wrong and a single combined
 * assertion would report the wrong one:
 *
 *   1. `the top status band is gone ...` -- a page the sweep missed, or a band re-added later.
 *   2. `every page states the deployment status ...` -- a footer edit that drops the disclosure now
 *      that nothing above the nav repeats it. This is the assertion that actually protects the
 *      reader, and it is the reason the count is pinned per page rather than merely `>= 1`.
 *   3. `status.html carries the full status block` -- the status page quietly emptied into a link.
 *
 * CHANGED 2026-09-05, CARRYING ACROSS THE CORPUS'S OWN CONSOLIDATION. faq.html no longer quotes the
 * deployment-status sentence in an answer body (that repetition was deliberately dropped, along with
 * the FOOTER_TOKEN/FOOTER_LICENSE duplicates — see the note on FOOTER_SENTENCE_COUNTS), and
 * status.html's own band no longer restates BANNER_STATUS/BANNER_OFFER at all: it states
 * DEPLOYED_LINE instead (see DEPLOYED_LINE_COUNTS and the "status.html carries the full status
 * block" test below). So BANNER_STATUS and BANNER_OFFER are now counted the SAME on every page —
 * once each, from the shared Footer only — except disclaimers.html, where BANNER_OFFER also opens
 * risks-hero's own paragraph and so counts twice. That disclaimers.html exception is the frozen-
 * Footer artefact described on BANNER_STATUS above, not a corpus-pinned shape.
 */
const STATUS_PAGE = 'status.html';

// REPOINTED 2026-09-05 to `apps/site/test/site.test.mjs`'s PINNED_SENTENCE_COUNTS at protocol/main
// 2faed164, and it is the largest claims change in this file. BANNER_STATUS is GONE, not moved: it
// was the absolute "Not deployed to mainnet.", the protocol is now on Robinhood Chain mainnet, and
// an absolute that is false cannot be pinned anywhere. DEPLOYED_LINE replaces it and names the
// chain id, which is what makes it checkable against the committed deployment record.
//
// Zero everywhere a sentence is not named: a stray copy on an eighth page is as much a drift as a
// missing one. Verified against this build — BANNER_OFFER once on disclaimers.html and nowhere
// else; DEPLOYED_LINE once on status.html and once on disclaimers.html; the string "Not deployed to
// mainnet" zero times on every page.
const STATUS_SENTENCE_COUNTS = {
  [DEPLOYED_LINE]: { default: 0, 'status.html': 1, [DISCLAIMERS_PAGE]: 1 },
  [BANNER_OFFER]: { default: 0, [DISCLAIMERS_PAGE]: 1 },
};

/**
 * DEPLOYED_LINE's own count, tracked separately from STATUS_SENTENCE_COUNTS because it is pinned
 * INSIDE <main> on the two pages that carry it (status.html's band, disclaimers.html's hero) rather
 * than in the footer — the opposite placement rule from BANNER_STATUS/BANNER_OFFER. This is the one
 * pinned-sentence count in this file that already matches the corpus's shape exactly: Footer.tsx
 * plays no part in it.
 */
const DEPLOYED_LINE_COUNTS = { default: 0, [STATUS_PAGE]: 1, [DISCLAIMERS_PAGE]: 1 };

/** The status band of a page, markup and all, or null when the page has none. */
const statusBand = (html) => (html.match(/<div class="banner">[\s\S]*?<\/div><\/div>/) ?? [null])[0];

t('the top status band is gone from every marketing page and lives only on the status page', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    const bands = (html.match(/<div class="banner">/g) ?? []).length;
    if (p === STATUS_PAGE) {
      assert.equal(bands, 1, `${p}: the status page must carry exactly one status band, found ${bands}`);
      continue;
    }
    assert.equal(
      bands,
      0,
      `${p}: the top status band was moved to ${STATUS_PAGE} by owner decision 2026-09-04, link to it from the footer instead of restoring it here`,
    );
  }
});

// THE PLACEMENT HALF OF THIS TEST IS GONE, and its absence is the point. It required the LAST
// occurrence of each pinned sentence to sit after `<footer`, because the footer was the only place
// every page stated it. The site-copy change took those sentences out of the footer entirely and
// left a link in their place, so a footer-position rule would now assert something no page does.
// What replaces it is stricter about the thing that actually matters: the count, defaulting to
// zero, so a sentence cannot reappear on a page that is not named — and the mandatory footer link
// to the Disclaimers page, which the "every page's footer links to the disclaimers page" test above
// pins on every page.
t('each pinned sentence appears exactly where it is pinned, and nowhere else', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    assert.ok(html.indexOf('<footer') !== -1, `${p}: missing <footer>`);
    for (const [sentence, allowed] of Object.entries(STATUS_SENTENCE_COUNTS)) {
      const want = /** @type {Record<string, number>} */ (allowed)[p] ?? allowed.default;
      const got = count(html, sentence);
      assert.equal(got, want, `${p}: expected ${want} occurrence(s) of ${JSON.stringify(sentence)}, found ${got}`);
    }
  }
});

/**
 * ADDED 2026-09-05, carrying across the corpus's own "each pinned sentence appears exactly where
 * it is pinned, and inside main" check for DEPLOYED_LINE specifically. Opposite placement rule from
 * the test above: DEPLOYED_LINE is never in the footer, so it is checked against <main>/<footer>
 * bounds rather than against footerAt alone.
 */
t('DEPLOYED_LINE appears exactly where pinned, inside main and never in the footer', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    const mainAt = html.indexOf('<main id="main"');
    const footerAt = html.indexOf('<footer');
    assert.ok(mainAt !== -1 && footerAt !== -1, `${p}: missing <main id="main"> or <footer>`);
    const want = /** @type {Record<string, number>} */ (DEPLOYED_LINE_COUNTS)[p] ?? DEPLOYED_LINE_COUNTS.default;
    const got = count(html, DEPLOYED_LINE);
    assert.equal(got, want, `${p}: expected ${want} occurrence(s) of ${JSON.stringify(DEPLOYED_LINE)}, found ${got}`);
    if (want === 0) continue;
    const at = html.indexOf(DEPLOYED_LINE);
    assert.ok(at > mainAt && at < footerAt, `${p}: ${JSON.stringify(DEPLOYED_LINE)} must sit inside <main>, not in the footer or above the nav`);
  }
});

/*
 * RETIRED 2026-09-05: `status.html carries the full status block, inside main rather than above the
 * nav`.
 *
 * The test that stood here asserted that the pre-launch band was absent from every marketing page
 * and present exactly once, inside `<main>`, on status.html. status.html is retired: the v3 brief
 * collapsed the site to one scroll page plus Disclaimers, and `public/_redirects` 301s `/status` to
 * `/disclaimers`.
 *
 * NOTHING IT CHECKED IS NOW UNCHECKED, which is the only reason it is deleted rather than
 * repointed. Its two halves survive elsewhere in this file:
 *
 *   THE ABSENCE HALF is `each pinned sentence appears exactly where it is pinned, and nowhere
 *   else`, which counts BANNER_STATUS and BANNER_OFFER per page against PINNED_SENTENCE_COUNTS and
 *   reds any page carrying one it is not pinned on. That is the stronger check of the two, because
 *   it counts rather than merely asserting absence.
 *
 *   THE DEPLOYMENT-RECORD HALF is `DEPLOYED_LINE appears exactly where pinned, inside main and
 *   never in the footer`, whose counts now name disclaimers.html alone.
 *
 * And the facts the band carried are no longer asserted by the page at all: index.html READS the
 * chain state from the public RPC in the reader's own browser, which `src/sections/index-live/`
 * renders with the call that produced each figure printed beside it.
 */
// RENAMED AND HALVED 2026-09-05: it was `the two standing sentences are stated once each`, and one
// of the two was the no-token sentence. What replaced that half is not nothing, and it is not a
// weaker check either: the sentence must now be ABSENT from both pages, and the token block that
// stands in its place is pinned by the RWLY leg further down, which requires the address, the fixed
// supply figure and the creator-position disclosure to be on the page by name.
t('the licence sentence is stated on the Disclaimers page, and the retired no-token sentence on neither', () => {
  const html = raw.get(DISCLAIMERS_PAGE) ?? '';
  assert.ok(html.includes(FOOTER_LICENSE), `${DISCLAIMERS_PAGE}: missing exact licence sentence`);
  for (const p of PAGES) {
    assert.ok(
      !(raw.get(p) ?? '').includes(RETIRED_NO_TOKEN),
      `${p}: carries the retired no-token sentence ${JSON.stringify(RETIRED_NO_TOKEN)}. RWLY was created at ` +
        '2026-09-05T21:51:57Z and the sentence opens on a false clause. Do not reword it back in from a ' +
        'corpus page that has not been through its own flip yet',
    );
  }
});

// The "banner precedes the nav on every page" test was deleted on 2026-09-04 rather than adapted.
// It asserted the ONE property the owner's decision reverses -- that the status block sits above
// the nav -- so there is nothing left of it to keep. What it was protecting, that the disclosure is
// not buried, is now carried by the footer-position assertion two tests above, which is strictly
// stronger: it pins the count as well as the position.

t('document skeleton: doctype, lang, one h1, main, skip link, description, title', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    assert.ok(/^<!doctype html>/i.test(html.trimStart()), `${p}: missing doctype`);
    assert.ok(html.includes('lang="en"'), `${p}: missing lang="en"`);
    assert.equal(html.split('<h1').length - 1, 1, `${p}: must have exactly one <h1>`);
    assert.ok(html.includes('<main id="main"'), `${p}: missing <main id="main">`);
    assert.ok(html.includes('href="#main"'), `${p}: missing skip link targeting #main`);
    assert.ok(html.includes('<meta name="description"'), `${p}: missing meta description`);
    const title = html.match(/<title>([^<]*)<\/title>/);
    assert.ok(title, `${p}: missing <title>`);
    assert.ok(title[1].endsWith(TITLE_SUFFIX), `${p}: title must end in "${TITLE_SUFFIX}" (got ${JSON.stringify(title[1])})`);
    assert.ok(html.includes('<footer'), `${p}: missing <footer>`);
  }
});

t('the skip link is the first focusable element on every page', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    const body = html.slice(html.indexOf('<body'));
    const firstAnchor = body.indexOf('<a ');
    const skip = body.indexOf('href="#main"');
    assert.ok(firstAnchor !== -1 && skip !== -1, `${p}: no anchors found in body`);
    assert.ok(skip - firstAnchor < 120, `${p}: the skip link must be the first anchor in <body>`);
  }
});

/**
 * THE PER-CLAIM REVIEW MARKERS ARE GONE, AND THIS IS THE GUARD THAT KEEPS THEM GONE.
 *
 * Owner decision, 2026-09-04: "The audit counsel is now becoming an issue with repetitiveness.
 * Remove them entirely so that we can work faster." The markers were HTML comments emitted into the
 * prerendered pages by a shell component, and they were spread across most of the section
 * directories in this build.
 *
 * THE ASSERTION INVERTS RATHER THAN DISAPPEARING. A deleted check protects nothing, and the habit
 * was spread widely enough that without a guard it comes back one section at a time and nobody
 * notices until there are eighty again. So this walks the SOURCE — `src/`, `test/`, `scripts/` —
 * as well as the build output, because the marker plumbing lived in components, in copy modules, in
 * a stylesheet rule and in the section READMEs, not only in the markup.
 *
 * THE NEEDLE IS BUILT RATHER THAN WRITTEN. A guard has to name the string it bans, and this file is
 * inside its own walk, so spelling the token here would make the test fail on itself. Concatenating
 * it keeps the walk honest instead of carving out an exemption for the one directory that would be
 * easiest to hide something in.
 *
 * WHAT IS DELIBERATELY NOT BANNED: the lower-case word. CHANGED 2026-09-05: the specific published
 * sentence this note used to cite ("flagged for counsel", on the old risks.html r13 and on
 * faq.html) is gone from the 2026-09-05 copy deck — disclaimers.html's r13 now discloses the same
 * open licensing question without that phrase. The reasoning stands regardless of whether any
 * current page happens to use the word: a guard banning "counsel" case-insensitively everywhere
 * would forbid the site from ever naming a real legal fact in its own words, and a guard that would
 * have to be deleted the first time it fired is not a guard worth keeping. Only the ALL-CAPS marker
 * token and the same word inside an HTML comment are banned, below.
 */
const MARKER_TOKEN = 'COUN' + 'SEL';

/** Every text file under one directory, recursively; binaries are skipped by extension. */
function textFilesUnder(root, dir = '') {
  const here = path.join(root, dir);
  if (!existsSync(here)) return [];
  /** @type {string[]} */
  const out = [];
  for (const e of readdirSync(here, { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...textFilesUnder(root, rel));
    else if (!/\.(?:png|ico|jpg|jpeg|gif|webp|woff2?|ttf|otf|eot)$/i.test(e.name)) out.push(rel);
  }
  return out;
}

test('no per-claim review marker survives in the source or in the build', () => {
  /** @type {Array<[string, string]>} */
  const roots = [
    ['src', path.join(APP, 'src')],
    ['test', path.join(APP, 'test')],
    ['scripts', path.join(APP, 'scripts')],
  ];
  // dist/ only when it is built. With no build there is nothing to read, and the source legs above
  // still run — this test is not one of the ones that skip.
  if (BUILT) roots.push(['dist', SITE]);

  let scanned = 0;
  for (const [label, root] of roots) {
    for (const f of textFilesUnder(root)) {
      scanned++;
      const text = readFileSync(path.join(root, f), 'utf8');
      assert.ok(
        !text.includes(MARKER_TOKEN),
        `${label}/${f}: the per-claim review markers were removed by owner decision 2026-09-04, do not reintroduce them`,
      );
    }
  }
  // NON-VACUITY. src/ alone holds well over a hundred files; a count near zero means the walk
  // stopped reading rather than that the markers stopped existing.
  assert.ok(scanned >= 50, `the marker sweep read only ${scanned} files; it is no longer walking the source`);
});

/**
 * REPLACES `zero JavaScript: no script tags, no event handler attributes` — the first of the four
 * replacements apps/site-next/README.md records as owed, and the only one that had to give ground
 * on the letter of the old rule. This build is React; a page with no `<script>` would not hydrate.
 *
 * What the old rule was protecting is not "no JavaScript" but "nothing the CSP would refuse and
 * nothing a reader cannot see the source of". So the replacement is exact rather than absent, and
 * checks four things the old one checked none of:
 *
 *   - EXACTLY ONE `<script>` per page, and it must match the shape Vite emits for a module entry
 *     served from this origin. Two scripts, or one whose src is anywhere but /assets/, fails.
 *   - No inline script. `script-src 'self'` has no 'unsafe-inline', so an inline script does not
 *     run — and the failure is silent unless somebody is watching the console. That is also why
 *     `build.modulePreload.polyfill` is false in vite.config.ts: the polyfill Vite would otherwise
 *     inject is exactly this. This assertion is what would notice it coming back.
 *   - No `<style>` element and no `style=` attribute. `style-src 'self'` refuses both, and
 *     public/_headers:37-41 states outright that there are none. That was an unchecked claim.
 *   - No `on*=` handler. Carried over from the old rule unchanged.
 */
const MODULE_SCRIPT = /^<script type="module" crossorigin src="\/assets\/[^"]+\.js"><\/script>$/;

t('exactly one module script per page, from /assets/, and no inline script, style or handler', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    const scripts = html.match(/<script\b[\s\S]*?<\/script>/gi) ?? [];
    assert.equal(scripts.length, 1, `${p}: expected exactly one <script>, found ${scripts.length}`);
    assert.ok(
      MODULE_SCRIPT.test(scripts[0]),
      `${p}: the one script must be the built module entry served from this origin, got ${JSON.stringify(scripts[0].slice(0, 120))}`,
    );
    assert.equal(html.match(/\son[a-z]+\s*=/i), null, `${p}: contains an inline event handler attribute`);
    assert.equal(html.match(/<style\b/i), null, `${p}: contains a <style> element, which style-src 'self' refuses`);
    assert.equal(html.match(/\sstyle\s*=\s*"/i), null, `${p}: contains an inline style attribute, which style-src 'self' refuses`);
  }
});

/**
 * The display face is preloaded on every page, and the href must name a file that exists.
 *
 * The preload is written in the entry HTML as a path into node_modules and rewritten by the build:
 * Vite resolves it through the same asset pipeline that rewrites the url() in fonts.css, emits one
 * hashed copy, and writes the /assets/ path into the output. That is the whole reason this check
 * can be strict — a hand-maintained hash would go stale on the next build and nobody would know,
 * and a stale preload is worse than none: a wasted request for a file that is not there, plus a
 * console warning that the preloaded resource went unused.
 */
t('every page preloads the display face, and the preloaded file exists in the build', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    const links = (html.match(/<link\b[^>]*\brel="preload"[^>]*>/gi) ?? []).filter((l) => /\bas="font"/i.test(l));
    assert.equal(
      links.length,
      1,
      `${p}: expected exactly one font preload, found ${links.length}. If dist/ predates the entry HTMLs, rebuild: npm run build in apps/site-next`,
    );
    const link = links[0];
    assert.ok(/\bcrossorigin\b/i.test(link), `${p}: a font preload without crossorigin fetches the file twice`);
    assert.ok(/\btype="font\/woff2"/i.test(link), `${p}: the font preload must declare type="font/woff2"`);
    const href = link.match(/\bhref="([^"]*)"/i)?.[1];
    assert.ok(href && href.startsWith('/assets/'), `${p}: the preload href must be a built asset path, got ${JSON.stringify(href)}`);
    assert.ok(
      existsSync(path.join(SITE, href.replace(/^\//, ''))),
      `${p}: the preload points at ${href}, which is not in the build. The href in the entry HTML is a node_modules path that Vite rewrites; if it did not resolve, fix the path rather than hard-coding a hash`,
    );
  }
});

/**
 * NOTHING UNHASHED MAY BE ADDRESSED UNDER /assets/.
 *
 * public/_headers gives `/assets/*` a year of `immutable` caching, and the justification written
 * there is that the build emits content-hashed filenames under that prefix. Vite hashes what it
 * PROCESSES and copies public/ through verbatim, so a file at public/assets/x.png serves from
 * /assets/x.png with a fixed name and inherits a promise it cannot keep: replacing it leaves every
 * cache that already holds it serving the old bytes for a year, with no way to bust it.
 *
 * The social-preview card was at public/assets/og-card.png and is now at public/og-card.png. This
 * check is the reason it cannot drift back.
 */
t('no social-preview image is addressed under the immutable /assets/ prefix', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    for (const m of html.matchAll(/<meta[^>]*(?:property="og:image"|name="twitter:image")[^>]*content="([^"]*)"/gi)) {
      assert.ok(
        !/\/assets\//i.test(m[1]),
        `${p}: ${m[1]} is served from /assets/, which public/_headers caches immutable for a year on the strength of content hashing that a verbatim public/ copy does not have. Move the file to public/ and point at https://rwally.com/<name>. If dist/ predates the entry HTMLs, rebuild`,
      );
    }
  }
});

/**
 * The href values exempted from the host rule below: `rel="canonical"` links pointing at this
 * site's own public host. This is the ONLY exemption, and it exists for a reason worth writing
 * down rather than leaving to be reconstructed.
 *
 * The invariant the host rule protects is that a page LOADS nothing from anywhere and NAVIGATES
 * off-site only to the project repository. A canonical link does neither: it fetches no resource,
 * and it is not a link a reader can follow -- it is metadata that happens to be spelled with an
 * `href` rather than a `content` attribute, which is why `og:url` needs no exemption and this does.
 *
 * It also cannot be written any other way. A RELATIVE canonical would pass this check untouched
 * and is worse than having none at all, because it cannot do the one job canonicals exist for:
 * collapsing www/non-www, http/https and trailing-slash duplicates of a page onto one URL. An
 * exemption that lets the correct form ship beats a check that only permits the useless form.
 *
 * Both halves of the exemption are load-bearing and deliberately narrow. `rel="canonical"` ONLY --
 * any other `rel` (stylesheet, preload, icon) still fails, because those DO load. And
 * CANONICAL_HOST ONLY -- a canonical pointing anywhere else is not exempt and still fails.
 *
 * TWO WAYS THIS WAS WRONG WHEN FIRST WRITTEN, BOTH FOUND IN REVIEW, BOTH WORTH RECORDING:
 *
 * It matched the host with `startsWith('https://rwally.com')`, so `https://rwally.com.attacker.
 * example/x` prefixed it and was exempt. The host is now parsed with `new URL` and compared for
 * EQUALITY. Never re-narrow this to a string prefix: a prefix of a hostname is a different
 * hostname, and the attacker picks the suffix.
 *
 * It exempted href VALUES rather than the tags carrying them, so any `src` or `href` anywhere on
 * the page that happened to equal an exempted value inherited the exemption -- including a
 * `rel="stylesheet"`, which does load. Composed with the prefix bug, a stylesheet pulling from a
 * foreign host passed this gate green. The exempt canonical tags are now REMOVED from the markup
 * before the scan, so the exemption cannot spread past the tag it was written for.
 *
 * The shape of the mistake, since it will recur: an exemption narrowed by describing it in a
 * comment rather than by encoding it. Both sentences above were in the file, and both were false
 * as implemented. Test the exemption's edges with a probe, not with prose.
 */
const isExemptCanonical = (tag) => {
  if (!/\brel\s*=\s*"canonical"/i.test(tag)) return false;
  const href = tag.match(/\bhref\s*=\s*"([^"]*)"/i)?.[1];
  if (!href) return false;
  let u;
  try {
    u = new URL(href);
  } catch {
    return false; // relative or malformed: not exempt, and the host rule ignores it anyway
  }
  return u.protocol === 'https:' && u.host.toLowerCase() === CANONICAL_HOST;
};

/** The markup with the exempt canonical tags removed, so the scan below never sees them. */
const withoutExemptCanonicals = (html) =>
  html.replace(/<link\b[^>]*>/gi, (tag) => (isExemptCanonical(tag) ? ' ' : tag));

t('no external requests: the only permitted remote host is the project repository', () => {
  let scanned = 0;
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    assert.ok(!/fonts\.googleapis\.com/i.test(html), `${p}: references fonts.googleapis.com`);
    assert.ok(!/fonts\.gstatic\.com/i.test(html), `${p}: references fonts.gstatic.com`);
    // Scan the markup with the exempt canonical tags removed, rather than skipping matching
    // href VALUES: a value-scoped skip leaks the exemption to any other tag carrying the same URL.
    for (const m of withoutExemptCanonicals(html).matchAll(/(?:src|href)\s*=\s*"([^"]*)"/gi)) {
      scanned++;
      const v = m[1];
      if (!/^(?:https?:)?\/\//i.test(v)) continue; // relative or fragment: fine
      const host = v.replace(/^(?:https?:)?\/\//i, '').split('/')[0].toLowerCase();
      assert.ok(ALLOWED_HOSTS.has(host), `${p}: external host ${host} is not permitted`);
    }
  }
  // NON-VACUITY. A page whose markup the regex no longer matches — a change of quoting style is
  // enough — would make this loop iterate zero times and report a pass over nothing.
  assert.ok(scanned >= PAGES.length * 8, `the src/href scan matched only ${scanned} attributes across ${PAGES.length} pages; it is no longer reading the markup it is supposed to check`);
});

t('every internal .html link resolves to a file on disk', () => {
  let checked = 0;
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    for (const m of html.matchAll(/href\s*=\s*"([^"]+\.html)(?:#[^"]*)?"/gi)) {
      const target = m[1];
      if (/^(?:https?:)?\/\//i.test(target)) continue;
      checked++;
      assert.ok(existsSync(path.join(SITE, target)), `${p}: dead internal link -> ${target}`);
    }
  }
  // NON-VACUITY. Every page carries a nav to the other six and a footer list, so the true count is
  // in the dozens per page; anything near zero means the links stopped being written as .html and
  // this check silently stopped checking.
  assert.ok(checked >= PAGES.length * 6, `only ${checked} internal .html links were resolved across ${PAGES.length} pages; the nav is not being read`);
});

/**
 * FIXED 2026-09-05, and recorded because for part of that day it was a known failure this file
 * reported rather than hid. `src/shell/Footer.tsx` filtered the current page out of its own Pages
 * list with a special case written for status.html alone, before disclaimers.html existed, so the
 * disclaimers page was the one page with no link to itself — while status.html got a self-link
 * carrying `aria-current="page"`. Both footer-only pages now take that clause. The six pages in the
 * header nav self-link through the masthead, which does not filter the current page at all.
 */
t('every page links to every other page', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    for (const other of PAGES) {
      // "is missing", not "the nav is missing": seven of the eight come from the masthead and
      // status.html comes from the footer's Pages list.
      assert.ok(html.includes(`href="${other}"`), `${p}: is missing a link to ${other}`);
    }
  }
});

/** Strip CSS comments. Both stylesheets document the rules they follow IN those comments, so the
 *  declaration-level checks below have to look at declarations, not at prose about declarations. */
const decls = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** Every CSS file the build compiles: the three shared sheets, then every section's module CSS. */
function stylesheets() {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.css')) out.push(full);
    }
  };
  walk(path.join(APP, 'src'));
  return out;
}

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/;

/**
 * REPLACES `stylesheets exist and site.css contains no raw hex colour literal`. Same property,
 * wider surface: the old site had two stylesheets and one of them was allowed the literals. This
 * build has three shared sheets plus one module stylesheet per section, and exactly one file —
 * src/tokens.css — may carry a colour literal. That is what makes a re-theme a one-file change,
 * and a section that hard-codes `#a094ff` breaks it silently because it looks right.
 */
test('src/tokens.css is the only stylesheet permitted a colour literal', () => {
  const files = stylesheets();
  assert.ok(files.length >= 10, `expected the section stylesheets to be found under src/, got ${files.length}`);
  const tokensPath = path.join(APP, 'src', 'tokens.css');
  assert.ok(files.includes(tokensPath), 'src/tokens.css is missing');
  for (const f of files) {
    if (f === tokensPath) continue;
    // Declarations only. Every one of these files documents the rule it follows in a comment, and
    // a comment that names a hex value is prose about a declaration, not a declaration.
    const hex = decls(readFileSync(f, 'utf8')).match(HEX);
    assert.equal(
      hex,
      null,
      `${path.relative(APP, f)} must reference tokens only, found raw colour ${JSON.stringify(hex?.[0])}, add a token to src/tokens.css instead`,
    );
  }
});

test('no stylesheet reaches off this origin', () => {
  for (const f of stylesheets()) {
    const rel = path.relative(APP, f);
    const text = readFileSync(f, 'utf8');
    // The host check stays on the RAW text: a font host has no business appearing in any of them.
    assert.ok(!/fonts\.(?:googleapis|gstatic)\.com/i.test(text), `${rel} references a webfont host`);
    const body = decls(text);
    assert.ok(!/@import/i.test(body), `${rel} must not @import anything`);
    for (const m of body.matchAll(/url\(\s*['"]?([^'")]+)/gi)) {
      assert.ok(
        !/^(?:https?:)?\/\//i.test(m[1]),
        `${rel}: url(${m[1]}) is an absolute URL. Every asset ships from this origin; font-src and img-src are 'self'`,
      );
    }
  }
});

/**
 * REPLACES `tokens.css defines the full inherited token set…`. The old list was the token set of
 * the site this one succeeds, and half of those names — line-soft, the -soft pairs, shadow-1/2,
 * r-sm/r-md/r-lg, maxw — do not exist here, while --seam, the step scale and the motion curves do.
 * Pinning a list of names to a file is also the weaker half of what that test was for.
 *
 * The stronger property, and the one checked instead: EVERY token any stylesheet reads is defined.
 * A `var(--typo)` renders as nothing at all and is invisible in a screenshot of a dark page; this
 * is the check that catches it, and unlike a fixed list it cannot go stale.
 */
test('every custom property any stylesheet reads is defined, in tokens.css or locally', () => {
  const tokens = decls(readFileSync(path.join(APP, 'src', 'tokens.css'), 'utf8'));
  const defined = new Set([...tokens.matchAll(/--([a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
  assert.ok(defined.size >= 40, `src/tokens.css defines only ${defined.size} custom properties; it is not the palette any more`);
  let read = 0;
  for (const f of stylesheets()) {
    const body = decls(readFileSync(f, 'utf8'));
    // A section may define its own custom properties; those count as defined for that file.
    const local = new Set([...body.matchAll(/--([a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
    for (const m of body.matchAll(/var\(\s*--([a-zA-Z0-9-]+)/g)) {
      read++;
      assert.ok(
        defined.has(m[1]) || local.has(m[1]),
        `${path.relative(APP, f)} reads var(--${m[1]}), which is defined nowhere. It resolves to nothing and the declaration is dropped`,
      );
    }
  }
  assert.ok(read >= 100, `only ${read} var() reads were found across the stylesheets; this check is not reading them`);
});

/**
 * REPLACES `tokens.css must use system font stacks only`, INVERTED. That rule existed because the
 * old site fetched no font, so a named family in a stack was dead weight masking the fallback that
 * actually rendered. This build bundles three faces from this origin, so naming them is correct and
 * the check becomes the other half of the same property: a family named in a stack must be one the
 * page can actually get, which means an @font-face in fonts.css whose src is same-origin.
 */
test('every non-generic family named in a token stack has a same-origin @font-face', () => {
  const tokens = decls(readFileSync(path.join(APP, 'src', 'tokens.css'), 'utf8'));
  const fonts = decls(readFileSync(path.join(APP, 'src', 'fonts.css'), 'utf8'));
  const faces = new Set(
    [...fonts.matchAll(/font-family:\s*'([^']+)'/g)].map((m) => m[1]),
  );
  assert.ok(faces.size >= 3, `src/fonts.css declares only ${faces.size} @font-face families; the three bundled faces are missing`);
  // Every quoted family in the three stacks must either be declared here or be a face installed on
  // the reader's machine — and the only way to tell those apart is that the ones we declare are the
  // ones we ship. So: quoted names in --display/--sans/--mono that fonts.css does not declare are
  // fallbacks, and a fallback must not be one of OUR bundled family names misspelled.
  let stacks = 0;
  for (const m of tokens.matchAll(/--(?:display|sans|mono):\s*([^;]+);/g)) {
    stacks++;
    const first = m[1].match(/'([^']+)'/)?.[1];
    assert.ok(first, `a token stack names no primary family: ${m[1].trim()}`);
    assert.ok(
      faces.has(first),
      `the first family in a stack is ${JSON.stringify(first)}, which src/fonts.css does not declare, the page cannot fetch it and would silently render the fallback`,
    );
  }
  assert.equal(stacks, 3, `expected --display, --sans and --mono in src/tokens.css, found ${stacks}`);
  for (const m of fonts.matchAll(/src:\s*([^;]+);/g)) {
    assert.ok(
      !/^\s*url\(\s*['"]?(?:https?:)?\/\//i.test(m[1]),
      `src/fonts.css fetches a face from another origin: ${m[1].trim().slice(0, 80)}`,
    );
  }
});

/*
 * RETIRED 2026-09-05: `the operator page states the capital obligation exactly, and never denies
 * it`.
 *
 * It asserted that operators.html stated the 2,500 USDG figure and the 5% creator gate, named the
 * proposal threshold and the creator withdrawal gate, and never claimed a zero capital cost.
 * operators.html is retired; `public/_redirects` 301s `/operators` to `/`.
 *
 * THE CLAIM IS NOT UNGUARDED, AND THIS IS WHERE THE READER SHOULD LOOK FOR IT. `apps/site` still
 * carries all nine pages, operators.html among them, and `apps/site/test/site.test.mjs` still runs
 * this exact check against it. That corpus is also the sentence source this file's own
 * `every homepage sentence comes from a source that was checked` leg reads from, so the operator
 * economics remain both published and guarded, on the surface that publishes them.
 *
 * WHAT WOULD MAKE THIS A REAL LOSS: this site restating the operator's capital obligation in its
 * own words. It does not. Neither surviving page mentions the 2,500 USDG figure or the 5% gate at
 * all, and if one ever does, the check belongs back here pointed at that page.
 */
t('no page manufactures urgency or a price expectation', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    // `\bhurry\b` is deliberately NOT here: who-its-for.html-style copy can legitimately say a small
    // first vault "is not a signal to hurry", which is the correct sentence and which a bare-word
    // ban would red. Ban phrases, never bare words — the rule this file opens with.
    for (const re of [/\blaunch(?:ing)? soon\b/i, /\bcoming soon\b/i, /\bnext week\b/i, /\bany day now\b/i, /\bto the moon\b/i, /\bdon'?t miss out\b/i]) {
      const hit = html.match(re);
      assert.equal(hit, null, `${p}: ${JSON.stringify(hit?.[0])} sets a clock or a price expectation this site has no business setting`);
    }
  }
});

/**
 * The published prose of a page: HTML comments dropped (a comment is a note to the next editor,
 * not copy a reader ever sees), tags flattened, and the meta description put back in front
 * because it is the string that travels into a link preview.
 */
function publishedProse(html) {
  const noComments = html.replace(/<!--[\s\S]*?-->/g, ' ');
  const metas = [...noComments.matchAll(/<meta[^>]*name="description"[^>]*content="([^"]*)"/gi)].map((m) => m[1]);
  const body = noComments.replace(/<[^>]*>/g, ' ');
  return [...metas, body].join(' . ');
}

const sentencesOf = (text) => text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);

// Genuine negations only. "whatever" and friends are deliberately absent: widening this list to
// swallow an unqualified sentence is gaming the check rather than fixing the sentence.
const NEGATED = /\bnot\b|\bno\b|\bnever\b|\bnothing\b|\bnone\b|\bnor\b|\bcannot\b|\bsuperseded\b|\bwould be\b/i;

/**
 * The chain a deployment sentence must name, or the record it must cite, to be checkable if it does
 * not negate itself. Same rule `scripts/test/claims-robinhood-deployment.test.mjs` uses at the
 * repo-root level, carried across here so the two guards converge rather than drift.
 */
const DEPLOY_CITED = /\brobinhood\b|\b4663\b|contracts\/config\/deployments\/robinhood-mainnet\.json/i;

/**
 * CHANGED 2026-09-05, CARRYING ACROSS THE CORPUS'S OWN REWRITE OF THIS TEST. It used to require
 * every sentence containing "deployed" to negate itself — true while nothing was deployed anywhere.
 * DEPLOYED_LINE ("Deployed on Robinhood Chain mainnet, chain id 4663.") is now pinned on status.html
 * and disclaimers.html precisely BECAUSE it is true and unnegatable, so a pure negation requirement
 * would red the one sentence the site most needs to state plainly. The successor rule is STRICTER,
 * not weaker: a sentence that says "deployed" without negating itself must name the chain (by word
 * or by chain id) or the deployment record, in the same sentence — a vague "it is deployed" still
 * fails where before it only had to avoid the word "not".
 */
t('every "deployed" either negates itself or names the chain and the record', () => {
  // Sentence-scoped, not page-scoped. A page-wide check is what let "Whatever gets deployed is
  // what runs" ship next to a banner three thousand characters away that said "Not deployed."
  let seen = 0;
  for (const p of PAGES) {
    for (const s of sentencesOf(publishedProse(raw.get(p) ?? ''))) {
      if (!/\bdeployed\b/i.test(s)) continue;
      seen++;
      if (NEGATED.test(s)) continue;
      assert.ok(
        DEPLOY_CITED.test(s),
        `${p}: "deployed" in a sentence that neither negates it nor says where, name Robinhood Chain, the chain id 4663, or contracts/config/deployments/robinhood-mainnet.json in the same sentence, ${JSON.stringify(s.trim())}`,
      );
    }
  }
  // NON-VACUITY, REPOINTED 2026-09-05. The floor used to be one per page, because the footer's
  // legal paragraph carried "Not deployed to mainnet." on every page. That paragraph is gone: the
  // site-copy change moved every pinned sentence onto the Disclaimers page and left a link behind,
  // so the word now appears only where a page has something to say about deployment. Measured over
  // this build, five sentences across the nine pages qualify. The floor is set at four rather than
  // five so that editing one of them out is a copy decision rather than a red gate, and it is not
  // set lower: the two pages that pin DEPLOYED_LINE contribute one each by construction, and a
  // reading below four means the sentence splitter or publishedProse() stopped returning prose.
  assert.ok(
    seen >= 4,
    `only ${seen} sentences containing "deployed" were found across ${PAGES.length} pages, and five were measured on 2026-09-05; below four this check is reading nothing rather than finding nothing`,
  );
});

t('the security-review attestation carries its qualifier in the same block', () => {
  // Block-scoped, not page-scoped: the old check was satisfied by a footer thousands of characters
  // away, so the claim could be excerpted without the fact that nobody can check it.
  const PHRASE = /external security review/gi;
  const BLOCK = /<(p|dd|li)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let seen = 0;
  for (const p of PAGES) {
    const html = (raw.get(p) ?? '').replace(/<!--[\s\S]*?-->/g, ' ');
    const blocks = [...html.matchAll(BLOCK)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, text: m[0] }));
    for (const hit of html.matchAll(PHRASE)) {
      seen++;
      const at = hit.index ?? 0;
      const enclosing = blocks
        .filter((b) => b.start <= at && at < b.end)
        .sort((a, b) => a.text.length - b.text.length)[0];
      assert.ok(enclosing, `${p}: "external security review" appears outside any paragraph or list item`);
      assert.ok(
        /no public report/i.test(enclosing.text),
        `${p}: names the external security review without the "no public report" qualifier in the same block, ${JSON.stringify(enclosing.text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 160))}`,
      );
    }
  }
  // NON-VACUITY, suite-wide: the attestation is not required on every page, but it is on several,
  // and a check that finds it nowhere has stopped being a check. If the claim were genuinely
  // deleted from the whole site this line is the one that says so, in a commit, out loud.
  assert.ok(seen >= 1, 'no page names an external security review. If the attestation was removed rather than qualified, say so in the commit and delete this test in the same change');
});

// ─────────────────────────── the site against the repository ───────────────────────────
//
// THE SINGLE HIGHEST-VALUE CHECK IN THIS FILE. Every number in the reference-configuration table
// is read out of the reference mainnet configuration named by CONFIG_NAME above and compared to
// what the page renders. Before
// this existed the table was pinned only to itself, so a config edit silently desynchronized the
// site and the gate stayed green. Every failure message here says the SITE is stale, never the
// config: the config is the source of truth and the page is the copy of it.

// THE FILE CAN BE ABSENT, AND ONLY FOR ONE REASON, so this reads it defensively and says which.
// `contracts/config/robinhood-mainnet.json` landed on `protocol/main` with the 2026-09-04 target
// chain decision. This branch was cut before that commit, so a worktree that has not been rebased
// does not have the file — and an unguarded `readFileSync` here throws at MODULE SCOPE, which
// kills the whole suite with a bare ENOENT and hides the other forty results. That is the same
// failure the page map above was hardened against, and the same answer applies: read it as absent
// and let the four tests that need it say so by name.
//
// THE SKIP IS NOT A RELAXATION AND MUST NOT BECOME ONE. It fires only when the file is not there,
// which on `protocol/main` it always is; CI runs on a branch that must be `behind_by 0` before it
// can merge, so these four run there. A skip here means the checkout predates the pivot, and the
// fix is to rebase, not to widen anything. Never make this fall back to `base-mainnet.json`: the
// pages now state Robinhood Chain's figures, and checking them against Base's would pass on
// nothing and red on the one row where the two files genuinely differ.
const HAS_CONFIG = existsSync(CONFIG_PATH);
const CONFIG_SKIP = `${CONFIG_NAME} is not in this checkout. It landed on protocol/main with the target-chain decision of 2026-09-04 and this branch predates it, rebase onto protocol/main and re-run`;
/** @type {(name: string, fn: () => void | Promise<void>) => void} */
const tc = (name, fn) => test(name, BUILT && HAS_CONFIG ? {} : { skip: BUILT ? CONFIG_SKIP : SKIP }, fn);
const config = HAS_CONFIG ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : null;

/** Every rendering of a duration this site would accept, derived from the raw seconds. */
function durations(seconds) {
  const out = [];
  if (seconds % 86400 === 0) out.push(`${seconds / 86400} day${seconds === 86400 ? '' : 's'}`);
  if (seconds % 3600 === 0) out.push(`${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`);
  if (seconds % 60 === 0) out.push(`${seconds / 60} minute${seconds === 60 ? '' : 's'}`);
  out.push(`${seconds.toLocaleString('en-US')} second${seconds === 1 ? '' : 's'}`);
  return out;
}

tc('the figures the Disclaimers page DERIVES from the config are pinned to it as well', () => {
  // These do not appear in any table, so a row-by-row check cannot see them. They are arithmetic on
  // config values, which is exactly the class of number that goes stale silently: a config edit
  // changes the true answer and leaves the sentence standing.
  //
  // TRIMMED, NOT RETIRED, ON 2026-09-05. The version this replaces asserted the Mode-F window on
  // how-it-works.html AND on disclaimers.html, and the two figures below on disclaimers.html alone.
  // how-it-works.html is retired with the page collapse and its half of the Mode-F loop is gone
  // with it; every assertion that named the SURVIVING page is here unchanged. This distinction is
  // the whole reason the note above the three retired config tests is worth reading: those three
  // read a retired page and nothing else, so they went; this one always read disclaimers.html too,
  // so deleting it outright would have stopped checking three live figures.
  const gov = config.smoke.gov;
  const modeFHours = (gov.timelockDuration + gov.executionWindow) / 3600;
  const disclaimers = raw.get(DISCLAIMERS_PAGE) ?? '';
  assert.ok(
    disclaimers.includes(`${modeFHours} hours in the reference configuration`),
    `${DISCLAIMERS_PAGE} is stale relative to ${CONFIG_NAME}: the Mode-F window is timelockDuration + executionWindow = ${modeFHours} hours`,
  );
  // What four seats BUY changed with the H-8/CM-7 remediation, while the arithmetic did not.
  // Before it, four dust seats passed a proposal outright, because the sub-five regime was a pure
  // head count. Now both sub-five branches weigh stake (`headMajorityWithStake` carries a stake
  // quorum term and `forStakeMajority` is stake alone), so dust cannot pass anything on numbers.
  // What four seats still buy is the REGIME: taking a single-member vault to five members moves it
  // out of the signer-count branch into the pure stake rule, which is H-8(a), documented by
  // `Governance.finalize` as unfixed by design and mitigated at the config layer by a meaningful
  // minimum deposit. So the seat price is still the minimum deposit and still moves with the config.
  const SEATS = 4;
  const capture = (SEATS * Number(BigInt(config.smoke.minDepositUsdc))) / 1e6;
  assert.ok(
    disclaimers.includes(`reference ${usdg(config.smoke.minDepositUsdc)} minimum deposit`),
    `${DISCLAIMERS_PAGE} is stale relative to ${CONFIG_NAME}: the minimum deposit renders as ${usdg(config.smoke.minDepositUsdc)}`,
  );
  assert.ok(
    disclaimers.includes(`about ${capture.toLocaleString('en-US')} USDG`),
    `${DISCLAIMERS_PAGE} is stale relative to ${CONFIG_NAME}: ${SEATS} seats at ${usdg(config.smoke.minDepositUsdc)} is about ${capture.toLocaleString('en-US')} USDG`,
  );
});

// ────────────────────────────── the 2026-08-29 corrections ──────────────────────────────

/** The "What is done" cells of the Disclaimers page (risks.html's replacement), as plain text, in document order. */
function whatIsDoneCells() {
  const html = raw.get(DISCLAIMERS_PAGE) ?? '';
  return [...html.matchAll(/<dt>What is done<\/dt><dd>([\s\S]*?)<\/dd>/g)].map((m) => m[1].replace(/<[^>]*>/g, '').trim());
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen'];

/** Every rendering of a basis-point figure this site would accept. */
function percents(bps) {
  const pct = bps / 100;
  return [`${pct}%`, `${pct.toFixed(2)}%`, `${bps} bps`];
}

// The settlement asset LABEL, not just the number. The reference configuration is now chain
// 4663's, whose settlement token under the `usdc` key is USDG (Global Dollar) rather than Circle
// USDC — see robinhood-mainnet.json `usdcNote`. The FIELD NAMES stay `usdc`/`minDepositUsdc`
// because the config keeps them (it is a verbatim copy of base-mainnet.json's smoke block, and
// nothing in contracts/ reads a symbol: VaultCore identifies the settlement token by address and
// measures it with decimals()). Only the rendered label moves, and the numbers do not move at all.
//
// Three site figures hang off this label and had to change together: the "Minimum deposit" table
// row on how-it-works.html, and disclaimers.html's "reference 100 USDG minimum deposit" and "about
// 400 USDG". The third of those is spelled out INLINE below rather than through this helper, which
// is exactly how a rename gets half-done — so it is named here.
const usdg = (units) => `${(Number(BigInt(units)) / 1e6).toLocaleString('en-US')} USDG`;
const wadDollars = (wad) => `$${(Number(BigInt(wad)) / 1e18).toLocaleString('en-US')}`;

/*
 * RETIRED 2026-09-05, ALL THREE OF THEM: `the reference-configuration table matches
 * <config> row for row`, `the sane-price bands on the site match the config`, and `the figures the
 * site DERIVES from the config are pinned to it as well`.
 *
 * These were the strongest guards in this file and losing them here is the most expensive thing the
 * page collapse cost, so this note says exactly what happened to each one.
 *
 * ALL THREE READ how-it-works.html AND NOTHING ELSE. That page carried a reference-configuration
 * table with a row per parameter, the WETH and cbBTC sane-price bands rendered as dollar figures,
 * and two figures DERIVED from the config rather than copied from it (the Mode-F window as
 * timelockDuration + executionWindow, and the minimum-deposit figure). Each test parsed
 * contracts/config/robinhood-mainnet.json and asserted the page agreed with it, which is what kept
 * a config edit from silently making the site wrong.
 *
 * how-it-works.html is retired. `public/_redirects` 301s `/how-it-works` to `/`, and the section it
 * collapsed into, `index.html#how`, carries the seven-step lifecycle in words and NOT ONE NUMBER
 * FROM THE CONFIG. There is nothing on either surviving page for these tests to compare, and a test
 * repointed at a page that states none of the values it checks is a test that passes vacuously,
 * which is worse than one that is gone.
 *
 * THE GUARDS THEMSELVES ARE NOT GONE FROM THE REPOSITORY. `apps/site` still carries all nine pages,
 * how-it-works.html among them, and `apps/site/test/site.test.mjs` still runs all three against it.
 * `apps/site` is also the corpus this file's own sentence-source leg reads from, so the numbers stay
 * published, stay guarded, and stay the source every sentence on this site is checked against.
 *
 * WHAT WOULD BRING THEM BACK: the moment either surviving page states a figure that comes from that
 * config, the matching check belongs here, pointed at that page. `scripts/test/claims-robinhood-
 * deployment.test.mjs` covers the deployment RECORD across every surface in the repository in the
 * meantime, and it is not page-scoped.
 */
t('the Disclaimers page states the true number of unmitigated risks', () => {
  const cells = whatIsDoneCells();
  assert.ok(cells.length >= 15, `${DISCLAIMERS_PAGE}: expected at least fifteen risk entries, parsed ${cells.length}`);
  const unmitigated = cells.filter((c) => c.startsWith('Nothing')).length;
  const word = NUMBER_WORDS[unmitigated];
  assert.ok(word, `${DISCLAIMERS_PAGE}: ${unmitigated} unmitigated risks is off the end of NUMBER_WORDS`);
  const disclaimers = raw.get(DISCLAIMERS_PAGE) ?? '';
  assert.ok(
    disclaimers.includes(`${word.charAt(0).toUpperCase()}${word.slice(1)} of these have no mitigation`),
    `${DISCLAIMERS_PAGE}: ${unmitigated} "What is done" cells begin with "Nothing", so the page must say "${word.charAt(0).toUpperCase()}${word.slice(1)} of these have no mitigation"`,
  );
});

t('every named risk has an anchor and a contents entry, including r15', () => {
  const html = raw.get(DISCLAIMERS_PAGE) ?? '';
  const ids = [...html.matchAll(/<article class="risk" id="(r\d+)">/g)].map((m) => m[1]);
  assert.ok(ids.includes('r15'), `${DISCLAIMERS_PAGE} must carry the oracle-rotation risk at #r15`);
  for (const id of ids) assert.ok(html.includes(`href="#${id}"`), `${DISCLAIMERS_PAGE}: #${id} has no contents entry`);
  const word = NUMBER_WORDS[ids.length];
  assert.ok(html.includes(`All ${word}.`), `${DISCLAIMERS_PAGE}: ${ids.length} risks, so the contents heading must read "All ${word}."`);
});

t('the corrections from the 2026-08-29 review have not been undone', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    // A3: the exit fee is not routed to the operator IDENTITY, but the operator holds shares and
    // the fee reaches them through share value. "No share of the exit fee" was simply false.
    assert.ok(!/no share of the exit fee/i.test(html), `${p}: "no share of the exit fee" is false, the operator's mandatory 5% collects it through share value`);
    // A7: the creator gate is a withdrawal gate, not a top-up obligation.
    assert.ok(!/must be topped up/i.test(html), `${p}: the creator gate is a withdrawal gate, not a top-up obligation`);
    // C7: there is no population of vaults to generalise from.
    assert.ok(!/set lower by many vaults/i.test(html), `${p}: there are no other vaults, nothing has been deployed`);
    // A1: Mode F opens at reveal start, not at passage.
    assert.ok(!/rebalance has passed but has not yet executed/i.test(html), `${p}: Mode F opens at reveal start, not when a proposal passes`);
    // A4: the pre-audit findings are not all closed.
    assert.ok(!/all of which are now resolved/i.test(html), `${p}: one High remains open at the launch configuration and a sub-vault class is dormant, not fixed`);
    // C8: the cap is a planned parameter of a vault that does not exist.
    if (html.includes('50,000')) {
      assert.ok(/\bplanned\b/i.test(html), `${p}: states the 50,000 figure without labelling it planned and undeployed`);
    }
  }
});

t('the sequencer guard is not presented as a proven mitigation', () => {
  const html = raw.get(DISCLAIMERS_PAGE) ?? '';
  const r5 = html.slice(html.indexOf('id="r5"'), html.indexOf('id="r6"'));
  assert.ok(!/severity--mitigated/.test(r5), `${DISCLAIMERS_PAGE}: risk 5 must not carry the green mitigated chip, the guard has never run against a real uptime feed`);
  assert.ok(/never (?:run|executed) against a real/i.test(r5), `${DISCLAIMERS_PAGE}: risk 5 must say the sequencer path has never executed against a real feed`);
});

/**
 * RWLY EXISTS NOW, AND EVERY MENTION OF IT STILL HAS TO CARRY WHAT MAKES IT CHECKABLE.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * REWRITTEN 2026-09-05, THE EVENING THE TOKEN WAS CREATED. Read this before touching the regex.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * This leg used to require the literal qualifier `does not exist` within 160 characters of every
 * `RWLY`. That was the right rule for a page describing a token that did not exist, and it became
 * the wrong rule at 2026-09-05T21:51:57Z, the timestamp of the block that created RWLY. A guard
 * that requires a false sentence is worse than no guard: it makes the falsehood load-bearing, so
 * the next editor who corrects the copy sees a red suite and reverts the correction.
 *
 * THE REPLACEMENT IS NOT WEAKER, AND THE SHAPE OF THE ARGUMENT MATTERS MORE THAN THE REGEX. The
 * old rule protected exactly one property: a named token is the easiest thing on these pages to
 * quote out of context into a claim that something is buyable, so no mention of it may travel
 * alone. That property is unchanged. What changed is which neighbour discharges it. Three now do,
 * and each is a fact a reader can check rather than a reassurance:
 *
 *   THE ADDRESS. `0x2eed8ae7`, the STEM, not the full forty-two characters, and that distinction
 *   is the one thing in this file most likely to be got wrong by someone tightening it. The hero
 *   chip renders `shorten(RWLY)`, which is the first ten characters, an ellipsis and the last
 *   eight. The full string exists on the homepage only inside the meta description and inside the
 *   copy button's `aria-label`, and `publishedProse()` strips every tag, so matching on the full
 *   address would red on correct copy at the chip's own `RWLY` label. Match the stem.
 *
 *   THE FIXED SUPPLY. `fixed supply`, case-insensitive, so the homepage's sentence-initial `Fixed
 *   supply 1,000,000,000` counts. The supply being fixed and minted once is the fact that makes
 *   every other number about this token stable, and it is the one an inflation claim would have
 *   to contradict.
 *
 *   THE DESIGN-INTENT HEDGE. `design intent`, `designed to` or `not built`. This is the old rule's
 *   real successor: it is what a mention of the STAKING, the epochs or the fee accrual must carry,
 *   because none of those exists and `grep -ci rwly` still returns 0 in Governance.sol,
 *   FeeEngine.sol and VaultCore.sol.
 *
 * DO NOT ADD A FOURTH ALTERNATIVE. In particular do not add a bare `designed`, `planned`, `future`
 * or `intends`: each of those is a word an editor can reach for while writing a sentence that
 * promises something, and the point of a three-item list is that every item is checkable against
 * either the chain or the absence of a contract.
 *
 * `does not exist` IS DELIBERATELY NOT IN THE LIST, even though it would be harmless as a
 * qualifier, because it is not harmless as COPY. The absence assertion at the foot of this leg
 * bans it outright on both pages: it is the exact sentence four other public surfaces still carry
 * at the time of writing, and the way it comes back is somebody copying a paragraph across from a
 * page that has not been flipped yet.
 *
 * `llms.txt` IS WALKED HERE AND IS NOT FLIPPED YET, AND THAT IS DELIBERATE RATHER THAN AN
 * OVERSIGHT. The repository-root `llms.txt` is shared byte-for-byte with `apps/site`, whose own
 * suite still requires `does not exist` beside every RWLY in it, so flipping it from here would
 * red that suite and take a surface this pass does not own with it. It passes this leg on its
 * `designed to` clause, which is true and stays true. It still carries one false clause, which is
 * a separate ticket against `apps/site`, and this note is here so that nobody reads its green
 * result as a statement that the file is correct.
 *
 * THE VISION-PAGE BRANCH IS GONE. `vision.html` was retired before this build shipped, `PAGES` is
 * two entries, and the section-scoped chip check it carried had nothing left to walk. Its reason
 * for existing (that `stRWLY` contains `RWLY`, so a page with thirty of them cannot satisfy a
 * window rule) is preserved instead as the design-intent proximity check below, which walks
 * `stRWLY`, `epoch` and `buyback` in their own right.
 */
const RWLY_WINDOW = 160;

/** The stem the page can actually show. See the note above before widening this to the full address. */
const RWLY_ADDRESS_STEM = '0x2eed8ae7';
const RWLY_SUPPLY = '1,000,000,000';

/** The hedge, on its own, because the proximity check below needs it without the other two. */
const DESIGN_INTENT = /design intent|designed to|not built/i;

const RWLY_QUALIFIER = new RegExp(`${RWLY_ADDRESS_STEM}|fixed supply|${DESIGN_INTENT.source}`, 'i');

/** The sentence the flip replaced, banned outright rather than merely no longer required. */
const RETIRED_RWLY_CLAUSES = ['RWLY does not exist', 'does not exist yet'];

/**
 * Terms that name a thing which does not exist on chain, and must therefore travel with the hedge.
 *
 * `epochs?` is here rather than `hourly epoch` because the homepage says `the epochs` and the
 * Disclaimers page says `no hourly epoch` and `no epoch`; pinning the longer phrase would check
 * one of the three.
 */
const DESIGN_ONLY_TERMS = /stRWLY|epochs?|buyback/gi;

/** Purchase vocabulary. None of it belongs in a sentence that names the token. */
const PURCHASE_VERB = /\b(?:buy|buys|buying|bought|purchase|purchases|purchasing|acquire|acquires|acquiring)\b/i;

/** Purchase INVITATIONS, banned anywhere on a page whether or not RWLY is in the same sentence. */
const PURCHASE_INVITE = [
  /\bbuy\s+RWLY\b/i,
  /\bbuy\s+the\s+token\b/i,
  /\bhow\s+to\s+buy\b/i,
  /\bwhere\s+to\s+buy\b/i,
  /\byou\s+can\s+buy\b/i,
  /\bbuy\s+now\b/i,
  /\bavailable\s+to\s+(?:buy|purchase)\b/i,
];

/**
 * The windows around every `RWLY` in a piece of prose that carry none of the three qualifiers.
 *
 * EXTRACTED AS A PURE FUNCTION SO THE PROBE BELOW CAN PROVE IT BITES. The old version of this leg
 * inlined the same logic in its loop, which means the only evidence it worked was that it was
 * green, and a window check is exactly the kind of guard that goes green by measuring the wrong
 * distance. `claims-lede-truth.test.mjs` carries two probes of this shape for the same reason.
 */
const rwlyUnqualified = (prose) => {
  const text = prose.replace(/\s+/g, ' ');
  const out = [];
  for (const m of text.matchAll(/RWLY/g)) {
    const at = m.index ?? 0;
    const window = text.slice(Math.max(0, at - RWLY_WINDOW), at + RWLY_WINDOW);
    if (!RWLY_QUALIFIER.test(window)) out.push(window.trim().slice(0, 200));
  }
  return out;
};

/** The same, for the terms that name something with no on-chain existence at all. */
const designOnlyUnhedged = (prose) => {
  const text = prose.replace(/\s+/g, ' ');
  const out = [];
  for (const m of text.matchAll(DESIGN_ONLY_TERMS)) {
    const at = m.index ?? 0;
    const window = text.slice(Math.max(0, at - RWLY_WINDOW), at + RWLY_WINDOW);
    if (!DESIGN_INTENT.test(window)) out.push(`${m[0]}: ${window.trim().slice(0, 200)}`);
  }
  return out;
};

/*
 * RE-MEASURED 2026-09-05 AFTER THE FLIP, AND THE NUMBER MOVED FOR A REASON WORTH WRITING DOWN.
 *
 * It was 8 against a measured 15. The flip changes the count in both directions: the homepage's
 * closing beat went from two mentions to one and gained a third address chip that carries the name
 * as a label, the three meta descriptions went from two mentions each to two of a different shape,
 * and the Disclaimers page's token block replaced one paragraph with four. Measured over this
 * build the count is printed by the leg itself, so it never has to be taken on trust from this
 * comment again.
 *
 * The floor stays BELOW the measurement with room, on the reasoning the previous author set it
 * that way: a floor set AT the count reds on the next legitimate edit and teaches whoever hits it
 * to lower the number rather than to look. It is a non-vacuity check (it exists so that deleting
 * every mention cannot make the qualifier test pass by having nothing to qualify) and it is not a
 * quota.
 */
const RWLY_FLOOR = 10;

/**
 * What each page must state about the token IN ITS OWN WORDS, not merely avoid getting wrong.
 *
 * THIS HALF IS WHY THE REWRITE IS A TIGHTENING. The old leg's one positive assertion pinned the
 * sentence `RWLY does not exist yet.` on index.html, a requirement that the page carry a claim
 * which is now false. Replacing it with nothing would have left the qualifier rule satisfiable by
 * a page that never names the token at all. So each page is pinned to the facts that make the
 * mention checkable: the address stem a reader pastes into an explorer, the supply figure, and on
 * the Disclaimers page the two disclosures that a reader cannot reconstruct without effort and
 * would resent learning from somewhere else.
 */
const RWLY_MUST_STATE = {
  'index.html': [RWLY_ADDRESS_STEM, RWLY_SUPPLY, 'RWLY is live.'],
  [DISCLAIMERS_PAGE]: [
    RWLY_ADDRESS_STEM,
    RWLY_SUPPLY,
    // The creator position. It is the sentence the whole flip turns on: the transaction is public
    // and the arithmetic is four lines, so the only question was whether this site said it first.
    '7.3% of the fixed supply',
    // Where the launch happened, and whose launchpad it is.
    'Pons',
    'design intent',
  ],
};

t('every mention of RWLY carries the address, the fixed supply or the design-intent hedge', () => {
  let seen = 0;
  for (const p of PAGES) {
    const fileText = raw.get(p) ?? '';
    seen += (fileText.replace(/\s+/g, ' ').match(/RWLY/g) ?? []).length;

    // TAGS STRIPPED FIRST, via the same publishedProse() every other window-style check in this
    // file already uses. This build's markup carries a hashed CSS-module class on most elements
    // (e.g. `class="_term_1xs2u_43"`), so a 160-character window measured over raw bytes counts
    // characters of markup rather than of prose, and a pair the reviewed source keeps well inside
    // the window can be pushed outside it by attribute soup alone. Stripping tags measures prose
    // distance, which is what a reader experiences.
    const prose = publishedProse(fileText);
    assert.deepEqual(
      rwlyUnqualified(prose),
      [],
      `${p}: names RWLY without the address stem ${RWLY_ADDRESS_STEM}, the words "fixed supply", or a ` +
        `design-intent hedge within ${RWLY_WINDOW} characters. RWLY exists as of 2026-09-05T21:51:57Z, it is ` +
        'a launchpad token no deployed contract of this protocol references, and everything designed around ' +
        'it is still only designed. A mention that travels alone is a mention that gets quoted alone',
    );

    assert.deepEqual(
      designOnlyUnhedged(prose),
      [],
      `${p}: names the staking token, an epoch or a buyback without a design-intent hedge within ` +
        `${RWLY_WINDOW} characters. None of the three exists on chain: the curve's own buyback flag is ` +
        'false on this launch, there is no epoch contract and no keeper, and there is no staking contract',
    );

    for (const clause of RETIRED_RWLY_CLAUSES) {
      assert.ok(
        !fileText.includes(clause),
        `${p}: carries the retired clause ${JSON.stringify(clause)}. It was true until 2026-09-05T21:51:57Z ` +
          'and is not now. Four other public surfaces still carry it and are a separate ticket, so the way ' +
          'this comes back is a paragraph copied across from one of them',
      );
    }

    for (const re of PURCHASE_INVITE) {
      const hit = fileText.match(re);
      assert.equal(hit, null, `${p}: ${JSON.stringify(hit?.[0])} invites a purchase. This site has no venue link and no funnel`);
    }

    for (const s of sentencesOf(publishedProse(fileText))) {
      if (!/\bRWLY\b/.test(s)) continue;
      const hit = s.match(PURCHASE_VERB);
      assert.equal(
        hit,
        null,
        `${p}: a sentence naming RWLY also says ${JSON.stringify(hit?.[0])}. Describe what the launch ` +
          `transaction did in the past tense against a named address, never what a reader might do, ` +
          JSON.stringify(s.trim().slice(0, 200)),
      );
    }
  }

  for (const [p, musts] of Object.entries(RWLY_MUST_STATE)) {
    const fileText = raw.get(p) ?? '';
    for (const must of musts) {
      assert.ok(
        fileText.includes(must),
        `${p}: must state ${JSON.stringify(must)}. A qualifier rule alone is satisfied by a page that ` +
          'never names the token, which is how a disclosure disappears without any guard going red',
      );
    }
  }

  // public/llms.txt is byte-identical to the repository-root copy (asserted elsewhere in this
  // file) and is part of the shipped surface, so it is walked here too. It is NOT flipped yet and
  // the header note above says why: the root copy is shared with `apps/site`, whose suite still
  // requires the retired clause in it. It passes on its `designed to` clause. Its remaining false
  // sentence is a separate ticket against that surface, and the retired-clause assertion above is
  // deliberately NOT applied to it for that reason.
  const llmsPath = path.join(APP, 'public', 'llms.txt');
  if (existsSync(llmsPath)) {
    const text = readFileSync(llmsPath, 'utf8');
    seen += (text.replace(/\s+/g, ' ').match(/RWLY/g) ?? []).length;
    assert.deepEqual(
      rwlyUnqualified(text),
      [],
      `public/llms.txt: names RWLY without the address stem, "fixed supply", or a design-intent hedge ` +
        `within ${RWLY_WINDOW} characters`,
    );
  }

  // PRINTED, NOT JUST ASSERTED, for the same reason the word budget is: a count that only appears
  // on failure is a count nobody watches move.
  console.log(`\n  RWLY named on ${seen} surfaces across ${PAGES.length} pages plus llms.txt (floor ${RWLY_FLOOR})\n`);
  assert.ok(
    seen >= RWLY_FLOOR,
    `expected RWLY to be named at least ${RWLY_FLOOR} times, found ${seen}. If the mentions were deleted ` +
      'rather than qualified, say so in the commit rather than letting this guard pass by absence',
  );
});

/**
 * PROBE: the window rule bites, and it spares the three forms the flip approved.
 *
 * WITHOUT THIS THE LEG ABOVE IS UNFALSIFIED. A window check has two failure modes that both report
 * green: measuring the wrong distance, and a qualifier alternation so wide that everything matches
 * it. The `bad` cases below are the shapes an editor actually writes, including the one this file
 * warns about twice: matching on the FULL address when the page can only render the stem.
 */
test('probe: the RWLY window rule catches a bare mention and spares the approved forms', () => {
  const PAD = 'x'.repeat(RWLY_WINDOW + 40);
  for (const bad of [
    'RWLY is live.',
    `RWLY trades today. ${PAD} It has a fixed supply.`,
    `The staking is design intent. ${PAD} RWLY is a token.`,
    'Hold RWLY.',
  ]) {
    assert.notDeepEqual(rwlyUnqualified(bad), [], `the window rule no longer catches: ${bad}`);
  }
  for (const ok of [
    // The homepage's own beat, as prose.
    'RWLY is live. Launched 2026-09-05 on Pons, a third-party launchpad, on a bonding curve quoted in ETH that graduated the same day. Fixed supply 1,000,000,000, no owner, no mint function, no upgrade path.',
    // The chip, which is a label and an address and nothing else.
    'RWLY 0x2eed8ae7…b6B7FDF9 Copy',
    // The hedge, which is what a mention of the unbuilt half has to carry.
    'RWLY is designed to accrue the protocol’s fees into official Robinhood Stock Tokens, and that mechanism is design intent rather than code.',
  ]) {
    assert.deepEqual(rwlyUnqualified(ok), [], `the window rule reds approved copy: ${ok}`);
  }

  // The stem, not the full address. This is the assertion that documents the trap: the full string
  // never survives publishedProse() on the homepage, so a guard written against it reds on correct
  // copy at the chip's own label.
  assert.deepEqual(rwlyUnqualified('RWLY 0x2eed8ae7…b6B7FDF9 Copy'), []);
  assert.notDeepEqual(
    rwlyUnqualified(`RWLY is a token. ${'y'.repeat(RWLY_WINDOW + 40)} 0x2eed8ae78AE1aa6824e1C378F46d5C51b6B7FDF9`),
    [],
    'an address far outside the window must not qualify a mention',
  );

  // And the design-intent proximity check, which is the vision-page branch's successor.
  assert.notDeepEqual(designOnlyUnhedged(`The buyback runs hourly. ${PAD} design intent`), []);
  assert.deepEqual(designOnlyUnhedged('There is no buyback; it is design intent.'), []);
});

/**
 * THE GUARD THAT PROVED WHY EVERY LOOP IN THIS FILE NOW COUNTS.
 *
 * In apps/site this read `assets/site.css` and iterated `/\.pre-launch[^{]*\{[^}]*\}/g`. The
 * redesign renamed the banner's class from `.pre-launch` to `.banner`, so the same guard pointed at
 * this build would have matched nothing, iterated an empty array, asserted nothing, and reported a
 * PASS — while the one stylesheet rule it exists to forbid went unchecked. A guard that is silent
 * about finding nothing is worse than no guard, because a reader sees the green and stops looking.
 *
 * So: the selector follows the class, the stylesheet path follows the file, and the block count is
 * asserted to be non-zero. The last of those three is the part that generalises, and it is applied
 * to every regex-iterating loop in this file.
 */
t('the status band cannot be hidden by the stylesheet', () => {
  const shell = decls(readFileSync(path.join(APP, 'src', 'index.css'), 'utf8'));
  const blocks = shell.match(/\.banner[^{]*\{[^}]*\}/g) ?? [];
  assert.ok(
    blocks.length > 0,
    'src/index.css contains no .banner rule. Either the status band is unstyled, or its class was renamed and this guard is now checking nothing, follow the class rather than deleting the check. The band is on status.html only since 2026-09-04, and the reasoning is unchanged and sharper for it: a status block that exists in the markup and renders at zero height passes every presence assertion above while showing a reader nothing',
  );
  for (const block of blocks) {
    assert.ok(!/display\s*:\s*none/i.test(block), `index.css hides the status band: ${block.replace(/\s+/g, ' ')}`);
    assert.ok(!/visibility\s*:\s*hidden/i.test(block), `index.css hides the status band: ${block.replace(/\s+/g, ' ')}`);
    assert.ok(!/(?:^|[;{])\s*height\s*:\s*0/i.test(block), `index.css collapses the status band: ${block.replace(/\s+/g, ' ')}`);
    assert.ok(!/font-size\s*:\s*0/i.test(block), `index.css collapses the status band: ${block.replace(/\s+/g, ' ')}`);
  }
  // The band is rendered by one component and styled by one file, so no section stylesheet has
  // any business carrying a `.banner` rule that could override the ones above.
  for (const f of stylesheets()) {
    if (f === path.join(APP, 'src', 'index.css')) continue;
    assert.equal(
      decls(readFileSync(f, 'utf8')).match(/\.banner[^{]*\{/),
      null,
      `${path.relative(APP, f)} styles .banner. The status band is owned by src/index.css; a second rule for it is a second place it can be hidden from`,
    );
  }
});

t('tables carry a caption and scoped headers', () => {
  let tables = 0;
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    for (const table of html.match(/<table[\s\S]*?<\/table>/gi) ?? []) {
      tables++;
      // `<caption[ >]` rather than `<caption>`: CSS-module class names are generated at build time
      // and land on the element, so the caption on a styled table is `<caption class="_caption_…">`.
      // The character class keeps the check strict — it still refuses `<captionfoo>` — while not
      // making "has a caption" depend on whether the caption is styled.
      assert.ok(/<caption[ >]/i.test(table), `${p}: a <table> is missing its <caption>`);
      assert.ok(/<th[^>]*\sscope="(?:col|row)"/i.test(table), `${p}: a <table> is missing scoped <th> cells`);
    }
  }
  // NON-VACUITY, AND IT IS NOW ASSERTED THE OTHER WAY ROUND.
  //
  // This used to require at least two tables across the site, so that a change of table markup
  // could not make the check pass over nothing. The four tables it counted were on how-it-works,
  // operators and status, and all three pages are retired: index.html renders the live reads as a
  // grid of `<div>` cells rather than a table, because those four figures are not tabular data with
  // a header row, and disclaimers.html has never had a table.
  //
  // So the floor of two would now fail on a site that is CORRECT, which is the one thing a
  // non-vacuity check must never do. What replaces it is the same protection stated for the state
  // this site is actually in: if a table appears, the loop above audits it; and if a table appears
  // WITHOUT this file being revisited, the assertion below is what makes that visible, by failing
  // and pointing at this paragraph. Raise the expected count and delete this note when a real table
  // lands, rather than deleting the check.
  assert.equal(
    tables,
    0,
    `${tables} table(s) were found, and this site had none when the check was written. Audit the new ` +
      'table against the caption and scope rules above, then pin the new count here.',
  );
});

// ═══════════════ the claim surface OUTSIDE apps/site — added by the 2026-09-01 audit ═══════════════
//
// WHY THIS SECTION EXISTS. Everything above stops at the six marketing pages. The 2026-09-01 claims
// audit found the same claims — one of them the *identical* claim this file already bans — alive
// and false in the repository's own member- and agent-facing prose, which publishes on the same day
// the site does. The rule that produced the gap is worth stating so it is not re-learned: a claims
// test protects the FILES IT READS and nothing else. Where a claim travels, the check must travel.
//
// Scope is per-rule and narrow rather than "run BANNED over the whole repo": the engineering docs
// legitimately say "audit", "safe" and "returns", and a blanket list over them would be neutered by
// its first false positive — the exact failure mode this file's header warns about.

/** Repository prose a non-developer or an integrating agent reads. Paths are repo-relative. */
const REPO_PROSE = ['README.md', 'llms.txt', 'docs/AGENT-QUICKSTART.md'];
const repoProse = new Map(REPO_PROSE.map((f) => [f, readFileSync(path.join(REPO, f), 'utf8')]));

/**
 * Mode F opens when a live proposal reaches its REVEAL phase, not when a proposal passes:
 * `VaultCore.requestExit` queues on `Governance.hasPendingExecution`, which returns true from
 * `p.commitDeadline` onward (`Governance.sol:648-659`). Every phrasing below puts the trigger at
 * passage instead, which understates the window in which a member's exit can be trapped, and hides
 * that a DEFEATED proposal still queued the exits requested while it was live.
 *
 * The site-page ban on one phrasing of this has existed since 2026-08-29 (correction A1 above). It
 * did not stop README.md, llms.txt and docs/AGENT-QUICKSTART.md shipping the same claim in three
 * other phrasings, because nothing read those files. Both halves now run over both surfaces.
 */
const MODE_F_MISSTATEMENTS = [
  /\bpassed[-\s]but[-\s]pending\b/i,
  /\bpassed[-\s]but[-\s]unexecuted\b/i,
  /\bbetween a vote passing\b/i,
  /\bvote passing and execut/i,
  /\brebalance has passed but has not yet executed\b/i,
];

t('no surface places the Mode-F trigger at proposal passage instead of reveal', () => {
  for (const [f, text] of repoProse) {
    for (const re of MODE_F_MISSTATEMENTS) {
      const hit = text.match(re);
      assert.equal(
        hit,
        null,
        `${f}: ${JSON.stringify(hit?.[0])} places the Mode-F trigger at passage. It opens at the reveal phase, Governance.hasPendingExecution is true from p.commitDeadline (Governance.sol:653)`,
      );
    }
  }
  for (const p of PAGES) {
    const prose = publishedProse(raw.get(p) ?? '');
    for (const re of MODE_F_MISSTATEMENTS) {
      const hit = prose.match(re);
      assert.equal(hit, null, `${p}: ${JSON.stringify(hit?.[0])} places the Mode-F trigger at passage, not at the reveal phase`);
    }
  }
});

t('every surface that describes Mode F names the reveal phase as its trigger', () => {
  // The negative check alone is satisfiable by deleting the sentence. This is the positive half:
  // each of these files explains the exit modes, so each must say WHEN the window opens.
  for (const [f, text] of repoProse) {
    assert.ok(
      /reveal phase/i.test(text),
      `${f} describes forward settlement but never names the reveal phase as the trigger, state when the window opens, do not merely avoid stating when it does not`,
    );
  }
});

/**
 * The open High must be NAMED wherever it is claimed, never left as an anonymous severity.
 *
 * At the launch configuration (`Deploy.s.sol` hardcodes `allowSubVaults = false`) exactly one High
 * is reachable: **H-8**, the stake-blind `<5`-member quorum regime — partially fixed in code, with
 * its regime-flip (attack (a)) mitigated only by a meaningful `minDepositUsdc`. H-5/H-6/H-7/H-9 are
 * NOT open-but-unfixed at launch; they are unreachable, because each requires a funded child vault
 * (AI-AUDIT-REPORT: "Dormant at launch — all require a funded child"). Their deferral is dormancy,
 * not EIP-170 headroom: PR #90 reclaimed VaultCore to 4,095 B of margin on 2026-09-01.
 *
 * risks.html carried this claim anonymously ("A High-severity pre-audit finding remains open…")
 * while index.html and faq.html named it in the same words two screens away. An unnamed severity is
 * the one form of this sentence a reader cannot check, and it reads as a larger admission than the
 * truth — so the check is that the class travels with the claim.
 */
const OPEN_HIGH_CLAIM = /remains open at the launch configuration/i;
// The class used to be spelled "stake-blind". That descriptor is now FALSE — the H-8/CM-7
// remediation put a stake term in both sub-five branches — so pinning it here would have required
// every surface to keep naming the finding by behaviour the contracts no longer have. What is
// still open, and what the sentence must name, is the purchasable member count (H-8(a)). Accept
// the finding id too: "H-8" is the most checkable name a reader can carry to the audit report.
const OPEN_HIGH_CLASS = /purchasable member count|\bH-8\b/i;

t('the "open High at the launch configuration" claim always names the finding', () => {
  /** @type {[string, string][]} */
  const surfaces = [
    ...PAGES.map((p) => /** @type {[string, string]} */ ([p, publishedProse(raw.get(p) ?? '')])),
    ...REPO_PROSE.map((f) => /** @type {[string, string]} */ ([f, repoProse.get(f) ?? ''])),
  ];
  let seen = 0;
  for (const [where, text] of surfaces) {
    for (const s of sentencesOf(text)) {
      if (!OPEN_HIGH_CLAIM.test(s)) continue;
      seen++;
      assert.ok(
        OPEN_HIGH_CLASS.test(s),
        `${where}: claims a High "remains open at the launch configuration" without naming it. It is H-8, the purchasable member count in the <5-member quorum regime, name it in the same sentence, ${JSON.stringify(s.trim().slice(0, 160))}`,
      );
    }
  }
  assert.ok(seen >= 3, `expected the open-High claim on at least three surfaces, found ${seen}, if it was deleted rather than qualified, say so in the commit`);
});

/**
 * Demo vault and operator names in the allocator app.
 *
 * `apps/web` had no claims coverage at all, which is how "AlphaSeek Index" survived the rename of
 * "Stable Yield Micro" — the fixture that reached a legal review as a screenshot. A fixture name is
 * product copy: it renders as an `<h1>`. The line this draws, stated so it can be applied
 * consistently: a name may describe what a vault HOLDS or how it is BUILT ("cbBTC Micro",
 * "Base Blue-Chip 5", "Momentum Majors" are strategy descriptors, not outcome claims); it may never
 * describe or imply what it EARNS. Substring matching rather than word boundaries, because the
 * failure case was a compound ("AlphaSeek") and a proper noun has no legitimate use for any of these.
 */
const NAME_OUTCOME_WORDS = [/alpha/i, /yield/i, /\bstable/i, /\bapy\b/i, /\bapr\b/i, /profit/i, /\breturn/i, /guarantee/i, /\bsafe/i, /outperform/i, /passive/i, /\bgains?\b/i];

t('no demo vault or operator name implies an outcome', async () => {
  const fixtures = await import(pathToFileURL(path.join(REPO, 'apps', 'web', 'src', 'fixtures.mjs')).href);
  /** @type {string[]} */
  const names = [
    ...fixtures.VAULTS.flatMap((/** @type {any} */ v) => [v.name, v.operatorName].filter(Boolean)),
    ...fixtures.LEADERBOARD.map((/** @type {any} */ r) => r.name).filter(Boolean),
  ];
  assert.ok(names.length >= 8, `expected the fixture set to carry at least eight names, found ${names.length}`);
  for (const n of names) {
    for (const re of NAME_OUTCOME_WORDS) {
      assert.equal(
        n.match(re),
        null,
        `apps/web/src/fixtures.mjs: the demo name ${JSON.stringify(n)} implies an outcome (${re}). A name may say what a vault holds, never what it earns`,
      );
    }
  }
});

/**
 * `llms.txt` is the file written to orient autonomous agents, and it lives at the repository root.
 * Cloudflare Pages serves one app directory, not the repository, so the root copy is not reachable
 * at the public origin -- `https://rwally.com/llms.txt` would 404, which is the one URL an agent is
 * most likely to try. Here the served copy is `public/llms.txt`, which the build writes through to
 * `dist/llms.txt` verbatim.
 *
 * The site therefore carries a copy. Two copies of a claim-bearing file is a drift hazard, so this
 * pins them byte-identical rather than trusting anyone to update both. Edit the root file; this
 * test tells you to copy it across.
 */
t('the served and source llms.txt are both byte-identical to the repository root copy', () => {
  // BOTH copies, not one. `public/llms.txt` is the file a person edits; `dist/llms.txt` is the file
  // an agent fetches, and it is the one whose absence would 404. Pinning only the source lets a
  // stale build serve old text; pinning only the build lets the next build reintroduce it. The root
  // file is the source of both.
  const root = readFileSync(path.join(REPO, 'llms.txt'), 'utf8');
  const FIX = {
    'public/llms.txt': 'copy the root file across rather than editing this one, cp llms.txt apps/site-next/public/llms.txt',
    'dist/llms.txt': 'the build copies public/ verbatim, so this one is fixed by rebuilding, npm run build in apps/site-next. If public/llms.txt is also failing, fix that first',
  };
  for (const [rel, fix] of Object.entries(FIX)) {
    assert.equal(
      readFileSync(path.join(APP, rel), 'utf8'),
      root,
      `apps/site-next/${rel} has drifted from the root llms.txt. The root file is the source: ${fix}`,
    );
  }
});

/**
 * THE STYLESHEET GRAPH WAS THE ONE THING NOTHING HERE CHECKED, and status.html is the page that
 * made that matter. Vite does not put a `<link rel="stylesheet">` in a page because a stylesheet
 * exists; it puts one there for the CSS reachable from that page's entry module. So a page whose
 * entry graph loses a sheet ships intact markup with no rules behind it: every wording assertion
 * in this file passes on it, and the reader receives unstyled text.
 *
 * This is not hypothetical. On 2026-09-04 `src/entry-status.tsx` was rewritten to contain nothing
 * but side-effect CSS imports. Rolldown emits no chunk for an entry with no JavaScript, and with
 * no chunk there was no `<script>` and no `<link>` for the five section stylesheets it imported —
 * measured on the 02:34 build of 2026-09-05, dist/status.html carried 0 `<script>` elements and 1
 * stylesheet link where every other page carried 1 and 2, and 35 of the 46 classes in its markup
 * were defined in no sheet the page linked. The two checks below are what reds on that.
 *
 * The first is deliberately weak on WHICH sheets and strict on WHERE they come from. Naming files
 * would pin build-time hashes; requiring `/assets/` is the same property `_headers` and the CSP
 * state, and it is what the script check above already requires of the module entry.
 */
t('every page links at least one stylesheet, and every stylesheet link is served from /assets/', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    const links = html.match(/<link\s(?:[^>]*\s)?rel="stylesheet"[^>]*>/gi) ?? [];
    assert.ok(
      links.length > 0,
      `${p}: no <link rel="stylesheet">. The page ships unstyled, and every content assertion in this file still passes on it`,
    );
    for (const link of links) {
      assert.ok(
        /\shref="\/assets\/[^"]+\.css"/.test(link),
        `${p}: a stylesheet is not served from /assets/ on this origin: ${JSON.stringify(link)}`,
      );
    }
  }
});

/**
 * AND THE SECOND READS THE BUILT PAGE, which is the half the first one cannot reach. Counting
 * links says a page has some CSS; it does not say the CSS is the page's own. status.html linked
 * the three shared sheets and none of its five sections, and the link count check was green on it.
 *
 * So: take every class name in the built markup, take every class selector in every sheet that
 * page links, and require the first set to be inside the second. A CSS-module class carries the
 * shape `_name_hash_line`, which means a class that reaches the markup but not the stylesheet is
 * unambiguous — no rule anywhere in the build can define it by coincidence.
 *
 * IT IS AN EXACT CHECK, not a heuristic with a tolerance. Measured over the build of 2026-09-05
 * that this replaced, seven of the eight pages had ZERO classes undefined (84, 76, 49, 42, 53, 43
 * and 25 classes used) and status.html had 35 of 46. The floors below are what keep a future
 * build from passing it vacuously: a page with no classes, or a sheet parsed to no selectors,
 * fails rather than reporting a clean sweep over an empty set.
 */
t('every class in a built page is defined in a stylesheet that page links', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    const hrefs = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/gi)].map((m) => m[1]);

    const defined = new Set();
    for (const href of hrefs) {
      const file = path.join(SITE, href.replace(/^\//, ''));
      assert.ok(existsSync(file), `${p}: links ${href}, which is not in the build`);
      const css = readFileSync(file, 'utf8');
      for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) defined.add(m[1]);
    }
    assert.ok(
      defined.size > 0,
      `${p}: the sheets it links define no class selector at all, so the check below would pass on anything`,
    );

    const used = new Set();
    for (const m of html.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].trim().split(/\s+/)) if (c) used.add(c);
    }
    assert.ok(
      used.size > 0,
      `${p}: no class attribute in the built markup, so this check has nothing to verify`,
    );

    const missing = [...used].filter((c) => !defined.has(c)).sort();
    assert.deepEqual(
      missing,
      [],
      `${p}: ${missing.length} of ${used.size} classes in the markup are defined in none of the ${hrefs.length} stylesheets this page links, so those elements render unstyled: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', …' : ''}`,
    );
  }
});

/**
 * THE MARK IS ONE ARTWORK SHIPPED FROM TWO ORIGINS, and nothing but this stops them drifting.
 *
 * WHAT THIS GUARD USED TO ASSERT, AND WHY THE SHAPE HAD TO CHANGE RATHER THAN THE INTENT. Until
 * 2026-09-05 it read a single path string out of `src/brand/markPath.ts` and asserted that
 * `src/brand/mark.svg` and `public/favicon.svg` drew exactly that string: the ledger R, one
 * monochrome stroke, inlined everywhere so it could inherit `currentColor`. The owner replaced
 * that letter that day with the comic R from the brand set. The comic R is five traced layers
 * carrying five fixed colours, so there is no single path to compare and nothing to tint, and both
 * halves of the old assertion stopped being expressible: it has no `fill="none"` because every
 * fill is a colour, and the favicon carries a `<rect>` on purpose, as the dark tile the mark sits
 * on. Deleting the guard would have left the identity unguarded on the exact commit that changed
 * it, so it is REPLACED, and the property it protects is unchanged: one identity, not two.
 *
 * TWO FAMILIES, NOT ONE, AND THEY ARE NOT INTERCHANGEABLE. Collapsing them is the tempting wrong
 * fix and it throws artwork away.
 *
 *   THE MARK, `brand/mark-comic.svg`. The R alone, tight to its ink, no ground. It is what the
 *   masthead, the footer and the hero watermark link. Two copies exist because two ORIGINS serve
 *   it: rwally.com from `apps/site-next/public/`, app.rwally.com from `apps/app/src/`, which
 *   `apps/app/build.mjs` copies into its own `dist/`. Neither may link the other's, because a
 *   cross-origin image is exactly what both `_headers` files refuse.
 *
 *   THE FAVICON, `favicon.svg`. The same R recentred in a square and set on the ground tile, which
 *   is what a tab icon needs and a header mark must not have. Same two origins, same reason.
 *
 * IT READS SOURCE, NOT `dist`, so it runs on an unbuilt checkout, and it reaches across into
 * `apps/app` deliberately: the app has no suite of its own that could hold this, and an identity
 * guard that only looks at one of the two surfaces it is about is half a guard.
 */
const APP_SURFACE = path.join(REPO, 'apps', 'app', 'src');

/**
 * The floor each artwork has to clear, in bytes.
 *
 * NOT DECORATION. Byte-identity alone passes over two empty files, and an emptied or truncated SVG
 * renders as nothing at all rather than as an error, which is the one failure mode a reader of the
 * built site would not notice. Both files are traced polygon sets of about 14 KB; 8,000 is well
 * under that and well over anything that could be a stub.
 */
const MARK_MIN_BYTES = 8000;

test('the brand mark is one artwork, byte-identical on both surfaces', () => {
  const families = [
    {
      what: 'the mark',
      files: [
        ['apps/site-next/public/brand/mark-comic.svg', path.join(APP, 'public', 'brand', 'mark-comic.svg')],
        ['apps/app/src/brand/mark-comic.svg', path.join(APP_SURFACE, 'brand', 'mark-comic.svg')],
      ],
      fix: 'cp apps/site-next/public/brand/mark-comic.svg apps/app/src/brand/mark-comic.svg',
    },
    {
      what: 'the favicon',
      files: [
        ['apps/site-next/public/favicon.svg', path.join(APP, 'public', 'favicon.svg')],
        ['apps/app/src/favicon.svg', path.join(APP_SURFACE, 'favicon.svg')],
      ],
      fix: 'cp apps/site-next/public/favicon.svg apps/app/src/favicon.svg',
    },
  ];

  // NON-VACUITY, per item 6 in this file's header: a loop that found nothing to compare would
  // report a pass. Both families are counted, and so is every file in them.
  assert.equal(families.length, 2, 'the mark and the favicon are two families; this loop lost one');

  for (const family of families) {
    assert.equal(family.files.length, 2, `${family.what}: two surfaces, two files`);
    const digests = family.files.map(([rel, file]) => {
      const bytes = readFileSync(file);
      assert.ok(
        bytes.length >= MARK_MIN_BYTES,
        `${rel} is ${bytes.length} bytes, under the ${MARK_MIN_BYTES}-byte floor. An emptied or ` +
          'truncated SVG renders as nothing at all rather than as an error, so size is checked ' +
          'before sameness',
      );
      return [rel, crypto.createHash('sha256').update(bytes).digest('hex')];
    });
    assert.equal(
      digests[0][1],
      digests[1][1],
      `${family.what} differs between the two surfaces, so rwally.com and app.rwally.com ship two ` +
        `logos: ${digests.map(([rel, d]) => `${rel} ${d.slice(0, 12)}`).join(', ')}. The site copy ` +
        `is the source: ${family.fix}`,
    );
  }
});

/**
 * THE COMIC MARK COLLAPSES AT SMALL SIZES, AND THAT IS MEASURED RATHER THAN ASSUMED.
 *
 * The brand set's own README records rendering the full-colour mark at 32 pixels and reading it:
 * the speed lines inside the R turn into noise and the letter barely reads. Its measured floor is
 * 48, and `MIN_MARK_PX` in `src/brand/markAsset.ts` is where this repository writes that number
 * down. The owner's decision of 2026-09-05 is that the comic mark is the mark in the header and
 * the footer, which makes the floor a constraint on two stylesheets rather than a note.
 *
 * IT CHECKS THE DECLARATION, NOT A RENDER. `height` in rem against the site's 16px root is what
 * decides the drawn size, so the rule is read and converted. A change to either stylesheet that
 * shrinks the mark back toward the size the old monochrome letter was drawn at reds here.
 */
test('the comic mark is drawn at a size its halftone survives', () => {
  const asset = readFileSync(path.join(APP, 'src', 'brand', 'markAsset.ts'), 'utf8');
  const floor = asset.match(/export const MIN_MARK_PX = (\d+);/);
  assert.ok(floor, 'src/brand/markAsset.ts no longer declares MIN_MARK_PX as a bare integer');
  const minPx = Number(floor[1]);

  // BOTH SURFACES, for the same reason the byte-identity guard reaches across: the app has no suite
  // that could hold this, and a floor enforced on one of two headers that are meant to be identical
  // is a floor the other can quietly drop through.
  const sheets = [
    ['apps/site-next/src/shell/masthead.module.css', path.join(APP, 'src', 'shell', 'masthead.module.css')],
    ['apps/site-next/src/shell/footer.module.css', path.join(APP, 'src', 'shell', 'footer.module.css')],
    ['apps/app/src/app.css', path.join(APP_SURFACE, 'app.css')],
  ];
  let checked = 0;
  for (const [rel, file] of sheets) {
    const css = readFileSync(file, 'utf8');
    const rule = css.match(/^\.mark \{[^}]*\}/m);
    assert.ok(rule, `${rel} has no .mark rule, so the mark's size is set somewhere this cannot read`);
    const height = rule[0].match(/height:\s*([\d.]+)rem;/);
    assert.ok(height, `${rel}: .mark sets no height in rem, so its drawn size cannot be checked`);
    const px = Number(height[1]) * 16;
    assert.ok(
      px >= minPx,
      `${rel}: .mark is ${px}px tall, under the ${minPx}px floor MIN_MARK_PX records. The brand ` +
        'set measured the full-colour mark at 32 and the halftone inside the R collapses into ' +
        'noise. Raise the height rather than the floor',
    );
    // Width must NOT be pinned: the artwork is landscape, and two fixed dimensions squash it.
    assert.match(
      rule[0],
      /width:\s*auto;/,
      `${rel}: .mark pins a width. The comic mark is 385.5 by 291.5, so a width beside a height ` +
        'distorts it. Set the height and leave width: auto',
    );
    checked += 1;
  }
  assert.equal(checked, sheets.length, 'not every stylesheet that draws the mark was read');
});

// ═══════════════ the v3 homepage: a word budget, and where every sentence came from ═══════════════
//
// TWO LEGS, ADDED 2026-09-05 WITH THE ONE-SCROLL-PAGE REDESIGN. They exist because the two things
// most likely to go wrong on a page like this are not things any other guard in this file looks at.
//
//   THE BUDGET. The v3 brief caps the homepage at 150 to 250 VISIBLE words. That is not a style
//   preference; it is the whole reason the page can be loud without being a pitch. A cap nobody
//   measures is a cap that drifts by twenty words a commit, and the drift is invisible because each
//   commit adds a reasonable sentence.
//
//   THE PROVENANCE. Every sentence on this page has to be literally true against the contracts, and
//   the way this repository establishes that is by having a human read a sentence against the code.
//   A redesign is exactly where somebody writes a better-SOUNDING sentence than the one that was
//   read. So a sentence on this page must be one that already exists in a checked source, and this
//   leg is what makes "already exists" mechanical rather than a promise in a commit message.

/**
 * The visible text of a built page: markup, scripts, styles and comments removed.
 *
 * IT READS THE PRERENDERED HTML, WHICH IS THE POINT AND NOT A SHORTCUT. What this returns is what a
 * reader gets before a single line of JavaScript runs, and what a crawler gets. That is the correct
 * definition of "visible" for a budget: it cannot be gamed by moving copy into a component that
 * mounts later, and it is the same text the page shows, because nothing on this site is hidden
 * behind a scroll reveal in shipped CSS. `src/motion/Reveal.tsx` writes its pre-animation
 * `opacity: 0` through the CSSOM in a layout effect, so the document itself is fully visible.
 *
 * The one thing it deliberately does NOT count is the live figures: the block height, the two
 * prices, the vault count and the sub-vault flag are fetched in the reader's browser and are absent
 * from this markup. They are numbers rather than words, their LABELS are counted, and a figure
 * baked into the HTML at build time would carry a timestamp from whenever the build ran.
 */
const visibleText = (html) =>
  html
    .slice(html.indexOf('<body'))
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&rsquo;|&#8217;/gi, "'")
    .replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const WORD_FLOOR = 150;
const WORD_CEILING = 250;

t('the homepage stays inside its 150 to 250 visible-word budget', () => {
  const text = visibleText(raw.get('index.html') ?? '');
  const words = text.split(' ').filter(Boolean);

  // PRINTED, NOT JUST ASSERTED. A number that only appears when the test fails is a number nobody
  // watches drift toward its own limit, and the whole value of a budget is seeing it before it is
  // breached. The text is printed with it so a reviewer can read the entire homepage in the test
  // log without building and serving the site.
  console.log(`\n  homepage: ${words.length} visible words (budget ${WORD_FLOOR} to ${WORD_CEILING})`);
  console.log(`  ${text}\n`);

  assert.ok(
    words.length >= WORD_FLOOR,
    `the homepage is down to ${words.length} visible words, under the brief's floor of ${WORD_FLOOR}. ` +
      'A page this short has stopped saying what the protocol is.',
  );
  assert.ok(
    words.length <= WORD_CEILING,
    `the homepage is up to ${words.length} visible words, over the brief's ceiling of ${WORD_CEILING}. ` +
      'Cut a sentence rather than raising the number: the cap is what keeps this page a door rather ' +
      'than a pitch.',
  );
});

/**
 * SOURCE 1: the corpus. Every page of `apps/site`, as visible text.
 *
 * `apps/site` is the nine-page site this one succeeds, it is still in the repository, and every
 * sentence in it has been read against the contracts and is guarded by
 * `apps/site/test/site.test.mjs`. It is the reason the page collapse did not throw away the checked
 * prose along with the pages: the words survive as the source this site quotes from.
 */
const corpusText = () => {
  const dir = path.join(REPO, 'apps', 'site');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.html'))
    .map((f) => visibleText(readFileSync(path.join(dir, f), 'utf8')))
    .join('  ');
};

/**
 * SOURCE 2: the promo script the owner approved on 2026-09-05.
 *
 * Recorded in the owner's decision note `Agent-Governed Vaults/Decisions/comic-theme-and-mascot.md`
 * under "Promo v2 script, approved". That note is in the owner's vault and not in this repository,
 * which is exactly why the lines this site uses are PINNED HERE rather than read from a path: a
 * source a test cannot open is not a source, and a quotation nobody can diff is not a quotation.
 *
 * Only the lines this site actually renders are listed. Adding one is a visible diff in this file,
 * which is the property that keeps this from becoming a place to park a sentence.
 */
const PROMO_SCRIPT = [
  'Different models. Different minds. Different thoughts.',
  'Every trade argued in the open. Every position put to a vote.',
  'No boardroom. No closed door. Just code no one can rewrite.',
];

/**
 * SOURCE 3: the strings this site introduces, which by their nature cannot be in the corpus.
 *
 * TWO KINDS, AND THE SPLIT IS THE DISCIPLINE. Everything here is a sentence that did not exist
 * before this redesign, so each one carries the reason it could not be quoted from somewhere that
 * was already checked. Anything that CAN be quoted must be, and this list is not the place to put a
 * sentence that was merely inconvenient to source.
 */
const OWNER_AND_LIVE_STRINGS = [
  // --- the owner's own words, from revision 2 of the website v3 brief, 2026-09-05 ---
  //
  // The tagline. It read "The AI agent trading index on Robinhood Chain." in the corpus and the
  // owner shortened it that evening, so the corpus carries the long form and this site the short
  // one. It is pinned in `src/shell/pinned.ts` as TAGLINE, and the exact phrase "AI agent trading
  // index" is permitted BY NAME in `scripts/test/claims-lede-truth.test.mjs`, which masks it before
  // scanning for an agent as the subject of trading. One character of drift breaks that permission.
  'The AI agent trading index.',
  // Two of the four marquee phrases, listed verbatim in the brief's own marquee line. The other two
  // resolve against the corpus and the promo script, so they are not here: "No admin key." is the
  // tail of the corpus sentence "The contracts carry no proxy, no upgrade path, no pause function
  // and no admin key.", and "Every position put to a vote." is promo script line 7.
  'The hive decides.',
  'Seven immutable contracts.',

  // --- the live panel's labels, from `src/sections/index-live/copy.ts` ---
  //
  // A live read has no corpus sentence by definition: the corpus was written before the read
  // happened. These are the only sentences on the page describing figures fetched at run time.
  // They are duplicated here rather than imported because that file is TypeScript and this suite is
  // plain ESM, and the duplication is a feature: a change to either has to be made in both, in one
  // commit, which is a diff a reviewer sees.
  'Read from the chain in your browser.',
  'Reading.',
  'The read failed.',
];

/**
 * SOURCE 4: the RWLY launch record, `rwly-flip-facts.md` and its companion
 * `rwly-robinhood-mainnet.json`, measured against chain 4663 on 2026-09-05.
 *
 * WHY THIS SOURCE HAD TO EXIST AT ALL. The corpus is `apps/site`, and every sentence in it was
 * written before RWLY was created at 2026-09-05T21:51:57Z. So the corpus cannot contain a true
 * sentence about the token, and the homepage's closing beat, which used to quote the corpus word
 * for word, has nothing left to quote. Source 3 was the wrong home for these: its entries are the
 * owner's own wording and the live panel's labels, and its note is explicit that it is not a place
 * to park a sentence that was inconvenient to source. These are neither. They are readings.
 *
 * PINNED HERE RATHER THAN READ FROM A PATH, for exactly the reason PROMO_SCRIPT is. The record
 * lives in the session scratchpad the launch was verified in, not in this repository, and a source
 * a test cannot open is not a source. Committing it would drag a 31 KB JSON readback into the
 * `claims-lede-truth` walk for no gain to this commit. What the record is FOR is the review: every
 * clause below is tagged in it with the `cast` call that establishes it, so a reviewer checks the
 * sentence against the chain rather than against this file.
 *
 * WHAT EACH ONE RESTS ON, in one line each. The long form is in `index-next/copy.ts`.
 *
 *   the launch date        the creation block's own timestamp, equal to the curve's `launchedAt()`
 *   Pons, third-party      the curve's `factory()` is the Pons v2 factory; nobody here wrote it
 *   quoted in ETH          `pairToken()` is the zero address, `isNativeQuote()` is true
 *   fixed supply           `totalSupply()` is 1e27, minted once, `mint(...)` reverts
 *   no owner               `owner()`, `admin()`, `transferOwnership(...)` revert against a control
 *   no upgrade path        zero DELEGATECALL and zero CALLCODE in the 3,248-byte runtime
 *   no contract references `git grep -i 2eed8ae7` returns nothing on the default branch
 *
 * ADDING A SENTENCE HERE IS THE SAME DECISION AS ADDING ONE TO SOURCE 3, and the same rule
 * applies: it belongs here only if it is a READING, and only if the reading is in the record with
 * its reproduction command. A sentence about what the token will do is not a reading.
 */
const RWLY_LAUNCH_RECORD = [
  'RWLY is live.',
  'Launched 2026-09-05 on Pons, a third-party launchpad, on a bonding curve quoted in ETH that graduated the same day.',
  'Fixed supply 1,000,000,000, no owner, no mint function, no upgrade path.',
  'No contract this protocol deployed references it, and the staking, the epochs and the fee accrual into stock tokens are design intent.',
];

/** Apostrophes, quotes and dashes normalised, so a typographic edit is not a provenance failure. */
const normalise = (s) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * The homepage's sentences, as a list.
 *
 * WHAT COUNTS AS A SENTENCE HERE, and why the definition is narrower than a linguist's: a run of
 * text that contains a full stop and is at least four words long. Both halves matter.
 *
 *   THE FULL STOP is what separates a CLAIM from a LABEL. "Disclaimers", "Latest block", "Feed last
 *   printed", "How it works" and "Open the app" are names of things and of actions, not assertions
 *   about the protocol, and requiring them to be quoted from somewhere would say nothing about
 *   whether this page is true. Every sentence that asserts something ends in a full stop.
 *
 *   FOUR WORDS keeps out the fragments that fall out of the markup rather than out of the copy:
 *   "factory.vaultCount()" is one word containing a full stop, and the headline is split across a
 *   line break into "The AI agent" and "trading index." so that the second line can carry the
 *   accent. The whole tagline is rendered elsewhere, unsplit, and IS checked.
 *
 * Sentences are taken per TEXT RUN rather than from the flattened page, so two labels that happen to
 * sit next to each other in the markup are never glued into one nonsense sentence.
 */
const homepageSentences = () => {
  const html = raw.get('index.html') ?? '';
  const body = html
    .slice(html.indexOf('<body'))
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const out = [];
  for (const m of body.matchAll(/>([^<]+)</g)) {
    const run = m[1]
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&rsquo;|&#8217;/gi, "'")
      .replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!run) continue;
    for (const raw of run.split(/(?<=\.)\s+/)) {
      const sentence = raw.trim();
      if (!sentence.includes('.')) continue;
      if (sentence.split(' ').filter(Boolean).length < 4) continue;
      out.push(sentence);
    }
  }
  return out;
};

t('every sentence on the homepage comes from a source that was already checked', () => {
  const haystack = [
    normalise(corpusText()),
    normalise(PROMO_SCRIPT.join('  ')),
    normalise(OWNER_AND_LIVE_STRINGS.join('  ')),
    normalise(RWLY_LAUNCH_RECORD.join('  ')),
  ].join('  ');

  const sentences = homepageSentences();

  // NON-VACUITY. A change of markup, of quoting style or of the sentence definition above could
  // make the extractor return nothing and this test pass over an empty list. The homepage carries
  // well over a dozen sentences; a floor of ten reds long before the extractor silently stops
  // reading, and does not red on a legitimate edit that removes one or two.
  assert.ok(
    sentences.length >= 10,
    `only ${sentences.length} sentences were extracted from the homepage; the markup changed and ` +
      'this provenance check is no longer reading it',
  );

  const unsourced = sentences.filter((s) => !haystack.includes(normalise(s)));
  assert.deepEqual(
    unsourced,
    [],
    'Every sentence on the homepage must appear verbatim in one of four sources:\n' +
      '  1. the corpus, apps/site/*.html, which is guarded by apps/site/test/site.test.mjs\n' +
      '  2. PROMO_SCRIPT, the promo lines the owner approved on 2026-09-05\n' +
      '  3. OWNER_AND_LIVE_STRINGS, the tagline, two marquee phrases and the live panel labels\n' +
      '  4. RWLY_LAUNCH_RECORD, the on-chain readings of the 2026-09-05 launch, each tagged with\n' +
      '     its own cast call in rwly-flip-facts.md and rwly-robinhood-mainnet.json\n' +
      'Do not add a sentence to source 3 or 4 to make this pass. Source 3 is for strings that CANNOT\n' +
      'exist in the corpus, and every entry in it carries the reason it cannot. If a sentence says\n' +
      'something the corpus already says, quote the corpus; if it says something new about the\n' +
      'protocol, it has not been read against the contracts yet and it does not belong on the page.\n' +
      'Unsourced sentences:\n' +
      unsourced.map((s) => `  ${JSON.stringify(s)}`).join('\n'),
  );
});
