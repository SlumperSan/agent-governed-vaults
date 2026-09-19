/**
 * The chains this app can connect a wallet to. Chain FACTS only (id, name, RPC, explorer, and the
 * native-currency shape a wallet needs for `wallet_addEthereumChain`) — never a contract address.
 * `chain-actions.ts` reads `usdc()` and `governance()` off the connected vault itself, so a wrong
 * address here can never steer a deposit or a vote at the wrong contract.
 *
 * TARGET_CHAIN defaults to Base Sepolia, not Arc. Arc mainnet (5042) is the eventual production
 * chain — USDC is its native gas asset, with an 18-decimal native view AND a 6-decimal ERC-20 view
 * over the SAME pool of funds (contracts/config/arc-mainnet.json) — but nothing from this
 * repository is deployed there yet (that file's own `status` field says so in as many words). The
 * smoke harness this card closes on runs against Base Sepolia (contracts/config/base-sepolia.json,
 * chainId 84532), which does have a live VaultFactory deployment, so that is what a member can
 * actually deposit into, vote in, or exit from today. Override with `VITE_TARGET_CHAIN=arc` once
 * Arc carries a deployment — nothing else in this module needs to change.
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
 * app sends are always in that 6-decimal unit, never the native one). No deployment exists here
 * yet; selecting this chain lets a wallet connect and switch to it, nothing more, until a vault is
 * deployed and its address is known.
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
export const TARGET_CHAIN_KEY: ChainKey = requested === 'arc' ? 'arc' : 'base-sepolia';
export const TARGET_CHAIN = CHAINS[TARGET_CHAIN_KEY];
