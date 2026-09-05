/**
 * status-pins — copy for the corpus's "The first vault" section on
 * status.html.
 *
 * 2026-09-05 CORPUS SYNC. This section used to render "Four sentences the
 * guard pins" — a standing-fact note box quoting `FOOTER_TOKEN` from
 * src/shell/pinned.ts plus explanatory prose about the wording guard itself.
 * The corpus carries no such meta-commentary about its own guard any more.
 * In its place, in the same document position (the section right before
 * Verification), the corpus has "The first vault": four plain paragraphs
 * stating that no vault has been created yet, what the first vault's planned
 * parameters are, and that there is still no token. See
 * status-testnet/copy.ts for the full note on how the corpus's three
 * post-address-book sections were split between that file and this one — the
 * short version is that this section kept the shape it already had (plain
 * prose, no table), which is the shape "The first vault" needs.
 *
 * `FOOTER_TOKEN` is no longer imported or rendered here: the corpus's fourth
 * paragraph below states the no-token fact in its own words rather than
 * quoting the footer sentence, so this page now carries `FOOTER_TOKEN` once
 * (in the footer) rather than twice. Whoever owns the per-page sentence-count
 * constant needs to move status.html from 2 to 1 for that sentence.
 *
 * Every string below is lifted byte-for-byte from the corpus. Several carry a
 * real `<code>` element, an `<a>`, or the `&rsquo;` entity the corpus itself
 * uses for "protocol's" — hence HTML source bytes rendered through `<Pinned>`.
 */

export const EYEBROW = 'The first vault';

export const HEADING = 'No vault has been created yet.';

// REPOINTED 2026-09-05, copy deck v2. Owner: "I haven't created the safe
// vault yet. I want the pivot to the all-stocks index." The paragraph
// describing the first vault's PLANNED parameters (including the 50,000 USDG
// cap) is gone — no vault is planned any more, so it is replaced with three
// shorter paragraphs describing contracts/config/robinhood-mainnet.json as
// what it actually is: the chain's configuration, not a plan for a vault. The
// closing paragraph is rewritten to point at the Vision page instead of
// naming Robinhood Stock Tokens directly, matching vision.html's fuller
// design-intent account.
export const PARAGRAPHS: readonly string[] = [
  'The singletons are on chain and the factory is open, and <code>factory.vaultCount()</code> returns 0. Until a vault exists there is nothing to deposit into and no address to check, which is why the row above says so rather than leaving a gap.',
  '<code>contracts/config/robinhood-mainnet.json</code> is the chain&rsquo;s configuration, not a plan for a vault.',
  'It is what the oracle was deployed against on Robinhood Chain, and what this site&rsquo;s figures are checked against: the two priced assets, their feeds and bands, the settlement token, and a set of governance durations any vault creator may adopt or ignore.',
  '<a href="how-it-works.html">How it works</a> renders that table in full. A vault freezes its own parameters only when it is funded, and none has been.',
  "Whatever execution adapter a vault is created with is bound in its constructor and cannot be repointed, and its oracle address is fixed in immutable code at construction.",
  'There is no token. RWLY is designed to be the protocol&rsquo;s governance token and to accrue fees into stock; RWLY does not exist yet, and this page will carry its record when it does. The design is on the <a href="vision.html">Vision page</a>.',
];
