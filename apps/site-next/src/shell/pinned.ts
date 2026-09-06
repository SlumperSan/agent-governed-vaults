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
 * Every page's <title> ends in this. The separator and the spacing are pinned.
 *
 * CHANGED TWICE ON 2026-09-05, both times by owner decision. It was
 * ' - Agent-Governed Vaults' set with an em-dash; the rename to Rwally made it
 * ' | Rwally', and "Agent-Governed Vaults" survives only as the descriptor line
 * in the footer (see BRAND below). The recasing to RWAlly followed the same day:
 * the name is a play on RWA, so the first three letters carry it.
 */
export const TITLE_SUFFIX = ' | RWAlly';

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

/**
 * FOOTER_TOKEN WAS DELETED HERE ON 2026-09-05, AND THE DELETION IS THE RECORD.
 *
 * It held `No token.` followed by three more negatives, it rendered once on
 * disclaimers.html through `risks-hero`, and it was corpus-verbatim. RWLY was
 * created at 2026-09-05T21:51:57Z, the timestamp of its creation block, so the
 * sentence opens on a clause that is false and cannot be repaired by
 * rewording: the whole sentence exists to say a thing does not exist.
 *
 * WHAT REPLACED IT is not another pinned sentence. `risks-hero` carries a
 * four-paragraph token block instead, page-local rather than pinned, because
 * nothing else on the site quotes it and a constant nobody shares is a
 * constant that only invites a second copy. The homepage says the same thing
 * in 49 words in `sections/index-next/copy.ts`.
 *
 * TWO CONSEQUENCES FOR WHOEVER EDITS THE COPY NEXT. The per-page count in
 * `test/site.test.mjs` is zero on every page, so a reappearance reds rather
 * than passes silently. And the two negated words that sentence carried had
 * their only exemption on this site inside it, so with it gone they are banned
 * outright everywhere and a replacement sentence may not reach for either.
 */

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
 * TWO LISTS, NOT ONE, AND ONE OF THEM IS NOW EMPTY. `NAV` is the header nav and
 * carries nothing; `FOOTER_PAGES` is the footer's Pages column and carries both
 * documents this site has. The v3 brief of 2026-09-05 collapsed the nine-page
 * site into one scroll page plus the Disclaimers, so a header nav would list the
 * page you are already on and one other. `site.test.mjs` asserts the half that
 * still matters: every page links to every page.
 * ------------------------------------------------------------------------ */

export const PAGE_IDS = ['index.html', 'disclaimers.html'] as const;

export type PageId = (typeof PAGE_IDS)[number];

/**
 * THE HEADER NAV IS EMPTY, AND THE HEADER'S OWN NAV IS `HEADER_NAV` BELOW.
 *
 * `NAV` is the list of PAGE ids the footer composes `FOOTER_PAGES` from, and it
 * is empty because this site has exactly two pages and both are listed
 * explicitly there. It is kept rather than deleted so `FOOTER_PAGES` still
 * composes from one place.
 *
 * The masthead was ALSO empty from the first v3 pass on 2026-09-05, on the
 * reasoning that a nav of two entries, one of which is the page you are on, is
 * chrome that says nothing. Revision 2 of the brief, the same evening, replaced
 * that reasoning rather than refined it: the owner named artificialinu.com as
 * the reference and asked that "header, footer, tab icon all are the same"
 * across rwally.com and app.rwally.com. The reference's header is a floating
 * pill carrying a centred four-entry nav, and two of those four entries are not
 * pages of this site at all. So the nav came back with a different shape, and
 * the shape is why it is a separate constant: see `HEADER_NAV`.
 */
export const NAV: ReadonlyArray<{ id: PageId; label: string }> = [];

/**
 * THE HEADER'S CENTRED NAV. Four entries, and they are deliberately NOT
 * `PageId`s.
 *
 * A `PageId` is a document this build prerenders and the internal-link guards
 * walk. Only two of these four are that. The other two are a same-page anchor
 * and an off-site absolute URL, and typing all four as `PageId` is how an
 * anchor ends up in `sitemap.xml` and an off-site host ends up being walked as
 * a local file. So the type here is an href string and nothing more, and each
 * entry says which kind it is.
 *
 *   Home           the top of this page. `#top`, not `index.html`, because from
 *                  the homepage a link to index.html is a full navigation that
 *                  throws away scroll position to arrive where you already are.
 *   How it works   the `#how` section of this page. The seven retired pages
 *                  collapsed into one scroll, so the thing that used to be a
 *                  page is now a section, and the nav entry is the anchor.
 *   App            app.rwally.com. Off-site.
 *   Disclaimers    the other document. A real page.
 *
 * `external` is what the component uses to decide `rel="noopener"`, and
 * `page` is what it uses to decide `aria-current="page"`. Both are read from
 * the data rather than inferred from the href, because inferring "does this
 * string start with http" is the kind of check that is right until somebody
 * adds a protocol-relative URL.
 */
export const HEADER_NAV: ReadonlyArray<{
  readonly label: string;
  readonly href: string;
  readonly external?: true;
  readonly page?: PageId;
}> = [
  { label: 'Home', href: '#top', page: 'index.html' },
  { label: 'How it works', href: '#how' },
  { label: 'App', href: 'https://app.rwally.com', external: true },
  { label: 'Disclaimers', href: 'disclaimers.html', page: 'disclaimers.html' },
];

/**
 * THE TAGLINE, set under the wordmark in the header and again in the footer.
 *
 * It is "The AI agent trading index." and it stops there. It read "The AI agent
 * trading index on Robinhood Chain." until revision 2 of the v3 brief, where
 * the owner shortened it: the chain belongs in the facts, which the live reads
 * and the hive section both state with the chain id beside them, not in the
 * positioning line.
 *
 * THIS EXACT PHRASE IS PERMITTED BY NAME IN A GUARD, WHICH IS WHY IT IS PINNED
 * HERE RATHER THAN TYPED INTO TWO COMPONENTS. `scripts/test/claims-lede-truth
 * .test.mjs` bans an agent as the subject of pooling, governing, managing or
 * trading, participles included, and masks `AI agent trading index` character
 * for character before it scans. The phrase names WHAT THE INDEX IS ABOUT, not
 * who executes; `Governance.propose` gates on stake, and `Governance.sol`
 * contains zero occurrences of "operator". One character of drift here and the
 * mask stops matching, so both surfaces read the string from this constant.
 */
export const TAGLINE = 'The AI agent trading index.';

/**
 * The project's X account, given by the owner on 2026-09-05.
 *
 * It was absent from this file until then, and the footer rendered no X link at
 * all rather than an `href="#"`, because a link that lies about having a
 * destination is worse than no link. The handle exists now, so the header
 * carries it as an icon button and the footer carries it as a labelled link.
 * NAVIGATION ONLY: nothing on this site loads a byte from x.com, and
 * `site.test.mjs` permits the host on that basis alone.
 */
export const X_URL = 'https://x.com/RWAllyVault';

/**
 * THE APP DOOR. It was declared here with `href: null` while app.rwally.com did
 * not answer; the v3 brief of 2026-09-05 records that it does, so the value is
 * filled in and the slot is a link.
 *
 * It is an off-site absolute URL, so it is deliberately NOT a `PageId`: nothing
 * prerenders it, nothing walks it, and the internal-link guards do not apply to
 * it. `site.test.mjs` permits this host by name in its external-host rule, in
 * the navigation half only: nothing on this site LOADS a byte from it.
 *
 * The label is the whole button, so it is written as an instruction rather than
 * as a noun. "App" names a thing; "Open the app" says what the click does, which
 * is the rule the rest of this site's CTA labels already follow.
 */
export const APP_NAV: { readonly label: string; readonly href: string } = {
  label: 'Open the app',
  href: 'https://app.rwally.com',
};

/** The label the footer gives the disclaimers page. Not a header-nav label. */
export const DISCLAIMERS_PAGE_LABEL = 'Disclaimers';

/** The label the footer gives the one scroll page. Not a header-nav label. */
export const OVERVIEW_PAGE_LABEL = 'Overview';

/**
 * Label and href for each page the footer carries, in order. Both of them, on
 * both pages: with an empty header nav this list is the ONLY route between the
 * two documents, so neither is dropped on itself. The current page carries
 * `aria-current="page"` instead, which is the treatment the masthead used to
 * give a self-link.
 */
export const FOOTER_PAGES: ReadonlyArray<{ id: PageId; label: string }> = [
  ...NAV,
  { id: 'index.html', label: OVERVIEW_PAGE_LABEL },
  { id: 'disclaimers.html', label: DISCLAIMERS_PAGE_LABEL },
];

/**
 * THE SITE IS CALLED RWALLY, AND THAT IS NEW. Owner decision, 2026-09-05: the
 * masthead reads "RWAlly", page titles end " | RWAlly", and "Agent-Governed
 * Vaults" survives only as the descriptor line, one sentence-length gloss of
 * what RWAlly is, rendered once, in the footer.
 *
 * THE CASING IS THE JOKE AND IS NOT A TYPO. The owner set it later the same day:
 * "RWA is the play on words", so the first three letters are capital and the
 * rest is not. It also puts the site's name in the same case as the token's,
 * which was created as RWAlly on chain and had been the one surface spelling it
 * that way. A tool that lowercases or title-cases this string is wrong twice.
 *
 * Two constants rather than one, because they are two different things: a name
 * that goes in a title and a lockup, and a description that goes under it.
 * Collapsing them is how the descriptor ends up in the tab title.
 */
export const BRAND_NAME = 'RWAlly';

/** The descriptor. One place renders it: the footer, under the mark. */
export const BRAND = 'Agent-Governed Vaults';

export const REPO_URL = 'https://github.com/SlumperSan/agent-governed-vaults';

/**
 * The block explorer for chain 4663, as `contracts/config/deployments/
 * robinhood-mainnet.json` records it under `explorer`. It is a NAVIGATION target
 * and nothing else: no page loads a byte from it, and `site.test.mjs` permits
 * the host on that basis alone.
 *
 * The path is the VaultFactory's, because the address book that used to publish
 * all seven singletons went with status.html, and the factory is the one address
 * a reader can verify every other from.
 *
 * THE CITATION THAT STOOD HERE POINTED AT A DELETED FILE. It named
 * `src/sections/index-record/copy.ts` as carrying the corpus sentence that says
 * so, and that section went with revision 2 of the v3 brief on 2026-09-05: the
 * record band it rendered is replaced by `src/sections/index-live/`, which does
 * not assert the addresses at all but READS the factory's own answers from chain
 * 4663 in the reader's browser. The two addresses a reader needs are the hero's
 * copy chips, and both come from `src/live/chain.ts`, which is also the file the
 * live panel calls, so the page cannot show one address and check another.
 */
export const EXPLORER_URL =
  'https://robinhoodchain.blockscout.com/address/0xc44B853F037b4fF33B831C9a2B341686dEC88Fd1';

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
