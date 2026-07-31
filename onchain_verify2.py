import json, urllib.request, urllib.error, time, sys, datetime

RPC = "https://mainnet.base.org"
USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
TRANSFER_SIG = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
CHUNK = 10000

def rpc(method, params, retries=6):
    payload = json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode()
    last_err = None
    for attempt in range(retries):
        req = urllib.request.Request(RPC, data=payload, headers={"Content-Type":"application/json","User-Agent":"402cap-onchain-verify/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                data = json.loads(r.read())
                if "error" in data:
                    raise RuntimeError("RPC_ERROR:"+str(data["error"]))
                return data["result"]
        except urllib.error.HTTPError as e:
            body = e.read().decode()[:300]
            last_err = f"HTTP {e.code}: {body}"
        except Exception as e:
            last_err = str(e)
        time.sleep(1.0*(attempt+1))
    raise RuntimeError(f"Failed after {retries} retries: {method} :: {last_err}")

def pad_addr(addr):
    a = addr.lower().replace("0x","")
    return "0x" + "0"*24 + a

def hexint(x):
    return int(x, 16)

def get_block_number():
    return hexint(rpc("eth_blockNumber", []))

def get_block(num):
    return rpc("eth_getBlockByNumber", [hex(num), False])

def get_logs(from_block, to_block, topics):
    return rpc("eth_getLogs", [{
        "fromBlock": hex(from_block),
        "toBlock": hex(to_block),
        "address": USDC,
        "topics": topics
    }])

def scan_facilitator(name, addresses, latest_block, total_blocks, chunk=CHUNK, sleep=0.25):
    """Scan [latest_block-total_blocks, latest_block] in chunks for USDC transfers
    where any of `addresses` is sender OR receiver. Returns dedup'd log list."""
    padded = [pad_addr(a) for a in addresses]
    seen = set()
    results = []
    start = latest_block - total_blocks
    n_chunks = (total_blocks + chunk - 1)//chunk
    for i in range(n_chunks):
        fb = start + i*chunk
        tb = min(fb + chunk - 1, latest_block)
        # incoming: topic2 (to) in our set
        for direction, topics in [
            ("in",  [TRANSFER_SIG, None, padded]),
            ("out", [TRANSFER_SIG, padded, None]),
        ]:
            logs = get_logs(fb, tb, topics)
            for lg in logs:
                key = (lg["transactionHash"], lg["logIndex"])
                if key in seen:
                    continue
                seen.add(key)
                results.append(lg)
            time.sleep(sleep)
        print(f"  [{name}] chunk {i+1}/{n_chunks} blocks {fb}-{tb}: cum logs={len(results)}", flush=True)
    return results

def decode_transfer(lg):
    from_addr = "0x"+lg["topics"][1][-40:]
    to_addr = "0x"+lg["topics"][2][-40:]
    value = int(lg["data"], 16)
    return from_addr, to_addr, value

if __name__ == "__main__":
    with open("facilitator_addresses.json") as f:
        data = json.load(f)
    fac_by_id = {f["id"]: f for f in data["facilitators"]}

    latest = get_block_number()
    b_latest = get_block(latest)
    ts_latest = hexint(b_latest["timestamp"])
    print(f"latest_block={latest} latest_ts={ts_latest} ({datetime.datetime.fromtimestamp(ts_latest, datetime.UTC)})")

    TOTAL_BLOCKS = int(sys.argv[1]) if len(sys.argv) > 1 else 100000
    targets = sys.argv[2:] if len(sys.argv) > 2 else ["coinbase","mrdn","heurist","thirdweb"]

    start_block = latest - TOTAL_BLOCKS
    b_start = get_block(start_block)
    ts_start = hexint(b_start["timestamp"])
    print(f"window_start_block={start_block} ts={ts_start} ({datetime.datetime.fromtimestamp(ts_start, datetime.UTC)})")
    window_seconds = ts_latest - ts_start
    print(f"window_seconds={window_seconds} ({window_seconds/3600:.2f} hours, {window_seconds/86400:.3f} days)")

    summary = {}
    for fid in targets:
        fac = fac_by_id[fid]
        addrs = fac.get("base", [])
        if not addrs:
            print(f"[{fid}] no base addresses, skip")
            continue
        print(f"=== {fid}: {len(addrs)} base addresses ===", flush=True)
        logs = scan_facilitator(fid, addrs, latest, TOTAL_BLOCKS)
        total_value = 0
        tx_hashes = set()
        counterparties = set()
        sample = []
        for lg in logs:
            frm, to, val = decode_transfer(lg)
            total_value += val
            tx_hashes.add(lg["transactionHash"])
            counterparties.add(frm)
            counterparties.add(to)
            if len(sample) < 8:
                sample.append({"tx": lg["transactionHash"], "from": frm, "to": to, "value_usdc": val/1e6, "block": hexint(lg["blockNumber"])})
        summary[fid] = {
            "window_blocks": TOTAL_BLOCKS,
            "window_seconds": window_seconds,
            "logs": len(logs),
            "unique_tx": len(tx_hashes),
            "total_value_usdc": total_value/1e6,
            "avg_value_usdc": (total_value/1e6/len(logs)) if logs else 0,
            "unique_counterparties": len(counterparties),
            "reported_tx_count_alltime": fac["tx_count"],
            "reported_total_amount_alltime_usdc": fac["total_amount"]/1e6,
            "sample_transfers": sample,
        }
        print(json.dumps(summary[fid], indent=2), flush=True)

    with open("onchain_verify_results.json", "w") as f:
        json.dump({"latest_block": latest, "latest_ts": ts_latest, "window_start_block": start_block,
                    "window_start_ts": ts_start, "window_seconds": window_seconds,
                    "results": summary}, f, indent=2)
    print("DONE - wrote onchain_verify_results.json")
