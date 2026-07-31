import json, urllib.request, time, sys

RPC = "https://mainnet.base.org"
USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".lower()
TRANSFER_SIG = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

def rpc(method, params, retries=5):
    payload = json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode()
    for attempt in range(retries):
        req = urllib.request.Request(RPC, data=payload, headers={"Content-Type":"application/json","User-Agent":"402cap-onchain-verify/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read())
                if "error" in data:
                    err = data["error"]
                    msg = str(err)
                    if "limit" in msg.lower() or "range" in msg.lower() or "too many" in msg.lower():
                        raise RuntimeError("RANGE_ERROR:"+msg)
                    raise RuntimeError("RPC_ERROR:"+msg)
                return data["result"]
        except RuntimeError as e:
            if str(e).startswith("RANGE_ERROR"):
                raise
            time.sleep(1.5*(attempt+1))
        except Exception as e:
            time.sleep(1.5*(attempt+1))
    raise RuntimeError(f"Failed after {retries} retries: {method}")

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

def log(msg):
    print(msg, flush=True)
    sys.stdout.flush()

if __name__ == "__main__":
    latest = get_block_number()
    log(f"latest_block={latest}")
    b_latest = get_block(latest)
    ts_latest = hexint(b_latest["timestamp"])
    log(f"latest_ts={ts_latest}")

    # sample block ~10000 back to compute block time
    sample_back = 10000
    b_sample = get_block(latest - sample_back)
    ts_sample = hexint(b_sample["timestamp"])
    dt = ts_latest - ts_sample
    blocktime = dt / sample_back
    log(f"sample_block={latest-sample_back} sample_ts={ts_sample} delta_s={dt} avg_blocktime={blocktime:.3f}s")
