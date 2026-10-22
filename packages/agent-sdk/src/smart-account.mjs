// @ts-check
/**
 * A `walletClient` stand-in that sends each write as an ERC-4337 UserOperation from a smart
 * account, so an agent whose on-chain identity is a smart account (Kernel, behind a session key)
 * plugs into the reference agent's actor unchanged: the actor only ever calls
 * `walletClient.writeContract({ address, abi, functionName, args, account, chain })`
 * (`packages/reference-agent/src/act.mjs`).
 *
 * viem only. The caller builds both inputs with viem's own account-abstraction helpers
 * (`createBundlerClient` and `toSmartAccount` from `viem/account-abstraction`) or anything with
 * the same methods; this module never constructs an account and never holds key material.
 *
 * What it deliberately does NOT expose: any `signMessage`, `signTypedData` or `sign`. The returned
 * object has `writeContract` and nothing else, so nothing built here can hand out an ERC-1271
 * signature from the smart account. That matters for USDC: an ERC-1271 signature the account
 * accepts is enough for USDC's `transferWithAuthorization(bytes signature)` to move its whole
 * balance, outside any UserOp call policy. The x402 payer stays a separate EOA.
 *
 * @example
 *   const writer = createUserOpWalletClient({ bundlerClient, smartAccount, maxFeePerGasCeiling: 50n * 10n ** 9n });
 *   const agent = createAgent({ account: { address: smartAccount.address, signMessage }, walletClient: writer, ... });
 */

import { encodeFunctionData } from 'viem';

/**
 * Keep scheme and host of every http(s) URL in `text`; drop path, query and fragment. A bundler
 * or RPC URL from a hosted provider carries its API key in the path, and viem error text embeds
 * the request URL verbatim.
 * @param {string} text
 */
export function stripUrls(text) {
  return String(text).replace(/(https?:\/\/[^\s/?#"'<>`]+)[^\s"'<>`]*/gi, '$1');
}

/**
 * The same error with every URL stripped from its text, and without its `cause` chain (viem keeps
 * the URL in nested causes too). `shortMessage` is kept, stripped, because the actor logs it.
 * @param {unknown} err
 */
function scrubbed(err) {
  const e = /** @type {any} */ (err);
  const out = /** @type {Error & {shortMessage?: string}} */ (new Error(stripUrls(e?.message ?? e)));
  out.name = typeof e?.name === 'string' ? e.name : 'Error';
  if (typeof e?.shortMessage === 'string') out.shortMessage = stripUrls(e.shortMessage);
  return out;
}

/**
 * @param {Object} cfg
 * @param {{
 *   prepareUserOperation: (p:object) => Promise<any>,
 *   sendUserOperation: (p:object) => Promise<string>,
 *   waitForUserOperationReceipt: (p:{hash:string}) => Promise<{success:boolean, receipt:{transactionHash:string}}>,
 * }} cfg.bundlerClient  a viem bundler client
 * @param {{address:string, entryPoint:{address:string, version:string}, signUserOperation:(op:object) => Promise<string>}} cfg.smartAccount
 *   a viem smart account; its entry point (0.6 or 0.7) is used as given, never assumed
 * @param {bigint} cfg.maxFeePerGasCeiling  refuse any UserOp priced above this, in the chain's
 *   native gas unit per gas (wei). On Arc the native gas token is USDC at 18 decimals, not the
 *   ERC-20's 6, so never derive this from a USDC amount.
 * @param {boolean} [cfg.waitForReceipt]  default true: wait until the UserOp is mined and return
 *   the transaction hash; a reverted UserOp throws. Leave it on: the actor sends an approval and
 *   then the deposit that spends it, and the second must not race the first.
 */
export function createUserOpWalletClient({ bundlerClient, smartAccount, maxFeePerGasCeiling, waitForReceipt = true }) {
  for (const m of ['prepareUserOperation', 'sendUserOperation', 'waitForUserOperationReceipt'])
    if (typeof bundlerClient?.[m] !== 'function') throw new TypeError(`bundlerClient.${m} is not a function`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(smartAccount?.address)))
    throw new TypeError('smartAccount.address is not an address');
  if (typeof smartAccount.entryPoint?.address !== 'string')
    throw new TypeError('smartAccount.entryPoint.address is missing; the entry point version is never guessed');
  if (typeof smartAccount.signUserOperation !== 'function')
    throw new TypeError('smartAccount.signUserOperation is not a function');
  if (typeof maxFeePerGasCeiling !== 'bigint' || maxFeePerGasCeiling <= 0n)
    throw new TypeError('maxFeePerGasCeiling must be a positive bigint (wei per gas); a UserOp is never sent unpriced');

  return {
    /**
     * @param {{address:string, abi:readonly any[], functionName:string, args?:readonly any[], account?:{address?:string}|string, chain?:unknown}} req
     * @returns {Promise<string>} the transaction hash, or the UserOp hash when `waitForReceipt` is false
     */
    async writeContract({ address, abi, functionName, args = [], account }) {
      const from = typeof account === 'string' ? account : account?.address;
      if (typeof from !== 'string' || from.toLowerCase() !== smartAccount.address.toLowerCase())
        throw new Error(`refused: the write is for ${from ?? 'no account'} but this writer sends from ${smartAccount.address}`);

      const calls = [{ to: address, data: encodeFunctionData({ abi, functionName, args }) }];
      try {
        const prepared = await bundlerClient.prepareUserOperation({ account: smartAccount, calls });
        if (typeof prepared?.maxFeePerGas !== 'bigint')
          throw new Error('refused: the prepared UserOp carries no maxFeePerGas, so its price cannot be checked');
        if (prepared.maxFeePerGas > maxFeePerGasCeiling)
          throw new Error(`refused: maxFeePerGas ${prepared.maxFeePerGas} is above the ceiling ${maxFeePerGasCeiling}`);

        // Sign what was checked and send it as is, so the bundler cannot be asked to re-price it.
        const { account: _unused, ...op } = prepared;
        const signature = await smartAccount.signUserOperation(op);
        const hash = await bundlerClient.sendUserOperation({ ...op, signature, entryPointAddress: smartAccount.entryPoint.address });
        if (!waitForReceipt) return hash;

        const { success, receipt } = await bundlerClient.waitForUserOperationReceipt({ hash });
        if (!success) throw new Error(`UserOp ${hash} reverted in transaction ${receipt?.transactionHash}`);
        return receipt.transactionHash;
      } catch (err) {
        throw scrubbed(err);
      }
    },
  };
}
