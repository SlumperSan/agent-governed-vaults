#!/usr/bin/env node
// @ts-check
/**
 * Builds the Sign-queue items for the FIRST live Arc deposit: an owner-held persona EOA (Ballast
 * or Momentum, funded and disclosed in `docs/seeded-addresses.json`, PR #391 — card 210, Decisions/
 * Seed agent personas 2026-09-23.md), never the Safe. Three DIRECT (non-Safe) items per persona,
 * signed by the persona EOA itself, in the SAME shape `scripts/sign-queue/arc-deploy.mjs` and
 * `scripts/sign-queue/finalize-12.mjs` already use (`from`/`to`/`data`, no `dataTemplate` —
 * `scripts/lib/sign-queue-resolve.mjs` only knows the `safe-exec` template kind, which does not
 * apply here):
 *
 *   1. `persona-<name>-approve`: EOA -> USDC (`0x3600000000000000000000000000000000000000`)
 *      `approve(vault, amount)`.
 *   2. `persona-<name>-deposit`: EOA -> VaultCore `deposit(uint256)` — NOT the `(uint256,uint256)`
 *      slippage overload; that one is for the immediate-mint path only
 *      (VaultCore.sol:396-401), and a fresh EOA's first-ever deposit always takes the pending path.
 *   3. `persona-<name>-activate`: EOA -> VaultCore `activate(member)`. ALWAYS NEEDED HERE: `_deposit`
 *      (VaultCore.sol:407-435) mints immediately only when `windowCleared[msg.sender] ||
 *      sharesOf[msg.sender] > 0` — both false for a brand-new persona wallet — so the deposit is
 *      escrowed pending for `OBSERVATION_WINDOW` (VaultCore.sol:52, 4 hours) and `activate` is the
 *      one call that mints shares (`_activatePending`, VaultCore.sol:473-479). `activate` is
 *      natspec'd "Callable by anyone" (VaultCore.sol:438), but this builder has the persona itself
 *      call it, matching who signs the other two items in the sequence.
 *
 * `expectedNonce` is frozen ONCE per persona from that EOA's own live pending nonce, exactly the
 * discipline `arc-deploy.mjs` uses for its deployer nonce (`scripts/lib/sign-queue-preconditions.
 * mjs`'s `nonceGateRefusal`, wired into `scripts/lib/sign-queue-server.mjs` below) — a rebuild
 * reuses the frozen value off the existing queue rather than re-reading, and refuses outright if the
 * frozen item belongs to a DIFFERENT `--from`. Server-side preconditions (amount vs. live
 * `minDepositUsdc()`, balance (plus a gas headroom on the approve item — see GAS_HEADROOM_RAW
 * below), frozen-vault, allowance, the seeded-address gate, the two-persona ordering gate) live in
 * `scripts/lib/sign-queue-preconditions.mjs`, never baked into the data this file builds — see that
 * module's persona-deposit section.
 *
 * GAS ON ARC IS PAID IN USDC — measured, not assumed: `eth_getBalance` and `USDC.balanceOf` on the
 * same address returned 11069932331621126434 and 11069932 respectively (2026-09-23,
 * rpc.mainnet.arc.io) — dividing the first by 1e18 and the second by 1e6 both give 11.069932,
 * confirming they read the SAME underlying balance through two different decimal presentations
 * (18-decimal native, 6-decimal ERC-20 view). A persona funded with EXACTLY the deposit amount can
 * therefore pay for the approve item's own gas out of the same balance the deposit still needs —
 * `personaDepositPreconditionRefusal`'s approve-item balance check requires headroom above the
 * deposit amount for exactly this reason; fund each persona wallet with the deposit amount PLUS
 * headroom (see GAS_HEADROOM_RAW's own comment for the measured gas-price basis).
 *
 * Every item's `postCheckPlan` records `sharesOf`/`totalShares`/`navWad`/`idleUsdc`/the persona's
 * own USDC balance once that item confirms `done` (`recordPersonaPostCheck`,
 * `scripts/lib/sign-queue-server.mjs`) — set on ALL THREE items (approve, deposit, activate), not
 * only deposit/activate, so the approve item's recorded balance becomes the BASELINE the deposit
 * item's own post-check diffs against for `holderUsdcBalanceDelta`.
 *
 * Vault address: `contracts/config/deployments/arc-mainnet.json`'s `firstVault.address` if that
 * file exists in this checkout (PR #390, open as of this writing); otherwise the cited literal
 * below, re-read independently on two RPC endpoints per PR #390's own record
 * (`factory.allVaults(0)` == `firstVault.address` == `0x4EAE5C6D753AAC0b4825d41c12e71f0a8bE579f6`).
 *
 * Writes nothing to the chain — `cast` is used only for pure encoding (`calldata`), plus one read
 * (the persona's own pending nonce) frozen the same way `arc-deploy.mjs` freezes the deployer
 * nonce. Never touches the live queue file when driven through `build()` directly (used by
 * `scripts/test/persona-deposit.test.mjs` against temp queue paths only) — only `main()`, run as a
 * script, reads/writes the real Sign-queue file at `scripts/lib/sign-queue.mjs`'s `QUEUE_PATH`.
 *
 * Usage: `node scripts/sign-queue/persona-deposit.mjs --from 0x... --persona Ballast --amount-usdc 100`
 * Env:   ARC_RPC (default https://rpc.mainnet.arc.io), CAST (default "cast")
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'viem';
import {
  mergeBuiltItems, normAddr, readQueue, writeQueueAtomic,
} from '../lib/sign-queue.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CAST = process.env.CAST ?? 'cast';
const RPC = process.env.ARC_RPC ?? 'https://rpc.mainnet.arc.io';
const CHAIN_ID = 5042;
const CHAIN_NAME = 'Arc';
/** Card 210's exact two personas. Not open-ended: an unrecognised persona is very likely a typo
 * for a real listing, and this queue signs real transactions. */
const PERSONAS = ['Ballast', 'Momentum'];
/** `factory.allVaults(0)` on Arc mainnet, PR #390 (`docs/evidence`/`contracts/config/deployments/
 * arc-mainnet.json` once merged) — cross-checked on rpc.mainnet.arc.io and arc.gateway.tenderly.co.
 * TODO: once PR #390 lands on protocol/main, `resolveVaultAddress` below reads the deployment
 * record instead of this literal; delete the literal itself once that path is exercised for real. */
const FALLBACK_VAULT_ADDR = '0x4EAE5C6D753AAC0b4825d41c12e71f0a8bE579f6';
export const BUILDER_NAME = 'persona-deposit';

function cast(args) {
  return execFileSync(CAST, args, { encoding: 'utf8', windowsHide: true }).trim();
}

/** Live network read — the persona EOA's own pending nonce, `arc-deploy.mjs`'s exact pattern
 * (`cast nonce <addr> --rpc-url <RPC>`). Overridable in `build()` so tests never touch the network. */
function liveReadNonce(addr) {
  return Number(cast(['nonce', addr, '--rpc-url', RPC]));
}

/** @param {string} name @returns {string} */
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || process.argv[i + 1] === undefined) {
    throw new Error(`missing required --${name} (no default)`);
  }
  return process.argv[i + 1];
}

/**
 * USDC has 6 decimals; `--amount-usdc` is a plain human-readable decimal amount (e.g. "100" or
 * "100.5"), REQUIRED with no default — an absent or unparsable amount throws rather than falling
 * back to some figure nobody asked for.
 * @param {string|undefined} raw @returns {bigint}
 */
export function usdcToRawUnits(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new Error('--amount-usdc is required and has no default');
  }
  const s = String(raw).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) {
    throw new Error(`--amount-usdc "${raw}" is not a plain decimal amount with at most 6 decimal places (USDC has 6 decimals)`);
  }
  const [whole, frac = ''] = s.split('.');
  const units = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0') || '0');
  if (units <= 0n) throw new Error(`--amount-usdc "${raw}" must be greater than zero`);
  return units;
}

/** @param {string} persona @returns {string} */
export function requirePersona(persona) {
  if (!PERSONAS.includes(persona)) {
    throw new Error(`--persona must be one of ${PERSONAS.join(', ')} (got ${JSON.stringify(persona)})`);
  }
  return persona;
}

/** `contracts/config/deployments/arc-mainnet.json`'s `firstVault.address` if that file exists in
 * this checkout (PR #390), else the cited fallback literal above.
 * @param {string} [root] */
export function resolveVaultAddress(root = ROOT) {
  const depPath = path.join(root, 'contracts', 'config', 'deployments', 'arc-mainnet.json');
  if (existsSync(depPath)) {
    const dep = JSON.parse(readFileSync(depPath, 'utf8'));
    const addr = dep?.firstVault?.address;
    if (typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr)) return addr;
    throw new Error('contracts/config/deployments/arc-mainnet.json exists but has no usable firstVault.address — PR #390 landed in an unexpected shape');
  }
  return FALLBACK_VAULT_ADDR;
}

/**
 * @param {object} p
 * @param {string} p.from persona EOA address
 * @param {string} p.persona 'Ballast' | 'Momentum'
 * @param {bigint} p.amountUsdcRaw raw USDC units (6 decimals) — already validated by `usdcToRawUnits`
 * @param {import('../lib/sign-queue.mjs').QueueItem[]} [p.existingItems] the CURRENT queue's items,
 *   for frozen-nonce reuse and detecting whether the OTHER persona has already deposited (ordering
 *   gate) — never read internally from the live queue file, so this function is safe to unit-test.
 * @param {(addr: string) => number} [p.readNonce] injectable — defaults to a live `cast nonce` read
 * @param {(args: string[]) => string} [p.castFn] injectable — defaults to real `cast` (pure/offline)
 * @param {string} [p.root] injectable repo root, for `resolveVaultAddress`/config reads in tests
 */
export function build({
  from, persona, amountUsdcRaw, existingItems = [], readNonce = liveReadNonce, castFn = cast, root = ROOT,
} = {}) {
  const addrFrom = getAddress(from); // throws on a malformed/invalid address
  requirePersona(persona);
  if (typeof amountUsdcRaw !== 'bigint') throw new Error('amountUsdcRaw must be a bigint — pass usdcToRawUnits(...)');

  const cfg = JSON.parse(readFileSync(path.join(root, 'contracts', 'config', 'arc-mainnet.json'), 'utf8'));
  const usdc = cfg.usdc;
  const minDepositUsdc = BigInt(cfg.smoke.minDepositUsdc);
  if (amountUsdcRaw < minDepositUsdc) {
    throw new Error(
      `persona-deposit: amount ${amountUsdcRaw} (raw USDC units) is below arc-mainnet.json's `
      + `smoke.minDepositUsdc (${minDepositUsdc}) — VaultCore.deposit would revert BelowMinDeposit; refusing to build it`,
    );
  }
  const vault = resolveVaultAddress(root);

  const personaLower = persona.toLowerCase();
  const idApprove = `persona-${personaLower}-approve`;
  const idDeposit = `persona-${personaLower}-deposit`;
  const idActivate = `persona-${personaLower}-activate`;

  const byId = new Map(existingItems.map((it) => [it.id, it]));
  const prevApprove = byId.get(idApprove);
  // Reuse the frozen nonce ONLY when the previous build was for the SAME address — `persona-
  // ballast-approve` is one queue id bound to one signer; re-running this builder for the same
  // persona but a DIFFERENT `--from` (an address typo, or the persona wallet being replaced) must
  // never silently inherit a nonce that belongs to somebody else's account.
  if (prevApprove && normAddr(prevApprove.from) !== normAddr(addrFrom)) {
    throw new Error(
      `persona-deposit: ${idApprove} already exists in the queue for ${prevApprove.from}, not ${addrFrom} `
      + '— refusing to reuse its frozen nonce for a different address',
    );
  }
  const baseNonce = (prevApprove && typeof prevApprove.expectedNonce === 'number')
    ? prevApprove.expectedNonce
    : readNonce(addrFrom);
  if (!Number.isInteger(baseNonce) || baseNonce < 0) {
    throw new Error(`persona-deposit: unusable base nonce ${baseNonce} for ${addrFrom}`);
  }

  const approveData = castFn(['calldata', 'approve(address,uint256)', vault, amountUsdcRaw.toString()]);
  const depositData = castFn(['calldata', 'deposit(uint256)', amountUsdcRaw.toString()]);
  const activateData = castFn(['calldata', 'activate(address)', addrFrom]);

  const commonFields = {
    chainId: CHAIN_ID, chainName: CHAIN_NAME, from: addrFrom, dataTemplate: null,
    status: 'pending', txHash: null, receipt: null, predictedAddress: null,
    sentData: null, builder: BUILDER_NAME, builtAt: new Date().toISOString(),
    sentAt: null, doneAt: null, verifyNote: null,
    persona, amountUsdcRaw: amountUsdcRaw.toString(), vault, usdc,
  };

  const approveItem = {
    ...commonFields, id: idApprove, order: 1,
    what: `${persona} (${addrFrom}): USDC.approve(vault ${vault}, ${amountUsdcRaw} raw units)`,
    to: usdc, value: '0', data: approveData, dependsOn: [], expectedNonce: baseNonce,
    personaAction: 'approve', postCheckPlan: { vault, usdc, holder: addrFrom },
  };
  const depositItem = {
    ...commonFields, id: idDeposit, order: 2,
    what: `${persona} (${addrFrom}): VaultCore.deposit(${amountUsdcRaw}) — first-ever deposit, escrows `
      + 'pending for OBSERVATION_WINDOW (4h)',
    to: vault, value: '0', data: depositData, dependsOn: [idApprove], expectedNonce: baseNonce + 1,
    personaAction: 'deposit', postCheckPlan: { vault, usdc, holder: addrFrom },
  };
  const activateItem = {
    ...commonFields, id: idActivate, order: 3,
    what: `${persona} (${addrFrom}): VaultCore.activate(${addrFrom}) — mints shares once the observation window has elapsed`,
    to: vault, value: '0', data: activateData, dependsOn: [idDeposit], expectedNonce: baseNonce + 2,
    personaAction: 'activate', postCheckPlan: { vault, usdc, holder: addrFrom },
  };

  // Ordering gate: if the OTHER persona already has an activate item in this queue THE VERY FIRST
  // TIME this persona's deposit item is built, this persona is the second mover, and its deposit
  // item must not go signable until the first's has actually minted shares — see
  // personaOrderingGateRefusal's own header (sign-queue-preconditions.mjs) for why this keys off
  // ACTIVATE rather than the literal "deposit item" it was briefed with.
  //
  // "First build only" is deliberate and FROZEN thereafter, exactly like the nonce above — never
  // recomputed on a rebuild. Recomputing it every time creates a cycle: build Ballast (no gate,
  // correctly — nothing else exists yet), build Momentum (gated on Ballast's activate, correctly),
  // then REBUILD Ballast — a naive "does the other persona have an activate item" check would now
  // find Momentum's and gate Ballast on it too, deadlocking both deposits on each other (or, once
  // either is sent/done, making `mergeBuiltItems` throw on the changed `dependsOn`). Freezing at
  // first build means whichever persona was built when the queue held no OTHER persona's items is
  // permanently the first mover, and every later rebuild of either persona reuses that same answer.
  const prevDeposit = byId.get(idDeposit);
  let orderingGate;
  if (prevDeposit) {
    orderingGate = prevDeposit.orderingGate; // undefined if this persona was first — stays that way
  } else {
    const otherActivate = existingItems.find(
      (it) => it.builder === BUILDER_NAME && it.personaAction === 'activate' && it.persona && it.persona !== persona,
    );
    if (otherActivate) orderingGate = { firstActivateId: otherActivate.id, firstPersonaFrom: otherActivate.from };
  }
  if (orderingGate) {
    depositItem.dependsOn = [...depositItem.dependsOn, orderingGate.firstActivateId];
    depositItem.orderingGate = orderingGate;
  }

  return [approveItem, depositItem, activateItem];
}

function main() {
  const from = arg('from');
  const persona = requirePersona(arg('persona'));
  const amountUsdcRaw = usdcToRawUnits(arg('amount-usdc'));
  const existing = readQueue();
  const items = build({ from, persona, amountUsdcRaw, existingItems: existing.items });
  const merged = mergeBuiltItems(existing.items, items, BUILDER_NAME);
  writeQueueAtomic({ items: merged });
  console.log(`persona-deposit: wrote/merged ${items.length} items into the Sign queue for ${persona} (${from})`);
  for (const it of items) console.log(`  ${it.order}. ${it.id} (nonce ${it.expectedNonce}) — ${it.what}`);
}

if (import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  main();
}
