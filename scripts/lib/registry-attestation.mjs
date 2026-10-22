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
 * destination per UTC day and accepts a 7-day expiry, so without these an attacker holding 100 real
 * origins can hoard attestations and fill every destination's cap in the first block of a day. Each
 * default can be overridden by the env var named beside it.
 */
/** Refuse an `expiry` further out than this (NatSpec rule 5: about one hour). REGISTRY_ATTEST_MAX_EXPIRY_SECONDS */
export const MAX_EXPIRY_SECONDS = 3600;
/** Attestations per destination per UTC day; below MIRROR_DAILY_CAP so honest mirrors keep headroom. REGISTRY_ATTEST_DAILY_BUDGET */
export const DAILY_ISSUANCE_BUDGET = 80;
/** Attestations per holder per destination per UTC day. REGISTRY_ATTEST_PER_HOLDER_DAILY */
export const PER_HOLDER_DAILY_LIMIT = 10;
/** Minimum age of the origin identity at signing, raising the cost of fresh sybil origins. REGISTRY_ATTEST_MIN_ORIGIN_AGE_SECONDS */
export const MIN_ORIGIN_AGE_SECONDS = 86400;

const LIMIT_ENV = {
  maxExpirySeconds: ['REGISTRY_ATTEST_MAX_EXPIRY_SECONDS', MAX_EXPIRY_SECONDS],
  dailyBudget: ['REGISTRY_ATTEST_DAILY_BUDGET', DAILY_ISSUANCE_BUDGET],
  perHolderDaily: ['REGISTRY_ATTEST_PER_HOLDER_DAILY', PER_HOLDER_DAILY_LIMIT],
  minOriginAgeSeconds: ['REGISTRY_ATTEST_MIN_ORIGIN_AGE_SECONDS', MIN_ORIGIN_AGE_SECONDS],
};

/**
 * The issuance limits with env overrides applied. A malformed override throws rather than falling back
 * to the default, and a daily budget at or above the on-chain cap throws: it would reserve no headroom.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{maxExpirySeconds: number, dailyBudget: number, perHolderDaily: number, minOriginAgeSeconds: number}}
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
  if (out.dailyBudget >= MIRROR_DAILY_CAP) {
    throw new Error(`REGISTRY_ATTEST_DAILY_BUDGET must be below MIRROR_DAILY_CAP (${MIRROR_DAILY_CAP})`);
  }
  return /** @type {any} */ (out);
}

const sameAddress = (/** @type {string} */ a, /** @type {string} */ b) => a.toLowerCase() === b.toLowerCase();

/**
 * The signer's refusal rules. Returns a reason string to refuse, or null to sign.
 *
 * `readback` is what the Worker read on the origin chain at the `finalized` block, through that
 * chain's own RPC, at signing time; pass null (or leave a field null) for anything it could not read,
 * and the attestation is refused. Nothing is signed on a value the caller supplied but the origin chain
 * did not confirm (A13 finding A4).
 *
 * `issuance` counts are this signer's own records for the destination in the current UTC day, plus
 * `mirrorsRemainingToday()` read on the destination registry.
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
 *   ownerCodeHashOrigin?: string | null, // keccak of the owner's code on the origin chain ('0x' + 64 hex), or null for no code
 *   ownerCodeHashDestination?: string | null,
 *   issuance: {issuedToday: number, issuedTodayToHolder: number, outstanding: number, mirrorsRemainingToday: number|bigint},
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
  const hadCode = p.ownerCodeHashOrigin != null;
  if (hadCode && p.ownerCodeHashOrigin !== p.ownerCodeHashDestination) {
    return 'owner has code on the origin chain and the destination code hash differs or is absent: one party may not control the address on both chains';
  }

  const now = BigInt(p.nowSeconds);
  const expiry = BigInt(a.expiry);
  if (expiry <= now) return 'expiry is not in the future';
  if (expiry > now + BigInt(limits.maxExpirySeconds)) {
    return `expiry is more than ${limits.maxExpirySeconds}s out: long-lived attestations can be hoarded and dumped at the start of a day`;
  }
  if (now - BigInt(r.registeredAtSeconds) < BigInt(limits.minOriginAgeSeconds)) {
    return `origin identity is younger than ${limits.minOriginAgeSeconds}s`;
  }

  const s = p.issuance;
  if (s.issuedToday >= limits.dailyBudget) {
    return `daily issuance budget for this destination (${limits.dailyBudget}) is spent`;
  }
  if (s.issuedTodayToHolder >= limits.perHolderDaily) {
    return `per-holder daily limit for this destination (${limits.perHolderDaily}) is spent`;
  }
  if (BigInt(s.outstanding) >= BigInt(s.mirrorsRemainingToday)) {
    return 'unexpired unminted attestations already cover the destination capacity left today';
  }
  return null;
}
