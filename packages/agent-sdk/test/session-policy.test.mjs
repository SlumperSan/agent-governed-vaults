// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toFunctionSelector, getAbiItem } from 'viem';
import { ALLOW, DENY, SESSION_POLICY, USDC_ABI, VAULT_ABI, GOVERNANCE_ABI } from '../src/session-policy.mjs';
import { VAULT_WRITE_ABI, ERC20_WRITE_ABI, GOVERNANCE_WRITE_ABI } from '../../reference-agent/src/act.mjs';

const ABIS = { usdc: USDC_ABI, vault: VAULT_ABI, governance: GOVERNANCE_ABI };
const AGENT_ABIS = { usdc: ERC20_WRITE_ABI, vault: VAULT_WRITE_ABI, governance: GOVERNANCE_WRITE_ABI };
const SOURCE = {
  vault: readFileSync(new URL('../../../contracts/src/VaultCore.sol', import.meta.url), 'utf8'),
  governance: readFileSync(new URL('../../../contracts/src/Governance.sol', import.meta.url), 'utf8'),
};
const names = new Set(ALLOW.map((r) => r.name));

test('every allow-list selector exists in the ABI it names', () => {
  for (const r of ALLOW) {
    const item = getAbiItem({ abi: ABIS[r.target], name: r.name });
    assert.ok(item && item.type === 'function', `${r.target}.${r.name} missing from its ABI`);
    assert.equal(r.selector, toFunctionSelector(item), `${r.target}.${r.name} selector`);
  }
});

test('every allow-list row names a function declared in the contract source', () => {
  for (const r of ALLOW.filter((x) => x.target !== 'usdc')) {
    assert.match(SOURCE[r.target], new RegExp(`function ${r.name}\\(`), `${r.target}.${r.name} not in contract source`);
  }
});

test('rows that the reference agent also declares carry the same selector', () => {
  for (const r of ALLOW) {
    const item = getAbiItem({ abi: AGENT_ABIS[r.target], name: r.name });
    if (item) assert.equal(r.selector, toFunctionSelector(item), `${r.target}.${r.name} differs from the agent ABI`);
  }
  assert.ok(ALLOW.length >= 12);
});

test('transfer, transferFrom, createVault are absent and denied', () => {
  for (const n of ['transfer', 'transferFrom', 'transferWithAuthorization', 'createVault', 'createAgentVault', 'skipWindow']) {
    assert.ok(!names.has(n), `${n} must not be allowed`);
    assert.ok(DENY.some((d) => d.name === n), `${n} must be on the deny list`);
  }
  for (const abi of Object.values(ABIS)) {
    for (const n of ['transfer', 'transferFrom', 'createVault']) assert.equal(getAbiItem({ abi, name: n }), undefined);
  }
  assert.equal(SESSION_POLICY.denyUnlistedTargets, true);
});

test('approve is allowed only with a spender-in-owner-vaults rule', () => {
  const approves = ALLOW.filter((r) => r.name === 'approve');
  assert.equal(approves.length, 1);
  assert.equal(approves[0].target, 'usdc');
  assert.deepEqual(approves[0].argRule, { kind: 'arg-in-owner-vaults', index: 0 });
  assert.deepEqual(ALLOW.find((r) => r.name === 'propose')?.argRule, { kind: 'arg-in-owner-vaults', index: 0 });
});

test('the crank calls are present, skipWindow is not', () => {
  for (const n of ['activate', 'finalize', 'markExpired', 'execute']) assert.ok(names.has(n), n);
  assert.ok(!names.has('skipWindow'));
});

test('the USDC ERC-1271 denial marker is present', () => {
  assert.equal(SESSION_POLICY.signaturePolicy, 'deny-usdc-1271');
});
