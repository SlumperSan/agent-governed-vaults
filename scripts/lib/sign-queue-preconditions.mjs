// @ts-check
/**
 * Server-side preconditions for the Sign queue: does the CHAIN currently agree it is safe to
 * enable a given item's Sign button? Every function here is read-only (`eth_call`/
 * `eth_getCode`/`eth_getTransactionCount`) via `scripts/lib/chain-rpc.mjs`, and every one returns
 * `{ok:true}` or `{ok:false, reason}` — never throws for an ordinary chain disagreement, so a
 * single item's failed read cannot take the rest of the panel down (`scripts/dashboard.mjs` wraps
 * each call in `Promise.allSettled` on top of this, matching `runLaunchChecks`'s own discipline).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ethCall, ethChainId, ethGetCode, ethGetTransactionCountPending, rpcCall,
} from './chain-rpc.mjs';
import { creatorCodeRefusal, safeRoutingPlanRefusal } from '../smoke-preflight.mjs';
import { P, STATUS } from './proposal-decode.mjs';

const ARC_RPC = 'https://rpc.mainnet.arc.io';
const ARC_CHAIN_ID = 5042;
const BASE_SEPOLIA_RPC = 'https://sepolia.base.org';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const encodeAddr = (a) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const encodeUint = (n) => BigInt(n).toString(16).padStart(64, '0');
const decodeAddr = (word) => `0x${word.slice(-40)}`;
const decodeBool = (word) => BigInt(`0x${word}`) !== 0n;

// VaultCore/USDC selectors used by the persona-deposit preconditions below — `cast sig`, not
// hand-typed (scripts/test/persona-deposit.test.mjs re-derives each one independently).
const SEL_MIN_DEPOSIT_USDC = '0xd98656fd'; // minDepositUsdc()
const SEL_NAV_WAD = '0xd09074c0'; // navWad()
const SEL_SHARES_OF = '0xf5eb42dc'; // sharesOf(address)
const SEL_PENDING_DEPOSIT = '0x3a64b492'; // pendingDeposit(address)
const SEL_BALANCE_OF = '0x70a08231'; // balanceOf(address) — ERC-20
const SEL_ALLOWANCE = '0xdd62ed3e'; // allowance(address,address) — ERC-20

/** Arc pays gas in USDC itself (`contracts/config/arc-mainnet.json`'s `usdcNote`: "On Arc USDC is
 * ALSO the native gas asset"), CONFIRMED by reading `eth_getBalance` and `USDC.balanceOf` on the
 * same address on 2026-09-23 (rpc.mainnet.arc.io): 11069932331621126434 / 1e18 and 11069932 / 1e6
 * both equal 11.069932 — the same balance through two decimal presentations, not two ledgers. The
 * gas price read on that RPC was 20,100,000,000 wei; three light calls (approve/deposit/activate)
 * at a generous 500,000 gas total costs roughly 1.005e16 wei, i.e. ~0.01 USDC — three orders of
 * magnitude below this headroom, which is sized for a gas-price spike rather than the median case.
 * A persona funded with EXACTLY the deposit amount would otherwise pass the approve item's balance
 * check, pay gas for it, and then have the deposit item correctly (but avoidably) refuse — so this
 * is required as headroom above `amount` on the APPROVE item specifically. */
const GAS_HEADROOM_RAW = 1_000_000n; // 1 USDC (6 decimals)

/**
 * The nonce gate: MetaMask picks the nonce, so a stray transaction from the same deployer between
 * this item's build and its send would silently put a CREATE at a different address than what was
 * predicted and baked into every dependent item's calldata. Refuse to enable Sign unless the
 * live pending nonce is EXACTLY the frozen `expectedNonce`.
 * @param {typeof fetch} fetchImpl @param {string} rpcUrl @param {string} from @param {number} expectedNonce
 */
export async function nonceGateRefusal(fetchImpl, rpcUrl, from, expectedNonce) {
  const r = await ethGetTransactionCountPending(fetchImpl, rpcUrl, from);
  if (!r.ok) return `could not read the live nonce for ${from}: ${r.reason}`;
  const live = Number(BigInt(r.result));
  if (live !== expectedNonce) {
    return `live nonce for ${from} is ${live}, this item was built expecting ${expectedNonce} — a `
      + 'transaction landed out of order, or a prior item in this sequence has not been mined yet. '
      + 'Refusing: signing now would put this CREATE at a different address than every dependent '
      + 'item already assumes.';
  }
  return null;
}

/** #329/card 208: the SAME preconditions `scripts/smoke-test.mjs`'s `stepCreateVault`/
 * `routeThroughSafe` check before broadcasting — `creatorCodeRefusal` (the declared contract
 * creator must actually have code, on the declared chain) and `safeRoutingPlanRefusal` (the built
 * plan must route through that same Safe, at the right target, calling the right function, as a
 * plain CALL with zero value/safeTxGas/baseGas/gasPrice) — plus a live
 * `getThreshold()==1 && getOwners()==[from]` read, since the pre-validated signature
 * (`scripts/lib/safe-exec.mjs`'s `preValidatedSignature`) is only valid when `from` is a CURRENT
 * Safe owner and `msg.sender==owner` is sufficient authorisation, which is only true at
 * threshold 1.
 * @param {typeof fetch} fetchImpl
 * @param {{safe:string, owner:string, plan:{to:string,action:string,expectedTo:string,data:string,operation:number,value:string|number,safeTxGas:string|number,baseGas:string|number,gasPrice:string|number}}} p
 */
export async function safeRoutedRefusal(fetchImpl, { safe, owner, plan, expectedSafeNonce }) {
  const [codeR, chainR] = await Promise.all([
    ethGetCode(fetchImpl, ARC_RPC, safe), ethChainId(fetchImpl, ARC_RPC),
  ]);
  if (!codeR.ok || !chainR.ok) {
    return `could not read the creator Safe's code/chain id: ${[!codeR.ok && codeR.reason, !chainR.ok && chainR.reason].filter(Boolean).join('; ')}`;
  }
  const codeRefusal = creatorCodeRefusal({
    address: safe, code: codeR.result, observedChainId: Number(BigInt(chainR.result)),
    declaredChainId: ARC_CHAIN_ID, kind: 'contract',
  });
  if (codeRefusal) return codeRefusal;

  const planRefusal = safeRoutingPlanRefusal({ intended: safe, safe, ...plan });
  if (planRefusal) return planRefusal;

  const [thresholdR, ownersR] = await Promise.all([
    ethCall(fetchImpl, ARC_RPC, safe, '0xe75235b8'), // getThreshold()
    ethCall(fetchImpl, ARC_RPC, safe, '0xa0e67e2b'), // getOwners()
  ]);
  if (!thresholdR.ok) return `could not read Safe.getThreshold(): ${thresholdR.reason}`;
  const threshold = BigInt(thresholdR.result);
  if (threshold !== 1n) {
    return `Safe ${safe} now reports getThreshold() ${threshold}, not 1 — a pre-validated `
      + '(no-ECDSA) signature is only valid when the Safe requires exactly 1 signature and `from` '
      + 'is itself an owner. Raise this to a real multi-owner signature flow before signing.';
  }
  if (!ownersR.ok) return `could not read Safe.getOwners(): ${ownersR.reason}`;
  // Dynamic array ABI decoding, minimal: offset word, length word, then N address words.
  const hex = ownersR.result.replace(/^0x/, '');
  const len = Number(BigInt(`0x${hex.slice(64, 128)}`));
  const owners = Array.from({ length: len }, (_, i) => decodeAddr(hex.slice(128 + i * 64, 128 + (i + 1) * 64)));
  if (owners.length !== 1 || owners[0].toLowerCase() !== owner.toLowerCase()) {
    return `Safe ${safe} owners are [${owners.join(', ')}], expected exactly [${owner}]`;
  }
  // The Safe-nonce gate (V-381-r2). The pre-validated signature authorises by msg.sender alone, so
  // nothing in the Safe stops the SAME execTransaction running twice. The item was built for one
  // Safe nonce; once any Safe transaction has executed at it, this item must never be signable
  // again. Throws rather than skipping when the expected nonce is absent.
  if (expectedSafeNonce === undefined || expectedSafeNonce === null) {
    return 'this Safe-routed item carries no expected Safe nonce — refusing rather than risking a duplicate execution';
  }
  const nonceR = await ethCall(fetchImpl, ARC_RPC, safe, '0xaffed0e0'); // nonce()
  if (!nonceR.ok) return `could not read Safe.nonce(): ${nonceR.reason}`;
  const live = BigInt(nonceR.result);
  if (live !== BigInt(expectedSafeNonce)) {
    return `Safe ${safe} nonce is ${live}, this item was built for Safe nonce ${expectedSafeNonce} — a Safe transaction has already executed at that nonce (possibly this very one), so signing again could execute a duplicate`;
  }
  return null;
}

/**
 * `Governance.finalize`'s own precondition (`Governance.sol:577-579`): `status == Active &&
 * block.timestamp >= revealDeadline`. Reads `proposals(id)` and the chain's own clock on the SAME
 * connection, the identical discipline `scripts/lib/launch-checks.mjs`'s `checkStaleProposal` uses
 * (a local wall clock is not guaranteed to agree with the chain's).
 * @param {typeof fetch} fetchImpl @param {string} governance @param {number} proposalId
 */
export async function finalizePreconditionRefusal(fetchImpl, governance, proposalId) {
  const [propR, blockR] = await Promise.all([
    ethCall(fetchImpl, BASE_SEPOLIA_RPC, governance, `0x013cf08b${encodeUint(proposalId)}`),
    rpcCall(fetchImpl, BASE_SEPOLIA_RPC, 'eth_getBlockByNumber', ['latest', false]),
  ]);
  if (!propR.ok) return `could not read proposals(${proposalId}): ${propR.reason}`;
  if (!blockR.ok) return `could not read the chain's own clock: ${blockR.reason}`;
  const nowSec = Number(BigInt(blockR.result.timestamp));
  const hex = propR.result.replace(/^0x/, '');
  // Tuple layout and STATUS ordering imported from scripts/lib/proposal-decode.mjs's own `P`/
  // `STATUS` — NOT re-derived here. STATUS[0] is 'None': an earlier draft of this file hand-wrote
  // a 5-element array starting at 'Active', which is off by one against the real 6-element
  // ['None','Active','Passed','Defeated','Executed','Expired'] and would have misread every status.
  const word = (i) => hex.slice(i * 64, (i + 1) * 64);
  const revealDeadline = Number(BigInt(`0x${word(P.REVEAL_DEADLINE)}`));
  const statusByte = Number(BigInt(`0x${word(P.STATUS)}`));
  const status = STATUS[statusByte] ?? `unknown(${statusByte})`;
  if (status !== 'Active') {
    return `proposal ${proposalId} is ${status}, not Active — finalize() would revert WrongPhase`;
  }
  if (nowSec < revealDeadline) {
    return `proposal ${proposalId} is Active but still within its reveal window (chain time ${nowSec}, `
      + `deadline ${revealDeadline}) — finalize() would revert WrongPhase before then`;
  }
  return null;
}

// ───────────────────────── persona-deposit (card 210 / persona-deposit.mjs) ─────────────────────────

/**
 * `Governance`/`VaultCore`'s own preconditions for the approve/deposit pair of a persona-routed
 * deposit — `_deposit` (`contracts/src/VaultCore.sol:407-435`): amount must clear
 * `minDepositUsdc()` (read LIVE here rather than trusted from `contracts/config/arc-mainnet.json`,
 * which the builder also checks at build time — this is the defence against the config and the
 * chain having drifted apart since), the depositor's USDC balance must cover it (else the
 * `transferFrom` reverts), and `navWad()` must not revert (VaultCore's own freeze: "Reverts while
 * the oracle breaker is tripped — freezing everything, including exits, by design (K-4)",
 * VaultCore.sol:302-303). `checkAllowance` additionally requires `USDC.allowance(from, vault) >=
 * amount` — true only for the deposit item, since checking it on the approve item would refuse the
 * very item that sets the allowance. On the APPROVE item (`checkAllowance: false`), the balance
 * check additionally requires `GAS_HEADROOM_RAW` above `amount` — see that constant's own comment:
 * gas on Arc is paid in USDC itself, so a persona funded with EXACTLY the deposit amount would pass
 * this check, spend some of it on the approve item's own gas, and then have the DEPOSIT item
 * correctly but avoidably refuse for insufficient balance.
 * @param {typeof fetch} fetchImpl
 * @param {{vault:string, usdc:string, from:string, amountUsdcRaw:string|number|bigint, checkAllowance:boolean}} p
 */
export async function personaDepositPreconditionRefusal(fetchImpl, {
  vault, usdc, from, amountUsdcRaw, checkAllowance,
}) {
  const amount = BigInt(amountUsdcRaw);
  const [minR, balR, navR] = await Promise.all([
    ethCall(fetchImpl, ARC_RPC, vault, SEL_MIN_DEPOSIT_USDC),
    ethCall(fetchImpl, ARC_RPC, usdc, `${SEL_BALANCE_OF}${encodeAddr(from)}`),
    ethCall(fetchImpl, ARC_RPC, vault, SEL_NAV_WAD),
  ]);
  if (!minR.ok) return `could not read vault.minDepositUsdc(): ${minR.reason}`;
  const minDeposit = BigInt(minR.result);
  if (amount < minDeposit) {
    return `amount ${amount} is below vault.minDepositUsdc() (${minDeposit}) — deposit() would revert BelowMinDeposit`;
  }
  if (!balR.ok) return `could not read USDC.balanceOf(${from}): ${balR.reason}`;
  const balance = BigInt(balR.result);
  // Headroom on BOTH items: Arc pays gas in USDC out of the same balance, so a balance of exactly
  // `amount` pays the deposit's gas first and then reverts on the transferFrom (V-398-r1).
  const balanceNeeded = amount + GAS_HEADROOM_RAW;
  if (balance < balanceNeeded) {
    return `${from}'s USDC balance is ${balance}, below ${balanceNeeded} (the ${amount} deposit plus `
      + `${GAS_HEADROOM_RAW} headroom for this item's own gas — Arc pays gas in USDC) — fund more before ${checkAllowance ? 'depositing' : 'approving'}`;
  }
  if (!navR.ok) {
    return `vault.navWad() reverted (${navR.reason}) — the oracle breaker looks tripped, so the vault is frozen for deposits`;
  }
  if (checkAllowance) {
    const allowR = await ethCall(fetchImpl, ARC_RPC, usdc, `${SEL_ALLOWANCE}${encodeAddr(from)}${encodeAddr(vault)}`);
    if (!allowR.ok) return `could not read USDC.allowance(${from}, ${vault}): ${allowR.reason}`;
    const allowance = BigInt(allowR.result);
    if (allowance < amount) {
      return `USDC.allowance(${from}, ${vault}) is ${allowance}, below the ${amount} this deposit needs — the approve item must land first`;
    }
  }
  return null;
}

/**
 * `VaultCore.activate`'s own precondition (`contracts/src/VaultCore.sol:440-445`):
 * `pendingDeposit(member).amountUsdc > 0 && block.timestamp >= availableAt`. Reads
 * `pendingDeposit(from)` and the chain's own clock on the SAME connection — the same discipline
 * `finalizePreconditionRefusal` above already uses, since a local wall clock is not guaranteed to
 * agree with the chain's.
 * @param {typeof fetch} fetchImpl @param {{vault:string, from:string}} p
 */
export async function personaActivatePreconditionRefusal(fetchImpl, { vault, from }) {
  const [pendR, blockR] = await Promise.all([
    ethCall(fetchImpl, ARC_RPC, vault, `${SEL_PENDING_DEPOSIT}${encodeAddr(from)}`),
    rpcCall(fetchImpl, ARC_RPC, 'eth_getBlockByNumber', ['latest', false]),
  ]);
  if (!pendR.ok) return `could not read vault.pendingDeposit(${from}): ${pendR.reason}`;
  const hex = pendR.result.replace(/^0x/, '');
  // The public getter for `struct PendingDeposit { uint256 amountUsdc; uint64 availableAt; }`
  // returns each field as its own right-aligned 32-byte word, regardless of packed storage layout.
  const amountUsdc = BigInt(`0x${hex.slice(0, 64)}`);
  const availableAt = BigInt(`0x${hex.slice(64, 128)}`);
  if (amountUsdc === 0n) {
    return `vault has no pending deposit for ${from} — it may already have activated, taken the immediate-mint path, or been cancelled`;
  }
  if (!blockR.ok) return `could not read the chain's own clock: ${blockR.reason}`;
  const nowSec = BigInt(blockR.result.timestamp);
  if (nowSec < availableAt) {
    return `${from}'s pending deposit is not yet activatable — chain time ${nowSec}, available at ${availableAt} `
      + '(VaultCore.OBSERVATION_WINDOW is 4 hours from the deposit)';
  }
  return null;
}

/**
 * Card 210 (Decisions/Seed agent personas 2026-09-23.md): every persona-routed item must name an
 * EOA that is actually disclosed, under the matching persona, in `docs/seeded-addresses.json`
 * (PR #391) — refuses with a clear message when that file is not present in this checkout rather
 * than silently skipping the check. Deliberately synchronous (a filesystem read, not a chain read)
 * and does not import `scripts/lib/seeded-addresses.mjs` statically: that module (and the file it
 * validates) do not exist on `protocol/main` as of this writing, and a static import would make
 * loading THIS file — used by every other precondition too — throw before Arc's own deploy/vault
 * checks could ever run.
 * @param {string} from @param {string} persona @param {string} [root] injectable for tests only —
 *   real callers always use the repo root this module itself lives under
 */
export function seededPersonaRefusal(from, persona, root = ROOT) {
  const seededPath = path.join(root, 'docs', 'seeded-addresses.json');
  if (!existsSync(seededPath)) {
    return 'docs/seeded-addresses.json not found in this checkout — the seeded-persona disclosure '
      + 'list (PR #391) has not landed yet; refusing to sign a persona-routed item without it';
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(seededPath, 'utf8'));
  } catch (e) {
    return `docs/seeded-addresses.json is not valid JSON: ${/** @type {Error} */ (e).message}`;
  }
  if (!Array.isArray(doc?.addresses)) return 'docs/seeded-addresses.json has no "addresses" array';
  const entry = doc.addresses.find(
    (e) => typeof e?.address === 'string' && e.address.toLowerCase() === from.toLowerCase(),
  );
  if (!entry) {
    return `${from} is not listed in docs/seeded-addresses.json — refusing to sign a persona-routed item for an undisclosed address`;
  }
  if (entry.persona !== persona) {
    return `${from} is listed in docs/seeded-addresses.json under persona "${entry.persona}", not `
      + `"${persona}" — refusing: this item was built for the wrong persona`;
  }
  return null;
}

/**
 * Ordering gate (card 210, owner pivot 2026-09-23): the SECOND persona's deposit item must not be
 * signable until the FIRST persona's deposit has actually minted shares. `sharesOf` stays zero for
 * the entire 4-hour pending-deposit window (VaultCore.sol:407-435), so this is keyed off the first
 * persona's ACTIVATE item, not its deposit item — `_activatePending` (VaultCore.sol:473-479) is the
 * one call that mints. (The task that briefed this builder said "the first persona's deposit item
 * is done"; shares do not exist at that point, only after activation, so this function reads that
 * as shorthand for "the first persona's deposit has landed and activated" — see this repo's
 * CLAUDE.md merge-bar section on saying which reading of an ambiguous instruction was taken rather
 * than resolving it silently.)
 *
 * "Its recorded post-check", as briefed: the primary check reads the first persona's ACTIVATE
 * item's own STORED `postCheck` (`recordPersonaPostCheck`, `scripts/lib/sign-queue-server.mjs`) —
 * `sharesOfHolder > 0` and `navWad` present — rather than a fresh chain read. A LIVE `sharesOf`/
 * `navWad` read runs as an extra, belt-and-braces check beyond that snapshot (chain state can move
 * between the postCheck being recorded and this gate being evaluated — an exit, a freeze).
 * @param {typeof fetch} fetchImpl
 * @param {{vault:string, firstPersonaFrom:string, firstActivateDone:boolean, firstActivatePostCheck:({sharesOfHolder:string|null, navWad:string|null}|null|undefined)}} p
 */
export async function personaOrderingGateRefusal(fetchImpl, {
  vault, firstPersonaFrom, firstActivateDone, firstActivatePostCheck,
}) {
  if (!firstActivateDone) {
    return `waiting on the first persona (${firstPersonaFrom})'s deposit to activate before a second persona may deposit`;
  }
  if (!firstActivatePostCheck || firstActivatePostCheck.sharesOfHolder == null) {
    return `the first persona (${firstPersonaFrom})'s activate item is done but has no recorded post-check yet — `
      + 'waiting for sharesOf/navWad to be recorded before a second persona may deposit';
  }
  if (BigInt(firstActivatePostCheck.sharesOfHolder) === 0n) {
    return `the first persona (${firstPersonaFrom})'s recorded post-check shows sharesOf 0 — the deposit has not actually minted shares`;
  }
  if (firstActivatePostCheck.navWad == null) {
    return `the first persona (${firstPersonaFrom})'s recorded post-check has no navWad reading — refusing until NAV was confirmed readable at activation`;
  }
  // Extra live check beyond the recorded snapshot above.
  const [sharesR, navR] = await Promise.all([
    ethCall(fetchImpl, ARC_RPC, vault, `${SEL_SHARES_OF}${encodeAddr(firstPersonaFrom)}`),
    ethCall(fetchImpl, ARC_RPC, vault, SEL_NAV_WAD),
  ]);
  if (!sharesR.ok) return `could not read vault.sharesOf(${firstPersonaFrom}): ${sharesR.reason}`;
  if (BigInt(sharesR.result) === 0n) {
    return `vault.sharesOf(${firstPersonaFrom}) reads 0 right now — the first persona's shares may have since exited`;
  }
  if (!navR.ok) return `vault.navWad() is not readable right now (${navR.reason}) — refusing the second persona's deposit until NAV is readable`;
  return null;
}
