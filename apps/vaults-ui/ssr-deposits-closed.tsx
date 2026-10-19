/**
 * Not shipped. Test harness for test/deposits-closed.test.mjs: renders the member surface
 * (`MemberActions`, `EscrowClaims`) once for a vault the app has closed deposits for and once for
 * an unflagged vault, at first paint (no wallet connected, no effects run), and prints both
 * markups as one JSON line. Built the same way ssr-smoke.tsx is: `vite build --ssr`.
 */
import { renderToString } from 'react-dom/server';
import { EscrowClaims } from './src/components/EscrowClaims';
import { MemberActions } from './src/components/MemberActions';
import type { Vault } from './src/lib/atlas';
import { DEPOSITS_CLOSED_VAULTS } from './src/lib/vault-policy';
import { WalletProvider } from './src/lib/wallet';

const baseVault = {
  name: '',
  operatorName: '',
  operatorAddress: '0x0000000000000000000000000000000000000001',
  attested: true,
  frozen: false,
  totalShares: 0n,
  navWad: 0n,
  navPerShareWad: 0n,
  idleUsdc: 0n,
  holderCount: 0,
  nonCreatorMemberCount: 0,
  basket: [],
  proposal: null,
  manifestVerified: 'verified',
} as const;

const closedAddress = Object.keys(DEPOSITS_CLOSED_VAULTS)[0];
if (!closedAddress) throw new Error('DEPOSITS_CLOSED_VAULTS is empty: nothing to render as closed');
// Mixed case on purpose: the policy lookup is case-insensitive, a checksummed address must match.
const closedVault: Vault = { ...baseVault, address: closedAddress.replace(/[a-f]/g, (c, i) => (i % 2 ? c.toUpperCase() : c)).replace('0X', '0x') };
const openVault: Vault = { ...baseVault, address: '0x00000000000000000000000000000000000000a2' };

const render = (v: Vault) =>
  renderToString(
    <WalletProvider>
      <MemberActions vault={v} />
      <EscrowClaims vault={v} />
    </WalletProvider>,
  );

console.log(`DEPOSITS_CLOSED_RENDER ${JSON.stringify({ closed: render(closedVault), open: render(openVault), closedAddress: closedVault.address })}`);
