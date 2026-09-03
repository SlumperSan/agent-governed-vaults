// @ts-check
/**
 * Contract-size claims in Solidity comments, resolved against the BUILD ARTIFACT.
 *
 * WHY THIS EXISTS, AND WHY IT IS A SEPARATE FILE FROM claims-lede-truth.
 *
 * `claims-lede-truth.test.mjs` matches banned claim SHAPES. That works because a claim like "the
 * agent votes" has a shape. **A bare byte count does not.** `24,731 B` is just a number; no regex
 * can know it is wrong. So the shape guard cannot catch this class, and adding `.sol` to its
 * `PUBLIC_EXT` — which this change also does — does not by itself close the hole that produced the
 * defect below.
 *
 * The defect, twice. `VaultDeployer.sol` asserted VaultCore's creation code was 24,731 B and
 * "larger than the 24,576 B runtime cap all by itself". Re-measured, it is 22,391 B — under the
 * cap. The claim was TRUE when written; what expired was the date, and nothing carried the date.
 * #151 corrected it. **The identical claim survived one file away in `VaultFactory.sol`** ("it
 * exists because VaultCore's creation code alone exceeds EIP-170") until 2026-09-03, because the
 * correction was applied to the instance in view rather than to every instance of the shape.
 * `VaultDeployer.sol`'s own corrected paragraph names the reason: "nothing walks `.sol` for stale
 * figures, which is how the old one lasted."
 *
 * WHAT THIS CHECKS. Not the bare number — the COMPARATIVE ASSERTION around it, which does have a
 * shape: `<Contract>'s <creation|runtime|initcode> code [alone] <exceeds|is under|fits under|...>
 * <EIP-170|EIP-3860|24,576|49,152|the cap>`. Each match is resolved against
 * `contracts/out/<C>.sol/<C>.json` and must be TRUE. A date is deliberately NOT the mechanism: a
 * date is author-asserted, and "Re-measured 2026-09-02: … 24,731 B" would pass a date check while
 * being false. Machine comparison re-checks on every build instead of trusting a human to notice
 * an expiry.
 *
 * COVERAGE FLOOR. The natural rewrite of a false claim is to delete the comparative altogether,
 * which would drop the match count to zero and leave this guard silently green forever — the
 * false-green shape. So the floor below asserts at least one live claim is still being resolved,
 * with the anchor sentence named. If a future rewrite trips it, the message says to re-point this
 * guard or delete it deliberately — never to quietly let it match nothing. Precedent:
 * `config-doc-truth.test.mjs`.
 *
 * KNOWN LIMITATION, stated rather than discovered later. The pattern is NAME-ANCHORED, so it does
 * not match self-referential subjects: `VaultDeployer.sol` says "**This contract's** own CREATION
 * code carries `type(VaultCore).creationCode` (initcode is capped at 49,152 B by EIP-3860, so it
 * fits there)" — a comparative against a cap that this guard does NOT resolve. `.sol` NatSpec uses
 * "this contract's" constantly. That is a real gap, not a hypothetical one.
 *
 * BUILD DEPENDENCY. This reads `contracts/out/`, so it FAILS LOUD when the artifact is missing
 * rather than skipping — a skip here is indistinguishable from a pass, and `npm run test:backend`
 * does not build. `npm run gate` runs `build` before `backend` for exactly this reason.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(REPO, 'contracts', 'src');

// A size claim is a size claim wherever it is written, so this walks PROSE as well as `.sol`.
// Scoping it to `contracts/src` would have caught exactly one of the four sites that carried the
// false EIP-170 claim on 2026-09-03: the other three were in docs/audit/walkthroughs/VaultFactory.md,
// docs/vault/vaultfactory.md and docs/vault/contracts-index.md. Enumerated from the filesystem,
// never from a list — a negative guard that names its files cannot catch the file nobody added.
const SIZE_EXT = new Set(['.sol', '.md', '.html', '.txt', '.json']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'out', 'cache', 'broadcast', 'coverage', 'artifacts']);
// Path-anchored, NOT name-matched: a bare `lib` entry also swallows `contracts/src/lib/`, which is
// how three shipped source files sat outside the sibling claims guard's walk entirely.
const SKIP_PATHS = ['contracts/lib/', 'contracts/test/retired/vendor/'];
const OUT = path.join(REPO, 'contracts', 'out');

/** EIP-170 caps deployed RUNTIME code; EIP-3860 caps INITCODE. Conflating them is the usual error. */
const CAPS = { 'eip-170': 24576, 'eip-3860': 49152 };

/** Byte length of a `0x`-prefixed hex string. */
const byteLen = (hex) => (String(hex ?? '').replace(/^0x/, '').length) / 2;

/** @returns {{creation:number, runtime:number}|null} */
function sizesOf(contract) {
  const f = path.join(OUT, `${contract}.sol`, `${contract}.json`);
  if (!existsSync(f)) return null;
  const j = JSON.parse(readFileSync(f, 'utf8'));
  return {
    creation: byteLen(j?.bytecode?.object),
    runtime: byteLen(j?.deployedBytecode?.object),
  };
}

/** Every surface that could carry a size claim, walked from the filesystem — never a list. */
function sizeSurfaces(dir = REPO, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(REPO, p).split(path.sep).join('/');
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (SKIP_PATHS.some((sp) => `${rel}/`.startsWith(sp))) continue;
      sizeSurfaces(p, acc);
    } else if (SIZE_EXT.has(path.extname(e.name)) && !rel.endsWith('package-lock.json')) {
      acc.push(p);
    }
  }
  return acc;
}

/**
 * Prose that frames a figure as a RECORD of a superseded claim, rather than making one. Deliberately
 * NOT a bare marker word: a marker exempts a block because the author typed the marker, which is a
 * rubber stamp. This requires a past-reference bound to a VERB OF CLAIMING within one clause — "this
 * said X until", "read X until then", "claimed otherwise until" — which cannot be satisfied by
 * decorating a live claim with a date.
 */
const SUPERSESSION =
  /\b(?:said|claimed|read|carried|asserted|stated)\b[^.]{0,80}\b(?:until|before|previously|no longer|not any more|anymore)\b|\b(?:until|before)\s+(?:then|2\d{3}-\d{2}-\d{2})\b/i;

/** Collapse comment markers and whitespace so a claim split across `///` lines still matches. */
const flat = (t) => t.replace(/^\s*(?:\/\/\/?|\*)\s?/gm, ' ').replace(/\s+/g, ' ');

// <Contract>'s <which> code [alone] <relation> <cap>
const CLAIM =
  /\b([A-Z][A-Za-z0-9_]*)(?:'s|s')\s+(?:own\s+)?(creation|runtime|deployed|initcode|init)\s+code\b[^.]{0,40}?\b(exceeds?|is larger than|is bigger than|is over|is under|is below|is smaller than|fits under|fits within|does not fit|cannot fit)\b[^.]{0,60}?(eip-?170|eip-?3860|24,?576|49,?152)/gi;

/** Does the artifact make this comparative TRUE? */
function evaluate(contract, which, relation, capToken) {
  const s = sizesOf(contract);
  if (!s) return { resolved: false };
  const size = /creation|init/i.test(which) ? s.creation : s.runtime;
  const key = /3860|49,?152/i.test(capToken) ? 'eip-3860' : 'eip-170';
  const cap = CAPS[key];
  const over = /exceeds?|larger|bigger|is over|does not fit|cannot fit/i.test(relation);
  const actual = over ? size > cap : size < cap;
  return { resolved: true, ok: actual, size, cap, key };
}

test('contracts/out exists — this guard must never skip its way to green', () => {
  assert.ok(
    existsSync(OUT),
    `contracts/out/ is missing, so contract-size claims cannot be resolved.\n` +
      `Run \`npm run build:contracts\` (or \`npm run gate\`, which builds first).\n` +
      `This test fails rather than skips on purpose: a skipped size check is indistinguishable ` +
      `from a passing one, which is the false-green shape this file exists to prevent.`
  );
});

test('every contract-size comparative in contracts/src is TRUE against the build artifact', () => {
  const failures = [];
  let resolvedClaims = 0;

  for (const file of sizeSurfaces()) {
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    const hay = flat(readFileSync(file, 'utf8'));
    for (const m of hay.matchAll(CLAIM)) {
      const [full, contract, which, relation, capToken] = m;
      const v = evaluate(contract, which, relation, capToken);
      if (!v.resolved) continue; // not a contract we build (an interface, a library reference)
      resolvedClaims++;
      // A retracted claim quoted inside its own correction is a record, not a claim. The window
      // spans ~160 chars on BOTH sides: the frame usually PRECEDES the quotation ("This said
      // '<claim>' until 2026-09-03"), and a forward-only window misses exactly that — it flagged
      // this file's own correction on the first run.
      const at = m.index ?? 0;
      const window = hay.slice(Math.max(0, at - 160), at + full.length + 160);
      if (!v.ok && SUPERSESSION.test(window)) continue;
      if (!v.ok) {
        failures.push(
          `${rel}\n    claim:  "${full.trim()}"\n` +
            `    actual: ${contract} ${which} code = ${v.size.toLocaleString()} B, ` +
            `${v.key.toUpperCase()} cap = ${v.cap.toLocaleString()} B — the comparative is FALSE.`
        );
      }
    }
  }

  assert.equal(
    failures.length,
    0,
    `Contract-size claims that the build artifact contradicts:\n\n${failures.join('\n\n')}\n\n` +
      `These were almost certainly TRUE when written. Re-measure from ` +
      `contracts/out/<C>.sol/<C>.json rather than copying a number from another comment — that ` +
      `copying is how the 24,731 B figure survived in two files at once.`
  );

  // Coverage floor. Anchor: VaultFactory.sol's "VaultCore's creation code is under EIP-170 by
  // itself, but not once a factory's own logic is added". If that sentence is rewritten so no
  // comparative remains, this guard would match nothing and pass forever without checking anything.
  assert.ok(
    resolvedClaims >= 1,
    `This guard resolved ZERO contract-size claims, so it is now checking nothing.\n` +
      `That is not a pass. Either a comparative was rewritten out of contracts/src (re-point the ` +
      `anchor comment in VaultFactory.sol, or update CLAIM to match the new phrasing), or the ` +
      `pattern has drifted from how the NatSpec is written. Do not leave this silently green.`
  );
});

/** The same decision the walk makes, against a string — so the edges can be probed, not argued. */
function verdictFor(text) {
  const hay = flat(text);
  for (const m of hay.matchAll(CLAIM)) {
    const [full, contract, which, relation, capToken] = m;
    const v = evaluate(contract, which, relation, capToken);
    if (!v.resolved) continue;
    const at = m.index ?? 0;
    if (!v.ok && SUPERSESSION.test(hay.slice(Math.max(0, at - 160), at + full.length + 160))) continue;
    if (!v.ok) return 'RED';
  }
  return 'GREEN';
}

test('probe: the supersession exemption is not a rubber stamp', () => {
  // The four sites that carried the false claim on 2026-09-03, in their ORIGINAL wording. Each must
  // be caught. If a future refactor greens any of these, the guard has stopped doing its job.
  for (const stale of [
    `it exists because VaultCore's creation code alone exceeds EIP-170`,
    `forced by EIP-170 — VaultCore's creation code alone exceeds the runtime cap (24,576 B)`,
    `the factory can't inline it because VaultCore's creation code exceeds EIP-170`,
    `exists solely because VaultCore's creation code exceeds EIP-170`,
  ]) {
    assert.equal(verdictFor(stale), 'RED', `should have been caught: ${stale}`);
  }

  // A genuine retraction quoting the claim it retracts is a RECORD, and must pass.
  assert.equal(
    verdictFor(`This said "VaultCore's creation code alone exceeds EIP-170" until 2026-09-03.`),
    'GREEN'
  );

  // ...but the frame must be EARNED. A bare marker word, or a date pinned to a still-live claim,
  // is exactly the rubber stamp this design rejected — both must stay RED.
  assert.equal(
    verdictFor(`Re-measured 2026-09-03: VaultCore's creation code alone exceeds EIP-170.`),
    'RED',
    'a date on a live false claim must not exempt it'
  );
  assert.equal(
    verdictFor(`HISTORICAL. VaultCore's creation code alone exceeds EIP-170.`),
    'RED',
    'a bare marker word must not exempt a live false claim'
  );
  assert.equal(
    verdictFor(`This was reviewed and fixed. VaultCore's creation code alone exceeds EIP-170.`),
    'RED',
    'an adjacent remediation sentence must not exempt a live false claim'
  );

  // A true comparative passes with no frame at all — the guard bans falsehood, not phrasing.
  assert.equal(verdictFor(`VaultCore's creation code is under EIP-170 by itself.`), 'GREEN');
});

test('the pattern distinguishes EIP-170 from EIP-3860, and creation from runtime', () => {
  // The two caps govern different things and the sizes differ by ~1.7 KB, so a guard that
  // conflated them would score a true claim false (or worse, the reverse).
  const s = sizesOf('VaultCore');
  assert.ok(s, 'VaultCore artifact missing');
  assert.ok(s.creation > s.runtime, 'creation code must exceed runtime code');

  // Runtime is what EIP-170 caps; creation code is not, and that distinction is the whole finding.
  assert.equal(evaluate('VaultCore', 'runtime', 'is under', 'EIP-170').ok, true);
  assert.equal(evaluate('VaultCore', 'creation', 'exceeds', 'EIP-170').ok, false);
  assert.equal(evaluate('VaultCore', 'creation', 'is under', 'EIP-170').ok, true);
  assert.equal(evaluate('VaultCore', 'creation', 'fits under', 'EIP-3860').ok, true);
});
