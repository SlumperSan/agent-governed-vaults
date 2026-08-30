// @ts-check
/**
 * Which actions a vault permits right now, and — when it does not — the reason, in the user's
 * terms. One place, so no button anywhere can be enabled on a rule the rest of the app respects.
 *
 * Derived from the actual revert surfaces:
 *
 *   deposit()        _deposit → navWad() for the capacity check     → BLOCKED when frozen
 *   activate()       → _mintShares → navWad()                        → BLOCKED when frozen
 *   cancelPending()  reads no oracle, transfers escrow back          → ALWAYS AVAILABLE
 *   requestExit()    Mode I  → _settleExit → oracle.priceWad()       → BLOCKED when frozen
 *                    Mode F  → queue only, NO oracle read            → *succeeds* when frozen
 *   skipWindow()     sets a permanent flag; only activates if pending → see below
 *
 * Two of those are traps rather than features, and this module refuses both:
 *
 *  TRAP 1 — Mode-F queueing during a freeze. It is not blocked by the contract, and its whole
 *  effect is harmful: the exit is irrevocable, the shares lose voting eligibility the instant it
 *  is queued, and it cannot settle until BOTH the proposal resolves AND the oracle recovers.
 *  There is no state in which a user is better off having pressed it while frozen, so it is
 *  presented as unavailable with that reason spelled out — a deliberate product decision to be
 *  stricter than the contract, not a claim that the contract forbids it.
 *
 *  TRAP 2 — skipWindow() with nothing pending. It succeeds, and permanently burns the
 *  once-per-agent-per-vault opt-in for no benefit (it even succeeds while frozen). It is
 *  therefore never offered as a standalone action, only as a branch inside a deposit that has an
 *  amount attached.
 */

/**
 * @typedef {Object} VaultFacts
 * @property {boolean|null} frozen         oracle breaker tripped for one of the basket assets;
 *                                         `null` = the freeze state cannot be read from this data
 * @property {boolean} attested            operatorId !== 0
 * @property {'I'|'F'|'unknown'} exitMode  from governance.resolveExitMode
 * @property {boolean} isMember            holds shares
 * @property {boolean} hasPendingDeposit
 * @property {boolean} pendingMatured      observation window elapsed
 * @property {boolean} hasQueuedExit       a Mode-F exit is already queued (one at a time)
 * @property {boolean} capacityFull
 * @property {boolean} [capacityKnown]     false ⇒ NAV and escrowed pending are both unreadable
 * @property {boolean} [isCreatorBelowGate] creator whose redemption would breach the 5% gate
 * @property {boolean} [walletConnected]
 */

/** @typedef {{available:boolean, reason:string, severity:'ok'|'info'|'warn'|'blocked'}} Verdict */

const ok = () => /** @type {Verdict} */ ({ available: true, reason: '', severity: 'ok' });
const no = (reason, severity = 'blocked') => /** @type {Verdict} */ ({ available: false, reason, severity });
const warn = (reason) => /** @type {Verdict} */ ({ available: true, reason, severity: 'warn' });

/**
 * @param {VaultFacts} f
 * @returns {{deposit:Verdict, activate:Verdict, cancelPending:Verdict, exit:Verdict,
 *            skipWindow:Verdict, settleQueuedExit:Verdict,
 *            notices:Array<{id:string,tone:string,title:string,body:string}>}}
 */
export function actions(f) {
  const notices = [];
  const freezeUnknown = f.frozen === null || f.frozen === undefined;

  if (f.frozen === true) {
    notices.push({
      id: 'frozen',
      tone: 'frozen',
      title: 'This vault is frozen, on purpose.',
      body:
        'A price source for one of its basket assets went stale, so every path that reads a ' +
        'valuation stops — deposits, activations, exits and rebalances alike. Freezing is the ' +
        'safety mechanism: it is what stops anyone entering or leaving at a price the vault can ' +
        'no longer verify. There is no emergency withdrawal and no admin who can override it, ' +
        'by design. Your shares and history are unchanged and still visible. Capital still in ' +
        'the observation window is not frozen — you can cancel it and take it back right now.',
    });
  }
  if (freezeUnknown) {
    notices.push({
      id: 'freeze-unknown',
      tone: 'warn',
      title: 'Whether this vault is frozen cannot be read from this data.',
      body:
        'The breaker lives on the OracleAggregator, which is read directly and never emitted, so ' +
        'no event-derived projection carries it. This vault may be frozen right now — every ' +
        'figure below that depends on NAV is unreadable in that state, and deposits, activations ' +
        'and exits all stop. Unknown is not the same claim as healthy, and it is not shown as one.',
    });
  }
  if (!f.attested) {
    notices.push({
      id: 'unattested',
      tone: 'critical',
      title: 'Not attested by the canonical registry.',
      body:
        'This vault reports operator #0, which means no registered operator stands behind it. ' +
        'The name and any track record it displays are self-declared and unverifiable, and it ' +
        'carries no leaderboard history. The registry is the trust signal here; a name is not.',
    });
  }
  if (f.exitMode === 'unknown') {
    notices.push({
      id: 'mode-unknown',
      tone: 'warn',
      title: 'Exit mode cannot be resolved from this data.',
      body:
        'Whether an exit settles instantly or is queued irrevocably turns on a proposal’s commit ' +
        'deadline, and that deadline is not in this data — Governance.Proposed carries no times. ' +
        'Treat an exit here as possibly irrevocable until your wallet resolves it on-chain.',
    });
  }
  if (f.hasQueuedExit) {
    notices.push({
      id: 'queued-exit',
      tone: 'warn',
      title: 'You have a queued, irrevocable exit.',
      body:
        'It becomes SETTLEABLE when the proposal executes or expires — whichever comes first — ' +
        'and settles at the NAV at that moment. Nothing settles it for you: settleQueuedExit(you) ' +
        'is an ordinary call that somebody has to make, and anybody can. Until it is made, those ' +
        'shares are locked, do not vote, and cannot be un-queued.',
    });
  }

  // ── deposit ──
  let deposit;
  if (!f.walletConnected && f.walletConnected !== undefined) deposit = no('Connect a wallet to deposit.', 'info');
  else if (f.frozen === true) deposit = no('Frozen — the deposit’s capacity check reads NAV, and NAV is unavailable while the oracle is stale.');
  else if (!f.attested) deposit = no('Unattested vault — deposits are withheld here until an operator is registered against it.');
  else if (f.capacityFull) deposit = no('At capacity — live NAV plus escrowed pending deposits already fill the cap.');
  else if (f.hasPendingDeposit) deposit = no('You already have a deposit in the observation window. Cancel or activate it first.', 'info');
  else if (freezeUnknown) deposit = warn('The freeze state cannot be read here. If a price source is stale, this reverts StaleOracle and costs you the gas.');
  else if (f.capacityKnown === false) deposit = warn('Remaining capacity cannot be read here, so this may revert CapacityExceeded.');
  else deposit = ok();

  // ── activate ──
  let activate;
  if (!f.hasPendingDeposit) activate = no('Nothing pending to activate.', 'info');
  else if (f.frozen === true) activate = no('Frozen — activation mints shares at activation NAV, which the oracle cannot price. Your escrow is safe and cancellable.');
  else if (!f.pendingMatured) activate = no('The 4-hour observation window has not elapsed yet.', 'info');
  else if (freezeUnknown) activate = warn('The freeze state cannot be read here — activation mints at NAV, so it reverts if a feed is stale. Cancelling always works.');
  else activate = ok();

  // ── cancelPending: the one guaranteed action, including under a freeze ──
  const cancelPending = f.hasPendingDeposit
    ? ok()
    : no('Nothing pending to cancel.', 'info');

  // ── exit ──
  let exit;
  if (!f.isMember) exit = no('You hold no shares in this vault.', 'info');
  else if (f.hasQueuedExit) exit = no('An exit is already queued — one at a time, and it cannot be cancelled or added to.', 'info');
  // The creator gate is applied at QUEUE time on the Mode-F branch too (VaultCore.sol:497-511,
  // the L-1 fix), so it must be evaluated BEFORE the mode branches — otherwise a gated creator is
  // handed an enabled "Queue irrevocable exit" for a call that reverts CreatorStakeGate.
  else if (f.isCreatorBelowGate)
    exit = no('Creator withdrawal gate — this redemption would take the creator below 5% of shares while other members remain. It is checked when the exit is QUEUED, not only when it settles.');
  else if (f.frozen === true && f.exitMode === 'F')
    exit = no(
      'Withheld while frozen. The contract would accept this queue, but a queued exit is ' +
      'irrevocable, strips your vote immediately, and could not settle until both the proposal ' +
      'resolves and the oracle recovers. There is no version of this that helps you today.',
    );
  else if (f.frozen === true) exit = no('Frozen — settlement prices your in-kind slice through the oracle, and the oracle is stale.');
  else if (f.exitMode === 'unknown')
    exit = warn('Mode unresolved — this may queue irrevocably. Read the confirmation carefully.');
  else if (f.exitMode === 'F')
    exit = warn('Queues irrevocably and settles later at a price not yet knowable.');
  else if (freezeUnknown)
    exit = warn('The freeze state cannot be read here. Settlement prices your in-kind slice through the oracle, so this reverts if a feed is stale.');
  else exit = ok();

  // ── skipWindow: never a standalone action (TRAP 2), and never under a freeze ──
  // With a pending deposit it falls straight through to `_activatePending → _mintShares →
  // navWad()`, which reverts StaleOracle — the same path `activate` is already gated on.
  let skipWindow;
  if (!f.hasPendingDeposit) skipWindow = no('Only offered as part of a deposit. On its own it would permanently burn your one-time opt-in and mint nothing.');
  else if (f.frozen === true) skipWindow = no('Frozen — skipping activates the pending deposit immediately, which mints at NAV and reverts while the oracle is stale.');
  else skipWindow = ok();

  // ── settleQueuedExit: an ordinary external call, and NOTHING invokes it as a side effect ──
  // `settleQueuedExit(member)` reverts ExecutionStillPending until `!_pendingExecution()`
  // (VaultCore.sol:531-539). A member who queues and waits holds locked, non-voting shares until
  // somebody makes this call — anybody can, but somebody must.
  let settleQueuedExit;
  if (!f.hasQueuedExit) settleQueuedExit = no('No queued exit to settle.', 'info');
  else if (f.frozen === true) settleQueuedExit = no('Frozen — settlement prices the in-kind slice through the oracle, so this reverts until the feeds recover.');
  else if (f.exitMode === 'F') settleQueuedExit = no('Not yet — the proposal is still pending execution, and this reverts ExecutionStillPending until it executes or expires.', 'info');
  else if (f.exitMode === 'unknown') settleQueuedExit = warn('Whether this can settle yet turns on the proposal state, which cannot be resolved from this data. It reverts harmlessly if it is too early.');
  else settleQueuedExit = ok();

  return { deposit, activate, cancelPending, exit, skipWindow, settleQueuedExit, notices };
}

/**
 * The single state word for a vault card. Ordered by how much it should change a decision, so
 * the most consequential fact wins the badge.
 * @param {VaultFacts} f
 * @returns {{key:string, label:string, tone:string, glyph:string}}
 */
export function vaultStatus(f) {
  if (!f.attested) return { key: 'unattested', label: 'Unattested', tone: 'critical', glyph: '▲' };
  if (f.frozen === true) return { key: 'frozen', label: 'Frozen', tone: 'frozen', glyph: '❄' };
  // "Open" is a claim about two things — that nothing is frozen and that an exit settles now.
  // Neither is knowable from an event-derived projection, so neither is asserted.
  if (f.exitMode === 'unknown') return { key: 'unknown', label: 'Exit mode unknown', tone: 'warn', glyph: '?' };
  if (f.frozen === null || f.frozen === undefined) return { key: 'freeze-unknown', label: 'Freeze state unknown', tone: 'warn', glyph: '?' };
  if (f.exitMode === 'F') return { key: 'modeF', label: 'Exits queue', tone: 'warn', glyph: '⏳' };
  if (f.capacityFull) return { key: 'full', label: 'At capacity', tone: 'muted', glyph: '■' };
  return { key: 'open', label: 'Open', tone: 'good', glyph: '●' };
}
