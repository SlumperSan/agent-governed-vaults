// @ts-check
/**
 * `scripts/sign-queue/persona-deposit.mjs` — the builder for card 210's owner-decided first Arc
 * deposit (a persona EOA, never the Safe). `build()` never touches the live Sign-queue file or the
 * network: every network dependency (`readNonce`) and every `cast` invocation (`castFn`, pure/
 * offline encoding only) is injectable, and `root` points at a throwaway temp checkout so the
 * vault-address fallback and `contracts/config/arc-mainnet.json` reads are exercised without
 * touching this repo's own files.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  build, requirePersona, resolveVaultAddress, usdcToRawUnits,
} from '../sign-queue/persona-deposit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FROM = '0x1111111111111111111111111111111111111111';
const FROM2 = '0x2222222222222222222222222222222222222222';
const AMOUNT = 100_000_000n;
const CAST = process.env.CAST ?? 'cast';
const realCast = (args) => execFileSync(CAST, args, { encoding: 'utf8', windowsHide: true }).trim();
const noNetwork = () => { throw new Error('readNonce must not be called — this test proves no network read was needed'); };

// ─────────────────────────────── usdcToRawUnits ───────────────────────────────

test('usdcToRawUnits: missing --amount-usdc throws — REQUIRED, no default', () => {
  assert.throws(() => usdcToRawUnits(undefined), /required and has no default/);
  assert.throws(() => usdcToRawUnits(''), /required and has no default/);
});

test('usdcToRawUnits: whole and fractional amounts convert to raw 6-decimal USDC units', () => {
  assert.equal(usdcToRawUnits('100'), 100_000_000n);
  assert.equal(usdcToRawUnits('100.5'), 100_500_000n);
  assert.equal(usdcToRawUnits('0.000001'), 1n);
});

test('usdcToRawUnits: zero, negative, or too-many-decimal-places amounts throw', () => {
  assert.throws(() => usdcToRawUnits('0'), /must be greater than zero/);
  assert.throws(() => usdcToRawUnits('-5'), /not a plain decimal amount/);
  assert.throws(() => usdcToRawUnits('1.1234567'), /not a plain decimal amount/);
});

// ─────────────────────────────── requirePersona ───────────────────────────────

test('requirePersona: only Ballast/Momentum are accepted', () => {
  assert.equal(requirePersona('Ballast'), 'Ballast');
  assert.equal(requirePersona('Momentum'), 'Momentum');
  assert.throws(() => requirePersona('ballast'), /--persona must be one of/); // case-sensitive
  assert.throws(() => requirePersona('Drift'), /--persona must be one of/);
});

// ─────────────────────────────── resolveVaultAddress ───────────────────────────────

const TMP = mkdtempSync(path.join(tmpdir(), 'persona-deposit-test-'));
after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
let n = 0;
/** A throwaway root carrying only `contracts/config/arc-mainnet.json` (copied from the real repo,
 * so the smoke.minDepositUsdc/usdc figures this test relies on are the REAL ones, not invented) and
 * optionally `contracts/config/deployments/arc-mainnet.json`. */
function fixtureRoot({ withDeploymentRecord } = {}) {
  const root = path.join(TMP, `root${n++}`);
  mkdirSync(path.join(root, 'contracts', 'config'), { recursive: true });
  cpSync(path.join(ROOT, 'contracts', 'config', 'arc-mainnet.json'), path.join(root, 'contracts', 'config', 'arc-mainnet.json'));
  if (withDeploymentRecord) {
    mkdirSync(path.join(root, 'contracts', 'config', 'deployments'), { recursive: true });
    writeFileSync(
      path.join(root, 'contracts', 'config', 'deployments', 'arc-mainnet.json'),
      JSON.stringify({ firstVault: { address: withDeploymentRecord } }),
    );
  }
  return root;
}

test('resolveVaultAddress: falls back to the cited literal when contracts/config/deployments/arc-mainnet.json does not exist (PR #390 not merged)', () => {
  const root = fixtureRoot({});
  assert.equal(resolveVaultAddress(root), '0x4EAE5C6D753AAC0b4825d41c12e71f0a8bE579f6');
});

test('resolveVaultAddress: reads firstVault.address once contracts/config/deployments/arc-mainnet.json exists (PR #390 landed)', () => {
  const addr = `0x${'9'.repeat(39)}b`;
  const root = fixtureRoot({ withDeploymentRecord: addr });
  assert.equal(resolveVaultAddress(root), addr);
});

// ─────────────────────────────── build() ───────────────────────────────

test('build(): refuses an amount below arc-mainnet.json\'s smoke.minDepositUsdc (100 USDC)', () => {
  const root = fixtureRoot({});
  assert.throws(
    () => build({
      from: FROM, persona: 'Ballast', amountUsdcRaw: 50_000_000n, root, castFn: realCast, readNonce: () => 0,
    }),
    /below arc-mainnet\.json's smoke\.minDepositUsdc/,
  );
});

/** `cast abi-decode --input` refuses a selector-prefixed calldata string — strip the 4 leading
 * bytes before handing it the encoded arguments, per `cast abi-decode --help`. */
const decodeArgs = (sig, data) => realCast(['abi-decode', '--input', sig, `0x${data.slice(10)}`]).trim().split('\n').map((l) => l.trim());

test('build(): the three items encode the EXACT calldata their names claim, decoded independently (not re-using the builder\'s own encoding)', () => {
  const root = fixtureRoot({});
  const vault = resolveVaultAddress(root);
  const usdc = JSON.parse(readFileSync(path.join(root, 'contracts', 'config', 'arc-mainnet.json'), 'utf8')).usdc;
  const [approveItem, depositItem, activateItem] = build({
    from: FROM, persona: 'Ballast', amountUsdcRaw: AMOUNT, root, castFn: realCast, readNonce: () => 7,
  });

  assert.equal(approveItem.id, 'persona-ballast-approve');
  assert.equal(approveItem.to, usdc);
  assert.equal(realCast(['sig', 'approve(address,uint256)']), approveItem.data.slice(0, 10));
  const [decodedVault, decodedAmount] = decodeArgs('approve(address,uint256)', approveItem.data);
  assert.equal(decodedVault.toLowerCase(), vault.toLowerCase());
  assert.match(decodedAmount, new RegExp(`^${AMOUNT}\\b`));

  assert.equal(depositItem.id, 'persona-ballast-deposit');
  assert.equal(depositItem.to, vault);
  assert.equal(realCast(['sig', 'deposit(uint256)']), depositItem.data.slice(0, 10));
  assert.match(decodeArgs('deposit(uint256)', depositItem.data)[0], new RegExp(`^${AMOUNT}\\b`));
  // Never the (uint256,uint256) slippage overload — that path is for the immediate-mint case only.
  assert.notEqual(depositItem.data.slice(0, 10), realCast(['sig', 'deposit(uint256,uint256)']));

  assert.equal(activateItem.id, 'persona-ballast-activate');
  assert.equal(activateItem.to, vault);
  assert.equal(realCast(['sig', 'activate(address)']), activateItem.data.slice(0, 10));
  assert.equal(decodeArgs('activate(address)', activateItem.data)[0].toLowerCase(), FROM.toLowerCase());
});

test('build(): expectedNonce is sequential from the frozen base (approve=n, deposit=n+1, activate=n+2), and dependsOn chains approve->deposit->activate', () => {
  const root = fixtureRoot({});
  const [approveItem, depositItem, activateItem] = build({
    from: FROM, persona: 'Ballast', amountUsdcRaw: AMOUNT, root, castFn: realCast, readNonce: () => 12,
  });
  assert.equal(approveItem.expectedNonce, 12);
  assert.equal(depositItem.expectedNonce, 13);
  assert.equal(activateItem.expectedNonce, 14);
  assert.deepEqual(approveItem.dependsOn, []);
  assert.deepEqual(depositItem.dependsOn, ['persona-ballast-approve']);
  assert.deepEqual(activateItem.dependsOn, ['persona-ballast-deposit']);
});

test('build(): idempotent re-run — a rebuild with the approve item already in the queue reuses its frozen nonce and never re-reads the network', () => {
  const root = fixtureRoot({});
  const [firstApprove] = build({
    from: FROM, persona: 'Ballast', amountUsdcRaw: AMOUNT, root, castFn: realCast, readNonce: () => 20,
  });
  const [approveAgain, depositAgain, activateAgain] = build({
    from: FROM, persona: 'Ballast', amountUsdcRaw: AMOUNT, root, castFn: realCast,
    existingItems: [firstApprove], readNonce: noNetwork,
  });
  assert.equal(approveAgain.expectedNonce, 20);
  assert.equal(depositAgain.expectedNonce, 21);
  assert.equal(activateAgain.expectedNonce, 22);
});

test('build(): re-running for the SAME persona id but a DIFFERENT --from address refuses rather than reusing the wrong nonce', () => {
  const root = fixtureRoot({});
  const [firstApprove] = build({
    from: FROM, persona: 'Ballast', amountUsdcRaw: AMOUNT, root, castFn: realCast, readNonce: () => 20,
  });
  assert.throws(
    () => build({
      from: FROM2, persona: 'Ballast', amountUsdcRaw: AMOUNT, root, castFn: realCast,
      existingItems: [firstApprove], readNonce: noNetwork,
    }),
    /already exists in the queue for .*, not .* — refusing to reuse its frozen nonce for a different address/,
  );
});

test('build(): the FIRST persona built gets no ordering gate', () => {
  const root = fixtureRoot({});
  const [, depositItem] = build({
    from: FROM, persona: 'Ballast', amountUsdcRaw: AMOUNT, root, castFn: realCast, readNonce: () => 0,
  });
  assert.equal(depositItem.orderingGate, undefined);
});

test('build(): the SECOND persona built gets an ordering gate on the first persona\'s activate item', () => {
  const root = fixtureRoot({});
  const [, , ballastActivate] = build({
    from: FROM, persona: 'Ballast', amountUsdcRaw: AMOUNT, root, castFn: realCast, readNonce: () => 0,
  });
  const [, momentumDeposit] = build({
    from: FROM2, persona: 'Momentum', amountUsdcRaw: AMOUNT, root, castFn: realCast,
    existingItems: [ballastActivate], readNonce: () => 100,
  });
  assert.ok(momentumDeposit.dependsOn.includes('persona-ballast-activate'));
  assert.deepEqual(momentumDeposit.orderingGate, { firstActivateId: 'persona-ballast-activate', firstPersonaFrom: FROM });
});

test('build(): REBUILDING the first persona after the second already exists does not retroactively gate it — no cycle', () => {
  const root = fixtureRoot({});
  const ballastFirstBuild = build({
    from: FROM, persona: 'Ballast', amountUsdcRaw: AMOUNT, root, castFn: realCast, readNonce: () => 0,
  });
  const [, , momentumActivate] = build({
    from: FROM2, persona: 'Momentum', amountUsdcRaw: AMOUNT, root, castFn: realCast,
    existingItems: ballastFirstBuild, readNonce: () => 100,
  });
  // A naive "does the other persona have an activate item" recheck on every rebuild would now find
  // Momentum's activate item and gate Ballast on it too — deadlocking both deposits on each other.
  // The queue existing at this point holds BOTH personas' full item sets, exactly as the dashboard's
  // real queue file would after two separate `node persona-deposit.mjs` runs.
  const [, ballastDepositRebuilt] = build({
    from: FROM, persona: 'Ballast', amountUsdcRaw: AMOUNT, root, castFn: realCast,
    existingItems: [...ballastFirstBuild, momentumActivate], readNonce: noNetwork,
  });
  assert.equal(ballastDepositRebuilt.orderingGate, undefined);
  assert.deepEqual(ballastDepositRebuilt.dependsOn, ['persona-ballast-approve']);
});
