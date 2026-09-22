// @ts-check
/**
 * Card 176's closing condition: a green smoke harness against Base Sepolia for the three
 * member-signed flows this repository's own reconciliation found untested at the UI level —
 * deposit, vote (commit then reveal), exit. See `apps/vaults-ui/ui-smoke.ts` and
 * `apps/vaults-ui/test/lib/ui-smoke-chain.mjs` for what runs and why a fork rather than a bare
 * chain or a stub.
 *
 * WHAT RUNS THROUGH THE REAL APP CODE, ONCE PER ACTION, via `vite build --ssr ui-smoke.ts` (built
 * ONCE, reused for every action below): `sendDeposit`, `sendCommitVote`, `sendRevealVote`,
 * `sendRequestExit` from `src/lib/chain-actions.ts`, through a real viem `walletClient` built the
 * same way `wallet.tsx` builds one. WHAT RUNS OUT OF BAND, via `cast`/`forge` directly (setup only
 * — `apps/vaults-ui` has no UI for any of these): deploy, createVault, registerVault, activate,
 * propose, finalize, execute — mirroring `scripts/smoke-test.mjs`'s own lifecycle order for exactly
 * the steps that script also performs out of the member's own signature.
 *
 * ONE SIGNER FOR THE WHOLE RUN, deliberately, matching `scripts/smoke-test.mjs`: the throwaway
 * account is the vault's creator AND its sole depositor, so the exit round-trip is exact (no exit
 * fee, no other holder's share to reconcile) — the same shape that script's `stepExit` relies on.
 *
 * TIMING: real chain time, collapsed. `fastForward` (`evm_increaseTime` + `evm_mine`) turns the
 * REAL 4-hour deposit observation window and the REAL two REAL 1-hour commit/reveal windows into
 * milliseconds — the property that makes this a CI-shaped gate at all, instead of the 6-7 real
 * wall-clock hours `scripts/smoke-test.mjs` needs against the live network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFunctionData } from 'viem';
import {
  BASE_SEPOLIA_CHAIN_ID,
  activateVault,
  chainNow,
  createVault,
  dealErc20,
  deployProtocol,
  fastForward,
  finalizeAndExecute,
  generateThrowawayAccount,
  proposeNoOpRebalance,
  registerVault,
  requireBin,
  rmDir,
  setEthBalance,
  startFork,
} from './lib/ui-smoke-chain.mjs';
import {
  checkApprovalBounded,
  checkChainIdConsistent,
  checkEverySendSimulated,
  checkRecipient,
  sendSequence,
} from './lib/ui-smoke-assertions.mjs';

const APP = fileURLToPath(new URL('..', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const cfg = JSON.parse(readFileSync(path.join(REPO, 'contracts', 'config', 'base-sepolia.json'), 'utf8'));
const CHAIN_ID_HEX = `0x${BASE_SEPOLIA_CHAIN_ID.toString(16)}`;
const ONE_ETH = 10n ** 18n;

// ─────────────────────────── build the SSR harness once, reused by every action ───────────────────────────

function buildHarnessOnce() {
  // Nested under apps/vaults-ui/dist-ssr/ — already gitignored (apps/vaults-ui/.gitignore's
  // `dist-ssr/` line covers everything beneath it) and already excluded from every repo-wide test
  // walk (test-wiring-truth.test.mjs's SKIP_DIRS). Deliberately NOT os.tmpdir(): vite's SSR build
  // externalizes node_modules dependencies (viem, react) rather than bundling them, so the output
  // must stay inside apps/vaults-ui for Node's own node_modules resolution to find them when this
  // file is later run standalone via `node <outDir>/ui-smoke.js` — exactly why the existing
  // `npm run smoke` script builds `ssr-smoke.tsx` into `dist-ssr/` rather than an external path.
  // Suffixed with this process's pid so two agent sessions running this suite in the shared
  // checkout at once cannot clobber each other's build.
  const outDir = path.join(APP, 'dist-ssr', `ui-smoke-${process.pid}`);
  // node_modules/.bin/vite is a .cmd wrapper on Windows, and Node refuses to spawnSync a .cmd
  // without shell:true (CVE-2024-27980) — the exact trap scripts/gate.mjs's own "SHELL POLICY"
  // comment documents. Sidestepped entirely by running vite's real JS entrypoint through this
  // process's own node binary instead of through the OS-specific shim.
  const viteJs = path.join(APP, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(viteJs)) {
    throw new Error(`ui-smoke.test.mjs: vite entrypoint not found at ${viteJs} — run npm ci first`);
  }
  const r = spawnSync(process.execPath, [viteJs, 'build', '--ssr', 'ui-smoke.ts', '--outDir', outDir], {
    cwd: APP,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`vite build --ssr ui-smoke.ts failed (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
  }
  const entry = path.join(outDir, 'ui-smoke.js');
  if (!existsSync(entry)) throw new Error(`ui-smoke.test.mjs: vite did not produce ${entry}`);
  return { outDir, entry };
}

/** Runs one built harness action as a child process and parses its one `UI_SMOKE_RESULT ` line. */
function runAction(entry, env) {
  const r = spawnSync(process.execPath, [entry], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('UI_SMOKE_RESULT '));
  if (!line) {
    throw new Error(`ui-smoke action produced no UI_SMOKE_RESULT line.\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
  }
  return JSON.parse(line.slice('UI_SMOKE_RESULT '.length));
}

// ────────────────────────────────────────────── setup ──────────────────────────────────────────────

test('UI smoke harness — deposit, vote, exit against a local Base Sepolia fork, through the real app code', async (t) => {
  requireBin('anvil');
  requireBin('forge');
  requireBin('cast');

  const port = 20000 + (process.pid % 10000);
  const fork = await startFork({ port });
  const build = buildHarnessOnce();
  const { privateKey, account } = generateThrowawayAccount();
  const member = account.address;

  t.after(() => {
    fork.stop();
    rmDir(build.outDir);
  });

  await t.test('setup: fund throwaway signer on the fork only', () => {
    setEthBalance(fork.rpcUrl, member, `0x${(100n * ONE_ETH).toString(16)}`);
    dealErc20(fork.rpcUrl, cfg.usdc, member, 20_000_000n); // 20 USDC, well over the smoke deposit
  });

  let deployed;
  await t.test('setup: deploy DeployTestnet.s.sol (real, unmodified) onto the fork', () => {
    deployed = deployProtocol(fork.rpcUrl, privateKey);
    assert.match(deployed.factory, /^0x[0-9a-fA-F]{40}$/);
  });

  let vault;
  await t.test('setup: createVault + registerVault (out of band — no UI for either)', () => {
    vault = createVault(fork.rpcUrl, privateKey, {
      factory: deployed.factory,
      usdc: cfg.usdc,
      tokens: cfg.assets.map((a) => a.token),
      aggregator: deployed.aggregator,
      adapter: deployed.adapter,
      smoke: cfg.smoke,
    });
    assert.match(vault, /^0x[0-9a-fA-F]{40}$/);
    registerVault(fork.rpcUrl, privateKey, deployed.governance, vault, cfg.smoke.gov);
  });

  // ─────────────────────── MUTATION: wrong chain id, before any real signing happens ───────────────────────
  // Run first, against a vault that has NOTHING pending yet, so a caught-before-send failure here
  // cannot leave state the happy path below would trip over.
  await t.test('MUTATION: a wallet reporting the wrong chain id is refused before it ever sends', () => {
    const r = runAction(build.entry, {
      UI_SMOKE_RPC_URL: fork.rpcUrl,
      UI_SMOKE_PRIVATE_KEY: privateKey,
      UI_SMOKE_VAULT: vault,
      UI_SMOKE_ACTION: 'deposit',
      UI_SMOKE_AMOUNT_USDC: String(cfg.smoke.depositUsdc),
      UI_SMOKE_CHAIN_ID_OVERRIDE: '1', // Ethereum mainnet — never this app's TARGET_CHAIN
    });
    assert.equal(r.ok, false, 'RED expected: a wallet on the wrong chain must not be allowed to write');
    assert.match(r.error, /chain/i, `expected a chain-mismatch error, got: ${r.error}`);
    const sends = sendSequence(r.log ?? []);
    assert.deepEqual(sends, [], 'no approve/deposit send should have reached the chain on a chain-id mismatch');
  });

  // ─────────────────────────────────────────── happy path: deposit ───────────────────────────────────────────
  let depositLog;
  await t.test('deposit: real sendDeposit, through the real walletClient, against real bytecode', () => {
    const r = runAction(build.entry, {
      UI_SMOKE_RPC_URL: fork.rpcUrl,
      UI_SMOKE_PRIVATE_KEY: privateKey,
      UI_SMOKE_VAULT: vault,
      UI_SMOKE_ACTION: 'deposit',
      UI_SMOKE_AMOUNT_USDC: String(cfg.smoke.depositUsdc),
    });
    assert.equal(r.ok, true, `deposit failed: ${r.error}`);
    assert.ok(r.result.approvalHash && r.result.depositHash, 'sendDeposit must return both hashes');
    depositLog = r.log;

    assert.deepEqual(sendSequence(depositLog), ['approve', 'deposit'], 'deposit must approve then deposit, in that order');
    assert.equal(
      checkApprovalBounded(depositLog, { vault, amountUsdc: BigInt(cfg.smoke.depositUsdc) }),
      null,
      'approval must be exact-bounded to the deposit amount, not unbounded',
    );
    assert.equal(checkRecipient(depositLog, { functionName: 'deposit', expectedTo: vault }), null);
    assert.equal(checkEverySendSimulated(depositLog), null, 'every send must be preceded by an eth_call (simulateThenWrite)');
    assert.equal(checkChainIdConsistent(depositLog, CHAIN_ID_HEX), null);
  });

  // ─────────────── MUTATION: a second deposit while one is pending — a REAL contract revert ───────────────
  await t.test('MUTATION: a second deposit while one is pending is refused with a decoded PendingExists, not a raw selector', () => {
    const r = runAction(build.entry, {
      UI_SMOKE_RPC_URL: fork.rpcUrl,
      UI_SMOKE_PRIVATE_KEY: privateKey,
      UI_SMOKE_VAULT: vault,
      UI_SMOKE_ACTION: 'deposit',
      UI_SMOKE_AMOUNT_USDC: String(cfg.smoke.minDepositUsdc),
    });
    assert.equal(r.ok, false, 'RED expected: VaultCore.deposit reverts PendingExists on a second escrow');
    assert.match(r.error, /PendingExists/, `expected the DECODED custom error name, got: ${r.error}`);
  });

  // ─────────────────────────────── activate + propose (out of band, no UI for either) ───────────────────────────────
  let pid;
  let payload;
  let proposal;
  await t.test('setup: fast-forward the 4h observation window, then activate + propose', () => {
    const pending = spawnSyncCast(fork.rpcUrl, ['call', vault, 'pendingDeposit(address)(uint256,uint64)', member]);
    const pendingLines = pending.split('\n').map((l) => l.trim()).filter(Boolean);
    assert.equal(pendingLines.length, 2, `pendingDeposit(address) must return two values, got: ${pending}`);
    const availableAt = Number(pendingLines[1].split(' ')[0]);
    const now = chainNow(fork.rpcUrl);
    fastForward(fork.rpcUrl, Math.max(1, availableAt - now));
    activateVault(fork.rpcUrl, privateKey, vault, member);

    const shares = spawnSyncCast(fork.rpcUrl, ['call', vault, 'sharesOf(address)(uint256)', member]);
    assert.ok(BigInt(shares.split(' ')[0]) > 0n, 'activation must mint shares');

    // Governance.propose reads pastVotingEligibleShares(proposer, nowTs - 1) — a checkpoint
    // STRICTLY before the proposal's own block, on purpose (VO-9: same-second/flash stake carries
    // zero voting weight). Advance the clock past activation's own checkpoint before proposing, or
    // "own > 0" reads the pre-activation (zero) checkpoint and propose() reverts NoWeight.
    fastForward(fork.rpcUrl, 2);

    proposal = proposeNoOpRebalance(fork.rpcUrl, privateKey, deployed.governance, vault, deployed.adapter);
    pid = proposal.pid;
    payload = proposal.payload;
  });

  // ─────────────────────────────────────────── happy path: commit ───────────────────────────────────────────
  await t.test('commit: real sendCommitVote, through the real walletClient', () => {
    const r = runAction(build.entry, {
      UI_SMOKE_RPC_URL: fork.rpcUrl,
      UI_SMOKE_PRIVATE_KEY: privateKey,
      UI_SMOKE_VAULT: vault,
      UI_SMOKE_ACTION: 'commit',
      UI_SMOKE_PID: String(pid),
      UI_SMOKE_SUPPORT: 'true',
    });
    assert.equal(r.ok, true, `commit failed: ${r.error}`);
    assert.ok(r.result.commitHash && r.result.commitment, 'sendCommitVote must return both');
    assert.deepEqual(sendSequence(r.log), ['commitVote']);
    assert.equal(checkRecipient(r.log, { functionName: 'commitVote', expectedTo: deployed.governance }), null);
    assert.equal(checkEverySendSimulated(r.log), null);
  });

  // ─────────────────────────────────────────── happy path: reveal ───────────────────────────────────────────
  await t.test('reveal: real sendRevealVote — the salt is RE-DERIVED, never read from storage', () => {
    const now = chainNow(fork.rpcUrl);
    fastForward(fork.rpcUrl, Math.max(1, proposal.commitDeadline - now));

    const r = runAction(build.entry, {
      UI_SMOKE_RPC_URL: fork.rpcUrl,
      UI_SMOKE_PRIVATE_KEY: privateKey,
      UI_SMOKE_VAULT: vault,
      UI_SMOKE_ACTION: 'reveal',
      UI_SMOKE_PID: String(pid),
    });
    assert.equal(r.ok, true, `reveal failed: ${r.error}`);
    assert.ok(r.result.revealHash);
    assert.deepEqual(sendSequence(r.log), ['revealVote']);
    assert.equal(checkRecipient(r.log, { functionName: 'revealVote', expectedTo: deployed.governance }), null);
    assert.equal(checkEverySendSimulated(r.log), null);
  });

  // ─────────────────────────────── finalize + execute (out of band, no UI for either) ───────────────────────────────
  await t.test('setup: fast-forward past reveal, then finalize + execute the no-op rebalance', () => {
    const now = chainNow(fork.rpcUrl);
    fastForward(fork.rpcUrl, Math.max(1, proposal.revealDeadline - now));
    finalizeAndExecute(fork.rpcUrl, privateKey, deployed.governance, pid, payload);
    const pending = spawnSyncCast(fork.rpcUrl, ['call', deployed.governance, 'hasPendingExecution(address)(bool)', vault]);
    assert.equal(pending.trim(), 'false', 'exit must settle instantly (Mode I) below, not queue — execute must have cleared this');
  });

  // ─────────────────────────────────────────── happy path: exit ───────────────────────────────────────────
  await t.test('exit: real sendRequestExit — sole holder, exact round trip', () => {
    const shares = spawnSyncCast(fork.rpcUrl, ['call', vault, 'sharesOf(address)(uint256)', member]).split(' ')[0];
    const r = runAction(build.entry, {
      UI_SMOKE_RPC_URL: fork.rpcUrl,
      UI_SMOKE_PRIVATE_KEY: privateKey,
      UI_SMOKE_VAULT: vault,
      UI_SMOKE_ACTION: 'exit',
      UI_SMOKE_AMOUNT_USDC: shares,
    });
    assert.equal(r.ok, true, `exit failed: ${r.error}`);
    assert.ok(r.result.exitHash);
    assert.deepEqual(sendSequence(r.log), ['requestExit']);
    assert.equal(checkRecipient(r.log, { functionName: 'requestExit', expectedTo: vault }), null);
    assert.equal(checkEverySendSimulated(r.log), null);

    const sharesLeft = spawnSyncCast(fork.rpcUrl, ['call', vault, 'sharesOf(address)(uint256)', member]).split(' ')[0];
    assert.equal(BigInt(sharesLeft), 0n, 'sole holder exit must fully burn shares');
  });
});

/** Small local `cast call` helper for the setup-only reads above — not exported from
 * ui-smoke-chain.mjs because these are one-off reads specific to this test's own state machine,
 * not reusable lifecycle steps. */
function spawnSyncCast(rpcUrl, args) {
  const bin = requireBin('cast');
  const r = spawnSync(bin, [...args, '--rpc-url', rpcUrl], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`cast ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// ─────────────────────── fixture-based mutation tests of the CHECKERS themselves ───────────────────────
// No chain, no anvil, no build — pure log fixtures, the same style simulate-before-sign.test.mjs
// uses for its own coupling guards. These prove the assertion functions above actually
// discriminate, independent of whether any particular live run happens to be clean.

const VAULT = '0x1111111111111111111111111111111111111111';
const GOVERNANCE = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const APPROVE_ABI = [{ type: 'function', name: 'approve', inputs: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [] }];
const DEPOSIT_ABI = [{ type: 'function', name: 'deposit', inputs: [{ name: 'amountUsdc', type: 'uint256' }], outputs: [] }];

function sendEntry(to, data) {
  return { method: 'eth_sendTransaction', params: [{ to, data }] };
}
function callEntry(to, data) {
  return { method: 'eth_call', params: [{ to, data }] };
}

test('MUTATION: checkApprovalBounded reds on an unbounded (max-uint) approval, greens on the exact amount', () => {
  const maxUintData = encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: [VAULT, (1n << 256n) - 1n] });
  const redLog = [callEntry(VAULT, maxUintData), sendEntry(VAULT, maxUintData)];
  assert.match(checkApprovalBounded(redLog, { vault: VAULT, amountUsdc: 5_000_000n }) ?? '', /max/i);

  const exactData = encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: [VAULT, 5_000_000n] });
  const greenLog = [callEntry(VAULT, exactData), sendEntry(VAULT, exactData)];
  assert.equal(checkApprovalBounded(greenLog, { vault: VAULT, amountUsdc: 5_000_000n }), null);
});

test('MUTATION: checkRecipient reds when a send targets the wrong contract, greens on the right one', () => {
  const data = encodeFunctionData({ abi: DEPOSIT_ABI, functionName: 'deposit', args: [5_000_000n] });
  const redLog = [callEntry(OTHER, data), sendEntry(OTHER, data)]; // sent to the wrong address
  assert.match(checkRecipient(redLog, { functionName: 'deposit', expectedTo: VAULT }) ?? '', /expected/i);

  const greenLog = [callEntry(VAULT, data), sendEntry(VAULT, data)];
  assert.equal(checkRecipient(greenLog, { functionName: 'deposit', expectedTo: VAULT }), null);
});

test('MUTATION: checkEverySendSimulated reds on a send with no preceding eth_call (signed blind), greens when one precedes it', () => {
  const data = encodeFunctionData({ abi: DEPOSIT_ABI, functionName: 'deposit', args: [5_000_000n] });
  const redLog = [sendEntry(VAULT, data)]; // no eth_call before it — the pre-fix shape
  assert.match(checkEverySendSimulated(redLog) ?? '', /signed blind/);

  const greenLog = [callEntry(VAULT, data), sendEntry(VAULT, data)];
  assert.equal(checkEverySendSimulated(greenLog), null);
});

test('MUTATION: checkChainIdConsistent reds when a logged eth_chainId disagrees with the expected chain, greens when it matches', () => {
  const redLog = [{ method: 'eth_chainId', params: [], result: '0x1' }];
  assert.match(checkChainIdConsistent(redLog, '0x14a34') ?? '', /0x1/);

  const greenLog = [{ method: 'eth_chainId', params: [], result: '0x14a34' }];
  assert.equal(checkChainIdConsistent(greenLog, '0x14a34'), null);
});

test('non-firing branch: a correctly-ordered, correctly-bounded, correctly-addressed log trips none of the checkers', () => {
  const approveData = encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: [VAULT, 5_000_000n] });
  const depositData = encodeFunctionData({ abi: DEPOSIT_ABI, functionName: 'deposit', args: [5_000_000n] });
  const log = [
    { method: 'eth_chainId', result: CHAIN_ID_HEX },
    callEntry(VAULT, approveData),
    sendEntry(VAULT, approveData),
    callEntry(VAULT, depositData),
    sendEntry(VAULT, depositData),
  ];
  assert.equal(checkApprovalBounded(log, { vault: VAULT, amountUsdc: 5_000_000n }), null);
  assert.equal(checkRecipient(log, { functionName: 'deposit', expectedTo: VAULT }), null);
  assert.equal(checkEverySendSimulated(log), null);
  assert.equal(checkChainIdConsistent(log, CHAIN_ID_HEX), null);
});
