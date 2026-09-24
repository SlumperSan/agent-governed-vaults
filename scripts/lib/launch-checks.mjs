// @ts-check
/**
 * Launch-readiness checks for the dashboard's "Launch checks" panel — read-only, on demand.
 *
 * EVERY CHECK HERE IS ONE OF: `eth_call`, `eth_getCode`, `eth_chainId`, `eth_getBalance`,
 * `eth_getBlockByNumber`, or a file/HTTP read. NOTHING HERE SIGNS, BROADCASTS, OR TOUCHES A KEY.
 * Where the remedy for a red row is a transaction, this module returns the exact command as a
 * string for the owner to run
 * himself — it never runs one. `docs/SWARM.md` §10 puts "anything requiring a private key, a
 * funded account, or a `--broadcast`" on the escalate-do-not-act list, and a "run" button here
 * would cross it. If you are tempted to add one, stop and read that section first.
 *
 * THE UNKNOWN STATE IS THE WHOLE POINT. A row is 'unknown' whenever its read could not complete
 * — RPC unreachable, timeout, malformed response, a JSON-RPC `error` object, or a chain-id that
 * does not match what the row expects. 'green' is asserted ONLY when every read that feeds it
 * actually returned a value consistent with "the check passed". There is no code path from
 * "the read failed" to "green" anywhere below; every function's error branches return 'unknown'
 * or 'red', never fall through to a default that could read as pass. `Rules/a-disclosure-that-
 * vanishes-is-a-claim.md` in the Obsidian vault names this exact failure mode.
 *
 * Each row's own function is exported separately so the test suite can call one row at a time
 * with a stubbed `fetch`, rather than driving the whole panel through the network.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { P, STATUS, decodeProposal } from './proposal-decode.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const BASE_SEPOLIA_DEPLOYMENT = path.join(ROOT, 'contracts/config/deployments/base-sepolia.json');
const ARC_MAINNET_DEPLOYMENT = path.join(ROOT, 'contracts/config/deployments/arc-mainnet.json');
const ARC_MAINNET_CONFIG = path.join(ROOT, 'contracts/config/arc-mainnet.json');
const SOAK_VAULTS = path.join(ROOT, 'scripts/soak/soak-vaults.json');

/** Read a JSON config once per call — these are small files and this endpoint is click-driven,
 * never polled, so re-reading costs nothing and can never serve a stale address after a redeploy. */
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// ───────────────────────── addresses, derived rather than copied ─────────────────────────────
// Everything derivable comes from the repo's own config so a hand-typed address here can never
// rot out of step with a redeploy. The two addresses that are NOT in any repo config are called
// out at their use site below, with why.
const baseSepolia = readJson(BASE_SEPOLIA_DEPLOYMENT);
const GOVERNANCE_ADDR = baseSepolia.singletons.Governance;
const USDC_ADDR = baseSepolia.infrastructure.usdc;
const DEPLOYER_ADDR = baseSepolia.deployer;
const BASE_SEPOLIA_RPC = baseSepolia.rpc;

/** Not in any repo config — the Creator Safe was deployed through the Safe UI, not this repo's
 * deploy scripts, so there is nothing here to derive it from. Given by the owner. */
const SAFE_ADDR = '0x99e805294F1f1465C96f68e36264E99991Ef9E82';
const ARC_MAINNET_RPC = 'https://rpc.mainnet.arc.io';
const ARC_MAINNET_CHAIN_ID_HEX = '0x13b2'; // 5042 decimal

/** There is deliberately NO hardcoded proposal id here — see `checkStaleProposal`'s own doc
 * comment for why PR #366 was rejected for having one, and why `proposalCount()` (a public
 * monotonic counter, `Governance.sol:144`) is read fresh on every click instead. */

const APP_MARKER = '<title>App | RWAlly</title>'; // apps/app, retiring
const VAULTS_UI_MARKER = 'Vault Atlas'; // apps/vaults-ui, the replacement

const DEFAULT_TIMEOUT_MS = 6000;

/**
 * One JSON-RPC call over HTTP, with a hard timeout and no throw. Every possible failure —
 * network error, timeout, non-2xx, unparsable body, a JSON-RPC `error` object — resolves to
 * `{ ok:false, ... }` rather than throwing, so a caller can never accidentally let an exception
 * skip past an 'unknown' state into whatever the last-known state was.
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {string} method
 * @param {unknown[]} params
 * @param {number} [timeoutMs]
 * @returns {Promise<{ok:true, result:any}|{ok:false, reason:string}>}
 */
async function rpcCall(fetchImpl, url, method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, reason: `${method}: request failed — ${/** @type {Error} */ (e).message}` };
  }
  if (!res.ok) return { ok: false, reason: `${method}: HTTP ${res.status}` };
  let body;
  try {
    body = await res.json();
  } catch (e) {
    return { ok: false, reason: `${method}: response was not JSON — ${/** @type {Error} */ (e).message}` };
  }
  if (body && typeof body === 'object' && body.error) {
    return { ok: false, reason: `${method}: RPC error — ${body.error.message ?? JSON.stringify(body.error)}` };
  }
  if (!body || body.result === undefined) {
    return { ok: false, reason: `${method}: no result in response` };
  }
  return { ok: true, result: body.result };
}

/**
 * Several JSON-RPC calls as one HTTP request — a batch array — so that reads which must agree
 * with each other (code + chain id) are answered by the SAME node behind a load-balanced RPC
 * hostname. If the endpoint does not support batching (an error, a non-array body, or the whole
 * request failing), falls back to firing the calls sequentially against the same URL; the
 * same-connection guarantee is then best-effort rather than mechanical, and callers are told so
 * via `batched: false`.
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {{method:string, params:unknown[]}[]} calls
 * @param {number} [timeoutMs]
 * @returns {Promise<{batched:boolean, results:({ok:true,result:any}|{ok:false,reason:string})[]}>}
 */
async function rpcBatch(fetchImpl, url, calls, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params }));
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = await res.json();
    if (!Array.isArray(parsed)) throw new Error('batch response was not an array');
    const byId = new Map(parsed.map((r) => [r.id, r]));
    const results = calls.map((c, i) => {
      const r = byId.get(i);
      if (!r) return { ok: false, reason: `${c.method}: missing from batch response` };
      if (r.error) return { ok: false, reason: `${c.method}: RPC error — ${r.error.message ?? JSON.stringify(r.error)}` };
      if (r.result === undefined) return { ok: false, reason: `${c.method}: no result in response` };
      return { ok: true, result: r.result };
    });
    return { batched: true, results };
  } catch {
    // Fall back to sequential calls against the same URL — still one endpoint, just not
    // provably one connection.
    const results = [];
    for (const c of calls) results.push(await rpcCall(fetchImpl, url, c.method, c.params, timeoutMs));
    return { batched: false, results };
  }
}

const hexToBigInt = (h) => BigInt(h);
/** Right-pad a hex selector, left-pad a uint256 arg — the whole of this repo's ABI encoding need. */
const encodeCall = (selector, ...uint256Args) =>
  selector + uint256Args.map((a) => BigInt(a).toString(16).padStart(64, '0')).join('');
/** One 32-byte word out of raw eth_call return data, 0-indexed, without the leading `0x`. */
const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
const wordAsAddress = (hex, i) => '0x' + word(hex, i).slice(24);
const wordAsBigInt = (hex, i) => BigInt('0x' + word(hex, i));

// ─────────────────────────────────── row 1 — Creator Safe ────────────────────────────────────

/**
 * Creator Safe live on Arc mainnet: `eth_getCode` and `eth_chainId` in one batch against the same
 * endpoint, so a stray testnet read can never masquerade as a mainnet one — that is exactly how
 * the real testnet-vs-mainnet mistake happened. `getThreshold()` is read alongside and shown as
 * informational only; a 1-of-1 Safe is not itself a failure of this check.
 * @param {typeof fetch} fetchImpl
 */
export async function checkCreatorSafe(fetchImpl) {
  const { results } = await rpcBatch(fetchImpl, ARC_MAINNET_RPC, [
    { method: 'eth_getCode', params: [SAFE_ADDR, 'latest'] },
    { method: 'eth_chainId', params: [] },
    { method: 'eth_call', params: [{ to: SAFE_ADDR, data: '0xe75235b8' }, 'latest'] },
  ]);
  const [code, chainId, threshold] = results;

  if (!code.ok || !chainId.ok) {
    const reason = [!code.ok && code.reason, !chainId.ok && chainId.reason].filter(Boolean).join('; ');
    return row('safe', 'Creator Safe live on Arc mainnet', 'unknown', reason, null);
  }
  if (chainId.result !== ARC_MAINNET_CHAIN_ID_HEX) {
    return row('safe', 'Creator Safe live on Arc mainnet', 'red',
      `connected chain is ${chainId.result}, not Arc mainnet (${ARC_MAINNET_CHAIN_ID_HEX}) — a read on the wrong chain, not a real answer`, null);
  }
  const hasCode = typeof code.result === 'string' && code.result !== '0x' && code.result !== '0x0';
  if (!hasCode) {
    return row('safe', 'Creator Safe live on Arc mainnet', 'red',
      `no code at ${SAFE_ADDR} on Arc mainnet (chain id confirmed ${chainId.result})`, null);
  }
  let thresholdNote = '';
  if (threshold.ok && typeof threshold.result === 'string' && threshold.result.length >= 66) {
    const n = wordAsBigInt(threshold.result, 0);
    thresholdNote = n === 1n ? ' · threshold 1-of-1 (informational, not a failure)' : ` · threshold ${n}-of-N`;
  } else {
    thresholdNote = ' · threshold unreadable (informational only)';
  }
  return row('safe', 'Creator Safe live on Arc mainnet', 'green',
    `code present at ${SAFE_ADDR}, chain id ${chainId.result} confirmed${thresholdNote}`, null);
}

// ───────────────────────── row 2 — stale governance proposal ─────────────────────────────────

/** Upper bound on how many proposal ids one click will enumerate. `proposalCount()` has never
 * been observed above single digits on this testnet as of 2026-09-21, so this is generous
 * headroom, not a tuned limit — its job is only to bound one click to a fixed number of RPC
 * calls. If the real count ever exceeds it, the row below renders 'unknown' rather than silently
 * scanning a subset and calling that complete. */
const PROPOSAL_SCAN_CAP = 500;
/** Calls per JSON-RPC batch while scanning — keeps any one HTTP request to a size public
 * providers reliably accept, rather than one `PROPOSAL_SCAN_CAP`-sized batch. */
const PROPOSAL_SCAN_CHUNK = 100;

/**
 * Stale governance proposal blocking the soak.
 *
 * WHY THIS PROPERTY, NOT A PID (PR #366's REJECT). The previous version of this row hardcoded
 * `proposals(11)` and only cross-checked `activeProposalOf(vault)` — and only inside the RED
 * branch — so once proposal 11 resolved, a NEW stuck proposal rendered green. That happened for
 * real, hours after the row was written: proposal 11 resolved (Defeated) and proposal 12 went
 * Active and sat past its reveal deadline with zero reveals, stranding a soak drill — and the
 * pid-11 check would have shown PASS throughout.
 *
 * `activeProposalOf` alone is not a safe replacement either: `Governance.sol` assigns it once
 * inside `propose` (line 343) and NEVER clears it on settlement (see `scripts/soak/lib.mjs`'s
 * `votableNow` doc comment for the incident that already cost a soak run over this), so it
 * always names the LAST pid ONE vault ever had — it cannot, by itself, prove nothing is stuck
 * for any OTHER vault.
 *
 * WHAT THIS ROW READS INSTEAD: `Governance.proposalCount` (line 144) is a public monotonic
 * counter, and every `propose()` call does `pid = ++proposalCount` (line 330) — so proposal ids
 * are EXACTLY the contiguous range `1..proposalCount`, with no gaps and none outside it, by
 * construction. Reading `proposalCount()` fresh and then every `proposals(i)` for `i` in that
 * range reaches every proposal that has ever existed, for every vault — never a remembered or
 * hardcoded id.
 *
 * WHAT "STUCK" MEANS, AND WHY IT ENTAILS "BLOCKING THE SOAK" — the property checked, not an
 * adjacent one. `finalize(uint256)` (`Governance.sol:577-579`) requires exactly
 * `p.status == Status.Active && block.timestamp >= p.revealDeadline`; that is this row's own
 * predicate, copied from the contract's own precondition for the one function that unsticks a
 * proposal. Nothing else moves an `Active` proposal off that status on its own —
 * `_refreshStatus` (line 718) only auto-expires a proposal already `Passed`, never `Active` — so
 * a proposal meeting this predicate stays stuck until someone calls `finalize`. And it actually
 * blocks: `propose()` (lines 312-315) and delegation (lines 562-565) both refuse to proceed for a
 * vault whose `activeProposalOf` entry is not yet settled.
 *
 * THE ROW LABEL SAYS "blocking the soak", SINGULAR AND SOAK-SCOPED; THE SCAN IS REPO-WIDE, ACROSS
 * EVERY VAULT. That is deliberate, not a drift between the label and the property: the soak
 * shares one Governance deployment with every vault this repo has registered, any one of them
 * stuck blocks that vault's own governance, and there is no cheaper query that is scoped to "the
 * soak's vault" without reintroducing a hardcoded vault address — the same defect shape as the
 * hardcoded pid, one property over.
 *
 * BOTH BRANCHES EARN THEIR VERDICT THE SAME WAY. There is one code path below: scan every
 * proposal `1..proposalCount`, and green and red are both computed from that same complete scan
 * — unlike the rejected version, there is no cheaper path to green that skips the check the red
 * branch does.
 *
 * UNKNOWN, LOUDLY, WHENEVER THE SCAN CANNOT BE TRUSTED COMPLETE: `proposalCount()` unreadable,
 * the chain's own clock (`eth_getBlockByNumber('latest').timestamp`, read on the same connection
 * as the count) unreadable, any single `proposals(i)` read failing or malformed, a decoded status
 * byte out of range, or `proposalCount()` itself exceeding `PROPOSAL_SCAN_CAP`. A partial scan, or
 * a fallback to this machine's own clock instead of the chain's, could hide the one stuck
 * proposal, so either is never reported as green.
 * @param {typeof fetch} fetchImpl
 */
export async function checkStaleProposal(fetchImpl) {
  // proposalCount() and the chain's OWN clock, batched onto the same connection — Governance
  // gates `finalize` on `block.timestamp`, not wall-clock time (`Governance.sol:579`), and this
  // machine's clock is not guaranteed to agree with the chain's. Using `Date.now()` here would be
  // the same species of defect this fix exists to remove: a predicate that approximates the
  // contract's own precondition instead of reading it. If a local clock ran behind chain time, an
  // actually-stuck proposal would read "still within its reveal window" and this row would say
  // green — the corroborating read the green branch would not otherwise have earned.
  const { results: headerResults } = await rpcBatch(fetchImpl, BASE_SEPOLIA_RPC, [
    { method: 'eth_call', params: [{ to: GOVERNANCE_ADDR, data: '0xda35c664' }, 'latest'] },
    { method: 'eth_getBlockByNumber', params: ['latest', false] },
  ]);
  const [countCall, blockCall] = headerResults;
  if (!countCall.ok) {
    return row('proposal', 'Stale governance proposal blocking the soak', 'unknown', `proposalCount(): ${countCall.reason}`, null);
  }
  if (typeof countCall.result !== 'string' || countCall.result.length < 66) {
    return row('proposal', 'Stale governance proposal blocking the soak', 'unknown',
      'proposalCount() returned a short/malformed result', null);
  }
  if (!blockCall.ok) {
    return row('proposal', 'Stale governance proposal blocking the soak', 'unknown', `eth_getBlockByNumber (chain clock): ${blockCall.reason}`, null);
  }
  if (!blockCall.result || typeof blockCall.result.timestamp !== 'string') {
    return row('proposal', 'Stale governance proposal blocking the soak', 'unknown',
      'eth_getBlockByNumber returned no usable block.timestamp — cannot read the chain\'s own clock', null);
  }
  const nowSec = Number(hexToBigInt(blockCall.result.timestamp));
  const count = hexToBigInt(countCall.result);

  if (count === 0n) {
    return row('proposal', 'Stale governance proposal blocking the soak', 'green',
      'proposalCount() reads 0 — no proposal has ever been created, so none can be stuck', null);
  }
  if (count > BigInt(PROPOSAL_SCAN_CAP)) {
    return row('proposal', 'Stale governance proposal blocking the soak', 'unknown',
      `proposalCount() reads ${count}, above this row's scan cap of ${PROPOSAL_SCAN_CAP} — cannot enumerate every proposal to confirm none are stuck (a scan-completeness limit, not a health verdict)`, null);
  }

  const total = Number(count);
  /** @type {({ok:true,result:any}|{ok:false,reason:string})[]} */
  const results = [];
  for (let start = 1; start <= total; start += PROPOSAL_SCAN_CHUNK) {
    const end = Math.min(start + PROPOSAL_SCAN_CHUNK - 1, total);
    const calls = [];
    for (let pid = start; pid <= end; pid++) {
      calls.push({ method: 'eth_call', params: [{ to: GOVERNANCE_ADDR, data: encodeCall('0x013cf08b', pid) }, 'latest'] });
    }
    const { results: chunk } = await rpcBatch(fetchImpl, BASE_SEPOLIA_RPC, calls);
    results.push(...chunk);
  }

  const failed = [];
  const stuck = [];
  let activeWithinWindow = 0;
  for (let i = 0; i < total; i++) {
    const pid = i + 1;
    const r = results[i];
    if (!r.ok) { failed.push(`#${pid}: ${r.reason}`); continue; }
    const data = r.result;
    if (typeof data !== 'string' || data.length < 2 + 16 * 64) { failed.push(`#${pid}: short/malformed tuple`); continue; }
    const fields = [
      wordAsAddress(data, P.VAULT),
      String(wordAsBigInt(data, P.PTYPE)),
      wordAsAddress(data, P.PROPOSER),
      String(wordAsBigInt(data, P.CREATED_AT)),
      String(wordAsBigInt(data, P.COMMIT_DEADLINE)),
      String(wordAsBigInt(data, P.REVEAL_DEADLINE)),
      String(wordAsBigInt(data, P.EXECUTABLE_AT)),
      String(wordAsBigInt(data, P.EXPIRES_AT)),
      String(wordAsBigInt(data, P.STATUS)),
      '0x' + word(data, P.ACTION_HASH),
      String(wordAsBigInt(data, P.SNAPSHOT_TOTAL)),
      String(wordAsBigInt(data, P.MEMBER_COUNT)),
      String(wordAsBigInt(data, P.FOR_WEIGHT)),
      String(wordAsBigInt(data, P.AGAINST_WEIGHT)),
      String(wordAsBigInt(data, P.REVEALED_WEIGHT)),
      String(wordAsBigInt(data, P.REVEALED_VOTER_COUNT)),
    ];
    const p = decodeProposal(fields);
    if (p.status === undefined) { failed.push(`#${pid}: status byte out of range`); continue; }
    if (p.status === 'Active' && nowSec >= p.revealDeadline) {
      stuck.push({ pid, vault: p.vault, revealDeadline: p.revealDeadline });
    } else if (p.status === 'Active') {
      activeWithinWindow++;
    }
  }

  // A read gap could be hiding the one stuck proposal — never reported as green.
  if (failed.length > 0) {
    return row('proposal', 'Stale governance proposal blocking the soak', 'unknown',
      `${failed.length}/${total} proposal read(s) failed, so this scan cannot be trusted complete — ${failed.join('; ')}`, null);
  }

  if (stuck.length === 0) {
    const withinWindowNote = activeWithinWindow > 0
      ? ` (${activeWithinWindow} currently Active but still within its/their reveal window — finalize would revert WrongPhase before then, so no remedy is offered for those)`
      : '';
    return row('proposal', 'Stale governance proposal blocking the soak', 'green',
      `scanned every proposal 1..${total} (proposalCount()) — none are Active past their reveal deadline${withinWindowNote}`, null);
  }

  const [first, ...rest] = stuck;
  const remedy = `cast send ${GOVERNANCE_ADDR} "finalize(uint256)" ${first.pid} --rpc-url ${BASE_SEPOLIA_RPC} --account <account>`;
  const others = rest.length > 0
    ? ` · ${rest.length} more stuck proposal(s): ${rest.map((s) => `#${s.pid} (vault ${s.vault})`).join(', ')}`
    : '';
  return row('proposal', 'Stale governance proposal blocking the soak', 'red',
    `proposal #${first.pid} (vault ${first.vault}) is Active and past its reveal deadline (${new Date(first.revealDeadline * 1000).toISOString()})${others}`,
    remedy);
}

// ───────────────────────────── row 3 — deployer balance margin ───────────────────────────────

/**
 * USDC and native balance for the Base Sepolia deployer, against the soak's own drill plan
 * total (`scripts/soak/soak-vaults.json` `budget.creatorUsdcTotal`) as the derived minimum —
 * not a number typed into this file, so it tracks the plan if the plan changes. Amber, not
 * green, when the margin above that minimum is under ~2 USDC: a thin margin covers the next
 * drill or two with nothing spare for a stranded retry, which is a real risk even though it is
 * not a failure.
 * @param {typeof fetch} fetchImpl
 */
export async function checkDeployerBalance(fetchImpl) {
  let minUsdcUnits;
  try {
    minUsdcUnits = BigInt(readJson(SOAK_VAULTS).budget.creatorUsdcTotal);
  } catch (e) {
    return row('balance', 'Deployer balance margin', 'unknown',
      `could not read the soak's drill-plan minimum from ${path.relative(ROOT, SOAK_VAULTS)}: ${/** @type {Error} */ (e).message}`, null);
  }

  const { results } = await rpcBatch(fetchImpl, BASE_SEPOLIA_RPC, [
    { method: 'eth_call', params: [{ to: USDC_ADDR, data: encodeCall('0x70a08231', DEPLOYER_ADDR) }, 'latest'] },
    { method: 'eth_getBalance', params: [DEPLOYER_ADDR, 'latest'] },
  ]);
  const [usdcCall, nativeCall] = results;
  if (!usdcCall.ok) {
    return row('balance', 'Deployer balance margin', 'unknown', usdcCall.reason, null);
  }
  if (typeof usdcCall.result !== 'string' || usdcCall.result.length < 66) {
    return row('balance', 'Deployer balance margin', 'unknown', 'USDC balanceOf returned a malformed result', null);
  }
  const usdcUnits = wordAsBigInt(usdcCall.result, 0);
  const usdcStr = (Number(usdcUnits) / 1e6).toFixed(2);
  const minStr = (Number(minUsdcUnits) / 1e6).toFixed(2);
  const marginUnits = usdcUnits - minUsdcUnits;
  const marginStr = (Number(marginUnits) / 1e6).toFixed(2);
  const nativeStr = nativeCall.ok && typeof nativeCall.result === 'string'
    ? (Number(hexToBigInt(nativeCall.result)) / 1e18).toFixed(4) + ' ETH'
    : `native balance unreadable${!nativeCall.ok ? ` (${nativeCall.reason})` : ''}`;

  if (marginUnits < 0n) {
    return row('balance', 'Deployer balance margin', 'red',
      `${usdcStr} USDC held, below the soak's own drill-plan total of ${minStr} USDC (short ${(Number(-marginUnits) / 1e6).toFixed(2)}) · ${nativeStr}`, null);
  }
  const state = marginUnits < 2_000_000n ? 'amber' : 'green'; // < ~2.00 USDC of margin
  return row('balance', 'Deployer balance margin', state,
    `${usdcStr} USDC held against a ${minStr} USDC drill-plan minimum (margin ${marginStr}) · ${nativeStr}`, null);
}

// ─────────────────────────────────── row 4 — Arc deployment ──────────────────────────────────

/**
 * Whether this repository has anything deployed on Arc mainnet — a file read, no RPC. The
 * `arc-mainnet.json` this checks is the DEPLOYMENT RECORD path
 * (`contracts/config/deployments/`), which does not exist today; `contracts/config/arc-
 * mainnet.json` is a DIFFERENT file — pre-deploy configuration evidence, not a record of
 * anything live — and its own `status` field is quoted here rather than paraphrased, so this row
 * cannot drift from what that file actually says.
 */
export function checkArcDeployment() {
  if (existsSync(ARC_MAINNET_DEPLOYMENT)) {
    return row('arc-deploy', 'Arc deployment', 'green',
      `${path.relative(ROOT, ARC_MAINNET_DEPLOYMENT)} exists`, null);
  }
  let configStatus = '';
  try {
    configStatus = readJson(ARC_MAINNET_CONFIG).status ?? '';
  } catch {
    // The config file is optional context for this row's message, not its verdict — a missing
    // or unreadable config file does not change the fact that the deployment record is absent.
  }
  return row('arc-deploy', 'Arc deployment', 'red',
    `${path.relative(ROOT, ARC_MAINNET_DEPLOYMENT)} does not exist — nothing from this repository is on Arc mainnet` +
    (configStatus ? ` (${path.relative(ROOT, ARC_MAINNET_CONFIG)}: "${configStatus}")` : ''),
    null);
}

// ────────────────────────────── row 5 — member surface in production ─────────────────────────

/**
 * Fetches app.rwally.com and rwally.com and reports, for each, whether the body carries the
 * retiring `apps/app` marker or the replacement `apps/vaults-ui` marker. Purely informational —
 * there is no "wrong" answer this row asserts, only what is live right now — so 'green' means
 * the member surface (`app.rwally.com`) is fully cut over to `apps/vaults-ui`, 'amber' means it
 * is still serving the retiring `apps/app`, and 'unknown' means the fetch itself failed for the
 * host that matters (`app.rwally.com`); `rwally.com` is the marketing site and is not expected to
 * carry either marker.
 * @param {typeof fetch} fetchImpl
 */
export async function checkMemberSurface(fetchImpl) {
  const classify = (body) => {
    if (typeof body !== 'string') return 'neither';
    if (body.includes(VAULTS_UI_MARKER)) return 'vaults-ui';
    if (body.includes(APP_MARKER)) return 'app';
    return 'neither';
  };
  const fetchBody = async (host) => {
    try {
      const res = await fetchImpl(`https://${host}/`, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      return { ok: true, body: await res.text() };
    } catch (e) {
      return { ok: false, reason: /** @type {Error} */ (e).message };
    }
  };

  const [app, root] = await Promise.all([fetchBody('app.rwally.com'), fetchBody('rwally.com')]);

  if (!app.ok) {
    return row('member-surface', 'What app.rwally.com and rwally.com are serving', 'unknown',
      `app.rwally.com: ${app.reason}` + (!root.ok ? ` · rwally.com: ${root.reason}` : ''), null);
  }
  const appWhich = classify(app.body);
  const rootWhich = root.ok ? classify(root.body) : 'unreachable';
  const detail = `app.rwally.com serves ${appWhich === 'vaults-ui' ? 'apps/vaults-ui' : appWhich === 'app' ? 'apps/app (retiring)' : 'neither marker — could not classify'} (matched on "${appWhich === 'vaults-ui' ? VAULTS_UI_MARKER : appWhich === 'app' ? APP_MARKER : 'no known marker'}") · rwally.com is ${rootWhich === 'unreachable' ? `unreachable (${root.ok ? '' : root.reason})` : rootWhich === 'vaults-ui' ? 'serving apps/vaults-ui' : rootWhich === 'app' ? 'serving apps/app' : 'serving neither marker (expected — it is the marketing site, apps/site)'}`;

  if (appWhich === 'vaults-ui') return row('member-surface', 'What app.rwally.com and rwally.com are serving', 'green', detail, null);
  if (appWhich === 'app') return row('member-surface', 'What app.rwally.com and rwally.com are serving', 'amber', detail, null);
  return row('member-surface', 'What app.rwally.com and rwally.com are serving', 'unknown', detail, null);
}

/** @returns {{id:string, name:string, state:'green'|'amber'|'red'|'unknown', detail:string, remedy:string|null}} */
function row(id, name, state, detail, remedy) {
  return { id, name, state, detail, remedy };
}

/**
 * One entry per row — id, display name, and the function that runs it — kept as ONE array rather
 * than three parallel ones. Three separate lists (a call array, an ids array, a names array),
 * aligned only by sharing the same index, is the same defect this file exists to prevent one
 * layer up: nothing stops them drifting apart if a row is reordered or inserted, and a row moved
 * this way would surface under a DIFFERENT row's id and name — a wrong-row-named vanishing
 * disclosure. Binding id+name+run together in one element makes that impossible by construction:
 * whatever order this array is in, `CHECKS[i]` is always the descriptor for `settled[i]`.
 * @type {{id:string, name:string, run:(f:typeof fetch)=>Promise<ReturnType<typeof row>>}[]}
 */
const CHECKS = [
  { id: 'safe', name: 'Creator Safe live on Arc mainnet', run: (f) => checkCreatorSafe(f) },
  { id: 'proposal', name: 'Stale governance proposal blocking the soak', run: (f) => checkStaleProposal(f) },
  { id: 'balance', name: 'Deployer balance margin', run: (f) => checkDeployerBalance(f) },
  { id: 'arc-deploy', name: 'Arc deployment', run: () => Promise.resolve(checkArcDeployment()) },
  { id: 'member-surface', name: 'What app.rwally.com and rwally.com are serving', run: (f) => checkMemberSurface(f) },
];

/**
 * Every row, run in parallel. One row throwing (a bug in this module, not an RPC failure — every
 * RPC failure is already caught above) must not take the rest down with it, so each is wrapped.
 *
 * The fallback for a thrown row is keyed off `CHECKS[i]`'s own id and name — NOT the array index.
 * A fallback keyed on index (`String(i)`) is the exact defect this module exists to prevent one
 * layer up: the client looks a row up by its real id (`scripts/dashboard.mjs`'s `byId[meta.id]`),
 * so an id of "0".."4" makes a genuinely-thrown row invisible to that lookup and the panel renders
 * it as "NOT CHECKED YET" — an unknown rendered as silence — instead of the UNKNOWN pill the
 * failed read earned. PR #366's Product review caught this for real via `BigInt('0xzz')` throwing
 * inside `checkStaleProposal`.
 * @param {typeof fetch} [fetchImpl]
 */
export async function runLaunchChecks(fetchImpl = fetch) {
  const settled = await Promise.allSettled(CHECKS.map((c) => c.run(fetchImpl)));
  return settled.map((s, i) =>
    s.status === 'fulfilled' ? s.value : row(CHECKS[i].id, CHECKS[i].name, 'unknown', `check threw: ${s.reason?.message ?? s.reason}`, null));
}
