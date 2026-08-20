// @ts-check
/**
 * Planning — turn the perceived world into an ordered list of INTENTS.
 *
 * An intent is a description of a transaction, not a transaction: `{ kind, vault, args, dueAtSec,
 * reason }`. Dry-run prints intents and stops; execute mode hands the same list to the actor. One
 * representation for both modes is the point — what the operator reads in dry-run is exactly what
 * would be sent, not a parallel description of it that can drift.
 *
 * Ordering is risk-ordered, not vault-ordered:
 *   1. reveal            — an obligation already incurred; missing it forfeits the vote (S-4)
 *   2. settle-queued-exit — capital already committed to leaving, waiting to be released
 *   3. exit              — risk-off
 *   4. activate          — completes an entry already paid for
 *   5. commit            — a new obligation, taken on last
 *   6. deposit           — new capital, the only intent that increases exposure
 *
 * `dueAtSec` lets an intent be SCHEDULED rather than done now — the activate-after-window case and
 * the reveal case both need it. An intent with `dueAtSec > now` is reported and deferred, not run.
 *
 * **skipWindow is not in the vocabulary** unless `danger.allowSkipWindow` is explicitly true.
 * test/plan.test.mjs pins that the default config cannot produce one.
 */

import { decideEntry, decideExit, decideJoin, decideSettle, decideVote } from './policy.mjs';

/** Risk order — lower runs first. */
export const INTENT_ORDER = Object.freeze({
  reveal: 0,
  'settle-queued-exit': 1,
  exit: 2,
  activate: 3,
  'skip-window': 4,
  commit: 5,
  deposit: 6,
});

/**
 * @param {Object} p
 * @param {any} p.world     output of perceive()
 * @param {any} p.config
 * @param {Map<string, bigint>} [p.entryMarks]  vault ⇒ NAV/share at entry (drawdown baseline)
 * @param {any} p.log
 * @returns {{intents:Array<any>, decisions:Array<any>}}
 */
export function plan({ world, config, entryMarks = new Map(), log }) {
  const nowSec = world.nowSec;
  const intents = [];
  const decisions = [];
  let heldVaultCount = world.heldVaultCount ?? 0;

  for (const o of world.vaults) {
    const vault = o.chain.vault;
    const short = vault.slice(0, 10) + '…';
    const shares = o.chain?.self?.shares == null ? 0n : BigInt(o.chain.self.shares);
    const held = shares > 0n;
    const pending = o.chain?.self?.pendingAmount != null && BigInt(o.chain.self.pendingAmount) > 0n;

    // ── governance first: a reveal we owe outranks everything ─────────────────
    const vote = decideVote({
      governance: o.governance,
      chain: o.chain,
      // Snapshot-measured voting weight, NOT the share balance: shares deposited after the
      // proposal opened, still in the observation window, or locked behind a Mode-F exit carry no
      // vote. An unreadable weight falls to 0, which blocks a commit — failing closed.
      votingWeight: o.votingWeight ?? 0n,
      nowSec,
      config: config.policy.vote,
      timing: config.policy.timing,
    });
    decisions.push({ vault, kind: 'vote', ...vote });

    if (vote.action === 'reveal') {
      intents.push({
        kind: 'reveal',
        vault,
        pid: o.governance.proposal.pid,
        // support and salt are recovered from the chain commitment at act time (salt.recoverVote):
        // the agent holds no vote state, so a restart cannot lose it.
        args: { pid: o.governance.proposal.pid },
        dueAtSec: nowSec,
        urgent: vote.urgent,
        reason: vote.reason,
      });
      log.decide(`${short} REVEAL owed on proposal ${o.governance.proposal.pid} — ${vote.reason}`);
    } else if (vote.action === 'commit') {
      intents.push({
        kind: 'commit',
        vault,
        pid: o.governance.proposal.pid,
        args: { pid: o.governance.proposal.pid, support: vote.support },
        dueAtSec: nowSec,
        reason: vote.reason,
      });
      log.decide(`${short} COMMIT ${vote.support ? 'FOR' : 'AGAINST'} proposal ${o.governance.proposal.pid} — ${vote.reason}`);
    } else if (o.governance?.proposal || vote.degraded) {
      // A degraded verdict is a warning, not an informational line: it means the agent could not
      // determine whether it owes a reveal.
      (vote.degraded ? log.warn : log.decide)(`${short} no vote action — ${vote.reason}`);
    }

    // ── Mode F: release shares already queued behind an executed rebalance ────
    const settle = decideSettle({ chain: o.chain, governance: o.governance });
    if (settle.action === 'settle-queued-exit') {
      decisions.push({ vault, kind: 'settle', ...settle });
      intents.push({ kind: 'settle-queued-exit', vault, args: { member: world.member }, dueAtSec: nowSec, reason: settle.reason });
      log.decide(`${short} SETTLE queued exit — ${settle.reason}`);
    }

    // ── exit / join are mutually exclusive per vault ──────────────────────────
    if (held) {
      const exit = decideExit({
        chain: o.chain,
        entryNavPerShareWad: entryMarks.get(vault) ?? null,
        operatorRow: o.operatorRow,
        governance: o.governance,
        config: config.policy.exit,
      });
      decisions.push({ vault, kind: 'exit', ...exit });
      log.checks(`${short} exit triggers:`, exit.triggers);
      if (exit.exit) {
        intents.push({
          kind: 'exit',
          vault,
          args: { shares },
          dueAtSec: nowSec,
          modeF: exit.modeF,
          reason:
            exit.reason +
            (exit.modeF
              ? ' — WARNING: a passed-but-unexecuted rebalance exists, so this exit is Mode F: shares lock and settle at POST-rebalance NAV, not the price seen now (ARCHITECTURE §4.4)'
              : ' — Mode I: instant, in-kind pro-rata basket'),
        });
        log.decide(`${short} EXIT — ${exit.reason}${exit.modeF ? ' [MODE F: forward-priced]' : ''}`);
      }
    } else if (pending) {
      // ── entry lifecycle: schedule the activate, never skip the window ───────
      const entry = decideEntry({ chain: o.chain, nowSec, timing: config.policy.timing, danger: config.danger });
      decisions.push({ vault, kind: 'entry', ...entry });
      if (entry.action === 'activate')
        intents.push({ kind: 'activate', vault, args: { member: world.member }, dueAtSec: entry.dueAtSec ?? nowSec, reason: entry.reason });
      else if (entry.action === 'skip-window')
        intents.push({ kind: 'skip-window', vault, args: {}, dueAtSec: nowSec, irreversible: true, reason: entry.reason });
      else if (entry.action === 'wait')
        // Still an intent: it is the scheduled activate, reported now and due later. The operator
        // sees the deadline in dry-run instead of discovering it when the loop finally fires.
        intents.push({ kind: 'activate', vault, args: { member: world.member }, dueAtSec: entry.dueAtSec ?? nowSec, scheduled: true, reason: entry.reason });
      log.decide(`${short} entry: ${entry.action} — ${entry.reason}`);
    } else {
      const join = decideJoin({
        vault: o.summary,
        chain: o.chain,
        operatorRow: o.operatorRow,
        registryOperatorId: o.registryOperatorId,
        fees: o.fees,
        heldVaultCount,
        config: config.policy.join,
      });
      decisions.push({ vault, kind: 'join', ...join });
      log.checks(`${short} join gates:`, join.checks);
      if (join.join) {
        intents.push({ kind: 'deposit', vault, args: { amountUsdc: join.depositUsdc }, dueAtSec: nowSec, reason: join.reason });
        // A deposit that lands counts against the concurrency limit for the rest of this pass —
        // otherwise a single tick could join every vault at once and blow past maxConcurrentVaults.
        heldVaultCount += 1;
        log.decide(`${short} JOIN — deposit ${join.depositUsdc} base units; ${join.reason}`);
      } else {
        log.decide(`${short} no join — ${join.reason}`);
      }
    }
  }

  intents.sort((a, b) => (INTENT_ORDER[a.kind] ?? 99) - (INTENT_ORDER[b.kind] ?? 99) || a.dueAtSec - b.dueAtSec);
  return { intents, decisions };
}

/** Split a plan into what runs on this tick and what is scheduled for a later one. */
export function partitionDue(intents, nowSec) {
  const due = [];
  const deferred = [];
  for (const i of intents) (i.dueAtSec <= nowSec ? due : deferred).push(i);
  return { due, deferred };
}
