"""
Backlog #22: does the mega-merchant's (0xe9030014f5dae217d0a152f02a043567b16c1abf) ECOSYSTEM-WIDE
dollar share converge? Three prior readings on file disagree: 22.3% (vendor-derived, NOT an
on-chain window -- see notes-merchant-concentration.md Sec 4), 74.37% (on-chain window,
notes-merchant-dollar-share-verify.md), 57.1% (on-chain window, notes-tail-reconciliation.md).

This script runs 4 MORE fresh, mutually-disjoint, on-chain windows (Coinbase-Base-facilitator
scope, same as the 74.37% and 57.1% readings -- apples to apples), reusing the calldata decoder +
positive control from onchain_verify_values2.py verbatim (imported, not reimplemented).

Read-only RPC only (base-rpc.publicnode.com, fallback base.llamarpc.com). No tx signed/sent, no
paid endpoint touched.
"""
import sys, os, json, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from onchain_verify_values2 import (
    control_calldata, get_block_number, get_block, decode_calldata_value, USDC, MEGA_MERCHANT
)

# Every block range any prior Chain-dept script has already scanned for this merchant/value work.
# New windows below are checked against ALL of these, not just the three cited in the task.
PRIOR_WINDOWS = {
    "method1_recent":            (49344877, 49344976),  # notes-chain-values.md
    "method2_disjoint_12h":      (49323515, 49323614),  # notes-chain-values-method2.md step 3
    "method2_spotcheck_30d":     (48050232, 48050251),  # notes-chain-values-method2.md step 6
    "merchant_dollar_share_74pct": (49348974, 49349273),# notes-merchant-dollar-share-verify.md
    "tail_reconcile_57pct":      (49339501, 49340000),  # notes-tail-reconciliation.md
}

def overlaps(a_start, a_end, b_start, b_end):
    return a_start <= b_end and b_start <= a_end

def check_disjoint(name, start, end, already_run):
    all_ranges = dict(PRIOR_WINDOWS)
    all_ranges.update(already_run)
    for other_name, (ps, pe) in all_ranges.items():
        if other_name == name:
            continue
        if overlaps(start, end, ps, pe):
            raise RuntimeError(f"WINDOW '{name}' ({start}-{end}) OVERLAPS '{other_name}' ({ps}-{pe}) -- abort")

def scan_window(name, n_blocks, end_block, addrs, already_run):
    start_block = end_block - n_blocks + 1
    check_disjoint(name, start_block, end_block, already_run)
    print(f"\n=== WINDOW '{name}': blocks {start_block}-{end_block} ({n_blocks} blocks) -- "
          f"disjoint check PASSED vs all {len(PRIOR_WINDOWS)+len(already_run)} prior/sibling windows ===", flush=True)

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
        if blocks_scanned % 50 == 0:
            print(f"  [{name}] scanned {blocks_scanned}/{n_blocks}, total_tx_seen={total_tx_seen}, "
                  f"matches={len(matches)}", flush=True)
        time.sleep(0.08)

    print(f"[{name}] SCAN DONE: blocks_scanned={blocks_scanned}/{n_blocks} total_tx_seen={total_tx_seen} "
          f"facilitator_matches={len(matches)}", flush=True)

    with open(f"onchain_mega_share_{name}_raw.json", "w") as f:
        json.dump({
            "name": name, "start_block": start_block, "end_block": end_block,
            "first_ts_utc": first_ts, "last_ts_utc": last_ts,
            "blocks_scanned": blocks_scanned, "total_tx_seen": total_tx_seen,
            "matches": matches,
        }, f, indent=2)

    return matches, start_block, end_block, first_ts, last_ts, blocks_scanned, total_tx_seen


def analyze(name, matches):
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

    mega = by_payee.get(MEGA_MERCHANT.lower(), {"n": 0, "value": 0.0})
    mega_share_dollars = (mega["value"] / total_value) if total_value > 0 else None
    mega_share_count = (mega["n"] / n) if n > 0 else None

    result = {
        "name": name,
        "n_facilitator_matches": len(matches),
        "n_non_usdc_call_excluded": n_non_usdc,
        "n_valued": n,
        "n_distinct_payees": len(by_payee),
        "total_decoded_value_usd": total_value,
        "mega_merchant_n_tx": mega["n"],
        "mega_merchant_value_usd": mega["value"],
        "mega_merchant_dollar_share": mega_share_dollars,
        "mega_merchant_count_share": mega_share_count,
    }
    print(f"[{name}] total=${total_value:.6f} n={n} mega_n={mega['n']} mega_$={mega['value']:.6f} "
          f"mega_dollar_share={mega_share_dollars}", flush=True)

    with open(f"onchain_mega_share_{name}_summary.json", "w") as f:
        json.dump(result, f, indent=2)
    return result


if __name__ == "__main__":
    print("=== STEP 1: POSITIVE CONTROL (mandatory, must be 4/4 PASS) ===", flush=True)
    ok = control_calldata()
    if not ok:
        print("ABORT: positive control failed", flush=True)
        sys.exit(1)

    data = json.load(open("facilitator_addresses.json"))
    fac = {f["id"]: f for f in data["facilitators"]}["coinbase"]
    addrs = fac["base"]

    latest = get_block_number()
    print(f"\nlatest block at run time: {latest}", flush=True)

    # 4 fresh windows, chosen to spread across different times of day (burstiness is documented
    # and window-timing-sensitive per notes-merchant-concentration.md sec 2), 500 blocks each
    # (same size as the 57.1% tail_reconcile window, for size-comparability).
    plan = [
        ("w4_fresh_now",  500, latest),
        ("w5_back_9h",    500, latest - 16200),   # ~9h back
        ("w6_back_2d",    500, latest - 86400),   # ~2 days back
        ("w7_back_15d",   500, latest - 648000),  # ~15 days back
    ]

    already_run = {}
    results = []
    for name, n_blocks, end_block in plan:
        matches, sb, eb, fts, lts, bs, tts = scan_window(name, n_blocks, end_block, addrs, already_run)
        already_run[name] = (sb, eb)
        r = analyze(name, matches)
        r.update({"start_block": sb, "end_block": eb, "first_ts_utc": fts, "last_ts_utc": lts,
                   "blocks_scanned": bs, "total_tx_seen": tts})
        with open(f"onchain_mega_share_{name}_summary.json", "w") as f:
            json.dump(r, f, indent=2)
        results.append(r)

    print("\n=== ALL 4 WINDOWS DONE -- SUMMARY ===", flush=True)
    for r in results:
        print(f"  {r['name']}: blocks {r['start_block']}-{r['end_block']} n_valued={r['n_valued']} "
              f"total=${r['total_decoded_value_usd']:.4f} mega_share={r['mega_merchant_dollar_share']}", flush=True)

    with open("onchain_mega_share_multiwindow_summary.json", "w") as f:
        json.dump(results, f, indent=2)

    print("ALL DONE", flush=True)
