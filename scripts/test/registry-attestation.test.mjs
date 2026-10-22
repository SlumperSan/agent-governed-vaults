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
  DAILY_ISSUANCE_BUDGET,
  MAX_EXPIRY_SECONDS,
  MIN_ORIGIN_AGE_SECONDS,
  MIRROR_DAILY_CAP,
  PER_HOLDER_DAILY_LIMIT,
  POLYGON_CHAIN_ID,
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

/** A request every rule accepts; each test changes one field. */
function request({ attestation = {}, readback = {}, issuance = {}, ...rest } = {}) {
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
    issuance: { issuedToday: 79, issuedTodayToHolder: 9, outstanding: 0, mirrorsRemainingToday: 100, ...issuance },
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

test('signer policy (A1): expiry must be in the future and at most an hour out', () => {
  assert.match(refusal(request({ attestation: { expiry: NOW + 7200 } })) ?? '', /more than 3600s out/);
  assert.match(refusal(request({ attestation: { expiry: NOW + 3601 } })) ?? '', /more than 3600s out/);
  assert.match(refusal(request({ attestation: { expiry: NOW } })) ?? '', /not in the future/);
});

test('signer policy (A1): a fresh origin identity is refused', () => {
  assert.match(refusal(request({ readback: { registeredAtSeconds: NOW - 86399 } })) ?? '', /younger than 86400s/);
});

test('signer policy (A1): the 81st attestation for one destination in one day is refused', () => {
  assert.match(refusal(request({ issuance: { issuedToday: 80 } })) ?? '', /daily issuance budget/);
});

test('signer policy (A1): a holder past the per-holder daily limit is refused', () => {
  assert.match(refusal(request({ issuance: { issuedTodayToHolder: 10 } })) ?? '', /per-holder daily limit/);
});

test('signer policy (A1): outstanding attestations never exceed the capacity left on chain', () => {
  assert.match(
    refusal(request({ issuance: { outstanding: 5, mirrorsRemainingToday: 5 } })) ?? '',
    /cover the destination capacity/,
  );
  assert.equal(refusal(request({ issuance: { outstanding: 4, mirrorsRemainingToday: 5 } })), null);
});

test('signer limits: named defaults, env overrides, malformed or headroom-free overrides throw', () => {
  assert.deepEqual(LIMITS, {
    maxExpirySeconds: MAX_EXPIRY_SECONDS,
    dailyBudget: DAILY_ISSUANCE_BUDGET,
    perHolderDaily: PER_HOLDER_DAILY_LIMIT,
    minOriginAgeSeconds: MIN_ORIGIN_AGE_SECONDS,
  });
  assert.ok(DAILY_ISSUANCE_BUDGET < MIRROR_DAILY_CAP);
  const env = {
    REGISTRY_ATTEST_MAX_EXPIRY_SECONDS: '600',
    REGISTRY_ATTEST_DAILY_BUDGET: '50',
    REGISTRY_ATTEST_PER_HOLDER_DAILY: '2',
    REGISTRY_ATTEST_MIN_ORIGIN_AGE_SECONDS: '3600',
  };
  assert.deepEqual(signerLimits(env), {
    maxExpirySeconds: 600,
    dailyBudget: 50,
    perHolderDaily: 2,
    minOriginAgeSeconds: 3600,
  });
  // an override is actually applied by the policy
  assert.match(
    signerRefusal(request({ attestation: { expiry: NOW + 601 } }), signerLimits(env)) ?? '',
    /more than 600s out/,
  );
  assert.throws(() => signerLimits({ REGISTRY_ATTEST_DAILY_BUDGET: '100' }), /below MIRROR_DAILY_CAP/);
  for (const bad of ['0', '-1', '1.5', 'ten']) {
    assert.throws(() => signerLimits({ REGISTRY_ATTEST_PER_HOLDER_DAILY: bad }), /positive integer/);
  }
});

test('MIRROR_DAILY_CAP in the helper equals the contract constant', () => {
  assert.match(SOL, new RegExp(`MIRROR_DAILY_CAP = ${MIRROR_DAILY_CAP};`));
});
