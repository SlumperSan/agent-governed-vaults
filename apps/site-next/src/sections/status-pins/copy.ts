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

export const PARAGRAPHS: readonly string[] = [
  'The singletons are on chain and the factory is open, and <code>factory.vaultCount()</code> returns 0. Until a vault exists there is nothing to deposit into and no address to check, which is why the row above says so rather than leaving a gap.',
  'The parameters the first vault is planned to be created with are the reference configuration in <code>contracts/config/robinhood-mainnet.json</code>: settlement in USDG, the two assets in the oracle table above, a planned capacity cap of 50,000 USDG, a minimum deposit of 100 USDG, and governance parameters of commit 1 hour, reveal 1 hour, timelock 0, execution window 24 hours, quorum 25%, proposal threshold 5%, delegate concentration cap 40% and proposal cooldown 6 hours. <a href="how-it-works.html">How it works</a> renders that table in full. They are a configuration, not a vault; a vault freezes them only when it is funded.',
  "Whatever execution adapter a vault is created with is bound in its constructor and cannot be repointed, and its oracle address is fixed in immutable code at construction.",
  'There is no token. The next iteration, RWLY, is designed to accrue the protocol&rsquo;s fees into official Robinhood Stock Tokens; RWLY does not exist yet, and this page will carry its record when it does.',
];
