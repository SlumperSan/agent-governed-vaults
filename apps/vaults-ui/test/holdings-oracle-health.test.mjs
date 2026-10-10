// @ts-check
/**
 * `Holdings.tsx`'s oracle-age column now defers to `oracleHealth` (`apps/web/src/vault-view.mjs`)
 * instead of an inline `age > leg.maxStalenessSec` comparison it used to carry.
 *
 * THAT COMPARISON WAS A SECOND, UNTESTED IMPLEMENTATION OF WHAT `oracleHealth` ALREADY OWNS, AND IT
 * HAD A REAL DEFECT: no `unheld` exemption (a zero-balance leg with an old feed read "stale" for an
 * asset nobody was exposed to), no `ageing` warning before the hard bound, and — the one that
 * matters most — `NaN > bound` evaluates `false` in JavaScript, so an unmeasurable age would have
 * rendered as NOT stale. An unknown fact looking healthy is the exact shape this project has already
 * found and fixed more than once elsewhere (#338, quorum). `oracleHealth` itself is well-tested
 * (`apps/web/test/vault-view.test.mjs`, 3 cases exactly on this); this file is not re-testing that
 * logic, it is guarding that the component actually CALLS it rather than quietly growing a second
 * comparison beside it again.
 *
 * WHY SOURCE ASSERTIONS. `node --test` has no TSX/TS loader, so this file cannot import
 * `Holdings.tsx` — the same constraint `contrast.test.mjs`, `csp.test.mjs` and
 * `quorum-unknown.test.mjs` already work under (see that file's own header). Both checks below are
 * demonstrated non-vacuous against the actual pre-fix text this change replaced.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const HOLDINGS = join(REPO, 'apps/vaults-ui/src/components/Holdings.tsx');

const src = readFileSync(HOLDINGS, 'utf8');
// Comments stripped before any "is the old pattern gone" check — this file's own docstrings
// describe the old inline comparison in prose (to explain why it was replaced), and a check that
// does not strip comments would match its own documentation. Same failure shape a favicon.svg guard
// hit earlier the same day; fixed the same way here before it shipped rather than after.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('Holdings.tsx calls the real oracleHealth rather than re-deriving staleness inline', () => {
  assert.match(code, /\boracleHealth\(/, 'Holdings.tsx no longer calls oracleHealth at all');
  assert.doesNotMatch(
    code,
    /age\s*>\s*leg\.maxStalenessSec/,
    'the old inline "age > leg.maxStalenessSec" comparison is back — that is the exact defect this file exists to guard against',
  );
});

test('every state oracleHealth can return has a distinct rendering, and none of the non-fresh ones looks healthy', () => {
  for (const state of ['unheld', 'unknown', 'stale', 'ageing', 'fresh']) {
    assert.match(code, new RegExp(`case '${state}':`), `no case for oracleHealth state "${state}" — a real state would fall through unhandled`);
  }
  // The two states that mean "do not trust this reading" both take the warn treatment, and neither
  // is worded the same as the other — a reader must be able to tell "confirmed old" from "cannot
  // tell", not just "not fresh". Bounded to the next `case` (or the closing brace) rather than to
  // one comment line, so this does not depend on exactly how the case is commented.
  const unknownBlock = /case 'unknown':[\s\S]*?(?=case '|\n\s*\}\s*\n\s*\})/.exec(code);
  assert.ok(unknownBlock, 'no case for "unknown" found in oracleAgeCell');
  assert.match(unknownBlock[0], /tag-warn/, '"unknown" state does not take the warn treatment — it could render as healthy');
  assert.doesNotMatch(unknownBlock[0], /stale/i, '"unknown" state reuses stale’s wording — a reader cannot tell them apart');
});

test('mutation: the guard above fails against the actual pre-fix inline comparison', () => {
  const preFix = `
          {legs.map((leg) => {
            const age = nowSec - leg.oracleUpdatedAt;
            const stale = age > leg.maxStalenessSec;
            return (
              <tr key={leg.address}>
                <td className={stale ? 'num tag-warn' : 'num dim'}>
                  {age}s{stale ? ' · stale' : ''}
                </td>
              </tr>
            );
          })}
`;
  assert.match(
    preFix,
    /age\s*>\s*leg\.maxStalenessSec/,
    'the pre-fix fixture no longer matches the inline comparison pattern — fixture is stale',
  );
});
