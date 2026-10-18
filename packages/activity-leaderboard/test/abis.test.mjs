// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_EVENTS, VAULT_READ_ABI } from '../src/abis.mjs';
import { CHAINS } from '../src/chains.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SRC = readFileSync(path.join(REPO, 'contracts', 'src', 'VaultCore.sol'), 'utf8');

/** `name(type [indexed] [name], ...)` -> `name(type[ indexed],...)`, names dropped, from Solidity source. */
function solidityEventShape(name) {
  const m = SRC.match(new RegExp(`event\\s+${name}\\s*\\(([^)]*)\\)\\s*;`));
  assert.ok(m, `event ${name} is not declared in contracts/src/VaultCore.sol`);
  const params = m[1].split(',').map((p) => p.trim().split(/\s+/)).map((w) => `${w[0]}${w[1] === 'indexed' ? ' indexed' : ''}`);
  return `${name}(${params.join(',')})`;
}
const abiShape = (e) => `${e.name}(${e.inputs.map((i) => `${i.type}${i.indexed ? ' indexed' : ''}`).join(',')})`;

test('the event fragments match VaultCore.sol type for type and indexed flag for flag', () => {
  for (const e of VAULT_EVENTS) assert.equal(abiShape(e), solidityEventShape(e.name));
});

test('every DepositActivated emit passes the member\'s share balance after the mint as its third argument', () => {
  const emits = [...SRC.matchAll(/emit\s+DepositActivated\s*\(([^;]*)\)\s*;/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
  assert.ok(emits.length >= 2, `expected at least two emit sites, found ${emits.length}`);
  for (const args of emits) {
    const [first, , third] = args.split(',').map((s) => s.trim());
    assert.equal(third, `sharesOf[${first}]`, `emit DepositActivated(${args}) no longer passes the member share balance as its third argument; the reducer's reading of the field must be revisited`);
  }
});

test('exit removes cost basis pro rata over the member\'s shares, as the ledger assumes', () => {
  assert.match(SRC, /basisRemoved\s*=\s*costBasisUsdc\[member\]\s*\*\s*burnShares\s*\/\s*memberShares\s*;/);
  assert.match(SRC, /costBasisUsdc\[member\]\s*\+=\s*amountUsdc\s*;/);
});

test('cost basis and shares change in no other place', () => {
  const writes = [...SRC.matchAll(/(sharesOf|costBasisUsdc)\[[^\]]+\]\s*[-+]?=[^=]/g)].map((m) => m[0].replace(/\s+/g, ' ').trim());
  assert.equal(writes.length, 4, `unexpected writes to sharesOf/costBasisUsdc: ${writes.join(' | ')}`);
});

test('the read ABI names the public getters the head check relies on', () => {
  for (const fn of ['sharesOf', 'costBasisUsdc']) {
    assert.match(SRC, new RegExp(`mapping\\(address\\s*=>\\s*uint256\\)\\s+public\\s+${fn}\\b`));
    assert.ok(VAULT_READ_ABI.some((f) => f.name === fn));
  }
  assert.match(SRC, /address\s+public\s+immutable\s+creator\s*;/);
});

test('chain records: ids and the deployer agree with the deployment records', () => {
  const arc = JSON.parse(readFileSync(path.join(REPO, 'contracts', 'config', 'deployments', 'arc-mainnet.json'), 'utf8'));
  assert.equal(CHAINS.arc.chainId, arc.chainId);
  assert.equal(CHAINS.arc.deployer, arc.deployer.toLowerCase());
  assert.deepEqual(CHAINS.arc.rpcs, [arc.rpc, arc.crossCheckedOn]);
  for (const c of Object.values(CHAINS)) {
    for (const v of c.vaults) {
      assert.match(v.address, /^0x[0-9a-f]{40}$/);
      assert.ok(Number.isSafeInteger(v.fromBlock) && v.fromBlock >= 0);
    }
  }
});
