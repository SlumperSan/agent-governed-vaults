"""
Free-RPC on-chain investigation of the single largest x402 merchant address
(0xe9030014f5dae217d0a152f02a043567b16c1abf, catalogued as BlockRun.AI).

All calls are read-only (eth_blockNumber, eth_getLogs, eth_call, eth_getCode,
eth_getBalance, eth_getTransactionCount, eth_getBlockByNumber). No paid endpoint
is touched. Base blocks are ~2.000s apart (measured); eth_getLogs is capped at
10,000-block ranges by public providers, so all windows here stay well under that.

Usable both as a library (import and call the functions) and as a script:
    python onchain_merchant_concentration.py windows   # multi-window burst sample
    python onchain_merchant_concentration.py balance    # binary-search first-nonzero balance
    python onchain_merchant_concentration.py basics      # nonce/code/balance/outgoing check
"""
import json, urllib.request, time, sys, datetime

RPCS = ["https://base-rpc.publicnode.com", "https://base.gateway.tenderly.co",
        "https://base.llamarpc.com", "https://1rpc.io/base"]
# eth_getLogs specifically: publicnode 403s under load, tenderly gateway is reliable for it.
LOGS_RPCS = ["https://base.gateway.tenderly.co", "https://base-rpc.publicnode.com"]

USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
TARGET = "0xe9030014f5dae217d0a152f02a043567b16c1abf"
TARGET_TOPIC = "0x" + "0" * 24 + TARGET[2:]


def rpc(method, params, timeout=40, rpcs=None):
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    last_err = None
    for url in (rpcs or RPCS):
        try:
            req = urllib.request.Request(
                url, data=payload,
                headers={"Content-Type": "application/json",
                         "User-Agent": "402cap-merchant-concentration/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                res = json.loads(r.read())
                if "error" in res:
                    raise RuntimeError(str(res["error"]))
                return res["result"]
        except Exception as e:
            last_err = e
            time.sleep(0.4)
    raise RuntimeError(f"{method} failed on all RPCs: {last_err}")


def hexint(x):
    return int(x, 16)


def latest_block():
    return hexint(rpc("eth_blockNumber", []))


def incoming_transfer_logs(start, end):
    """Real USDC Transfer events with TARGET as recipient, [start,end] inclusive."""
    return rpc("eth_getLogs", [{
        "fromBlock": hex(start), "toBlock": hex(end),
        "address": USDC, "topics": [TRANSFER_TOPIC0, None, TARGET_TOPIC],
    }], rpcs=LOGS_RPCS)


def outgoing_transfer_logs(start, end):
    """Real USDC Transfer events with TARGET as sender, [start,end] inclusive."""
    return rpc("eth_getLogs", [{
        "fromBlock": hex(start), "toBlock": hex(end),
        "address": USDC, "topics": [TRANSFER_TOPIC0, TARGET_TOPIC, None],
    }], rpcs=LOGS_RPCS)


def balance_at(block):
    data = "0x70a08231" + "0" * 24 + TARGET[2:]
    res = rpc("eth_call", [{"to": USDC, "data": data}, hex(block)])
    return hexint(res)


def sample_window(offset_blocks, width, tag=""):
    end = latest_block() - offset_blocks
    start = end - width
    logs = incoming_transfer_logs(start, end)
    buyers = {}
    amounts = []
    for lg in logs:
        frm = "0x" + lg["topics"][1][-40:]
        buyers[frm] = buyers.get(frm, 0) + 1
        amounts.append(hexint(lg["data"]))
    rate_per_day = len(logs) / (width * 2) * 86400
    print(f"[{tag}] offset={offset_blocks} width={width} blocks {start}-{end} "
          f"-> {len(logs)} logs, {len(buyers)} buyers, rate/day~{rate_per_day:.0f}, "
          f"extrap_30d~{rate_per_day*30:.0f}")
    if amounts:
        usdc = [a / 1e6 for a in amounts]
        print(f"    usdc min={min(usdc):.6f} max={max(usdc):.6f} mean={sum(usdc)/len(usdc):.6f}")
    return len(logs), buyers, amounts


def multi_window_sample():
    offsets = [(0, "recent"), (10800, "6h_back"), (18000, "9h_back"),
               (21600, "12h_back"), (32400, "18h_back"), (43200, "24h_back"),
               (64800, "36h_back"), (86400, "48h_back"), (108000, "60h_back"),
               (129600, "72h_back")]
    total_logs, total_secs = 0, 0
    for off, tag in offsets:
        n, _, _ = sample_window(off, 500, tag)
        total_logs += n
        total_secs += 500 * 2
        time.sleep(0.5)
    rate_per_day = total_logs / total_secs * 86400
    print(f"AGGREGATE across {len(offsets)} windows: {total_logs} logs / {total_secs}s "
          f"-> rate/day~{rate_per_day:.0f}, extrap_30d~{rate_per_day*30:.0f}")


def find_first_nonzero_balance():
    """Binary-search the block at which TARGET's USDC balance first went nonzero."""
    latest = latest_block()
    # coarse scan first (verified: 37_500_001 -> 0, 45_000_001 -> nonzero on 2026-07-31)
    lo, hi = 37_500_001, 45_000_001
    assert balance_at(lo) == 0, "coarse lower bound assumption violated - rescan needed"
    assert balance_at(hi) != 0, "coarse upper bound assumption violated - rescan needed"
    while hi - lo > 1:
        mid = (lo + hi) // 2
        bal = balance_at(mid)
        if bal == 0:
            lo = mid
        else:
            hi = mid
        time.sleep(0.25)
    blk = rpc("eth_getBlockByNumber", [hex(hi), False])
    ts = hexint(blk["timestamp"])
    print(f"first_nonzero_balance_block={hi} timestamp={ts} "
          f"({datetime.datetime.utcfromtimestamp(ts).isoformat()}Z)")
    return hi, ts


def basics():
    latest = latest_block()
    nonce = hexint(rpc("eth_getTransactionCount", [TARGET, "latest"]))
    code = rpc("eth_getCode", [TARGET, "latest"])
    bal = balance_at(latest)
    print(f"latest_block={latest}")
    print(f"target_nonce_as_sender={nonce}")
    print(f"target_is_contract={code not in ('0x', '0x0')}")
    print(f"target_usdc_balance={bal/1e6:.6f}")
    out_logs = outgoing_transfer_logs(latest - 50000, latest)
    print(f"outgoing_usdc_transfers_last_50000_blocks(~27.8h)={len(out_logs)}")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "basics"
    if mode == "windows":
        multi_window_sample()
    elif mode == "balance":
        find_first_nonzero_balance()
    else:
        basics()
