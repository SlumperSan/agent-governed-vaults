/**
 * The fake Base Sepolia chain that answers every `cast` invocation scripts/smoke-test.mjs makes,
 * across the full happy-path lifecycle: create -> register -> deposit -> activate -> propose ->
 * commit -> reveal -> finalize -> execute -> exit.
 *
 * This is NOT a mock of smoke-test.mjs. It has no idea smoke-test.mjs exists. It is a small,
 * stateful model of the on-chain facts the UNMODIFIED script reads and writes via `cast`, keyed
 * off the exact argv shapes `cast()` in smoke-test.mjs builds (see scripts/smoke-test.mjs:70-145).
 * The unmodified script's own logic (event decoding, assertions, retry loops) runs for real
 * against these answers; only the transport is fake.
 *
 * Addresses and amounts are read from the SAME two files the real script reads (SMOKE_CONFIG,
 * DEPLOY_JSON) rather than duplicated here, so the fixture cannot silently drift from what the
 * script itself will load.
 */
import fs from 'node:fs';
import { keccak256, toHex } from 'viem';
// The real Status enum order, not a re-typed copy of it: STATUS.indexOf(...) below must line up
// with lib/proposal-decode.mjs's own decodeProposal, or a respelled status here would pass this
// harness while silently drifting from what the script's own decode expects.
import { STATUS } from '../../lib/proposal-decode.mjs';

/** `cast keccak`: hex input hashes the decoded bytes, anything else hashes the UTF-8 string. */
const isHexLike = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]*$/.test(s);
export function castKeccak(data) {
  return keccak256(isHexLike(data) ? data : toHex(String(data)));
}

/** `cast abi-encode`: real ABI encoding is not needed here — nothing on this fake chain decodes
 * it (there is no EVM underneath). A deterministic hex string is enough for `keccakOf(payload)`
 * to produce a stable actionHash and for the commit/reveal commitment to round-trip. */
export function fakeAbiEncode(sig, args) {
  return '0x' + Buffer.from([sig, ...args].join('|'), 'utf8').toString('hex');
}

/** Pad a 20-byte address into the 32-byte left-padded form an event topic carries. */
export function addressToTopic(addr) {
  return '0x' + '0'.repeat(24) + addr.slice(2).toLowerCase();
}

const mkAddr = (tag) => '0x' + tag.padStart(40, '0');

export const SIGNER_ADDR = mkAddr('51de5');
export const VAULT_ADDR = mkAddr('4a017');
const OTHER_ADDR = mkAddr('bad2'); // used by the 'bad-creator' negative control

const T_VAULT_CREATED = castKeccak('VaultCreated(address,address,address,uint256)');
const T_REBALANCE_EXECUTED = castKeccak('RebalanceExecuted(address,uint256)');
const T_EXIT_SETTLED = castKeccak('ExitSettled(address,uint256,uint256,uint256,uint256)');

// Chain-time constants. FAKE_NOW is chosen far past every deadline the script computes, so
// waitUntilChainTime's `now >= target` check is already satisfied on the FIRST read and the
// script never enters its real-wall-clock sleep loop.
const BASE_T = 1_000_000;
const AVAILABLE_AT = BASE_T + 14_400; // 4h observation window
const COMMIT_DEADLINE = AVAILABLE_AT + 3_600;
const REVEAL_DEADLINE = COMMIT_DEADLINE + 3_600;
const EXPIRES_AT = REVEAL_DEADLINE + 86_400;
export const FAKE_NOW = 5_000_000_000;

function addrOf(dep, name) {
  const tx = (dep.transactions ?? []).find((t) => t.transactionType === 'CREATE' && t.contractName === name);
  if (!tx) throw new Error(`fixture deploy json missing exactly one CREATE for ${name}`);
  return tx.contractAddress;
}

/**
 * @param {object} opts
 * @param {string} opts.configPath   same path smoke-test.mjs will read via SMOKE_CONFIG
 * @param {string} opts.deployJsonPath   same path smoke-test.mjs will read via DEPLOY_JSON
 * @param {string} opts.logPath   every intercepted call is appended here as one JSON line
 * @param {string} [opts.scenario]   'happy' or a named negative-control fault (see below)
 */
export function createFakeChain({ configPath, deployJsonPath, logPath, scenario = 'happy' }) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const dep = JSON.parse(fs.readFileSync(deployJsonPath, 'utf8'));

  const registryAddr = addrOf(dep, 'OperatorRegistry');
  const governanceAddr = addrOf(dep, 'Governance');
  const factoryAddr = addrOf(dep, 'VaultFactory');
  const aggregatorAddr = addrOf(dep, 'ChainlinkOracle');
  const usdcAddr = cfg.usdc;
  const depositUsdc = BigInt(cfg.smoke.depositUsdc);

  let usdcBalance = depositUsdc * 10n;
  let pendingDepositAmt = 0n;
  let activated = false;
  let shares = 0n;
  let navWad = 0n;
  let registered = false;
  let proposalStatus = 'None';
  let hasPendingExecution = false;
  let payload = null;
  let actionHash = null;
  let sendCounter = 0;

  const appendLog = (entry) => {
    if (logPath) fs.appendFileSync(logPath, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
  };

  /** Build a fake execFileSync-shaped Error: `.stderr` is what cast()/attempt() consult. */
  const castError = (stderr) => Object.assign(new Error(`fixture cast failure: ${stderr}`), { stderr });

  const nextReceipt = (logs) => {
    sendCounter += 1;
    return {
      status: '0x1',
      transactionHash: '0x' + String(sendCounter).padStart(64, '0'),
      blockNumber: 1000 + sendCounter,
      logs,
    };
  };

  function handleCall(to, sig) {
    if (sig.startsWith('wire(')) {
      appendLog({ kind: 'call', sig, to, broadcast: false });
      if (scenario === 'wire-ok') return ''; // no throw: registry falsely accepted the re-wire
      if (scenario === 'wire-transport') throw castError('error sending request: 429 Too Many Requests');
      throw castError('reverted: AlreadyWired()');
    }
    // The vault's OWN creator(), re-read after the broadcast rather than trusted from the event:
    // the event is emitted by the factory, `creator()` is what the protocol acts on for the life of
    // the vault. 'creator-reread-differs' makes the vault disagree with the event it emitted — the
    // only way to exercise that second assertion, since in every other scenario the two agree and
    // the first one fails before this is reached.
    if (sig.startsWith('creator(')) {
      return scenario === 'creator-reread-differs' ? OTHER_ADDR : SIGNER_ADDR;
    }
    if (sig.startsWith('priceWad(')) return '2500000000000000000000';
    if (sig.startsWith('balanceOf(') && to.toLowerCase() === usdcAddr.toLowerCase()) return usdcBalance.toString();
    if (sig.startsWith('operatorOf(')) return '1';
    if (sig.startsWith('vaultRegistered(')) return registered ? 'true' : 'false';
    if (sig.startsWith('pendingDeposit(')) return `${pendingDepositAmt}\n${AVAILABLE_AT}`;
    if (sig.startsWith('navWad(')) return navWad.toString();
    if (sig.startsWith('sharesOf(')) return shares.toString();
    if (sig.startsWith('activeProposalOf(')) return '1';
    if (sig.startsWith('hasPendingExecution(')) return hasPendingExecution ? 'true' : 'false';
    if (sig.startsWith('proposals(')) {
      return [
        VAULT_ADDR, '0', SIGNER_ADDR, String(BASE_T), String(COMMIT_DEADLINE), String(REVEAL_DEADLINE),
        String(REVEAL_DEADLINE), String(EXPIRES_AT), String(STATUS.indexOf(proposalStatus)),
        actionHash ?? ('0x' + '0'.repeat(64)), '0', '1', '0', '0', '0', '0',
      ].join('\n');
    }
    throw new Error(`fixture: unhandled cast call sig ${JSON.stringify(sig)} to ${to}`);
  }

  function handleSend(to, sig) {
    if (sig.startsWith('createVault(')) {
      const creatorTopicAddr = scenario === 'bad-creator' ? OTHER_ADDR : SIGNER_ADDR;
      const logs = [{
        address: VAULT_ADDR,
        topics: [T_VAULT_CREATED, addressToTopic(VAULT_ADDR), addressToTopic(creatorTopicAddr)],
      }];
      const receipt = nextReceipt(logs);
      if (scenario === 'bad-status') receipt.status = '0x0';
      return receipt;
    }
    if (sig.startsWith('registerVault(')) { registered = true; return nextReceipt([]); }
    if (sig.startsWith('approve(')) return nextReceipt([]);
    if (sig.startsWith('deposit(')) {
      pendingDepositAmt = depositUsdc;
      usdcBalance -= depositUsdc;
      return nextReceipt([]);
    }
    if (sig.startsWith('activate(')) {
      activated = true;
      shares = depositUsdc;
      navWad = depositUsdc * 10n ** 12n;
      return nextReceipt([]);
    }
    if (sig.startsWith('propose(')) { proposalStatus = 'Active'; return nextReceipt([]); }
    if (sig.startsWith('commitVote(')) return nextReceipt([]);
    if (sig.startsWith('revealVote(')) return nextReceipt([]);
    if (sig.startsWith('finalize(')) { proposalStatus = 'Passed'; hasPendingExecution = true; return nextReceipt([]); }
    if (sig.startsWith('execute(')) {
      hasPendingExecution = false;
      return nextReceipt([{ address: VAULT_ADDR, topics: [T_REBALANCE_EXECUTED] }]);
    }
    if (sig.startsWith('requestExit(')) {
      if (scenario !== 'bad-roundtrip') usdcBalance += depositUsdc;
      if (scenario !== 'shares-not-burned') shares = 0n;
      return nextReceipt([{ address: VAULT_ADDR, topics: [T_EXIT_SETTLED] }]);
    }
    throw new Error(`fixture: unhandled cast send sig ${JSON.stringify(sig)} to ${to}`);
  }

  /** @param {string[]} args the exact argv smoke-test.mjs's cast() was about to exec */
  function handle(args) {
    const [cmd, ...rest] = args;
    if (cmd === 'chain-id') return String(cfg.chainId);
    // `cast code <addr>` — card 179. The creator check asks the chain whether the declared
    // intendedCreator is ACTUALLY THERE, as the kind the deployment record declares.
    //
    // '0x' IS THE REALISTIC DEFAULT, not a shortcut: the fixture signer is an EOA, and the real
    // base-sepolia record declares `intendedCreatorKind: "eoa"`, so an empty code answer is exactly
    // what the live chain returns for it (measured against sepolia.base.org, 2026-09-21). The happy
    // path therefore exercises the agreeing case rather than skipping the check.
    if (cmd === 'code') {
      // 'creator-has-code' makes the chain report bytecode at an address the record declares an
      // EOA — the other direction of the same disagreement, and the one reachable without a second
      // deployment record.
      return scenario === 'creator-has-code' ? '0x60806040' : '0x';
    }
    if (cmd === 'wallet' && rest[0] === 'address') { appendLog({ kind: 'wallet-address' }); return SIGNER_ADDR; }
    if (cmd === 'balance') return (10n ** 18n).toString(); // 1 test ETH, well above the 0.01 floor
    if (cmd === 'block' && rest[0] === 'latest' && rest[1] === '-f') {
      return rest[2] === 'timestamp' ? String(FAKE_NOW) : '999999999';
    }
    if (cmd === 'keccak') return castKeccak(rest[0]);
    if (cmd === 'abi-encode') {
      const out = fakeAbiEncode(rest[0], rest.slice(1));
      if (rest[0].startsWith('f(address,')) { payload = out; actionHash = castKeccak(out); }
      return out;
    }
    if (cmd === 'call') {
      const [to, sig] = rest;
      try {
        const value = handleCall(to, sig);
        appendLog({ kind: 'call', sig, to, broadcast: false, ok: true });
        return value;
      } catch (e) {
        appendLog({ kind: 'call', sig, to, broadcast: false, ok: false, error: String(e.stderr ?? e.message) });
        throw e;
      }
    }
    if (cmd === 'send') {
      const [to, sig] = rest;
      const receipt = handleSend(to, sig);
      appendLog({ kind: 'send', sig, to, broadcast: true, argv: args, receiptStatus: receipt.status });
      return JSON.stringify(receipt);
    }
    throw new Error(`fixture: unhandled cast subcommand ${JSON.stringify(args)}`);
  }

  return { handle, registryAddr, governanceAddr, factoryAddr, aggregatorAddr, usdcAddr };
}
