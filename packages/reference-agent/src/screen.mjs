// @ts-check
/**
 * OFAC SDN screening on the agent's own accounts, at the two places this process signs: every
 * on-chain send (`walletClient.writeContract`) and every x402 payment authorization (the payer).
 *
 * The check is the UI's `assertNotSanctioned`, imported unchanged, so the list, the 30-day
 * freshness ceiling and the exit exemption are one implementation. It fails closed exactly as it
 * does there: a stale list refuses every write except `requestExit` and `claimEscrowed`, and a
 * listed address is refused even on those. A payment gets no exemption (it brings value in).
 *
 * This screens what this software submits. It cannot stop a call made directly against the
 * Protocol's permissionless contracts, and nothing here may claim otherwise.
 *
 * shortcut: a packages-to-apps import (Node 24 strips the types), the same direction
 * agent-sdk/test/sdk.test.mjs already uses; move sanctions.ts and sdn-addresses.ts to a shared
 * package when a fourth consumer appears.
 */

import { assertNotSanctioned } from '../../../apps/vaults-ui/src/lib/sanctions.ts';

/**
 * Wrap a wallet client so every send screens the account it is sent from, before the inner client
 * sees the request. A request with no account address is refused: absent an address there is
 * nothing to prove clean.
 * @param {{writeContract:Function}} walletClient
 * @param {() => number} [now]  test-only clock in ms; production reads the real clock
 */
export function screenWalletClient(walletClient, now) {
  return {
    ...walletClient,
    writeContract(/** @type {any} */ req) {
      const from = req?.account?.address;
      if (!from) throw new Error('sanctions screen: writeContract has no account address to screen');
      assertNotSanctioned(from, now?.(), req.functionName);
      return walletClient.writeContract(req);
    },
  };
}

/**
 * Wrap an x402 payer so every signature screens the payer address first. Only the signing methods
 * the API client calls (`signTypedData`, `sign`) are wrapped, and only those the payer has.
 * @param {{address:string, signTypedData?:Function, sign?:Function}} payer
 * @param {() => number} [now]  test-only clock in ms
 */
export function screenPayer(payer, now) {
  /** @type {any} */
  const out = { ...payer };
  for (const name of /** @type {const} */ (['signTypedData', 'sign'])) {
    const fn = payer[name];
    if (typeof fn !== 'function') continue;
    out[name] = (/** @type {any[]} */ ...args) => {
      if (!payer.address) throw new Error('sanctions screen: x402 payer has no address to screen');
      assertNotSanctioned(payer.address, now?.());
      return fn.apply(payer, args);
    };
  }
  return out;
}
