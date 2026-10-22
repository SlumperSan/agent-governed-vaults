/**
 * The registry's mirror attestation (RWAllyAgentRegistry.mintMirrored) is defined twice: in Solidity
 * and, independently, in scripts/lib/registry-attestation.mjs through viem. This file is where the two
 * meet, so the typehash, field order and domain are tested against an implementation that does not
 * share the contract's assumptions.
 *
 * The vector literals live in contracts/test/RWAllyAgentRegistryMirror.t.sol (the forge test asserts
 * the contract's digest equals them and accepts the signature). This test re-derives them with viem and
 * fails if the Solidity literals drift, and checks that the type string and domain strings in the
 * helper equal the ones in contracts/src. It also covers the signer's refusal rules, which the
 * contract cannot enforce.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashTypedData, keccak256, toHex, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  DOMAIN_NAME,
  DOMAIN_VERSION,
  MAX_EXPIRY_SECONDS,
  MIN_ORIGIN_AGE_SECONDS,
  MIRROR_DAILY_CAP,
  PER_HOLDER_DAILY_LIMIT,
  POLYGON_CHAIN_ID,
  YOUNG_ORIGIN_AGE_SECONDS,
  YOUNG_ORIGIN_DAILY_BUDGET,
  assertSignerLimits,
  attestationDays,
  mirrorAttestationTypeString,
  mirrorAttestationTypedData,
  signerLimits,
  signerRefusal,
} from '../lib/registry-attestation.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOL = readFileSync(path.join(REPO, 'contracts', 'src', 'RWAllyAgentRegistry.sol'), 'utf8');
const VECTOR_TEST = readFileSync(
  path.join(REPO, 'contracts', 'test', 'RWAllyAgentRegistryMirror.t.sol'),
  'utf8',
);

const ATT_PK = '0x00000000000000000000000000000000000000000000000000000000a77e57ed';
const REGISTRY = '0x1234567890123456789012345678901234567890';
const message = {
  originChainId: 5042n,
  originRegistry: REGISTRY,
  originAgentId: 7n,
  owner: '0x2222222222222222222222222222222222222222',
  agentURIHash: keccak256(toHex('ipfs://vector')),
  expiry: 1800003600n,
  nonce: 26639726n,
};
const typed = (destinationChainId = 8453) =>
  mirrorAttestationTypedData({ destinationChainId, registry: REGISTRY, message });

/** @param {string} name a `constant NAME = ...;` literal in the vector contract */
function solLiteral(name) {
  const m = VECTOR_TEST.match(new RegExp(`${name}\\s*=\\s*(?:hex)?"?(0x[0-9a-fA-F]+|[0-9a-fA-F]+)"?;`));
  assert.ok(m, `${name} not found in RWAllyAgentRegistryMirror.t.sol`);
  return m[1].startsWith('0x') ? m[1] : `0x${m[1]}`;
}

test('the Solidity vector equals what viem computes (digest, signature, attestor)', async () => {
  const acct = privateKeyToAccount(ATT_PK);
  assert.equal(solLiteral('VECTOR_ATTESTOR').toLowerCase(), acct.address.toLowerCase());
  assert.equal(solLiteral('VECTOR_DIGEST'), hashTypedData(typed()));
  const sig = await acct.signTypedData(typed());
  assert.equal(solLiteral('VECTOR_SIG'), sig);
  assert.equal(await recoverTypedDataAddress({ ...typed(), signature: sig }), acct.address);
});

test('the same attestation has a different digest on every destination chain', () => {
  const digests = [8453, 42161, 1, 137, 5042].map((c) => hashTypedData(typed(c)));
  assert.equal(new Set(digests).size, digests.length);
});

test('the helper type string and domain strings equal the ones in the contract source', () => {
  const typeLiteral = SOL.match(/MIRROR_ATTESTATION_TYPEHASH\s*=\s*keccak256\(\s*"([^"]+)"/);
  assert.ok(typeLiteral, 'MIRROR_ATTESTATION_TYPEHASH literal not found');
  assert.equal(mirrorAttestationTypeString(), typeLiteral[1]);
  assert.match(SOL, new RegExp(`NAME_HASH = keccak256\\("${DOMAIN_NAME}"\\)`));
  assert.match(SOL, new RegExp(`VERSION_HASH = keccak256\\("${DOMAIN_VERSION}"\\)`));
});

const NOW = 1_800_000_000;
const OWNER = '0x2222222222222222222222222222222222222222';
const OUTSIDE_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const LIMITS = signerLimits({});
/** The one UTC day the baseline window (NOW to NOW + 3600) touches. */
const DAY = Math.floor(NOW / 86400);

/**
 * A request every rule accepts (a young origin, one below every limit); each test changes one field.
 * `counts` overrides the baseline's counts for DAY; pass `issuance` to replace the whole record.
 */
function request({ attestation = {}, readback = {}, counts = {}, ...rest } = {}) {
  return {
    destinationChainId: 8453,
    ourRegistry: REGISTRY,
    nowSeconds: NOW,
    attestation: { originChainId: 5042, originRegistry: REGISTRY, owner: OWNER, expiry: NOW + 3600, ...attestation },
    readback: {
      chainId: 5042,
      ownerOf: OWNER,
      originOfRegistry: OUTSIDE_REGISTRY,
      registeredAtSeconds: NOW - 86400,
      ...readback,
    },
    ownerCodeHashOrigin: null,
    issuance: {
      [DAY]: { issuedToHolder: 9, issuedToYoungOrigins: 49, ...counts },
    },
    ...rest,
  };
}
const refusal = (/** @type {any} */ p) => signerRefusal(p, LIMITS);

test('signer policy: the baseline request is signed', () => {
  assert.equal(refusal(request()), null);
});

test('signer policy: Polygon is never an origin, and is allowed as a destination', () => {
  assert.match(
    refusal(request({ attestation: { originChainId: POLYGON_CHAIN_ID }, readback: { chainId: POLYGON_CHAIN_ID } })) ?? '',
    /Polygon/,
  );
  assert.equal(refusal(request({ destinationChainId: POLYGON_CHAIN_ID })), null);
});

test('signer policy: a destination equal to the origin is refused', () => {
  assert.match(refusal(request({ destinationChainId: 5042 })) ?? '', /destination equals the origin/);
  assert.match(refusal(request({ destinationChainId: 5042n })) ?? '', /destination equals the origin/);
});

test('signer policy: an origin chain id not read back, or read back different, is refused', () => {
  assert.match(refusal({ ...request(), readback: null }) ?? '', /chain id could not be read back/);
  assert.match(refusal(request({ readback: { chainId: null } })) ?? '', /chain id could not be read back/);
  assert.match(refusal(request({ readback: { chainId: 5043 } })) ?? '', /different chain id/);
  // hex (eth_chainId's own form) and bigint read the same value
  assert.equal(refusal(request({ readback: { chainId: '0x13b2' } })), null);
  assert.equal(refusal(request({ readback: { chainId: 5042n } })), null);
});

test('signer policy (V515b F3): a malformed chain id or current time refuses', () => {
  for (const bad of ['', true, -1, -5042n, 0, '0x0', '0x', '5042', 1.5, NaN, undefined]) {
    assert.match(refusal(request({ readback: { chainId: bad } })) ?? '', /chain id could not be read back/, `chainId ${String(bad)}`);
    assert.match(refusal(request({ nowSeconds: bad })) ?? '', /nowSeconds is not a positive integer/, `nowSeconds ${String(bad)}`);
    assert.match(
      refusal(request({ destinationChainId: bad })) ?? '',
      /destination chain id is not a positive integer/,
      `destinationChainId ${String(bad)}`,
    );
  }
  assert.equal(refusal(request({ destinationChainId: '0x2105', nowSeconds: BigInt(NOW) })), null);
});

test('signer policy: an origin registry other than ours is refused', () => {
  assert.match(
    refusal(request({ attestation: { originRegistry: OUTSIDE_REGISTRY } })) ?? '',
    /origin registry is not our registry/,
  );
  // checksum case does not matter
  assert.equal(refusal(request({ attestation: { originRegistry: REGISTRY.toUpperCase().replace('0X', '0x') } })), null);
});

test('signer policy: a holder or registry not read back, or a different holder, is refused', () => {
  for (const field of ['ownerOf', 'originOfRegistry', 'registeredAtSeconds']) {
    assert.match(refusal(request({ readback: { [field]: null } })) ?? '', /could not be read back/, field);
  }
  assert.match(
    refusal(request({ readback: { ownerOf: '0x3333333333333333333333333333333333333333' } })) ?? '',
    /not the attested owner/,
  );
});

test('signer policy (V515b F2): a holder or origin registry that is not an address refuses', () => {
  for (const field of ['ownerOf', 'originOfRegistry']) {
    for (const bad of ['', 'garbage', '0x', `0x${'2'.repeat(39)}`, `0x${'2'.repeat(41)}`, `0x${'g'.repeat(40)}`, 0, true]) {
      assert.match(refusal(request({ readback: { [field]: bad } })) ?? '', /could not be read back/, `${field} ${String(bad)}`);
    }
  }
  // a native origin reads the zero address as its origin registry, and signs
  assert.equal(refusal(request({ readback: { originOfRegistry: `0x${'0'.repeat(40)}` } })), null);
});

test('signer policy (S1 / V515b F1): a malformed, zero or future origin mint time refuses', () => {
  for (const bad of ['', ' ', false, true, 0, 0n, '0x0', -5, -1n, '12', 1.5, NaN, NOW + 1]) {
    assert.match(
      refusal(request({ readback: { registeredAtSeconds: bad } })) ?? '',
      /mint time could not be read back/,
      `registeredAtSeconds ${String(bad)}`,
    );
  }
  assert.equal(refusal(request({ readback: { registeredAtSeconds: BigInt(NOW - 86400) } })), null);
});

test('signer policy: a mirror of a mirror is refused, an import is not', () => {
  assert.match(
    refusal(request({ readback: { originOfRegistry: REGISTRY.toUpperCase().replace('0X', '0x') } })) ?? '',
    /mirror of a mirror/,
  );
  // an import's origin registry is the outside ERC-8004 registry: the baseline
  assert.equal(refusal(request({ readback: { originOfRegistry: OUTSIDE_REGISTRY } })), null);
});

test('signer policy: a contract owner needs the same code on the destination', () => {
  const h1 = `0x${'11'.repeat(32)}`;
  const h2 = `0x${'22'.repeat(32)}`;
  assert.equal(refusal(request({ ownerCodeHashOrigin: h1, ownerCodeHashDestination: h1 })), null);
  assert.match(refusal(request({ ownerCodeHashOrigin: h1, ownerCodeHashDestination: h2 })) ?? '', /code hash differs/);
  assert.match(
    refusal(request({ ownerCodeHashOrigin: h1, ownerCodeHashDestination: null })) ?? '',
    /code hash differs or is absent/,
  );
});

test('signer policy (A4): owner code unreadable on the origin refuses; explicit null (an EOA) signs', () => {
  assert.equal(refusal(request({ ownerCodeHashOrigin: null })), null);
  assert.match(refusal(request({ ownerCodeHashOrigin: undefined })) ?? '', /code on the origin chain could not be read back/);
  const { ownerCodeHashOrigin, ...absent } = request();
  assert.match(refusal(absent) ?? '', /code on the origin chain could not be read back/);
});

test('signer policy (A1): expiry must be in the future and at most an hour out', () => {
  assert.match(refusal(request({ attestation: { expiry: NOW + 7200 } })) ?? '', /more than 3600s out/);
  assert.match(refusal(request({ attestation: { expiry: NOW + 3601 } })) ?? '', /more than 3600s out/);
  assert.match(refusal(request({ attestation: { expiry: NOW } })) ?? '', /not in the future/);
});

test('signer policy (A1): an origin inside the finality buffer is refused', () => {
  assert.match(refusal(request({ readback: { registeredAtSeconds: NOW - 3599 } })) ?? '', /younger than 3600s/);
  assert.equal(refusal(request({ readback: { registeredAtSeconds: NOW - 3600 } })), null);
});

test('signer policy (A1): young origins share a 50 a day budget per destination; aged origins do not draw on it', () => {
  const young = NOW - (YOUNG_ORIGIN_AGE_SECONDS - 1);
  const aged = NOW - YOUNG_ORIGIN_AGE_SECONDS;
  assert.match(
    refusal(request({ readback: { registeredAtSeconds: young }, counts: { issuedToYoungOrigins: 50 } })) ?? '',
    /young-origin daily budget for this destination \(50\)/,
  );
  assert.equal(refusal(request({ readback: { registeredAtSeconds: young }, counts: { issuedToYoungOrigins: 49 } })), null);
  assert.equal(refusal(request({ readback: { registeredAtSeconds: aged }, counts: { issuedToYoungOrigins: 50 } })), null);
});

test('signer policy (A1): a holder past the per-holder daily limit is refused', () => {
  assert.match(refusal(request({ counts: { issuedToHolder: 10 } })) ?? '', /per-holder daily limit/);
});

for (const counter of ['issuedToHolder', 'issuedToYoungOrigins']) {
  test(`signer policy (S1): a missing or malformed ${counter} refuses, never signs`, () => {
    for (const bad of [undefined, null, NaN, -1, -1n, 1.5, '3', '', true]) {
      assert.match(
        refusal(request({ counts: { [counter]: bad } })) ?? '',
        /issuance count for UTC day \d+ is missing/,
        `${counter} = ${String(bad)}`,
      );
    }
    const { [counter]: _, ...absent } = request().issuance[DAY];
    assert.match(refusal({ ...request(), issuance: { [DAY]: absent } }) ?? '', /issuance count for UTC day \d+ is missing/);
  });
}

test('signer policy (S1): a missing issuance object or day refuses; bigint counts are accepted', () => {
  assert.match(refusal({ ...request(), issuance: null }) ?? '', /issuance count for UTC day \d+ is missing/);
  assert.match(refusal({ ...request(), issuance: { [DAY - 1]: request().issuance[DAY] } }) ?? '', /issuance count for UTC day \d+ is missing/);
  assert.equal(refusal(request({ counts: { issuedToHolder: 9n, issuedToYoungOrigins: 49n } })), null);
});

test('signer policy (R515c P1): an attestation counts against every UTC day its window touches', () => {
  const M = (DAY + 1) * 86400; // the midnight ending DAY
  const youngAt = (/** @type {number} */ now) => now - 7200;
  const at = (/** @type {number} */ now, /** @type {Record<number, any>} */ issuance) => ({
    ...request(),
    nowSeconds: now,
    attestation: { ...request().attestation, expiry: now + 3600 },
    readback: { ...request().readback, registeredAtSeconds: youngAt(now) },
    issuance,
  });
  const room = { issuedToHolder: 0, issuedToYoungOrigins: 0 };
  assert.deepEqual(attestationDays(M - 1800, M + 1800), [DAY, DAY + 1]);
  assert.deepEqual(attestationDays(M - 3600, M), [DAY, DAY + 1]); // the contract accepts a mint at block.timestamp == expiry
  assert.deepEqual(attestationDays(M - 3601, M - 1), [DAY]);
  // 23:30 with a 00:30 expiry needs both days, and reads both
  assert.match(refusal(at(M - 1800, { [DAY]: room })) ?? '', /UTC day \d+ is missing/);
  assert.equal(refusal(at(M - 1800, { [DAY]: room, [DAY + 1]: room })), null);
  // R515c probe2: 50 young attestations signed in DAY's last hour count on DAY + 1, so after midnight
  // DAY + 1's young budget is spent (the probe's second case), and before midnight a young origin
  // with DAY at 49 refuses when DAY + 1 is spent (the first case)
  const spent = { issuedToHolder: 0, issuedToYoungOrigins: 50 };
  const fortyNine = { issuedToHolder: 0, issuedToYoungOrigins: 49 };
  assert.match(refusal(at(M + 60, { [DAY + 1]: spent })) ?? '', /young-origin daily budget .* spent on UTC day \d+/);
  assert.match(refusal(at(M - 1800, { [DAY]: fortyNine, [DAY + 1]: spent })) ?? '', /young-origin daily budget .* spent on UTC day \d+/);
  assert.match(refusal(at(M - 1800, { [DAY]: spent, [DAY + 1]: fortyNine })) ?? '', /young-origin daily budget .* spent on UTC day \d+/);
  // the per-holder limit the same way
  const holderSpent = { issuedToHolder: 10, issuedToYoungOrigins: 0 };
  assert.match(refusal(at(M - 1800, { [DAY]: room, [DAY + 1]: holderSpent })) ?? '', /per-holder daily limit .* spent on UTC day \d+/);
  assert.match(refusal(at(M - 1800, { [DAY]: holderSpent, [DAY + 1]: room })) ?? '', /per-holder daily limit .* spent on UTC day \d+/);
  assert.throws(() => attestationDays(M, M - 1), /expiry not before now/);
  assert.throws(() => attestationDays(true, M), /positive integers/);
});

test('signer policy (R515c S1): malformed owner code hashes refuse as unreadable, even when equal', () => {
  const h1 = `0x${'ab'.repeat(32)}`;
  for (const bad of ['', ' ', false, true, 0, -1, 1.5, '0x0', '0x', `0x${'ab'.repeat(31)}`, `0x${'gg'.repeat(32)}`]) {
    assert.match(
      refusal(request({ ownerCodeHashOrigin: bad, ownerCodeHashDestination: bad })) ?? '',
      /code on the origin chain could not be read back/,
      `both ${JSON.stringify(bad)}`,
    );
    assert.match(
      refusal(request({ ownerCodeHashOrigin: h1, ownerCodeHashDestination: bad })) ?? '',
      /code on the destination chain could not be read back/,
      `destination ${JSON.stringify(bad)}`,
    );
  }
  assert.match(refusal(request({ ownerCodeHashOrigin: h1 })) ?? '', /code on the destination chain could not be read back/);
  // hex case is formatting, not a different hash
  assert.equal(refusal(request({ ownerCodeHashOrigin: h1, ownerCodeHashDestination: h1.toUpperCase().replace('0X', '0x') })), null);
});

test('signer policy (R515c): originChainId and expiry go through the strict integer reader', () => {
  for (const bad of ['', ' ', true, false, 0, -1, 1.5, NaN, '0x0', '5042', [5042], undefined]) {
    assert.match(
      refusal(request({ attestation: { originChainId: bad } })) ?? '',
      /attestation origin chain id is not a positive integer/,
      `originChainId ${String(bad)}`,
    );
    assert.match(
      refusal(request({ attestation: { expiry: bad } })) ?? '',
      /attestation expiry is not a positive integer/,
      `expiry ${String(bad)}`,
    );
  }
  // chain 1 read back and attested as `true` used to sign as chain 1
  assert.match(
    refusal(request({ attestation: { originChainId: true }, readback: { chainId: 1 } })) ?? '',
    /attestation origin chain id is not a positive integer/,
  );
  assert.equal(refusal(request({ attestation: { originChainId: '0x13b2', expiry: BigInt(NOW + 3600) } })), null);
});

test('signer policy (R515c): ourRegistry that is not an address throws', () => {
  for (const bad of ['', ' ', '0x0', 'garbage', `0x${'1'.repeat(39)}`, undefined, null, 0]) {
    assert.throws(
      () => refusal(request({ ourRegistry: bad, attestation: { originRegistry: bad } })),
      /ourRegistry is not an address/,
      `ourRegistry ${String(bad)}`,
    );
  }
});

test('signer policy (R515c): a hand-built limits object is validated like signerLimits', () => {
  const thirtyMinutes = request({ readback: { registeredAtSeconds: NOW - 1800 } });
  for (const bad of ['', false, 0, -1, '0x0', [], 1.5, NaN, undefined, '3600']) {
    for (const key of Object.keys(LIMITS)) {
      assert.throws(() => signerRefusal(thirtyMinutes, /** @type {any} */ ({ ...LIMITS, [key]: bad })), /must be a positive integer/, `${key} ${String(bad)}`);
    }
  }
  assert.throws(() => signerRefusal(request(), { ...LIMITS, youngOriginDailyBudget: 1e9 }), /below MIRROR_DAILY_CAP/);
  assert.throws(() => signerRefusal(request(), { ...LIMITS, youngOriginDailyBudget: MIRROR_DAILY_CAP }), /below MIRROR_DAILY_CAP/);
  assert.throws(() => signerRefusal(request(), { ...LIMITS, minOriginAgeSeconds: YOUNG_ORIGIN_AGE_SECONDS }), /must be below youngOriginAgeSeconds/);
  assert.throws(() => signerRefusal(request(), /** @type {any} */ (null)), /must be a positive integer/);
  assert.throws(() => assertSignerLimits({}), /must be a positive integer/);
  assert.doesNotThrow(() => assertSignerLimits(LIMITS));
});

/** What a signer built on `signerRefusal` must do: sign only on a null return, refuse on a reason or a throw. */
function decide(/** @type {any} */ p) {
  try {
    return refusal(p) === null ? 'sign' : 'refuse';
  } catch {
    return 'refuse';
  }
}

test('signer policy: a throwing getter makes signerRefusal throw, and the caller refuses', () => {
  const boom = () => {
    throw new Error('rpc timeout');
  };
  const throwingReadback = { ...request(), readback: Object.defineProperty({ ...request().readback }, 'chainId', { get: boom }) };
  const throwingCounter = {
    ...request(),
    issuance: { [DAY]: Object.defineProperty({ ...request().issuance[DAY] }, 'issuedToYoungOrigins', { get: boom }) },
  };
  const throwingCode = Object.defineProperty(request(), 'ownerCodeHashOrigin', { get: boom });
  for (const p of [throwingReadback, throwingCounter, throwingCode]) {
    assert.throws(() => refusal(p), /rpc timeout/);
    assert.equal(decide(p), 'refuse');
  }
  assert.equal(decide(request()), 'sign');
});

test('signer limits: named defaults, env overrides, malformed or headroom-free overrides throw', () => {
  assert.deepEqual(LIMITS, {
    maxExpirySeconds: MAX_EXPIRY_SECONDS,
    perHolderDaily: PER_HOLDER_DAILY_LIMIT,
    minOriginAgeSeconds: MIN_ORIGIN_AGE_SECONDS,
    youngOriginAgeSeconds: YOUNG_ORIGIN_AGE_SECONDS,
    youngOriginDailyBudget: YOUNG_ORIGIN_DAILY_BUDGET,
  });
  assert.deepEqual(
    [MAX_EXPIRY_SECONDS, PER_HOLDER_DAILY_LIMIT, MIN_ORIGIN_AGE_SECONDS, YOUNG_ORIGIN_AGE_SECONDS, YOUNG_ORIGIN_DAILY_BUDGET],
    [3600, 10, 3600, 604800, 50],
  );
  assert.ok(YOUNG_ORIGIN_DAILY_BUDGET < MIRROR_DAILY_CAP);
  const env = {
    REGISTRY_ATTEST_MAX_EXPIRY_SECONDS: '600',
    REGISTRY_ATTEST_PER_HOLDER_DAILY: '2',
    REGISTRY_ATTEST_MIN_ORIGIN_AGE_SECONDS: '7200',
    REGISTRY_ATTEST_YOUNG_ORIGIN_AGE_SECONDS: '86400',
    REGISTRY_ATTEST_YOUNG_ORIGIN_DAILY_BUDGET: '20',
  };
  assert.deepEqual(signerLimits(env), {
    maxExpirySeconds: 600,
    perHolderDaily: 2,
    minOriginAgeSeconds: 7200,
    youngOriginAgeSeconds: 86400,
    youngOriginDailyBudget: 20,
  });
  // an override is actually applied by the policy
  assert.match(
    signerRefusal(request({ attestation: { expiry: NOW + 601 } }), signerLimits(env)) ?? '',
    /more than 600s out/,
  );
  const youngAt = {
    attestation: { expiry: NOW + 600 },
    readback: { registeredAtSeconds: NOW - 86399 },
    counts: { issuedToHolder: 0, issuedToYoungOrigins: 20 },
  };
  assert.match(signerRefusal(request(youngAt), signerLimits(env)) ?? '', /young-origin daily budget for this destination \(20\)/);
  assert.equal(signerRefusal(request({ ...youngAt, readback: { registeredAtSeconds: NOW - 86400 } }), signerLimits(env)), null);
  assert.throws(() => signerLimits({ REGISTRY_ATTEST_YOUNG_ORIGIN_DAILY_BUDGET: '100' }), /below MIRROR_DAILY_CAP/);
  assert.equal(signerLimits({ REGISTRY_ATTEST_YOUNG_ORIGIN_DAILY_BUDGET: '99' }).youngOriginDailyBudget, 99);
  // an age floor at or above the young threshold would leave no young origin to budget
  for (const floor of ['604800', '604801']) {
    assert.throws(() => signerLimits({ REGISTRY_ATTEST_MIN_ORIGIN_AGE_SECONDS: floor }), /must be below youngOriginAgeSeconds \(REGISTRY_ATTEST_YOUNG_ORIGIN_AGE_SECONDS\)/);
  }
  assert.equal(signerLimits({ REGISTRY_ATTEST_MIN_ORIGIN_AGE_SECONDS: '604799' }).minOriginAgeSeconds, 604799);
  for (const bad of ['0', '-1', '1.5', 'ten']) {
    assert.throws(() => signerLimits({ REGISTRY_ATTEST_PER_HOLDER_DAILY: bad }), /positive integer/);
  }
});

test('MIRROR_DAILY_CAP in the helper equals the contract constant', () => {
  assert.match(SOL, new RegExp(`MIRROR_DAILY_CAP = ${MIRROR_DAILY_CAP};`));
});
