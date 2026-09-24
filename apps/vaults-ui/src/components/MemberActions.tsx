import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import {
  actions,
  bpsPct,
  canReveal,
  canSign,
  classifyDepositStatus,
  creatorGateRefusal,
  exitFeeCeiling,
  formatUnits,
  isSeeded,
  parseUnits,
  previewExit,
  SEEDED_ADDRESSES,
  shortAddress,
  USDC_SCALAR,
  usdcShort,
  type DepositStatus,
  type ExitFeeCeiling,
  type ExitPreview,
  type Refusal,
  type Vault,
  type VaultActions,
  type VoteCustodyState,
} from '../lib/atlas';
import {
  readDepositStatusInputs,
  readExitGateInputs,
  readHasPendingExecution,
  readMemberShares,
  readVaultAddresses,
  readVoteCustody,
  sendCommitVote,
  sendDeposit,
  sendRequestExit,
  sendRevealVote,
  type ExitGateInputs,
} from '../lib/chain-actions';
import { useWallet } from '../lib/wallet';

/** Real wall-clock seconds, computed locally rather than threaded in as a prop — `App.tsx` passes
 * its own `Math.floor(Date.now() / 1000)` down to `ProposalPanel`/`Holdings` for the same reason:
 * every reader of "now" in this app is the real clock, not a fixture's frozen one, since plan item
 * 0.7 removed the last fixture (`apps/web/src/fixtures.mjs`'s `NOW` constant) from this workspace. */
const nowSec = () => Math.floor(Date.now() / 1000);

const UNKNOWN_REFUSAL: Refusal = {
  kind: 'unknown',
  code: null,
  reason: 'Not yet read from chain — do not sign against this until it resolves.',
};

interface Props {
  readonly vault: Vault;
}

const isAddress = (s: string): s is Address => /^0x[0-9a-fA-F]{40}$/.test(s);

/** One `{busy, message, error}` triple per action, so one flow's spinner never shows on another's
 * button and one flow's error never blocks a different one from being tried. */
interface FlowState {
  readonly busy: boolean;
  readonly message: string | null;
  readonly error: string | null;
}
const IDLE: FlowState = { busy: false, message: null, error: null };

/**
 * Deposit, vote (commit then reveal), and exit — the three signed flows this card adds. Deliberately
 * NOT part of `ProposalPanel.tsx` (a concurrent PR touches that file's delegated-weight rendering)
 * or `Holdings.tsx`/`VaultList.tsx` — a sibling panel, mounted once per selected vault in App.tsx.
 *
 * Reads (vault addresses, share balance, vote-commit state) happen against the LIVE connected
 * chain via `chain-actions.ts`'s own `publicClient` — a SEPARATE viem client from the one
 * `src/lib/live-vaults.ts` builds for the read-only vault list, bound to whatever chain the
 * connected wallet is actually on rather than the fixed `VITE_RPC_URL` that page reads through.
 * Plan item 0.7 (merged into this branch after this component was written) means the `vault` prop
 * below is no longer fixture data either, so both halves of this page now agree with the chain —
 * this component's own reads were never the part that needed catching up.
 */
export function MemberActions({ vault }: Props) {
  const { status, address, publicClient, walletClient } = useWallet();
  const connected = status === 'connected' && !!address && !!walletClient;
  const vaultAddr = vault.address;

  const [addrs, setAddrs] = useState<{ usdc: Address; governance: Address } | null>(null);
  const [addrErr, setAddrErr] = useState<string | null>(null);

  const [deposit, setDeposit] = useState<FlowState>(IDLE);
  const [depositInput, setDepositInput] = useState('');

  const [exit, setExit] = useState<FlowState>(IDLE);
  const [exitInput, setExitInput] = useState('');
  const [shares, setShares] = useState<bigint | null>(null);
  const [pendingExecution, setPendingExecution] = useState<boolean | null>(null);
  const [exitGate, setExitGate] = useState<ExitGateInputs | null>(null);

  const [depositStatus, setDepositStatus] = useState<DepositStatus | null>(null);

  const [commit, setCommit] = useState<FlowState>(IDLE);
  const [support, setSupport] = useState(true);
  const [custody, setCustody] = useState<VoteCustodyState | null>(null);
  const [custodyErr, setCustodyErr] = useState<string | null>(null);
  const [reveal, setReveal] = useState<FlowState>(IDLE);

  // Live reads, refreshed whenever the connected member or the selected vault changes. Every read
  // here is independent at the TOP level — one of these four calls failing never blocks the
  // others. readExitGateInputs carries the same independence one level DEEPER, across its own
  // seven reads; see its call site below.
  useEffect(() => {
    if (!connected || !address || !isAddress(vaultAddr)) {
      setAddrs(null);
      setShares(null);
      setPendingExecution(null);
      setCustody(null);
      setExitGate(null);
      setDepositStatus(null);
      return;
    }
    let cancelled = false;
    readVaultAddresses(publicClient, vaultAddr)
      .then((a) => { if (!cancelled) { setAddrs(a); setAddrErr(null); } })
      .catch((e: unknown) => { if (!cancelled) setAddrErr(e instanceof Error ? e.message : String(e)); });
    readMemberShares(publicClient, vaultAddr, address as Address)
      .then((s) => { if (!cancelled) setShares(s); })
      .catch(() => { if (!cancelled) setShares(null); });
    // Feeds creatorGateRefusal/exitFeeCeiling (wallet-refusals.mjs). readExitGateInputs resolves
    // each of its seven reads independently (Promise.allSettled) and nulls only the ones that
    // actually failed, so one reverting call (an older vault, a transient RPC error) narrows the
    // refusal check's confidence for that ONE field rather than for the whole exit gate — the
    // .catch below is only the outer fallback for readExitGateInputs itself throwing.
    readExitGateInputs(publicClient, vaultAddr, address as Address)
      .then((g) => { if (!cancelled) setExitGate(g); })
      .catch(() => { if (!cancelled) setExitGate(null); });
    readDepositStatusInputs(publicClient, vaultAddr, address as Address)
      .then((d) => {
        if (cancelled) return;
        setDepositStatus(classifyDepositStatus({
          pendingAmountUsdc: d.pendingAmountUsdc,
          availableAt: d.availableAt,
          sharesOf: d.sharesOf,
          now: nowSec(),
        }));
      })
      .catch(() => { if (!cancelled) setDepositStatus(null); });
    return () => { cancelled = true; };
  }, [connected, address, vaultAddr, publicClient]);

  // Governance address arrives one read later than the vault's own address, so pending-execution
  // and vote-custody reads run once it is known.
  useEffect(() => {
    if (!connected || !address || !addrs || !isAddress(vaultAddr)) return;
    let cancelled = false;
    readHasPendingExecution(publicClient, addrs.governance, vaultAddr)
      .then((v) => { if (!cancelled) setPendingExecution(v); })
      .catch(() => { if (!cancelled) setPendingExecution(null); });
    const pid = vault.proposal?.pid;
    if (pid == null || !walletClient) return;
    setCustodyErr(null);
    readVoteCustody(publicClient, walletClient, address as Address, addrs.governance, vaultAddr, pid)
      .then((s) => { if (!cancelled) setCustody(s); })
      .catch((e: unknown) => { if (!cancelled) setCustodyErr(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, address, addrs, vaultAddr, vault.proposal?.pid, publicClient, walletClient]);

  if (!isAddress(vaultAddr)) {
    return (
      <section className="panel">
        <h2>Act</h2>
        <p className="note tag-warn">Fixture vault address is not a real on-chain address — nothing here can sign against it.</p>
      </section>
    );
  }

  async function handleDeposit() {
    if (!connected || !walletClient || !address) return;
    const parsed = parseUnits(depositInput, 6, { unit: 'USDC' });
    if (!parsed.ok) { setDeposit({ busy: false, message: null, error: parsed.error }); return; }
    setDeposit({ busy: true, message: 'Approving…', error: null });
    try {
      const r = await sendDeposit(publicClient, walletClient, address as Address, vaultAddr as Address, parsed.value);
      setDeposit({ busy: false, message: `Deposited. approve ${r.approvalHash} · deposit ${r.depositHash}`, error: null });
      setDepositInput('');
    } catch (e) {
      setDeposit({ busy: false, message: null, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function handleExit() {
    if (!connected || !walletClient || !address) return;
    const parsed = parseUnits(exitInput, 18, { unit: 'shares' });
    if (!parsed.ok) { setExit({ busy: false, message: null, error: parsed.error }); return; }
    setExit({ busy: true, message: null, error: null });
    try {
      const r = await sendRequestExit(publicClient, walletClient, address as Address, vaultAddr as Address, parsed.value);
      setExit({ busy: false, message: `Sent. requestExit ${r.exitHash}`, error: null });
      setExitInput('');
    } catch (e) {
      setExit({ busy: false, message: null, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function handleCommit() {
    if (!connected || !walletClient || !address || !addrs || vault.proposal == null) return;
    setCommit({ busy: true, message: null, error: null });
    try {
      const r = await sendCommitVote(publicClient, walletClient, address as Address, addrs.governance, vaultAddr as Address, vault.proposal.pid, support);
      setCommit({ busy: false, message: `Committed ${support ? 'FOR' : 'AGAINST'}. commitVote ${r.commitHash}`, error: null });
    } catch (e) {
      setCommit({ busy: false, message: null, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function handleReveal() {
    if (!connected || !walletClient || !address || !addrs || vault.proposal == null || !custody) return;
    setReveal({ busy: true, message: null, error: null });
    try {
      const r = await sendRevealVote(publicClient, walletClient, address as Address, addrs.governance, vault.proposal.pid, custody);
      setReveal({ busy: false, message: `Revealed. revealVote ${r.revealHash}`, error: null });
    } catch (e) {
      setReveal({ busy: false, message: null, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const disabled = !connected;

  // VaultCore._deposit (VaultCore.sol:429): `require(pendingDeposit[msg.sender].amountUsdc == 0,
  // PendingExists())` — a SECOND deposit while one is already escrowed in the four-hour
  // observation window always reverts, contract-first, regardless of amount. Block it in the UI
  // rather than let a member pay gas to learn it. Also block while the read is missing or
  // 'unknown' — an unread pending-deposit state must never resolve to "go ahead and deposit".
  const depositBlocked =
    depositStatus == null ||
    depositStatus.state === 'unknown' ||
    depositStatus.state === 'waiting' ||
    depositStatus.state === 'available' ||
    // FROZEN, read straight off the vault prop rather than through `vaultActions` below — so this
    // refusal survives a failed exit-side read (`queuedExitShares`, `shares`) that nulls the
    // verdict object entirely. A refusal that disappears because an unrelated call reverted is the
    // same defect as a caveat that disappears. `VaultCore._deposit` calls `navWad()`
    // UNCONDITIONALLY (VaultCore.sol:412), above the `capacityCapUsdc != 0` branch, so this
    // reverts on every vault while frozen — including an uncapped one with no capacity check to
    // run. vault-state.mjs's own reason text attributes the read to the capacity check; that is
    // true of a capped vault and understates the reach.
    vault.frozen;

  // The exit shares typed so far — 0n (not a parse failure) once nothing/invalid is entered, so
  // an empty box reads as "burns nothing" rather than falling through to `creatorGateRefusal`'s
  // own unread-input branch, which is reserved for a chain read that failed, not for user input
  // that has not been typed yet.
  const exitParsed = parseUnits(exitInput, 18, { unit: 'shares' });
  const burnShares = exitParsed.ok ? exitParsed.value : 0n;
  // exitGate's own fields are independently nullable (see readExitGateInputs) — passed straight
  // through rather than gated on "every field present", because creatorGateRefusal/exitFeeCeiling
  // already resolve to 'unknown' only for the specific missing field, not for the whole check.
  const creatorGate: Refusal = exitGate
    ? creatorGateRefusal({
        creator: exitGate.creator,
        member: address,
        sharesOf: exitGate.sharesOf,
        totalShares: exitGate.totalShares,
        nonCreatorMemberCount: exitGate.nonCreatorMemberCount,
        burnShares,
      })
    : UNKNOWN_REFUSAL;
  const exitFee: ExitFeeCeiling | null = exitGate
    ? exitFeeCeiling({
        exitFeeMaxBps: exitGate.exitFeeMaxBps,
        exitFeeDecayPeriodSec: exitGate.exitFeeDecayPeriod,
        tenureSec: exitGate.lastDepositTime == null ? null : BigInt(nowSec()) - exitGate.lastDepositTime,
      })
    : null;
  // The frozen/Mode-F/queued-exit refusal (vault-state.mjs's `actions().exit`) — the same module
  // apps/web/index.html has always refused against, unwired here until now. `vault.frozen` is a
  // live navWad()-revert read (chain-reader.mjs), never the tri-state "cannot be read" apps/web's
  // event-derived path has to allow for — this app's `Vault.frozen` is always a known boolean, so
  // there is no freeze-unknown case to preserve here (unlike a frozen-vs-unknown notice on the
  // metered API path). `null` until `exitGate`/`shares`/`queuedExitShares` resolve, deliberately:
  // a fact built from a still-loading read (e.g. `isMember` defaulting to `shares > 0n` on a null
  // `shares`, or `hasQueuedExit` defaulting to `false` on a FAILED `queuedExitShares` read) would
  // silently misclassify a real member, or a real already-queued exit, as a known-clean state
  // rather than as "not yet known" — a failed read is not an absence, and treating it as one is
  // the same shape as every other disclosure-that-vanishes defect this repo keeps re-finding.
  const vaultActions: VaultActions | null =
    exitGate && shares !== null && exitGate.queuedExitShares !== null
      ? actions({
          frozen: vault.frozen,
          attested: vault.attested,
          exitMode: pendingExecution === true ? 'F' : pendingExecution === false ? 'I' : 'unknown',
          isMember: shares > 0n,
          // TRUTHFUL, not placeholders. `capacityCapUsdc` is not sourced by this app at all
          // (atlas.ts says why), so capacity here is genuinely UNDETERMINABLE — and
          // `{capacityFull: false, capacityKnown: false}` is exactly how vault-view.mjs's own
          // `vaultView` encodes that pair (`capacityFull: cap.capped && cap.determinable && ...`
          // is necessarily false whenever `determinable` is), not a default standing in for a
          // number nobody read.
          hasPendingDeposit: depositStatus?.state === 'waiting' || depositStatus?.state === 'available',
          pendingMatured: depositStatus?.state === 'available',
          capacityFull: false,
          capacityKnown: false,
          hasQueuedExit: exitGate.queuedExitShares > 0n,
          walletConnected: connected,
        })
      : null;
  // The one case `vaultActions === null` needs its OWN stated reason rather than a silent
  // disabled button: `exitGate` resolved (so `creatorGate`'s own UNKNOWN_REFUSAL message, which
  // covers "exitGate is still null", does not fire) but `queuedExitShares` specifically failed.
  const queuedExitUnread = exitGate !== null && shares !== null && exitGate.queuedExitShares === null;
  // What the member would actually RECEIVE (P-O12) — mirrors VaultCore._settleExit/_exitFeeBps
  // term for term; see exit-preview.mjs for the fee-as-a-range rule and the SV-5 scope note. Only
  // computed once `shares` has resolved: `previewExit` treats a missing memberShares as an input
  // error ("cannot preview this exit"), which would be the wrong message for "not read yet" — the
  // same absent-vs-unknown distinction every other read in this component already keeps.
  //
  // EXPLICITLY gated on `!vault.frozen`, not left to fall out of pricing. `previewExit` itself has
  // no `frozen` parameter — it degrades a null-priced leg into `valueComplete:false`, which today
  // happens to cover a frozen vault only because this basket is a single asset (cirBTC): the one
  // stale leg's `priceWad` goes null, so the total suppresses itself. That is a correct answer for
  // the wrong reason. `usdcPay` and any OTHER, still-healthy leg's value are computed from balances
  // and prices that have nothing to do with `frozen` and would render as confident numbers next to
  // a button `vaultActions.exit` has already refused — add a second basket asset whose oracle is
  // still fresh and the accidental coverage stops covering the leg that IS fresh, no test would
  // catch it, and the preview starts asserting a settlement the contract would revert. apps/web's
  // own dialog avoids this the same way, one level up: `openExit` never renders the exit surface
  // at all unless `x.actions.exit.available` (index.html:1019-1020) — this is that same gate,
  // applied here instead of at a dialog boundary this component does not have.
  const preview: ExitPreview | null =
    !vault.frozen && exitGate && shares !== null
      ? previewExit({
          burnShares,
          memberShares: shares,
          totalShares: vault.totalShares,
          idleUsdc: vault.idleUsdc,
          // exit-preview.mjs wants `decimals`; this app's live basket carries `assetUnit`
          // instead (VaultCore.sol:97, `assetUnit[a] = 10 ** ad` -- read off the contract rather
          // than trusted from the token's own decimals()). Always an exact power of ten, so
          // log10 recovers it exactly for every decimals count this basket can hold.
          basket: vault.basket.map((leg) => ({
            symbol: leg.symbol,
            balance: leg.balance,
            priceWad: leg.priceWad,
            decimals: Math.round(Math.log10(Number(leg.assetUnit))),
          })),
          costBasisUsdc: exitGate.costBasisUsdc,
          exitFeeMaxBps: exitGate.exitFeeMaxBps,
          exitFeeDecayPeriodSec: exitGate.exitFeeDecayPeriod,
          tenureSec: exitGate.lastDepositTime == null ? null : nowSec() - Number(exitGate.lastDepositTime),
        })
      : null;
  const previewLeg = (min: bigint | null, max: bigint, fmt: (n: bigint) => string) =>
    min === null || min === max ? fmt(max) : `${fmt(min)} to ${fmt(max)}`;

  return (
    <section className="panel">
      <h2>Act</h2>
      {!connected ? <p className="note">Connect a wallet to deposit, vote, or exit.</p> : null}
      {addrErr ? <p className="note tag-warn">Could not read this vault&rsquo;s USDC/governance addresses: {addrErr}</p> : null}

      <h3>Deposit</h3>
      <div className="act-row">
        <input
          type="text"
          inputMode="decimal"
          placeholder="USDC amount"
          value={depositInput}
          disabled={disabled || deposit.busy}
          onChange={(e) => setDepositInput(e.target.value)}
        />
        <button
          type="button"
          className="btn"
          disabled={disabled || deposit.busy || !addrs || depositBlocked}
          onClick={() => void handleDeposit()}
        >
          {deposit.busy ? 'Depositing…' : 'Deposit'}
        </button>
      </div>
      <p className="note dim">
        Two signatures: an ERC-20 approve, then <code>deposit(amountUsdc)</code>. A first-time deposit escrows for a
        4-hour observation window before it mints shares — it does not mint immediately (VaultCore.sol:52).
      </p>
      {vault.frozen ? (
        // The refusal states its reason, same rule as the exit button's. Wording comes from
        // vault-state.mjs's own `actions().deposit` verdict rather than a second copy written
        // here, so this app and apps/web never say different things about the same refusal —
        // the `frozen === true` branch sits above every capacity/pending branch in that chain,
        // so it is the one this renders and the facts below it cannot change the answer.
        <p className="note tag-warn">
          {vaultActions?.deposit.reason ??
            'Frozen — the deposit reads NAV to price the vault, and NAV is unavailable while the oracle is stale.'}
        </p>
      ) : null}
      {depositStatus ? (
        <p
          className={
            depositStatus.state === 'unknown' || depositStatus.state === 'waiting' || depositStatus.state === 'available'
              ? 'note tag-warn'
              : 'note dim'
          }
        >
          {depositStatus.label}. {depositStatus.detail}
        </p>
      ) : (
        <p className="note dim">Deposit status has not been read yet.</p>
      )}
      {deposit.message ? <p className="note mono">{deposit.message}</p> : null}
      {deposit.error ? <p className="note tag-warn">{deposit.error}</p> : null}

      <h3>Vote</h3>
      {vault.proposal == null ? (
        <p className="note">No open proposal.</p>
      ) : (
        <>
          {custodyErr ? <p className="note tag-warn">Could not read vote status: {custodyErr}</p> : null}
          {custody?.status === 'revealed' ? (
            <p className="note">Already revealed {custody.support ? 'FOR' : 'AGAINST'}.</p>
          ) : custody?.status === 'ready' ? (
            <>
              <p className="note">
                A commit exists and re-derives to <strong>{custody.support ? 'FOR' : 'AGAINST'}</strong>. Ready to reveal — the
                salt was re-derived from your wallet signature, not read from storage.
              </p>
              <button type="button" className="btn" disabled={disabled || reveal.busy || !canReveal(custody)} onClick={() => void handleReveal()}>
                {reveal.busy ? 'Revealing…' : 'Reveal'}
              </button>
            </>
          ) : custody?.status === 'mismatch' ? (
            <p className="note tag-warn">{custody.detail}</p>
          ) : custody?.status === 'none' || custody == null ? (
            <div className="act-row">
              <label>
                <input type="radio" name="support" checked={support} onChange={() => setSupport(true)} disabled={disabled} /> For
              </label>
              <label>
                <input type="radio" name="support" checked={!support} onChange={() => setSupport(false)} disabled={disabled} /> Against
              </label>
              <button type="button" className="btn" disabled={disabled || commit.busy || !addrs} onClick={() => void handleCommit()}>
                {commit.busy ? 'Committing…' : 'Commit'}
              </button>
            </div>
          ) : (
            <p className="note dim">Reading vote status…</p>
          )}
          <p className="note dim">
            The reveal salt is derived from a wallet signature, not stored — reload this page, reconnect the same
            wallet, and it re-derives.
          </p>
          {commit.message ? <p className="note mono">{commit.message}</p> : null}
          {commit.error ? <p className="note tag-warn">{commit.error}</p> : null}
          {reveal.message ? <p className="note mono">{reveal.message}</p> : null}
          {reveal.error ? <p className="note tag-warn">{reveal.error}</p> : null}
        </>
      )}

      <h3>Exit</h3>
      {/* P-O13: rendered unconditionally, before any deposit — not only once a freeze is live. */}
      <p className="note dim" data-testid="exit-stale-oracle-disclosure">
        If the price feed goes stale, everything that reads NAV reverts, including your exit. There is no
        fallback price source, and the freeze lasts for as long as the feed stays stale.
      </p>
      <div className="act-row">
        <input
          type="text"
          inputMode="decimal"
          placeholder="Shares"
          value={exitInput}
          disabled={disabled || exit.busy}
          onChange={(e) => setExitInput(e.target.value)}
        />
        {shares != null ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={disabled}
            // shares is a raw WAD bigint (1 share = 10^18), not a human amount. `String(shares)`
            // would put the scaled integer straight into a box parseUnits(_, 18) then scales
            // AGAIN — one share becomes 1e36 and the call reverts. formatUnits(shares, 18, ...)
            // renders it as the exact decimal parseUnits(exitInput, 18) round-trips back to the
            // same bigint (both are plain decimal-string arithmetic, no float involved).
            onClick={() => setExitInput(formatUnits(shares, 18, { minFrac: 0, maxFrac: 18, group: false }))}
          >
            Use full balance
          </button>
        ) : null}
        <button
          type="button"
          className="btn"
          disabled={disabled || exit.busy || !canSign(creatorGate) || vaultActions === null || !vaultActions.exit.available}
          onClick={() => void handleExit()}
        >
          {exit.busy ? 'Exiting…' : 'Request exit'}
        </button>
      </div>
      {vaultActions && !vaultActions.exit.available ? (
        // Stated reason, not just a greyed button — vault-state.mjs's own wording, unchanged, so
        // this app never says something different from apps/web about the same refusal. Covers
        // the frozen-Mode-F trap (irrevocable queue during a freeze), an outright frozen vault,
        // "already queued", and "no shares" — none of which this button refused before.
        <p className={vaultActions.exit.severity === 'info' ? 'note dim' : 'note tag-warn'}>{vaultActions.exit.reason}</p>
      ) : queuedExitUnread ? (
        // A FAILED queuedExitShares read, not an absence of one — `?? 0n` on this field would
        // silently read a real already-queued exit as "clear to queue another", the same
        // vanishing-disclosure shape this repo keeps finding. Stated as unknown, not as clean.
        <p className="note tag-warn">Whether you already have a queued exit could not be read from chain — do not sign against this until it resolves.</p>
      ) : null}
      {pendingExecution === true ? (
        <p className="note tag-warn">
          A proposal is past its commit deadline: this exit QUEUES — irrevocably, no cancel — and settles later at
          whatever NAV holds once that proposal resolves.
        </p>
      ) : pendingExecution === false ? (
        <p className="note dim">No pending execution — this exit settles now, in this transaction, at current NAV.</p>
      ) : (
        <p className="note dim">Whether this exit settles now or queues has not been read yet.</p>
      )}
      {creatorGate.kind === 'refused' ? (
        <p className="note tag-warn">{creatorGate.reason}</p>
      ) : creatorGate.kind === 'unknown' ? (
        <p className="note dim">{creatorGate.reason}</p>
      ) : null}
      {exitFee == null ? (
        <p className="note dim">Exit fee ceiling has not been read yet.</p>
      ) : exitFee.kind === 'unknown' ? (
        // Explicit, not omitted: an unshown ceiling reads as "no fee applies", which is worse
        // than an unread one. Never fall back to a default number here.
        <p className="note tag-warn">{exitFee.reason}</p>
      ) : (
        <p className="note dim">{exitFee.reason}</p>
      )}

      {vault.frozen ? (
        // Explicit, not a side effect of an unpriced leg: see `preview`'s own comment above for
        // why "the total already suppresses itself" is not the same claim as "this is frozen".
        <p className="note tag-warn">
          No preview while frozen — settlement prices this exit through the oracle, and the oracle is stale.
        </p>
      ) : preview == null ? (
        <p className="note dim">What you would receive has not been read yet.</p>
      ) : !preview.ok ? (
        <p className="note dim">{preview.error}</p>
      ) : (
        <table className="grid">
          <tbody>
            <tr>
              <th scope="row">
                USDC
                <br />
                <span className={preview.perfFee === null ? 'tag-warn' : 'dim'}>
                  idle stables
                  {preview.perfFee !== null && preview.perfFee.maxUsdc > 0n
                    ? ', before the performance fee below'
                    : preview.perfFee === null
                      ? // Matches apps/web/index.html's identical branch: the fee could not be
                        // BOUNDED (costBasisUsdc unread, an unpriced leg, or a child unwind), never
                        // that no fee applies. Not rendering this here is the exact defect PR #350's
                        // review found -- a member-facing Total that reads as final when it is not.
                        '. The 10% performance fee is withheld from this leg and from every slice ' +
                        'below, and could not be bounded from the data here, so these are pre-fee ' +
                        'figures, not receipts'
                      : ''}
                </span>
              </th>
              <td className="num">{previewLeg(preview.usdcPayMin, preview.usdcPay, (n) => usdcShort(n))}</td>
            </tr>
            {preview.slices.map((s) => (
              <tr key={s.symbol}>
                <th scope="row">
                  {s.symbol}
                  <br />
                  <span className="dim">paid in the token itself</span>
                </th>
                <td className="num">
                  {previewLeg(s.amountMin, s.amount, (n) => formatUnits(n, s.decimals, { maxFrac: 8 }))} {s.symbol}
                  {s.valueWad !== null ? <><br /><span className="dim">{usdcShort(s.valueWad / USDC_SCALAR)} before the fee</span></> : null}
                </td>
              </tr>
            ))}
            <tr>
              <th scope="row">
                Exit fee {bpsPct(preview.feeBps)}
                {preview.isSoleHolder ? ', waived' : ''}
                <br />
                <span className="dim">
                  {preview.isSoleHolder
                    ? 'sole member: accrues to those who remain, and there are none'
                    : 'stays in the vault, adding to every remaining share'}
                </span>
              </th>
              <td className="num">{preview.feeValueWad !== null ? `−${usdcShort(preview.feeValueWad / USDC_SCALAR)}` : bpsPct(preview.feeBps)}</td>
            </tr>
            {preview.perfFee !== null && preview.perfFee.maxUsdc > 0n ? (
              <tr>
                <th scope="row">
                  Performance fee, up to 10% of gain
                  <br />
                  <span className="dim">withheld uniformly from every leg above; the exact figure depends on your loss carry, which is not exposed here</span>
                </th>
                <td className="num">−{usdcShort(0n)} to −{usdcShort(preview.perfFee.maxUsdc)}</td>
              </tr>
            ) : null}
            <tr>
              <th scope="row">Total value{preview.valueComplete ? '' : ': cannot be totalled'}</th>
              <td className="num">
                {preview.payoutValueWad !== null
                  ? previewLeg(
                      preview.payoutValueMinWad === null ? null : preview.payoutValueMinWad / USDC_SCALAR,
                      preview.payoutValueWad / USDC_SCALAR,
                      (n) => usdcShort(n),
                    )
                  : '—'}
              </td>
            </tr>
          </tbody>
        </table>
      )}
      {preview?.ok && preview.coversFromChildren ? (
        <p className="note tag-warn">
          Part of this exit unwinds child-vault positions — this preview covers the common path only and understates
          what you would actually receive.
        </p>
      ) : null}
      {preview?.ok &&
      preview.perfFee === null &&
      preview.valueComplete &&
      !preview.coversFromChildren &&
      preview.payoutValueWad !== null &&
      preview.payoutValueWad > 0n ? (
        // The one case previewExit CAN price a gain but cannot bound the performance fee taken from
        // it — costBasisUsdc failed to read independently of everything else above. Every other
        // null-perfFee cause already has its own warning (coversFromChildren) or its own label
        // (valueComplete driving "cannot be totalled"), so reaching here means specifically this.
        <p className="note tag-warn">
          The Total above is pre-fee, not a receipt — the 10% performance fee could not be bounded from
          what was read, so it is not shown as a range here the way it is on the leg rows.
        </p>
      ) : null}

      {exit.message ? <p className="note mono">{exit.message}</p> : null}
      {exit.error ? <p className="note tag-warn">{exit.error}</p> : null}

      {address ? (
        <p className="note dim">
          Acting as {shortAddress(address)}
          {isSeeded(address, SEEDED_ADDRESSES) ? ' — seeded by the RWAlly team' : ''}.
        </p>
      ) : null}
    </section>
  );
}
