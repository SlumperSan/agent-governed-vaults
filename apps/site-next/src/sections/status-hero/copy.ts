/**
 * status-hero — copy for the top of status.html: the record band, then the
 * page's one <h1>.
 *
 * 2026-09-05 CORPUS SYNC. status.html stopped being the launch-verdict /
 * NO-GO page and became a neutral address ledger for the Robinhood Chain
 * mainnet deployment. The band this section renders (styled by the sitewide
 * `.banner` / `.banner-tag` rules in src/index.css — unchanged, only the words
 * inside them changed) used to carry the pre-launch "not deployed to mainnet"
 * disclosure from `src/shell/pinned.ts` (`BANNER_TAG`, `BANNER_PARAGRAPH`).
 * The corpus's band no longer says that: it is now titled "The record" and
 * states the deployment fact instead. Those two pinned constants are simply
 * the wrong words for this page now, so this section stopped importing them
 * and holds its own two literal strings below instead — this is a genuine
 * content change, not a refactor, and is called out for whoever owns
 * `src/shell/PreLaunchBanner.tsx` and `src/shell/pinned.ts` next: that shared
 * component and its constants are no longer rendered anywhere in this build.
 *
 * All four strings are lifted byte-for-byte from the corpus's `.pre-launch`
 * block and `.hero--plain` block. Nothing was rewritten, re-punctuated,
 * shortened or composed.
 *
 * `BAND_TEXT` carries a real `<code>` element around the file path, exactly as
 * the corpus does — hence HTML source bytes rendered through `<Pinned>` rather
 * than a plain text child. The hero strings carry no markup and no apostrophe,
 * so they render as plain JSX text.
 */

export const BAND_TAG = 'The record';

export const BAND_TEXT =
  'Deployed on Robinhood Chain mainnet, chain id 4663. The ledger is <code>contracts/config/deployments/robinhood-mainnet.json</code>, and every address below was read back on-chain rather than transcribed from a deploy log.';

export const EYEBROW = 'Status';

export const TITLE = 'Every address, and how it was checked.';

export const LEDE =
  'Every figure on this page is read out of a named file in the public repository. Nothing here asks to be taken on trust.';
