"""
Backlog: independently verify the mega-merchant (0xe903...c1abf, BlockRun.AI) DOLLAR share of the
x402 economy directly on-chain. The 22.3% figure in notes-merchant-concentration.md is vendor-derived
(x402scan's own stated $0.0169/tx average), never independently confirmed. This script computes the
share directly from decoded on-chain calldata values, per-payee, over a fresh disjoint window.

REUSES the calldata decoder already built and positive-controlled in onchain_verify_values2.py
(4/4 PASS on our own known $0.01 txs) -- does not reimplement decoding. Per ORG-LESSONS.md's standing
method warning: x402 settles via EIP-3009 transferWithAuthorization -- the facilitator SUBMITS and
pays gas, it never appears as payee in Transfer-log topics, so this decodes calldata (from/to/value)
directly rather than filtering Transfer events by facilitator address.

Read-only RPC only (eth_blockNumber, eth_getBlockByNumber, eth_getTransactionByHash equivalents via
full-block fetch). No tx signed or sent. No paid x402 endpoint touched.
"""
import sys, os, json, statistics, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from onchain_verify_values2 import (
    control_calldata, get_block_number, get_block, decode_calldata_value, USDC, MEGA_MERCHANT
)

PRIOR_WINDOWS = {
    "method1_recent": (49344877, 49344976),      # notes-chain-values.md, n=150
    "method2_disjoint_12h": (49323515, 49323614), # notes-chain-values-method2.md step 3
    "method2_spotcheck_30d": (48050251, 48050270),# notes-chain-values-method2.md step 6
}

def overlaps(a_start, a_end, b_start, b_end):
    return a_start <= b_end and b_start <= a_end

def scan_window(n_blocks, addrs):
    latest = get_block_number()
    end_block = latest
    start_block = end_block - n_blocks + 1

    for name, (ps, pe) in PRIOR_WINDOWS.items():
        if overlaps(start_block, end_block, ps, pe):
            raise RuntimeError(f"NEW WINDOW OVERLAPS {name} ({ps}-{pe}) -- aborting, pick a disjoint range")

    print(f"=== FRESH WINDOW: latest={latest}, scanning blocks {start_block}-{end_block} "
          f"({n_blocks} blocks, ~{n_blocks*2}s / {n_blocks*2/60:.1f} min of chain time) ===", flush=True)
    print(f"Disjoint check vs prior windows: {PRIOR_WINDOWS} -- confirmed no overlap.", flush=True)

    addr_set_l = set(a.lower() for a in addrs)
    matches = []
    blocks_scanned = 0
    total_tx_seen = 0
    first_ts = None
    last_ts = None

    for bn in range(start_block, end_block + 1):
        blk = get_block(bn, full=True)
        if blk is None:
            continue
        blocks_scanned += 1
        ts = int(blk["timestamp"], 16)
        if first_ts is None:
            first_ts = ts
        last_ts = ts
        txs = blk.get("transactions", [])
        total_tx_seen += len(txs)
        for tx in txs:
            if tx.get("from", "").lower() in addr_set_l:
                sel, val, frm, recipient = decode_calldata_value(tx.get("input", "0x"))
                contract = (tx.get("to") or "").lower()
                is_usdc_call = (contract == USDC.lower())
                matches.append({
                    "hash": tx["hash"], "block": bn, "selector": sel,
                    "payer_from": frm, "payee_to": recipient,
                    "is_usdc_call": is_usdc_call,
                    "value_usdc": val if is_usdc_call else None,
                })
        if blocks_scanned % 25 == 0:
            print(f"  scanned {blocks_scanned}/{n_blocks} blocks, total_tx_seen={total_tx_seen}, "
                  f"matches={len(matches)}", flush=True)
        time.sleep(0.08)

    print(f"SCAN DONE: blocks_scanned={blocks_scanned}/{n_blocks} total_tx_seen={total_tx_seen} "
          f"facilitator_matches={len(matches)}", flush=True)

    with open("onchain_merchant_dollar_share_raw.json", "w") as f:
        json.dump({
            "start_block": start_block, "end_block": end_block,
            "first_ts_utc": first_ts, "last_ts_utc": last_ts,
            "blocks_scanned": blocks_scanned, "total_tx_seen": total_tx_seen,
            "matches": matches,
        }, f, indent=2)

    return matches, start_block, end_block, first_ts, last_ts, blocks_scanned, total_tx_seen


def analyze(matches):
    valued = [m for m in matches if m["value_usdc"] is not None and m["payee_to"]]
    n_non_usdc = len(matches) - len(valued)
    total_value = sum(m["value_usdc"] for m in valued)
    n = len(valued)

    by_payee = {}
    for m in valued:
        p = m["payee_to"].lower()
        by_payee.setdefault(p, {"n": 0, "value": 0.0})
        by_payee[p]["n"] += 1
        by_payee[p]["value"] += m["value_usdc"]

    ranked = sorted(by_payee.items(), key=lambda kv: -kv[1]["value"])

    mega = by_payee.get(MEGA_MERCHANT.lower(), {"n": 0, "value": 0.0})
    mega_share_dollars = (mega["value"] / total_value) if total_value > 0 else None
    mega_share_count = (mega["n"] / n) if n > 0 else None

    top1_share = (ranked[0][1]["value"] / total_value) if ranked and total_value > 0 else None
    top2_value = sum(v["value"] for _, v in ranked[:2])
    top5_value = sum(v["value"] for _, v in ranked[:5])
    top2_share = top2_value / total_value if total_value > 0 else None
    top5_share = top5_value / total_value if total_value > 0 else None
    second_largest = ranked[1] if len(ranked) > 1 else None

    result = {
        "n_facilitator_matches": len(matches),
        "n_non_usdc_call_excluded": n_non_usdc,
        "n_valued": n,
        "n_distinct_payees": len(by_payee),
        "total_decoded_value_usd": total_value,
        "mega_merchant": MEGA_MERCHANT,
        "mega_merchant_n_tx": mega["n"],
        "mega_merchant_value_usd": mega["value"],
        "mega_merchant_dollar_share": mega_share_dollars,
        "mega_merchant_count_share_this_window": mega_share_count,
        "second_largest_payee": second_largest[0] if second_largest else None,
        "second_largest_payee_value_usd": second_largest[1]["value"] if second_largest else None,
        "second_largest_payee_share": (second_largest[1]["value"] / total_value) if second_largest and total_value > 0 else None,
        "top1_share": top1_share,
        "top5_share": top5_share,
        "top10": [
            {"payee": p, "n_tx": v["n"], "value_usd": v["value"],
             "share": (v["value"] / total_value) if total_value > 0 else None}
            for p, v in ranked[:10]
        ],
    }

    print("=== ANALYSIS ===")
    print(f"n facilitator matches: {len(matches)}, excluded (non-USDC-call): {n_non_usdc}, "
          f"valued+has-payee: {n}")
    print(f"total decoded value in window: ${total_value:.6f}")
    print(f"distinct payees: {len(by_payee)}")
    print(f"MEGA-MERCHANT ({MEGA_MERCHANT}): n_tx={mega['n']}, value=${mega['value']:.6f}, "
          f"dollar_share={mega_share_dollars}")
    if second_largest:
        print(f"2nd-largest payee: {second_largest[0]}, value=${second_largest[1]['value']:.6f}, "
              f"share={result['second_largest_payee_share']}")
    print(f"top-5 payee concentration: {top5_share}")
    print("top10 by dollar value:")
    for row in result["top10"]:
        print(f"  {row['payee']}  n={row['n_tx']}  ${row['value_usd']:.4f}  share={row['share']}")

    with open("onchain_merchant_dollar_share_summary.json", "w") as f:
        json.dump(result, f, indent=2)

    return result


if __name__ == "__main__":
    print("=== STEP 1: RE-RUN POSITIVE CONTROL (mandatory, per ORG-LESSONS.md) ===", flush=True)
    ok = control_calldata()
    if not ok:
        print("ABORT: positive control failed, refusing to trust decoder", flush=True)
        sys.exit(1)

    data = json.load(open("facilitator_addresses.json"))
    fac = {f["id"]: f for f in data["facilitators"]}["coinbase"]
    addrs = fac["base"]

    n_blocks = int(sys.argv[1]) if len(sys.argv) > 1 else 300
    matches, sb, eb, fts, lts, bs, tts = scan_window(n_blocks, addrs)
    result = analyze(matches)
    result["start_block"] = sb
    result["end_block"] = eb
    result["first_ts_utc"] = fts
    result["last_ts_utc"] = lts
    result["blocks_scanned"] = bs
    result["total_tx_seen"] = tts
    with open("onchain_merchant_dollar_share_summary.json", "w") as f:
        json.dump(result, f, indent=2)

    print("ALL DONE", flush=True)
