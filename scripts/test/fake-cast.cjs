// @ts-check
/**
 * A stand-in for `cast`, for scripts/test/verify-chainlink-oracle.test.mjs. NO RPC, NO NETWORK.
 *
 * How it is wired. The verifier runs `execFileSync(CAST, args)`, and Windows cannot exec a script
 * file as a program, so the test sets `CAST` to node itself and preloads this file through
 * `NODE_OPTIONS=--require`. Node runs preloads BEFORE it resolves the main entry, so when the
 * verifier spawns `node call 0x… 'decimals()(uint8)' --rpc-url …` this file answers as cast would
 * and exits before node goes looking for a script named "call". In any other process (the verifier
 * itself, the test runner) it recognises no subcommand and does nothing.
 *
 * Scenario. `FAKE_CAST_FAIL` is a `;`-separated list of `<signature|code>=<transport|revert|nocode>`
 * naming which invocations fail and how. The three stderr wordings are the ones cast 1.7.1 printed
 * on 2026-09-04 against a local anvil (`revert`: a contract whose code is a bare REVERT; `nocode`:
 * an address with no code) and a local HTTP server answering 429 (`transport`), so what
 * `classifyCallError` sees here is what it sees from a real cast. `nocode` on `code` itself prints
 * `0x` and exits 0, which is what `cast code` really does for an address with no code.
 * `FAKE_CAST_LOG`, if set, receives one line per invocation so a test can count retries;
 * `FAKE_CAST_SEQ` names the address whose latestRoundData answers 0 (a sequencer feed).
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const sub = path.basename(String(process.argv[1] ?? ''));
if (sub === 'call' || sub === 'code') {
  const addr = process.argv[2];
  const key = sub === 'call' ? process.argv[3] : 'code';
  if (process.env.FAKE_CAST_LOG) fs.appendFileSync(process.env.FAKE_CAST_LOG, `${sub} ${addr} ${key}\n`);

  const fail = Object.fromEntries(
    (process.env.FAKE_CAST_FAIL ?? '').split(';').filter(Boolean).map((e) => e.split('=')),
  );
  const STDERR = {
    transport: 'Error: error sending request for url (http://127.0.0.1:8598/)\n\nContext:\n- operation timed out\n',
    revert: 'Error: server returned an error response: error code 3: execution reverted, data: "0x"\n',
    nocode: `Error: contract ${addr} does not have any code\n`,
  };
  const mode = fail[key];
  if (mode === 'nocode' && key === 'code') {
    fs.writeSync(1, '0x\n');
    process.exit(0);
  }
  if (mode) {
    fs.writeSync(2, STDERR[mode] ?? `${mode}\n`);
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  const isSeq = String(addr).toLowerCase() === String(process.env.FAKE_CAST_SEQ ?? '').toLowerCase();
  const OUT = {
    code: '0x6080604052',
    'description()(string)': '"ETH / USD"',
    'decimals()(uint8)': '8',
    'aggregator()(address)': '0x05c84a58Fe042275b37DB038BAacd15F410c7bB0',
    'phaseId()(uint16)': '1',
    'latestRoundData()(uint80,int256,uint256,uint256,uint80)': `1\n${isSeq ? '0' : '245911590522 [2.459e11]'}\n${now - 5}\n${now - 5}\n1`,
  };
  if (!(key in OUT)) {
    fs.writeSync(2, `fake-cast: unexpected invocation ${process.argv.slice(1).join(' ')}\n`);
    process.exit(3);
  }
  fs.writeSync(1, `${OUT[key]}\n`);
  process.exit(0);
}
