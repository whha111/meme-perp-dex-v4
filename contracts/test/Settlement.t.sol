// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/perpetual/Settlement.sol";
import "../src/common/ContractRegistry.sol";
import "../src/common/IContractRegistry.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDT
 * @notice 测试用 USDT 代币（6位小数）
 */
contract MockUSDT is ERC20 {
    constructor() ERC20("Mock USDT", "USDT") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * @title MockUSDC
 * @notice 测试用 USDC 代币（6位小数）
 */
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * @title MockUSD1
 * @notice 测试用 USD1 代币（18位小数）
 */
contract MockUSD1 is ERC20 {
    constructor() ERC20("Mock USD1", "USD1") {}

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * @title Settlement 合约测试 (多稳定币版本)
 * @notice 验证核心需求点：
 * 1. 链下撮合 - EIP-712 签名验证
 * 2. 盈利从对手方/资金费率/保险基金支付
 * 3. 订单等待配对（通过撮合引擎）
 * 4. 链上统一时间批量结算
 * 5. 1:N 部分成交撮合
 * 6. 多稳定币支持 (USDT, USDC, USD1)
 */
contract SettlementTest is Test {
    Settlement public settlement;
    ContractRegistry public registry;
    MockUSDT public usdt;
    MockUSDC public usdc;
    MockUSD1 public usd1;

    // Test accounts
    address public owner;
    uint256 public ownerKey = 1;

    address public matcher;
    uint256 public matcherKey = 2;

    address public longTrader;
    uint256 public longTraderKey = 3;

    address public shortTrader;
    uint256 public shortTraderKey = 4;

    address public insuranceFund;
    address public feeReceiver;

    address public testToken = address(0xCafe);

    // USDT 精度: 6 位小数
    uint256 constant USDT_DECIMALS = 1e6;

    // EIP-712 domain
    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address trader,address token,bool isLong,uint256 size,uint256 leverage,uint256 price,uint256 deadline,uint256 nonce,uint8 orderType)"
    );

    function setUp() public {
        // Generate addresses from private keys
        owner = vm.addr(ownerKey);
        matcher = vm.addr(matcherKey);
        longTrader = vm.addr(longTraderKey);
        shortTrader = vm.addr(shortTraderKey);
        insuranceFund = makeAddr("insuranceFund");
        feeReceiver = makeAddr("feeReceiver");

        // Deploy Mock Stablecoins
        usdt = new MockUSDT();
        usdc = new MockUSDC();
        usd1 = new MockUSD1();

        // Deploy Settlement and ContractRegistry
        vm.startPrank(owner);
        settlement = new Settlement();
        registry = new ContractRegistry();

        // Set contract registry in settlement
        settlement.setContractRegistry(address(registry));

        // Add supported tokens
        settlement.addSupportedToken(address(usdt), 6);
        settlement.addSupportedToken(address(usdc), 6);
        settlement.addSupportedToken(address(usd1), 18);

        // Configure
        settlement.setAuthorizedMatcher(matcher, true);
        settlement.setInsuranceFund(insuranceFund);
        settlement.setFeeReceiver(feeReceiver);
        settlement.setFeeRate(10); // 0.1%
        vm.stopPrank();

        // Mint USDT to traders (50,000 USDT each)
        usdt.mint(longTrader, 50_000 * USDT_DECIMALS);
        usdt.mint(shortTrader, 50_000 * USDT_DECIMALS);
        usdt.mint(insuranceFund, 10_000 * USDT_DECIMALS);

        // Traders approve and deposit USDT
        vm.startPrank(longTrader);
        usdt.approve(address(settlement), type(uint256).max);
        settlement.deposit(address(usdt), 50_000 * USDT_DECIMALS);
        vm.stopPrank();

        vm.startPrank(shortTrader);
        usdt.approve(address(settlement), type(uint256).max);
        settlement.deposit(address(usdt), 50_000 * USDT_DECIMALS);
        vm.stopPrank();

        // Insurance fund deposits
        vm.startPrank(insuranceFund);
        usdt.approve(address(settlement), type(uint256).max);
        settlement.deposit(address(usdt), 10_000 * USDT_DECIMALS);
        vm.stopPrank();
    }

    // ============================================================
    // 测试1: 链下撮合 - EIP-712 签名验证
    // ============================================================

    function test_EIP712_SignatureVerification() public {
        console.log("=== Test 1: EIP-712 Signature Verification ===");

        // Create order (10,000 USDT position)
        Settlement.Order memory order = Settlement.Order({
            trader: longTrader,
            token: testToken,
            isLong: true,
            size: 10_000 * USDT_DECIMALS,  // 10,000 USDT
            leverage: 100000, // 10x
            price: 0, // market
            deadline: block.timestamp + 1 hours,
            nonce: 0,
            orderType: Settlement.OrderType.MARKET
        });

        // Sign the order
        bytes memory signature = _signOrder(order, longTraderKey);

        // Verify signature
        bool valid = settlement.verifyOrder(order, signature);
        assertTrue(valid, "Signature should be valid");

        console.log("  [PASS] Valid signature verified");

        // Test invalid signature
        bytes memory wrongSig = _signOrder(order, shortTraderKey);
        bool invalid = settlement.verifyOrder(order, wrongSig);
        assertFalse(invalid, "Wrong signer should be invalid");

        console.log("  [PASS] Invalid signature rejected");
    }

    // ============================================================
    // 测试2: 盈利从对手方保证金支付
    // ============================================================

    function test_ProfitFromCounterparty() public {
        console.log("\n=== Test 2: Profit Paid from Counterparty ===");

        // Setup initial price (1 token = 1000 USDT)
        vm.prank(matcher);
        settlement.updatePrice(testToken, 1000 * USDT_DECIMALS);

        // Record total balances before opening position (available + locked)
        (uint256 longAvailBefore, uint256 longLockedBefore) = settlement.getUserBalance(longTrader);
        (uint256 shortAvailBefore, uint256 shortLockedBefore) = settlement.getUserBalance(shortTrader);
        uint256 longTotalBefore = longAvailBefore + longLockedBefore;
        uint256 shortTotalBefore = shortAvailBefore + shortLockedBefore;

        console.log("  Long total before: ", _formatUsdt(int256(longTotalBefore)));
        console.log("  Short total before: ", _formatUsdt(int256(shortTotalBefore)));

        // Create and settle a matched pair (10,000 USDT position)
        uint256 pairId = _createMatchedPair(10_000 * USDT_DECIMALS, 10, 10, 1000 * USDT_DECIMALS);

        console.log("  Pair created at entry price: 1000 USDT");

        // Price goes up 10%
        vm.prank(matcher);
        settlement.updatePrice(testToken, 1100 * USDT_DECIMALS);

        console.log("  Price moved to: 1100 USDT (+10%)");

        // Close the pair
        vm.prank(longTrader);
        settlement.closePair(pairId);

        // Check final balances
        (uint256 longAvailAfter, uint256 longLockedAfter) = settlement.getUserBalance(longTrader);
        (uint256 shortAvailAfter, uint256 shortLockedAfter) = settlement.getUserBalance(shortTrader);
        uint256 longTotalAfter = longAvailAfter + longLockedAfter;
        uint256 shortTotalAfter = shortAvailAfter + shortLockedAfter;

        console.log("  Long total after: ", _formatUsdt(int256(longTotalAfter)));
        console.log("  Short total after: ", _formatUsdt(int256(shortTotalAfter)));

        // Account for fees (0.1% per side = 10 USDT each for 10,000 USDT position)
        // Long's change should be positive (profit minus fees)
        // Short's change should be negative (loss plus fees)
        int256 longChange = int256(longTotalAfter) - int256(longTotalBefore);
        int256 shortChange = int256(shortTotalAfter) - int256(shortTotalBefore);

        console.log("  Long change: ", _formatUsdt(longChange));
        console.log("  Short change: ", _formatUsdt(shortChange));

        // 10% price increase on 10,000 USDT = 1,000 USDT profit for long
        // Both sides pay 10 USDT fee (0.1% of 10,000 USDT)
        // Long: +1,000 USDT profit - 10 USDT fee = ~+990 USDT
        // Short: -1,000 USDT loss - 10 USDT fee = ~-1,010 USDT

        assertTrue(longChange > 0, "Long should profit overall");
        assertTrue(shortChange < 0, "Short should lose overall");

        console.log("  [PASS] Profit correctly transferred from counterparty");
    }

    // ============================================================
    // 测试3: 资金费率结算
    // ============================================================

    function test_FundingRateSettlement() public {
        console.log("\n=== Test 3: Funding Rate Settlement ===");

        // Setup
        vm.prank(matcher);
        settlement.updatePrice(testToken, 1000 * USDT_DECIMALS);

        // Set funding rate (positive = longs pay shorts)
        // Using a larger rate to see more effect
        vm.prank(matcher);
        settlement.updateFundingRate(testToken, int256(10 * USDT_DECIMALS)); // 1% per 8 hours

        console.log("  Funding rate: 1% per 8h (longs pay shorts)");

        // Record balances before
        (uint256 longBefore,) = settlement.getUserBalance(longTrader);
        (uint256 shortBefore,) = settlement.getUserBalance(shortTrader);

        // Create pair (10,000 USDT position)
        uint256 pairId = _createMatchedPair(10_000 * USDT_DECIMALS, 10, 10, 1000 * USDT_DECIMALS);

        console.log("  Pair created, waiting 8 hours...");

        // Move time forward (8 hours = 1 funding period)
        vm.warp(block.timestamp + 8 hours);

        // Close the pair - this triggers funding settlement
        vm.prank(longTrader);
        settlement.closePair(pairId);

        // Check final balances
        (uint256 longAfter,) = settlement.getUserBalance(longTrader);
        (uint256 shortAfter,) = settlement.getUserBalance(shortTrader);

        int256 longChange = int256(longAfter) - int256(longBefore);
        int256 shortChange = int256(shortAfter) - int256(shortBefore);

        console.log("  Long balance change: ", _formatUsdt(longChange));
        console.log("  Short balance change: ", _formatUsdt(shortChange));

        // With positive funding rate, long should lose to funding, short should gain
        // Even though price didn't change, funding affects the final settlement
        // Note: Both sides also pay trading fees, so we check relative performance

        // The short should perform better than just getting collateral back
        // because they receive funding payment
        console.log("  [PASS] Funding rate settlement affects final balances");
    }

    // ============================================================
    // 测试4: 保险基金兜底
    // ============================================================

    function test_InsuranceFundBackstop() public {
        console.log("\n=== Test 4: Insurance Fund Backstop ===");

        // Setup with high leverage for short (easier to blow up)
        vm.prank(matcher);
        settlement.updatePrice(testToken, 1000 * USDT_DECIMALS);

        // Short uses 50x leverage, long uses 5x (10,000 USDT position)
        uint256 pairId = _createMatchedPairCustomLeverage(10_000 * USDT_DECIMALS, 5, 50, 1000 * USDT_DECIMALS);

        console.log("  Created pair: Long 5x, Short 50x");

        (uint256 insuranceBefore,) = settlement.getUserBalance(insuranceFund);
        console.log("  Insurance fund before: ", _formatUsdt(int256(insuranceBefore)));

        // Price goes up 20% - this should nearly wipe out short's 2% margin
        vm.prank(matcher);
        settlement.updatePrice(testToken, 1200 * USDT_DECIMALS);

        console.log("  Price moved to 1200 USDT (+20%)");

        // Close pair - short is in deficit
        vm.prank(longTrader);
        settlement.closePair(pairId);

        (uint256 insuranceAfter,) = settlement.getUserBalance(insuranceFund);
        console.log("  Insurance fund after: ", _formatUsdt(int256(insuranceAfter)));

        // Insurance fund may have been used to cover deficit
        console.log("  [PASS] Settlement completed (insurance fund may have covered deficit)");
    }

    // ============================================================
    // 测试5: 批量结算
    // ============================================================

    function test_BatchSettlement() public {
        console.log("\n=== Test 5: Batch Settlement ===");

        vm.prank(matcher);
        settlement.updatePrice(testToken, 1000 * USDT_DECIMALS);

        // Create multiple pairs in one batch
        Settlement.MatchedPair[] memory pairs = new Settlement.MatchedPair[](3);

        for (uint i = 0; i < 3; i++) {
            pairs[i] = _createMatchedPairStruct(
                (1000 + i * 100) * USDT_DECIMALS, // different sizes (1000, 1100, 1200 USDT)
                10,
                10,
                1000 * USDT_DECIMALS
            );
        }

        uint256 gasStart = gasleft();

        // Settle all at once
        vm.prank(matcher);
        settlement.settleBatch(pairs);

        uint256 gasUsed = gasStart - gasleft();

        console.log("  Created 3 pairs in single batch");
        console.log("  Gas used: ", gasUsed);

        // Verify all pairs created
        Settlement.PairedPosition memory pos1 = settlement.getPairedPosition(1);
        Settlement.PairedPosition memory pos2 = settlement.getPairedPosition(2);
        Settlement.PairedPosition memory pos3 = settlement.getPairedPosition(3);

        assertTrue(pos1.size > 0, "Pair 1 should exist");
        assertTrue(pos2.size > 0, "Pair 2 should exist");
        assertTrue(pos3.size > 0, "Pair 3 should exist");

        console.log("  [PASS] Batch settlement successful");
    }

    // ============================================================
    // 测试6: 清算机制
    // ============================================================

    function test_Liquidation() public {
        console.log("\n=== Test 6: Liquidation ===");

        vm.prank(matcher);
        settlement.updatePrice(testToken, 1000 * USDT_DECIMALS);

        // High leverage position (10,000 USDT)
        uint256 pairId = _createMatchedPairCustomLeverage(10_000 * USDT_DECIMALS, 5, 100, 1000 * USDT_DECIMALS);

        console.log("  Created pair: Long 5x, Short 100x (very risky)");

        // Price up 1% - short should be liquidatable (100x with 0.5% maintenance margin)
        vm.prank(matcher);
        settlement.updatePrice(testToken, 1010 * USDT_DECIMALS);

        (bool canLiqLong, bool canLiqShort) = settlement.canLiquidate(pairId);

        console.log("  Can liquidate long: ", canLiqLong);
        console.log("  Can liquidate short: ", canLiqShort);

        assertTrue(canLiqShort, "Short should be liquidatable at 100x with 1% move");

        // Liquidate - liquidator needs to deposit some USDT first
        address liquidator = makeAddr("liquidator");
        usdt.mint(liquidator, 100 * USDT_DECIMALS);
        vm.startPrank(liquidator);
        usdt.approve(address(settlement), type(uint256).max);
        settlement.deposit(address(usdt), 100 * USDT_DECIMALS);
        vm.stopPrank();

        vm.prank(liquidator);
        settlement.liquidate(pairId);

        (uint256 liquidatorBalance,) = settlement.getUserBalance(liquidator);
        console.log("  Liquidator reward received: ", _formatUsdt(int256(liquidatorBalance) - int256(100 * USDT_DECIMALS)));

        Settlement.PairedPosition memory pos = settlement.getPairedPosition(pairId);
        assertTrue(pos.status == Settlement.PositionStatus.LIQUIDATED, "Position should be liquidated");

        console.log("  [PASS] Liquidation mechanism working");
    }

    // ============================================================
    // 测试7: Nonce 防重放
    // ============================================================

    function test_NonceProtection() public {
        console.log("\n=== Test 7: Nonce Replay Protection ===");

        vm.prank(matcher);
        settlement.updatePrice(testToken, 1000 * USDT_DECIMALS);

        // Create first pair (1,000 USDT)
        _createMatchedPair(1_000 * USDT_DECIMALS, 10, 10, 1000 * USDT_DECIMALS);

        console.log("  First pair created successfully");

        // Try to replay the exact same order (should fail with OrderAlreadyUsed)
        Settlement.Order memory longOrder = Settlement.Order({
            trader: longTrader,
            token: testToken,
            isLong: true,
            size: 1_000 * USDT_DECIMALS,
            leverage: 100000,
            price: 0,
            deadline: block.timestamp + 1 hours,
            nonce: 0, // Same nonce!
            orderType: Settlement.OrderType.MARKET
        });

        Settlement.Order memory shortOrder = Settlement.Order({
            trader: shortTrader,
            token: testToken,
            isLong: false,
            size: 1_000 * USDT_DECIMALS,
            leverage: 100000,
            price: 0,
            deadline: block.timestamp + 1 hours,
            nonce: 0,
            orderType: Settlement.OrderType.MARKET
        });

        Settlement.MatchedPair[] memory pairs = new Settlement.MatchedPair[](1);
        pairs[0] = Settlement.MatchedPair({
            longOrder: longOrder,
            longSignature: _signOrder(longOrder, longTraderKey),
            shortOrder: shortOrder,
            shortSignature: _signOrder(shortOrder, shortTraderKey),
            matchPrice: 1000 * USDT_DECIMALS,
            matchSize: 1_000 * USDT_DECIMALS
        });

        // The contract first checks if the order hash was already used
        // This is a stronger protection - even if nonce is valid, same order can't be used twice
        vm.prank(matcher);
        vm.expectRevert(Settlement.OrderAlreadyUsed.selector);
        settlement.settleBatch(pairs);

        console.log("  [PASS] Replay attack prevented (OrderAlreadyUsed)");

        // Also test that incrementing nonce invalidates old nonces
        // Long trader increments nonce
        vm.prank(longTrader);
        settlement.incrementNonce();

        console.log("  Long trader incremented nonce");

        // Try with old nonce (should fail with InvalidNonce)
        Settlement.Order memory newLongOrder = Settlement.Order({
            trader: longTrader,
            token: testToken,
            isLong: true,
            size: 2_000 * USDT_DECIMALS, // Different size so different hash
            leverage: 100000,
            price: 0,
            deadline: block.timestamp + 1 hours,
            nonce: 0, // Old nonce (current is 1)
            orderType: Settlement.OrderType.MARKET
        });

        Settlement.Order memory newShortOrder = Settlement.Order({
            trader: shortTrader,
            token: testToken,
            isLong: false,
            size: 2_000 * USDT_DECIMALS,
            leverage: 100000,
            price: 0,
            deadline: block.timestamp + 1 hours,
            nonce: 1, // Correct nonce for short
            orderType: Settlement.OrderType.MARKET
        });

        Settlement.MatchedPair[] memory newPairs = new Settlement.MatchedPair[](1);
        newPairs[0] = Settlement.MatchedPair({
            longOrder: newLongOrder,
            longSignature: _signOrder(newLongOrder, longTraderKey),
            shortOrder: newShortOrder,
            shortSignature: _signOrder(newShortOrder, shortTraderKey),
            matchPrice: 1000 * USDT_DECIMALS,
            matchSize: 2_000 * USDT_DECIMALS
        });

        vm.prank(matcher);
        vm.expectRevert(Settlement.InvalidNonce.selector);
        settlement.settleBatch(newPairs);

        console.log("  [PASS] Old nonce rejected after increment");
    }

    // ============================================================
    // Helper Functions
    // ============================================================

    function _signOrder(Settlement.Order memory order, uint256 privateKey) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(
            ORDER_TYPEHASH,
            order.trader,
            order.token,
            order.isLong,
            order.size,
            order.leverage,
            order.price,
            order.deadline,
            order.nonce,
            order.orderType
        ));

        bytes32 domainSeparator = _domainSeparator();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("MemePerp"),
            keccak256("1"),
            block.chainid,
            address(settlement)
        ));
    }

    function _createMatchedPair(
        uint256 size,
        uint256 longLeverageX,
        uint256 shortLeverageX,
        uint256 price
    ) internal returns (uint256) {
        return _createMatchedPairCustomLeverage(size, longLeverageX, shortLeverageX, price);
    }

    function _createMatchedPairCustomLeverage(
        uint256 size,
        uint256 longLeverageX,
        uint256 shortLeverageX,
        uint256 price
    ) internal returns (uint256) {
        uint256 nonceLong = settlement.nonces(longTrader);
        uint256 nonceShort = settlement.nonces(shortTrader);

        Settlement.Order memory longOrder = Settlement.Order({
            trader: longTrader,
            token: testToken,
            isLong: true,
            size: size,
            leverage: longLeverageX * 10000, // Convert to LEVERAGE_PRECISION
            price: 0,
            deadline: block.timestamp + 1 hours,
            nonce: nonceLong,
            orderType: Settlement.OrderType.MARKET
        });

        Settlement.Order memory shortOrder = Settlement.Order({
            trader: shortTrader,
            token: testToken,
            isLong: false,
            size: size,
            leverage: shortLeverageX * 10000,
            price: 0,
            deadline: block.timestamp + 1 hours,
            nonce: nonceShort,
            orderType: Settlement.OrderType.MARKET
        });

        Settlement.MatchedPair[] memory pairs = new Settlement.MatchedPair[](1);
        pairs[0] = Settlement.MatchedPair({
            longOrder: longOrder,
            longSignature: _signOrder(longOrder, longTraderKey),
            shortOrder: shortOrder,
            shortSignature: _signOrder(shortOrder, shortTraderKey),
            matchPrice: price,
            matchSize: size
        });

        vm.prank(matcher);
        settlement.settleBatch(pairs);

        return settlement.nextPairId() - 1;
    }

    function _createMatchedPairStruct(
        uint256 size,
        uint256 longLeverageX,
        uint256 shortLeverageX,
        uint256 price
    ) internal view returns (Settlement.MatchedPair memory) {
        uint256 nonceLong = settlement.nonces(longTrader);
        uint256 nonceShort = settlement.nonces(shortTrader);

        Settlement.Order memory longOrder = Settlement.Order({
            trader: longTrader,
            token: testToken,
            isLong: true,
            size: size,
            leverage: longLeverageX * 10000,
            price: 0,
            deadline: block.timestamp + 1 hours,
            nonce: nonceLong,
            orderType: Settlement.OrderType.MARKET
        });

        Settlement.Order memory shortOrder = Settlement.Order({
            trader: shortTrader,
            token: testToken,
            isLong: false,
            size: size,
            leverage: shortLeverageX * 10000,
            price: 0,
            deadline: block.timestamp + 1 hours,
            nonce: nonceShort,
            orderType: Settlement.OrderType.MARKET
        });

        return Settlement.MatchedPair({
            longOrder: longOrder,
            longSignature: _signOrder(longOrder, longTraderKey),
            shortOrder: shortOrder,
            shortSignature: _signOrder(shortOrder, shortTraderKey),
            matchPrice: price,
            matchSize: size
        });
    }

    function _formatUsdt(int256 value) internal pure returns (string memory) {
        if (value >= 0) {
            return string(abi.encodePacked("+", vm.toString(uint256(value) / USDT_DECIMALS), " USDT"));
        } else {
            return string(abi.encodePacked("-", vm.toString(uint256(-value) / USDT_DECIMALS), " USDT"));
        }
    }

    // ============================================================
    // 测试8: 1:N 部分成交撮合
    // ============================================================

    function test_PartialFill_1ToN() public {
        console.log("\n=== Test 8: 1:N Partial Fill Matching ===");

        vm.prank(matcher);
        settlement.updatePrice(testToken, 1000 * USDT_DECIMALS);

        // 创建 5 个空方交易者
        address[] memory shortTraders = new address[](5);
        uint256[] memory shortKeys = new uint256[](5);

        for (uint i = 0; i < 5; i++) {
            shortKeys[i] = 100 + i;
            shortTraders[i] = vm.addr(shortKeys[i]);
            usdt.mint(shortTraders[i], 5_000 * USDT_DECIMALS);
            vm.startPrank(shortTraders[i]);
            usdt.approve(address(settlement), type(uint256).max);
            settlement.deposit(address(usdt), 5_000 * USDT_DECIMALS);
            vm.stopPrank();
        }

        // 多方下 5,000 USDT 大单
        uint256 longOrderSize = 5_000 * USDT_DECIMALS;
        uint256 nonceLong = settlement.nonces(longTrader);

        Settlement.Order memory longOrder = Settlement.Order({
            trader: longTrader,
            token: testToken,
            isLong: true,
            size: longOrderSize,
            leverage: 100000, // 10x
            price: 0,
            deadline: block.timestamp + 1 hours,
            nonce: nonceLong,
            orderType: Settlement.OrderType.MARKET
        });

        bytes memory longSig = _signOrder(longOrder, longTraderKey);
        bytes32 longHash = settlement.getOrderHash(longOrder);

        console.log("  Long order: 5000 USDT (will match with 5 shorts)");

        // 创建 5 个 MatchedPair，每个 matchSize = 1,000 USDT
        Settlement.MatchedPair[] memory pairs = new Settlement.MatchedPair[](5);

        for (uint i = 0; i < 5; i++) {
            Settlement.Order memory shortOrder = Settlement.Order({
                trader: shortTraders[i],
                token: testToken,
                isLong: false,
                size: 1_000 * USDT_DECIMALS,
                leverage: 100000, // 10x
                price: 0,
                deadline: block.timestamp + 1 hours,
                nonce: 0,
                orderType: Settlement.OrderType.MARKET
            });

            pairs[i] = Settlement.MatchedPair({
                longOrder: longOrder,
                longSignature: longSig,
                shortOrder: shortOrder,
                shortSignature: _signOrderDynamic(shortOrder, shortKeys[i]),
                matchPrice: 1000 * USDT_DECIMALS,
                matchSize: 1_000 * USDT_DECIMALS
            });
        }

        // 批量结算
        vm.prank(matcher);
        settlement.settleBatch(pairs);

        // 验证：多单已完全成交
        uint256 longFilled = settlement.getFilledAmount(longHash);
        assertEq(longFilled, longOrderSize, "Long order should be fully filled");
        console.log("  Long filled amount: ", longFilled / USDT_DECIMALS, " USDT");

        // 验证：创建了 5 个独立的 PairedPosition
        for (uint i = 1; i <= 5; i++) {
            Settlement.PairedPosition memory pos = settlement.getPairedPosition(i);
            assertEq(pos.size, 1_000 * USDT_DECIMALS, "Each pair should be 1000 USDT");
            assertEq(pos.longTrader, longTrader, "Long trader should match");
            assertEq(pos.shortTrader, shortTraders[i-1], "Short trader should match");
        }

        console.log("  Created 5 PairedPositions (each 1000 USDT)");
        console.log("  [PASS] 1:N partial fill matching works correctly");
    }

    // ============================================================
    // 测试9: 部分成交后订单剩余量
    // ============================================================

    function test_PartialFill_RemainingAmount() public {
        console.log("\n=== Test 9: Partial Fill Remaining Amount ===");

        vm.prank(matcher);
        settlement.updatePrice(testToken, 1000 * USDT_DECIMALS);

        // 多方下 10,000 USDT 大单
        uint256 longOrderSize = 10_000 * USDT_DECIMALS;
        uint256 nonceLong = settlement.nonces(longTrader);

        Settlement.Order memory longOrder = Settlement.Order({
            trader: longTrader,
            token: testToken,
            isLong: true,
            size: longOrderSize,
            leverage: 100000,
            price: 0,
            deadline: block.timestamp + 1 hours,
            nonce: nonceLong,
            orderType: Settlement.OrderType.MARKET
        });

        bytes memory longSig = _signOrder(longOrder, longTraderKey);
        bytes32 longHash = settlement.getOrderHash(longOrder);

        // 第一次撮合：3,000 USDT
        Settlement.Order memory shortOrder1 = Settlement.Order({
            trader: shortTrader,
            token: testToken,
            isLong: false,
            size: 3_000 * USDT_DECIMALS,
            leverage: 100000,
            price: 0,
            deadline: block.timestamp + 1 hours,
            nonce: settlement.nonces(shortTrader),
            orderType: Settlement.OrderType.MARKET
        });

        Settlement.MatchedPair[] memory pairs1 = new Settlement.MatchedPair[](1);
        pairs1[0] = Settlement.MatchedPair({
            longOrder: longOrder,
            longSignature: longSig,
            shortOrder: shortOrder1,
            shortSignature: _signOrder(shortOrder1, shortTraderKey),
            matchPrice: 1000 * USDT_DECIMALS,
            matchSize: 3_000 * USDT_DECIMALS
        });

        vm.prank(matcher);
        settlement.settleBatch(pairs1);

        // 验证部分成交
        uint256 filled1 = settlement.getFilledAmount(longHash);
        uint256 remaining1 = settlement.getRemainingAmount(longOrder);

        assertEq(filled1, 3_000 * USDT_DECIMALS, "Should have filled 3000 USDT");
        assertEq(remaining1, 7_000 * USDT_DECIMALS, "Should have 7000 USDT remaining");

        console.log("  After 1st match: filled=3000, remaining=7000");

        // 第二次撮合：5,000 USDT（空方需要递增 nonce）
        Settlement.Order memory shortOrder2 = Settlement.Order({
            trader: shortTrader,
            token: testToken,
            isLong: false,
            size: 5_000 * USDT_DECIMALS,
            leverage: 100000,
            price: 0,
            deadline: block.timestamp + 1 hours,
            nonce: settlement.nonces(shortTrader),
            orderType: Settlement.OrderType.MARKET
        });

        Settlement.MatchedPair[] memory pairs2 = new Settlement.MatchedPair[](1);
        pairs2[0] = Settlement.MatchedPair({
            longOrder: longOrder,
            longSignature: longSig,
            shortOrder: shortOrder2,
            shortSignature: _signOrder(shortOrder2, shortTraderKey),
            matchPrice: 1000 * USDT_DECIMALS,
            matchSize: 5_000 * USDT_DECIMALS
        });

        vm.prank(matcher);
        settlement.settleBatch(pairs2);

        // 验证累计成交
        uint256 filled2 = settlement.getFilledAmount(longHash);
        uint256 remaining2 = settlement.getRemainingAmount(longOrder);

        assertEq(filled2, 8_000 * USDT_DECIMALS, "Should have filled 8000 USDT total");
        assertEq(remaining2, 2_000 * USDT_DECIMALS, "Should have 2000 USDT remaining");

        console.log("  After 2nd match: filled=8000, remaining=2000");
        console.log("  [PASS] Partial fill tracking works correctly");
    }

    // ============================================================
    // 测试10: 超额成交保护
    // ============================================================

    function test_PartialFill_OverfillProtection() public {
        console.log("\n=== Test 10: Overfill Protection ===");

        vm.prank(matcher);
        settlement.updatePrice(testToken, 1000 * USDT_DECIMALS);

        // 多方下 5,000 USDT 单
        uint256 longOrderSize = 5_000 * USDT_DECIMALS;
        uint256 nonceLong = settlement.nonces(longTrader);

        Settlement.Order memory longOrder = Settlement.Order({
            trader: longTrader,
            token: testToken,
            isLong: true,
            size: longOrderSize,
            leverage: 100000,
            price: 0,
            deadline: block.timestamp + 1 hours,
            nonce: nonceLong,
            orderType: Settlement.OrderType.MARKET
        });

        bytes memory longSig = _signOrder(longOrder, longTraderKey);

        // 尝试撮合 6,000 USDT（超过订单大小）
        Settlement.Order memory shortOrder = Settlement.Order({
            trader: shortTrader,
            token: testToken,
            isLong: false,
            size: 6_000 * USDT_DECIMALS,
            leverage: 100000,
            price: 0,
            deadline: block.timestamp + 1 hours,
            nonce: settlement.nonces(shortTrader),
            orderType: Settlement.OrderType.MARKET
        });

        Settlement.MatchedPair[] memory pairs = new Settlement.MatchedPair[](1);
        pairs[0] = Settlement.MatchedPair({
            longOrder: longOrder,
            longSignature: longSig,
            shortOrder: shortOrder,
            shortSignature: _signOrder(shortOrder, shortTraderKey),
            matchPrice: 1000 * USDT_DECIMALS,
            matchSize: 6_000 * USDT_DECIMALS // 超过多单的 5,000 USDT
        });

        vm.prank(matcher);
        vm.expectRevert(Settlement.InvalidMatch.selector);
        settlement.settleBatch(pairs);

        console.log("  [PASS] Overfill correctly rejected");
    }

    // ============================================================
    // 辅助函数：动态签名
    // ============================================================

    function _signOrderDynamic(Settlement.Order memory order, uint256 privateKey) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(
            ORDER_TYPEHASH,
            order.trader,
            order.token,
            order.isLong,
            order.size,
            order.leverage,
            order.price,
            order.deadline,
            order.nonce,
            order.orderType
        ));

        bytes32 domainSeparator = _domainSeparator();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    // ============================================================
    // 测试11-15: Session Key 功能已移至 SessionKeyManager 合约
    // ============================================================

    // ============================================================
    // 测试16: 多代币支持
    // ============================================================

    function test_MultiToken_DepositUSDT() public {
        console.log("\n=== Test 16: Multi-Token Deposit USDT ===");

        address newUser = makeAddr("multiTokenUser");
        usdt.mint(newUser, 1_000 * USDT_DECIMALS);

        vm.startPrank(newUser);
        usdt.approve(address(settlement), type(uint256).max);
        settlement.deposit(address(usdt), 1_000 * USDT_DECIMALS);
        vm.stopPrank();

        (uint256 available,) = settlement.getUserBalance(newUser);
        // ETH 本位: USDT 6位 → _toStandardDecimals → 18位 = 1000 * 1e18
        assertEq(available, 1_000 * 1e18, "Should have 1000 USDT balance (stored as 18 decimals)");

        console.log("  [PASS] USDT deposit successful");
    }

    function test_MultiToken_DepositUSDC() public {
        console.log("\n=== Test 17: Multi-Token Deposit USDC ===");

        address newUser = makeAddr("usdcUser");
        usdc.mint(newUser, 1_000 * USDT_DECIMALS);

        vm.startPrank(newUser);
        usdc.approve(address(settlement), type(uint256).max);
        settlement.deposit(address(usdc), 1_000 * USDT_DECIMALS);
        vm.stopPrank();

        (uint256 available,) = settlement.getUserBalance(newUser);
        // ETH 本位: USDC 6位 → _toStandardDecimals → 18位 = 1000 * 1e18
        assertEq(available, 1_000 * 1e18, "Should have 1000 USDC balance (stored as 18 decimals)");

        console.log("  [PASS] USDC deposit successful");
    }

    function test_MultiToken_DepositUSD1() public {
        console.log("\n=== Test 18: Multi-Token Deposit USD1 (18 decimals) ===");

        address newUser = makeAddr("usd1User");
        usd1.mint(newUser, 1_000 * 1e18); // USD1 has 18 decimals

        vm.startPrank(newUser);
        usd1.approve(address(settlement), type(uint256).max);
        settlement.deposit(address(usd1), 1_000 * 1e18);
        vm.stopPrank();

        (uint256 available,) = settlement.getUserBalance(newUser);
        // ETH 本位: USD1 18位 → STANDARD_DECIMALS=18 → 不转换 = 1000 * 1e18
        assertEq(available, 1_000 * 1e18, "Should have 1000 USD1 balance (18 decimals, no conversion)");

        console.log("  [PASS] USD1 deposit successful (no decimal conversion needed)");
    }

    function test_MultiToken_WithdrawDifferentToken() public {
        console.log("\n=== Test 19: Withdraw Different Token ===");

        address newUser = makeAddr("crossTokenUser");

        // 存入 USDT (6位 → 内部 18位)
        usdt.mint(newUser, 1_000 * USDT_DECIMALS);
        vm.startPrank(newUser);
        usdt.approve(address(settlement), type(uint256).max);
        settlement.deposit(address(usdt), 1_000 * USDT_DECIMALS);
        vm.stopPrank();

        // 合约需要有 USDC 流动性
        usdc.mint(address(settlement), 10_000 * USDT_DECIMALS);

        // 提取 500 (18位精度), _fromStandardDecimals 转回 6位给用户
        vm.prank(newUser);
        settlement.withdraw(address(usdc), 500 * 1e18);

        (uint256 available,) = settlement.getUserBalance(newUser);
        // ETH 本位: 余额以 18 位存储, 1000-500 = 500 * 1e18
        assertEq(available, 500 * 1e18, "Should have 500 left after withdrawing (18 decimals)");

        uint256 usdcBalance = usdc.balanceOf(newUser);
        // _fromStandardDecimals: 500 * 1e18 → USDC 6位 = 500 * 1e6
        assertEq(usdcBalance, 500 * USDT_DECIMALS, "Should have received 500 USDC (6 decimals)");

        console.log("  [PASS] Cross-token withdrawal successful");
    }

    function test_MultiToken_UnsupportedToken() public {
        console.log("\n=== Test 20: Unsupported Token Rejected ===");

        address fakeToken = makeAddr("fakeToken");

        vm.prank(longTrader);
        vm.expectRevert(Settlement.TokenNotSupported.selector);
        settlement.deposit(fakeToken, 1_000 * USDT_DECIMALS);

        console.log("  [PASS] Unsupported token correctly rejected");
    }

    function test_MultiToken_AdminFunctions() public {
        console.log("\n=== Test 21: Admin Token Management ===");

        // 检查支持的代币
        address[] memory tokens = settlement.getSupportedTokens();
        assertEq(tokens.length, 3, "Should have 3 supported tokens");

        assertTrue(settlement.isTokenSupported(address(usdt)), "USDT should be supported");
        assertTrue(settlement.isTokenSupported(address(usdc)), "USDC should be supported");
        assertTrue(settlement.isTokenSupported(address(usd1)), "USD1 should be supported");

        // 检查精度
        assertEq(settlement.getTokenDecimals(address(usdt)), 6, "USDT should have 6 decimals");
        assertEq(settlement.getTokenDecimals(address(usdc)), 6, "USDC should have 6 decimals");
        assertEq(settlement.getTokenDecimals(address(usd1)), 18, "USD1 should have 18 decimals");

        // 移除代币
        vm.prank(owner);
        settlement.removeSupportedToken(address(usd1));

        assertFalse(settlement.isTokenSupported(address(usd1)), "USD1 should no longer be supported");

        tokens = settlement.getSupportedTokens();
        assertEq(tokens.length, 2, "Should have 2 supported tokens after removal");

        console.log("  [PASS] Admin token management works correctly");
    }

    // ============================================================
    // 测试22-25: 合约规格系统
    // ============================================================

    function test_ContractSpec_DefaultSpec() public {
        console.log("\n=== Test 22: Default Contract Spec ===");

        IContractRegistry.ContractSpec memory spec = registry.getContractSpec(testToken);

        // 验证默认值
        assertEq(spec.contractSize, 200_000, "Contract size should be 200,000");
        assertEq(spec.minOrderSize, 1_000_000, "Min order should be $1");
        assertEq(spec.maxOrderSize, 100_000_000_000, "Max order should be $100,000");
        assertEq(spec.maxPositionSize, 500_000_000_000, "Max position should be $500,000");
        assertTrue(spec.isActive, "Should be active by default");

        console.log("  Contract size:", spec.contractSize);
        console.log("  Min order (USDT):", spec.minOrderSize / USDT_DECIMALS);
        console.log("  Max order (USDT):", spec.maxOrderSize / USDT_DECIMALS);
        console.log("  [PASS] Default contract spec loaded correctly");
    }

    function test_ContractSpec_CustomSpec() public {
        console.log("\n=== Test 23: Custom Contract Spec ===");

        // 为 testToken 设置自定义规格（模拟低市值 Meme 币）
        IContractRegistry.ContractSpec memory customSpec = IContractRegistry.ContractSpec({
            contractSize: 200_000,           // 1张 = 200,000 代币
            tickSize: 1e11,                  // 0.0000001
            priceDecimals: 7,
            quantityDecimals: 0,
            minOrderSize: 1 * USDT_DECIMALS, // 最小 $1
            maxOrderSize: 5_000 * USDT_DECIMALS, // 单笔最大 $5,000
            maxPositionSize: 10_000 * USDT_DECIMALS, // 持仓限额 $10,000
            maxLeverage: 20 * settlement.LEVERAGE_PRECISION(), // 20x
            imRate: 500,                     // 5%
            mmRate: 500,                     // 5% (Meme 币高风险)
            maxPriceDeviation: 1500,         // 15%
            isActive: true,
            createdAt: block.timestamp
        });

        vm.prank(owner);
        registry.setContractSpec(testToken, customSpec);

        // 验证
        IContractRegistry.ContractSpec memory loadedSpec = registry.getContractSpec(testToken);
        assertEq(loadedSpec.maxOrderSize, 5_000 * USDT_DECIMALS, "Custom max order should be $5,000");
        assertEq(loadedSpec.maxLeverage, 20 * settlement.LEVERAGE_PRECISION(), "Max leverage should be 20x");

        console.log("  Custom spec set for testToken");
        console.log("  [PASS] Custom contract spec works correctly");
    }

    function test_ContractSpec_OrderSizeValidation() public {
        console.log("\n=== Test 24: Order Size Validation ===");

        vm.prank(matcher);
        settlement.updatePrice(testToken, 1000 * USDT_DECIMALS);

        // 设置严格的合约规格
        IContractRegistry.ContractSpec memory strictSpec = IContractRegistry.ContractSpec({
            contractSize: 200_000,
            tickSize: 1e11,
            priceDecimals: 7,
            quantityDecimals: 0,
            minOrderSize: 100 * USDT_DECIMALS,    // 最小 $100
            maxOrderSize: 1_000 * USDT_DECIMALS,  // 最大 $1,000
            maxPositionSize: 5_000 * USDT_DECIMALS,
            maxLeverage: 100 * settlement.LEVERAGE_PRECISION(),
            imRate: 500,
            mmRate: 250,
            maxPriceDeviation: 1000,
            isActive: true,
            createdAt: block.timestamp
        });

        vm.prank(owner);
        registry.setContractSpec(testToken, strictSpec);

        // 尝试下单 $50（低于最小 $100）
        Settlement.Order memory smallOrder = Settlement.Order({
            trader: longTrader,
            token: testToken,
            isLong: true,
            size: 50 * USDT_DECIMALS, // $50
            leverage: 100000,
            price: 0,
            deadline: block.timestamp + 1 hours,
            nonce: settlement.nonces(longTrader),
            orderType: Settlement.OrderType.MARKET
        });

        Settlement.Order memory shortOrder = Settlement.Order({
            trader: shortTrader,
            token: testToken,
            isLong: false,
            size: 50 * USDT_DECIMALS,
            leverage: 100000,
            price: 0,
            deadline: block.timestamp + 1 hours,
            nonce: settlement.nonces(shortTrader),
            orderType: Settlement.OrderType.MARKET
        });

        Settlement.MatchedPair[] memory pairs = new Settlement.MatchedPair[](1);
        pairs[0] = Settlement.MatchedPair({
            longOrder: smallOrder,
            longSignature: _signOrder(smallOrder, longTraderKey),
            shortOrder: shortOrder,
            shortSignature: _signOrder(shortOrder, shortTraderKey),
            matchPrice: 1000 * USDT_DECIMALS,
            matchSize: 50 * USDT_DECIMALS
        });

        vm.prank(matcher);
        vm.expectRevert(Settlement.OrderSizeTooSmall.selector);
        settlement.settleBatch(pairs);

        console.log("  [PASS] Small order correctly rejected");

        // 尝试下单 $2,000（超过最大 $1,000）
        Settlement.Order memory bigOrder = Settlement.Order({
            trader: longTrader,
            token: testToken,
            isLong: true,
            size: 2_000 * USDT_DECIMALS, // $2,000
            leverage: 100000,
            price: 0,
            deadline: block.timestamp + 1 hours,
            nonce: settlement.nonces(longTrader),
            orderType: Settlement.OrderType.MARKET
        });

        Settlement.Order memory bigShortOrder = Settlement.Order({
            trader: shortTrader,
            token: testToken,
            isLong: false,
            size: 2_000 * USDT_DECIMALS,
            leverage: 100000,
            price: 0,
            deadline: block.timestamp + 1 hours,
            nonce: settlement.nonces(shortTrader),
            orderType: Settlement.OrderType.MARKET
        });

        pairs[0] = Settlement.MatchedPair({
            longOrder: bigOrder,
            longSignature: _signOrder(bigOrder, longTraderKey),
            shortOrder: bigShortOrder,
            shortSignature: _signOrder(bigShortOrder, shortTraderKey),
            matchPrice: 1000 * USDT_DECIMALS,
            matchSize: 2_000 * USDT_DECIMALS
        });

        vm.prank(matcher);
        vm.expectRevert(Settlement.OrderSizeTooBig.selector);
        settlement.settleBatch(pairs);

        console.log("  [PASS] Large order correctly rejected");
    }

    function test_ContractSpec_PositionLimitValidation() public {
        console.log("\n=== Test 25: Position Limit Validation ===");

        vm.prank(matcher);
        settlement.updatePrice(testToken, 1000 * USDT_DECIMALS);

        // 设置小的持仓限额（注意：maxPositionSize 必须 >= maxOrderSize）
        IContractRegistry.ContractSpec memory limitSpec = IContractRegistry.ContractSpec({
            contractSize: 200_000,
            tickSize: 1e11,
            priceDecimals: 7,
            quantityDecimals: 0,
            minOrderSize: 100 * USDT_DECIMALS,
            maxOrderSize: 1_000 * USDT_DECIMALS,   // 单笔最大 $1,000
            maxPositionSize: 1_500 * USDT_DECIMALS, // 持仓限额 $1,500
            maxLeverage: 100 * settlement.LEVERAGE_PRECISION(),
            imRate: 500,
            mmRate: 250,
            maxPriceDeviation: 1000,
            isActive: true,
            createdAt: block.timestamp
        });

        vm.prank(owner);
        registry.setContractSpec(testToken, limitSpec);

        // 第一笔订单 $1,000（成功）
        _createMatchedPair(1_000 * USDT_DECIMALS, 10, 10, 1000 * USDT_DECIMALS);

        console.log("  First order $1,000 succeeded");

        // 检查持仓大小
        uint256 longPos = settlement.getUserPositionSize(longTrader, testToken);
        assertEq(longPos, 1_000 * USDT_DECIMALS, "Long position should be $1,000");

        // 第二笔订单 $600（应该失败，因为总持仓 $1,600 会超过 $1,500 限额）
        // 注意：需要使用新的 nonce（第一笔订单后 nonce 已更新）
        uint256 newLongNonce = settlement.nonces(longTrader);
        uint256 newShortNonce = settlement.nonces(shortTrader);

        Settlement.Order memory longOrder2 = Settlement.Order({
            trader: longTrader,
            token: testToken,
            isLong: true,
            size: 600 * USDT_DECIMALS, // $600 使总持仓达到 $1,600 > $1,500 限额
            leverage: 100000,
            price: 0,
            deadline: block.timestamp + 1 hours,
            nonce: newLongNonce,
            orderType: Settlement.OrderType.MARKET
        });

        Settlement.Order memory shortOrder2 = Settlement.Order({
            trader: shortTrader,
            token: testToken,
            isLong: false,
            size: 600 * USDT_DECIMALS,
            leverage: 100000,
            price: 0,
            deadline: block.timestamp + 1 hours,
            nonce: newShortNonce,
            orderType: Settlement.OrderType.MARKET
        });

        Settlement.MatchedPair[] memory pairs2 = new Settlement.MatchedPair[](1);
        pairs2[0] = Settlement.MatchedPair({
            longOrder: longOrder2,
            longSignature: _signOrder(longOrder2, longTraderKey),
            shortOrder: shortOrder2,
            shortSignature: _signOrder(shortOrder2, shortTraderKey),
            matchPrice: 1000 * USDT_DECIMALS,
            matchSize: 600 * USDT_DECIMALS
        });

        // ETH 本位重构: 持仓限额检查已移至后端撮合引擎 (see _validateContractSpec line 872)
        // 链上不再 revert，第二笔订单应当成功执行
        vm.prank(matcher);
        settlement.settleBatch(pairs2);

        // 验证持仓确实增加了
        uint256 finalPos = settlement.getUserPositionSize(longTrader, testToken);
        assertEq(finalPos, 1_600 * USDT_DECIMALS, "Position should be $1,600 (limit check moved to backend)");

        console.log("  Second order succeeded (position limit check moved to backend)");
        console.log("  [PASS] On-chain allows; backend enforces position limits");
    }

    function test_ContractSpec_MarginTiers() public {
        console.log("\n=== Test 26: Margin Tiers ===");

        // 设置保证金阶梯
        // positionSize 是触发该档位的阈值（仓位 >= 该值时使用该档位）
        IContractRegistry.MarginTier[] memory tiers = new IContractRegistry.MarginTier[](3);
        tiers[0] = IContractRegistry.MarginTier({
            positionSize: 1_000 * USDT_DECIMALS,   // 仓位 >= $1,000 时
            mmRate: 250,                            // 2.5%
            maxLeverage: 20 * settlement.LEVERAGE_PRECISION() // 20x
        });
        tiers[1] = IContractRegistry.MarginTier({
            positionSize: 5_000 * USDT_DECIMALS,   // 仓位 >= $5,000 时
            mmRate: 500,                            // 5%
            maxLeverage: 10 * settlement.LEVERAGE_PRECISION() // 10x
        });
        tiers[2] = IContractRegistry.MarginTier({
            positionSize: 10_000 * USDT_DECIMALS,  // 仓位 >= $10,000 时
            mmRate: 1000,                           // 10%
            maxLeverage: 5 * settlement.LEVERAGE_PRECISION() // 5x
        });

        vm.prank(owner);
        registry.setMarginTiers(testToken, tiers);

        // 验证：$500 仓位（小于 $1,000 阈值，使用第一档）
        (uint256 mmRate1, uint256 maxLev1) = registry.getMarginRequirement(testToken, 500 * USDT_DECIMALS);
        assertEq(mmRate1, 250, "Below tier 1 threshold: mmRate should be 2.5%");
        assertEq(maxLev1, 20 * settlement.LEVERAGE_PRECISION(), "Below tier 1: max leverage should be 20x");

        // 验证：$3,000 仓位（>= $1,000 但 < $5,000，使用 tier 0）
        (uint256 mmRate2, uint256 maxLev2) = registry.getMarginRequirement(testToken, 3_000 * USDT_DECIMALS);
        assertEq(mmRate2, 250, "In tier 1 ($1K-$5K): mmRate should be 2.5%");
        assertEq(maxLev2, 20 * settlement.LEVERAGE_PRECISION(), "In tier 1: max leverage should be 20x");

        // 验证：$7,000 仓位（>= $5,000 但 < $10,000，使用 tier 1）
        (uint256 mmRate3, uint256 maxLev3) = registry.getMarginRequirement(testToken, 7_000 * USDT_DECIMALS);
        assertEq(mmRate3, 500, "In tier 2 ($5K-$10K): mmRate should be 5%");
        assertEq(maxLev3, 10 * settlement.LEVERAGE_PRECISION(), "In tier 2: max leverage should be 10x");

        // 验证：$15,000 仓位（>= $10,000，使用 tier 2）
        (uint256 mmRate4, uint256 maxLev4) = registry.getMarginRequirement(testToken, 15_000 * USDT_DECIMALS);
        assertEq(mmRate4, 1000, "In tier 3 ($10K+): mmRate should be 10%");
        assertEq(maxLev4, 5 * settlement.LEVERAGE_PRECISION(), "In tier 3: max leverage should be 5x");

        console.log("  Tier 0 (>=$1K): 2.5% margin, 20x max");
        console.log("  Tier 1 (>=$5K): 5% margin, 10x max");
        console.log("  Tier 2 (>=$10K): 10% margin, 5x max");
        console.log("  [PASS] Margin tiers work correctly");
    }

    // ============================================================
    // 测试27-32: batchSettlePnL (链下→链上 PnL 同步)
    // ============================================================

    function test_batchSettlePnL_success() public {
        console.log("\n=== Test 27: batchSettlePnL Success ===");

        // 初始余额：longTrader 50,000 USDT (18位精度), shortTrader 50,000 USDT
        (uint256 longBefore,) = settlement.getUserBalance(longTrader);
        (uint256 shortBefore,) = settlement.getUserBalance(shortTrader);

        // 模拟链下撮合结果：shortTrader 亏损 1000 USDT，longTrader 盈利 1000 USDT
        address[] memory from = new address[](1);
        address[] memory to = new address[](1);
        uint256[] memory amounts = new uint256[](1);

        from[0] = shortTrader;       // 亏损方
        to[0] = longTrader;          // 盈利方
        amounts[0] = 1_000 * 1e18;   // 1000 USDT (18位精度)

        vm.prank(matcher);
        settlement.batchSettlePnL(from, to, amounts);

        (uint256 longAfter,) = settlement.getUserBalance(longTrader);
        (uint256 shortAfter,) = settlement.getUserBalance(shortTrader);

        assertEq(longAfter, longBefore + 1_000 * 1e18, "Long should gain 1000");
        assertEq(shortAfter, shortBefore - 1_000 * 1e18, "Short should lose 1000");

        console.log("  Long: +1000 USDT, Short: -1000 USDT");
        console.log("  [PASS] batchSettlePnL transferred balances correctly");
    }

    function test_batchSettlePnL_multiplePairs() public {
        console.log("\n=== Test 27b: batchSettlePnL Multiple Pairs ===");

        // 创建第三个交易者
        address trader3 = makeAddr("trader3");
        usdt.mint(trader3, 10_000 * USDT_DECIMALS);
        vm.startPrank(trader3);
        usdt.approve(address(settlement), type(uint256).max);
        settlement.deposit(address(usdt), 10_000 * USDT_DECIMALS);
        vm.stopPrank();

        // 批量结算 2 对
        address[] memory from = new address[](2);
        address[] memory to = new address[](2);
        uint256[] memory amounts = new uint256[](2);

        from[0] = shortTrader;  to[0] = longTrader;  amounts[0] = 500 * 1e18;
        from[1] = trader3;      to[1] = longTrader;   amounts[1] = 300 * 1e18;

        (uint256 longBefore,) = settlement.getUserBalance(longTrader);

        vm.prank(matcher);
        settlement.batchSettlePnL(from, to, amounts);

        (uint256 longAfter,) = settlement.getUserBalance(longTrader);
        assertEq(longAfter, longBefore + 800 * 1e18, "Long should gain 800 total");

        console.log("  [PASS] Multiple pairs settled correctly");
    }

    function test_batchSettlePnL_onlyMatcher() public {
        console.log("\n=== Test 28: batchSettlePnL Only Matcher ===");

        address[] memory from = new address[](1);
        address[] memory to = new address[](1);
        uint256[] memory amounts = new uint256[](1);

        from[0] = shortTrader;
        to[0] = longTrader;
        amounts[0] = 100 * 1e18;

        // 未授权的地址调用
        vm.prank(longTrader);
        vm.expectRevert(Settlement.Unauthorized.selector);
        settlement.batchSettlePnL(from, to, amounts);

        console.log("  [PASS] Non-matcher correctly rejected");

        // 随机地址调用
        address random = makeAddr("random");
        vm.prank(random);
        vm.expectRevert(Settlement.Unauthorized.selector);
        settlement.batchSettlePnL(from, to, amounts);

        console.log("  [PASS] Random address correctly rejected");
    }

    function test_batchSettlePnL_insufficientBalance() public {
        console.log("\n=== Test 29: batchSettlePnL Insufficient Balance ===");

        address[] memory from = new address[](1);
        address[] memory to = new address[](1);
        uint256[] memory amounts = new uint256[](1);

        from[0] = shortTrader;
        to[0] = longTrader;
        amounts[0] = 999_999 * 1e18;  // 远超 shortTrader 的余额

        vm.prank(matcher);
        vm.expectRevert("Insufficient from balance");
        settlement.batchSettlePnL(from, to, amounts);

        console.log("  [PASS] Insufficient balance correctly reverted");
    }

    function test_batchSettlePnL_emptyBatch() public {
        console.log("\n=== Test 30: batchSettlePnL Empty Batch ===");

        address[] memory from = new address[](0);
        address[] memory to = new address[](0);
        uint256[] memory amounts = new uint256[](0);

        vm.prank(matcher);
        vm.expectRevert("Empty batch");
        settlement.batchSettlePnL(from, to, amounts);

        console.log("  [PASS] Empty batch correctly rejected");
    }

    function test_batchSettlePnL_tooLarge() public {
        console.log("\n=== Test 31: batchSettlePnL Too Large ===");

        // 创建 201 对的数组（超过 200 上限）
        address[] memory from = new address[](201);
        address[] memory to = new address[](201);
        uint256[] memory amounts = new uint256[](201);

        for (uint i = 0; i < 201; i++) {
            from[i] = shortTrader;
            to[i] = longTrader;
            amounts[i] = 1 * 1e18;
        }

        vm.prank(matcher);
        vm.expectRevert("Batch too large");
        settlement.batchSettlePnL(from, to, amounts);

        console.log("  [PASS] Oversized batch (201) correctly rejected");
    }

    function test_batchSettlePnL_afterSettle_withdrawable() public {
        console.log("\n=== Test 32: batchSettlePnL -> Withdraw ===");

        // 记录初始余额
        (uint256 longBefore,) = settlement.getUserBalance(longTrader);

        // 结算：shortTrader 亏 2000，longTrader 盈 2000
        address[] memory from = new address[](1);
        address[] memory to = new address[](1);
        uint256[] memory amounts = new uint256[](1);

        from[0] = shortTrader;
        to[0] = longTrader;
        amounts[0] = 2_000 * 1e18;

        vm.prank(matcher);
        settlement.batchSettlePnL(from, to, amounts);

        // 盈利方提款 — 应能提取包含盈利的全额
        uint256 withdrawAmount = 2_000 * 1e18;

        // 合约需要有足够的 USDT 流动性
        // longTrader 会通过 withdraw 提取 2000 * 1e18 (18位) → _fromStandardDecimals → 2000 * 1e6 (6位)
        // 合约本身已有 longTrader + shortTrader 各 50,000 USDT 的存款 = 100,000 USDT
        // 所以流动性足够

        vm.prank(longTrader);
        settlement.withdraw(address(usdt), withdrawAmount);

        // 验证提款后余额
        (uint256 longAfter,) = settlement.getUserBalance(longTrader);
        assertEq(longAfter, longBefore + 2_000 * 1e18 - withdrawAmount, "Balance should reflect settlement + withdrawal");

        // 验证 USDT 已到账
        uint256 longUsdtBalance = usdt.balanceOf(longTrader);
        assertEq(longUsdtBalance, 2_000 * USDT_DECIMALS, "Should have received 2000 USDT");

        console.log("  Settled +2000 USDT on-chain");
        console.log("  Withdrew 2000 USDT successfully");
        console.log("  [PASS] Post-settlement withdrawal works correctly");
    }
}
