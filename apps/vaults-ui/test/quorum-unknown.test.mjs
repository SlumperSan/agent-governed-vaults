// @ts-check
/**
 * `quorumReadout.met` IS TRI-STATE, AND EVERY SURFACE THAT PRINTS IT MUST PRINT THREE THINGS.
 *
 * `null` means "not measurable from what was read". `apps/web/src/governance.mjs` returns it on
 * six paths — five that return the literal and one that computes it — and VO-2b (#330) added a
 * new way to reach one of them: under five members both stake terms are `forWeight` MINUS cranked
 * delegated weight, so a caller that does not supply `delegatedForWeight` gets `null` rather than
 * a guess.
 *
 * WHAT WENT WRONG, AND WHY A TYPE DECLARATION IS THE ROOT OF IT. `ProposalPanel` rendered
 * `readout.met ? 'met' : 'not met'`. `null` is falsy, so an unmeasurable quorum printed a settled
 * **"not met"** next to `readout.text` saying in words that the answer is unknown — the panel
 * contradicting itself in one line. The component was not careless: `governance.d.ts` declared
 * `met: boolean`, and these hand-written declarations are believed by `tsc` over the module they
 * describe. `ssr-smoke.tsx` exists because of that exact failure mode on `proposalPhase`; this is
 * the same mistake in the same directory, on the field that decides whether a proposal passed.
 *
 * WHY SOURCE ASSERTIONS. `node --test` has no TSX loader, so this file cannot import the
 * component — the same constraint `contrast.test.mjs` and `csp.test.mjs` already work under.
 * Rendering it needs a vite SSR build (`npm run smoke`), and the gate runs neither that nor `tsc`
 * over this workspace, so a render-based assertion would not run in CI at all while these do, via
 * `test:backend`'s `apps/vaults-ui/test/*.test.mjs` glob. The three-row table this file pins WAS
 * verified against the built component before it was written — pre-fix it printed "not met" on all
 * three rows, post-fix "unknown" — but that probe is a build step, not a test. The first test
 * below is a real behavioural probe of the module (no source reading at all), and the rest are
 * source guards whose non-vacuity is demonstrated against the pre-fix text rather than asserted.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { quorumReadout } from '../../web/src/governance.mjs';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const PANEL = join(REPO, 'apps/vaults-ui/src/components/ProposalPanel.tsx');
const DECL = join(REPO, 'apps/vaults-ui/src/lib/atlas-modules/governance.d.ts');
const ALLOCATOR = join(REPO, 'apps/web/index.html');

const wad = (n) => BigInt(n) * 10n ** 18n;

/** Four members, three revealed, 85% of the snapshot sitting in `forWeight`. */
const SUB_FIVE = Object.freeze({
  ptype: 'Rebalance',
  revealedWeight: wad(1700),
  forWeight: wad(1700),
  snapshotTotal: wad(2000),
  memberCount: 4,
  quorumBps: 2500,
  revealedVoterCount: 3,
});

test('the unknown this renders is real: sub-five without delegatedForWeight is met === null', () => {
  const unknown = quorumReadout(SUB_FIVE);
  assert.equal(unknown.met, null, 'governance.mjs no longer returns null here — re-read this file');
  // The whole defect in one assertion: a two-branch truthiness ternary sends `null` down the
  // negative arm, so "unknown" and "short of quorum" print identically.
  assert.equal(unknown.met ? 'met' : 'not met', 'not met');

  // And it is an unknown that the missing argument alone causes — both answers are reachable.
  assert.equal(quorumReadout({ ...SUB_FIVE, delegatedForWeight: 0n }).met, true);
  assert.equal(quorumReadout({ ...SUB_FIVE, delegatedForWeight: wad(1600) }).met, false);
});

/** The `<span>` that carries the quorum tag, isolated so a match elsewhere cannot pass this. */
function quorumTagSpan(src) {
  const start = src.indexOf('<dt>Quorum</dt>');
  assert.ok(start >= 0, 'the Quorum row is gone from ProposalPanel — did this move?');
  const end = src.indexOf('</dd>', start);
  assert.ok(end > start, 'could not find the end of the Quorum row');
  return src.slice(start, end);
}

/** The three labels a tri-state tag must be able to print. */
const LABELS = ['met', 'not met', 'unknown'];

test('ProposalPanel prints three quorum states, not two', () => {
  const src = readFileSync(PANEL, 'utf8');
  const span = quorumTagSpan(src);

  // A truthiness test on `met` is the defect itself: it cannot distinguish null from false.
  assert.doesNotMatch(
    span,
    /\{\s*readout\.met\s*\?/,
    'the quorum tag branches on the truthiness of `met`, so an unmeasurable quorum prints as a settled "not met"',
  );
  assert.match(span, /quorumTag\(readout\.met\)/, 'the quorum tag no longer routes through quorumTag()');

  // And `quorumTag` must actually yield all three, by `=== true` / `=== false` rather than truthiness.
  const fn = src.slice(src.indexOf('function quorumTag('), src.indexOf('interface Props'));
  assert.match(fn, /met === true/, 'quorumTag does not test `met === true`');
  assert.match(fn, /met === false/, 'quorumTag does not test `met === false`');
  for (const label of LABELS) {
    assert.ok(fn.includes(`'${label}'`), `quorumTag cannot print "${label}"`);
  }
});

test('NON-VACUITY: the pre-fix quorum row fails the assertions above', () => {
  const preFix = `<dt>Quorum</dt>
        <dd>
          <span className={readout.met ? 'tag' : 'tag tag-warn'}>{readout.met ? 'met' : 'not met'}</span>{' '}
          <span className="dim">{readout.text}</span>
        `;
  assert.match(preFix, /\{\s*readout\.met\s*\?/);
  assert.doesNotMatch(preFix, /quorumTag\(readout\.met\)/);
});

test('governance.d.ts declares met as tri-state, because tsc believes it over the module', () => {
  const decl = readFileSync(DECL, 'utf8');
  const met = decl.split('\n').find((l) => /^\s*readonly met\s*[:?]/.test(l));
  assert.ok(met, '`met` is gone from QuorumReadout');
  assert.match(
    met,
    /boolean\s*\|\s*null/,
    '`met` is declared narrower than governance.mjs returns — the declaration that caused this bug',
  );
});

test('the allocator front end forwards delegatedForWeight into quorumReadout too', () => {
  const src = readFileSync(ALLOCATOR, 'utf8');
  const start = src.indexOf('quorumReadout({');
  assert.ok(start >= 0, 'apps/web/index.html no longer calls quorumReadout');
  const block = src.slice(start, src.indexOf('});', start));
  assert.match(
    block,
    /delegatedForWeight:\s*p\.delegatedForWeight/,
    'apps/web/index.html drops delegatedForWeight, so its sub-five vaults read "cannot be determined" forever',
  );
});
