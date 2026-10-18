// @ts-check
/**
 * The two vault events the reducer reads, with argument names that say what the fields are.
 *
 * `DepositActivated`'s third field is named `sharesMinted` in the contract and is NOT the shares
 * minted: both emit sites pass `sharesOf[member]` read AFTER the mint (VaultCore.sol, in `_deposit`
 * and `_activatePending`), so it is the member's share balance after the deposit. It is named
 * `sharesAfter` here. The reducer sets the balance to it and never adds it. A repeat deposit by one
 * member is the case that tells the two readings apart.
 * `test/abis.test.mjs` pins the signatures and both emit sites against `contracts/src/VaultCore.sol`.
 */
const addr = (name, indexed = false) => ({ name, type: 'address', indexed });
const u256 = (name, indexed = false) => ({ name, type: 'uint256', indexed });

export const VAULT_EVENTS = Object.freeze([
  Object.freeze({
    type: 'event', name: 'DepositActivated', anonymous: false,
    inputs: [addr('member', true), u256('amountUsdc'), u256('sharesAfter')],
  }),
  Object.freeze({
    type: 'event', name: 'ExitSettled', anonymous: false,
    inputs: [addr('member', true), u256('sharesBurned'), u256('usdcPaid'), u256('exitFeeBps'), u256('perfFeeUsdc')],
  }),
]);

export const VAULT_READ_ABI = Object.freeze([
  { type: 'function', name: 'sharesOf', stateMutability: 'view', inputs: [addr('')], outputs: [u256('')] },
  { type: 'function', name: 'costBasisUsdc', stateMutability: 'view', inputs: [addr('')], outputs: [u256('')] },
  { type: 'function', name: 'creator', stateMutability: 'view', inputs: [], outputs: [addr('')] },
]);
