/**
 * The live panel's labels.
 *
 * THESE ARE THE THIRD SENTENCE SOURCE, AND THE ONLY ONE THAT IS NOT A CORPUS.
 * `test/site.test.mjs` requires every sentence on this page to appear verbatim
 * in one of three places: the nine pages of `apps/site`, the approved promo
 * script, or this label set. A live read has no corpus sentence by definition,
 * because the corpus was written before the read happened. So the set is pinned
 * here, the test imports the same strings, and adding a sentence to this panel
 * means adding it to this file, where it sits next to the reason it is true.
 *
 * EVERY LABEL NAMES THE CALL THAT PRODUCES IT. `factory.vaultCount()` under
 * "Vaults created" is not decoration and it is not developer garnish: it is the
 * difference between a number this page asserts and a number a reader can go and
 * fetch for themselves. The whole panel is built on that distinction.
 *
 * THE TWO FEED DESCRIPTIONS ARE EXPECTATIONS, NOT ASSERTIONS. `EXPECT_ETH` and
 * `EXPECT_SPY` are what the two proxies called themselves when they were read on
 * 2026-09-05, and they are rendered in the server markup so a reader with no
 * JavaScript gets a labelled panel rather than four blank rows. The moment the
 * read lands, each label is REPLACED by whatever the contract's own
 * `description()` returns. If those ever disagree, the reader sees the chain's
 * answer and not this file's, which is the only ordering that keeps the page
 * honest. The directory and the contract already disagree for nine of the
 * thirty-five equity feeds on this chain: the Chainlink directory says
 * "Robinhood SPY / USD" and the contract says "RHSPY / USD".
 */

/** The section's eyebrow. 4663 is the chain, and the read asserts it. */
export const EYEBROW = 'Live from chain 4663';

/** Under the giant figure. */
export const BLOCK_LABEL = 'Latest block';

/**
 * The standing statement of what this panel is.
 *
 * "in your browser" is the load-bearing half. Every other number on this site
 * was put there by whoever built the page; these five were fetched by the
 * reader's own machine while they were looking at it, and a reader who doubts
 * that can open the network panel and watch the requests go out.
 */
export const INTRO = 'Read from the chain in your browser.';

/** The two calls on the factory, and what each answer means. */
export const VAULTS_LABEL = 'Vaults created';
export const VAULTS_CALL = 'factory.vaultCount()';
export const SUBVAULTS_LABEL = 'Sub-vaults enabled';
export const SUBVAULTS_CALL = 'factory.allowSubVaults()';

/**
 * The line under each price, and it is never omitted.
 *
 * A PRICE WITHOUT ITS TIMESTAMP IS A CLAIM ABOUT NOW. The equity feeds on this
 * chain stop printing when the market closes: the SPY proxy was thirty hours old
 * when this panel was built, on a Saturday afternoon, and it will be older on
 * Sunday. Rendering that price with a stamp reading "just now" would be a lie
 * the reader has no way to catch. So the stamp belongs to the FEED, it says when
 * the FEED printed, and the separate line that says when this browser asked is a
 * different line with different words.
 */
export const FEED_LABEL = 'Feed last printed';

/**
 * The freshness verdict, as a word beside a colour rather than a colour alone.
 *
 * Twenty-four hours is the boundary the deployed oracle draws for the ETH feed;
 * `src/live/useLive.ts` records why it is the honest comparison for the equity
 * feed too, and why the page does not claim the protocol prices that asset.
 */
export const FRESH = 'inside 24h';
export const STALE = 'past 24h';

/** What the panel says while the requests are in flight, and if they fail. */
export const READING = 'Reading.';
export const FAILED = 'The read failed.';

/** See the header note: expectations that the chain's own answer overrides. */
export const EXPECT_ETH = 'ETH / USD';
export const EXPECT_SPY = 'RHSPY / USD';

/**
 * The stamp under the block figure once a read has landed.
 *
 * It is a SENTENCE FRAGMENT completed by a local wall-clock time, because "when
 * did my browser ask" is a fact about the reader and belongs in the reader's own
 * zone. The feed stamps above are the opposite case and are rendered in UTC:
 * they are facts about the chain, identical for everyone, and rendering them
 * locally would make two readers disagree about when a print happened.
 */
export const READ_AT = 'Read at';
