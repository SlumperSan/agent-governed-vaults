// @ts-check
/**
 * Pure assembly for a Safe{Wallet} Transaction Builder batch file (card: owner signs the first
 * vault through app.safe.global on Arc). Every chain/`cast` interaction is a caller-supplied
 * dependency (`calldata`), the same discipline `scripts/lib/safe-exec.mjs` and
 * `scripts/smoke-preflight.mjs` already use — so this module is testable with a stub and the CLI
 * (`scripts/build-safe-tx-builder.mjs`) supplies the real one.
 *
 * CALLDATA IS BUILT FROM THE SAME TUPLE CONSTRUCTORS `scripts/smoke-test.mjs` USES
 * (`createVaultParamsTuple` / `registerVaultConfigTuple`, `scripts/smoke-preflight.mjs`) — this file
 * does not re-derive the parameter shapes, only assembles them into the Transaction Builder's
 * `BatchTransaction`/`BatchFile` shapes (safe-global/safe-react-apps commit
 * `118f25df89f781631386e6b279d812dfc837204a`, `apps/tx-builder/src/typings/models.ts`).
 *
 * `contractMethod.inputs` ARE READ FROM THE COMPILED ABI (`contracts/out/…`), the same "read off the
 * compiled contract rather than typed out by hand a second time" discipline
 * `scripts/build-rebalance-order.mjs`'s `rebalanceDecodeSig` already established — a hand-transcribed
 * struct shape is exactly what drifted in card 207.
 *
 * WHAT `contractMethod`/`contractInputsValues` ACTUALLY BUY IN THE SAFE UI, STATED HONESTLY.
 * `transactionLibraryContext.tsx`'s `convertToProposedTransactions` (same commit) branches on
 * `if (transaction.data)` FIRST: when `data` is present (as it always is here, because byte-identity
 * with smoke-test.mjs's calldata is the hard requirement and dropping `data` would hand encoding to
 * Safe's own `encodeToHexData` instead), it sets `contractInterface: null` and displays the raw
 * `customTransactionData` — `contractMethod`/`contractInputsValues` are NOT decoded or shown in that
 * branch. They are still included below because the card asks for them and they cost nothing (the
 * checksum covers them too), but the owner will see raw calldata in the Transaction Builder UI, not a
 * decoded parameter form. Basescan / the Safe confirmation UI at signing time may still decode it
 * independently from the target's verified ABI.
 */
import { createVaultParamsTuple, registerVaultConfigTuple, CREATE_VAULT_SIG, REGISTER_VAULT_SIG } from '../smoke-preflight.mjs';

/**
 * @param {object} p
 * @param {(sig: string, ...args: string[]) => string} p.calldata `cast calldata <sig> <args...>`
 * @param {string} p.usdc
 * @param {string[]} p.tokens
 * @param {string} p.aggregator
 * @param {string|number} p.capacityCapUsdc
 * @param {string|number} p.minDepositUsdc
 * @param {string|number} p.exitFeeMaxBps
 * @param {string|number} p.exitFeeDecayPeriod
 * @param {string} p.adapter
 * @param {string} p.factory the inner call's `to`
 * @param {object[]} p.abiInputs `createVault`'s `inputs`, read verbatim from the compiled ABI
 *   (`{internalType, name, type, components?}[]`) — the exact shape Safe's own `ContractInput` wants
 * @returns {{to: string, value: string, data: string, contractMethod: object, contractInputsValues: object}}
 */
export function createVaultBatchTransaction({
  calldata, usdc, tokens, aggregator, capacityCapUsdc, minDepositUsdc, exitFeeMaxBps,
  exitFeeDecayPeriod, adapter, factory, abiInputs,
}) {
  const tuple = createVaultParamsTuple({
    usdc, tokens, aggregator, capacityCapUsdc, minDepositUsdc, exitFeeMaxBps, exitFeeDecayPeriod, adapter,
  });
  const data = calldata(CREATE_VAULT_SIG, tuple);
  return {
    to: factory,
    value: '0',
    data,
    contractMethod: { inputs: abiInputs, name: 'createVault', payable: false },
    contractInputsValues: { p: tuple },
  };
}

/**
 * @param {object} p
 * @param {(sig: string, ...args: string[]) => string} p.calldata
 * @param {string} p.vault
 * @param {object} p.gov `cfg.smoke.gov`
 * @param {string} p.governance the inner call's `to`
 * @param {object[]} p.abiInputs `registerVault`'s `inputs`, read verbatim from the compiled ABI
 * @returns {{to: string, value: string, data: string, contractMethod: object, contractInputsValues: object}}
 */
export function registerVaultBatchTransaction({ calldata, vault, gov, governance, abiInputs }) {
  const tuple = registerVaultConfigTuple(gov);
  const data = calldata(REGISTER_VAULT_SIG, vault, tuple);
  return {
    to: governance,
    value: '0',
    data,
    contractMethod: { inputs: abiInputs, name: 'registerVault', payable: false },
    contractInputsValues: { vault, cfg: tuple },
  };
}

/**
 * Assembles the `BatchFile` envelope around ONE transaction — this generator never batches
 * `createVault` and `registerVault` together (see `scripts/build-safe-tx-builder.mjs`'s header for
 * why: Transaction Builder batches of 2+ transactions go through Safe's MultiSend, and
 * `createVault` is permissionless, so a plan built against a PREDICTED vault address could be raced).
 *
 * DELIBERATELY OMITS `meta.checksum`. `scripts/lib/safe-tx-builder-checksum.mjs`'s own header
 * documents why: Safe's `addChecksum` must run against an object with NO `checksum` key present (the
 * real `generateBatchFile` -> `addChecksum` pipeline never sets one first), or the resulting checksum
 * fails Safe's own `validateChecksum` on import — a checksum computed by a different rule than the
 * one that checks it. The caller attaches the checksum via `addChecksum` from that module.
 *
 * @param {object} p
 * @param {number|string} p.chainId
 * @param {number} p.createdAt epoch ms — injectable so tests are deterministic
 * @param {string} p.safe
 * @param {string} p.name
 * @param {string} p.description
 * @param {ReturnType<typeof createVaultBatchTransaction> | ReturnType<typeof registerVaultBatchTransaction>} p.transaction
 * @returns {object}
 */
export function buildBatchFile({ chainId, createdAt, safe, name, description, transaction }) {
  return {
    version: '1.0',
    chainId: String(chainId),
    createdAt,
    meta: {
      name,
      description,
      txBuilderVersion: 'agent-governed-vaults/build-safe-tx-builder.mjs',
      createdFromSafeAddress: safe,
      createdFromOwnerAddress: '',
    },
    transactions: [transaction],
  };
}
