// @ts-check
/**
 * Launch-readiness checks for the dashboard's "Launch checks" panel — read-only, on demand.
 *
 * EVERY CHECK HERE IS ONE OF: `eth_call`, `eth_getCode`, `eth_chainId`, `eth_getBalance`, or a
 * file/HTTP read. NOTHING HERE SIGNS, BROADCASTS, OR TOUCHES A KEY. Where the remedy for a red
 * row is a transaction, this module returns the exact command as a string for the owner to run
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

/** The proposal id the launch soak is currently stalled on. Not derivable from any file in this
 * repo — it is the operational fact this row exists to check — so it is given here and the row
 * reads its CURRENT state live rather than trusting this number to still be the stuck one. */
const STALLED_PROPOSAL_ID = 11;

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

/**
 * Reads `proposals(11)` on Base Sepolia's Governance, decodes it with the SAME decoder
 * `scripts/smoke-test.mjs` and the soak runner use (`scripts/lib/proposal-decode.mjs`), and
 * cross-reads `activeProposalOf(vault)` to confirm 11 is still the vault's current proposal
 * rather than one superseded since. Green only when there is no Active proposal past its reveal
 * deadline. The `finalize` remedy is offered ONLY once the proposal is past that deadline —
 * offered earlier it would revert `WrongPhase` (`Governance.sol:579`), which is a confusing way
 * to learn the timing was wrong.
 * @param {typeof fetch} fetchImpl
 */
export async function checkStaleProposal(fetchImpl) {
  const proposalsCall = await rpcCall(
    fetchImpl, BASE_SEPOLIA_RPC, 'eth_call',
    [{ to: GOVERNANCE_ADDR, data: encodeCall('0x013cf08b', STALLED_PROPOSAL_ID) }, 'latest'],
  );
  if (!proposalsCall.ok) {
    return row('proposal', 'Stale governance proposal blocking the soak', 'unknown', proposalsCall.reason, null);
  }
  const data = proposalsCall.result;
  if (typeof data !== 'string' || data.length < 2 + 16 * 64) {
    return row('proposal', 'Stale governance proposal blocking the soak', 'unknown',
      `proposals(${STALLED_PROPOSAL_ID}) returned a short/malformed tuple`, null);
  }

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
  if (p.status === undefined) {
    return row('proposal', 'Stale governance proposal blocking the soak', 'unknown',
      `proposal ${STALLED_PROPOSAL_ID} decoded a status byte out of range`, null);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const pastDeadline = p.status === 'Active' && nowSec >= p.revealDeadline;
  const remedy = `cast send ${GOVERNANCE_ADDR} "finalize(uint256)" ${STALLED_PROPOSAL_ID} --rpc-url ${BASE_SEPOLIA_RPC} --account <account>`;

  if (p.status !== 'Active') {
    return row('proposal', 'Stale governance proposal blocking the soak', 'green',
      `proposal ${STALLED_PROPOSAL_ID} is ${p.status}, not Active — nothing blocking`, null);
  }
  if (!pastDeadline) {
    const eta = new Date(p.revealDeadline * 1000).toISOString();
    return row('proposal', 'Stale governance proposal blocking the soak', 'green',
      `proposal ${STALLED_PROPOSAL_ID} is Active but still within its reveal window (deadline ${eta}) — finalize would revert WrongPhase before then, so no remedy is offered yet`, null);
  }

  // Corroborate with activeProposalOf(vault) — same read pattern as row 1's "same connection"
  // rule, here spent on "same vault" instead: confirms 11 has not already been superseded.
  const activeCall = await rpcCall(
    fetchImpl, BASE_SEPOLIA_RPC, 'eth_call',
    [{ to: GOVERNANCE_ADDR, data: encodeCall('0xdce22376', p.vault) }, 'latest'],
  );
  let corroboration = '';
  if (activeCall.ok && typeof activeCall.result === 'string' && activeCall.result.length >= 66) {
    const activePid = wordAsBigInt(activeCall.result, 0);
    corroboration = activePid === BigInt(STALLED_PROPOSAL_ID)
      ? ` · activeProposalOf(vault) confirms ${STALLED_PROPOSAL_ID} is still the vault's active proposal`
      : ` · activeProposalOf(vault) now reads ${activePid}, not ${STALLED_PROPOSAL_ID} — re-check which pid is actually stuck before running the remedy below`;
  }

  return row('proposal', 'Stale governance proposal blocking the soak', 'red',
    `proposal ${STALLED_PROPOSAL_ID} is Active and past its reveal deadline (${new Date(p.revealDeadline * 1000).toISOString()})${corroboration}`,
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
 * Every row, run in parallel. One row throwing (a bug in this module, not an RPC failure — every
 * RPC failure is already caught above) must not take the rest down with it, so each is wrapped.
 * @param {typeof fetch} [fetchImpl]
 */
export async function runLaunchChecks(fetchImpl = fetch) {
  const settled = await Promise.allSettled([
    checkCreatorSafe(fetchImpl),
    checkStaleProposal(fetchImpl),
    checkDeployerBalance(fetchImpl),
    Promise.resolve(checkArcDeployment()),
    checkMemberSurface(fetchImpl),
  ]);
  const names = ['Creator Safe live on Arc mainnet', 'Stale governance proposal blocking the soak',
    'Deployer balance margin', 'Arc deployment', 'What app.rwally.com and rwally.com are serving'];
  return settled.map((s, i) =>
    s.status === 'fulfilled' ? s.value : row(String(i), names[i], 'unknown', `check threw: ${s.reason?.message ?? s.reason}`, null));
}
