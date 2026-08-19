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

    error BadOracleConfig();

    constructor(
        address[] memory assets_,
        address[][] memory sources_,
        uint32[] memory maxStaleness_,
        uint8[] memory quorum_
    ) {
        uint256 n = assets_.length;
        require(n > 0 && sources_.length == n && maxStaleness_.length == n && quorum_.length == n, BadOracleConfig());
        for (uint256 i; i < n; ++i) {
            uint256 m = sources_[i].length;
            // Finding 6: enforce the §11/SF-1 floor — >= 3 sources and a STRICT MAJORITY
            // freshness quorum, so no single source can freeze or move an asset.
            require(m >= MIN_SOURCES && m <= 15, BadOracleConfig());
            require(quorum_[i] > m / 2 && quorum_[i] <= m, BadOracleConfig());
            // Finding 2: bound staleness both sides — nonzero and below the ceiling.
            require(maxStaleness_[i] > 0 && maxStaleness_[i] <= MAX_STALENESS_CEILING, BadOracleConfig());
            require(_cfg[assets_[i]].sources.length == 0, BadOracleConfig()); // no duplicates
            _cfg[assets_[i]] = AssetConfig({sources: sources_[i], maxStaleness: maxStaleness_[i], quorum: quorum_[i]});
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
            // A reverting source is simply not fresh — one broken feed must not trip the
            // breaker while quorum still holds elsewhere.
            try IPriceSource(cfg.sources[i]).latestPrice() returns (uint256 p, uint256 updatedAt) {
                if (p > 0 && updatedAt >= minUpdated) fresh[k++] = p;
            } catch {}
        }
        if (k < cfg.quorum) revert StaleOracle(asset);

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
        // quorum guarantees the middle element is bounded by the honest set.
        return fresh[(k - 1) / 2];
    }

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

    constructor(IAggregatorV3 feed_) {
        feed = feed_;
        uint8 d = feed_.decimals();
        require(d <= 18, BadFeed());
        scale = 10 ** (18 - d);
    }

    function latestPrice() external view returns (uint256, uint256) {
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0) return (0, 0); // aggregator treats as not-fresh
        return (uint256(answer) * scale, updatedAt);
    }
}
