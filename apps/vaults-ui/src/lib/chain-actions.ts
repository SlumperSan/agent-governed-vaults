/**
 * The three signed flows this card adds: deposit, vote (commit then reveal), exit. Every write
 * goes through a connected wallet's own `walletClient.writeContract`/`signMessage` — this module
 * holds no key and broadcasts nothing on its own initiative.
 *
 * ABI fragments and the salt scheme are BORROWED, not redefined — see vite.config.ts's header for
 * why, and `packages/reference-agent/src/act.mjs` / `salt.mjs` for the originals this app's
 * `@chain/act` alias and `apps/web/src/vote-custody.mjs` (`@atlas/vote-custody`) mirror.
 *
 * `deposit(uint256)`, NOT `deposit(uint256,uint256)`. VaultCore has both (VaultCore.sol:392-403);
 * the two-argument overload adds `minSharesOut` slippage protection (M-15) on the immediate-mint
 * path only — a first-time deposit is escrowed pending and prices at ACTIVATION regardless, so
 * `minSharesOut` cannot protect that path either way, live NAV or not. This app now reads live NAV
 * (`src/lib/live-vaults.ts`, plan item 0.7, merged into this branch after this file was written —
 * the claim here used to be that no live number existed yet to compute a tolerance from; that is
 * no longer true for a REPEAT deposit on the immediate-mint path, only for a first one). Wiring
 * `minSharesOut` for that case is still not this card: it needs its own slippage-tolerance UI and
 * its own review, not a silent behavior change riding along with a merge. `packages/reference-agent`'s
 * actor (the other signer of this exact call) makes the same one-argument choice — see
 * `VAULT_WRITE_ABI` in act.mjs, which declares only that fragment.
 *
 * `requestExit` is IRREVOCABLE once it queues (a proposal past its commit deadline turns the call
 * into a Mode-F queue, VaultCore.sol:551-567) — there is no cancel. This module does not decide
 * whether that applies; the caller (MemberActions.tsx) is responsible for warning before the
 * signature is requested, and mutation-testing that warning is part of this card's own gate.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  keccak256,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { VAULT_WRITE_ABI, ERC20_WRITE_ABI, GOVERNANCE_WRITE_ABI } from '@chain/act';
import { VAULT_VIEWS, GOVERNANCE_VIEWS } from '@chain/abis';
import { canReveal, commitmentFor, deriveSalt, reconstructVoteCustody, type VoteCustodyState } from '@atlas/vote-custody';
import { assembleVoteCommit, planVoteCommit, type PlannedCall } from '@atlas/chain-reader';
import { TARGET_CHAIN } from './chains';

/** Every field is independently nullable: `readExitGateInputs` resolves each read on its own
 * (`Promise.allSettled`, not `Promise.all`), so one reverting call — an older vault, a transient
 * RPC error — cannot null the other six. `wallet-refusals.mjs`'s `creatorGateRefusal` and
 * `exitFeeCeiling` already accept a per-field `null` and resolve to 'unknown' only for the fields
 * that actually failed, which is the whole reason this is safe to pass straight through rather
 * than gating on "every field present". */
export interface ExitGateInputs {
  readonly creator: Address | null;
  readonly sharesOf: bigint | null;
  readonly totalShares: bigint | null;
  readonly nonCreatorMemberCount: bigint | null;
  readonly exitFeeMaxBps: bigint | null;
  readonly exitFeeDecayPeriod: bigint | null;
  readonly lastDepositTime: bigint | null;
}

const READ_TABLES: Record<string, typeof VAULT_VIEWS> = { VAULT_VIEWS, GOVERNANCE_VIEWS };

/** Execute one `PlannedCall` (chain-reader.mjs's shape) against a live public client. */
async function readPlanned(publicClient: PublicClient, call: PlannedCall): Promise<unknown> {
  const abi = READ_TABLES[call.abi];
  if (!abi) throw new Error(`chain-actions: unknown ABI table '${call.abi}'`);
  return publicClient.readContract({
    address: call.address as Address,
    abi,
    functionName: call.fn,
    args: call.args as readonly unknown[],
  });
}

/** A `walletClient`'s `signMessage`, bound to one connected account — what every salt derivation needs. */
function signerFor(walletClient: WalletClient, account: Address) {
  return async ({ message }: { message: string }) => walletClient.signMessage({ account, message });
}

// ─────────────────────────────────────── reads ───────────────────────────────────────

/** `VaultCore.usdc()` and `.governance()` — read off the vault itself, never hardcoded per chain
 * (see chains.ts's header for why: Arc's dual-decimals USDC view makes a copied address a live
 * hazard, not just a maintenance one). */
export async function readVaultAddresses(
  publicClient: PublicClient,
  vault: Address,
): Promise<{ usdc: Address; governance: Address }> {
  const [usdc, governance] = await Promise.all([
    publicClient.readContract({ address: vault, abi: VAULT_VIEWS, functionName: 'usdc' }) as Promise<Address>,
    publicClient.readContract({ address: vault, abi: VAULT_VIEWS, functionName: 'governance' }) as Promise<Address>,
  ]);
  return { usdc, governance };
}

/** A member's current share balance — used to prefill "exit all" rather than to gate anything. */
export async function readMemberShares(publicClient: PublicClient, vault: Address, member: Address): Promise<bigint> {
  return publicClient.readContract({
    address: vault,
    abi: VAULT_VIEWS,
    functionName: 'sharesOf',
    args: [member],
  }) as Promise<bigint>;
}

/** Governance's own answer: would `requestExit` on this vault settle now (Mode I) or queue
 * irrevocably (Mode F)? Read live, immediately before an exit is offered — see abis.mjs's
 * `hasPendingExecution` entry for why this is not reconstructed from proposal deadlines here. */
export async function readHasPendingExecution(
  publicClient: PublicClient,
  governance: Address,
  vault: Address,
): Promise<boolean> {
  return publicClient.readContract({
    address: governance,
    abi: GOVERNANCE_VIEWS,
    functionName: 'hasPendingExecution',
    args: [vault],
  }) as Promise<boolean>;
}

/**
 * The seven reads `apps/web/src/wallet-refusals.mjs`'s `creatorGateRefusal` and `exitFeeCeiling`
 * need, read together so a caller building an exit warning never has to reconcile timing across
 * separate round trips itself. `burnShares` — how many shares THIS exit would burn — is the one
 * input the refusal check needs that is not a chain read; the caller (MemberActions.tsx) supplies
 * it from the amount the member typed.
 */
export async function readExitGateInputs(
  publicClient: PublicClient,
  vault: Address,
  member: Address,
): Promise<ExitGateInputs> {
  const read = (functionName: string, args: readonly unknown[] = []) =>
    publicClient.readContract({ address: vault, abi: VAULT_VIEWS, functionName, args });
  // allSettled, deliberately not all: one revert (an older vault missing a view, a transient RPC
  // error on one call) must resolve to that ONE field being unknown, not the whole exit gate.
  const results = await Promise.allSettled([
    read('creator'),
    read('sharesOf', [member]),
    read('totalShares'),
    read('nonCreatorMemberCount'),
    read('exitFeeMaxBps'),
    read('exitFeeDecayPeriod'),
    read('lastDepositTime', [member]),
  ]);
  const value = <T>(r: PromiseSettledResult<unknown>): T | null => (r.status === 'fulfilled' ? (r.value as T) : null);
  const [creator, sharesOf, totalShares, nonCreatorMemberCount, exitFeeMaxBps, exitFeeDecayPeriod, lastDepositTime] = results;
  return {
    creator: value<Address>(creator),
    sharesOf: value<bigint>(sharesOf),
    totalShares: value<bigint>(totalShares),
    nonCreatorMemberCount: value<bigint>(nonCreatorMemberCount),
    exitFeeMaxBps: value<bigint>(exitFeeMaxBps),
    exitFeeDecayPeriod: value<bigint>(exitFeeDecayPeriod),
    lastDepositTime: value<bigint>(lastDepositTime),
  };
}

export interface DepositStatusInputs {
  readonly pendingAmountUsdc: bigint;
  readonly availableAt: number;
  readonly sharesOf: bigint;
}

/** `VaultCore.pendingDeposit(member)` + `sharesOf(member)` — the two reads
 * `apps/web/src/deposit-status.mjs`'s `classifyDepositStatus` needs; `now` is supplied by the
 * caller so this stays a plain chain read with no wall-clock opinion of its own. */
export async function readDepositStatusInputs(
  publicClient: PublicClient,
  vault: Address,
  member: Address,
): Promise<DepositStatusInputs> {
  const [pending, sharesOf] = await Promise.all([
    publicClient.readContract({
      address: vault,
      abi: VAULT_VIEWS,
      functionName: 'pendingDeposit',
      args: [member],
    }) as Promise<readonly [bigint, number]>,
    publicClient.readContract({ address: vault, abi: VAULT_VIEWS, functionName: 'sharesOf', args: [member] }) as Promise<bigint>,
  ]);
  return { pendingAmountUsdc: pending[0], availableAt: Number(pending[1]), sharesOf };
}

/**
 * This member's commit/reveal state for one proposal, from chain reads alone — survives a reload
 * because nothing about it is read from local storage. Each of the three reads is caught
 * independently: a revert or a dropped call becomes `undefined`, which `assembleVoteCommit` and
 * then `reconstructVoteCustody` treat as UNREAD rather than as "no commit" (see vote-custody.mjs's
 * module header — that conflation is the exact bug this design exists to prevent).
 */
export async function readVoteCustody(
  publicClient: PublicClient,
  walletClient: WalletClient,
  account: Address,
  governance: Address,
  vault: Address,
  pid: bigint | number,
): Promise<VoteCustodyState> {
  const [commitOfValue, revealedValue, revealedSupportValue] = await Promise.all(
    planVoteCommit(governance, pid, account).map((call) => readPlanned(publicClient, call).catch(() => undefined)),
  );
  const { onChainCommitment, revealed, revealedSupport } = assembleVoteCommit({
    commitOfValue,
    revealedValue,
    revealedSupportValue,
  });
  return reconstructVoteCustody({
    chainId: TARGET_CHAIN.id,
    vault,
    pid,
    voter: account,
    onChainCommitment,
    revealed,
    revealedSupport,
    signMessage: signerFor(walletClient, account),
    keccak256,
    encodeAbiParameters,
  });
}

// ─────────────────────────────────────── writes ───────────────────────────────────────

/**
 * Every custom error `VaultCore`/`Governance` can revert with, reachable directly or through
 * `_settleExit`/`_checkCreatorGate`/`navWad` (`StaleOracle`) from the five calls below. Declared
 * ONLY for revert decoding, never for encoding a call — `VAULT_WRITE_ABI`/`GOVERNANCE_WRITE_ABI`
 * stay the narrow, borrowed fragments they already were. A superset here is safe (an error this
 * write path can never actually hit just never matches); a SUBSET would silently under-decode a
 * real revert back into a raw selector, which is the exact "wallet-level revert" failure mode
 * simulate-before-sign exists to remove — so this is copied whole from each contract's own `error`
 * declarations (`VaultCore.sol`, `Governance.sol`, `IOracleAggregator.sol`), PLUS every error
 * declared by a library VaultCore.sol binds via `using` (`contracts/src/lib/*.sol` — currently
 * `SafeTransferLib`, `Checkpoints`, `BoundedCall`; `BoundedCall` declares none today). A revert
 * that bubbles up from inside a `using`-bound library is still a revert on VaultCore's own call
 * frame — `deposit()`'s `usdc.safeTransferFrom(...)` at VaultCore.sol:420 is exactly this shape —
 * so those errors belong in the same decode set, not hand-picked by tracing which branch each
 * call can reach. The coupling guard (`test/simulate-before-sign.test.mjs`) re-derives the
 * library list from VaultCore.sol's own `using` declarations rather than trusting this comment,
 * so a future added library is caught even if this list is not updated by hand.
 */
const KNOWN_ERRORS_ABI = [
  // VaultCore.sol
  { type: 'error', name: 'Reentrancy', inputs: [] },
  { type: 'error', name: 'ZeroAmount', inputs: [] },
  { type: 'error', name: 'BelowMinDeposit', inputs: [] },
  { type: 'error', name: 'CapacityExceeded', inputs: [] },
  { type: 'error', name: 'PendingExists', inputs: [] },
  { type: 'error', name: 'NoPending', inputs: [] },
  { type: 'error', name: 'WindowNotElapsed', inputs: [] },
  { type: 'error', name: 'AlreadyOptedIn', inputs: [] },
  { type: 'error', name: 'InsufficientShares', inputs: [] },
  { type: 'error', name: 'ExitAlreadyQueued', inputs: [] },
  { type: 'error', name: 'SlippageExceeded', inputs: [] },
  { type: 'error', name: 'NoQueuedExit', inputs: [] },
  { type: 'error', name: 'ExecutionStillPending', inputs: [] },
  { type: 'error', name: 'CreatorStakeGate', inputs: [] },
  { type: 'error', name: 'NothingToClaim', inputs: [] },
  { type: 'error', name: 'BadConfig', inputs: [] },
  { type: 'error', name: 'OnlyGovernance', inputs: [] },
  { type: 'error', name: 'AdapterNotAllowed', inputs: [] },
  { type: 'error', name: 'BadSwapToken', inputs: [] },
  { type: 'error', name: 'InsufficientAssetBalance', inputs: [] },
  { type: 'error', name: 'SwapSlippage', inputs: [] },
  { type: 'error', name: 'MinOutTooLow', inputs: [] },
  { type: 'error', name: 'BadSlippageBound', inputs: [] },
  { type: 'error', name: 'NotRegisteredChild', inputs: [] },
  { type: 'error', name: 'TooManyChildren', inputs: [] },
  { type: 'error', name: 'ChildSettlementPending', inputs: [] },
  { type: 'error', name: 'ExitNeedsChildSettlement', inputs: [] },
  // Governance.sol
  { type: 'error', name: 'OnlyDeployer', inputs: [] },
  { type: 'error', name: 'AlreadyWiredSubRegistry', inputs: [] },
  { type: 'error', name: 'ZeroSubRegistry', inputs: [] },
  { type: 'error', name: 'AlreadyRegistered', inputs: [] },
  { type: 'error', name: 'NotRegistered', inputs: [] },
  { type: 'error', name: 'NotVaultCreator', inputs: [] },
  { type: 'error', name: 'BadGovConfig', inputs: [] },
  { type: 'error', name: 'ProposalActive', inputs: [] },
  { type: 'error', name: 'NoActiveProposal', inputs: [] },
  { type: 'error', name: 'BelowProposalThreshold', inputs: [] },
  { type: 'error', name: 'Cooldown', inputs: [] },
  { type: 'error', name: 'WrongPhase', inputs: [] },
  { type: 'error', name: 'NoWeight', inputs: [] },
  { type: 'error', name: 'AlreadyCommitted', inputs: [] },
  { type: 'error', name: 'NoCommit', inputs: [] },
  { type: 'error', name: 'BadReveal', inputs: [] },
  { type: 'error', name: 'AlreadyRevealed', inputs: [] },
  { type: 'error', name: 'NotRebalance', inputs: [] },
  { type: 'error', name: 'DefaultUnavailable', inputs: [] },
  { type: 'error', name: 'HasDelegate', inputs: [] },
  { type: 'error', name: 'DelegateNotRevealed', inputs: [] },
  { type: 'error', name: 'ConcentrationCap', inputs: [] },
  { type: 'error', name: 'NotPassed', inputs: [] },
  { type: 'error', name: 'TimelockActive', inputs: [] },
  { type: 'error', name: 'ExecutionWindowOver', inputs: [] },
  { type: 'error', name: 'BadPayload', inputs: [] },
  { type: 'error', name: 'CannotDelegateDuringProposal', inputs: [] },
  // IOracleAggregator.sol -- navWad() reaches this from _deposit and _settleExit alike
  { type: 'error', name: 'StaleOracle', inputs: [{ name: 'asset', type: 'address' }] },
  // contracts/src/lib/SafeTransferLib.sol -- `using SafeTransferLib for address;` (VaultCore.sol:39).
  // deposit()'s usdc.safeTransferFrom(...) (VaultCore.sol:420) can revert TransferFromFailed directly
  // on this call frame; the other two are reachable from the same bound library.
  { type: 'error', name: 'TransferFailed', inputs: [{ name: 'token', type: 'address' }] },
  { type: 'error', name: 'TransferFromFailed', inputs: [{ name: 'token', type: 'address' }] },
  { type: 'error', name: 'ApproveFailed', inputs: [{ name: 'token', type: 'address' }] },
  // contracts/src/lib/Checkpoints.sol -- `using Checkpoints for Checkpoints.History;` (VaultCore.sol:40).
  { type: 'error', name: 'ValueOverflow', inputs: [] },
  // contracts/src/lib/BoundedCall.sol -- `using BoundedCall for address;` (VaultCore.sol:41) declares
  // no `error`s today; nothing to add here, but the coupling guard still scans it so a future one
  // added there is caught rather than silently missing from decode.
] as const satisfies Abi;

/** The message a member sees for a revert this module could not name. Never invented text pretending
 *  to be a decoded reason -- an unnamed revert stays visibly unnamed. */
function describeRevert(err: unknown): string {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      if (name) return name;
    }
    return err.shortMessage ?? err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * SIMULATE, THEN SIGN. Every write in this module goes through this rather than calling
 * `walletClient.writeContract` directly. `publicClient.simulateContract` runs the call as an
 * `eth_call` first -- same calldata, same block, no signature -- so a revert that would otherwise
 * surface only AFTER a member has signed and paid gas (or, worse, after it mines) is caught before
 * the wallet is ever asked to sign. This is the fix for the class of defect named in the frontend
 * security pass (row A17/B12): "use full balance" overscaling and a repeat deposit inside the
 * observation window were each individually caught and fixed; simulate-before-sign catches that
 * whole class rather than requiring the next one to be anticipated and hand-coded as its own
 * app-level refusal check.
 *
 * On a REVERT, throws with the decoded custom error name (`StaleOracle`, `PendingExists`,
 * `CreatorStakeGate`, ...) when the ABI above can decode it, or the wallet/RPC's own message
 * otherwise -- never a guess. The caller (`MemberActions.tsx`) is responsible for turning that
 * name into member-facing copy; this module's job stops at "which error, if any".
 */
async function simulateThenWrite<T extends { abi: Abi; functionName: string; args: readonly unknown[] }>(
  publicClient: PublicClient,
  walletClient: WalletClient,
  params: T & { address: Address; account: Address },
): Promise<Hex> {
  let request: unknown;
  try {
    ({ request } = await publicClient.simulateContract({
      ...params,
      abi: [...params.abi, ...KNOWN_ERRORS_ABI] as Abi,
      chain: TARGET_CHAIN,
    } as Parameters<PublicClient['simulateContract']>[0]));
  } catch (err) {
    throw new Error(`${params.functionName} would revert: ${describeRevert(err)}`);
  }
  return walletClient.writeContract(request as Parameters<WalletClient['writeContract']>[0]);
}

export interface DepositResult {
  readonly approvalHash: Hex;
  readonly depositHash: Hex;
}

/** Approve, then deposit, in sequence — the same order `scripts/smoke-test.mjs`'s `stepDeposit`
 * and `packages/reference-agent/src/act.mjs`'s `deposit` intent both use. Waits for the approval
 * receipt before sending the deposit: `VaultCore.deposit` pulls with `safeTransferFrom` in the
 * SAME block the allowance must already be visible in, and an unconfirmed approval racing a
 * deposit is exactly the shape of bug a receipt wait exists to rule out. */
export async function sendDeposit(
  publicClient: PublicClient,
  walletClient: WalletClient,
  account: Address,
  vault: Address,
  amountUsdc: bigint,
): Promise<DepositResult> {
  const { usdc } = await readVaultAddresses(publicClient, vault);
  const approvalHash = await simulateThenWrite(publicClient, walletClient, {
    address: usdc,
    abi: ERC20_WRITE_ABI,
    functionName: 'approve',
    args: [vault, amountUsdc],
    account,
  });
  await publicClient.waitForTransactionReceipt({ hash: approvalHash });
  const depositHash = await simulateThenWrite(publicClient, walletClient, {
    address: vault,
    abi: VAULT_WRITE_ABI,
    functionName: 'deposit',
    args: [amountUsdc],
    account,
  });
  return { approvalHash, depositHash };
}

/**
 * Commit a vote. The salt is DERIVED from a wallet signature and returned to the caller for
 * display only — nothing here writes it to storage, and nothing needs to: `readVoteCustody` +
 * `sendRevealVote` re-derive it from the same signature after any reload, restart, or device
 * change (the requirement this card names explicitly — see `apps/web/src/vote-custody.mjs`).
 */
export async function sendCommitVote(
  publicClient: PublicClient,
  walletClient: WalletClient,
  account: Address,
  governance: Address,
  vault: Address,
  pid: bigint | number,
  support: boolean,
): Promise<{ commitHash: Hex; commitment: Hex }> {
  const salt = await deriveSalt({
    signMessage: signerFor(walletClient, account),
    chainId: TARGET_CHAIN.id,
    vault,
    pid,
    keccak256,
  });
  const commitment = (await commitmentFor({ pid, voter: account, support, salt, keccak256, encodeAbiParameters })) as Hex;
  const commitHash = await simulateThenWrite(publicClient, walletClient, {
    address: governance,
    abi: GOVERNANCE_WRITE_ABI,
    functionName: 'commitVote',
    args: [BigInt(pid), commitment],
    account,
  });
  return { commitHash, commitment };
}

/** Reveal. Only callable from a `CUSTODY_READY` state — `canReveal` is the one predicate this
 * module trusts to say so; a `mismatch`/`unread`/`none`/`revealed` state throws rather than
 * guessing at a salt or a support value. */
export async function sendRevealVote(
  publicClient: PublicClient,
  walletClient: WalletClient,
  account: Address,
  governance: Address,
  pid: bigint | number,
  state: VoteCustodyState,
): Promise<{ revealHash: Hex }> {
  if (!canReveal(state) || state.status !== 'ready') {
    throw new Error(`sendRevealVote: not safe to reveal from state '${state.status}' — ${state.detail}`);
  }
  const revealHash = await simulateThenWrite(publicClient, walletClient, {
    address: governance,
    abi: GOVERNANCE_WRITE_ABI,
    functionName: 'revealVote',
    args: [BigInt(pid), state.support, state.salt as Hex],
    account,
  });
  return { revealHash };
}

/** `requestExit` — queues (irrevocably) or settles instantly, entirely as a function of whether
 * the vault currently has a pending execution; see this file's header. */
export async function sendRequestExit(
  publicClient: PublicClient,
  walletClient: WalletClient,
  account: Address,
  vault: Address,
  shares: bigint,
): Promise<{ exitHash: Hex }> {
  const exitHash = await simulateThenWrite(publicClient, walletClient, {
    address: vault,
    abi: VAULT_WRITE_ABI,
    functionName: 'requestExit',
    args: [shares],
    account,
  });
  return { exitHash };
}
