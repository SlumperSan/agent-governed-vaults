// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @notice Timestamp-keyed value history for proposal-time stake snapshots (threat model VO-9:
/// voting power is read at proposal creation, so post-creation flash deposits carry no weight).
/// Timestamps only — no block numbers (commitment C-2).
library Checkpoints {
    struct Checkpoint {
        uint64 ts;
        uint192 value;
    }

    struct History {
        Checkpoint[] arr;
    }

    error ValueOverflow();

    /// @notice Record `value` at the current timestamp, overwriting a same-second checkpoint.
    function push(History storage h, uint256 value) internal {
        if (value > type(uint192).max) revert ValueOverflow();
        uint256 len = h.arr.length;
        if (len > 0 && h.arr[len - 1].ts == uint64(block.timestamp)) {
            h.arr[len - 1].value = uint192(value);
        } else {
            h.arr.push(Checkpoint(uint64(block.timestamp), uint192(value)));
        }
    }

    function latest(History storage h) internal view returns (uint256) {
        uint256 len = h.arr.length;
        return len == 0 ? 0 : h.arr[len - 1].value;
    }

    /// @notice Last value recorded at or before `ts` (0 if none). Binary search.
    function getAt(History storage h, uint64 ts) internal view returns (uint256) {
        uint256 lo = 0;
        uint256 hi = h.arr.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (h.arr[mid].ts <= ts) lo = mid + 1;
            else hi = mid;
        }
        return lo == 0 ? 0 : h.arr[lo - 1].value;
    }
}
