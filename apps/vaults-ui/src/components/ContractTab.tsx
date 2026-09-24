import { useEffect, useState } from 'react';
import { isAddress, type Address } from 'viem';
import { GOVERNANCE_VIEWS, OPERATOR_REGISTRY_VIEWS, SUBVAULT_REGISTRY_VIEWS, VAULT_FACTORY_VIEWS, VAULT_VIEWS } from '@chain/abis';
import {
  assembleAllowSubVaults,
  assembleWiringLock,
  planAllowSubVaults,
  planWiringLockCore,
  planWiringLockSubVaultFactory,
  shortAddress,
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
 * `Decisions/app-workspace-copy-2026-09-18.md` §4 is where every word below comes from.
 *
 * READ-ONLY, ON PURPOSE. This tab renders facts; it signs nothing.
 *
 * THE PAIRING RULE, STRUCTURALLY. Every row's live line is its own `{cond ? <p>…</p> : null}` —
 * never an `??`/ternary that could fall back to a fixture, a zero, or the word "unknown" standing
 * in for a value. A read that has not resolved yet and a read that failed both render NOTHING for
 * that row's live line; the static claim still renders, unconditionally.
 *
 * WHY "cirBTC" IS LITERAL TEXT. Rows 5 and 6's static copy names cirBTC specifically because the
 * v1 basket holds exactly one asset (`Decisions/Arc basket is cirBTC only 2026-09-18`) — the same
 * literal-copy hazard `test/btc-exposure-disclosure.test.mjs` already guards for
 * `MemberActions.tsx`. `test/contract-tab.test.mjs` carries the same pin for this file.
 *
 * ROW 6B (the per-token claimable-escrow tri-state, card 205) IS NOT IN THIS COMPONENT YET — it is
 * a separately tracked, separately reviewed task (`Tasks/row-6b-tri-state-unread.md`), explicitly
 * blocked on this component existing at all. Added in the following commit.
 *
 * OPEN COPY QUESTION (not guessed public-facing copy; see this PR's body): Row 6's live line for a
 * CONFIRMED paused/blacklisted leg (as opposed to unread) has no string in the copy doc, which only
 * gives the reassurance sentence. This renders the same plain, factual wording `Holdings.tsx`'s
 * existing "Safety" column already ships, rather than inventing new alarm copy.
 */
export function ContractTab({ vault }: Props) {
  const { publicClient } = useWallet();
  const vaultAddr = vault.address as Address;

  // ─────────────────────── round 1: the two addresses Row 4 needs ───────────────────────────────
  const [addrs, setAddrs] = useState<{ usdc: Address; governance: Address } | null>(null);
  const [operatorRegistry, setOperatorRegistry] = useState<Address | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAddrs(null);
    setOperatorRegistry(null);
    readVaultAddresses(publicClient, vaultAddr)
      .then((a) => {
        if (!cancelled) setAddrs(a);
      })
      .catch(() => {
        if (!cancelled) setAddrs(null);
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

      <h3>3. No pause</h3>
      <p className="note">Nothing in the protocol can halt deposits, exits or voting.</p>

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
        <p className="note tag-warn" role="status">
          Read now: {leg.symbol || shortAddress(leg.address)} is
          {leg.paused === 'paused' ? ' paused' : ''}
          {leg.paused === 'paused' && leg.blacklisted === 'blacklisted' ? ' and' : ''}
          {leg.blacklisted === 'blacklisted' ? ' blacklisted for this vault' : ''}.
        </p>
      ) : null}
    </section>
  );
}
