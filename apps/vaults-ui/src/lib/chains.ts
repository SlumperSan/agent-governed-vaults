/**
 * The chains this app can connect a wallet to. Chain FACTS only (id, name, RPC, explorer, and the
 * native-currency shape a wallet needs for `wallet_addEthereumChain`) — never a contract address.
 * `chain-actions.ts` reads `usdc()` and `governance()` off the connected vault itself, so a wrong
 * address here can never steer a deposit or a vote at the wrong contract.
 *
 * TARGET_CHAIN defaults to Arc mainnet (5042) as of the Arc cutover — RWAlly's v1 vault
 * (cirBTC Vault, 0x4EAE5C6D753AAC0b4825d41c12e71f0a8bE579f6) is live there, so that is what a
 * member's wallet should connect to and what `wallet_addEthereumChain`/`wallet_switchEthereumChain`
 * request by default. USDC is Arc's native gas asset, with an 18-decimal native view AND a
 * 6-decimal ERC-20 view over the SAME pool of funds (contracts/config/arc-mainnet.json) — the two
 * views must never be summed or converted between; every deposit/approve amount this app sends
 * goes through the 6-decimal ERC-20 view, which `chain-actions.ts` reads off the connected vault
 * itself. Base Sepolia (contracts/config/base-sepolia.json, chainId 84532) remains here for local
 * dev and the UI smoke harness (`test/lib/ui-smoke-chain.mjs` forks it) — override with
 * `VITE_TARGET_CHAIN=base-sepolia` — but it is no longer the default a production build connects
 * to.
 */
import { defineChain } from 'viem';

export const BASE_SEPOLIA = defineChain({
  id: 84532,
  name: 'Base Sepolia',
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://sepolia.base.org'] } },
  blockExplorers: { default: { name: 'Basescan', url: 'https://sepolia.basescan.org' } },
  testnet: true,
});

/**
 * Arc mainnet. USDC is the native gas asset here (18-decimal native view, 6-decimal ERC-20 view
 * over one pool of funds — VaultCore.usdc() is the ERC-20 view, and deposit/approve amounts this
 * app sends are always in that 6-decimal unit, never the native one). RWAlly's v1 vault (cirBTC
 * Vault, 0x4EAE5C6D753AAC0b4825d41c12e71f0a8bE579f6) has been live here since 2026-09-24
 * (firstVault.createdAt, contracts/config/deployments/arc-mainnet.json) — see `.env.example` for
 * the deployed addresses this app reads by default.
 */
export const ARC_MAINNET = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' } },
});

export const CHAINS = { 'base-sepolia': BASE_SEPOLIA, arc: ARC_MAINNET } as const;
export type ChainKey = keyof typeof CHAINS;

const requested = (import.meta.env.VITE_TARGET_CHAIN as string | undefined)?.trim().toLowerCase();
export const TARGET_CHAIN_KEY: ChainKey = requested === 'base-sepolia' ? 'base-sepolia' : 'arc';
export const TARGET_CHAIN = CHAINS[TARGET_CHAIN_KEY];
