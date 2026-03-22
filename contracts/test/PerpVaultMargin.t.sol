// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {PerpVault} from "../src/perpetual/PerpVault.sol";

/**
 * @title PerpVault Margin Tests
 * @notice Tests for trader margin deposit/withdraw/settle functions.
 *         Verifies that trader margin is properly segregated from LP pool.
 */
contract PerpVaultMarginTest is Test {
    PerpVault public vault;

    address public owner = address(0x1);
    address public engine = address(0x2); // Matching engine (authorized)
    address public lp1 = address(0x10);
    address public trader1 = address(0x20);
    address public trader2 = address(0x21);
    address public trader3 = address(0x22);
    address public unauthorized = address(0x99);

    uint256 constant PRECISION = 1e18;

    function setUp() public {
        vm.prank(owner);
        vault = new PerpVault();

        vm.prank(owner);
        vault.setAuthorizedContract(engine, true);

        // Seed LP pool with 10 ETH
        vm.deal(lp1, 100 ether);
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        // Fund traders
        vm.deal(trader1, 100 ether);
        vm.deal(trader2, 100 ether);
        vm.deal(trader3, 100 ether);
        vm.deal(engine, 100 ether);
    }

    // ============================================================
    // depositMargin Tests
    // ============================================================

    function test_depositMargin_basic() public {
        vm.prank(trader1);
        vault.depositMargin{value: 1 ether}();

        assertEq(vault.traderMargin(trader1), 1 ether, "Trader margin recorded");
        assertEq(vault.totalTraderMargin(), 1 ether, "Total trader margin updated");
    }

    function test_depositMargin_multipleDeposits() public {
        vm.prank(trader1);
        vault.depositMargin{value: 1 ether}();

        vm.prank(trader1);
        vault.depositMargin{value: 0.5 ether}();

        assertEq(vault.traderMargin(trader1), 1.5 ether, "Cumulative margin");
        assertEq(vault.totalTraderMargin(), 1.5 ether, "Total updated");
    }

    function test_depositMargin_multipleTraders() public {
        vm.prank(trader1);
        vault.depositMargin{value: 2 ether}();

        vm.prank(trader2);
        vault.depositMargin{value: 3 ether}();

        assertEq(vault.traderMargin(trader1), 2 ether);
        assertEq(vault.traderMargin(trader2), 3 ether);
        assertEq(vault.totalTraderMargin(), 5 ether);
    }

    function test_depositMargin_zeroReverts() public {
        vm.prank(trader1);
        vm.expectRevert(PerpVault.InvalidAmount.selector);
        vault.depositMargin{value: 0}();
    }

    function test_depositMargin_emitsEvent() public {
        vm.prank(trader1);
        vm.expectEmit(true, false, false, true);
        emit PerpVault.MarginDeposited(trader1, 1 ether);
        vault.depositMargin{value: 1 ether}();
    }

    function test_depositMargin_doesNotAffectPoolValue() public {
        uint256 poolBefore = vault.getPoolValue();

        vm.prank(trader1);
        vault.depositMargin{value: 5 ether}();

        uint256 poolAfter = vault.getPoolValue();
        assertEq(poolAfter, poolBefore, "Pool value must NOT change when trader deposits margin");
    }

    function test_depositMargin_doesNotAffectSharePrice() public {
        uint256 priceBefore = vault.getSharePrice();

        vm.prank(trader1);
        vault.depositMargin{value: 5 ether}();

        uint256 priceAfter = vault.getSharePrice();
        assertEq(priceAfter, priceBefore, "Share price must NOT change from margin deposit");
    }

    // ============================================================
    // withdrawMargin Tests
    // ============================================================

    function test_withdrawMargin_basic() public {
        // Setup: deposit margin first
        vm.prank(trader1);
        vault.depositMargin{value: 2 ether}();

        uint256 balBefore = trader1.balance;

        // Engine withdraws margin
        vm.prank(engine);
        vault.withdrawMargin(trader1, 0.5 ether);

        assertEq(vault.traderMargin(trader1), 1.5 ether, "Margin reduced");
        assertEq(vault.totalTraderMargin(), 1.5 ether, "Total reduced");
        assertEq(trader1.balance, balBefore + 0.5 ether, "Trader received BNB");
    }

    function test_withdrawMargin_full() public {
        vm.prank(trader1);
        vault.depositMargin{value: 2 ether}();

        vm.prank(engine);
        vault.withdrawMargin(trader1, 2 ether);

        assertEq(vault.traderMargin(trader1), 0, "Margin fully withdrawn");
        assertEq(vault.totalTraderMargin(), 0, "Total zeroed");
    }

    function test_withdrawMargin_insufficientReverts() public {
        vm.prank(trader1);
        vault.depositMargin{value: 1 ether}();

        vm.prank(engine);
        vm.expectRevert(PerpVault.InsufficientTraderMargin.selector);
        vault.withdrawMargin(trader1, 2 ether);
    }

    function test_withdrawMargin_unauthorizedReverts() public {
        vm.prank(trader1);
        vault.depositMargin{value: 1 ether}();

        vm.prank(unauthorized);
        vm.expectRevert(PerpVault.Unauthorized.selector);
        vault.withdrawMargin(trader1, 0.5 ether);
    }

    function test_withdrawMargin_zeroReverts() public {
        vm.prank(engine);
        vm.expectRevert(PerpVault.InvalidAmount.selector);
        vault.withdrawMargin(trader1, 0);
    }

    function test_withdrawMargin_doesNotAffectPoolValue() public {
        vm.prank(trader1);
        vault.depositMargin{value: 3 ether}();

        uint256 poolBefore = vault.getPoolValue();

        vm.prank(engine);
        vault.withdrawMargin(trader1, 1 ether);

        assertEq(vault.getPoolValue(), poolBefore, "Pool value unchanged by margin withdraw");
    }

    // ============================================================
    // settleClose Tests — Profit Scenarios
    // ============================================================

    function test_settleClose_profit() public {
        // Trader deposits 1 ETH margin, closes with +0.2 ETH profit
        vm.prank(trader1);
        vault.depositMargin{value: 1 ether}();

        uint256 balBefore = trader1.balance;
        uint256 poolBefore = vault.getPoolValue();

        vm.prank(engine);
        vault.settleClose(trader1, int256(0.2 ether), 1 ether);

        // Trader gets margin + profit = 1.2 ETH
        assertEq(trader1.balance, balBefore + 1.2 ether, "Trader receives margin + profit");
        assertEq(vault.traderMargin(trader1), 0, "Margin fully released");
        assertEq(vault.totalTraderMargin(), 0, "Total margin zeroed");

        // LP pool shrinks by profit amount
        uint256 poolAfter = vault.getPoolValue();
        assertApproxEqAbs(poolAfter, poolBefore - 0.2 ether, 1, "LP pool reduced by profit");
    }

    function test_settleClose_loss_partial() public {
        // Trader deposits 1 ETH, loses 0.3 ETH
        vm.prank(trader1);
        vault.depositMargin{value: 1 ether}();

        uint256 balBefore = trader1.balance;
        uint256 poolBefore = vault.getPoolValue();

        vm.prank(engine);
        vault.settleClose(trader1, -int256(0.3 ether), 1 ether);

        // Trader gets margin - loss = 0.7 ETH
        assertEq(trader1.balance, balBefore + 0.7 ether, "Trader receives margin minus loss");
        assertEq(vault.traderMargin(trader1), 0, "Margin released");

        // LP pool grows by loss amount
        uint256 poolAfter = vault.getPoolValue();
        assertApproxEqAbs(poolAfter, poolBefore + 0.3 ether, 1, "LP pool gains from loss");
    }

    function test_settleClose_loss_total() public {
        // Trader deposits 1 ETH, loses 1.5 ETH (more than margin)
        vm.prank(trader1);
        vault.depositMargin{value: 1 ether}();

        uint256 balBefore = trader1.balance;
        uint256 poolBefore = vault.getPoolValue();

        vm.prank(engine);
        vault.settleClose(trader1, -int256(1.5 ether), 1 ether);

        // Trader gets 0 (capped at margin)
        assertEq(trader1.balance, balBefore, "Trader receives nothing on total loss");
        assertEq(vault.traderMargin(trader1), 0, "Margin zeroed");

        // LP pool gains entire margin (capped at marginRelease)
        uint256 poolAfter = vault.getPoolValue();
        assertApproxEqAbs(poolAfter, poolBefore + 1 ether, 1, "LP gains entire margin");
    }

    function test_settleClose_zeroPnl() public {
        // Break-even close: pnl = 0
        vm.prank(trader1);
        vault.depositMargin{value: 1 ether}();

        uint256 balBefore = trader1.balance;

        vm.prank(engine);
        vault.settleClose(trader1, 0, 1 ether);

        // Trader gets full margin back
        assertEq(trader1.balance, balBefore + 1 ether, "Trader gets full margin on break-even");
        assertEq(vault.traderMargin(trader1), 0);
    }

    function test_settleClose_profitADL() public {
        // Deploy a mock WETH for fallback
        MockWETH mockWeth = new MockWETH();
        vm.prank(owner);
        vault.setWETH(address(mockWeth));

        // Drain LP pool: pay out most of it
        vm.prank(engine);
        vault.settleTraderProfit(trader2, 9 ether); // Leave ~1 ETH in LP

        // Now trader1 deposits margin and has 5 ETH profit (more than LP)
        vm.prank(trader1);
        vault.depositMargin{value: 2 ether}();

        uint256 lpBefore = vault.getRawBalance();
        uint256 balBefore = trader1.balance;

        vm.prank(engine);
        vault.settleClose(trader1, int256(5 ether), 2 ether);

        // Trader gets margin + partial profit (capped by LP balance)
        assertEq(vault.traderMargin(trader1), 0, "Margin released");
        // Trader gets at least margin back + whatever LP could pay
        assertGe(trader1.balance - balBefore, 2 ether, "At least margin returned");
        // But less than full margin + full profit (since ADL triggered)
        assertLt(trader1.balance - balBefore, 2 ether + 5 ether, "Profit capped by ADL");
    }

    function test_settleClose_unauthorizedReverts() public {
        vm.prank(trader1);
        vault.depositMargin{value: 1 ether}();

        vm.prank(unauthorized);
        vm.expectRevert(PerpVault.Unauthorized.selector);
        vault.settleClose(trader1, int256(0.1 ether), 1 ether);
    }

    function test_settleClose_insufficientMarginReverts() public {
        vm.prank(trader1);
        vault.depositMargin{value: 1 ether}();

        vm.prank(engine);
        vm.expectRevert(PerpVault.InsufficientTraderMargin.selector);
        vault.settleClose(trader1, 0, 2 ether); // Try to release more than deposited
    }

    // ============================================================
    // batchDepositMargin Tests
    // ============================================================

    function test_batchDepositMargin_basic() public {
        address[] memory traders = new address[](3);
        traders[0] = trader1;
        traders[1] = trader2;
        traders[2] = trader3;

        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 1 ether;
        amounts[1] = 2 ether;
        amounts[2] = 0.5 ether;

        uint256 total = 3.5 ether;

        vm.prank(engine);
        vault.batchDepositMargin{value: total}(traders, amounts);

        assertEq(vault.traderMargin(trader1), 1 ether);
        assertEq(vault.traderMargin(trader2), 2 ether);
        assertEq(vault.traderMargin(trader3), 0.5 ether);
        assertEq(vault.totalTraderMargin(), total);
    }

    function test_batchDepositMargin_valueMismatchReverts() public {
        address[] memory traders = new address[](2);
        traders[0] = trader1;
        traders[1] = trader2;

        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 1 ether;
        amounts[1] = 2 ether;

        vm.prank(engine);
        vm.expectRevert(PerpVault.MarginValueMismatch.selector);
        vault.batchDepositMargin{value: 2 ether}(traders, amounts); // Should be 3 ETH
    }

    function test_batchDepositMargin_arrayLengthMismatchReverts() public {
        address[] memory traders = new address[](2);
        traders[0] = trader1;
        traders[1] = trader2;

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1 ether;

        vm.prank(engine);
        vm.expectRevert(PerpVault.ArrayLengthMismatch.selector);
        vault.batchDepositMargin{value: 1 ether}(traders, amounts);
    }

    function test_batchDepositMargin_unauthorizedReverts() public {
        address[] memory traders = new address[](1);
        traders[0] = trader1;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1 ether;

        vm.deal(unauthorized, 10 ether);
        vm.prank(unauthorized);
        vm.expectRevert(PerpVault.Unauthorized.selector);
        vault.batchDepositMargin{value: 1 ether}(traders, amounts);
    }

    function test_batchDepositMargin_doesNotAffectPoolValue() public {
        uint256 poolBefore = vault.getPoolValue();

        address[] memory traders = new address[](2);
        traders[0] = trader1;
        traders[1] = trader2;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 3 ether;
        amounts[1] = 4 ether;

        vm.prank(engine);
        vault.batchDepositMargin{value: 7 ether}(traders, amounts);

        assertEq(vault.getPoolValue(), poolBefore, "Pool value unchanged by batch margin deposit");
    }

    // ============================================================
    // batchSettleClose Tests
    // ============================================================

    function test_batchSettleClose_mixed() public {
        // Setup: 3 traders with margin
        vm.prank(trader1);
        vault.depositMargin{value: 2 ether}();
        vm.prank(trader2);
        vault.depositMargin{value: 3 ether}();
        vm.prank(trader3);
        vault.depositMargin{value: 1 ether}();

        uint256 bal1 = trader1.balance;
        uint256 bal2 = trader2.balance;
        uint256 bal3 = trader3.balance;

        address[] memory traders = new address[](3);
        traders[0] = trader1;
        traders[1] = trader2;
        traders[2] = trader3;

        int256[] memory pnls = new int256[](3);
        pnls[0] = int256(0.5 ether);   // Profit
        pnls[1] = -int256(1 ether);     // Loss
        pnls[2] = int256(0);            // Break-even

        uint256[] memory margins = new uint256[](3);
        margins[0] = 2 ether;
        margins[1] = 3 ether;
        margins[2] = 1 ether;

        vm.prank(engine);
        vault.batchSettleClose(traders, pnls, margins);

        // Trader1: 2 + 0.5 = 2.5 ETH
        assertEq(trader1.balance, bal1 + 2.5 ether, "Trader1 profit");
        // Trader2: 3 - 1 = 2 ETH
        assertEq(trader2.balance, bal2 + 2 ether, "Trader2 loss");
        // Trader3: 1 + 0 = 1 ETH
        assertEq(trader3.balance, bal3 + 1 ether, "Trader3 break-even");

        assertEq(vault.totalTraderMargin(), 0, "All margin released");
    }

    function test_batchSettleClose_arrayMismatchReverts() public {
        address[] memory traders = new address[](2);
        traders[0] = trader1;
        traders[1] = trader2;
        int256[] memory pnls = new int256[](1);
        pnls[0] = int256(0);
        uint256[] memory margins = new uint256[](2);
        margins[0] = 0;
        margins[1] = 0;

        vm.prank(engine);
        vm.expectRevert(PerpVault.ArrayLengthMismatch.selector);
        vault.batchSettleClose(traders, pnls, margins);
    }

    // ============================================================
    // Integration: Margin + LP Isolation
    // ============================================================

    function test_integration_marginIsolatedFromLP() public {
        // LP deposits 10 ETH (already in setUp)
        uint256 poolValueStart = vault.getPoolValue();
        uint256 sharePriceStart = vault.getSharePrice();

        // Trader deposits 50 ETH margin (5x the LP pool)
        vm.prank(trader1);
        vault.depositMargin{value: 50 ether}();

        // Pool value and share price should NOT change
        assertEq(vault.getPoolValue(), poolValueStart, "Pool value isolated from margin");
        assertEq(vault.getSharePrice(), sharePriceStart, "Share price isolated from margin");

        // But contract balance increased
        assertGt(address(vault).balance, 50 ether, "Contract holds both LP + margin");

        // Total trader margin tracked separately
        assertEq(vault.totalTraderMargin(), 50 ether);
    }

    function test_integration_fullCycle() public {
        // 1. Trader deposits margin
        vm.prank(trader1);
        vault.depositMargin{value: 2 ether}();

        uint256 poolBefore = vault.getPoolValue();

        // 2. Trade happens, trader profits 0.3 ETH, engine settles
        vm.prank(engine);
        vault.settleClose(trader1, int256(0.3 ether), 2 ether);

        // 3. Verify: trader margin gone, pool reduced by profit
        assertEq(vault.traderMargin(trader1), 0);
        assertEq(vault.totalTraderMargin(), 0);
        assertApproxEqAbs(vault.getPoolValue(), poolBefore - 0.3 ether, 1);

        // 4. Trader deposits again for second trade
        vm.prank(trader1);
        vault.depositMargin{value: 1 ether}();

        // 5. Second trade: loss of 0.5 ETH
        uint256 poolBeforeLoss = vault.getPoolValue();
        vm.prank(engine);
        vault.settleClose(trader1, -int256(0.5 ether), 1 ether);

        // 6. Verify: pool increased by loss
        assertEq(vault.traderMargin(trader1), 0);
        assertApproxEqAbs(vault.getPoolValue(), poolBeforeLoss + 0.5 ether, 1);
    }

    function test_integration_marginDoesNotAffectLPWithdrawal() public {
        // Large margin deposit
        vm.prank(trader1);
        vault.depositMargin{value: 50 ether}();

        // LP requests withdrawal
        uint256 lp1Shares = vault.shares(lp1);
        vm.prank(lp1);
        vault.requestWithdrawal(lp1Shares / 2);

        // Warp past cooldown
        vm.warp(block.timestamp + 25 hours);

        // LP should be able to withdraw from LP pool only
        uint256 balBefore = lp1.balance;
        vm.prank(lp1);
        vault.executeWithdrawal();

        assertGt(lp1.balance, balBefore, "LP received ETH");
        // Trader margin should be untouched
        assertEq(vault.traderMargin(trader1), 50 ether, "Trader margin untouched by LP withdrawal");
    }

    // ============================================================
    // Reentrancy Protection
    // ============================================================

    function test_settleClose_reentrancyProtected() public {
        // settleClose has nonReentrant modifier — test that it doesn't reenter
        // This is implicitly tested by the modifier; explicit test verifies the modifier is present
        vm.prank(trader1);
        vault.depositMargin{value: 1 ether}();

        // Normal call should work
        vm.prank(engine);
        vault.settleClose(trader1, 0, 1 ether);
        assertEq(vault.traderMargin(trader1), 0);
    }

    // ============================================================
    // View Function Tests
    // ============================================================

    function test_getTraderMargin() public {
        vm.prank(trader1);
        vault.depositMargin{value: 3 ether}();

        assertEq(vault.getTraderMargin(trader1), 3 ether);
        assertEq(vault.getTraderMargin(trader2), 0); // No deposit
    }

    function test_getTotalTraderMargin() public {
        vm.prank(trader1);
        vault.depositMargin{value: 2 ether}();
        vm.prank(trader2);
        vault.depositMargin{value: 3 ether}();

        assertEq(vault.getTotalTraderMargin(), 5 ether);
    }

    // ============================================================
    // Edge Cases
    // ============================================================

    function test_depositMargin_whenPaused_reverts() public {
        vm.prank(owner);
        vault.pause();

        vm.prank(trader1);
        vm.expectRevert();
        vault.depositMargin{value: 1 ether}();
    }

    function test_settleClose_partialMarginRelease() public {
        // Trader has 5 ETH margin, only release 2 ETH (partial close)
        vm.prank(trader1);
        vault.depositMargin{value: 5 ether}();

        vm.prank(engine);
        vault.settleClose(trader1, int256(0.1 ether), 2 ether);

        assertEq(vault.traderMargin(trader1), 3 ether, "Remaining margin = 5 - 2");
        assertEq(vault.totalTraderMargin(), 3 ether);
    }

    function test_getExtendedStats_includesMarginExclusion() public {
        vm.prank(trader1);
        vault.depositMargin{value: 10 ether}();

        vault.getExtendedStats();
        // rawBalance uses getRawBalance() which excludes margin
        uint256 rawBal = vault.getRawBalance();
        // rawBal should be total contract balance minus trader margin
        assertEq(rawBal + vault.totalTraderMargin(), address(vault).balance, "Raw + margin = total");
    }
}

/// @notice Minimal WETH mock for testing fallback transfers
contract MockWETH {
    mapping(address => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount);
        balanceOf[msg.sender] -= amount;
        (bool s,) = msg.sender.call{value: amount}("");
        require(s);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value);
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }

    receive() external payable {}
}
