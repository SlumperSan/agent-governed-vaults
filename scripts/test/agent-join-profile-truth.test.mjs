// @ts-check
/**
 * The `unproven-operator` join profile: what the docs say it does is what the code does, and the
 * Governance facts its risk text rests on are still true of contracts/src/Governance.sol.
 *
 * The risk text (`UNPROVEN_OPERATOR_RISK`, printed in the dry-run banner and beside every join
 * decision) makes three claims about `Governance.finalize`. A claim about a contract is a claim that
 * can go stale when the contract changes, so each one is pinned here to the source it was read from:
 * a change to the sub-five regime, to the lone-holder majority branch or to the RuleChange
 * consensus rule turns this red and sends someone to re-read the text.
 *
 * The doc half pins the profile's documented properties and the `discovery.logs` defaults to the
 * config, so the table in REFERENCE-AGENT.md cannot drift from `DEFAULT_CONFIG`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG, JOIN_PROFILES, UNPROVEN_OPERATOR_PROFILE } from '../../packages/reference-agent/src/config.mjs';
import { UNPROVEN_OPERATOR_RISK } from '../../packages/reference-agent/src/policy.mjs';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const governance = read('contracts/src/Governance.sol');
const reference = read('docs/REFERENCE-AGENT.md');
const quickstart = read('docs/AGENT-QUICKSTART.md');

/** The body of `finalize`, from its signature to the Finalized event. */
const finalizeBody = () => {
  const start = governance.indexOf('function finalize(uint256 pid)');
  const end = governance.indexOf('emit Finalized(pid, p.status);', start);
  assert.ok(start > 0 && end > start, 'Governance.finalize was not found: the risk text cites it');
  return governance.slice(start, end);
};

test('Governance.finalize: the sub-five regime starts below five members at creation', () => {
  assert.match(governance, /uint256 public constant SIGNER_REGIME_BELOW = 5;/);
  assert.match(finalizeBody(), /else if \(p\.memberCount < SIGNER_REGIME_BELOW\)/);
});

test('Governance.finalize: below five a proposal passes on a head majority with stake, or on FOR stake above half of the snapshot', () => {
  const body = finalizeBody();
  assert.match(body, /bool headMajorityWithStake = p\.revealedVoterCount \* 2 > p\.memberCount\s*&& selfDirectedFor \* BPS >= uint256\(configOf\[p\.vault\]\.quorumBps\) \* p\.snapshotTotal;/);
  assert.match(body, /bool forStakeMajority = selfDirectedFor \* 2 > p\.snapshotTotal;/);
  assert.match(body, /quorumOk = headMajorityWithStake \|\| forStakeMajority;/);
});

test('Governance.finalize: meeting quorum is not passing, FOR weight must also exceed AGAINST weight, and the docs say so instead of "passes on" the quorum branches', () => {
  assert.match(finalizeBody(), /if \(quorumOk && p\.forWeight > p\.againstWeight\) \{\s*p\.status = Status\.Passed;/);
  const flat = reference.replace(/\s+/g, ' ');
  const at = flat.indexOf('**The risk you accept.**');
  assert.ok(at > 0, 'the risk paragraph is missing');
  const risk = flat.slice(at, flat.indexOf('**What the track record can and cannot say.**', at));
  assert.match(risk, /Quorum is met on a strict majority of the members at creation revealing with the FOR stake clearing the quorum share, or on FOR stake above half of the snapshot, and a proposal that meets quorum passes only when its FOR weight is above its AGAINST weight/);
  assert.doesNotMatch(risk, /it passes on/, 'the two sub-five branches decide quorum only; at the live quorumBps (2500) branch 1 can be met and the proposal still lose on FOR against AGAINST');
});

test('Governance.finalize: a RuleChange needs every unit of snapshot stake revealed, all of it FOR', () => {
  const body = finalizeBody();
  assert.match(body, /if \(p\.ptype == ProposalType\.RuleChange\) \{/);
  assert.match(body, /quorumOk = p\.revealedWeight == p\.snapshotTotal && p\.forWeight >= p\.snapshotTotal;/);
});

test('the risk text states exactly those three facts, and no "stake-weighted" claim', () => {
  const text = UNPROVEN_OPERATOR_RISK.join(' ');
  assert.match(text, /Below five holders/);
  assert.match(text, /depends on stake and on how many addresses vote/);
  assert.match(text, /only holder, a depositor holds more than half of eligible stake/);
  assert.match(text, /whoever joins first holds the deciding vote on Rebalance proposals/);
  assert.match(text, /RuleChange needs every unit of eligible stake to reveal in favour/);
  assert.doesNotMatch(text, /stake-weighted/i);
});

test('the profile is exactly requireProvenOperator: false; the deposit pin and the exit are enforced elsewhere and documented as such', () => {
  assert.deepEqual(JOIN_PROFILES[UNPROVEN_OPERATOR_PROFILE], { policy: { join: { requireProvenOperator: false } } });
  assert.equal(DEFAULT_CONFIG.policy.join.profile, null, 'off by default');
  assert.equal(DEFAULT_CONFIG.policy.join.requireProvenOperator, true, 'the default refusal stays');
  assert.equal(DEFAULT_CONFIG.policy.exit.onOperatorNetNegative, true);
  const section = reference.slice(reference.indexOf('### Joining a vault with no track record'), reference.indexOf('### `policy.exit`'));
  assert.ok(section.length > 500, 'the REFERENCE-AGENT section is missing');
  assert.doesNotMatch(section, /whatever `depositUsdc` says/, 'the deposit is bounded by depositUsdc, so "whatever depositUsdc says" would be false');
  for (const claim of [
    '`"unproven-operator"`',
    'sets `requireProvenOperator` to `false`',
    "deposits exactly the vault's own `minDepositUsdc`",
    'refuses a\n  vault whose minimum is above `depositUsdc`',
    '`deposit-within-ceiling`',
    'keeps `policy.exit.onOperatorNetNegative` on',
    'prints the risk below in the dry-run banner',
    '`outside-track-record`',
    'An unread range is a gap,\n  never "zero realizations"',
  ])
    assert.ok(section.includes(claim), `REFERENCE-AGENT.md no longer says: ${claim}`);
});

test('the empty-list sentence does not say the outside figure equals the registry own: the window starts at this vault, the registry accumulators are lifetime', () => {
  const flat = reference.replace(/\s+/g, ' ');
  const at = flat.indexOf('While the list is empty');
  assert.ok(at > 0, 'the empty-list sentence is missing');
  const sentence = flat.slice(at, flat.indexOf('The figure is read when', at));
  assert.doesNotMatch(sentence, /figure equals the registry/, 'the figure covers only the blocks from this vault creation, so it is not unconditionally the registry figure');
  assert.match(sentence, /sum over every realization the scan read, from this vault's creation block to the head/);
  assert.match(sentence, /equals the registry's own figure unless the operator realized before that block, in an older vault, and then the two differ/);
});

test('an operator has no record only on its first vault: attestVault reuses the operator id, so no doc or risk line says a new vault starts with none', () => {
  const registry = read('contracts/src/OperatorRegistry.sol');
  const attest = registry.slice(registry.indexOf('function attestVault('), registry.indexOf('function operatorOf('));
  assert.ok(attest.length > 100, 'OperatorRegistry.attestVault was not found: the docs cite it');
  assert.match(attest, /uint256 opId = operatorIdOf\[operator\];\s*if \(opId == 0\) opId = registerOperator\(operator\);/, 'the operator id is reused, so a later vault of the same operator inherits its record');
  const flat = (s) => s.replace(/\s+/g, ' ');
  assert.ok(flat(reference).includes('The first vault of an operator with no earlier vault has an operator with no realized gain or loss'));
  assert.ok(flat(quickstart).includes('so the first vault of a new operator starts with none.'));
  assert.ok(UNPROVEN_OPERATOR_RISK[0].includes('the first vault of a new operator starts there'));
  for (const [name, text] of [['REFERENCE-AGENT.md', reference], ['AGENT-QUICKSTART.md', quickstart], ['the risk text', UNPROVEN_OPERATOR_RISK.join(' ')]])
    assert.doesNotMatch(flat(text), /vault created today/, `${name} says a vault created today has no record, which is false for an operator with an earlier vault`);
});

test('the discovery.logs table in REFERENCE-AGENT.md carries the config defaults', () => {
  const logs = DEFAULT_CONFIG.discovery.logs;
  for (const [knob, value] of Object.entries(logs)) {
    const row = reference.split('\n').find((l) => l.startsWith(`| \`${knob}\` |`));
    assert.ok(row, `no table row for discovery.logs.${knob}`);
    assert.ok(row.includes(`\`${value}\``), `the ${knob} row does not show the default ${value}: ${row}`);
  }
  assert.equal(Object.keys(logs).length, 4, 'a new discovery.logs knob needs a documented row');
});

test('the measured RPC limits are recorded for both Arc RPCs, and the quickstart points at the section', () => {
  assert.match(reference, /`https:\/\/rpc\.mainnet\.arc\.io` \| 9,999 blocks \(a page of 10,000\) \| `-32012 "requested range too large"`/);
  assert.match(reference, /`https:\/\/arc\.gateway\.tenderly\.co` \| 100,000 blocks \| `-32602 "query exceeds max block range 100000"`/);
  assert.ok(quickstart.includes('REFERENCE-AGENT.md#joining-a-vault-with-no-track-record'));
  assert.ok(quickstart.includes('unproven-operator'));
});
