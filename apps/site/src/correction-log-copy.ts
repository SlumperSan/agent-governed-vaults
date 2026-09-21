/**
 * EVERY SENTENCE ON THE CORRECTION LOG PAGE, IN ONE FILE.
 *
 * Schema: `Decisions/correction-log-content-spec-2026-09-19.md`. Four fields per entry, no more —
 * date (when the correction was made, not when the error shipped), the claim as stated, what was
 * wrong and how it was found, and the replacement plus a verification pointer. Entries are read from
 * this structured source rather than hand-authored in the page component, so adding one later is not
 * a redesign — see `CorrectionLog.tsx`.
 *
 * WHERE ENTRIES COME FROM. Not authored fresh: each is a distillation of a commit that already
 * corrected a public claim, re-verified independently before being written here rather than copied
 * uncritically from a vault note. Both back-fill entries below cite the exact commit and the exact
 * contract line or config field an editor can re-check today.
 *
 * THE CLAIMS-GUARD HAZARD. `scripts/test/claims-lede-truth.test.mjs` walks every `.md`/`.html`/
 * `.txt`/`.json` file in the repo, including this page's built `dist/correction-log.html`, and its
 * "dated-record exemption" (guard 4 only) covers `docs/audit/` and `docs/reviews/` — not this page.
 * So the "claim, as stated" fields below PARAPHRASE the old false claims rather than quoting them
 * verbatim, describing their shape instead of reproducing the exact banned sentence. This page's own
 * job is to say a claim was wrong, never to restate it as though it still stood.
 *
 * THIS LOG AGREES WITH THE PRESENT, NEVER WITH THE PAST. Both entries below describe history; neither
 * contradicts what `copy.ts` / `disclaimers-copy.ts` say the truth is today. If either ever drifts
 * from the current copy, the entry is wrong and must be fixed, not the copy.
 */

export type CorrectionEntry = {
  /** When the correction was made, not when the error shipped. */
  readonly date: string;
  /** The claim as it was publicly stated (or, where quoting the exact banned shape would trip the
   * claims guard, a faithful paraphrase of it — see the file header). */
  readonly claim: string;
  /** What was wrong, and how it was found. One or two sentences. */
  readonly whatWasWrong: string;
  /** The corrected claim, plus a pointer to the primary source a reader can check it against. */
  readonly replacement: string;
};

export const HERO = {
  eyebrow: 'Correction log',
  title: 'Every public claim this site made that was wrong.',
  lede:
    'Dated, in full, as corrections happen. Not a changelog of features and not a bug tracker — ' +
    'only instances of the shape "we said X, X was wrong, here is why, here is what is true now."',
} as const;

export const EMPTY_STATE_NOTE =
  'This list opens with real back-fill entries rather than empty, because real public claims had ' +
  'already changed before this page existed.';

export const CORRECTION_ENTRIES: readonly CorrectionEntry[] = [
  {
    date: '2026-09-18',
    claim:
      'Public copy (the disclaimers page and the README) described this vault’s basket as a ' +
      'two-asset mix carried over from the Robinhood Chain configuration — a wrapped-ETH-plus-' +
      'wrapped-BTC pairing, priced off both an ETH feed and a BTC feed.',
    whatWasWrong:
      'That basket shape was correct for Robinhood Chain (chain 4663) but never verified against ' +
      'Arc (chain 5042), the only chain this site now describes. A complete Uniswap v3 PoolCreated ' +
      'scan of Arc mainnet — 26,286 pools, 26,187 distinct tokens that appear in a v3 pool, zero ' +
      'window errors — found no ETH representation of any kind on the chain: Arc publishes a ' +
      'live Chainlink ETH/USD feed, but there is no token on Arc for it to price.',
    replacement:
      'The basket is one asset, cirBTC, priced off the Chainlink BTC/USD feed. Verify at ' +
      '`contracts/config/arc-mainnet.json` → `chainlinkOracle.assets[0]` (symbol `cirBTC`, ' +
      'address `0x171a4217b86a807a64eb94757db6849fb4bdbaa0`) and `chainlinkOracle.notListed.ETH`, ' +
      'which records the live ETH/USD feed and the chain-wide scan that found nothing for it to price.',
  },
  {
    date: '2026-09-18',
    claim:
      'Three sentences on the homepage — the hero line, the second how-it-works step, and a ' +
      'trust bullet — described the vault in unscoped terms: broadly, that nothing about the ' +
      'vault moves, and no trade happens, until a governance vote passes.',
    whatWasWrong:
      'The claim was true of rebalances but false as a statement about the vault generally. ' +
      '`VaultCore.pullChildEscrow` is `external` with no `msg.sender` gate at all — its own ' +
      'NatSpec calls it "Crank ... Permissionless" — so any address can move a child vault’s ' +
      'escrowed inventory into the parent with no vote. Deposits, exits and the fee slice change what ' +
      'the vault holds the same way. "Holds" is an inventory word, and the inventory moves ' +
      'continuously without votes; what a vote actually decides is the investment choice.',
    replacement:
      'The claim now scopes to the investment decision, never to the vault’s holdings: "What ' +
      'this vault invests in is decided by vote." Verify at `apps/site/src/copy.ts` ' +
      '(`HOME.hero.sub` and the "What a vault is" entry) against `contracts/src/VaultCore.sol:900`, ' +
      'where `executeRebalance` requires `msg.sender == address(governance)` — contrasted with ' +
      '`VaultCore.sol:868`’s `pullChildEscrow`, which carries no such check.',
  },
] as const;
