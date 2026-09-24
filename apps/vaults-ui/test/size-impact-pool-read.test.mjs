// @ts-check
/**
 * The size-impact notice's pool read (#183): `chain-actions.ts`'s `resolvePool` and the
 * `VITE_V3_FACTORY` it resolves through. SOURCE GUARDS, same reason as the sibling wiring tests: no
 * TSX/TS loader under `node --test`.
 *
 * On Arc, `getPool(cirBTC, USDC, fee)` answers for three tiers (100, 3000, 10000) and only tier 100
 * holds liquidity. A lookup that falls through to the next tier after a FAILED read would quietly
 * forecast against a different, empty or unrelated pool. `getPool` answers the zero address for a
 * missing tier and never reverts for it, so a throw is a read failure and must stop resolution.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const APP = fileURLToPath(new URL('..', import.meta.url));
const REPO = join(APP, '..', '..');
const CHAIN_ACTIONS = readFileSync(join(APP, 'src/lib/chain-actions.ts'), 'utf8');
const ENV_EXAMPLE = readFileSync(join(APP, '.env.example'), 'utf8');
const ARC_CONFIG = JSON.parse(readFileSync(join(REPO, 'contracts/config/arc-mainnet.json'), 'utf8'));

/** The body of `resolvePool`, from its signature to the next top-level export. */
const resolvePoolBody = (src) => {
  const start = src.indexOf('async function resolvePool(');
  assert.ok(start >= 0, 'resolvePool not found in chain-actions.ts');
  const end = src.indexOf('\nexport ', start);
  assert.ok(end > start, 'end of resolvePool not found');
  return src.slice(start, end);
};

/** Only the catch block's own contents (it holds no braces), so a later `return null` elsewhere
 *  in the function can never satisfy this. */
const failedReadStops = (body) => {
  const m = /catch\s*\{([^}]*)\}/.exec(body);
  assert.ok(m, 'resolvePool has no catch block');
  return /\breturn null;/.test(m[1]);
};

const CATCH_BLOCK = /(async function resolvePool\([\s\S]*?catch\s*\{)[^}]*\}/;

test('a failed getPool read stops pool resolution — it never falls through to another fee tier', () => {
  assert.ok(failedReadStops(resolvePoolBody(CHAIN_ACTIONS)), 'resolvePool must return null from its catch, not try the next tier');
});

test('MUTATION: a catch that falls through to the next tier is caught', () => {
  const mutated = CHAIN_ACTIONS.replace(CATCH_BLOCK, '$1\n      // try the next tier\n    }');
  assert.notEqual(mutated, CHAIN_ACTIONS, 'mutation target not found');
  assert.equal(failedReadStops(resolvePoolBody(mutated)), false, 'RED: a fall-through catch must read as unsafe');
});

test('.env.example sets VITE_V3_FACTORY to the factory arc-mainnet.json records off SwapRouter02', () => {
  const m = /^VITE_V3_FACTORY=(0x[0-9a-fA-F]{40})$/m.exec(ENV_EXAMPLE);
  assert.ok(m, '.env.example must set VITE_V3_FACTORY now that it targets Arc (chain 5042)');
  assert.match(ENV_EXAMPLE, /^VITE_CHAIN_ID=5042$/m, "the factory is Arc's; the template must target Arc");
  const recorded = /factory\(\) returns (0x[0-9a-fA-F]{40})/.exec(ARC_CONFIG.routerNote);
  assert.ok(recorded, 'arc-mainnet.json routerNote no longer records factory(); re-derive before changing this test');
  assert.equal(m[1].toLowerCase(), recorded[1].toLowerCase(), "VITE_V3_FACTORY must be the factory read off Arc's router, never the squatted canonical address");
});
