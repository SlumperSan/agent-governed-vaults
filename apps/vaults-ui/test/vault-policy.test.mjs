// @ts-check
/**
 * Owner decision 2026-10-18: app.rwally.com stops offering deposits into the Arc v1 vault, keeps
 * every exit path, escrow claims and every read, and says so in one line. This file is the unit
 * test of the per-vault policy module itself plus its pin to the committed deployment record.
 * The rendered surface and the write-layer guards are in `deposits-closed.test.mjs`.
 *
 * `vault-policy.ts` has no JSX and no alias imports, so plain `node --test` imports it directly,
 * the same shape as `sanctions.test.mjs`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECT_PROMPT_DEPOSITS_CLOSED,
  DEPOSITS_CLOSED_NOTICE,
  DEPOSITS_CLOSED_VAULTS,
  assertDepositsOpen,
  depositsClosedNotice,
  vaultPolicy,
} from '../src/lib/vault-policy.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const dep = JSON.parse(readFileSync(join(ROOT, 'contracts/config/deployments/arc-mainnet.json'), 'utf8'));
const V1 = dep.firstVault.address;

test('the closed set is exactly the Arc v1 vault of the committed deployment record', () => {
  assert.deepEqual(Object.keys(DEPOSITS_CLOSED_VAULTS), [V1.toLowerCase()]);
});

test('every key is lowercase and a well-formed address, every value has a notice', () => {
  for (const [addr, reason] of Object.entries(DEPOSITS_CLOSED_VAULTS)) {
    assert.match(addr, /^0x[0-9a-f]{40}$/);
    assert.ok(DEPOSITS_CLOSED_NOTICE[reason], `no notice for reason ${reason}`);
  }
});

test('v1 is closed, in any letter case; the policy carries a reason key', () => {
  for (const a of [V1, V1.toLowerCase(), V1.toUpperCase().replace('0X', '0x')]) {
    const p = vaultPolicy(a);
    assert.equal(p.depositsClosed, true, a);
    assert.equal(p.reason, 'v1-closed');
    assert.equal(depositsClosedNotice(a), DEPOSITS_CLOSED_NOTICE['v1-closed']);
    assert.throws(() => assertDepositsOpen(a), /no longer offers deposits/);
  }
});

test('any other vault is open: no notice, no refusal', () => {
  for (const a of ['0x00000000000000000000000000000000000000a2', dep.singletons.VaultFactory, '0x', '']) {
    assert.deepEqual(vaultPolicy(a), { depositsClosed: false, reason: null });
    assert.equal(depositsClosedNotice(a), null);
    assert.doesNotThrow(() => assertDepositsOpen(a));
  }
});

test('the public copy is scoped to the app, calm, and says what stays', () => {
  const n = DEPOSITS_CLOSED_NOTICE['v1-closed'];
  assert.match(n, /^This app no longer offers deposits into this vault\./);
  assert.match(n, /Exits and claims of escrowed amounts are still available here\.$/);
  // ContractTab.tsx says no address can switch off deposits through the contracts: the notice must
  // not read as an on-chain closure, and must not describe a mechanism or a risk.
  assert.doesNotMatch(n, /paus|disabled on.?chain|exploit|attack|ratchet|vulnerab|at risk|unsafe|loss|stolen/i);
  assert.doesNotMatch(n + CONNECT_PROMPT_DEPOSITS_CLOSED, /[\u2013\u2014]|--/);
  assert.doesNotMatch(CONNECT_PROMPT_DEPOSITS_CLOSED, /deposit/i);
});
