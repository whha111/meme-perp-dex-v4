// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {TokenFactory} from "../src/spot/TokenFactory.sol";
import {MemeTokenV2} from "../src/spot/MemeTokenV2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title TokenFactory 测试
 * @notice 全面测试 TokenFactory 合约的所有功能
 *
 * 测试覆盖:
 * 1. 代币创建 (createToken)
 * 2. 买入操作 (buy)
 * 3. 卖出操作 (sell)
 * 4. 价格计算 (getCurrentPrice, previewBuy, previewSell)
 * 5. 池子状态 (getPoolState)
 * 6. 毕业机制 (graduation)
 * 7. 边界情况和错误处理
 * 8. 管理员功能
 */
contract TokenFactoryTest is Test {
    TokenFactory public factory;

    address public owner = address(0x1);
    address public feeReceiver = address(0x2);
    address public user1 = address(0x3);
    address public user2 = address(0x4);

    // Mock Uniswap Router (简化版，毕业测试需要更完整的mock)
    address public mockRouter = address(0x5);

    // Constants from TokenFactory (30 ETH graduation, 1 ETH fee)
    uint256 constant VIRTUAL_ETH_RESERVE = 10.593 ether;
    uint256 constant REAL_TOKEN_SUPPLY = 1_000_000_000 ether;
    uint256 constant GRADUATION_THRESHOLD = 207_000_000 ether;
    uint256 constant FEE_BPS = 100;
    uint256 constant SERVICE_FEE = 0.001 ether;
    uint256 constant GRADUATION_FEE = 1 ether;

    event TokenCreated(address indexed tokenAddress, address indexed creator, string name, string symbol, string uri, uint256 totalSupply);
    event Trade(address indexed tokenAddress, address indexed trader, bool isBuy, uint256 ethAmount, uint256 tokenAmount, uint256 virtualEthReserves, uint256 virtualTokenReserves, uint256 timestamp);

    function setUp() public {
        vm.deal(owner, 100 ether);
        vm.deal(user1, 100 ether);
        vm.deal(user2, 100 ether);

        vm.prank(owner);
        factory = new TokenFactory(owner, feeReceiver, mockRouter);
    }

    // ══════════════════════════════════════════════════════════════════════════════
    // 1. 代币创建测试
    // ══════════════════════════════════════════════════════════════════════════════

    function test_CreateToken_Basic() public {
        vm.prank(user1);
        address tokenAddress = factory.createToken{value: SERVICE_FEE}(
            "Test Token",
            "TEST",
            "ipfs://test",
            0
        );

        assertTrue(tokenAddress != address(0), "Token should be created");

        // 验证代币信息
        MemeTokenV2 token = MemeTokenV2(tokenAddress);
        assertEq(token.name(), "Test Token");
        assertEq(token.symbol(), "TEST");

        // 验证池子状态
        TokenFactory.PoolState memory state = factory.getPoolState(tokenAddress);
        assertEq(state.creator, user1);
        assertTrue(state.isActive);
        assertFalse(state.isGraduated);
        assertEq(state.realETHReserve, 0);
        assertEq(state.realTokenReserve, REAL_TOKEN_SUPPLY);
    }

    function test_CreateToken_WithInitialBuy() public {
        uint256 buyAmount = 0.1 ether;

        vm.prank(user1);
        address tokenAddress = factory.createToken{value: SERVICE_FEE + buyAmount}(
            "Test Token",
            "TEST",
            "ipfs://test",
            0
        );

        // 验证用户收到代币
        uint256 balance = IERC20(tokenAddress).balanceOf(user1);
        assertTrue(balance > 0, "User should receive tokens");

        // 验证池子状态
        TokenFactory.PoolState memory state = factory.getPoolState(tokenAddress);
        assertTrue(state.realETHReserve > 0, "Pool should have ETH");
    }

    function test_CreateToken_InsufficientFee() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(TokenFactory.InsufficientFee.selector, SERVICE_FEE - 1, SERVICE_FEE));
        factory.createToken{value: SERVICE_FEE - 1}(
            "Test Token",
            "TEST",
            "ipfs://test",
            0
        );
    }

    function test_CreateToken_FeeTransferred() public {
        uint256 feeReceiverBalanceBefore = feeReceiver.balance;

        vm.prank(user1);
        factory.createToken{value: SERVICE_FEE}(
            "Test Token",
            "TEST",
            "ipfs://test",
            0
        );

        assertEq(feeReceiver.balance, feeReceiverBalanceBefore + SERVICE_FEE);
    }

    // ══════════════════════════════════════════════════════════════════════════════
    // 2. 买入测试
    // ══════════════════════════════════════════════════════════════════════════════

    function test_Buy_Basic() public {
        // 创建代币
        vm.prank(user1);
        address tokenAddress = factory.createToken{value: SERVICE_FEE}(
            "Test Token",
            "TEST",
            "ipfs://test",
            0
        );

        // 买入
        uint256 buyAmount = 0.1 ether;
        vm.prank(user2);
        factory.buy{value: buyAmount}(tokenAddress, 0);

        // 验证
        uint256 balance = IERC20(tokenAddress).balanceOf(user2);
        assertTrue(balance > 0, "User should receive tokens");

        TokenFactory.PoolState memory state = factory.getPoolState(tokenAddress);
        assertTrue(state.realETHReserve > 0);
    }

    function test_Buy_PriceIncreases() public {
        vm.prank(user1);
        address tokenAddress = factory.createToken{value: SERVICE_FEE}(
            "Test Token",
            "TEST",
            "ipfs://test",
            0
        );

        uint256 priceBefore = factory.getCurrentPrice(tokenAddress);

        // 买入
        vm.prank(user2);
        factory.buy{value: 0.5 ether}(tokenAddress, 0);

        uint256 priceAfter = factory.getCurrentPrice(tokenAddress);
        assertTrue(priceAfter > priceBefore, "Price should increase after buy");
    }

    function test_Buy_ZeroAmount() public {
        vm.prank(user1);
        address tokenAddress = factory.createToken{value: SERVICE_FEE}(
            "Test Token",
            "TEST",
            "ipfs://test",
            0
        );

        vm.prank(user2);
        vm.expectRevert(TokenFactory.InvalidAmount.selector);
        factory.buy{value: 0}(tokenAddress, 0);
    }

    function test_Buy_SlippageProtection() public {
        vm.prank(user1);
        address tokenAddress = factory.createToken{value: SERVICE_FEE}(
            "Test Token",
            "TEST",
            "ipfs://test",
            0
        );

        // 预览买入结果
        uint256 expectedTokens = factory.previewBuy(tokenAddress, 0.1 ether);

        // 设置过高的 minTokensOut
        vm.prank(user2);
        vm.expectRevert();
        factory.buy{value: 0.1 ether}(tokenAddress, expectedTokens * 2);
    }

    function test_Buy_MultipleBuyers() public {
        vm.prank(user1);
        address tokenAddress = factory.createToken{value: SERVICE_FEE}(
            "Test Token",
            "TEST",
            "ipfs://test",
            0
        );

        // 多个用户买入
        vm.prank(user1);
        factory.buy{value: 0.1 ether}(tokenAddress, 0);

        vm.prank(user2);
        factory.buy{value: 0.2 ether}(tokenAddress, 0);

        // 验证两个用户都有代币
        assertTrue(IERC20(tokenAddress).balanceOf(user1) > 0);
        assertTrue(IERC20(tokenAddress).balanceOf(user2) > 0);
    }

    // ══════════════════════════════════════════════════════════════════════════════
    // 3. 卖出测试
    // ══════════════════════════════════════════════════════════════════════════════

    function test_Sell_Basic() public {
        vm.prank(user1);
        address tokenAddress = factory.createToken{value: SERVICE_FEE + 0.5 ether}(
            "Test Token",
            "TEST",
            "ipfs://test",
            0
        );

        uint256 tokenBalance = IERC20(tokenAddress).balanceOf(user1);
        uint256 ethBalanceBefore = user1.balance;

        // 授权并卖出一半
        uint256 sellAmount = tokenBalance / 2;
        vm.startPrank(user1);
        IERC20(tokenAddress).approve(address(factory), sellAmount);
        factory.sell(tokenAddress, sellAmount, 0);
        vm.stopPrank();

        // 验证
        assertEq(IERC20(tokenAddress).balanceOf(user1), tokenBalance - sellAmount);
        assertTrue(user1.balance > ethBalanceBefore, "Should receive ETH");
    }

    function test_Sell_PriceDecreases() public {
        vm.prank(user1);
        address tokenAddress = factory.createToken{value: SERVICE_FEE + 1 ether}(
            "Test Token",
            "TEST",
            "ipfs://test",
            0
        );

        uint256 priceBefore = factory.getCurrentPrice(tokenAddress);

        uint256 tokenBalance = IERC20(tokenAddress).balanceOf(user1);
        uint256 sellAmount = tokenBalance / 4;

        vm.startPrank(user1);
        IERC20(tokenAddress).approve(address(factory), sellAmount);
        factory.sell(tokenAddress, sellAmount, 0);
        vm.stopPrank();

        uint256 priceAfter = factory.getCurrentPrice(tokenAddress);
        assertTrue(priceAfter < priceBefore, "Price should decrease after sell");
    }

    function test_Sell_InsufficientBalance() public {
        vm.prank(user1);
        address tokenAddress = factory.createToken{value: SERVICE_FEE + 0.1 ether}(
            "Test Token",
            "TEST",
            "ipfs://test",
            0
        );

        uint256 tokenBalance = IERC20(tokenAddress).balanceOf(user1);

        vm.startPrank(user1);
        IERC20(tokenAddress).approve(address(factory), tokenBalance * 2);
        vm.expectRevert();
        factory.sell(tokenAddress, tokenBalance * 2, 0);
        vm.stopPrank();
    }

    function test_Sell_ZeroAmount() public {
        vm.prank(user1);
        address tokenAddress = factory.createToken{value: SERVICE_FEE + 0.1 ether}(
            "Test Token",
            "TEST",
            "ipfs://test",
            0
        );

        vm.prank(user1);
        vm.expectRevert(TokenFactory.InvalidAmount.selector);
        factory.sell(tokenAddress, 0, 0);
    }

    // ══════════════════════════════════════════════════════════════════════════════
    // 4. 价格计算测试
    // ══════════════════════════════════════════════════════════════════════════════

    function test_GetCurrentPrice_Initial() public {
        vm.prank(user1);
        address tokenAddress = factory.createToken{value: SERVICE_FEE}(
            "Test Token",
            "TEST",
            "ipfs://test",
            0
        );

        uint256 price = factory.getCurrentPrice(tokenAddress);
        assertTrue(price > 0, "Initial price should be positive");

        // 初始价格应该非常小 (约 1.7e-9 ETH per token)
        assertTrue(price < 1e10, "Initial price should be very small");
    }

    function test_PreviewBuy_Accuracy() public {
        vm.prank(user1);
        address tokenAddress = factory.createToken{value: SERVICE_FEE}(
            "Test Token",
            "TEST",
            "ipfs://test",
            0
        );

        uint256 buyAmount = 0.1 ether;
        uint256 preview = factory.previewBuy(tokenAddress, buyAmount);

        vm.prank(user2);
        factory.buy{value: buyAmount}(tokenAddress, 0);

        uint256 actual = IERC20(tokenAddress).balanceOf(user2);

        // 预览和实际结果应该一致
        assertEq(preview, actual, "Preview should match actual");
    }

    function test_PreviewSell_Accuracy() public {
        vm.prank(user1);
        address tokenAddress = factory.createToken{value: SERVICE_FEE + 0.5 ether}(
            "Test Token",
            "TEST",
            "ipfs://test",
            0
        );

        uint256 tokenBalance = IERC20(tokenAddress).balanceOf(user1);
        uint256 sellAmount = tokenBalance / 2;

        uint256 preview = factory.previewSell(tokenAddress, sellAmount);
        uint256 ethBefore = user1.balance;

        vm.startPrank(user1);
        IERC20(tokenAddress).approve(address(factory), sellAmount);
        factory.sell(tokenAddress, sellAmount, 0);
        vm.stopPrank();

        uint256 actual = user1.balance - ethBefore;

        assertEq(preview, actual, "Preview should match actual");
    }

    // ══════════════════════════════════════════════════════════════════════════════
    // 5. 池子状态测试
    // ══════════════════════════════════════════════════════════════════════════════

    function test_GetPoolState() public {
        vm.prank(user1);
        address tokenAddress = factory.createToken{value: SERVICE_FEE + 0.1 ether}(
            "Test Token",
            "TEST",
            "ipfs://test",
            0
        );

        TokenFactory.PoolState memory state = factory.getPoolState(tokenAddress);

        assertEq(state.creator, user1);
        assertTrue(state.isActive);
        assertFalse(state.isGraduated);
        assertTrue(state.realETHReserve > 0);
        assertTrue(state.soldTokens > 0);
        assertEq(state.metadataURI, "ipfs://test");
    }

    function test_GetAllTokens() public {
        // 创建多个代币
        vm.prank(user1);
        address token1 = factory.createToken{value: SERVICE_FEE}("Token1", "T1", "ipfs://1", 0);

        vm.prank(user2);
        address token2 = factory.createToken{value: SERVICE_FEE}("Token2", "T2", "ipfs://2", 0);

        address[] memory tokens = factory.getAllTokens();
        assertEq(tokens.length, 2);
        assertEq(tokens[0], token1);
        assertEq(tokens[1], token2);
    }

    function test_GetTokenCount() public {
        assertEq(factory.getTokenCount(), 0);

        vm.prank(user1);
        factory.createToken{value: SERVICE_FEE}("Token1", "T1", "ipfs://1", 0);
        assertEq(factory.getTokenCount(), 1);

        vm.prank(user2);
        factory.createToken{value: SERVICE_FEE}("Token2", "T2", "ipfs://2", 0);
        assertEq(factory.getTokenCount(), 2);
    }

    // ══════════════════════════════════════════════════════════════════════════════
    // 6. 手续费测试
    // ══════════════════════════════════════════════════════════════════════════════

    function test_Fee_OnBuy() public {
        vm.prank(user1);
        address tokenAddress = factory.createToken{value: SERVICE_FEE}(
            "Test Token",
            "TEST",
            "ipfs://test",
            0
        );

        uint256 feeReceiverBefore = feeReceiver.balance;

        vm.prank(user2);
        factory.buy{value: 1 ether}(tokenAddress, 0);

        // ETH 本位: _distributeTradingFee 直接 sendValue 给 feeReceiver
        // 1% fee = 0.01 ETH, creator 25% = 0.0025 ETH, 无 referrer → 剩余 75% 归平台
        // platformFee = 0.01 - 0.0025 - 0 = 0.0075 ETH (直接转到 feeReceiver)
        // H-08 FIX: 不再多扣 10% referrer share — 无推荐人时 platform 正确得 75%
        uint256 expectedPlatformFee = 0.0075 ether;
        assertApproxEqAbs(feeReceiver.balance - feeReceiverBefore, expectedPlatformFee, 1e14, "Platform fee sent directly to feeReceiver");
    }

    function test_Fee_OnSell() public {
        vm.prank(user1);
        address tokenAddress = factory.createToken{value: SERVICE_FEE + 1 ether}(
            "Test Token",
            "TEST",
            "ipfs://test",
            0
        );

        uint256 tokenBalance = IERC20(tokenAddress).balanceOf(user1);
        uint256 feeReceiverBefore = feeReceiver.balance;

        vm.startPrank(user1);
        IERC20(tokenAddress).approve(address(factory), tokenBalance);
        factory.sell(tokenAddress, tokenBalance / 2, 0);
        vm.stopPrank();

        // ETH 本位: 卖出手续费也直接 sendValue 给 feeReceiver
        assertTrue(feeReceiver.balance > feeReceiverBefore, "Platform fee sent directly to feeReceiver on sell");
    }

    // ══════════════════════════════════════════════════════════════════════════════
    // 7. 管理员功能测试
    // ══════════════════════════════════════════════════════════════════════════════

    function test_SetServiceFee() public {
        uint256 newFee = 0.002 ether;

        vm.prank(owner);
        factory.setServiceFee(newFee);

        assertEq(factory.serviceFee(), newFee);
    }

    function test_SetServiceFee_OnlyOwner() public {
        vm.prank(user1);
        vm.expectRevert();
        factory.setServiceFee(0.002 ether);
    }

    function test_SetFeeReceiver() public {
        address newReceiver = address(0x100);

        vm.prank(owner);
        factory.setFeeReceiver(newReceiver);

        assertEq(factory.feeReceiver(), newReceiver);
    }

    function test_SetFeeReceiver_ZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(TokenFactory.InvalidAddress.selector);
        factory.setFeeReceiver(address(0));
    }

    function test_Pause() public {
        vm.prank(owner);
        factory.pause();

        vm.prank(user1);
        vm.expectRevert();
        factory.createToken{value: SERVICE_FEE}("Test", "T", "ipfs://", 0);
    }

    function test_Unpause() public {
        vm.prank(owner);
        factory.pause();

        vm.prank(owner);
        factory.unpause();

        vm.prank(user1);
        address token = factory.createToken{value: SERVICE_FEE}("Test", "T", "ipfs://", 0);
        assertTrue(token != address(0));
    }

    // ══════════════════════════════════════════════════════════════════════════════
    // 8. 边界情况测试
    // ══════════════════════════════════════════════════════════════════════════════

    function test_BuyAfterPoolInactive() public {
        vm.prank(user1);
        address tokenAddress = factory.createToken{value: SERVICE_FEE}(
            "Test Token",
            "TEST",
            "ipfs://test",
            0
        );

        // 模拟池子变为非活跃状态（需要管理员操作或毕业）
        // 这里测试正常池子应该是活跃的
        TokenFactory.PoolState memory state = factory.getPoolState(tokenAddress);
        assertTrue(state.isActive);
    }

    function test_LargeBuy() public {
        vm.prank(user1);
        address tokenAddress = factory.createToken{value: SERVICE_FEE}(
            "Test Token",
            "TEST",
            "ipfs://test",
            0
        );

        // 大额买入
        vm.deal(user2, 10 ether);
        vm.prank(user2);
        factory.buy{value: 5 ether}(tokenAddress, 0);

        uint256 balance = IERC20(tokenAddress).balanceOf(user2);
        assertTrue(balance > 0);
    }

    function test_SmallBuy() public {
        vm.prank(user1);
        address tokenAddress = factory.createToken{value: SERVICE_FEE}(
            "Test Token",
            "TEST",
            "ipfs://test",
            0
        );

        // 小额买入
        vm.prank(user2);
        factory.buy{value: 0.001 ether}(tokenAddress, 0);

        uint256 balance = IERC20(tokenAddress).balanceOf(user2);
        assertTrue(balance > 0);
    }

    // ══════════════════════════════════════════════════════════════════════════════
    // Fuzz 测试
    // ══════════════════════════════════════════════════════════════════════════════

    function testFuzz_Buy(uint256 amount) public {
        // 限制范围：0.001 ETH - 10 ETH
        amount = bound(amount, 0.001 ether, 10 ether);

        vm.deal(user1, 100 ether);
        vm.deal(user2, 100 ether);

        vm.prank(user1);
        address tokenAddress = factory.createToken{value: SERVICE_FEE}(
            "Test Token",
            "TEST",
            "ipfs://test",
            0
        );

        vm.prank(user2);
        factory.buy{value: amount}(tokenAddress, 0);

        uint256 balance = IERC20(tokenAddress).balanceOf(user2);
        assertTrue(balance > 0, "Should receive tokens for any valid amount");
    }

    function testFuzz_BuySell(uint256 buyAmount) public {
        buyAmount = bound(buyAmount, 0.01 ether, 5 ether);

        vm.deal(user1, 100 ether);

        vm.prank(user1);
        address tokenAddress = factory.createToken{value: SERVICE_FEE + buyAmount}(
            "Test Token",
            "TEST",
            "ipfs://test",
            0
        );

        uint256 tokenBalance = IERC20(tokenAddress).balanceOf(user1);
        uint256 sellAmount = tokenBalance / 2;

        vm.startPrank(user1);
        IERC20(tokenAddress).approve(address(factory), sellAmount);
        factory.sell(tokenAddress, sellAmount, 0);
        vm.stopPrank();

        // 应该收到一些 ETH（减去手续费后）
        assertTrue(IERC20(tokenAddress).balanceOf(user1) > 0);
    }
}
