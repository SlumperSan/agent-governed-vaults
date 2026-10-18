// @ts-check
/**
 * The unproven-operator profile and the disclosed-address file, through the real entrypoint.
 *
 * `--ticks=0` prints the startup declaration and stops, so these need no RPC and read no chain: they
 * test that the flags reach the config, that the risk is in the banner when the profile is on and
 * absent when it is not, and that a malformed file or a conflicting config is a refusal by exit code,
 * never a silent fall back to the defaults (an empty disclosed list would put every disclosed
 * address back into the track record).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUN = fileURLToPath(new URL('../src/run.mjs', import.meta.url));
/** @param {string[]} args */
const run = (args) => spawnSync(process.execPath, [RUN, ...args], { encoding: 'utf8', timeout: 60_000 });
const out = (r) => `${r.stdout}\n${r.stderr}`;

const dir = mkdtempSync(path.join(tmpdir(), 'reference-agent-profile-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const file = (name, body) => {
  const p = path.join(dir, name);
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
  return p;
};

test('--profile=unproven-operator puts the profile and its risk in the startup banner', () => {
  const r = run(['--profile=unproven-operator', '--ticks=0']);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /JOIN PROFILE unproven-operator IS ON/);
  assert.match(r.stdout, /deposit is pinned at the vault minimum, and the exit on a negative operator net stays on/);
  assert.match(r.stdout, /Below five holders, the outcome of a Rebalance depends on stake and on how many addresses vote/);
  assert.match(r.stdout, /RuleChange needs every unit of eligible stake to reveal in favour/);
});

test('without the flag the banner says nothing of the profile', () => {
  const r = run(['--ticks=0']);
  assert.equal(r.status, 0, out(r));
  assert.doesNotMatch(r.stdout, /JOIN PROFILE|unproven-operator/);
});

test('an unknown profile name is refused, not ignored', () => {
  const r = run(['--profile=trusting', '--ticks=0']);
  assert.notEqual(r.status, 0);
  assert.match(out(r), /unknown policy\.join\.profile "trusting"/);
});

test('the profile beside a config that turns the net-negative exit off is refused', () => {
  const cfg = file('exit-off.json', { policy: { exit: { onOperatorNetNegative: false } } });
  const r = run(['--profile=unproven-operator', `--config=${cfg}`, '--ticks=0']);
  assert.notEqual(r.status, 0);
  assert.match(out(r), /onOperatorNetNegative must stay true/);
});

test('--disclosed reads the addresses of a seeded-addresses file, and an empty one is allowed', () => {
  const some = file('some.json', { addresses: [{ address: '0x' + 'ab'.repeat(20), persona: 'x' }] });
  assert.equal(run([`--disclosed=${some}`, '--ticks=0']).status, 0);
  assert.equal(run([`--disclosed=${file('empty.json', { readme: 'x', addresses: [] })}`, '--ticks=0']).status, 0);
});

test('--disclosed with a file that is not that shape is an error, never an empty list', () => {
  for (const [name, body, message] of [
    ['no-array.json', { addresses: 'x' }, /expected an object with an "addresses" array/],
    ['bare-array.json', ['0x' + 'ab'.repeat(20)], /expected an object with an "addresses" array/],
    ['no-address.json', { addresses: [{ persona: 'x' }] }, /addresses\[0\] has no "address" string/],
    ['bad-address.json', { addresses: [{ address: 'not-an-address' }] }, /disclosedAddresses must be an array of 0x addresses/],
    ['not-json.json', '{ nope', /JSON/],
  ]) {
    const r = run([`--disclosed=${file(name, body)}`, '--ticks=0']);
    assert.notEqual(r.status, 0, `${name} was accepted`);
    assert.match(out(r), message, name);
  }
  const missing = run([`--disclosed=${path.join(dir, 'missing.json')}`, '--ticks=0']);
  assert.notEqual(missing.status, 0);
});
