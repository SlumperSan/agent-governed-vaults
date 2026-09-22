// @ts-check
/**
 * Card 179 — the declared creator must actually EXIST on chain, as the kind of account the
 * deployment record says it is.
 *
 * ## What was measured, 2026-09-21
 *
 * The Arc mainnet creator Safe `0x99e805294F1f1465C96f68e36264E99991Ef9E82` has **no bytecode on
 * chain 5042**: `eth_getCode` returns `0x` and `eth_getTransactionCount` returns `0x0` against
 * `rpc.mainnet.arc.io`, and no bytecode exists for it on Arc testnet, Base, Base Sepolia, Ethereum,
 * Arbitrum or Optimism either. A Gnosis Safe address is deterministic and knowable BEFORE the Safe
 * is deployed, so a predicted-but-never-activated address satisfies every comparison
 * `requireIntendedCreator` makes — that function compares the address used against the address
 * declared and never asks whether anything is there.
 *
 * `VaultCore.creator` is immutable with no rotation path, so a first vault created against an
 * unactivated Safe is the one item on the launch list that cannot be re-run.
 *
 * ## Why the check is two-directional rather than "the creator must have code"
 *
 * The one-sided version was considered and is wrong: this deployment's own `intendedCreator` is
 * `0x0f80606a…9f35`, an **EOA**, and `eth_getCode` returns `0x` for it on chain 84532 — verified
 * against `sepolia.base.org` on 2026-09-21, exactly as an EOA must read. A blanket code-exists rule
 * refuses the working testnet path. So the record declares which kind it intends, and a disagreement
 * either way is a refusal.
 *
 * ## Why these are executable tests
 *
 * Rounds 1–3 of PR #329 were rejected for asserting over `smoke-test.mjs`'s source text: `gate.mjs`
 * lists that file under `ENTRYPOINTS`, which is `node --check` only, so a regex could see that a
 * call existed, and where it sat, and never that it did anything — replacing
 * `assert(!refusal, refusal)` with a log kept 17 tests green. Every behavioural assertion below
 * calls `creatorCodeRefusal` / `requireCreatorCode` directly. The single source assertion at the end
 * is narrow and says so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { creatorCodeRefusal, requireCreatorCode, CreationRefused } from '../smoke-preflight.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The real, unactivated Arc creator Safe. */
const SAFE = '0x99e805294F1f1465C96f68e36264E99991Ef9E82';
/** This deployment's real creator EOA. */
const EOA = '0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35';
const ZERO = '0x0000000000000000000000000000000000000000';
const ARC = 5042;
const BASE_SEPOLIA = 84532;
/** Any non-empty bytecode; the check cares that there IS code, never what it is. */
const SOME_CODE = '0x60806040';

test('a contract-kind creator with NO code on its own chain is REFUSED', () => {
  const r = creatorCodeRefusal({
    address: SAFE, code: '0x', observedChainId: '0x13b2', declaredChainId: ARC, kind: 'contract',
  });
  assert.ok(r, 'an unactivated Safe declared as a contract must be refused');
  assert.match(r, /NO BYTECODE/, 'the refusal must say what the chain actually reported');
  assert.match(r, /immutable/, 'and why it cannot be corrected afterwards');
});

test('the throwing wrapper the runner calls actually throws', () => {
  // The runner has no `assert` to neuter here — the throw is the enforcement, which is why it lives
  // in smoke-preflight.mjs where this test can reach it.
  assert.throws(
    () => requireCreatorCode({
      address: SAFE, code: '0x', observedChainId: ARC, declaredChainId: ARC, kind: 'contract',
    }),
    (err) => err instanceof CreationRefused && /NO BYTECODE/.test(err.message),
  );
  // ...and hands back the address on the passing path, so a caller cannot mistake undefined for OK.
  assert.equal(
    requireCreatorCode({ address: EOA, code: '0x', observedChainId: BASE_SEPOLIA, declaredChainId: BASE_SEPOLIA, kind: 'eoa' }),
    EOA,
  );
});

test("every empty-code spelling counts as absent, including the non-standard '0x0'", () => {
  // Some providers answer '0x0' rather than '0x'. Reading that as "has code" is a false pass on the
  // single thing this check exists for.
  for (const empty of ['0x', '0x0', '', '  0X0  ', '0X']) {
    assert.ok(
      creatorCodeRefusal({ address: SAFE, code: empty, observedChainId: ARC, declaredChainId: ARC, kind: 'contract' }),
      `code ${JSON.stringify(empty)} must count as absent`,
    );
  }
});

test('the CORRECT current deployment still passes — an EOA creator with no code', () => {
  assert.equal(
    creatorCodeRefusal({
      address: EOA, code: '0x', observedChainId: '0x14a34', declaredChainId: BASE_SEPOLIA, kind: 'eoa',
    }),
    null,
    'an EOA with no code is exactly what an EOA looks like, and the one-sided version of this check refuses it',
  );
});

test('an EOA-kind creator that turns out to be a CONTRACT is refused too', () => {
  const r = creatorCodeRefusal({
    address: EOA, code: SOME_CODE, observedChainId: BASE_SEPOLIA, declaredChainId: BASE_SEPOLIA, kind: 'eoa',
  });
  assert.ok(r, 'bytecode at an address declared an EOA means the operator is wrong about what they hold');
  assert.match(r, /is a contract/);
});

test('a contract-kind creator WITH code passes', () => {
  assert.equal(
    creatorCodeRefusal({ address: SAFE, code: SOME_CODE, observedChainId: ARC, declaredChainId: ARC, kind: 'contract' }),
    null,
    'an activated Safe is the state this check is waiting for, and must not be refused',
  );
});

test('a MISSING intendedCreatorKind is a refusal, never a skip', () => {
  // The guard-that-skips shape: without this, an Arc record opts out of the check that exists for it
  // by omitting one field.
  for (const kind of [undefined, null, '', 'safe', 'multisig', 42, {}]) {
    const r = creatorCodeRefusal({ address: SAFE, code: '0x', observedChainId: ARC, declaredChainId: ARC, kind });
    assert.ok(r, `kind ${JSON.stringify(kind)} must refuse rather than skip`);
    assert.match(r, /intendedCreatorKind/);
  }
});

test('case and surrounding whitespace in the kind are normalised, not rejected', () => {
  assert.equal(
    creatorCodeRefusal({ address: EOA, code: '0x', observedChainId: ARC, declaredChainId: ARC, kind: '  EOA ' }),
    null,
  );
  assert.ok(
    creatorCodeRefusal({ address: SAFE, code: '0x', observedChainId: ARC, declaredChainId: ARC, kind: 'CONTRACT' }),
    'a normalised contract kind still enforces the code requirement',
  );
});

test('code read on the WRONG chain is refused, however healthy the answer looks', () => {
  // The adjacent-property trap, and easy to hit here because this path routinely holds two chains at
  // once: the Safe has no code on 5042, and an answer from Base Sepolia says nothing about 5042.
  const r = creatorCodeRefusal({
    address: SAFE, code: SOME_CODE, observedChainId: BASE_SEPOLIA, declaredChainId: ARC, kind: 'contract',
  });
  assert.ok(r, 'a code read from another chain must not satisfy this check');
  assert.match(r, /read on chain 84532/);
  assert.match(r, /record is for chain 5042/);
});

test('hex and decimal chain ids compare equal', () => {
  // `cast chain-id` and `eth_chainId` disagree on formatting; a string/number mismatch here would
  // refuse every correct input and get the check deleted on deploy night.
  assert.equal(
    creatorCodeRefusal({ address: SAFE, code: SOME_CODE, observedChainId: '0x13b2', declaredChainId: 5042, kind: 'contract' }),
    null,
  );
  assert.equal(
    creatorCodeRefusal({ address: SAFE, code: SOME_CODE, observedChainId: 5042, declaredChainId: '5042', kind: 'contract' }),
    null,
  );
});

test('an unreadable chain id, or a failed code read, refuses rather than assuming', () => {
  const cases = [
    { observedChainId: 'nope', declaredChainId: ARC, code: SOME_CODE },
    { observedChainId: 0, declaredChainId: ARC, code: SOME_CODE },
    { observedChainId: ARC, declaredChainId: undefined, code: SOME_CODE },
    { observedChainId: ARC, declaredChainId: 0, code: SOME_CODE },
    { observedChainId: ARC, declaredChainId: ARC, code: null },
    { observedChainId: ARC, declaredChainId: ARC, code: undefined },
    { observedChainId: ARC, declaredChainId: ARC, code: 42 },
  ];
  for (const c of cases) {
    assert.ok(
      creatorCodeRefusal({ address: SAFE, kind: 'contract', ...c }),
      `${JSON.stringify(c)} must refuse rather than treat an unknown as an answer`,
    );
  }
});

test('a malformed creator address is refused before the chain is consulted', () => {
  for (const bad of ['TBD', '0xabc', ZERO, undefined, null, 12345]) {
    assert.ok(
      creatorCodeRefusal({ address: bad, code: SOME_CODE, observedChainId: ARC, declaredChainId: ARC, kind: 'contract' }),
      `${JSON.stringify(bad)} must be refused on shape`,
    );
  }
});

test('the SHIPPED deployment record declares a kind, and does not refuse itself', () => {
  // The real record, not a fixture — so an Arc record added without the field fails here rather than
  // silently skipping the check at deploy time.
  const rec = JSON.parse(readFileSync(path.join(ROOT, 'contracts/config/deployments/base-sepolia.json'), 'utf8'));
  assert.ok(
    ['eoa', 'contract'].includes(String(rec.intendedCreatorKind).trim().toLowerCase()),
    `base-sepolia.json declares intendedCreatorKind ${JSON.stringify(rec.intendedCreatorKind)}, which is not usable`,
  );
  assert.equal(
    creatorCodeRefusal({
      address: rec.intendedCreator,
      code: '0x', // what Base Sepolia actually returns for this EOA, measured 2026-09-21
      observedChainId: rec.chainId,
      declaredChainId: rec.chainId,
      kind: rec.intendedCreatorKind,
    }),
    null,
    'the shipped record must not refuse itself',
  );
});

test('the runner reads the chain id from the SAME connection as the code', () => {
  // Source assertion deliberately, and the only one here: the behaviour is owned by the executable
  // tests above. This pins the one property no unit test of a pure function can see — that the
  // caller does not pass the record's own chainId as both sides, which would make the mismatch
  // branch unreachable and the check meaningless.
  const runner = readFileSync(path.join(ROOT, 'scripts/smoke-test.mjs'), 'utf8');
  const i = runner.indexOf('requireCreatorCode({');
  assert.ok(i > 0, 'stepCreateVault does not call requireCreatorCode');
  const call = runner.slice(i, runner.indexOf('});', i));
  assert.match(call, /code:\s*cast\(\['code',/, 'the code must be read live, not taken from the record');
  assert.match(call, /observedChainId:\s*cast\(\['chain-id'/, 'the chain id must come from the same RPC as the code');
  assert.match(call, /declaredChainId:\s*deployment\.chainId/);
  assert.match(call, /kind:\s*deployment\.intendedCreatorKind/);
});
