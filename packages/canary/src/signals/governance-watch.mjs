// @ts-check
/**
 * Signal (h) — GOVERNANCE WATCH. Closes Monitoring Gap Analysis G8 (Incident Catalogue OPS-7).
 *
 * The protocol's whole answer to governance capture is "publish analysis during the reveal
 * window" — and until this signal nothing said when a window had opened. A hostile proposal
 * could move through commit into reveal while both humans slept and consume the only defence
 * window the protocol has. This signal says, once per phase entry, that the clock is running and
 * exactly when it runs out.
 *
 * WHAT IT READS. `vault.governance()` (immutable) locates the Governance module, then
 * `activeProposalOf(vault)`, `proposals(pid)` and `configOf(vault)`. The phase is derived from
 * the proposal's stored deadlines against CHAIN time, never the host clock, because two of the
 * transitions that matter — commit→reveal and timelock→executable — are clock crossings that
 * emit no event. The four lifecycle events (`Proposed`, `Finalized`, `Executed`,
 * `ProposalExpired`) are scanned over the poll window for block/tx attribution only, with the
 * same `MAX_LOG_SPAN_BLOCKS` plumbing as `module-events`.
 *
 * TWO DIFFERENT GAPS, and only one of them is harmless. A LOG-WINDOW gap (the backlog exceeded
 * `MAX_LOG_SPAN_BLOCKS`) costs this signal a tx hash and never a page, because the phase is read
 * from state rather than from the events. A SWEEP gap — the canary process down long enough to
 * span a whole lifecycle — is different in kind: every phase key was OK before and is OK again
 * after, so the tracker emits NO transition and the proposal is never narrated at all. No
 * state-poller can recover that, and nothing here should claim otherwise; it is what the off-host
 * dead-man ping (`DEADMAN_PING_URL`) exists to make visible.
 *
 * Reads are PINNED to the same `toBlock` the log window ends at, the way `nav-backing` pins its
 * legs. Unpinned, state comes from `latest` while logs stop at `head - CONFIRMATIONS`, so a
 * proposal executed inside the confirmation lag reads `Executed` while its `Executed` log is still
 * outside the window — the line would then attribute the settlement to the earlier `Finalized` tx.
 * Pinning also means a `finalize`/`execute` reorged out of those last blocks cannot produce a
 * spurious ALERT→RECOVERED pair.
 *
 * SHAPE. One tracked key per PHASE (`commit`, `reveal`, `tally`, `timelock`, `execution`,
 * `lapsed`), every one of them emitted every sweep: the phase the proposal is in reads ALERT and
 * the other five read OK. Entering a phase is therefore one OK→ALERT line carrying the deadlines,
 * and leaving it is one ALERT→OK line saying where the proposal went. Low volume by construction, and the bound
 * is CM-6: `propose` requires the previous proposal to be settled (Governance.sol:278), so one
 * vault cannot have two proposals running at once however many proposers try — that, not the phase
 * durations, is what bounds pages per vault per hour, and it is also the answer to M-7's
 * per-proposer cooldown sidestep. Do NOT reach for "every phase is at least an hour": it is false.
 * `_validateConfig` floors `commitDuration`, `revealDuration` and `executionWindow` at 1 hour but
 * only CAPS `timelockDuration`, so a zero timelock is legal and that phase is skipped outright.
 *
 * DO NOT COLLAPSE THESE SIX KEYS INTO ONE, however tempting the line count looks. The transition
 * tracker keys state by `signal|vault|key` and emits on a STATUS change, so a single key holding a
 * changing message would emit nothing at all on commit→reveal — the vault is already `alert`, the
 * message text would silently start describing a different phase, and the reveal window, the one
 * the whole signal exists to announce, would open unannounced. The general form of that failure is
 * MASKING: with one key, any second condition arising while the first is still firing produces no
 * transition and therefore no page. Per-leg keys are the house pattern for exactly this reason —
 * `nav-backing` splits composition/custody, `oracle-freshness` and `feed-identity` split per asset.
 * (Argument sharpened by the PR #115 review, which found the masking case the hard way.)
 *
 * Every alert carries the reveal-window deadline and the earliest possible `execute` timestamp in
 * `detail`. The SEV-2 label comes from Monitoring Gap Analysis §3 item 5, which is the note that
 * assigns this signal a severity at all — the Severity Ladder's SEV-2 definition enumerates
 * OPS-1/2/3/5 and does not mention governance, and the Incident Catalogue's OPS-7 entry assigns no
 * tier; what the Ladder supplies is the 08:00–24:00 UTC waking-hours window quoted below.
 *
 * Routing lives in the sinks, not here: the signal name is in `PAGE_SIGNALS` (sinks.mjs), so an
 * ALERT from it reaches `PAGE_WEBHOOK_URL` while its recoveries and blind-detector lines go to
 * `LOG_WEBHOOK_URL`. The waking-hours half is the receiver's — this signal reports state, knows
 * nothing about the time of day, and makes no promise about who responds when.
 *
 * `governance() == 0` is a MISDEPLOYMENT, not a supported configuration. Neither VaultCore's
 * constructor nor VaultFactory zero-checks `governance_`, and `VaultCore._hasPendingExecution`
 * tolerates a broken governance by falling back to Mode I (H-1) — so such a vault is contractually
 * survivable, and this signal will re-assert DETECTOR BROKEN against it on the doubling backoff
 * indefinitely. That is the correct behaviour (a vault whose proposals cannot be seen is
 * unmonitored, not quiet), and the real deploy path always constructs a Governance, so the
 * standing alert means the deployment is wrong rather than the detector.
 *
 * NOT CHECKED, and why: whether the execution payload behind `actionHash` has been PUBLISHED
 * (security-ops §5.3). The payload is not on-chain until `execute` — `Proposed` carries only
 * its keccak — and there is no publication surface in this tree: the indexer folds the hash, the
 * API has no proposal route, and the reference agent's own evaluator says the payload is opaque
 * from chain state. There is nothing to read. `detail.actionHash` and `detail.payloadOnChain`
 * are carried so a receiver with an out-of-band payload source can do the comparison itself.
 */

import { VAULT_VIEWS, GOVERNANCE_VIEWS, GOVERNANCE_WATCH_EVENTS } from '../abis.mjs';
import { ok, alert, detectorBroken, shortAddr } from '../signal.mjs';

export const SIGNAL = 'governance-watch';

/** Phase keys, in lifecycle order. Each is its own transition key. */
export const PHASES = Object.freeze(['commit', 'reveal', 'tally', 'timelock', 'execution', 'lapsed']);

/** Governance.ProposalType and Governance.Status, by enum index. */
export const PROPOSAL_TYPES = Object.freeze(['Rebalance', 'RuleChange', 'ChildAllocation']);
export const STATUSES = Object.freeze(['None', 'Active', 'Passed', 'Defeated', 'Executed', 'Expired']);

const ZERO_ADDR = `0x${'0'.repeat(40)}`;
const [PROPOSED, FINALIZED, EXECUTED, PROPOSAL_EXPIRED] = GOVERNANCE_WATCH_EVENTS;

const num = (x) => Number(x ?? 0);
const iso = (sec) => new Date(num(sec) * 1000).toISOString();
const stamp = (sec) => `${iso(sec)} (unix ${num(sec)})`;
const secs = (n) => `${n}s`;

/** Flatten the `proposals(pid)` tuple viem returns into a named, plain-number record. */
export function decodeProposal(tuple) {
  const t = Array.isArray(tuple) ? tuple : Object.values(tuple ?? {});
  const ptype = num(t[1]);
  const status = num(t[8]);
  return {
    vault: t[0],
    ptype: PROPOSAL_TYPES[ptype] ?? `type#${ptype}`,
    proposer: t[2],
    createdAt: num(t[3]),
    commitDeadline: num(t[4]),
    revealDeadline: num(t[5]),
    executableAt: num(t[6]),
    expiresAt: num(t[7]),
    status: STATUSES[status] ?? `status#${status}`,
    actionHash: t[9],
    snapshotTotal: String(t[10] ?? 0),
    memberCount: num(t[11]),
    forWeight: String(t[12] ?? 0),
    againstWeight: String(t[13] ?? 0),
    revealedWeight: String(t[14] ?? 0),
    revealedVoterCount: num(t[15]),
  };
}

/** Flatten the `configOf(vault)` tuple. Only the four durations matter here. */
export function decodeGovConfig(tuple) {
  const t = Array.isArray(tuple) ? tuple : Object.values(tuple ?? {});
  return {
    commitDuration: num(t[0]),
    revealDuration: num(t[1]),
    timelockDuration: num(t[2]),
    executionWindow: num(t[3]),
  };
}

/**
 * Which phase a proposal is in at chain time `nowSec`, or null once it is settled. The
 * boundaries copy Governance.sol exactly: commits need `now < commitDeadline`, reveals need
 * `commitDeadline <= now < revealDeadline`, finalize needs `now >= revealDeadline`, execute needs
 * `executableAt <= now <= expiresAt` (inclusive at the top), and `markExpired` needs
 * `now > expiresAt`.
 * @param {ReturnType<typeof decodeProposal>} p
 * @param {number} nowSec
 */
export function phaseOf(p, nowSec) {
  if (p.status === 'Active') {
    if (nowSec < p.commitDeadline) return 'commit';
    if (nowSec < p.revealDeadline) return 'reveal';
    return 'tally';
  }
  if (p.status === 'Passed') {
    if (nowSec < p.executableAt) return 'timelock';
    if (nowSec <= p.expiresAt) return 'execution';
    return 'lapsed';
  }
  return null;
}

/**
 * The two timestamps the alert exists to deliver.
 *
 * `revealDeadline` is stored. `earliestExecuteAt` is stored only once the proposal has PASSED
 * (`executableAt`); while it is still Active the floor is `revealDeadline + timelockDuration`,
 * because `finalize` is permissionless and callable the second reveals close. That is a LOWER
 * bound: a late finalize pushes both the timelock and the execution window later, so no upper
 * bound is claimed for an Active proposal.
 * @param {ReturnType<typeof decodeProposal>} p
 * @param {ReturnType<typeof decodeGovConfig>} cfg
 * @param {number} nowSec
 */
export function timingOf(p, cfg, nowSec) {
  if (p.status === 'Passed') {
    return {
      revealDeadline: p.revealDeadline,
      earliestExecuteAt: p.executableAt,
      earliestExecuteBasis: 'executableAt',
      executionWindowClosesAt: p.expiresAt,
    };
  }
  if (p.status === 'Active') {
    const finalizeFloor = Math.max(nowSec, p.revealDeadline);
    return {
      revealDeadline: p.revealDeadline,
      earliestExecuteAt: finalizeFloor + cfg.timelockDuration,
      earliestExecuteBasis: 'revealDeadline+timelock (lower bound; a late finalize moves it later)',
      executionWindowClosesAt: null,
    };
  }
  return { revealDeadline: p.revealDeadline, earliestExecuteAt: null, earliestExecuteBasis: null, executionWindowClosesAt: null };
}

/** Shape one decoded log for `detail.events`. */
function eventRow(l) {
  const a = l.args ?? {};
  return {
    event: l.eventName,
    pid: a.pid != null ? num(a.pid) : undefined,
    ...(a.ptype != null ? { ptype: PROPOSAL_TYPES[num(a.ptype)] ?? `type#${num(a.ptype)}` } : {}),
    ...(a.proposer != null ? { proposer: a.proposer } : {}),
    ...(a.actionHash != null ? { actionHash: a.actionHash } : {}),
    ...(l.eventName === 'Finalized' ? { status: STATUSES[num(a.status)] ?? `status#${num(a.status)}` } : {}),
    blockNumber: num(l.blockNumber),
    txHash: l.transactionHash ?? null,
  };
}

/**
 * @param {Object} ctx
 * @param {any} ctx.reader
 * @param {string} ctx.vault
 * @param {number} ctx.fromBlock
 * @param {number} ctx.toBlock
 * @param {number} ctx.nowSec   chain time, from the reader — never the host clock
 * @param {number} [ctx.atBlock]  pin every state read to this height; defaults to `toBlock`, so
 *        state and logs describe the same instant. See the header for why that matters. Note this
 *        DEFAULTS, where `nav-backing`/`share-conservation` pin only when handed a number and
 *        otherwise read `latest` — this signal's reads must agree with its own log window.
 * @returns {Promise<import('../signal.mjs').SignalResult[]>}
 */
export async function checkGovernanceWatch({ reader, vault, fromBlock, toBlock, nowSec, atBlock }) {
  // Same instant for state and logs. `!= null` is the package's idiom — nav-backing.mjs,
  // share-conservation.mjs and reader.mjs all collapse null and undefined the same way — so both
  // mean "not specified" here too and fall through to the toBlock default. There is deliberately
  // NO third "explicitly unpinned" state: no caller passes one, and inventing one would make this
  // the only signal in the package where null and undefined differ.
  const pinned = atBlock != null ? atBlock : toBlock;
  const at = pinned != null ? { blockNumber: pinned } : {};
  const gov = await reader.tryRead(vault, VAULT_VIEWS, 'governance', [], at);
  if (!gov.ok || typeof gov.value !== 'string' || gov.value.toLowerCase() === ZERO_ADDR) {
    return [detectorBroken({
      signal: SIGNAL, vault,
      message: `GOVERNANCE DETECTOR BLIND on vault ${shortAddr(vault)}: governance() ${gov.ok ? `returned ${gov.value}` : `${gov.kind === 'transport' ? 'could not be read' : 'reverted'} (${gov.error ?? 'reverted'})`} — no proposal on this vault can be seen, so it is unmonitored for governance, not quiet`,
      detail: { vault, error: gov.ok ? `governance() = ${gov.value}` : gov.error ?? 'reverted', kind: gov.ok ? null : gov.kind ?? null },
    })];
  }
  const governance = gov.value;

  const active = await reader.tryRead(governance, GOVERNANCE_VIEWS, 'activeProposalOf', [vault], at);
  if (!active.ok) {
    return [detectorBroken({
      signal: SIGNAL, vault,
      // "It may not be a Governance contract" is an inference from a REVERT. A transport failure
      // supports no inference about what is deployed at that address, so it does not get one.
      message: active.kind === 'transport'
        ? `GOVERNANCE DETECTOR BLIND on vault ${shortAddr(vault)}: activeProposalOf() on Governance ${shortAddr(governance)} could not be read (${active.error ?? 'no error text'}) — the call did not reach the chain, so no revert was observed; the vault is unmonitored for governance this sweep, not quiet`
        : `GOVERNANCE DETECTOR BLIND on vault ${shortAddr(vault)}: Governance ${shortAddr(governance)} did not answer activeProposalOf() (${active.error ?? 'reverted'}) — it may not be a Governance contract; the vault is unmonitored for governance, not quiet`,
      detail: { vault, governance, error: active.error ?? 'reverted', kind: active.kind ?? null },
    })];
  }
  const pid = num(active.value);

  const window = { vault, governance, fromBlock, toBlock, nowSec, atBlock: pinned ?? null };
  const meta = { severity: 'SEV-2', incident: 'OPS-7', gap: 'G8', threatModelRows: ['VO-7', 'VO-8', 'CM-6'], payloadOnChain: false };

  // ── no proposal was ever opened on this vault ──
  if (pid === 0) {
    const proposed = await reader.getLogs({ address: governance, event: PROPOSED, args: { vault }, fromBlock, toBlock });
    const detail = { ...window, ...meta, pid: 0, events: proposed.map(eventRow) };
    return PHASES.map((phase) => ok({
      signal: SIGNAL, vault, key: phase,
      message: `no governance proposal has been opened on vault ${shortAddr(vault)}`,
      measured: 'no proposal', threshold: 'no active proposal', detail: { ...detail, phase: null },
    }));
  }

  const [rawProposal, rawCfg, proposed, finalized, executed, expired] = await Promise.all([
    reader.read(governance, GOVERNANCE_VIEWS, 'proposals', [BigInt(pid)], at),
    reader.read(governance, GOVERNANCE_VIEWS, 'configOf', [vault], at),
    reader.getLogs({ address: governance, event: PROPOSED, args: { vault }, fromBlock, toBlock }),
    reader.getLogs({ address: governance, event: FINALIZED, args: { pid: BigInt(pid) }, fromBlock, toBlock }),
    reader.getLogs({ address: governance, event: EXECUTED, args: { pid: BigInt(pid) }, fromBlock, toBlock }),
    reader.getLogs({ address: governance, event: PROPOSAL_EXPIRED, args: { pid: BigInt(pid) }, fromBlock, toBlock }),
  ]);
  const p = decodeProposal(rawProposal);
  const cfg = decodeGovConfig(rawCfg);
  const phase = phaseOf(p, nowSec);
  const timing = timingOf(p, cfg, nowSec);
  const events = [...proposed, ...finalized, ...executed, ...expired]
    .map(eventRow)
    .sort((a, b) => a.blockNumber - b.blockNumber);

  const detail = {
    ...window, ...meta,
    pid, phase, proposal: p, config: cfg, ...timing,
    revealDeadlineIso: iso(p.revealDeadline),
    earliestExecuteAtIso: timing.earliestExecuteAt != null ? iso(timing.earliestExecuteAt) : null,
    executionWindowClosesAtIso: timing.executionWindowClosesAt != null ? iso(timing.executionWindowClosesAt) : null,
    // VO-8: from reveal start until settlement an exit request queues in Mode F.
    modeFExitQueueing: phase != null && phase !== 'commit' && phase !== 'lapsed',
    actionHash: p.actionHash,
    events,
  };
  const who = `proposal ${pid} (${p.ptype}, by ${shortAddr(p.proposer)}) on vault ${shortAddr(vault)}`;
  const settledAt = events.filter((e) => e.event !== 'Proposed').at(-1);
  const settledWhere = settledAt ? ` at block ${settledAt.blockNumber}${settledAt.txHash ? ` (tx ${settledAt.txHash})` : ''}` : '';

  // ── settled: Defeated / Executed / Expired ──
  if (phase == null) {
    return PHASES.map((k) => ok({
      signal: SIGNAL, vault, key: k,
      message: `no governance proposal active on vault ${shortAddr(vault)}; ${who} settled as ${p.status}${settledWhere}`,
      measured: `proposal ${pid} ${p.status}`, threshold: 'no active proposal', detail,
    }));
  }

  const execFloor = timing.earliestExecuteAt != null ? `earliest execute ${stamp(timing.earliestExecuteAt)} (timelock ${secs(cfg.timelockDuration)})` : '';
  const messages = {
    commit: `GOVERNANCE PROPOSAL OPEN — ${who} is in the COMMIT phase since ${stamp(p.createdAt)}: commits close ${stamp(p.commitDeadline)} (in ${secs(p.commitDeadline - nowSec)}), reveals close ${stamp(p.revealDeadline)}; ${execFloor}; actionHash ${p.actionHash}`,
    reveal: `GOVERNANCE REVEAL PHASE — ${who} is in the REVEAL phase: reveals close ${stamp(p.revealDeadline)} (in ${secs(p.revealDeadline - nowSec)}); the running tally is readable on-chain and exit requests now queue in Mode-F; ${execFloor}; actionHash ${p.actionHash}`,
    tally: `GOVERNANCE AWAITING FINALIZE — ${who}: reveals closed ${stamp(p.revealDeadline)} (${secs(nowSec - p.revealDeadline)} ago) and finalize() has not been called; it is permissionless; ${execFloor}; actionHash ${p.actionHash}`,
    timelock: `GOVERNANCE PROPOSAL PASSED, IN TIMELOCK — ${who}: executable from ${stamp(p.executableAt)} (in ${secs(p.executableAt - nowSec)}), execution window closes ${stamp(p.expiresAt)}; execute() is permissionless and hash-gated on actionHash ${p.actionHash}`,
    execution: `GOVERNANCE PROPOSAL EXECUTABLE NOW — ${who}: execute() has been callable since ${stamp(p.executableAt)} and the window closes ${stamp(p.expiresAt)} (in ${secs(p.expiresAt - nowSec)}); permissionless, hash-gated on actionHash ${p.actionHash}`,
    lapsed: `GOVERNANCE PROPOSAL LAPSED UNEXECUTED — ${who} passed but nobody called execute() before the window closed ${stamp(p.expiresAt)} (${secs(nowSec - p.expiresAt)} ago); markExpired() is permissionless and the next propose() settles it; actionHash ${p.actionHash}`,
  };

  const current = PHASES.indexOf(phase);
  return PHASES.map((k, i) => {
    if (k === phase) {
      return alert({
        signal: SIGNAL, vault, key: k,
        message: messages[k],
        measured: `proposal ${pid} in ${k} phase`, threshold: 'no active proposal', detail,
      });
    }
    // `timelockDuration` has no floor (Governance caps it, nothing floors it), so a zero-timelock
    // proposal goes tally→execution and never has a timelock phase at all. Saying that phase "is
    // over" would assert something that never happened, so the skipped case is named instead.
    const skipped = k === 'timelock' && cfg.timelockDuration === 0;
    // Only offer the reveal deadline while it is still ahead; past it the hint reads as a stale
    // future date on every remaining line.
    const revealHint = nowSec < p.revealDeadline ? ` (reveals close ${stamp(p.revealDeadline)})` : '';
    const message = skipped
      ? `${who} has no ${k} phase — timelockDuration is 0, so it became executable at finalize; now in the ${phase} phase`
      : i < current
        ? `${k} phase of ${who} is over; now in the ${phase} phase${revealHint}`
        : `${who} has not reached the ${k} phase; now in the ${phase} phase`;
    return ok({
      signal: SIGNAL, vault, key: k,
      message, measured: `proposal ${pid} in ${phase} phase`, threshold: 'no active proposal', detail,
    });
  });
}
