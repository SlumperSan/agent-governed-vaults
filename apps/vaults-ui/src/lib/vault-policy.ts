/**
 * Per-vault policy for what THIS APP offers. Not an on-chain fact: every contract keeps accepting
 * `deposit()` from anyone, which is why the notice below says "this app" and never "this vault".
 *
 * Owner decision 2026-10-18: app.rwally.com stops offering deposits into the Arc v1 vault. Exits,
 * escrow claims and every read stay. The reason is the v1 exit fee share-price ratchet (proof of
 * concept 2026-10-18); v1 is immutable, so the fix ships as a new vault.
 *
 * KEYED BY ADDRESS, LOWERCASE, in this one module, so no component names an address and a v2 vault
 * is open by default. `test/vault-policy.test.mjs` pins the v1 entry to `firstVault.address` in
 * `contracts/config/deployments/arc-mainnet.json`.
 *
 * This file has no JSX and no alias imports, so plain `node --test` can import it (same shape as
 * `sanctions.ts`).
 */

export type DepositsClosedReason = 'v1-closed';

export interface VaultPolicy {
  readonly depositsClosed: boolean;
  /** Internal key into DEPOSITS_CLOSED_NOTICE; never rendered. Null when deposits are open. */
  readonly reason: DepositsClosedReason | null;
}

/** Public copy. Scoped to the app on purpose: the contracts still accept deposits from anyone. */
export const DEPOSITS_CLOSED_NOTICE: Readonly<Record<DepositsClosedReason, string>> = {
  'v1-closed':
    'This app no longer offers deposits into this vault. Exits and claims of escrowed amounts are still available here.',
};

/** Shown in place of 'Connect a wallet to deposit, vote, or exit.' when deposits are closed. */
export const CONNECT_PROMPT_DEPOSITS_CLOSED = 'Connect a wallet to vote, exit or claim.';

/** Lowercase address -> reason. Add a vault here to close deposits for it; absence means open. */
export const DEPOSITS_CLOSED_VAULTS: Readonly<Record<string, DepositsClosedReason>> = {
  // Arc v1 vault (cirBTC Vault), contracts/config/deployments/arc-mainnet.json firstVault.address.
  '0x4eae5c6d753aac0b4825d41c12e71f0a8be579f6': 'v1-closed',
};

const OPEN: VaultPolicy = { depositsClosed: false, reason: null };

export function vaultPolicy(vaultAddress: string): VaultPolicy {
  const reason = DEPOSITS_CLOSED_VAULTS[vaultAddress.toLowerCase()];
  return reason === undefined ? OPEN : { depositsClosed: true, reason };
}

export function depositsClosedNotice(vaultAddress: string): string | null {
  const { reason } = vaultPolicy(vaultAddress);
  return reason === null ? null : DEPOSITS_CLOSED_NOTICE[reason];
}

/** The write-layer refusal: `sendDeposit` calls this before the approval, so a rendering
 * regression cannot sign an approval or a deposit for a closed vault. */
export function assertDepositsOpen(vaultAddress: string): void {
  if (vaultPolicy(vaultAddress).depositsClosed) {
    throw new Error('This app no longer offers deposits into this vault, so no approval or deposit was sent.');
  }
}
