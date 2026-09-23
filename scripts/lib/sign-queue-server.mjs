// @ts-check
/**
 * The dashboard's two Sign-queue endpoints, factored out of `scripts/dashboard.mjs` so
 * `scripts/test/sign-queue-server.test.mjs` can drive them with stubbed `fetch`/`cast` and no
 * real HTTP server, RPC, or `cast` binary. `scripts/dashboard.mjs` itself only wires these into
 * `GET /api/sign-queue` and `POST /api/sign-queue/:id/hash` — it adds no logic of its own.
 *
 * NO ENDPOINT HERE ADDS OR EDITS ITEMS. The queue file is written only by the builders
 * (`scripts/sign-queue/*.mjs`) and by this module's own receipt confirmation / hash recording —
 * never by an arbitrary field from an HTTP request.
 */
import { execFileSync } from 'node:child_process';
import {
  ethGetTransactionByHash, ethGetTransactionReceipt,
} from './chain-rpc.mjs';
import { finalizePreconditionRefusal, nonceGateRefusal, safeRoutedRefusal } from './sign-queue-preconditions.mjs';
import { resolveItemData } from './sign-queue-resolve.mjs';
import {
  QUEUE_PATH, EVENT_LOG_FIELDS, normAddr, readQueue, verifyReceipt, writeQueueAtomic,
} from './sign-queue.mjs';
import { CREATE_VAULT_SIG, REGISTER_VAULT_SIG } from '../smoke-preflight.mjs';

const RPC_BY_CHAIN = {
  5042: 'https://rpc.mainnet.arc.io',
  84532: 'https://sepolia.base.org',
};

/** Default `cast` runner — a thin wrapper so tests can inject a stub instead. */
export function defaultCast(args) {
  return execFileSync(process.env.CAST ?? 'cast', args, { encoding: 'utf8', windowsHide: true }).trim();
}

const encodeAddr = (a) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
const wordAsAddr = (hex, i) => `0x${word(hex, i).slice(-40)}`;
const isTrue = (hex) => BigInt(word(hex, 0)) !== 0n;

/**
 * Store a receipt/tx pair as the SUMMARY shape `verifyReceipt`/template resolution expect: raw
 * logs kept (topics/address), everything else narrowed to what this module ever reads back.
 */
function receiptSummary(tx, receipt) {
  return {
    status: receipt.status, from: receipt.from, to: receipt.to,
    contractAddress: receipt.contractAddress ?? null,
    logs: (receipt.logs ?? []).map((l) => ({ address: l.address, topics: l.topics, data: l.data })),
  };
}

/**
 * Poll every `sent` item for a receipt, and advance it to `done`/`failed` when `verifyReceipt`
 * (or, for the non-signing `arc-readback` item, a direct set of reads) confirms it. Mutates and
 * persists `queue.items` in place when anything changed. Never throws — a single item's failed
 * read is recorded on that item and the rest of the queue is still processed.
 * @param {{items: import('./sign-queue.mjs').QueueItem[]}} queue
 * @param {typeof fetch} fetchImpl
 */
async function advanceSentItems(queue, fetchImpl) {
  let changed = false;
  for (const item of queue.items) {
    if (item.status !== 'sent' || !item.txHash) continue;
    const rpcUrl = RPC_BY_CHAIN[item.chainId];
    if (!rpcUrl) { item.verifyNote = `no known RPC for chainId ${item.chainId}`; continue; }
    const [txR, rcptR] = await Promise.all([
      ethGetTransactionByHash(fetchImpl, rpcUrl, item.txHash),
      ethGetTransactionReceipt(fetchImpl, rpcUrl, item.txHash),
    ]);
    if (!txR.ok || !rcptR.ok) {
      item.verifyNote = `could not confirm yet: ${!txR.ok ? txR.reason : rcptR.reason}`;
      continue;
    }
    if (!txR.result || !rcptR.result) {
      item.verifyNote = 'transaction not yet mined (no receipt)';
      continue;
    }
    const receipt = receiptSummary(txR.result, rcptR.result);
    const reason = verifyReceipt({ item, tx: txR.result, receipt });
    if (reason) {
      // A confirmed but MISMATCHED receipt "changes nothing" — status stays `sent`, never `done`,
      // per the design doc. A genuine on-chain revert is the one case that DOES advance status,
      // to `failed`, since that is true regardless of which hash produced it.
      const reverted = receipt.status !== '0x1' && receipt.status !== 1;
      if (reverted) { item.status = 'failed'; item.receipt = receipt; item.verifyNote = reason; changed = true; }
      else if (item.verifyNote !== reason) { item.verifyNote = reason; changed = true; }
      continue;
    }
    item.status = 'done'; item.receipt = receipt; item.doneAt = new Date().toISOString(); item.verifyNote = null;
    changed = true;
  }
  if (changed) writeQueueAtomic(queue);
  return changed;
}

/** The `arc-readback` item never signs: it is marked `done` once every wired-state read agrees,
 * `pending` (with a note) otherwise. Mirrors `DeployTestnet.s.sol`'s post-deploy sanity block. */
async function checkArcReadback(item, itemsById, fetchImpl) {
  if (item.status !== 'pending') return false;
  const deps = item.dependsOn.map((id) => itemsById.get(id));
  if (deps.some((d) => !d || d.status !== 'done')) {
    item.verifyNote = 'waiting on every arc-deploy item to be done';
    return false;
  }
  const addr = (it) => it.receipt?.contractAddress;
  const rb = item.readback;
  const rpcUrl = RPC_BY_CHAIN[5042];
  const reg = addr(itemsById.get('arc-registry'));
  const subReg = addr(itemsById.get('arc-subreg'));
  const gov = addr(itemsById.get('arc-governance'));
  const factory = addr(itemsById.get('arc-factory'));
  const adapter = addr(itemsById.get('arc-adapter'));
  const oracle = addr(itemsById.get('arc-oracle'));
  const { ethCall } = await import('./chain-rpc.mjs');
  const checks = [
    ['registry.factory() == factory', ethCall(fetchImpl, rpcUrl, reg, '0xc45a0155'), factory, 'address'],
    ['registry.feeEngine() == feeEngine', ethCall(fetchImpl, rpcUrl, reg, '0xe31b3091'), addr(itemsById.get('arc-feeengine')), 'address'],
    ['subReg.factory() == factory', ethCall(fetchImpl, rpcUrl, subReg, '0xc45a0155'), factory, 'address'],
    ['governance.subVaultRegistry() == subReg', ethCall(fetchImpl, rpcUrl, gov, '0x23f4879f'), subReg, 'address'],
    ['adapter.router() == router', ethCall(fetchImpl, rpcUrl, adapter, '0xf887ea40'), rb.router, 'address'],
    ['factory.isAllowedOracle(oracle)', ethCall(fetchImpl, rpcUrl, factory, `0x785d97a8${encodeAddr(oracle)}`), null, 'true'],
  ];
  for (const sel of rb.selectors) {
    checks.push([`adapter.allowedSelector(${sel})`, ethCall(fetchImpl, rpcUrl, adapter, `0xbda90e09${sel.replace(/^0x/, '').padEnd(64, '0')}`), null, 'true']);
  }
  for (let i = 0; i < rb.assets.length; i++) {
    checks.push([`oracle.feedOf(${rb.assets[i]}) == ${rb.feeds[i]}`, ethCall(fetchImpl, rpcUrl, oracle, `0x4b45e8a6${encodeAddr(rb.assets[i])}`), rb.feeds[i], 'address']);
  }
  const resolved = await Promise.all(checks.map(([, p]) => p));
  const failures = [];
  resolved.forEach((r, i) => {
    const [label, , expect, kind] = checks[i];
    if (!r.ok) { failures.push(`${label}: ${r.reason}`); return; }
    if (kind === 'address' && normAddr(wordAsAddr(r.result, 0)) !== normAddr(expect)) {
      failures.push(`${label}: got ${wordAsAddr(r.result, 0)}`);
    } else if (kind === 'true' && !isTrue(r.result)) {
      failures.push(`${label}: got false`);
    }
  });
  if (failures.length) { item.verifyNote = failures.join(' · '); return false; }
  item.status = 'done'; item.doneAt = new Date().toISOString(); item.verifyNote = null;
  return true;
}

/**
 * Which item-type precondition applies, keyed off `item.builder`/`item.id` — the closed set this
 * queue currently has. Returns null (ready) or a reason string.
 */
async function preconditionRefusal(item, itemsById, fetchImpl, castFn) {
  if (item.builder === 'arc-deploy' && item.id !== 'arc-readback') {
    if (typeof item.expectedNonce === 'number') {
      const r = await nonceGateRefusal(fetchImpl, RPC_BY_CHAIN[5042], item.from, item.expectedNonce);
      if (r) return r;
    }
    return null;
  }
  if (item.builder === 'first-vault') {
    const t = item.dataTemplate;
    if (!t) return 'item has no build recipe';
    const planAction = item.id === 'arc-first-vault-create' ? 'createVault' : 'registerVault';
    // The selector is derived from the SIGNATURE alone (`cast sig`), never sliced from calldata
    // this same check is validating — the independence `safeRoutingPlanRefusal` itself requires
    // (see its own doc in scripts/smoke-preflight.mjs).
    const selector = castFn(['sig', planAction === 'createVault' ? CREATE_VAULT_SIG : REGISTER_VAULT_SIG]);
    // `expectedTo` is read from arc-deploy's OWN current state — the confirmed receipt address
    // once it exists, else the frozen prediction — NOT from this item's own `t.to`, so this check
    // can actually catch the two disagreeing rather than only ever comparing a value to itself.
    const depId = planAction === 'createVault' ? 'arc-factory' : 'arc-governance';
    const dep = itemsById.get(depId);
    const expectedTo = dep?.receipt?.contractAddress ?? dep?.predictedAddress;
    if (!expectedTo) return `${depId} has no known address yet`;
    return safeRoutedRefusal(fetchImpl, {
      safe: t.safe, owner: t.safeOwner,
      plan: {
        to: t.to, action: planAction, expectedTo, data: `${selector}${'0'.repeat(64)}`,
        operation: 0, value: 0, safeTxGas: 0, baseGas: 0, gasPrice: 0,
      },
    });
  }
  if (item.builder === 'finalize-12') {
    return finalizePreconditionRefusal(fetchImpl, item.to, item.proposalId);
  }
  return null;
}

/**
 * `GET /api/sign-queue`'s whole handler body. Polls every `sent` item for a receipt, resolves
 * every item's `data` (template or literal), computes `ready`, and returns the enriched list. No
 * argument mutates anything the caller did not already own (the queue file itself).
 * @param {typeof fetch} fetchImpl
 * @param {(args: string[]) => string} castFn
 */
export async function buildSignQueueResponse(fetchImpl = fetch, castFn = defaultCast) {
  const queue = readQueue();
  await advanceSentItems(queue, fetchImpl);

  const itemsById = new Map(queue.items.map((it) => [it.id, it]));
  if (itemsById.has('arc-readback')) {
    const changed = await checkArcReadback(itemsById.get('arc-readback'), itemsById, fetchImpl);
    if (changed) writeQueueAtomic(queue);
  }

  const enriched = [];
  for (const item of queue.items.sort((a, b) => (a.chainId - b.chainId) || (a.order - b.order))) {
    const depsDone = item.dependsOn.every((id) => itemsById.get(id)?.status === 'done');
    let blockedReason = null;
    let resolvedData = null;
    if (!item.from) {
      // A non-signing item (e.g. arc-readback): no data to resolve, no Sign button. Its own
      // `verifyNote` (set by checkArcReadback above) already explains what it is waiting on.
      blockedReason = item.status === 'pending' ? (item.verifyNote ?? 'waiting on reads') : null;
    } else if (!depsDone) {
      blockedReason = 'waiting on: ' + item.dependsOn.filter((id) => itemsById.get(id)?.status !== 'done').join(', ');
    } else {
      const resolved = resolveItemData(item, itemsById, castFn);
      if (!resolved.ok) blockedReason = `cannot resolve data: ${resolved.reason}`;
      else {
        resolvedData = resolved.resolved;
        const pre = await preconditionRefusal(item, itemsById, fetchImpl, castFn);
        if (pre) blockedReason = pre;
      }
    }
    enriched.push({
      ...item,
      resolvedData,
      ready: item.status === 'pending' && !!item.from && blockedReason === null,
      blockedReason: item.status === 'pending' ? blockedReason : null,
    });
  }
  return { at: new Date().toISOString(), queuePath: QUEUE_PATH, items: enriched };
}

/**
 * `POST /api/sign-queue/:id/hash`'s whole handler body. Records the browser's reported hash as
 * `sent`, freezing `sentData` NOW (never re-resolved later) — verification against it happens on
 * the NEXT `buildSignQueueResponse` call. Refuses (never silently accepts) a wrong `from`, an
 * already-sent/done item, or an item still blocked on a dependency/precondition.
 * @param {string} id
 * @param {{hash: unknown, from: unknown}} body
 * @param {typeof fetch} fetchImpl
 * @param {(args: string[]) => string} castFn
 */
export async function recordSentHash(id, body, fetchImpl = fetch, castFn = defaultCast) {
  const hash = typeof body.hash === 'string' ? body.hash : '';
  const from = typeof body.from === 'string' ? body.from : '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return { code: 400, msg: 'hash is not a 32-byte 0x-hex tx hash' };

  const queue = readQueue();
  const item = queue.items.find((it) => it.id === id);
  if (!item) return { code: 404, msg: `no queue item ${id}` };
  if (item.status !== 'pending') return { code: 409, msg: `item is already ${item.status}` };
  if (!item.from || normAddr(from) !== normAddr(item.from)) {
    return { code: 400, msg: `from (${from}) does not match this item's required signer (${item.from})` };
  }
  const itemsById = new Map(queue.items.map((it) => [it.id, it]));
  const depsDone = item.dependsOn.every((depId) => itemsById.get(depId)?.status === 'done');
  if (!depsDone) return { code: 409, msg: 'item still has an unmet dependency' };
  const resolved = resolveItemData(item, itemsById, castFn);
  if (!resolved.ok) return { code: 409, msg: `cannot resolve item data: ${resolved.reason}` };

  item.status = 'sent'; item.txHash = hash; item.sentData = resolved.resolved; item.sentAt = new Date().toISOString();
  writeQueueAtomic(queue);
  return { code: 200, msg: 'recorded — polling the chain for confirmation' };
}

export { EVENT_LOG_FIELDS }; // re-exported for the dashboard's log-field UI hints, if ever needed
