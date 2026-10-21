#!/usr/bin/env bash
# Read-back of a v2 deployment. Keyless and read-only: the replays are eth_call simulations sent
# `--from` PROTOCOL_INITIALIZER, so this runs unchanged against a real RPC (set R and ORA).
# The feedOf expectations are the dry run's stand-in inputs; edit them to the frozen config.
R=${R:-http://127.0.0.1:8545}
PI=0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35
HERE=$(cd "$(dirname "$0")" && pwd); MANIFEST=$HERE/../../../contracts/config/create2-manifest.json
# The six singleton addresses come from the manifest, never from literals here, so they cannot drift.
m() { jq -er ".contracts.$1.address" "$MANIFEST" || { echo "no $1 in $MANIFEST" >&2; exit 1; }; }
REG=$(m OperatorRegistry) SUB=$(m SubVaultRegistry) FEE=$(m FeeEngine)
GOV=$(m Governance) DEP=$(m VaultDeployer) FAC=$(m VaultFactory)
ORA=${ORA:?set ORA to the blessed oracle}
WETH=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 WBTC=0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599 USDC=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
pass=0 fail=0
lc() { echo "$1" | tr 'A-F' 'a-f'; }
eq() { if [ "$(lc "$2")" == "$(lc "$3")" ]; then echo "PASS  $1 = $2"; pass=$((pass+1)); else echo "FAIL  $1: got $2 want $3"; fail=$((fail+1)); fi; }
call() { cast call "$@" -r $R 2>&1 | awk '{print $1}'; }
eq "chainId" "$(cast chain-id -r $R)" 1
for p in "OperatorRegistry $REG" "SubVaultRegistry $SUB" "FeeEngine $FEE" "Governance $GOV" "VaultDeployer $DEP" "VaultFactory $FAC" "ChainlinkOracle $ORA"; do
  set $p; n=$(( ($(cast code $2 -r $R | wc -c) - 3) / 2 )); [ $n -gt 0 ] && { echo "PASS  code at $1 $2 ($n bytes)"; pass=$((pass+1)); } || { echo "FAIL  no code at $1"; fail=$((fail+1)); }
done
echo "-- constructor arguments (immutables)"
eq "FeeEngine.registry" "$(call $FEE 'registry()(address)')" $REG
eq "VaultFactory.registry" "$(call $FAC 'registry()(address)')" $REG
eq "VaultFactory.governance" "$(call $FAC 'governance()(address)')" $GOV
eq "VaultFactory.feeEngine" "$(call $FAC 'feeEngine()(address)')" $FEE
eq "VaultFactory.subVaultRegistry" "$(call $FAC 'subVaultRegistry()(address)')" $SUB
eq "VaultFactory.vaultDeployer" "$(call $FAC 'vaultDeployer()(address)')" $DEP
eq "VaultFactory.allowSubVaults" "$(call $FAC 'allowSubVaults()(bool)')" false
echo "-- one-shot wiring and initialise"
eq "VaultFactory.initialized" "$(call $FAC 'initialized()(bool)')" true
eq "VaultFactory.oracleAllowlistEnforced" "$(call $FAC 'oracleAllowlistEnforced()(bool)')" true
eq "VaultFactory.isAllowedOracle(oracle)" "$(call $FAC 'isAllowedOracle(address)(bool)' $ORA)" true
eq "VaultFactory.isAllowedOracle(random)" "$(call $FAC 'isAllowedOracle(address)(bool)' 0x000000000000000000000000000000000000dEaD)" false
if [ -n "${FEE_TREASURY:-}" ]; then eq "FeeEngine.treasury" "$(call $FEE 'treasury()(address)')" "$FEE_TREASURY"
else n=$(call $FEE 'treasury()(address)'); [ "$(lc "$n")" != 0x0000000000000000000000000000000000000000 ] && { echo "PASS  FeeEngine.treasury is set ($n); set FEE_TREASURY to compare it"; pass=$((pass+1)); } || { echo "FAIL  FeeEngine.treasury is unset"; fail=$((fail+1)); }; fi
eq "OperatorRegistry.factory" "$(call $REG 'factory()(address)')" $FAC
eq "OperatorRegistry.feeEngine" "$(call $REG 'feeEngine()(address)')" $FEE
eq "OperatorRegistry.initialized" "$(call $REG 'initialized()(bool)')" true
eq "SubVaultRegistry.factory" "$(call $SUB 'factory()(address)')" $FAC
eq "SubVaultRegistry.initialized" "$(call $SUB 'initialized()(bool)')" true
eq "Governance.subVaultRegistry" "$(call $GOV 'subVaultRegistry()(address)')" $SUB
eq "Governance.initialized" "$(call $GOV 'initialized()(bool)')" true
ev=$(cast logs --from-block 0 --address $FAC 'Initialized(address[])' -r $R --json | jq length)
eq "VaultFactory Initialized events" "$ev" 1
echo "-- ChainlinkOracle constructor arguments"
eq "oracle.usdc" "$(call $ORA 'usdc()(address)')" $USDC
eq "oracle.sequencerUptimeFeed" "$(call $ORA 'sequencerUptimeFeed()(address)')" 0x0000000000000000000000000000000000000000
f=$(cast call $ORA 'feedOf(address)(address,uint32,uint64,uint128,uint128)' $WETH -r $R | awk '{print $1}' | paste -sd' ')
eq "oracle.feedOf(WETH)" "$f" "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419 3600 10000000000 250000000000000000000 50000000000000000000000"
f=$(cast call $ORA 'feedOf(address)(address,uint32,uint64,uint128,uint128)' $WBTC -r $R | awk '{print $1}' | paste -sd' ')
eq "oracle.feedOf(WBTC)" "$f" "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c 3600 10000000000 5000000000000000000000 1000000000000000000000000"
echo "-- PROTOCOL_INITIALIZER: the constant each contract checks, and no residual power after bring-up"
eq "OperatorRegistry.deployer" "$(call $REG 'deployer()(address)')" $PI
eq "SubVaultRegistry.deployer" "$(call $SUB 'deployer()(address)')" $PI
eq "Governance.deployer" "$(call $GOV 'deployer()(address)')" $PI
rev() { out=$(cast call "$@" --from $PI -r $R 2>&1); if echo "$out" | grep -qi "revert\|error"; then echo "PASS  replay reverts: $2 ($(echo "$out" | grep -o 'custom error [^,]*\|0x[0-9a-f]\{8\}' | head -1))"; pass=$((pass+1)); else echo "FAIL  replay succeeded: $2"; fail=$((fail+1)); fi; }
rev $FAC 'initialize(address[])' "[$ORA]"
rev $REG 'wire(address,address)' $FAC $FEE
rev $SUB 'wire(address)' $FAC
rev $GOV 'wireSubVaultRegistry(address)' $SUB
rev $FEE 'initialize(address)' 0x000000000000000000000000000000000000bEEF
echo "-- result: $pass pass, $fail fail"
