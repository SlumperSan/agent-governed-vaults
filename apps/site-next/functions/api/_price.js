/**
 * Price and facilitator resolution for the metered read route, at the edge.
 *
 * WHY THIS FILE HOLDS NO KEY UNDER `FACILITATOR=standard`, AND CANNOT HOLD ONE.
 * `apps/api` has FOUR selectable facilitator modes -- `facilitatorFromConfig` in serve.mjs builds
 * `stub`, `http`, `standard` and `svm`. `stub`, `http` and `standard` hold no key,
 * and `FACILITATOR=svm` DOES hold one — the one mode that does, because Solana's flow makes this
 * process the fee payer and there is nothing to delegate. This route is
 * EVM-only and uses `createStandardHttpFacilitator` — it POSTs spec-shaped bodies to a facilitator
 * and reads back a receipt, using nothing but `fetch`. No key is read here, none can be configured
 * here, and a deploy of this Worker moves no funds. That is a property of the code, not a promise:
 * no key material appears in any of these files. (Stated that way on purpose: the earlier wording
 * invited a grep whose only hit was the sentence itself.)
 * (facilitator.mjs defines a FIFTH implementation, `createSettlingFacilitator`, which takes an
 * operator-supplied signing walletClient -- but it is not a selectable FACILITATOR value and is
 * not reachable from this route. Counting modes and counting implementations give 4 and 5.)
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
    // NOT echoed. Unlike the other four, this value is operator configuration that is published
    // nowhere, and facilitator endpoints routinely carry a key in the path or query. Omitting the
    // scheme is the commonest URL typo, so the unparseable branch is exactly where a credential
    // would surface -- to an unauthenticated GET, since this becomes a 500 body.
    throw new ConfigError('FACILITATOR_URL is not a valid URL (value withheld: it may carry a credential)');
  }
  // A facilitator receives a signed payment authorization. Over plain http that envelope is
  // readable and replayable by anything on the path, so the scheme is checked rather than assumed.
  if (parsed.protocol !== 'https:') {
    // `parsed.protocol` is NOT safe to echo. When the scheme is omitted but a port is present
    // -- `facilitator.example.com:443/settle?apiKey=...` -- WHATWG parses the HOST as the scheme,
    // so echoing it prints the hostname of a setting published nowhere.
    throw new ConfigError('FACILITATOR_URL must use https (value withheld: it may carry a credential)');
  }
  return parsed.toString();
}

/**
 * A 500 that names the setting at fault, for the operator.
 *
 * WHICH BRANCHES ECHO A VALUE, enumerated per branch rather than asserted as a rule. Three earlier
 * versions of this comment stated a rule and each was falsified by a branch it had not enumerated:
 * "no values are echoed" (false), "all five are safe to echo" (false), "FACILITATOR_URL is not
 * echoed" (false -- the non-https branch printed `parsed.protocol`, which for a scheme-omitted value
 * like `host:443/path?key=...` is the HOST). So:
 *
 *   requireAddr   PRICE_ASSET, PRICE_PAYTO   ECHOES the bad value. Both are on the free discovery
 *                                            document already, so there is nothing to withhold.
 *   PRICE_AMOUNT                             ECHOES the bad value. Also on the discovery document.
 *   requireEnv    all six, when BLANK        echoes nothing -- it reports only the key name. This is
 *                                            why `PRICE_NETWORK` has no value-echoing branch at all.
 *   FACILITATOR_NETWORK                      ECHOES the bad value. A CAIP-2 chain id is public and
 *                                            an operator debugging `base` vs `eip155:8453` needs to
 *                                            see which one they typed. Enumerated here because the
 *                                            commit that ADDED this setting did not, which is the
 *                                            fourth time this comment missed a branch.
 *   FACILITATOR_URL                          WITHHELD in both of its branches, unparseable and
 *                                            non-https. Published nowhere, and a facilitator
 *                                            endpoint may carry a key in path or query.
 *
 * Before adding a setting here, find the branch that would print it and decide there. Note the 500
 * answers an unauthenticated GET.
 *
 * One thing this file does NOT control: on a fetch rejection `createStandardHttpFacilitator` puts
 * `<step>-unreachable: <err.message>` into the 402 body via `gate` -- measured as
 * `settlement failed: verify-unreachable: ...`, so the failing STEP is named, which the bespoke
 * client did not do. Under Node that message is `fetch failed` with no URL; what the Workers
 * runtime puts there is unverified.
 *
 * A misconfigured deployment must never fall through to serving the paid body for free.
 */
/**
 * The CAIP-2 chain id sent to the facilitator in `paymentRequirements.network`.
 *
 * This is NOT `PRICE_NETWORK` and the two must not be merged. `PRICE_NETWORK` is what the 402
 * challenge advertises to a paying client (`base`, the label PayAI's `/supported` lists for its
 * x402Version 1 Base-mainnet entry). `FACILITATOR_NETWORK` is what the facilitator's `/verify` and
 * `/settle` expect (`eip155:8453`, its v2 entry for the same chain). One chain, two spellings,
 * different audiences -- `createStandardHttpFacilitator` refuses to start without the CAIP-2 one.
 */
export function resolveFacilitatorNetwork(env) {
  const v = requireEnv(env, 'FACILITATOR_NETWORK');
  // Required to be CAIP-2 rather than defaulted: a wrong chain id here means every payment is
  // verified against the wrong chain and rejected forever, and a default would hide that.
  if (!/^[a-z0-9-]{3,8}:[a-zA-Z0-9._-]{1,32}$/.test(v)) {
    throw new ConfigError(`FACILITATOR_NETWORK must be a CAIP-2 id such as eip155:8453, got: ${v}`);
  }
  return v;
}

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
