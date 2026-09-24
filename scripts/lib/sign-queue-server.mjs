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
import {
  finalizePreconditionRefusal, nonceGateRefusal, personaActivatePreconditionRefusal,
  personaDepositPreconditionRefusal, personaOrderingGateRefusal, safeRoutedRefusal, seededPersonaRefusal,
} from './sign-queue-preconditions.mjs';
import { resolveItemData } from './sign-queue-resolve.mjs';
import {
  QUEUE_PATH, EVENT_LOG_FIELDS, isForeignTx, normAddr, readQueue, verifyReceipt, writeQueueAtomic,
} from './sign-queue.mjs';
import { CREATE_VAULT_SIG, REGISTER_VAULT_SIG } from '../smoke-preflight.mjs';

const RPC_BY_CHAIN = {
  5042: 'https://rpc.mainnet.arc.io',
  84532: 'https://sepolia.base.org',
};

/** Default `cast` runner — a thin wrapper so tests can inject a stub instead. Memoised: the
 * server only calls pure, offline subcommands through it (`sig`, `calldata`, `abi-encode`), so a
 * given argv always yields the same output. Each spawn is synchronous and costs hundreds of ms on
 * Windows; re-spawning for every item on every 5 s poll blocked the server. Anything that reaches
 * the network must not use this runner. */
const castMemo = new Map();
export function defaultCast(args) {
  // Callers pass BigInts (execTransactionArgs carries the plan's uint fields as BigInt). A process
  // argv is strings anyway, so normalise once, before BOTH the memo key and the spawn:
  // JSON.stringify throws on a BigInt, which blocked the Safe-routed first-vault item from
  // resolving at all ("Do not know how to serialize a BigInt").
  const argv = args.map(String);
  const key = JSON.stringify(argv);
  if (!castMemo.has(key)) {
    castMemo.set(key, execFileSync(process.env.CAST ?? 'cast', argv, { encoding: 'utf8', windowsHide: true }).trim());
  }
  return castMemo.get(key);
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

/** How long a `sent` item may sit with an UNFINDABLE hash (never located by
 * `eth_getTransactionByHash` at all) before it is treated as never going to confirm and reverted
 * to `pending` — signable again. A genuinely just-broadcast transaction can take a few seconds to
 * propagate to the RPC endpoint this polls; a made-up or foreign hash never resolves, ever. Kept
 * generous specifically so a real, merely-slow-to-propagate send is never reverted out from under
 * the owner while it is still in flight. */
const UNFINDABLE_GRACE_MS = 10 * 60 * 1000;

/** Revert a `sent` item to `pending` — signable again — clearing everything that made it look
 * sent. Used ONLY for a hash this module can prove is not the item's own transaction (foreign,
 * per `isForeignTx`) or one that has never resolved at all within `UNFINDABLE_GRACE_MS`. A
 * genuine on-chain revert of the item's OWN transaction (from/to/input all match, but
 * `status != 1`) is a different, terminal outcome — see the `failed` branch below — because
 * re-signing the identical calldata would very likely fail again for the same reason. */
function revertToPending(item, note) {
  item.status = 'pending';
  item.txHash = null;
  item.sentData = null;
  item.sentAt = null;
  item.verifyNote = note;
}

/**
 * Poll every `sent` item for a receipt, and advance it to `done`/`failed`/back-to-`pending` when
 * the chain settles the question. Mutates and persists `queue.items` in place when anything
 * changed. Never throws — a single item's failed read is recorded on that item and the rest of
 * the queue is still processed.
 * @param {{items: import('./sign-queue.mjs').QueueItem[]}} queue
 * @param {typeof fetch} fetchImpl
 */
export async function advanceSentItems(queue, fetchImpl, queuePath = QUEUE_PATH) {
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
    // Only a hash with NO transaction behind it may be recovered to pending. A transaction that
    // EXISTS but has no receipt yet is a real, unmined send: reverting it would re-enable Sign while
    // it can still mine, and for the Safe-routed items a second execTransaction with the
    // pre-validated signature would execute too (it binds msg.sender, not the Safe nonce), creating
    // a duplicate vault (Security V-381-r2). It stays `sent` however long it takes.
    if (!txR.result) {
      const ageMs = item.sentAt ? Date.now() - Date.parse(item.sentAt) : 0;
      if (ageMs > UNFINDABLE_GRACE_MS) {
        revertToPending(item, `hash ${item.txHash} was never found on chain after ${Math.round(ageMs / 60000)} minutes — this was a foreign or junk hash, not a real send. Signable again.`);
        changed = true;
      } else {
        item.verifyNote = 'transaction not found yet';
      }
      continue;
    }
    if (!rcptR.result) {
      if (isForeignTx(item, txR.result)) {
        revertToPending(item, `hash ${item.txHash} resolved to a transaction whose from/to/input do not match this item — not this item's send. Signable again.`);
        changed = true;
      } else {
        item.verifyNote = 'transaction found, not yet mined — stays sent until it mines';
      }
      continue;
    }
    // A tx WAS found for this hash. First: is it even OUR transaction? A confirmed receipt for a
    // hash that belongs to someone else's transaction entirely (the CSRF shape this exists for)
    // must never sit at `sent` forever — it is provably not what this item asked for.
    if (isForeignTx(item, txR.result)) {
      revertToPending(item, `hash ${item.txHash} resolved to a transaction whose from/to/input do not match this item — not this item's send. Signable again.`);
      changed = true;
      continue;
    }
    const receipt = receiptSummary(txR.result, rcptR.result);
    const reason = verifyReceipt({ item, tx: txR.result, receipt });
    if (reason) {
      // It IS this item's own transaction (from/to/input matched above), but it did not confirm
      // the way this item expects — a genuine on-chain revert, an ExecutionFailure, a CREATE that
      // landed at an unpredicted address, or a missing expected log. Terminal: re-signing the
      // identical calldata would very likely reproduce the same outcome.
      item.status = 'failed'; item.receipt = receipt; item.verifyNote = reason; changed = true;
      continue;
    }
    item.status = 'done'; item.receipt = receipt; item.doneAt = new Date().toISOString(); item.verifyNote = null;
    changed = true;
    await recordPersonaPostCheck(item, queue.items, fetchImpl);
  }
  if (changed) writeQueueAtomic(queue, queuePath);
  return changed;
}

/**
 * Card 210: once a persona-deposit item confirms `done`, record the reads the owner asked for so
 * shares/NAV can be verified after it lands without a separate manual pass: `sharesOf(holder)`,
 * `totalShares()`, `navWad()`, `idleUsdc()` and the holder's own USDC balance. `postCheckPlan` is
 * set on ALL THREE persona-deposit items (approve, deposit, activate), not only deposit/activate,
 * specifically so the APPROVE item's recorded `holderUsdcBalance` becomes the baseline the DEPOSIT
 * item's own post-check diffs against for `holderUsdcBalanceDelta` — the deposit item's precondition
 * (`personaDepositPreconditionRefusal`) requires `dependsOn` includes the approve item, so by the
 * time a deposit item can even confirm, its sibling approve item is guaranteed `done` with its own
 * `postCheck` already recorded. Never throws: an individual read failure is recorded in
 * `readErrors` rather than blocking the item's own `done` transition, which has already happened by
 * the time this runs.
 * @param {import('./sign-queue.mjs').QueueItem} item
 * @param {import('./sign-queue.mjs').QueueItem[]} allItems the full queue, for finding this
 *   persona's own approve item as the balance-delta baseline
 * @param {typeof fetch} fetchImpl
 */
async function recordPersonaPostCheck(item, allItems, fetchImpl) {
  if (item.builder !== 'persona-deposit' || !item.postCheckPlan) return;
  const { vault, usdc, holder } = item.postCheckPlan;
  const rpcUrl = RPC_BY_CHAIN[item.chainId];
  const { ethCall } = await import('./chain-rpc.mjs');
  const [sharesR, totalR, navR, idleR, balR] = await Promise.all([
    ethCall(fetchImpl, rpcUrl, vault, `0xf5eb42dc${encodeAddr(holder)}`), // sharesOf(address)
    ethCall(fetchImpl, rpcUrl, vault, '0x3a98ef39'), // totalShares()
    ethCall(fetchImpl, rpcUrl, vault, '0xd09074c0'), // navWad()
    ethCall(fetchImpl, rpcUrl, vault, '0x047b7fc7'), // idleUsdc()
    ethCall(fetchImpl, rpcUrl, usdc, `0x70a08231${encodeAddr(holder)}`), // balanceOf(address)
  ]);
  const val = (r) => (r.ok ? BigInt(r.result).toString() : null);
  const holderUsdcBalance = val(balR);
  let holderUsdcBalanceDelta = null;
  if (item.personaAction === 'deposit' && holderUsdcBalance !== null) {
    const approveSibling = allItems.find(
      (it) => it.builder === 'persona-deposit' && it.persona === item.persona && it.personaAction === 'approve',
    );
    const baseline = approveSibling?.postCheck?.holderUsdcBalance;
    if (baseline != null) holderUsdcBalanceDelta = (BigInt(holderUsdcBalance) - BigInt(baseline)).toString();
  }
  item.postCheck = {
    at: new Date().toISOString(),
    sharesOfHolder: val(sharesR),
    totalShares: val(totalR),
    navWad: val(navR),
    idleUsdc: val(idleR),
    holderUsdcBalance,
    holderUsdcBalanceDelta,
    readErrors: [sharesR, totalR, navR, idleR, balR].filter((r) => !r.ok).map((r) => r.reason),
  };
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
      safe: t.safe, owner: t.safeOwner, expectedSafeNonce: t.safeNonce,
      plan: {
        to: t.to, action: planAction, expectedTo, data: `${selector}${'0'.repeat(64)}`,
        operation: 0, value: 0, safeTxGas: 0, baseGas: 0, gasPrice: 0,
      },
    });
  }
  if (item.builder === 'finalize-12') {
    return finalizePreconditionRefusal(fetchImpl, item.to, item.proposalId);
  }
  if (item.builder === 'persona-deposit') {
    // "A guard that can skip is a guard that will" — unlike arc-deploy's pre-existing branch above,
    // a persona-deposit item with no usable expectedNonce REFUSES rather than silently skipping the
    // nonce gate; the builder always sets a number, so a missing one means something is wrong.
    if (typeof item.expectedNonce !== 'number') return 'item has no expectedNonce recorded — refusing rather than skipping the nonce gate';
    const nonceRefusal = await nonceGateRefusal(fetchImpl, RPC_BY_CHAIN[5042], item.from, item.expectedNonce);
    if (nonceRefusal) return nonceRefusal;
    const seeded = seededPersonaRefusal(item.from, item.persona);
    if (seeded) return seeded;
    if (item.personaAction === 'approve' || item.personaAction === 'deposit') {
      const r = await personaDepositPreconditionRefusal(fetchImpl, {
        vault: item.vault, usdc: item.usdc, from: item.from, amountUsdcRaw: item.amountUsdcRaw,
        checkAllowance: item.personaAction === 'deposit',
      });
      if (r) return r;
    }
    if (item.personaAction === 'activate') {
      const r = await personaActivatePreconditionRefusal(fetchImpl, { vault: item.vault, from: item.from });
      if (r) return r;
    }
    if (item.personaAction === 'deposit' && item.orderingGate) {
      const firstActivate = itemsById.get(item.orderingGate.firstActivateId);
      const r = await personaOrderingGateRefusal(fetchImpl, {
        vault: item.vault, firstPersonaFrom: item.orderingGate.firstPersonaFrom,
        firstActivateDone: firstActivate?.status === 'done',
        firstActivatePostCheck: firstActivate?.postCheck,
      });
      if (r) return r;
    }
    return null;
  }
  return null;
}

/**
 * Refuses a `POST /api/sign-queue/:id/hash` request that did not come from THIS dashboard's own
 * page — V-381-r1-8083f497 (Security, PR #381): with no check at all, any website the owner has
 * open could `fetch('http://127.0.0.1:<port>/api/sign-queue/<id>/hash', {method:'POST', ...})` —
 * a `no-cors` cross-origin POST is PERMITTED by the browser, it just cannot read the response —
 * and freeze a `pending` item at `sent` with a made-up hash, blocking the owner's real click with
 * a 409 until the queue file was hand-edited.
 *
 * Three checks, ALL must pass, any failure is a flat refusal (never "changes nothing" — the
 * request never reaches `recordSentHash` at all):
 *   - `Host` must be exactly `127.0.0.1:<port>`. This is what stops DNS rebinding — an attacker
 *     page served from a hostname that later re-resolves to 127.0.0.1 still sends `Host:
 *     attacker.example`, and the browser does not let a page override that header.
 *   - `Origin`, if the request sent one at all (browsers omit it for a plain top-level
 *     navigation, but a `fetch`/`XHR` POST — exactly the CSRF shape here — always sends one),
 *     must equal `http://127.0.0.1:<port>` exactly.
 *   - `Content-Type` must be `application/json`. A `no-cors` cross-origin request is restricted to
 *     the CORS-safelisted content types (`text/plain`, `application/x-www-form-urlencoded`,
 *     `multipart/form-data`) — it CANNOT set `application/json` without a preflight, and this
 *     server answers no `OPTIONS` route, so a preflighted request fails before it ever arrives
 *     here. Requiring this header is what turns "the browser permits this" into "the browser
 *     cannot actually send this cross-origin".
 *
 * @param {{host?: string, origin?: string, 'content-type'?: string}} headers lower-cased header map
 * @param {number} port this server's own listening port
 * @returns {string|null} a refusal reason, or null when the request may proceed
 */
export function originGateRefusal(headers, port) {
  const wantHost = `127.0.0.1:${port}`;
  const wantOrigin = `http://127.0.0.1:${port}`;
  const host = (headers.host ?? '').trim();
  if (host !== wantHost) {
    return `Host is ${JSON.stringify(host)}, expected ${JSON.stringify(wantHost)}`;
  }
  const origin = headers.origin;
  if (origin !== undefined && origin.trim() !== wantOrigin) {
    return `Origin is ${JSON.stringify(origin)}, expected absent or ${JSON.stringify(wantOrigin)}`;
  }
  const contentType = (headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return `Content-Type is ${JSON.stringify(headers['content-type'] ?? '')}, expected application/json`;
  }
  return null;
}

/**
 * One async mutex per queue file around every read-modify-write of it. Both writers (the GET
 * poll's advance/readback and the POST that records a hash) take it, so neither can write back a
 * copy read before the other's write. A failing section releases the lock for the next caller.
 */
const queueLocks = new Map();
export function withQueueLock(queuePath, fn) {
  const prev = queueLocks.get(queuePath) ?? Promise.resolve();
  const run = prev.then(() => fn());
  queueLocks.set(queuePath, run.catch(() => {}));
  return run;
}

/**
 * `GET /api/sign-queue`'s whole handler body. Polls every `sent` item for a receipt, resolves
 * every item's `data` (template or literal), computes `ready`, and returns the enriched list. No
 * argument mutates anything the caller did not already own (the queue file itself).
 * @param {typeof fetch} fetchImpl
 * @param {(args: string[]) => string} castFn
 * @param {string} [queuePath] override for tests only — the dashboard always uses the default
 */
export async function buildSignQueueResponse(fetchImpl = fetch, castFn = defaultCast, queuePath = QUEUE_PATH) {
  // The read-modify-write runs under the queue lock (see withQueueLock). Without it, a Sign POST
  // that lands while this poll awaits the chain was overwritten by this poll's stale copy: the
  // item went back to pending with no hash, its tx still mined, and the nonce gate then refused
  // it forever (Security, #382 follow-up, reproduced). Display enrichment below runs unlocked on
  // this in-memory copy; the next poll re-reads.
  const queue = await withQueueLock(queuePath, async () => {
    const q = readQueue(queuePath);
    await advanceSentItems(q, fetchImpl, queuePath);
    const byId = new Map(q.items.map((it) => [it.id, it]));
    if (byId.has('arc-readback')) {
      const changed = await checkArcReadback(byId.get('arc-readback'), byId, fetchImpl);
      if (changed) writeQueueAtomic(q, queuePath);
    }
    return q;
  });

  const itemsById = new Map(queue.items.map((it) => [it.id, it]));

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
 * @param {string} [queuePath] override for tests only — the dashboard always uses the default
 */
export async function recordSentHash(id, body, fetchImpl = fetch, castFn = defaultCast, queuePath = QUEUE_PATH) {
  const hash = typeof body.hash === 'string' ? body.hash : '';
  const from = typeof body.from === 'string' ? body.from : '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return { code: 400, msg: 'hash is not a 32-byte 0x-hex tx hash' };
  return withQueueLock(queuePath, () => recordSentHashLocked(id, hash, from, castFn, queuePath));
}

/** recordSentHash's read-modify-write, only ever run under the queue lock. */
function recordSentHashLocked(id, hash, from, castFn, queuePath) {
  const queue = readQueue(queuePath);
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
  writeQueueAtomic(queue, queuePath);
  return { code: 200, msg: 'recorded — polling the chain for confirmation' };
}

export { EVENT_LOG_FIELDS }; // re-exported for the dashboard's log-field UI hints, if ever needed
