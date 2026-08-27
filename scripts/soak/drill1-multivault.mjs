#!/usr/bin/env node
// @ts-check
/**
 * DRILL 1 — MULTI-VAULT. A second vault with a different basket and config, proving
 *   (a) the operator leaderboard aggregates across BOTH vaults (SF-4), and
 *   (b) the indexer discovers the new vault DYNAMICALLY, with no restart or config edit.
 *
 * Why the config differs from the smoke vault in every dimension it can: a leaderboard that
 * merely sums two identical rows proves nothing about aggregation. Vault B runs a LINK-only
 * basket against the smoke vault's [WETH, LINK], half the capacity cap, twice the minimum
 * deposit, half the exit-fee ceiling, and a 50% governance quorum against the smoke vault's
 * 25% floor. If the leaderboard is really reading per-vault state, it has to reconcile two
 * genuinely different vaults.
 *
 * (b) is the claim that cannot be proven retroactively, so the ordering is load-bearing: the
 * indexer must already be RUNNING and caught up before createVault is signed. A snapshot taken
 * afterwards would be indistinguishable from a cold backfill. The drill therefore records the
 * indexer's head block BEFORE the transaction and asserts the vault appears in a snapshot the
 * daemon wrote afterwards without being restarted.
 *
 * Vault B is also drill 3's Mode-F host, so this drill leaves it activated with live shares.
 *
 * Env: SOAK_SIGNER_ARGS (required for the write steps), BASE_SEPOLIA_RPC, SOAK_API,
 *      SOAK_STATE_DIR, SOAK_INDEXER_STATE, SOAK_RESET=1 to start over.
 * Run:  node scripts/soak/drill1-multivault.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, RPC, log, assert, eq, call, callU, send, tryCall, chainNow, waitUntilChainTime, pollUntil,
  openState, runSteps, topicToAddress, TOPIC, SIGNER_ARGS, cast,
} from './lib.mjs';
import { loadDeployment, wiringExpectations } from './deployment.mjs';
import { apiGet } from './api-client.mjs';
import { vaultsIn, headBlockOf } from './snapshot.mjs';

const dep = loadDeployment(
  path.join(ROOT, 'contracts', 'config', 'deployments', 'base-sepolia.json'),
  { expectChainId: 84532 },
);
const soak = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'soak', 'soak-vaults.json'), 'utf8'));
const B = soak.vaultB;

const STATE_DIR = process.env.SOAK_STATE_DIR ?? path.join(ROOT, 'scripts', 'soak');
const STATE_PATH = path.join(STATE_DIR, '.state-drill1.json');
const INDEXER_STATE = process.env.SOAK_INDEXER_STATE ?? path.join(ROOT, 'data', 'indexer-state.json');

const { state, save, saveFirst } = openState(STATE_PATH, dep.factory);

/** Resolve a basket symbol list to token addresses via the verified address book. */
function tokensFor(symbols) {
  return symbols.map((s) => {
    const a = dep.assets.find((x) => x.symbol === s);
    assert(a, `basket asset ${s} is not in the deployment's oracle config`);
    return a.token;
  });
}
const TOKENS_B = tokensFor(B.basket);

// ────────────────────────────────── phases ──────────────────────────────────

function preflight() {
  log(`rpc=${RPC}  factory=${dep.factory}`);
  const chainId = Number(cast(['chain-id', '--rpc-url', RPC]));
  assert(chainId === dep.chainId, `RPC chain id ${chainId} != address-book chainId ${dep.chainId}`);

  // Re-prove the address book against the chain. A committed JSON file can drift from a
  // redeploy; spending a signature against a stale book is the expensive way to find out.
  for (const w of wiringExpectations(dep)) {
    const got = call(w.to, w.sig)[0];
    assert(eq(got, w.expect), `wiring drift: ${w.label} reads ${got}, address book says ${w.expect}`);
  }
  log(`wiring re-verified on-chain: ${wiringExpectations(dep).length}/${wiringExpectations(dep).length} match`);

  if (!state.signer) {
    assert(SIGNER_ARGS.length > 0, 'SOAK_SIGNER_ARGS is required; this script never handles the key itself');
    saveFirst('signer', cast(['wallet', 'address', ...SIGNER_ARGS], { interactive: true }).split('\n').pop().trim());
  }
  log(`signer ${state.signer}`);

  const eth = BigInt(cast(['balance', state.signer, '--rpc-url', RPC]));
  assert(eth >= 10n ** 16n, `signer needs >= 0.01 test ETH for gas (has ${eth} wei)`);
  if (!state.steps.deposit?.done) {
    const usdc = callU(dep.usdc, 'balanceOf(address)(uint256)', state.signer);
    assert(usdc >= BigInt(B.depositUsdc),
      `signer needs >= ${B.depositUsdc} USDC units for vault B (has ${usdc}) — faucet.circle.com, Base Sepolia`);
  }

  // Snapshot the indexer's position BEFORE anything is signed. This is what makes the
  // dynamic-discovery claim falsifiable rather than assumed.
  //
  // CAPTURE IT ONCE. `saveFirst` flushes to disk before a dependent send — it does NOT mean
  // "write only if absent", and it overwrites on every call. Re-running preflight on a resume
  // therefore replaced the pre-creation snapshot with a post-creation one, and the discovery
  // assertion then correctly refused its own evidence: "vault B was already in the indexer
  // snapshot before it was created". The snapshot is only meaningful while the vault does not
  // yet exist, so take it only then.
  if (!state.steps.createVaultB?.done && state.indexerHeadBefore === undefined) {
    const snap = readIndexerSnapshot();
    saveFirst('indexerHeadBefore', headBlockOf(snap));
    saveFirst('vaultsKnownBefore', vaultsIn(snap));
    log(`indexer before: head ${state.indexerHeadBefore}, ${state.vaultsKnownBefore.length} vault(s) known`);
  } else {
    assert(state.indexerHeadBefore !== undefined,
      'no pre-creation indexer snapshot in state, and vault B already exists — dynamic discovery cannot be proven for this vault. Use SOAK_RESET=1 with a fresh vault, or record the reconstruction and its provenance explicitly.');
    log(`indexer before (captured earlier, retained): head ${state.indexerHeadBefore}, ${state.vaultsKnownBefore.length} vault(s) known`);
  }
  log('preflight OK');
}

function readIndexerSnapshot() {
  assert(fs.existsSync(INDEXER_STATE),
    `indexer snapshot not found at ${INDEXER_STATE} — the indexer must be RUNNING before this drill, or dynamic discovery cannot be proven`);
  return JSON.parse(fs.readFileSync(INDEXER_STATE, 'utf8'));
}

function stepCreateVaultB() {
  // RESUME GUARD. `vaultB` is persisted immediately after the send, BEFORE the verification
  // reads below. If one of those reads failed (they are RPC-lag prone), the step is not marked
  // done but the vault genuinely exists — re-running createVault here would silently deploy a
  // SECOND vault and spend another 5M gas. Adopt the existing one instead.
  let r = null;
  let vault = state.vaultB;
  if (vault && Number(cast(['codesize', vault, '--rpc-url', RPC])) > 0) {
    log(`vault B ${vault} already exists from an earlier attempt — adopting it rather than creating a second`);
  } else {
    const params = `(${dep.usdc},[${TOKENS_B.join(',')}],${dep.aggregator},${B.capacityCapUsdc},${B.minDepositUsdc},${B.exitFeeMaxBps},${B.exitFeeDecayPeriod},[${dep.adapter}])`;
    r = send('factory.createVault(soak-B)', dep.factory,
      'createVault((address,address[],address,uint256,uint256,uint256,uint256,address[]))', params);
    const created = r.logs.find((l) => l.topics?.[0] === TOPIC.VaultCreated());
    assert(created, 'VaultCreated not found in receipt');
    vault = topicToAddress(created.topics[1]);
    saveFirst('vaultB', vault);
    saveFirst('createBlock', Number(r.blockNumber));
  }

  // Independent verification: re-read from the chain, not from the receipt. Polled, because the
  // public RPC is load-balanced and the node answering this read may not have applied the block
  // that the send just mined — a real observation, not a hypothetical.
  const codesize = pollUntil(
    () => Number(cast(['codesize', vault, '--rpc-url', RPC])),
    (n) => n > 0,
    { label: 'vault B codesize' },
  );
  const opId = pollUntil(
    () => callU(dep.registry, 'operatorOf(address)(uint256)', vault),
    (v) => v !== 0n,
    { label: 'vault B operator attestation' },
  );
  log(`vault B ${vault} created (codesize ${codesize}, operator id ${opId})`);
  state.steps.createVaultB = {
    done: true, tx: r?.transactionHash ?? state.steps.createVaultB?.tx ?? '(adopted from a prior attempt)',
    vault, codesize, operatorId: String(opId),
  };
  save();
}

function stepVerifyDistinctConfig() {
  // Prove on-chain that vault B really is configured differently from the smoke vault --
  // otherwise drill 1's whole premise (aggregation across DIFFERENT vaults) is unfounded.
  const v = state.vaultB;
  const smoke = soak.smokeVault.address;
  const reads = {
    capacityCapUsdc: 'capacityCapUsdc()(uint256)',
    minDepositUsdc: 'minDepositUsdc()(uint256)',
    exitFeeMaxBps: 'exitFeeMaxBps()(uint256)',
    exitFeeDecayPeriod: 'exitFeeDecayPeriod()(uint256)',
  };
  const diff = {};
  for (const [name, sig] of Object.entries(reads)) {
    const b = call(v, sig)[0];
    const s = call(smoke, sig)[0];
    diff[name] = { vaultB: b, smoke: s, differs: b !== s };
  }
  const bAssets = call(v, 'basketLength()(uint256)');
  diff.basketLength = { vaultB: bAssets[0], smoke: call(smoke, 'basketLength()(uint256)')[0] };
  assert(diff.capacityCapUsdc.differs && diff.exitFeeMaxBps.differs,
    `vault B is not meaningfully distinct from the smoke vault: ${JSON.stringify(diff)}`);
  log(`config distinctness verified: ${JSON.stringify(diff)}`);
  state.steps.verifyDistinctConfig = { done: true, diff };
  save();
}

function stepRegisterGovB() {
  const g = B.gov;
  const tuple = `(${g.commitDuration},${g.revealDuration},${g.timelockDuration},${g.executionWindow},${g.quorumBps},${g.proposalThresholdBps},${g.concentrationCapBps},${g.proposalCooldown})`;
  const r = send('governance.registerVault(soak-B)', dep.governance,
    'registerVault(address,(uint32,uint32,uint32,uint32,uint16,uint16,uint16,uint32))', state.vaultB, tuple);
  assert(call(dep.governance, 'vaultRegistered(address)(bool)', state.vaultB)[0] === 'true',
    'vault B not registered with governance');
  const cfg = call(dep.governance, 'configOf(address)(uint32,uint32,uint32,uint32,uint16,uint16,uint16,uint32)', state.vaultB);
  assert(Number(cfg[4]) === g.quorumBps, `quorumBps on-chain ${cfg[4]} != configured ${g.quorumBps}`);
  log(`vault B governance registered, quorum ${cfg[4]}bps (smoke vault runs 2500bps)`);
  state.steps.registerGovB = { done: true, tx: r.transactionHash, onChainConfig: cfg };
  save();
}

function stepDeposit() {
  const amt = B.depositUsdc;
  send('usdc.approve(vault B)', dep.usdc, 'approve(address,uint256)', state.vaultB, amt);
  const r = send(`vaultB.deposit(${amt})`, state.vaultB, 'deposit(uint256)', amt);
  const [pending, availableAt] = call(state.vaultB, 'pendingDeposit(address)(uint256,uint64)', state.signer);
  assert(BigInt(pending) === BigInt(amt), `pending ${pending} != ${amt}`);
  // EE-1 again, on a second vault: escrowed capital is excluded from NAV.
  const nav = callU(state.vaultB, 'navWad()(uint256)');
  assert(nav === 0n, `EE-1 violated: navWad should exclude the pending deposit, got ${nav}`);
  saveFirst('availableAt', Number(availableAt));
  log(`deposit escrowed; navWad still 0 (EE-1). Observation window ends at chain time ${availableAt}`);
  state.steps.deposit = { done: true, tx: r.transactionHash, pending, availableAt: Number(availableAt) };
  save();
}

async function stepActivate() {
  await waitUntilChainTime(state.availableAt, 'vault B observation window (4h)');
  const r = send('vaultB.activate', state.vaultB, 'activate(address)', state.signer);
  const shares = callU(state.vaultB, 'sharesOf(address)(uint256)', state.signer);
  const nav = callU(state.vaultB, 'navWad()(uint256)');
  const nps = callU(state.vaultB, 'navPerShareWad()(uint256)');
  assert(shares > 0n, 'no shares minted at activation');
  assert(nav > 0n, 'navWad still zero after activation');
  saveFirst('sharesB', shares.toString());
  log(`vault B activated: ${shares} shares, navWad ${nav}, navPerShare ${nps}`);
  state.steps.activate = { done: true, tx: r.transactionHash, shares: shares.toString(), navWad: nav.toString(), navPerShareWad: nps.toString() };
  save();
}

/** Wait for the RUNNING indexer to fold vault B in on its own. */
async function stepVerifyDynamicDiscovery() {
  const target = state.vaultB.toLowerCase();
  assert(!state.vaultsKnownBefore.includes(target),
    'vault B was already in the indexer snapshot before it was created — discovery cannot be proven');
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    const snap = readIndexerSnapshot();
    const known = vaultsIn(snap);
    if (known.includes(target)) {
      const head = headBlockOf(snap);
      log(`indexer discovered vault B dynamically: snapshot head ${head} (was ${state.indexerHeadBefore} pre-drill), ${known.length} vaults known`);
      state.steps.verifyDynamicDiscovery = {
        done: true, headBefore: state.indexerHeadBefore, headAfter: head,
        vaultsBefore: state.vaultsKnownBefore.length, vaultsAfter: known.length,
        createBlock: state.createBlock,
        // The load-bearing inequality, stated so the report does not have to re-derive it:
        // a snapshot taken at headBefore cannot contain a vault created in a LATER block.
        headBeforeIsEarlierThanCreation: Number(state.indexerHeadBefore) < Number(state.createBlock),
        ...(state.discoveryProvenance ? { provenance: state.discoveryProvenance } : {}),
      };
      save();
      return;
    }
    assert(Date.now() < deadline,
      `indexer did not pick up vault B within 5 minutes — it knows ${known.length} vault(s): ${known.join(', ')}`);
    log(`waiting for the indexer to fold in vault B (knows ${known.length} so far)…`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

/** SF-4: the operator leaderboard must aggregate across BOTH vaults, no cherry-picking. */
async function stepVerifyLeaderboard() {
  const vaults = await apiGet('/vaults');
  const lb = await apiGet('/operators/leaderboard');
  assert(vaults.status === 200 && lb.status === 200, `API read failed: ${vaults.status}/${lb.status}`);

  const listed = (vaults.body.vaults ?? []).map((v) => v.vault.toLowerCase());
  assert(listed.includes(state.vaultB.toLowerCase()), `/vaults does not list vault B: ${listed.join(', ')}`);
  assert(listed.includes(soak.smokeVault.address.toLowerCase()), '/vaults dropped the smoke vault');

  const rows = lb.body.leaderboard ?? [];
  const opId = Number(state.steps.createVaultB.operatorId);
  const row = rows.find((r) => Number(r.operatorId) === opId);
  assert(row, `operator ${opId} missing from the leaderboard`);
  assert(Number(row.vaultCount) >= 2,
    `SF-4 aggregation failed: operator ${opId} shows vaultCount ${row.vaultCount}, expected >= 2 (smoke vault + vault B)`);

  log(`SF-4 verified: operator ${opId} aggregates ${row.vaultCount} vaults; /vaults lists ${listed.length}`);
  state.steps.verifyLeaderboard = {
    done: true, vaultCount: row.vaultCount, listed, row,
    caveat: 'API ran FACILITATOR=stub — the 402 gate was exercised, on-chain settlement was NOT',
  };
  save();
}

// ────────────────────────────────── main ──────────────────────────────────

log('DRILL 1 — multi-vault: second vault, SF-4 leaderboard aggregation, dynamic indexer discovery');
preflight();
await runSteps([
  ['createVaultB', stepCreateVaultB],
  ['verifyDistinctConfig', stepVerifyDistinctConfig],
  ['registerGovB', stepRegisterGovB],
  ['deposit', stepDeposit],
  ['activate', stepActivate],
  ['verifyDynamicDiscovery', stepVerifyDynamicDiscovery],
  ['verifyLeaderboard', stepVerifyLeaderboard],
], state, save);

log('──────────────────────────────────────────────');
log('DRILL 1 PASSED');
log(`  vault B      ${state.vaultB}`);
log(`  shares       ${state.sharesB}`);
log(`  state file   ${STATE_PATH}`);
log('vault B is now drill 3\'s Mode-F host — run drill3-modef.mjs next.');
