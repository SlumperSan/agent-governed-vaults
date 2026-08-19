// @ts-check
/**
 * EIP-3009 `transferWithAuthorization` helpers for x402 payments.
 *
 * The protocol's metered API settles USDC via EIP-3009 (not permit/2612): the agent signs an
 * authorization that a facilitator executes on-chain. The agent's WALLET does the actual EIP-712
 * signature; this module only assembles the typed-data struct and the x402 envelope around it,
 * so any signer (viem, ethers, a raw eth_signTypedData_v4 hook, an MCP wallet tool) can plug in.
 *
 * @typedef {Object} Eip3009Authorization
 * @property {string} from        payer (agent wallet)
 * @property {string} to          recipient (payTo from the challenge)
 * @property {string} value       integer string, USDC base units
 * @property {string} validAfter  unix seconds
 * @property {string} validBefore unix seconds
 * @property {string} nonce       32-byte hex, single-use
 * @property {string} asset       USDC token address
 */

/**
 * Build the EIP-712 typed-data payload for `transferWithAuthorization`, ready to hand to a
 * wallet's `signTypedData`. Domain fields come from the USDC contract (name/version/chainId/
 * verifyingContract) — the agent supplies them for the target chain.
 *
 * @param {Object} p
 * @param {Eip3009Authorization} p.authorization
 * @param {{name:string, version:string, chainId:number, verifyingContract:string}} p.domain
 */
export function buildTypedData({ authorization, domain }) {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    domain,
    message: {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value,
      validAfter: authorization.validAfter,
      validBefore: authorization.validBefore,
      nonce: authorization.nonce,
    },
  };
}

/**
 * Assemble the x402 V2 PAYMENT-SIGNATURE envelope from a signed authorization.
 * @param {Object} p
 * @param {Eip3009Authorization} p.authorization
 * @param {string} p.signature  the EIP-712 signature (0x…65 bytes)
 * @param {string} p.network    e.g. "base"
 */
export function buildEnvelope({ authorization, signature, network }) {
  return {
    x402Version: 2,
    scheme: 'exact',
    network,
    signature,
    authorization,
  };
}

/**
 * Turn a challenge + the agent's wallet into an x402 envelope. `sign` receives EIP-712 typed
 * data and returns a signature. `walletAddress` is the payer; `domain` describes the USDC
 * contract on the challenge's network. Fills validAfter/validBefore around `nowSec`.
 *
 * @param {Object} p
 * @param {object} p.challenge     the PAYMENT-REQUIRED challenge
 * @param {string} p.walletAddress
 * @param {{name:string, version:string, chainId:number, verifyingContract:string}} p.domain
 * @param {(typedData:object) => Promise<string>} p.sign
 * @param {number} p.nowSec
 * @param {number} [p.ttlSec]
 * @returns {Promise<object>} the envelope for the PAYMENT-SIGNATURE header
 */
export async function authorizeFromChallenge({ challenge, walletAddress, domain, sign, nowSec, ttlSec = 300 }) {
  /** @type {Eip3009Authorization} */
  const authorization = {
    from: walletAddress,
    to: challenge.payTo,
    value: challenge.amount,
    validAfter: String(nowSec - 5),
    validBefore: String(nowSec + ttlSec),
    nonce: challenge.nonce,
    asset: challenge.asset,
  };
  const typedData = buildTypedData({ authorization, domain });
  const signature = await sign(typedData);
  return buildEnvelope({ authorization, signature, network: challenge.network });
}
