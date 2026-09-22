// @ts-check
/**
 * The regression this file exists for. smoke-test.mjs's wiring-immutability check was
 *
 *   let rewired = false;
 *   try { call(dep.registry, 'wire(address,address)', …); rewired = true; } catch { (expected revert) }
 *   assert(!rewired, 'registry.wire() did NOT revert — deployment is not wired/locked correctly');
 *
 * so ANY failed call — a 429, a timeout, a DNS miss, a missing `cast` binary — was read as the
 * expected revert and the assertion PASSED, reporting the deployment wired and locked without
 * having tested it. That is the quiet direction of the bug PR #173 fixed in the soak harness and
 * PR #179 in the canary: a false PASS on a security assertion rather than a false alarm.
 *
 * Fixtures are cast's real wording — the set scripts/test/soak-drills.test.mjs measures
 * `classifyCallError` against — plus two failures specific to this runner: `spawnSync cast ENOENT`
 * (cast not on PATH, which execFileSync reports with no stderr) and the local-decode spelling of
 * the two reverts OperatorRegistry.wire() can produce.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  wiringImmutabilityFailure, oracleProbeWarning, intendedCreatorRefusal, normAddr,
  requireIntendedCreator, loadDeploymentRecord, CreationRefused, signerCacheRefusal, addressShapeRefusal,
  contractCreatorRoutingRefusal,
} from '../smoke-preflight.mjs';

const REVERTS = [
  'Error: server returned an error response: error code 3: execution reverted, data: "0x88cce429"',
  'Error: execution reverted',
  'reverted: AlreadyWired()',
  'reverted: OnlyDeployer()',
];
const NOT_A_VERDICT = [
  'error sending request: 429 Too Many Requests',
  'Error: operation timed out',
  'ECONNRESET',
  'getaddrinfo ENOTFOUND base-sepolia-rpc.publicnode.com',
  'max retries exceeded',
  'error sending request: 503 Service Unavailable',
  'spawnSync cast ENOENT',
  'wording nobody has seen before',
];

test('wiring: a transport failure can no longer satisfy the immutability assertion', () => {
  for (const error of NOT_A_VERDICT) {
    const f = wiringImmutabilityFailure({ ok: false, error });
    assert.notEqual(f, null, `must FAIL loudly, not pass as the expected revert: ${error}`);
    assert.match(String(f), /could not be confirmed to revert/);
    assert.match(String(f), /UNVERIFIED, not broken/);
    assert.doesNotMatch(String(f), /did NOT revert|not wired/, 'an unmade call is not a finding about the lock');
    assert.ok(String(f).includes(error), "carries cast's own words so the operator sees what actually failed");
  }
});

test('wiring: a genuine revert still satisfies it', () => {
  for (const error of REVERTS) {
    assert.equal(wiringImmutabilityFailure({ ok: false, error }), null, `a confirmed revert is the lock holding: ${error}`);
  }
});

test('wiring: a call the registry ACCEPTS is the original finding, unchanged', () => {
  assert.equal(
    wiringImmutabilityFailure({ ok: true, value: [] }),
    'registry.wire() did NOT revert — deployment is not wired/locked correctly',
  );
});

test('wiring: a revert whose text also carries a transport-looking token is still the lock holding', () => {
  // The same guard soak-drills pins for classifyCallError: a 429-like number inside revert data
  // must not demote the revert to missing evidence, or a held lock reads as an RPC outage.
  assert.equal(wiringImmutabilityFailure({ ok: false, error: 'execution reverted, data: "0x429" timeout' }), null);
});

test('oracle: a transport failure is no longer attributed to a stale feed or a working breaker', () => {
  for (const error of NOT_A_VERDICT) {
    const w = oracleProbeWarning('WETH', error);
    assert.equal(w.kind, 'transport');
    assert.ok(w.message.startsWith('WARN oracle WETH: priceWad could not be read ('), w.message);
    assert.doesNotMatch(w.message, /stale|breaker|reverted \(/i, 'says nothing about the feed either way');
    assert.ok(w.message.includes(error));
  }
});

test('oracle: a confirmed revert is reported as the contract refusing to price, and is still a WARN', () => {
  for (const error of REVERTS) {
    const w = oracleProbeWarning('LINK', error);
    assert.equal(w.kind, 'revert');
    assert.ok(w.message.startsWith('WARN oracle LINK: priceWad reverted ('), w.message);
    assert.match(w.message, /StaleOracle/);
    assert.match(w.message, /the run continues$/);
  }
});

test('oracle: only the first line of a multi-line cast error reaches the log', () => {
  const w = oracleProbeWarning('WETH', 'Error: execution reverted\n\nContext:\n- request …');
  assert.ok(w.message.includes('(Error: execution reverted)'), w.message);
  assert.ok(!w.message.includes('Context'), 'the rest of cast\'s stderr is noise on a WARN line');
});

// The runner cannot be imported (it drives cast on load), so the wiring of the two verdicts into
// it is pinned at the source level: the bare catch that produced the false PASS must not come
// back, and both verdicts must be the ones the runner actually consults.
// ── who may create a vault (the 4663 divergence) ─────────────────────────────
//
// `VaultCore.createVault` fixes `msg.sender` as the vault's immutable creator and attested operator.
// On chain 4663 both vaults were created by the deployer EOA while the record named the creator Safe,
// and nothing compared them; `creator` has no rotation path, so the remedy was a new vault.
//
// THE CHECK THIS REPLACES WAS TRUE BY CONSTRUCTION: the runner asserted the creator in the event
// equalled the SIGNER, which is what the chain guarantees anyway. It passed on 4663 every time.

test('a signer that matches the declared intendedCreator may proceed', () => {
  const a = '0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35';
  assert.equal(intendedCreatorRefusal(a, a), null);
});

test('case and whitespace do not make the same address a different one', () => {
  // A checksummed record against a lowercased signer is the SAME party; refusing there would teach
  // the operator that the check is noise, which is how a check gets bypassed.
  const a = '0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35';
  assert.equal(intendedCreatorRefusal(a.toLowerCase(), ` ${a.toUpperCase()} `), null);
});

test('THE 4663 CASE: a signer that is not the declared creator is refused, naming both', () => {
  const eoa = '0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35';
  const safe = '0xC73Bd58725afF051109b97B7Be40a8E31C6CAD4c';
  const refusal = intendedCreatorRefusal(safe, eoa);
  assert.ok(refusal, 'the exact divergence that shipped on 4663 must not pass');
  assert.match(refusal, /REFUSING TO CREATE/);
  assert.ok(refusal.includes(eoa) && refusal.includes(safe), 'the refusal must name BOTH addresses');
});

test('a MISSING intendedCreator refuses rather than skipping — that state is the defect', () => {
  // The direction that matters most. A record with nothing declared is exactly the 4663 condition,
  // so "no declaration" must not read as "no objection".
  const a = '0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35';
  for (const missing of [undefined, null, '', '   ']) {
    const refusal = intendedCreatorRefusal(missing, a);
    assert.ok(refusal, `an intendedCreator of ${JSON.stringify(missing)} must refuse, not pass`);
    assert.match(refusal, /declares no `intendedCreator`/);
  }
});

test('an unknown signer refuses too — an unproven comparison is not a comparison', () => {
  const a = '0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35';
  for (const nosigner of [undefined, null, '']) {
    assert.ok(intendedCreatorRefusal(a, nosigner), 'a missing signer must refuse');
  }
});

test('the shipped Base Sepolia record declares an intendedCreator, so the check has something to do', () => {
  // Non-vacuity: the verdict above is only worth having if the record it reads actually carries the
  // field. Without this, every assertion here passes over a record that would refuse in practice.
  const record = JSON.parse(
    readFileSync(path.join(import.meta.dirname, '..', '..', 'contracts', 'config', 'deployments', 'base-sepolia.json'), 'utf8'),
  );
  assert.match(record.intendedCreator ?? '', /^0x[0-9a-fA-F]{40}$/, 'base-sepolia.json declares no intendedCreator');
  assert.equal(intendedCreatorRefusal(record.intendedCreator, record.intendedCreator), null);
});

// ── the Arc gap: a CONTRACT-kind creator can never equal the signer, and must not be told it does ──
//
// The owner recorded creator Safe 0x99e805294F1f1465C96f68e36264E99991Ef9E82 on Arc on 2026-09-21.
// `intendedCreatorRefusal` compares the signer's own address to the declared creator, which is right
// for an EOA (msg.sender for a direct send IS the signer) and wrong for a contract (msg.sender only
// becomes the contract when the call is ROUTED THROUGH IT, which this script never does) -- so it
// refused every Safe-routed creation, with a message that reads as "wrong signer" when the real
// problem is "no routing path exists". `contractCreatorRoutingRefusal` is the kind-aware replacement.

test('contractCreatorRoutingRefusal refuses UNCONDITIONALLY -- there is no signer that passes it', () => {
  const safe = '0x99e805294F1f1465C96f68e36264E99991Ef9E82';
  const refusal = contractCreatorRoutingRefusal(safe);
  assert.ok(refusal, 'a contract-kind creator must always refuse under direct-send routing');
  assert.match(refusal, /REFUSING TO CREATE/);
  assert.match(refusal, /execTransaction/, 'must name the missing routed-execution path, not report a mismatch');
  assert.ok(refusal.includes(safe), 'must name the declared contract');
  assert.doesNotMatch(refusal, /the signer is/i, 'must not read as a wrong-signer finding -- that is the bug this replaces');
});

test('requireIntendedCreator routes on intendedCreatorKind: "contract" refuses even when the signer owns the Safe', () => {
  // THE EXACT ARC SHAPE. Even the deployer EOA itself -- who really is the Safe's sole owner --
  // cannot pass this: ownership does not change what msg.sender would be under a direct send.
  const safe = '0x99e805294F1f1465C96f68e36264E99991Ef9E82';
  const ownerEoa = '0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35';
  assert.throws(
    () => requireIntendedCreator({ intendedCreator: safe, intendedCreatorKind: 'contract' }, ownerEoa),
    (err) => {
      assert.ok(err instanceof CreationRefused);
      assert.match(err.message, /execTransaction/);
      return true;
    },
    'a contract-kind record must refuse regardless of who signs',
  );
  // Case/whitespace on the kind must not be a way to slip past the branch.
  assert.throws(
    () => requireIntendedCreator({ intendedCreator: safe, intendedCreatorKind: '  Contract  ' }, ownerEoa),
    CreationRefused,
  );
});

test('requireIntendedCreator with NO kind, or kind "eoa", keeps the original address-equality check', () => {
  // Backward compatibility, asserted rather than assumed: every record and test written before
  // intendedCreatorKind existed -- including the shipped base-sepolia.json, which declares "eoa" --
  // must be completely unaffected by the contract branch.
  const a = '0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35';
  assert.equal(requireIntendedCreator({ intendedCreator: a }, a), a, 'no kind at all: unchanged');
  assert.equal(requireIntendedCreator({ intendedCreator: a, intendedCreatorKind: 'eoa' }, a), a, 'kind "eoa": unchanged');
  assert.throws(() => requireIntendedCreator({ intendedCreator: a }, '0x1111111111111111111111111111111111111111'), CreationRefused);
});

test('requireIntendedCreator THROWS rather than reporting — the enforcement is callable now', () => {
  // THE ROUND-2 BLOCKER. Replacing `assert(!refusal, refusal)` in the runner with a log line kept
  // 17/17 green, because every assertion about `smoke-test.mjs` was a regex over its source: a regex
  // sees that a call exists and where it sits, never that it does anything. `gate.mjs` only
  // `node --check`s that file, so there was no way to reach the property from outside it.
  //
  // These call the enforcement. A `log` in place of the throw is not a mutation that survives here;
  // it is a change to a function whose contract is that it throws.
  const safe = '0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35';
  const eoa = '0x1111111111111111111111111111111111111111';

  assert.equal(requireIntendedCreator({ intendedCreator: safe }, safe), safe, 'a matching signer returns the declaration');
  assert.equal(requireIntendedCreator({ intendedCreator: ` ${safe} ` }, safe.toUpperCase().replace('0X', '0x')), ` ${safe} `,
    'padding and case are normalised on BOTH sides, so neither broadcasts before failing');

  // Every refusing input, and the class rather than only the message: a caller that catches by type
  // must be able to.
  const refusals = [
    ['a different signer', { intendedCreator: safe }, eoa],
    ['no declaration', {}, safe],
    ['an empty declaration', { intendedCreator: '' }, safe],
    ['a whitespace declaration', { intendedCreator: '   ' }, safe],
    ['a null declaration', { intendedCreator: null }, safe],
    ['a non-string declaration', { intendedCreator: 42 }, safe],
    ['no record at all', null, safe],
    ['an undefined record', undefined, safe],
    ['an unknown signer', { intendedCreator: safe }, undefined],
    ['an empty signer', { intendedCreator: safe }, ''],
  ];
  for (const [why, deployment, signer] of refusals) {
    assert.throws(
      () => requireIntendedCreator(deployment, signer),
      (err) => {
        assert.ok(err instanceof CreationRefused, `${why}: must throw CreationRefused, got ${err?.name}`);
        assert.ok(String(err.message).length > 40, `${why}: the refusal must say what is wrong`);
        return true;
      },
      `must refuse: ${why}`,
    );
  }
});

test('loadDeploymentRecord refuses a missing record, a wrong chain and unreadable JSON — by behaviour', () => {
  // Round 2 covered these with a regex for `if (!fs.existsSync` and one for the comparison's text.
  // Both were evadable without changing what the code does: the existsSync ban by respelling it, the
  // chain check by `true ||`. These call the function instead.
  const files = new Map();
  const io = {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT ${p}`);
      return files.get(p);
    },
  };
  const D = '/rec.json';
  const C = '/cfg.json';
  const load = () => loadDeploymentRecord({ deploymentPath: D, configPath: C, ...io });

  // 1. missing record
  files.set(C, JSON.stringify({ chainId: 84532 }));
  assert.throws(load, (e) => e instanceof CreationRefused && /not found at/.test(e.message), 'a missing record must refuse');

  // 2. unreadable JSON
  files.set(D, '{ not json');
  assert.throws(load, (e) => e instanceof CreationRefused && /not readable JSON/.test(e.message));

  // 3. wrong chain, in both directions
  files.set(D, JSON.stringify({ chainId: 8453, intendedCreator: '0x1111111111111111111111111111111111111111' }));
  assert.throws(load, (e) => e instanceof CreationRefused && /is for chain 8453/.test(e.message), 'a record for another chain must refuse');
  files.set(D, JSON.stringify({ intendedCreator: '0x1111111111111111111111111111111111111111' })); // no chainId at all
  assert.throws(load, (e) => e instanceof CreationRefused && /is for chain undefined/.test(e.message));

  // 4. a config with no usable chainId cannot be matched against, so it refuses rather than passing
  files.set(D, JSON.stringify({ chainId: 84532, intendedCreator: '0x1111111111111111111111111111111111111111' }));
  files.set(C, JSON.stringify({}));
  assert.throws(load, (e) => e instanceof CreationRefused && /no usable chainId/.test(e.message));
  files.set(C, JSON.stringify({ chainId: 0 }));
  assert.throws(load, (e) => e instanceof CreationRefused && /no usable chainId/.test(e.message));

  // 5. and the matching case returns the record -- without this the five above would pass with a
  //    function that threw unconditionally.
  files.set(C, JSON.stringify({ chainId: 84532 }));
  assert.deepEqual(load(), { chainId: 84532, intendedCreator: '0x1111111111111111111111111111111111111111' });
});

test('the signer is DERIVED every run, and a cached one that disagrees refuses', () => {
  // THE ROUND-3 BLOCKER, and it is 4663 reproduced through the new guard. `smoke-test.mjs` derived
  // the signer only `if (!state.signer)` while `send()` broadcasts with the live SMOKE_SIGNER_ARGS, so
  // a resumed run validated a persisted STRING against the record while a different key was on the
  // wire. The reader reproduced it executably: record declares the Safe, state caches the Safe, run
  // with `--account deployerEOA`, preflight passes, broadcast lands under the EOA.
  //
  // And the workflow that produces it is the one this check creates: refusal fires, operator switches
  // SMOKE_SIGNER_ARGS, re-runs against the old state file.
  const safe = '0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35';
  const eoa = '0x1111111111111111111111111111111111111111';

  assert.equal(signerCacheRefusal(safe, undefined), null, 'a first run has nothing to disagree with');
  assert.equal(signerCacheRefusal(safe, ''), null, 'nor does an empty cached value');
  assert.equal(signerCacheRefusal(safe, ` ${safe.toUpperCase().replace('0X', '0x')} `), null,
    'the same address in a different case or with padding is the same signer');

  const refusal = signerCacheRefusal(eoa, safe);
  assert.ok(refusal, 'a derived signer that differs from the cached one must refuse');
  assert.match(refusal, /REFUSING TO CONTINUE/);
  assert.match(refusal, /SMOKE_RESET=1/, 'and must say how to start a clean lifecycle');
  assert.ok(refusal.includes(safe) && refusal.includes(eoa), 'both addresses must be named');

  // A derivation that did not produce an address is a refusal, not a pass: `cast wallet address` can
  // fail, be cancelled at a password prompt, or print something else entirely.
  for (const derived of [undefined, null, '', '   ', 'Error: no such account', '0xabc', 42]) {
    assert.ok(signerCacheRefusal(derived, safe), `a derived value of ${JSON.stringify(derived)} must refuse`);
  }
});

test('the creator check validates SHAPE, not just equality — two copies of a wrong value agree', () => {
  // Round 3 compared two normalised strings, so every pair here was accepted as a verified creator.
  // Equality is not identity, and `creator` is immutable with no rotation path.
  const good = '0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35';
  const zero = `0x${'0'.repeat(40)}`;
  const shortOne = '0x' + 'a'.repeat(39);

  assert.equal(requireIntendedCreator({ intendedCreator: good }, good), good, 'a real address still passes');

  const bothWrong = [
    ['a typo that agrees with itself', '0xabc'],
    ['the same typo in another case', '0xABC'],
    ['a placeholder nobody replaced', 'TBD'],
    ['the zero address', zero],
    ['one hex character short', shortOne],
    ['an address with trailing junk', `${good}00`],
    ['not hex at all', '0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'],
    ['a decimal number', '1234567890123456789012345678901234567890'],
  ];
  for (const [why, value] of bothWrong) {
    assert.throws(
      () => requireIntendedCreator({ intendedCreator: value }, value),
      (err) => {
        assert.ok(err instanceof CreationRefused, `${why}: must throw CreationRefused`);
        return true;
      },
      `both sides ${JSON.stringify(value)} must refuse even though they are equal: ${why}`,
    );
  }

  // THE DECLARATION-SIDE CHECK IS ABOUT THE MESSAGE, and that is why it needs its own assertion.
  // Removing it left the suite green: when both sides carry the same malformed value the SIGNER-side
  // check refuses anyway, so refusal is covered twice. What is not covered twice is what the operator
  // reads at 3am. "the signer is 0xabc but the record declares 0xabc" is baffling; "the declared
  // intendedCreator is 0xabc, which is not a 20-byte hex address" is actionable. A refusal whose
  // message describes the wrong problem gets diagnosed as a bug in the guard.
  for (const value of ['0xabc', 'TBD', zero, shortOne]) {
    try {
      requireIntendedCreator({ intendedCreator: value }, value);
      assert.fail(`${value} must refuse`);
    } catch (err) {
      assert.ok(err instanceof CreationRefused);
      // The DECLARATION must be the subject. An alternation that also accepted the signer-side
      // wording let the declaration-side check be deleted with the suite green -- the signer message
      // satisfied it, which is the whole reason this assertion exists.
      assert.match(
        err.message,
        /^the declared intendedCreator is/,
        `the refusal for ${JSON.stringify(value)} must name the SHAPE problem, not report a mismatch `
          + `between two identical values: got ${JSON.stringify(err.message)}`,
      );
      assert.doesNotMatch(err.message, /but this deployment record declares/,
        'two equal values must never be reported as disagreeing');
    }
  }

  // The same shape rule applies to the SIGNER, so a malformed derivation cannot be waved through by a
  // declaration that happens to match it.
  assert.throws(() => requireIntendedCreator({ intendedCreator: good }, shortOne), CreationRefused);
  assert.throws(() => requireIntendedCreator({ intendedCreator: zero }, zero), CreationRefused);

  // addressShapeRefusal on its own, both directions, so the rule is not only observable through the
  // verdict that uses it.
  assert.equal(addressShapeRefusal('x', good), null);
  assert.equal(addressShapeRefusal('x', good.toLowerCase()), null);
  assert.match(addressShapeRefusal('x', zero), /zero address/);
  assert.match(addressShapeRefusal('x', shortOne), /not a 20-byte hex address/);
  assert.match(addressShapeRefusal('x', undefined), /missing or not a string/);
});

test('nothing between the refusal and the process swallows it', () => {
  // A `try/catch` in the step loop turns the throw back into a log line, and nothing asserted that the
  // throw REACHES the process. This is a wiring assertion and stays source-level deliberately: the
  // runner is only `node --check`ed by the gate, which is why the enforcement itself was moved out.
  const src = readFileSync(path.join(import.meta.dirname, '..', 'smoke-test.mjs'), 'utf8');

  // The step loop must invoke each step bare. A try around `await fn()` catches every refusal in the
  // whole lifecycle, not just this one.
  const loop = src.slice(src.indexOf('for (const [name, fn] of steps)'));
  const body = loop.slice(0, loop.indexOf('\n}') + 2);
  assert.match(body, /await fn\(\);/, 'the step loop no longer calls its steps the way this test expects');
  assert.doesNotMatch(body, /try\s*\{/, 'a try in the step loop turns every refusal into a log line');
  assert.doesNotMatch(body, /catch/, 'and so does a catch');

  // Nor may the signer refusal be caught where it is raised.
  const pre = src.slice(src.indexOf('function preflight()'));
  const preBody = pre.slice(0, pre.indexOf('\nfunction '));
  assert.match(preBody, /assert\(!signerRefusal, signerRefusal\)/, 'the signer refusal must be enforced, not logged');
  assert.doesNotMatch(preBody, /catch[\s\S]*signerRefusal|signerRefusal[\s\S]{0,200}catch/, 'and not caught');

  // The signer must not be read back from the state file anywhere before it is derived.
  const deriveIdx = src.indexOf('const derivedSigner = cast(');
  assert.ok(deriveIdx > 0, 'the signer is no longer derived');
  assert.doesNotMatch(src.slice(0, deriveIdx), /if \(!state\.signer\)/, 'the cached-signer shortcut must not come back');
});

/**
 * Each named seam is imported from `./smoke-preflight.mjs` — asserted per NAME, against the parsed
 * import block, rather than against a fixed adjacency like `/a, b,/`.
 *
 * The adjacency form was what these two tests used, and adding a third seam between two of the
 * names broke both of them while every property they exist to protect still held. A literal that
 * pins incidental ORDER fails on correct changes and passes a reordering that drops a name, which
 * is the wrong way round: the property is membership.
 */
function assertSeamsImported(src, names) {
  const block = /import\s*\{([\s\S]*?)\}\s*from\s*'\.\/smoke-preflight\.mjs';/.exec(src);
  assert.ok(block, "smoke-test.mjs no longer imports from './smoke-preflight.mjs' at all");
  const imported = block[1].split(',').map((s) => s.trim()).filter(Boolean);
  for (const n of names) {
    assert.ok(imported.includes(n), `${n} must be imported from smoke-preflight.mjs — found: ${imported.join(', ')}`);
  }
}

test('the runner CALLS the seam, and holds no enforcement of its own to disarm', () => {
  // The source assertions that remain are only about WIRING -- which function is called and where.
  // Everything they used to stand in for is now asserted by calling it, above.
  const src = readFileSync(path.join(import.meta.dirname, '..', 'smoke-test.mjs'), 'utf8');
  assertSeamsImported(src, ['requireIntendedCreator', 'loadDeploymentRecord']);
  assert.match(src, /requireIntendedCreator\(deployment, state\.signer\)/);
  // The BINDING must be fed by the loader, not merely mention it. Asserting the call appears
  // somewhere let `const deployment = {}; const unused = () => loadDeploymentRecord({...})` survive:
  // the loader present, correct, and called by nothing. There is exactly one `deployment` binding and
  // its initialiser is the loader.
  const bindings = [...src.matchAll(/(?:^|[\r\n])[ \t]*(?:const|let|var)[ \t]+deployment[ \t]*=[ \t]*([^;\r\n]*)/g)];
  assert.equal(bindings.length, 1, `expected exactly one \`deployment\` binding, found ${bindings.length}`);
  assert.match(
    bindings[0][1],
    /^loadDeploymentRecord\(/,
    `the deployment record must come FROM the loader, not from ${JSON.stringify(bindings[0][1].trim())}`,
  );

  // No local re-implementation may creep back: a second copy is how the tested one stops being the
  // one that runs.
  assert.doesNotMatch(src, /function requireIntendedCreator\s*\(/, 'the runner must not define its own');
  assert.doesNotMatch(src, /function loadDeploymentRecord\s*\(/, 'nor its own loader');
  assert.doesNotMatch(src, /intendedCreatorRefusal\s*\(/, 'the runner must not call the verdict directly and decide what to do with it');
  // And it must not swallow the refusal: a try around the call turns the throw back into a report.
  const create = src.slice(src.indexOf('function stepCreateVault()'));
  const body = create.slice(0, create.indexOf('\nfunction '));
  assert.doesNotMatch(body, /try\s*\{[\s\S]*requireIntendedCreator/, 'the refusal must not be caught inside stepCreateVault');
});

test('smoke-test.mjs consults both verdicts and has no bare catch left to swallow a failed call', () => {
  const src = readFileSync(path.join(import.meta.dirname, '..', 'smoke-test.mjs'), 'utf8');
  // Every verdict, named individually rather than by a loose pattern: this assertion exists so that
  // a verdict quietly dropped from the import is a red, and `/import \{[^}]*\}/` would not be.
  assertSeamsImported(src, ['requireIntendedCreator', 'requireCreatorCode', 'loadDeploymentRecord']);
  assert.match(src, /wiringImmutabilityFailure\(attempt\(/);
  assert.match(src, /oracleProbeWarning\(a\.symbol, r\.error\)/);
  // The creator check is consulted BEFORE the transaction, not after: `requireIntendedCreator()` is
  // called at the top of stepCreateVault, and its result is what the post-broadcast assertions
  // compare against. Checking afterwards would report a permanent mistake rather than prevent it.
  // The verdict is no longer called from the runner at all: `requireIntendedCreator` owns it and
  // THROWS, which is what made the enforcement testable. Wiring is asserted in the seam test above.
  assert.match(src, /creator\(\)\(address\)/, 'the vault\'s own creator() must be re-read, not just the event');
  assert.doesNotMatch(
    src,
    /creator in event != signer/,
    'the old signer-vs-event check is true by construction and passed on 4663 every time',
  );
  assert.doesNotMatch(src, /\}\s*catch\s*\{\s*(\/\*[\s\S]*?\*\/)?\s*\}/, 'a bare catch reads a transport failure as whatever the try expected');
});
