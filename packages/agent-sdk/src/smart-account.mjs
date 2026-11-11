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

import { encodeFunctionData, decodeFunctionResult, parseAbi } from 'viem';

const RECEIVER_ABI = parseAbi(['function onERC721Received(address operator, address from, uint256 tokenId, bytes data) returns (bytes4)']);
const ZERO_ADDRESS = '0x' + '0'.repeat(40);
/** `IERC721Receiver.onERC721Received.selector`. */
export const ERC721_RECEIVED_SELECTOR = '0x150b7a02';
/** The registry functions that mint an identity to `msg.sender` and then call `onERC721Received` on it. */
export const REGISTRY_MINT_FUNCTIONS = Object.freeze(['register', 'importAgent', 'mintMirrored']);

/** True when a viem call error is the contract reverting (a revert anywhere in the cause chain), not a transport failure. */
function isRevert(err) {
  for (let e = /** @type {any} */ (err), i = 0; e && i < 8; e = e.cause, i++)
    if (/revert/i.test(`${e.name ?? ''} ${e.shortMessage ?? ''} ${e.message ?? ''}`)) return true;
  return false;
}

/** Thrown before any UserOp is built or signed when the minting account cannot receive an ERC-721. */
export class Erc721ReceiverError extends Error {
  /** @param {string} account @param {string} detail */
  constructor(account, detail) {
    super(`${account} cannot receive ERC-721 tokens (${detail}). A smart account must answer onERC721Received with ${ERC721_RECEIVED_SELECTOR} to hold an agent identity; this one did not. Nothing was built or signed.`);
    this.name = 'Erc721ReceiverError';
    this.account = account;
  }
}

/**
 * Gas and UX guard, not a safety check: the registry itself reverts with ERC721InvalidReceiver when
 * the recipient is a contract that does not return the selector, so a bad account loses nothing
 * on-chain, it only pays for a UserOp that reverts. This fails fast with a readable error instead.
 * An account with no code (an EOA, or a counterfactual account) is skipped, as the registry does.
 * The probe is a static call made as the registry, to `account`, with `operator` = `account` and `from` = the
 * zero address. That mirrors a mint: the registry calls `onERC721Received(msg.sender, address(0), id, "")`
 * on the recipient, and every mint entry point (`register`, `importAgent`, `mintMirrored`) mints to
 * `msg.sender`, so for a UserOp both the operator and the recipient are the smart account itself. Only a
 * revert or wrong return bytes become `Erc721ReceiverError`; transport errors propagate unchanged.
 * @param {{getCode:(p:{address:string}) => Promise<string|undefined>, call:(p:object) => Promise<{data?:string}>}} publicClient
 * @param {string} registry  the registry address; the probe's caller (`msg.sender` of the callback is the registry)
 * @param {string} account  the smart account: the minting sender, the recipient, and the `operator` argument
 */
export async function assertCanReceiveErc721(publicClient, registry, account) {
  const code = await publicClient.getCode({ address: account });
  if (!code || code === '0x') return;
  let result;
  try {
    result = await publicClient.call({
      to: account,
      account: registry,
      data: encodeFunctionData({ abi: RECEIVER_ABI, functionName: 'onERC721Received', args: [account, ZERO_ADDRESS, 0n, '0x'] }),
    });
  } catch (err) {
    if (isRevert(err)) throw new Erc721ReceiverError(account, 'onERC721Received reverted');
    throw err;
  }
  let returned;
  try {
    returned = decodeFunctionResult({ abi: RECEIVER_ABI, functionName: 'onERC721Received', data: result?.data ?? '0x' });
  } catch {
    throw new Erc721ReceiverError(account, 'onERC721Received returned no bytes4');
  }
  if (returned !== ERC721_RECEIVED_SELECTOR)
    throw new Erc721ReceiverError(account, `onERC721Received returned ${returned}`);
}

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
 * @param {{publicClient:{getCode:Function, call:Function}, registry:string}} [cfg.mintPreflight]  when given, a write to
 *   `registry` of register, importAgent or mintMirrored first static-calls onERC721Received on the smart account
 *   (see `assertCanReceiveErc721`) and throws `Erc721ReceiverError` before anything is prepared. Opt-in; leave it out
 *   and no check runs.
 * @param {boolean} [cfg.waitForReceipt]  default true: wait until the UserOp is mined and return
 *   the transaction hash; a reverted UserOp throws. Leave it on: the actor sends an approval and
 *   then the deposit that spends it, and the second must not race the first.
 */
export function createUserOpWalletClient({ bundlerClient, smartAccount, maxFeePerGasCeiling, waitForReceipt = true, mintPreflight }) {
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

  if (mintPreflight !== undefined) {
    if (typeof mintPreflight?.publicClient?.getCode !== 'function' || typeof mintPreflight.publicClient.call !== 'function')
      throw new TypeError('mintPreflight.publicClient needs getCode and call');
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(mintPreflight.registry)))
      throw new TypeError('mintPreflight.registry is not an address');
  }

  return {
    /**
     * @param {{address:string, abi:readonly any[], functionName:string, args?:readonly any[], account?:{address?:string}|string, chain?:unknown}} req
     * @returns {Promise<string>} the transaction hash, or the UserOp hash when `waitForReceipt` is false
     */
    async writeContract({ address, abi, functionName, args = [], account }) {
      const from = typeof account === 'string' ? account : account?.address;
      if (typeof from !== 'string' || from.toLowerCase() !== smartAccount.address.toLowerCase())
        throw new Error(`refused: the write is for ${from ?? 'no account'} but this writer sends from ${smartAccount.address}`);

      if (mintPreflight && address.toLowerCase() === mintPreflight.registry.toLowerCase() && REGISTRY_MINT_FUNCTIONS.includes(functionName))
        await assertCanReceiveErc721(mintPreflight.publicClient, mintPreflight.registry, smartAccount.address);

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
