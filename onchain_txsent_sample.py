import json, urllib.request, time, sys

RPCS = ["https://base-rpc.publicnode.com", "https://base.llamarpc.com", "https://1rpc.io/base"]

def rpc_batch(rpc_url, reqs, timeout=40):
    payload = json.dumps(reqs).encode()
    req = urllib.request.Request(rpc_url, data=payload, headers={"Content-Type":"application/json","User-Agent":"402cap-onchain-verify/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())

def hexint(x): return int(x, 16)

def get_blocks_range(start, end, batch_size=25):
    """Fetch full blocks [start, end] inclusive, batched. Returns dict blocknum -> block."""
    blocks = {}
    nums = list(range(start, end+1))
    for i in range(0, len(nums), batch_size):
        chunk = nums[i:i+batch_size]
        reqs = [{"jsonrpc":"2.0","id":n,"method":"eth_getBlockByNumber","params":[hex(n), True]} for n in chunk]
        last_err = None
        for url in RPCS:
            try:
                res = rpc_batch(url, reqs)
                for item in res:
                    if "error" in item:
                        raise RuntimeError(str(item["error"]))
                    blocks[item["id"]] = item["result"]
                last_err = None
                break
            except Exception as e:
                last_err = e
                time.sleep(0.5)
        if last_err:
            raise RuntimeError(f"batch {chunk[0]}-{chunk[-1]} failed on all RPCs: {last_err}")
        print(f"  fetched blocks {chunk[0]}-{chunk[-1]} (cum {len(blocks)})", flush=True)
        time.sleep(0.15)
    return blocks

if __name__ == "__main__":
    with open("facilitator_addresses.json") as f:
        data = json.load(f)
    fac_by_id = {f["id"]: f for f in data["facilitators"]}
    coinbase_addrs = set(a.lower() for a in fac_by_id["coinbase"]["base"])

    N_BLOCKS = int(sys.argv[1]) if len(sys.argv) > 1 else 1500

    latest = None
    for url in RPCS:
        try:
            resp = rpc_batch(url, [{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}])
            item = resp[0] if isinstance(resp, list) else resp
            latest = hexint(item["result"])
            break
        except Exception as e:
            print(f"blockNumber failed on {url}: {e}")
    if latest is None:
        raise RuntimeError("could not get latest block from any RPC")
    start = latest - N_BLOCKS
    print(f"latest={latest} sampling blocks {start}-{latest} ({N_BLOCKS} blocks, ~{N_BLOCKS*2}s = {N_BLOCKS*2/3600:.2f}h)")

    blocks = get_blocks_range(start, latest)

    total_tx = 0
    coinbase_tx = 0
    first_ts = None
    last_ts = None
    per_addr = {}
    for num in sorted(blocks.keys()):
        blk = blocks[num]
        ts = hexint(blk["timestamp"])
        if first_ts is None: first_ts = ts
        last_ts = ts
        for tx in blk["transactions"]:
            total_tx += 1
            frm = (tx.get("from") or "").lower()
            if frm in coinbase_addrs:
                coinbase_tx += 1
                per_addr[frm] = per_addr.get(frm, 0) + 1

    real_seconds = last_ts - first_ts if last_ts and first_ts else N_BLOCKS*2
    print(f"real_window_seconds={real_seconds} ({real_seconds/3600:.3f}h, {real_seconds/86400:.4f}d)")
    print(f"total_tx_in_window={total_tx}")
    print(f"coinbase_facilitator_tx_sent_in_window={coinbase_tx}")
    print(f"per_addr breakdown: {per_addr}")
    if real_seconds > 0:
        rate_per_day = coinbase_tx / real_seconds * 86400
        print(f"extrapolated_rate_per_day={rate_per_day:.1f}")
        print(f"extrapolated_30d={rate_per_day*30:.0f}")

    with open("onchain_txsent_sample_results.json", "w") as f:
        json.dump({
            "n_blocks": N_BLOCKS, "start_block": start, "end_block": latest,
            "real_window_seconds": real_seconds, "total_tx": total_tx,
            "coinbase_tx_sent": coinbase_tx, "per_addr": per_addr,
            "extrapolated_rate_per_day": coinbase_tx/real_seconds*86400 if real_seconds>0 else None,
            "extrapolated_30d": coinbase_tx/real_seconds*86400*30 if real_seconds>0 else None,
        }, f, indent=2)
    print("DONE - wrote onchain_txsent_sample_results.json")
