// @ts-check
/**
 * Perception — the metered API (via the agent SDK) plus direct chain reads, both under budget.
 *
 * Two sources, deliberately not interchangeable (and a third way to find the vault set, below):
 *
 *   the API   is an event projection: the vault set, member counts, attestation flags, and the
 *             operator leaderboard. It costs USDC per read, so every call goes through the budget.
 *   the chain is the only source of NAV, fee schedules, pending-deposit timers and governance
 *             deadlines — events do not carry them. Free, but only as available as the RPC.
 *
 * Where the vault set and the track record come from is chosen by `discoverySource(config)`:
 *
 *   'api'    the metered API's vault list and leaderboard (the default).
 *   'chain'  a chain preset is set and no API URL is: the vault list is the factory's array and
 *            each operator's record is the registry's `leaderboardEntry`, both read directly. No
 *            API is contacted and no x402 payment is signed. Rows come out in the shape the policy
 *            already consumes, so `decideJoin` and `decideExit` are unchanged. The chain's member
 *            count is `holderCount`, which differs from the API's event-derived count, and its
 *            record has no loss history beyond the registry's two accumulators.
 *
 * Degradation is a first-class outcome. An exhausted spend cap, an unreachable API, or a failing
 * RPC each produce a partial world with the gaps NAMED, and the policy layer decides what a
 * missing value means. The loop never crashes because a read failed, and it never silently treats
 * "unknown" as "fine" — `decideJoin`'s gates fail closed on every unreadable input.
 */

import { createProtocolClient } from '../../agent-sdk/src/index.mjs';
import { toBaseUnits } from './config.mjs';
import { verifyKnownPayloads } from './payloads.mjs';

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
 * Which source supplies the vault set and the track record. A preset is the proof that the
 * contract addresses are known; an API URL is the operator saying to use the API instead.
 * @param {any} config @returns {'api'|'chain'}
 */
export function discoverySource(config) {
  return config.chain?.preset && !config.api?.baseUrl ? 'chain' : 'api';
}

/**
 * Chain-only discovery: the vault list and the operator records, from the factory and the registry.
 * Never throws; every unreadable piece becomes a named gap.
 *
 * @param {Object} p
 * @param {any} p.chainReader @param {any} p.config @param {any} p.log @param {string[]} p.gaps
 * @returns {Promise<{vaults:any[], leaderboard:any[]}>}
 */
export async function discoverFromChain({ chainReader, config, log, gaps }) {
  const { factory, operatorRegistry } = config.chain;
  if (!factory || !operatorRegistry) {
    gaps.push('chain discovery needs chain.factory and chain.operatorRegistry (set chain.preset)');
    return { vaults: [], leaderboard: [] };
  }
  const { maxVaults, pageSize, include } = config.discovery;
  const listing = await chainReader.listFactoryVaults(factory, { maxVaults, pageSize });
  if (listing.total === null) {
    gaps.push('vault list unavailable (factory vaultCount unreadable)');
    return { vaults: [], leaderboard: [] };
  }
  if (listing.failedIndexes.length)
    gaps.push(`vault list incomplete: allVaults read failed at index ${listing.failedIndexes.join(', ')}`);
  if (listing.truncated)
    gaps.push(`vault list is a window: the newest ${maxVaults} of ${listing.total} factory vaults (discovery.maxVaults); list older ones to watch in discovery.include`);
  log.perceive(`factory: ${listing.total} vault(s), reading ${listing.addresses.length}${listing.truncated ? ` (newest ${maxVaults})` : ''}`);

  // Pinned vaults first, then the window, each address once.
  const addresses = [...new Set([...include.map((a) => a.toLowerCase()), ...listing.addresses])];
  const vaults = [];
  for (const vault of addresses) {
    const [identity, answered] = await Promise.all([
      chainReader.readVaultIdentity(vault),
      chainReader.readOperatorId(operatorRegistry, vault),
    ]);
    // The attestation is only worth something if it came from the registry this config trusts AND
    // the vault is wired to that same registry. A vault pointing elsewhere (an address pinned in
    // `include` can be anything) keeps whatever it claims to itself: it is unattested here.
    const sameRegistry = identity.operatorRegistry === operatorRegistry.toLowerCase();
    if (!sameRegistry) gaps.push(`${vault} reports operator registry ${identity.operatorRegistry ?? 'unreadable'}, not the configured one; treated as unattested`);
    // An unreadable answer is 0, not a guess: 0 is the unattested value the join gate refuses.
    const operatorId = sameRegistry ? answered ?? 0 : 0;
    if (sameRegistry && answered === null) gaps.push(`operator id unreadable for ${vault}`);
    vaults.push({
      vault,
      operatorId,
      memberCount: identity.holderCount,
      depth: null, // not measured here: the per-vault SubVaultRegistry.depthOf read supplies it, and null refuses
      parent: null,
      capacityCapUsdc: null, // filled from the per-vault read below
      attested: operatorId !== 0,
      creator: identity.creator,
    });
  }

  const opIds = [...new Set(vaults.map((v) => v.operatorId).filter((id) => id > 0))];
  const records = await Promise.all(opIds.map((id) => chainReader.readOperatorRecord(operatorRegistry, id)));
  const leaderboard = records.filter(Boolean);
  for (const id of opIds) if (!leaderboard.some((r) => r.operatorId === id)) gaps.push(`operator record unreadable for operatorId ${id}`);
  log.perceive(`registry: ${leaderboard.length} operator record(s) for ${vaults.length} vault(s)`);
  return { vaults, leaderboard };
}

/**
 * API discovery: the free price and health probes, then the two paid reads (vault list and
 * leaderboard). Never throws; every failure becomes a named gap.
 *
 * @param {Object} p
 * @param {any} p.client @param {ReturnType<import('./budget.mjs').createBudget>} p.budget
 * @param {any} p.config @param {any} p.log @param {string[]} p.gaps
 */
async function discoverFromApi({ client, budget, config, log, gaps }) {
  // ── free: discovery tells us the real price before we commit to paying it ──
  let discovery = null;
  try {
    discovery = await client.discovery();
    // An API on a chain without x402 answers `enabled: false` and a null price. Say so rather than
    // printing "$0 per metered read on undefined"; the reads below then simply succeed unpaid, and
    // the budget's signer backstop still catches any 402 that turns up anyway.
    log.perceive(
      discovery.enabled === false
        ? `discovery: x402 v${discovery.x402Version} is OFF on this chain — every route is free, no payment will be signed`
        : `discovery: x402 v${discovery.x402Version}, $${Number(discovery.price?.amount ?? 0) / 1e6} per metered read on ${discovery.price?.network}`,
    );
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

  return { discovery, health, price, vaults, leaderboard };
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
 * @param {number} p.nowSec          the local clock; `world.chainNowSec` is the chain's, for the crank
 * @returns {Promise<any>} the world state the decide phase consumes
 */
export async function perceive({ client, chainReader, budget, config, member, log, nowSec }) {
  /** @type {string[]} */
  const gaps = [];

  const source = discoverySource(config);
  let discovery = null;
  let health = null;
  let price = 0n;
  let vaults;
  let leaderboard;
  if (source === 'chain') {
    log.perceive(`discovery: chain-only (factory ${config.chain.factory}); no API is contacted and no x402 payment is signed`);
    ({ vaults, leaderboard } = await discoverFromChain({ chainReader, config, log, gaps }));
  } else {
    ({ discovery, health, price, vaults, leaderboard } = await discoverFromApi({ client, budget, config, log, gaps }));
  }
  const operatorById = new Map(leaderboard.map((r) => [Number(r.operatorId), r]));

  // ── per-vault detail: paid API view + free chain reads ────────────────────
  const observed = [];
  for (const v of vaults) {
    const address = String(v.vault).toLowerCase();

    // The chain source has no API detail view; its facts come from the reads below.
    const detail =
      source === 'chain'
        ? { ok: false, skipped: true, reason: 'chain-only discovery' }
        : await paidRead({ call: () => client.getVault(address), price, label: `getVault ${address.slice(0, 10)}`, budget, log });
    if (!detail.ok && source !== 'chain') gaps.push(`vault detail unavailable for ${address}`);

    const chain = await chainReader.readVault(address, member);
    // The chain source trusts the registry the config names, not whichever one the vault points at.
    const registryOperatorId = await chainReader.readOperatorId(source === 'chain' ? config.chain.operatorRegistry : chain.operatorRegistry, address);
    const fees = await chainReader.readStackedFees(config.chain.subvaultRegistry ?? null, address);
    // The row's own depth is only a fallback for the stacked read; with neither, the join gate
    // refuses, and the log must say why instead of showing a clean pass.
    if (fees.depth === null && (v.depth === null || v.depth === undefined))
      gaps.push(
        `depth unreadable for ${address} (${config.chain.subvaultRegistry ? 'SubVaultRegistry.depthOf read failed' : 'chain.subvaultRegistry not configured'}); the depth gate refuses`,
      );
    const governance = await chainReader.readGovernance(address, member);

    // Voting weight is measured at the proposal's snapshot, not now, and it is NOT the share
    // balance — see chain.readVotingWeight. Only worth a read when there is something to vote on.
    const votingWeight = governance?.proposal
      ? await chainReader.readVotingWeight(address, member, governance.proposal.createdAt)
      : null;

    const opId = registryOperatorId ?? Number(v.operatorId ?? 0);
    // A chain row cannot know the cap until the vault itself is read; the policy reads it from
    // `chain` regardless, so this only keeps the row's field honest.
    const summary =
      source === 'chain' ? { ...v, capacityCapUsdc: chain.capacityCapUsdc == null ? null : chain.capacityCapUsdc.toString() } : v;
    observed.push({
      summary,
      detail: detail.ok ? detail.data : null,
      chain,
      fees,
      governance,
      votingWeight,
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

  // Cranking: the three Governance gates compare block.timestamp, so read it, and check each
  // payload the operator handed over against its hash. Both are skipped when cranking is off.
  let chainNowSec = null;
  let crankPayloads = {};
  if (config.policy.crank.scope !== 'off') {
    chainNowSec = await chainReader.readBlockTimestamp();
    if (chainNowSec === null)
      gaps.push(`latest block timestamp unreadable; the crank falls back to the local clock less the ${config.policy.timing.activateGraceSec}s margin`);
    const checked = await verifyKnownPayloads(config.policy.crank.knownPayloads);
    crankPayloads = checked.verified;
    for (const r of checked.rejected) gaps.push(`crank payload ${r.actionHash} ignored: ${r.reason}`);
  }

  return {
    nowSec,
    chainNowSec,
    crankPayloads,
    member,
    source,
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
