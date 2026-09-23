// @ts-check
/**
 * The Sign queue: schema, atomic file I/O, template resolution, idempotent merge, and receipt
 * verification. `scripts/dashboard.mjs`'s Sign section and every builder under
 * `scripts/sign-queue/*.mjs` share this one module so the shape of an item, and what counts as a
 * confirmed send, can never drift between "what a builder wrote" and "what the server will accept
 * as done".
 *
 * QUEUE FILE: `Obsidian Vault/Agent-Governed Vaults/Tasks/_sign-queue.json`, one JSON object,
 * written via a temp file in the same directory then `renameSync` — the identical discipline
 * `scripts/dashboard.mjs`'s `recordAnswer` already uses for the task board, so a half-written
 * queue file is never the one a poller reads mid-write.
 *
 * THE SERVER CONFIRMS, NOT THE BROWSER. `verifyReceipt` below is the one function that may ever
 * move an item to `done`, and it requires every one of: receipt `status == 1`, `from`/`to` (or, for
 * a CREATE, `contractAddress` equal to the item's own predicted address) match, and `input` on the
 * transaction equal to the EXACT data this server resolved and handed to the browser at send time
 * (`item.sentData` — never a fresh re-resolution of the template, which could have changed if an
 * upstream item's log changed between send and confirm). A foreign or mismatched hash changes
 * nothing: `verifyReceipt` returns a reason and the caller must not advance `status`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** @typedef {'pending'|'sent'|'done'|'failed'} ItemStatus */

/**
 * @typedef {object} QueueItem
 * @property {string} id
 * @property {number} order
 * @property {number} chainId
 * @property {string} chainName
 * @property {string} what
 * @property {string} from
 * @property {string|null} to               null for a CREATE (contract deployment)
 * @property {string} value                 decimal wei string
 * @property {string} data                  resolved calldata/initcode, OR still carrying
 *                                           unresolved `{{item:...}}` templates
 * @property {string|null} dataTemplate      the raw template before resolution, or null when
 *                                           `data` never contained one (kept so the UI can show
 *                                           both the template and what it resolved to)
 * @property {string[]} dependsOn
 * @property {ItemStatus} status
 * @property {string|null} txHash
 * @property {object|null} receipt           a stored SUMMARY: {status,blockNumber,contractAddress,logs}
 * @property {string|null} predictedAddress  for a CREATE item
 * @property {number|null} expectedNonce     frozen at build time; never recomputed on rebuild
 * @property {string|null} sentData          the EXACT resolved data this server handed the
 *                                           browser at send time — frozen, compared at verify time
 * @property {string} builder
 * @property {string} builtAt
 * @property {string|null} sentAt
 * @property {string|null} doneAt
 * @property {string|null} verifyNote        non-blocking diagnostic: a receipt exists but does not
 *                                            (yet, or ever) match — status stays as it was
 */

export const QUEUE_PATH = path.join(
  'C:/Users/Micha/Desktop/Claude/Obsidian Vault/Agent-Governed Vaults/Tasks',
  '_sign-queue.json',
);

const EMPTY_QUEUE = Object.freeze({ updatedAt: null, items: [] });

/** @param {string} [queuePath] */
export function readQueue(queuePath = QUEUE_PATH) {
  if (!existsSync(queuePath)) return { updatedAt: null, items: [] };
  const raw = JSON.parse(readFileSync(queuePath, 'utf8'));
  return { updatedAt: raw.updatedAt ?? null, items: Array.isArray(raw.items) ? raw.items : [] };
}

/**
 * Atomic write: a temp file in the SAME directory, then `renameSync` — never a partial file a
 * concurrent reader (the dashboard's poll, or a second builder) could observe.
 * @param {{items: QueueItem[]}} queue
 * @param {string} [queuePath]
 */
export function writeQueueAtomic(queue, queuePath = QUEUE_PATH) {
  mkdirSync(path.dirname(queuePath), { recursive: true });
  const out = { updatedAt: new Date().toISOString(), items: queue.items };
  const tmp = `${queuePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
  renameSync(tmp, queuePath);
  return out;
}

export const normAddr = (a) => (typeof a === 'string' ? a.trim().toLowerCase() : '');

/** The immutable, descriptive fields of an item — what a builder computes from its inputs. Two
 * builds of the SAME item must agree on every one of these, or the second build is describing a
 * DIFFERENT transaction under the same id, which `mergeBuiltItems` below refuses to accept once
 * the first has been sent. `status`/`txHash`/`receipt`/timestamps are lifecycle state, not
 * description, and are deliberately excluded — those belong to the server alone. */
const DESCRIPTIVE_FIELDS = [
  'order', 'chainId', 'chainName', 'what', 'from', 'to', 'value', 'data', 'dataTemplate',
  'dependsOn', 'predictedAddress', 'expectedNonce', 'builder',
];

/** `JSON.stringify` with object keys sorted so two objects with the same keys in a different
 * order compare equal — but only for a genuine (non-null, non-array) object; `Object.keys` on
 * `null`/`undefined` throws, and applying it to an array would spell its indices as a key
 * replacer and drop the array shape. `null`, primitives and arrays fall through to plain
 * `JSON.stringify`, which is already key-order-stable for them. */
const stableJson = (v) => {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return JSON.stringify(v, Object.keys(v).sort());
  }
  return JSON.stringify(v);
};

/**
 * Idempotent merge: a builder re-run recomputes its own items and calls this with the FULL result
 * for its own `builder` name. For each recomputed item:
 *   - no existing item with that id            -> insert
 *   - existing item is 'pending'                -> overwrite (nothing irreversible happened yet)
 *   - existing item is 'sent'/'done'/'failed'    -> the DESCRIPTIVE_FIELDS must match byte-for-byte,
 *     or this throws. A rebuild must never silently redescribe a transaction that is already on
 *     its way to, or already on, the chain.
 * Items belonging to OTHER builders are left untouched.
 * @param {QueueItem[]} existingItems
 * @param {QueueItem[]} recomputedItems
 * @param {string} builderName
 * @returns {QueueItem[]}
 */
export function mergeBuiltItems(existingItems, recomputedItems, builderName) {
  const byId = new Map(existingItems.map((it) => [it.id, it]));
  const out = existingItems.filter((it) => it.builder !== builderName || !recomputedItems.some((n) => n.id === it.id));
  // ^ start from every item NOT being replaced this run (other builders' items, plus any of this
  // builder's own items that recomputedItems no longer names — left alone rather than deleted,
  // since a builder that narrows its own output is not this function's problem to guess about).
  for (const next of recomputedItems) {
    const prev = byId.get(next.id);
    if (!prev) { out.push(next); continue; }
    if (prev.status === 'pending') { out.push(next); continue; }
    for (const f of DESCRIPTIVE_FIELDS) {
      if (stableJson(prev[f] ?? null) !== stableJson(next[f] ?? null)) {
        throw new Error(
          `mergeBuiltItems: item ${next.id} is already ${prev.status} on chain, but a rebuild `
          + `computed a DIFFERENT ${f} (was ${JSON.stringify(prev[f])}, now ${JSON.stringify(next[f])}). `
          + 'Refusing to overwrite a sent/done/failed item — fix the builder input, or this item '
          + 'id needs to change.',
        );
      }
    }
    out.push(prev); // unchanged: keep the original (preserves status/txHash/receipt/etc.)
  }
  return out;
}

// ─────────────────────────────── template resolution ───────────────────────────────

/** `{{item:<id>.contractAddress}}` or `{{item:<id>.log:<Event>.<field>}}` */
const TEMPLATE_RE = /\{\{item:([a-zA-Z0-9_-]+)\.(contractAddress|log:[A-Za-z0-9_]+\.[A-Za-z0-9_]+)\}\}/g;

/** Known event field -> which piece of a stored receipt log it reads. `topic` values are 0-indexed
 * INTO THE TOPICS ARRAY (0 is the event hash itself). Adding an event here is the only thing a new
 * `log:` template needs; `resolveTemplates` below does not special-case any event by name beyond
 * this table.
 *
 * `VaultCreated(address indexed vault, address indexed creator, address usdc, uint256 capacityCapUsdc)`
 * — `contracts/src/VaultFactory.sol:87`. Topic hash re-derived independently (not hand-transcribed)
 * by `scripts/test/sign-queue.test.mjs`, the same discipline
 * `EXPECTED_CREATE_VAULT_SELECTOR` already uses in `scripts/smoke-preflight.mjs`. */
export const EVENT_LOG_FIELDS = Object.freeze({
  VaultCreated: {
    topic0: '0x4dda9a6d0ba03769e9813c47681795a7210f951e6ef31e64772e13b9ea0f1406',
    fields: { vault: { kind: 'topic-address', index: 1 }, creator: { kind: 'topic-address', index: 2 } },
  },
});

/**
 * Resolve every `{{item:...}}` template in `template` against `itemsById`. Returns
 * `{ ok:true, resolved }` once every reference is satisfiable, or `{ ok:false, reason }` naming the
 * FIRST unresolved reference — a referenced item that does not exist, is not yet `done`, has no
 * stored receipt, or names a field this table does not know.
 * @param {string} template
 * @param {Map<string, QueueItem>} itemsById
 * @returns {{ok:true, resolved:string}|{ok:false, reason:string}}
 */
export function resolveTemplates(template, itemsById) {
  if (typeof template !== 'string' || !template.includes('{{item:')) return { ok: true, resolved: template };
  let reason = null;
  const resolved = template.replace(TEMPLATE_RE, (whole, id, tail) => {
    if (reason) return whole; // already failed; stop mutating further, the failure wins
    const dep = itemsById.get(id);
    if (!dep) { reason = `template references item "${id}", which does not exist in the queue`; return whole; }
    if (dep.status !== 'done') { reason = `template references item "${id}", which is not done yet (status: ${dep.status})`; return whole; }
    if (tail === 'contractAddress') {
      const addr = dep.receipt?.contractAddress;
      if (!addr) { reason = `item "${id}" is done but its stored receipt has no contractAddress`; return whole; }
      return addr;
    }
    const m = /^log:([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)$/.exec(tail);
    if (!m) { reason = `template tail ${JSON.stringify(tail)} is not a recognised form`; return whole; }
    const [, eventName, fieldName] = m;
    const eventDef = EVENT_LOG_FIELDS[eventName];
    if (!eventDef) { reason = `template references unknown event "${eventName}"`; return whole; }
    const fieldDef = eventDef.fields[fieldName];
    if (!fieldDef) { reason = `event "${eventName}" has no known field "${fieldName}"`; return whole; }
    const logs = Array.isArray(dep.receipt?.logs) ? dep.receipt.logs : [];
    const log = logs.find((l) => normAddr(l.topics?.[0]) === normAddr(eventDef.topic0));
    if (!log) { reason = `item "${id}"'s stored receipt has no ${eventName} log`; return whole; }
    if (fieldDef.kind === 'topic-address') {
      const topic = log.topics?.[fieldDef.index];
      if (typeof topic !== 'string' || topic.length < 66) {
        reason = `item "${id}"'s ${eventName} log has no usable topics[${fieldDef.index}]`; return whole;
      }
      return `0x${topic.slice(-40)}`;
    }
    reason = `field kind ${fieldDef.kind} is not implemented`;
    return whole;
  });
  if (reason) return { ok: false, reason };
  return { ok: true, resolved };
}

// ────────────────────────────────── receipt verification ──────────────────────────────────

/**
 * Does `receipt`+`tx` confirm that `item` (with its FROZEN `sentData`, never a fresh
 * re-resolution) actually landed? Returns `null` when confirmed, or a reason string naming exactly
 * what disagreed — the caller (dashboard.mjs's poller) must not advance `status` to `done` unless
 * this returns `null`, and a `null` return is the ONLY path that may.
 *
 * Deliberately reads `input`/`from`/`to` off the TRANSACTION (`eth_getTransactionByHash`), not the
 * receipt — `eth_getTransactionReceipt` carries no `input` field, so comparing against
 * `receipt.input` is always `undefined === undefined`: a guard that always "passes" by never
 * running. `to` is read from the receipt for a CREATE (it is `null` there, by design) and from the
 * transaction otherwise, since both report the same value for a plain call.
 *
 * @param {object} p
 * @param {QueueItem} p.item
 * @param {{from:string,to:string|null,input:string}} p.tx
 * @param {{status:string,from:string,to:string|null,contractAddress:string|null,logs:any[]}} p.receipt
 * @returns {string|null}
 */
export function verifyReceipt({ item, tx, receipt }) {
  if (typeof item.sentData !== 'string') return 'item has no frozen sentData to verify against';
  const statusOk = receipt.status === '0x1' || receipt.status === 1;
  if (!statusOk) return `receipt.status is ${JSON.stringify(receipt.status)}, not success`;
  if (normAddr(tx.from) !== normAddr(item.from)) {
    return `tx.from is ${tx.from}, item.from is ${item.from}`;
  }
  if (item.to === null) {
    if (!receipt.contractAddress) return 'item is a CREATE but receipt has no contractAddress';
    if (item.predictedAddress && normAddr(receipt.contractAddress) !== normAddr(item.predictedAddress)) {
      return `receipt.contractAddress is ${receipt.contractAddress}, predicted ${item.predictedAddress}`;
    }
    if (tx.to !== null && tx.to !== undefined) return `item is a CREATE but tx.to is ${tx.to}, not null`;
  } else if (normAddr(tx.to) !== normAddr(item.to)) {
    return `tx.to is ${tx.to}, item.to is ${item.to}`;
  }
  if (normAddr(tx.input) !== normAddr(item.sentData)) {
    return 'tx.input does not match the data this server resolved and sent to the browser at send time';
  }
  // Safe-routed items (execTransaction): status==1 is the OUTER transaction only.
  // Safe.execTransaction catches an inner-call revert and emits ExecutionFailure rather than
  // reverting the outer tx — see scripts/smoke-test.mjs's own T_EXEC_SUCCESS/T_EXEC_FAILURE
  // comment. A caller trusting receipt.status alone would read a failed inner call as success.
  if (item.expectsSafeExecution) {
    const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
    const success = logs.some((l) => normAddr(l.topics?.[0]) === EXEC_SUCCESS_TOPIC && normAddr(l.address) === normAddr(item.to));
    const failure = logs.some((l) => normAddr(l.topics?.[0]) === EXEC_FAILURE_TOPIC && normAddr(l.address) === normAddr(item.to));
    if (failure) return 'Safe emitted ExecutionFailure — the outer transaction succeeded but the inner call reverted';
    if (!success) return 'Safe emitted neither ExecutionSuccess nor ExecutionFailure — cannot confirm the inner call ran';
  }
  if (item.expectedLog) {
    const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
    const def = EVENT_LOG_FIELDS[item.expectedLog.event];
    const found = logs.some((l) => normAddr(l.topics?.[0]) === normAddr(def?.topic0)
      && normAddr(l.address) === normAddr(item.expectedLog.emitter));
    if (!found) return `expected ${item.expectedLog.event} from ${item.expectedLog.emitter} was not found in the receipt's logs`;
  }
  return null;
}

/**
 * Is `tx` simply NOT this item's transaction at all — a foreign or junk hash, confirmed or
 * otherwise, whose `from`/`to`/`input` disagree with what this item recorded at send time? This is
 * deliberately narrower than `verifyReceipt`: it never looks at `status` or logs, because a
 * genuinely-the-item's-own transaction that reverted on chain is a real `failed` outcome, not a
 * foreign hash — see `advanceSentItems` (`scripts/lib/sign-queue-server.mjs`), which uses this to
 * decide "revert to pending, signable again" (foreign) vs "failed" (ours, but it reverted).
 *
 * V-381-r1-8083f497 (Security, PR #381): the un-authenticated POST endpoint let any website freeze
 * a `pending` item at `sent` with a made-up hash, which then NEVER confirmed and left the item
 * stuck — the owner's real click got a 409 and every dependent stayed blocked. The Origin/Host/
 * content-type gate (`scripts/dashboard.mjs`) is the fix for the POST itself; this function is the
 * recovery path for whatever gets through anyway (a mistake, or a gate that is itself defeated).
 *
 * @param {QueueItem} item
 * @param {{from:string,to:string|null,input:string}} tx
 * @returns {boolean}
 */
export function isForeignTx(item, tx) {
  if (typeof item.sentData !== 'string') return true;
  if (normAddr(tx.from) !== normAddr(item.from)) return true;
  if (item.to === null) {
    if (tx.to !== null && tx.to !== undefined) return true;
  } else if (normAddr(tx.to) !== normAddr(item.to)) {
    return true;
  }
  if (normAddr(tx.input) !== normAddr(item.sentData)) return true;
  return false;
}

/** `ExecutionSuccess(bytes32,uint256)` / `ExecutionFailure(bytes32,uint256)` — Safe.sol / SafeL2.sol.
 * Re-derived independently by `scripts/test/sign-queue.test.mjs` via a real `cast keccak`, the same
 * discipline `scripts/smoke-test.mjs`'s own `T_EXEC_SUCCESS`/`T_EXEC_FAILURE` computes at runtime;
 * these are the literal, pre-computed form so the dashboard's request path never shells out to
 * `cast` on every poll. */
export const EXEC_SUCCESS_TOPIC = '0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e';
export const EXEC_FAILURE_TOPIC = '0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5272e64d115b687d23';
