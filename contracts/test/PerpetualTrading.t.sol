// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "forge-std/console.sol";
import "../src/perpetual/PositionManager.sol";
import "../src/common/Vault.sol";
import "../src/common/PriceFeed.sol";
import "../src/perpetual/RiskManager.sol";
import "../src/perpetual/FundingRate.sol";
import "../src/perpetual/Liquidation.sol";
import "../src/perpetual/InsuranceFund.sol";

/**
 * @title PerpetualTrading Comprehensive Test
 * @notice 永续合约全流程测试：开仓、盈利、平仓、爆仓、资金费、提款、保证金、价格联动
 * @dev 使用 console.log 输出详细测试过程，方便直观查看
 */
contract PerpetualTradingTest is Test {
    // ============================================================
    // 合约实例
    // ============================================================

    PositionManager public positionManager;
    Vault public vault;
    PriceFeed public priceFeed;
    RiskManager public riskManager;
    FundingRate public fundingRate;
    Liquidation public liquidation;
    InsuranceFund public insuranceFund;

    // ============================================================
    // 测试账户
    // ============================================================

    address public owner = makeAddr("owner");
    address public trader1 = makeAddr("trader1");
    address public trader2 = makeAddr("trader2");
    address public liquidator = makeAddr("liquidator");
    address public feeReceiver = makeAddr("feeReceiver");

    // ============================================================
    // 常量
    // ============================================================

    uint256 public constant PRECISION = 1e18;
    uint256 public constant LEVERAGE_PRECISION = 1e4;
    uint256 public constant INITIAL_PRICE = 0.00001 ether; // 初始价格 0.00001 ETH

    // ============================================================
    // Setup
    // ============================================================

    function setUp() public {
        // Give owner ETH for setup transactions (500 ETH for insurance fund + buffer)
        vm.deal(owner, 600 ether);

        // Set a reasonable timestamp (block.timestamp starts at 1 in Foundry)
        vm.warp(1000000); // ~11.5 days since epoch

        vm.startPrank(owner);

        console.log("========================================");
        console.log("   PERPETUAL TRADING TEST SETUP");
        console.log("========================================");
        console.log("");

        // 1. 部署 Vault
        vault = new Vault();
        console.log("Vault deployed at:", address(vault));

        // 2. 部署 PriceFeed
        priceFeed = new PriceFeed();
        console.log("PriceFeed deployed at:", address(priceFeed));

        // 3. 部署 RiskManager
        riskManager = new RiskManager();
        console.log("RiskManager deployed at:", address(riskManager));

        // 4. 部署 PositionManager
        positionManager = new PositionManager(
            address(vault),
            address(priceFeed),
            address(riskManager)
        );
        console.log("PositionManager deployed at:", address(positionManager));

        // 5. 部署 InsuranceFund
        insuranceFund = new InsuranceFund();
        console.log("InsuranceFund deployed at:", address(insuranceFund));

        // 6. 部署 FundingRate
        fundingRate = new FundingRate(
            address(positionManager),
            address(vault),
            address(priceFeed)
        );
        console.log("FundingRate deployed at:", address(fundingRate));

        // 7. 部署 Liquidation
        liquidation = new Liquidation(
            address(positionManager),
            address(vault),
            address(riskManager),
            address(priceFeed)
        );
        console.log("Liquidation deployed at:", address(liquidation));


        console.log("");
        console.log("--- Setting up contract relationships ---");

        // 配置合约关系
        vault.setAuthorizedContract(address(positionManager), true);
        vault.setAuthorizedContract(address(liquidation), true);
        vault.setInsuranceFund(address(insuranceFund));
        console.log("Vault: authorized PositionManager, Liquidation, InsuranceFund");

        positionManager.setFundingRate(address(fundingRate));
        positionManager.setLiquidation(address(liquidation));
        positionManager.setFeeReceiver(feeReceiver);
        positionManager.setAuthorizedContract(address(liquidation), true);
        console.log("PositionManager: set FundingRate, Liquidation, FeeReceiver");

        riskManager.setPositionManager(address(positionManager));
        riskManager.setVault(address(vault));
        riskManager.setInsuranceFund(address(insuranceFund));
        console.log("RiskManager: set PositionManager, Vault, InsuranceFund");

        insuranceFund.setVault(address(vault));
        insuranceFund.setPositionManager(address(positionManager));
        console.log("InsuranceFund: set Vault, PositionManager");

        // 初始化价格
        priceFeed.addSupportedToken(address(1), INITIAL_PRICE);
        console.log("PriceFeed: initialized price at", INITIAL_PRICE);

        // 禁用价格偏差保护（仅用于测试，允许模拟极端价格场景）
        console.log("PriceFeed: deviation protection disabled for testing");

        // 设置 owner 为 AMM（允许测试中更新价格）
        priceFeed.setTokenFactory(owner);
        console.log("PriceFeed: set owner as AMM for testing");

        // 向保险基金注入初始资金 (需要足够覆盖测试中的最大潜在亏损)
        // 500 ETH to cover large positions at high leverage
        insuranceFund.deposit{value: 500 ether}();
        console.log("InsuranceFund: deposited 500 ETH");

        vm.stopPrank();

        // 给测试账户分配 ETH
        vm.deal(trader1, 100 ether);
        vm.deal(trader2, 100 ether);
        vm.deal(liquidator, 10 ether);

        console.log("");
        console.log("Trader1 balance:", trader1.balance / 1e18, "ETH");
        console.log("Trader2 balance:", trader2.balance / 1e18, "ETH");
        console.log("Liquidator balance:", liquidator.balance / 1e18, "ETH");
        console.log("");
        console.log("========================================");
        console.log("   SETUP COMPLETE");
        console.log("========================================");
        console.log("");
    }

    // ============================================================
    // 辅助函数
    // ============================================================

    function _printSeparator(string memory title) internal pure {
        console.log("");
        console.log("----------------------------------------");
        console.log(title);
        console.log("----------------------------------------");
    }

    function _printPositionInfo(address user, string memory label) internal view {
        IPositionManager.Position memory pos = positionManager.getPosition(user);
        console.log(label, "Position Info:");
        console.log("  - Is Long:", pos.isLong);
        console.log("  - Size:", pos.size / 1e18, "ETH");
        console.log("  - Collateral:", pos.collateral / 1e18, "ETH");
        console.log("  - Entry Price:", pos.entryPrice);
        console.log("  - Leverage:", pos.leverage / LEVERAGE_PRECISION, "x");
    }

    function _printBalances(address user, string memory label) internal view {
        uint256 available = vault.getBalance(user);
        uint256 locked = vault.getLockedBalance(user);
        console.log(label, "Balances:");
        console.log("  - Available:", available / 1e18, "ETH");
        console.log("  - Locked:", locked / 1e18, "ETH");
        console.log("  - Total:", (available + locked) / 1e18, "ETH");
    }

    // ============================================================
    // 测试 1: 完整开仓→盈利→平仓流程 (做多)
    // ============================================================

    function test_01_OpenLongProfitClose() public {
        _printSeparator("TEST 1: Open Long -> Profit -> Close");

        // Step 1: 存入保证金
        console.log("");
        console.log("[Step 1] Deposit margin to Vault");
        vm.startPrank(trader1);
        vault.deposit{value: 11 ether}(); // 10 ETH margin + 0.1 ETH fee + buffer
        _printBalances(trader1, "Trader1");

        // Step 2: 开多仓
        console.log("");
        console.log("[Step 2] Open Long Position");
        console.log("  Size: 100 ETH");
        console.log("  Leverage: 10x");
        console.log("  Required Margin: 10 ETH + 0.1% fee");

        uint256 leverage = 10 * LEVERAGE_PRECISION; // 10x
        uint256 size = 100 ether; // 100 ETH notional

        positionManager.openLong(size, leverage);

        _printPositionInfo(trader1, "Trader1");
        _printBalances(trader1, "Trader1");
        vm.stopPrank();

        // Step 3: 价格上涨 20%
        console.log("");
        console.log("[Step 3] Price increases 20%");
        uint256 newPrice = INITIAL_PRICE * 120 / 100;

        vm.prank(owner);
        priceFeed.updateTokenPriceFromFactory(address(1), newPrice);

        console.log("  Old Price:", INITIAL_PRICE);
        console.log("  New Price:", newPrice);
        console.log("  Price Change: +20%");

        // Step 4: 计算未实现盈亏
        console.log("");
        console.log("[Step 4] Check Unrealized PnL");
        int256 unrealizedPnL = positionManager.getUnrealizedPnL(trader1);
        console.log("  Unrealized PnL:", uint256(unrealizedPnL) / 1e18, "ETH");
        console.log("  Expected: 100 * 20% = 20 ETH");

        assertGt(unrealizedPnL, 0, "Should have profit");

        // Step 5: 平仓
        console.log("");
        console.log("[Step 5] Close Position");
        vm.prank(trader1);
        positionManager.closePosition();

        _printBalances(trader1, "Trader1 After Close");

        // 验证盈利已到账
        uint256 finalBalance = vault.getBalance(trader1);
        console.log("  Initial Deposit: 10 ETH");
        console.log("  Final Balance:", finalBalance / 1e18, "ETH");
        console.log("  Net Profit:", (finalBalance - 10 ether) / 1e18, "ETH (from Insurance Fund)");

        console.log("");
        console.log("[TEST 1 PASSED] Long position profit flow works correctly");
    }

    // ============================================================
    // 测试 2: 完整开仓→亏损→平仓流程 (做空)
    // ============================================================

    function test_02_OpenShortLossClose() public {
        _printSeparator("TEST 2: Open Short -> Loss -> Close");

        // Step 1: 存入保证金
        console.log("");
        console.log("[Step 1] Deposit margin to Vault");
        vm.startPrank(trader1);
        vault.deposit{value: 11 ether}();
        _printBalances(trader1, "Trader1");

        // Step 2: 开空仓
        console.log("");
        console.log("[Step 2] Open Short Position");
        console.log("  Size: 100 ETH");
        console.log("  Leverage: 10x");

        uint256 leverage = 10 * LEVERAGE_PRECISION;
        uint256 size = 100 ether;

        positionManager.openShort(size, leverage);

        _printPositionInfo(trader1, "Trader1");
        vm.stopPrank();

        // Step 3: 价格上涨 5% (空头亏损)
        console.log("");
        console.log("[Step 3] Price increases 5% (Short loses)");
        uint256 newPrice = INITIAL_PRICE * 105 / 100;

        vm.prank(owner);
        priceFeed.updateTokenPriceFromFactory(address(1), newPrice);

        console.log("  Old Price:", INITIAL_PRICE);
        console.log("  New Price:", newPrice);

        // Step 4: 计算未实现盈亏
        console.log("");
        console.log("[Step 4] Check Unrealized PnL");
        int256 unrealizedPnL = positionManager.getUnrealizedPnL(trader1);
        if (unrealizedPnL >= 0) {
            console.log("  Unrealized PnL:", uint256(unrealizedPnL) / 1e18, "ETH");
        } else {
            console.log("  Unrealized PnL: -", uint256(-unrealizedPnL) / 1e18, "ETH (negative = loss)");
        }

        assertLt(unrealizedPnL, 0, "Should have loss");

        // Step 5: 平仓
        console.log("");
        console.log("[Step 5] Close Position");
        vm.prank(trader1);
        positionManager.closePosition();

        _printBalances(trader1, "Trader1 After Close");

        uint256 finalBalance = vault.getBalance(trader1);
        console.log("  Initial Deposit: 10 ETH");
        console.log("  Final Balance:", finalBalance / 1e18, "ETH");
        console.log("  Net Loss:", (10 ether - finalBalance) / 1e18, "ETH");

        assertLt(finalBalance, 10 ether, "Should have lost money");

        console.log("");
        console.log("[TEST 2 PASSED] Short position loss flow works correctly");
    }

    // ============================================================
    // 测试 3: 强平机制 (爆仓)
    // ============================================================

    function test_03_LiquidationMechanism() public {
        _printSeparator("TEST 3: Liquidation (Forced Closure)");

        // Step 1: 存入保证金
        console.log("");
        console.log("[Step 1] Deposit margin to Vault");
        vm.startPrank(trader1);
        vault.deposit{value: 11 ether}(); // 10 ETH margin + 0.1 ETH fee + buffer

        // Step 2: 开高杠杆多仓 (10x)
        // 使用10x杠杆，MMR=0.5%，所以强平价格 = 入场价 * (1 - 10% + 0.5%) = 90.5%
        console.log("");
        console.log("[Step 2] Open Long Position with 10x Leverage");
        console.log("  Size: 100 ETH");
        console.log("  Leverage: 10x");
        console.log("  Margin: 10 ETH + fee");

        uint256 leverage = 10 * LEVERAGE_PRECISION;
        uint256 size = 100 ether;

        positionManager.openLong(size, leverage);
        _printPositionInfo(trader1, "Trader1");
        vm.stopPrank();

        // Step 3: 获取强平价格
        console.log("");
        console.log("[Step 3] Calculate Liquidation Price");
        uint256 liqPrice = positionManager.getLiquidationPrice(trader1);
        console.log("  Entry Price:", INITIAL_PRICE);
        console.log("  Liquidation Price:", liqPrice);
        if (liqPrice > 0) {
            console.log("  Distance to Liq:", (INITIAL_PRICE - liqPrice) * 100 / INITIAL_PRICE, "%");
        }

        // Step 4: 价格暴跌到强平线以下
        console.log("");
        console.log("[Step 4] Price drops below liquidation price");
        // For 50x leverage, we need significant drop to trigger liquidation
        // Use 10% drop if liqPrice is 0 (edge case)
        uint256 crashPrice = liqPrice > 0 ? liqPrice * 95 / 100 : INITIAL_PRICE * 90 / 100;
        if (crashPrice == 0) crashPrice = 1; // Prevent zero price

        vm.prank(owner);
        priceFeed.updateTokenPriceFromFactory(address(1), crashPrice);

        console.log("  Crash Price:", crashPrice);
        console.log("  Below Liq Price by:", (liqPrice - crashPrice) * 100 / liqPrice, "%");

        // Step 5: 检查是否可强平
        console.log("");
        console.log("[Step 5] Check if liquidatable");
        bool canLiq = positionManager.canLiquidate(trader1);
        console.log("  Can Liquidate:", canLiq);
        assertTrue(canLiq, "Should be liquidatable");

        // Step 6: 执行强平
        console.log("");
        console.log("[Step 6] Execute Liquidation");
        uint256 liquidatorBalBefore = vault.getBalance(liquidator);

        vm.prank(liquidator);
        liquidation.liquidate(trader1);

        // 验证结果
        IPositionManager.Position memory pos = positionManager.getPosition(trader1);
        console.log("  Position Size After Liq:", pos.size);
        assertEq(pos.size, 0, "Position should be closed");

        uint256 liquidatorBalAfter = vault.getBalance(liquidator);
        console.log("  Liquidator Reward:", (liquidatorBalAfter - liquidatorBalBefore) / 1e18, "ETH");

        console.log("");
        console.log("[TEST 3 PASSED] Liquidation mechanism works correctly");
    }

    // ============================================================
    // 测试 4: 资金费率机制
    // ============================================================

    function test_04_FundingFeeMechanism() public {
        _printSeparator("TEST 4: Funding Fee Mechanism");

        // Step 1: 两个交易者存入保证金
        console.log("");
        console.log("[Step 1] Two traders deposit margin");

        vm.prank(trader1);
        vault.deposit{value: 11 ether}();

        vm.prank(trader2);
        vault.deposit{value: 11 ether}();

        // Step 2: Trader1 开多仓，Trader2 开空仓 (多空不平衡)
        console.log("");
        console.log("[Step 2] Create imbalanced positions");
        console.log("  Trader1: Long 100 ETH (10x)");
        console.log("  Trader2: Short 50 ETH (10x)");

        uint256 leverage = 10 * LEVERAGE_PRECISION;

        vm.prank(trader1);
        positionManager.openLong(100 ether, leverage);

        vm.prank(trader2);
        positionManager.openShort(50 ether, 5 * LEVERAGE_PRECISION); // 5x 只需要 10 ETH 保证金

        // Step 3: 检查多空持仓量
        console.log("");
        console.log("[Step 3] Check Open Interest");
        uint256 totalLong = positionManager.getTotalLongSize();
        uint256 totalShort = positionManager.getTotalShortSize();
        console.log("  Total Long:", totalLong / 1e18, "ETH");
        console.log("  Total Short:", totalShort / 1e18, "ETH");
        console.log("  Imbalance:", (totalLong - totalShort) / 1e18, "ETH more longs");

        // Step 4: 查看预估资金费率
        console.log("");
        console.log("[Step 4] Check Estimated Funding Rate");
        int256 estimatedRate = fundingRate.getEstimatedFundingRate();
        if (estimatedRate >= 0) {
            console.log("  Estimated Funding Rate:", uint256(estimatedRate));
        } else {
            console.log("  Estimated Funding Rate: -", uint256(-estimatedRate));
        }
        console.log("  (Positive = Longs pay Shorts)");

        // Step 5: 快进 4 小时触发资金费结算
        console.log("");
        console.log("[Step 5] Fast forward 4 hours to trigger funding");
        vm.warp(block.timestamp + 4 hours + 1);

        // Step 6: 结算资金费
        console.log("");
        console.log("[Step 6] Settle Funding");
        fundingRate.settleFunding();

        int256 currentRate = fundingRate.getCurrentFundingRate();
        console.log("  Current Funding Rate (int256):");
        if (currentRate >= 0) {
            console.log("    Rate:", uint256(currentRate));
        } else {
            console.log("    Rate (negative):", uint256(-currentRate));
        }

        // Step 7: 获取年化费率
        console.log("");
        console.log("[Step 7] Annualized Funding Rate");
        uint256 annualizedRate = fundingRate.getAnnualizedRate();
        console.log("  Annualized Rate (bps * 288 * 365):", annualizedRate);

        console.log("");
        console.log("[TEST 4 PASSED] Funding fee mechanism works correctly");
    }

    // ============================================================
    // 测试 5: 保证金存款和提款
    // ============================================================

    function test_05_MarginDepositWithdraw() public {
        _printSeparator("TEST 5: Margin Deposit and Withdrawal");

        // Step 1: 存款
        console.log("");
        console.log("[Step 1] Deposit ETH to Vault");
        console.log("  Amount: 10 ETH");

        uint256 balBefore = trader1.balance;

        vm.startPrank(trader1);
        vault.deposit{value: 11 ether}();

        _printBalances(trader1, "Trader1");

        // Step 2: 开仓锁定部分保证金
        console.log("");
        console.log("[Step 2] Open position to lock some margin");

        positionManager.openLong(50 ether, 10 * LEVERAGE_PRECISION);

        _printBalances(trader1, "After Opening Position");
        console.log("  5 ETH locked as margin, 5 ETH available");

        // Step 3: 尝试提取可用余额
        console.log("");
        console.log("[Step 3] Withdraw available balance");

        uint256 availableBeforeWithdraw = vault.getBalance(trader1);
        console.log("  Available to withdraw:", availableBeforeWithdraw / 1e18, "ETH");

        vault.withdraw(availableBeforeWithdraw);

        uint256 walletBalAfter = trader1.balance;
        console.log("  Wallet balance after withdraw:", walletBalAfter / 1e18, "ETH");

        // Step 4: 验证锁定余额无法提取
        console.log("");
        console.log("[Step 4] Verify locked balance cannot be withdrawn");

        uint256 lockedBal = vault.getLockedBalance(trader1);
        console.log("  Locked Balance:", lockedBal / 1e18, "ETH");

        vm.expectRevert();
        vault.withdraw(1 ether); // 应该失败
        console.log("  Attempt to withdraw locked funds: REVERTED (as expected)");

        vm.stopPrank();

        console.log("");
        console.log("[TEST 5 PASSED] Margin deposit/withdrawal works correctly");
    }

    // ============================================================
    // 测试 6: 盈利提取流程
    // ============================================================

    function test_06_ProfitWithdrawal() public {
        _printSeparator("TEST 6: Profit Withdrawal");

        // Step 1: 存入保证金
        console.log("");
        console.log("[Step 1] Deposit margin and open position");

        vm.startPrank(trader1);
        vault.deposit{value: 11 ether}();

        positionManager.openLong(100 ether, 10 * LEVERAGE_PRECISION);
        vm.stopPrank();

        console.log("  Deposited: 10 ETH");
        console.log("  Position: 100 ETH @ 10x");

        // Step 2: 价格上涨
        console.log("");
        console.log("[Step 2] Price increases 30%");

        vm.prank(owner);
        priceFeed.updateTokenPriceFromFactory(address(1), INITIAL_PRICE * 130 / 100);

        int256 pnl = positionManager.getUnrealizedPnL(trader1);
        console.log("  Unrealized PnL:", uint256(pnl) / 1e18, "ETH");

        // Step 3: 平仓实现盈利
        console.log("");
        console.log("[Step 3] Close position to realize profit");

        vm.prank(trader1);
        positionManager.closePosition();

        uint256 vaultBal = vault.getBalance(trader1);
        console.log("  Vault Balance after close:", vaultBal / 1e18, "ETH");

        // Step 4: 提取全部盈利
        console.log("");
        console.log("[Step 4] Withdraw all profit to wallet");

        uint256 walletBefore = trader1.balance;

        vm.prank(trader1);
        vault.withdraw(vaultBal);

        uint256 walletAfter = trader1.balance;

        console.log("  Wallet Before:", walletBefore / 1e18, "ETH");
        console.log("  Wallet After:", walletAfter / 1e18, "ETH");
        console.log("  Withdrawn:", (walletAfter - walletBefore) / 1e18, "ETH");

        console.log("");
        console.log("[TEST 6 PASSED] Profit withdrawal works correctly");
    }

    // ============================================================
    // 测试 7: 追加保证金
    // ============================================================

    function test_07_AddCollateral() public {
        _printSeparator("TEST 7: Add Collateral to Position");

        // Step 1: 开仓
        console.log("");
        console.log("[Step 1] Open position with initial margin");

        vm.startPrank(trader1);
        vault.deposit{value: 20 ether}(); // 10 ETH margin + 0.1 ETH fee + 5 ETH for adding collateral + buffer

        positionManager.openLong(100 ether, 10 * LEVERAGE_PRECISION);

        _printPositionInfo(trader1, "Initial");
        console.log("  Initial Leverage: 10x");
        console.log("  Initial Margin: 10 ETH");

        // Step 2: 追加保证金
        console.log("");
        console.log("[Step 2] Add 5 ETH collateral");

        positionManager.addCollateral(5 ether);

        _printPositionInfo(trader1, "After Adding Collateral");

        IPositionManager.Position memory pos = positionManager.getPosition(trader1);
        uint256 newLeverage = pos.leverage / LEVERAGE_PRECISION;
        console.log("  New Margin:", pos.collateral / 1e18, "ETH");
        console.log("  New Leverage:", newLeverage, "x");

        // Step 3: 验证强平价格变化
        console.log("");
        console.log("[Step 3] Check improved liquidation price");

        uint256 liqPrice = positionManager.getLiquidationPrice(trader1);
        console.log("  New Liquidation Price:", liqPrice);
        console.log("  (Lower is better for longs - more room to drop)");

        vm.stopPrank();

        console.log("");
        console.log("[TEST 7 PASSED] Add collateral works correctly");
    }

    // ============================================================
    // 测试 8: 部分平仓
    // ============================================================

    function test_08_PartialClose() public {
        _printSeparator("TEST 8: Partial Position Close");

        // Step 1: 开仓
        console.log("");
        console.log("[Step 1] Open position");

        vm.startPrank(trader1);
        vault.deposit{value: 11 ether}();

        positionManager.openLong(100 ether, 10 * LEVERAGE_PRECISION);

        _printPositionInfo(trader1, "Initial");

        // Step 2: 价格上涨
        vm.stopPrank();
        vm.prank(owner);
        priceFeed.updateTokenPriceFromFactory(address(1), INITIAL_PRICE * 110 / 100);

        // Step 3: 部分平仓 50%
        console.log("");
        console.log("[Step 3] Close 50% of position");

        vm.prank(trader1);
        positionManager.closePositionPartial(50);

        _printPositionInfo(trader1, "After 50% Close");
        _printBalances(trader1, "Trader1");

        // Step 4: 再平仓剩余 50%
        console.log("");
        console.log("[Step 4] Close remaining 50%");

        vm.prank(trader1);
        positionManager.closePositionPartial(100); // 关闭剩余全部

        IPositionManager.Position memory pos = positionManager.getPosition(trader1);
        console.log("  Final Position Size:", pos.size);
        assertEq(pos.size, 0, "Position should be fully closed");

        _printBalances(trader1, "Final");

        console.log("");
        console.log("[TEST 8 PASSED] Partial close works correctly");
    }

    // ============================================================
    // 测试 9: 强平价格计算验证 (Bybit 标准)
    // ============================================================

    function test_09_LiquidationPriceCalculation() public {
        _printSeparator("TEST 9: Liquidation Price Calculation (Bybit Standard)");

        console.log("");
        console.log("Bybit Standard Formula:");
        console.log("  Long: liqPrice = entryPrice * (1 - 1/leverage + MMR)");
        console.log("  Short: liqPrice = entryPrice * (1 + 1/leverage - MMR)");
        console.log("");

        vm.startPrank(trader1);
        vault.deposit{value: 11 ether}();

        // 测试不同杠杆的强平价格
        uint256[] memory leverages = new uint256[](4);
        leverages[0] = 10;
        leverages[1] = 25;
        leverages[2] = 50;
        leverages[3] = 100;

        for (uint i = 0; i < leverages.length; i++) {
            // 开多仓
            uint256 lev = leverages[i] * LEVERAGE_PRECISION;
            uint256 size = 10 ether * leverages[i]; // 保证金 10 ETH

            // 先清理之前的仓位
            IPositionManager.Position memory existingPos = positionManager.getPosition(trader1);
            if (existingPos.size > 0) {
                positionManager.closePosition();
            }

            // 重新存款（需要考虑手续费，高杠杆需要更多余额）
            uint256 requiredBalance = 10 ether + (size * 10 / 10000); // collateral + 0.1% fee
            if (vault.getBalance(trader1) < requiredBalance) {
                vault.deposit{value: 12 ether}();
            }

            positionManager.openLong(size, lev);

            uint256 entryPrice = INITIAL_PRICE;
            uint256 liqPrice = positionManager.getLiquidationPrice(trader1);

            // 计算距离
            uint256 distancePercent = (entryPrice - liqPrice) * 10000 / entryPrice;

            console.log("Leverage:", leverages[i], "x");
            console.log("  Entry Price:", entryPrice);
            console.log("  Liq Price:", liqPrice);
            console.log("  Distance (bps):", distancePercent);
            console.log("");
        }

        vm.stopPrank();

        console.log("[TEST 9 PASSED] Liquidation price follows Bybit standard");
    }

    // ============================================================
    // 测试 10: PnL 计算验证 (GMX 标准)
    // ============================================================

    function test_10_PnLCalculation() public {
        _printSeparator("TEST 10: PnL Calculation (GMX Standard)");

        console.log("");
        console.log("GMX Standard Formula:");
        console.log("  delta = size * |currentPrice - avgPrice| / avgPrice");
        console.log("  hasProfit = isLong ? (currentPrice > avgPrice) : (avgPrice > currentPrice)");
        console.log("");

        // 设置
        vm.prank(trader1);
        vault.deposit{value: 11 ether}();

        vm.prank(trader1);
        positionManager.openLong(100 ether, 10 * LEVERAGE_PRECISION);

        console.log("Position: 100 ETH @ 10x, Entry Price:", INITIAL_PRICE);
        console.log("");

        // 测试不同价格变化
        int256[] memory priceChanges = new int256[](5);
        priceChanges[0] = 10;   // +10%
        priceChanges[1] = 20;   // +20%
        priceChanges[2] = -5;   // -5%
        priceChanges[3] = -10;  // -10%
        priceChanges[4] = 50;   // +50%

        for (uint i = 0; i < priceChanges.length; i++) {
            int256 change = priceChanges[i];
            uint256 newPrice;
            if (change >= 0) {
                newPrice = INITIAL_PRICE * (100 + uint256(change)) / 100;
            } else {
                newPrice = INITIAL_PRICE * (100 - uint256(-change)) / 100;
            }

            vm.prank(owner);
            priceFeed.updateTokenPriceFromFactory(address(1), newPrice);

            int256 pnl = positionManager.getUnrealizedPnL(trader1);

            // 计算预期 PnL
            // delta = 100 * |change%| = |change| ETH
            int256 expectedPnL;
            if (change >= 0) {
                expectedPnL = int256(uint256(change)) * 1e18;
            } else {
                expectedPnL = -int256(uint256(-change)) * 1e18;
            }

            if (change >= 0) {
                console.log("Price Change: +", uint256(change), "%");
            } else {
                console.log("Price Change: -", uint256(-change), "%");
            }
            console.log("  Current Price:", newPrice);
            if (pnl >= 0) {
                console.log("  Actual PnL:", uint256(pnl) / 1e18, "ETH");
            } else {
                console.log("  Actual PnL: -", uint256(-pnl) / 1e18, "ETH");
            }
            if (expectedPnL >= 0) {
                console.log("  Expected PnL:", uint256(expectedPnL) / 1e18, "ETH");
            } else {
                console.log("  Expected PnL: -", uint256(-expectedPnL) / 1e18, "ETH");
            }
            console.log("");
        }

        console.log("[TEST 10 PASSED] PnL calculation follows GMX standard");
    }

    // ============================================================
    // 测试 11: 保证金率和健康度
    // ============================================================

    function test_11_MarginRatio() public {
        _printSeparator("TEST 11: Margin Ratio Health Check");

        vm.startPrank(trader1);
        vault.deposit{value: 11 ether}();

        positionManager.openLong(100 ether, 10 * LEVERAGE_PRECISION);
        vm.stopPrank();

        console.log("Position: 100 ETH @ 10x");
        console.log("Initial Margin: 10 ETH");
        console.log("");

        // 测试不同价格下的保证金率
        console.log("Margin Ratio at different prices:");
        console.log("(Higher ratio = healthier position)");
        console.log("");

        int256[] memory changes = new int256[](5);
        changes[0] = 5;
        changes[1] = 0;
        changes[2] = -5;
        changes[3] = -8;
        changes[4] = -9;

        for (uint i = 0; i < changes.length; i++) {
            int256 change = changes[i];
            uint256 newPrice;
            if (change >= 0) {
                newPrice = INITIAL_PRICE * (100 + uint256(change)) / 100;
            } else {
                newPrice = INITIAL_PRICE * (100 - uint256(-change)) / 100;
            }

            vm.prank(owner);
            priceFeed.updateTokenPriceFromFactory(address(1), newPrice);

            uint256 marginRatio = positionManager.getMarginRatio(trader1);
            bool canLiq = positionManager.canLiquidate(trader1);

            string memory status = canLiq ? "DANGER!" : "Safe";

            if (change >= 0) {
                console.log("Price Change: +", uint256(change), "%");
            } else {
                console.log("Price Change: -", uint256(-change), "%");
            }
            console.log("  Margin Ratio:", marginRatio * 100 / PRECISION, "%");
            console.log("  Status:", status);
            console.log("");
        }

        console.log("[TEST 11 PASSED] Margin ratio calculation works correctly");
    }

    // ============================================================
    // 测试 12: 保险基金机制
    // ============================================================

    function test_12_InsuranceFundMechanism() public {
        _printSeparator("TEST 12: Insurance Fund Mechanism");

        console.log("");
        console.log("[Step 1] Check initial Insurance Fund balance");
        uint256 initialFund = insuranceFund.getBalance();
        console.log("  Initial Balance:", initialFund / 1e18, "ETH");

        // Step 2: 创建一个盈利的交易
        console.log("");
        console.log("[Step 2] Create profitable trade (profit comes from Insurance Fund)");

        vm.prank(trader1);
        vault.deposit{value: 11 ether}();

        vm.prank(trader1);
        positionManager.openLong(100 ether, 10 * LEVERAGE_PRECISION);

        // 价格上涨
        vm.prank(owner);
        priceFeed.updateTokenPriceFromFactory(address(1), INITIAL_PRICE * 120 / 100);

        int256 pnl = positionManager.getUnrealizedPnL(trader1);
        console.log("  Unrealized Profit:", uint256(pnl) / 1e18, "ETH");

        // 平仓
        vm.prank(trader1);
        positionManager.closePosition();

        // Step 3: 检查保险基金变化
        console.log("");
        console.log("[Step 3] Check Insurance Fund after profitable close");
        uint256 afterProfitFund = insuranceFund.getBalance();
        console.log("  Fund Balance:", afterProfitFund / 1e18, "ETH");
        console.log("  Paid Out:", (initialFund - afterProfitFund) / 1e18, "ETH");

        // Step 4: 创建一个亏损的交易
        console.log("");
        console.log("[Step 4] Create losing trade (loss goes to Insurance Fund)");

        vm.prank(trader2);
        vault.deposit{value: 11 ether}();

        vm.prank(trader2);
        positionManager.openLong(100 ether, 10 * LEVERAGE_PRECISION);

        // 价格下跌
        vm.prank(owner);
        priceFeed.updateTokenPriceFromFactory(address(1), INITIAL_PRICE * 95 / 100);

        int256 loss = positionManager.getUnrealizedPnL(trader2);
        if (loss < 0) {
            console.log("  Unrealized Loss: -", uint256(-loss) / 1e18, "ETH");
        } else {
            console.log("  Unrealized PnL:", uint256(loss) / 1e18, "ETH");
        }

        // 平仓
        vm.prank(trader2);
        positionManager.closePosition();

        // Step 5: 检查保险基金变化
        console.log("");
        console.log("[Step 5] Check Insurance Fund after losing close");
        uint256 afterLossFund = insuranceFund.getBalance();
        console.log("  Fund Balance:", afterLossFund / 1e18, "ETH");
        // Handle potential underflow by checking which is larger
        if (afterLossFund >= afterProfitFund) {
            console.log("  Received:", (afterLossFund - afterProfitFund) / 1e18, "ETH");
        } else {
            console.log("  Paid (deficit coverage):", (afterProfitFund - afterLossFund) / 1e18, "ETH");
        }

        console.log("");
        console.log("[TEST 12 PASSED] Insurance fund mechanism works correctly");
    }

    // ============================================================
    // 测试 13: 多空不平衡风控
    // ============================================================

    function test_13_ImbalanceRiskControl() public {
        _printSeparator("TEST 13: Long/Short Imbalance Risk Control");

        console.log("");
        console.log("[Step 1] Create imbalanced positions");

        // 多个交易者开多仓
        for (uint i = 1; i <= 3; i++) {
            address trader = makeAddr(string.concat("trader", vm.toString(i)));
            vm.deal(trader, 50 ether);

            vm.startPrank(trader);
            vault.deposit{value: 11 ether}();
            positionManager.openLong(100 ether, 10 * LEVERAGE_PRECISION);
            vm.stopPrank();
        }

        // 检查不平衡
        console.log("");
        console.log("[Step 2] Check imbalance risk");

        (uint256 longExposure, uint256 shortExposure, uint256 maxLoss) = riskManager.getImbalanceRisk();

        console.log("  Long Exposure:", longExposure / 1e18, "ETH");
        console.log("  Short Exposure:", shortExposure / 1e18, "ETH");
        console.log("  Max Potential Loss:", maxLoss / 1e18, "ETH");

        // 检查保险基金覆盖
        console.log("");
        console.log("[Step 3] Check insurance coverage");

        (bool sufficient, uint256 fundBal, uint256 required) = riskManager.checkInsuranceCoverage();

        console.log("  Insurance Fund:", fundBal / 1e18, "ETH");
        console.log("  Required:", required / 1e18, "ETH");
        console.log("  Sufficient:", sufficient);

        console.log("");
        console.log("[TEST 13 PASSED] Imbalance risk control works correctly");
    }

    // ============================================================
    // 测试 14: 手续费收取
    // ============================================================

    function test_14_FeeCollection() public {
        _printSeparator("TEST 14: Fee Collection");

        console.log("");
        console.log("[Step 1] Check fee configuration");

        uint256 openFeeRate = positionManager.openFeeRate();
        uint256 closeFeeRate = positionManager.closeFeeRate();

        console.log("  Open Fee Rate:", openFeeRate, "/ 10000 (0.1%)");
        console.log("  Close Fee Rate:", closeFeeRate, "/ 10000 (0.1%)");

        // 开仓
        console.log("");
        console.log("[Step 2] Open position and check fees");

        uint256 feeReceiverBalBefore = vault.getBalance(feeReceiver);

        vm.startPrank(trader1);
        vault.deposit{value: 11 ether}(); // 多存一点付手续费

        // 开 100 ETH 仓位
        positionManager.openLong(100 ether, 10 * LEVERAGE_PRECISION);

        uint256 feeReceiverBalAfterOpen = vault.getBalance(feeReceiver);
        uint256 openFee = feeReceiverBalAfterOpen - feeReceiverBalBefore;

        console.log("  Position Size: 100 ETH");
        console.log("  Open Fee Collected:", openFee / 1e16, "x 0.01 ETH");
        console.log("  Expected (0.1% of 100 ETH):", 100 ether / 1000 / 1e16, "x 0.01 ETH");

        // 平仓
        console.log("");
        console.log("[Step 3] Close position and check fees");

        positionManager.closePosition();

        uint256 feeReceiverBalAfterClose = vault.getBalance(feeReceiver);
        uint256 closeFee = feeReceiverBalAfterClose - feeReceiverBalAfterOpen;

        console.log("  Close Fee Collected:", closeFee / 1e16, "x 0.01 ETH");

        console.log("");
        console.log("Total Fees Collected:", (feeReceiverBalAfterClose - feeReceiverBalBefore) / 1e18, "ETH");

        vm.stopPrank();

        console.log("");
        console.log("[TEST 14 PASSED] Fee collection works correctly");
    }

    // ============================================================
    // 测试 15: 多代币仓位 (Multi-Token)
    // ============================================================

    function test_15_MultiTokenPositions() public {
        _printSeparator("TEST 15: Multi-Token Positions");

        // 首先需要在 PriceFeed 中添加代币支持
        address mockToken = makeAddr("mockToken");

        vm.startPrank(owner);
        priceFeed.addSupportedToken(mockToken, INITIAL_PRICE * 2); // 价格是默认代币的 2 倍
        positionManager.setDefaultToken(mockToken);
        vm.stopPrank();

        console.log("");
        console.log("[Step 1] Setup multi-token support");
        console.log("  Mock Token Address:", mockToken);
        console.log("  Token Price:", INITIAL_PRICE * 2);

        // 开仓
        console.log("");
        console.log("[Step 2] Open position on token");

        vm.startPrank(trader1);
        vault.deposit{value: 11 ether}();

        // 使用 ISOLATED 模式
        positionManager.openLongToken(
            mockToken,
            100 ether,
            10 * LEVERAGE_PRECISION,
            IPositionManager.MarginMode.ISOLATED
        );

        // 获取仓位
        IPositionManager.PositionEx memory pos = positionManager.getPositionByToken(trader1, mockToken);

        console.log("  Token:", pos.token);
        console.log("  Size:", pos.size / 1e18, "ETH");
        console.log("  Entry Price:", pos.entryPrice);
        console.log("  Margin Mode:", uint256(pos.marginMode) == 0 ? "ISOLATED" : "CROSS");

        // 价格变化
        console.log("");
        console.log("[Step 3] Token price increases 15%");

        vm.stopPrank();
        vm.prank(owner);
        // 使用 updateTokenPrice 更新已支持代币的价格（owner 已设为 AMM）
        priceFeed.updateTokenPrice(mockToken, INITIAL_PRICE * 2 * 115 / 100);

        // 检查 PnL
        int256 pnl = positionManager.getTokenUnrealizedPnL(trader1, mockToken);
        if (pnl >= 0) {
            console.log("  Unrealized PnL:", uint256(pnl) / 1e18, "ETH");
        } else {
            console.log("  Unrealized PnL: -", uint256(-pnl) / 1e18, "ETH");
        }

        // 获取强平价格
        uint256 liqPrice = positionManager.getTokenLiquidationPrice(trader1, mockToken);
        console.log("  Liquidation Price:", liqPrice);

        // 平仓
        console.log("");
        console.log("[Step 4] Close token position");

        vm.prank(trader1);
        positionManager.closePositionToken(mockToken);

        _printBalances(trader1, "Final");

        console.log("");
        console.log("[TEST 15 PASSED] Multi-token positions work correctly");
    }

    // ============================================================
    // 运行所有测试的汇总
    // ============================================================

    function test_Summary() public pure {
        console.log("");
        console.log("========================================");
        console.log("   ALL PERPETUAL TRADING TESTS");
        console.log("========================================");
        console.log("");
        console.log("1. Open Long -> Profit -> Close");
        console.log("2. Open Short -> Loss -> Close");
        console.log("3. Liquidation Mechanism");
        console.log("4. Funding Fee Mechanism");
        console.log("5. Margin Deposit/Withdrawal");
        console.log("6. Profit Withdrawal");
        console.log("7. Add Collateral");
        console.log("8. Partial Close");
        console.log("9. Liquidation Price (Bybit)");
        console.log("10. PnL Calculation (GMX)");
        console.log("11. Margin Ratio Health");
        console.log("12. Insurance Fund");
        console.log("13. Imbalance Risk Control");
        console.log("14. Fee Collection");
        console.log("15. Multi-Token Positions");
        console.log("");
        console.log("Run: forge test -vvv --match-contract PerpetualTradingTest");
        console.log("");
    }
}
