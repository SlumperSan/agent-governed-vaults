// @ts-check
/**
 * Card 213 — is the sanctions check actually WIRED into the signing path and the connect flow, not
 * just defined? `chain-actions.ts` and `wallet.tsx` both pull in `@chain/*`/`@atlas/*` aliases and
 * (for wallet.tsx) JSX, so — same constraint as every sibling wiring test in this directory (see
 * `simulate-before-sign.test.mjs`, `exit-freeze-gate.test.mjs`) — this reads them as text rather
 * than importing them.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const APP = fileURLToPath(new URL('..', import.meta.url));
const CHAIN_ACTIONS = readFileSync(join(APP, 'src/lib/chain-actions.ts'), 'utf8');
const WALLET = readFileSync(join(APP, 'src/lib/wallet.tsx'), 'utf8');

// ─────────────────────── chain-actions.ts: the write choke point ───────────────────────

/**
 * The full body of `async function simulateThenWrite(...) { ... }`, brace-balanced. Anchored on
 * `): Promise<Hex> {` (the return-type annotation immediately before the body), NOT on the first
 * `{` after the function name — `simulateThenWrite<T extends { abi: Abi; ... }>` has its own `{`
 * inside the generic constraint, before the parameter list even opens, which a naive
 * "first brace after the name" scan would mistake for the body's opening brace.
 */
function simulateThenWriteBody(src) {
  const sigIdx = src.indexOf('async function simulateThenWrite');
  assert.ok(sigIdx >= 0, 'simulateThenWrite function not found in chain-actions.ts');
  const returnTypeIdx = src.indexOf('): Promise<Hex> {', sigIdx);
  assert.ok(returnTypeIdx >= 0, 'simulateThenWrite\'s "): Promise<Hex> {" signature tail not found — did its return type change?');
  const braceStart = returnTypeIdx + '): Promise<Hex> '.length;
  assert.equal(src[braceStart], '{', 'computed brace position is not actually a brace — offset math is wrong');
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(braceStart, i + 1);
    }
  }
  throw new Error('simulateThenWrite body never closes its braces');
}

test('chain-actions.ts imports assertNotSanctioned from ./sanctions', () => {
  assert.match(CHAIN_ACTIONS, /import\s*\{\s*assertNotSanctioned\s*\}\s*from\s*'\.\/sanctions';/);
});

test('simulateThenWrite calls assertNotSanctioned(params.account) before simulateContract — a listed address never reaches an eth_call', () => {
  const body = simulateThenWriteBody(CHAIN_ACTIONS);
  const guardAt = body.indexOf('assertNotSanctioned(params.account)');
  const simulateAt = body.indexOf('publicClient.simulateContract');
  assert.ok(guardAt >= 0, 'assertNotSanctioned(params.account) not found inside simulateThenWrite');
  assert.ok(simulateAt >= 0, 'publicClient.simulateContract not found inside simulateThenWrite');
  assert.ok(guardAt < simulateAt, 'assertNotSanctioned must run BEFORE the simulate call, not after');
});

test('MUTATION: a simulateThenWrite body with the sanctions guard removed is caught', () => {
  // Same fixture shape as every sibling MUTATION test in this directory: reconstruct the pre-fix
  // body (no assertNotSanctioned call at all) and show the guard above would correctly report it
  // missing rather than passing vacuously.
  const preFixBody = `{
  let request;
  try {
    ({ request } = await publicClient.simulateContract({ ...params }));
  } catch (err) {
    throw new Error('would revert');
  }
  return walletClient.writeContract(request);
}`;
  const guardAt = preFixBody.indexOf('assertNotSanctioned(params.account)');
  assert.equal(guardAt, -1, 'RED: the pre-fix body has no sanctions guard at all — this is the state that must fail the real test above');
});

test('non-vacuity: every one of the five write functions still routes through simulateThenWrite (regression on the pre-existing routing tests, not a card-213 test of its own)', () => {
  // Not a re-test of simulate-before-sign.test.mjs's own coverage — just confirms the premise this
  // file's whole argument rests on (one choke point covers all five writes) has not quietly
  // stopped being true, e.g. because a new write function was added that signs directly.
  for (const fn of ['approve', 'deposit', 'commitVote', 'revealVote', 'requestExit']) {
    const idx = CHAIN_ACTIONS.indexOf(`functionName: '${fn}'`);
    assert.ok(idx >= 0, `functionName: '${fn}' not found in chain-actions.ts`);
    const before = CHAIN_ACTIONS.slice(0, idx);
    assert.ok(before.lastIndexOf('simulateThenWrite(') > before.lastIndexOf('walletClient.writeContract({'), `'${fn}' is not routed through simulateThenWrite`);
  }
});

// ─────────────────────── wallet.tsx: surfaced at connect ───────────────────────

test('wallet.tsx imports isSanctionedAddress from ./sanctions', () => {
  assert.match(WALLET, /import\s*\{\s*isSanctionedAddress\s*\}\s*from\s*'\.\/sanctions';/);
});

test('connect() sets sanctioned state from the newly connected address', () => {
  const connectIdx = WALLET.indexOf('const connect = useCallback(');
  assert.ok(connectIdx >= 0, 'connect callback not found in wallet.tsx');
  const disconnectIdx = WALLET.indexOf('const disconnect = useCallback(');
  assert.ok(disconnectIdx > connectIdx, 'disconnect not found after connect — extraction window is wrong');
  const connectBody = WALLET.slice(connectIdx, disconnectIdx);
  assert.match(connectBody, /setSanctioned\(isSanctionedAddress\(first\)\)/, 'connect() does not compute sanctioned from the freshly connected address');
});

test('the accountsChanged handler re-checks sanctioned on every account switch, not only at initial connect', () => {
  const onAccountsIdx = WALLET.indexOf('const onAccounts = ');
  assert.ok(onAccountsIdx >= 0, 'onAccounts handler not found in wallet.tsx');
  const onChainIdx = WALLET.indexOf('const onChain = ');
  assert.ok(onChainIdx > onAccountsIdx, 'onChain not found after onAccounts — extraction window is wrong');
  const onAccountsBody = WALLET.slice(onAccountsIdx, onChainIdx);
  assert.match(onAccountsBody, /setSanctioned\(isSanctionedAddress\(next\)\)/, 'onAccounts does not re-check sanctioned when the active account changes');
});

test('MUTATION: a connect() body with the sanctioned check removed is caught', () => {
  const preFixConnectBody = `useCallback(async (uuid) => {
    setAddress(first);
    const hexChain = await provider.request({ method: 'eth_chainId' });
  }, [providers]);`;
  assert.doesNotMatch(preFixConnectBody, /setSanctioned\(isSanctionedAddress\(first\)\)/, 'RED: the pre-fix body has no sanctioned check at all');
});

test('WalletConnect.tsx surfaces SANCTIONS_REFUSAL_MESSAGE when sanctioned', () => {
  const WALLET_CONNECT = readFileSync(join(APP, 'src/components/WalletConnect.tsx'), 'utf8');
  assert.match(WALLET_CONNECT, /import\s*\{\s*SANCTIONS_REFUSAL_MESSAGE/);
  assert.match(WALLET_CONNECT, /sanctioned\s*\?\s*<p[^>]*>\{SANCTIONS_REFUSAL_MESSAGE\}<\/p>\s*:\s*null/);
});

// ─────────────────── WalletConnect.tsx: the runtime freshness banner (card 217) ───────────────────

test('WalletConnect.tsx imports the freshness predicate and the stale-list message from ./sanctions', () => {
  const WALLET_CONNECT = readFileSync(join(APP, 'src/components/WalletConnect.tsx'), 'utf8');
  assert.match(WALLET_CONNECT, /import\s*\{[^}]*SANCTIONS_LIST_STALE_MESSAGE[^}]*\}\s*from\s*'\.\.\/lib\/sanctions';/);
  assert.match(WALLET_CONNECT, /import\s*\{[^}]*sdnListAgeDays[^}]*\}\s*from\s*'\.\.\/lib\/sanctions';/);
  assert.match(WALLET_CONNECT, /import\s*\{[^}]*SDN_LIST_MAX_AGE_DAYS[^}]*\}\s*from\s*'\.\.\/lib\/sanctions';/);
});

test('WalletConnect.tsx surfaces SANCTIONS_LIST_STALE_MESSAGE when the vendored list is older than SDN_LIST_MAX_AGE_DAYS', () => {
  const WALLET_CONNECT = readFileSync(join(APP, 'src/components/WalletConnect.tsx'), 'utf8');
  assert.match(WALLET_CONNECT, /sdnListAgeDays\(\)\s*>\s*SDN_LIST_MAX_AGE_DAYS/, 'the same age comparison assertNotSanctioned uses, not a re-derived one');
  assert.match(WALLET_CONNECT, /listStale\s*\?\s*<p[^>]*>\{SANCTIONS_LIST_STALE_MESSAGE\}<\/p>\s*:\s*null/);
});

test('MUTATION: a WalletConnect.tsx body with the freshness banner removed is caught', () => {
  const preFixBody = `
      {error ? <p className="note tag-warn">{error}</p> : null}
      {sanctioned ? <p className="note tag-warn">{SANCTIONS_REFUSAL_MESSAGE}</p> : null}
    </div>
  );
}`;
  assert.doesNotMatch(preFixBody, /SANCTIONS_LIST_STALE_MESSAGE/, 'RED: the pre-fix body has no stale-list banner at all — this is why the real assertions above check for it by name');
});
