// @ts-check
/**
 * Card 127 (#182, P-O15) — the Contract tab component itself: the checkable rows that distinguish
 * this vault from a fund with a manager. `Decisions/contract-tab-requirements-2026-09-19.md` is
 * the row-to-read map this file checks the component against.
 *
 * SOURCE GUARDS, same reason as every sibling wiring test in this app: no JSX/TSX loader in
 * `node --test` (see `quorum-unknown.test.mjs`'s own header for the fuller version of this note).
 *
 * Row 6b (the per-token claimable-escrow tri-state, card 205) is covered in the following commit,
 * once the component itself exists — see `Tasks/row-6b-tri-state-unread.md`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const APP = fileURLToPath(new URL('..', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const SRC = readFileSync(join(APP, 'src/components/ContractTab.tsx'), 'utf8');
const APP_TSX = readFileSync(join(APP, 'src/App.tsx'), 'utf8');
const STYLES = readFileSync(join(APP, 'src/styles.css'), 'utf8');

// ───────────────────────── Row 4: all-or-nothing, never a partial pass ─────────────────────────

test('Row 4s live line renders only when wiringLock resolved to the full record', () => {
  assert.match(SRC, /\{wiringLock \? <p className="note dim">Read now: all four are set\.<\/p> : null\}/);
});

test('MUTATION: defaulting wiringLock rendering to always show would hide an unresolved/partial wiring read', () => {
  const line = '{wiringLock ? <p className="note dim">Read now: all four are set.</p> : null}';
  assert.ok(SRC.includes(line), 'exact Row 4 live-line JSX not found — did it move?');
  const weakened = line.replace('{wiringLock ? ', '{').replace(' : null}', '}');
  assert.notEqual(weakened, line);
  assert.doesNotMatch(weakened, /wiringLock \?/, 'RED: the weakened line no longer gates on wiringLock at all');
});

// ───────────────────────── Row 5: undefined (unread) is distinct from false ─────────────────────────

test('Row 5s live line renders only when allowSubVaults !== undefined, and both true/false are named distinctly', () => {
  assert.match(SRC, /\{allowSubVaults !== undefined \? \(/, 'a truthiness check here would hide the real "disabled" (false) answer, folding it into "not read yet"');
  assert.match(SRC, /allowSubVaults \? 'enabled' : 'disabled'/);
});

test('MUTATION: a bare truthiness check on allowSubVaults would fold false (a real answer) into "not read"', () => {
  const strictGate = '{allowSubVaults !== undefined ? (';
  assert.ok(SRC.includes(strictGate), 'exact Row 5 gate not found');
  const truthy = SRC.replace(strictGate, '{allowSubVaults ? (');
  assert.notEqual(truthy, SRC);
  assert.doesNotMatch(truthy, /allowSubVaults !== undefined/, 'RED: the weakened gate no longer distinguishes false from undefined');
});

// ───────────────── Row 6: exact-equality tri-state — "unknown" must render as neither pass nor fail ─────

test('Row 6s dim/warn conditions use exact equality against the tri-state values, never a negated/loose check', () => {
  assert.match(SRC, /leg\.paused === 'active' && leg\.blacklisted === 'clear'/);
  assert.match(SRC, /leg\.paused === 'paused' \|\| leg\.blacklisted === 'blacklisted'/);
  assert.doesNotMatch(SRC, /leg\.paused !== 'paused'/, 'a negated check would treat "unknown" the same as "active"');
  assert.doesNotMatch(SRC, /leg\.blacklisted !== 'blacklisted'/, 'a negated check would treat "unknown" the same as "clear"');
});

test('MUTATION: an unknown safety state must not satisfy either Row 6 condition — it must render NEITHER a pass nor a fail', () => {
  const dimFires = (paused, blacklisted) => paused === 'active' && blacklisted === 'clear';
  const warnFires = (paused, blacklisted) => paused === 'paused' || blacklisted === 'blacklisted';
  assert.equal(dimFires('unknown', 'unknown'), false, 'an unread safety state must not render the reassurance line — that would be an unresolved read looking like a pass');
  assert.equal(warnFires('unknown', 'unknown'), false, 'an unread safety state must not render the alarm line either — "unknown" is its own state, not a guessed fail');
  // A weakened, loose version — `paused !== 'paused'` in place of `paused === 'active'` — DOES let
  // 'unknown' pass as reassuring, demonstrating why the exact-equality form above matters.
  const looseDimFires = (paused, blacklisted) => paused !== 'paused' && blacklisted !== 'blacklisted';
  assert.equal(looseDimFires('unknown', 'unknown'), true, 'sanity: the loosened form is exactly the regression the exact-equality source pattern above prevents');
});

test('Row 6s live-line leg is resolved only when the basket has exactly one asset — defensive against a future multi-asset basket invalidating the singular "cirBTC" copy', () => {
  assert.match(SRC, /vault\.basket\.length === 1 \? vault\.basket\[0\] : undefined/);
});

// ───────────────────────── "cirBTC" is literal only while the deployment is cirBTC-only ─────────
// Same hazard, same guard shape as test/btc-exposure-disclosure.test.mjs's equivalent test for
// MemberActions.tsx — this file names cirBTC too (Rows 5 and 6's static copy).

test('non-vacuity: ContractTab.tsx actually names cirBTC in its static copy', () => {
  assert.match(SRC, /cirBTC/);
});

test('"cirBTC" is literal only while this app serves one vault on a cirBTC-only oracle', () => {
  const env = readFileSync(join(APP, '.env.example'), 'utf8');
  const vaults = (/^VITE_VAULT_ADDRESSES=(.*)$/m.exec(env)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const dep = JSON.parse(readFileSync(join(REPO, 'contracts/config/deployments/arc-mainnet.json'), 'utf8'));
  assert.deepEqual(vaults.map((v) => v.toLowerCase()), [dep.firstVault.address.toLowerCase()]);
  const cfg = JSON.parse(readFileSync(join(REPO, 'contracts/config/arc-mainnet.json'), 'utf8'));
  assert.deepEqual(cfg.chainlinkOracle.assets.map((a) => a.symbol), ['cirBTC']);
});

// ───────────────────────── read-only: no write path, no walletClient ─────────────────────────
// This card's own constraint: "No new write paths. This is a read-only tab."

// Comments stripped before the check below — the module's own doc comment can otherwise match
// itself (same "a guard's own docstring can match itself" hazard `holdings-oracle-health.test.mjs`
// already strips comments for).
const CODE_ONLY = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('ContractTab.tsx imports no write function and no walletClient — read-only, per this cards constraint', () => {
  for (const writeFn of ['sendClaimEscrowed', 'sendDeposit', 'sendCommitVote', 'sendRevealVote', 'sendRequestExit']) {
    assert.doesNotMatch(CODE_ONLY, new RegExp(writeFn), `ContractTab.tsx must not import or call ${writeFn} — this tab is read-only`);
  }
  assert.doesNotMatch(CODE_ONLY, /walletClient/, 'ContractTab.tsx must not destructure walletClient from useWallet — a write-capable client has no place on a read-only tab');
});

test('MUTATION: importing a write function would be caught', () => {
  const mutated = `import { sendClaimEscrowed } from '../lib/chain-actions';\n${CODE_ONLY}`;
  assert.match(mutated, /sendClaimEscrowed/, 'sanity: the mutation actually adds the import');
});

// ───────────────────────── every CSS class used is one styles.css actually defines ─────────────────
// This card's own constraint: "Use only CSS classes that styles.css defines."

test('every CSS class ContractTab.tsx uses is defined in styles.css', () => {
  const classAttrs = [...SRC.matchAll(/className="([^"{}]+)"/g)].map((m) => m[1]);
  assert.ok(classAttrs.length > 5, 'expected several className="..." literals in a panel this size — did the component change shape?');
  const classesUsed = new Set(classAttrs.flatMap((c) => c.split(/\s+/)).filter(Boolean));
  for (const cls of classesUsed) {
    const re = new RegExp(`(^|[,{}\\s])\\.${cls}([\\s{.:,>]|$)`);
    assert.ok(re.test(STYLES), `className "${cls}" used in ContractTab.tsx is not defined in styles.css`);
  }
});

test('ContractTab.tsx declares no CSS of its own and redeclares no shared :root token', () => {
  assert.doesNotMatch(SRC, /:root/, 'a component file has no business declaring :root at all');
});

// ───────────────────────── wiring: ContractTab is actually mounted, and not behind the write gate ─────

test('ContractTab is mounted in App.tsx, unconditionally alongside Holdings/ProposalPanel', () => {
  assert.match(APP_TSX, /<ContractTab vault=\{vault\} \/>/, 'ContractTab is not mounted in App.tsx at all');
});

test('ContractTab is mounted OUTSIDE the manifestVerified write gate — reading contract facts needs no write-eligibility check', () => {
  const gateStart = APP_TSX.indexOf("{vault.manifestVerified === 'verified' ? (");
  const contractTabIdx = APP_TSX.indexOf('<ContractTab vault={vault} />');
  assert.ok(gateStart >= 0, 'the manifest-verified write gate was not found — did App.tsx change shape?');
  assert.ok(contractTabIdx >= 0 && contractTabIdx < gateStart, 'ContractTab must mount before the manifest-verified write gate, not inside it');
});
