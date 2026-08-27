// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IOracleAggregator} from "./interfaces/IOracleAggregator.sol";

/// @notice One independent price source (Chainlink-style push, TWAP, pull-oracle wrapper…).
/// Source *mechanism diversity* is the SF-1 listing criterion — correlated upstreams are not
/// independent sources.
interface IPriceSource {
    /// @return priceWad USD price of one whole token, WAD-scaled
    /// @return updatedAt unix timestamp of the last update
    function latestPrice() external view returns (uint256 priceWad, uint256 updatedAt);
}

/// @title OracleAggregator — multi-source median with staleness circuit breaker
/// @notice Sprint 4 module (SF-1/SF-2). Config is IMMUTABLE after construction: no admin can
/// swap sources, retune staleness, or lower the quorum. A vault creator who wants different
/// sources deploys a different aggregator; members see it at deposit time.
///
/// Breaker semantics (K-4, accepted by design): if fewer than `quorum` sources are fresh for
/// an asset, `priceWad` reverts `StaleOracle` — freezing every NAV-reading path in consuming
/// vaults, INCLUDING exits. No escape hatch exists on purpose: any exit during staleness is
/// exactly the stale-price exit the breaker prevents.
contract OracleAggregator is IOracleAggregator {
    struct AssetConfig {
        address[] sources;
        uint32 maxStaleness; // seconds
        uint8 quorum; // minimum fresh sources
    }

    mapping(address => AssetConfig) internal _cfg;
    address[] public assets;

    /// @dev Upper bound on per-asset staleness. Prevents the finding-2 underflow honeypot
    /// (block.timestamp - maxStaleness) AND bounds the finding-7 latency-arb drift window. A
    /// multi-year staleness bound is never legitimate for a spot index.
    uint32 public constant MAX_STALENESS_CEILING = 1 days;
    uint8 public constant MIN_SOURCES = 3; // §11 / SF-1: median of >= 3 independent sources

    /// @dev H-1: the lower median `fresh[(k-1)/2]` is `fresh[0]` — the MINIMUM — at k == 2.
    /// The old constructor permitted quorum 2 of 3, so the documented mainnet configuration
    /// selected min() rather than a median whenever one source failed, biased one-directionally
    /// DOWNWARD, which is the exploitable direction for share issuance (C-4). Below three fresh
    /// sources there is no median to take, so the breaker trips instead.
    uint8 public constant MIN_MEDIAN = 3;

    error BadOracleConfig();

    /// @notice Fix the full per-asset source configuration forever. Floors are load-bearing
    /// (the creator is untrusted): ≥3 sources, strict-majority freshness quorum, staleness
    /// bounded to (0, 1 day].
    /// @param assets_ the priceable assets (no duplicates)
    /// @param sources_ per-asset IPriceSource sets (3–15 each; mechanism diversity per SF-1)
    /// @param maxStaleness_ per-asset freshness bound in seconds, ≤ MAX_STALENESS_CEILING
    /// @param quorum_ per-asset minimum fresh sources, strict majority of the set
    constructor(
        address[] memory assets_,
        address[][] memory sources_,
        uint32[] memory maxStaleness_,
        uint8[] memory quorum_
    ) {
        uint256 n = assets_.length;
        require(
            n > 0 && sources_.length == n && maxStaleness_.length == n && quorum_.length == n,
            BadOracleConfig()
        );
        for (uint256 i; i < n; ++i) {
            uint256 m = sources_[i].length;
            // Finding 6: enforce the §11/SF-1 floor — >= 3 sources and a STRICT MAJORITY
            // freshness quorum, so no single source can freeze or move an asset.
            require(m >= MIN_SOURCES && m <= 15, BadOracleConfig());
            // H-1: quorum must also reach MIN_MEDIAN, so a config can never select min().
            // NOTE the deliberate consequence: at m == 3 this forces quorum == 3, i.e. any one
            // source failing trips the breaker. Fault tolerance and median integrity cannot both
            // be had at m == 3 — the resolution is m >= 5, not a lower quorum.
            require(quorum_[i] >= MIN_MEDIAN && quorum_[i] > m / 2 && quorum_[i] <= m, BadOracleConfig());
            // Finding 2: bound staleness both sides — nonzero and below the ceiling.
            require(maxStaleness_[i] > 0 && maxStaleness_[i] <= MAX_STALENESS_CEILING, BadOracleConfig());
            require(_cfg[assets_[i]].sources.length == 0, BadOracleConfig()); // no duplicate assets
            for (uint256 a; a < m; ++a) {
                // C-3(a): a codeless source address (one deploy typo) returns empty data
                // forever. Rejected here, where it is still fixable, rather than bricking the
                // asset permanently at the first read.
                require(sources_[i][a].code.length > 0, BadOracleConfig());
                // M-1: [S,S,S] satisfied "3 sources" and any quorum, and its median is just S.
                // Correlated upstreams behind distinct addresses stay out of code's reach (the
                // accepted SF-1 residual); literal address equality does not.
                for (uint256 b = a + 1; b < m; ++b) {
                    require(sources_[i][a] != sources_[i][b], BadOracleConfig());
                }
            }
            _cfg[assets_[i]] =
                AssetConfig({sources: sources_[i], maxStaleness: maxStaleness_[i], quorum: quorum_[i]});
            assets.push(assets_[i]);
        }
    }

    /// @inheritdoc IOracleAggregator
    function priceWad(address asset) external view returns (uint256) {
        AssetConfig storage cfg = _cfg[asset];
        uint256 m = cfg.sources.length;
        if (m == 0) revert StaleOracle(asset); // unlisted asset: breaker, not zero

        uint256[] memory fresh = new uint256[](m);
        uint256 k;
        // Saturating: never underflow-panic even if maxStaleness somehow exceeded the clock.
        uint256 minUpdated = block.timestamp > cfg.maxStaleness ? block.timestamp - cfg.maxStaleness : 0;
        for (uint256 i; i < m; ++i) {
            // A broken source is simply not fresh — one broken feed must not trip the breaker
            // while quorum still holds elsewhere. C-3: this now holds for MALFORMED RETURNS too,
            // not only for genuine reverts. See _tryLatestPrice.
            (bool ok, uint256 p, uint256 updatedAt) = _tryLatestPrice(cfg.sources[i]);
            if (ok && p > 0 && updatedAt >= minUpdated) fresh[k++] = p;
        }
        // H-1: quorum alone is not enough — the median itself needs three elements. Both bounds
        // are checked because deployed aggregators may carry a pre-H-1 quorum of 2.
        if (k < cfg.quorum || k < MIN_MEDIAN) revert StaleOracle(asset);

        // Median of the fresh set (insertion sort; m ≤ 15).
        for (uint256 i = 1; i < k; ++i) {
            uint256 key = fresh[i];
            uint256 j = i;
            while (j > 0 && fresh[j - 1] > key) {
                fresh[j] = fresh[j - 1];
                --j;
            }
            fresh[j] = key;
        }
        // Lower median: no averaging (no even-k swing, no sum overflow-freeze). Majority-fresh
        // quorum AND k >= 3 together guarantee the middle element is bounded by the honest set.
        return fresh[(k - 1) / 2];
    }

    /// @dev C-3 remediation. `try/catch` CANNOT absorb a decode failure: Solidity decodes the
    /// returned buffer in the CALLER's frame, after the callee has already returned
    /// successfully. So a source returning 32 bytes, zero bytes, or having no code at all made
    /// `priceWad` revert unconditionally — regardless of quorum, with empty returndata rather
    /// than `StaleOracle`, for every vault wired to this aggregator, permanently. A genuine
    /// `revert` was absorbed correctly, which is exactly why the gap survived review.
    ///
    /// A raw staticcall with an explicit length check absorbs both cases. The returndata copy is
    /// bounded to the two words actually needed, so a returndata-bombing source cannot OOG the
    /// reader either — that would be the same defect class one layer out.
    /// @param src the price source to poll
    /// @return ok true only if the call succeeded AND returned at least two well-formed words
    /// @return p the reported WAD price (meaningless unless ok)
    /// @return updatedAt the reported update timestamp (meaningless unless ok)
    function _tryLatestPrice(address src) internal view returns (bool ok, uint256 p, uint256 updatedAt) {
        bytes4 sel = IPriceSource.latestPrice.selector;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, sel)
            let success := staticcall(gas(), src, ptr, 4, 0, 0)
            if and(success, iszero(lt(returndatasize(), 64))) {
                returndatacopy(ptr, 0, 64)
                p := mload(ptr)
                updatedAt := mload(add(ptr, 32))
                ok := 1
            }
        }
    }

    /// @notice The immutable source configuration for `asset` — what a prospective member
    /// inspects before depositing into a vault priced by this aggregator.
    /// @param asset the asset queried
    /// @return sources the source set
    /// @return maxStaleness per-source freshness bound, seconds
    /// @return quorum minimum fresh sources before the breaker trips
    function assetConfig(address asset)
        external
        view
        returns (address[] memory sources, uint32 maxStaleness, uint8 quorum)
    {
        AssetConfig storage cfg = _cfg[asset];
        return (cfg.sources, cfg.maxStaleness, cfg.quorum);
    }
}

/// @notice Chainlink-style AggregatorV3 wrapper normalizing to WAD. One mechanism class among
/// several — pair with TWAP / pull-oracle sources for real independence (SF-1).
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

contract ChainlinkSourceAdapter is IPriceSource {
    IAggregatorV3 public immutable feed;
    uint256 public immutable scale; // 10**(18 - feedDecimals)

    error BadFeed();

    /// @param feed_ the AggregatorV3 feed to wrap (decimals ≤ 18)
    constructor(IAggregatorV3 feed_) {
        feed = feed_;
        uint8 d = feed_.decimals();
        require(d <= 18, BadFeed());
        scale = 10 ** (18 - d);
    }

    /// @notice WAD-normalized feed price. Non-positive answers surface as (0, 0), which the
    /// aggregator treats as not-fresh rather than a revert.
    /// @return priceWad USD price of one whole token, WAD (0 if the feed answer is invalid)
    /// @return updatedAt the feed's last-update timestamp (0 if invalid)
    function latestPrice() external view returns (uint256, uint256) {
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0) return (0, 0); // aggregator treats as not-fresh
        return (uint256(answer) * scale, updatedAt);
    }
}
