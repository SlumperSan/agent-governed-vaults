// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IOracleAggregator} from "../interfaces/IOracleAggregator.sol";
import {IAggregatorV3} from "../OracleAggregator.sol";

/// @notice The `description()` half of Chainlink's full `AggregatorV3Interface`, declared HERE
/// rather than added to the shared {IAggregatorV3}. {IAggregatorV3} is the minimal read surface the
/// hot path needs and is implemented by {ChainlinkSourceAdapter} and every test mock; widening it
/// would force `description()` on implementers that have no business answering it. Every genuine
/// Chainlink `EACAggregatorProxy` implements this (it forwards to the underlying aggregator).
interface IAggregatorV3Description {
    function description() external view returns (string memory);
}

/// @title ChainlinkOracle — single-feed-per-asset IOracleAggregator over Chainlink Data Feeds
/// @notice THE launch oracle. It REPLACES the bespoke per-vault median {OracleAggregator}, which
/// is retired to `contracts/test/retired/` and kept only as the C-4/C-6 exploit evidence — it is
/// not on the launch path and must not be deployed. This resolves audit finding C-6 by trusting
/// Chainlink's OWN decentralized OCR aggregation per asset, rather than curating a per-vault
/// source set and a quorum here. There is no median, no quorum, and no per-vault source list to
/// misconfigure: each asset maps to exactly one Chainlink AggregatorV3 feed, so there is no
/// "2-of-n" freshness regime for a vault creator to size wrong, or for an attacker to game by
/// selectively stalling sources (contrast {OracleAggregator}, whose integrity depended on a
/// correctly-sized source set and a strict-majority quorum — the surface C-6/H-1/M-1 live on).
///
/// Config is IMMUTABLE after construction, exactly like {OracleAggregator}: no admin can swap a
/// feed, retune a heartbeat, or repoint the sequencer feed. A vault creator who wants different
/// feeds deploys a different ChainlinkOracle; members see it at deposit time.
///
/// Fail-closed contract, mirrored from {OracleAggregator} verbatim: `priceWad` reverts
/// `StaleOracle(asset)` on ANY failure (unlisted asset, feed revert, non-positive answer, unset or
/// future timestamp, staleness past the heartbeat, a price outside the sane-price band, or the L2
/// sequencer being down / within its grace period). It NEVER returns 0 and NEVER returns a stale
/// price. Every NAV-reading path in a consuming vault therefore freezes on a bad read, INCLUDING
/// exits — the accepted K-4 / SF-2 posture.
///
/// TRADEOFF, stated honestly (accepted vs the custom aggregator, which C-6 proves could not be
/// secured): single-provider dependency (a feed deprecation/freeze fails the asset closed — safe,
/// but that asset's vault freezes with no fallback); assets WITHOUT a Chainlink feed on the chain
/// cannot be listed; and a feed only updates on its heartbeat OR a deviation-threshold move, so a
/// price up to ~the deviation band stale reads as "fresh" (a bounded, inherent-to-Chainlink NAV
/// arb — the vault-side defence is M-15's `minSharesOut`/`minValueOut`). The sane-price band below
/// is the defence against a feed reporting a DEPRECATED min/maxAnswer clamp value during a
/// depeg/flash-crash (Chainlink's on-aggregator circuit breakers no longer stop the proxy).
contract ChainlinkOracle is IOracleAggregator {
    /// @dev One Chainlink feed per asset. `feed` + `heartbeat` + `scale` pack into slot 0;
    /// `minPriceWad` + `maxPriceWad` pack into slot 1. `scale = 10**(18 - feedDecimals)`, cached at
    /// construction — a feed's `decimals()` is fixed and the config is immutable (see the decimals
    /// assumption in the constructor). `feed == address(0)` is the unlisted sentinel.
    struct FeedConfig {
        IAggregatorV3 feed; // 160
        uint32 heartbeat; // 32; the feed's own configured max silence (heartbeat, not deviation)
        uint64 scale; // 64; 10**(18 - feedDecimals). Currently always 1e10 — the constructor pins
        // feedDecimals to 8 (the USD-feed convention) as the denomination cross-check. The
        // general form is retained so relaxing that pin is a one-line change, and dropping the
        // field would repack the struct for no gain.
        uint128 minPriceWad; // sane-price band floor (WAD); 0 with maxPriceWad 0 => band disabled
        uint128 maxPriceWad; // sane-price band ceiling (WAD); 0 => band disabled for this asset
    }

    /// @notice The immutable per-asset feed configuration a prospective member inspects before
    /// depositing into a vault priced by this oracle.
    mapping(address => FeedConfig) public feedOf;

    /// @notice USDC-like token pinned to $1.00 (WAD), matching how {UniswapV3TwapSource} treats its
    /// quote leg. `address(0)` disables the pin. The pin is a decision, not a measurement: a
    /// sustained USDC depeg would be mispriced — the alternative (a USDC/USD feed) is available by
    /// listing USDC in the feed map instead of pinning it. The constructor forbids doing BOTH.
    address public immutable usdc;

    /// @notice Chainlink L2 Sequencer Uptime Feed, set per chain by the deployer (e.g. Base
    /// mainnet). `address(0)` => this deployment is not on a sequencer L2 (local / L1 / tests), so
    /// the uptime guard is skipped.
    IAggregatorV3 public immutable sequencerUptimeFeed;

    /// @dev Grace window after a sequencer restart, per Chainlink docs. Prices published in the
    /// first hour after recovery are not yet trustworthy (queued-during-outage txs still drain).
    uint256 public constant GRACE_PERIOD = 3600;

    error BadOracleConfig();

    /// @notice Fix the full per-asset feed configuration forever (parallel arrays, matching
    /// {OracleAggregator}'s style).
    /// @param assets_ the priceable assets (no zero address, no duplicates, and not `usdc_`)
    /// @param feeds_ per-asset Chainlink AggregatorV3 PROXY addresses. Each must be codeless-free,
    /// must describe itself as USD-quoted (`description()` ending in `/ USD` — see
    /// `_requireUsdQuote`), and must report exactly 8 decimals (the USD-feed convention).
    /// @param heartbeats_ per-asset staleness bound in seconds (the feed's own heartbeat; > 0)
    /// @param minPriceWad_ per-asset sane-price floor (WAD), or 0 to disable the band with max 0
    /// @param maxPriceWad_ per-asset sane-price ceiling (WAD), or 0 to disable the band
    /// @param usdc_ USDC-like token to pin at 1e18, or address(0) to disable the pin
    /// @param sequencerUptimeFeed_ L2 sequencer uptime feed, or address(0) off a sequencer L2.
    /// DELIBERATELY EXEMPT from the USD-quote and 8-decimals checks: it is a status feed, not a
    /// price feed (Base's reports 0 decimals and describes itself as an uptime status), so applying
    /// a price-feed denomination rule to it would reject every correct mainnet deployment.
    constructor(
        address[] memory assets_,
        address[] memory feeds_,
        uint32[] memory heartbeats_,
        uint256[] memory minPriceWad_,
        uint256[] memory maxPriceWad_,
        address usdc_,
        address sequencerUptimeFeed_
    ) {
        uint256 n = assets_.length;
        require(
            n > 0 && feeds_.length == n && heartbeats_.length == n && minPriceWad_.length == n
                && maxPriceWad_.length == n,
            BadOracleConfig()
        );
        for (uint256 i; i < n; ++i) {
            address asset = assets_[i];
            address feed = feeds_[i];
            require(asset != address(0) && feed != address(0), BadOracleConfig());
            require(asset != usdc_, BadOracleConfig()); // a pinned USDC must not ALSO carry a feed
            require(heartbeats_[i] > 0, BadOracleConfig());
            // A codeless feed (one deploy typo) returns empty data forever; reject it here, where it
            // is still fixable, rather than bricking the asset at the first read.
            require(feed.code.length > 0, BadOracleConfig());
            require(address(feedOf[asset].feed) == address(0), BadOracleConfig()); // no duplicate asset

            // Sane-price band: either disabled (both 0) or a well-ordered non-zero ceiling. The band
            // is the defence against a feed reporting a deprecated min/maxAnswer clamp as "fresh".
            uint256 lo = minPriceWad_[i];
            uint256 hi = maxPriceWad_[i];
            require(hi <= type(uint128).max && lo <= type(uint128).max, BadOracleConfig());
            require(hi == 0 ? lo == 0 : lo <= hi, BadOracleConfig());

            // DENOMINATION. Everything downstream (NAV, deposit, exit, rebalance) reads `priceWad`
            // as USD. Nothing used to check that the wired feed actually quotes in USD, and the
            // mistake is silent: Base HAS a `CBETH / ETH` feed but no cbETH/USD one, so a deployer
            // reaching for cbETH wires the ETH-denominated feed and every vault prices cbETH at
            // ~1.04 "dollars" forever. Prove the quote leg is USD from the feed's own
            // `description()`, once, at construction — where the mistake is still fixable.
            _requireUsdQuote(feed);

            // DECIMALS CROSS-CHECK, corroborating the denomination above. Chainlink's convention is
            // 8 decimals for USD feeds and 18 for ETH-denominated ones, so a feed that claims a USD
            // quote while reporting anything but 8 is not the feed the deployer thinks it is (a
            // spoofed `description()`, or a genuine feed whose aggregator was upgraded out from
            // under the cached `scale`). Fail closed: a false REJECT halts a deploy loudly and is
            // fixable, a false ACCEPT is permanent silent mispricing.
            // Cost, stated: a legitimate 18-decimal USD feed (Chainlink has a handful, e.g.
            // AMPL/USD on L1 — none on Base, none in the launch basket) cannot be listed without a
            // contract change and a re-audit. Accepted.
            uint8 d = IAggregatorV3(feed).decimals(); // also proves the feed answers AggregatorV3
            require(d == 8, BadOracleConfig());
            // Prove the feed decodes latestRoundData at construction, where a mistake is fixable.
            // The per-call raw-staticcall decode guard {OracleAggregator} needs (C-3) is not
            // repeated: config is immutable and every feed is proven to speak the ABI here, so no
            // listed feed can later revert-with-empty on a well-formed proxy. A feed swapped for a
            // malformed contract is impossible under immutable config; a genuine revert at read time
            // is caught by try/catch in `priceWad`. (A short/malformed return that fails ABI-decode
            // of the try-returns tuple could still surface as a Panic rather than StaleOracle — the
            // real mitigation is this construction-time proof plus immutability, not the catch.)
            // decimals() ASSUMPTION: Chainlink upgrades the underlying aggregator behind the proxy
            // over time but holds `decimals()` constant by convention; `scale` is cached on that
            // assumption. A decimals change on an upgrade would silently mis-scale — an accepted,
            // documented, convention-backed risk (reading decimals() live each call would close it
            // at a gas cost on every NAV read).
            IAggregatorV3(feed).latestRoundData();

            feedOf[asset] = FeedConfig({
                feed: IAggregatorV3(feed),
                heartbeat: heartbeats_[i],
                scale: uint64(10 ** (18 - d)),
                minPriceWad: uint128(lo),
                maxPriceWad: uint128(hi)
            });
        }

        if (sequencerUptimeFeed_ != address(0)) {
            require(sequencerUptimeFeed_.code.length > 0, BadOracleConfig());
            IAggregatorV3(sequencerUptimeFeed_).latestRoundData(); // decode-proof, like the asset feeds
        }
        sequencerUptimeFeed = IAggregatorV3(sequencerUptimeFeed_);
        usdc = usdc_;
    }

    /// @dev Reverts `BadOracleConfig` unless `feed` describes itself as quoting in USD.
    ///
    /// Chainlink names a Data Feed after its pair, quote leg last: "ETH / USD", "BTC / USD",
    /// "LINK / USD" — versus "CBETH / ETH" for the exchange-rate feeds. The predicate is therefore
    /// "the description ends in USD, as a whole word": the last three bytes are `USD` and the byte
    /// before them is a pair separator (`' '` or `'/'`, covering both the spaced and unspaced
    /// spellings Chainlink has used). The separator requirement is what stops a hypothetical
    /// `"ETH / PYUSD"` — an ETH price quoted in a USD-ISH TOKEN, not in USD — from passing on a
    /// bare suffix match.
    ///
    /// WHY THIS IS SAFE TO DEPEND ON ON-CHAIN, given `description()` returns a string:
    ///  - it runs ONCE, in the constructor, so it is initcode-only and costs the hot path nothing —
    ///    `priceWad` is byte-for-byte unchanged;
    ///  - config is immutable, so there is no later drift to re-check. Chainlink editing a
    ///    description string on a future aggregator upgrade cannot retroactively fail an already
    ///    deployed oracle (a per-read check WOULD have that failure mode);
    ///  - a false REJECT surfaces as a failed deployment, before any funds exist.
    ///
    /// WHAT IT IS NOT: this is a MISCONFIGURATION guard, not an authenticity guard. A hostile fake
    /// `AggregatorV3` can return "ETH / USD" and 8 decimals while pricing whatever it likes — that
    /// is C-6's territory, answered by {VaultFactory}'s blessed-oracle allowlist. This check closes
    /// the honest-deployer hole the allowlist cannot see: an oracle blessed on the assumption that
    /// its feeds are USD feeds, when one of them is not.
    function _requireUsdQuote(address feed) private view {
        (bool ok, bytes memory ret) =
            feed.staticcall(abi.encodeWithSelector(IAggregatorV3Description.description.selector));
        // A genuine proxy returns (offset, length, data) — at least three words. Anything shorter is
        // a contract that does not implement `description()`; reject rather than guess.
        require(ok && ret.length >= 96, BadOracleConfig());
        bytes memory desc = bytes(abi.decode(ret, (string)));
        uint256 n = desc.length;
        require(n >= 4, BadOracleConfig()); // "X/USD" is the shortest real shape; n-4 must be in range
        require(desc[n - 3] == "U" && desc[n - 2] == "S" && desc[n - 1] == "D", BadOracleConfig());
        require(desc[n - 4] == " " || desc[n - 4] == "/", BadOracleConfig());
    }

    /// @inheritdoc IOracleAggregator
    /// @dev Order matters: the sequencer gate runs BEFORE any price is trusted, then the USDC pin,
    /// then the feed read. Every failure surfaces as StaleOracle(asset) and nothing else.
    function priceWad(address asset) external view returns (uint256) {
        _requireSequencerUp(asset); // L2 gate first (no-op off a sequencer chain)

        if (usdc != address(0) && asset == usdc) return 1e18; // pinned quote leg

        FeedConfig memory cfg = feedOf[asset];
        if (address(cfg.feed) == address(0)) revert StaleOracle(asset); // unlisted: breaker, not zero

        try cfg.feed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0) revert StaleOracle(asset); // non-positive is invalid; reject before the cast
            if (updatedAt == 0) revert StaleOracle(asset); // unset / incomplete round
            if (updatedAt > block.timestamp) revert StaleOracle(asset); // future stamp: never "fresh"
            // Saturating lower bound (mirrors OracleAggregator.sol) so a heartbeat larger than the
            // clock in tests cannot underflow-panic — the panic would escape as non-StaleOracle.
            uint256 minUpdated = block.timestamp > cfg.heartbeat ? block.timestamp - cfg.heartbeat : 0;
            if (updatedAt < minUpdated) revert StaleOracle(asset); // stale past the heartbeat

            uint256 priceWad_ = uint256(answer) * cfg.scale; // normalize feed decimals to WAD
            // Sane-price band (when enabled): a feed reporting a deprecated clamp value during a
            // depeg/flash-crash reads as "fresh" but out-of-band — fail closed rather than price it.
            if (cfg.maxPriceWad != 0 && (priceWad_ < cfg.minPriceWad || priceWad_ > cfg.maxPriceWad)) {
                revert StaleOracle(asset);
            }
            return priceWad_;
        } catch {
            revert StaleOracle(asset); // a reverting / deprecated feed must fail closed, never fall through
        }
    }

    /// @dev Reverts (as StaleOracle) unless the L2 sequencer is up AND has been up longer than the
    /// grace period. No-op when no uptime feed is configured. Runs before any price read so a
    /// downed-or-just-restarted sequencer short-circuits before a price computed during the outage
    /// is ever consumed.
    function _requireSequencerUp(address asset) internal view {
        IAggregatorV3 seq = sequencerUptimeFeed;
        if (address(seq) == address(0)) return; // non-sequencer chain

        // The uptime feed's own `updatedAt` (4th field) is intentionally NOT staleness-checked: it
        // is event-driven (it only writes on an up<->down transition), so a long-unchanged
        // `updatedAt` is its healthy steady state, not staleness — checking it would freeze pricing
        // during normal uptime. `answer` + `startedAt` are the authoritative signals. (Audit Council
        // note: accepted residual — a genuinely frozen uptime feed reads "up", the same posture
        // standard Chainlink L2 consumers take.)
        try seq.latestRoundData() returns (uint80, int256 answer, uint256 startedAt, uint256, uint80) {
            // answer == 0 => up, 1 => down.
            if (answer != 0) revert StaleOracle(asset);
            // startedAt == 0 => uptime round not yet started (init edge); treat as down.
            if (startedAt == 0 || startedAt > block.timestamp) revert StaleOracle(asset);
            // Grace window must have FULLY elapsed since restart.
            if (block.timestamp - startedAt <= GRACE_PERIOD) revert StaleOracle(asset);
        } catch {
            revert StaleOracle(asset);
        }
    }
}
