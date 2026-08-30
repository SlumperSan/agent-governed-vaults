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
 * @property {boolean} frozen              oracle breaker tripped for one of the basket assets
 * @property {boolean} attested            operatorId !== 0
 * @property {'I'|'F'|'unknown'} exitMode  from governance.resolveExitMode
 * @property {boolean} isMember            holds shares
 * @property {boolean} hasPendingDeposit
 * @property {boolean} pendingMatured      observation window elapsed
 * @property {boolean} hasQueuedExit       a Mode-F exit is already queued (one at a time)
 * @property {boolean} capacityFull
 * @property {boolean} [isCreatorBelowGate] creator whose redemption would breach the 5% gate
 * @property {boolean} [walletConnected]
 */

/** @typedef {{available:boolean, reason:string, severity:'ok'|'info'|'warn'|'blocked'}} Verdict */

const ok = () => /** @type {Verdict} */ ({ available: true, reason: '', severity: 'ok' });
const no = (reason, severity = 'blocked') => /** @type {Verdict} */ ({ available: false, reason, severity });

/**
 * @param {VaultFacts} f
 * @returns {{deposit:Verdict, activate:Verdict, cancelPending:Verdict, exit:Verdict,
 *            skipWindow:Verdict, notices:Array<{id:string,tone:string,title:string,body:string}>}}
 */
export function actions(f) {
  const notices = [];

  if (f.frozen) {
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
        'This vault has an active proposal, and whether an exit settles instantly or is queued ' +
        'irrevocably depends on its commit deadline — which the metered API does not carry. ' +
        'Treat an exit here as possibly irrevocable until your wallet resolves it on-chain.',
    });
  }
  if (f.hasQueuedExit) {
    notices.push({
      id: 'queued-exit',
      tone: 'warn',
      title: 'You have a queued, irrevocable exit.',
      body:
        'It settles automatically when the proposal executes or expires — whichever comes first ' +
        '— at the NAV at that moment. Those shares no longer vote and cannot be un-queued.',
    });
  }

  // ── deposit ──
  let deposit;
  if (!f.walletConnected && f.walletConnected !== undefined) deposit = no('Connect a wallet to deposit.', 'info');
  else if (f.frozen) deposit = no('Frozen — the deposit’s capacity check reads NAV, and NAV is unavailable while the oracle is stale.');
  else if (!f.attested) deposit = no('Unattested vault — deposits are withheld here until an operator is registered against it.');
  else if (f.capacityFull) deposit = no('At capacity — live NAV plus escrowed pending deposits already fill the cap.');
  else if (f.hasPendingDeposit) deposit = no('You already have a deposit in the observation window. Cancel or activate it first.', 'info');
  else deposit = ok();

  // ── activate ──
  let activate;
  if (!f.hasPendingDeposit) activate = no('Nothing pending to activate.', 'info');
  else if (f.frozen) activate = no('Frozen — activation mints shares at activation NAV, which the oracle cannot price. Your escrow is safe and cancellable.');
  else if (!f.pendingMatured) activate = no('The 4-hour observation window has not elapsed yet.', 'info');
  else activate = ok();

  // ── cancelPending: the one guaranteed action, including under a freeze ──
  const cancelPending = f.hasPendingDeposit
    ? ok()
    : no('Nothing pending to cancel.', 'info');

  // ── exit ──
  let exit;
  if (!f.isMember) exit = no('You hold no shares in this vault.', 'info');
  else if (f.hasQueuedExit) exit = no('An exit is already queued — one at a time, and it cannot be cancelled or added to.', 'info');
  else if (f.frozen && f.exitMode === 'F')
    exit = no(
      'Withheld while frozen. The contract would accept this queue, but a queued exit is ' +
      'irrevocable, strips your vote immediately, and could not settle until both the proposal ' +
      'resolves and the oracle recovers. There is no version of this that helps you today.',
    );
  else if (f.frozen) exit = no('Frozen — settlement prices your in-kind slice through the oracle, and the oracle is stale.');
  else if (f.exitMode === 'unknown')
    exit = { available: true, reason: 'Mode unresolved — this may queue irrevocably. Read the confirmation carefully.', severity: 'warn' };
  else if (f.exitMode === 'F')
    exit = { available: true, reason: 'Queues irrevocably and settles later at a price not yet knowable.', severity: 'warn' };
  else if (f.isCreatorBelowGate)
    exit = no('Creator withdrawal gate — this redemption would take the creator below 5% of shares while other members remain.');
  else exit = ok();

  // ── skipWindow: never a standalone action (TRAP 2) ──
  const skipWindow = f.hasPendingDeposit
    ? ok()
    : no('Only offered as part of a deposit. On its own it would permanently burn your one-time opt-in and mint nothing.');

  return { deposit, activate, cancelPending, exit, skipWindow, notices };
}

/**
 * The single state word for a vault card. Ordered by how much it should change a decision, so
 * the most consequential fact wins the badge.
 * @param {VaultFacts} f
 * @returns {{key:string, label:string, tone:string, glyph:string}}
 */
export function vaultStatus(f) {
  if (!f.attested) return { key: 'unattested', label: 'Unattested', tone: 'critical', glyph: '▲' };
  if (f.frozen) return { key: 'frozen', label: 'Frozen', tone: 'frozen', glyph: '❄' };
  if (f.exitMode === 'unknown') return { key: 'unknown', label: 'Exit mode unknown', tone: 'warn', glyph: '?' };
  if (f.exitMode === 'F') return { key: 'modeF', label: 'Exits queue', tone: 'warn', glyph: '⏳' };
  if (f.capacityFull) return { key: 'full', label: 'At capacity', tone: 'muted', glyph: '■' };
  return { key: 'open', label: 'Open', tone: 'good', glyph: '●' };
}
