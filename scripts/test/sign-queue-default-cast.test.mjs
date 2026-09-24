// @ts-check
/**
 * defaultCast must accept the BigInt arguments its callers really pass. #382 memoised it with
 * JSON.stringify(args) as the key, which throws on a BigInt, and the Safe-routed first-vault item
 * (whose execTransaction args carry the plan's uint fields as BigInt) could not resolve at all.
 * The owner saw "cannot resolve data: ... Do not know how to serialize a BigInt" and could not sign
 * item 101. Uses the real `cast`, as scripts/test/safe-exec.test.mjs does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { defaultCast } from '../lib/sign-queue-server.mjs';

const SIG = 'f(address,uint256,uint8)';
const ADDR = '0x99e805294F1f1465C96f68e36264E99991Ef9E82';

test('defaultCast encodes BigInt and number arguments exactly as their string forms', () => {
  const expected = execFileSync(process.env.CAST ?? 'cast', ['calldata', SIG, ADDR, '5', '0'], { encoding: 'utf8' }).trim();
  assert.equal(defaultCast(['calldata', SIG, ADDR, 5n, 0]), expected);
  // Memo hit with the equivalent string form returns the same bytes.
  assert.equal(defaultCast(['calldata', SIG, ADDR, '5', '0']), expected);
});
