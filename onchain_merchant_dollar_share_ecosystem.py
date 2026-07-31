"""
Follow-up to onchain_merchant_dollar_share.py, correcting a scope mismatch caught by review:
the first run's 74.37% denominator was Coinbase-Base-facilitator dollars only, while the vendor's
22.3% denominator is ALL-facilitator, all-chain ecosystem dollars. Re-scans the EXACT SAME finalized
block range (49,348,974-49,349,273 -- already ~10+ min old, chain-final, deterministic) using the
union of every facilitator's Base addresses from facilitator_addresses.json, so the new denominator
is scope-matched to (the Base-chain portion of) the vendor's figure.

Reuses the same calldata decoder (imported, not reimplemented). Read-only RPC only.
"""
import sys, os, json, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from onchain_verify_values2 import get_block, decode_calldata_value, USDC, MEGA_MERCHANT

START_BLOCK = 49348974
END_BLOCK = 49349273

def main():
    data = json.load(open("facilitator_addresses.json"))
    union_addrs = set()
    per_facilitator_addrs = {}
    for f in data["facilitators"]:
        addrs = [a.lower() for a in f.get("base", [])]
        per_facilitator_addrs[f["id"]] = set(addrs)
        union_addrs.update(addrs)
    print(f"Union of ALL facilitators' Base addresses: {len(union_addrs)} unique "
          f"(vs. Coinbase-only 40 used in the prior run)", flush=True)

    matches = []
    blocks_scanned = 0
    total_tx_seen = 0
    for bn in range(START_BLOCK, END_BLOCK + 1):
        blk = get_block(bn, full=True)
        if blk is None:
            continue
        blocks_scanned += 1
        txs = blk.get("transactions", [])
        total_tx_seen += len(txs)
        for tx in txs:
            frm_addr = tx.get("from", "").lower()
            if frm_addr in union_addrs:
                which_fac = [fid for fid, s in per_facilitator_addrs.items() if frm_addr in s]
                sel, val, frm, recipient = decode_calldata_value(tx.get("input", "0x"))
                contract = (tx.get("to") or "").lower()
                is_usdc_call = (contract == USDC.lower())
                matches.append({
                    "hash": tx["hash"], "block": bn, "facilitator": which_fac,
                    "sender": tx.get("from"), "selector": sel,
                    "payer_from": frm, "payee_to": recipient,
                    "is_usdc_call": is_usdc_call,
                    "value_usdc": val if is_usdc_call else None,
                })
        if blocks_scanned % 25 == 0:
            print(f"  scanned {blocks_scanned}/300 blocks, total_tx_seen={total_tx_seen}, "
                  f"matches={len(matches)}", flush=True)
        time.sleep(0.08)

    print(f"SCAN DONE (union, same window as prior run): blocks_scanned={blocks_scanned}/300 "
          f"total_tx_seen={total_tx_seen} matches={len(matches)}", flush=True)

    valued = [m for m in matches if m["value_usdc"] is not None and m["payee_to"]]
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
    mega_share = (mega["value"] / total_value) if total_value > 0 else None

    by_facilitator = {}
    for m in valued:
        for fid in m["facilitator"]:
            by_facilitator.setdefault(fid, {"n": 0, "value": 0.0})
            by_facilitator[fid]["n"] += 1
            by_facilitator[fid]["value"] += m["value_usdc"]

    print(f"=== ECOSYSTEM-BASE (all facilitators, same window) ===")
    print(f"total facilitator-submitted matches: {len(matches)}, valued: {n}")
    print(f"total decoded value (all-Base-facilitator, this window): ${total_value:.6f}")
    print(f"MEGA-MERCHANT: n_tx={mega['n']} value=${mega['value']:.6f} share={mega_share}")
    print("by facilitator (dollar value this window):")
    for fid, v in sorted(by_facilitator.items(), key=lambda kv: -kv[1]["value"]):
        print(f"  {fid}: n={v['n']} ${v['value']:.6f} share={v['value']/total_value if total_value else None}")

    result = {
        "start_block": START_BLOCK, "end_block": END_BLOCK,
        "n_union_addrs": len(union_addrs),
        "blocks_scanned": blocks_scanned, "total_tx_seen": total_tx_seen,
        "n_matches": len(matches), "n_valued": n,
        "total_decoded_value_usd_all_facilitators_base": total_value,
        "mega_merchant_value_usd": mega["value"], "mega_merchant_n_tx": mega["n"],
        "mega_merchant_share_of_all_base_facilitators": mega_share,
        "by_facilitator": {fid: {"n": v["n"], "value_usd": v["value"],
                                   "share": v["value"]/total_value if total_value else None}
                            for fid, v in by_facilitator.items()},
        "top10_payees": [{"payee": p, "n": v["n"], "value_usd": v["value"],
                           "share": v["value"]/total_value if total_value else None}
                          for p, v in ranked[:10]],
    }
    with open("onchain_merchant_dollar_share_ecosystem_summary.json", "w") as f:
        json.dump(result, f, indent=2)
    with open("onchain_merchant_dollar_share_ecosystem_raw.json", "w") as f:
        json.dump({"start_block": START_BLOCK, "end_block": END_BLOCK, "matches": matches}, f, indent=2)
    print("ALL DONE", flush=True)

if __name__ == "__main__":
    main()
