// @ts-check
/**
 * Perception — the metered API (via the agent SDK) plus direct chain reads, both under budget.
 *
 * Two sources, deliberately not interchangeable:
 *
 *   the API   is an event projection: the vault set, member counts, attestation flags, and the
 *             operator leaderboard. It costs USDC per read, so every call goes through the budget.
 *   the chain is the only source of NAV, fee schedules, pending-deposit timers and governance
 *             deadlines — events do not carry them. Free, but only as available as the RPC.
 *
 * Degradation is a first-class outcome. An exhausted spend cap, an unreachable API, or a failing
 * RPC each produce a partial world with the gaps NAMED, and the policy layer decides what a
 * missing value means. The loop never crashes because a read failed, and it never silently treats
 * "unknown" as "fine" — `decideJoin`'s gates fail closed on every unreadable input.
 */

import { createProtocolClient } from '../../agent-sdk/src/index.mjs';
import { toBaseUnits } from './config.mjs';

/**
 * Build the SDK client with the budget wired into its signer.
 *
 * The SDK runs 402 → sign → retry inside a single `request()` call, so a check after the fact is
 * too late — the authorization is already signed, and under EIP-3009 a signature IS the spend.
 * The guarded signer throws before producing one.
 *
 * @param {Object} p
 * @param {any} p.config
 * @param {{address:string, signTypedData?:Function, sign?:Function}|null} p.payer  x402 payment signer
 * @param {ReturnType<import('./budget.mjs').createBudget>} p.budget
 * @param {typeof fetch} [p.fetchImpl]
 */
export function createApiClient({ config, payer, budget, fetchImpl = fetch }) {
  const domain = {
    name: config.chain.usdcName,
    version: config.chain.usdcVersion,
    chainId: Number(config.chain.chainId),
    verifyingContract: config.chain.usdc,
  };

  // Without a payer the agent can still reach the free routes (/health, /.well-known/x402); every
  // metered route will 402 and surface as a named gap rather than a crash.
  const rawSign = payer
    ? (typedData) =>
        typeof payer.signTypedData === 'function' ? payer.signTypedData(typedData) : payer.sign(typedData)
    : async () => {
        throw new Error('no x402 payer configured — metered reads are unavailable');
      };

  return createProtocolClient({
    baseUrl: config.api.baseUrl,
    wallet: { address: payer?.address ?? '0x' + '0'.repeat(40), sign: budget.guardSigner(rawSign) },
    domain,
    fetchImpl,
  });
}

/**
 * One paid read, gated on the budget BEFORE the request so an exhausted cap skips cleanly.
 *
 * @param {Object} p
 * @param {() => Promise<any>} p.call
 * @param {bigint} p.price     expected cost in base units
 * @param {string} p.label
 * @param {ReturnType<import('./budget.mjs').createBudget>} p.budget
 * @param {any} p.log
 * @returns {Promise<{ok:true, data:any}|{ok:false, skipped:boolean, reason:string}>}
 */
export async function paidRead({ call, price, label, budget, log }) {
  const verdict = budget.canAfford(price);
  if (!verdict.ok) {
    log.warn(`skipped paid read "${label}" — ${verdict.reason}`);
    return { ok: false, skipped: true, reason: verdict.reason };
  }
  try {
    const { data } = await call();
    return { ok: true, data };
  } catch (err) {
    const reason = String(err?.message ?? err);
    log.warn(`paid read "${label}" failed — ${reason}`);
    return { ok: false, skipped: false, reason };
  }
}

/**
 * Full perception pass.
 *
 * @param {Object} p
 * @param {any} p.client            SDK client
 * @param {any} p.chainReader       createChainReader / createStubChainReader
 * @param {ReturnType<import('./budget.mjs').createBudget>} p.budget
 * @param {any} p.config
 * @param {string|null} p.member    the agent's on-chain address (null in a keyless dry run)
 * @param {any} p.log
 * @param {number} p.nowSec
 * @returns {Promise<any>} the world state the decide phase consumes
 */
export async function perceive({ client, chainReader, budget, config, member, log, nowSec }) {
  /** @type {string[]} */
  const gaps = [];

  // ── free: discovery tells us the real price before we commit to paying it ──
  let discovery = null;
  try {
    discovery = await client.discovery();
    log.perceive(`discovery: x402 v${discovery.x402Version}, $${Number(discovery.price?.amount ?? 0) / 1e6} per metered read on ${discovery.price?.network}`);
  } catch (err) {
    gaps.push('discovery unreachable');
    log.warn(`discovery failed — ${String(err?.message ?? err)}`);
  }

  let health = null;
  try {
    health = await client.health();
    log.perceive(`health: ok=${health.ok}, last indexed block ${health.lastBlock}`);
  } catch (err) {
    gaps.push('health unreachable');
    log.warn(`health failed — ${String(err?.message ?? err)}`);
  }

  // Trust the advertised price over the configured one — paying more than expected is exactly
  // what the per-read cap exists to catch, and the budget re-checks it at signature time anyway.
  const price = discovery?.price?.amount ? BigInt(discovery.price.amount) : toBaseUnits(config.api.payments.maxSingleReadUsdc);

  // ── paid: the vault set ────────────────────────────────────────────────────
  const vaultsRes = await paidRead({ call: () => client.listVaults(), price, label: 'listVaults', budget, log });
  const vaults = vaultsRes.ok ? vaultsRes.data.vaults ?? [] : [];
  if (!vaultsRes.ok) gaps.push(`vault list unavailable (${vaultsRes.reason})`);
  else log.perceive(`listVaults: ${vaults.length} vault(s) known to the indexer`);

  // ── paid: the operator leaderboard, loss history included ─────────────────
  const lbRes = await paidRead({ call: () => client.leaderboard(), price, label: 'leaderboard', budget, log });
  const leaderboard = lbRes.ok ? lbRes.data.leaderboard ?? [] : [];
  if (!lbRes.ok) gaps.push(`leaderboard unavailable (${lbRes.reason})`);
  else log.perceive(`leaderboard: ${leaderboard.length} operator(s) with realized history`);
  const operatorById = new Map(leaderboard.map((r) => [Number(r.operatorId), r]));

  // ── per-vault detail: paid API view + free chain reads ────────────────────
  const observed = [];
  for (const v of vaults) {
    const address = String(v.vault).toLowerCase();

    const detail = await paidRead({ call: () => client.getVault(address), price, label: `getVault ${address.slice(0, 10)}`, budget, log });
    if (!detail.ok) gaps.push(`vault detail unavailable for ${address}`);

    const chain = await chainReader.readVault(address, member);
    const registryOperatorId = await chainReader.readOperatorId(chain.operatorRegistry, address);
    const fees = await chainReader.readStackedFees(config.chain.subvaultRegistry ?? null, address);
    const governance = await chainReader.readGovernance(address, member);

    const opId = registryOperatorId ?? Number(v.operatorId ?? 0);
    observed.push({
      summary: v,
      detail: detail.ok ? detail.data : null,
      chain,
      fees,
      governance,
      registryOperatorId,
      operatorRow: operatorById.get(opId) ?? null,
    });

    const held = chain.self?.shares != null && BigInt(chain.self.shares) > 0n;
    const pending = chain.self?.pendingAmount != null && BigInt(chain.self.pendingAmount) > 0n;
    log.perceive(
      `vault ${address.slice(0, 10)}… op=${opId}${opId === 0 ? ' (UNATTESTED)' : ''} ` +
        `nav/share=${chain.navReadable ? String(chain.navPerShareWad) : 'UNREADABLE'} ` +
        `members=${v.memberCount ?? '?'} ` +
        `position=${held ? `${chain.self.shares} shares` : pending ? 'pending (in observation window)' : 'none'}` +
        (governance?.hasPendingExecution ? ' [PENDING REBALANCE — exits are Mode F]' : '') +
        (chain.stub ? '  [stub-chain]' : ''),
    );
  }

  const heldVaults = observed.filter((o) => o.chain?.self?.shares != null && BigInt(o.chain.self.shares) > 0n);

  return {
    nowSec,
    member,
    discovery,
    health,
    priceBaseUnits: price,
    vaults: observed,
    leaderboard,
    heldVaultCount: heldVaults.length,
    gaps,
    budget: budget.summary(),
  };
}
