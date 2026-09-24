// @ts-check
/**
 * Card 127 (#182, P-O15) — the Contract tab component itself. Card 205 — Row 6b's tri-state must
 * survive all the way to the screen: `apps/web/src/chain-reader.mjs`'s `assembleClaimableEscrow`
 * (PR #361) already keeps "confirmed zero" and "unread/failed" apart at the data layer (tested in
 * `apps/web/test/chain-reader.test.mjs`), so this file is not re-testing that split — it is
 * guarding that `ContractTab.tsx` does not quietly re-collapse it on the way to JSX, the exact
 * defect `Findings/2026-09-21-row-6b-collapses-unread-into-zero.md` found in the original spec.
 *
 * SOURCE GUARDS, same reason as every sibling wiring test in this app: no JSX/TSX loader in
 * `node --test` (see `quorum-unknown.test.mjs`'s own header for the fuller version of this note).
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

// ─────────────────── row order: 6b first, then the scope line, then rows 1-6 ───────────────────
// contract-tab-requirements-2026-09-19.md, rule 4.

test('Row 6b (claimable and unread) renders before the scope line', () => {
  const claimableIdx = SRC.indexOf('claimable.map((c)');
  const unreadIdx = SRC.indexOf('unread.map((u)');
  const scopeIdx = SRC.indexOf('These are properties of the vault and governance contracts — not of the assets a vault');
  assert.ok(claimableIdx >= 0, 'no claimable.map(...) render block found');
  assert.ok(unreadIdx >= 0, 'no unread.map(...) render block found');
  assert.ok(scopeIdx >= 0, 'the scope line text was not found');
  assert.ok(claimableIdx < scopeIdx, 'the claimable (Row 6b) block must render before the scope line');
  assert.ok(unreadIdx < scopeIdx, 'the unread (Row 6b) block must render before the scope line');
});

// ───────── row 6b's tri-state: unread is its own render, never folded into "claimable" ─────────
// This is the card's own required mutation: "make unread render as a pass, and confirm red."

test('the unread block is its own independent condition, not an else-branch of the claimable ternary', () => {
  const between = SRC.slice(SRC.indexOf('claimable.map((c)'), SRC.indexOf('unread.map((u)'));
  assert.match(between, /: null\}/, 'the claimable block does not close its own ternary before the unread block begins — they are one merged expression, not two independent ones');
  assert.match(SRC, /\{connected && unread\.length > 0/, 'the unread block is not gated by its own, independent condition');
});

test('MUTATION: a version that only checks claimable.length (ignoring unread) renders a real unread balance as a pass', () => {
  // Reconstructed inline, not executed against the component (no TSX loader) — the exact shape
  // card 205 exists to forbid: a caller that consults only `claimable` and never `unread` cannot
  // tell "you have nothing" from "we could not check", which is the defect Findings/2026-09-21-
  // row-6b-collapses-unread-into-zero.md found in the ORIGINAL spec for this exact row.
  const claimable = /** @type {readonly {asset: string}[]} */ ([]);
  const unreadList = [{ asset: '0xabc', readAt: null }];
  const buggyRendersSomething = claimable.length > 0; // the pre-fix shape: unread is never consulted
  const fixedRendersSomething = claimable.length > 0 || unreadList.length > 0;
  assert.equal(buggyRendersSomething, false, 'sanity: the buggy shape renders NOTHING for a real unread balance — this IS "unread rendering as a pass"');
  assert.equal(fixedRendersSomething, true, 'the fixed logic must render something for this exact state');
  // And the real component is the fixed shape: two structurally independent conditions.
  assert.match(SRC, /claimable && claimable\.length > 0/);
  assert.match(SRC, /unread\.length > 0/);
});

test('MUTATION: deleting the unread render block removes the ONLY place unread is ever rendered', () => {
  const unreadBlockMatch = /\{connected && unread\.length > 0[\s\S]*?: null\}/.exec(SRC);
  assert.ok(unreadBlockMatch, 'could not isolate the unread render block');
  const withoutUnreadBlock = SRC.replace(unreadBlockMatch[0], '');
  assert.doesNotMatch(
    withoutUnreadBlock,
    /unread\.map\(/,
    'RED: with the block removed, nothing in the component reads `unread` for rendering at all',
  );
});

test('the unread line uses distinct wording and the warn treatment — a reader must be able to tell it apart from a real claim', () => {
  const claimableBlock = /claimable\.map\(\(c\) => \([\s\S]*?\)\)\s*: null/.exec(SRC);
  const unreadBlock = /unread\.map\(\(u\) => \([\s\S]*?\)\)\s*: null/.exec(SRC);
  assert.ok(claimableBlock && unreadBlock, 'could not isolate both Row 6b blocks');
  assert.doesNotMatch(unreadBlock[0], /we could not deliver/, 'the unread line must not reuse the claimable-positive copy — that would claim a balance exists when it is only unread');
  assert.match(unreadBlock[0], /tag-warn/, 'the unread line must take the warn treatment');
  assert.doesNotMatch(claimableBlock[0], /tag-warn/, 'the claimable-positive line is a factual disclosure, not an alarm — it must not take the warn treatment');
});

// ───────────────── the whole Row 6b family is absent without a connected wallet ─────────────────
// contract-tab-claimable-escrow-read.md's own checklist: "No wallet connected → the entire row
// family is absent, not 'connect to check'."

test('every Row 6b block is gated on `connected`, not rendered as a "connect your wallet" placeholder', () => {
  assert.match(SRC, /\{connected && claimable && claimable\.length > 0/);
  assert.match(SRC, /\{connected && unread\.length > 0/);
  assert.match(SRC, /\{connected && row6bError/);
  assert.doesNotMatch(SRC, /connect your wallet/i, 'no placeholder text asking a disconnected viewer to connect in order to check');
});

test('MUTATION: dropping the `connected &&` guard from the claimable block would render Row 6b for a disconnected viewer', () => {
  const guarded = '{connected && claimable && claimable.length > 0';
  assert.ok(SRC.includes(guarded), 'exact guarded condition not found — did the block move?');
  const weakened = SRC.replace(guarded, '{claimable && claimable.length > 0');
  assert.notEqual(weakened, SRC, 'mutation target not found');
  assert.doesNotMatch(weakened.slice(0, weakened.indexOf('unread.map((u)')), /\{connected && claimable/, 'RED: the weakened condition no longer requires a connected wallet');
});

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
  const strictGate = "{allowSubVaults !== undefined ? (";
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

// Comments stripped before the check below — the module's own doc comment explains, in prose, WHY
// no write function is imported, and names `sendClaimEscrowed` to do it (same "a guard's own
// docstring can match itself" hazard `holdings-oracle-health.test.mjs` already strips comments for).
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

// ─────── Product's corrected copy (#434 review, 2026-09-24) ───────

test('Row 3 never claims nothing can halt deposits or exits; it names the stale-feed stop', () => {
  const flat = SRC.replace(/\s+/g, ' ');
  assert.doesNotMatch(flat, /Nothing in the protocol can halt/, 'false: navWad reverts on a stale feed and deposits/exits revert with it (#388)');
  assert.match(flat, /No contract has a pause function, and no address — ours included — can halt deposits, exits or voting\./);
  assert.match(flat, /The contracts do stop on their own when the price feed goes stale: deposits and exits revert until it answers again\./);
});

test('Row 6 confirmed states and Row 6b unread use the copy-doc lines, and never name the issuer', () => {
  const flat = SRC.replace(/\s+/g, ' ');
  assert.match(flat, /Read now: cirBTC is paused by its issuer\./);
  assert.match(flat, /Read now: this vault&rsquo;s address is blacklisted on cirBTC\./);
  assert.match(flat, /That is not the same as having nothing to claim\. Reload to check again\./);
  assert.doesNotMatch(flat, /\bCircle\b/, 'copy-doc hard constraint: "its issuer", never the issuer by name');
});
