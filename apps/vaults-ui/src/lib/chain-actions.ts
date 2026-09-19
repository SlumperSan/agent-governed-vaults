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
  encodeAbiParameters,
  keccak256,
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
  /** `VaultCore.costBasisUsdc(member)` (P-O12) — `exit-preview.mjs`'s `previewExit` needs this to
   *  bound the performance-fee range; the six fields above predate it and never needed it. */
  readonly costBasisUsdc: bigint | null;
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
    read('costBasisUsdc', [member]),
  ]);
  const value = <T>(r: PromiseSettledResult<unknown>): T | null => (r.status === 'fulfilled' ? (r.value as T) : null);
  const [creator, sharesOf, totalShares, nonCreatorMemberCount, exitFeeMaxBps, exitFeeDecayPeriod, lastDepositTime, costBasisUsdc] = results;
  return {
    creator: value<Address>(creator),
    sharesOf: value<bigint>(sharesOf),
    totalShares: value<bigint>(totalShares),
    nonCreatorMemberCount: value<bigint>(nonCreatorMemberCount),
    exitFeeMaxBps: value<bigint>(exitFeeMaxBps),
    exitFeeDecayPeriod: value<bigint>(exitFeeDecayPeriod),
    lastDepositTime: value<bigint>(lastDepositTime),
    costBasisUsdc: value<bigint>(costBasisUsdc),
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
  const approvalHash = await walletClient.writeContract({
    address: usdc,
    abi: ERC20_WRITE_ABI,
    functionName: 'approve',
    args: [vault, amountUsdc],
    account,
    chain: TARGET_CHAIN,
  });
  await publicClient.waitForTransactionReceipt({ hash: approvalHash });
  const depositHash = await walletClient.writeContract({
    address: vault,
    abi: VAULT_WRITE_ABI,
    functionName: 'deposit',
    args: [amountUsdc],
    account,
    chain: TARGET_CHAIN,
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
  const commitHash = await walletClient.writeContract({
    address: governance,
    abi: GOVERNANCE_WRITE_ABI,
    functionName: 'commitVote',
    args: [BigInt(pid), commitment],
    account,
    chain: TARGET_CHAIN,
  });
  return { commitHash, commitment };
}

/** Reveal. Only callable from a `CUSTODY_READY` state — `canReveal` is the one predicate this
 * module trusts to say so; a `mismatch`/`unread`/`none`/`revealed` state throws rather than
 * guessing at a salt or a support value. */
export async function sendRevealVote(
  walletClient: WalletClient,
  account: Address,
  governance: Address,
  pid: bigint | number,
  state: VoteCustodyState,
): Promise<{ revealHash: Hex }> {
  if (!canReveal(state) || state.status !== 'ready') {
    throw new Error(`sendRevealVote: not safe to reveal from state '${state.status}' — ${state.detail}`);
  }
  const revealHash = await walletClient.writeContract({
    address: governance,
    abi: GOVERNANCE_WRITE_ABI,
    functionName: 'revealVote',
    args: [BigInt(pid), state.support, state.salt as Hex],
    account,
    chain: TARGET_CHAIN,
  });
  return { revealHash };
}

/** `requestExit` — queues (irrevocably) or settles instantly, entirely as a function of whether
 * the vault currently has a pending execution; see this file's header. */
export async function sendRequestExit(
  walletClient: WalletClient,
  account: Address,
  vault: Address,
  shares: bigint,
): Promise<{ exitHash: Hex }> {
  const exitHash = await walletClient.writeContract({
    address: vault,
    abi: VAULT_WRITE_ABI,
    functionName: 'requestExit',
    args: [shares],
    account,
    chain: TARGET_CHAIN,
  });
  return { exitHash };
}
