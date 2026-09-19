// @ts-check
/**
 * `ProposalPanel` forwards `delegatedForWeight` into `quorumReadout`.
 *
 * WHY A SOURCE GUARD RATHER THAN A COMPONENT TEST. This app has no JSX/TSX loader wired into
 * `node --test` (no vitest, no @testing-library/react, no `tsc` step in the gate at all --
 * `apps/vaults-ui` is currently type-checked by nothing the gate runs). Importing the component
 * directly is not available; `contrast.test.mjs` and `csp.test.mjs` already establish the pattern
 * of reading built output or source for exactly this reason.
 *
 * WHAT THIS DOES NOT PROVE. `quorumReadout`'s actual arithmetic on `delegatedForWeight`
 * (including the sub-five branch-1 case) is proven by `apps/web/test/governance.test.mjs`, which
 * this file does not duplicate. This test proves only the WIRING: that the argument object built
 * at the one call site in this app includes the field bound to `p.delegatedForWeight`, so a value
 * present in the API response actually reaches the readout. Before this fix, `ProposalPanel` never
 * forwarded the field, so the readout was always `met: null` on every sub-five vault -- BUT the
 * render was `readout.met ? 'met' : 'not met'`, and `null` is falsy, so the panel printed a
 * settled "not met" next to `readout.text` saying the answer was unknown. That was a real runtime
 * symptom, a false negative on the one line a member reads to know whether a proposal passed --
 * see #338, which fixes the render and the `.d.ts` declaration that hid the `null` case from
 * `tsc`. This test proves the forward alone; it does not prove the render is honest about it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const APP = fileURLToPath(new URL('..', import.meta.url));
const PANEL = join(APP, 'src/components/ProposalPanel.tsx');
const ATLAS = join(APP, 'src/lib/atlas.ts');

/** The `quorumReadout({ ... })` call block, isolated so a match elsewhere in the file (a comment,
 *  an unrelated object) cannot make this pass vacuously. */
function readoutCallBlock(src) {
  const start = src.indexOf('quorumReadout({');
  assert.ok(start >= 0, 'quorumReadout call site not found -- did it move or get renamed?');
  const end = src.indexOf('});', start);
  assert.ok(end > start, 'could not find the end of the quorumReadout call block');
  return src.slice(start, end);
}

test('the quorumReadout call in ProposalPanel forwards delegatedForWeight', () => {
  const src = readFileSync(PANEL, 'utf8');
  const block = readoutCallBlock(src);
  assert.match(
    block,
    /delegatedForWeight:\s*p\.delegatedForWeight/,
    'delegatedForWeight is not forwarded -- every sub-five vault will render "unknown" quorum forever',
  );
});

test('NON-VACUITY: the same regex fails on the pre-fix call block', () => {
  // Proves the assertion above is not trivially true of any object literal -- reconstructed from
  // git history (the call site before this fix) rather than invented.
  const preFix = `quorumReadout({
    ptype: p.ptype,
    revealedWeight: p.revealedWeight,
    forWeight: p.forWeight,
    snapshotTotal: p.snapshotTotal,
    memberCount: p.memberCount,
    quorumBps: (vault.governanceConfig?.['quorumBps'] as number | undefined) ?? undefined,
    revealedVoterCount: p.revealedVoterCount,
  })`;
  assert.doesNotMatch(preFix, /delegatedForWeight:\s*p\.delegatedForWeight/);
});

test('the Proposal type carries delegatedForWeight, nullable, matching the API shape', () => {
  // docs/api/openapi.yaml: `delegatedForWeight: { type: [string, 'null'] }`. The TS side models
  // that as `bigint | null` (the app's convention: amounts arrive as strings, are parsed to
  // bigint before components see them -- see forWeight/revealedWeight above it), not `bigint`
  // alone, which would make the omitted/null API case a type error instead of the unknown state
  // `quorumReadout` is designed to report.
  const src = readFileSync(ATLAS, 'utf8');
  assert.match(
    src,
    /delegatedForWeight\?:\s*bigint\s*\|\s*null/,
    'Proposal.delegatedForWeight must be optional AND nullable, matching the OpenAPI shape',
  );
});
