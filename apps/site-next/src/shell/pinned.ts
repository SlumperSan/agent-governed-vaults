/**
 * PINNED STRINGS — the single source for every sentence that must not drift.
 *
 * OWNED BY SHELL. Section builders IMPORT from here. Nobody retypes a pinned
 * sentence into a component, because a retyped sentence is a sentence that
 * diverges on the next edit and the guard failure lands two pages away from
 * the change that caused it.
 *
 * ---------------------------------------------------------------------------
 * HOW TO RENDER THESE — read this before you use one
 * ---------------------------------------------------------------------------
 * `renderToString` HTML-escapes text children. Probed on this exact toolchain:
 *
 *     renderToString(<p>page's word — S&P 500</p>)
 *       -> <p>page&#x27;s word — S&amp;P 500</p>
 *
 * So a pinned sentence containing an apostrophe, an ampersand or a quote does
 * NOT appear literally in `dist/*.html` when rendered as a text child, and
 * `html.includes(PINNED)` — which is exactly how `site.test.mjs` checks — fails
 * on bytes that look identical in a browser. The em-dash is fine; `'`, `&`,
 * `<`, `>` and `"` are not.
 *
 * THE RULE, therefore:
 *
 *   1. Every constant below stores HTML SOURCE BYTES. If a sentence needs an
 *      entity, the entity is written here (`&amp;`), not the character.
 *   2. Render it with `<Pinned>` (src/shell/PinnedText.tsx), which writes the
 *      bytes straight onto the semantic element:
 *
 *          <Pinned as="p" className={s.legal} html={FOOTER_LEGAL} />
 *
 *      never as `<p>{FOOTER_LEGAL}</p>`.
 *   3. Never wrap a pinned sentence in an extra element and never interpolate
 *      into the middle of one. Guards match on the sentence, and an inserted
 *      `<span>` splits it.
 *
 * ---------------------------------------------------------------------------
 * WHERE THESE CAME FROM
 * ---------------------------------------------------------------------------
 * Every string is lifted byte-for-byte out of `apps/site/*.html`, which is the
 * reviewed source of truth for the site's copy. None of it was rewritten,
 * re-punctuated or tightened. Where a passage travels across pages, the note
 * above the constant says which pages carry it and what the guard asserts
 * about the placement, because placement is checked as well as presence.
 */

/**
 * Every page's <title> ends in this. Em-dash and spacing are pinned.
 *
 * CHANGED 2026-09-05: was ' — Agent-Governed Vaults'. The owner's decision that
 * day renamed the site to Rwally; "Agent-Governed Vaults" survives only as the
 * descriptor line in the footer (see BRAND below), not as the title suffix.
 */
export const TITLE_SUFFIX = ' | Rwally';

/* ---------------------------------------------------------------------------
 * PRE-LAUNCH BANNER — one block, on status.html, inside <main>.
 *
 * It stood above the <nav> on all seven pages until the owner's decision of
 * 2026-09-04 moved the status block off the top of every page and onto a page
 * of its own, linked from every footer. NOTHING WAS DROPPED WITH IT: both
 * sentences also open FOOTER_LEGAL below, so every page still states each of
 * them, and removing the band leaves each page stating each exactly once.
 * status.html carries two of each — the band and its own footer — and faq.html
 * two of the deployment-status sentence, because one of its answers quotes it.
 * Those counts are asserted per page in site.test.mjs.
 * ------------------------------------------------------------------------ */

export const BANNER_OFFER = 'Nothing on this site is an offer, a solicitation, or financial advice.';


/**
 * THREE CONSTANTS WERE DELETED HERE ON 2026-09-05, and the deletion is the
 * record. `BANNER_STATUS` was the absolute "Not deployed to mainnet. The only
 * deployment is a testnet trial with no real value at stake."; `BANNER_PARAGRAPH`
 * joined it to the not-an-offer line for the pre-launch band; `FOOTER_LEGAL`
 * opened with it in the footer of every page. The protocol is deployed on
 * Robinhood Chain mainnet, so all three said something false, and the corpus
 * retired them in the same change that consolidated the disclosures onto one
 * page. `DEPLOYED_LINE` below is what replaced the claim; the footer's link to
 * the Disclaimers page is what replaced the repetition. `src/shell/
 * PreLaunchBanner.tsx`, the component that rendered the band, is deleted with
 * them — nothing imported it after the sync.
 */

export const BANNER_TAG = 'Pre-launch';

/**
 * THE CORPUS'S REPLACEMENT FOR THE RETIRED BANNER_STATUS ABSOLUTE. Not yet
 * wired into Footer (see the note on BANNER_STATUS above); page-local content
 * that is NOT rendered by the shared, frozen Footer component may import this
 * directly — status.html's pre-launch band and disclaimers.html's deployment
 * paragraph are the two places the corpus pins it, exactly once each.
 */
export const DEPLOYED_LINE = 'Deployed on Robinhood Chain mainnet, chain id 4663.';

/* ---------------------------------------------------------------------------
 * FOOTER — the two standing-fact sentences are COUNTED, not merely required.
 * Exactly one of each per page, except faq.html which carries two of each: the
 * footer copy plus the copy inside the answer that quotes it. A third copy
 * anywhere on a page — including inside a <title> or an og:description — reds
 * the "open source / airdrop / presale appear only inside the footer
 * sentences" check, because the scrubber strips only the permitted count.
 *
 * Consequence for whoever writes the hero: these sentences may not be reused
 * as a fact-strip line, a badge or a meta description. Ever.
 *
 * THE ONE PLACE A SECOND COPY IS NOT ONLY ALLOWED BUT REQUIRED is faq.html,
 * and it is the FAQ section's obligation rather than the footer's. `Footer`
 * renders one of each on every page; `faq-questions` owes the other two —
 * FOOTER_TOKEN inside the answer to "Is there a token?", and FOOTER_LICENCE
 * inside the answer to "Can I fork it? What licence is the code under?". Both
 * counts are asserted exactly, so a shell-only faq.html reads 1/1 and is
 * incomplete rather than correct. Import them from here; do not retype them.
 * ------------------------------------------------------------------------ */

/**
 * THE FOOTER'S THIRD COLUMN AND ITS CLOSING LINE, both new on 2026-09-05 and
 * both copied from `apps/site/index.html` at protocol/main 2faed164.
 *
 * WHAT THEY REPLACED, because it is the largest single change this file has
 * carried. Until that commit the footer of every page repeated four pinned
 * sentences — the no-token line, the licence line, the not-an-offer line and
 * the deployment-status line — and the guards counted them per page. The
 * site-copy change consolidated every warning, limit and legal sentence onto
 * one page, and the footer now POINTS at that page instead of restating it.
 * Measured against the corpus at 2faed164: `No token. No points. No airdrop.
 * No presale.` occurs on disclaimers.html and on no other page, `Nothing on
 * this site is an offer` occurs twice on disclaimers.html and nowhere else, and
 * `Not deployed to mainnet` occurs on no page at all.
 *
 * That is a deliberate editorial change made in a reviewed pull request, not a
 * drift, and this build follows it rather than keeping a footer the served site
 * no longer has.
 */
export const FOOTER_DISCLAIMERS_HEADING = 'Disclaimers';

export const FOOTER_DISCLAIMERS_BODY =
  'The risks, the legal position, and what has not been checked are on one page.';

export const FOOTER_TOKEN = 'No token. No points. No airdrop. No presale.';

/** The em-dash is pinned. Do not normalise it to a hyphen. */
export const FOOTER_LICENCE = 'Source-available under BUSL-1.1, not open source.';

/** The two-sentence repository note. Carried in the footer of every page. */
export const FOOTER_REPO_AUTHORITY =
  'The repository is the authority for the code. Where this site and the contracts disagree, the contracts are right and this site is wrong.';

/**
 * CHANGED 2026-09-05: was 'It is public, including the launch-readiness board
 * and every review round.' The corpus dropped "the launch-readiness board"
 * from this sentence on every page; carried across verbatim here.
 */
export const FOOTER_REPO_PUBLIC =
  'It is public, including every review round. Read the contracts rather than this description of them.';

/* ---------------------------------------------------------------------------
 * PASSAGES THAT TRAVEL BETWEEN PAGES
 *
 * If two pages carried a passage byte-identically before an edit, they must
 * carry it byte-identically after. Each of these is rendered from this one
 * constant on every surface that needs it — never re-typed, never adapted for
 * a tighter layout.
 * ------------------------------------------------------------------------ */

/**
 * The security-review attestation.
 *
 * CHANGED 2026-09-05: was carried byte-identically on index.html, risks.html
 * AND faq.html. Owner decision that day consolidated every negative claim onto
 * one page — this paragraph now lives on disclaimers.html ONLY (still
 * byte-identical there to this constant); index.html and faq.html no longer
 * carry it at all and link to the Disclaimers instead. Two placement rules the
 * guard enforces on wherever it does appear, both easy to break by splitting
 * the paragraph for rhythm:
 *   - `external security review` and `no public report` must sit in the SAME
 *     block element;
 *   - `remains open at the launch configuration` must sit in the same SENTENCE
 *     as `purchasable member count`.
 * Render it as one <p>. Do not break it into two.
 */
export const SECURITY_REVIEW_ATTESTATION =
  'An external security review was commissioned against the launch tree. The owner attests it returned no major issues. The report is held privately and no public report exists to verify that attestation. Alongside it, four internal adversarial review rounds and an AI pre-audit were run; the AI pre-audit found 41 issues including 5 Critical. All five Criticals are resolved or closed by launch configuration. One High, the purchasable member count below five members, remains open at the launch configuration, and a set of Medium and Low findings are accepted residuals that will not be fixed. A further class is dormant only because sub-vaults are disabled at launch: those are not repaired in code and would return if sub-vaults were ever enabled.';

/**
 * The launch-status paragraph naming the open High.
 *
 * RETIRED AS A STANDALONE PARAGRAPH, 2026-09-05. This exact sentence no longer
 * appears verbatim anywhere in the corpus: the open-High claim now lives
 * folded into the relevant risk-register entries on disclaimers.html (e.g. the
 * concentration-risk entry's "What is done" cell), not as its own paragraph on
 * index.html. Left defined, unused by any page, in case a future surface needs
 * the exact wording again — do not import it into new copy without checking
 * the corpus first.
 */
export const LAUNCH_STATUS =
  'Every security gate the team defined is cleared. That still certifies that the gates ran, not that the protocol is secure. One High, the purchasable member count below five members, remains open at the launch configuration and is not classified as a launch blocker.';

/**
 * The Mode-F trigger clause. It appears inside longer sentences on
 * how-it-works, disclaimers r6, faq, who-its-for and agents, and the surrounding
 * sentence differs by surface — but this clause never does, and five
 * misstatements of it are asserted absent everywhere: `passed-but-pending`,
 * `passed-but-unexecuted`, `between a vote passing`, `vote passing and
 * execut…`, and `rebalance has passed but has not yet executed`.
 *
 * The point the clause exists to make: the queue opens when the REVEAL PHASE
 * opens, not when a proposal passes. A proposal that is ultimately defeated
 * still queued your exit while it was live.
 */
export const MODE_F_TRIGGER =
  'From the moment the reveal phase opens on any live proposal (not from the moment one passes)';

/**
 * The enumerated operator sentence, in the form index.html and faq.html carry
 * it (byte-identical on both as of the 2026-09-05 corpus).
 *
 * READ THIS BEFORE SHORTENING IT. A blanket negative about the operator is
 * false and falsifiable in one transaction: `FeeEngine.onFeeCollected` credits
 * `claimableFees[operatorAddressOf(opId)]`, so the operator holds a real
 * unilateral on-chain right no other member has. Only the ENUMERATION passes —
 * `no authority` followed immediately by the list of verbs. A cinematic
 * headline that compresses this to "the operator has no privileged power" is
 * the single most likely claims violation in this redesign. This is also the
 * exact wording CLAUDE.md's Claims accuracy section quotes as the approved
 * replacement for a blanket negative — do not widen it back into one.
 *
 * CHANGED 2026-09-05: was the longer clause "...confers no authority to
 * execute a rebalance the members did not pass, to pause, reprice, upgrade,
 * skip the timelock, or move, freeze or seize another member's funds...". The
 * corpus shortened it on index.html/faq.html to the form below. THE LONGER
 * FORM SURVIVES SEPARATELY on operators.html, but as a different sentence
 * shape — a "Cannot" list of short imperative sentences ("Execute a rebalance
 * the members did not pass. Pause the vault. Upgrade the contracts. Reprice
 * shares. Move, freeze or seize another member's funds. Skip the timelock.
 * Receive the exit fee as a payment. …"), not this clause — so operators.html
 * must NOT import this constant for that list; it has its own copy.
 */
export const OPERATOR_ENUMERATED =
  'There is no seize function and no privileged withdrawal. Operatorship confers no authority to vote, execute, pause, reprice, or move member funds. Its one power beyond proposing and voting like any member of equal stake is economic: the operator identity receives the 10% performance fee, which no other member does.';

/**
 * The exit-fee correction, carried on index, how-it-works, operators and faq.
 * The second half is not optional politeness: the operator IS a member, so a
 * bare "the operator gets no share of the exit fee" is a banned shape.
 */
export const EXIT_FEE_CORRECTION =
  'The exit fee is never routed to the operator identity. But the operator is also a member, and the fee stays in the vault where it raises the value of every share. So an operator holding the 5% the creator gate requires collects at least 5% of every exit fee, exactly as any other holder of that stake would.';

/**
 * The high-water-mark reset sentence, carried on how-it-works, operators and
 * faq. The closing clause is the whole point: the mark is not enforced by the
 * contracts against a fresh identity.
 */
export const HIGH_WATER_MARK_RESET =
  'Nothing stops an operator abandoning a loss-carrying identity and registering a fresh one, which resets the mark. The only cost is a visibly empty track record on the leaderboard. The enforcement here is reputation, not code.';

/* ---------------------------------------------------------------------------
 * NAVIGATION
 *
 * The .html suffix stays. `site.test.mjs` asserts that every page literally
 * contains `href="<other>.html"` for every page, and Cloudflare Pages already
 * 301s a bare page path (e.g. the retired /risks.html) onto the extensionless
 * form, so the suffix costs a redirect nobody sees and dropping it reds eight
 * checks.
 *
 * TWO LISTS, NOT ONE. `NAV` is the header nav and carries six pages;
 * `FOOTER_PAGES` is the footer's Pages column and carries eight. status.html
 * and disclaimers.html are the difference, and both are deliberate — the owner
 * asked for a footer link rather than a header entry in each case, and
 * site.test.mjs asserts both halves: that every page's footer links to them,
 * and that no <nav> does.
 * ------------------------------------------------------------------------ */

export const PAGE_IDS = [
  'index.html',
  'how-it-works.html',
  'agents.html',
  'who-its-for.html',
  'operators.html',
  'faq.html',
  'vision.html',
  'status.html',
  'disclaimers.html',
] as const;

export type PageId = (typeof PAGE_IDS)[number];

/**
 * Label and href for each page the HEADER nav carries, in nav order.
 *
 * status.html and disclaimers.html are deliberately absent — see the note above.
 * Add a page here and it appears in the masthead of every page.
 */
export const NAV: ReadonlyArray<{ id: PageId; label: string }> = [
  { id: 'index.html', label: 'Overview' },
  { id: 'how-it-works.html', label: 'How it works' },
  { id: 'vision.html', label: 'Vision' },
  { id: 'agents.html', label: 'Agents' },
  { id: 'who-its-for.html', label: 'Who it is for' },
  { id: 'operators.html', label: 'Operators' },
  { id: 'faq.html', label: 'Questions' },
];

/**
 * THE APP SLOT, AND WHY IT IS DECLARED BEFORE IT EXISTS.
 *
 * Owner decision, 2026-09-05: the masthead gets an "App" entry pointing at
 * app.rwally.com, and it stays hidden until that host answers. Declaring it here
 * with `href: null` rather than leaving it out is the difference between a slot
 * with a rule and an edit somebody has to remember: `Masthead` renders nothing
 * while the href is null, and turning it on is one value in this file.
 *
 * IT IS NOT A CSS TOGGLE. A hidden nav item still reaches a screen reader, still
 * reaches a crawler, and still reaches the "every page links to every page"
 * guard — so a `display: none` version of this would publish a link to a host
 * that 404s. Nothing is rendered at all.
 *
 * WHEN app.rwally.com EXISTS: set `href` to it. It is an off-site absolute URL,
 * so it is deliberately NOT a `PageId` — nothing prerenders it, nothing walks
 * it, and the internal-link guards do not apply to it.
 */
export const APP_NAV: { readonly label: string; readonly href: string | null } = {
  label: 'App',
  href: null,
};

/** The label the footer gives the disclaimers page. Not a header-nav label. */
export const DISCLAIMERS_PAGE_LABEL = 'Disclaimers';

/** The label the footer gives the status page. Not a header-nav label. */
export const STATUS_PAGE_LABEL = 'Status and claims';

/**
 * Label and href for each page the FOOTER's Pages column carries, in order.
 *
 * All eight: the six the header nav carries, plus status.html and
 * disclaimers.html. These two links are the ONLY route to those pages, which is
 * why `Footer` keeps status.html in the list even on the status page itself —
 * where it carries `aria-current="page"`, the treatment the masthead gives a
 * self-link — rather than dropping it the way it drops every other current
 * page.
 */
export const FOOTER_PAGES: ReadonlyArray<{ id: PageId; label: string }> = [
  ...NAV,
  { id: 'status.html', label: STATUS_PAGE_LABEL },
  { id: 'disclaimers.html', label: DISCLAIMERS_PAGE_LABEL },
];

/**
 * THE SITE IS CALLED RWALLY, AND THAT IS NEW. Owner decision, 2026-09-05: the
 * masthead reads "Rwally", page titles end " — Rwally", and "Agent-Governed
 * Vaults" survives only as the descriptor line — one sentence-length gloss of
 * what Rwally is, rendered once, in the footer.
 *
 * Two constants rather than one, because they are two different things: a name
 * that goes in a title and a lockup, and a description that goes under it.
 * Collapsing them is how the descriptor ends up in the tab title.
 */
export const BRAND_NAME = 'Rwally';

/** The descriptor. One place renders it: the footer, under the mark. */
export const BRAND = 'Agent-Governed Vaults';

export const REPO_URL = 'https://github.com/SlumperSan/agent-governed-vaults';

/**
 * The CTA labels already in use on the current site. Carry these verbatim
 * rather than writing a new one: `get started`, `sign up` and `connect wallet`
 * are banned outright, and a redesign is exactly where someone reaches for
 * them.
 *
 * CHANGED 2026-09-05: `risks` and `allRisks` were 'Read the risks first' and
 * 'All fifteen named risks'. Neither string survives in the corpus — every
 * button that points at the retired risks.html (now disclaimers.html) reads
 * exactly "Disclaimers" (see e.g. agents.html's "Before you point anything at
 * this" section, faq.html's closing section, status.html's Verification
 * section). Both keys are kept, pointing at the same corpus-verbatim value,
 * rather than renamed, so an in-flight edit elsewhere that still imports
 * `CTA.allRisks` does not silently break.
 */
export const CTA = {
  risks: 'Disclaimers',
  allRisks: 'Disclaimers',
  /** index.html's second hero action button, and status.html's own tag. */
  record: 'The record',
  howItWorks: 'How it works',
  faq: 'The awkward questions',
  source: 'Source and docs',
} as const;
