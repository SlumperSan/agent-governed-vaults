// @ts-check
/**
 * Commit-reveal secret custody for the member surface — the browser half of S-4.
 *
 * THE FAILURE THIS EXISTS TO PREVENT. `Governance.commitVote` stores
 * `keccak256(abi.encode(pid, msg.sender, support, salt))` and `Governance.revealVote` re-computes it
 * from arguments the caller must supply again (Governance.sol:365-391). A member who cannot produce
 * the same `salt` cannot reveal, the commit is forfeit, and it counts toward nothing — no member,
 * no operator and no contract can recover it. CONSUMER-UX-SPEC §3.2 calls this the single
 * highest-severity human-specific failure in the product, and a browser is a worse custodian than
 * an agent process: profiles are cleared, devices are swapped, and the same person reaches the same
 * vault from a phone an hour later.
 *
 * SO THIS MODULE HOLDS NO SECRET AND READS NO STORAGE. Two properties, and they are the whole design:
 *
 *  1. **The salt is DERIVED, never stored.** `salt = keccak256(signature over saltMessage(...))`,
 *     where the message is built from public, chain-readable inputs only — chain id, vault address,
 *     proposal id. Any device holding the same key derives the same salt forever, so "committed on
 *     a laptop, revealed on a phone" needs no export, no backup file and no sync.
 *  2. **Outstanding state is RECONSTRUCTED from chain reads.** `reconcileVote` decides what a member
 *     owes from `commitOf`, `revealedOf` and `defaultApplied` — never from anything this browser
 *     remembers. `packages/reference-agent/src/chain.mjs` states the same property for the agent;
 *     the reason it matters here is identical and the mechanism is identical.
 *
 * THE MESSAGE STRING IS DELIBERATELY IDENTICAL TO THE REFERENCE AGENT'S, AND THAT IS A CORRECTNESS
 * REQUIREMENT RATHER THAN TIDINESS. `packages/reference-agent/src/salt.mjs` signs
 * `x402-vaults:reveal-salt:v1:{chainId}:{vault}:{pid}`. One member may commit through an agent and
 * reveal through this surface, or the reverse. If the two derivations differed by one byte, every
 * such vote would land in `committed-unrecoverable` below — the state this module exists to make
 * loud — for a wallet that is in fact perfectly able to reveal. A copy cannot be avoided (see the
 * dependency note) so `test/vote-custody.test.mjs` reads the agent's source and asserts the prefix
 * and the message format still agree, and derives one salt through each path to compare.
 *
 * NO IMPORTS, AND AN INJECTED HASH. `apps/web/src` has zero cross-package imports and zero
 * dependencies — `chain-reader.mjs` states why: it is what makes this directory runnable under
 * `node --test` with no fixture server and importable by any surface, including a plain
 * `<script type="module">`. Node ships no keccak256 (`crypto.getHashes()` has `sha3-256`, whose
 * padding differs) and viem is not importable here, so every function that hashes takes a
 * `keccak256` function from the caller with viem's semantics: hex string in, hex string out,
 * hashing the BYTES the hex denotes. What is pure here is the part where the bugs live — the
 * `abi.encode` field order and the padding — and `test/vote-custody.test.mjs` pins the encoding to
 * the Solidity source and to a Foundry-derived vector rather than to this implementation.
 *
 * WHAT THE DERIVATION PROTECTS AND WHAT IT DOES NOT, stated precisely because the loose version is
 * wrong in a way that matters:
 *
 *  - Nobody without the member's key can derive the salt. The only input that is not public is the
 *    signature, and producing it requires the key.
 *  - The salt is domain-separated and scoped per (chain, vault, proposal), so one disclosed salt
 *    unmasks exactly one vote on one proposal and is useless on the next one.
 *  - A DISCLOSED SALT LEAKS THE DIRECTION, NOT THE VOTE. Given the salt and the public commitment,
 *    anyone can try both support values and learn which one the member committed. They still cannot
 *    cast, change or forfeit that vote: `revealVote` re-derives the commitment against `msg.sender`,
 *    so a third party's own `commitOf` is zero and their reveal reverts with `NoCommit`. The
 *    consequence of a leak is early disclosure of one direction — which is what commit-reveal is
 *    for — and `SALT_SIGNATURE_WARNING` is the sentence a surface must show beside the request so a
 *    member signing the same string somewhere else understands what they are giving away.
 *  - It is NOT a defence against a non-deterministic signer, which is the one way the scheme fails
 *    silently. `assertReproducibleSignature` is for that, and it is checked BEFORE the first commit.
 */

/** `bytes32(0)` — what `commitOf[pid][member]` reads as when no commit was ever made. */
export const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;

/**
 * Domain separation tag. Byte-identical to `SALT_MESSAGE_PREFIX` in
 * `packages/reference-agent/src/salt.mjs`; changing it here without changing it there splits the
 * derivation in two and strands every cross-surface commit.
 */
export const SALT_MESSAGE_PREFIX = 'x402-vaults:reveal-salt:v1';

/**
 * The sentence a surface must show next to the signature request. It is here rather than in the
 * view layer because it states a consequence only this module knows: signing this exact string
 * elsewhere discloses the direction of one vote.
 */
export const SALT_SIGNATURE_WARNING =
  'This signature is not a transaction and authorises nothing — it derives the secret that lets you ' +
  'reveal this one vote, on this one proposal, from any device holding this wallet. Sign it only here: ' +
  'anyone who obtains this signature can work out which way you voted, though they still cannot vote ' +
  'for you or stop you revealing.';

/**
 * The per-member governance reads this module reconciles. Declared here, with types, because
 * `packages/canary/src/abis.mjs` `GOVERNANCE_VIEWS` does not carry them — it holds
 * `activeProposalOf`, `proposals` and `configOf` only — so naming that table would hand a caller a
 * fragment it cannot find. This is the first declaration of these three, not a second copy, and
 * `test/vote-custody.test.mjs` pins each name and signature against `contracts/src/Governance.sol`.
 */
export const GOVERNANCE_VOTE_VIEWS = Object.freeze([
  Object.freeze({ type: 'function', stateMutability: 'view', name: 'commitOf', inputs: Object.freeze([{ name: 'pid', type: 'uint256' }, { name: 'voter', type: 'address' }]), outputs: Object.freeze([{ name: '', type: 'bytes32' }]) }),
  Object.freeze({ type: 'function', stateMutability: 'view', name: 'revealedOf', inputs: Object.freeze([{ name: 'pid', type: 'uint256' }, { name: 'voter', type: 'address' }]), outputs: Object.freeze([{ name: '', type: 'bool' }]) }),
  Object.freeze({ type: 'function', stateMutability: 'view', name: 'revealedSupportOf', inputs: Object.freeze([{ name: 'pid', type: 'uint256' }, { name: 'voter', type: 'address' }]), outputs: Object.freeze([{ name: '', type: 'bool' }]) }),
  Object.freeze({ type: 'function', stateMutability: 'view', name: 'defaultApplied', inputs: Object.freeze([{ name: 'pid', type: 'uint256' }, { name: 'voter', type: 'address' }]), outputs: Object.freeze([{ name: '', type: 'bool' }]) }),
]);

/**
 * The reads that reconstruct one member's participation in one proposal, in the `plan*` convention
 * of `chain-reader.mjs`: this module says WHICH calls to make, the caller owns transport.
 *
 * `defaultApplied` is in the set and it is the one a first draft omits. `revealDelegated` and
 * `applyStandingDefault` set `defaultApplied[pid][member]` and accrue the member's weight WITHOUT
 * touching `revealedOf[pid][member]` (Governance.sol:427, 506), so `commitOf == 0 && !revealedOf`
 * does not mean "has not participated" — it is also exactly what a delegator whose weight has
 * already been cranked onto their delegate's direction looks like. A surface that offered such a
 * member a commit button would be offering an action the contract will refuse, and one that said
 * "you have not voted" would be wrong about a vote already counted.
 *
 * @param {string} governance  Governance address
 * @param {number|bigint|string} pid
 * @param {string} member  the address that would send commitVote/revealVote — i.e. `msg.sender`
 */
export function planVoteReads(governance, pid, member) {
  const args = [BigInt(pid), member];
  return Object.freeze(
    ['commitOf', 'revealedOf', 'revealedSupportOf', 'defaultApplied'].map((fn) =>
      Object.freeze({ address: governance, abi: 'GOVERNANCE_VOTE_VIEWS', fn, args: Object.freeze([...args]) }),
    ),
  );
}

/**
 * The exact string the wallet signs. Every input is public and re-derivable from chain state, so
 * there is nothing to persist. The vault address is lowercased: a checksummed and a lowercase form
 * of one address must not derive two different salts for one vote.
 *
 * @param {{chainId:number|string, vault:string, pid:number|bigint|string}} p
 * @returns {string}
 */
export function saltMessage({ chainId, vault, pid }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(vault))) throw new Error(`saltMessage: not an address: ${vault}`);
  const id = Number(chainId);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`saltMessage: not a chain id: ${chainId}`);
  return `${SALT_MESSAGE_PREFIX}:${id}:${String(vault).toLowerCase()}:${asPid(pid)}`;
}

/**
 * `salt = keccak256(signature)`. Pure given the injected hash.
 *
 * The signature is required to be whole bytes. A truncated or `0x`-only value would hash happily
 * to a perfectly usable-looking salt that no second derivation reproduces, which is the forfeiture
 * this module exists to prevent, arriving as a success.
 *
 * @param {string} signature  the wallet's signature over `saltMessage(...)`
 * @param {(hex:string)=>string} keccak256  viem semantics: hex in, hex out, hashes the bytes
 * @returns {string} 32-byte hex salt
 */
export function saltFromSignature(signature, keccak256) {
  if (typeof keccak256 !== 'function') throw new Error('saltFromSignature: needs a keccak256 function — see the module header');
  if (!/^0x([0-9a-fA-F]{2})+$/.test(String(signature)))
    throw new Error('saltFromSignature: signature must be non-empty whole-byte hex');
  return requireBytes32(keccak256(String(signature)), 'saltFromSignature: keccak256 returned');
}

/**
 * `abi.encode(pid, voter, support, salt)` — the commitment preimage, as hex, with no hashing.
 *
 * Four static 32-byte words in Governance.sol's order (Governance.sol:391). Separated from the hash
 * so the encoding is testable against the Solidity source without a keccak implementation, because
 * the encoding is where the expensive mistakes are: `encodePacked` instead of `encode`, the voter
 * and the pid transposed, a bool written as one byte. Each produces a commitment that is accepted
 * on commit and reverts with `BadReveal` on reveal.
 *
 * @param {{pid:number|bigint|string, voter:string, support:boolean, salt:string}} p
 * @returns {string} `0x` + 256 hex characters
 */
export function commitmentPreimage({ pid, voter, support, salt }) {
  if (typeof support !== 'boolean') throw new Error('commitmentPreimage: support must be a boolean');
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(voter))) throw new Error(`commitmentPreimage: not an address: ${voter}`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(salt))) throw new Error('commitmentPreimage: salt must be 32-byte hex');
  const word = (hex) => hex.padStart(64, '0');
  return (
    '0x' +
    word(asPid(pid).toString(16)) +
    word(String(voter).slice(2).toLowerCase()) +
    word(support ? '1' : '0') +
    String(salt).slice(2).toLowerCase()
  );
}

/**
 * The commitment `Governance.commitVote` expects and `Governance.revealVote` re-derives.
 *
 * @param {{pid:number|bigint|string, voter:string, support:boolean, salt:string}} p
 * @param {(hex:string)=>string} keccak256
 * @returns {string} 32-byte hex
 */
export function commitmentFor({ pid, voter, support, salt }, keccak256) {
  if (typeof keccak256 !== 'function') throw new Error('commitmentFor: needs a keccak256 function — see the module header');
  return requireBytes32(keccak256(commitmentPreimage({ pid, voter, support, salt })), 'commitmentFor: keccak256 returned');
}

/**
 * Both commitments a salt can produce for one voter and proposal — support FOR and AGAINST.
 *
 * This is what makes recovery possible without storing the direction: the direction is not a secret
 * the member must keep, it is one bit recoverable by trying both against the public commitment.
 * Several salts may be offered (the derived one, plus any a member has written down), and every
 * combination is returned so `reconcileVote` can match against all of them at once.
 *
 * @param {{pid:number|bigint|string, voter:string, salts:readonly string[]}} p
 * @param {(hex:string)=>string} keccak256
 * @returns {readonly {support:boolean, salt:string, commitment:string, voter:string, pid:bigint}[]}
 */
export function candidateCommitments({ pid, voter, salts }, keccak256) {
  if (!Array.isArray(salts) || salts.length === 0) throw new Error('candidateCommitments: needs at least one salt');
  const out = [];
  for (const salt of salts) {
    for (const support of [true, false]) {
      out.push(
        Object.freeze({
          support,
          salt: String(salt).toLowerCase(),
          commitment: commitmentFor({ pid, voter, support, salt }, keccak256).toLowerCase(),
          voter: String(voter).toLowerCase(),
          pid: asPid(pid),
        }),
      );
    }
  }
  return Object.freeze(out);
}

/**
 * Two signatures over the SAME message must be byte-identical, or this wallet cannot be trusted with
 * a commit-reveal vote at all.
 *
 * Local secp256k1 signers use RFC-6979 deterministic ECDSA, so they pass. Passkey and WebAuthn
 * signers use a random nonce and CANNOT pass. Smart-contract accounts and some hardware signers may
 * or may not. Such a wallet commits successfully and is then unable to reveal, which is the exact
 * forfeiture this module prevents, discovered at the only moment nothing can be done about it. So
 * the probe runs before the FIRST commit — two signatures, one comparison, no transaction.
 *
 * @param {string} a @param {string} b
 * @returns {{reproducible:true}}
 */
export function assertReproducibleSignature(a, b) {
  if (!/^0x([0-9a-fA-F]{2})+$/.test(String(a)) || !/^0x([0-9a-fA-F]{2})+$/.test(String(b)))
    throw new Error('assertReproducibleSignature: both signatures must be non-empty whole-byte hex');
  if (String(a).toLowerCase() !== String(b).toLowerCase())
    throw new Error(
      'This wallet signed the same message two different ways, so the secret that reveals your vote ' +
        'cannot be re-derived later. Committing with it would forfeit the vote. Use a wallet whose ' +
        'signatures are deterministic, or vote by sending the two transactions yourself and keeping ' +
        'the salt.',
    );
  return { reproducible: /** @type {true} */ (true) };
}

/**
 * The states a member's participation can be in. Every one of them is distinguishable from the
 * others by chain reads alone, which is the point.
 */
export const VOTE_STATUS = Object.freeze({
  /** A read failed. NOT "has not voted" — see `reconcileVote`. */
  UNKNOWN: 'unknown',
  /** No commit, no reveal, no applied default: nothing cast. */
  NONE: 'none',
  /** Weight already counted through a delegate or a standing default. Not a self-commit. */
  DELEGATED: 'delegated-applied',
  /** Already revealed. The commitment is spent and the direction is on-chain. */
  REVEALED: 'revealed',
  /** A commit is outstanding and a candidate salt reproduces it: this wallet can reveal. */
  RECOVERABLE: 'committed-recoverable',
  /** A commit is outstanding and no salt has been offered yet — the wallet has not signed. */
  UNDERIVED: 'committed-underived',
  /** A commit is outstanding and NO offered salt reproduces it. The loud one. */
  UNRECOVERABLE: 'committed-unrecoverable',
  /** Reads that cannot both be true. Reported, never resolved by guessing. */
  INCONSISTENT: 'inconsistent',
});

/** Phases (from `governance.mjs` `proposalPhase`) in which `revealVote` can still be sent. */
const REVEAL_PHASES = new Set(['reveal']);

/**
 * What one member owes on one proposal, from chain reads and candidate salts alone.
 *
 * FOUR RULES, each of which a plausible implementation gets wrong:
 *
 *  1. **A FAILED READ IS `UNKNOWN`, NEVER `NONE`.** `commitOf` is tested with
 *     `commitment == null`, and `revealed !== true` decides revealedness — copied from
 *     `chain.mjs`'s `hasOutstandingCommit`, where the reasoning is written out: treating a null
 *     from one RPC hiccup as "already revealed" drops a reveal obligation and forfeits the vote,
 *     while an unnecessary reveal reverts harmlessly. Fail toward revealing.
 *  2. **A NON-ZERO `commitOf` WITH NO MATCHING SALT IS ITS OWN STATE.** It is a real, reachable
 *     position — the member changed wallet derivation, used a signer that is not reproducible, or
 *     committed under a different scheme — and it must never render as "not voted". The member has
 *     an outstanding commitment they may be unable to reveal, and the honest surface says so while
 *     the reveal window is open, when writing down or pasting the salt can still save it.
 *  3. **THE CANDIDATES MUST BELONG TO THE MEMBER BEING RECONCILED.** The commitment binds
 *     `msg.sender`, so a candidate built for address A can never match `commitOf[pid][B]`. Passing
 *     a stale set after a wallet switch would therefore produce `UNRECOVERABLE` for a member who
 *     has simply not voted — a false alarm indistinguishable from the real one. Mismatched voter or
 *     pid throws, because it is a programming error and its symptom is a plausible wrong answer.
 *  4. **`canCommit` IS A THREE-VALUED ANSWER.** `commitVote` requires the commit phase AND
 *     `_boundedWeight(p, msg.sender) > 0` (Governance.sol:366-369): pending deposits, Mode-F-locked
 *     shares and stake acquired after the snapshot all carry zero weight. Without the weight read
 *     the answer is `null`, not `true`.
 *
 * @param {Object} p
 * @param {number|bigint|string} p.pid
 * @param {string} p.member  whose participation this is — `commitOf[pid][member]`
 * @param {string|null|undefined} p.commitment  `commitOf(pid, member)`; null/undefined = READ FAILED
 * @param {boolean|null|undefined} p.revealed  `revealedOf(pid, member)`; null/undefined = READ FAILED
 * @param {boolean|null|undefined} [p.defaultApplied]  `defaultApplied(pid, member)`
 * @param {boolean|null|undefined} [p.revealedSupport]  `revealedSupportOf(pid, member)`
 * @param {readonly {support:boolean, salt:string, commitment:string, voter:string, pid:bigint}[]|null|undefined} [p.candidates]
 *        from `candidateCommitments`; null/undefined = the wallet has produced no signature yet
 * @param {string} [p.phase]  from `proposalPhase(...).phase`
 * @param {bigint|number|string|null|undefined} [p.votingWeight]  `votingEligibleShares(member)`
 */
export function reconcileVote({ pid, member, commitment, revealed, defaultApplied, revealedSupport, candidates, phase, votingWeight }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(member))) throw new Error(`reconcileVote: not an address: ${member}`);
  const me = String(member).toLowerCase();
  const wantPid = asPid(pid);

  const cands = candidates == null ? null : [...candidates];
  if (cands) {
    for (const c of cands) {
      if (String(c.voter).toLowerCase() !== me)
        throw new Error(
          `reconcileVote: candidate salts were derived for ${c.voter} but this is ${member}. ` +
            'The commitment binds msg.sender, so they can never match — rebuild them for the connected wallet.',
        );
      if (asPid(c.pid) !== wantPid)
        throw new Error(`reconcileVote: candidate salts are for proposal ${c.pid}, not ${wantPid}`);
    }
  }

  const out = (status, label, detail, extra = {}) =>
    Object.freeze({
      status,
      label,
      detail,
      reveal: null,
      canCommit: false,
      forfeited: false,
      needsSignature: false,
      ...extra,
    });

  const weight = toBigOrNull(votingWeight);
  // Past the reveal window an unrevealed commit is gone: `revealVote` requires
  // `now < revealDeadline`, and nothing reopens it. `tally` is already past it.
  const revealWindowClosed = ['tally', 'executed', 'defeated', 'expired', 'timelock', 'executable'].includes(String(phase));

  // Rule 1. A read we did not get is not a fact about the member.
  if (commitment == null || revealed == null) {
    return out(
      VOTE_STATUS.UNKNOWN,
      'Vote state could not be read',
      'This surface could not read your commit state from the chain, so it will not tell you whether you have voted. ' +
        'Retry before the reveal window closes: an unrevealed commit is forfeit and counts toward nothing.',
    );
  }

  const committed = String(commitment).toLowerCase() !== ZERO_BYTES32;

  // `revealVote` requires a non-zero commitment, so revealed-without-a-commitment cannot happen
  // on-chain. If both reads succeeded and say it did, one of them is not what it claims to be.
  if (revealed === true && !committed) {
    return out(
      VOTE_STATUS.INCONSISTENT,
      'Vote state is contradictory',
      'The chain reports this vote as revealed while holding no commitment for it, which Governance.revealVote cannot produce. ' +
        'One of the two reads is wrong — check the Governance address and the proposal id before acting on either.',
    );
  }

  if (revealed === true) {
    const dir = revealedSupport == null ? null : Boolean(revealedSupport);
    return out(
      VOTE_STATUS.REVEALED,
      'Revealed',
      dir === null
        ? 'Your vote is revealed and counted. The direction is on-chain in revealedSupportOf and was not read here.'
        : `Your vote is revealed and counted ${dir ? 'FOR' : 'AGAINST'}. Nothing further is owed on this proposal.`,
      { revealedSupport: dir },
    );
  }

  if (committed) {
    if (cands === null) {
      return out(
        VOTE_STATUS.UNDERIVED,
        'Committed — sign to recover the reveal',
        'You have a vote committed on this proposal. Its direction and secret are not stored anywhere; they are re-derived ' +
          'from one signature by this wallet. Sign to recover them, then reveal before the window closes.',
        { needsSignature: true, forfeited: revealWindowClosed },
      );
    }
    const hit = cands.find((c) => String(c.commitment).toLowerCase() === String(commitment).toLowerCase());
    if (hit) {
      return out(
        VOTE_STATUS.RECOVERABLE,
        revealWindowClosed ? 'Committed — reveal window has closed' : 'Committed — ready to reveal',
        revealWindowClosed
          ? 'Your commitment was recovered, but the reveal window is closed and revealVote can no longer be sent. ' +
              'This vote counted toward nothing.'
          : `Your commitment was recovered from this wallet: you voted ${hit.support ? 'FOR' : 'AGAINST'}. ` +
              'Reveal it before the window closes — an unrevealed commit is forfeit.',
        {
          // Offered even outside the reveal window: the arguments are correct and the phase read may
          // be stale, and the caller decides whether to send. `forfeited` is the flag to render on.
          reveal: Object.freeze({ pid: wantPid, support: hit.support, salt: hit.salt }),
          forfeited: revealWindowClosed,
          matchedSalt: hit.salt,
        },
      );
    }
    // Rule 2. The loud state.
    return out(
      VOTE_STATUS.UNRECOVERABLE,
      'Committed — this wallet cannot reproduce the secret',
      'The chain holds a vote committed by this address on this proposal, and none of the secrets this wallet can produce ' +
        'matches it. That happens when the commit was made with a different wallet, or by a wallet whose signatures are not ' +
        'reproducible. You have NOT abstained and you cannot be shown as not having voted. ' +
        (revealWindowClosed
          ? 'The reveal window has closed, so this vote counted toward nothing.'
          : 'While the reveal window is open you can still reveal it by entering the salt used to commit; after it closes the vote counts toward nothing.'),
      { forfeited: revealWindowClosed, triedSalts: Object.freeze([...new Set(cands.map((c) => c.salt))]) },
    );
  }

  // Nothing committed and nothing revealed. Before this can be called "not voted", the delegation
  // crank has to be ruled out — and if that read failed, it has not been.
  if (defaultApplied == null) {
    return out(
      VOTE_STATUS.UNKNOWN,
      'Vote state could not be read',
      'You have no commit of your own on this proposal, but this surface could not read whether your weight has already been ' +
        'counted through a delegate or a standing default, so it cannot tell you whether anything is owed.',
    );
  }

  if (defaultApplied === true) {
    return out(
      VOTE_STATUS.DELEGATED,
      'Counted through your standing instruction',
      'Your weight on this proposal has already been counted through your delegate or your standing default. You did not ' +
        'cast this vote yourself and there is nothing left to reveal.',
    );
  }

  return out(
    VOTE_STATUS.NONE,
    'No vote cast',
    weight === 0n
      ? 'You have no vote cast on this proposal, and no voting-eligible shares at its snapshot — committing would revert with NoWeight.'
      : 'You have no vote cast on this proposal.',
    {
      // Rule 4. Only the commit phase, and only with weight read — absent, the answer is null.
      canCommit: String(phase) === 'commit' ? (weight === null ? null : weight > 0n) : false,
    },
  );
}

/** A pid is a uint256. Rejecting a negative or fractional one here stops it being padded into a lie. */
function asPid(pid) {
  const v = BigInt(pid);
  if (v < 0n || v >= 1n << 256n) throw new Error(`pid out of uint256 range: ${pid}`);
  return v;
}

function requireBytes32(v, what) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(v))) throw new Error(`${what} ${v}, which is not 32-byte hex`);
  return String(v).toLowerCase();
}

function toBigOrNull(v) {
  try {
    if (v === null || v === undefined || v === '') return null;
    return BigInt(v);
  } catch {
    return null;
  }
}
