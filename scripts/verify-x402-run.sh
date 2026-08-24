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
