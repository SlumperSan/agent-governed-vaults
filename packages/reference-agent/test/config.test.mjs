// @ts-check
/**
 * The safety gates: dry-run by default, execute refused unless BOTH conditions hold, and no key
 * material survives into anything log-bound.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chainBindingVerdict } from '../../chain-config/src/chain-binding.mjs';
import { createLogger } from '../src/log.mjs';
import {
  DEFAULT_CONFIG,
  EXECUTE_ENV_VAR,
  ConfigError,
  fromBaseUnits,
  gateMode,
  loadConfig,
  redact,
  redactUrls,
  toBaseUnits,
} from '../src/config.mjs';

const ACCOUNT = { address: '0x' + '1'.repeat(40), signMessage: async () => '0x' };

test('the default mode is dry-run and skipWindow is off', () => {
  assert.equal(DEFAULT_CONFIG.mode, 'dry-run');
  assert.equal(DEFAULT_CONFIG.danger.allowSkipWindow, false);
  assert.equal(loadConfig().mode, 'dry-run');
});

test('dry-run needs nothing and signs no transactions', () => {
  assert.deepEqual(gateMode({ mode: 'dry-run' }), { mode: 'dry-run', signsTransactions: false });
  // Even with everything an execute run would need, dry-run stays dry-run.
  assert.equal(gateMode({ mode: 'dry-run', account: ACCOUNT, env: { [EXECUTE_ENV_VAR]: 'yes' } }).signsTransactions, false);
});

test('execute REFUSES without an account', () => {
  assert.throws(
    () => gateMode({ mode: 'execute', account: null, env: { [EXECUTE_ENV_VAR]: 'yes' } }),
    (e) => e instanceof ConfigError && /no viem account was injected/.test(e.message),
  );
});

test('execute REFUSES without the env var', () => {
  assert.throws(
    () => gateMode({ mode: 'execute', account: ACCOUNT, env: {} }),
    (e) => e instanceof ConfigError && new RegExp(EXECUTE_ENV_VAR).test(e.message),
  );
});

test('execute REFUSES on a near-miss env value — no truthiness, no aliases', () => {
  for (const v of ['1', 'true', 'YES', 'Yes', 'y', ' yes', 'yes ', ''])
    assert.throws(() => gateMode({ mode: 'execute', account: ACCOUNT, env: { [EXECUTE_ENV_VAR]: v } }), ConfigError, `value ${JSON.stringify(v)} must not unlock execute`);
});

test('execute REFUSES rather than silently downgrading to dry-run', () => {
  // The failure mode this guards: a gate that returned dry-run on a missing condition would teach
  // an operator the env var is optional, and they would be wrong exactly once.
  let result = null;
  try {
    result = gateMode({ mode: 'execute', account: null, env: {} });
  } catch {
    /* expected */
  }
  assert.equal(result, null, 'gateMode must throw, never return a downgraded mode');
});

test('execute is allowed only with BOTH an account and the exact env value', () => {
  assert.deepEqual(gateMode({ mode: 'execute', account: ACCOUNT, env: { [EXECUTE_ENV_VAR]: 'yes' } }), {
    mode: 'execute',
    signsTransactions: true,
  });
});

test('an unknown mode is rejected', () => {
  assert.throws(() => loadConfig({ mode: 'yolo' }), ConfigError);
  assert.throws(() => gateMode({ mode: 'yolo' }), ConfigError);
});

test('redact reduces a signer to its public address', () => {
  const account = { address: '0x' + 'a'.repeat(40), signMessage: () => {}, signTransaction: () => {}, source: 'privateKey' };
  const out = redact({ account });
  assert.equal(out.account.address, account.address);
  assert.equal(out.account.signMessage, undefined);
  assert.equal(out.account.signTransaction, undefined);
});

test('redact removes key-shaped fields and bare 32-byte hex', () => {
  const KEY = '0x' + 'de'.repeat(32);
  const out = redact({
    privateKey: KEY,
    secret: 'hunter2',
    mnemonic: 'test test test',
    nested: { pk: KEY, salt: KEY },
    incidental: KEY,
  });
  const flat = JSON.stringify(out);
  assert.ok(!flat.includes('de'.repeat(32)), `a key survived redaction: ${flat}`);
  assert.ok(!flat.includes('hunter2'));
  assert.ok(!flat.includes('test test test'));
  assert.equal(out.incidental, '[redacted:32-byte-hex]');
});

test('redact survives cycles and deep nesting without throwing', () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: 'deep' } } } } } } } } };
  assert.doesNotThrow(() => redact(deep));
  assert.equal(redact(10n ** 20n), '100000000000000000000');
});

test('redact removes session-key and serialized-account fields', () => {
  const out = redact({ sessionKey: 'S1', sessionPrivateKey: 'S2', serializedSessionKey: 'S3', serializedAccount: 'S4', approval: 'kept' });
  for (const k of ['sessionKey', 'sessionPrivateKey', 'serializedSessionKey', 'serializedAccount']) assert.equal(out[k], '[redacted]', k);
  assert.equal(out.approval, 'kept', 'the dry-run approval field must stay readable');
});

// An Alchemy RPC URL carries its API key in the path. It must never reach a log line, whether it
// arrives in the message, in a detail, inside an error's text, or through the chain-binding verdict.
const KEY_SEGMENT = 'sk9Xq2LmT7vR4wZ8yB1nC6dF3gH5jK0p';
const ALCHEMY = `https://arb-sepolia.g.alchemy.com/v2/${KEY_SEGMENT}?x=1`;

test('redactUrls cuts any URL in a string to scheme plus host', () => {
  assert.equal(redactUrls(`could not reach ${ALCHEMY} (retrying)`), 'could not reach https://arb-sepolia.g.alchemy.com (retrying)');
  assert.equal(redactUrls(`a ${ALCHEMY}\nb ${ALCHEMY}`), 'a https://arb-sepolia.g.alchemy.com\nb https://arb-sepolia.g.alchemy.com');
  assert.equal(redactUrls('wss://u:pw@node.example:8546/ws/KEY'), 'wss://node.example:8546');
  assert.equal(redactUrls('http://127.0.0.1:8402'), 'http://127.0.0.1:8402');
  assert.equal(redactUrls('no url here'), 'no url here');
});

for (const json of [false, true]) {
  test(`a key-shaped URL path never appears in captured log output (${json ? 'json' : 'prose'})`, async () => {
    const lines = [];
    const log = createLogger({ write: (l) => lines.push(l), json });
    log.info(`chain binding: ${ALCHEMY}`);
    log.error('read failed', { err: `HTTP request failed. URL: ${ALCHEMY} Details: fetch failed`, nested: [{ url: ALCHEMY }] });
    log.banner([`rpc ${ALCHEMY}`]);
    log.section(`reading ${ALCHEMY}`);
    log.checks('rpc', [{ ok: false, name: 'reachable', detail: ALCHEMY }]);
    // The verdict is what run.mjs logs as `chain binding: ...`, and what the indexer and canary throw.
    for (const rpcChainId of [null, 1, 84532]) {
      const v = chainBindingVerdict({ declaredChainId: 84532, rpcChainId, rpc: ALCHEMY, declaredBy: '--chain-id' });
      log.info(`chain binding: ${v.message}`);
      assert.ok(!v.message.includes(KEY_SEGMENT), `verdict leaked the key: ${v.message}`);
      assert.match(v.message, /https:\/\/arb-sepolia\.g\.alchemy\.com/);
    }
    const out = lines.join('\n') + JSON.stringify(log.records());
    assert.ok(out.length > 0);
    assert.ok(!out.includes(KEY_SEGMENT), `the key reached a log line:\n${out}`);
    assert.ok(!out.includes('/v2/'), `a URL path reached a log line:\n${out}`);
    assert.ok(out.includes('arb-sepolia.g.alchemy.com'), 'the host should stay, so the operator can tell which RPC');
  });
}

test('run.mjs never prints the RPC URL path when the RPC is unreachable', () => {
  // End to end: the real CLI, an RPC on a refused port, the key in the path. Binding refuses
  // (unreadable chain id) and exits 2; nothing it printed may carry the path.
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../src/run.mjs', import.meta.url)), `--rpc=http://127.0.0.1:1/v2/${KEY_SEGMENT}`], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 2, `expected the binding refusal exit code, got ${r.status}:\n${out}`);
  assert.match(out, /UNPROVEN/);
  assert.ok(out.includes('http://127.0.0.1:1'), `the host should be printed:\n${out}`);
  assert.ok(!out.includes(KEY_SEGMENT), `the key reached the CLI output:\n${out}`);
});

test('run.mjs crash handler redacts URLs in the uncaught error it prints', () => {
  // Any uncaught error whose text carries a URL takes this path; a URL given as a profile name is
  // the cheapest way to make one (the ConfigError quotes the value it refused).
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../src/run.mjs', import.meta.url)), `--profile=https://h.example/v2/${KEY_SEGMENT}`], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 1, `expected the crash exit code, got ${r.status}:\n${out}`);
  assert.match(r.stderr, /unknown policy\.join\.profile "https:\/\/h\.example"/);
  assert.ok(!out.includes(KEY_SEGMENT), `the key reached the crash output:\n${out}`);
});

test('USDC amounts round-trip through base units', () => {
  assert.equal(toBaseUnits('25'), 25_000_000n);
  assert.equal(toBaseUnits('0.01'), 10_000n);
  assert.equal(toBaseUnits('0.000001'), 1n);
  assert.equal(fromBaseUnits(25_000_000n), '25');
  assert.equal(fromBaseUnits(10_000n), '0.01');
  assert.equal(fromBaseUnits(-15_500_000_000n), '-15500');
  assert.throws(() => toBaseUnits('0.0000001'), ConfigError); // 7dp — more precision than USDC has
  assert.throws(() => toBaseUnits('abc'), ConfigError);
});

test('loadConfig validates money knobs eagerly, not at first use', () => {
  assert.throws(() => loadConfig({ api: { payments: { maxSessionSpendUsdc: 'lots' } } }), ConfigError);
  assert.throws(() => loadConfig({ policy: { join: { depositUsdc: '1.9999999' } } }), ConfigError);
});

test('overrides merge deeply without dropping sibling defaults', () => {
  const cfg = loadConfig({ policy: { join: { depositUsdc: '5' } } });
  assert.equal(cfg.policy.join.depositUsdc, '5');
  assert.equal(cfg.policy.join.requireAttestedOperator, true, 'sibling default must survive');
  assert.equal(cfg.policy.timing.revealSafetyMarginSec, 1800, 'unrelated branch must survive');
});

test('the default USDC domain matches the default chain, not mainnet', () => {
  // These two fields travel together into every x402 signature the agent makes (perceive.mjs
  // builds the EIP-712 domain from them). The default chain is Base Sepolia, whose token reports
  // name() == "USDC" — the old 'USD Coin' default was mainnet's and could never recover here.
  // Verified against the live token in docs/X402-LIVE-REPORT.md §6.
  assert.equal(DEFAULT_CONFIG.chain.chainId, 84532);
  assert.equal(DEFAULT_CONFIG.chain.usdcName, 'USDC');
  assert.equal(DEFAULT_CONFIG.chain.usdcVersion, '2');
});

// ── chain presets ─────────────────────────────────────────────────────────────────────────────

test('with no preset the chain block is exactly the Base Sepolia defaults, as before', () => {
  const c = loadConfig().chain;
  assert.equal(c.preset, null);
  assert.equal(c.chainId, 84532);
  assert.equal(c.chainName, 'base-sepolia');
  assert.equal(c.rpcUrl, null);
  assert.equal(c.usdcName, 'USDC');
  assert.deepEqual(c.nativeCurrency, { name: 'Ether', symbol: 'ETH', decimals: 18 });
  assert.equal(loadConfig().policy.join.depositUsdc, '25');
  assert.equal(DEFAULT_CONFIG.chain.chainId, 84532, 'the shipped default must stay Base Sepolia');
});

test("chain.preset 'arc-mainnet' fills the chain block and the default deposit from the preset file", () => {
  const preset = JSON.parse(readFileSync(new URL('../presets/arc-mainnet.json', import.meta.url), 'utf8'));
  const cfg = loadConfig({ chain: { preset: 'arc-mainnet' } });
  assert.equal(cfg.chain.chainId, 5042);
  assert.equal(cfg.chain.chainName, 'arc-mainnet');
  assert.deepEqual(cfg.chain.nativeCurrency, { name: 'USDC', symbol: 'USDC', decimals: 18 });
  assert.deepEqual(cfg.chain.rpcUrls, preset.rpcUrls);
  assert.equal(cfg.chain.rpcUrl, preset.rpcUrls[0]);
  assert.equal(cfg.chain.governance, preset.contracts.governance.toLowerCase());
  assert.equal(cfg.chain.factory, preset.contracts.factory.toLowerCase());
  assert.equal(cfg.chain.operatorRegistry, preset.contracts.operatorRegistry.toLowerCase());
  assert.equal(cfg.chain.subvaultRegistry, preset.contracts.subvaultRegistry.toLowerCase());
  assert.equal(cfg.chain.usdc, '0x3600000000000000000000000000000000000000');
  assert.equal(cfg.chain.usdcName, preset.usdcDomain.name);
  assert.equal(cfg.chain.usdcVersion, preset.usdcDomain.version);
  assert.equal(cfg.policy.join.depositUsdc, '100');
  assert.equal(toBaseUnits(cfg.policy.join.depositUsdc), toBaseUnits(preset.minDepositUsdc), 'the default deposit meets the vault minimum');
  // Everything outside the chain block and the deposit is untouched.
  assert.equal(cfg.policy.join.requireAttestedOperator, true);
  assert.equal(cfg.mode, 'dry-run');
});

test('an explicit setting beside the preset wins over it', () => {
  const cfg = loadConfig({ chain: { preset: 'arc-mainnet', rpcUrl: 'https://arc.gateway.tenderly.co' }, policy: { join: { depositUsdc: '250' } } });
  assert.equal(cfg.chain.rpcUrl, 'https://arc.gateway.tenderly.co');
  assert.equal(cfg.policy.join.depositUsdc, '250');
  assert.equal(cfg.chain.chainId, 5042);
});

test('a chainId that disagrees with the preset is refused, an agreeing one is accepted', () => {
  assert.throws(() => loadConfig({ chain: { preset: 'arc-mainnet', chainId: 84532 } }), (e) => e instanceof ConfigError && /is chain 5042, but chain.chainId is 84532/.test(e.message));
  assert.equal(loadConfig({ chain: { preset: 'arc-mainnet', chainId: 5042 } }).chain.chainId, 5042);
});

test('a null or empty rpcUrl beside a preset is refused, an absent one takes the preset RPC', () => {
  for (const bad of [null, ''])
    assert.throws(() => loadConfig({ chain: { preset: 'arc-mainnet', rpcUrl: bad } }), (e) => e instanceof ConfigError && /rpcUrl is .* beside chain.preset/.test(e.message), String(bad));
  assert.equal(loadConfig({ chain: { preset: 'arc-mainnet', } }).chain.rpcUrl, 'https://rpc.mainnet.arc.io');
  assert.equal(loadConfig({ chain: { rpcUrl: null } }).chain.rpcUrl, null, 'no preset: null still means the stub');
});

test('a usdc override beside a preset needs its own EIP-712 name and version', () => {
  const other = '0x' + 'ab'.repeat(20);
  assert.throws(() => loadConfig({ chain: { preset: 'arc-mainnet', usdc: other } }), (e) => e instanceof ConfigError && /usdcName and chain.usdcVersion/.test(e.message));
  assert.throws(() => loadConfig({ chain: { preset: 'arc-mainnet', usdc: other, usdcName: 'X' } }), ConfigError, 'name alone is not both');
  const cfg = loadConfig({ chain: { preset: 'arc-mainnet', usdc: other, usdcName: 'X', usdcVersion: '1' } });
  assert.equal(cfg.chain.usdcName, 'X');
  assert.equal(cfg.chain.usdcVersion, '1');
  // The preset's own token, in any casing, keeps the preset's domain.
  assert.equal(loadConfig({ chain: { preset: 'arc-mainnet', usdc: '0x3600000000000000000000000000000000000000'.toUpperCase().replace('0X', '0x') } }).chain.usdcName, 'USDC');
});

test('an unknown preset name is refused, including a path-shaped one', () => {
  for (const name of ['mainnet', 'base-sepolia', '../config', 'arc-mainnet.json'])
    assert.throws(() => loadConfig({ chain: { preset: name } }), (e) => e instanceof ConfigError && /unknown chain preset/.test(e.message), name);
});

test('the preset does not leak into a later default load', () => {
  loadConfig({ chain: { preset: 'arc-mainnet' } });
  assert.equal(loadConfig().chain.chainId, 84532);
  assert.equal(DEFAULT_CONFIG.chain.preset, null);
});

// ── policy.crank validation ─────────────────────────────────────────────────

test('policy.crank: a bad scope, a non-boolean switch, or a malformed payload table is a startup error', () => {
  const bad = (crank, re) => assert.throws(() => loadConfig({ policy: { crank } }), (e) => e instanceof ConfigError && re.test(e.message));
  bad({ scope: 'everything' }, /policy\.crank\.scope must be one of held, all, off/);
  bad({ finalize: 'yes' }, /policy\.crank\.finalize must be true or false/);
  bad({ markExpired: 1 }, /policy\.crank\.markExpired must be true or false/);
  bad({ knownPayloads: [] }, /knownPayloads must be an object/);
  bad({ knownPayloads: { '0x12': '0x00' } }, /not a 32-byte 0x hash/);
  bad({ knownPayloads: { ['0x' + 'ab'.repeat(32)]: 'abcd' } }, /not 0x hex bytes/);
  bad({ knownPayloads: { ['0x' + 'ab'.repeat(32)]: '0xabc' } }, /not 0x hex bytes/);
});

test('policy.crank: valid values are accepted, and the default scope is held', () => {
  assert.equal(loadConfig().policy.crank.scope, 'held');
  const cfg = loadConfig({ policy: { crank: { scope: 'all', markExpired: true, knownPayloads: { ['0x' + 'ab'.repeat(32)]: '0x' } } } });
  assert.equal(cfg.policy.crank.scope, 'all');
  assert.equal(cfg.policy.crank.markExpired, true);
  assert.equal(cfg.policy.crank.finalize, true);
});

// ── the unproven-operator join profile ───────────────────────────────────────

test('the default join policy has no profile and requires a proven operator', () => {
  const j = loadConfig().policy.join;
  assert.equal(j.profile, null);
  assert.equal(j.requireProvenOperator, true);
  assert.deepEqual(j.disclosedAddresses, []);
  assert.equal(DEFAULT_CONFIG.policy.exit.onOperatorNetNegative, true);
});

test('the unproven-operator profile turns requireProvenOperator off and changes nothing else in the join or exit policy', () => {
  const base = loadConfig();
  const cfg = loadConfig({ policy: { join: { profile: 'unproven-operator' } } });
  assert.equal(cfg.policy.join.profile, 'unproven-operator');
  assert.equal(cfg.policy.join.requireProvenOperator, false);
  assert.deepEqual({ ...cfg.policy.join, requireProvenOperator: true, profile: null }, base.policy.join);
  assert.deepEqual(cfg.policy.exit, base.policy.exit);
  assert.equal(cfg.policy.exit.onOperatorNetNegative, true);
});

test('a key set beside the profile wins over the profile, the way it does over a chain preset', () => {
  const cfg = loadConfig({ policy: { join: { profile: 'unproven-operator', requireProvenOperator: true } } });
  assert.equal(cfg.policy.join.requireProvenOperator, true);
  assert.equal(loadConfig({ chain: { preset: 'arc-mainnet' }, policy: { join: { profile: 'unproven-operator' } } }).policy.join.depositUsdc, '100', 'the preset deposit still arrives; decideJoin pins it');
});

test('the profile refuses to start with the exit on a negative operator net turned off', () => {
  assert.throws(
    () => loadConfig({ policy: { join: { profile: 'unproven-operator' }, exit: { onOperatorNetNegative: false } } }),
    (e) => e instanceof ConfigError && /onOperatorNetNegative must stay true/.test(e.message),
  );
  assert.doesNotThrow(() => loadConfig({ policy: { exit: { onOperatorNetNegative: false } } }), 'without the profile the knob is the operator own to set');
});

test('an unknown profile name is refused, including inherited object keys', () => {
  for (const name of ['proven', 'Unproven-Operator', 'toString', '__proto__', ''])
    assert.throws(() => loadConfig({ policy: { join: { profile: name } } }), (e) => e instanceof ConfigError && /unknown policy\.join\.profile/.test(e.message), JSON.stringify(name));
});

test('disclosedAddresses and the log bounds are validated at startup', () => {
  const ok = '0x' + 'ab'.repeat(20);
  assert.deepEqual(loadConfig({ policy: { join: { disclosedAddresses: [ok] } } }).policy.join.disclosedAddresses, [ok]);
  for (const bad of ['x', [ok, 'nope'], [123], ['0x123']])
    assert.throws(() => loadConfig({ policy: { join: { disclosedAddresses: bad } } }), ConfigError, JSON.stringify(bad));
  for (const bad of [{ pageBlocks: 0 }, { maxPagesPerTick: 1.5 }, { maxBlocks: -1 }, { pacingMs: -1 }, { pacingMs: 0.5 }])
    assert.throws(() => loadConfig({ discovery: { logs: bad } }), ConfigError, JSON.stringify(bad));
  assert.doesNotThrow(() => loadConfig({ discovery: { logs: { pacingMs: 0 } } }));
});
