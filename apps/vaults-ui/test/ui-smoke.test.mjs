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
  rawSends,
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

  let usdcBeforeDeposit;
  await t.test('setup: fund throwaway signer on the fork only', () => {
    setEthBalance(fork.rpcUrl, member, `0x${(100n * ONE_ETH).toString(16)}`);
    dealErc20(fork.rpcUrl, cfg.usdc, member, 20_000_000n); // 20 USDC, well over the smoke deposit
    usdcBeforeDeposit = BigInt(spawnSyncCast(fork.rpcUrl, ['call', cfg.usdc, 'balanceOf(address)(uint256)', member]).split(' ')[0]);
    // NON-VACUITY: the exit round trip below asserts `usdcAfterExit === usdcBeforeDeposit`. That
    // equality holds trivially if both reads ever collapsed to the same wrong value (e.g. the
    // masked-empty-read shape `spawnSyncCast` now throws on above) — pin the baseline to the exact
    // amount `dealErc20` just funded, so the round-trip assertion is checking a known-real number,
    // not two possibly-equal unknowns.
    assert.equal(usdcBeforeDeposit, 20_000_000n, 'pre-deposit USDC balance must be exactly what dealErc20 funded');
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
    // No `?? []` here on purpose: ui-smoke.ts's failure branch must emit the real captured log
    // (see its own comment at the module-scope `log` declaration). If it ever stops doing that,
    // `r.log` is `undefined` — this named assertion is what should name that, rather than an
    // unlabelled TypeError several lines later from calling `.filter`/`.some` on `undefined`
    // (mutation-tested: removing `log` from ui-smoke.ts's `ok: false` payload reds HERE).
    assert.ok(Array.isArray(r.log), `ui-smoke.ts's failure branch must emit the captured log, got: ${JSON.stringify(r.log)}`);
    const log = r.log;

    // THE CLAIM UNDER TEST, checked FIRST and against the RAW log — this is what PR #373's REJECT
    // was about, checked ahead of `r.ok`/`r.error` on purpose. A live mutation run against this
    // exact test (this PR's #373 comment records the mutation table) found that disabling viem's
    // chain guard at the write-action layer (`chain: null` on `simulateThenWrite`'s
    // `simulateContract` call, which rides through the `request` object into `walletClient
    // .writeContract`) lets a real send actually reach the chain — which flips `r.ok` to `true`,
    // not `false`. If that ever regresses again, THIS assertion must be the one that names it, not
    // a generic ok/false mismatch several lines later that a reader has to go correlate with "did a
    // send leak" by hand.
    //
    // Raw `eth_sendTransaction` count (`rawSends`, ui-smoke-assertions.mjs), not `sendSequence`'s
    // decoded functionName list: `decodedSends` silently DROPS any send it cannot decode against its
    // five-function ABI mirror — a drifted mirror, or a send with no/garbled calldata, would read
    // back as zero decoded sends even though a real send reached the chain. Count every attempted
    // send, decodable or not.
    const leaked = rawSends(log);
    assert.deepEqual(leaked, [], `no eth_sendTransaction should have reached the chain on a chain-id mismatch, found ${leaked.length}`);

    // NON-VACUITY anchor, checked second (not first): prove the override hook actually fired, for a
    // case `rawSends` alone cannot catch — a throw in `main()` before `log = recording.log` runs
    // (ui-smoke.ts) leaves the module-scope default `log = []`, which reads as "no sends" regardless
    // of whether the override ever reached the app. This is not hypothetical: a live mutation run
    // with `chain: null` on `chain-actions.ts`'s per-call argument (this PR's #373 comment, table row
    // 3) hit exactly this shape — viem's `sendTransaction` never calls `getChainId` when `chain` is
    // explicitly `null`, so `eth_chainId` was never asked, and THIS anchor is what went red (ordered
    // ahead of `rawSends` in that run). Once the checks were reordered `rawSends`-first to match the
    // claim under test, a rerun of the same mutation aborted at `rawSends` before ever reaching this
    // line — so this anchor still guards a shape one call ordering away from firing again, not a
    // shape nothing has ever hit.
    assert.ok(log.some((e) => e.method === 'eth_chainId' && e.result === '0x1'), 'the chain-id-override hook must have answered eth_chainId as chain 1 at least once');

    assert.equal(r.ok, false, 'RED expected: a wallet on the wrong chain must not be allowed to write');
    // Tightened from a bare /chain/i, which also matches viem's unrelated `ChainNotFoundError`
    // ("No chain was provided to the request...") — a client MISCONFIGURATION, not a caught
    // mismatch, verified empirically (this PR's #373 comment) to also make `r.ok === false` and
    // satisfy /chain/i. `does not match the target chain` is viem's `ChainMismatchError`-only
    // wording (node_modules/viem/_esm/errors/chain.js), so this can't be satisfied by that other
    // error.
    assert.match(r.error, /does not match the target chain/, `expected a genuine chain-ID MISMATCH error (not viem's unrelated "no chain configured" error), got: ${r.error}`);

    const sends = sendSequence(log);
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
    // NON-VACUITY: checkChainIdConsistent returns null both when every eth_chainId answer matches
    // AND when the log holds zero eth_chainId entries at all (an empty filter has no wrong entries
    // either) — pin that this run actually exercised the check, not that it had nothing to check.
    assert.ok(depositLog.some((e) => e.method === 'eth_chainId'), 'depositLog must contain at least one eth_chainId entry for checkChainIdConsistent to actually check');
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

    // "Exact round trip" means the USDC too, not just the shares — a share count of zero says
    // nothing about whether the member got their money back. Sole-holder exit waives the exit
    // fee (VaultCore.sol's `_settleExit`: "fee would route to self; last-member waiver per
    // EE-8/EE-9") and this is a no-op rebalance (zero orders, so no realized gain or loss), so
    // the member's USDC balance after exit must equal exactly what it was before the deposit.
    const usdcAfterExit = BigInt(spawnSyncCast(fork.rpcUrl, ['call', cfg.usdc, 'balanceOf(address)(uint256)', member]).split(' ')[0]);
    assert.equal(usdcAfterExit, usdcBeforeDeposit, 'sole-holder exact round trip must return the exact USDC deposited, not just burn the shares');
  });
});

/** Small local `cast call` helper for the setup-only reads above — not exported from
 * ui-smoke-chain.mjs because these are one-off reads specific to this test's own state machine,
 * not reusable lifecycle steps. */
function spawnSyncCast(rpcUrl, args) {
  const bin = requireBin('cast');
  const r = spawnSync(bin, [...args, '--rpc-url', rpcUrl], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`cast ${args.join(' ')} failed: ${r.stderr}`);
  const out = r.stdout.trim();
  // `BigInt('')` is `0n`, not a throw — an empty-but-exit-0 `cast call` would silently read as a
  // real zero everywhere this helper feeds `BigInt(...)` (balances, share counts), making the
  // exact-round-trip and full-burn assertions pass on a value that was never actually read. Same
  // shape as the PR #373 REJECT one level down: refuse to let an empty read pass as data.
  if (!out) throw new Error(`cast ${args.join(' ')} produced no output (exit 0, empty stdout) — refusing to read this as zero`);
  return out;
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

test('NON-VACUITY: the chain-id-mismatch MUTATION test\'s own assertion actually reds when a send leaks through', () => {
  // This is PR #373's REJECT finding, pinned as a permanent regression guard. The live MUTATION
  // test above (`sendSequence(r.log)`, asserted `deepEqual([])`) can only prove the chain-id guard
  // works if that assertion is CAPABLE of failing. Before the fix, `ui-smoke.ts`'s failure branch
  // never emitted the module-scope `log` it captured, so the test read it through `r.log ?? []`
  // and the assertion was fed `[]` regardless of what actually happened on chain — it could not go
  // red for ANY behaviour, including a send that reached the chain. This reproduces exactly that
  // leaked-send shape (an approve+deposit pair that DID get sent) directly against `sendSequence`
  // and the real assertion line, independent of anvil/forge/cast, so it runs on every CI pass.
  const approveData = encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: [VAULT, 5_000_000n] });
  const depositData = encodeFunctionData({ abi: DEPOSIT_ABI, functionName: 'deposit', args: [5_000_000n] });
  const leakedLog = [
    callEntry(VAULT, approveData),
    sendEntry(VAULT, approveData),
    callEntry(VAULT, depositData),
    sendEntry(VAULT, depositData),
  ];
  const sends = sendSequence(leakedLog);
  assert.deepEqual(sends, ['approve', 'deposit'], 'sendSequence must read a real approve/deposit pair back, not an empty sequence');
  assert.throws(
    () => assert.deepEqual(sends, [], 'no approve/deposit send should have reached the chain on a chain-id mismatch'),
    assert.AssertionError,
    'RED expected: the live MUTATION test\'s own assertion must throw when fed a log where a send leaked through',
  );

  // NOTE on what is deliberately NOT asserted here: `sendSequence(undefined ?? [])` is always `[]`
  // — that is a fact about `??`'s own semantics, true independent of any application state, so an
  // `assert.deepEqual` on it cannot fail and would itself be exactly the tautological-assertion
  // shape this test exists to guard against. The real regression guard is the `assert.throws` above
  // (the leaked-send log fed through the REAL, un-fallback'd assertion line) plus `r.log` no longer
  // carrying a `?? []` at its one call site (grep it — `ui-smoke.test.mjs`'s only defined `sends`
  // comes from `sendSequence(r.log)`, not `sendSequence(r.log ?? [])`).
});

test('NON-VACUITY: the wrong-chain-id MUTATION test\'s raw-send-count check catches what sendSequence alone would miss', () => {
  // Found auditing this PR's own fix for the same vacuity shape one level down. `decodedSends`
  // (ui-smoke-assertions.mjs) silently DROPS any `eth_sendTransaction` entry it cannot decode
  // against its five-function ABI mirror (`if (!tx?.data) continue` / `catch { /* leave undecoded */ }`)
  // — by design, so it never MISREPORTS an unknown send as a known one, but that means `sendSequence`
  // undercounts: a send whose calldata does not match any of the five known selectors reads back as
  // zero decoded sends even though a real send reached the chain. A log with exactly one such send
  // (garbage, undecodable calldata) proves the gap: `sendSequence` reports it as absent while
  // `rawSends` (ui-smoke-assertions.mjs) — what the wrong-chain-id test now checks first — still
  // sees it. Run against the SAME exported functions the live test calls, and through an
  // `assert.throws`, the same way the sibling NON-VACUITY test above does: a bare length check on a
  // hand-built one-element array would itself be a constant expression incapable of failing,
  // exactly the shape this test exists to guard against.
  const undecodableLog = [sendEntry(VAULT, '0xdeadbeef')];
  assert.deepEqual(sendSequence(undecodableLog), [], 'sendSequence cannot decode this calldata against any of the five known functions, and correctly does not guess');
  const leaked = rawSends(undecodableLog);
  assert.equal(leaked.length, 1, 'rawSends must still see the send sendSequence silently dropped');
  assert.throws(
    () => assert.deepEqual(leaked, [], 'no eth_sendTransaction should have reached the chain on a chain-id mismatch'),
    assert.AssertionError,
    'RED expected: the live MUTATION test\'s raw-send-count assertion must throw when fed a log holding an undecodable send',
  );
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
