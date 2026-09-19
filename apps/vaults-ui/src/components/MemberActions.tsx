import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import {
  canReveal,
  canSign,
  classifyDepositStatus,
  creatorGateRefusal,
  exitFeeCeiling,
  formatUnits,
  parseUnits,
  shortAddress,
  type DepositStatus,
  type ExitFeeCeiling,
  type Refusal,
  type Vault,
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

/** Real wall-clock seconds — the live chain reads in this component are never in the fixture's
 * time reference frame (`App.tsx`'s `NOW` constant), so they must not be compared against it. */
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
 * chain via `chain-actions.ts`, independent of the fixture data the rest of this app still
 * renders — see chain-actions.ts's header. A member acts on what their wallet and the chain agree
 * is true, never on the fixture displayed beside it.
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
      const r = await sendRequestExit(walletClient, address as Address, vaultAddr as Address, parsed.value);
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
      const r = await sendCommitVote(walletClient, address as Address, addrs.governance, vaultAddr as Address, vault.proposal.pid, support);
      setCommit({ busy: false, message: `Committed ${support ? 'FOR' : 'AGAINST'}. commitVote ${r.commitHash}`, error: null });
    } catch (e) {
      setCommit({ busy: false, message: null, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function handleReveal() {
    if (!connected || !walletClient || !address || !addrs || vault.proposal == null || !custody) return;
    setReveal({ busy: true, message: null, error: null });
    try {
      const r = await sendRevealVote(walletClient, address as Address, addrs.governance, vault.proposal.pid, custody);
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
    depositStatus.state === 'available';

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
          disabled={disabled || exit.busy || !canSign(creatorGate)}
          onClick={() => void handleExit()}
        >
          {exit.busy ? 'Exiting…' : 'Request exit'}
        </button>
      </div>
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
      {exit.message ? <p className="note mono">{exit.message}</p> : null}
      {exit.error ? <p className="note tag-warn">{exit.error}</p> : null}

      {address ? <p className="note dim">Acting as {shortAddress(address)}.</p> : null}
    </section>
  );
}
