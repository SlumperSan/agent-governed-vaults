/**
 * status-board — copy for "The address book" table on status.html: what is on
 * Robinhood Chain mainnet, chain id 4663.
 *
 * 2026-09-05 CORPUS SYNC. This section used to render the launch-verdict
 * board — nine gates read out of `docs/LAUNCH-READINESS.md`, closing on
 * "The launch verdict is NO-GO." status.html carries no verdict language at
 * all any more: the corpus replaced that whole board with a neutral address
 * book for the Robinhood Chain mainnet deployment, and this section now
 * renders that table instead. Every address, date, block number and commit
 * hash below is copied byte-for-byte from the corpus's `<table>`, itself read
 * out of `contracts/config/deployments/robinhood-mainnet.json` — a real
 * repository record merged separately from this redesign work, so this file
 * is a pure text sync against the corpus rather than an independent
 * re-derivation of those values. Do not round, reformat or "correct" any
 * address, date or block number here; if one looks wrong, the fix is to the
 * corpus and the deployment record, not to this file.
 *
 * The corpus has no lede paragraph between the heading and the table for this
 * section, so none is rendered here.
 *
 * `valueHtml` is HTML source bytes because several rows carry a `<code>`
 * element or an `&mdash;`. All rows go through `<Pinned>` so a later edit
 * adding one to a currently-plain row cannot break a guard silently on a page
 * that still looks perfect in the browser.
 */

export const EYEBROW = 'The address book';

export const HEADING = 'What is on chain 4663.';

export const CAPTION = 'Robinhood Chain mainnet, from contracts/config/deployments/robinhood-mainnet.json';

export const TABLE_ARIA_LABEL = 'Robinhood Chain mainnet address book';

/** One row of the address book. `record` renders as the row header. */
export const ROWS: ReadonlyArray<{ record: string; valueHtml: string }> = [
  { record: 'Chain', valueHtml: 'Robinhood Chain mainnet, chain id 4663' },
  { record: 'Broadcast', valueHtml: '2026-09-05' },
  { record: 'Source commit', valueHtml: '<code>b1cde122</code>' },
  {
    record: 'ChainlinkOracle',
    valueHtml: '<code>0x79279FBa3b6F6736f07cbBFcB7Cf0559466D5bfB</code>',
  },
  {
    record: 'OperatorRegistry',
    valueHtml: '<code>0xE200d63DB7c665F8eead3C7BDF3f0c030d7a6568</code>',
  },
  {
    record: 'SubVaultRegistry',
    valueHtml: '<code>0x692385262C05df7515560886f167c4eDD0814025</code>',
  },
  {
    record: 'FeeEngine',
    valueHtml: '<code>0x221D09326DBf6CDb708E7aBEdC9B117d64Ac4232</code>',
  },
  {
    record: 'Governance',
    valueHtml: '<code>0x790A308f1ac06FeD4C79884BAD25d0C721C5B125</code>',
  },
  {
    record: 'VaultDeployer',
    valueHtml: '<code>0xc36198FD2c7C62738159ED1FF965679105FAF05a</code>',
  },
  {
    record: 'VaultFactory',
    valueHtml: '<code>0xc44B853F037b4fF33B831C9a2B341686dEC88Fd1</code>',
  },
  {
    record: 'Vaults created',
    valueHtml: 'none &mdash; <code>factory.vaultCount()</code> returns 0',
  },
  { record: 'Oracle deploy block', valueHtml: '54,989,143' },
  {
    record: 'Singletons deploy block',
    valueHtml: '54,989,195, all six singleton receipts plus three wire calls in that one block',
  },
];

export const CLOSING =
  "The VaultFactory is the address to verify against. Everything else hangs off it and can be read from it. No execution adapter is deployed as a singleton here: adapters are not protocol singletons, so each vault creator supplies its own and it is bound in that vault's constructor.";
