// @ts-check
/**
 * Owner decision 2026-10-18: this app stops offering deposits into the Arc v1 vault and keeps
 * exit, escrow claims, voting and every read. Three layers, each tested against the thing that
 * would regress:
 *
 *  1. RENDER. `ssr-deposits-closed.tsx` renders the real `MemberActions` and `EscrowClaims` at
 *     first paint for a flagged and an unflagged vault (built once with `vite build --ssr`, the
 *     way ui-smoke.test.mjs builds its harness). The deposit control must be absent for the
 *     flagged vault and present for the other; the exit control and the escrow section must be
 *     present for both. A first paint has no wallet, so the deposit button of the unflagged vault
 *     is rendered-but-disabled; "present" here means rendered, which is what "absent" is the
 *     contrast to.
 *  2. WRITE LAYER. `sendDeposit` refuses before its approval; no other write path mentions the
 *     policy. Source guards, because chain-actions.ts needs vite's aliases.
 *  3. WIRING. The exit button's `disabled` expression and EscrowClaims.tsx never reference the
 *     policy; the vault summary in App.tsx carries the notice.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { DEPOSITS_CLOSED_NOTICE, CONNECT_PROMPT_DEPOSITS_CLOSED } from '../src/lib/vault-policy.ts';

const APP = fileURLToPath(new URL('..', import.meta.url));
// LF-normalised: a Windows checkout may carry CRLF, and the multi-line anchors below are LF.
const read = (rel) => readFileSync(join(APP, rel), 'utf8').replace(/\r\n/g, '\n');
const NOTICE = DEPOSITS_CLOSED_NOTICE['v1-closed'];

// ─────────────────────────── 1. render ───────────────────────────

const outDir = join(APP, 'dist-ssr', `deposits-closed-${process.pid}`);
/** @type {{closed: string, open: string, closedAddress: string}} */
let html;

before(() => {
  const viteJs = join(APP, 'node_modules', 'vite', 'bin', 'vite.js');
  assert.ok(existsSync(viteJs), `vite entrypoint not found at ${viteJs}: run npm ci first`);
  const b = spawnSync(process.execPath, [viteJs, 'build', '--ssr', 'ssr-deposits-closed.tsx', '--outDir', outDir], {
    cwd: APP, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(b.status, 0, `vite build --ssr ssr-deposits-closed.tsx failed:\n${b.stdout}\n${b.stderr}`);
  const r = spawnSync(process.execPath, [join(outDir, 'ssr-deposits-closed.js')], { cwd: APP, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `the render harness failed:\n${r.stdout}\n${r.stderr}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('DEPOSITS_CLOSED_RENDER '));
  assert.ok(line, `no DEPOSITS_CLOSED_RENDER line in:\n${r.stdout}`);
  html = JSON.parse(line.slice('DEPOSITS_CLOSED_RENDER '.length));
});

after(() => {
  try { rmSync(outDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

const DEPOSIT_INPUT = 'placeholder="USDC amount"';
const DEPOSIT_BUTTON = />Deposit<\/button>/;
const EXIT_INPUT = 'placeholder="Shares"';
const EXIT_BUTTON = />Request exit<\/button>/;

test('render: for the flagged vault the deposit control is absent and the one-line notice is present', () => {
  assert.ok(html.closed.includes(NOTICE), 'the notice is not rendered for the flagged vault');
  assert.ok(html.closed.includes('data-testid="deposits-closed-notice"'));
  assert.ok(!html.closed.includes(DEPOSIT_INPUT), 'the USDC amount input is still rendered');
  assert.doesNotMatch(html.closed, DEPOSIT_BUTTON, 'the Deposit button is still rendered');
  assert.doesNotMatch(html.closed, /Depositing/);
  assert.ok(!html.closed.includes('Two signatures'), 'the approve-then-deposit helper is still rendered');
  assert.ok(html.closed.includes(CONNECT_PROMPT_DEPOSITS_CLOSED));
  assert.ok(!html.closed.includes('Connect a wallet to deposit'), 'the disconnected prompt still invites a deposit');
});

test('render: for an unflagged vault the deposit control is present and no closed notice is shown', () => {
  assert.ok(html.open.includes(DEPOSIT_INPUT), 'the USDC amount input is missing');
  assert.match(html.open, DEPOSIT_BUTTON, 'the Deposit button is missing');
  assert.ok(html.open.includes('Two signatures'));
  assert.ok(html.open.includes('Connect a wallet to deposit, vote, or exit.'));
  assert.ok(!html.open.includes(NOTICE));
  assert.ok(!html.open.includes('deposits-closed-notice'));
});

test('render: exit, vote and the escrow section are rendered for the flagged vault exactly as for the other', () => {
  for (const which of /** @type {const} */ (['closed', 'open'])) {
    const h = html[which];
    assert.ok(h.includes(EXIT_INPUT), `${which}: the exit shares input is missing`);
    assert.match(h, EXIT_BUTTON, `${which}: the Request exit button is missing`);
    assert.ok(h.includes('<h3>Exit</h3>'), `${which}: the Exit section is missing`);
    assert.ok(h.includes('<h3>Vote</h3>'), `${which}: the Vote section is missing`);
    assert.ok(h.includes('data-testid="exit-stale-oracle-disclosure"'), `${which}: the exit disclosure is missing`);
    assert.match(h, /scrow/, `${which}: no escrow-claims markup`);
  }
  // Everything from the Exit heading on is identical for the two vaults: the policy changes the
  // deposit surface above it and nothing below it.
  const fromExit = (h) => h.slice(h.indexOf('<h3>Exit</h3>'));
  assert.equal(fromExit(html.closed), fromExit(html.open));
});

test('render: the BTC-exposure disclosure above the deposit form is kept (card 218 pins it unconditional)', () => {
  assert.ok(html.closed.includes('What your USDC becomes.'));
});

// ─────────────────────────── 2. write layer ───────────────────────────

const CHAIN_ACTIONS = read('src/lib/chain-actions.ts');

/** The body of `export async function <name>`, up to the next top-level `export`. */
function fnBody(src, name) {
  const start = src.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} not found in chain-actions.ts: did it move?`);
  const next = src.indexOf('\nexport ', start + 10);
  return src.slice(start, next === -1 ? undefined : next);
}

function checkSendDeposit(src) {
  const body = fnBody(src, 'sendDeposit');
  const guard = body.indexOf('assertDepositsOpen(vault)');
  assert.ok(guard >= 0, 'sendDeposit does not call assertDepositsOpen(vault)');
  const firstSideEffect = Math.min(...['readVaultAddresses(', 'simulateThenWrite('].map((s) => body.indexOf(s)).filter((i) => i >= 0));
  assert.ok(guard < firstSideEffect, 'assertDepositsOpen runs after the approval path has started');
  assert.match(src, /import \{ assertDepositsOpen \} from '\.\/vault-policy';/);
}

test('write layer: sendDeposit refuses a closed vault before the approval', () => {
  checkSendDeposit(CHAIN_ACTIONS);
});

function checkOtherWritesUngated(src) {
  for (const name of ['sendRequestExit', 'sendClaimEscrowed', 'sendCommitVote', 'sendRevealVote']) {
    assert.doesNotMatch(fnBody(src, name), /assertDepositsOpen|vaultPolicy|depositsClosed/, `${name} is gated on the deposit policy`);
  }
  // The policy is consulted from exactly one write function.
  assert.equal(src.match(/assertDepositsOpen\(/g)?.length, 1, 'assertDepositsOpen is called from more than one place');
}

test('write layer: no exit, claim or vote write path consults the deposit policy', () => {
  checkOtherWritesUngated(CHAIN_ACTIONS);
});

// ─────────────────────────── 3. wiring ───────────────────────────

const MEMBER_ACTIONS = read('src/components/MemberActions.tsx');
const ESCROW = read('src/components/EscrowClaims.tsx');
const APP_TSX = read('src/App.tsx');

/** The Request exit button's opening tag, from `<button` to its label. */
function exitButtonTag(src) {
  const label = src.indexOf("{exit.busy ? 'Exiting…' : 'Request exit'}");
  assert.ok(label >= 0, 'exit button label not found');
  const open = src.lastIndexOf('<button', label);
  return src.slice(open, label);
}

function checkWiring(member, escrow, app) {
  assert.match(exitButtonTag(member), /disabled=\{[^}]*vaultActions\.exit\.available[^}]*\}/, 'precondition: the exit gate is still the vault-state verdict');
  assert.doesNotMatch(exitButtonTag(member), /closedNotice|depositsClosed|vaultPolicy/, 'the exit button is gated on the deposit policy');
  assert.doesNotMatch(escrow, /vault-policy|closedNotice|depositsClosed/, 'EscrowClaims consults the deposit policy');
  assert.match(member, /const closedNotice = depositsClosedNotice\(vaultAddr\);/);
  assert.match(member, /async function handleDeposit\(\) \{\n\s*if \(closedNotice !== null\) return;/, 'handleDeposit does not return early on a closed vault');
  assert.match(app, /depositsClosedNotice\(vault\.address\) !== null/, 'App.tsx does not show the notice in the vault summary');
  // Exit and claims stay mounted whatever the policy says.
  assert.match(app, /<MemberActions vault=\{vault\} \/>\s*<EscrowClaims vault=\{vault\} \/>/);
}

test('wiring: the exit button and escrow claims never read the policy; handleDeposit and the summary do', () => {
  checkWiring(MEMBER_ACTIONS, ESCROW, APP_TSX);
});

test('MUTATION (source): each defect below is red', () => {
  // sendDeposit: guard removed; guard moved after the approval path starts.
  const g = 'assertDepositsOpen(vault);';
  assert.ok(CHAIN_ACTIONS.includes(g), 'fixture anchor: the sendDeposit guard');
  assert.throws(() => checkSendDeposit(CHAIN_ACTIONS.replace(g, '')), /does not call assertDepositsOpen/);
  const read1 = 'const { usdc } = await readVaultAddresses(publicClient, vault);';
  assert.ok(CHAIN_ACTIONS.includes(read1), 'fixture anchor: the first read in sendDeposit');
  assert.throws(
    () => checkSendDeposit(CHAIN_ACTIONS.replace(g, '').replace(read1, `${read1}\n  ${g}`)),
    /runs after the approval path/,
  );
  // Exit button gated on the policy: red.
  const exitGate = 'vaultActions === null || !vaultActions.exit.available';
  assert.ok(MEMBER_ACTIONS.includes(exitGate), 'fixture anchor: the exit button gate');
  assert.throws(
    () => checkWiring(MEMBER_ACTIONS.replace(exitGate, `${exitGate} || closedNotice !== null`), ESCROW, APP_TSX),
    /exit button is gated/,
  );
  // EscrowClaims reading the policy: red.
  assert.throws(
    () => checkWiring(MEMBER_ACTIONS, ESCROW.replace('import { useWallet }', "import { depositsClosedNotice } from '../lib/vault-policy';\nimport { useWallet }"), APP_TSX),
    /EscrowClaims consults/,
  );
  // Another write path gated on the policy: red.
  const exitBody = fnBody(CHAIN_ACTIONS, 'sendRequestExit');
  const gated = CHAIN_ACTIONS.replace(exitBody, exitBody.replace('{\n', '{\n  assertDepositsOpen(vault);\n'));
  assert.notEqual(gated, CHAIN_ACTIONS);
  assert.throws(() => checkOtherWritesUngated(gated), /gated on the deposit policy|more than one place/);
  // handleDeposit's early return removed; summary notice removed: red.
  assert.throws(() => checkWiring(MEMBER_ACTIONS.replace('if (closedNotice !== null) return;\n', ''), ESCROW, APP_TSX), /early/);
  assert.throws(() => checkWiring(MEMBER_ACTIONS, ESCROW, APP_TSX.replace('depositsClosedNotice(vault.address) !== null', 'false')), /vault summary/);
});
