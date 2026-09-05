#!/usr/bin/env node
// @ts-check
/**
 * Seed an indexer snapshot for the demo run.
 *
 * `node packages/reference-agent/fixtures/seed-snapshot.mjs [path]`
 *
 * Nothing is deployed to mainnet: the only record in `contracts/config/deployments/` is
 * `base-sepolia.json`, a testnet trial. The events here are synthetic for a reason no deployment
 * changes, though. The demo needs a specific joint state across three vaults at once — see
 * `fixtures/demo-chain.mjs`, down to a reveal-phase proposal against a commit the demo agent
 * itself made — and no live chain can be relied on to be holding that at demo time. So rather than
 * serve whatever a real snapshot happened to contain, this folds synthetic events through the REAL
 * projection code (`packages/indexer/src/projections.mjs`) and writes them with the REAL store
 * (`store.mjs`, whose round-trip is already covered by the existing suite).
 *
 * The consequence matters: the API is not stubbed or special-cased for the demo. It loads this
 * snapshot exactly as it would load one the daemon produced, so the x402 loop, the projections,
 * and the route handlers are all genuinely exercised. Only the *events* are synthetic.
 *
 * The scenario matches fixtures/demo-chain.mjs — see that file for what each vault is for.
 */

import { applyAll } from '../../indexer/src/projections.mjs';
import { saveSnapshot } from '../../indexer/src/store.mjs';
import { DEMO_OPERATORS, DEMO_VAULTS } from './demo-chain.mjs';

const USDC = 10n ** 6n;
const AGENT = '0x000000000000000000000000000000000000dead';

let seq = 0;
/** Normalized-event shape, matching packages/indexer/src/chain.mjs normalizeLog. */
const ev = (name, vault, args) => ({ name, vault, blockNumber: 1000 + Math.floor(seq / 4), logIndex: seq++, args });

export function demoEvents() {
  seq = 0;
  return [
    // ── operators register, then attest their vaults ──────────────────────────
    ev('OperatorRegistered', null, { opId: DEMO_OPERATORS.meridian.opId, operator: DEMO_OPERATORS.meridian.address }),
    ev('OperatorRegistered', null, { opId: DEMO_OPERATORS.helios.opId, operator: DEMO_OPERATORS.helios.address }),

    ev('VaultCreated', DEMO_VAULTS.meridian, {
      vault: DEMO_VAULTS.meridian,
      creator: DEMO_OPERATORS.meridian.address,
      usdc: '0x' + 'c'.repeat(40),
      capacityCapUsdc: 1_000_000n * USDC,
    }),
    ev('VaultAttested', DEMO_VAULTS.meridian, { vault: DEMO_VAULTS.meridian, opId: DEMO_OPERATORS.meridian.opId }),

    ev('VaultCreated', DEMO_VAULTS.helios, {
      vault: DEMO_VAULTS.helios,
      creator: DEMO_OPERATORS.helios.address,
      usdc: '0x' + 'c'.repeat(40),
      capacityCapUsdc: 250_000n * USDC,
    }),
    ev('VaultAttested', DEMO_VAULTS.helios, { vault: DEMO_VAULTS.helios, opId: DEMO_OPERATORS.helios.opId }),

    // DRIFTER is created but NEVER attested — operatorId stays 0, which is the signal an agent
    // must treat as scam-quarantine (AGENT-QUICKSTART §4).
    ev('VaultCreated', DEMO_VAULTS.drifter, {
      vault: DEMO_VAULTS.drifter,
      creator: '0x' + 'ba'.repeat(20),
      usdc: '0x' + 'c'.repeat(40),
      capacityCapUsdc: 0n, // uncapped
    }),

    // ── members join ──────────────────────────────────────────────────────────
    ev('DepositPending', DEMO_VAULTS.meridian, { member: '0x' + '11'.repeat(20), amountUsdc: 250_000n * USDC, availableAt: 0 }),
    ev('DepositActivated', DEMO_VAULTS.meridian, { member: '0x' + '11'.repeat(20), amountUsdc: 250_000n * USDC, sharesMinted: 240_000n * USDC }),
    ev('DepositActivated', DEMO_VAULTS.meridian, { member: '0x' + '12'.repeat(20), amountUsdc: 150_000n * USDC, sharesMinted: 144_000n * USDC }),
    ev('DepositPending', DEMO_VAULTS.meridian, { member: '0x' + '13'.repeat(20), amountUsdc: 5_000n * USDC, availableAt: 0 }),

    ev('DepositActivated', DEMO_VAULTS.helios, { member: '0x' + '21'.repeat(20), amountUsdc: 100_000n * USDC, sharesMinted: 102_500n * USDC }),
    ev('DepositActivated', DEMO_VAULTS.helios, { member: AGENT, amountUsdc: 1_500n * USDC, sharesMinted: 1_500n * USDC }),

    ev('DepositActivated', DEMO_VAULTS.drifter, { member: '0x' + '31'.repeat(20), amountUsdc: 12_000n * USDC, sharesMinted: 12_000n * USDC }),

    // ── realized history: this is what the leaderboard is made of ─────────────
    // MERIDIAN's operator is net positive; HELIOS's has realized more loss than gain, which is the
    // exit trigger. SF-4: losses are included, no cherry-picking.
    ev('RealizationRecorded', DEMO_VAULTS.meridian, {
      vault: DEMO_VAULTS.meridian, opId: 1, member: '0x' + '11'.repeat(20),
      gainUsdc: 42_000n * USDC, lossUsdc: 6_000n * USDC, carryAfter: 0n,
    }),
    ev('FeeRecorded', DEMO_VAULTS.meridian, { opId: 1, amountUsdc: 3_600n * USDC }),

    ev('RealizationRecorded', DEMO_VAULTS.helios, {
      vault: DEMO_VAULTS.helios, opId: 2, member: '0x' + '21'.repeat(20),
      gainUsdc: 4_000n * USDC, lossUsdc: 19_500n * USDC, carryAfter: 15_500n * USDC,
    }),

    // ── an active Rebalance proposal on HELIOS ────────────────────────────────
    ev('Proposed', DEMO_VAULTS.helios, {
      pid: 42, vault: DEMO_VAULTS.helios, ptype: 0,
      proposer: DEMO_OPERATORS.helios.address, actionHash: '0x' + 'ab'.repeat(32),
    }),
  ];
}

/** @param {string} path */
export async function seed(path) {
  const state = applyAll(demoEvents());
  state.lastBlock = 1010;
  await saveSnapshot(path, state);
  return state;
}

// Run directly: node fixtures/seed-snapshot.mjs [path]
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('seed-snapshot.mjs')) {
  const path = process.argv[2] ?? './data/demo-snapshot.json';
  const state = await seed(path);
  console.log(
    `seeded ${path}: ${state.vaults.size} vaults, ${state.operators.size} operators, ${state.proposals.size} proposal(s), lastBlock ${state.lastBlock}`,
  );
}
