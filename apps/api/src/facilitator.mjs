// @ts-check
/**
 * x402 facilitators for the metered API — the component behind x402.mjs's injected
 * `verifyAndSettle(challenge, envelope)` seam.
 *
 * Three implementations, one interface:
 *   - createStubFacilitator     accept/deny with no chain — tests and local dev.
 *   - createHttpFacilitator     delegate verify+settle to a REMOTE facilitator over HTTP. This is
 *                               the API server's production default: the server stays non-custodial
 *                               (holds no key, moves no funds) and a separate facilitator settles.
 *   - createSettlingFacilitator run-your-own settler: recover the EIP-712 payer, then settle via
 *                               USDC.transferWithAuthorization with an OPERATOR-SUPPLIED account.
 *                               It needs viem + a funded key the operator injects at runtime; this
 *                               module never embeds, reads, or logs a key.
 *
 * Design contract (per x402.mjs): verifyAndSettle's first arg is `{ price }`, NOT the full
 * challenge — it carries no chainId. So chainId and the USDC name/version/address come from
 * CONSTRUCTION config, never from the call argument. The non-crypto pieces (shape + typed-data
 * reconstruction) are pure and unit-tested; viem is a lazy optional dependency loaded only by the
 * crypto path, so this file imports cleanly with no node_modules.
 */

const SIG_RE = /^0x[0-9a-fA-F]{130}$/; // 65 bytes: r(32) s(32) v(1)
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Rebuild the EIP-712 typed data for a `transferWithAuthorization` authorization. MUST match the
 * SDK's builder (packages/agent-sdk/src/eip3009.mjs buildTypedData) field-for-field, or a valid
 * client signature will fail to recover. The domain's verifyingContract is the USDC address —
 * taken from config, falling back to the envelope's declared asset only for the pure helper.
 *
 * @param {object} envelope  decoded PAYMENT-SIGNATURE envelope ({ authorization, ... })
 * @param {{chainId:number, usdcName?:string, usdcVersion?:string, usdcAddress?:string}} cfg
 */
export function reconstructTypedData(envelope, cfg) {
  const auth = envelope.authorization ?? {};
  const verifyingContract = cfg.usdcAddress ?? auth.asset;
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
    domain: {
      name: cfg.usdcName ?? 'USD Coin',
      version: cfg.usdcVersion ?? '2',
      chainId: cfg.chainId,
      verifyingContract,
    },
    message: {
      from: auth.from,
      to: auth.to,
      value: auth.value,
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: auth.nonce,
    },
  };
}

/**
 * Non-crypto structural validation of an envelope before we spend a settlement. Confirms the
 * authorization is well-formed and the signature is a 65-byte hex string. Cryptographic recovery
 * and the on-chain nonce check happen in the settling/remote path.
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function verifyEnvelopeShape(envelope, nowMs) {
  if (!envelope || typeof envelope !== 'object') return { ok: false, reason: 'no-envelope' };
  if (envelope.x402Version !== 2) return { ok: false, reason: 'bad-version' };
  const a = envelope.authorization;
  if (!a || typeof a !== 'object') return { ok: false, reason: 'no-authorization' };
  for (const f of ['from', 'to']) {
    if (!ADDR_RE.test(a[f] ?? '')) return { ok: false, reason: `bad-${f}` };
  }
  if (typeof envelope.signature !== 'string' || !SIG_RE.test(envelope.signature))
    return { ok: false, reason: 'bad-signature-format' };
  let value;
  try { value = BigInt(a.value ?? ''); } catch { return { ok: false, reason: 'bad-value' }; }
  if (value <= 0n) return { ok: false, reason: 'nonpositive-value' };
  if (!/^0x[0-9a-fA-F]{64}$/.test(a.nonce ?? '')) return { ok: false, reason: 'bad-nonce' };
  const validBefore = Number(a.validBefore ?? 0) * 1000;
  if (validBefore && validBefore < nowMs) return { ok: false, reason: 'authorization-expired' };
  return { ok: true };
}

/**
 * Recover the EIP-712 signer of an authorization and confirm it equals `authorization.from`.
 * Uses viem (lazy). Returns { ok, payer } — payer lowercased.
 * @param {object} envelope
 * @param {{chainId:number, usdcName?:string, usdcVersion?:string, usdcAddress?:string}} cfg
 */
export async function recoverPayer(envelope, cfg) {
  const { recoverTypedDataAddress } = await import('viem').catch(() => {
    throw new Error('facilitator: viem is not installed — run `npm install viem`');
  });
  const td = reconstructTypedData(envelope, cfg);
  const recovered = await recoverTypedDataAddress({
    domain: td.domain,
    types: { TransferWithAuthorization: td.types.TransferWithAuthorization },
    primaryType: 'TransferWithAuthorization',
    message: td.message,
    signature: envelope.signature,
  });
  const from = (envelope.authorization?.from ?? '').toLowerCase();
  const payer = recovered.toLowerCase();
  return payer === from ? { ok: true, payer } : { ok: false, reason: 'signer-mismatch', payer };
}

/** Accept/deny facilitator for tests and local dev — no chain, no crypto. */
export function createStubFacilitator({ accept = true, receiptPrefix = 'stub' } = {}) {
  let n = 0;
  return {
    async verifyAndSettle(_challenge, envelope) {
      if (!accept) return { ok: false, reason: 'stub-deny' };
      const nonce = envelope?.authorization?.nonce ?? '';
      return { ok: true, receiptId: `${receiptPrefix}_${++n}_${nonce.slice(0, 10)}` };
    },
  };
}

/**
 * Production default: delegate verify+settle to a REMOTE facilitator over HTTP. The API server
 * holds no key; this posts the challenge+envelope and returns the remote verdict. Non-custodial.
 * @param {{url:string, fetchImpl?:typeof fetch, timeoutMs?:number}} cfg
 */
export function createHttpFacilitator({ url, fetchImpl = fetch, timeoutMs = 10_000 }) {
  return {
    async verifyAndSettle(challenge, envelope) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ x402Version: 2, challenge, envelope }),
          signal: ctrl.signal,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, reason: body.reason ?? `facilitator-http-${res.status}` };
        return { ok: !!body.ok, receiptId: body.receiptId, reason: body.reason };
      } catch (err) {
        return { ok: false, reason: `facilitator-unreachable: ${err?.message ?? err}` };
      } finally {
        clearTimeout(t);
      }
    },
  };
}

// Minimal USDC ABI: the (v,r,s) transferWithAuthorization overload (FiatTokenV2, universally
// supported) plus authorizationState for a pre-flight replay check.
const USDC_ABI = [
  {
    type: 'function', name: 'transferWithAuthorization', stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function', name: 'authorizationState', stateMutability: 'view',
    inputs: [{ name: 'authorizer', type: 'address' }, { name: 'nonce', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
];

/**
 * Run-your-own settling facilitator: recover the payer, then settle the EIP-3009 authorization by
 * calling USDC.transferWithAuthorization. The `account` (a viem account with signing capability)
 * is supplied by the OPERATOR at runtime — this code never creates or persists a key. Not wired
 * into the API server by default; see docs/RUNTIME.md for running it as a separate process.
 *
 * @param {Object} cfg
 * @param {any} cfg.publicClient    viem PublicClient (reads / simulate)
 * @param {any} cfg.walletClient    viem WalletClient (sends the settlement tx)
 * @param {string} cfg.usdcAddress
 * @param {number} cfg.chainId
 * @param {string} [cfg.usdcName]   USDC EIP-712 domain name (default 'USD Coin')
 * @param {string} [cfg.usdcVersion]
 * @param {() => number} [cfg.now]
 */
export function createSettlingFacilitator({ publicClient, walletClient, usdcAddress, chainId, usdcName, usdcVersion, now = () => Date.now() }) {
  if (!ADDR_RE.test(usdcAddress ?? '')) throw new Error('settling facilitator: usdcAddress required');
  const domainCfg = { chainId, usdcName, usdcVersion, usdcAddress };

  return {
    async verifyAndSettle(_challenge, envelope) {
      const shape = verifyEnvelopeShape(envelope, now());
      if (!shape.ok) return { ok: false, reason: shape.reason };

      const rec = await recoverPayer(envelope, domainCfg).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
      if (!rec.ok) return { ok: false, reason: rec.reason };

      const a = envelope.authorization;
      const sig = envelope.signature;
      const r = `0x${sig.slice(2, 66)}`;
      const s = `0x${sig.slice(66, 130)}`;
      let v = parseInt(sig.slice(130, 132), 16);
      if (v < 27) v += 27; // normalize recovery id

      try {
        // Pre-flight: reject an already-used authorization nonce before spending gas.
        const used = await publicClient.readContract({
          address: usdcAddress, abi: USDC_ABI, functionName: 'authorizationState', args: [a.from, a.nonce],
        });
        if (used) return { ok: false, reason: 'authorization-used' };

        const { request } = await publicClient.simulateContract({
          address: usdcAddress, abi: USDC_ABI, functionName: 'transferWithAuthorization',
          args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, v, r, s],
          account: walletClient.account,
        });
        const hash = await walletClient.writeContract(request);
        return { ok: true, receiptId: hash };
      } catch (err) {
        return { ok: false, reason: `settle-failed: ${err?.shortMessage ?? err?.message ?? err}` };
      }
    },
  };
}
