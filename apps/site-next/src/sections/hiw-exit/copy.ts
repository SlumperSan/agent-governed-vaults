/**
 * hiw-exit — the reviewed copy, held as HTML SOURCE BYTES.
 *
 * Every string below is lifted byte-for-byte out of the `Exit` section of
 * `apps/site/how-it-works.html` (grep "Redemption is pro-rata, in kind, and
 * sometimes queued."), which is the reviewed source of truth for this page's
 * copy. Nothing here was rewritten, re-punctuated, shortened for a tighter
 * column, or split for rhythm.
 *
 * WHY BYTES RATHER THAN TEXT. `renderToString` HTML-escapes text children, so
 * `the vault's gains` reaches `dist/how-it-works.html` as `the vault&#x27;s
 * gains`. Five of the eight passages here contain an apostrophe and two carry
 * an inline `<code>` element, so all of them are rendered through
 * `<Pinned html={...}>` (src/shell/PinnedText.tsx), which writes these bytes
 * straight onto the semantic element. An em-dash survives as a text child; an
 * apostrophe does not, and mixing the two rendering paths inside one section is
 * how a passage diverges from its twin on another page.
 *
 * The apostrophes in `apps/site/*.html` are ASCII U+0027 throughout — verified
 * by scanning the file for U+2018/U+2019/U+201C/U+201D and finding none — so
 * these strings carry ASCII apostrophes too, not typographic ones.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE NUMBERS COME FROM. Paths are repo-relative.
 * ---------------------------------------------------------------------------
 * - Mode F opens at REVEAL START, not at passage. `VaultCore.requestExit`
 *   (contracts/src/VaultCore.sol:546) queues on `_hasPendingExecution`
 *   (VaultCore.sol:569,576), which reads `Governance.hasPendingExecution`
 *   (contracts/src/Governance.sol:649-659): for an Active proposal it returns
 *   `block.timestamp >= p.commitDeadline` — the instant the reveal phase opens
 *   — and for a Passed one it stays true to `p.expiresAt`. The contract's own
 *   note at Governance.sol:27 and VaultCore.sol:534 says the same.
 * - `settleQueuedExit` is external and unpermissioned — anyone can call it:
 *   contracts/src/VaultCore.sol:586.
 * - "24 hours in the reference configuration": `contracts/config/
 *   robinhood-mainnet.json` sets `timelockDuration: 0` and
 *   `executionWindow: 86400`. This exact rendering is pinned by
 *   `apps/site/test/site.test.mjs`, which computes `(timelockDuration +
 *   executionWindow) / 3600` from the config and asserts how-it-works.html
 *   contains `${n} hours in the reference configuration`. Editing the
 *   phrasing reds that check.
 */
import { MODE_F_TRIGGER } from '../../shell/pinned';

/** The section eyebrow and heading. Neither contains a character React escapes. */
export const EYEBROW = 'Exit';
export const HEADING = 'Redemption is pro-rata, in kind, and sometimes queued.';

/* --------------------------------------------------------------------------
 * The three lede paragraphs, in document order.
 * ----------------------------------------------------------------------- */

export const P_IN_KIND_DEFAULT = `By default you receive your share of every asset in the basket plus your share of the idle USDG, minus the exit fee. Shares burn at settlement, never at request, so a request is not a sale. Until it settles you still carry the vault's gains and losses.`;

export const P_TOKENS_NOT_DOLLARS = `In kind means tokens, not dollars. You receive the ETH and BTC the vault holds, as the wrapped ERC-20s the <a href="status.html">status page</a> names by address. Converting them back is your own transaction. The routing and the cost are yours too.`;

export const P_FORWARD_WINDOW = `A passed proposal holds the forward-settlement window for its timelock plus its execution window: 24 hours in the reference configuration. What that costs a member who wanted out is set out in the <a href="disclaimers.html">Disclaimers</a>.`;

/* --------------------------------------------------------------------------
 * The settlement table.
 *
 * The caption and the aria-label are the same sentence the current page
 * carries, not a new one. Both `<th scope="row">` labels are plain text with an
 * em-dash and no apostrophe, so they survive as text children; the four
 * body cells go through `<Pinned as="td">` because the Mode-F cell must carry
 * MODE_F_TRIGGER byte-identically and splitting the rendering path per cell is
 * how a table ends up with one escaped apostrophe nobody sees.
 * ----------------------------------------------------------------------- */

export const TABLE_CAPTION = 'The two settlement modes';

export const TABLE_HEADERS = ['Mode', 'When it applies', 'What it means for you'] as const;

export const MODE_I_LABEL = 'Mode I: instant';

export const MODE_I_WHEN = `No live proposal has reached its reveal phase, and no passed proposal is still inside its execution window.`;

export const MODE_I_MEANS = `The redemption settles in the same transaction, at current NAV.`;

export const MODE_F_LABEL = 'Mode F: forward';

/**
 * The one cell on this page that carries the Mode-F trigger clause. It is
 * composed from the shared constant rather than retyped: the clause travels to
 * hiw-lifecycle, disclaimers, faq, who-its-for and agents, five misstatements of
 * it are asserted absent on every surface, and a hand-typed copy is the one
 * that drifts. Note the join — MODE_F_TRIGGER ends in a closing parenthesis,
 * and the sentence continues with a space and `until`, exactly as the current
 * page reads.
 */
export const MODE_F_WHEN = `${MODE_F_TRIGGER} until that proposal executes, is defeated, or its execution window lapses. A proposal that is ultimately defeated still forced your exit into the queue while it was live.`;

export const MODE_F_MEANS = `The request is queued and settles at post-execution NAV. Once queued it is irrevocable. Your shares stay outstanding and keep gaining and losing with the vault. They are locked, though: non-transferable, and excluded from voting-eligible stake.`;

/* --------------------------------------------------------------------------
 * ----------------------------------------------------------------------- */

export const NOTE_LABEL = 'Why Mode F exists';

export const NOTE_P_WHY = `Without it, anyone watching the outcome form during the reveal phase could exit at pre-rebalance prices while already knowing it. That is a free option, paid for by everyone who stayed.`;

export const NOTE_P_LAPSE = `If the proposal is defeated or its execution window lapses without execution, a queued exit settles at the NAV current at settlement. Settlement is not automatic in that case: <code>settleQueuedExit</code> has to be called, and anyone can call it.`;

