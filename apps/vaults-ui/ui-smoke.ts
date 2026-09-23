/**
 * Not shipped — the UI-level counterpart to `ssr-smoke.tsx`. Where that file proves the app
 * RENDERS correctly, this file proves the three signed flows card 176 gates the first deposit on
 * — deposit, vote (commit then reveal), exit — actually WORK, by calling the real,
 * unmodified `sendDeposit`/`sendCommitVote`/`sendRevealVote`/`sendRequestExit` from
 * `src/lib/chain-actions.ts` against a real local chain, through a real viem `walletClient` built
 * exactly the way `src/lib/wallet.tsx` builds one (`createWalletClient({ chain: TARGET_CHAIN,
 * transport: custom(provider) })`).
 *
 * Built the same way `ssr-smoke.tsx` is (`vite build --ssr ui-smoke.ts`), which is what resolves
 * `chain-actions.ts`'s `@chain/*`/`@atlas/*` aliases exactly as production does —
 * `apps/vaults-ui/test/simulate-before-sign.test.mjs`'s own header records that `node --test` alone
 * cannot import this file, which is why this bundle-and-run split exists at all.
 *
 * WHAT THIS DOES NOT EXERCISE, stated plainly rather than left implicit: `wallet.tsx`'s EIP-6963
 * discovery (nothing here announces or listens for a provider — the walletClient is built directly
 * against a provider this file constructs) and `MemberActions.tsx`'s React rendering/button-disable
 * gating (covered separately, and only partially, by the existing `apps/vaults-ui/test/*.test.mjs`
 * source guards). What it DOES exercise is the part those cannot reach: the actual signed calldata
 * `chain-actions.ts` builds, `simulateThenWrite`'s eth_call-before-send, and whether the deployed
 * VaultCore/Governance bytecode actually accepts it — see the harness's own findings note for the
 * full "what this proves / cannot prove" table.
 *
 * ENV CONTRACT (all required unless noted) — set by
 * `apps/vaults-ui/test/ui-smoke.test.mjs`, never typed by a human:
 *   UI_SMOKE_RPC_URL          local anvil fork this run talks to
 *   UI_SMOKE_PRIVATE_KEY      throwaway signer (see ui-smoke-chain.mjs's header)
 *   UI_SMOKE_VAULT            vault address under test
 *   UI_SMOKE_ACTION           'deposit' | 'commit' | 'reveal' | 'exit'
 *   UI_SMOKE_AMOUNT_USDC      deposit/exit: raw USDC units (deposit) or share units (exit)
 *   UI_SMOKE_PID              commit/reveal: proposal id
 *   UI_SMOKE_SUPPORT          commit: 'true' | 'false'
 *   UI_SMOKE_CHAIN_ID_OVERRIDE  optional: MUTATION HOOK, see ui-smoke-provider.mjs
 */
import { createPublicClient, createWalletClient, custom, type Address } from 'viem';
import { TARGET_CHAIN } from './src/lib/chains';
import {
  readVaultAddresses,
  readVoteCustody,
  sendCommitVote,
  sendDeposit,
  sendRequestExit,
  sendRevealVote,
} from './src/lib/chain-actions';
import { createRecordingProvider } from './test/lib/ui-smoke-provider.mjs';
import { privateKeyToAccount } from 'viem/accounts';

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`ui-smoke.ts: required env var ${name} is not set`);
  return v;
}

// Module scope, not main()'s, so the failure handler below can still print whatever the log
// captured up to the point of the throw — a negative-control scenario needs the log even (in fact
// especially) when the action fails.
let log: unknown[] = [];

async function main() {
  const rpcUrl = env('UI_SMOKE_RPC_URL');
  const privateKey = env('UI_SMOKE_PRIVATE_KEY') as `0x${string}`;
  const vault = env('UI_SMOKE_VAULT') as Address;
  const action = env('UI_SMOKE_ACTION');
  const chainIdOverrideRaw = process.env.UI_SMOKE_CHAIN_ID_OVERRIDE;
  const chainIdOverride = chainIdOverrideRaw ? Number(chainIdOverrideRaw) : undefined;

  const account = privateKeyToAccount(privateKey);
  const recording = createRecordingProvider({ rpcUrl, account, chainIdOverride });
  const provider = recording.provider;
  log = recording.log;

  // walletClient is built EXACTLY the way wallet.tsx builds one (same TARGET_CHAIN, same
  // custom(provider) transport shape) — the one difference is the transport target, which here is
  // the local fork instead of the real https://sepolia.base.org wallet.tsx hardcodes, since this
  // harness has no browser/network layer to intercept that hardcoded URL through.
  //
  // publicClient ALSO routes through the recording provider here, which is a deliberate departure
  // from wallet.tsx: production builds a SEPARATE plain-http publicClient for reads ("independent
  // of any connected wallet" — see that file's own comment), so in the real app the simulateContract
  // eth_call and the writeContract eth_sendTransaction travel over two different transports and
  // this harness cannot observe both through one wallet-provider log if it copied that split. Both
  // still hit the same real anvil node and the same real bytecode either way — this only changes
  // WHICH object the harness's own log sees the eth_call through, not what chain-actions.ts calls
  // or what the call does. See ui-smoke-provider.mjs: unrecognized methods (eth_call included) are
  // a pure pass-through to the RPC, never answered by the provider itself.
  const publicClient = createPublicClient({ chain: TARGET_CHAIN, transport: custom(provider) });
  const walletClient = createWalletClient({ chain: TARGET_CHAIN, transport: custom(provider) });

  const { governance } = await readVaultAddresses(publicClient, vault);

  let result: unknown;
  if (action === 'deposit') {
    const amount = BigInt(env('UI_SMOKE_AMOUNT_USDC'));
    result = await sendDeposit(publicClient, walletClient, account.address, vault, amount);
  } else if (action === 'commit') {
    const pid = BigInt(env('UI_SMOKE_PID'));
    const support = env('UI_SMOKE_SUPPORT') === 'true';
    result = await sendCommitVote(publicClient, walletClient, account.address, governance, vault, pid, support);
  } else if (action === 'reveal') {
    const pid = BigInt(env('UI_SMOKE_PID'));
    // Re-derives the salt from the same wallet signature `sendCommitVote` used — never read from
    // storage — the exact property `chain-actions.ts`'s own header names as the requirement.
    const custody = await readVoteCustody(publicClient, walletClient, account.address, governance, vault, pid);
    result = await sendRevealVote(publicClient, walletClient, account.address, governance, pid, custody);
  } else if (action === 'exit') {
    const shares = BigInt(env('UI_SMOKE_AMOUNT_USDC'));
    result = await sendRequestExit(publicClient, walletClient, account.address, vault, shares);
  } else {
    throw new Error(`ui-smoke.ts: unknown UI_SMOKE_ACTION '${action}'`);
  }

  console.log(`UI_SMOKE_RESULT ${JSON.stringify({ ok: true, action, result: jsonSafe(result), log })}`);
}

/** bigint -> string, so JSON.stringify does not throw on a hash-adjacent bigint field. */
function jsonSafe(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val)));
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  // `log` is module-scope precisely so this branch can emit whatever the recording provider
  // captured up to the throw (see the comment at its declaration) — a negative-control scenario
  // (e.g. the chain-id-mismatch mutation) needs the real log even, in fact especially, when the
  // action fails, so the test can assert nothing reached the chain rather than assuming it.
  console.log(`UI_SMOKE_RESULT ${JSON.stringify({ ok: false, error: message, log })}`);
  process.exitCode = 1;
});
