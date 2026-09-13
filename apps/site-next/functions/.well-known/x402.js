/**
 * `GET /.well-known/x402` — the discovery document. FREE, and free on purpose.
 *
 * This is how an agent finds out what this endpoint sells and what it costs WITHOUT paying to find
 * out. `apps/api/src/server.mjs` keeps `/.well-known/x402` in `FREE_ROUTES` for that reason, and its
 * own comment makes the point this file has to honour: the discovery document is "told the truth
 * rather than quoted a price it will never be charged". So the price here is resolved from exactly
 * the same env the paid route resolves it from — not restated as a literal that could drift away
 * from what the gate actually demands.
 *
 * It also publishes what "live" means for this route NOW that `api/vaults.js` reads the chain at
 * request time rather than serving a pinned file: there is no fixed `asOf` to quote any more, only
 * the fact that every 200 carries the block it was read at.
 */
import { resolvePrice, configErrorResponse, BASE_MAINNET_USDC } from '../api/_price.js';
import { DATA_CHAIN_ID, DATA_CHAIN_NAME, VAULTS } from '../api/_chain.js';

export const onRequestGet = async (context) => {
  const { request, env } = context;

  let price;
  try {
    price = resolvePrice(env);
  } catch (err) {
    return configErrorResponse(err);
  }

  const origin = new URL(request.url).origin;

  return new Response(
    JSON.stringify(
      {
        x402Version: 2,
        scheme: 'exact',
        network: price.network,
        asset: price.asset,
        assetNote:
          price.asset.toLowerCase() === BASE_MAINNET_USDC.toLowerCase()
            ? 'Circle-native USDC on Base mainnet, 6 decimals.'
            : 'Not the Circle-native Base USDC address this deployment expects — check PRICE_ASSET.',
        payTo: price.payTo,
        routes: [
          {
            method: 'GET',
            path: '/api/vaults',
            url: `${origin}/api/vaults`,
            price: { amount: price.amount, asset: price.asset, decimals: 6 },
            description:
              'A chain read, taken at request time, of every Agent-Governed Vault on Robinhood Chain ' +
              'mainnet (4663): NAV, NAV per share, total shares, idle USDC, pending USDC, capacity cap ' +
              'and headroom, minimum deposit, basket length, child vault count, lock state and creator. ' +
              'Two vaults today.',
            data: {
              live: true,
              chainId: DATA_CHAIN_ID,
              chainName: DATA_CHAIN_NAME,
              vaultCount: VAULTS.length,
              freshness:
                'Read at request time, not pinned. There is no fixed age to quote here — every 200 ' +
                'response carries the block number the read was taken at.',
              perVaultCaveats:
                'A field can be absent from a served vault instead of a number: `pricingFrozen: true` ' +
                'means the oracle itself reverted the NAV read (a real signal), and `unreadable` names a ' +
                'field this deployment could not read this request (a transport failure, or an ' +
                'unrecognised revert) rather than a value of zero.',
            },
          },
        ],
        free: ['/.well-known/x402'],
        paymentFlow:
          'Request the route with no payment header and it answers 402 with a PAYMENT-REQUIRED challenge. Sign the challenge as an EIP-3009 transferWithAuthorization, base64 the envelope into the PAYMENT-SIGNATURE header, and repeat the request. The response carries PAYMENT-RESPONSE with the settlement receipt id.',
        source: 'https://github.com/SlumperSan/agent-governed-vaults',
      },
      null,
      2,
    ),
    {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        // Discovery is cheap and public, but the price is env-resolved and can be rotated, so this
        // is cached briefly rather than indefinitely.
        'cache-control': 'public, max-age=60',
      },
    },
  );
};
