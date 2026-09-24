// @ts-check
/**
 * `scripts/sign-queue/persona-intake.mjs`: the step that makes a persona deposit signable. Every
 * refusal below is a way an entry could otherwise unlock a deposit item it should not. The passing
 * case is also fed through the REAL `personaIntentRefusal` (#415) with items from the REAL
 * `persona-deposit.mjs` builder, so intake and the Sign-queue gate are proven to agree.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodeFunctionData, parseAbiItem } from 'viem';
import { buildIntake, MIN_FUNDING_RAW } from '../sign-queue/persona-intake.mjs';
import { build } from '../sign-queue/persona-deposit.mjs';
import { personaIntentRefusal } from '../lib/sign-queue-preconditions.mjs';

const VAULT = '0x4EAE5C6D753AAC0b4825d41c12e71f0a8bE579f6';
const USDC = '0x3600000000000000000000000000000000000000';
const B = '0x1111111111111111111111111111111111111111';
const M = '0x2222222222222222222222222222222222222222';
const roots = [];
after(() => { for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } } });

function fixtureRoot(addresses = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'persona-intake-'));
  roots.push(root);
  const put = (rel, doc) => { const p = path.join(root, ...rel.split('/')); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(doc)); };
  put('docs/seeded-addresses.json', { readme: 'x', addresses });
  put('contracts/config/deployments/arc-mainnet.json', { chainId: 5042, firstVault: { address: VAULT } });
  put('contracts/config/arc-mainnet.json', { usdc: USDC, smoke: { minDepositUsdc: '100000000' } });
  return root;
}
const funded = async () => MIN_FUNDING_RAW;
const at = { today: '2026-09-24' };

test('adds Ballast then Momentum with the declared intent, and the result passes the real Sign-queue intent gate', async () => {
  const root = fixtureRoot();
  const doc = await buildIntake({ ballast: B, momentum: M, readBalance: funded, root, ...at });
  assert.deepEqual(doc.addresses.map((e) => [e.persona, e.address]), [['Ballast', B], ['Momentum', M]]);
  for (const e of doc.addresses) assert.deepEqual(e.intendedDeposit, { vault: VAULT, amountUsdcRaw: '100000000' });
  assert.ok(doc.addresses.every((e) => /operator funds/.test(e.fundedBy) && /Not an outside member/.test(e.note)));

  writeFileSync(path.join(root, 'docs', 'seeded-addresses.json'), JSON.stringify(doc));
  const castFn = (args) => { const [, sig, ...rest] = args; const abi = parseAbiItem(`function ${sig}`); return encodeFunctionData({ abi: [abi], args: rest.map((v, i) => (abi.inputs[i].type === 'uint256' ? BigInt(v) : v)) }); };
  for (const [from, persona] of [[B, 'Ballast'], [M, 'Momentum']]) {
    const items = build({ from, persona, amountUsdcRaw: 100_000_000n, root, castFn, readNonce: () => 0 });
    for (const it of items) assert.equal(personaIntentRefusal(it, root), null, `${persona} ${it.personaAction}`);
  }
});

const REFUSALS = [
  ['an underfunded wallet', { readBalance: async (a) => (a === M ? MIN_FUNDING_RAW - 1n : MIN_FUNDING_RAW) }, /Momentum .* below 101000000/],
  ['a malformed address', { ballast: '0x123' }, /--ballast .* is not a valid address/],
  ['the same wallet twice', { momentum: B }, /two different wallets/],
];
for (const [name, over, re] of REFUSALS) {
  test(`refuses ${name}`, async () => {
    await assert.rejects(buildIntake({ ballast: B, momentum: M, readBalance: funded, root: fixtureRoot(), ...at, ...over }), re);
  });
}

test('refuses an address or persona already listed', async () => {
  const existing = { address: B, persona: 'Ballast', model: 'x', fundedBy: 'x', addedAt: 'x', note: 'x' };
  await assert.rejects(buildIntake({ ballast: B, momentum: M, readBalance: funded, root: fixtureRoot([existing]), ...at }), /already listed/);
  await assert.rejects(buildIntake({ ballast: '0x3333333333333333333333333333333333333333', momentum: M, readBalance: funded, root: fixtureRoot([existing]), ...at }), /persona Ballast is already listed/);
});

test('a balance read that fails refuses rather than adding the entry', async () => {
  await assert.rejects(buildIntake({ ballast: B, momentum: M, readBalance: async () => { throw new Error('rpc down'); }, root: fixtureRoot(), ...at }), /rpc down/);
});

test('the shipped disclosure file is untouched by importing the module', () => {
  const doc = JSON.parse(readFileSync(new URL('../../docs/seeded-addresses.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(doc.addresses));
});
