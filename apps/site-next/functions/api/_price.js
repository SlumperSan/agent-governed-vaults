/**
 * Price and facilitator resolution for the metered read route, at the edge.
 *
 * WHY THIS FILE HOLDS NO KEY UNDER `FACILITATOR=http`, AND CANNOT HOLD ONE.
 * `apps/api` has three facilitator modes: `FACILITATOR=stub` and `FACILITATOR=http` hold no key,
 * and `FACILITATOR=svm` DOES hold one — the one mode that does, because Solana's flow makes this
 * process the fee payer and there is nothing to delegate. This route is
 * EVM-only and hard-wires `http` — `createHttpFacilitator` POSTs an envelope to a facilitator URL
 * and reads back a receipt, using nothing but `fetch`. No key is read here, none can be configured
 * here, and a deploy of this Worker moves no funds. That is a property of the code, not a promise:
 * grep this directory for `KEYPAIR`, `PRIVATE_KEY` or `signer` and the result is empty.
 *
 * WHY THE NUMBERS COME FROM ENV AND NOT FROM THIS FILE.
 * `PRICE_PAYTO` decides who is paid. Committing an address here would put a payee in git history
 * where a reviewer reads it as documentation rather than as configuration, and rotating it would be
 * a code change. Every value below is refused rather than defaulted when it is missing, because the
 * failure mode of a default is the one that matters: a default payTo would silently send a caller's
 * USDC to whatever address the default named.
 *
 * THE ONE DEFAULT THAT IS SAFE is the asset, and it is still not applied — see `requireAddr`.
 */

/** Circle-native USDC on Base mainnet, for cross-checking PRICE_ASSET. NOT USDbC. */
export const BASE_MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const ADDR = /^0x[0-9a-fA-F]{40}$/;

class ConfigError extends Error {}

function requireEnv(env, key) {
  const v = env?.[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ConfigError(`${key} is not set on this deployment`);
  }
  return v.trim();
}

function requireAddr(env, key) {
  const v = requireEnv(env, key);
  if (!ADDR.test(v)) throw new ConfigError(`${key} is not an address: ${v}`);
  return v;
}

/**
 * Resolve the price this route charges.
 *
 * `amount` is a STRING of base units, which is what `buildChallenge` copies into the challenge and
 * what `checkEnvelopeAgainstPrice` compares against. USDC is 6dp, so $0.10 is "100000". It is read
 * as a string and validated as digits rather than parsed as a Number: at 6dp a Number is exact for
 * any plausible price, but the value is a token amount and token amounts are not floats anywhere
 * else in this repository.
 */
export function resolvePrice(env) {
  const amount = requireEnv(env, 'PRICE_AMOUNT');
  if (!/^[1-9][0-9]*$/.test(amount)) {
    throw new ConfigError(`PRICE_AMOUNT must be a positive integer of base units, got: ${amount}`);
  }
  return {
    asset: requireAddr(env, 'PRICE_ASSET'),
    payTo: requireAddr(env, 'PRICE_PAYTO'),
    amount,
    network: requireEnv(env, 'PRICE_NETWORK'),
  };
}

export function resolveFacilitatorUrl(env) {
  const url = requireEnv(env, 'FACILITATOR_URL');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(`FACILITATOR_URL is not a URL: ${url}`);
  }
  // A facilitator receives a signed payment authorization. Over plain http that envelope is
  // readable and replayable by anything on the path, so the scheme is checked rather than assumed.
  if (parsed.protocol !== 'https:') {
    throw new ConfigError(`FACILITATOR_URL must be https, got: ${parsed.protocol}`);
  }
  return parsed.toString();
}

/**
 * A 500 that says which setting is missing, for the operator, without leaking values.
 * A misconfigured deployment must never fall through to serving the paid body for free.
 */
export function configErrorResponse(err) {
  const isConfig = err instanceof ConfigError;
  return new Response(
    JSON.stringify({
      error: 'route misconfigured',
      detail: isConfig ? err.message : 'unexpected error resolving price configuration',
    }),
    { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}

export { ConfigError };
