// @ts-check
/**
 * Commit-reveal salt derivation — the S-4 forfeiture mitigation.
 *
 * The failure this module exists to prevent: an agent commits a vote, restarts (crash, redeploy,
 * new machine), and can no longer reconstruct the salt — so it cannot reveal, and its vote is
 * forfeit and counted as an abstain (ARCHITECTURE §8). CONSUMER-UX-SPEC §3.2 calls this "the
 * single highest-severity human-specific failure in the product"; it is worse for an autonomous
 * agent, which restarts far more often than a person changes devices.
 *
 * The fix is to hold no secret at all. The salt is DERIVED from a signature over a fixed,
 * fully-reconstructible message:
 *
 *     message = "x402-vaults:reveal-salt:v1:{chainId}:{vault}:{pid}"
 *     salt    = keccak256(account.signMessage(message))
 *
 * Every input is public and recoverable from chain state, so any process holding the same account
 * derives the same salt forever. Nothing is written to disk; there is nothing to lose.
 *
 * **v2, voter-bound.** An account with `saltVersion: 'v2'` signs
 *
 *     message = "x402-vaults:reveal-salt:v2:{chainId}:{vault}:{pid}:{voter}"
 *
 * where voter is `account.address` lowercased: the address that sends commitVote, which for a
 * smart-account agent is the account, not the key that signs. v1 carries no voter, so one salt key
 * serving several agent accounts gives them identical salts per (vault, pid), and the first reveal
 * exposes every sibling's direction (support is one bit). `signMessage` must be a dedicated salt
 * key, never a rotating session key: rotating it would make every outstanding commit unrevealable.
 * v1 stays byte-identical (the UI mirrors it in apps/web/src/vote-custody.mjs), and
 * `recoverVote` on a v2 account still tries v1, so a commit made before the switch still reveals.
 *
 * **Reproducibility caveat (honest limitation).** This holds because viem's local accounts sign
 * with RFC-6979 deterministic ECDSA — same key, same message, same signature, always. It is NOT
 * guaranteed for hardware wallets, smart-contract accounts, or any signer that adds entropy: such
 * a signer may produce a different signature each time and therefore a salt that cannot be
 * reproduced. `assertDeterministicSigner()` catches that at commit time, before the vote is at
 * risk, rather than at reveal time when it is already too late.
 *
 * The commitment itself must match Governance.sol exactly:
 *     keccak256(abi.encode(pid, msg.sender, support, salt))   // Governance.sol:292
 * — `abi.encode` (4 × 32 bytes), in that order. A mismatch reverts with `BadReveal`, producing
 * precisely the forfeiture this module prevents, so test/salt.test.mjs pins it to a `cast`-derived
 * vector rather than to our own implementation.
 */

/** viem is a lazy optional dependency here, matching packages/indexer/src/rpc.mjs. */
let _viem = null;
async function viem() {
  if (_viem) return _viem;
  _viem = await import('viem').catch(() => {
    throw new Error('salt: viem is not installed — run `npm install viem` at the repo root');
  });
  return _viem;
}

/** Domain-separated, version-tagged, and fully reconstructible from public state. */
export const SALT_MESSAGE_PREFIX = 'x402-vaults:reveal-salt:v1';
export const SALT_MESSAGE_PREFIX_V2 = 'x402-vaults:reveal-salt:v2';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The salt scheme an account derives with: `account.saltVersion`, default v1. Anything else is
 * refused rather than guessed, because a wrong guess commits a vote the agent cannot reveal.
 *
 * @param {{saltVersion?:string}} account
 * @returns {'v1'|'v2'}
 */
export function saltVersionOf(account) {
  const v = account?.saltVersion ?? 'v1';
  if (v !== 'v1' && v !== 'v2') throw new Error(`salt: unknown saltVersion ${JSON.stringify(v)} (expected 'v1' or 'v2')`);
  return v;
}

/**
 * The exact string the account signs. Deterministic in its inputs: lowercased addresses so a
 * checksummed vs. lowercase address can never derive two different salts for the same vote.
 *
 * @param {Object} p
 * @param {number} p.chainId
 * @param {string} p.vault
 * @param {number|bigint|string} p.pid
 * @param {string} [p.voter]   required for v2: the address that sends commitVote/revealVote
 * @param {'v1'|'v2'} [p.version]
 */
export function saltMessage({ chainId, vault, pid, voter, version = 'v1' }) {
  if (!ADDRESS.test(String(vault))) throw new Error(`saltMessage: not an address: ${vault}`);
  const base = `${Number(chainId)}:${String(vault).toLowerCase()}:${BigInt(pid)}`;
  if (version === 'v1') return `${SALT_MESSAGE_PREFIX}:${base}`;
  if (version !== 'v2') throw new Error(`saltMessage: unknown version ${JSON.stringify(version)}`);
  if (!ADDRESS.test(String(voter))) throw new Error(`saltMessage: v2 needs the voter address, got: ${voter}`);
  return `${SALT_MESSAGE_PREFIX_V2}:${base}:${String(voter).toLowerCase()}`;
}

/**
 * Derive the reveal salt. Pure in (account, chainId, vault, pid) — no storage, no randomness.
 * v2 binds `account.address` as the voter.
 *
 * @param {Object} p
 * @param {{address?:string, saltVersion?:string, signMessage:(a:{message:string})=>Promise<string>}} p.account
 * @param {number} p.chainId
 * @param {string} p.vault
 * @param {number|bigint|string} p.pid
 * @param {'v1'|'v2'} [p.version]  defaults to saltVersionOf(account); recoverVote passes v1 explicitly
 * @returns {Promise<string>} 32-byte hex salt
 */
export async function deriveSalt({ account, chainId, vault, pid, version = saltVersionOf(account) }) {
  if (!account || typeof account.signMessage !== 'function')
    throw new Error('deriveSalt: needs an account with signMessage — the salt IS the signature');
  const { keccak256 } = await viem();
  const message = saltMessage({ chainId, vault, pid, voter: account.address, version });
  const signature = await account.signMessage({ message });
  return keccak256(signature);
}

/**
 * The commitment Governance.commitVote expects.
 * Mirrors `keccak256(abi.encode(pid, msg.sender, support, salt))` (Governance.sol:292).
 *
 * @param {Object} p
 * @param {number|bigint|string} p.pid
 * @param {string} p.voter   the address that will send commitVote/revealVote (msg.sender)
 * @param {boolean} p.support
 * @param {string} p.salt    32-byte hex
 * @returns {Promise<string>} 32-byte hex commitment
 */
export async function commitmentFor({ pid, voter, support, salt }) {
  const { keccak256, encodeAbiParameters } = await viem();
  if (typeof support !== 'boolean') throw new Error('commitmentFor: support must be a boolean');
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(salt))) throw new Error('commitmentFor: salt must be 32-byte hex');
  const encoded = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'address' }, { type: 'bool' }, { type: 'bytes32' }],
    [BigInt(pid), voter, support, salt],
  );
  return keccak256(encoded);
}

/**
 * Derive the salt twice and compare. A signer that fails this cannot be trusted with a
 * commit-reveal vote at all: it would commit successfully and then be unable to reveal.
 *
 * Called before the FIRST commit of a session, not on every vote — one extra signature per run.
 *
 * @param {Object} p
 * @param {{signMessage:(a:{message:string})=>Promise<string>}} p.account
 * @param {number} p.chainId
 * @param {string} p.vault
 * @param {number|bigint|string} p.pid
 * @returns {Promise<{deterministic:boolean, salt:string}>}
 */
export async function assertDeterministicSigner({ account, chainId, vault, pid }) {
  const a = await deriveSalt({ account, chainId, vault, pid });
  const b = await deriveSalt({ account, chainId, vault, pid });
  if (a !== b)
    throw new Error(
      'salt: this signer is NOT deterministic — two signatures over the same message differed.\n' +
        'A non-deterministic signer (some hardware wallets, some smart-contract accounts) cannot\n' +
        'reproduce a reveal salt after a restart, so committing a vote with it risks forfeiture (S-4).\n' +
        'Use a local account (RFC-6979 ECDSA), or vote manually.',
    );
  return { deterministic: true, salt: a };
}

/**
 * Everything needed to commit AND, later, to reveal — reconstructible from public inputs alone.
 *
 * @param {Object} p
 * @param {{address:string, signMessage:(a:{message:string})=>Promise<string>}} p.account
 * @param {number} p.chainId
 * @param {string} p.vault
 * @param {number|bigint|string} p.pid
 * @param {boolean} p.support
 * @returns {Promise<{pid:bigint, vault:string, voter:string, support:boolean, salt:string, commitment:string}>}
 */
export async function buildVote({ account, chainId, vault, pid, support }) {
  const salt = await deriveSalt({ account, chainId, vault, pid });
  const commitment = await commitmentFor({ pid, voter: account.address, support, salt });
  return { pid: BigInt(pid), vault: String(vault).toLowerCase(), voter: account.address, support, salt, commitment };
}

/**
 * Recover the salt for an outstanding commit after a restart, and confirm it reproduces the
 * on-chain commitment for one of the two possible support values. This is the operation that makes
 * a restarted agent able to reveal: it holds no state, it re-derives.
 *
 * A v2 account tries v2 first, then v1: a commit made before the account switched schemes must
 * still reveal, and the commitment hash itself says which scheme produced it.
 *
 * @param {Object} p
 * @param {{address:string, saltVersion?:string, signMessage:(a:{message:string})=>Promise<string>}} p.account
 * @param {number} p.chainId
 * @param {string} p.vault
 * @param {number|bigint|string} p.pid
 * @param {string} p.onChainCommitment  commitOf(pid, voter) read from Governance
 * @returns {Promise<{support:boolean, salt:string, version:'v1'|'v2'}|null>} null when the commitment is not ours
 */
export async function recoverVote({ account, chainId, vault, pid, onChainCommitment }) {
  const versions = saltVersionOf(account) === 'v2' ? ['v2', 'v1'] : ['v1'];
  for (const version of versions) {
    const salt = await deriveSalt({ account, chainId, vault, pid, version });
    for (const support of [true, false]) {
      const c = await commitmentFor({ pid, voter: account.address, support, salt });
      if (c.toLowerCase() === String(onChainCommitment).toLowerCase()) return { support, salt, version };
    }
  }
  return null;
}
