// @ts-check
/**
 * Action — turn intents into transactions, or into a description of them.
 *
 * The same intent list drives both modes. Dry-run renders each intent as the exact call it would
 * make (contract, function, arguments) and returns; execute mode sends it through an injected
 * wallet client. There is no second code path for dry-run to drift away from.
 *
 * Invariants this module is responsible for:
 *
 *  - **Dry-run signs no transaction.** It does not construct a signature, does not touch the
 *    account beyond reading `.address`, and returns `{ sent: false }` for every intent. The one
 *    exception is deliberate and narrow: a `reveal` intent in dry-run still DERIVES its salt,
 *    because deriving the salt is a `personal_sign` over a fixed string — it authorizes nothing,
 *    moves nothing, and proving the salt is recoverable is the entire point of the S-4 mitigation.
 *    A dry run that skipped it would not be testing the thing that matters.
 *  - **skipWindow is refused unless explicitly enabled.** Even with an intent in hand, the actor
 *    re-checks `danger.allowSkipWindow`. Two independent gates on the one irreversible action.
 *  - **The salt is never logged**, only previewed (log.hexPreview).
 */

import { commitmentFor, recoverVote, buildVote, assertDeterministicSigner } from './salt.mjs';
import { hexPreview } from './log.mjs';
import { fromBaseUnits } from './config.mjs';

/** Write fragments for the four state-changing calls the agent may make. */
export const VAULT_WRITE_ABI = Object.freeze([
  { type: 'function', name: 'deposit', inputs: [{ name: 'amountUsdc', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'activate', inputs: [{ name: 'member', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'requestExit', inputs: [{ name: 'shares', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'settleQueuedExit', inputs: [{ name: 'member', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'skipWindow', inputs: [], outputs: [], stateMutability: 'nonpayable' },
]);

/**
 * ERC-20 approve. `VaultCore.deposit` pulls with `safeTransferFrom`, so a deposit from an account
 * with no allowance reverts `TransferFromFailed(address)` (0x6e1c8d15) before it touches any vault
 * logic. Nothing in the agent ever set an allowance, which made execute-mode deposits impossible.
 */
export const ERC20_WRITE_ABI = Object.freeze([
  { type: 'function', name: 'approve', inputs: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' },
]);

export const GOVERNANCE_WRITE_ABI = Object.freeze([
  {
    type: 'function',
    name: 'commitVote',
    inputs: [{ name: 'pid', type: 'uint256' }, { name: 'commitment', type: 'bytes32' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'revealVote',
    inputs: [{ name: 'pid', type: 'uint256' }, { name: 'support', type: 'bool' }, { name: 'salt', type: 'bytes32' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
]);

export class ActionRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'ActionRefused';
  }
}

/**
 * @param {Object} p
 * @param {'dry-run'|'execute'} p.mode
 * @param {any} p.config
 * @param {{address:string, signMessage:Function}|null} p.account
 * @param {any} p.chainReader
 * @param {any} p.log
 * @param {{writeContract:Function}|null} [p.walletClient]  injected viem wallet client (execute only)
 */
export function createActor({ mode, config, account, chainReader, log, walletClient = null }) {
  const governance = config.chain.governance;
  let signerChecked = false;

  /** Render an intent as the concrete call it maps to. This is what dry-run prints. */
  async function resolveCall(intent) {
    switch (intent.kind) {
      case 'deposit':
        return {
          to: intent.vault,
          contract: 'VaultCore',
          abi: VAULT_WRITE_ABI,
          functionName: 'deposit',
          args: [BigInt(intent.args.amountUsdc)],
          human: `VaultCore(${intent.vault}).deposit($${fromBaseUnits(BigInt(intent.args.amountUsdc))} USDC)`,
          // `deposit` PULLS via safeTransferFrom, so it needs an allowance first. Declared here
          // rather than hidden in run(), so dry-run prints it too and the two modes still describe
          // the same sequence.
          approvalFirst: config.chain.usdc
            ? {
              to: config.chain.usdc,
              contract: 'USDC',
              abi: ERC20_WRITE_ABI,
              functionName: 'approve',
              args: [intent.vault, BigInt(intent.args.amountUsdc)],
              human: `USDC(${config.chain.usdc}).approve(${intent.vault}, $${fromBaseUnits(BigInt(intent.args.amountUsdc))})`,
            }
            : null,
        };

      case 'activate':
        return {
          to: intent.vault,
          contract: 'VaultCore',
          abi: VAULT_WRITE_ABI,
          functionName: 'activate',
          args: [intent.args.member],
          human: `VaultCore(${intent.vault}).activate(${intent.args.member})`,
        };

      case 'exit':
        return {
          to: intent.vault,
          contract: 'VaultCore',
          abi: VAULT_WRITE_ABI,
          functionName: 'requestExit',
          args: [BigInt(intent.args.shares)],
          human: `VaultCore(${intent.vault}).requestExit(${intent.args.shares} shares)${intent.modeF ? '  [MODE F — queues, settles at post-rebalance NAV]' : '  [MODE I — instant, in-kind]'}`,
        };

      case 'settle-queued-exit':
        return {
          to: intent.vault,
          contract: 'VaultCore',
          abi: VAULT_WRITE_ABI,
          functionName: 'settleQueuedExit',
          args: [intent.args.member],
          human: `VaultCore(${intent.vault}).settleQueuedExit(${intent.args.member})`,
        };

      case 'skip-window': {
        // Second gate. The planner already refused to emit this without the flag; refuse again
        // here, because the cost of being wrong once is a permanent, unrecoverable opt-in.
        if (config.danger?.allowSkipWindow !== true)
          throw new ActionRefused(
            'refusing skipWindow(): it is IRREVERSIBLE and once-per-agent-per-vault, and danger.allowSkipWindow is not enabled. ' +
              'The agent never takes this action autonomously.',
          );
        return {
          to: intent.vault,
          contract: 'VaultCore',
          abi: VAULT_WRITE_ABI,
          functionName: 'skipWindow',
          args: [],
          human: `VaultCore(${intent.vault}).skipWindow()  [IRREVERSIBLE — explicitly enabled in config]`,
        };
      }

      case 'commit': {
        if (!account) throw new ActionRefused('commitVote needs an account: the salt IS a signature by that account');
        if (!governance) throw new ActionRefused('commitVote needs chain.governance to be configured');
        // One extra signature per session, before the first commit ever happens: prove this signer
        // reproduces its salt. A signer that does not would commit and then be unable to reveal.
        if (!signerChecked) {
          await assertDeterministicSigner({ account, chainId: config.chain.chainId, vault: intent.vault, pid: intent.args.pid });
          signerChecked = true;
          log.ok('signer determinism verified — the reveal salt is reproducible after a restart');
        }
        const vote = await buildVote({
          account,
          chainId: config.chain.chainId,
          vault: intent.vault,
          pid: intent.args.pid,
          support: intent.args.support,
        });
        return {
          to: governance,
          contract: 'Governance',
          abi: GOVERNANCE_WRITE_ABI,
          functionName: 'commitVote',
          args: [vote.pid, vote.commitment],
          human: `Governance.commitVote(pid=${vote.pid}, commitment=${hexPreview(vote.commitment)})  [${intent.args.support ? 'FOR' : 'AGAINST'}, salt=${hexPreview(vote.salt)} derived, not stored]`,
          vote,
        };
      }

      case 'reveal': {
        if (!account) throw new ActionRefused('revealVote needs an account to re-derive the salt');
        if (!governance) throw new ActionRefused('revealVote needs chain.governance to be configured');
        // THE RESTART PATH. Nothing was stored at commit time; the on-chain commitment is read
        // back and the salt is re-derived from the account. Two candidate support values reproduce
        // the hash, and only ours matches — that is the recovery.
        const gov = await chainReader.readGovernance(intent.vault, account.address);
        const onChainCommitment = gov?.commitment;
        if (!onChainCommitment) throw new ActionRefused(`no on-chain commitment found for pid ${intent.args.pid}`);
        const recovered = await recoverVote({
          account,
          chainId: config.chain.chainId,
          vault: intent.vault,
          pid: intent.args.pid,
          onChainCommitment,
        });
        if (!recovered)
          throw new ActionRefused(
            `could not reproduce the on-chain commitment ${hexPreview(onChainCommitment)} for pid ${intent.args.pid}. ` +
              'The commit was made by a different account, a different salt scheme, or a non-deterministic signer — the vote cannot be revealed.',
          );
        // Belt and braces: confirm the reconstruction before spending gas on a revert.
        const rebuilt = await commitmentFor({ pid: intent.args.pid, voter: account.address, support: recovered.support, salt: recovered.salt });
        if (rebuilt.toLowerCase() !== String(onChainCommitment).toLowerCase())
          throw new ActionRefused('internal: recovered salt failed to reproduce the commitment');
        return {
          to: governance,
          contract: 'Governance',
          abi: GOVERNANCE_WRITE_ABI,
          functionName: 'revealVote',
          args: [BigInt(intent.args.pid), recovered.support, recovered.salt],
          human: `Governance.revealVote(pid=${intent.args.pid}, support=${recovered.support}, salt=${hexPreview(recovered.salt)})  [salt RE-DERIVED from the wallet — survives a restart]`,
          recovered,
        };
      }

      default:
        throw new ActionRefused(`unknown intent kind: ${intent.kind}`);
    }
  }

  /**
   * Run one intent. Returns a record either way — a refusal is a result, not an exception the
   * caller has to catch to keep the loop alive.
   * @param {any} intent
   */
  async function run(intent) {
    let call;
    try {
      call = await resolveCall(intent);
    } catch (err) {
      log.warn(`REFUSED ${intent.kind} on ${intent.vault} — ${String(err?.message ?? err)}`);
      return { intent: intent.kind, vault: intent.vault, sent: false, refused: true, error: String(err?.message ?? err) };
    }

    if (mode === 'dry-run') {
      if (call.approvalFirst) log.act(`[DRY-RUN] would send: ${call.approvalFirst.human}`);
      log.act(`[DRY-RUN] would send: ${call.human}`);
      log.info(`           why: ${intent.reason}`);
      return {
        intent: intent.kind, vault: intent.vault, sent: false, dryRun: true,
        call: describe(call),
        ...(call.approvalFirst ? { approval: describe(call.approvalFirst) } : {}),
      };
    }

    if (!walletClient) {
      log.error(`cannot send ${intent.kind}: execute mode has no wallet client injected`);
      return { intent: intent.kind, vault: intent.vault, sent: false, refused: true, error: 'no wallet client' };
    }

    let approvalHash = null;
    if (call.approvalFirst) {
      // Sent unconditionally rather than after reading the current allowance: the actor has no
      // read client, and USDC (FiatTokenV2) permits setting a new allowance directly. Approving
      // the EXACT deposit amount means a successful deposit consumes it back to zero, so no
      // standing allowance is left behind.
      try {
        approvalHash = await walletClient.writeContract({
          address: call.approvalFirst.to,
          abi: call.approvalFirst.abi,
          functionName: call.approvalFirst.functionName,
          args: call.approvalFirst.args,
          account,
          chain: null,
        });
        log.act(`[EXECUTE] sent ${call.approvalFirst.human}  tx=${approvalHash}`);
      } catch (err) {
        log.error(`[EXECUTE] approval for ${intent.kind} on ${intent.vault} FAILED — ${String(err?.shortMessage ?? err?.message ?? err)}`);
        return { intent: intent.kind, vault: intent.vault, sent: false, error: `approval failed: ${String(err?.message ?? err)}` };
      }
    }

    try {
      const hash = await walletClient.writeContract({
        address: call.to,
        abi: call.abi,
        functionName: call.functionName,
        args: call.args,
        account,
        chain: null,
      });
      log.act(`[EXECUTE] sent ${call.human}  tx=${hash}`);
      return { intent: intent.kind, vault: intent.vault, sent: true, hash, call: describe(call), ...(approvalHash ? { approvalHash } : {}) };
    } catch (err) {
      log.error(`[EXECUTE] ${intent.kind} on ${intent.vault} FAILED — ${String(err?.shortMessage ?? err?.message ?? err)}`);
      return { intent: intent.kind, vault: intent.vault, sent: false, error: String(err?.message ?? err) };
    }
  }

  return { run, resolveCall };
}

/** A log-safe view of a resolved call: no salt, no signature, arguments stringified. */
function describe(call) {
  return {
    to: call.to,
    contract: call.contract,
    functionName: call.functionName,
    args: call.args.map((a) => (typeof a === 'bigint' ? a.toString() : typeof a === 'string' && /^0x[0-9a-fA-F]{64}$/.test(a) ? hexPreview(a) : a)),
  };
}
