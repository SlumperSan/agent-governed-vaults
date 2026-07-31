import json, urllib.request, urllib.error, time, sys, datetime

RPCS = [
    "https://base-rpc.publicnode.com",
    "https://base.llamarpc.com",
    "https://1rpc.io/base",
]

def rpc(rpc_url, method, params, retries=3):
    payload = json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode()
    last_err = None
    for attempt in range(retries):
        req = urllib.request.Request(rpc_url, data=payload, headers={"Content-Type":"application/json","User-Agent":"402cap-onchain-verify/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read())
                if "error" in data:
                    raise RuntimeError("RPC_ERROR:"+str(data["error"]))
                return data["result"]
        except urllib.error.HTTPError as e:
            body = e.read().decode()[:300]
            last_err = f"HTTP {e.code}: {body}"
        except Exception as e:
            last_err = str(e)
        time.sleep(0.5*(attempt+1))
    raise RuntimeError(f"Failed after {retries} retries against {rpc_url}: {method} :: {last_err}")

def hexint(x):
    return int(x, 16)

def try_all(method, params):
    last_err = None
    for rpc_url in RPCS:
        try:
            return rpc_url, rpc(rpc_url, method, params)
        except Exception as e:
            last_err = e
            continue
    raise last_err

if __name__ == "__main__":
    with open("facilitator_addresses.json") as f:
        data = json.load(f)
    fac_by_id = {f["id"]: f for f in data["facilitators"]}

    used_rpc, latest_hex = try_all("eth_blockNumber", [])
    latest = hexint(latest_hex)
    print(f"using RPC={used_rpc}, latest_block={latest}")

    used_rpc2, b_latest = try_all("eth_getBlockByNumber", [hex(latest), False])
    ts_latest = hexint(b_latest["timestamp"])
    print(f"latest_ts={ts_latest} ({datetime.datetime.fromtimestamp(ts_latest, datetime.UTC)})")

    BLOCKS_PER_DAY = 43200  # 2.000s/block, measured
    windows = {
        "1d": 1*BLOCKS_PER_DAY,
        "7d": 7*BLOCKS_PER_DAY,
        "30d": 30*BLOCKS_PER_DAY,
    }

    addrs = fac_by_id["coinbase"]["base"]
    print(f"testing historical eth_getTransactionCount support, coinbase addr[0]={addrs[0]}")

    # First: does the RPC even support a non-"latest" historical block tag for getTransactionCount?
    for label, blocks_back in windows.items():
        target_block = latest - blocks_back
        try:
            _, cnt_hex = try_all("eth_getTransactionCount", [addrs[0], hex(target_block)])
            cnt = hexint(cnt_hex)
            print(f"  [{label}] block={target_block} eth_getTransactionCount(addr0)={cnt}  OK")
        except Exception as e:
            print(f"  [{label}] block={target_block} FAILED: {e}")

    # Also get "latest" nonce for addr0 for comparison
    _, latest_cnt_hex = try_all("eth_getTransactionCount", [addrs[0], "latest"])
    print(f"latest nonce addr0 = {hexint(latest_cnt_hex)}")
