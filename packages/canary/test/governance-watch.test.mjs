// @ts-check
/**
 * Signal (h) — governance-watch (Monitoring Gap Analysis G8 / OPS-7).
 *
 * Every phase boundary below is copied from Governance.sol's own requires, and every deadline in
 * an alert is checked against the fixture's stored fields — the point of the signal is the
 * timestamps, so the tests pin them rather than the prose around them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkGovernanceWatch, phaseOf, timingOf, decodeProposal, decodeGovConfig, PHASES, SIGNAL,
} from '../src/signals/governance-watch.mjs';
import { createTransitionTracker } from '../src/transitions.mjs';
import { createTieredWebhookSink, emitAll } from '../src/sinks.mjs';
import {
  mockReader, log, healthyVault, proposalTuple,
  VAULT, GOVERNANCE, PROPOSER, GOV_CONFIG,
} from './helpers.mjs';

const NOW = 1_700_000_000;
const T0 = NOW - 600; // proposal opened ten minutes ago
const [COMMIT_S, REVEAL_S, TIMELOCK_S, EXEC_WINDOW_S] = GOV_CONFIG;
const ACTION = `0x${'ab'.repeat(32)}`;
const WINDOW = { fromBlock: 900, toBlock: 995 };

/** An Active proposal opened at T0 with the fixture config's 1h commit / 1h reveal. */
const activeProposal = (over = {}) => proposalTuple({
  createdAt: T0, commitDeadline: T0 + COMMIT_S, revealDeadline: T0 + COMMIT_S + REVEAL_S, status: 1, ...over,
});
/** A Passed proposal finalized at `finalizedAt`, with the fixture config's 1h timelock / 1d window. */
const passedProposal = (finalizedAt, over = {}) => proposalTuple({
  createdAt: T0, commitDeadline: T0 + COMMIT_S, revealDeadline: T0 + COMMIT_S + REVEAL_S,
  executableAt: finalizedAt + TIMELOCK_S, expiresAt: finalizedAt + TIMELOCK_S + EXEC_WINDOW_S, status: 2, ...over,
});

function readerWith({ pid = 1n, proposal, config = GOV_CONFIG, logs = [], nowSec = NOW, governance = {} } = {}) {
  const contracts = healthyVault({
    [GOVERNANCE]: {
      activeProposalOf: () => pid,
      configOf: () => config,
      proposals: () => proposal,
      ...governance,
    },
  });
  return mockReader({ contracts, logs, nowSec });
}

const run = (reader, nowSec = NOW) => checkGovernanceWatch({ reader, vault: VAULT, ...WINDOW, nowSec });
const alertsOf = (rs) => rs.filter((r) => r.status === 'alert');
const byKey = (rs, k) => rs.find((r) => r.key === k);

// ── pure helpers ─────────────────────────────────────────────────────────────

test('phaseOf copies the contract boundaries exactly: strict at commit/reveal, inclusive at the top of the execution window', () => {
  const p = decodeProposal(activeProposal());
  assert.equal(phaseOf(p, p.commitDeadline - 1), 'commit');
  assert.equal(phaseOf(p, p.commitDeadline), 'reveal', 'revealVote needs now >= commitDeadline');
  assert.equal(phaseOf(p, p.revealDeadline - 1), 'reveal');
  assert.equal(phaseOf(p, p.revealDeadline), 'tally', 'finalize needs now >= revealDeadline');

  const q = decodeProposal(passedProposal(NOW));
  assert.equal(phaseOf(q, q.executableAt - 1), 'timelock');
  assert.equal(phaseOf(q, q.executableAt), 'execution', 'execute needs now >= executableAt');
  assert.equal(phaseOf(q, q.expiresAt), 'execution', 'execute allows now == expiresAt');
  assert.equal(phaseOf(q, q.expiresAt + 1), 'lapsed', 'markExpired needs now > expiresAt');

  for (const status of [3, 4, 5]) {
    assert.equal(phaseOf(decodeProposal(activeProposal({ status })), NOW), null, `status ${status} is settled`);
  }
});

test('timingOf: a Passed proposal reports its stored executableAt; an Active one reports revealDeadline + timelock as a lower bound', () => {
  const cfg = decodeGovConfig(GOV_CONFIG);
  const active = decodeProposal(activeProposal());
  const t = timingOf(active, cfg, NOW);
  assert.equal(t.revealDeadline, T0 + COMMIT_S + REVEAL_S);
  assert.equal(t.earliestExecuteAt, T0 + COMMIT_S + REVEAL_S + TIMELOCK_S);
  assert.match(t.earliestExecuteBasis, /lower bound/);
  assert.equal(t.executionWindowClosesAt, null, 'no upper bound is claimed while finalize is still pending');

  // Once reveals have closed and nobody has finalized, the floor moves with the clock.
  const late = active.revealDeadline + 500;
  assert.equal(timingOf(active, cfg, late).earliestExecuteAt, late + TIMELOCK_S);

  const passed = decodeProposal(passedProposal(NOW));
  const u = timingOf(passed, cfg, NOW);
  assert.equal(u.earliestExecuteAt, NOW + TIMELOCK_S);
  assert.equal(u.earliestExecuteBasis, 'executableAt');
  assert.equal(u.executionWindowClosesAt, NOW + TIMELOCK_S + EXEC_WINDOW_S);
});

test('decodeProposal maps the tuple positionally and names both enums', () => {
  const p = decodeProposal(activeProposal({ ptype: 1, status: 2 }));
  assert.equal(p.ptype, 'RuleChange');
  assert.equal(p.status, 'Passed');
  assert.equal(p.proposer, PROPOSER);
  assert.equal(p.commitDeadline, T0 + COMMIT_S);
  assert.equal(p.actionHash, ACTION);
});

// ── quiet vault ──────────────────────────────────────────────────────────────

test('OK on every phase key when no proposal has ever been opened — and silent through the tracker', async () => {
  const results = await run(readerWith({ pid: 0n, proposal: proposalTuple({ status: 0 }) }));
  assert.equal(results.length, PHASES.length);
  assert.deepEqual(results.map((r) => r.key), [...PHASES]);
  assert.ok(results.every((r) => r.status === 'ok'));
  assert.equal(results[0].detail.pid, 0);
  assert.equal(results[0].detail.severity, 'SEV-2');

  const tracker = createTransitionTracker();
  assert.deepEqual(tracker.observe(results), [], 'a first-sighting OK announces nothing');
});

test('the shared healthy fixture reads OK — the signal adds no noise to every other test\'s healthy vault', async () => {
  const results = await run(mockReader({ contracts: healthyVault(), nowSec: NOW }));
  assert.ok(results.every((r) => r.status === 'ok'), results.map((r) => r.message).join('\n'));
});

// ── the six phases ───────────────────────────────────────────────────────────

test('ALERTS on the commit key when a proposal is open, with the reveal deadline and earliest execute in detail', async () => {
  const results = await run(readerWith({
    proposal: activeProposal(),
    logs: [log(GOVERNANCE, 'Proposed', 950, { pid: 1n, vault: VAULT, ptype: 0, proposer: PROPOSER, actionHash: ACTION }, { transactionHash: '0xproposed' })],
  }));
  const alerts = alertsOf(results);
  assert.equal(alerts.length, 1, 'exactly one phase pages');
  const a = alerts[0];
  assert.equal(a.signal, SIGNAL);
  assert.equal(a.key, 'commit');
  assert.match(a.message, /GOVERNANCE PROPOSAL OPEN/);
  assert.match(a.message, /proposal 1 \(Rebalance/);
  assert.match(a.message, new RegExp(`reveals close .*unix ${T0 + COMMIT_S + REVEAL_S}`));
  assert.match(a.message, new RegExp(`earliest execute .*unix ${T0 + COMMIT_S + REVEAL_S + TIMELOCK_S}`));
  assert.match(a.message, new RegExp(ACTION));

  const d = a.detail;
  assert.equal(d.pid, 1);
  assert.equal(d.phase, 'commit');
  assert.equal(d.governance, GOVERNANCE);
  assert.equal(d.revealDeadline, T0 + COMMIT_S + REVEAL_S);
  assert.equal(d.revealDeadlineIso, new Date((T0 + COMMIT_S + REVEAL_S) * 1000).toISOString());
  assert.equal(d.earliestExecuteAt, T0 + COMMIT_S + REVEAL_S + TIMELOCK_S);
  assert.equal(d.executionWindowClosesAt, null);
  assert.equal(d.modeFExitQueueing, false, 'Mode-F queueing starts at reveal start, not at propose');
  assert.equal(d.actionHash, ACTION);
  assert.equal(d.payloadOnChain, false);
  assert.deepEqual(d.config, { commitDuration: COMMIT_S, revealDuration: REVEAL_S, timelockDuration: TIMELOCK_S, executionWindow: EXEC_WINDOW_S });
  assert.equal(d.events.length, 1);
  assert.equal(d.events[0].event, 'Proposed');
  assert.equal(d.events[0].blockNumber, 950);
  assert.equal(d.events[0].txHash, '0xproposed');
  assert.deepEqual(d.threatModelRows, ['VO-7', 'VO-8', 'CM-6']);
  assert.equal(d.incident, 'OPS-7');

  // The other five phases read OK and say where the proposal actually is.
  for (const k of PHASES.filter((k) => k !== 'commit')) {
    assert.equal(byKey(results, k).status, 'ok');
    assert.match(byKey(results, k).message, /now in the commit phase/);
  }
});

test('ALERTS on the reveal key once chain time crosses commitDeadline, and flags Mode-F queueing', async () => {
  const now = T0 + COMMIT_S + 5;
  const results = await run(readerWith({ proposal: activeProposal(), nowSec: now }), now);
  const [a] = alertsOf(results);
  assert.equal(a.key, 'reveal');
  assert.match(a.message, /GOVERNANCE REVEAL PHASE/);
  assert.match(a.message, new RegExp(`in ${REVEAL_S - 5}s`));
  assert.equal(a.detail.modeFExitQueueing, true);
  assert.match(byKey(results, 'commit').message, /commit phase of proposal 1 .* is over; now in the reveal phase/);
});

test('ALERTS on the tally key when reveals have closed and nobody has called finalize', async () => {
  const now = T0 + COMMIT_S + REVEAL_S + 120;
  const results = await run(readerWith({ proposal: activeProposal(), nowSec: now }), now);
  const [a] = alertsOf(results);
  assert.equal(a.key, 'tally');
  assert.match(a.message, /AWAITING FINALIZE/);
  assert.match(a.message, /120s ago/);
  assert.match(a.message, /permissionless/);
  assert.equal(a.detail.earliestExecuteAt, now + TIMELOCK_S, 'the floor tracks the clock while finalize is pending');
});

test('ALERTS on the timelock key for a Passed proposal, with the stored executableAt and window close', async () => {
  const finalizedAt = NOW - 100;
  const results = await run(readerWith({
    proposal: passedProposal(finalizedAt),
    logs: [log(GOVERNANCE, 'Finalized', 990, { pid: 1n, status: 2 }, { transactionHash: '0xfin' })],
  }));
  const [a] = alertsOf(results);
  assert.equal(a.key, 'timelock');
  assert.match(a.message, /PASSED, IN TIMELOCK/);
  assert.match(a.message, new RegExp(`executable from .*unix ${finalizedAt + TIMELOCK_S}`));
  assert.equal(a.detail.earliestExecuteAt, finalizedAt + TIMELOCK_S);
  assert.equal(a.detail.earliestExecuteBasis, 'executableAt');
  assert.equal(a.detail.executionWindowClosesAt, finalizedAt + TIMELOCK_S + EXEC_WINDOW_S);
  assert.equal(a.detail.events[0].event, 'Finalized');
  assert.equal(a.detail.events[0].status, 'Passed');
  assert.equal(a.detail.modeFExitQueueing, true);
});

test('ALERTS on the execution key inside the window, and on lapsed past it', async () => {
  const finalizedAt = NOW - TIMELOCK_S - 10;
  const inWindow = await run(readerWith({ proposal: passedProposal(finalizedAt) }));
  const [a] = alertsOf(inWindow);
  assert.equal(a.key, 'execution');
  assert.match(a.message, /EXECUTABLE NOW/);
  assert.match(a.message, /hash-gated/);

  const late = finalizedAt + TIMELOCK_S + EXEC_WINDOW_S + 1;
  const lapsed = await run(readerWith({ proposal: passedProposal(finalizedAt), nowSec: late }), late);
  const [b] = alertsOf(lapsed);
  assert.equal(b.key, 'lapsed');
  assert.match(b.message, /LAPSED UNEXECUTED/);
  assert.equal(b.detail.modeFExitQueueing, false, 'hasPendingExecution is false past expiresAt');
});

test('a settled proposal reads OK on every key and names the outcome and its tx', async () => {
  for (const [status, name, ev] of [[4, 'Executed', 'Executed'], [3, 'Defeated', 'Finalized'], [5, 'Expired', 'ProposalExpired']]) {
    const results = await run(readerWith({
      proposal: passedProposal(NOW - 5000, { status }),
      logs: [log(GOVERNANCE, ev, 980, ev === 'Finalized' ? { pid: 1n, status: 3 } : { pid: 1n }, { transactionHash: `0x${name}` })],
    }));
    assert.ok(results.every((r) => r.status === 'ok'), name);
    assert.match(results[0].message, new RegExp(`settled as ${name} at block 980 \\(tx 0x${name}\\)`));
    assert.equal(results[0].detail.phase, null);
  }
});

// ── the lifecycle through the transition tracker: the lines an operator actually sees ──

test('a full lifecycle emits one ALERT per phase entered and one RECOVERED per phase left — nothing else', async () => {
  const tracker = createTransitionTracker();
  const lines = [];
  const sweep = async (reader, now, poll) => {
    const t = tracker.observe(await run(reader, now), { poll });
    lines.push(...t.map((x) => `${x.to}:${x.key}`));
  };

  await sweep(readerWith({ pid: 0n, proposal: proposalTuple({ status: 0 }) }), T0 - 60, 1);
  await sweep(readerWith({ proposal: activeProposal(), nowSec: T0 + 30 }), T0 + 30, 2);
  await sweep(readerWith({ proposal: activeProposal(), nowSec: T0 + 60 }), T0 + 60, 3); // still commit: silent
  const revealAt = T0 + COMMIT_S + 30;
  await sweep(readerWith({ proposal: activeProposal(), nowSec: revealAt }), revealAt, 4);
  const finalizedAt = T0 + COMMIT_S + REVEAL_S + 10;
  await sweep(readerWith({ proposal: passedProposal(finalizedAt), nowSec: finalizedAt + 5 }), finalizedAt + 5, 5);
  const execAt = finalizedAt + TIMELOCK_S + 5;
  await sweep(readerWith({ proposal: passedProposal(finalizedAt), nowSec: execAt }), execAt, 6);
  await sweep(readerWith({ proposal: passedProposal(finalizedAt, { status: 4 }), nowSec: execAt + 60 }), execAt + 60, 7);
  await sweep(readerWith({ proposal: passedProposal(finalizedAt, { status: 4 }), nowSec: execAt + 120 }), execAt + 120, 8); // settled: silent

  assert.deepEqual(lines, [
    'alert:commit',
    'ok:commit', 'alert:reveal',
    'ok:reveal', 'alert:timelock',
    'ok:timelock', 'alert:execution',
    'ok:execution',
  ]);
});

test('a restart mid-phase does not re-page: the persisted tracker state carries the phase', async () => {
  const first = createTransitionTracker();
  first.observe(await run(readerWith({ proposal: activeProposal() })), { poll: 1 });
  const restored = createTransitionTracker({ initial: JSON.parse(JSON.stringify(first.snapshot())) });
  assert.deepEqual(restored.observe(await run(readerWith({ proposal: activeProposal() })), { poll: 2 }), []);
});

// ── the detector, not the vault ──────────────────────────────────────────────

test('DETECTOR BROKEN when the vault does not answer governance() — never a false OK', async () => {
  const contracts = healthyVault();
  delete contracts[VAULT].governance;
  const [r] = await run(mockReader({ contracts, nowSec: NOW }));
  assert.equal(r.status, 'skipped');
  assert.equal(r.detail.detectorBroken, true);
  assert.match(r.message, /GOVERNANCE DETECTOR BLIND/);
});

test('DETECTOR BROKEN when governance() is the zero address or the module does not answer activeProposalOf()', async () => {
  const zero = healthyVault({ [VAULT]: { governance: `0x${'0'.repeat(40)}` } });
  const [z] = await run(mockReader({ contracts: zero, nowSec: NOW }));
  assert.equal(z.detail.detectorBroken, true);
  assert.match(z.message, /returned 0x0{40}/);

  const notGov = healthyVault({ [GOVERNANCE]: { activeProposalOf: { revert: '0xdeadbeef' } } });
  const [n] = await run(mockReader({ contracts: notGov, nowSec: NOW }));
  assert.equal(n.detail.detectorBroken, true);
  assert.match(n.message, /did not answer activeProposalOf/);
});

test('reads Governance through vault.governance() and never through any env — no address is assumed', async () => {
  const reader = readerWith({ proposal: activeProposal() });
  await run(reader);
  const govReads = reader.calls.filter((c) => c.kind === 'read' && c.address === GOVERNANCE).map((c) => c.fn);
  assert.deepEqual([...new Set(govReads)].sort(), ['activeProposalOf', 'configOf', 'proposals']);
  assert.ok(reader.calls.some((c) => c.address === VAULT && c.fn === 'governance'));
  assert.ok(reader.calls.every((c) => c.kind !== 'staticCall'), 'no eth_call impersonation — this signal only reads views');
});

test('ignores lifecycle events for OTHER proposals and other vaults in the same window', async () => {
  const OTHER_VAULT = `0x${'77'.repeat(20)}`;
  const results = await run(readerWith({
    proposal: activeProposal(),
    logs: [
      log(GOVERNANCE, 'Proposed', 950, { pid: 9n, vault: OTHER_VAULT, ptype: 0, proposer: PROPOSER, actionHash: ACTION }),
      log(GOVERNANCE, 'Executed', 951, { pid: 9n }),
      log(GOVERNANCE, 'Finalized', 952, { pid: 2n, status: 2 }),
    ],
  }));
  assert.deepEqual(alertsOf(results)[0].detail.events, []);
});

// ── read pinning (Review117 F4) ──────────────────────────────────────────────

test('every state read is PINNED to toBlock, so state and logs describe the same instant', async () => {
  const reader = readerWith({ proposal: activeProposal() });
  await run(reader);
  const reads = reader.calls.filter((c) => c.kind === 'read');
  // FOUR, not `>= 3`: `vault.governance()` is a read too, and a lower bound would let a read
  // DISAPPEAR while the pin assertion below stayed green (three pinned reads are still [toBlock]).
  // The assertion catches un-pinning; this guard catches removal, and a loose bound forfeits it.
  assert.equal(reads.length, 4, 'governance, activeProposalOf, proposals, configOf');
  assert.deepEqual(
    [...new Set(reads.map((c) => c.blockNumber))],
    [WINDOW.toBlock],
    'an unpinned read would come from `latest` while logs stop at toBlock — that is the wrong-tx attribution bug',
  );
});

test('an explicit atBlock overrides the default; null and undefined both fall through to it', async () => {
  const reader = readerWith({ proposal: activeProposal() });
  await checkGovernanceWatch({ reader, vault: VAULT, ...WINDOW, nowSec: NOW, atBlock: 42 });
  assert.deepEqual(
    [...new Set(reader.calls.filter((c) => c.kind === 'read').map((c) => c.blockNumber))],
    [42],
  );

  // `!= null` is the package idiom (nav-backing, share-conservation and reader all collapse the
  // two), so this signal must not be the one place where null and undefined diverge.
  for (const atBlock of [null, undefined]) {
    const r = readerWith({ proposal: activeProposal() });
    await checkGovernanceWatch({ reader: r, vault: VAULT, ...WINDOW, nowSec: NOW, atBlock });
    assert.deepEqual(
      [...new Set(r.calls.filter((c) => c.kind === 'read').map((c) => c.blockNumber))],
      [WINDOW.toBlock],
      `atBlock: ${atBlock} must fall through to the toBlock default`,
    );
  }
});

test('the settled line attributes to the LAST settling event in the pinned window, not to an earlier one', async () => {
  // Finalized(Passed) then Executed, both inside the window: the line must name the Executed tx.
  const results = await run(readerWith({
    proposal: passedProposal(NOW - 5000, { status: 4 }),
    logs: [
      log(GOVERNANCE, 'Finalized', 970, { pid: 1n, status: 2 }, { transactionHash: '0xfinalize' }),
      log(GOVERNANCE, 'Executed', 990, { pid: 1n }, { transactionHash: '0xexecute' }),
    ],
  }));
  assert.ok(results.every((r) => r.status === 'ok'));
  assert.match(results[0].message, /settled as Executed at block 990 \(tx 0xexecute\)/);
});

// ── skipped-phase wording (Review117 F5) ─────────────────────────────────────

test('a zero timelock does not claim a timelock phase "is over" — it says the phase never existed', async () => {
  // Governance caps timelockDuration but does not floor it, so finalize -> executable is legal.
  const cfg = [3600, 3600, 0, 86400, 2500, 500, 5000, 3600];
  const finalizedAt = NOW - 10;
  const results = await run(readerWith({
    proposal: passedProposal(finalizedAt, { executableAt: finalizedAt, expiresAt: finalizedAt + 86400 }),
    config: cfg,
  }));
  const [a] = alertsOf(results);
  assert.equal(a.key, 'execution', 'with no timelock the proposal is executable immediately');
  const timelock = byKey(results, 'timelock');
  assert.equal(timelock.status, 'ok');
  assert.match(timelock.message, /has no timelock phase — timelockDuration is 0/);
  assert.doesNotMatch(timelock.message, /is over/, 'a phase that never happened cannot be over');
});

test('the reveal-deadline hint is dropped once that deadline is in the past', async () => {
  const past = T0 + COMMIT_S + REVEAL_S + 900; // in the tally phase, reveals long closed
  const results = await run(readerWith({ proposal: activeProposal(), nowSec: past }), past);
  const commit = byKey(results, 'commit');
  assert.equal(commit.status, 'ok');
  assert.match(commit.message, /commit phase of proposal 1 .* is over/);
  assert.doesNotMatch(commit.message, /reveals close/, 'quoting a past deadline as if it were ahead is misleading');

  // While it IS ahead, the hint is still offered.
  const during = T0 + COMMIT_S + 30;
  const early = await run(readerWith({ proposal: activeProposal(), nowSec: during }), during);
  assert.match(byKey(early, 'commit').message, /reveals close/);
});

// ── end-to-end dispatch: real signal → real tracker → real tiered sink ───────
//
// The route test in sinks.test.mjs builds its transition as a literal, which is faithful only
// while `tierOf` reads nothing but `t.to` and `t.signal` — it would stop being faithful the moment
// this signal moved to CONDITIONAL_PAGE, because a predicate reads `result.detail`. This one uses
// no literals: the transitions are whatever the real signal and the real tracker produce, and the
// assertion is which URL physically received each POST. (Test design suggested by the Fix117
// session, which mutation-tested the sinks.mjs version and found this gap in it.)

test('a full lifecycle physically POSTs one PAGE per phase entry and every recovery to LOG', async () => {
  const tracker = createTransitionTracker();
  const posts = [];
  const sink = createTieredWebhookSink({
    pageUrl: 'https://example.invalid/page',
    logUrl: 'https://example.invalid/log',
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      posts.push({ endpoint: url.endsWith('/page') ? 'PAGE' : 'LOG', key: body.key, status: body.status });
      return { ok: true, status: 200 };
    },
  });

  const sweep = async (reader, now, poll) => {
    const transitions = tracker.observe(await run(reader, now), { poll });
    await emitAll([sink], transitions, { onError: () => { throw new Error('sink error'); } });
  };

  const finalizedAt = T0 + COMMIT_S + REVEAL_S + 10;
  const execAt = finalizedAt + TIMELOCK_S + 5;
  await sweep(readerWith({ pid: 0n, proposal: proposalTuple({ status: 0 }) }), T0 - 60, 1);
  await sweep(readerWith({ proposal: activeProposal(), nowSec: T0 + 30 }), T0 + 30, 2);
  await sweep(readerWith({ proposal: activeProposal(), nowSec: T0 + COMMIT_S + 30 }), T0 + COMMIT_S + 30, 3);
  await sweep(readerWith({ proposal: passedProposal(finalizedAt), nowSec: finalizedAt + 5 }), finalizedAt + 5, 4);
  await sweep(readerWith({ proposal: passedProposal(finalizedAt), nowSec: execAt }), execAt, 5);
  await sweep(readerWith({ proposal: passedProposal(finalizedAt, { status: 4 }), nowSec: execAt + 60 }), execAt + 60, 6);

  // Every ALERT — one per phase ENTERED — physically reached the pager.
  assert.deepEqual(
    posts.filter((p) => p.endpoint === 'PAGE').map((p) => p.key),
    ['commit', 'reveal', 'timelock', 'execution'],
    'four pages for a four-phase lifecycle: this is what "every occurrence PAGEs" means in practice',
  );
  // And every recovery went to the log sink, so leaving a phase never wakes anyone.
  assert.ok(posts.filter((p) => p.endpoint === 'LOG').length >= 4);
  assert.ok(
    posts.filter((p) => p.endpoint === 'LOG').every((p) => p.status === 'ok'),
    'only recoveries route LOG here — no ALERT may land on the log endpoint',
  );
  // Six keys observed every sweep is NOT six pages per sweep. That is the claim the PAGE tiering
  // rests on, so it is asserted rather than argued.
  assert.equal(posts.filter((p) => p.endpoint === 'PAGE').length, 4);
});

test('a blind governance detector does NOT page — recorded, not endorsed', async () => {
  // tierOf routes on `to === 'alert'`, and DETECTOR BROKEN is a `skipped`. So "no proposal on this
  // vault can be seen at all" reaches the log sink. That is the package-wide rule for every
  // signal's non-alert statuses; changing it is an escalation across all of them and Operations'
  // call. Pinned here so the behaviour is visible rather than discovered during an incident.
  const tracker = createTransitionTracker();
  const posts = [];
  const sink = createTieredWebhookSink({
    pageUrl: 'https://example.invalid/page', logUrl: 'https://example.invalid/log',
    fetchImpl: async (url) => { posts.push(url.endsWith('/page') ? 'PAGE' : 'LOG'); return { ok: true, status: 200 }; },
  });
  const contracts = healthyVault();
  delete contracts[VAULT].governance;
  const results = await run(mockReader({ contracts, nowSec: NOW }));
  assert.equal(results[0].detail.detectorBroken, true);
  await emitAll([sink], tracker.observe(results, { poll: 1 }), { onError: () => {} });
  assert.deepEqual(posts, ['LOG']);
});
