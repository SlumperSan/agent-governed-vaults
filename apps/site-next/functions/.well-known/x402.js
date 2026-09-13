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
 * It also publishes the STALENESS of the data. A caller deciding whether $0.10 is worth paying needs
 * the age of the payload before they pay, not after.
 */
import { resolvePrice, configErrorResponse, BASE_MAINNET_USDC } from '../api/_price.js';
import snapshot from '../api/_snapshot.json' with { type: 'json' };

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
              'Creation-time facts for every indexed Agent-Governed Vault on Robinhood Chain mainnet (4663): address, creator, creation block and time, minimum deposit, capacity cap, runtime codesize.',
            data: {
              live: false,
              asOf: snapshot.asOf,
              chainId: snapshot.chainId,
              vaultCount: snapshot.vaults.length,
              staleness:
                'Pinned snapshot, not a chain read at request time. Balances, NAV, share supply and member positions are NOT included — see `notIncluded` in the payload.',
            },
          },
        ],
        free: ['/.well-known/x402'],
        paymentFlow:
          'Request the route with no payment header and it answers 402 with a PAYMENT-REQUIRED challenge, base64-encoded JSON per specs/transports-v2/http.md. Decode it, sign it as an EIP-3009 transferWithAuthorization, base64 the envelope into the PAYMENT-SIGNATURE header, and repeat the request. The 200 carries PAYMENT-RESPONSE: a base64 SettlementResponse ({success, transaction, network, payer}), with receiptId and nonce alongside. A FAILED settlement is a 402 whose body `error` names the reason and which carries no PAYMENT-RESPONSE.',
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
