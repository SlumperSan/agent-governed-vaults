// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IPriceSource} from "../OracleAggregator.sol";

/// @notice Minimal Pyth surface — the two declarations this repo actually uses, vendored
/// rather than pulling in the official `pyth-sdk-solidity` package (which brings an ERC-20-free
/// dependency tree, its own `PythStructs`/`PythErrors` files and an `AbstractPyth` base for a
/// single `view` call). The struct layout is ABI-identical to `PythStructs.Price`:
/// `(int64 price, uint64 conf, int32 expo, uint256 publishTime)`. Same vendoring rationale as
/// `SafeTransferLib` — keep the dependency surface auditable in one sitting.
interface IPyth {
    struct Price {
        /// @dev Price, scaled by `10 ** expo`.
        int64 price;
        /// @dev Confidence interval, in the same units and scale as `price`.
        uint64 conf;
        /// @dev Base-10 exponent; negative in practice (−8 for most USD feeds).
        int32 expo;
        /// @dev Unix timestamp the aggregate was published at, on Pythnet.
        uint256 publishTime;
    }

    /// @notice The latest on-chain price for `id`, **without** an implicit staleness revert.
    /// @dev Deliberately the `Unsafe` variant: freshness is the aggregator's decision, made
    /// against the per-asset `maxStaleness`, not this contract's. `getPriceNoOlderThan` would
    /// duplicate that policy in a second place with a second bound, which is exactly how two
    /// staleness models drift apart. Reverts if `id` has never been populated on this chain.
    function getPriceUnsafe(bytes32 id) external view returns (Price memory price);
}

/// @title PythSource — Pyth pull-oracle feed as an IPriceSource
/// @notice Sprint 11. A **post-audit-freeze, additive** price source: it implements the
/// existing `IPriceSource` and modifies nothing inside the `v0.2.0-audit` tree. It supplies
/// the third SF-1 mechanism class, alongside `ChainlinkSourceAdapter` (push) and
/// `UniswapV3TwapSource` (spot-market TWAP).
///
/// **Everything is immutable**: the Pyth contract, the price id, and the confidence bound are
/// fixed at construction and have no setter, matching `OracleAggregator`'s posture.
///
/// ## What "pull oracle" means for the aggregator's staleness model
///
/// Chainlink pushes: a heartbeat writes the feed whether or not anyone reads it. Pyth pulls:
/// the on-chain price only advances when *somebody pays* to post a signed update. So this
/// source's `updatedAt` (`publishTime`) is a statement about keeper economics, not about
/// Pyth's own liveness — a feed can be minutes or hours stale on a quiet chain while
/// Pythnet's off-chain aggregate is a second old.
///
/// That has a direct configuration consequence, and it is the easiest way to mis-deploy this
/// contract: **`OracleAggregator`'s per-asset `maxStaleness` must be chosen against the actual
/// on-chain update cadence of the pinned price id, not only against basket volatility.**
/// DEPLOYMENT.md's standing advice to "pick `maxStaleness` tight (minutes)" is right for a
/// push feed and will, on a quiet chain, silently drop this leg out of the fresh set on most
/// reads — turning an advertised 2-of-3 quorum into an effective 2-of-2 with no margin, which
/// is a breaker one Chainlink hiccup away from freezing. Either fund a keeper that posts at a
/// known cadence, or set `maxStaleness` above the observed worst-case gap.
///
/// ## Failure modes
///
/// Every one degrades to `(0, 0)` — the aggregator's not-fresh signal, matching
/// `ChainlinkSourceAdapter`'s convention — rather than reverting:
///
/// - the price id has never been populated on this chain (`getPriceUnsafe` reverts);
/// - a non-positive price, or a zero `publishTime`;
/// - an exponent outside `[MIN_EXPO, MAX_EXPO]` (a feed reconfigured beyond what this
///   contract's normalization was reasoned about);
/// - a confidence interval wider than `maxConfBps` of the price. Pyth publishes `conf`
///   precisely so consumers can reject their own tail; a feed in disagreement with itself
///   should decline to vote in a median rather than cast an uncertain vote.
contract PythSource is IPriceSource {
    /// @notice Most negative exponent this contract will normalize. At −36 a WAD result is the
    /// raw price divided by 1e18, so anything beyond is numerically meaningless here.
    int32 public constant MIN_EXPO = -36;
    /// @notice Most positive exponent this contract will normalize. `int64` price × 10**18 ×
    /// 1e18 ≈ 9.2e54, comfortably inside uint256, so the WAD scaling below cannot overflow.
    int32 public constant MAX_EXPO = 18;
    /// @notice Widest permitted confidence bound: 20% of price. A bound looser than this is
    /// not a filter, and pinning a ceiling keeps a creator from configuring the check away.
    uint32 public constant MAX_CONF_BPS_CEILING = 2000;

    /// @notice The Pyth contract on this chain.
    IPyth public immutable pyth;
    /// @notice The pinned price-feed id (e.g. the ETH/USD feed).
    bytes32 public immutable priceId;
    /// @notice Reject a reading whose `conf` exceeds this many basis points of `price`.
    uint32 public immutable maxConfBps;

    error BadPythConfig();

    /// @notice Pin the feed forever, validating everything knowable at deployment.
    /// @dev The constructor **reads the feed**. That is the point: a mistyped 32-byte price id
    /// is otherwise indistinguishable from a correct one until the source silently returns
    /// `(0, 0)` for the life of the vault, and a source that never votes is invisible in a
    /// 2-of-3 quorum until the day one of the other two fails. `getPriceUnsafe` reverts for an
    /// unknown id, so a typo cannot be deployed. The cost of this check is that the feed must
    /// already be populated on-chain — which is a prerequisite for the source being useful at
    /// all, so it is not a real restriction.
    /// @param pyth_ the Pyth contract for this chain (must have code)
    /// @param priceId_ the price-feed id to wrap (non-zero, and resolvable today)
    /// @param maxConfBps_ confidence-band rejection threshold, in (0, MAX_CONF_BPS_CEILING]
    constructor(IPyth pyth_, bytes32 priceId_, uint32 maxConfBps_) {
        require(address(pyth_) != address(0) && address(pyth_).code.length > 0, BadPythConfig());
        require(priceId_ != bytes32(0), BadPythConfig());
        require(maxConfBps_ > 0 && maxConfBps_ <= MAX_CONF_BPS_CEILING, BadPythConfig());

        IPyth.Price memory p = pyth_.getPriceUnsafe(priceId_);
        require(p.expo >= MIN_EXPO && p.expo <= MAX_EXPO, BadPythConfig());

        pyth = pyth_;
        priceId = priceId_;
        maxConfBps = maxConfBps_;
    }

    /// @notice WAD-normalized Pyth price, or `(0, 0)` when the reading is unusable.
    /// @dev `updatedAt` is Pyth's `publishTime`, not `block.timestamp`: unlike a TWAP, this is
    /// a published number with a real publish lag, and the aggregator's staleness bound is the
    /// right place to judge it.
    /// @return priceWad USD price of one whole token, WAD (0 if the reading is unusable)
    /// @return updatedAt the aggregate's Pythnet publish timestamp (0 if unusable)
    function latestPrice() external view returns (uint256, uint256) {
        try pyth.getPriceUnsafe(priceId) returns (IPyth.Price memory p) {
            if (p.price <= 0 || p.publishTime == 0) return (0, 0);
            if (p.expo < MIN_EXPO || p.expo > MAX_EXPO) return (0, 0);

            uint256 raw = uint256(uint64(p.price));
            // Confidence gate. Cross-multiplied to avoid a division; both sides are far inside
            // uint256 (conf ≤ 1.8e19 × 1e4; raw ≤ 9.2e18 × 2e3).
            if (uint256(p.conf) * 10_000 > raw * maxConfBps) return (0, 0);

            uint256 priceWad;
            if (p.expo >= 0) {
                // Rare in practice; handled rather than assumed away.
                priceWad = raw * (10 ** uint256(uint32(p.expo))) * 1e18;
            } else {
                uint256 e = uint256(uint32(-p.expo));
                // e ≤ 18 scales up (the normal case: expo −8 becomes ×1e10); beyond 18 the
                // feed carries more precision than WAD holds, so scale down and lose the tail.
                priceWad = e <= 18 ? raw * (10 ** (18 - e)) : raw / (10 ** (e - 18));
            }
            // A sub-WAD-dust price is indistinguishable from "no price" to the aggregator,
            // which treats 0 as not-fresh; say so explicitly rather than voting 0 into a median.
            if (priceWad == 0) return (0, 0);
            return (priceWad, p.publishTime);
        } catch {
            return (0, 0);
        }
    }
}
