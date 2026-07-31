import json, urllib.request, urllib.error, time, sys, datetime, statistics

RPC = "https://base-rpc.publicnode.com"
# 1rpc.io caps eth_getLogs at 50 blocks - unusable for 10k chunks. mainnet.base.org needs
# a browser UA (already set below) and 403s under load per README - kept as last resort.
RPC_FALLBACKS = ["https://base.llamarpc.com", "https://mainnet.base.org"]
USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
TRANSFER_SIG = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
CHUNK = 10000

def rpc(method, params, retries=3, rounds=3, rpc_url=RPC):
    payload = json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode()
    last_err = None
    urls = [rpc_url] + [u for u in RPC_FALLBACKS if u != rpc_url]
    for rnd in range(rounds):
        for url in urls:
            for attempt in range(retries):
                req = urllib.request.Request(url, data=payload, headers={
                    "Content-Type":"application/json",
                    "User-Agent":"Mozilla/5.0 402cap-chain-values/1.0 (research probe; read-only RPC)"})
                try:
                    with urllib.request.urlopen(req, timeout=40) as r:
                        data = json.loads(r.read())
                        if "error" in data:
                            raise RuntimeError("RPC_ERROR:"+str(data["error"]))
                        return data["result"]
                except urllib.error.HTTPError as e:
                    body = e.read().decode()[:300]
                    last_err = f"HTTP {e.code} @ {url}: {body}"
                except Exception as e:
                    last_err = f"{url}: {e}"
                time.sleep(0.6*(attempt+1))
        time.sleep(1.5*(rnd+1))
    raise RuntimeError(f"Failed after {rounds} rounds x {retries} retries across all RPCs: {method} :: {last_err}")

def hexint(x):
    return int(x, 16)

def pad_addr(addr):
    a = addr.lower().replace("0x","")
    return "0x" + "0"*24 + a

def get_block_number():
    return hexint(rpc("eth_blockNumber", []))

def get_block(num, full=False):
    return rpc("eth_getBlockByNumber", [hex(num), full])

def get_logs(from_block, to_block, topics):
    return rpc("eth_getLogs", [{
        "fromBlock": hex(from_block),
        "toBlock": hex(to_block),
        "address": USDC,
        "topics": topics
    }])

def get_receipt(txhash):
    return rpc("eth_getTransactionReceipt", [txhash])

def decode_transfer(lg):
    from_addr = "0x"+lg["topics"][1][-40:]
    to_addr = "0x"+lg["topics"][2][-40:]
    value = int(lg["data"], 16)
    return from_addr, to_addr, value

# ---------- STEP 1: positive control ----------
def positive_control(our_wallet, seller, hours_back=30):
    print(f"=== POSITIVE CONTROL: our wallet {our_wallet} -> {seller} ===", flush=True)
    latest = get_block_number()
    blocks_back = int(hours_back*3600/2.0)
    start = max(0, latest - blocks_back)
    padded_us = pad_addr(our_wallet)
    n_chunks = (blocks_back + CHUNK - 1)//CHUNK
    found = []
    for i in range(n_chunks):
        fb = start + i*CHUNK
        tb = min(fb+CHUNK-1, latest)
        logs = get_logs(fb, tb, [TRANSFER_SIG, padded_us, None])
        for lg in logs:
            frm, to, val = decode_transfer(lg)
            found.append({"tx": lg["transactionHash"], "from": frm, "to": to,
                          "value_usdc": val/1e6, "block": hexint(lg["blockNumber"])})
        print(f"  chunk {i+1}/{n_chunks} blocks {fb}-{tb}: cum found={len(found)}", flush=True)
        time.sleep(0.3)
    print(json.dumps(found, indent=2))
    return found

# ---------- STEP 2: sample facilitator-sent transactions ----------
def sample_facilitator_tx(addr_set, n_blocks, start_block=None):
    """Scan n_blocks (full tx lists) ending at start_block (or latest), collect
    all txs whose 'from' is in addr_set."""
    addr_set_l = set(a.lower() for a in addr_set)
    latest = start_block if start_block else get_block_number()
    matches = []
    blocks_scanned = 0
    total_tx_seen = 0
    for bn in range(latest, latest-n_blocks, -1):
        blk = get_block(bn, full=True)
        if blk is None:
            continue
        blocks_scanned += 1
        txs = blk.get("transactions", [])
        total_tx_seen += len(txs)
        for tx in txs:
            if tx.get("from","").lower() in addr_set_l:
                matches.append({"hash": tx["hash"], "from": tx["from"], "to": tx.get("to"),
                                "block": bn, "input_selector": (tx.get("input","0x")[:10])})
        if blocks_scanned % 50 == 0:
            print(f"  scanned {blocks_scanned}/{n_blocks} blocks, total_tx_seen={total_tx_seen}, matches={len(matches)}", flush=True)
    print(f"DONE scanning: blocks_scanned={blocks_scanned} total_tx_seen={total_tx_seen} matches={len(matches)}")
    return matches, blocks_scanned, total_tx_seen, latest

def classify_and_decode(matches, addr_set):
    addr_set_l = set(a.lower() for a in addr_set)
    results = []
    for i, m in enumerate(matches):
        try:
            rcpt = get_receipt(m["hash"])
        except Exception as e:
            results.append({**m, "error": str(e)})
            continue
        logs = rcpt.get("logs", [])
        usdc_transfers = []
        other_logs = 0
        for lg in logs:
            if lg["address"].lower() == USDC.lower() and len(lg["topics"])>0 and lg["topics"][0].lower()==TRANSFER_SIG.lower():
                frm, to, val = decode_transfer(lg)
                usdc_transfers.append({"from": frm, "to": to, "value_usdc": val/1e6})
            else:
                other_logs += 1
        results.append({**m, "status": rcpt.get("status"), "usdc_transfers": usdc_transfers,
                        "n_usdc_transfers": len(usdc_transfers), "n_other_logs": other_logs,
                        "n_total_logs": len(logs)})
        if (i+1) % 20 == 0:
            print(f"  decoded {i+1}/{len(matches)} receipts", flush=True)
        time.sleep(0.05)
    return results

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "all"
    out = {}

    if mode in ("all", "control"):
        pc = positive_control("0xf0E8c76aE405963Dc49aaE5806d71c3fa3A709d6",
                               "0x2EC4545f96A24876764bF2B04D54E66A1351bE71", hours_back=30)
        out["positive_control"] = pc
        with open("onchain_values_control.json","w") as f:
            json.dump(pc, f, indent=2)

    if mode in ("all", "sample"):
        data = json.load(open("facilitator_addresses.json"))
        fac = {f["id"]: f for f in data["facilitators"]}["coinbase"]
        addrs = fac["base"]
        n_blocks = int(sys.argv[2]) if len(sys.argv) > 2 else 300
        matches, blocks_scanned, total_tx_seen, latest = sample_facilitator_tx(addrs, n_blocks)
        with open("onchain_values_matches_raw.json","w") as f:
            json.dump({"matches": matches, "blocks_scanned": blocks_scanned,
                       "total_tx_seen": total_tx_seen, "latest_block": latest}, f, indent=2)
        print(f"Matched {len(matches)} facilitator-sent tx out of {total_tx_seen} total tx across {blocks_scanned} blocks")

        decoded = classify_and_decode(matches, addrs)
        with open("onchain_values_decoded.json","w") as f:
            json.dump(decoded, f, indent=2)

        # stats
        all_values = []
        selector_counts = {}
        no_transfer_count = 0
        for d in decoded:
            sel = d.get("input_selector","?")
            selector_counts[sel] = selector_counts.get(sel,0)+1
            if d.get("n_usdc_transfers",0) == 0:
                no_transfer_count += 1
            for t in d.get("usdc_transfers", []):
                all_values.append(t["value_usdc"])

        print("=== SELECTOR DISTRIBUTION (facilitator-sent tx, by 4-byte input selector) ===")
        for sel, cnt in sorted(selector_counts.items(), key=lambda x:-x[1]):
            print(f"  {sel}: {cnt}")
        print(f"tx with ZERO usdc transfer logs: {no_transfer_count} / {len(decoded)}")
        print(f"total usdc transfer events decoded: {len(all_values)}")
        if all_values:
            all_values.sort()
            n = len(all_values)
            def pct(p):
                idx = min(n-1, int(p*n))
                return all_values[idx]
            print(f"median=${statistics.median(all_values):.6f} mean=${statistics.mean(all_values):.6f}")
            print(f"p10=${pct(0.10):.6f} p25=${pct(0.25):.6f} p50=${pct(0.50):.6f} p75=${pct(0.75):.6f} p90=${pct(0.90):.6f} p99=${pct(0.99):.6f}")
            print(f"min=${all_values[0]:.6f} max=${all_values[-1]:.6f}")

        with open("onchain_values_summary.json","w") as f:
            json.dump({
                "blocks_scanned": blocks_scanned, "total_tx_seen": total_tx_seen,
                "n_facilitator_tx_matched": len(matches),
                "selector_counts": selector_counts,
                "no_transfer_count": no_transfer_count,
                "n_transfer_events": len(all_values),
                "value_stats": {
                    "median": statistics.median(all_values) if all_values else None,
                    "mean": statistics.mean(all_values) if all_values else None,
                    "min": all_values[0] if all_values else None,
                    "max": all_values[-1] if all_values else None,
                } if all_values else None,
                "all_values": all_values,
            }, f, indent=2)
    print("ALL DONE")
