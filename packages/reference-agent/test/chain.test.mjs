// @ts-check
/**
 * Chain-read tests.
 *
 * The two failures worth catching here are both SILENT ones:
 *   - an embedded ABI fragment drifting from the deployed contract, so a read decodes garbage
 *   - a positional mis-map of the 16-field `proposals(pid)` tuple, which would shift
 *     `revealDeadline` and make the agent schedule its reveal against the wrong timestamp —
 *     forfeiting the vote without ever throwing
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  GOVERNANCE_READ_ABI,
  OPERATOR_REGISTRY_READ_ABI,
  PROPOSAL_STATUS,
  PROPOSAL_TYPE,
  SUBVAULT_REGISTRY_READ_ABI,
  VAULT_READ_ABI,
  ZERO_BYTES32,
  createChainReader,
  createStubChainReader,
  decodeProposal,
} from '../src/chain.mjs';

const OUT = new URL('../../../contracts/out/', import.meta.url);

/** Compiled Foundry ABI for a contract, or null when contracts/out is absent. */
function compiledAbi(name) {
  const path = new URL(`${name}.sol/${name}.json`, OUT);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')).abi;
}

const sig = (f) => `${f.name}(${(f.inputs ?? []).map((i) => i.type).join(',')})`;
const outs = (f) => (f.outputs ?? []).map((o) => o.type).join(',');

/**
 * Cross-check every embedded fragment against the compiled contract — the same guard
 * packages/indexer/test/abis.test.mjs applies to its event fragments. A Solidity signature change
 * breaks this test instead of silently producing wrong reads at runtime.
 */
for (const [contract, abi] of [
  ['VaultCore', VAULT_READ_ABI],
  ['Governance', GOVERNANCE_READ_ABI],
  ['OperatorRegistry', OPERATOR_REGISTRY_READ_ABI],
  ['SubVaultRegistry', SUBVAULT_REGISTRY_READ_ABI],
]) {
  test(`${contract} read fragments match the compiled ABI (no drift)`, (t) => {
    const compiled = compiledAbi(contract);
    if (!compiled) return t.skip(`contracts/out/${contract}.sol is absent — run \`forge build\``);
    const byName = new Map(compiled.filter((e) => e.type === 'function').map((e) => [sig(e), e]));
    for (const frag of abi) {
      const found = byName.get(sig(frag));
      assert.ok(found, `${contract}.${sig(frag)} does not exist on the compiled contract`);
      assert.equal(outs(frag), outs(found), `${contract}.${sig(frag)} return types drifted`);
      assert.equal(found.stateMutability, 'view', `${contract}.${sig(frag)} is not a view function`);
    }
  });
}

test('the write fragments the actor uses also match the compiled ABI', async () => {
  const { VAULT_WRITE_ABI, GOVERNANCE_WRITE_ABI } = await import('../src/act.mjs');
  for (const [contract, abi] of [
    ['VaultCore', VAULT_WRITE_ABI],
    ['Governance', GOVERNANCE_WRITE_ABI],
  ]) {
    const compiled = compiledAbi(contract);
    if (!compiled) continue;
    const byName = new Map(compiled.filter((e) => e.type === 'function').map((e) => [sig(e), e]));
    for (const frag of abi) {
      const found = byName.get(sig(frag));
      assert.ok(found, `${contract}.${sig(frag)} does not exist — the agent would send a call that reverts`);
      assert.equal(found.stateMutability, 'nonpayable');
    }
  }
});

test('the enums match Governance.sol declaration order', () => {
  assert.deepEqual([...PROPOSAL_STATUS], ['None', 'Active', 'Passed', 'Defeated', 'Executed', 'Expired']);
  assert.deepEqual([...PROPOSAL_TYPE], ['Rebalance', 'RuleChange', 'ChildAllocation']);
});

/**
 * PINNED POSITIONS. viem returns a positional ARRAY for a multi-output function with unnamed
 * outputs, and `proposals` has sixteen fields. Each index is asserted individually with a distinct
 * value, so a single-slot shift fails loudly here instead of quietly at reveal time.
 */
test('decodeProposal maps all sixteen tuple positions correctly', () => {
  const raw = [
    '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // 0  vault
    2, // 1  ptype -> ChildAllocation
    '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', // 2  proposer
    1000n, // 3  createdAt
    2000n, // 4  commitDeadline
    3000n, // 5  revealDeadline   ← the one that forfeits votes if it shifts
    4000n, // 6  executableAt
    5000n, // 7  expiresAt
    3, // 8  status -> Defeated
    '0x' + 'cd'.repeat(32), // 9  actionHash
    11n, // 10 snapshotTotal
    12n, // 11 memberCount
    13n, // 12 forWeight
    14n, // 13 againstWeight
    15n, // 14 revealedWeight
    16n, // 15 revealedVoterCount
  ];
  const p = decodeProposal(raw);
  assert.equal(p.vault, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'addresses are canonicalised to lowercase');
  assert.equal(p.ptype, 2);
  assert.equal(p.ptypeName, 'ChildAllocation');
  assert.equal(p.proposer, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(p.createdAt, 1000);
  assert.equal(p.commitDeadline, 2000);
  assert.equal(p.revealDeadline, 3000);
  assert.equal(p.executableAt, 4000);
  assert.equal(p.expiresAt, 5000);
  assert.equal(p.status, 3);
  assert.equal(p.statusName, 'Defeated');
  assert.equal(p.actionHash, '0x' + 'cd'.repeat(32));
  assert.equal(p.snapshotTotal, 11n);
  assert.equal(p.memberCount, 12);
  assert.equal(p.forWeight, 13n);
  assert.equal(p.againstWeight, 14n);
  assert.equal(p.revealedWeight, 15n);
  assert.equal(p.revealedVoterCount, 16n);
});

test('decodeProposal also accepts a NAMED object, in case viem starts returning one', () => {
  const p = decodeProposal({ vault: '0x' + 'a'.repeat(40), ptype: 0, revealDeadline: 3000n, status: 1, commitDeadline: 2000n });
  assert.equal(p.revealDeadline, 3000);
  assert.equal(p.commitDeadline, 2000);
  assert.equal(p.statusName, 'Active');
});

// ── the reader's fault tolerance ────────────────────────────────────────────

/** A viem-shaped client that answers from a table and can be told to fail. */
function fakeClient(table, failing = new Set()) {
  return {
    calls: [],
    async readContract({ address, functionName, args }) {
      this.calls.push({ address, functionName, args });
      if (failing.has(functionName)) throw Object.assign(new Error('execution reverted'), { shortMessage: 'StaleOracle()' });
      const v = table[functionName];
      return typeof v === 'function' ? v(args) : v;
    },
  };
}

const TABLE = {
  navPerShareWad: 10n ** 18n,
  totalAssets: 1000n,
  totalShares: 900n,
  idleUsdc: 100n,
  totalPendingUsdc: 5n,
  capacityCapUsdc: 0n,
  isCapped: false,
  minDepositUsdc: 10n,
  OBSERVATION_WINDOW: 14400n,
  operatorRegistry: '0x' + 'e'.repeat(40),
  sharesOf: 42n,
  exitFeeBpsOf: 60n,
  queuedExitShares: 0n,
  windowCleared: true,
  skipOptIn: false,
  pendingDeposit: [0n, 0n],
  hasPendingExecution: false,
  activeProposalOf: 0n,
};

test('readVault returns a complete picture from a healthy chain', async () => {
  const reader = createChainReader({ client: fakeClient(TABLE) });
  const v = await reader.readVault('0x' + '1'.repeat(40), '0x' + '2'.repeat(40));
  assert.equal(v.navReadable, true);
  assert.equal(v.navPerShareWad, 10n ** 18n);
  assert.equal(v.idleUsdc, 100n);
  assert.equal(v.totalPendingUsdc, 5n);
  assert.equal(v.observationWindowSec, 14400);
  assert.equal(v.self.shares, 42n);
  assert.equal(v.self.exitFeeBps, 60);
});

test('a reverting navPerShareWad degrades one field and counts consecutive failures', async () => {
  // This is the oracle-freeze proxy: navPerShareWad reverts with StaleOracle when a price is
  // stale, so the failure IS the signal. It must not take the rest of the read down with it.
  const reader = createChainReader({ client: fakeClient(TABLE, new Set(['navPerShareWad'])) });
  const vault = '0x' + '1'.repeat(40);
  const a = await reader.readVault(vault, null);
  assert.equal(a.navReadable, false);
  assert.equal(a.navPerShareWad, null);
  assert.match(a.navError, /StaleOracle/);
  assert.equal(a.navConsecutiveFailures, 1);
  assert.equal(a.totalShares, 900n, 'the other reads must still succeed');

  const b = await reader.readVault(vault, null);
  assert.equal(b.navConsecutiveFailures, 2, 'consecutive failures accumulate per vault');
});

test('a recovered NAV read resets the failure counter', async () => {
  const failing = new Set(['navPerShareWad']);
  const reader = createChainReader({ client: fakeClient(TABLE, failing) });
  const vault = '0x' + '1'.repeat(40);
  await reader.readVault(vault, null);
  failing.delete('navPerShareWad');
  const ok = await reader.readVault(vault, null);
  assert.equal(ok.navConsecutiveFailures, 0);
});

test('pendingDeposit yields the REAL window end, not a guessed now+4h', async () => {
  const reader = createChainReader({ client: fakeClient({ ...TABLE, pendingDeposit: [25_000_000n, 1_700_000_000n] }) });
  const v = await reader.readVault('0x' + '1'.repeat(40), '0x' + '2'.repeat(40));
  assert.equal(v.self.pendingAmount, 25_000_000n);
  assert.equal(v.self.pendingAvailableAt, 1_700_000_000);
});

test('an outstanding commit is detected from CHAIN state alone (the restart path)', async () => {
  const commitment = '0x' + 'ab'.repeat(32);
  const client = fakeClient({
    ...TABLE,
    activeProposalOf: 42n,
    hasPendingExecution: true,
    proposals: ['0x' + 'a'.repeat(40), 0, '0x' + 'b'.repeat(40), 1n, 2n, 3n, 4n, 5n, 1, '0x' + 'cd'.repeat(32), 0n, 0n, 0n, 0n, 0n, 0n],
    commitOf: commitment,
    revealedOf: false,
  });
  const reader = createChainReader({ client, governance: '0x' + '9'.repeat(40) });
  const g = await reader.readGovernance('0x' + '1'.repeat(40), '0x' + '2'.repeat(40));
  assert.equal(g.hasOutstandingCommit, true);
  assert.equal(g.commitment, commitment);
  assert.equal(g.hasPendingExecution, true, 'this is what makes an exit Mode F');
  assert.equal(g.proposal.pid, 42n);
  assert.equal(g.proposal.revealDeadline, 3);
});

test('an empty commitment is NOT an outstanding commit', async () => {
  const client = fakeClient({ ...TABLE, activeProposalOf: 42n, proposals: new Array(16).fill(0n), commitOf: ZERO_BYTES32, revealedOf: false });
  const reader = createChainReader({ client, governance: '0x' + '9'.repeat(40) });
  const g = await reader.readGovernance('0x' + '1'.repeat(40), '0x' + '2'.repeat(40));
  assert.equal(g.hasOutstandingCommit, false);
});

test('an already-revealed commit is not outstanding', async () => {
  const client = fakeClient({ ...TABLE, activeProposalOf: 42n, proposals: new Array(16).fill(0n), commitOf: '0x' + 'ab'.repeat(32), revealedOf: true });
  const reader = createChainReader({ client, governance: '0x' + '9'.repeat(40) });
  const g = await reader.readGovernance('0x' + '1'.repeat(40), '0x' + '2'.repeat(40));
  assert.equal(g.hasOutstandingCommit, false);
});

test('governance reads are skipped, not crashed, when no address is configured', async () => {
  const reader = createChainReader({ client: fakeClient(TABLE) });
  const g = await reader.readGovernance('0x' + '1'.repeat(40), null);
  assert.equal(g.available, false);
});

test('the stub reader marks everything it produces', async () => {
  const reader = createStubChainReader({ ['0x' + '1'.repeat(40)]: { navPerShareWad: 5n } });
  const v = await reader.readVault('0x' + '1'.repeat(40), null);
  assert.equal(v.stub, true, 'stub values must be distinguishable from live ones in the narrative');
  assert.equal(v.navPerShareWad, 5n);
});

// ── read failures on the S-4 path must never read as "nothing to do" ─────────

test('a FAILED revealedOf read still yields an outstanding commit (fail toward revealing)', async () => {
  // The silent forfeiture this pins: `revealed === false` would require a SUCCESSFUL read, so one
  // RPC hiccup on revealedOf would drop the reveal obligation and the vote with it. An unnecessary
  // reveal attempt costs gas and reverts; a skipped one costs the vote.
  const client = fakeClient(
    { ...TABLE, activeProposalOf: 42n, proposals: new Array(16).fill(0n), commitOf: '0x' + 'ab'.repeat(32) },
    new Set(['revealedOf']),
  );
  const reader = createChainReader({ client, governance: '0x' + '9'.repeat(40) });
  const g = await reader.readGovernance('0x' + '1'.repeat(40), '0x' + '2'.repeat(40));
  assert.equal(g.revealed, null, 'the read failed, so this is unknown');
  assert.equal(g.hasOutstandingCommit, true, 'unknown must not be treated as already-revealed');
});

test('a FAILED commitOf read is reported as unknown, not as "no commit"', async () => {
  const client = fakeClient(
    { ...TABLE, activeProposalOf: 42n, proposals: new Array(16).fill(0n), revealedOf: false },
    new Set(['commitOf']),
  );
  const reader = createChainReader({ client, governance: '0x' + '9'.repeat(40) });
  const g = await reader.readGovernance('0x' + '1'.repeat(40), '0x' + '2'.repeat(40));
  assert.equal(g.commitUnknown, true);
  assert.equal(g.hasOutstandingCommit, false, 'we cannot claim a commit we did not read…');
});

test('a FAILED proposals read is flagged, so the agent does not report "no active proposal"', async () => {
  const client = fakeClient({ ...TABLE, activeProposalOf: 42n, commitOf: ZERO_BYTES32, revealedOf: false }, new Set(['proposals']));
  const reader = createChainReader({ client, governance: '0x' + '9'.repeat(40) });
  const g = await reader.readGovernance('0x' + '1'.repeat(40), '0x' + '2'.repeat(40));
  assert.equal(g.proposalUnknown, true);
  assert.equal(g.activePid, 42n, 'the pid read succeeded — we know something is there');
  assert.equal(g.proposal, null);
});

// ── voting weight is not the share balance ──────────────────────────────────

test('voting weight is read at the proposal SNAPSHOT, not as sharesOf now', async () => {
  const client = fakeClient({ ...TABLE, pastVotingEligibleShares: (args) => (args[1] === 1234n ? 777n : 0n) });
  const reader = createChainReader({ client });
  const w = await reader.readVotingWeight('0x' + '1'.repeat(40), '0x' + '2'.repeat(40), 1234);
  assert.equal(w, 777n);
  const call = client.calls.find((c) => c.functionName === 'pastVotingEligibleShares');
  assert.ok(call, 'must use the snapshot measure, the same one quorum uses');
  assert.equal(call.args[1], 1234n);
  assert.notEqual(w, TABLE.sharesOf, 'a share balance is not a voting weight');
});

test('with no snapshot timestamp it falls back to current voting-eligible stake', async () => {
  const client = fakeClient({ ...TABLE, votingEligibleShares: 5n });
  const reader = createChainReader({ client });
  assert.equal(await reader.readVotingWeight('0x' + '1'.repeat(40), '0x' + '2'.repeat(40)), 5n);
  assert.ok(client.calls.some((c) => c.functionName === 'votingEligibleShares'));
});

test('an unreadable voting weight is null, which the planner turns into a blocked commit', async () => {
  const reader = createChainReader({ client: fakeClient(TABLE, new Set(['pastVotingEligibleShares'])) });
  assert.equal(await reader.readVotingWeight('0x' + '1'.repeat(40), '0x' + '2'.repeat(40), 1n), null);
  assert.equal(await reader.readVotingWeight('0x' + '1'.repeat(40), null, 1n), null, 'no member, no weight');
});
