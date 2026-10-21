#!/usr/bin/env bash
# Ethereum v2 deploy dry run on a LOCAL anvil at chain id 1 (Osaka rules). No real key is used and
# nothing is sent anywhere but 127.0.0.1. See docs/audits/2026-10-21-deploy-dry-run.md.
#
# Needs forge, cast and anvil on PATH (Foundry 1.7.1 was used) and a `forge build` of contracts/.
# Optional env:
#   SOLC=<path>            a solc binary for forge --use (with --offline) when forge cannot fetch one
#   SAFE_ARTIFACTS=<dir>   build/artifacts/contracts of `npm i @safe-global/safe-contracts@1.4.1-build.0`;
#                          step 8 (real 2 of 3 Safe) is skipped, and says so, without it
#   WORK=<dir>             scratch directory (default: a new mktemp dir)
set -u
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../../.." && pwd)
WORK=${WORK:-$(mktemp -d)}; mkdir -p "$WORK"
R=http://127.0.0.1:8545; export R
FORGE_ARGS=(); [ -n "${SOLC:-}" ] && FORGE_ARGS=(--use "$SOLC" --offline)
# Broadcast records go to WORK, never to contracts/broadcast/<script>/1/, so a rehearsal at chain id
# 1 leaves nothing a real mainnet run could later mistake for its own (forge --resume reads there).
export FOUNDRY_BROADCAST="$WORK/broadcast"
K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil account 0, public test key
PI=0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35
WETH=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 WBTC=0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599 USDC=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
FETH=0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419 FBTC=0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c
step() { echo; echo "######## $1"; }
cleanup() { [ -f "$WORK/anvil.pid" ] && kill "$(cat "$WORK/anvil.pid")" 2>/dev/null; rm -rf "$REPO"/contracts/cache/*.s.sol/1; }
trap cleanup EXIT
anvil --chain-id 1 --port 8545 --hardfork osaka --timestamp 1792000000 > "$WORK/anvil.log" 2>&1 & echo $! > "$WORK/anvil.pid"
sleep 3

step "stand-ins: compile"
mkdir -p "$WORK/standins/src"
cat > "$WORK/standins/src/StandIns.sol" <<'SOL'
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
/// Stand-in for a Chainlink AggregatorV3 proxy, etched at the real mainnet feed address. Always fresh.
contract FeedStandIn {
    string public description;
    uint8 public decimals;
    int256 public answer;
    function init(string calldata d, uint8 dec, int256 a) external { description = d; decimals = dec; answer = a; }
    function version() external pure returns (uint256) { return 4; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, block.timestamp, block.timestamp, 1);
    }
}
/// Stand-in for an ERC20, etched at the real mainnet token address.
contract TokenStandIn {
    uint8 public decimals;
    mapping(address => uint256) public balanceOf;
    function init(uint8 dec) external { decimals = dec; }
}
SOL
(cd "$WORK/standins" && forge build --root . --contracts src --out out --evm-version cancun "${FORGE_ARGS[@]}" >/dev/null) || { echo "stand-in build failed"; exit 1; }

step "0. chain and proxy"
echo "chainId $(cast chain-id -r $R)  hardfork $(cast rpc anvil_nodeInfo -r $R | jq -r .hardFork)"
echo "Arachnid proxy runtime $(cast code 0x4e59b44847b379578588920cA78FbF26c0B4956C -r $R)"
echo "PROTOCOL_INITIALIZER code bytes $(( ($(cast code $PI -r $R | wc -c) - 3) / 2 ))  nonce $(cast nonce $PI -r $R)"
for c in OperatorRegistry SubVaultRegistry FeeEngine Governance VaultDeployer VaultFactory; do a=$(jq -r ".contracts.$c.address" "$REPO/contracts/config/create2-manifest.json"); echo "predicted $c $a code bytes $(( ($(cast code $a -r $R | wc -c) - 3) / 2 ))"; done

step "1. stage stand-ins at mainnet feed and token addresses (no mainnet RPC was reachable)"
FEED=$(jq -r .deployedBytecode.object "$WORK/standins/out/StandIns.sol/FeedStandIn.json"); TOK=$(jq -r .deployedBytecode.object "$WORK/standins/out/StandIns.sol/TokenStandIn.json")
for a in $FETH $FBTC; do cast rpc anvil_setCode $a $FEED -r $R >/dev/null; done
for a in $WETH $WBTC $USDC; do cast rpc anvil_setCode $a $TOK -r $R >/dev/null; done
cast send $FETH "init(string,uint8,int256)" "ETH / USD" 8 250000000000 --private-key $K0 -r $R >/dev/null
cast send $FBTC "init(string,uint8,int256)" "BTC / USD" 8 8000000000000 --private-key $K0 -r $R >/dev/null
cast send $WETH "init(uint8)" 18 --private-key $K0 -r $R >/dev/null; cast send $WBTC "init(uint8)" 8 --private-key $K0 -r $R >/dev/null; cast send $USDC "init(uint8)" 6 --private-key $K0 -r $R >/dev/null
echo "ETH/USD $(cast call $FETH 'description()(string)' -r $R) answer 2500e8; BTC/USD $(cast call $FBTC 'description()(string)' -r $R) answer 80000e8; token decimals 18/8/6"

cd "$REPO/contracts"
export ORACLE_ASSETS=$WETH,$WBTC ORACLE_FEEDS=$FETH,$FBTC ORACLE_HEARTBEATS=3600,3600 ORACLE_USDC=$USDC
step "2a. DeployChainlinkOracle on chain 1 with NO price band (must refuse)"
ORACLE_MIN_WAD=0,0 ORACLE_MAX_WAD=0,0 forge script script/DeployChainlinkOracle.s.sol:DeployChainlinkOracle "${FORGE_ARGS[@]}" --rpc-url $R --private-key $K0 2>&1 | grep -m1 "Error"
step "2b. DeployChainlinkOracle, throwaway key, bands at ratio 200"
export ORACLE_MIN_WAD=250000000000000000000,5000000000000000000000 ORACLE_MAX_WAD=50000000000000000000000,1000000000000000000000000
forge script script/DeployChainlinkOracle.s.sol:DeployChainlinkOracle "${FORGE_ARGS[@]}" --rpc-url $R --private-key $K0 --broadcast 2>&1 | grep -E "feed OK|ChainlinkOracle |sequencer|COMPLETE|Error"
ORA=$(jq -r '.receipts[0].contractAddress' "$FOUNDRY_BROADCAST/DeployChainlinkOracle.s.sol/1/run-latest.json"); export ORA; echo "ORA=$ORA"
step "3a. Deploy.s.sol with EMPTY BLESSED_ORACLES on chain 1 (must refuse)"
forge script script/Deploy.s.sol:Deploy "${FORGE_ARGS[@]}" --rpc-url $R --private-key $K0 --broadcast 2>&1 | grep -m1 "Error"
step "3b. Deploy.s.sol signed by the throwaway key (must refuse: broadcast is pinned to PROTOCOL_INITIALIZER)"
BLESSED_ORACLES=$ORA forge script script/Deploy.s.sol:Deploy "${FORGE_ARGS[@]}" --rpc-url $R --private-key $K0 --broadcast 2>&1 | grep -m1 "Error"
echo "block after refusals $(cast block-number -r $R)"
step "3c. Deploy.s.sol as PROTOCOL_INITIALIZER (anvil impersonation, no key)"
cast rpc anvil_impersonateAccount $PI -r $R >/dev/null; cast rpc anvil_setBalance $PI 0x8AC7230489E80000 -r $R >/dev/null
BLESSED_ORACLES=$ORA forge script script/Deploy.s.sol:Deploy "${FORGE_ARGS[@]}" --rpc-url $R --unlocked --sender $PI --broadcast 2>&1 | grep -E "^  [A-Z][A-Za-z]+ +0x|COMPLETE|Error"
step "4. per-transaction gas (EIP-7825 cap 16,777,216; anvil does not enforce it, so it is checked here)"
for f in DeployChainlinkOracle.s.sol Deploy.s.sol; do node -e '
const j=require(process.argv[1]); j.transactions.forEach((t,i)=>{const r=j.receipts[i]; const g=parseInt(t.transaction.gas); console.log([g<=16777216?"PASS":"FAIL", t.transactionType, t.contractName||"-", t.function||"", "from="+t.transaction.from, "gasLimit="+g, "gasUsed="+parseInt(r.gasUsed), "status="+r.status].join(" "))})' "$FOUNDRY_BROADCAST/$f/1/run-latest.json"; done
step "5. read-back"
"$HERE/readback.sh"
for p in "OperatorRegistry 0xf80382d75920A41647F6934610f40493A3920Ea8" "SubVaultRegistry 0x1C85cF7122BEF88b4DdF2d5Ef0C5e8549348e5b0" "Governance 0x9b943eB263f0E2ad46b07003aC2455Ba2e6cfC11"; do set $p; a=$(cast code $2 -r $R | tr A-F a-f); b=$(jq -r .deployedBytecode.object out/$1.sol/$1.json | tr A-F a-f); [ "$a" == "$b" ] && echo "PASS  runtime == local build: $1" || echo "FAIL  runtime differs: $1"; done
step "6. initialisation preflight (repo script, two endpoints)"
sed "s/ORACLE_ADDR/$ORA/" "$HERE/plan.tmpl.json" > "$WORK/plan.json"; sed "s/ORACLE_ADDR/0x000000000000000000000000000000000000dEaD/" "$HERE/plan.tmpl.json" > "$WORK/plan-wrong.json"
node "$REPO/scripts/protocol-initialize-preflight.mjs" --plan "$WORK/plan.json"; echo "exit $?"
echo "-- negative: plan names an oracle that was not blessed"
node "$REPO/scripts/protocol-initialize-preflight.mjs" --plan "$WORK/plan-wrong.json" 2>&1 | head -2; echo "exit ${PIPESTATUS[0]}"
step "7. manifest"
(cd "$REPO" && node scripts/update-create2-manifest.mjs --check)
step "8. real Safe v1.4.1, 2 of 3, as vault creator and operator"
if [ -n "${SAFE_ARTIFACTS:-}" ]; then node "$HERE/safe-2of3.mjs" "$REPO" "$SAFE_ARTIFACTS"; else echo "SKIP  SAFE_ARTIFACTS not set"; fi
step "done"
