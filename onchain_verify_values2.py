"""
Method 2 for backlog #15: independent verification of on-chain settlement dollar values.

Two genuinely independent checks vs. notes-chain-values.md (which decoded the emitted USDC
Transfer LOG's data field):
  (a) decode the transferWithAuthorization CALLDATA's 'value' argument directly -- a different
      field, parsed via ABI decoding of tx.input, not the log.
  (b) re-run on a temporally disjoint window (~12h earlier than the original ~200s window),
      reusing the exact block range Intel's dept already used for tx-count bridging
      (49323114-49323614), so this new number is cross-checkable against their work too.

Read-only RPC only: eth_blockNumber, eth_getBlockByNumber, eth_getTransactionByHash.
No transaction signed or sent. No paid x402 endpoint touched.
"""
import json, urllib.request, urllib.error, time, sys, statistics

RPC = "https://base-rpc.publicnode.com"
RPC_FALLBACKS = ["https://base.llamarpc.com", "https://mainnet.base.org"]
USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
MEGA_MERCHANT = "0xe9030014f5dae217d0a152f02a043567b16c1abf"  # 75.7% of x402scan's 30d tx, $0.0169/tx

# Both known calldata layouts for EIP-3009 on Base USDC (FiatTokenV2.2 supports both overloads).
# For OUR purpose (extracting `value`) they are identical for the first 3 static words:
#   word0 = from, word1 = to, word2 = value  -- true whether the tail is (v,r,s) or packed bytes.
SEL_VRS = "0xe3ee160e"       # transferWithAuthorization(...,uint8 v,bytes32 r,bytes32 s)
SEL_BYTES_SIG = "0xcf092995" # transferWithAuthorization(...,bytes signature)
KNOWN_SELECTORS = {SEL_VRS, SEL_BYTES_SIG}

def rpc(method, params, retries=2, rounds=2, rpc_url=RPC, timeout=15):
    payload = json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode()
    last_err = None
    urls = [rpc_url] + [u for u in RPC_FALLBACKS if u != rpc_url]
    for rnd in range(rounds):
        for url in urls:
            for attempt in range(retries):
                req = urllib.request.Request(url, data=payload, headers={
                    "Content-Type":"application/json",
                    "User-Agent":"Mozilla/5.0 402cap-chain-values2/1.0 (research probe; read-only RPC)"})
                try:
                    with urllib.request.urlopen(req, timeout=timeout) as r:
                        data = json.loads(r.read())
                        if "error" in data:
                            raise RuntimeError("RPC_ERROR:"+str(data["error"]))
                        return data["result"]
                except urllib.error.HTTPError as e:
                    body = e.read().decode()[:300]
                    last_err = f"HTTP {e.code} @ {url}: {body}"
                except Exception as e:
                    last_err = f"{url}: {e}"
                time.sleep(0.4*(attempt+1))
        time.sleep(0.8*(rnd+1))
    raise RuntimeError(f"Failed after {rounds} rounds x {retries} retries: {method} :: {last_err}")

def hexint(x):
    return int(x, 16)

def get_block_number():
    return hexint(rpc("eth_blockNumber", []))

def get_block(num, full=True):
    return rpc("eth_getBlockByNumber", [hex(num), full])

def get_tx(txhash):
    return rpc("eth_getTransactionByHash", [txhash])

def decode_calldata_value(input_hex):
    """Return (selector, value_usdc, from_addr, to_addr) or (selector, None, None, None) if
    the selector isn't one of the known transferWithAuthorization overloads, or on malformed input."""
    if not input_hex or len(input_hex) < 10:
        return None, None, None, None
    selector = input_hex[:10].lower()
    if selector not in KNOWN_SELECTORS:
        return selector, None, None, None
    body = input_hex[10:]
    if len(body) < 3*64:
        return selector, None, None, None
    word0 = body[0:64]
    word1 = body[64:128]
    word2 = body[128:192]
    from_addr = "0x" + word0[-40:]
    to_addr = "0x" + word1[-40:]
    value = int(word2, 16) / 1e6
    return selector, value, from_addr, to_addr

# ---------- Step A: positive control for the CALLDATA decoder itself ----------
def control_calldata():
    print("=== METHOD 2 POSITIVE CONTROL: decode calldata of our own known $0.01 payments ===", flush=True)
    control = json.load(open("onchain_values_control.json"))
    results = []
    for c in control:
        tx = get_tx(c["tx"])
        contract_called = (tx.get("to") or "").lower()
        sel, val, frm, to = decode_calldata_value(tx.get("input","0x"))
        ok = (val is not None and abs(val - c["value_usdc"]) < 1e-9
              and frm and frm.lower() == c["from"].lower()
              and to and to.lower() == c["to"].lower()
              and contract_called == USDC.lower())
        results.append({"tx": c["tx"], "expected_usdc": c["value_usdc"], "decoded_selector": sel,
                        "decoded_usdc": val, "decoded_from": frm, "decoded_to_recipient": to,
                        "contract_called_is_usdc": (contract_called == USDC.lower()),
                        "match": ok})
        print(f"  {c['tx'][:12]}... expected=${c['value_usdc']} decoded=${val} selector={sel} "
              f"contract_is_usdc={contract_called == USDC.lower()} match={ok}", flush=True)
        time.sleep(0.2)
    all_ok = all(r["match"] for r in results)
    print(f"CALLDATA POSITIVE CONTROL: {'PASS' if all_ok else 'FAIL'} ({sum(r['match'] for r in results)}/{len(results)})")
    with open("onchain_values2_control.json","w") as f:
        json.dump({"all_pass": all_ok, "results": results}, f, indent=2)
    return all_ok

# ---------- Step B: cross-check calldata-decode vs log-decode on the SAME method-1 tx set ----------
def crosscheck_same_population():
    print("=== CROSSCHECK: calldata-decoded value vs log-decoded value, same 150-tx sample ===", flush=True)
    decoded1 = json.load(open("onchain_values_decoded.json"))
    results = []
    for i, d in enumerate(decoded1):
        h = d["hash"]
        log_vals = [t["value_usdc"] for t in d.get("usdc_transfers", [])]
        log_val = log_vals[0] if len(log_vals) == 1 else None
        try:
            tx = get_tx(h)
            sel, val, frm, to = decode_calldata_value(tx.get("input","0x"))
        except Exception as e:
            results.append({"hash": h, "log_value": log_val, "error": str(e)})
            print(f"  [{i+1}/{len(decoded1)}] ERROR {h[:12]}: {e}", flush=True)
            continue
        match = (log_val is not None and val is not None and abs(log_val - val) < 1e-9)
        results.append({"hash": h, "log_value": log_val, "calldata_value": val,
                        "selector": sel, "n_log_transfers": len(log_vals), "match": match})
        if (i+1) % 25 == 0:
            print(f"  [{i+1}/{len(decoded1)}] cumulative matches so far: {sum(1 for r in results if r.get('match'))}", flush=True)
        time.sleep(0.15)
    n_comparable = sum(1 for r in results if r.get("log_value") is not None and r.get("calldata_value") is not None)
    n_match = sum(1 for r in results if r.get("match"))
    print(f"CROSSCHECK DONE: {n_match}/{n_comparable} exact value matches (of {len(results)} tx total)")
    with open("onchain_values2_crosscheck.json","w") as f:
        json.dump({"n_total": len(results), "n_comparable": n_comparable, "n_match": n_match,
                   "results": results}, f, indent=2)
    return n_match, n_comparable, len(results)

# ---------- Step C: temporally disjoint window, full-population calldata decode ----------
def disjoint_window(n_blocks, end_block, addrs):
    print(f"=== DISJOINT WINDOW: blocks {end_block-n_blocks+1}-{end_block} (reuses Intel's 12h-back range) ===", flush=True)
    addr_set_l = set(a.lower() for a in addrs)
    matches = []
    blocks_scanned = 0
    total_tx_seen = 0
    start_block = end_block - n_blocks + 1
    for bn in range(start_block, end_block+1):
        blk = get_block(bn, full=True)
        if blk is None:
            continue
        blocks_scanned += 1
        txs = blk.get("transactions", [])
        total_tx_seen += len(txs)
        for tx in txs:
            if tx.get("from","").lower() in addr_set_l:
                sel, val, frm, recipient = decode_calldata_value(tx.get("input","0x"))
                contract = (tx.get("to") or "").lower()
                is_usdc_call = (contract == USDC.lower())
                matches.append({"hash": tx["hash"], "from": tx["from"], "contract": tx.get("to"),
                                "recipient": recipient, "is_usdc_call": is_usdc_call,
                                "block": bn, "selector": sel,
                                "value_usdc": val if is_usdc_call else None})
        if blocks_scanned % 20 == 0:
            print(f"  scanned {blocks_scanned}/{n_blocks} blocks, total_tx_seen={total_tx_seen}, matches={len(matches)}", flush=True)
        time.sleep(0.1)
    print(f"DISJOINT SCAN DONE: blocks_scanned={blocks_scanned} total_tx_seen={total_tx_seen} matches={len(matches)}", flush=True)
    with open("onchain_values2_disjoint_raw.json","w") as f:
        json.dump({"start_block": start_block, "end_block": end_block, "blocks_scanned": blocks_scanned,
                   "total_tx_seen": total_tx_seen, "matches": matches}, f, indent=2)

    n_non_usdc = sum(1 for m in matches if not m["is_usdc_call"])
    values = [m["value_usdc"] for m in matches if m["value_usdc"] is not None]
    selector_counts = {}
    for m in matches:
        s = m["selector"] or "none/malformed"
        selector_counts[s] = selector_counts.get(s,0)+1
    print("=== SELECTOR DISTRIBUTION (disjoint window) ===")
    for s,c in sorted(selector_counts.items(), key=lambda x:-x[1]):
        print(f"  {s}: {c}")
    print(f"excluded from value stats (contract called was NOT usdc): {n_non_usdc}/{len(matches)}")

    mega = [m for m in matches if (m.get("recipient") or "").lower() == MEGA_MERCHANT.lower()]
    mega_vals = [m["value_usdc"] for m in mega if m["value_usdc"] is not None]
    print(f"=== MEGA-MERCHANT CHECK ({MEGA_MERCHANT}, 75.7% of x402scan's 30d tx @ $0.0169/tx) ===")
    print(f"  found {len(mega)}/{len(matches)} matches to this recipient in this window; "
          f"values: {mega_vals[:10]}{'...' if len(mega_vals)>10 else ''}")
    if mega_vals:
        print(f"  mega-merchant mean=${statistics.mean(mega_vals):.6f} median=${statistics.median(mega_vals):.6f}")
    stats = None
    if values:
        values.sort()
        n = len(values)
        def pct(p):
            idx = min(n-1, int(p*n))
            return values[idx]
        stats = {
            "n": n, "median": statistics.median(values), "mean": statistics.mean(values),
            "p10": pct(0.10), "p25": pct(0.25), "p50": pct(0.50), "p75": pct(0.75),
            "p90": pct(0.90), "p99": pct(0.99), "min": values[0], "max": values[-1],
        }
        print(f"n={n} median=${stats['median']:.6f} mean=${stats['mean']:.6f} "
              f"p10=${stats['p10']:.6f} p90=${stats['p90']:.6f} max=${stats['max']:.4f}")
    with open("onchain_values2_disjoint_summary.json","w") as f:
        json.dump({"start_block": start_block, "end_block": end_block, "blocks_scanned": blocks_scanned,
                   "total_tx_seen": total_tx_seen, "n_facilitator_matched": len(matches),
                   "n_non_usdc_call": n_non_usdc,
                   "selector_counts": selector_counts, "value_stats": stats, "all_values": values,
                   "mega_merchant_matches": len(mega), "mega_merchant_values": mega_vals}, f, indent=2)
    return stats, len(matches), total_tx_seen, blocks_scanned

# ---------- Step D: small far-back spot check (~30 days back) ----------
def spot_check_far_back(n_blocks, blocks_back, addrs, tag):
    latest = get_block_number()
    end_block = latest - blocks_back
    print(f"=== SPOT CHECK '{tag}': latest={latest}, probing {n_blocks} blocks ending {end_block} "
          f"({blocks_back} blocks / ~{blocks_back*2/86400:.1f} days back) ===", flush=True)
    addr_set_l = set(a.lower() for a in addrs)
    matches = []
    blocks_scanned = 0
    total_tx_seen = 0
    errors = 0
    start_block = end_block - n_blocks + 1
    for bn in range(start_block, end_block+1):
        try:
            blk = get_block(bn, full=True)
        except Exception as e:
            errors += 1
            print(f"  block {bn} ERROR: {e}", flush=True)
            continue
        if blk is None:
            errors += 1
            continue
        blocks_scanned += 1
        txs = blk.get("transactions", [])
        total_tx_seen += len(txs)
        for tx in txs:
            if tx.get("from","").lower() in addr_set_l:
                sel, val, frm, recipient = decode_calldata_value(tx.get("input","0x"))
                contract = (tx.get("to") or "").lower()
                is_usdc_call = (contract == USDC.lower())
                matches.append({"hash": tx["hash"], "block": bn, "selector": sel,
                                "recipient": recipient,
                                "value_usdc": val if is_usdc_call else None})
    values = [m["value_usdc"] for m in matches if m["value_usdc"] is not None]
    result = {"tag": tag, "latest_at_run": latest, "start_block": start_block, "end_block": end_block,
               "blocks_back": blocks_back, "blocks_scanned": blocks_scanned, "rpc_errors": errors,
               "total_tx_seen": total_tx_seen, "n_matched": len(matches),
               "median": statistics.median(values) if values else None,
               "mean": statistics.mean(values) if values else None,
               "all_values": values}
    print(f"SPOT CHECK '{tag}' DONE: blocks_scanned={blocks_scanned}/{n_blocks} (errors={errors}) "
          f"matched={len(matches)} median={result['median']} mean={result['mean']}", flush=True)
    with open(f"onchain_values2_spotcheck_{tag}.json","w") as f:
        json.dump(result, f, indent=2)
    return result

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "all"

    if mode in ("all", "control"):
        ok = control_calldata()
        if not ok and mode == "all":
            print("ABORT: positive control failed, refusing to trust facilitator decode", flush=True)
            sys.exit(1)

    if mode in ("all", "crosscheck"):
        crosscheck_same_population()

    if mode in ("all", "disjoint"):
        data = json.load(open("facilitator_addresses.json"))
        fac = {f["id"]: f for f in data["facilitators"]}["coinbase"]
        addrs = fac["base"]
        # Reuse Intel's exact 12h-back range (500 blocks: 49323114-49323614); take the last
        # 100 of those 500 for a same-size-as-method-1 window, full-population decode (free --
        # calldata comes from the same full-block fetch, no extra receipt calls needed).
        disjoint_window(n_blocks=100, end_block=49323614, addrs=addrs)

    if mode in ("all", "spotcheck"):
        data = json.load(open("facilitator_addresses.json"))
        fac = {f["id"]: f for f in data["facilitators"]}["coinbase"]
        addrs = fac["base"]
        # ~30 days back (1,296,000 blocks @ 2s/block) -- tests historical composition, the
        # single biggest limitation flagged in notes-chain-values.md. Small n by design (cheap
        # RPC budget, ~20 blocks): explicitly a spot check, not a third full sample.
        try:
            spot_check_far_back(n_blocks=20, blocks_back=1_296_000, addrs=addrs, tag="30d_back")
        except Exception as e:
            print(f"SPOT CHECK FAILED (documented limitation, not hidden): {e}", flush=True)

    print("ALL DONE", flush=True)
