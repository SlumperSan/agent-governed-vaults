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
  POLYGON_CHAIN_ID,
  mirrorAttestationTypeString,
  mirrorAttestationTypedData,
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

test('signer policy: Polygon is never an origin, and is allowed as a destination', () => {
  const ok = {
    originChainId: 5042,
    ourRegistry: REGISTRY,
    originOfRegistry: '0x0000000000000000000000000000000000000000',
  };
  assert.equal(signerRefusal(ok), null);
  assert.match(signerRefusal({ ...ok, originChainId: POLYGON_CHAIN_ID }) ?? '', /Polygon/);
  // destination Polygon is not an input to the policy at all: nothing refuses it
  assert.equal(signerRefusal({ ...ok, originChainId: 8453 }), null);
});

test('signer policy: a mirror of a mirror is refused, an import is not', () => {
  const base = { originChainId: 8453, ourRegistry: REGISTRY };
  assert.match(
    signerRefusal({ ...base, originOfRegistry: REGISTRY.toUpperCase().replace('0X', '0x') }) ?? '',
    /mirror of a mirror/,
  );
  // an import's origin registry is the outside ERC-8004 registry
  assert.equal(
    signerRefusal({ ...base, originOfRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' }),
    null,
  );
});

test('signer policy: a contract owner needs the same code on the destination', () => {
  const base = {
    originChainId: 1,
    ourRegistry: REGISTRY,
    originOfRegistry: '0x0000000000000000000000000000000000000000',
  };
  const h1 = `0x${'11'.repeat(32)}`;
  const h2 = `0x${'22'.repeat(32)}`;
  assert.equal(signerRefusal({ ...base, ownerCodeHashOrigin: h1, ownerCodeHashDestination: h1 }), null);
  assert.match(
    signerRefusal({ ...base, ownerCodeHashOrigin: h1, ownerCodeHashDestination: h2 }) ?? '',
    /code hash differs/,
  );
  assert.match(
    signerRefusal({ ...base, ownerCodeHashOrigin: h1, ownerCodeHashDestination: null }) ?? '',
    /code hash differs or is absent/,
  );
  // an account with no code on the origin chain needs no rule
  assert.equal(signerRefusal({ ...base }), null);
});
