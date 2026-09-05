/**
 * ops-obligation — the reviewed copy, held as HTML SOURCE BYTES.
 *
 * Every string below is lifted byte-for-byte out of the `The obligation`
 * section of `apps/site/operators.html` (the `<section>` that opens with the
 * eyebrow "The obligation"), which is the reviewed source of truth for this
 * page's copy. Nothing here was rewritten, re-punctuated, shortened for a
 * tighter column, or split for rhythm. No sentence in this section was written
 * for this build.
 *
 * WHY BYTES RATHER THAN TEXT. `renderToString` HTML-escapes text children, so
 * `the vault's share supply` reaches `dist/operators.html` as `the
 * vault&#x27;s share supply`. Three passages here carry an ASCII apostrophe,
 * so all of the prose is rendered through `<Pinned html={...}>`
 * (src/shell/PinnedText.tsx), which writes these bytes straight onto the
 * semantic element. Mixing rendering paths inside one section — some cells as
 * text children, some as bytes — is how one escaped apostrophe survives review
 * on a page that looks perfect in a browser.
 *
 * The apostrophes in `apps/site/*.html` are ASCII U+0027 throughout, so these
 * strings carry ASCII apostrophes too, not typographic ones.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE NUMBERS COME FROM. Paths are repo-relative.
 * ---------------------------------------------------------------------------
 * - "The creator withdrawal gate is 5% of the vault's share supply":
 *   `uint256 public constant CREATOR_MIN_STAKE_BPS = 500; // 5%` at
 *   contracts/src/VaultCore.sol:53. It is a protocol CONSTANT, not a
 *   creator-supplied parameter (VaultCore.sol:64-65 records that as a
 *   deliberate choice), which is why this heading states it flatly while the
 *   proposal threshold below is qualified as a per-vault configuration value.
 * - The gate is on the creator's ACTION and only while others remain:
 *   `_checkCreatorGate` at contracts/src/VaultCore.sol:589-597 reverts with
 *   `CreatorStakeGate()` when `member == creator && nonCreatorMemberCount > 0`
 *   and the post-burn balance would fall below the constant. Nothing there
 *   demands a deposit, which is why "not a top-up obligation" is the accurate
 *   reading and `must be topped up` is a banned shape.
 * - The gate is evaluated at QUEUE time for a Mode-F request, not only at
 *   settlement: contracts/src/VaultCore.sol:546-548 (the L-1 fix).
 * - "the 5% proposal threshold": `proposalThresholdBps: 500` at
 *   contracts/config/base-mainnet.json:233. The same file's
 *   `govChosenValuesNote` (:238) records it as a deliberate config choice above
 *   a floor the contract does not set — `Governance._validateConfig` requires
 *   only `<= 10000` and accepts 0 (base-mainnet.json:237) — which is what makes
 *   "still an open launch decision" true rather than hedging.
 * - "In a vault holding 50,000 USDG that is 2,500 USDG ... in a half-subscribed
 *   vault it is 1,250 USDG": 5% of 50,000 is 2,500 and 5% of 25,000 is 1,250.
 *   The corpus's closing sentence for this paragraph now reads "50,000 USDG is
 *   the first vault's planned capacity cap and 5% is its proposal threshold in
 *   the reference configuration" — both figures explicitly named as the
 *   reference-configuration values, qualified by "planned" in the same
 *   sentence per the page-wide 50,000/planned pairing rule. NOTE:
 *   `site.test.mjs:940` still asserts the literal string `2,500 USDC` on this
 *   page; that guard was not repointed for the 2026-09-04 Robinhood Chain
 *   pivot and now reds against copy that is correct against the corpus.
 */

/** The section eyebrow. Neither it nor the row headers contain an escaped character. */
export const EYEBROW = 'The obligation';

/** Carries `the vault's share supply`, hence `<Pinned as="h2">`. */
export const HEADING = `The creator withdrawal gate is 5% of the vault's share supply.`;

/* --------------------------------------------------------------------------
 * The two lede paragraphs, in document order.
 * ----------------------------------------------------------------------- */

/**
 * The quantified obligation. REPOINTED 2026-09-05, copy deck v2. Owner: "I
 * haven't created the safe vault yet. I want the pivot to the all-stocks
 * index." The sentence used to close on a claim about a first vault's planned
 * capacity cap; the pivot reframes the whole paragraph as arithmetic on the
 * protocol constant instead — `CREATOR_MIN_STAKE_BPS = 500` at
 * contracts/src/VaultCore.sol:53 — with `50,000 USDG` and `2,500 USDG` kept as
 * a worked example rather than as a claim about any particular vault. The
 * word `planned` survives too, now negated (`not a parameter of any planned
 * or created vault`), which keeps operators.html's page-wide 50,000/"planned"
 * co-occurrence rule satisfied while asserting nothing false: no vault, planned
 * or created, exists. Carries an em-dash as an HTML source byte.
 */
export const P_FIGURE = `In a vault holding 50,000 USDG that is 2,500 USDG; in a vault half that size it is 1,250. The figure moves with the vault. It is arithmetic on <code>CREATOR_MIN_STAKE_BPS = 500</code>, not a parameter of any planned or created vault &mdash; none exists yet.`;

/**
 * Why the minimum is really the whole position. The em-dash pair here is doing
 * the same restrictive work the hero's is: "Being diluted below 5% is
 * permitted and breaches nothing" is stated and then immediately bounded by
 * "but your redemptions revert until you are back above it". Split the two
 * halves into separate sentences and the first becomes a standalone
 * reassurance the contract does not support.
 */
export const P_LOCKED = `That capital is locked while other members remain. Being diluted below 5% is permitted and breaches nothing. But your redemptions revert until you are back above it, so dilution quietly converts a locked minimum into a locked whole position.`;

/* --------------------------------------------------------------------------
 * The crit note.
 * ----------------------------------------------------------------------- */

export const NOTE_LABEL = 'Two separate mechanisms, both 5%';

export const NOTE_BODY = `They are not the same rule. They do not bite the same way. Conflating them is the most common misreading of this protocol, so they are set out separately below.`;

/* --------------------------------------------------------------------------
 * The four-column comparison table.
 *
 * THE CAPTION AND THE ACCESSIBLE NAME ARE DIFFERENT STRINGS, deliberately, and
 * the current page carries both: `<caption>The two 5% mechanisms</caption>` but
 * `aria-label="The two 5 percent mechanisms"`. A percent SIGN is announced
 * inconsistently between screen readers — some read it, some skip it — so the
 * region's name spells the word while the visible caption keeps the numeral.
 * They are two constants for that reason; collapsing them into one silently
 * changes whichever of the two you did not intend to touch.
 * ----------------------------------------------------------------------- */

export const TABLE_CAPTION = 'The two 5% mechanisms';

export const TABLE_REGION_LABEL = 'The two 5 percent mechanisms';

export const TABLE_HEADERS = [
  'Mechanism',
  'What it controls',
  'How you fall below it',
  'What happens then',
] as const;

/** Row header. Named by site.test.mjs:417 as a required phrase on this page. */
export const THRESHOLD_LABEL = 'Proposal threshold';

export const THRESHOLD_CONTROLS = `The right to open any proposal at all. In the reference mainnet configuration it is 5% of voting-eligible stake.`;

export const THRESHOLD_FALL = `Passively. Other members deposit, total shares grow, your percentage falls. Nothing re-checks it and nothing warns you.`;

export const THRESHOLD_THEN = `You lose the right to propose anything, including the rule change that would lower the threshold. The only way back is to deposit more.`;

/** Row header. Named by site.test.mjs:418 as a required phrase on this page. */
export const GATE_LABEL = 'Creator withdrawal gate';

export const GATE_CONTROLS = `Your ability to redeem, enforced in the vault core. It is a withdrawal gate, not a top-up obligation.`;

export const GATE_FALL = `Passively, the same way. Being diluted below 5% is permitted and is not a breach of anything.`;

export const GATE_THEN = `Your redemption reverts if it would take your share below 5% while at least one non-creator member remains. Withdrawals stay frozen until the position is restored.`;

/* --------------------------------------------------------------------------
 * The closing line. Carries a real <a> element, hence the html-bytes form.
 * ----------------------------------------------------------------------- */

export const P_WATCH = `The two together, and what neither of them warns you about, are set out in the <a href="disclaimers.html">Disclaimers</a>.`;

