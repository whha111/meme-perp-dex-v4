// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {PerpVault} from "../src/perpetual/PerpVault.sol";

/**
 * @title PerpVault Tests (Production-grade)
 * @notice Tests account for: dead shares, deposit/withdrawal fees (30 bps),
 *         deposit-time cooldown, OI withdrawal guard, slippage protection.
 *
 * Constants:
 *   DEAD_SHARES         = 1000
 *   DEPOSIT_FEE_BPS     = 30  (0.3%)
 *   WITHDRAWAL_FEE_BPS  = 30  (0.3%)
 *   FEE_PRECISION       = 10000
 */
contract PerpVaultTest is Test {
    PerpVault public vault;

    address public owner = address(0x1);
    address public matchingEngine = address(0x2);
    address public vaultContract = address(0x3);
    address public lp1 = address(0x10);
    address public lp2 = address(0x11);
    address public lp3 = address(0x12);
    address public trader1 = address(0x20);
    address public liquidator1 = address(0x30);
    address public tokenA = address(0xA);
    address public tokenB = address(0xB);

    uint256 constant PRECISION = 1e18;
    uint256 constant DEAD_SHARES = 1000;
    uint256 constant FEE_BPS = 30;
    uint256 constant FEE_PRECISION = 10000;

    // Helper: calculate deposit fee
    function _depositFee(uint256 amount) internal pure returns (uint256) {
        return (amount * FEE_BPS) / FEE_PRECISION;
    }

    // Helper: calculate net deposit (after fee)
    function _netDeposit(uint256 amount) internal pure returns (uint256) {
        return amount - _depositFee(amount);
    }

    // Helper: calculate shares for first deposit
    function _firstDepositShares(uint256 amount) internal pure returns (uint256) {
        return _netDeposit(amount) - DEAD_SHARES;
    }

    // Helper: calculate withdrawal fee
    function _withdrawalFee(uint256 grossETH) internal pure returns (uint256) {
        return (grossETH * FEE_BPS) / FEE_PRECISION;
    }

    function setUp() public {
        vm.prank(owner);
        vault = new PerpVault();

        vm.prank(owner);
        vault.setAuthorizedContract(matchingEngine, true);

        vm.prank(owner);
        vault.setVault(vaultContract);

        // Restore old parameter values so existing test math stays correct
        vm.prank(owner);
        vault.setFees(30, 30);           // restore old 0.3% fees
        vm.prank(owner);
        vault.setMaxUtilization(8000);   // restore old 80%
        vm.prank(owner);
        vault.setAdlThreshold(9000);     // restore old 90%

        vm.deal(lp1, 1000 ether);
        vm.deal(lp2, 1000 ether);
        vm.deal(lp3, 500 ether);
        vm.deal(matchingEngine, 1000 ether);
        vm.deal(trader1, 100 ether);
    }

    // ============================================================
    // 1. Deposit Tests (with dead shares + fee)
    // ============================================================

    function test_deposit_firstDeposit() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        // net = 10 - 0.003 = 9.997 ETH → shares = 9.997e18 - 1000
        uint256 expectedShares = _firstDepositShares(10 ether);
        assertEq(vault.shares(lp1), expectedShares, "First deposit shares (minus dead shares and fee)");
        assertEq(vault.totalShares(), expectedShares + DEAD_SHARES, "Total includes dead shares");
        assertEq(vault.shares(vault.DEAD_ADDRESS()), DEAD_SHARES, "Dead shares minted");
        assertEq(vault.getPoolValue(), 10 ether, "Full ETH stays in pool");
        assertGt(vault.totalFeesCollected(), 0, "Deposit fee collected");
    }

    function test_deposit_subsequentDeposit() public {
        // LP1 deposits 10 ETH
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        uint256 lp1Shares = vault.shares(lp1);
        uint256 totalSharesAfterLP1 = vault.totalShares();

        // LP2 deposits 5 ETH — shares proportional to pool value
        vm.prank(lp2);
        vault.deposit{value: 5 ether}();

        uint256 lp2Net = _netDeposit(5 ether);
        // shares = lp2Net * totalSharesAfterLP1 / poolValueBefore(10 ether)
        uint256 expectedLP2Shares = (lp2Net * totalSharesAfterLP1) / 10 ether;
        assertEq(vault.shares(lp2), expectedLP2Shares, "LP2 gets proportional shares");
        assertEq(vault.getPoolValue(), 15 ether, "Pool has 15 ETH total");
    }

    function test_deposit_afterPriceChange() public {
        // LP1 deposits 10 ETH
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        uint256 totalSharesBefore = vault.totalShares();

        // Simulate trader loss → pool value goes to 12 ETH
        vm.prank(matchingEngine);
        vault.settleTraderLoss{value: 2 ether}(2 ether);

        uint256 sharePriceBefore = vault.getSharePrice();
        // sharePrice = 12 ETH * 1e18 / totalShares
        assertEq(sharePriceBefore, (12 ether * PRECISION) / totalSharesBefore);

        // LP2 deposits 6 ETH
        vm.prank(lp2);
        vault.deposit{value: 6 ether}();

        uint256 lp2Net = _netDeposit(6 ether);
        uint256 expectedLP2Shares = (lp2Net * totalSharesBefore) / 12 ether;
        assertEq(vault.shares(lp2), expectedLP2Shares, "LP2 gets shares at new price");
        assertEq(vault.getPoolValue(), 18 ether);
    }

    function test_deposit_revertBelowMinimum() public {
        vm.prank(lp1);
        vm.expectRevert(PerpVault.InvalidAmount.selector);
        vault.deposit{value: 0.0001 ether}();
    }

    function test_deposit_revertWhenPaused() public {
        vm.prank(owner);
        vault.pause();

        vm.prank(lp1);
        vm.expectRevert();
        vault.deposit{value: 1 ether}();
    }

    // ============================================================
    // 2. Withdrawal Tests (cooldown from deposit time + fee)
    // ============================================================

    function test_withdrawal_fullFlow() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        uint256 lp1Shares = vault.shares(lp1);

        // Request withdrawal of all LP1 shares
        vm.prank(lp1);
        vault.requestWithdrawal(lp1Shares);

        // Try to execute before cooldown — should fail
        vm.prank(lp1);
        vm.expectRevert(PerpVault.CooldownNotMet.selector);
        vault.executeWithdrawal();

        // Advance time past cooldown (from deposit time)
        vm.warp(block.timestamp + 24 hours + 1);

        // Execute withdrawal
        uint256 balanceBefore = lp1.balance;
        vm.prank(lp1);
        vault.executeWithdrawal();

        // Calculate expected: grossETH = shares * sharePrice / 1e18
        // Then minus withdrawal fee (30 bps)
        uint256 grossETH = (lp1Shares * vault.getSharePrice()) / PRECISION;
        // After withdrawal, pool only has dead shares left
        // So we calculate using pre-withdrawal values
        // LP1 had all user shares, receives most of pool minus dead share portion minus fee
        assertGt(lp1.balance - balanceBefore, 9.9 ether, "Should receive most ETH back after fees");
        assertEq(vault.shares(lp1), 0, "Shares should be burned");
    }

    function test_withdrawal_partialShares() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        uint256 lp1Shares = vault.shares(lp1);
        uint256 withdrawShares = lp1Shares * 4 / 10; // ~40% of shares

        vm.prank(lp1);
        vault.requestWithdrawal(withdrawShares);

        vm.warp(block.timestamp + 24 hours + 1);

        uint256 balanceBefore = lp1.balance;
        vm.prank(lp1);
        vault.executeWithdrawal();

        assertGt(lp1.balance - balanceBefore, 3.9 ether, "Should receive ~4 ETH minus fees");
        assertEq(vault.shares(lp1), lp1Shares - withdrawShares, "Remaining shares correct");
    }

    function test_withdrawal_afterProfitIncrease() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        uint256 lp1Shares = vault.shares(lp1);

        // Trader loss → pool grows to 15 ETH
        vm.prank(matchingEngine);
        vault.settleTraderLoss{value: 5 ether}(5 ether);

        uint256 sharePrice = vault.getSharePrice();
        uint256 grossETH = (lp1Shares * sharePrice) / PRECISION;
        uint256 fee = _withdrawalFee(grossETH);
        uint256 expectedNet = grossETH - fee;

        // Withdraw all shares
        vm.prank(lp1);
        vault.requestWithdrawal(lp1Shares);
        vm.warp(block.timestamp + 24 hours + 1);

        uint256 balanceBefore = lp1.balance;
        vm.prank(lp1);
        vault.executeWithdrawal();

        // Should get nearly 15 ETH (minus dead share portion and fees)
        assertGt(lp1.balance - balanceBefore, 14.8 ether, "Should get ~15 ETH minus fees");
    }

    function test_withdrawal_cancelPending() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        uint256 lp1Shares = vault.shares(lp1);

        vm.prank(lp1);
        vault.requestWithdrawal(lp1Shares / 2);

        vm.prank(lp1);
        vault.cancelWithdrawal();

        assertEq(vault.withdrawalAmount(lp1), 0);
        assertEq(vault.withdrawalTimestamp(lp1), 0);
    }

    function test_withdrawal_revertInsufficientShares() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        uint256 lp1Shares = vault.shares(lp1);

        vm.prank(lp1);
        vm.expectRevert(PerpVault.InsufficientShares.selector);
        vault.requestWithdrawal(lp1Shares + 1);
    }

    function test_withdrawal_revertBelowMinLiquidity() public {
        vm.prank(lp1);
        vault.deposit{value: 0.15 ether}();

        uint256 lp1Shares = vault.shares(lp1);
        // Withdraw most shares, leaving < MIN_LIQUIDITY
        uint256 withdrawAmount = lp1Shares * 4 / 10;

        vm.prank(lp1);
        vault.requestWithdrawal(withdrawAmount);

        vm.warp(block.timestamp + 24 hours + 1);

        vm.prank(lp1);
        vm.expectRevert(PerpVault.BelowMinLiquidity.selector);
        vault.executeWithdrawal();
    }

    function test_withdrawal_canWithdrawAll() public {
        vm.prank(lp1);
        vault.deposit{value: 1 ether}();

        uint256 lp1Shares = vault.shares(lp1);

        vm.prank(lp1);
        vault.requestWithdrawal(lp1Shares);
        vm.warp(block.timestamp + 24 hours + 1);

        vm.prank(lp1);
        vault.executeWithdrawal();

        // Dead shares still exist but they have negligible value
        assertEq(vault.shares(lp1), 0);
    }

    // ============================================================
    // 3. Trader Profit Settlement
    // ============================================================

    function test_settleTraderProfit() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        uint256 totalSharesNow = vault.totalShares();
        uint256 poolBefore = vault.getPoolValue();

        // Trader profits 2 ETH
        uint256 traderBalBefore = trader1.balance;
        vm.prank(matchingEngine);
        vault.settleTraderProfit(trader1, 2 ether);

        // Pool should decrease by 2 ETH
        assertEq(vault.getPoolValue(), poolBefore - 2 ether, "Pool reduced by profit");
        assertEq(trader1.balance - traderBalBefore, 2 ether, "Trader receives profit");
        // Share price drops: (10-2) * 1e18 / totalShares
        assertEq(vault.getSharePrice(), ((poolBefore - 2 ether) * PRECISION) / totalSharesNow);
    }

    // C2: ADL — settleTraderProfit now pays partial instead of reverting
    function test_settleTraderProfit_partialPaymentADL() public {
        vm.prank(lp1);
        vault.deposit{value: 1 ether}();

        // Request 2 ETH profit but pool only has 1 ETH → partial payment
        uint256 traderBalBefore = trader1.balance;
        vm.prank(matchingEngine);
        vault.settleTraderProfit(trader1, 2 ether);

        // Should have paid all available balance
        assertEq(address(vault).balance, 0, "Pool drained for ADL");
        assertEq(trader1.balance - traderBalBefore, 1 ether, "Trader received partial");
    }

    // C2: ADL — settleTraderProfit reverts only when pool is completely empty
    function test_settleTraderProfit_revertWhenPoolEmpty() public {
        // No deposits, pool is empty
        vm.prank(matchingEngine);
        vm.expectRevert(PerpVault.InsufficientPoolBalance.selector);
        vault.settleTraderProfit(trader1, 1 ether);
    }

    function test_settleTraderProfit_zeroIsNoop() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        vm.prank(matchingEngine);
        vault.settleTraderProfit(trader1, 0);

        assertEq(vault.getPoolValue(), 10 ether, "No change on zero profit");
    }

    // ============================================================
    // 4. Trader Loss Settlement
    // ============================================================

    function test_settleTraderLoss() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        uint256 totalSharesNow = vault.totalShares();

        // Trader loses 3 ETH
        vm.prank(matchingEngine);
        vault.settleTraderLoss{value: 3 ether}(3 ether);

        assertEq(vault.getPoolValue(), 13 ether, "Pool grows by loss");
        assertEq(vault.getSharePrice(), (13 ether * PRECISION) / totalSharesNow);
    }

    function test_settleTraderLoss_revertMismatch() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        vm.prank(matchingEngine);
        vm.expectRevert(PerpVault.InvalidAmount.selector);
        vault.settleTraderLoss{value: 2 ether}(3 ether);
    }

    // ============================================================
    // 5. Liquidation Settlement
    // ============================================================

    function test_settleLiquidation() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        uint256 liquidatorBalanceBefore = liquidator1.balance;
        vm.prank(matchingEngine);
        vault.settleLiquidation{value: 5 ether}(5 ether, 0.5 ether, liquidator1);

        assertEq(vault.getPoolValue(), 14.5 ether, "Pool = 10 + 5 - 0.5");
        assertEq(liquidator1.balance - liquidatorBalanceBefore, 0.5 ether);
    }

    function test_settleLiquidation_revertRewardExceedsCollateral() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        vm.prank(matchingEngine);
        vm.expectRevert(PerpVault.InvalidAmount.selector);
        vault.settleLiquidation{value: 1 ether}(1 ether, 2 ether, liquidator1);
    }

    // ============================================================
    // 6. OI Tracking
    // ============================================================

    function test_increaseOI_long() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        vm.prank(matchingEngine);
        vault.increaseOI(tokenA, true, 2 ether);

        (uint256 longOI, uint256 shortOI) = vault.getTokenOI(tokenA);
        assertEq(longOI, 2 ether);
        assertEq(shortOI, 0);
        assertEq(vault.getTotalOI(), 2 ether);
        assertEq(vault.totalOIAccumulator(), 2 ether, "Accumulator tracks total OI");
    }

    function test_increaseOI_revertExceedsMax() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        // Max OI = 10 * 80% = 8 ETH
        vm.prank(matchingEngine);
        vm.expectRevert(PerpVault.ExceedsMaxOI.selector);
        vault.increaseOI(tokenA, true, 9 ether);
    }

    function test_increaseOI_revertExceedsPerTokenMax() public {
        vm.prank(lp1);
        vault.deposit{value: 100 ether}();

        vm.prank(owner);
        vault.setMaxOIPerToken(tokenA, 5 ether);

        vm.prank(matchingEngine);
        vm.expectRevert(PerpVault.ExceedsMaxOI.selector);
        vault.increaseOI(tokenA, true, 6 ether);
    }

    function test_decreaseOI() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        vm.prank(matchingEngine);
        vault.increaseOI(tokenA, true, 5 ether);

        vm.prank(matchingEngine);
        vault.decreaseOI(tokenA, true, 3 ether);

        (uint256 longOI,) = vault.getTokenOI(tokenA);
        assertEq(longOI, 2 ether);
        assertEq(vault.totalOIAccumulator(), 2 ether, "Accumulator decreased");
    }

    function test_decreaseOI_cannotUnderflow() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        vm.prank(matchingEngine);
        vault.increaseOI(tokenA, true, 2 ether);

        vm.prank(matchingEngine);
        vault.decreaseOI(tokenA, true, 5 ether);

        (uint256 longOI,) = vault.getTokenOI(tokenA);
        assertEq(longOI, 0);
        assertEq(vault.totalOIAccumulator(), 0, "Accumulator floors at 0");
    }

    function test_OI_multipleTokens() public {
        vm.prank(lp1);
        vault.deposit{value: 20 ether}();

        vm.prank(matchingEngine);
        vault.increaseOI(tokenA, true, 3 ether);
        vm.prank(matchingEngine);
        vault.increaseOI(tokenB, false, 4 ether);

        assertEq(vault.getTotalOI(), 7 ether);
        assertEq(vault.totalOIAccumulator(), 7 ether);
        assertEq(vault.getOITokenCount(), 2);
    }

    // ============================================================
    // 7. Fee Collection
    // ============================================================

    function test_collectFee() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        uint256 totalSharesBefore = vault.totalShares();
        uint256 depositFee = _depositFee(10 ether);

        // Collect 0.1 ETH fee
        vm.prank(matchingEngine);
        vault.collectFee{value: 0.1 ether}(0.1 ether);

        assertEq(vault.getPoolValue(), 10.1 ether, "Pool grows by fee");
        // feesCollected = deposit fee + trading fee
        assertEq(vault.totalFeesCollected(), depositFee + 0.1 ether);
        // Share price = 10.1 ETH * 1e18 / totalShares
        assertEq(vault.getSharePrice(), (10.1 ether * PRECISION) / totalSharesBefore);
    }

    // ============================================================
    // 8. Multiple LPs — Fair Distribution (with fees)
    // ============================================================

    function test_multipleLPs_fairDistribution() public {
        // LP1 deposits 10 ETH
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();
        uint256 lp1Shares = vault.shares(lp1);

        // LP2 deposits 10 ETH
        vm.prank(lp2);
        vault.deposit{value: 10 ether}();
        uint256 lp2Shares = vault.shares(lp2);

        // Trader loses 4 ETH → pool grows
        vm.prank(matchingEngine);
        vault.settleTraderLoss{value: 4 ether}(4 ether);

        // Both LPs should have similar value (LP1 slightly more from receiving LP2's deposit fee)
        uint256 lp1Val = vault.getLPValue(lp1);
        uint256 lp2Val = vault.getLPValue(lp2);
        assertGt(lp1Val, 11 ether, "LP1 profited from trader loss");
        assertGt(lp2Val, 11 ether, "LP2 profited from trader loss");

        // LP1 withdraws all
        vm.prank(lp1);
        vault.requestWithdrawal(lp1Shares);
        vm.warp(block.timestamp + 24 hours + 1);

        uint256 lp1BalanceBefore = lp1.balance;
        vm.prank(lp1);
        vault.executeWithdrawal();

        // LP1 should get more than deposited (10 ETH) minus fees
        assertGt(lp1.balance - lp1BalanceBefore, 11 ether, "LP1 gets fair share of profits minus fee");
    }

    function test_multipleLPs_lateDepositor() public {
        // LP1 deposits 10 ETH
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        uint256 totalSharesAfterLP1 = vault.totalShares();

        // Trader loses 5 ETH → pool = 15 ETH
        vm.prank(matchingEngine);
        vault.settleTraderLoss{value: 5 ether}(5 ether);

        uint256 sharePriceAfterLoss = vault.getSharePrice();
        // sharePrice = 15 * 1e18 / totalShares
        assertEq(sharePriceAfterLoss, (15 ether * PRECISION) / totalSharesAfterLP1);

        // LP2 deposits 15 ETH
        vm.prank(lp2);
        vault.deposit{value: 15 ether}();

        uint256 lp2Net = _netDeposit(15 ether);
        uint256 expectedLP2Shares = (lp2Net * totalSharesAfterLP1) / 15 ether;
        assertEq(vault.shares(lp2), expectedLP2Shares, "LP2 gets shares at inflated price");

        // Both LPs should have roughly equal value
        uint256 lp1Val = vault.getLPValue(lp1);
        uint256 lp2Val = vault.getLPValue(lp2);
        // LP1 value ~15 ETH (profited from trader loss)
        // LP2 value ~15 ETH (just deposited at current price, minus fee effect)
        assertGt(lp1Val, 14.5 ether, "LP1 profited");
        assertGt(lp2Val, 14.5 ether, "LP2 fair entry");
    }

    // ============================================================
    // 9. Edge Cases
    // ============================================================

    function test_emptyPool_sharePrice() public {
        assertEq(vault.getSharePrice(), PRECISION);
    }

    function test_emptyPool_maxOI() public {
        assertEq(vault.getMaxOI(), 0);
    }

    function test_poolStats() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        uint256 totalSharesNow = vault.totalShares();
        uint256 depositFee = _depositFee(10 ether);

        vm.prank(matchingEngine);
        vault.settleTraderLoss{value: 2 ether}(2 ether);

        vm.prank(matchingEngine);
        vault.settleTraderProfit(trader1, 1 ether);

        vm.prank(matchingEngine);
        vault.collectFee{value: 0.5 ether}(0.5 ether);

        (
            uint256 poolValue,
            uint256 sharePrice,
            uint256 _totalShares,
            uint256 totalOI,
            uint256 maxOI,
            ,
            uint256 feesCollected,
            uint256 profitsPaid,
            uint256 lossesReceived,
        ) = vault.getPoolStats();

        assertEq(poolValue, 11.5 ether);                                 // 10 + 2 - 1 + 0.5
        assertEq(_totalShares, totalSharesNow);
        assertEq(sharePrice, (11.5 ether * PRECISION) / totalSharesNow); // dynamic
        assertEq(totalOI, 0);
        // maxOI = 11.5 * 80% = 9.2 ETH
        assertEq(maxOI, (11.5 ether * 8000) / 10000);
        assertEq(feesCollected, depositFee + 0.5 ether);
        assertEq(profitsPaid, 1 ether);
        assertEq(lossesReceived, 2 ether);
    }

    function test_withdrawalInfo() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        uint256 lp1Shares = vault.shares(lp1);
        uint256 halfShares = lp1Shares / 2;

        vm.prank(lp1);
        vault.requestWithdrawal(halfShares);

        (uint256 pendingShares, uint256 requestTime, uint256 executeAfter, uint256 estimatedETH) =
            vault.getWithdrawalInfo(lp1);

        assertEq(pendingShares, halfShares);
        assertGt(requestTime, 0);
        assertEq(executeAfter, requestTime + 24 hours);
        // estimatedETH = halfShares * sharePrice / PRECISION
        uint256 expectedETH = (halfShares * vault.getSharePrice()) / PRECISION;
        assertEq(estimatedETH, expectedETH);
    }

    // ============================================================
    // 10. Authorization Tests
    // ============================================================

    function test_unauthorized_settleProfit() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        vm.prank(lp1);
        vm.expectRevert(PerpVault.Unauthorized.selector);
        vault.settleTraderProfit(trader1, 1 ether);
    }

    function test_unauthorized_settleLoss() public {
        vm.prank(lp1);
        vm.expectRevert(PerpVault.Unauthorized.selector);
        vault.settleTraderLoss{value: 1 ether}(1 ether);
    }

    function test_unauthorized_increaseOI() public {
        vm.prank(lp1);
        vm.expectRevert(PerpVault.Unauthorized.selector);
        vault.increaseOI(tokenA, true, 1 ether);
    }

    function test_unauthorized_collectFee() public {
        vm.prank(lp1);
        vm.expectRevert(PerpVault.Unauthorized.selector);
        vault.collectFee{value: 1 ether}(1 ether);
    }

    // ============================================================
    // 11. Admin Tests
    // ============================================================

    function test_admin_setMaxOIPerToken() public {
        vm.prank(owner);
        vault.setMaxOIPerToken(tokenA, 50 ether);
        assertEq(vault.maxOIPerToken(tokenA), 50 ether);
    }

    function test_admin_emergencyRescue_timelock() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        // Step 1: Request rescue (starts 48h timelock)
        vm.prank(owner);
        vault.requestEmergencyRescue(owner, 5 ether);

        // Step 2: Cannot execute before timelock expires
        vm.prank(owner);
        vm.expectRevert(PerpVault.RescueTimelockActive.selector);
        vault.executeEmergencyRescue();

        // Step 3: Warp past timelock (48 hours)
        vm.warp(block.timestamp + 48 hours + 1);

        // Step 4: Execute rescue after timelock
        uint256 ownerBalanceBefore = owner.balance;
        vm.prank(owner);
        vault.executeEmergencyRescue();

        assertEq(owner.balance - ownerBalanceBefore, 5 ether);
    }

    function test_admin_emergencyRescue_cancel() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        // Request then cancel
        vm.prank(owner);
        vault.requestEmergencyRescue(owner, 5 ether);
        vm.prank(owner);
        vault.cancelEmergencyRescue();

        // Cannot execute cancelled rescue
        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(owner);
        vm.expectRevert(PerpVault.NoPendingRescue.selector);
        vault.executeEmergencyRescue();
    }

    function test_admin_pause_unpause() public {
        vm.prank(owner);
        vault.pause();

        vm.prank(lp1);
        vm.expectRevert();
        vault.deposit{value: 1 ether}();

        vm.prank(owner);
        vault.unpause();

        vm.prank(lp1);
        vault.deposit{value: 1 ether}();
        assertEq(vault.getPoolValue(), 1 ether);
    }

    // ============================================================
    // 12. Utilization View
    // ============================================================

    function test_utilization() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        vm.prank(matchingEngine);
        vault.increaseOI(tokenA, true, 4 ether);

        // 4/10 = 40% = 4000 bps
        assertEq(vault.getUtilization(), 4000);
    }

    // ============================================================
    // 13. NEW: Dead Shares — Inflation Attack Prevention
    // ============================================================

    function test_deadShares_preventInflationAttack() public {
        // Attacker deposits minimum
        vm.prank(lp1);
        vault.deposit{value: 0.01 ether}();

        // Attacker tries to inflate share price by sending ETH directly
        vm.deal(address(0x99), 100 ether);
        vm.prank(address(0x99));
        (bool success,) = address(vault).call{value: 100 ether}("");
        assertTrue(success, "Direct ETH send should succeed");

        // Now pool has ~100.01 ETH, shares = first deposit shares + dead shares
        // If no dead shares: attacker's shares ≈ 0.01e18, price ≈ 10000 ETH/share
        // With dead shares: attacker's shares ≈ 0.01e18 - 1000, dead = 1000
        // The share price is high but dead shares dilute the attack

        // Victim deposits 50 ETH → should get meaningful shares (not 0)
        vm.prank(lp2);
        vault.deposit{value: 50 ether}();

        uint256 lp2Shares = vault.shares(lp2);
        assertGt(lp2Shares, 0, "Victim must receive non-zero shares");

        // Victim's value should be close to what they deposited
        uint256 lp2Value = vault.getLPValue(lp2);
        assertGt(lp2Value, 49 ether, "Victim's value should be near deposit amount");
    }

    function test_deadShares_firstDepositMintsToDeadAddress() public {
        vm.prank(lp1);
        vault.deposit{value: 1 ether}();

        assertEq(vault.shares(vault.DEAD_ADDRESS()), DEAD_SHARES, "Dead shares minted to 0xdEaD");
        assertGt(vault.shares(lp1), 0, "LP still gets shares");
        assertEq(vault.totalShares(), vault.shares(lp1) + DEAD_SHARES, "Total = LP + dead");
    }

    // ============================================================
    // 14. NEW: Deposit-Time Cooldown (GMX-style)
    // ============================================================

    function test_cooldown_enforcedFromDepositTime() public {
        // LP deposits at T=0
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        uint256 lp1Shares = vault.shares(lp1);

        // LP requests withdrawal at T=12h
        vm.warp(block.timestamp + 12 hours);
        vm.prank(lp1);
        vault.requestWithdrawal(lp1Shares);

        // At T=12h + 24h+1 = 36h+1 from request, but only 36h+1 from deposit
        // Both cooldowns should be met
        vm.warp(block.timestamp + 24 hours + 1);

        vm.prank(lp1);
        vault.executeWithdrawal(); // Should succeed — both cooldowns met
        assertEq(vault.shares(lp1), 0);
    }

    function test_cooldown_depositTimePreventsQuickWithdraw() public {
        // LP deposits at T=0
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        uint256 lp1Shares = vault.shares(lp1);

        // LP immediately requests withdrawal at T=0
        vm.prank(lp1);
        vault.requestWithdrawal(lp1Shares);

        // Only advance 12 hours — deposit cooldown not met
        vm.warp(block.timestamp + 12 hours);

        vm.prank(lp1);
        vm.expectRevert(PerpVault.CooldownNotMet.selector);
        vault.executeWithdrawal();
    }

    function test_cooldown_newDepositResetsTimer() public {
        // Use absolute timestamps to avoid optimizer issues
        // T=1000: first deposit
        vm.warp(1000);
        vm.prank(lp1);
        vault.deposit{value: 5 ether}();

        // T=73000: second deposit (20h later), resets lastDepositAt
        vm.warp(73000);
        vm.prank(lp1);
        vault.deposit{value: 5 ether}();
        assertEq(vault.lastDepositAt(lp1), 73000, "lastDepositAt updated");

        uint256 lp1Shares = vault.shares(lp1);

        // Request withdrawal at T=73000
        vm.prank(lp1);
        vault.requestWithdrawal(lp1Shares);

        // T=145000: 20h after second deposit (72000s < 86400s cooldown) — should revert
        vm.warp(145000);
        vm.prank(lp1);
        vm.expectRevert(PerpVault.CooldownNotMet.selector);
        vault.executeWithdrawal();

        // T=160000: 24.16h after second deposit (87000s > 86400s cooldown) — should succeed
        vm.warp(160000);
        vm.prank(lp1);
        vault.executeWithdrawal();
        assertEq(vault.shares(lp1), 0);
    }

    // ============================================================
    // 15. NEW: Deposit/Withdrawal Fees
    // ============================================================

    function test_depositFee_deductedAndStaysInPool() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        // Deposit fee = 10 * 30 / 10000 = 0.03 ETH
        uint256 expectedFee = _depositFee(10 ether);
        assertEq(expectedFee, 0.03 ether);

        // Pool still has the full 10 ETH (fee stays in pool)
        assertEq(vault.getPoolValue(), 10 ether);

        // But LP got slightly fewer shares than 10e18
        // net = 9.97 ETH, shares = 9.97e18 - DEAD_SHARES
        uint256 expectedShares = _firstDepositShares(10 ether);
        assertEq(vault.shares(lp1), expectedShares);
        assertGt(vault.totalFeesCollected(), 0);
    }

    function test_withdrawalFee_deductedOnWithdraw() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        uint256 lp1Shares = vault.shares(lp1);

        vm.prank(lp1);
        vault.requestWithdrawal(lp1Shares);
        vm.warp(block.timestamp + 24 hours + 1);

        uint256 poolBefore = vault.getPoolValue();
        uint256 grossETH = (lp1Shares * vault.getSharePrice()) / PRECISION;
        uint256 expectedFee = _withdrawalFee(grossETH);

        uint256 balanceBefore = lp1.balance;
        vm.prank(lp1);
        vault.executeWithdrawal();

        uint256 received = lp1.balance - balanceBefore;
        // LP should receive gross - fee
        assertEq(received, grossETH - expectedFee, "Net withdrawal = gross - fee");
        // Fee stays in pool (for dead shares / future LPs)
    }

    // ============================================================
    // 16. NEW: Slippage Protection
    // ============================================================

    function test_depositWithSlippage_succeeds() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        uint256 totalSharesBefore = vault.totalShares();
        uint256 poolBefore = vault.getPoolValue();

        // Calculate expected shares for 5 ETH deposit
        uint256 net = _netDeposit(5 ether);
        uint256 expectedShares = (net * totalSharesBefore) / poolBefore;

        // Set minSharesOut slightly below expected
        vm.prank(lp2);
        vault.depositWithSlippage{value: 5 ether}(expectedShares - 1);

        assertEq(vault.shares(lp2), expectedShares, "Got expected shares");
    }

    function test_depositWithSlippage_reverts() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        // Ask for unreasonably high minimum shares
        vm.prank(lp2);
        vm.expectRevert(PerpVault.SlippageExceeded.selector);
        vault.depositWithSlippage{value: 5 ether}(100 ether);
    }

    function test_executeWithdrawalWithSlippage_succeeds() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        uint256 lp1Shares = vault.shares(lp1);

        vm.prank(lp1);
        vault.requestWithdrawal(lp1Shares);
        vm.warp(block.timestamp + 24 hours + 1);

        // Calculate expected net ETH
        uint256 grossETH = (lp1Shares * vault.getSharePrice()) / PRECISION;
        uint256 fee = _withdrawalFee(grossETH);
        uint256 expectedNet = grossETH - fee;

        vm.prank(lp1);
        vault.executeWithdrawalWithSlippage(expectedNet - 1);
        // Should succeed
        assertEq(vault.shares(lp1), 0);
    }

    function test_executeWithdrawalWithSlippage_reverts() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        uint256 lp1Shares = vault.shares(lp1);

        vm.prank(lp1);
        vault.requestWithdrawal(lp1Shares);
        vm.warp(block.timestamp + 24 hours + 1);

        // Ask for unreasonably high min ETH
        vm.prank(lp1);
        vm.expectRevert(PerpVault.SlippageExceeded.selector);
        vault.executeWithdrawalWithSlippage(100 ether);
    }

    // ============================================================
    // 17. NEW: OI Withdrawal Guard
    // ============================================================

    function test_withdrawal_blockedByActiveOI() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        uint256 lp1Shares = vault.shares(lp1);

        // Open 6 ETH of OI
        vm.prank(matchingEngine);
        vault.increaseOI(tokenA, true, 6 ether);

        // Request full withdrawal
        vm.prank(lp1);
        vault.requestWithdrawal(lp1Shares);
        vm.warp(block.timestamp + 24 hours + 1);

        // Execute should fail — pool after withdrawal < totalOI
        vm.prank(lp1);
        vm.expectRevert(PerpVault.InsufficientPoolForOI.selector);
        vault.executeWithdrawal();
    }

    function test_withdrawal_allowedAfterOIDecreased() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        uint256 lp1Shares = vault.shares(lp1);

        // Open 6 ETH of OI
        vm.prank(matchingEngine);
        vault.increaseOI(tokenA, true, 6 ether);

        // Request full withdrawal
        vm.prank(lp1);
        vault.requestWithdrawal(lp1Shares);
        vm.warp(block.timestamp + 24 hours + 1);

        // Decrease OI to 0
        vm.prank(matchingEngine);
        vault.decreaseOI(tokenA, true, 6 ether);

        // Now withdrawal should succeed
        vm.prank(lp1);
        vault.executeWithdrawal();
        assertEq(vault.shares(lp1), 0);
    }

    function test_withdrawal_partialAllowedWithOI() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        // Open 2 ETH of OI
        vm.prank(matchingEngine);
        vault.increaseOI(tokenA, true, 2 ether);

        // Withdraw small amount (pool after > OI)
        uint256 lp1Shares = vault.shares(lp1);
        uint256 smallWithdraw = lp1Shares / 10; // ~10% of shares

        vm.prank(lp1);
        vault.requestWithdrawal(smallWithdraw);
        vm.warp(block.timestamp + 24 hours + 1);

        // Should succeed — pool after withdrawal still > 2 ETH OI
        vm.prank(lp1);
        vault.executeWithdrawal();
    }

    // ============================================================
    // 18. NEW: OI Accumulator Correctness
    // ============================================================

    function test_OIAccumulator_tracksCorrectly() public {
        vm.prank(lp1);
        vault.deposit{value: 100 ether}();

        // Increase OI across multiple tokens
        vm.prank(matchingEngine);
        vault.increaseOI(tokenA, true, 3 ether);
        assertEq(vault.totalOIAccumulator(), 3 ether);

        vm.prank(matchingEngine);
        vault.increaseOI(tokenA, false, 2 ether);
        assertEq(vault.totalOIAccumulator(), 5 ether);

        vm.prank(matchingEngine);
        vault.increaseOI(tokenB, true, 4 ether);
        assertEq(vault.totalOIAccumulator(), 9 ether);

        // Decrease some
        vm.prank(matchingEngine);
        vault.decreaseOI(tokenA, true, 1 ether);
        assertEq(vault.totalOIAccumulator(), 8 ether);

        vm.prank(matchingEngine);
        vault.decreaseOI(tokenB, true, 4 ether);
        assertEq(vault.totalOIAccumulator(), 4 ether);

        // Verify getTotalOI uses accumulator
        assertEq(vault.getTotalOI(), 4 ether);

        // Verify per-token OI is correct
        (uint256 aLong, uint256 aShort) = vault.getTokenOI(tokenA);
        assertEq(aLong, 2 ether);
        assertEq(aShort, 2 ether);

        (uint256 bLong, uint256 bShort) = vault.getTokenOI(tokenB);
        assertEq(bLong, 0);
        assertEq(bShort, 0);
    }

    // ============================================================
    // 19. NEW: lastDepositAt tracking
    // ============================================================

    function test_lastDepositAt_setOnDeposit() public {
        uint256 depositTime = block.timestamp + 100;
        vm.warp(depositTime);

        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        assertEq(vault.lastDepositAt(lp1), depositTime);
    }

    function test_lastDepositAt_updatedOnSecondDeposit() public {
        vm.prank(lp1);
        vault.deposit{value: 5 ether}();

        uint256 firstDepositTime = vault.lastDepositAt(lp1);

        vm.warp(block.timestamp + 1 hours);

        vm.prank(lp1);
        vault.deposit{value: 5 ether}();

        assertGt(vault.lastDepositAt(lp1), firstDepositTime, "Updated on second deposit");
    }

    // ============================================================
    // 20. NEW: C1 — netPendingPnL affects pool value & share price
    // ============================================================

    function test_C1_updatePendingPnL_positiveReducesPoolValue() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        // Traders in net profit → pool value decreases
        vm.prank(matchingEngine);
        vault.updatePendingPnL(2 ether);

        assertEq(vault.netPendingPnL(), 2 ether);
        assertEq(vault.getPoolValue(), 8 ether, "Pool value reduced by pending PnL");
        assertEq(vault.getRawBalance(), 10 ether, "Raw balance unchanged");
    }

    function test_C1_updatePendingPnL_negativeIncreasesPoolValue() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        // Traders in net loss → pool value increases
        vm.prank(matchingEngine);
        vault.updatePendingPnL(-3 ether);

        assertEq(vault.getPoolValue(), 13 ether, "Pool value increased by trader losses");
    }

    function test_C1_updatePendingPnL_affectsSharePrice() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        uint256 priceBefore = vault.getSharePrice();

        // Traders profit → share price drops
        vm.prank(matchingEngine);
        vault.updatePendingPnL(5 ether);

        uint256 priceAfter = vault.getSharePrice();
        assertLt(priceAfter, priceBefore, "Share price decreases when traders profit");
    }

    function test_C1_updatePendingPnL_protectsFromFrontrunDeposit() public {
        // LP1 deposits first
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        // Matching engine reports traders are losing 5 ETH (will flow to pool on settlement)
        vm.prank(matchingEngine);
        vault.updatePendingPnL(-5 ether);

        // LP2 deposits — should get fewer shares because pool value is higher
        vm.prank(lp2);
        vault.deposit{value: 10 ether}();

        // LP2 should have fewer shares than LP1 because pool value was 15 ETH at deposit time
        assertLt(vault.shares(lp2), vault.shares(lp1), "LP2 gets fewer shares due to PnL");
    }

    function test_C1_poolValueFlooredAtZero() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        // Massive trader profit exceeds pool balance
        vm.prank(matchingEngine);
        vault.updatePendingPnL(20 ether);

        assertEq(vault.getPoolValue(), 0, "Pool value floored at 0");
        assertEq(vault.getSharePrice(), 0, "Share price 0 when pool value 0");
    }

    function test_C1_onlyAuthorizedCanUpdatePnL() public {
        vm.prank(lp1);
        vm.expectRevert(PerpVault.Unauthorized.selector);
        vault.updatePendingPnL(1 ether);
    }

    function test_C1_pnlEmitsEvent() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        vm.prank(matchingEngine);
        vm.expectEmit(false, false, false, true);
        emit PerpVault.PendingPnLUpdated(0, 3 ether);
        vault.updatePendingPnL(3 ether);
    }

    function test_C1_maxOI_usesPnLAdjustedValue() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        // maxOI = 80% of pool value
        uint256 maxOIBefore = vault.getMaxOI();
        assertEq(maxOIBefore, 8 ether); // 80% of 10

        // Traders profiting → pool value shrinks → maxOI shrinks
        vm.prank(matchingEngine);
        vault.updatePendingPnL(5 ether);

        uint256 maxOIAfter = vault.getMaxOI();
        assertEq(maxOIAfter, 4 ether); // 80% of 5
    }

    // ============================================================
    // 21. NEW: C2 — ADL mechanism
    // ============================================================

    function test_C2_shouldADL_falseWhenTradersLosing() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        vm.prank(matchingEngine);
        vault.updatePendingPnL(-5 ether); // traders losing

        (bool trigger,) = vault.shouldADL();
        assertFalse(trigger, "No ADL when traders losing");
    }

    function test_C2_shouldADL_falseWhenBelowThreshold() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        vm.prank(matchingEngine);
        vault.updatePendingPnL(5 ether); // 50% of balance, below 90% threshold

        (bool trigger, uint256 bps) = vault.shouldADL();
        assertFalse(trigger, "No ADL at 50%");
        assertEq(bps, 5000, "PnL to pool ratio = 50%");
    }

    function test_C2_shouldADL_trueWhenAboveThreshold() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        vm.prank(matchingEngine);
        vault.updatePendingPnL(9.5 ether); // 95% of balance

        (bool trigger, uint256 bps) = vault.shouldADL();
        assertTrue(trigger, "ADL triggered at 95%");
        assertEq(bps, 9500, "PnL to pool ratio = 95%");
    }

    function test_C2_settleProfit_partialWhenInsufficient() public {
        vm.prank(lp1);
        vault.deposit{value: 5 ether}();

        // Try to settle 10 ETH but pool only has 5
        uint256 traderBalBefore = trader1.balance;
        vm.prank(matchingEngine);
        vault.settleTraderProfit(trader1, 10 ether);

        assertEq(address(vault).balance, 0, "Pool fully drained");
        assertEq(trader1.balance - traderBalBefore, 5 ether, "Trader got partial payment");
    }

    function test_C2_extendedStats() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        vm.prank(matchingEngine);
        vault.updatePendingPnL(3 ether);

        (
            int256 pnl,
            uint256 rawBal,
            uint256 cooldown,
            uint256 maxPV,
            bool depPaused,
            bool adlNeeded,
            uint256 adlBps
        ) = vault.getExtendedStats();

        assertEq(pnl, 3 ether);
        assertEq(rawBal, 10 ether);
        assertEq(cooldown, 24 hours);
        assertEq(maxPV, 0);
        assertFalse(depPaused);
        assertFalse(adlNeeded);
        assertEq(adlBps, 3000);
    }

    // ============================================================
    // 22. NEW: H1 — Configurable cooldown
    // ============================================================

    function test_H1_setCooldown() public {
        vm.prank(owner);
        vault.setCooldown(48 hours);
        assertEq(vault.withdrawalCooldown(), 48 hours);
    }

    function test_H1_setCooldown_revertExceedsMax() public {
        vm.prank(owner);
        vm.expectRevert(PerpVault.CooldownTooLong.selector);
        vault.setCooldown(8 days); // exceeds MAX_COOLDOWN (7 days)
    }

    function test_H1_setCooldown_onlyOwner() public {
        vm.prank(lp1);
        vm.expectRevert();
        vault.setCooldown(48 hours);
    }

    function test_H1_longerCooldown_enforcedOnWithdrawal() public {
        // Set 3 day cooldown
        vm.prank(owner);
        vault.setCooldown(3 days);

        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        uint256 sharesLp1 = vault.shares(lp1);
        vm.prank(lp1);
        vault.requestWithdrawal(sharesLp1);

        // Try after 24h — should fail
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(lp1);
        vm.expectRevert(PerpVault.CooldownNotMet.selector);
        vault.executeWithdrawal();

        // Try after 3 days — should succeed
        vm.warp(block.timestamp + 3 days);
        vm.prank(lp1);
        vault.executeWithdrawal();
    }

    function test_H1_zeroCooldown_instantWithdrawal() public {
        vm.prank(owner);
        vault.setCooldown(0);

        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        uint256 sharesLp1 = vault.shares(lp1);
        vm.prank(lp1);
        vault.requestWithdrawal(sharesLp1);

        // Can execute immediately
        vm.prank(lp1);
        vault.executeWithdrawal();
        assertEq(vault.shares(lp1), 0);
    }

    // ============================================================
    // 23. NEW: H2 — Deposit cap / pause
    // ============================================================

    function test_H2_depositsPaused_reverts() public {
        vm.prank(owner);
        vault.setDepositsPaused(true);

        vm.prank(lp1);
        vm.expectRevert(PerpVault.DepositsPausedError.selector);
        vault.deposit{value: 10 ether}();
    }

    function test_H2_depositsPaused_canUnpause() public {
        vm.prank(owner);
        vault.setDepositsPaused(true);

        vm.prank(owner);
        vault.setDepositsPaused(false);

        vm.prank(lp1);
        vault.deposit{value: 10 ether}(); // should succeed
        assertGt(vault.shares(lp1), 0);
    }

    function test_H2_maxPoolValue_reverts() public {
        vm.prank(owner);
        vault.setMaxPoolValue(5 ether);

        vm.prank(lp1);
        vault.deposit{value: 4 ether}(); // OK, under cap

        vm.prank(lp2);
        vm.expectRevert(PerpVault.ExceedsMaxPoolValue.selector);
        vault.deposit{value: 4 ether}(); // Would exceed 5 ETH cap
    }

    function test_H2_maxPoolValue_zeroMeansUnlimited() public {
        vm.prank(owner);
        vault.setMaxPoolValue(0);

        vm.prank(lp1);
        vault.deposit{value: 100 ether}(); // No limit
        assertGt(vault.shares(lp1), 0);
    }

    function test_H2_maxPoolValue_onlyOwner() public {
        vm.prank(lp1);
        vm.expectRevert();
        vault.setMaxPoolValue(5 ether);
    }

    function test_H2_depositsPaused_onlyOwner() public {
        vm.prank(lp1);
        vm.expectRevert();
        vault.setDepositsPaused(true);
    }

    function test_H2_depositsPaused_withdrawalStillWorks() public {
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        vm.prank(owner);
        vault.setDepositsPaused(true);

        // Withdrawal should still work even when deposits are paused
        uint256 sharesLp1 = vault.shares(lp1);
        vm.prank(lp1);
        vault.requestWithdrawal(sharesLp1);

        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(lp1);
        vault.executeWithdrawal();
    }

    // ============================================================
    // 24. NEW: Integration — PnL affects new deposits fairly
    // ============================================================

    function test_integration_depositWithPositivePnL() public {
        // LP1 deposits 10 ETH
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();
        uint256 lp1Shares = vault.shares(lp1);

        // Traders in profit by 5 ETH → pool value = 10 - 5 = 5 ETH
        vm.prank(matchingEngine);
        vault.updatePendingPnL(5 ether);

        // LP2 deposits 5 ETH → should get SAME shares as LP1 has
        // because pool value before = 5 ETH, LP2 deposits 5 ETH (net of fee)
        vm.prank(lp2);
        vault.deposit{value: 5 ether}();
        uint256 lp2Shares = vault.shares(lp2);

        // LP2 deposits ~5 ETH into a ~5 ETH pool, so should get roughly same shares as existing
        // (minus fees, which also apply to LP1)
        uint256 lp2Value = (lp2Shares * vault.getSharePrice()) / PRECISION;
        uint256 lp1Value = (lp1Shares * vault.getSharePrice()) / PRECISION;

        // LP1 value should be around 5 ETH (pool shrunk due to trader profit)
        // LP2 value should be around 5 ETH (deposited into reduced pool)
        // Both should be approximately equal
        assertApproxEqRel(lp1Value, lp2Value, 0.05e18, "Fair distribution with PnL");
    }

    function test_integration_withdrawalWithNegativePnL() public {
        // LP1 deposits 10 ETH
        vm.prank(lp1);
        vault.deposit{value: 10 ether}();

        // Traders losing 5 ETH → pool value = 10 + 5 = 15 ETH
        vm.prank(matchingEngine);
        vault.updatePendingPnL(-5 ether);

        // Share price should reflect the increased pool value
        uint256 lpValue = vault.getLPValue(lp1);
        // LP1 value should be close to 15 ETH (pool value increased)
        assertGt(lpValue, 12 ether, "LP value increased due to trader losses");
    }
}
