// @ts-check
/**
 * Web3 Secret Storage (keystore V3) decryption — enough of it to unlock a Foundry `cast wallet`
 * keystore in-process.
 *
 * ## Why this exists
 *
 * The live x402 runner needs a viem *account object*. The operator has a password-encrypted
 * keystore. The alternatives were worse:
 *
 *   - `SETTLER_PRIVATE_KEY=0x…` in the environment — one leaked shell history, `ps` listing, or
 *     crash dump away from a drained wallet, and exactly the pattern the reference agent refuses
 *     (see packages/reference-agent/src/run.mjs).
 *   - `cast wallet private-key …` piped in — prints the key to a terminal and into scrollback.
 *
 * Decrypting in-process keeps the plaintext key alive for the few microseconds between derivation
 * and `privateKeyToAccount`, inside one process, never written and never logged.
 *
 * ## Scope
 *
 * Deliberately narrow: V3 + scrypt + aes-128-ctr, which is what Foundry writes. PBKDF2 keystores
 * (geth's older default) are rejected with a clear message rather than half-supported. Everything
 * here is Node built-ins plus viem's keccak256 — no new dependency for a security-sensitive path.
 *
 * ## Handling rule
 *
 * `decryptKeystore` returns a raw private key. It has exactly one legitimate caller shape:
 *
 *     const account = privateKeyToAccount(await decryptKeystore(json, pw));
 *
 * Do not store the return value, pass it onward, put it in an object that gets logged, or return
 * it from anything. `loadAccountFromKeystore` below does this correctly; prefer it.
 */

import { readFile } from 'node:fs/promises';
import { createDecipheriv, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

export class KeystoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KeystoreError';
  }
}

/**
 * Decrypt a V3 keystore object.
 *
 * @param {object} keystore  parsed keystore JSON
 * @param {string} password
 * @returns {Promise<`0x${string}`>} the private key — consume immediately, never retain
 */
export async function decryptKeystore(keystore, password) {
  const { keccak256 } = await import('viem').catch(() => {
    throw new KeystoreError('viem is required to verify the keystore MAC — run `npm install viem`');
  });

  if (!keystore || typeof keystore !== 'object') throw new KeystoreError('keystore is not an object');
  if (keystore.version !== 3) throw new KeystoreError(`unsupported keystore version ${keystore.version} (need 3)`);
  if (typeof password !== 'string' || password.length === 0)
    throw new KeystoreError('a keystore password is required');

  const c = keystore.crypto ?? keystore.Crypto;
  if (!c) throw new KeystoreError('keystore has no crypto section');
  if (c.kdf !== 'scrypt')
    throw new KeystoreError(`unsupported kdf ${JSON.stringify(c.kdf)} — only scrypt is supported (Foundry's default)`);
  if (c.cipher !== 'aes-128-ctr')
    throw new KeystoreError(`unsupported cipher ${JSON.stringify(c.cipher)} — only aes-128-ctr is supported`);

  const { n: N, r, p, dklen, salt } = c.kdfparams ?? {};
  for (const [k, v] of Object.entries({ n: N, r, p, dklen })) {
    if (!Number.isInteger(v) || v <= 0) throw new KeystoreError(`keystore kdfparams.${k} is invalid`);
  }
  if (typeof salt !== 'string') throw new KeystoreError('keystore kdfparams.salt is invalid');

  // scrypt's working set is roughly 128 * N * r bytes; Node's default maxmem (32 MB) is too small
  // for the larger parameter sets people legitimately use, so size it from the params.
  const maxmem = Math.max(32 * 1024 * 1024, 256 * N * r + 1024 * 1024);
  const derived = /** @type {Buffer} */ (
    await scrypt(Buffer.from(password, 'utf8'), Buffer.from(salt, 'hex'), dklen, { N, r, p, maxmem })
  );

  const ciphertext = Buffer.from(c.ciphertext, 'hex');

  // MAC over the SECOND half of the derived key — this is what proves the password, and it must be
  // checked before decrypting. A wrong password otherwise yields 32 bytes of garbage that is a
  // perfectly well-formed private key for some unrelated, unfunded address, and the run fails much
  // later with something unhelpful like "insufficient funds".
  const mac = keccak256(new Uint8Array(Buffer.concat([derived.subarray(16, 32), ciphertext])));
  const expected = Buffer.from(String(c.mac).replace(/^0x/, ''), 'hex');
  const actual = Buffer.from(mac.slice(2), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new KeystoreError('keystore MAC mismatch — wrong password (or a corrupt keystore file)');

  const decipher = createDecipheriv('aes-128-ctr', derived.subarray(0, 16), Buffer.from(c.cipherparams.iv, 'hex'));
  const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (key.length !== 32) throw new KeystoreError(`decrypted key is ${key.length} bytes, expected 32`);
  return /** @type {`0x${string}`} */ (`0x${key.toString('hex')}`);
}

/**
 * Read a keystore file and return a viem account — the private key never escapes this function.
 *
 * @param {string} path      keystore file path (e.g. ~/.foundry/keystores/deployer)
 * @param {string} password
 * @returns {Promise<any>} viem account object
 */
export async function loadAccountFromKeystore(path, password) {
  const { privateKeyToAccount } = await import('viem/accounts').catch(() => {
    throw new KeystoreError('viem is required — run `npm install viem`');
  });
  let json;
  try {
    json = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new KeystoreError(`cannot read keystore at ${path}: ${err?.message ?? err}`);
  }
  // Single expression on purpose: no binding for the plaintext key to outlive this line.
  return privateKeyToAccount(await decryptKeystore(json, password));
}

/**
 * Reduce anything that might hold key material to something safe to print. Mirrors the reference
 * agent's `redact()`: an account becomes `{ address }` and a key-shaped string becomes a marker.
 * Every log line and transcript field in the runner goes through this.
 * @param {any} value
 */
export function redact(value) {
  if (value == null) return value;
  if (typeof value === 'string')
    return /^0x[0-9a-fA-F]{64}$/.test(value) ? '[redacted-32-byte-secret]' : value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    if (typeof value.address === 'string' && (value.signTypedData || value.sign || value.signMessage))
      return { address: value.address };
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /priv|secret|password|mnemonic|seed/i.test(k) ? '[redacted]' : redact(v);
    }
    return out;
  }
  return value;
}
