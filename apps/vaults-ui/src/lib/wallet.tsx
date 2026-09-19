/**
 * Wallet connect — EIP-6963 provider discovery, with a legacy EIP-1193 (`window.ethereum`)
 * fallback for a wallet that does not yet announce itself.
 *
 * BUY / BORROW / BUILD, restated here because this is the file the decision governs. This app has
 * two runtime dependencies before this card (react, react-dom); SWARM.md §5 says keep it light and
 * add nothing for "future-proofing". EIP-6963 discovery is ~30 lines over two DOM events with no
 * dependency of its own, and viem (already a root dependency, `^2.21.0`, unused by any workspace
 * until this card) supplies `createWalletClient`/`createPublicClient` over a `custom()` transport
 * that wraps that provider directly — no separate transport or account-abstraction layer needed
 * for an EOA browser wallet. A connector library (wagmi / RainbowKit / web3-onboard) was
 * considered and rejected FOR THIS SURFACE: they pull in a chain-caching layer, a React Query
 * dependency tree, and a chain-list default set this repo does not want vendored, to do less than
 * this file does for the one wallet flow the card asks for (connect, sign three transaction kinds).
 * "None found that fits this scope" is the honest verdict, not "none searched" — see the PR body's
 * Buy/borrow/build section for what was read before landing here.
 *
 * STANDARDS: EIP-1193 (Ethereum Provider JavaScript API) for `request`/events, EIP-6963 (Multi
 * Injected Provider Discovery) for finding more than one installed wallet without colliding on
 * `window.ethereum`. Falls back to bare EIP-1193 `window.ethereum` for a wallet that predates 6963
 * and never announces.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPublicClient, createWalletClient, custom, http, type PublicClient, type WalletClient } from 'viem';
import { TARGET_CHAIN } from './chains';

/** EIP-1193. Only the surface this app calls. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

/** EIP-6963 `EIP6963ProviderInfo` + the provider it announces alongside. */
export interface DiscoveredProvider {
  readonly uuid: string;
  readonly name: string;
  readonly icon: string;
  readonly rdns: string;
  readonly provider: Eip1193Provider;
}

interface Eip6963AnnounceEvent extends Event {
  readonly detail?: { info?: { uuid?: string; name?: string; icon?: string; rdns?: string }; provider?: Eip1193Provider };
}

declare global {
  interface WindowEventMap {
    'eip6963:announceProvider': Eip6963AnnounceEvent;
  }
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export type WalletStatus = 'disconnected' | 'connecting' | 'connected' | 'wrong-network' | 'switching';

export interface WalletState {
  readonly status: WalletStatus;
  readonly address: string | null;
  readonly chainId: number | null;
  readonly providers: readonly DiscoveredProvider[];
  readonly error: string | null;
  /** Always available, independent of connection — chain reads need no wallet. */
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient | null;
  connect(uuid?: string): Promise<void>;
  disconnect(): void;
  switchToTarget(): Promise<void>;
}

const WalletContext = createContext<WalletState | null>(null);

/** Independent of any connected wallet — reads work before, during, and after a connection. */
const publicClient: PublicClient = createPublicClient({ chain: TARGET_CHAIN, transport: http() });

/** `0x` + hex chain id -> number, the shape both `eth_chainId` and `chainChanged` return. */
const hexToNumber = (hex: unknown): number | null =>
  typeof hex === 'string' && /^0x[0-9a-fA-F]+$/.test(hex) ? Number.parseInt(hex, 16) : null;

export function WalletProvider({ children }: { children: ReactNode }) {
  const [providers, setProviders] = useState<readonly DiscoveredProvider[]>([]);
  const [activeUuid, setActiveUuid] = useState<string | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [status, setStatus] = useState<WalletStatus>('disconnected');
  const [error, setError] = useState<string | null>(null);

  // EIP-6963 discovery. Announcements can arrive any time (a wallet extension finishing its own
  // init), so the listener stays mounted for the app's lifetime rather than firing once.
  useEffect(() => {
    function onAnnounce(e: Eip6963AnnounceEvent) {
      const info = e.detail?.info;
      const provider = e.detail?.provider;
      if (!info?.uuid || !info.rdns || !provider) return;
      setProviders((prev) => (prev.some((p) => p.uuid === info.uuid) ? prev : [
        ...prev,
        { uuid: info.uuid!, name: info.name ?? info.rdns!, icon: info.icon ?? '', rdns: info.rdns!, provider },
      ]));
    }
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    return () => window.removeEventListener('eip6963:announceProvider', onAnnounce);
  }, []);

  const activeProvider = useMemo<Eip1193Provider | null>(() => {
    const fromDiscovery = providers.find((p) => p.uuid === activeUuid)?.provider;
    if (fromDiscovery) return fromDiscovery;
    // Legacy fallback: only once discovery has had a turn to announce (a page tick), and only if
    // nothing did — a wallet that supports 6963 should always be reached through it, never both.
    return activeUuid === LEGACY_UUID ? window.ethereum ?? null : null;
  }, [providers, activeUuid]);

  const walletClient = useMemo<WalletClient | null>(
    () => (activeProvider ? createWalletClient({ chain: TARGET_CHAIN, transport: custom(activeProvider) }) : null),
    [activeProvider],
  );

  // Track account/chain changes on whichever provider is active.
  useEffect(() => {
    if (!activeProvider?.on) return;
    const onAccounts = (...args: unknown[]) => {
      const accounts = args[0] as string[] | undefined;
      const next = accounts?.[0] ?? null;
      setAddress(next);
      if (!next) setStatus('disconnected');
    };
    const onChain = (...args: unknown[]) => {
      const next = hexToNumber(args[0]);
      setChainId(next);
      setStatus((s) => (s === 'connected' || s === 'wrong-network') ? (next === TARGET_CHAIN.id ? 'connected' : 'wrong-network') : s);
    };
    activeProvider.on('accountsChanged', onAccounts);
    activeProvider.on('chainChanged', onChain);
    return () => {
      activeProvider.removeListener?.('accountsChanged', onAccounts);
      activeProvider.removeListener?.('chainChanged', onChain);
    };
  }, [activeProvider]);

  const connect = useCallback(async (uuid?: string) => {
    setError(null);
    const target = uuid ?? providers[0]?.uuid ?? (window.ethereum ? LEGACY_UUID : null);
    if (!target) {
      setError('No wallet found. Install a browser wallet extension (EIP-1193/EIP-6963) and reload.');
      return;
    }
    setActiveUuid(target);
    const provider = target === LEGACY_UUID ? window.ethereum : providers.find((p) => p.uuid === target)?.provider;
    if (!provider) {
      setError('Selected wallet is no longer available.');
      return;
    }
    setStatus('connecting');
    try {
      const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
      const first = accounts?.[0];
      if (!first) throw new Error('Wallet returned no account.');
      setAddress(first);
      const hexChain = await provider.request({ method: 'eth_chainId' });
      const chain = hexToNumber(hexChain);
      setChainId(chain);
      setStatus(chain === TARGET_CHAIN.id ? 'connected' : 'wrong-network');
    } catch (e) {
      setStatus('disconnected');
      setAddress(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [providers]);

  const disconnect = useCallback(() => {
    // EIP-1193 has no standard "disconnect" call a dapp can make the wallet honor; this clears
    // this app's own session state, which is the whole of what a dapp can do.
    setActiveUuid(null);
    setAddress(null);
    setChainId(null);
    setStatus('disconnected');
    setError(null);
  }, []);

  const switchToTarget = useCallback(async () => {
    if (!activeProvider) return;
    setStatus('switching');
    setError(null);
    const idHex = `0x${TARGET_CHAIN.id.toString(16)}`;
    try {
      await activeProvider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: idHex }] });
    } catch (e) {
      // 4902: chain not added to this wallet yet — offer to add it, then the wallet will have
      // switched to it as part of accepting the add.
      const code = (e as { code?: number } | null)?.code;
      if (code === 4902) {
        try {
          await activeProvider.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: idHex,
              chainName: TARGET_CHAIN.name,
              nativeCurrency: TARGET_CHAIN.nativeCurrency,
              rpcUrls: TARGET_CHAIN.rpcUrls.default.http,
              blockExplorerUrls: TARGET_CHAIN.blockExplorers ? [TARGET_CHAIN.blockExplorers.default.url] : [],
            }],
          });
        } catch (addErr) {
          setError(addErr instanceof Error ? addErr.message : String(addErr));
        }
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      const hexChain = await activeProvider.request({ method: 'eth_chainId' }).catch(() => null);
      const chain = hexToNumber(hexChain);
      setChainId(chain);
      setStatus(chain === TARGET_CHAIN.id ? 'connected' : 'wrong-network');
    }
  }, [activeProvider]);

  const value: WalletState = {
    status, address, chainId, providers, error, publicClient, walletClient, connect, disconnect, switchToTarget,
  };
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

/** Sentinel uuid for the legacy `window.ethereum` fallback — never a real EIP-6963 uuid. */
const LEGACY_UUID = 'legacy-window-ethereum';

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet() called outside <WalletProvider>');
  return ctx;
}
