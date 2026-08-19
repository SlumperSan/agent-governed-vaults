// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IOperatorRegistry} from "../../src/interfaces/IOperatorRegistry.sol";
import {IGovernance} from "../../src/interfaces/IGovernance.sol";
import {IFeeEngine} from "../../src/interfaces/IFeeEngine.sol";
import {IOracleAggregator} from "../../src/interfaces/IOracleAggregator.sol";

contract MockERC20 {
    string public name;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    bool public transfersBlocked; // EE-6: simulate blacklist/revert on outbound transfer

    constructor(string memory name_, uint8 decimals_) {
        name = name_;
        decimals = decimals_;
    }

    function setTransfersBlocked(bool blocked) external {
        transfersBlocked = blocked;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(!transfersBlocked, "blocked");
        require(balanceOf[msg.sender] >= amount, "bal");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allow");
        require(balanceOf[from] >= amount, "bal");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockOracle is IOracleAggregator {
    mapping(address => uint256) public price; // WAD per whole token
    bool public stale;

    function setPrice(address asset, uint256 priceWad_) external {
        price[asset] = priceWad_;
    }

    function setStale(bool stale_) external {
        stale = stale_;
    }

    function priceWad(address asset) external view returns (uint256) {
        if (stale) revert StaleOracle(asset);
        uint256 p = price[asset];
        require(p != 0, "no price");
        return p;
    }
}

contract StubGovernance is IGovernance {
    bool public pending;

    function setPendingExecution(bool p) external {
        pending = p;
    }

    function hasPendingExecution(address) external view returns (bool) {
        return pending;
    }

    function isExecutor(address, address) external pure returns (bool) {
        return false;
    }
}

contract StubFeeEngine is IFeeEngine {
    uint256 public feeToCharge; // 0 by default (Sprint 3 lands the real engine)
    uint256 public lastGain;
    uint256 public lastLoss;
    address public lastMember;

    function setFeeToCharge(uint256 f) external {
        feeToCharge = f;
    }

    function onRealize(address member, uint256 gainUsdc, uint256 lossUsdc) external returns (uint256) {
        lastMember = member;
        lastGain = gainUsdc;
        lastLoss = lossUsdc;
        return gainUsdc > 0 ? feeToCharge : 0;
    }

    uint256 public lastCollected;

    function onFeeCollected(address, uint256 amountUsdc) external {
        lastCollected = amountUsdc;
    }
}

contract StubRegistry is IOperatorRegistry {
    uint256 public totalGain;
    uint256 public totalLoss;

    function operatorOf(address) external pure returns (uint256) {
        return 0;
    }

    function recordRealization(address, uint256 gainUsdc, uint256 lossUsdc) external {
        totalGain += gainUsdc;
        totalLoss += lossUsdc;
    }
}
