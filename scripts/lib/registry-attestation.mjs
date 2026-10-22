// @ts-check
/**
 * Off-chain half of `RWAllyAgentRegistry.mintMirrored`: the EIP-712 typed data an attestor signs, and
 * the signer's refusal rules. This is NOT the signer service (the Cloudflare Worker is a separate
 * piece of work); it exists so the typed data is defined once, outside Solidity, and the contract's
 * typehash and domain are tested against an independent implementation (viem), not against the
 * contract's own assumption. Used by scripts/test/registry-attestation.test.mjs.
 *
 * The rules in `signerRefusal` are the SIGNER POLICY listed in the NatSpec of `mintMirrored`. The
 * contract cannot read other chains, so these are not enforced on-chain.
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

/**
 * The signer's refusal rules. Returns a reason string to refuse, or null to sign.
 * @param {{
 *   originChainId: number|bigint,
 *   ourRegistry: string,
 *   originOfRegistry: string,     // `originOf(id).registry` read on the origin chain at finality
 *   ownerCodeHashOrigin?: string, // keccak of the owner's code on the origin chain ('0x' + 64 hex), or null for no code
 *   ownerCodeHashDestination?: string | null,
 * }} p
 * @returns {string | null}
 */
export function signerRefusal(p) {
  if (BigInt(p.originChainId) === BigInt(POLYGON_CHAIN_ID)) {
    return 'Polygon (137) is a destination only: no finality-depth rule is documented, so it is never an origin';
  }
  if (p.originOfRegistry.toLowerCase() === p.ourRegistry.toLowerCase()) {
    return 'origin identity is itself a mirror (originOf.registry is our registry): a mirror of a mirror would mint a second identity from one fee';
  }
  const hadCode = p.ownerCodeHashOrigin != null;
  if (hadCode && p.ownerCodeHashOrigin !== p.ownerCodeHashDestination) {
    return 'owner has code on the origin chain and the destination code hash differs or is absent: one party may not control the address on both chains';
  }
  return null;
}
