import { useEffect, useState } from 'react';
import { createPublicClient, http, type PublicClient } from 'viem';
import { assertChainBinding } from '@chain/binding';
import {
  AGGREGATOR_V3_VIEWS,
  CHAINLINK_ORACLE_VIEWS,
  GOVERNANCE_VIEWS,
  OPERATOR_REGISTRY_VIEWS,
  TOKEN_SAFETY_VIEWS,
  VAULT_FACTORY_VIEWS,
  VAULT_VIEWS,
} from '@chain/abis';
import {
  assembleLeg,
  assembleLegSafety,
  assembleManifestCheck,
  assembleProposal,
  assembleVault,
  describeError,
  failed,
  loading,
  planBasketAssets,
  planCore,
  planFactoryAllVaults,
  planFactoryVaultCount,
  planFeeds,
  planLegSafety,
  planLegs,
  planProposal,
  planProposalId,
  ready,
  type AssembledVault,
  type Fetched,
  type ManifestState,
  type PlannedCall,
  type Vault,
} from './atlas';

/**
 * The viem glue between `apps/web/src/chain-reader.mjs` (which only says WHICH calls to make and
 * what the answers MEAN — see that file's own header for why it holds no viem and no network) and
 * a real RPC. `chain-reader.mjs` calls this "the twenty lines of viem" its header says belong to
 * the caller; this workspace is that caller.
 *
 * NOT IN `apps/web/src`. That directory is zero-dependency by its own rule (importable under
 * `node --test` with no fixture server), so viem, `packages/canary/src/abis.mjs` and
 * `packages/chain-config/src/chain-binding.mjs` are aliased in here instead — see `vite.config.ts`.
 *
 * WHAT THIS DOES NOT COVER. `planPosition`/`planVoteCommit` (a connected wallet's own shares,
 * pending deposit, queued exit, and vote-custody reads) are deliberately not wired here.
 * `feat/wallet-connect-and-sign` is the branch adding a connected wallet to this app at all; wiring
 * per-member reads before there is a wallet to read them for would be inventing a member address.
 * `App.tsx` renders an honest "connect a wallet" notice in that slot instead of the fixture WALLET.
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The fragment tables `chain-reader.mjs`'s `PlannedCall.abi` can name. Extend, don't fork. */
const ABI_TABLES: Record<string, unknown> = Object.freeze({
  VAULT_VIEWS,
  GOVERNANCE_VIEWS,
  CHAINLINK_ORACLE_VIEWS,
  AGGREGATOR_V3_VIEWS,
  OPERATOR_REGISTRY_VIEWS,
  TOKEN_SAFETY_VIEWS,
  VAULT_FACTORY_VIEWS,
});

function toContractCall(c: PlannedCall) {
  const abi = ABI_TABLES[c.abi];
  if (!abi) throw new Error(`live-vaults: planned call names an unknown ABI table "${c.abi}"`);
  return { address: c.address, abi, functionName: c.fn, args: c.args };
}

/**
 * Viem decodes a multi-output Solidity function — a struct-valued mapping getter's auto-generated
 * ABI lists each field as its OWN output rather than a single tuple, which is what `configOf`,
 * `proposals`, `feedOf` and `latestRoundData` all are — as a plain POSITIONAL array, confirmed
 * against the real contracts on Base Sepolia: none of `configOf`'s, `proposals`'s or `feedOf`'s
 * results carry a `.fieldName` property despite every output in `packages/canary/src/abis.mjs`
 * being named. `chain-reader.mjs`'s `assembleProposal`/`assembleLeg`/`assembleVault` all
 * destructure these by NAME (`p.ptype`, `feed.heartbeat`, `governanceConfig['quorumBps']`, …)
 * because its own tests always hand it named objects — so this is the missing half of "the
 * twenty lines of viem" that module's header calls the caller's problem: zip each positional
 * result back into the name its own ABI fragment declares. A single-output function (everything
 * in `VAULT_VIEWS`) is unaffected — viem returns those unwrapped, never as a one-element array.
 */
function namedStruct(table: string, fn: string, value: unknown): Record<string, unknown> {
  const abi = ABI_TABLES[table] as readonly { name: string; outputs?: readonly { name?: string }[] }[];
  const fragment = abi?.find((f) => f.name === fn);
  const outputs = fragment?.outputs;
  if (!outputs || !Array.isArray(value)) {
    throw new Error(`live-vaults: cannot decode ${table}.${fn} — no fragment outputs, or the result was not an array`);
  }
  const obj: Record<string, unknown> = {};
  outputs.forEach((o, i) => {
    if (o.name) obj[o.name] = (value as readonly unknown[])[i];
  });
  return obj;
}

/** A viem-shaped multicall result, without importing viem's type just for this. */
interface CallResult {
  readonly status: 'success' | 'failure';
  readonly result?: unknown;
  readonly error?: unknown;
}

/** Batches one round through `client.multicall`. Empty input returns `[]` without a network call. */
async function multicallPlan(
  client: Pick<PublicClient, 'multicall'>,
  calls: readonly PlannedCall[],
): Promise<readonly CallResult[]> {
  if (calls.length === 0) return [];
  return (await client.multicall({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contracts: calls.map(toContractCall) as any,
    allowFailure: true,
  })) as readonly CallResult[];
}

function callErrorText(c: CallResult): string {
  const e = c.error as { shortMessage?: string; message?: string } | undefined;
  return e?.shortMessage ?? e?.message ?? String(c.error ?? 'unknown error');
}

/**
 * A read this pipeline treats as STRUCTURAL — immutable state or a plain storage read that a
 * well-formed, correctly-addressed vault must answer. A failure here is transport/config trouble,
 * not a fact about the vault, so it throws rather than folding into the assembled result; the
 * caller (`fetchLiveVaults`) turns that into the page's `error` state instead of a half-built
 * `Vault` with an invented number in place of the field that failed.
 */
function requireOk(c: CallResult, label: string, address: string): unknown {
  if (c.status !== 'success') {
    throw new Error(`live-vaults: ${label} failed for ${address}: ${callErrorText(c)}`);
  }
  return c.result;
}

interface RawLeg {
  readonly address: string;
  readonly assetUnit: bigint;
  readonly balance: bigint;
  readonly priceOk: boolean;
  readonly priceWad: bigint;
  readonly feed: string;
  readonly heartbeat: number | bigint;
}

/**
 * Round 3a — `planLegs` reads four values per asset: `assetUnit`, `assetBalance`, `priceWad`,
 * `feedOf`. Only `priceWad` is allowed to fail: `chain-reader.mjs`'s own header names it "the read
 * allowed to revert meaningfully" at the VAULT level (`navWad`), and on a single-asset basket the
 * same stale/out-of-band/down-sequencer condition that reverts `navWad` reverts this leg's
 * `priceWad` too — so a failure here is expected, not a transport error, on a frozen vault's leg.
 */
async function readLegs(
  client: Pick<PublicClient, 'multicall'>,
  vault: string,
  oracle: string,
  assets: readonly string[],
): Promise<readonly RawLeg[]> {
  if (assets.length === 0) return [];
  const results = await multicallPlan(client, planLegs(vault, oracle, assets));
  return assets.map((address, i) => {
    const base = i * 4;
    const assetUnit = requireOk(results[base] as CallResult, `assetUnit(${address})`, vault) as bigint;
    const balance = requireOk(results[base + 1] as CallResult, `assetBalance(${address})`, vault) as bigint;
    const priceCall = results[base + 2] as CallResult;
    const priceOk = priceCall.status === 'success';
    const feedRaw = requireOk(results[base + 3] as CallResult, `feedOf(${address})`, vault);
    const feed = namedStruct('CHAINLINK_ORACLE_VIEWS', 'feedOf', feedRaw) as {
      feed: string;
      heartbeat: number | bigint;
    };
    return {
      address,
      assetUnit,
      balance,
      priceOk,
      priceWad: priceOk ? (priceCall.result as bigint) : 0n,
      feed: feed.feed,
      heartbeat: feed.heartbeat,
    };
  });
}

/**
 * Round 4 — `latestRoundData` per feed, for `oracleUpdatedAt`. A failed feed read defaults the age
 * to "as of the epoch" rather than "just now": `Holdings.tsx` compares `nowSec - oracleUpdatedAt`
 * against `maxStalenessSec` to badge a leg stale, and the safe direction for an UNREADABLE age is
 * to read as maximally stale, never as fresh.
 */
async function readFeedAges(
  client: Pick<PublicClient, 'multicall'>,
  legs: readonly RawLeg[],
): Promise<readonly number[]> {
  if (legs.length === 0) return [];
  const results = await multicallPlan(client, planFeeds(legs.map((l) => l.feed)));
  return results.map((r) => {
    if (r.status !== 'success') return 0;
    const decoded = namedStruct('AGGREGATOR_V3_VIEWS', 'latestRoundData', r.result) as { updatedAt: bigint };
    return Number(decoded.updatedAt);
  });
}

/** Round 3c (card #32) — a failed `paused`/`isBlacklisted` read is a legitimate `'unknown'`, not a transport error. */
async function readLegSafety(client: Pick<PublicClient, 'multicall'>, vault: string, assets: readonly string[]) {
  if (assets.length === 0) return [];
  const results = await multicallPlan(client, planLegSafety(vault, assets));
  const readAt = Math.floor(Date.now() / 1000);
  return assets.map((address, i) => {
    const pausedR = results[i * 2] as CallResult;
    const blR = results[i * 2 + 1] as CallResult;
    return assembleLegSafety({
      address,
      pausedValue: pausedR.status === 'success' ? pausedR.result : null,
      pausedReadAt: readAt,
      blacklistedValue: blR.status === 'success' ? blR.result : null,
      blacklistedReadAt: readAt,
    });
  });
}

/**
 * Frontend security pass A2 (card 211) — calldata vs deployment manifest. `factoryAddress` is
 * `null` when `VITE_FACTORY_ADDRESS` is not configured; that is treated the SAME as any other
 * unread manifest — `'unknown'`, never `'verified'` — because an unconfigured factory is not
 * evidence a vault is on the manifest, and `App.tsx` refuses to offer Sign on anything but
 * `'verified'`. Never throws: a manifest-check failure must not take down the rest of the page,
 * only refuse the Sign surface.
 */
async function readManifestCheck(
  client: Pick<PublicClient, 'multicall'>,
  factoryAddress: string | null,
  vaultAddress: string,
): Promise<ManifestState> {
  if (!factoryAddress) return 'unknown';
  const [countR] = await multicallPlan(client, planFactoryVaultCount(factoryAddress));
  if (!countR || countR.status !== 'success' || typeof countR.result !== 'bigint') return 'unknown';
  const count = Number(countR.result);
  if (!Number.isInteger(count) || count < 0 || count > 10_000) return 'unknown';
  const entryResults = await multicallPlan(client, planFactoryAllVaults(factoryAddress, count));
  const entryValues = entryResults.map((r) => (r.status === 'success' ? r.result : undefined));
  return assembleManifestCheck(vaultAddress, countR.result, entryValues);
}

/** One vault, all four rounds. Throws on any structural read failure — the caller maps that to `Fetched.error`. */
async function readOneVault(
  client: PublicClient,
  address: string,
  name: string,
  factoryAddress: string | null,
): Promise<AssembledVault & { manifestVerified: ManifestState }> {
  const coreResults = await multicallPlan(client, planCore(address));
  // planCore's order: navWad, totalShares, idleUsdc, usdcScalar, totalPendingUsdc, basketLength,
  // childVaultCount, oracle, governance, creator, operatorRegistry, holderCount,
  // nonCreatorMemberCount — 13 calls, indices 0-12 (card 210 appended the last two).
  // Cast to a fixed-length tuple (rather than `CallResult[]`) so the destructure below is not
  // subject to `noUncheckedIndexedAccess` widening every element to `| undefined` — the length is
  // pinned by `planCore`'s own literal call list, asserted by `apps/web/test/chain-reader.test.mjs`.
  const [
    navWadCall, totalSharesR, idleUsdcR, usdcScalarR, totalPendingUsdcR,
    basketLengthR, childVaultCountR, oracleR, governanceR, creatorR, operatorRegistryR,
    holderCountR, nonCreatorMemberCountR,
  ] = coreResults as unknown as readonly [
    CallResult, CallResult, CallResult, CallResult, CallResult,
    CallResult, CallResult, CallResult, CallResult, CallResult, CallResult,
    CallResult, CallResult,
  ];
  const core = {
    navWad: navWadCall.status === 'success' ? (navWadCall.result as bigint) : null,
    totalShares: requireOk(totalSharesR, 'totalShares', address) as bigint,
    idleUsdc: requireOk(idleUsdcR, 'idleUsdc', address) as bigint,
    usdcScalar: requireOk(usdcScalarR, 'usdcScalar', address) as bigint,
    totalPendingUsdc: requireOk(totalPendingUsdcR, 'totalPendingUsdc', address) as bigint,
    childVaultCount: requireOk(childVaultCountR, 'childVaultCount', address) as bigint,
    oracle: requireOk(oracleR, 'oracle', address) as string,
    governance: requireOk(governanceR, 'governance', address) as string,
    creator: requireOk(creatorR, 'creator', address) as string,
  };
  const operatorRegistry = requireOk(operatorRegistryR, 'operatorRegistry', address) as string;
  const basketLength = Number(requireOk(basketLengthR, 'basketLength', address) as bigint);
  // Card 210: two plain storage reads, never expected to revert for a well-formed vault — same
  // treatment as `totalShares`/`idleUsdc` above, via `requireOk`, not a graceful-degrade default.
  // A silently-defaulted `0` here would read as "confirmed zero", the exact false claim
  // `organicMemberBound`'s `null`-on-unread convention exists to prevent (chain-reader.mjs).
  const holderCount = Number(requireOk(holderCountR, 'holderCount', address) as bigint);
  const nonCreatorMemberCount = Number(requireOk(nonCreatorMemberCountR, 'nonCreatorMemberCount', address) as bigint);

  const [assetResults, proposalIdResults, operatorIdResults] = await Promise.all([
    multicallPlan(client, planBasketAssets(address, basketLength)),
    multicallPlan(client, planProposalId(core.governance, address)),
    // Attestation (`operatorId !== 0`, `live-adapter.mjs`'s own convention). Not one of
    // `chain-reader.mjs`'s `plan*` functions — OperatorRegistry is outside that module's contract
    // — so this is the one call this file plans directly rather than through it. Left unread, a
    // real vault's own `attested` would default to `false` (`assembleVault`'s own default), which
    // is the SAME false claim as an unregistered operator: `vault-state.mjs` renders it as a
    // critical "self-declared and unverifiable" badge. Reading it is cheaper than being wrong.
    multicallPlan(client, [
      { address: operatorRegistry, abi: 'OPERATOR_REGISTRY_VIEWS', fn: 'operatorIdOf', args: [core.creator] },
    ]),
  ]);
  const assets = assetResults.map((r, i) => requireOk(r as CallResult, `basketAssets(${i})`, address) as string);
  const activeProposalId = requireOk(proposalIdResults[0] as CallResult, 'activeProposalOf', address) as bigint;
  const governanceConfig = namedStruct(
    'GOVERNANCE_VIEWS',
    'configOf',
    requireOk(proposalIdResults[1] as CallResult, 'configOf', address),
  );
  const operatorId = requireOk(operatorIdResults[0] as CallResult, 'operatorIdOf', address) as bigint;
  const attested = operatorId !== 0n;

  const [rawLegs, legSafety, proposalResults, manifestVerified] = await Promise.all([
    readLegs(client, address, core.oracle, assets),
    readLegSafety(client, address, assets),
    activeProposalId === 0n ? Promise.resolve(null) : multicallPlan(client, planProposal(core.governance, activeProposalId)),
    readManifestCheck(client, factoryAddress, address),
  ]);

  const oracleAges = await readFeedAges(client, rawLegs);
  const legs = rawLegs.map((r, i) =>
    assembleLeg({
      address: r.address,
      assetUnit: r.assetUnit,
      balance: r.balance,
      priceWad: r.priceWad,
      feed: { feed: r.feed, heartbeat: r.heartbeat },
      oracleUpdatedAt: oracleAges[i] ?? 0,
    }),
  );
  // Overwrite for DISPLAY only, after `assembleLeg` has already used a stand-in 0n so its internal
  // `legValueWad` (balance * priceWad / assetUnit) does not throw on `null * bigint`. The stand-in
  // never reaches a render: `priceOk === false` forces both fields back to `null` here, the same
  // "trust the flag, not the number" pattern `assembleVault` already applies to a reverted `navWad`.
  const legsForDisplay = legs.map((l, i) =>
    rawLegs[i]?.priceOk === false ? { ...l, priceWad: null, valueWad: null } : l,
  );

  let proposal: ReturnType<typeof assembleProposal> = null;
  if (proposalResults) {
    const record = namedStruct(
      'GOVERNANCE_VIEWS',
      'proposals',
      requireOk(proposalResults[0] as CallResult, 'proposals', address),
    );
    const delegatedForWeightR = proposalResults[1] as CallResult;
    proposal = assembleProposal(
      activeProposalId,
      record,
      delegatedForWeightR.status === 'success' ? (delegatedForWeightR.result as bigint) : null,
    );
  }

  return {
    // Card 211 (A2): the manifest state is NOT part of `assembleVault`'s own contract — see
    // `readManifestCheck`'s header for why it is merged on here instead, the same way
    // `fetchLiveVaults` already merges `blockNumber` on below.
    ...assembleVault({
      address,
      core,
      legs: legsForDisplay,
      legSafety,
      proposal,
      governanceConfig,
      attested,
      // `name` HAS NO ON-CHAIN SOURCE: `VAULT_VIEWS` has no `name()` — see card #67, "Nothing holds
      // what the one v1 vault is called". `fetchLiveVaults` passes it in from `VITE_VAULT_NAME`
      // (`readLiveConfig`, below), the one home in the repo this string has, rather than each
      // caller inventing or hardcoding it. Empty when unset, exactly `assembleVault`'s own default,
      // so an unconfigured build still falls back to `shortAddress` (`atlas.ts`'s `Vault.name`
      // comment) instead of printing an empty heading.
      name,
      // `operatorName` stays `''`: the only operator-identifying read this pipeline makes is
      // `VaultCore.creator`, the immutable payout address (see
      // `contracts/config/deployments/base-sepolia.json`'s `operatorPayoutNote`), not a registered
      // display name. `operatorAddress: core.creator` is the one address this data can honestly
      // attribute the vault to.
      operatorAddress: core.creator,
      // Card 210 (seeded-disclosure) — see the two `requireOk` reads above this function's `return`.
      holderCount,
      nonCreatorMemberCount,
    }),
    manifestVerified,
  };
}

export interface LiveConfig {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly vaultAddresses: readonly string[];
  /**
   * The one v1 vault's display name — card #67, `Decisions/Vault name is cirBTC Vault 2026-09-19`.
   * `''` when unset, which is `assembleVault`'s own "no name" value, so an unconfigured build still
   * falls back to `shortAddress` rather than printing an empty heading. Applied to EVERY configured
   * address: correct today because the v1 cut line pins exactly one
   * (`Decisions/v1-cut-line-2026-09-18`), and a config naming more than one vault with one shared
   * name is a decision for whoever lifts that cut line, not a case this file should silently guess.
   */
  readonly vaultName: string;
  /** `VITE_FACTORY_ADDRESS` — the deployment manifest's `VaultFactory` (card 211, A2). `null` when
   * unset or malformed; see `readManifestCheck` for what that does to the Sign gate. */
  readonly factoryAddress: string | null;
}

/**
 * Reads `VITE_RPC_URL` / `VITE_CHAIN_ID` / `VITE_VAULT_ADDRESSES`, all three build-time (Vite
 * inlines `import.meta.env.*` at build, never reads them at runtime from the served page).
 * `VITE_VAULT_NAME` is a fourth, OPTIONAL variable — unlike the first three, its absence does not
 * fail the config: a nameless vault renders `shortAddress`, which is honest, not broken.
 *
 * `null` on anything unusable — NOT a default that points somewhere. Even though a real vault is
 * now deployed (Arc mainnet, chain 5042, since 2026-09-24 — firstVault.createdAt,
 * contracts/config/deployments/arc-mainnet.json), an env this repository did not
 * configure is not evidence of one, so a production build with no env configured must render "not
 * configured", never fall back to a guess. See `App.tsx` for how that state renders, and
 * `apps/vaults-ui/.env.example` for the configuration this app builds against by default.
 */
export function readLiveConfig(): LiveConfig | null {
  const env = import.meta.env as Record<string, string | undefined>;
  const rpcUrl = env.VITE_RPC_URL;
  const chainIdRaw = env.VITE_CHAIN_ID;
  const vaultsRaw = env.VITE_VAULT_ADDRESSES;
  if (!rpcUrl || !chainIdRaw || !vaultsRaw) return null;
  const chainId = Number(chainIdRaw);
  if (!Number.isInteger(chainId) || chainId <= 0) return null;
  const vaultAddresses = vaultsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((a) => ADDRESS_RE.test(a));
  if (vaultAddresses.length === 0) return null;
  const vaultName = (env.VITE_VAULT_NAME ?? '').trim();
  // A2 (card 211): OPTIONAL, unlike the four required fields above. Its absence does not fail the
  // whole config the way a missing RPC/chain/vault does — it fails the ONE thing that depends on
  // it, the manifest check, closed: `readManifestCheck` treats `null` the same as any other unread
  // manifest (`'unknown'`), and `App.tsx` refuses Sign on anything but `'verified'`.
  const factoryAddressRaw = env.VITE_FACTORY_ADDRESS;
  const factoryAddress = factoryAddressRaw && ADDRESS_RE.test(factoryAddressRaw) ? factoryAddressRaw : null;
  return Object.freeze({ rpcUrl, chainId, vaultAddresses, vaultName, factoryAddress });
}

/**
 * The canonical Multicall3 deployment address — the same bytecode at the same address on nearly
 * every EVM chain via the deterministic factory (see https://github.com/mds1/multicall). REQUIRED
 * on a hand-built `chain` object: viem's `multicall` action resolves the target contract from
 * `chain.contracts.multicall3.address`, and unlike its own built-in chain definitions
 * (`viem/chains`), a chain object built here from a runtime-configured `chainId` carries no
 * `contracts` at all unless this sets one. Omitting it makes the FIRST `multicall` call throw
 * `ChainDoesNotSupportContract` — every configured vault read fails, permanently, which is the
 * whole pipeline this file exists to run.
 *
 * VERIFIED REACHABLE, NOT ASSUMED PRESENT — the earlier version of this fix was written (and this
 * PR's own body claimed it) without this line actually existing in the file, so the RPC was never
 * called to check. Confirmed 2026-09-19 with the real `fetchLiveVaults`/`buildBoundClient` in this
 * file, bundled via `vite build --ssr` (so every `@chain/*`/`@atlas/*` alias resolves exactly as
 * it does in production) and run against `https://sepolia.base.org` (chain 84532): a
 * `client.multicall` call against the real smoke vault
 * (`0xb940d71b0d695e2ba2b5853bf565c69daa3e3c98`, `contracts/config/deployments/base-sepolia.json`)
 * returned `{ status: 'success', result: 5000000000000000000n }` for `navWad()` — a real
 * `aggregate3` round trip through this exact address, not a stubbed client. `fetchLiveVaults`
 * itself then completed end to end for that vault, including the leg-safety round below.
 */
const MULTICALL3_ADDRESS = '0xca11bde05977b3631167028862be2a173976ca11';

/**
 * Builds a viem public client for `cfg` and refuses to read through it until `assertChainBinding`
 * (packages/chain-config — issue #204) confirms the RPC actually answers for `cfg.chainId`. A
 * client that silently reads the wrong chain is worse than no client: every address this module
 * goes on to read means something different there.
 */
export async function buildBoundClient(cfg: LiveConfig): Promise<PublicClient> {
  const client = createPublicClient({
    chain: {
      id: cfg.chainId,
      name: `chain-${cfg.chainId}`,
      // PLACEHOLDER, NOT A CLAIM ABOUT THE CONFIGURED CHAIN'S ACTUAL NATIVE CURRENCY. viem's
      // `Chain` type requires this field; this client only ever calls `readContract`/`multicall`,
      // neither of which consults it (no gas estimation, no native-balance display happens here).
      // On Arc the real native asset is USDC (18-decimal native view — see chains.ts's
      // ARC_MAINNET, which the connected WALLET client uses and which IS accurate), not ETH; this
      // generic read-only client is built from a bare `chainId`/`rpcUrl` pair with no per-chain
      // currency table, so it cannot know which is correct and must not be read as if it did.
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpcUrl] } },
      contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
    },
    transport: http(cfg.rpcUrl),
  });
  await assertChainBinding({
    client,
    declaredChainId: cfg.chainId,
    rpc: cfg.rpcUrl,
    declaredBy: 'VITE_CHAIN_ID',
  });
  return client;
}

/** Every configured vault, read fresh. Exported for the unit test; components use `useLiveVaults`. */
export async function fetchLiveVaults(cfg: LiveConfig, client?: PublicClient): Promise<readonly Vault[]> {
  const c = client ?? (await buildBoundClient(cfg));
  const blockNumber = await c.getBlockNumber();
  const vaults = await Promise.all(
    cfg.vaultAddresses.map((address) => readOneVault(c, address, cfg.vaultName, cfg.factoryAddress)),
  );
  return vaults.map((v) => ({ ...v, blockNumber }));
}

/**
 * The one hook every vault-reading view in this app uses. Runs once per mount (and again if the
 * configured vault set changes), never renders a partial `Vault` while a read is in flight — the
 * `Fetched` union (`apps/web/src/freshness.mjs`) is what stands in for "no data yet" instead of a
 * default that would print as a real, and wrong, number.
 */
export function useLiveVaults(): Fetched<readonly Vault[]> {
  const [state, setState] = useState<Fetched<readonly Vault[]>>(() => loading());

  useEffect(() => {
    let cancelled = false;
    const cfg = readLiveConfig();
    if (!cfg) {
      setState(
        failed(
          'Live chain reads are not configured for this build.',
          'VITE_RPC_URL / VITE_CHAIN_ID / VITE_VAULT_ADDRESSES were not set at build time — this ' +
            'build has no vault configured. RWAlly’s v1 vault (cirBTC Vault) is live on Arc ' +
            'mainnet; this screen shows no vault because THIS BUILD was not pointed at it, never a ' +
            'bundled sample standing in for a real read.',
          false,
        ),
      );
      return;
    }
    setState(loading());
    fetchLiveVaults(cfg)
      .then((vaults) => {
        if (cancelled) return;
        setState(ready(vaults, { chainId: cfg.chainId, rpcUrl: cfg.rpcUrl }));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
