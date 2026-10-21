// Deploy a real Safe v1.4.1 (SafeL2 + SafeProxyFactory from the npm build artifacts) on the local
// anvil, set it up 2 of 3 with public anvil test owners, and route createVault + registerVault through
// execTransaction using the repository's own scripts/lib/safe-exec.mjs. Local chain only.
// Usage: node safe-2of3.mjs <repo root> <safe artifacts dir>   (env: ORA = the blessed oracle)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const [, , wt, artifacts] = process.argv;
const X = await import(`${wt}/scripts/lib/safe-exec.mjs`);
const R = 'http://127.0.0.1:8545';
const cast = (a) => execFileSync('cast', a, { encoding: 'utf8' }).trim();
const rpc = (a) => cast([...a, '-r', R]);
const K = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
];
const addr = (k) => cast(['wallet', 'address', '--private-key', k]);
const art = (p) => JSON.parse(readFileSync(`${artifacts}/${p}`, 'utf8')).bytecode;
const send = (args) => JSON.parse(cast(['send', '--private-key', K[0], '--json', '-r', R, ...args]));
const deploy = (code) => send(['--create', code]).contractAddress;
const FAC = '0xcAa8749b68FC185E14996b4Cf6fE8199A1AC0e0d', GOV = '0x9b943eB263f0E2ad46b07003aC2455Ba2e6cfC11';
const REG = '0xf80382d75920A41647F6934610f40493A3920Ea8', ORA = process.env.ORA;
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const PI = '0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35';

const singleton = deploy(art('SafeL2.sol/SafeL2.json'));
const factory = deploy(art('proxies/SafeProxyFactory.sol/SafeProxyFactory.json'));
const owners = [K[1], K[2], K[3]].map(addr);
const setup = cast(['calldata', 'setup(address[],uint256,address,bytes,address,address,uint256,address)',
  `[${owners.join(',')}]`, '2', '0x0000000000000000000000000000000000000000', '0x',
  '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', '0',
  '0x0000000000000000000000000000000000000000']);
const safe = rpc(['call', factory, 'createProxyWithNonce(address,bytes,uint256)(address)', singleton, setup, '203']);
send([factory, 'createProxyWithNonce(address,bytes,uint256)', singleton, setup, '203']);
const call = (to, sig, ...a) => rpc(['call', to, sig, ...a.map(String)]).split('\n');
const callU = (to, sig) => BigInt(call(to, sig)[0].split(' ')[0]);
const st = X.readSafeState({ call, callU, safe });
console.log(`Safe ${safe} (SafeL2 1.4.1 singleton ${singleton}, factory ${factory})`);
console.log(`  VERSION ${call(safe, 'VERSION()(string)')[0]}  threshold ${st.threshold}  owners ${st.owners.join(', ')}  nonce ${st.nonce}`);
console.log(`  PROTOCOL_INITIALIZER is an owner: ${st.owners.map((o) => o.toLowerCase()).includes(PI.toLowerCase())}`);

function exec(label, to, data, signerKeys, expectOk = true) {
  const nonce = callU(safe, 'nonce()(uint256)');
  const plan = X.buildPlan({ safe, to, data, nonce });
  const h = X.safeTransactionHash({ call, cast, plan, chainId: 1 }); // refuses on local/on-chain mismatch
  const sigs = signerKeys.map((k) => X.signAsOwner({ cast, plan, chainId: 1, signerArgs: ['--private-key', k] }));
  const packed = X.packSignatures(sigs);
  const args = X.execTransactionArgs(plan, packed).map(String);
  try {
    const r = send([safe, X.SAFE_EXEC_TRANSACTION_SIG, ...args]);
    console.log(`${expectOk ? 'PASS' : 'FAIL'}  ${label}: status ${r.status} gasUsed ${parseInt(r.gasUsed)} safeTxHash ${h} tx ${r.transactionHash}`);
  } catch (e) {
    const m = String(e.stderr || e.message).match(/GS0\d\d|custom error [^,]*/);
    console.log(`${expectOk ? 'FAIL' : 'PASS'}  ${label}: reverted ${m ? m[0] : String(e.message).slice(0, 120)}`);
  }
}

const vp = `(${USDC},[${WETH},${WBTC}],${ORA},50000000000,10000000,0,0,[])`;
const createData = cast(['calldata', 'createVault((address,address[],address,uint256,uint256,uint256,uint256,address[]))', vp]);
exec('createVault with ONE owner signature (1 of 3, below threshold)', FAC, createData, [K[1]], false);
exec('createVault with owners 1 and 3 (2 of 3)', FAC, createData, [K[1], K[3]]);
const vault = call(FAC, 'allVaults(uint256)(address)', 0)[0];
const opId = call(REG, 'operatorOf(address)(uint256)', vault)[0].split(' ')[0];
console.log(`  vault ${vault}  creator ${call(vault, 'creator()(address)')[0]}  operator #${opId} ${call(REG, 'operatorAddressOf(uint256)(address)', opId)[0]}`);
const regData = cast(['calldata', 'registerVault(address,(uint32,uint32,uint32,uint32,uint16,uint16,uint16,uint32))', vault, '(86400,86400,0,86400,2500,500,4000,3600)']);
for (const [who, from] of [['PROTOCOL_INITIALIZER', PI], ['the throwaway deployer key', addr(K[0])]]) {
  try {
    rpc(['call', GOV, '--data', regData, '--from', from]);
    console.log(`FAIL  registerVault from ${who} did not revert`);
  } catch (e) {
    const m = String(e.stderr || e.message).match(/NotVaultCreator|custom error [^,]*/);
    console.log(`PASS  registerVault from ${who} reverts: ${m ? m[0] : 'reverted'}`);
  }
}
exec('registerVault with owners 2 and 3 (2 of 3)', GOV, regData, [K[2], K[3]]);
console.log(`  vaultRegistered ${call(GOV, 'vaultRegistered(address)(bool)', vault)[0]}  configOf ${call(GOV, 'configOf(address)(uint32,uint32,uint32,uint32,uint16,uint16,uint16,uint32)', vault).map((s) => s.split(' ')[0]).join(',')}`);
