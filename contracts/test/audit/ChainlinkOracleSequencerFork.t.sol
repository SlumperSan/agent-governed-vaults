// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {ChainlinkOracle} from "../../src/oracle/ChainlinkOracle.sol";
import {IOracleAggregator} from "../../src/interfaces/IOracleAggregator.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";

/// @dev The two AggregatorV3 methods this file needs that {IAggregatorV3} (deliberately minimal)
/// does not carry. `getRoundData` is what lets the history test below prove — against the REAL
/// Base feed, not a mock — what `startedAt` actually means.
interface IAggregatorV3Extra {
    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80 roundId_, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function description() external view returns (string memory);
}

/// @notice FORK TEST — the L2 sequencer-uptime guard in {ChainlinkOracle} against the REAL Chainlink
/// Base mainnet L2 Sequencer Uptime Feed (`0xBCF85224fc0756B9Fa45aA7892530B47e10b6433`).
///
/// WHY THIS FILE EXISTS. Every other test of `_requireSequencerUp` runs against `MockAggregatorV3`,
/// which is a mock the repo wrote to the semantics the repo BELIEVES. Base Sepolia deliberately
/// leaves `sequencerUptimeFeed` at `address(0)` (documented asymmetry), and no BASE mainnet
/// deployment exists — so before this file, the FIRST execution of that guard against a genuine
/// Chainlink uptime feed would have been on Base mainnet with live member capital. The Robinhood
/// Chain mainnet deployment of 2026-09-05 does not change that: Chainlink publishes no
/// uptime feed for chain 4663, so `sequencerUptimeFeed` is `address(0)` there too and the guard is
/// skipped. A polarity or `startedAt` mistake there is a permanent, immutable brick (config is
/// immutable by design). This file moves that first execution into CI.
///
/// The three Chainlink semantics that are easy to get backwards, and what is asserted about each:
///   1. POLARITY IS INVERTED. `answer == 0` means the sequencer is UP; `answer == 1` means DOWN.
///      Asserted against the live feed's raw ABI-decoded tuple, not a mock.
///   2. `startedAt` IS THE TRANSITION TIMESTAMP, not the round-write timestamp. The history test
///      proves this from real rounds: `updatedAt` can run MONTHS past `startedAt` on a single
///      round, so `updatedAt` would be the wrong grace anchor (and is equally useless as a
///      staleness signal, which is why the guard deliberately does not check it).
///   3. `startedAt == 0` (the feed's first round after deployment) must NOT be arithmetic'd. The
///      canonical Chainlink doc snippet computes `block.timestamp - startedAt` with no zero guard,
///      which yields a colossal `timeSinceUp` and FALSELY REPORTS THE GRACE PERIOD AS ELAPSED.
///      {ChainlinkOracle} rejects it instead; asserted below.
///
/// SKIPPING. There are no `rpc_endpoints` in foundry.toml and this repo had no fork tests before
/// this one, so the pattern is established here: read the RPC URL from the environment in `setUp`,
/// and `vm.skip(true)` every test when it is absent. CI has no Base RPC and must stay green; the
/// fork is never created on that path. Run it with either variable set:
///
///     BASE_MAINNET_RPC_URL=https://mainnet.base.org forge test --mc ChainlinkOracleSequencerFork -vv
///
/// The `testFork_` prefix is load-bearing: fork-at-latest gas is not reproducible, so these tests
/// are excluded from the `forge snapshot --check` gate in ci.yml exactly as `testFuzz` is.
contract ChainlinkOracleSequencerForkTest is Test {
    /// @dev Mirrors `ChainlinkOracle.GRACE_PERIOD`; re-asserted against the constant in `setUp`.
    uint256 constant GRACE = 3600;

    /// @dev Base mainnet. Asserted after forking so a misconfigured RPC fails loudly rather than
    /// silently testing some other chain's contracts.
    uint256 constant BASE_CHAIN_ID = 8453;

    /// @dev Upper bound on the config-asset index walk in `setUp` (the config lists 2 today).
    uint256 constant MAX_CONFIG_ASSETS = 32;

    bool internal forked;
    string internal configJson;

    address internal seqFeed;
    address internal usdc;
    address[] internal assets;
    address[] internal feeds;
    uint32[] internal heartbeats;
    uint256[] internal minBand;
    uint256[] internal maxBand;

    function setUp() public {
        string memory rpc = _rpcUrl();
        if (bytes(rpc).length == 0) return; // every test vm.skip()s; the fork is never created

        vm.createSelectFork(rpc);
        assertEq(block.chainid, BASE_CHAIN_ID, "fork is not Base mainnet");
        forked = true;

        // Read the SHIPPING config, not hardcoded copies: a fork test that hardcodes its addresses
        // proves nothing about the file the deploy script will actually consume.
        configJson = vm.readFile("config/base-mainnet.json");
        seqFeed = vm.parseJsonAddress(configJson, ".chainlinkOracle.sequencerUptimeFeed");
        usdc = vm.parseJsonAddress(configJson, ".usdc");
        // Indexed rather than `assets[*].asset`: foundry's JSONPath has no wildcard ("must return
        // exactly one JSON value"). Walk indices until one is absent, so adding a third asset to the
        // config brings it under this test automatically. `MAX_CONFIG_ASSETS` only bounds the loop.
        for (uint256 i; i < MAX_CONFIG_ASSETS; ++i) {
            string memory at = string.concat(".chainlinkOracle.assets[", vm.toString(i), "]");
            if (!vm.keyExistsJson(configJson, string.concat(at, ".asset"))) break;
            assets.push(vm.parseJsonAddress(configJson, string.concat(at, ".asset")));
            feeds.push(vm.parseJsonAddress(configJson, string.concat(at, ".feed")));
            heartbeats.push(uint32(vm.parseJsonUint(configJson, string.concat(at, ".heartbeatSeconds"))));
            // The band values are JSON STRINGS (they exceed JS number precision), hence parseUint.
            minBand.push(vm.parseUint(vm.parseJsonString(configJson, string.concat(at, ".minPriceWad"))));
            maxBand.push(vm.parseUint(vm.parseJsonString(configJson, string.concat(at, ".maxPriceWad"))));
        }
        assertGt(assets.length, 0, "config: chainlinkOracle.assets is empty or unreadable");
    }

    // --- helpers -----------------------------------------------------------

    /// @dev `BASE_MAINNET_RPC_URL` first, then `BASE_RPC_URL` (the name forge-std's StdChains uses).
    /// Empty => skip. Never falls back to a hardcoded public endpoint: a test that silently reaches
    /// the network on a machine that did not ask for it is a different kind of CI flake.
    function _rpcUrl() internal view returns (string memory) {
        string memory u = vm.envOr("BASE_MAINNET_RPC_URL", string(""));
        if (bytes(u).length == 0) u = vm.envOr("BASE_RPC_URL", string(""));
        return u;
    }

    /// @dev Every test's first line. Returns true when the body should run.
    function _live() internal returns (bool) {
        if (!forked) {
            vm.skip(true, "no Base mainnet RPC: set BASE_MAINNET_RPC_URL (or BASE_RPC_URL)");
            return false;
        }
        return true;
    }

    /// @dev The oracle the mainnet deploy script would produce, built inside the fork against the
    /// REAL feeds and the REAL uptime feed. Note the ordering constraint this creates for every
    /// mocked test below: `ChainlinkOracle`'s constructor calls `latestRoundData()` on the uptime
    /// feed as a decode-proof, so the oracle MUST be deployed BEFORE any `vm.mockCall` — mocking
    /// first would exercise the constructor path instead of the runtime guard.
    function _deployRealOracle() internal returns (ChainlinkOracle) {
        return new ChainlinkOracle(assets, feeds, heartbeats, minBand, maxBand, usdc, seqFeed);
    }

    /// @dev Raw `staticcall` + manual `abi.decode` of the live uptime feed — the point of the
    /// exercise is to read the wire format ourselves rather than trust the typed interface to have
    /// the field order right.
    function _readUptimeFeedRaw()
        internal
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        (bool ok, bytes memory ret) =
            seqFeed.staticcall(abi.encodeWithSelector(IAggregatorV3.latestRoundData.selector));
        require(ok && ret.length == 160, "uptime feed did not answer AggregatorV3");
        return abi.decode(ret, (uint80, int256, uint256, uint256, uint80));
    }

    /// @dev The verdict computed here from Chainlink's DOCUMENTED semantics, independently of the
    /// contract. The contract's behaviour is then asserted to agree with it.
    function _independentVerdictSequencerUsable() internal view returns (bool) {
        (, int256 answer, uint256 startedAt,,) = _readUptimeFeedRaw();
        if (answer != 0) return false; // 1 == DOWN (inverted vs intuition)
        if (startedAt == 0 || startedAt > block.timestamp) return false;
        return block.timestamp - startedAt > GRACE; // grace must have FULLY elapsed
    }

    /// @dev Overwrite only the uptime feed's runtime answer; every other contract in the fork stays
    /// real (the ETH/USD and BTC/USD feeds keep answering with live data).
    function _mockUptime(int256 answer, uint256 startedAt) internal {
        vm.mockCall(
            seqFeed,
            abi.encodeWithSelector(IAggregatorV3.latestRoundData.selector),
            abi.encode(uint80(1), answer, startedAt, block.timestamp, uint80(1))
        );
    }

    function _expectStale(ChainlinkOracle oracle, address asset) internal {
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, asset));
        oracle.priceWad(asset);
    }

    // --- 1. the real feed, decoded by hand ---------------------------------

    /// @notice Reads the live Base uptime feed with a raw staticcall, decodes the tuple manually,
    /// and asserts {ChainlinkOracle}'s interpretation of those exact bytes matches an independent
    /// reading of Chainlink's documented semantics. This is the assertion that would have caught an
    /// inverted polarity or a shifted field order before mainnet.
    function testFork_realUptimeFeed_rawDecodeMatchesTheGuardsInterpretation() public {
        if (!_live()) return;

        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) =
            _readUptimeFeedRaw();
        console2.log("uptime feed          ", seqFeed);
        console2.log("  description        ", IAggregatorV3Extra(seqFeed).description());
        console2.log("  decimals           ", uint256(IAggregatorV3(seqFeed).decimals()));
        console2.log("  roundId            ", uint256(roundId));
        console2.log("  answer (0=up,1=dn) ", answer);
        console2.log("  startedAt          ", startedAt);
        console2.log("  updatedAt          ", updatedAt);
        console2.log("  answeredInRound    ", uint256(answeredInRound));
        console2.log("  block.timestamp    ", block.timestamp);

        // Shape: an uptime STATUS feed is a 0-decimal boolean feed. A non-zero `decimals()` would
        // mean this address is a PRICE feed and the whole guard is pointed at the wrong contract.
        assertEq(
            uint256(IAggregatorV3(seqFeed).decimals()),
            uint256(0),
            "uptime feed must be 0-decimal (status, not price)"
        );
        assertGt(seqFeed.code.length, 0, "uptime feed has no code on Base mainnet");

        // Polarity: the answer is a BOOLEAN in {0,1}. Anything else and the `answer != 0` test in
        // `_requireSequencerUp` is reading a value it was not designed for.
        assertTrue(answer == 0 || answer == 1, "uptime answer outside {0,1}: polarity assumption broken");

        // A live feed has a real transition timestamp, never 0 and never in the future.
        assertGt(startedAt, 0, "live uptime feed reports startedAt == 0");
        assertLe(startedAt, block.timestamp, "uptime startedAt is in the future");
        assertGe(updatedAt, startedAt, "updatedAt precedes startedAt");
        assertEq(uint256(answeredInRound), uint256(roundId), "uptime round not fully answered");

        // The whole point: the contract's verdict on THESE bytes must equal the independent one.
        ChainlinkOracle oracle = _deployRealOracle();
        bool expectUsable = _independentVerdictSequencerUsable();
        if (expectUsable) {
            uint256 p = oracle.priceWad(assets[0]);
            assertGt(p, 0, "sequencer reads usable but the guard blocked pricing");
            console2.log("  guard verdict      : UP + past grace, priceWad =", p);
        } else {
            _expectStale(oracle, assets[0]);
            console2.log("  guard verdict      : NOT usable (down or inside grace) - priceWad reverts");
        }
    }

    // --- 2. what `startedAt` actually means, proved from real history ------

    /// @notice Proves from REAL historical rounds that `startedAt` is the timestamp the CURRENT
    /// STATUS BEGAN — the semantics the grace window depends on — and specifically that `updatedAt`
    /// is NOT a usable substitute for it.
    ///
    /// This is the load-bearing test in the file, because the grace window is the one part of the
    /// guard whose correctness is a claim about what a Chainlink FIELD MEANS rather than about
    /// arithmetic, and no mock can settle that claim.
    ///
    /// The observation that settles it: on Base mainnet a single uptime round carries an `updatedAt`
    /// MONTHS past its own `startedAt` (round 20 as of writing: startedAt 1782491507, updatedAt
    /// 1788022723 — a ~64-day gap; round 14: a ~296-day gap). The round is rewritten without the
    /// status changing, so `updatedAt` moves and `startedAt` stays pinned to the recovery instant.
    /// Two consequences, and the guard depends on both:
    ///   - `updatedAt` would be the WRONG grace anchor — every rewrite would re-open a fresh one-hour
    ///     freeze months after any real outage. {ChainlinkOracle} anchors on `startedAt`.
    ///   - `updatedAt` is equally useless as a STALENESS signal here, which is exactly why
    ///     `_requireSequencerUp` deliberately does not staleness-check it.
    ///
    /// Asserted rather than assumed: per-round `updatedAt >= startedAt`; strictly decreasing
    /// `startedAt` walking backwards; a newer round's `startedAt` at or after the older round's last
    /// write (so a round's status really does begin after the previous round was finished with); and
    /// that the two fields genuinely diverge on at least one round. Status ALTERNATION across rounds
    /// is observed and logged but not asserted — it held for every round walked while writing this
    /// (rounds 14..20 read 0,1,0,1,0,1,0), yet nothing in Chainlink's contract forbids a repeated
    /// status, and the semantic claim above does not need it.
    function testFork_realUptimeFeed_startedAtIsTheStatusTransitionTimestamp() public {
        if (!_live()) return;

        (uint80 latestRound, int256 latestAnswer, uint256 latestStartedAt, uint256 latestUpdatedAt,) =
            _readUptimeFeedRaw();

        console2.log("latest round                ", uint256(latestRound));
        console2.log("  answer                    ", latestAnswer);
        console2.log("  startedAt                 ", latestStartedAt);
        console2.log("  updatedAt                 ", latestUpdatedAt);
        console2.log("  updatedAt - startedAt (s) ", latestUpdatedAt - latestStartedAt);

        Walk memory w;
        w.prevAnswer = latestAnswer;
        w.prevStartedAt = latestStartedAt;
        w.diverged = latestUpdatedAt > latestStartedAt ? 1 : 0;
        w.sawDown = latestAnswer == 1;
        w.sawUp = latestAnswer == 0;

        // Walk back through the current aggregator phase. Round ids are phase-encoded
        // (phaseId << 64 | aggregatorRoundId), so decrementing stays inside the phase until it
        // underflows past round 1 — `try` absorbs that and any archive-depth limit on the RPC.
        for (uint256 i = 1; i <= 6; ++i) {
            if (uint256(latestRound) < i) break;
            if (!_walkOneRound(w, uint80(uint256(latestRound) - i))) break;
        }

        console2.log("  rounds walked             ", w.roundsWalked);
        console2.log("  status flips seen         ", w.statusFlips);

        // The two fields are not aliases of one another, so which one the grace window anchors on is
        // a real decision and not a stylistic one. If this ever fails, the reasoning in
        // `_requireSequencerUp` (both the grace anchor AND the deliberate non-staleness-check of
        // `updatedAt`) needs revisiting against whatever the feed now does.
        assertGt(w.diverged, 0, "startedAt and updatedAt never diverged: re-derive the guard");

        // The grace period is not theoretical: Base's sequencer really has gone down and recovered,
        // which is the event this guard exists to survive. (Only asserted once we actually walked
        // history — a shallow / non-archive RPC is not a test failure.)
        if (w.roundsWalked >= 2) {
            assertGt(w.statusFlips, 0, "no status transition in the walked history");
            assertTrue(w.sawDown, "no DOWN round observed in the walked history");
            assertTrue(w.sawUp, "no UP round observed in the walked history");
        }
    }

    /// @dev Loop state for the history walk, held in memory so the loop body stays inside the
    /// stack budget under `via_ir`.
    struct Walk {
        int256 prevAnswer;
        uint256 prevStartedAt;
        uint256 roundsWalked;
        uint256 statusFlips;
        uint256 diverged;
        bool sawDown;
        bool sawUp;
    }

    /// @dev Read one older round, assert the per-round and cross-round invariants against the round
    /// already in `w`, and fold it in. Returns false when the walk should stop (round unset, or the
    /// RPC has no archive depth for it) — neither is a test failure.
    function _walkOneRound(Walk memory w, uint80 rid) internal view returns (bool) {
        int256 answer;
        uint256 startedAt;
        uint256 updatedAt;
        try IAggregatorV3Extra(seqFeed).getRoundData(rid) returns (
            uint80, int256 a, uint256 s, uint256 u, uint80
        ) {
            if (s == 0) return false; // unset round: past the beginning of this phase
            (answer, startedAt, updatedAt) = (a, s, u);
        } catch {
            return false;
        }

        w.roundsWalked++;
        console2.log("  prior round               ", uint256(rid));
        console2.log("    answer                  ", answer);
        console2.log("    startedAt               ", startedAt);
        console2.log("    updatedAt               ", updatedAt);

        // Per-round shape of a status feed.
        assertTrue(answer == 0 || answer == 1, "historical uptime answer outside {0,1}");
        assertGe(updatedAt, startedAt, "historical updatedAt precedes startedAt");
        if (updatedAt > startedAt) w.diverged++;

        // Ordering: an older round's status began strictly earlier...
        assertLt(startedAt, w.prevStartedAt, "rounds are not ordered by startedAt");
        // ...and the NEWER round's status began at or after the older round's last write. This is
        // what makes `startedAt` a status-transition instant rather than an arbitrary stamp: rounds
        // partition time, they do not overlap.
        assertGe(w.prevStartedAt, updatedAt, "newer round's startedAt precedes the older round's write");

        if (answer != w.prevAnswer) {
            w.statusFlips++;
            // An older DOWN round followed by a newer UP round is a real outage-and-recovery. Its
            // length is the reason the grace period exists; log it as the concrete evidence.
            if (answer == 1 && w.prevAnswer == 0) {
                console2.log("    ^ outage recovered after (s)", w.prevStartedAt - startedAt);
            }
        } else {
            console2.log("    ^ note: status repeated across consecutive rounds");
        }
        if (answer == 1) w.sawDown = true;
        if (answer == 0) w.sawUp = true;

        w.prevAnswer = answer;
        w.prevStartedAt = startedAt;
        return true;
    }

    // --- 3. the UP path, end to end, against real price feeds --------------

    /// @notice End-to-end UP path: a real {ChainlinkOracle}, deployed in the fork against the real
    /// ETH/USD feed and the real uptime feed, returns a sane WAD price for every configured asset.
    /// Conditional on the live sequencer actually being usable — if it is not, the correct assertion
    /// is the revert, and `testFork_mockedJustPastGrace_priceWadFlowsAgain` still exercises the UP
    /// branch deterministically.
    function testFork_realFeeds_upPathReturnsSanePriceWad() public {
        if (!_live()) return;

        ChainlinkOracle oracle = _deployRealOracle();

        if (!_independentVerdictSequencerUsable()) {
            console2.log("live sequencer NOT usable at this block; asserting fail-closed instead");
            _expectStale(oracle, assets[0]);
            return;
        }

        for (uint256 i; i < assets.length; ++i) {
            (, int256 answer,, uint256 updatedAt,) = IAggregatorV3(feeds[i]).latestRoundData();
            uint8 d = IAggregatorV3(feeds[i]).decimals();
            uint256 expected = uint256(answer) * (10 ** (18 - d));

            uint256 p = oracle.priceWad(assets[i]);
            console2.log("asset", assets[i]);
            console2.log("  feed             ", feeds[i]);
            console2.log("  raw answer       ", answer);
            console2.log("  priceWad         ", p);

            assertEq(p, expected, "priceWad is not the feed answer scaled to WAD");
            assertGe(p, minBand[i], "priceWad below the configured sane-price floor");
            assertLe(p, maxBand[i], "priceWad above the configured sane-price ceiling");
            assertLe(block.timestamp - updatedAt, heartbeats[i], "live feed is stale vs configured heartbeat");
        }

        // The pinned quote leg passes the same gate.
        assertEq(oracle.priceWad(usdc), 1e18, "USDC pin broken on the UP path");
    }

    /// @notice The deterministic UP branch: unlike the test above this one does not depend on the
    /// live sequencer status, so the UP path is exercised on every fork run. `startedAt` exactly one
    /// second past the grace window is the tightest passing input.
    function testFork_mockedJustPastGrace_priceWadFlowsAgain() public {
        if (!_live()) return;

        ChainlinkOracle oracle = _deployRealOracle(); // real feed first: the ctor decode-proofs it
        _mockUptime(0, block.timestamp - GRACE - 1); // up, grace fully elapsed by 1s

        uint256 p = oracle.priceWad(assets[0]);
        assertGt(p, 0, "grace elapsed but pricing still blocked");
        assertGe(p, minBand[0], "priceWad below the configured floor");
        assertLe(p, maxBand[0], "priceWad above the configured ceiling");
        assertEq(oracle.priceWad(usdc), 1e18, "USDC pin blocked with the sequencer up");
    }

    // --- 4. the DOWN path -------------------------------------------------

    /// @notice DOWN: `answer == 1`. Everything else about the fork stays real — the ETH/USD feed is
    /// live and fresh — so this isolates the gate: a perfectly good price is refused because the
    /// sequencer is not up. Fail-closed, per the K-4 / SF-2 posture.
    function testFork_mockedDown_priceWadFailsClosed() public {
        if (!_live()) return;

        ChainlinkOracle oracle = _deployRealOracle();
        assertGt(oracle.priceWad(assets[0]), 0, "precondition: real feed prices before mocking");

        _mockUptime(1, block.timestamp - 30 days); // DOWN, and "down for a long time" must not help
        _expectStale(oracle, assets[0]);

        // Not a polarity coincidence: the guard tests `answer != 0`, so ANY non-zero answer is
        // refused — including a NEGATIVE one. `answer` is an int256, and a guard written the
        // tempting way (`answer == 1`) would pass every other test in this file while pricing
        // straight through a negative reading. `startedAt` is well past grace in both cases, so the
        // revert can only be coming from the polarity line.
        vm.clearMockedCalls();
        _mockUptime(2, block.timestamp - 30 days);
        _expectStale(oracle, assets[0]);

        vm.clearMockedCalls();
        _mockUptime(-1, block.timestamp - 30 days);
        _expectStale(oracle, assets[0]);

        vm.clearMockedCalls();
        _mockUptime(type(int256).min, block.timestamp - 30 days);
        _expectStale(oracle, assets[0]);
    }

    /// @notice The gate runs BEFORE the USDC pin, so a downed sequencer freezes the pinned leg too.
    /// If it did not, a vault could still "price" its USDC balance mid-outage and mint against it.
    function testFork_mockedDown_alsoGatesThePinnedUsdcLeg() public {
        if (!_live()) return;

        ChainlinkOracle oracle = _deployRealOracle();
        assertEq(oracle.priceWad(usdc), 1e18, "precondition: pin reads 1e18 while up");

        _mockUptime(1, block.timestamp - 30 days);
        _expectStale(oracle, usdc);
    }

    // --- 5. the GRACE-PERIOD path -----------------------------------------

    /// @notice GRACE: the sequencer reports UP (`answer == 0`) but only just came back. Prices must
    /// still be refused, because transactions queued during the outage have not yet been processed
    /// and the L2's state is not yet the state the price should be applied to. Covers the whole
    /// window including the exact boundary, which must be EXCLUSIVE (`<=` reverts).
    function testFork_mockedWithinGrace_priceWadFailsClosed() public {
        if (!_live()) return;

        ChainlinkOracle oracle = _deployRealOracle();

        _mockUptime(0, block.timestamp); // recovered this very second
        _expectStale(oracle, assets[0]);

        vm.clearMockedCalls();
        _mockUptime(0, block.timestamp - 1); // 1s into the window
        _expectStale(oracle, assets[0]);

        vm.clearMockedCalls();
        _mockUptime(0, block.timestamp - (GRACE / 2)); // mid-window
        _expectStale(oracle, assets[0]);

        vm.clearMockedCalls();
        _mockUptime(0, block.timestamp - GRACE); // EXACTLY at the boundary: still refused
        _expectStale(oracle, assets[0]);

        // The pinned leg is inside the grace window too.
        vm.clearMockedCalls();
        _mockUptime(0, block.timestamp - 1);
        _expectStale(oracle, usdc);
    }

    // --- 6. the `startedAt == 0` edge case ---------------------------------

    /// @notice `startedAt == 0` — the uptime feed's first round after deployment, before any status
    /// has been recorded.
    ///
    /// THIS IS THE CASE THE CANONICAL CHAINLINK SNIPPET GETS WRONG. The documented example computes
    /// `timeSinceUp = block.timestamp - startedAt` with no zero guard, so `startedAt == 0` yields a
    /// `timeSinceUp` of ~1.79 billion seconds — vastly greater than the grace period — and the
    /// consumer concludes the sequencer has been happily up for 56 years and PRICES NORMALLY off a
    /// feed that has never reported a status.
    ///
    /// {ChainlinkOracle} guards it explicitly (`startedAt == 0 || startedAt > block.timestamp`) and
    /// fails closed. Asserted in both directions: it must revert (not falsely pass), and it must
    /// revert as `StaleOracle` (not underflow-panic, and not brick the oracle permanently).
    function testFork_mockedStartedAtZero_failsClosedInsteadOfFalselyPassing() public {
        if (!_live()) return;

        ChainlinkOracle oracle = _deployRealOracle();

        // Demonstrate the trap concretely: the naive computation reports the grace period elapsed.
        assertGt(block.timestamp - 0, GRACE, "naive `block.timestamp - startedAt` would pass the grace test");

        _mockUptime(0, 0); // answer says UP, but no status has ever been recorded
        _expectStale(oracle, assets[0]); // clean StaleOracle, not a Panic and not a false price
        _expectStale(oracle, usdc);

        // And it is not a permanent brick: once the feed reports a real transition, pricing resumes.
        vm.clearMockedCalls();
        _mockUptime(0, block.timestamp - GRACE - 1);
        assertGt(oracle.priceWad(assets[0]), 0, "startedAt==0 bricked the oracle beyond the bad round");
    }

    /// @notice The mirror of the zero case: a `startedAt` in the FUTURE. Unguarded, the subtraction
    /// would underflow-panic — escaping the fail-closed contract as something other than
    /// `StaleOracle` and, inside a `try/catch` consumer, potentially being read as a different
    /// failure class entirely.
    function testFork_mockedStartedAtInFuture_failsClosed() public {
        if (!_live()) return;

        ChainlinkOracle oracle = _deployRealOracle();

        _mockUptime(0, block.timestamp + 1);
        _expectStale(oracle, assets[0]);

        vm.clearMockedCalls();
        _mockUptime(0, block.timestamp + 365 days);
        _expectStale(oracle, assets[0]);
    }

    // --- 7. a reverting uptime feed ---------------------------------------

    /// @notice A deprecated or reverting uptime feed must fail closed, not fall through. Uses the
    /// real feed address with a forced revert so the `try/catch` in `_requireSequencerUp` is the
    /// thing under test.
    function testFork_mockedRevertingUptimeFeed_failsClosed() public {
        if (!_live()) return;

        ChainlinkOracle oracle = _deployRealOracle();
        vm.mockCallRevert(
            seqFeed, abi.encodeWithSelector(IAggregatorV3.latestRoundData.selector), "uptime feed retired"
        );
        _expectStale(oracle, assets[0]);
        _expectStale(oracle, usdc);
    }

    // --- 8. config integrity ----------------------------------------------

    /// @notice The address the mainnet config will hand to the constructor really is a Chainlink L2
    /// Sequencer Uptime Feed on Base — not a price feed, not a copy-paste from another chain. The
    /// constructor's `code.length > 0` check cannot tell those apart; this can.
    function testFork_configuredSequencerAddressIsARealUptimeFeedOnBase() public {
        if (!_live()) return;

        assertEq(
            seqFeed,
            0xBCF85224fc0756B9Fa45aA7892530B47e10b6433,
            "config sequencerUptimeFeed drifted from the verified Base mainnet address"
        );
        assertGt(seqFeed.code.length, 0, "no code at the configured uptime feed on Base mainnet");
        assertEq(
            uint256(IAggregatorV3(seqFeed).decimals()),
            uint256(0),
            "configured uptime feed is not a 0-decimal status feed"
        );

        string memory desc = IAggregatorV3Extra(seqFeed).description();
        console2.log("configured uptime feed description:", desc);
        assertTrue(
            vm.contains(desc, "Sequencer") || vm.contains(desc, "sequencer"),
            "configured uptime feed does not describe itself as a sequencer feed"
        );

        // The constant the grace window is built on, pinned against the contract.
        ChainlinkOracle oracle = _deployRealOracle();
        assertEq(oracle.GRACE_PERIOD(), GRACE, "GRACE_PERIOD changed; revisit every window assertion here");
        assertEq(address(oracle.sequencerUptimeFeed()), seqFeed, "oracle did not retain the uptime feed");
    }
}
