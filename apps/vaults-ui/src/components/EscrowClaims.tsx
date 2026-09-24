import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { VAULT_VIEWS } from '@chain/abis';
import { assembleClaimableEscrow, planClaimableEscrow, shortAddress, type Vault } from '../lib/atlas';
import { readVaultAddresses, sendClaimEscrowed } from '../lib/chain-actions';
import { useWallet } from '../lib/wallet';

interface Props {
  readonly vault: Vault;
}

interface FlowState {
  readonly busy: boolean;
  readonly message: string | null;
  readonly error: string | null;
}
const IDLE: FlowState = { busy: false, message: null, error: null };

/**
 * Frontend security pass B2 (card 211) — escrow claim surface.
 *
 * `VaultCore.claimable[member][asset]` is an in-kind slice that was escrowed after a failed asset
 * transfer (EE-6) rather than paid out immediately; nothing before this card showed a member that
 * balance existed, or offered a way to claim it. `assembleClaimableEscrow`
 * (`apps/web/src/chain-reader.mjs`) is the one function that decides what "claimable" means for a
 * read — see its own header for why `claimable`/`unread` are ONE function's two outputs rather
 * than two independently callable ones.
 *
 * `unread` NEVER renders as "nothing to claim". A read that failed is not evidence a member has no
 * escrowed balance; it renders as "could not check", the same "unknown is not healthy" rule this
 * card's B3 (`Holdings.tsx`) and A2 (`App.tsx`) both apply.
 *
 * SECURITY NOTE (see this PR's body): `sendClaimEscrowed` is a member-funds WRITE path, gated the
 * same way every other write in this app is (`simulateThenWrite` in `chain-actions.ts` — a
 * pre-flight simulate before the signature request), but it is new code moving funds and this
 * component's own review is Engineering's; it has not had Security's independent read yet.
 */
export function EscrowClaims({ vault }: Props) {
  const { status, address, publicClient, walletClient } = useWallet();
  const connected = status === 'connected' && !!address && !!walletClient;
  const vaultAddr = vault.address as Address;

  const [usdc, setUsdc] = useState<Address | null>(null);
  const [usdcError, setUsdcError] = useState<string | null>(null);
  const [claimable, setClaimable] = useState<readonly { asset: string; amount: bigint }[] | null>(null);
  const [anyUnread, setAnyUnread] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [claim, setClaim] = useState<Record<string, FlowState>>({});

  // Round 1 — the vault's own USDC address, read fresh rather than assumed. Same helper
  // MemberActions.tsx already uses for the same read; not duplicated here.
  //
  // Security review, PR #409: a failed read here used to leave `usdc` at its initial `null`
  // forever, which the render below could not tell apart from "genuinely nothing claimable" — the
  // exact "unread renders as a clean zero" collapse this whole card exists to close, one step
  // earlier than the claimable read itself. `usdcError` makes "the address read never resolved" a
  // distinct, rendered state.
  useEffect(() => {
    let cancelled = false;
    setUsdc(null);
    setUsdcError(null);
    readVaultAddresses(publicClient, vaultAddr)
      .then((a) => { if (!cancelled) setUsdc(a.usdc); })
      .catch((e: unknown) => {
        if (cancelled) return;
        setUsdc(null);
        setUsdcError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [publicClient, vaultAddr]);

  // Round 2 — claimable(member, asset) for USDC and every basket asset, once both the connected
  // address and the vault's USDC address are known.
  useEffect(() => {
    if (!connected || !address || !usdc) {
      setClaimable(null);
      setAnyUnread(false);
      return;
    }
    let cancelled = false;
    const assets = [usdc, ...vault.basket.map((l) => l.address as Address)];
    const planned = planClaimableEscrow(vaultAddr, address, assets);
    publicClient
      .multicall({
        contracts: planned.map((c) => ({ address: c.address as Address, abi: VAULT_VIEWS, functionName: c.fn, args: c.args })),
        allowFailure: true,
      })
      .then((results) => {
        if (cancelled) return;
        const entries = planned.map((c, i) => ({
          asset: c.args[1] as string,
          value: results[i]?.status === 'success' ? results[i]?.result : undefined,
          readAt: Math.floor(Date.now() / 1000),
        }));
        const { claimable: c, unread } = assembleClaimableEscrow(entries);
        setClaimable(c);
        setAnyUnread(unread.length > 0);
        setReadError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setClaimable(null);
        setAnyUnread(false);
        setReadError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [connected, address, usdc, publicClient, vaultAddr, vault.basket]);

  async function handleClaim(asset: string) {
    if (!connected || !walletClient || !address) return;
    setClaim((s) => ({ ...s, [asset]: { busy: true, message: null, error: null } }));
    try {
      const r = await sendClaimEscrowed(publicClient, walletClient, address as Address, vaultAddr, asset as Address);
      setClaim((s) => ({ ...s, [asset]: { busy: false, message: `Claimed. ${r.claimHash}`, error: null } }));
      // A successful claim zeroes `claimable[member][asset]` on chain; drop it from the local list
      // rather than waiting for a remount, so the button does not stay offered for a balance that
      // is already gone.
      setClaimable((prev) => (prev ? prev.filter((c) => c.asset.toLowerCase() !== asset.toLowerCase()) : prev));
    } catch (e) {
      setClaim((s) => ({ ...s, [asset]: { busy: false, message: null, error: e instanceof Error ? e.message : String(e) } }));
    }
  }

  if (!connected) return null;

  // Security review, PR #409: "nothing claimable" is a CLAIM about a completed read, and it must
  // render ONLY when one actually completed and came back empty. `claimable === null` covers both
  // "still loading" and "the claimable read itself failed" (the catch branch below always resets
  // it to `null`) — neither is evidence of "nothing", and both used to fall through to the same
  // "Nothing claimable right now." text the genuinely-empty case renders. `usdcError` covers the
  // one round the claimable read cannot even start without (no vault USDC address, so nothing was
  // ever planned or called) — same rule, one round earlier.
  const loadingAddresses = !usdc && !usdcError;
  const loadingClaimable = !!usdc && claimable === null && !readError;
  const nothingClaimable = claimable !== null && claimable.length === 0 && !anyUnread;

  return (
    <section className="panel">
      <h2>Escrowed claims</h2>
      <p className="note">
        An in-kind claim is created only when a payout could not transfer directly (EE-6) — most
        members will never see one here.
      </p>
      {usdcError ? (
        <p className="note tag-warn" role="status">
          Could not read escrow — claimable unknown ({usdcError})
        </p>
      ) : null}
      {loadingAddresses || loadingClaimable ? (
        <p className="note dim" role="status" aria-live="polite">
          Reading escrowed claims…
        </p>
      ) : null}
      {readError ? <p className="note tag-warn">Could not read escrowed claims: {readError}</p> : null}
      {anyUnread ? (
        <p className="note tag-warn">
          At least one asset&rsquo;s claimable balance could not be checked — this list may be
          incomplete.
        </p>
      ) : null}
      {claimable && claimable.length > 0 ? (
        <table className="grid">
          <tbody>
            {claimable.map((c) => {
              const flow = claim[c.asset] ?? IDLE;
              return (
                <tr key={c.asset}>
                  <th scope="row">{shortAddress(c.asset)}</th>
                  <td className="num">{c.amount.toString()}</td>
                  <td>
                    <button type="button" disabled={flow.busy} onClick={() => handleClaim(c.asset)}>
                      {flow.busy ? 'Claiming…' : 'Claim'}
                    </button>
                    {flow.error ? <p className="note tag-warn">{flow.error}</p> : null}
                    {flow.message ? <p className="note">{flow.message}</p> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      {nothingClaimable ? <p className="note dim">Nothing claimable right now.</p> : null}
    </section>
  );
}
