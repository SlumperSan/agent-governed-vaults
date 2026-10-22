// @ts-check
/**
 * Off-chain half of `RWAllyAgentRegistry.mintMirrored`: the EIP-712 typed data an attestor signs, and
 * the signer's refusal rules. This is NOT the signer service (the Cloudflare Worker is a separate
 * piece of work); it exists so the typed data is defined once, outside Solidity, and the contract's
 * typehash and domain are tested against an independent implementation (viem), not against the
 * contract's own assumption. Used by scripts/test/registry-attestation.test.mjs.
 *
 * The rules in `signerRefusal` are the SIGNER POLICY listed in the NatSpec of `mintMirrored`, plus the
 * issuance limits and origin readback rules from the 2026-10-21 registry DoS audit (findings A1 and A4).
 * The contract cannot read other chains, so none of these is enforced on-chain.
 */

/** Polygon PoS: a destination for mirrors, never an origin, until a documented finality rule exists. */
export const POLYGON_CHAIN_ID = 137;

/** Must equal the EIP-712 domain name and version in RWAllyAgentRegistry.sol (NAME_HASH, VERSION_HASH). */
export const DOMAIN_NAME = 'ERC8004IdentityRegistry';
export const DOMAIN_VERSION = '1';

/** Field order is the struct order in the contract; it fixes the typehash. */
export const MIRROR_ATTESTATION_TYPES = {
  MirrorAttestation: [
    { name: 'originChainId', type: 'uint256' },
    { name: 'originRegistry', type: 'address' },
    { name: 'originAgentId', type: 'uint256' },
    { name: 'owner', type: 'address' },
    { name: 'agentURIHash', type: 'bytes32' },
    { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
};

/** The canonical EIP-712 type string, e.g. "MirrorAttestation(uint256 originChainId,...)". */
export function mirrorAttestationTypeString() {
  const fields = MIRROR_ATTESTATION_TYPES.MirrorAttestation.map((f) => `${f.type} ${f.name}`);
  return `MirrorAttestation(${fields.join(',')})`;
}

/**
 * Typed data for `signTypedData` / `hashTypedData`. `destinationChainId` is the chain the mirror will
 * be minted on and `registry` its address there: the same attestation has a different digest on every
 * chain and registry.
 * @param {{destinationChainId: number|bigint, registry: `0x${string}`, message: Record<string, any>}} p
 */
export function mirrorAttestationTypedData({ destinationChainId, registry, message }) {
  return {
    domain: {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      chainId: BigInt(destinationChainId),
      verifyingContract: registry,
    },
    types: MIRROR_ATTESTATION_TYPES,
    primaryType: /** @type {const} */ ('MirrorAttestation'),
    message,
  };
}

/** Must equal `MIRROR_DAILY_CAP` in RWAllyAgentRegistry.sol: mirrors accepted per destination per UTC day. */
export const MIRROR_DAILY_CAP = 100;

/**
 * Issuance limits (A13 finding A1, mirror cap griefing). The on-chain cap is one first-come counter per
 * destination per UTC day and accepts a 7-day expiry. What these limits do, with the registry's single
 * attestor and this signer as its only issuer:
 * - MIRROR_DAILY_CAP on chain still bounds what can mint on a destination in a day; nothing here
 *   changes that bound.
 * - The 1 hour expiry stops attestations being hoarded for days and spent in the first block of a day.
 * - Origins younger than YOUNG_ORIGIN_AGE_SECONDS share a sub-budget below the cap, so taking a
 *   destination's whole day needs origins older than that. This raises the cost of a full-day halt of
 *   mirroring on a destination.
 * - They do not prevent that halt. An attacker with enough aged origins can still take every slot left
 *   in a day, and every honest request that day is then refused. The per-holder limit is friction
 *   only: holders are free addresses.
 * Each default can be overridden by the env var named beside it.
 */
/** Refuse an `expiry` further out than this (NatSpec rule 5: about one hour). REGISTRY_ATTEST_MAX_EXPIRY_SECONDS */
export const MAX_EXPIRY_SECONDS = 3600;
/** Attestations per holder per destination per UTC day. REGISTRY_ATTEST_PER_HOLDER_DAILY */
export const PER_HOLDER_DAILY_LIMIT = 10;
/** Hard floor on origin age at signing: a finality buffer, not a sybil defense. REGISTRY_ATTEST_MIN_ORIGIN_AGE_SECONDS */
export const MIN_ORIGIN_AGE_SECONDS = 3600;
/** An origin younger than this at signing counts against the young-origin budget. REGISTRY_ATTEST_YOUNG_ORIGIN_AGE_SECONDS */
export const YOUNG_ORIGIN_AGE_SECONDS = 7 * 86400;
/** Attestations per destination per UTC day shared by all young origins; below MIRROR_DAILY_CAP. REGISTRY_ATTEST_YOUNG_ORIGIN_DAILY_BUDGET */
export const YOUNG_ORIGIN_DAILY_BUDGET = 50;

const LIMIT_ENV = {
  maxExpirySeconds: ['REGISTRY_ATTEST_MAX_EXPIRY_SECONDS', MAX_EXPIRY_SECONDS],
  perHolderDaily: ['REGISTRY_ATTEST_PER_HOLDER_DAILY', PER_HOLDER_DAILY_LIMIT],
  minOriginAgeSeconds: ['REGISTRY_ATTEST_MIN_ORIGIN_AGE_SECONDS', MIN_ORIGIN_AGE_SECONDS],
  youngOriginAgeSeconds: ['REGISTRY_ATTEST_YOUNG_ORIGIN_AGE_SECONDS', YOUNG_ORIGIN_AGE_SECONDS],
  youngOriginDailyBudget: ['REGISTRY_ATTEST_YOUNG_ORIGIN_DAILY_BUDGET', YOUNG_ORIGIN_DAILY_BUDGET],
};

/**
 * The issuance limits with env overrides applied. A malformed override throws rather than falling back
 * to the default, and a young-origin budget at or above the on-chain cap throws: young origins alone
 * could then take a destination's whole day.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{maxExpirySeconds: number, perHolderDaily: number, minOriginAgeSeconds: number, youngOriginAgeSeconds: number, youngOriginDailyBudget: number}}
 */
export function signerLimits(env = process.env) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const [key, [name, fallback]] of Object.entries(LIMIT_ENV)) {
    const raw = env[name];
    if (raw === undefined || raw === '') {
      out[key] = /** @type {number} */ (fallback);
      continue;
    }
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) throw new Error(`${name} must be a positive integer, got ${raw}`);
    out[key] = Number(raw);
  }
  if (out.youngOriginDailyBudget >= MIRROR_DAILY_CAP) {
    throw new Error(`REGISTRY_ATTEST_YOUNG_ORIGIN_DAILY_BUDGET must be below MIRROR_DAILY_CAP (${MIRROR_DAILY_CAP})`);
  }
  return /** @type {any} */ (out);
}

const sameAddress = (/** @type {string} */ a, /** @type {string} */ b) => a.toLowerCase() === b.toLowerCase();

/** A caller-supplied count as a bigint, or null when it is missing or not a non-negative integer. */
function readCount(/** @type {unknown} */ v) {
  if (typeof v === 'bigint') return v >= 0n ? v : null;
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
}

/**
 * The signer's refusal rules. Returns a reason string to refuse, or null to sign.
 *
 * `readback` is what the Worker read on the origin chain at the `finalized` block, through that
 * chain's own RPC, at signing time; pass null (or leave a field null) for anything it could not read,
 * and the attestation is refused. Nothing is signed on a value the caller supplied but the origin chain
 * did not confirm (A13 finding A4).
 *
 * `ownerCodeHashOrigin` is required: `null` means the owner has no code on the origin chain (an EOA),
 * and `undefined` (absent) means the code could not be read, which refuses.
 *
 * `issuance` counts are this signer's own records for the destination in the current UTC day, plus
 * `mirrorsRemainingToday()` read on the destination registry. `issuedTodayToYoungOrigins` counts only
 * attestations whose origin was younger than `youngOriginAgeSeconds` when signed. Every count must be
 * a non-negative integer (number or bigint); a missing, null, NaN or fractional count refuses, so a
 * counter store that cannot be read never signs. The counts only bound anything if every signing
 * process reads them from one shared store.
 *
 * A throw is a refusal. Any field may be a getter and any value may be malformed; when evaluating one
 * throws (a getter doing an RPC read that times out, a chain id that is not a number), this function
 * throws instead of returning. The caller must treat any throw as a refusal and never sign.
 * @param {{
 *   destinationChainId: number|bigint,
 *   ourRegistry: string,
 *   nowSeconds: number|bigint,
 *   attestation: {originChainId: number|bigint, originRegistry: string, owner: string, expiry: number|bigint},
 *   readback: {
 *     chainId: number|bigint|null,     // eth_chainId answered by the origin RPC
 *     ownerOf: string|null,            // ownerOf(originAgentId) on the origin registry
 *     originOfRegistry: string|null,   // originOf(originAgentId).registry on the origin registry
 *     registeredAtSeconds: number|bigint|null, // timestamp of the block that minted the origin identity
 *   } | null,
 *   ownerCodeHashOrigin: string | null | undefined, // keccak of the owner's code on the origin chain ('0x' + 64 hex); null = no code; undefined = unreadable
 *   ownerCodeHashDestination?: string | null,
 *   issuance: {issuedTodayToHolder: number|bigint, issuedTodayToYoungOrigins: number|bigint, outstanding: number|bigint, mirrorsRemainingToday: number|bigint},
 * }} p
 * @param {ReturnType<typeof signerLimits>} [limits]
 * @returns {string | null}
 */
export function signerRefusal(p, limits = signerLimits()) {
  const a = p.attestation;
  const originChainId = BigInt(a.originChainId);
  if (originChainId === BigInt(POLYGON_CHAIN_ID)) {
    return 'Polygon (137) is a destination only: no finality-depth rule is documented, so it is never an origin';
  }
  if (originChainId === BigInt(p.destinationChainId)) {
    return 'destination equals the origin chain: a mirror is minted on a different chain from its origin';
  }

  const r = p.readback;
  if (r == null || r.chainId == null) return 'origin chain id could not be read back from the origin chain';
  if (BigInt(r.chainId) !== originChainId) {
    return 'the origin RPC answered a different chain id than the attestation names';
  }
  if (!sameAddress(a.originRegistry, p.ourRegistry)) {
    return 'origin registry is not our registry: the destination refuses it (OriginRegistryNotThis)';
  }
  if (r.ownerOf == null || r.originOfRegistry == null || r.registeredAtSeconds == null) {
    return 'origin registry or holder could not be read back on the origin chain';
  }
  if (!sameAddress(r.ownerOf, a.owner)) {
    return 'holder read back on the origin chain is not the attested owner';
  }
  if (sameAddress(r.originOfRegistry, p.ourRegistry)) {
    return 'origin identity is itself a mirror (originOf.registry is our registry): a mirror of a mirror would mint a second identity from one fee';
  }
  if (p.ownerCodeHashOrigin === undefined) return "owner's code on the origin chain could not be read back";
  if (p.ownerCodeHashOrigin !== null && p.ownerCodeHashOrigin !== p.ownerCodeHashDestination) {
    return 'owner has code on the origin chain and the destination code hash differs or is absent: one party may not control the address on both chains';
  }

  const now = BigInt(p.nowSeconds);
  const expiry = BigInt(a.expiry);
  if (expiry <= now) return 'expiry is not in the future';
  if (expiry > now + BigInt(limits.maxExpirySeconds)) {
    return `expiry is more than ${limits.maxExpirySeconds}s out: long-lived attestations can be hoarded and dumped at the start of a day`;
  }
  const originAge = now - BigInt(r.registeredAtSeconds);
  if (originAge < BigInt(limits.minOriginAgeSeconds)) {
    return `origin identity is younger than ${limits.minOriginAgeSeconds}s (finality buffer)`;
  }

  const s = p.issuance;
  const toHolder = readCount(s?.issuedTodayToHolder);
  const toYoung = readCount(s?.issuedTodayToYoungOrigins);
  const outstanding = readCount(s?.outstanding);
  const remaining = readCount(s?.mirrorsRemainingToday);
  if (toHolder == null || toYoung == null || outstanding == null || remaining == null) {
    return 'an issuance count is missing or not a non-negative integer: a counter that cannot be read never signs';
  }
  if (toHolder >= BigInt(limits.perHolderDaily)) {
    return `per-holder daily limit for this destination (${limits.perHolderDaily}) is spent`;
  }
  if (originAge < BigInt(limits.youngOriginAgeSeconds) && toYoung >= BigInt(limits.youngOriginDailyBudget)) {
    return `young-origin daily budget for this destination (${limits.youngOriginDailyBudget}) is spent: origins younger than ${limits.youngOriginAgeSeconds}s wait`;
  }
  if (outstanding >= remaining) {
    return 'unexpired unminted attestations already cover the destination capacity left today';
  }
  return null;
}
