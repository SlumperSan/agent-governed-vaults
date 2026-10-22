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
 * destination per UTC day (MIRROR_DAILY_CAP, 100) and accepts a 7-day expiry. The registry has a single
 * attestor, and this signer is its only issuer. What the limits do, at the defaults:
 * - Minting is bounded on chain only: at most 100 mirrors per destination per UTC day, first come. An
 *   attestation reserves nothing until it is minted, so the signer may issue more than the day has left;
 *   an honest `mintMirrored` that lands after the 100th reverts `MirrorCapReached` and can retry the
 *   next UTC day.
 * - The 1 hour expiry stops attestations being hoarded for days and spent in the first block of a day.
 * - An attestation counts against every UTC day its validity window (signing time to expiry, inclusive)
 *   touches: one issued at 23:30 with a 00:30 expiry counts on both days. The contract accepts a mint
 *   only at or before the expiry, and a mint cannot precede its signature, so every mint lands on a
 *   day its attestation was counted against.
 * - An origin mints at most once per destination (`AlreadyMirrored`), so filling a destination's day
 *   consumes 100 distinct origins on that destination.
 * - Origins younger than 7 days at signing share at most 50 attestations per destination per day, so at
 *   least 50 of a day's 100 mints come from origins 7 days old or more. Each holder gets at most 10 per
 *   destination per day, so at least 10 holder addresses; holders are free addresses, so that is
 *   friction only. Both hold only while every signing process reads one shared counter store.
 * - What a full-day halt of one destination costs, per destination per day: 100 origins never usable
 *   on that destination again, at least 50 of them aged 7 days, each costing whatever registering it
 *   cost on its home chain (the owner-set fee, at most 100 USDC and possibly zero: an origin imported
 *   from the outside registry during the import window pays no registry fee), minted before the
 *   honest traffic that day. The same origins can fill every other destination's day once as well.
 * - None of this prevents that halt. An attacker holding that stock of origins halts mirroring on a
 *   destination for the day, and every honest mint after the 100th that day reverts.
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
 * Throws unless `limits` is well formed: every field a positive safe integer, the young-origin budget
 * below the on-chain cap (young origins alone could otherwise take a destination's whole day), and the
 * age floor below the young threshold (otherwise no signed origin is young and the budget never
 * applies). Called by both `signerLimits` and `signerRefusal`, so a hand-built limits object cannot
 * skip the floor or the budget.
 * @param {unknown} limits
 * @returns {asserts limits is ReturnType<typeof signerLimits>}
 */
export function assertSignerLimits(limits) {
  const l = /** @type {Record<string, unknown>} */ (limits);
  for (const [key, [name]] of Object.entries(LIMIT_ENV)) {
    const v = l?.[key];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
      throw new Error(`${key} (${name}) must be a positive integer, got ${String(v)}`);
    }
  }
  if (/** @type {number} */ (l.youngOriginDailyBudget) >= MIRROR_DAILY_CAP) {
    throw new Error(`youngOriginDailyBudget (REGISTRY_ATTEST_YOUNG_ORIGIN_DAILY_BUDGET) must be below MIRROR_DAILY_CAP (${MIRROR_DAILY_CAP})`);
  }
  if (/** @type {number} */ (l.minOriginAgeSeconds) >= /** @type {number} */ (l.youngOriginAgeSeconds)) {
    throw new Error(
      'minOriginAgeSeconds (REGISTRY_ATTEST_MIN_ORIGIN_AGE_SECONDS) must be below youngOriginAgeSeconds (REGISTRY_ATTEST_YOUNG_ORIGIN_AGE_SECONDS): otherwise no signed origin is young and the young-origin budget never applies',
    );
  }
}

/**
 * The issuance limits with env overrides applied. A malformed override throws rather than falling back
 * to the default; the result is checked by `assertSignerLimits`.
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
  assertSignerLimits(out);
  return out;
}

const sameAddress = (/** @type {string} */ a, /** @type {string} */ b) => a.toLowerCase() === b.toLowerCase();
const isAddress = (/** @type {unknown} */ v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);

/** A caller-supplied count as a bigint, or null when it is missing or not a non-negative integer. */
function readCount(/** @type {unknown} */ v) {
  if (typeof v === 'bigint') return v >= 0n ? v : null;
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
}

/** A chain id or timestamp as a bigint, or null unless it is a positive safe integer, a positive bigint or a positive `0x` hex string. */
function readPositive(/** @type {unknown} */ v) {
  const n = typeof v === 'string' ? (/^0x[0-9a-fA-F]+$/.test(v) ? BigInt(v) : null) : readCount(v);
  return n != null && n > 0n ? n : null;
}

const isCodeHash = (/** @type {unknown} */ v) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);

/**
 * The UTC day numbers (`seconds / 86400`, the contract's `block.timestamp / 1 days`) that an attestation
 * signed at `nowSeconds` with `expiry` can be minted on: every day from signing to expiry, inclusive.
 * These are the keys `signerRefusal` reads in `issuance`, and the days a signer must record a signed
 * attestation against. Throws unless both are positive integers and `expiry` is not before `nowSeconds`.
 * @param {number|bigint|string} nowSeconds
 * @param {number|bigint|string} expiry
 * @returns {number[]}
 */
export function attestationDays(nowSeconds, expiry) {
  const now = readPositive(nowSeconds);
  const exp = readPositive(expiry);
  if (now == null || exp == null || exp < now) throw new Error('attestationDays: nowSeconds and expiry must be positive integers, expiry not before now');
  const days = [];
  for (let d = now / 86400n; d <= exp / 86400n; d++) days.push(Number(d));
  return days;
}

/**
 * The signer's refusal rules. Returns a reason string to refuse, or null to sign.
 *
 * `readback` is what the Worker read on the origin chain at the `finalized` block, through that
 * chain's own RPC, at signing time; pass null (or leave a field null) for anything it could not read,
 * and the attestation is refused. A malformed value refuses the same way: `chainId` must be a positive
 * safe integer, a positive bigint or a positive `0x` hex string; `ownerOf` and `originOfRegistry` must
 * be `0x` plus 40 hex digits (the zero address is valid for `originOfRegistry`: a native origin reads
 * zero); `registeredAtSeconds` must be a non-negative integer (number or bigint) that is neither 0 nor
 * after `nowSeconds`. Nothing is signed on a value the caller supplied but the origin chain did not
 * confirm (A13 finding A4). `destinationChainId`, `nowSeconds`, `attestation.originChainId` and
 * `attestation.expiry` must be positive integers in the same forms as `chainId`, or the request is
 * refused. `ourRegistry` must be `0x` plus 40 hex digits, or this function throws (a misconfigured
 * signer, not a bad request).
 *
 * `ownerCodeHashOrigin` is required: `null` means the owner has no code on the origin chain (an EOA),
 * `undefined` (absent) means the code could not be read, and anything else must be `0x` plus 64 hex
 * digits, or it refuses as unreadable. When it is a hash, `ownerCodeHashDestination` must be the same
 * hash (case-insensitive): `null` (no code on the destination) refuses as differing, and anything that
 * is not `0x` plus 64 hex digits refuses as unreadable.
 *
 * `issuance` is this signer's own records for the destination and this holder, keyed by UTC day number
 * (`attestationDays`): `issuance[day] = {issuedToHolder, issuedToYoungOrigins}`, counting every
 * attestation already signed whose validity window touches that day (one signed at 23:30 with a 00:30
 * expiry is counted on both days). Every day the new attestation touches must be present.
 * `issuedToYoungOrigins` counts only attestations whose origin was younger than `youngOriginAgeSeconds`
 * when signed. Every count must be a non-negative integer (number or bigint); a missing day, or a
 * missing, null, NaN or fractional count, refuses, so a counter store that cannot be read never signs.
 * After signing, the caller records the attestation against every day `attestationDays` returns. The
 * counts only bound anything if every signing process reads them from one shared store.
 *
 * `limits` is checked by `assertSignerLimits` and a malformed one throws.
 *
 * A throw is a refusal. Any field may be a getter and any value may be malformed; when evaluating one
 * throws (a getter doing an RPC read that times out, a chain id that is not a number), this function
 * throws instead of returning. The caller must treat any throw as a refusal and never sign.
 * @param {{
 *   destinationChainId: number|bigint|string,
 *   ourRegistry: string,
 *   nowSeconds: number|bigint|string,
 *   attestation: {originChainId: number|bigint|string, originRegistry: string, owner: string, expiry: number|bigint|string},
 *   readback: {
 *     chainId: number|bigint|string|null, // eth_chainId answered by the origin RPC
 *     ownerOf: string|null,            // ownerOf(originAgentId) on the origin registry
 *     originOfRegistry: string|null,   // originOf(originAgentId).registry on the origin registry
 *     registeredAtSeconds: number|bigint|null, // timestamp of the block that minted the origin identity
 *   } | null,
 *   ownerCodeHashOrigin: string | null | undefined, // keccak of the owner's code on the origin chain ('0x' + 64 hex); null = no code; undefined = unreadable
 *   ownerCodeHashDestination?: string | null,
 *   issuance: Record<string, {issuedToHolder: number|bigint, issuedToYoungOrigins: number|bigint}>,
 * }} p
 * @param {ReturnType<typeof signerLimits>} [limits]
 * @returns {string | null}
 */
export function signerRefusal(p, limits = signerLimits()) {
  assertSignerLimits(limits);
  if (!isAddress(p.ourRegistry)) throw new Error(`ourRegistry is not an address: ${String(p.ourRegistry)}`);
  const destinationChainId = readPositive(p.destinationChainId);
  if (destinationChainId == null) return 'destination chain id is not a positive integer';
  const now = readPositive(p.nowSeconds);
  if (now == null) return 'nowSeconds is not a positive integer';

  const a = p.attestation;
  const originChainId = readPositive(a.originChainId);
  if (originChainId == null) return 'attestation origin chain id is not a positive integer';
  if (originChainId === BigInt(POLYGON_CHAIN_ID)) {
    return 'Polygon (137) is a destination only: no finality-depth rule is documented, so it is never an origin';
  }
  if (originChainId === destinationChainId) {
    return 'destination equals the origin chain: a mirror is minted on a different chain from its origin';
  }

  const r = p.readback;
  const readChainId = r == null ? null : readPositive(r.chainId);
  if (readChainId == null) return 'origin chain id could not be read back from the origin chain';
  if (readChainId !== originChainId) {
    return 'the origin RPC answered a different chain id than the attestation names';
  }
  if (!sameAddress(a.originRegistry, p.ourRegistry)) {
    return 'origin registry is not our registry: the destination refuses it (OriginRegistryNotThis)';
  }
  const registeredAt = readCount(r.registeredAtSeconds);
  if (!isAddress(r.ownerOf) || !isAddress(r.originOfRegistry) || registeredAt == null || registeredAt === 0n || registeredAt > now) {
    return 'origin holder, registry or mint time could not be read back on the origin chain';
  }
  if (!sameAddress(r.ownerOf, a.owner)) {
    return 'holder read back on the origin chain is not the attested owner';
  }
  if (sameAddress(r.originOfRegistry, p.ourRegistry)) {
    return 'origin identity is itself a mirror (originOf.registry is our registry): a mirror of a mirror would mint a second identity from one fee';
  }
  const codeOrigin = p.ownerCodeHashOrigin;
  if (codeOrigin !== null && !isCodeHash(codeOrigin)) return "owner's code on the origin chain could not be read back";
  if (codeOrigin !== null) {
    const codeDestination = p.ownerCodeHashDestination;
    if (codeDestination !== null && !isCodeHash(codeDestination)) {
      return "owner's code on the destination chain could not be read back";
    }
    if (codeDestination === null || codeOrigin.toLowerCase() !== codeDestination.toLowerCase()) {
      return 'owner has code on the origin chain and the destination code hash differs or is absent: one party may not control the address on both chains';
    }
  }

  const expiry = readPositive(a.expiry);
  if (expiry == null) return 'attestation expiry is not a positive integer';
  if (expiry <= now) return 'expiry is not in the future';
  if (expiry > now + BigInt(limits.maxExpirySeconds)) {
    return `expiry is more than ${limits.maxExpirySeconds}s out: long-lived attestations can be hoarded and dumped at the start of a day`;
  }
  const originAge = now - registeredAt;
  if (originAge < BigInt(limits.minOriginAgeSeconds)) {
    return `origin identity is younger than ${limits.minOriginAgeSeconds}s (finality buffer)`;
  }

  // Every UTC day the validity window touches: a mint can land on any of them, so each must have room.
  const young = originAge < BigInt(limits.youngOriginAgeSeconds);
  for (const day of attestationDays(now, expiry)) {
    const s = p.issuance?.[day];
    const toHolder = readCount(s?.issuedToHolder);
    const toYoung = readCount(s?.issuedToYoungOrigins);
    if (toHolder == null || toYoung == null) {
      return `an issuance count for UTC day ${day} is missing or not a non-negative integer: a counter that cannot be read never signs`;
    }
    if (toHolder >= BigInt(limits.perHolderDaily)) {
      return `per-holder daily limit for this destination (${limits.perHolderDaily}) is spent on UTC day ${day}`;
    }
    if (young && toYoung >= BigInt(limits.youngOriginDailyBudget)) {
      return `young-origin daily budget for this destination (${limits.youngOriginDailyBudget}) is spent on UTC day ${day}: origins younger than ${limits.youngOriginAgeSeconds}s wait`;
    }
  }
  return null;
}
