#!/usr/bin/env bash
# Independently verify a live x402 run against the chain.
#
#   scripts/verify-x402-run.sh docs/evidence/x402-live-run.json [rpc-url]
#
# This deliberately shares NO code with the runner. The runner observes the chain through viem and
# writes down what it saw; this reads the same facts back through `cast` and checks them against
# that record. If the runner were wrong — or lying — the two would disagree.
#
# Every check prints PASS or FAIL and the script exits non-zero if any check fails.

set -uo pipefail

TRANSCRIPT="${1:-docs/evidence/x402-live-run.json}"
[ -f "$TRANSCRIPT" ] || { echo "no transcript at $TRANSCRIPT"; exit 1; }

j() { python -c "import json,io,sys; print(eval('t'+sys.argv[2], {'t': json.load(io.open(sys.argv[1], encoding='utf8'))}))" "$TRANSCRIPT" "$1"; }

RPC="${2:-$(j "['chain']['rpcUrl']")}"
CHAIN_ID=$(j "['chain']['chainId']")
USDC=$(j "['usdcDomain']['address']")
PAYER=$(j "['accounts']['payer']")
PAYTO=$(j "['accounts']['payTo']")
TX=$(j "['paidRead']['receiptId']")
NONCE=$(j "['paidRead']['envelope']['authorization']['nonce']")
VALUE=$(j "['paidRead']['envelope']['authorization']['value']")
BLOCK=$(j "['paidRead']['settlement']['block']")

pass=0; fail=0
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; echo "          $2"; pass=$((pass+1));
  else echo "  FAIL  $1"; echo "          actual:   $2"; echo "          expected: $3"; fail=$((fail+1)); fi
}

echo "Verifying $TRANSCRIPT"
echo "  rpc   $RPC"
echo "  tx    $TX"
echo

# 0. BIND THE RPC TO THE CHAIN THE TRANSCRIPT NAMES, before reading anything through it (#204).
#
# Every address below — the USDC contract, the payer, the payee — is chain-specific, and `$2`
# overrides the transcript's own rpcUrl. Verifying a Base Sepolia transcript through a mainnet
# endpoint does not produce a partial verdict; `cast receipt` simply finds no such transaction and
# every row FAILs, which reads as "the runner lied" rather than "you pointed me at the wrong chain".
#
# NOT a `check` row. A row would be tallied into a verdict that is itself computed against the
# wrong chain. An unreadable chain id refuses too: "I could not tell" is not "they match".
#
# A transcript with no `chain.chainId` refuses here too. `set -uo pipefail` has no `-e`, so a
# failing `j` yields an empty string rather than aborting, which then compares unequal to any live
# id and refuses. That is the right disposition reached for the wrong reason, and it printed the
# confusing "the transcript records chain ." -- so it is named explicitly instead.
if [ -z "$CHAIN_ID" ]; then
  echo "  REFUSING: the transcript records no chain.chainId, so there is nothing to bind $RPC to."
  echo "            Every address below is chain-specific, and a transcript that does not say which"
  echo "            chain it was produced on cannot be verified against one."
  exit 1
fi
LIVE_CHAIN_ID=$(cast chain-id --rpc-url "$RPC" 2>/dev/null | tr -d '[:space:]')
if [ -z "$LIVE_CHAIN_ID" ]; then
  echo "  REFUSING: could not read the chain id of $RPC, so it is UNPROVEN that it is chain $CHAIN_ID"
  echo "            (the transcript's chain.chainId). An unproven binding is not a binding."
  exit 1
fi
if [ "$LIVE_CHAIN_ID" != "$CHAIN_ID" ]; then
  echo "  REFUSING: WRONG CHAIN — $RPC reports chain id $LIVE_CHAIN_ID, but the transcript records"
  echo "            chain $CHAIN_ID. Every address below is chain-specific, so a verdict computed"
  echo "            against the wrong chain is not a partial answer, it is a meaningless one."
  exit 1
fi
echo "  chain $LIVE_CHAIN_ID (matches the transcript)"
echo

# 1. The settlement transaction succeeded, and it was a call to the USDC contract.
echo "── settlement transaction ──"
RCPT=$(cast receipt "$TX" --rpc-url "$RPC" --json)
check "receipt status is success" \
  "$(echo "$RCPT" | python -c "import json,sys; print(json.load(sys.stdin)['status'])")" "0x1"
check "transaction target is the USDC contract" \
  "$(cast tx "$TX" --rpc-url "$RPC" --json | python -c "import json,sys; print(json.load(sys.stdin)['to'].lower())")" \
  "$(echo "$USDC" | tr 'A-Z' 'a-z')"
check "mined in the block the transcript claims" \
  "$(echo "$RCPT" | python -c "import json,sys; print(int(json.load(sys.stdin)['blockNumber'],16))")" "$BLOCK"

# 2. The events. AuthorizationUsed is what makes this EIP-3009 rather than a plain transfer.
echo
echo "── events ──"
AUTH_TOPIC=$(cast sig-event "AuthorizationUsed(address,bytes32)")
XFER_TOPIC=$(cast sig-event "Transfer(address,address,uint256)")
LOGS=$(echo "$RCPT" | python -c "
import json,sys
for l in json.load(sys.stdin)['logs']:
    print(l['address'].lower(), ' '.join(l['topics']), l['data'])
")
check "AuthorizationUsed emitted for this nonce" \
  "$(echo "$LOGS" | grep -ci "$AUTH_TOPIC.*$(echo "${NONCE#0x}" | tr 'A-Z' 'a-z')")" "1"
check "Transfer emitted by the USDC contract" \
  "$(echo "$LOGS" | grep -ci "^$(echo "$USDC" | tr 'A-Z' 'a-z') $XFER_TOPIC")" "1"
check "Transfer amount equals the authorized value" \
  "$(echo "$LOGS" | grep -i "$XFER_TOPIC" | awk '{print $NF}' | head -1 | xargs -I{} cast to-dec {})" "$VALUE"

# 3. The authorization nonce is now burned on-chain — this is what makes the replay rejection real.
echo
echo "── replay protection (authoritative, on-chain) ──"
check "authorizationState(payer, nonce) is now true" \
  "$(cast call "$USDC" 'authorizationState(address,bytes32)(bool)' "$PAYER" "$NONCE" --rpc-url "$RPC")" "true"
check "the transcript recorded the facilitator rejecting the replay" \
  "$(j "['replayAtFacilitator']['body']['reason']")" "authorization-used"
check "the transcript recorded the API's local guard rejecting it too" \
  "$(j "['replayAtApi']['error']")" "payment invalid: replayed-nonce"

# 4. Balances across the settlement block — the money actually moved.
echo
echo "── balance deltas across block $BLOCK ──"
PRE=$((BLOCK - 1))
payer_pre=$(cast call "$USDC" 'balanceOf(address)(uint256)' "$PAYER" --block "$PRE"   --rpc-url "$RPC" | awk '{print $1}')
payer_post=$(cast call "$USDC" 'balanceOf(address)(uint256)' "$PAYER" --block "$BLOCK" --rpc-url "$RPC" | awk '{print $1}')
payto_pre=$(cast call "$USDC" 'balanceOf(address)(uint256)' "$PAYTO" --block "$PRE"   --rpc-url "$RPC" | awk '{print $1}')
payto_post=$(cast call "$USDC" 'balanceOf(address)(uint256)' "$PAYTO" --block "$BLOCK" --rpc-url "$RPC" | awk '{print $1}')
check "payer USDC fell by exactly the price" "$((payer_pre - payer_post))" "$VALUE"
check "payTo USDC rose by exactly the price" "$((payto_post - payto_pre))" "$VALUE"

# 5. The EIP-712 domain the whole scheme depends on.
echo
echo "── EIP-712 domain ──"
check "token name() matches what the run signed under" \
  "$(cast call "$USDC" 'name()(string)' --rpc-url "$RPC" | tr -d '"')" "$(j "['usdcDomain']['name']")"
check "token version() matches" \
  "$(cast call "$USDC" 'version()(string)' --rpc-url "$RPC" | tr -d '"')" "$(j "['usdcDomain']['version']")"
check "on-chain DOMAIN_SEPARATOR matches the recorded one" \
  "$(cast call "$USDC" 'DOMAIN_SEPARATOR()(bytes32)' --rpc-url "$RPC")" "$(j "['usdcDomain']['onChainSeparator']")"

echo
echo "── $pass passed, $fail failed ──"
[ "$fail" -eq 0 ]
