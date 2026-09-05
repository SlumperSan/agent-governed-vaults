/**
 * The twelve rows of the reference-configuration table.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS DATA AND NOT MARKUP
 * ---------------------------------------------------------------------------
 * `apps/site/test/site.test.mjs` reads `how-it-works.html` and matches
 *
 *     /<tr><th scope="row">([^<]+)<\/th><td>([^<]+)<\/td><\/tr>/g
 *
 * then compares every captured cell against `contracts/config/base-mainnet.json`
 * — the single highest-value check on the site, and the only thing standing
 * between a config edit and a page that quietly states last month's numbers.
 * Three properties of that regex are load-bearing here, and each one is a
 * silent failure if it is broken:
 *
 *   1. NO WHITESPACE between `<tr>`, `<th scope="row">` and `<td>`. JSX trims
 *      whitespace-only lines between elements and `renderToString` inserts
 *      none of its own, so the shape below produces exactly that — provided
 *      nobody adds `{' '}` between the cells.
 *   2. `<td>` and `<th scope="row">` carry NO other attribute. A `className`
 *      on either one renders `<td class="…">` and the row stops matching.
 *      Every cell is styled from the parent selector in the module stylesheet.
 *   3. ONE child per cell, and `([^<]+)` means that child may contain no `<`.
 *      No `<span>` for tabular figures — that is CSS — and no second child,
 *      because React writes a `<!-- -->` separator between adjacent text nodes.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE VALUES CAME FROM
 * ---------------------------------------------------------------------------
 * Every label and every value is carried byte-for-byte from the reviewed
 * source, `apps/site/how-it-works.html`. Nothing here was reworded, rounded or
 * tidied, and two of them look tidyable and are not:
 *
 *   - `86,400 seconds per asset` — the guard builds the accepted seconds form
 *     with `toLocaleString('en-US')`, so it expects the thousands separator.
 *     Dropping the comma fails the row.
 *   - `0 hours, none` — the guard derives `0 days / 0 hours /
 *     0 minutes / 0 seconds` from a zero duration and accepts a cell that
 *     contains one of them. Shortening the cell to "None" fails the row; the
 *     `0 hours` prefix is what matches.
 *
 * Each row cites the line in `contracts/config/base-mainnet.json` and, where the
 * value differs on the stated target chain, `contracts/config/robinhood-mainnet.json`
 * too, so the next reader can check a number against its source rather than
 * against this comment. Line numbers are as of 2026-09-04.
 *
 * TWO ROWS NOW DIFFER FROM `base-mainnet.json`, on purpose: "Minimum deposit"
 * and "Oracle staleness bound" state the values `apps/site/how-it-works.html`
 * carries for the stated target chain, Robinhood Chain mainnet, which reads
 * its reference configuration from `contracts/config/robinhood-mainnet.json`
 * instead. `site.test.mjs`'s `CONFIG_PATH` (line 173) still reads
 * `base-mainnet.json` and has not been repointed for the 2026-09-04 pivot, so
 * those two rows fail that cross-check even though they are correct against
 * the corpus. See the per-row comments below for the exact source lines.
 */

export type ConfigRow = {
  /**
   * The row label, and the key the guard looks the row up by. ASCII only: it
   * is rendered as a JSX text child, so a character React escapes — an
   * apostrophe or an ampersand — would reach the built file as an entity and
   * would no longer equal the label the guard asks for.
   */
  readonly label: string;
  /**
   * HTML SOURCE BYTES for the value cell, rendered with `<Pinned as="td">`.
   *
   * Bytes rather than text for the same reason `src/shell/pinned.ts` stores
   * bytes: `renderToString` escapes text children, so the apostrophe in the
   * delegate row would land in `dist/how-it-works.html` as `&#x27;` and the
   * page would no longer be byte-identical to the reviewed source it was
   * carried from. Written this way the built cell matches that source exactly.
   */
  readonly valueHtml: string;
};

export const ROWS: readonly ConfigRow[] = [
  // base-mainnet.json:228 — smoke.gov.commitDuration = 3600
  { label: 'Commit duration', valueHtml: '1 hour' },
  // base-mainnet.json:229 — smoke.gov.revealDuration = 3600
  { label: 'Reveal duration', valueHtml: '1 hour' },
  // base-mainnet.json:230 — smoke.gov.timelockDuration = 0
  { label: 'Timelock', valueHtml: '0 hours, none' },
  // base-mainnet.json:231 — smoke.gov.executionWindow = 86400
  { label: 'Execution window', valueHtml: '24 hours' },
  // base-mainnet.json:232 — smoke.gov.quorumBps = 2500
  { label: 'Quorum', valueHtml: '25% of voting-eligible stake' },
  // base-mainnet.json:233 — smoke.gov.proposalThresholdBps = 500
  { label: 'Proposal threshold', valueHtml: '5% of voting-eligible stake' },
  // base-mainnet.json:234 — smoke.gov.concentrationCapBps = 4000
  {
    label: 'Delegate concentration cap',
    valueHtml: "a delegate's received weight ≤ 40% of snapshot stake",
  },
  // base-mainnet.json:235 — smoke.gov.proposalCooldown = 21600
  { label: 'Proposal cooldown', valueHtml: '6 hours' },
  // base-mainnet.json:222 / robinhood-mainnet.json:165 — smoke.minDepositUsdc
  // = "100000000" (6 decimals) in BOTH configs; only the unit name changes.
  // robinhood-mainnet.json:163 (smokeParametersProvenanceNote) records that the
  // field is still called minDepositUsdc, and still reads as "USDC" in the
  // copied note text, purely so the block stays a verbatim copy of
  // base-mainnet.json — but the units on chain 4663 are USDG, not Circle USDC.
  // The site now names the settlement token this row is denominated in, which
  // is why this cell reads "100 USDG" while site.test.mjs's CONFIG_PATH still
  // points at base-mainnet.json and still expects a "USDC" suffix (see the file
  // header above): that guard has not been repointed for the 2026-09-04
  // Robinhood Chain pivot, and this row is correct against the corpus and the
  // chain either config actually differs from is out of scope here.
  { label: 'Minimum deposit', valueHtml: '100 USDG' },
  // base-mainnet.json:225 — smoke.exitFeeMaxBps = 50
  { label: 'Exit fee maximum', valueHtml: '0.50% (50 bps)' },
  // base-mainnet.json:226 — smoke.exitFeeDecayPeriod = 604800
  { label: 'Exit fee decay period', valueHtml: '7 days' },
  // robinhood-mainnet.json:117 and :139 — chainlinkOracle.assets[].heartbeatSeconds
  // = 86400 for both assets on the stated target chain (base-mainnet.json:176/197
  // sets 3600 for Base). robinhood-mainnet.json's own header note explains why:
  // the measured Chainlink heartbeat on chain 4663 is 86,400 s, which is also
  // `ChainlinkOracle.MAX_HEARTBEAT` — the loosest bound the constructor accepts.
  // site.test.mjs's CONFIG_PATH still reads base-mainnet.json (see the file
  // header above) and will therefore expect "3,600" here; that guard has not
  // been repointed for the pivot, and this row is correct against the corpus.
  { label: 'Oracle staleness bound', valueHtml: '86,400 seconds per asset' },
];
