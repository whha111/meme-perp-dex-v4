// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import "../src/perpetual/PerpVault.sol";
import "../src/common/PriceFeed.sol";
import "../src/spot/TokenFactory.sol";
import "../src/spot/LendingPool.sol";
import "../src/spot/MemeTokenV2.sol";

/**
 * @title E2E Integration Tests
 * @notice 端到端交叉测试 — 验证所有合约在真实业务场景下的交互正确性
 * @dev 核心理念:
 *   1. 交叉测试 — 合约 A 的输出作为合约 B 的输入
 *   2. 交叉验证 — 同一值用两种方式独立计算，对比结果
 *   3. 多方测试 — 多 LP + 多 Trader + 多代币同时操作
 *   4. 交叉对比 — 合约结果 vs 手动公式计算 vs 预期行为
 */
contract E2ETest is Test {
    // ═══════════════════════════════════════════════════════════════
    // CONTRACTS
    // ═══════════════════════════════════════════════════════════════

    PerpVault public perpVault;
    PriceFeed public priceFeed;
    TokenFactory public tokenFactory;
    LendingPool public lendingPool;

    // Mock Uniswap Router for graduation
    MockUniswapRouter public mockRouter;

    // Mock Vault that receives trader profits
    MockVault public mockVault;

    // ═══════════════════════════════════════════════════════════════
    // ACTORS
    // ═══════════════════════════════════════════════════════════════

    address public owner = address(this);
    address public feeReceiver = makeAddr("feeReceiver");

    // LPs
    address public lp1 = makeAddr("lp1");
    address public lp2 = makeAddr("lp2");
    address public lp3 = makeAddr("lp3");
    address public lp4 = makeAddr("lp4");
    address public lp5 = makeAddr("lp5");

    // Traders
    address public trader1 = makeAddr("trader1");
    address public trader2 = makeAddr("trader2");
    address public trader3 = makeAddr("trader3");

    // Token creator
    address public creator = makeAddr("creator");

    // Matching engine (authorized)
    address public matchingEngine = makeAddr("matchingEngine");

    // ═══════════════════════════════════════════════════════════════
    // CONSTANTS (mirror from contracts for cross-validation)
    // ═══════════════════════════════════════════════════════════════

    uint256 constant PRECISION = 1e18;
    uint256 constant FEE_PRECISION = 10000;
    uint256 constant DEPOSIT_FEE_BPS = 30;
    uint256 constant WITHDRAWAL_FEE_BPS = 30;
    uint256 constant DEAD_SHARES = 1000;
    uint256 constant MAX_UTILIZATION = 8000; // 80%
    uint256 constant ADL_THRESHOLD_BPS = 9000; // 90%
    uint256 constant MIN_DEPOSIT = 0.001 ether;

    // TokenFactory constants
    uint256 constant VIRTUAL_ETH_RESERVE = 10.593 ether;
    uint256 constant REAL_TOKEN_SUPPLY = 1_000_000_000 ether;
    uint256 constant VIRTUAL_TOKEN_RESERVE = 1_073_000_000 ether;
    uint256 constant PERP_ENABLE_THRESHOLD = 6 ether;
    uint256 constant FEE_BPS = 100; // 1%

    // ═══════════════════════════════════════════════════════════════
    // SETUP
    // ═══════════════════════════════════════════════════════════════

    function setUp() public {
        // Deploy mock Uniswap router
        mockRouter = new MockUniswapRouter();

        // Deploy real contracts
        tokenFactory = new TokenFactory(owner, feeReceiver, address(mockRouter));
        priceFeed = new PriceFeed();
        perpVault = new PerpVault();
        lendingPool = new LendingPool(owner, address(tokenFactory));

        // Deploy mock vault for receiving trader profits
        mockVault = new MockVault();

        // Wire contracts together
        priceFeed.setTokenFactory(address(tokenFactory));
        tokenFactory.setPriceFeed(address(priceFeed));
        tokenFactory.setLendingPool(address(lendingPool));

        // Authorize matching engine on PerpVault and set vault
        perpVault.setAuthorizedContract(matchingEngine, true);
        perpVault.setVault(address(mockVault));

        // Restore old parameter values so existing test math stays correct
        perpVault.setFees(30, 30);           // restore old 0.3% fees
        perpVault.setMaxUtilization(8000);   // restore old 80%
        perpVault.setAdlThreshold(9000);     // restore old 90%

        // Fund all actors
        vm.deal(lp1, 100 ether);
        vm.deal(lp2, 100 ether);
        vm.deal(lp3, 100 ether);
        vm.deal(lp4, 100 ether);
        vm.deal(lp5, 100 ether);
        vm.deal(trader1, 100 ether);
        vm.deal(trader2, 100 ether);
        vm.deal(trader3, 100 ether);
        vm.deal(creator, 100 ether);
        vm.deal(matchingEngine, 100 ether);
    }

    // ═══════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════

    /// @dev Create a token and buy enough to enable perp (6 ETH threshold)
    function _createAndEnablePerp() internal returns (address token) {
        vm.prank(creator);
        token = tokenFactory.createToken{value: 0.001 ether}("MEME", "MEME", "ipfs://test", 0);

        // Buy enough to reach PERP_ENABLE_THRESHOLD (6 ETH + fees)
        vm.prank(trader1);
        tokenFactory.buy{value: 7 ether}(token, 0);

        // Verify perp is enabled
        TokenFactory.PoolState memory state = tokenFactory.getPoolState(token);
        assertTrue(state.perpEnabled, "Perp should be enabled after 6+ ETH");
    }

    /// @dev Calculate expected share price manually for cross-validation
    function _calcSharePrice(uint256 poolValue, uint256 totalShares) internal pure returns (uint256) {
        if (totalShares == 0) return PRECISION;
        if (poolValue == 0) return 0;
        return (poolValue * PRECISION) / totalShares;
    }

    /// @dev Calculate expected pool value manually for cross-validation
    function _calcPoolValue(uint256 rawBalance, int256 pendingPnL) internal pure returns (uint256) {
        int256 adjusted = int256(rawBalance) - pendingPnL;
        return adjusted > 0 ? uint256(adjusted) : 0;
    }

    /// @dev Calculate expected deposit shares manually
    function _calcDepositShares(uint256 depositAmount, uint256 totalShares, uint256 poolValue) internal pure returns (uint256) {
        if (totalShares == 0) return depositAmount - DEAD_SHARES;
        if (poolValue == 0) return depositAmount;
        return (depositAmount * totalShares) / poolValue;
    }

    /// @dev Calculate fee
    function _calcFee(uint256 amount, uint256 feeBps) internal pure returns (uint256) {
        return (amount * feeBps) / FEE_PRECISION;
    }

    /// @dev Assert two values are approximately equal (within tolerance)
    function _assertApproxEq(uint256 a, uint256 b, uint256 tolerance, string memory label) internal pure {
        uint256 diff = a > b ? a - b : b - a;
        require(diff <= tolerance, string.concat(label, ": values differ too much"));
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 1: TokenFactory → PriceFeed 交叉测试
    // ═══════════════════════════════════════════════════════════════

    /// @notice 验证 TokenFactory 交易后 PriceFeed 价格自动同步
    function test_E2E_TokenFactory_PriceFeed_PriceSync() public {
        // 1. Create token
        vm.prank(creator);
        address token = tokenFactory.createToken{value: 0.001 ether}("TEST", "TEST", "ipfs://", 0);

        // 2. Buy tokens to reach perp threshold
        vm.prank(trader1);
        tokenFactory.buy{value: 7 ether}(token, 0);

        // 3. Cross-validate: PriceFeed price should match TokenFactory price
        uint256 priceFeedPrice = priceFeed.getTokenMarkPrice(token);
        uint256 factoryPrice = tokenFactory.getCurrentPrice(token);

        assertEq(priceFeedPrice, factoryPrice, "PriceFeed and TokenFactory prices must match");
        assertGt(priceFeedPrice, 0, "Price must be non-zero");

        // 4. Another trade should update PriceFeed price
        uint256 oldPrice = priceFeedPrice;
        vm.prank(trader2);
        tokenFactory.buy{value: 2 ether}(token, 0);

        uint256 newPriceFeedPrice = priceFeed.getTokenMarkPrice(token);
        uint256 newFactoryPrice = tokenFactory.getCurrentPrice(token);

        assertEq(newPriceFeedPrice, newFactoryPrice, "Prices must still match after second trade");
        assertGt(newPriceFeedPrice, oldPrice, "Price should increase after buy");
    }

    /// @notice 验证 TokenFactory 卖出后 PriceFeed 价格同步下降
    function test_E2E_TokenFactory_PriceFeed_SellSync() public {
        vm.prank(creator);
        address token = tokenFactory.createToken{value: 0.001 ether}("TEST", "TEST", "ipfs://", 0);

        // Buy first
        vm.prank(trader1);
        tokenFactory.buy{value: 7 ether}(token, 0);

        uint256 priceAfterBuy = priceFeed.getTokenMarkPrice(token);

        // Sell some tokens
        uint256 balance = MemeTokenV2(token).balanceOf(trader1);
        uint256 sellAmount = balance / 4;

        vm.prank(trader1);
        MemeTokenV2(token).approve(address(tokenFactory), sellAmount);
        vm.prank(trader1);
        tokenFactory.sell(token, sellAmount, 0);

        uint256 priceAfterSell = priceFeed.getTokenMarkPrice(token);
        uint256 factoryPriceAfterSell = tokenFactory.getCurrentPrice(token);

        assertEq(priceAfterSell, factoryPriceAfterSell, "Prices must match after sell");
        assertLt(priceAfterSell, priceAfterBuy, "Price should decrease after sell");
    }

    /// @notice 验证 PriceFeed 价格 = 手动计算的 bonding curve 价格
    function test_E2E_PriceFeed_CrossValidation_BondingCurveFormula() public {
        vm.prank(creator);
        address token = tokenFactory.createToken{value: 0.001 ether}("TEST", "TEST", "ipfs://", 0);

        vm.prank(trader1);
        tokenFactory.buy{value: 7 ether}(token, 0);

        // Get contract values
        TokenFactory.PoolState memory state = tokenFactory.getPoolState(token);
        uint256 priceFeedPrice = priceFeed.getTokenMarkPrice(token);

        // Manually calculate price: P = virtualEth * 1e18 / virtualToken
        uint256 virtualEth = VIRTUAL_ETH_RESERVE + state.realETHReserve;
        uint256 virtualToken = state.realTokenReserve + (VIRTUAL_TOKEN_RESERVE - REAL_TOKEN_SUPPLY);
        uint256 manualPrice = (virtualEth * PRECISION) / virtualToken;

        assertEq(priceFeedPrice, manualPrice, "PriceFeed price must match manual bonding curve calculation");
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 2: TokenFactory → LendingPool 交叉测试
    // ═══════════════════════════════════════════════════════════════

    /// @notice 验证代币达到阈值后 LendingPool 自动启用
    function test_E2E_TokenFactory_LendingPool_AutoEnable() public {
        vm.prank(creator);
        address token = tokenFactory.createToken{value: 0.001 ether}("LEND", "LEND", "ipfs://", 0);

        // Before threshold: lending not enabled
        assertFalse(lendingPool.isTokenEnabled(token), "Lending should not be enabled before threshold");

        // Buy to reach LENDING_ENABLE_THRESHOLD (6 ETH)
        vm.prank(trader1);
        tokenFactory.buy{value: 7 ether}(token, 0);

        // After threshold: lending enabled
        assertTrue(lendingPool.isTokenEnabled(token), "Lending should be enabled after threshold");

        // Verify pool state is initialized
        (bool enabled, , , , , , , ) = lendingPool.getPoolInfo(token);
        assertTrue(enabled, "Pool should be enabled");
    }

    /// @notice 验证 TokenFactory → LendingPool → 存款 → 借款完整链路
    function test_E2E_TokenFactory_LendingPool_DepositBorrow() public {
        // Create and enable lending
        vm.prank(creator);
        address token = tokenFactory.createToken{value: 0.001 ether}("LEND", "LEND", "ipfs://", 0);

        vm.prank(trader1);
        tokenFactory.buy{value: 7 ether}(token, 0);

        assertTrue(lendingPool.isTokenEnabled(token), "Lending should be enabled");

        // Trader1 deposits tokens into LendingPool
        uint256 tokenBalance = MemeTokenV2(token).balanceOf(trader1);
        uint256 depositAmt = tokenBalance / 2;

        vm.prank(trader1);
        MemeTokenV2(token).approve(address(lendingPool), depositAmt);
        vm.prank(trader1);
        uint256 shares = lendingPool.deposit(token, depositAmt);

        // Cross-validate: shares should match 1:1 on first deposit
        assertEq(shares, depositAmt, "First deposit should give 1:1 shares");

        // Cross-validate: user deposit should equal amount deposited
        uint256 userDeposit = lendingPool.getUserDeposit(token, trader1);
        assertEq(userDeposit, depositAmt, "User deposit should match");

        // Authorize matching engine and borrow
        lendingPool.setAuthorizedContract(matchingEngine, true);

        uint256 borrowAmt = depositAmt / 4;
        vm.prank(matchingEngine);
        lendingPool.borrow(token, trader2, borrowAmt);

        // Cross-validate utilization
        uint256 utilization = lendingPool.getUtilization(token);
        uint256 manualUtilization = (borrowAmt * PRECISION) / depositAmt;
        assertEq(utilization, manualUtilization, "Utilization must match manual calculation");

        // Cross-validate: borrow rate should be > base rate
        uint256 borrowRate = lendingPool.getBorrowRate(token);
        assertGt(borrowRate, 2e16, "Borrow rate should be > base rate (2%)");
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 3: PerpVault LP 存款交叉验证
    // ═══════════════════════════════════════════════════════════════

    /// @notice 验证首次存款份额计算交叉验证
    function test_E2E_PerpVault_FirstDeposit_CrossValidation() public {
        uint256 depositAmount = 10 ether;

        // Deposit
        vm.prank(lp1);
        perpVault.deposit{value: depositAmount}();

        // Cross-validate: shares
        uint256 fee = _calcFee(depositAmount, DEPOSIT_FEE_BPS);
        uint256 netDeposit = depositAmount - fee;
        uint256 expectedShares = netDeposit - DEAD_SHARES;

        uint256 actualShares = perpVault.shares(lp1);
        assertEq(actualShares, expectedShares, "LP1 shares must match manual calculation");

        // Cross-validate: dead shares
        uint256 deadShares = perpVault.shares(perpVault.DEAD_ADDRESS());
        assertEq(deadShares, DEAD_SHARES, "Dead shares must be 1000");

        // Cross-validate: total shares
        uint256 totalShares = perpVault.totalShares();
        assertEq(totalShares, expectedShares + DEAD_SHARES, "Total shares must match");

        // Cross-validate: share price
        uint256 contractSharePrice = perpVault.getSharePrice();
        uint256 manualSharePrice = _calcSharePrice(perpVault.getPoolValue(), totalShares);
        assertEq(contractSharePrice, manualSharePrice, "Share price must match manual calc");
    }

    /// @notice 验证多 LP 顺序存款份额公平性
    function test_E2E_PerpVault_MultiLP_Fairness() public {
        // LP1 deposits 10 ETH
        vm.prank(lp1);
        perpVault.deposit{value: 10 ether}();

        uint256 sharePrice1 = perpVault.getSharePrice();

        // LP2 deposits 10 ETH (should get approximately same value)
        vm.prank(lp2);
        perpVault.deposit{value: 10 ether}();

        uint256 sharePrice2 = perpVault.getSharePrice();

        // LP3 deposits 5 ETH
        vm.prank(lp3);
        perpVault.deposit{value: 5 ether}();

        // Cross-validate: LP2's ETH value should be close to 10 ETH minus fees
        // Note: LP1's deposit fee stays in pool → raises share price for LP2's entry
        // So LP2's value may be slightly less than 10 ETH minus fee
        uint256 lp2Value = perpVault.getLPValue(lp2);
        uint256 lp2Fee = _calcFee(10 ether, DEPOSIT_FEE_BPS);
        // Tolerance: 0.1 ETH (deposit fees from other LPs affect share price)
        _assertApproxEq(lp2Value, 10 ether - lp2Fee, 0.1 ether, "LP2 value should be ~10 ETH minus fee");

        uint256 lp1Value = perpVault.getLPValue(lp1);
        assertGt(lp1Value, 0, "LP1 value should be > 0");
        assertGt(lp2Value, 0, "LP2 value should be > 0");

        // LP3 should have about half of LP2's value
        uint256 lp3Value = perpVault.getLPValue(lp3);
        _assertApproxEq(lp3Value, 5 ether - _calcFee(5 ether, DEPOSIT_FEE_BPS), 0.1 ether, "LP3 value should be ~5 ETH minus fee");
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 4: PerpVault PnL → SharePrice 交叉验证
    // ═══════════════════════════════════════════════════════════════

    /// @notice 验证: 交易者盈利 → 池子价值下降 → 份额价格下降 → LP 承担损失
    function test_E2E_PerpVault_TraderProfit_LPLoss_CrossValidation() public {
        // LP1 deposits 10 ETH
        vm.prank(lp1);
        perpVault.deposit{value: 10 ether}();

        uint256 sharePriceBefore = perpVault.getSharePrice();
        uint256 poolValueBefore = perpVault.getPoolValue();
        uint256 lp1SharesBefore = perpVault.shares(lp1);

        // Matching engine reports: traders collectively profiting 2 ETH
        vm.prank(matchingEngine);
        perpVault.updatePendingPnL(2 ether);

        // Cross-validate: pool value decreased by 2 ETH
        uint256 poolValueAfter = perpVault.getPoolValue();
        uint256 rawBalance = perpVault.getRawBalance();
        uint256 manualPoolValue = _calcPoolValue(rawBalance, 2 ether);
        assertEq(poolValueAfter, manualPoolValue, "Pool value must match manual PnL-adjusted calc");
        assertEq(poolValueAfter, poolValueBefore - 2 ether, "Pool value should decrease by trader profit");

        // Cross-validate: share price decreased
        uint256 sharePriceAfter = perpVault.getSharePrice();
        uint256 manualSharePrice = _calcSharePrice(poolValueAfter, perpVault.totalShares());
        assertEq(sharePriceAfter, manualSharePrice, "Share price must match manual calc");
        assertLt(sharePriceAfter, sharePriceBefore, "Share price must decrease when traders profit");

        // Cross-validate: LP1's value decreased proportionally
        uint256 lp1ValueAfter = perpVault.getLPValue(lp1);
        uint256 manualLp1Value = (lp1SharesBefore * sharePriceAfter) / PRECISION;
        assertEq(lp1ValueAfter, manualLp1Value, "LP1 value must match shares * sharePrice");
    }

    /// @notice 验证: 交易者亏损 → 池子价值上升 → 份额价格上升 → LP 获利
    function test_E2E_PerpVault_TraderLoss_LPProfit_CrossValidation() public {
        // LP1 deposits 10 ETH
        vm.prank(lp1);
        perpVault.deposit{value: 10 ether}();

        uint256 sharePriceBefore = perpVault.getSharePrice();

        // Matching engine reports: traders collectively losing 3 ETH (negative PnL)
        vm.prank(matchingEngine);
        perpVault.updatePendingPnL(-3 ether);

        // Cross-validate: pool value increased (traders' loss = LP's gain)
        uint256 rawBalance = perpVault.getRawBalance();
        uint256 poolValueAfter = perpVault.getPoolValue();
        uint256 manualPoolValue = _calcPoolValue(rawBalance, -3 ether);
        assertEq(poolValueAfter, manualPoolValue, "Pool value must include negative PnL as asset");
        assertGt(poolValueAfter, rawBalance, "Pool value > raw balance when traders lose");

        // Cross-validate: share price increased
        uint256 sharePriceAfter = perpVault.getSharePrice();
        assertGt(sharePriceAfter, sharePriceBefore, "Share price must increase when traders lose");

        // Cross-validate: getLPValue matches manual calc
        uint256 lp1Value = perpVault.getLPValue(lp1);
        uint256 manualValue = (perpVault.shares(lp1) * sharePriceAfter) / PRECISION;
        assertEq(lp1Value, manualValue, "LP value must equal shares * sharePrice");
    }

    /// @notice 验证: settleTraderLoss 实际 ETH 到账后 → 池子余额增加
    function test_E2E_PerpVault_SettleTraderLoss_BalanceIncrease() public {
        vm.prank(lp1);
        perpVault.deposit{value: 10 ether}();

        uint256 rawBefore = perpVault.getRawBalance();

        // Trader loses 2 ETH, matching engine settles loss to pool
        vm.prank(matchingEngine);
        perpVault.settleTraderLoss{value: 2 ether}(2 ether);

        uint256 rawAfter = perpVault.getRawBalance();
        assertEq(rawAfter, rawBefore + 2 ether, "Raw balance must increase by trader loss");

        // Cross-validate: totalLossesReceived tracks this
        assertEq(perpVault.totalLossesReceived(), 2 ether, "Total losses must match");
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 5: PerpVault OI → MaxOI 交叉验证
    // ═══════════════════════════════════════════════════════════════

    /// @notice 验证 OI 限制与池子价值挂钩 (80%)
    function test_E2E_PerpVault_OI_MaxOI_CrossValidation() public {
        vm.prank(lp1);
        perpVault.deposit{value: 10 ether}();

        address token = makeAddr("token1");

        // Cross-validate: maxOI = 80% of poolValue
        uint256 poolValue = perpVault.getPoolValue();
        uint256 contractMaxOI = perpVault.getMaxOI();
        uint256 manualMaxOI = (poolValue * MAX_UTILIZATION) / FEE_PRECISION;
        assertEq(contractMaxOI, manualMaxOI, "MaxOI must equal 80% of pool value");

        // Open positions up to 50% utilization
        uint256 oi = 4 ether;
        vm.prank(matchingEngine);
        perpVault.increaseOI(token, true, oi);

        // Cross-validate: totalOI tracks correctly
        assertEq(perpVault.getTotalOI(), oi, "TotalOI must match");

        // Cross-validate: utilization = totalOI / poolValue
        uint256 contractUtil = perpVault.getUtilization();
        uint256 manualUtil = (oi * FEE_PRECISION) / poolValue;
        assertEq(contractUtil, manualUtil, "Utilization must match manual calc");

        // When PnL changes, maxOI should change too
        vm.prank(matchingEngine);
        perpVault.updatePendingPnL(5 ether); // traders profiting → pool value drops

        uint256 newPoolValue = perpVault.getPoolValue();
        uint256 newMaxOI = perpVault.getMaxOI();
        uint256 manualNewMaxOI = (newPoolValue * MAX_UTILIZATION) / FEE_PRECISION;
        assertEq(newMaxOI, manualNewMaxOI, "MaxOI must update when PnL changes");
        assertLt(newMaxOI, contractMaxOI, "MaxOI should decrease when traders profit");
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 6: PerpVault ADL 交叉验证
    // ═══════════════════════════════════════════════════════════════

    /// @notice 验证 ADL 触发条件与部分结算
    function test_E2E_PerpVault_ADL_Trigger_CrossValidation() public {
        vm.prank(lp1);
        perpVault.deposit{value: 10 ether}();

        // Set pending PnL to 8.5 ETH (85% of raw balance → below 90% threshold)
        vm.prank(matchingEngine);
        perpVault.updatePendingPnL(int256(8.5 ether));

        (bool shouldTrigger1, uint256 bps1) = perpVault.shouldADL();
        assertFalse(shouldTrigger1, "ADL should NOT trigger at 85%");

        // Cross-validate: pnlToPoolBps calculation
        uint256 manualBps = (8.5 ether * FEE_PRECISION) / perpVault.getRawBalance();
        assertEq(bps1, manualBps, "ADL BPS must match manual calc");

        // Increase to 92% → should trigger
        vm.prank(matchingEngine);
        perpVault.updatePendingPnL(int256(9.2 ether));

        (bool shouldTrigger2, uint256 bps2) = perpVault.shouldADL();
        assertTrue(shouldTrigger2, "ADL should trigger at 92%");
        assertGe(bps2, ADL_THRESHOLD_BPS, "BPS must be >= 9000");
    }

    /// @notice 验证 ADL 部分结算 — 池子余额不够全额支付时
    function test_E2E_PerpVault_ADL_PartialSettlement() public {
        // Deposit 5 ETH
        vm.prank(lp1);
        perpVault.deposit{value: 5 ether}();

        uint256 traderBalBefore = address(trader1).balance;
        uint256 poolBalanceBefore = perpVault.getRawBalance();

        // Try to settle 10 ETH profit (but pool only has ~5 ETH)
        vm.prank(matchingEngine);
        perpVault.settleTraderProfit(trader1, 10 ether);

        uint256 traderBalAfter = address(trader1).balance;
        uint256 poolBalanceAfter = perpVault.getRawBalance();

        // Cross-validate: trader got what pool had, not full 10 ETH
        uint256 traderReceived = traderBalAfter - traderBalBefore;
        assertEq(traderReceived, poolBalanceBefore, "Trader should receive pool's full balance (ADL)");
        assertEq(poolBalanceAfter, 0, "Pool should be empty after ADL");
        assertLt(traderReceived, 10 ether, "Trader should NOT receive full profit");
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 7: 全链路 E2E — 创建代币 → 交易 → LP 存款 → 价格联动
    // ═══════════════════════════════════════════════════════════════

    /// @notice 完整链路: TokenFactory创建 → 买入达阈值 → PriceFeed更新 →
    ///         PerpVault LP存款 → 模拟交易盈亏 → 份额价格变动 → 取款验证
    function test_E2E_FullChain_Create_Trade_LP_Settle() public {
        // ── Step 1: Create token ──
        vm.prank(creator);
        address token = tokenFactory.createToken{value: 0.001 ether}("FULL", "FULL", "ipfs://", 0);

        // ── Step 2: Buy to enable perp ──
        vm.prank(trader1);
        tokenFactory.buy{value: 7 ether}(token, 0);

        // Verify cross-contract state: TokenFactory → PriceFeed → LendingPool all updated
        assertTrue(tokenFactory.getPoolState(token).perpEnabled, "Perp enabled");
        assertTrue(lendingPool.isTokenEnabled(token), "Lending enabled");
        assertGt(priceFeed.getTokenMarkPrice(token), 0, "Price > 0");

        // ── Step 3: LP deposits to PerpVault ──
        vm.prank(lp1);
        perpVault.deposit{value: 20 ether}();
        vm.prank(lp2);
        perpVault.deposit{value: 10 ether}();

        uint256 totalSharesBefore = perpVault.totalShares();
        uint256 sharePriceBefore = perpVault.getSharePrice();
        uint256 lp1SharesBefore = perpVault.shares(lp1);
        uint256 lp2SharesBefore = perpVault.shares(lp2);

        // ── Step 4: Simulate trades via matching engine ──
        // Matching engine opens OI
        vm.prank(matchingEngine);
        perpVault.increaseOI(token, true, 5 ether); // trader opens 5 ETH long

        // ── Step 5: Price moves up → traders profit ──
        vm.prank(matchingEngine);
        perpVault.updatePendingPnL(3 ether); // traders collectively up 3 ETH

        uint256 sharePriceAfterProfit = perpVault.getSharePrice();
        assertLt(sharePriceAfterProfit, sharePriceBefore, "Share price drops when traders profit");

        // ── Step 6: Trader closes with 3 ETH profit → settled from pool to trader ──
        uint256 traderBefore = address(trader1).balance;

        vm.prank(matchingEngine);
        perpVault.settleTraderProfit(trader1, 3 ether);

        vm.prank(matchingEngine);
        perpVault.decreaseOI(token, true, 5 ether);

        // Reset PnL after settlement
        vm.prank(matchingEngine);
        perpVault.updatePendingPnL(0);

        assertEq(address(trader1).balance - traderBefore, 3 ether, "Trader received 3 ETH profit");

        // ── Step 7: Pool value decreased → LP values decreased ──
        uint256 sharePriceAfterSettle = perpVault.getSharePrice();

        // Cross-validate LP1 and LP2 share the 3 ETH loss proportionally
        uint256 lp1ValueAfter = perpVault.getLPValue(lp1);
        uint256 lp2ValueAfter = perpVault.getLPValue(lp2);
        uint256 totalLPValue = lp1ValueAfter + lp2ValueAfter;
        uint256 deadShareValue = (DEAD_SHARES * sharePriceAfterSettle) / PRECISION;
        uint256 poolValue = perpVault.getPoolValue();

        // Total LP value + dead share value ≈ pool value
        _assertApproxEq(totalLPValue + deadShareValue, poolValue, 0.001 ether, "LP values + dead shares must equal pool value");

        // LP1 deposited 2x of LP2, so LP1's share of loss is 2x LP2's
        // Ratio check: lp1Value / lp2Value ≈ lp1Shares / lp2Shares
        uint256 ratioByValue = (lp1ValueAfter * PRECISION) / lp2ValueAfter;
        uint256 ratioByShares = (lp1SharesBefore * PRECISION) / lp2SharesBefore;
        _assertApproxEq(ratioByValue, ratioByShares, PRECISION / 100, "LP loss must be proportional to shares");

        // ── Step 8: LP1 withdraws — verify they get fair value ──
        uint256 lp1WithdrawShares = perpVault.shares(lp1) / 2;
        vm.prank(lp1);
        perpVault.requestWithdrawal(lp1WithdrawShares);

        vm.warp(block.timestamp + 25 hours); // pass cooldown

        uint256 lp1BalanceBefore = lp1.balance;
        vm.prank(lp1);
        perpVault.executeWithdrawal();

        uint256 lp1Received = lp1.balance - lp1BalanceBefore;

        // Cross-validate: LP1 received ≈ shares * sharePrice - fee
        uint256 expectedGross = (lp1WithdrawShares * sharePriceAfterSettle) / PRECISION;
        uint256 expectedFee = _calcFee(expectedGross, WITHDRAWAL_FEE_BPS);
        uint256 expectedNet = expectedGross - expectedFee;

        // Allow small rounding (1 wei per operation)
        _assertApproxEq(lp1Received, expectedNet, 10, "LP1 withdrawal must match share value minus fee");
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 8: 多方压力测试 — 5 LP + 多交易者 + 价格波动
    // ═══════════════════════════════════════════════════════════════

    /// @notice 5 LP 同时存款 → 交易者连续盈亏 → 中途有人存款/取款 → 所有人公平
    function test_E2E_MultiParty_5LP_Stress() public {
        // ── Phase 1: 5 LPs deposit ──
        vm.prank(lp1); perpVault.deposit{value: 10 ether}();
        vm.prank(lp2); perpVault.deposit{value: 20 ether}();
        vm.prank(lp3); perpVault.deposit{value: 5 ether}();
        vm.prank(lp4); perpVault.deposit{value: 15 ether}();
        vm.prank(lp5); perpVault.deposit{value: 8 ether}();

        uint256 sharePricePhase1 = perpVault.getSharePrice();

        // ── Phase 2: Traders open positions → price moves → traders profit ──
        _phase2_traderProfit();

        uint256 sharePricePhase2 = perpVault.getSharePrice();
        assertLt(sharePricePhase2, sharePricePhase1, "Share price decreased");

        // ── Phase 3: LP3 deposits MORE during trader profit (should get fair price) ──
        vm.prank(lp3);
        perpVault.deposit{value: 10 ether}();

        // ── Phase 4-5: Traders lose → settle → close ──
        _phase4_traderLossAndSettle();

        // ── Phase 6: Verify all LP values sum to pool value ──
        _verifyConservation();

        // ── Phase 7: LP3 who deposited at lower price should have value ──
        assertGt(perpVault.getLPValue(lp3), 0, "LP3 value should be positive");
    }

    function _phase2_traderProfit() internal {
        address token = makeAddr("token_stress");
        vm.prank(matchingEngine);
        perpVault.increaseOI(token, true, 10 ether);
        vm.prank(matchingEngine);
        perpVault.updatePendingPnL(4 ether);
    }

    function _phase4_traderLossAndSettle() internal {
        address token = makeAddr("token_stress");
        vm.prank(matchingEngine);
        perpVault.updatePendingPnL(-2 ether);

        vm.prank(matchingEngine);
        perpVault.settleTraderLoss{value: 2 ether}(2 ether);

        vm.prank(matchingEngine);
        perpVault.decreaseOI(token, true, 10 ether);

        vm.prank(matchingEngine);
        perpVault.updatePendingPnL(0);
    }

    function _verifyConservation() internal view {
        uint256 poolValueFinal = perpVault.getPoolValue();
        uint256 totalLPValueFinal = perpVault.getLPValue(lp1)
            + perpVault.getLPValue(lp2)
            + perpVault.getLPValue(lp3)
            + perpVault.getLPValue(lp4)
            + perpVault.getLPValue(lp5);
        uint256 deadShareValue = (DEAD_SHARES * perpVault.getSharePrice()) / PRECISION;

        _assertApproxEq(
            totalLPValueFinal + deadShareValue,
            poolValueFinal,
            0.001 ether, // Allow small rounding from integer division
            "Total LP values + dead shares must equal pool value (conservation)"
        );
    }

    /// @notice 验证: 多代币 OI 同时存在，总 OI 追踪准确
    function test_E2E_MultiToken_OI_Tracking() public {
        vm.prank(lp1);
        perpVault.deposit{value: 50 ether}();

        address token1 = makeAddr("tokenA");
        address token2 = makeAddr("tokenB");
        address token3 = makeAddr("tokenC");

        // Open OI on 3 different tokens
        vm.startPrank(matchingEngine);
        perpVault.increaseOI(token1, true, 5 ether);
        perpVault.increaseOI(token1, false, 3 ether);
        perpVault.increaseOI(token2, true, 8 ether);
        perpVault.increaseOI(token3, false, 2 ether);
        vm.stopPrank();

        // Cross-validate: per-token OI
        (uint256 long1, uint256 short1) = perpVault.getTokenOI(token1);
        assertEq(long1, 5 ether, "Token1 long OI");
        assertEq(short1, 3 ether, "Token1 short OI");

        (uint256 long2, uint256 short2) = perpVault.getTokenOI(token2);
        assertEq(long2, 8 ether, "Token2 long OI");
        assertEq(short2, 0, "Token2 short OI");

        (uint256 long3, uint256 short3) = perpVault.getTokenOI(token3);
        assertEq(long3, 0, "Token3 long OI");
        assertEq(short3, 2 ether, "Token3 short OI");

        // Cross-validate: total OI accumulator
        uint256 totalOI = perpVault.getTotalOI();
        uint256 manualTotalOI = 5 ether + 3 ether + 8 ether + 2 ether;
        assertEq(totalOI, manualTotalOI, "Total OI must equal sum of all positions");

        // Partially close
        vm.prank(matchingEngine);
        perpVault.decreaseOI(token1, true, 2 ether);

        // Cross-validate after decrease
        (uint256 long1After,) = perpVault.getTokenOI(token1);
        assertEq(long1After, 3 ether, "Token1 long OI after decrease");
        assertEq(perpVault.getTotalOI(), manualTotalOI - 2 ether, "Total OI after decrease");
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 9: Fee 收集交叉验证
    // ═══════════════════════════════════════════════════════════════

    /// @notice 验证: 交易费收集后 → 池子价值增加 → 份额价格增加 → LP 受益
    function test_E2E_PerpVault_FeeCollection_LPBenefit() public {
        vm.prank(lp1);
        perpVault.deposit{value: 10 ether}();

        uint256 sharePriceBefore = perpVault.getSharePrice();
        uint256 poolValueBefore = perpVault.getPoolValue();

        // Matching engine collects 0.5 ETH trading fee
        vm.prank(matchingEngine);
        perpVault.collectFee{value: 0.5 ether}(0.5 ether);

        // Cross-validate: pool value increased
        uint256 poolValueAfter = perpVault.getPoolValue();
        assertEq(poolValueAfter, poolValueBefore + 0.5 ether, "Pool value must increase by fee");

        // Cross-validate: share price increased
        uint256 sharePriceAfter = perpVault.getSharePrice();
        assertGt(sharePriceAfter, sharePriceBefore, "Share price must increase after fee");

        // Cross-validate: totalFeesCollected updated
        // Note: deposit fee was already collected, so total = deposit_fee + 0.5 ETH
        uint256 depositFee = _calcFee(10 ether, DEPOSIT_FEE_BPS);
        assertEq(perpVault.totalFeesCollected(), depositFee + 0.5 ether, "Total fees must track correctly");
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 10: Liquidation → PerpVault 交叉验证
    // ═══════════════════════════════════════════════════════════════

    /// @notice 验证: 清算 → 保证金进池 → 奖励给清算者 → 池子价值增加
    function test_E2E_PerpVault_Liquidation_Settlement() public {
        vm.prank(lp1);
        perpVault.deposit{value: 10 ether}();

        uint256 poolBefore = perpVault.getRawBalance();
        address liquidator = makeAddr("liquidator");

        // Liquidation: 1 ETH collateral, 0.05 ETH reward
        vm.prank(matchingEngine);
        perpVault.settleLiquidation{value: 1 ether}(1 ether, 0.05 ether, liquidator);

        // Cross-validate: pool got collateral minus reward
        uint256 poolAfter = perpVault.getRawBalance();
        assertEq(poolAfter, poolBefore + 1 ether - 0.05 ether, "Pool balance = +collateral -reward");

        // Cross-validate: liquidator got reward
        assertEq(liquidator.balance, 0.05 ether, "Liquidator must receive reward");

        // Cross-validate: stats updated
        assertEq(perpVault.totalLiquidationReceived(), 1 ether, "Liquidation stats must track");
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 11: 存款顺序公平性 — 存款前后 PnL 变化
    // ═══════════════════════════════════════════════════════════════

    /// @notice 验证: LP2 在 traders 亏钱后存款，不应享受之前的利润
    function test_E2E_PerpVault_DepositAfterTraderLoss_NoFreeLunch() public {
        // LP1 deposits first
        vm.prank(lp1);
        perpVault.deposit{value: 10 ether}();

        uint256 lp1SharesBefore = perpVault.shares(lp1);

        // Traders lose 3 ETH → pool value increases (LP1 profits)
        vm.prank(matchingEngine);
        perpVault.settleTraderLoss{value: 3 ether}(3 ether);

        uint256 sharePriceAfterLoss = perpVault.getSharePrice();

        // LP2 deposits AFTER trader loss — pays higher share price
        vm.prank(lp2);
        perpVault.deposit{value: 10 ether}();

        uint256 lp2Shares = perpVault.shares(lp2);

        // Cross-validate: LP2 got FEWER shares than LP1 for same ETH
        // because share price is now higher
        assertLt(lp2Shares, lp1SharesBefore, "LP2 must get fewer shares (higher entry price)");

        // Cross-validate: LP1's value > LP2's value
        uint256 lp1Value = perpVault.getLPValue(lp1);
        uint256 lp2Value = perpVault.getLPValue(lp2);
        assertGt(lp1Value, lp2Value, "LP1 must have more value (was in during profit)");

        // LP2's value should be approximately 10 ETH minus fee (they joined after profit)
        // Tolerance wider because deposit fee redistributes within the pool
        uint256 lp2Fee = _calcFee(10 ether, DEPOSIT_FEE_BPS);
        _assertApproxEq(lp2Value, 10 ether - lp2Fee, 0.1 ether, "LP2 value should be ~10 ETH minus fee");
    }

    /// @notice 验证: LP2 在 traders 盈利时存款，获得折扣但承担持续风险
    function test_E2E_PerpVault_DepositDuringTraderProfit_DiscountEntry() public {
        vm.prank(lp1);
        perpVault.deposit{value: 10 ether}();

        // Traders profiting → pool value drops → share price drops
        vm.prank(matchingEngine);
        perpVault.updatePendingPnL(4 ether);

        uint256 depressedSharePrice = perpVault.getSharePrice();

        // LP2 deposits at depressed price
        vm.prank(lp2);
        perpVault.deposit{value: 10 ether}();

        uint256 lp2Shares = perpVault.shares(lp2);

        // If PnL reverts to 0 (traders close even), LP2 profits
        vm.prank(matchingEngine);
        perpVault.updatePendingPnL(0);

        uint256 lp2ValueAfterRecovery = perpVault.getLPValue(lp2);
        uint256 lp2Fee = _calcFee(10 ether, DEPOSIT_FEE_BPS);

        // LP2 should be up because they bought at depressed price
        assertGt(lp2ValueAfterRecovery, 10 ether - lp2Fee, "LP2 should profit from buying dip");
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 12: 取款过程的 Conservation 验证
    // ═══════════════════════════════════════════════════════════════

    /// @notice 验证: 多人取款后，剩余 LP 的价值 + 取走的 ETH ≈ 初始总存款
    function test_E2E_PerpVault_Withdrawal_Conservation() public {
        // 3 LPs deposit
        vm.prank(lp1);
        perpVault.deposit{value: 10 ether}();
        vm.prank(lp2);
        perpVault.deposit{value: 20 ether}();
        vm.prank(lp3);
        perpVault.deposit{value: 15 ether}();

        // LP1 requests full withdrawal
        uint256 lp1AllShares = perpVault.shares(lp1);
        vm.prank(lp1);
        perpVault.requestWithdrawal(lp1AllShares);

        vm.warp(block.timestamp + 25 hours);

        uint256 lp1BalBefore = lp1.balance;
        vm.prank(lp1);
        perpVault.executeWithdrawal();
        uint256 lp1Withdrawn = lp1.balance - lp1BalBefore;

        // Remaining LPs' value should still be consistent
        uint256 lp2Value = perpVault.getLPValue(lp2);
        uint256 lp3Value = perpVault.getLPValue(lp3);
        uint256 deadValue = (DEAD_SHARES * perpVault.getSharePrice()) / PRECISION;

        // Conservation: remaining LP values + dead shares ≈ pool value
        // (withdrawal fee stays in pool, benefiting remaining LPs)
        uint256 poolValue = perpVault.getPoolValue();
        _assertApproxEq(
            lp2Value + lp3Value + deadValue,
            poolValue,
            0.001 ether, // Allow small rounding from division
            "Remaining LP values must equal pool value"
        );

        // LP1's shares should be 0
        assertEq(perpVault.shares(lp1), 0, "LP1 shares must be 0 after full withdrawal");
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 13: TokenFactory → PriceFeed → PerpVault 多代币链路
    // ═══════════════════════════════════════════════════════════════

    /// @notice 多代币创建 → 每个代币独立价格 → OI 分别追踪
    function test_E2E_MultiToken_Create_PriceFeed_OI() public {
        // Create 3 tokens
        vm.prank(creator);
        address tokenA = tokenFactory.createToken{value: 0.001 ether}("AAA", "AAA", "ipfs://a", 0);
        vm.prank(creator);
        address tokenB = tokenFactory.createToken{value: 0.001 ether}("BBB", "BBB", "ipfs://b", 0);
        vm.prank(creator);
        address tokenC = tokenFactory.createToken{value: 0.001 ether}("CCC", "CCC", "ipfs://c", 0);

        // Buy on each to enable perp
        vm.prank(trader1);
        tokenFactory.buy{value: 7 ether}(tokenA, 0);
        vm.prank(trader2);
        tokenFactory.buy{value: 8 ether}(tokenB, 0);
        vm.prank(trader3);
        tokenFactory.buy{value: 10 ether}(tokenC, 0);

        // Cross-validate: each token has independent price in PriceFeed
        uint256 priceA = priceFeed.getTokenMarkPrice(tokenA);
        uint256 priceB = priceFeed.getTokenMarkPrice(tokenB);
        uint256 priceC = priceFeed.getTokenMarkPrice(tokenC);

        // Token C had most ETH bought → highest price
        assertGt(priceC, priceA, "TokenC should be pricier (more bought)");
        assertGt(priceC, priceB, "TokenC should be pricier than B");
        assertGt(priceB, priceA, "TokenB should be pricier than A");

        // Cross-validate: each matches factory price
        assertEq(priceA, tokenFactory.getCurrentPrice(tokenA), "TokenA prices must sync");
        assertEq(priceB, tokenFactory.getCurrentPrice(tokenB), "TokenB prices must sync");
        assertEq(priceC, tokenFactory.getCurrentPrice(tokenC), "TokenC prices must sync");

        // LP deposits to PerpVault
        vm.prank(lp1);
        perpVault.deposit{value: 50 ether}();

        // Open OI on each token
        vm.startPrank(matchingEngine);
        perpVault.increaseOI(tokenA, true, 5 ether);
        perpVault.increaseOI(tokenB, false, 8 ether);
        perpVault.increaseOI(tokenC, true, 10 ether);
        vm.stopPrank();

        // Cross-validate: per-token OI is independent
        (uint256 longA,) = perpVault.getTokenOI(tokenA);
        (,uint256 shortB) = perpVault.getTokenOI(tokenB);
        (uint256 longC,) = perpVault.getTokenOI(tokenC);

        assertEq(longA, 5 ether);
        assertEq(shortB, 8 ether);
        assertEq(longC, 10 ether);

        // Cross-validate: total OI = sum
        assertEq(perpVault.getTotalOI(), 23 ether, "Total OI = 5 + 8 + 10");
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 14: LendingPool 利率模型交叉验证
    // ═══════════════════════════════════════════════════════════════

    /// @notice 验证: Aave-style 利率模型计算交叉验证
    function test_E2E_LendingPool_InterestRate_CrossValidation() public {
        // Create and enable lending
        vm.prank(creator);
        address token = tokenFactory.createToken{value: 0.001 ether}("RATE", "RATE", "ipfs://", 0);
        vm.prank(trader1);
        tokenFactory.buy{value: 7 ether}(token, 0);

        // Deposit tokens
        uint256 bal = MemeTokenV2(token).balanceOf(trader1);
        vm.prank(trader1);
        MemeTokenV2(token).approve(address(lendingPool), bal);
        vm.prank(trader1);
        lendingPool.deposit(token, bal);

        // Authorize and borrow 50%
        lendingPool.setAuthorizedContract(matchingEngine, true);
        uint256 borrowAmt = bal / 2;

        vm.prank(matchingEngine);
        lendingPool.borrow(token, trader2, borrowAmt);

        // Cross-validate: utilization = borrowed / deposited = 50%
        uint256 utilization = lendingPool.getUtilization(token);
        uint256 manualUtil = (borrowAmt * PRECISION) / bal;
        assertEq(utilization, manualUtil, "Utilization must match");

        // Cross-validate: borrow rate at 50% utilization (below 80% kink)
        // Rate = BASE_RATE + (utilization * SLOPE1) / OPTIMAL_UTILIZATION
        // Rate = 2% + (50% * 4%) / 80% = 2% + 2.5% = 4.5%
        uint256 borrowRate = lendingPool.getBorrowRate(token);
        uint256 manualBorrowRate = 2e16 + (utilization * 4e16) / 80e16;
        assertEq(borrowRate, manualBorrowRate, "Borrow rate must match Aave kinked model");

        // Borrow more to go above kink (80%)
        uint256 borrowMore = (bal * 35) / 100; // total borrow = 85%
        vm.prank(matchingEngine);
        lendingPool.borrow(token, trader3, borrowMore);

        uint256 newUtil = lendingPool.getUtilization(token);
        assertGt(newUtil, 80e16, "Utilization should be above kink");

        // Cross-validate rate above kink
        uint256 highRate = lendingPool.getBorrowRate(token);
        // Rate = BASE + SLOPE1 + (excess * SLOPE2) / maxExcess
        uint256 excess = newUtil - 80e16;
        uint256 maxExcess = PRECISION - 80e16;
        uint256 manualHighRate = 2e16 + 4e16 + (excess * 75e16) / maxExcess;
        assertEq(highRate, manualHighRate, "High rate must match kinked model above kink");
        assertGt(highRate, borrowRate, "Rate above kink must be higher");
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 15: Deposit Cap 与 Pause 交叉验证
    // ═══════════════════════════════════════════════════════════════

    /// @notice 验证存款上限和暂停功能
    function test_E2E_PerpVault_DepositCap_And_Pause() public {
        // Set max pool value to 20 ETH
        perpVault.setMaxPoolValue(20 ether);

        // First deposit: 10 ETH (OK)
        vm.prank(lp1);
        perpVault.deposit{value: 10 ether}();

        // Second deposit: 15 ETH (would exceed 20 ETH cap)
        vm.prank(lp2);
        vm.expectRevert(PerpVault.ExceedsMaxPoolValue.selector);
        perpVault.deposit{value: 15 ether}();

        // But 8 ETH is fine
        vm.prank(lp2);
        perpVault.deposit{value: 8 ether}();

        // Pause deposits
        perpVault.setDepositsPaused(true);

        vm.prank(lp3);
        vm.expectRevert(PerpVault.DepositsPausedError.selector);
        perpVault.deposit{value: 1 ether}();

        // Withdrawals still work when deposits paused
        uint256 lp1Shares = perpVault.shares(lp1);
        vm.prank(lp1);
        perpVault.requestWithdrawal(lp1Shares / 2);

        vm.warp(block.timestamp + 25 hours);

        vm.prank(lp1);
        perpVault.executeWithdrawal();
        // No revert = withdrawals work during deposit pause

        // Unpause
        perpVault.setDepositsPaused(false);
        vm.prank(lp3);
        perpVault.deposit{value: 1 ether}();
        // No revert = deposits work again
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 16: Cooldown 交叉验证
    // ═══════════════════════════════════════════════════════════════

    /// @notice 验证可配置冷却期正确执行
    function test_E2E_PerpVault_Cooldown_CrossValidation() public {
        // Set cooldown to 12 hours
        perpVault.setCooldown(12 hours);
        assertEq(perpVault.withdrawalCooldown(), 12 hours, "Cooldown should be 12h");

        vm.prank(lp1);
        perpVault.deposit{value: 10 ether}();

        uint256 halfShares = perpVault.shares(lp1) / 2;
        vm.prank(lp1);
        perpVault.requestWithdrawal(halfShares);

        // Try at 11 hours: should fail
        vm.warp(block.timestamp + 11 hours);
        vm.prank(lp1);
        vm.expectRevert(PerpVault.CooldownNotMet.selector);
        perpVault.executeWithdrawal();

        // Try at 13 hours: should succeed
        vm.warp(block.timestamp + 2 hours);
        vm.prank(lp1);
        perpVault.executeWithdrawal();
        // No revert = success

        // Set zero cooldown: instant withdrawal
        perpVault.setCooldown(0);

        uint256 remainingShares = perpVault.shares(lp1);
        vm.prank(lp1);
        perpVault.requestWithdrawal(remainingShares);

        // Should work immediately (zero cooldown)
        vm.prank(lp1);
        perpVault.executeWithdrawal();

        assertEq(perpVault.shares(lp1), 0, "All shares withdrawn");
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 17: 综合 — 完整生命周期场景
    // ═══════════════════════════════════════════════════════════════

    /// @notice 完整生命周期: 代币创建 → 交易 → LP赚钱 → LP亏钱 → 清算 → 最终结算
    function test_E2E_FullLifecycle_Complex() public {
        // ── Step 1: Create tokens ──
        vm.prank(creator);
        address token = tokenFactory.createToken{value: 0.001 ether}("LIFE", "LIFE", "ipfs://", 0);

        vm.prank(trader1);
        tokenFactory.buy{value: 7 ether}(token, 0);

        // ── Step 2: LPs deposit ──
        vm.prank(lp1);
        perpVault.deposit{value: 20 ether}();
        vm.prank(lp2);
        perpVault.deposit{value: 30 ether}();

        uint256 lp1InitialValue = perpVault.getLPValue(lp1);
        uint256 lp2InitialValue = perpVault.getLPValue(lp2);

        // ── Step 3: Trading round 1 — traders lose ──
        vm.startPrank(matchingEngine);
        perpVault.increaseOI(token, true, 10 ether);
        perpVault.settleTraderLoss{value: 3 ether}(3 ether);
        perpVault.updatePendingPnL(0); // settled, no more pending
        vm.stopPrank();

        // LP values should increase (traders lost)
        uint256 lp1AfterRound1 = perpVault.getLPValue(lp1);
        assertGt(lp1AfterRound1, lp1InitialValue, "LP1 gains from trader loss");

        // ── Step 4: Trading round 2 — traders win ──
        vm.startPrank(matchingEngine);
        perpVault.settleTraderProfit(trader1, 5 ether);
        vm.stopPrank();

        uint256 lp1AfterRound2 = perpVault.getLPValue(lp1);
        assertLt(lp1AfterRound2, lp1AfterRound1, "LP1 loses from trader profit");

        // ── Step 5: Liquidation — pool recovers some ──
        vm.prank(matchingEngine);
        perpVault.settleLiquidation{value: 2 ether}(2 ether, 0.1 ether, makeAddr("liqBot"));

        uint256 lp1AfterLiq = perpVault.getLPValue(lp1);
        assertGt(lp1AfterLiq, lp1AfterRound2, "LP1 gains from liquidation");

        // ── Step 6: Fee collection ──
        vm.prank(matchingEngine);
        perpVault.collectFee{value: 0.5 ether}(0.5 ether);

        // ── Step 7: Close all positions ──
        vm.prank(matchingEngine);
        perpVault.decreaseOI(token, true, 10 ether);

        // ── Step 8: Both LPs withdraw ──
        uint256 lp1AllShares = perpVault.shares(lp1);
        uint256 lp2AllShares = perpVault.shares(lp2);
        vm.prank(lp1);
        perpVault.requestWithdrawal(lp1AllShares);
        vm.prank(lp2);
        perpVault.requestWithdrawal(lp2AllShares);

        vm.warp(block.timestamp + 25 hours);

        uint256 lp1BalBefore = lp1.balance;
        uint256 lp2BalBefore = lp2.balance;

        vm.prank(lp1);
        perpVault.executeWithdrawal();
        vm.prank(lp2);
        perpVault.executeWithdrawal();

        uint256 lp1Received = lp1.balance - lp1BalBefore;
        uint256 lp2Received = lp2.balance - lp2BalBefore;

        // Both should have received something
        assertGt(lp1Received, 0, "LP1 withdrew ETH");
        assertGt(lp2Received, 0, "LP2 withdrew ETH");

        // LP2 deposited 1.5x of LP1, so LP2 should receive ~1.5x of LP1
        uint256 ratio = (lp2Received * 100) / lp1Received;
        // Allow 10% tolerance
        assertGe(ratio, 135, "LP2 should receive roughly 1.5x LP1 (min 135%)");
        assertLe(ratio, 165, "LP2 should receive roughly 1.5x LP1 (max 165%)");

        // Final: pool should only have dead shares' value + accumulated withdrawal fees
        // Dead shares hold ~0.09 ETH (fees from deposits/withdrawals stay in pool)
        assertLe(perpVault.getRawBalance(), 0.2 ether, "Pool should be nearly empty (only dead share value + fees remain)");
        // Only dead shares should remain
        assertEq(perpVault.shares(lp1), 0, "LP1 should have 0 shares");
        assertEq(perpVault.shares(lp2), 0, "LP2 should have 0 shares");
    }
}

// ═══════════════════════════════════════════════════════════════
// MOCK: Uniswap Router for graduation tests
// ═══════════════════════════════════════════════════════════════

contract MockUniswapRouter {
    address public factory;

    constructor() {
        factory = address(new MockUniswapFactory());
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256,
        uint256,
        address,
        uint256
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        return (amountTokenDesired, msg.value, msg.value);
    }
}

contract MockUniswapFactory {
    function getPair(address, address) external view returns (address) {
        return address(this);
    }
}

/// @notice Mock vault that receives trader profits from PerpVault
contract MockVault {
    receive() external payable {}
}
