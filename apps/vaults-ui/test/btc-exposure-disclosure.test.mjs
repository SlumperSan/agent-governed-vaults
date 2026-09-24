// @ts-check
/**
 * Card 218 (CPO, 2026-09-24): "Deposit USDC" reads as capital-stable, but the basket is cirBTC,
 * so a member's shares move with Bitcoin's price. The Deposit section must say so, UNCONDITIONALLY,
 * before the first deposit. Wording is the CMO's (Tasks/cpo-deposit-states-btc-exposure.md).
 *
 * SOURCE GUARDS, same shape as exit-freeze-gate.test.mjs (P-O13): no JSX/TSX loader in
 * `node --test`, so the component source is read and the disclosure's position and wrapping are
 * asserted on it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const APP = fileURLToPath(new URL('..', import.meta.url));
const ROOT = join(APP, '..', '..');
const SRC = readFileSync(join(APP, 'src/components/MemberActions.tsx'), 'utf8');

const PHRASES = [
  'What your USDC becomes.',
  'invests members’ USDC in cirBTC',
  'only when a member vote passes',
  'rises and falls with Bitcoin’s price',
  'USDC the vault has not invested does not',
];

/** Rendered text, near enough: JSX entities decoded, tags stripped. */
const text = (s) => s.replace(/&rsquo;/g, '’').replace(/<[^>]+>/g, '');

/** The source between `<h3>Deposit</h3>` and the first `<TermsClickwrap`, with `{/* … *\/}` comments removed. */
function depositHead(src = SRC) {
  const start = src.indexOf('<h3>Deposit</h3>');
  assert.ok(start >= 0, 'no <h3>Deposit</h3> in MemberActions.tsx — did the Deposit section move?');
  const end = src.indexOf('<TermsClickwrap', start);
  assert.ok(end > start, 'no <TermsClickwrap after <h3>Deposit</h3> — the disclosure must precede the clickwrap');
  return src.slice(start, end).replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

function check(src) {
  const head = depositHead(src);
  const p = /<p className="note">([\s\S]*?)<\/p>/.exec(head);
  assert.ok(p, 'no <p className="note"> between <h3>Deposit</h3> and <TermsClickwrap');
  const said = text(p[1]).replace(/\s+/g, ' ');
  for (const phrase of PHRASES) assert.ok(said.includes(phrase), `the disclosure no longer says "${phrase}"`);
  // Unconditional: nothing between the heading and the paragraph may open a JSX expression that
  // could wrap it (`{connected ? (`, `{vault.frozen && (`, `{depositStatus …`).
  const before = head.slice(0, p.index);
  assert.doesNotMatch(before, /\{[^}]*(\?|&&)/, 'the disclosure is wrapped in a conditional — it must render in every state');
}

test('the Deposit section states the BTC exposure, before the clickwrap, unconditionally', () => {
  check(SRC);
});

test('MUTATION: deleting the sentence, or gating it on connected/frozen, is red', () => {
  const para = /<p className="note"><strong>What your USDC becomes\.<\/strong>[\s\S]*?<\/p>/.exec(SRC);
  assert.ok(para, 'fixture anchor: the disclosure paragraph');
  assert.throws(() => check(SRC.replace(para[0], '')), /no <p className="note">|no longer says/);
  assert.throws(() => check(SRC.replace(para[0], `{connected ? (${para[0]}) : null}`)), /conditional/);
  assert.throws(() => check(SRC.replace(para[0], `{!vault.frozen && ${para[0]}}`)), /conditional/);
  assert.throws(() => check(SRC.replace('only when a member vote passes', 'when the agents decide')), /only when a member vote passes/);
  // Moved to just before <TermsClickwrap, which sits inside `{connected ? (`: gated, so red.
  const moved = SRC.replace(para[0], '').replace('<TermsClickwrap', `${para[0]}\n<TermsClickwrap`);
  assert.throws(() => check(moved), /conditional/);
});

test('"cirBTC" is literal only while this app serves one vault on a cirBTC-only oracle', () => {
  // The copy names cirBTC. That is true only because the one configured vault prices a single
  // asset, cirBTC, so if the app ever serves another vault or the oracle lists another asset, this
  // reds and the name must come from the vault's basketAssets instead.
  const env = readFileSync(join(APP, '.env.example'), 'utf8');
  const vaults = (/^VITE_VAULT_ADDRESSES=(.*)$/m.exec(env)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const dep = JSON.parse(readFileSync(join(ROOT, 'contracts/config/deployments/arc-mainnet.json'), 'utf8'));
  assert.deepEqual(vaults.map((v) => v.toLowerCase()), [dep.firstVault.address.toLowerCase()]);
  const cfg = JSON.parse(readFileSync(join(ROOT, 'contracts/config/arc-mainnet.json'), 'utf8'));
  assert.deepEqual(cfg.chainlinkOracle.assets.map((a) => a.symbol), ['cirBTC']);
});
