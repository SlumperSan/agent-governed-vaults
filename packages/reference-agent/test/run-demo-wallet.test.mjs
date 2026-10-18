// @ts-check
/**
 * The throwaway demo wallet is refused on chain 5042, by exit code, through the real entrypoint.
 *
 * `run.mjs`'s `TESTNET_CHAIN_IDS` is deliberately a closed list that does NOT contain Arc mainnet:
 * a key generated in memory for a demo must never be the identity or the payer on a chain that
 * holds real funds. Adding 5042 to make "the Arc preset work with the demo" would reverse that,
 * and nothing else would notice. Hence two tests that fail if it happens: one on the source, one
 * on behavior.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RUN = fileURLToPath(new URL('../src/run.mjs', import.meta.url));

/** @param {string[]} args */
const run = (args) => spawnSync(process.execPath, [RUN, ...args], { encoding: 'utf8', timeout: 60_000 });

test('--demo-wallet on chain 5042 exits with code 2 and says why', () => {
  const r = run(['--demo-wallet', '--chain-id=5042']);
  assert.equal(r.status, 2, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout + r.stderr, /--demo-wallet refused: chain id 5042 is not a known testnet/);
});

test('--demo-wallet with the Arc preset exits with code 2 too, before any wallet is made', () => {
  const r = run(['--demo-wallet', '--preset=arc-mainnet']);
  assert.equal(r.status, 2, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.doesNotMatch(r.stdout + r.stderr, /demo wallet: 0x/, 'a wallet must not be minted before the refusal');
});

test('the refusal is specific to mainnet ids: the same flag on Base Sepolia still runs', () => {
  const r = run(['--demo-wallet', '--chain-id=84532', '--ticks=0']);
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /demo wallet: 0x/);
});

test('5042 is not in TESTNET_CHAIN_IDS in the source', () => {
  const src = readFileSync(RUN, 'utf8');
  const m = src.match(/const TESTNET_CHAIN_IDS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'run.mjs no longer declares TESTNET_CHAIN_IDS as a literal set; update this test with it');
  const ids = m[1].split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
  assert.ok(ids.length >= 1, 'parsed no ids out of TESTNET_CHAIN_IDS');
  assert.ok(!ids.includes(5042), 'Arc mainnet must not be treated as a testnet');
});
