// @ts-check
/**
 * Keystore tests. Every fixture is built here at runtime from a throwaway key, so the suite never
 * depends on — or contains — a real one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptKeystore, loadAccountFromKeystore, redact, KeystoreError } from '../lib/keystore.mjs';

const viem = await import('viem').catch(() => null);
const accounts = await import('viem/accounts').catch(() => null);
const needsViem = !viem || !accounts ? 'viem not installed' : false;

/** Build a real V3 scrypt keystore around a given key — the inverse of decryptKeystore. */
function makeKeystore(privateKey, password, { n = 8192, r = 8, p = 1, dklen = 32 } = {}) {
  const key = Buffer.from(privateKey.replace(/^0x/, ''), 'hex');
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const derived = scryptSync(Buffer.from(password, 'utf8'), salt, dklen, { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 });
  const cipher = createCipheriv('aes-128-ctr', derived.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
  const mac = viem.keccak256(new Uint8Array(Buffer.concat([derived.subarray(16, 32), ciphertext])));
  return {
    version: 3,
    id: 'test',
    crypto: {
      kdf: 'scrypt',
      kdfparams: { n, r, p, dklen, salt: salt.toString('hex') },
      cipher: 'aes-128-ctr',
      cipherparams: { iv: iv.toString('hex') },
      ciphertext: ciphertext.toString('hex'),
      mac: mac.slice(2),
    },
  };
}

const KEY = '0x' + '3'.repeat(64);
const PW = 'correct horse battery staple';

test('decryptKeystore round-trips a Foundry-shaped V3 scrypt keystore', { skip: needsViem }, async () => {
  assert.equal(await decryptKeystore(makeKeystore(KEY, PW), PW), KEY);
});

test('a wrong password fails on the MAC, not on garbage output', { skip: needsViem }, async () => {
  // The point of the MAC check: without it, a wrong password decrypts to 32 random bytes, which is
  // a valid private key for some unrelated address, and the failure surfaces much later as
  // "insufficient funds" against an address the operator has never seen.
  await assert.rejects(
    () => decryptKeystore(makeKeystore(KEY, PW), 'wrong password'),
    (err) => {
      assert.ok(err instanceof KeystoreError);
      assert.match(err.message, /MAC mismatch — wrong password/);
      return true;
    },
  );
});

test('a tampered ciphertext is rejected', { skip: needsViem }, async () => {
  const ks = makeKeystore(KEY, PW);
  ks.crypto.ciphertext = ks.crypto.ciphertext.replace(/^../, '00');
  await assert.rejects(() => decryptKeystore(ks, PW), /MAC mismatch/);
});

test('a 0x-prefixed mac field is accepted (writers differ on this)', { skip: needsViem }, async () => {
  const ks = makeKeystore(KEY, PW);
  ks.crypto.mac = '0x' + ks.crypto.mac;
  assert.equal(await decryptKeystore(ks, PW), KEY);
});

test('unsupported kdf / cipher / version are refused explicitly, not half-handled', { skip: needsViem }, async () => {
  const base = makeKeystore(KEY, PW);
  await assert.rejects(() => decryptKeystore({ ...base, version: 4 }, PW), /unsupported keystore version 4/);
  await assert.rejects(
    () => decryptKeystore({ ...base, crypto: { ...base.crypto, kdf: 'pbkdf2' } }, PW),
    /unsupported kdf "pbkdf2"/,
  );
  await assert.rejects(
    () => decryptKeystore({ ...base, crypto: { ...base.crypto, cipher: 'aes-256-cbc' } }, PW),
    /unsupported cipher/,
  );
});

test('malformed keystores and empty passwords are refused', { skip: needsViem }, async () => {
  await assert.rejects(() => decryptKeystore(null, PW), /not an object/);
  await assert.rejects(() => decryptKeystore(makeKeystore(KEY, PW), ''), /password is required/);
  const noKdf = makeKeystore(KEY, PW);
  noKdf.crypto.kdfparams = { ...noKdf.crypto.kdfparams, n: 0 };
  await assert.rejects(() => decryptKeystore(noKdf, PW), /kdfparams.n is invalid/);
});

test('loadAccountFromKeystore yields a signing account and never surfaces the key', { skip: needsViem }, async () => {
  const expected = accounts.privateKeyToAccount(KEY);
  const dir = await mkdtemp(join(tmpdir(), 'ks-'));
  const path = join(dir, 'tester');
  await writeFile(path, JSON.stringify(makeKeystore(KEY, PW)), 'utf8');

  const account = await loadAccountFromKeystore(path, PW);
  assert.equal(account.address, expected.address);
  assert.equal(typeof account.signTypedData, 'function');
  // Nothing key-shaped may survive a redacted dump of the account.
  assert.ok(!JSON.stringify(redact(account)).includes(KEY.slice(2)));
});

test('loadAccountFromKeystore reports an unreadable path as a KeystoreError', { skip: needsViem }, async () => {
  await assert.rejects(() => loadAccountFromKeystore(join(tmpdir(), 'no-such-keystore-xyz'), PW), KeystoreError);
});

// ── redact ──

test('redact reduces an account to its address', () => {
  const account = { address: '0x' + '1'.repeat(40), signTypedData: () => {}, source: 'privateKey' };
  assert.deepEqual(redact(account), { address: '0x' + '1'.repeat(40) });
});

test('redact removes key-shaped strings and secret-named fields wherever they hide', () => {
  const out = redact({
    ok: 'visible',
    privateKey: KEY,
    password: 'hunter2',
    nested: { mnemonic: 'a b c', stray: KEY, list: [KEY, 'fine'] },
  });
  const s = JSON.stringify(out);
  assert.ok(!s.includes('3'.repeat(64)), 'no key-shaped string may survive');
  assert.ok(!s.includes('hunter2'));
  assert.ok(!s.includes('a b c'));
  assert.equal(out.ok, 'visible');
  assert.equal(out.nested.list[1], 'fine');
});

test('redact leaves ordinary hashes and addresses readable (they are the evidence)', () => {
  // A 32-byte hex string is key-shaped, so tx hashes ARE redacted by the string rule — the runner
  // must therefore pass hashes as named fields it prints directly, not through redact(). Addresses
  // (20 bytes) and nonces read back from a transcript stay legible.
  assert.equal(redact('0x' + '1'.repeat(40)), '0x' + '1'.repeat(40));
  assert.equal(redact('0x' + 'a'.repeat(64)), '[redacted-32-byte-secret]');
});
