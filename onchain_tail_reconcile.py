"""
Sprint 7 / Chain dept: reconcile the non-mega-merchant tail's ~6x gap (STRATEGY.md sec 0.2)
using MEAN basis (not median -- see ORG-LESSONS.md 'Comparing a median to a stated average').

Reuses the proven calldata decoder + positive control from onchain_verify_values2.py verbatim
(imported, not reimplemented). Runs the 4/4 positive control before trusting any decode.

Disjoint window check against all four prior windows used this org:
  1. onchain_verify_values.py         : blocks ~49344877-49344976
  2. onchain_verify_values2.py disjoint: blocks 49323515-49323614
  3. onchain_verify_values2.py spotcheck: blocks 48050232-48050251 (~30d back)
  4. onchain_merchant_dollar_share(+ecosystem): blocks 49348974-49349273
This run uses blocks 49339501-49340000 (500 blocks) -- disjoint from all four, ~2.9-6h before
the latest window at time of run (latest=49350266).

Free RPC only. No paid endpoint touched. No tx signed or sent.
"""
import json, time, statistics
import onchain_verify_values2 as v2

MEGA_MERCHANT = v2.MEGA_MERCHANT.lower()

PRIOR_WINDOWS = [
    (49344877, 49344976, "onchain_verify_values.py"),
    (49323515, 49323614, "onchain_verify_values2.py disjoint_window"),
    (48050232, 48050251, "onchain_verify_values2.py spotcheck_30d_back"),
    (49348974, 49349273, "onchain_merchant_dollar_share(+ecosystem)"),
]

START_BLOCK = 49339501
END_BLOCK   = 49340000

def check_disjoint():
    for (ps, pe, tag) in PRIOR_WINDOWS:
        overlap = not (END_BLOCK < ps or START_BLOCK > pe)
        print(f"  vs {tag} [{ps}-{pe}]: {'OVERLAP!!' if overlap else 'disjoint OK'}")
        if overlap:
            raise SystemExit(f"ABORT: window overlaps prior range {tag}")

def scan_window(addrs):
    addr_set_l = set(a.lower() for a in addrs)
    matches = []
    blocks_scanned = 0
    total_tx_seen = 0
    for bn in range(START_BLOCK, END_BLOCK + 1):
        blk = v2.get_block(bn, full=True)
        if blk is None:
            continue
        blocks_scanned += 1
        txs = blk.get("transactions", [])
        total_tx_seen += len(txs)
        for tx in txs:
            if tx.get("from", "").lower() in addr_set_l:
                sel, val, frm, recipient = v2.decode_calldata_value(tx.get("input", "0x"))
                contract = (tx.get("to") or "").lower()
                is_usdc_call = (contract == v2.USDC.lower())
                matches.append({
                    "hash": tx["hash"], "from": tx["from"], "block": bn,
                    "recipient": recipient, "selector": sel,
                    "is_usdc_call": is_usdc_call,
                    "value_usdc": val if is_usdc_call else None,
                })
        if blocks_scanned % 100 == 0:
            print(f"  scanned {blocks_scanned}/{END_BLOCK-START_BLOCK+1} blocks, "
                  f"total_tx_seen={total_tx_seen}, matches={len(matches)}", flush=True)
        time.sleep(0.08)
    return matches, blocks_scanned, total_tx_seen

if __name__ == "__main__":
    print("=== POSITIVE CONTROL (reused from onchain_verify_values2.py) ===", flush=True)
    ok = v2.control_calldata()
    if not ok:
        raise SystemExit("ABORT: positive control failed, refusing to trust decoder")

    print("\n=== DISJOINT CHECK vs 4 prior windows ===", flush=True)
    check_disjoint()

    print(f"\n=== SCANNING FRESH WINDOW blocks {START_BLOCK}-{END_BLOCK} ({END_BLOCK-START_BLOCK+1} blocks) ===", flush=True)
    data = json.load(open("facilitator_addresses.json"))
    fac = {f["id"]: f for f in data["facilitators"]}["coinbase"]
    addrs = fac["base"]
    matches, blocks_scanned, total_tx_seen = scan_window(addrs)
    print(f"SCAN DONE: blocks_scanned={blocks_scanned} total_tx_seen={total_tx_seen} facilitator_matches={len(matches)}", flush=True)

    with open("onchain_tail_reconcile_raw.json", "w") as f:
        json.dump({"start_block": START_BLOCK, "end_block": END_BLOCK,
                   "blocks_scanned": blocks_scanned, "total_tx_seen": total_tx_seen,
                   "matches": matches}, f, indent=2)

    # Full population, USDC calls only (this IS the full population of the window -- no subsample)
    usdc_matches = [m for m in matches if m["is_usdc_call"] and m["value_usdc"] is not None]
    mega_matches = [m for m in usdc_matches if (m.get("recipient") or "").lower() == MEGA_MERCHANT]
    tail_matches = [m for m in usdc_matches if (m.get("recipient") or "").lower() != MEGA_MERCHANT]

    print(f"\nusdc_matches (full pop)={len(usdc_matches)}  mega_matches={len(mega_matches)}  "
          f"tail_matches(excl. mega)={len(tail_matches)}")

    tail_values = [m["value_usdc"] for m in tail_matches]
    if not tail_values:
        raise SystemExit("ABORT: zero non-mega tail matches in this window -- cannot compute mean, window too small/unlucky")

    tail_mean = statistics.mean(tail_values)
    tail_median = statistics.median(tail_values)
    print(f"NON-MEGA TAIL (this window): n={len(tail_values)} mean=${tail_mean:.6f} median=${tail_median:.6f} "
          f"min=${min(tail_values):.6f} max=${max(tail_values):.6f}")

    # ---- Implied tail from x402scan ecosystem baseline (mean-basis) ----
    ECOSYSTEM_TX = 12_421_896
    ECOSYSTEM_DOLLARS = 711_166
    MEGA_TX_SHARE = 0.757         # triple-corroborated
    MEGA_DOLLAR_SHARE_PROXY = 0.7437  # Coinbase-window doubly-confirmed figure, used as APPROXIMATION
                                       # for the all-facilitator denominator -- stated explicitly, not exact.

    tail_tx_implied = ECOSYSTEM_TX * (1 - MEGA_TX_SHARE)
    tail_dollars_implied = ECOSYSTEM_DOLLARS * (1 - MEGA_DOLLAR_SHARE_PROXY)
    implied_tail_rate = tail_dollars_implied / tail_tx_implied

    # ---- Measured tail, independent method: fresh on-chain mean x implied tail tx count ----
    tail_dollars_measured = tail_mean * tail_tx_implied

    ratio = implied_tail_rate / tail_mean if tail_mean else None

    print("\n=== RECONCILIATION (mean-basis) ===")
    print(f"tail_tx_implied            = {ECOSYSTEM_TX} * (1-{MEGA_TX_SHARE}) = {tail_tx_implied:,.0f}")
    print(f"tail_dollars_implied       = ${ECOSYSTEM_DOLLARS} * (1-{MEGA_DOLLAR_SHARE_PROXY}) = ${tail_dollars_implied:,.2f}  "
          f"[NOTE: {MEGA_DOLLAR_SHARE_PROXY} is a Coinbase-only-window proxy applied to an all-facilitator "
          f"denominator -- stated approximation, not exact]")
    print(f"implied_tail_rate          = ${tail_dollars_implied:,.2f} / {tail_tx_implied:,.0f} tx = ${implied_tail_rate:.6f}/tx")
    print(f"measured_tail_rate (fresh onchain, mean, excl. mega) = ${tail_mean:.6f}/tx  (n={len(tail_values)})")
    print(f"measured_tail_dollars       = ${tail_mean:.6f} * {tail_tx_implied:,.0f} tx = ${tail_dollars_measured:,.2f}")
    print(f"RATIO implied/measured      = {ratio:.2f}x" if ratio else "RATIO: n/a")
    print(f"(open gap flagged in STRATEGY.md 0.2 was ~6x; measured-vs-implied is {'still open at ~same order' if ratio and 3<ratio<12 else 'RESOLVED / CHANGED' })")

    with open("onchain_tail_reconcile_summary.json", "w") as f:
        json.dump({
            "window": {"start_block": START_BLOCK, "end_block": END_BLOCK,
                       "blocks_scanned": blocks_scanned, "total_tx_seen": total_tx_seen},
            "population": {"usdc_matches": len(usdc_matches), "mega_matches": len(mega_matches),
                           "tail_matches": len(tail_matches)},
            "measured_tail_stats": {"n": len(tail_values), "mean": tail_mean, "median": tail_median,
                                    "min": min(tail_values), "max": max(tail_values)},
            "ecosystem_baseline": {"tx": ECOSYSTEM_TX, "dollars": ECOSYSTEM_DOLLARS,
                                   "mega_tx_share": MEGA_TX_SHARE,
                                   "mega_dollar_share_proxy_coinbase_window": MEGA_DOLLAR_SHARE_PROXY},
            "implied_tail": {"tx": tail_tx_implied, "dollars": tail_dollars_implied, "rate": implied_tail_rate},
            "measured_tail": {"rate": tail_mean, "dollars_scaled": tail_dollars_measured},
            "ratio_implied_over_measured": ratio,
        }, f, indent=2)
    print("\nWrote onchain_tail_reconcile_raw.json, onchain_tail_reconcile_summary.json")
