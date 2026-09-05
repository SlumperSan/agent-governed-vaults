/**
 * status-testnet — copy for two consecutive corpus sections on status.html:
 * "Wiring, read back" and "The oracle".
 *
 * 2026-09-05 CORPUS SYNC — WHY THIS FILE NOW HOLDS TWO SECTIONS, NOT ONE. This
 * section used to render the Base Sepolia address book. The corpus dropped
 * that table entirely (there is no testnet content on the neutral mainnet
 * ledger status.html has become) and, in its place, carries three sections in
 * this order: "Wiring, read back" (a bullet list, no table), "The oracle" (an
 * intro paragraph, a table, a closing paragraph) and "The first vault" (four
 * plain paragraphs, no table).
 *
 * The task of splitting those three across this section and status-pins was
 * decided by shape: this file already owned a table-plus-lede-plus-closing
 * layout, which is the exact shape "The oracle" needs, so it stays here.
 * status-pins already owned a plain prose block with no table, which is the
 * shape "The first vault" needs, so that one moved there instead — see
 * status-pins/copy.ts for its half of this split.
 *
 * That left "Wiring, read back" — a bullet list with no table — needing a
 * home. It could not move to status-pins without putting it AFTER "The
 * oracle" in render order (StatusPage.tsx renders StatusBoard, then
 * StatusTestnet, then StatusPins), which would reverse the corpus's actual
 * order (Wiring precedes the oracle table). So "Wiring, read back" stays here
 * too, rendered as its own `<section>` immediately before "The oracle" within
 * this same file, preserving the corpus's document order end to end:
 * the address book (status-board) -> Wiring, read back -> The oracle
 * (both here) -> The first vault (status-pins) -> Verification (status-verify).
 *
 * Every value below — the WETH/cbBTC addresses, the Chainlink feed addresses,
 * the staleness bound, the price bands and the USDG address — is copied
 * byte-for-byte from the corpus, itself read out of
 * contracts/config/robinhood-mainnet.json, a real repository record merged
 * separately from this redesign work. This file is a pure text sync against
 * the corpus, not an independent re-derivation of those values. Do not round,
 * reformat or "correct" any address or figure here.
 */

export const WIRING_HEADING_ID = 'status-testnet-wiring-heading';
export const WIRING_EYEBROW = 'Wiring, read back';
export const WIRING_HEADING = 'What the chain returned when each value was read back.';

/** Each item carries a real `<code>` element, hence HTML source bytes via `<Pinned>`. */
export const WIRING_ITEMS: readonly string[] = [
  '<code>factory.registry</code>, <code>factory.governance</code>, <code>factory.feeEngine</code> and <code>factory.vaultDeployer</code> each point at the singleton in the table above.',
  '<code>registry.factory</code> points back at the factory.',
  '<code>governance.subVaultRegistry</code> points at the SubVaultRegistry.',
  '<code>factory.oracleAllowlistEnforced()</code> is true, and <code>factory.isAllowedOracle(oracle)</code> is true for the oracle above.',
  '<code>factory.allowSubVaults()</code> is false, so this factory deploys root vaults only and every vault it deploys is wired <code>subVaultRegistry = address(0)</code>.',
];

export const HEADING_ID = 'status-testnet-heading';
export const EYEBROW = 'The oracle';
export const HEADING = 'Two assets, one Chainlink Data Feed each.';

export const LEDE =
  'The basket is written on this site as ETH and BTC because that is what people call them, and on Robinhood Chain it is held as WETH at <code>0x0bd7d308f8e1639fab988df18a8011f41eacad73</code> and cbBTC at <code>0xcec185eb182c47d1ba1efc84e6959e18cd620be4</code>.';

export const CAPTION = 'Oracle configuration, from contracts/config/robinhood-mainnet.json';
export const TABLE_ARIA_LABEL = 'Oracle configuration';

export const ROWS: ReadonlyArray<{ record: string; valueHtml: string }> = [
  {
    record: 'ETH/USD feed',
    valueHtml: '<code>0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9</code>, eight decimals',
  },
  {
    record: 'CBBTC/USD feed',
    valueHtml: '<code>0x0009cD492adf8167f9eEBf1293556A673530a21a</code>, eight decimals',
  },
  {
    record: 'Staleness bound',
    valueHtml: "86,400 seconds per asset, which is ChainlinkOracle's MAX_HEARTBEAT ceiling",
  },
  {
    record: 'Sane-price bands',
    valueHtml: '$100 to $100,000 for WETH; $1,000 to $1,000,000 for cbBTC',
  },
  {
    record: 'Settlement token',
    valueHtml: 'USDG at <code>0x5fc5360d0400a0fd4f2af552add042d716f1d168</code>, valued at one dollar in the oracle',
  },
  { record: 'Sequencer uptime feed', valueHtml: 'the zero address' },
];

export const CLOSING =
  'Chainlink publishes no L2 Sequencer Uptime Feed for chain 4663, so there is no address to wire. The deploy-time requirement exempts 4663 alongside a local node and Base Sepolia, by an owner-approved weakening of 2026-09-04. What that costs is set out in the <a href="disclaimers.html#r5">Disclaimers</a>.';
