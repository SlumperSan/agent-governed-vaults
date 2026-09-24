import { useEffect, useState } from 'react';
import { isAddress, type Address } from 'viem';
import {
  GOVERNANCE_VIEWS,
  OPERATOR_REGISTRY_VIEWS,
  SUBVAULT_REGISTRY_VIEWS,
  VAULT_FACTORY_VIEWS,
  VAULT_VIEWS,
} from '@chain/abis';
import {
  assembleAllowSubVaults,
  assembleClaimableEscrow,
  assembleWiringLock,
  planAllowSubVaults,
  planClaimableEscrow,
  planWiringLockCore,
  planWiringLockSubVaultFactory,
  shortAddress,
  type ClaimableEscrowEntry,
  type UnreadEscrowEntry,
  type Vault,
} from '../lib/atlas';
import { readVaultAddresses } from '../lib/chain-actions';
import { useWallet } from '../lib/wallet';

interface Props {
  readonly vault: Vault;
}

/**
 * Card 127 / #182 (P-O15) — the checkable rows that distinguish this vault from a fund with a
 * manager: `Decisions/contract-tab-requirements-2026-09-19.md` is the row-to-read map, and
 * `Decisions/app-workspace-copy-2026-09-18.md` §4 is where every word below comes from. Card 205
 * is Row 6b's tri-state: `apps/web/src/chain-reader.mjs`'s `assembleClaimableEscrow` (PR #361)
 * already keeps "confirmed zero" and "unread/failed" apart at the data layer — this component's
 * only job is to not collapse them back together on the way to the screen, which is exactly the
 * defect `Findings/2026-09-21-row-6b-collapses-unread-into-zero.md` found in the ORIGINAL spec.
 *
 * READ-ONLY, ON PURPOSE. This tab renders facts; it signs nothing. `EscrowClaims.tsx` already owns
 * the claim button for Row 6b's balances (`sendClaimEscrowed`, a member-funds write) — this
 * component reads the SAME `claimable`/`unread` pair via the SAME pure assembler but never imports
 * a write function, so a member sees the disclosure here and claims there, never both from one
 * surface.
 *
 * THE PAIRING RULE, STRUCTURALLY. Every row's live line is its own `{cond ? <p>…</p> : null}` —
 * never an `??`/ternary that could fall back to a fixture, a zero, or the word "unknown" standing
 * in for a value. A read that has not resolved yet and a read that failed both render NOTHING for
 * that row's live line (the static claim still renders, unconditionally) — `Findings/2026-09-21-
 * row-6b-collapses-unread-into-zero.md` is why Row 6b alone gets a THIRD rendering instead of this
 * two-state pair: its existence on the page is the read, so "not yet / failed" has to be its own
 * visible line rather than an absent one, or a member with a real balance and a flaky RPC call sees
 * literally nothing where their money is.
 *
 * ROW ORDER IS FIXED, PER THE SPEC'S OWN RULE 4: Row 6b (if present) first, then the scope line,
 * then rows 1-6 in order. Design's reasoning: when 6b renders at all it answers the question a
 * member with a stuck claim already has, before the general reassurance the rest of the tab gives.
 *
 * WHY "cirBTC" IS LITERAL TEXT. Rows 5 and 6's static copy names cirBTC specifically because the
 * v1 basket holds exactly one asset (`Decisions/Arc basket is cirBTC only 2026-09-18`) — the same
 * literal-copy hazard `test/btc-exposure-disclosure.test.mjs` already guards for
 * `MemberActions.tsx`. `test/contract-tab.test.mjs` carries the same pin for this file.
 *
 * COPY SOURCE: `Decisions/app-workspace-copy-2026-09-18.md` (Product), including Row 3's correction
 * and the Row 6 confirmed-state and Row 6b unread lines Product answered on #434 (2026-09-24). Row 3
 * no longer says nothing can halt deposits or exits: `navWad` reverts on a stale feed, and deposits
 * and exits revert with it, as the exit screen already says (#388). Row 6 says "its issuer", never
 * the issuer's name (a hard constraint in the copy doc).
 */
export function ContractTab({ vault }: Props) {
  const { status, address, publicClient } = useWallet();
  const connected = status === 'connected' && !!address;
  const vaultAddr = vault.address as Address;

  // ─────────────────────── round 1: the two addresses every later round needs ───────────────────
  const [addrs, setAddrs] = useState<{ usdc: Address; governance: Address } | null>(null);
  const [addrsError, setAddrsError] = useState<string | null>(null);
  const [operatorRegistry, setOperatorRegistry] = useState<Address | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAddrs(null);
    setAddrsError(null);
    setOperatorRegistry(null);
    readVaultAddresses(publicClient, vaultAddr)
      .then((a) => {
        if (!cancelled) setAddrs(a);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setAddrs(null);
        setAddrsError(e instanceof Error ? e.message : String(e));
      });
    // `operatorRegistry()` — a plain VaultCore view, read independently of `readVaultAddresses` so
    // one failing does not take the other down (mirrors `readExitGateInputs`'s `allSettled` shape).
    publicClient
      .readContract({ address: vaultAddr, abi: VAULT_VIEWS, functionName: 'operatorRegistry' })
      .then((r) => {
        if (!cancelled) setOperatorRegistry(r as Address);
      })
      .catch(() => {
        if (!cancelled) setOperatorRegistry(null);
      });
    return () => {
      cancelled = true;
    };
  }, [publicClient, vaultAddr]);

  // ─────────────────────── round 2/3: Row 4 (wiring lock) and Row 5 (allowSubVaults) ─────────────
  const [wiringLock, setWiringLock] = useState<ReturnType<typeof assembleWiringLock>>(null);
  const [allowSubVaults, setAllowSubVaults] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    const governance = addrs?.governance;
    if (!governance || !operatorRegistry) {
      setWiringLock(null);
      setAllowSubVaults(undefined);
      return;
    }
    let cancelled = false;
    (async () => {
      const readAtCore = Math.floor(Date.now() / 1000);
      // Fixed order, per `planWiringLockCore`'s own header: OperatorRegistry.factory(),
      // OperatorRegistry.feeEngine(), Governance.subVaultRegistry() — same "destructure
      // positionally, pin the order in a comment" convention `live-vaults.ts` uses for `planCore`.
      const core = planWiringLockCore(operatorRegistry, governance);
      const coreResults = await publicClient.multicall({
        contracts: [
          { address: core[0]!.address as Address, abi: OPERATOR_REGISTRY_VIEWS, functionName: core[0]!.fn, args: core[0]!.args },
          { address: core[1]!.address as Address, abi: OPERATOR_REGISTRY_VIEWS, functionName: core[1]!.fn, args: core[1]!.args },
          { address: core[2]!.address as Address, abi: GOVERNANCE_VIEWS, functionName: core[2]!.fn, args: core[2]!.args },
        ],
        allowFailure: true,
      });
      if (cancelled) return;
      const [opFactoryR, opFeeEngineR, govSubR] = coreResults;
      const opFactoryValue = opFactoryR?.status === 'success' ? opFactoryR.result : undefined;
      const govSubValue = govSubR?.status === 'success' ? govSubR.result : undefined;

      // Row 5 shares Row 4's OperatorRegistry.factory() read — VaultCore carries no `factory()` of
      // its own (chain-reader.mjs's own header on `planAllowSubVaults`), so this IS the live
      // resolution of "the vault's own factory", never a deploy-script constant.
      if (typeof opFactoryValue === 'string' && isAddress(opFactoryValue)) {
        const [row5Call] = planAllowSubVaults(opFactoryValue);
        publicClient
          .readContract({ address: row5Call!.address as Address, abi: VAULT_FACTORY_VIEWS, functionName: row5Call!.fn, args: row5Call!.args })
          .then((v) => {
            if (!cancelled) setAllowSubVaults(assembleAllowSubVaults(v));
          })
          .catch(() => {
            if (!cancelled) setAllowSubVaults(undefined);
          });
      } else {
        setAllowSubVaults(undefined);
      }

      // Round 3 — SubVaultRegistry.factory() — only attemptable once Governance.subVaultRegistry()
      // has answered with a well-formed address; an unread/malformed value here is not an address
      // to call, so the field stays unread rather than throwing.
      let subFactoryValue: unknown;
      const readAtSub = Math.floor(Date.now() / 1000);
      if (typeof govSubValue === 'string' && isAddress(govSubValue)) {
        const sub = planWiringLockSubVaultFactory(govSubValue);
        const subResults = await publicClient.multicall({
          contracts: [{ address: sub[0]!.address as Address, abi: SUBVAULT_REGISTRY_VIEWS, functionName: sub[0]!.fn, args: sub[0]!.args }],
          allowFailure: true,
        });
        subFactoryValue = subResults[0]?.status === 'success' ? subResults[0].result : undefined;
      } else {
        subFactoryValue = undefined;
      }
      if (cancelled) return;

      setWiringLock(
        assembleWiringLock({
          operatorFactoryValue: opFactoryValue,
          operatorFactoryReadAt: readAtCore,
          operatorFeeEngineValue: opFeeEngineR?.status === 'success' ? opFeeEngineR.result : undefined,
          operatorFeeEngineReadAt: readAtCore,
          govSubVaultRegistryValue: govSubValue,
          govSubVaultRegistryReadAt: readAtCore,
          subVaultRegistryFactoryValue: subFactoryValue,
          subVaultRegistryFactoryReadAt: readAtSub,
        }),
      );
    })().catch(() => {
      if (!cancelled) {
        setWiringLock(null);
        setAllowSubVaults(undefined);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [publicClient, addrs?.governance, operatorRegistry]);

  // ─────────────────────── Row 6b: claimable escrow, tri-state, member-scoped ─────────────────────
  const [claimable, setClaimable] = useState<readonly ClaimableEscrowEntry[] | null>(null);
  const [unread, setUnread] = useState<readonly UnreadEscrowEntry[]>([]);
  const [row6bError, setRow6bError] = useState<string | null>(null);

  useEffect(() => {
    // No wallet connected — the ENTIRE row family is absent, not "connect to check"
    // (contract-tab-claimable-escrow-read.md's own checklist).
    if (!connected || !address) {
      setClaimable(null);
      setUnread([]);
      setRow6bError(null);
      return;
    }
    if (addrsError) {
      setClaimable(null);
      setUnread([]);
      setRow6bError(addrsError);
      return;
    }
    if (!addrs?.usdc) {
      // Still loading round 1 — not evidence of anything, render nothing rather than a stand-in.
      setClaimable(null);
      setUnread([]);
      setRow6bError(null);
      return;
    }
    let cancelled = false;
    const assets = [addrs.usdc, ...vault.basket.map((l) => l.address as Address)];
    const planned = planClaimableEscrow(vaultAddr, address, assets);
    publicClient
      .multicall({
        contracts: planned.map((c) => ({ address: c.address as Address, abi: VAULT_VIEWS, functionName: c.fn, args: c.args })),
        allowFailure: true,
      })
      .then((results) => {
        if (cancelled) return;
        const readAt = Math.floor(Date.now() / 1000);
        const entries = planned.map((c, i) => ({
          asset: c.args[1] as string,
          value: results[i]?.status === 'success' ? results[i]?.result : undefined,
          readAt,
        }));
        const r = assembleClaimableEscrow(entries);
        setClaimable(r.claimable);
        setUnread(r.unread);
        setRow6bError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setClaimable(null);
        setUnread([]);
        setRow6bError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [connected, address, addrs?.usdc, addrsError, publicClient, vaultAddr, vault.basket]);

  /** `USDC` for the vault's own USDC leg (not a basket entry, so it carries no `symbol`), else the
   *  matching basket leg's symbol, else a short address — never a blank label. */
  function symbolFor(asset: string): string {
    if (addrs?.usdc && asset.toLowerCase() === addrs.usdc.toLowerCase()) return 'USDC';
    const leg = vault.basket.find((l) => l.address.toLowerCase() === asset.toLowerCase());
    return leg?.symbol || shortAddress(asset);
  }

  // Row 6 — the basket leg's own safety tri-state, already merged onto `vault.basket` by
  // `assembleVault` (card #32) — no extra read needed here.
  const leg = vault.basket.length === 1 ? vault.basket[0] : undefined;

  return (
    <section className="panel">
      <h2>Contract</h2>
      <p className="note">
        Properties of the vault and governance contracts a member can check against the chain
        directly, rather than take on trust.
      </p>

      {/* Row 6b — FIRST, per the spec's row-order rule. Zero, one, or many blocks; a wallet-scoped
          disclosure, never a table with an implied header row (the spec: "never a summary row"). */}
      {connected && claimable && claimable.length > 0
        ? claimable.map((c) => (
            <p className="note" key={c.asset}>
              <strong>{symbolFor(c.asset)} we could not deliver.</strong> This is yours. The
              transfer did not go through, so the vault is holding it for you rather than sending
              it. Claim it whenever you like — it does not expire, it pays out in full, and trying
              again later costs you nothing.{' '}
              <span className="mono dim">({c.amount.toString()})</span>
            </p>
          ))
        : null}
      {connected && unread.length > 0
        ? unread.map((u) => (
            <p className="note tag-warn" role="status" key={u.asset}>
              {symbolFor(u.asset)}: we could not check your escrowed balance for this token just now.
              That is not the same as having nothing to claim. Reload to check again.
            </p>
          ))
        : null}
      {connected && row6bError ? (
        <p className="note tag-warn" role="status">
          Could not check escrowed claims — status unknown ({row6bError})
        </p>
      ) : null}

      {/* The scope line — above rows 1-6, not a footnote (contract-tab-requirements-2026-09-19.md). */}
      <p className="note">
        <strong>
          These are properties of the vault and governance contracts — not of the assets a vault
          holds.
        </strong>{' '}
        Rows 1 to 3 are false of cirBTC. Row 6 is why.
      </p>

      <h3>1. No proxy</h3>
      <p className="note">
        Every contract is deployed directly — no <code>delegatecall</code>, no implementation slot.
      </p>

      <h3>2. No upgrade path</h3>
      <p className="note">
        No contract can be replaced, and no contract&rsquo;s code can change after deployment.
      </p>

      <h3>3. No pause switch</h3>
      <p className="note">
        No contract has a pause function, and no address — ours included — can halt deposits, exits
        or voting. The contracts do stop on their own when the price feed goes stale: deposits and
        exits revert until it answers again.
      </p>

      <h3>4. Deploy-time wiring is locked once</h3>
      <p className="note">
        <code>OperatorRegistry.factory</code>, <code>OperatorRegistry.feeEngine</code>,{' '}
        <code>SubVaultRegistry.factory</code> and <code>Governance.subVaultRegistry</code> are each
        written a single time, by the deployer, and permanently locked after — every later call
        reverts.
      </p>
      {wiringLock ? <p className="note dim">Read now: all four are set.</p> : null}

      <h3>5. No address holds outsized authority</h3>
      <p className="note">
        No address can vote, execute a trade, pause the vault, reprice an asset, change a fee,
        replace the oracle, or move a member&rsquo;s funds. Two roles are privileged and both are
        narrow: the vault&rsquo;s own <strong>governance</strong> module, which acts only on a
        proposal members have passed, and the vault&rsquo;s <strong>creator</strong>, whose entire
        authority is two acts — registering the governance config once at creation, and creating
        child vaults.
      </p>
      {allowSubVaults !== undefined ? (
        <p className="note dim">
          Read now: child vaults are {allowSubVaults ? 'enabled' : 'disabled'} on this factory.
        </p>
      ) : null}

      <h3>6. cirBTC is issued, not trustless</h3>
      <p className="note">
        The vault&rsquo;s BTC leg is a token whose own contract can be paused, upgraded, and can
        blacklist addresses. Those powers belong to its issuer — not to this protocol, not to the
        operator, and not to anyone who can be voted out here. Rows 1 to 3 above are true of our
        contracts and false of this one.
      </p>
      {leg && leg.paused === 'active' && leg.blacklisted === 'clear' ? (
        <p className="note dim">Read now: not paused, and this vault is not blacklisted.</p>
      ) : null}
      {leg && (leg.paused === 'paused' || leg.blacklisted === 'blacklisted') ? (
        <>
          {leg.paused === 'paused' ? (
            <p className="note tag-warn" role="status">
              Read now: cirBTC is paused by its issuer. Exiting returns your share of what the vault
              holds — cirBTC, not cash — whether or not anything is paused. A pause does not reduce
              what you get; it only means the cirBTC waits as a claim instead of arriving now.
            </p>
          ) : null}
          {leg.blacklisted === 'blacklisted' ? (
            <p className="note tag-warn" role="status">
              Read now: this vault&rsquo;s address is blacklisted on cirBTC. While that lasts the vault
              cannot send cirBTC, so the cirBTC part of an exit waits as a claim instead of arriving
              now. It does not reduce what you get.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
