// @ts-check
/**
 * Salt custody for a member's commit-reveal vote (Governance.commitVote / revealVote).
 *
 * THE FAILURE THIS MODULE EXISTS TO PREVENT. A member commits a vote, then loses the salt —
 * different device, cleared storage, a new browser profile — and can never reveal. The reveal
 * window has no grace period: an unrevealed commit is simply forfeit (Governance.sol's
 * `revealVote` doc, VO-6). CONSUMER-UX-SPEC §3.2 names this "the single highest-severity
 * human-specific failure in the product."
 *
 * THE FIX: hold no secret. The salt is DERIVED, deterministically, from a wallet signature over a
 * fixed, fully-reconstructible message — never generated randomly and never written to
 * localStorage. Any session holding the same wallet re-derives the same salt, forever, on any
 * device. This is byte-for-byte the same scheme as `packages/reference-agent/src/salt.mjs` (the
 * autonomous-agent side of the same product surface) — see "WHY THE SAME MESSAGE FORMAT" below.
 *
 * WHY THIS FILE HAS NO CRYPTO DEPENDENCY. `apps/web/src` is loaded straight into the browser by
 * `apps/web/index.html` with no bundler and no import map (see `api-client.mjs`, `chain-reader.mjs`
 * headers) — a bare `import 'viem'` would 404 there even though it resolves fine under `node
 * --test` from the repo root, which is exactly the kind of pass-in-tests/break-in-the-page bug
 * this module cannot afford. So `keccak256` and `encodeAbiParameters` are INJECTED by the caller,
 * the same way `chain-reader.mjs` never imports viem and lets its caller supply the transport:
 * "the caller passes fragments in; this module names functions, never signatures." The ABI field
 * list itself (`uint256, address, bool, bytes32`, in that order) stays IN this file, not injected
 * — that ordering is the exact encoding Governance.sol hashes, and it is what the pinned
 * cast-derived vector in the test file checks. Moving it out would move the one place a vote-
 * losing bug could hide out of test reach.
 *
 * DOMAIN SEPARATION — stated explicitly, per surface:
 *   (a) different proposals   — `pid` is in the signed message; changing it changes the signature.
 *   (b) different members     — carried by the SIGNATURE, not the message text. `salt =
 *       keccak256(signature)`, and a signature is bound to the signing key; two different members
 *       signing the identical message produce cryptographically distinct signatures (and hence
 *       distinct salts) by construction. Repeating the member address inside the message would add
 *       nothing here — but SEE (b'-caveat) below.
 *   (b'-caveat) `Governance.commitVote`/`revealVote` bind `msg.sender` into the ON-CHAIN
 *       commitment independently (`keccak256(abi.encode(pid, voter, support, salt))`), so even a
 *       hypothetical salt collision across two members could never produce a colliding COMMITMENT.
 *       Domain separation for members is therefore enforced twice, at two different layers, and
 *       this file does not need to duplicate it a third time in the message text.
 *   (c) different vote directions, before they are chosen — the salt message carries NO `support`
 *       field, deliberately. The salt is derived ONCE, before the member has decided which way to
 *       vote, and the SAME salt is later tested against both `support=true` and `support=false`
 *       when reconstructing state (see `reconstructVoteCustody`). Direction separation lives in
 *       the COMMITMENT encoding instead (`support` is its own ABI field), which is what makes a
 *       single wallet signature able to recover either direction after a restart.
 *   (d) this app vs. any other signing domain — the fixed prefix `SALT_MESSAGE_PREFIX` namespaces
 *       every message this module ever asks a wallet to sign, so a signature over this message can
 *       never be replayed as, or confused with, a signature this same key produced for an
 *       unrelated purpose.
 *
 * WHY THE SAME MESSAGE FORMAT AS packages/reference-agent/src/salt.mjs, ON PURPOSE. Reusing the
 * exact prefix and field order means a member using the SAME wallet key across surfaces — commit
 * from the web app, reveal from the reference agent CLI, or vice versa — re-derives the IDENTICAL
 * salt on both. CONSUMER-UX-SPEC §3.2 sells exactly this ("you can reveal from any device"), and
 * inventing a web-only prefix would silently break that portability while adding no security: see
 * (d) above — one shared prefix already namespaces this protocol's salts away from everything
 * else. This is a considered choice, not an oversight; do not "fix" it into a diverging prefix.
 *
 * REPRODUCIBILITY CAVEAT (honest limitation, inherited from the agent-side module). This holds
 * only for a DETERMINISTIC signer: same key, same message, same signature, every time (true of a
 * local EOA using RFC-6979 ECDSA). Many browser wallets are hardware-backed or smart-contract/
 * account-abstraction accounts that may add entropy and are NOT guaranteed to reproduce a
 * signature — and therefore not a salt — across sessions. `reconstructVoteCustody`'s `mismatch`
 * state is exactly what surfaces that: a real commit exists on-chain, but THIS signature no
 * longer reproduces it. See that function's doc for what a member should do about it (nothing
 * automatic — try the original wallet/device).
 */

import { VOTE_COMMIT_ZERO } from './chain-reader.mjs';

/** Domain-separated, version-tagged, and fully reconstructible from public chain state. */
export const SALT_MESSAGE_PREFIX = 'x402-vaults:reveal-salt:v1';

/** Discriminants for `reconstructVoteCustody`'s return `status`. Never string-compare loosely. */
export const CUSTODY_UNREAD = 'unread';
export const CUSTODY_NONE = 'none';
export const CUSTODY_REVEALED = 'revealed';
export const CUSTODY_READY = 'ready';
export const CUSTODY_MISMATCH = 'mismatch';

const isHex32 = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
/** A plausible signature: non-empty, even-length hex. Not byte-length-pinned — smart-contract
 * (ERC-1271) wallets may return signatures that are not exactly 65 bytes, and this module must
 * not reject a real signature just because it is shaped differently than a local EOA's. It DOES
 * reject empty/garbage input, because `keccak256('')` would otherwise produce a perfectly
 * plausible-looking 32-byte salt from nothing. */
const isPlausibleSignatureHex = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v) && v.length > 4;

/**
 * The exact string a wallet signs. Deterministic in its inputs: the vault address is lowercased
 * so a checksummed vs. lowercase address can never derive two different salts for the same vote.
 *
 * @param {{chainId: number, vault: string, pid: number|bigint|string}} p
 */
export function saltMessage({ chainId, vault, pid }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(vault))) throw new Error(`saltMessage: not an address: ${vault}`);
  return `${SALT_MESSAGE_PREFIX}:${Number(chainId)}:${String(vault).toLowerCase()}:${BigInt(pid)}`;
}

/**
 * Derive the reveal salt from a wallet signature. Pure in (signer, chainId, vault, pid) — no
 * storage, no randomness. Callers pass `signMessage` bound to whatever wallet is connected (a
 * viem local/JSON-RPC account's `signMessage`, or an equivalent adapter over `personal_sign`).
 *
 * @param {Object} p
 * @param {(a: {message: string}) => Promise<string>} p.signMessage
 * @param {number} p.chainId
 * @param {string} p.vault
 * @param {number|bigint|string} p.pid
 * @param {(hex: string) => (string|Promise<string>)} p.keccak256  injected — see module header
 * @returns {Promise<string>} 32-byte hex salt
 */
export async function deriveSalt({ signMessage, chainId, vault, pid, keccak256 }) {
  if (typeof signMessage !== 'function')
    throw new Error('deriveSalt: needs a signMessage function — the salt IS the signature');
  if (typeof keccak256 !== 'function')
    throw new Error('deriveSalt: needs an injected keccak256 (apps/web/src carries no crypto dependency)');
  const signature = await signMessage({ message: saltMessage({ chainId, vault, pid }) });
  if (!isPlausibleSignatureHex(signature))
    throw new Error('deriveSalt: signMessage did not return signature hex — refusing to hash it into a salt');
  const salt = await keccak256(signature);
  if (!isHex32(salt)) throw new Error('deriveSalt: injected keccak256 did not return a 32-byte hex value');
  return salt;
}

/** The exact ABI field list `Governance.sol` hashes: `keccak256(abi.encode(pid, voter, support, salt))`. */
const COMMITMENT_ABI_TYPES = Object.freeze([{ type: 'uint256' }, { type: 'address' }, { type: 'bool' }, { type: 'bytes32' }]);

/**
 * The commitment `Governance.commitVote` expects, and `revealVote` re-checks byte-for-byte.
 * Mirrors `keccak256(abi.encode(pid, msg.sender, support, salt))` (Governance.sol) exactly —
 * `abi.encode`, not `encodePacked`, in this field order. Pinned against a `cast`-derived vector
 * in the test file, not against this implementation, so a subtle encoding bug cannot pass by
 * agreeing with itself.
 *
 * @param {Object} p
 * @param {number|bigint|string} p.pid
 * @param {string} p.voter  the address that will send commitVote/revealVote (msg.sender)
 * @param {boolean} p.support
 * @param {string} p.salt   32-byte hex
 * @param {(hex: string) => (string|Promise<string>)} p.keccak256
 * @param {(types: readonly {type:string}[], values: readonly unknown[]) => (string|Promise<string>)} p.encodeAbiParameters  injected — see module header
 * @returns {Promise<string>} 32-byte hex commitment
 */
export async function commitmentFor({ pid, voter, support, salt, keccak256, encodeAbiParameters }) {
  if (typeof support !== 'boolean') throw new Error('commitmentFor: support must be a boolean');
  if (!isHex32(salt)) throw new Error('commitmentFor: salt must be 32-byte hex');
  if (typeof keccak256 !== 'function' || typeof encodeAbiParameters !== 'function')
    throw new Error('commitmentFor: needs injected keccak256 and encodeAbiParameters (apps/web/src carries no crypto dependency)');
  const encoded = await encodeAbiParameters(COMMITMENT_ABI_TYPES, [BigInt(pid), voter, support, salt]);
  return keccak256(encoded);
}

/**
 * Reconstruct a member's commit/reveal state for one proposal from CHAIN DATA ALONE — never from
 * localStorage or any other local record, which can be lost or absent on the device in hand.
 * Feed it `assembleVoteCommit(...)` from `chain-reader.mjs` for `onChainCommitment`/`revealed`/
 * `revealedSupport`.
 *
 * Returns exactly one of FIVE distinguishable states (`status`):
 *
 *   - `CUSTODY_REVEALED`  — chain says this member already revealed. Nothing left to do; the
 *     direction is read from chain, never re-derived (Governance reverts `AlreadyRevealed`
 *     regardless of what any salt says, so derivation is moot here and is skipped entirely).
 *   - `CUSTODY_UNREAD`    — a required chain read did not come back as an exact typed value (a
 *     revert, a timeout, a call never attempted). NEVER coerced into "no commit" or "not
 *     revealed" — see `assembleVoteCommit`'s doc. A caller must re-read before showing any reveal
 *     action off this state.
 *   - `CUSTODY_NONE`      — `commitOf` genuinely returned `bytes32(0)`. This member has not
 *     committed a vote on this proposal.
 *   - `CUSTODY_READY`     — a commit exists, is unrevealed, and re-deriving the salt from the
 *     CURRENT wallet signature reproduces it for exactly one direction. Safe to broadcast
 *     `revealVote(pid, support, salt)`.
 *   - `CUSTODY_MISMATCH`  — **THE LOSS CASE.** A commit exists on-chain, is unrevealed, and
 *     re-deriving the salt from the current wallet signature reproduces NEITHER direction's
 *     commitment. Broadcasting a reveal with a guessed or wrong salt would either revert
 *     (`BadReveal`) or — if a caller mishandled this state by substituting some other salt — cast
 *     a losing vote the member never meant to cast. THIS STATE MUST NEVER BE TREATED AS
 *     `CUSTODY_NONE` OR `CUSTODY_READY` BY ANY CALLER. The most likely cause is a non-deterministic
 *     signer (see the module header's reproducibility caveat) that signed differently than it did
 *     at commit time. There is no automatic recovery: the correct action is to retry from the
 *     exact wallet/device/signer that produced the original commit, not to "try again" with the
 *     same one.
 *
 * @param {Object} p
 * @param {number} p.chainId
 * @param {string} p.vault
 * @param {number|bigint|string} p.pid
 * @param {string} p.voter
 * @param {string|undefined} p.onChainCommitment   from `assembleVoteCommit`
 * @param {boolean|undefined} p.revealed           from `assembleVoteCommit`
 * @param {boolean|undefined} p.revealedSupport    from `assembleVoteCommit`
 * @param {(a: {message: string}) => Promise<string>} p.signMessage
 * @param {(hex: string) => (string|Promise<string>)} p.keccak256
 * @param {(types: readonly {type:string}[], values: readonly unknown[]) => (string|Promise<string>)} p.encodeAbiParameters
 */
export async function reconstructVoteCustody({
  chainId, vault, pid, voter,
  onChainCommitment, revealed, revealedSupport,
  signMessage, keccak256, encodeAbiParameters,
}) {
  // 1. Already revealed wins outright, and derivation never runs for it: `revealVote` reverts
  // `AlreadyRevealed` unconditionally once `revealedOf[pid][voter]` is true, so no salt is
  // relevant any more. The direction is whatever chain says, not what we would derive.
  if (revealed === true) {
    if (typeof revealedSupport !== 'boolean') {
      return {
        status: CUSTODY_UNREAD,
        label: 'Vote-custody state unread',
        detail:
          'On-chain says this member already revealed, but which way they voted was not read ' +
          '(or the read failed). Re-read revealedSupportOf(pid, member) before showing anything.',
      };
    }
    return {
      status: CUSTODY_REVEALED,
      support: revealedSupport,
      label: 'Already revealed',
      detail: `This member already revealed ${revealedSupport ? 'FOR' : 'AGAINST'} on-chain. Nothing left to do.`,
    };
  }

  // 2. Any other required read that did not come back as an exact typed value is UNREAD.
  // `revealed` must be the literal boolean `false` (not merely "not true") and `onChainCommitment`
  // must be valid bytes32 hex — anything else means the read failed, timed out, or was never
  // attempted, and must not be guessed at.
  if (revealed !== false || !isHex32(onChainCommitment)) {
    return {
      status: CUSTODY_UNREAD,
      label: 'Vote-custody state unread',
      detail:
        'commitOf/revealedOf for this member were not both read successfully from chain. ' +
        'Re-read before showing a commit or reveal action.',
    };
  }

  // 3. A genuine on-chain zero IS "no commit" — not a missing read. `commitOf` is a plain public
  // mapping getter; it cannot revert on a well-formed call, so a zero here is a real fact.
  if (onChainCommitment.toLowerCase() === VOTE_COMMIT_ZERO) {
    return { status: CUSTODY_NONE, label: 'No commit', detail: 'This member has not committed a vote on this proposal.' };
  }

  // 4. A commit exists and is unrevealed. Re-derive the salt from ONE wallet signature — the salt
  // is direction-agnostic by design (see domain-separation note (c) in the module header) — and
  // test it against the on-chain commitment for both possible directions.
  const salt = await deriveSalt({ signMessage, chainId, vault, pid, keccak256 });
  for (const support of [true, false]) {
    const commitment = await commitmentFor({ pid, voter, support, salt, keccak256, encodeAbiParameters });
    if (String(commitment).toLowerCase() === onChainCommitment.toLowerCase()) {
      return {
        status: CUSTODY_READY,
        support,
        salt,
        commitment,
        label: 'Ready to reveal',
        detail: `Re-derived salt reproduces the on-chain commitment for ${support ? 'FOR' : 'AGAINST'}. Safe to call revealVote(pid, ${support}, salt).`,
      };
    }
  }

  // 5. THE LOSS CASE. See CUSTODY_MISMATCH's doc above. Explicit, distinguishable, and carries no
  // `support` or `salt` field — a caller that naively checks for those finds nothing usable rather
  // than an accidental leftover from a previous branch.
  return {
    status: CUSTODY_MISMATCH,
    onChainCommitment,
    label: 'Vote custody mismatch — DO NOT REVEAL',
    detail:
      'A commit exists on-chain for this proposal, but re-deriving the salt from the current ' +
      'wallet signature does not reproduce it. Do not broadcast a reveal with a guessed salt. ' +
      'The most likely cause is a non-deterministic signer that signed differently than it did ' +
      'at commit time — try the exact wallet/device that produced the original commit.',
  };
}

/** True only for `CUSTODY_READY` — the one state it is safe to call `revealVote` from. */
export function canReveal(state) {
  return !!state && state.status === CUSTODY_READY;
}
