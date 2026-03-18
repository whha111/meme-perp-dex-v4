// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {ICurveEvents} from "../interfaces/ICurveEvents.sol";
import {ILendingPool} from "../interfaces/ILendingPool.sol";
import {ConstantProductAMMMath} from "../libraries/ConstantProductAMMMath.sol";
import {MemeTokenV2} from "./MemeTokenV2.sol";

interface IUniswapV2Router02 {
    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);

    function factory() external pure returns (address);
}

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IMemeTokenV2 {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
    function lockMinting() external;
    function unlockMinting() external;
    function removeMinter(address minter) external;
}

interface IPriceFeedFactory {
    function addSupportedTokenFromFactory(address token, uint256 initialPrice) external;
    function updateTokenPriceFromFactory(address token, uint256 newPrice) external;
    // P0-2: 毕业后通知 PriceFeed 设置 Uniswap V2 Pair
    function setTokenUniswapPair(address token, address pair) external;
}

/// @notice 清算合约回调接口（毕业后启用清算奖励）
interface ILiquidationCallback {
    function enableLiquidatorReward(address token) external;
}

// [C-01/C-05] Helper library for price sync to avoid stack too deep
library PriceFeedHelper {
    function syncPrice(
        address priceFeedAddr,
        address token,
        uint256 virtualEth,
        uint256 virtualToken
    ) internal {
        if (priceFeedAddr == address(0)) return;
        uint256 newPrice = ConstantProductAMMMath.getCurrentPrice(virtualEth, virtualToken);
        try IPriceFeedFactory(priceFeedAddr).updateTokenPriceFromFactory(token, newPrice) {} catch {}
    }
}

/**
 * @title TokenFactory
 * @notice Meme 代币工厂 - Pump.fun 风格 Bonding Curve
 * @dev 创建代币 → 立即可交易 → 毕业后迁移到 DEX
 *      P-007: 添加紧急暂停功能
 */
contract TokenFactory is Ownable, ReentrancyGuard, Pausable, ICurveEvents {
    using SafeERC20 for IERC20;

    // ══════════════════════════════════════════════════════════════════════════════
    // CONSTANTS (Pump.fun 参数，按 ETH 等值换算)
    // ══════════════════════════════════════════════════════════════════════════════

    // Bonding curve: 10.593 ETH virtual reserve, 30 ETH graduation, 1 ETH graduation fee
    // 793M tokens sold → 30 ETH collected → 1 ETH fee + 29 ETH to DEX liquidity
    uint256 public constant VIRTUAL_ETH_RESERVE = 10.593 ether;
    uint256 public constant REAL_TOKEN_SUPPLY = 1_000_000_000 ether; // 10亿真实供应
    uint256 public constant VIRTUAL_TOKEN_RESERVE = 1_073_000_000 ether; // 10.73亿虚拟供应

    // 毕业阈值：当 realTokenReserve <= 2.07亿时毕业 (卖出7.93亿代币后)
    uint256 public constant GRADUATION_THRESHOLD = 207_000_000 ether;

    // 手续费 1%
    uint256 public constant FEE_BPS = 100;

    // 毕业费 1 ETH（从 realETHReserve 中扣除，发送到 feeReceiver）
    uint256 public constant GRADUATION_FEE = 1 ether;

    // 永续合约开启阈值：池子里有 6 ETH 真实资金后自动开启永续合约
    // 6 ETH ≈ 20% graduation, 价格约涨 2.4 倍，做空有 58% 下跌空间
    uint256 public constant PERP_ENABLE_THRESHOLD = 6 ether;

    // P2P 借贷开启阈值：与永续合约同步开启
    // 持有者存入代币赚利息，做空者借入代币
    uint256 public constant LENDING_ENABLE_THRESHOLD = 6 ether;

    // 创建代币服务费
    uint256 public serviceFee = 0.001 ether;

    // 现货手续费分配比例 (基点，总和 = 10000)
    uint256 public constant CREATOR_FEE_SHARE = 2500;   // 25% 给创建者
    uint256 public constant REFERRER_FEE_SHARE = 1000;  // 10% 给邀请人
    uint256 public constant PLATFORM_FEE_SHARE = 6500;  // 65% 给平台

    // ══════════════════════════════════════════════════════════════════════════════
    // STATE
    // ══════════════════════════════════════════════════════════════════════════════

    struct PoolState {
        uint256 realETHReserve;      // 真实 ETH 储备
        uint256 realTokenReserve;    // 真实代币储备
        uint256 soldTokens;          // 已售出代币数量
        bool isGraduated;            // 是否已毕业
        bool isActive;               // 是否活跃
        address creator;             // 创建者
        uint64 createdAt;            // 创建时间
        string metadataURI;          // 元数据 URI
        bool graduationFailed;       // M-007: 毕业是否失败
        uint8 graduationAttempts;    // M-007: 毕业尝试次数
        bool perpEnabled;            // 是否已开启永续合约交易
        bool lendingEnabled;         // 是否已开启 P2P 借贷
    }

    // tokenAddress => PoolState
    mapping(address => PoolState) private _pools;

    // 所有代币地址列表
    address[] public allTokens;

    // 手续费接收地址
    address public feeReceiver;

    // DEX Router 地址
    address public uniswapV2Router;

    // PriceFeed 地址（用于自动开启永续合约）
    address public priceFeed;

    // LendingPool 地址（用于自动开启 P2P 借贷）
    address public lendingPool;

    // Liquidation 地址（毕业后启用清算奖励）
    address public liquidation;

    // WBNB 地址 (通过构造函数传入，支持多链部署)
    address public immutable WETH;

    // P0-2: 毕业后的 Uniswap V2 Pair 地址 (token => pair)
    mapping(address => address) public uniswapPairs;

    // P2-6: 重名代币检查 (symbol => used)
    mapping(string => bool) private _symbolUsed;

    // 创建者累计收益 (token => 累计ETH)
    mapping(address => uint256) public creatorEarnings;

    // 邀请人累计收益 (referrer => 累计ETH)
    mapping(address => uint256) public referrerEarnings;

    // 平台累计收益
    uint256 public platformEarnings;

    // 用户邀请人关系 (user => referrer)
    mapping(address => address) public userReferrer;

    // ══════════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ══════════════════════════════════════════════════════════════════════════════

    error PoolNotInitialized();
    error PoolAlreadyGraduated();
    error PoolNotActive();
    error InvalidAmount();
    error InvalidAddress();
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error InsufficientBalance(uint256 requested, uint256 available);
    error InsufficientFee(uint256 sent, uint256 required);
    error GraduationNotFailed();     // M-007: 毕业未失败
    error MaxGraduationAttempts();   // M-007: 达到最大尝试次数
    error NoEarningsToClaim();       // 无收益可提取
    error ReferrerAlreadySet();      // 邀请人已设置
    error CannotReferSelf();         // 不能邀请自己
    error SymbolAlreadyExists();     // P2-6: 代币符号已存在

    // ══════════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ══════════════════════════════════════════════════════════════════════════════

    event ServiceFeeUpdated(uint256 oldFee, uint256 newFee);
    event FeeReceiverUpdated(address indexed oldReceiver, address indexed newReceiver);
    event RouterUpdated(address indexed oldRouter, address indexed newRouter);
    // M-007: 毕业相关事件
    event GraduationFailed(address indexed token, uint8 attempt, string reason);
    event GraduationRetried(address indexed token, uint8 attempt);
    event GraduationRolledBack(address indexed token, uint256 ethReturned);
    // L-10: receive() event for tracking unexpected ETH deposits
    event ETHReceived(address indexed sender, uint256 amount);
    // 永续合约自动开启事件
    event PerpEnabled(address indexed token, uint256 ethReserve, uint256 price);
    event GraduationFeeCollected(address indexed token, uint256 fee, address feeReceiver);
    event PriceFeedUpdated(address indexed oldPriceFeed, address indexed newPriceFeed);
    // P2P 借贷事件
    event LendingEnabled(address indexed token, uint256 ethReserve);
    event LendingPoolUpdated(address indexed oldLendingPool, address indexed newLendingPool);
    event LiquidationUpdated(address indexed oldLiquidation, address indexed newLiquidation);
    // 费用分配事件
    event FeeDistributed(address indexed token, uint256 creatorFee, uint256 referrerFee, uint256 platformFee);
    event CreatorEarningsClaimed(address indexed token, address indexed creator, uint256 amount);
    event ReferrerEarningsClaimed(address indexed referrer, uint256 amount);
    event PlatformEarningsClaimed(address indexed receiver, uint256 amount);
    event ReferrerSet(address indexed user, address indexed referrer);

    // ══════════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ══════════════════════════════════════════════════════════════════════════════

    constructor(
        address initialOwner,
        address feeReceiver_,
        address uniswapV2Router_,
        address weth_
    ) Ownable(initialOwner) {
        if (feeReceiver_ == address(0)) revert InvalidAddress();
        if (uniswapV2Router_ == address(0)) revert InvalidAddress();
        if (weth_ == address(0)) revert InvalidAddress();

        feeReceiver = feeReceiver_;
        uniswapV2Router = uniswapV2Router_;
        WETH = weth_;
    }

    // ══════════════════════════════════════════════════════════════════════════════
    // CORE FUNCTIONS
    // ══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice 创建代币并立即开始交易
     * @param name 代币名称
     * @param symbol 代币符号
     * @param metadataURI 元数据 URI (IPFS)
     * @param minTokensOut 最小获得代币数量 (如果附带 ETH 购买)
     */
    // P-007: Added whenNotPaused
    function createToken(
        string memory name,
        string memory symbol,
        string memory metadataURI,
        uint256 minTokensOut
    ) external payable nonReentrant whenNotPaused returns (address tokenAddress) {
        if (msg.value < serviceFee) revert InsufficientFee(msg.value, serviceFee);

        // P2-6: 防止重名代币
        if (_symbolUsed[symbol]) revert SymbolAlreadyExists();
        _symbolUsed[symbol] = true;

        uint256 buyAmount = msg.value - serviceFee;

        // 创建代币
        MemeTokenV2 token = new MemeTokenV2(
            name,
            symbol,
            address(this), // admin
            address(this), // minter
            metadataURI
        );
        tokenAddress = address(token);

        // 初始化池子
        _pools[tokenAddress] = PoolState({
            realETHReserve: 0,
            realTokenReserve: REAL_TOKEN_SUPPLY,
            soldTokens: 0,
            isGraduated: false,
            isActive: true,
            creator: msg.sender,
            createdAt: uint64(block.timestamp),
            metadataURI: metadataURI,
            graduationFailed: false,
            graduationAttempts: 0,
            perpEnabled: false,
            lendingEnabled: false
        });

        allTokens.push(tokenAddress);

        // 转移服务费
        _safeTransferFee(serviceFee);

        emit TokenCreated(tokenAddress, msg.sender, name, symbol, metadataURI, REAL_TOKEN_SUPPLY);

        // 如果附带 ETH，执行首次购买
        if (buyAmount > 0) {
            _buyInternal(tokenAddress, msg.sender, buyAmount, minTokensOut);
        }

        return tokenAddress;
    }

    /**
     * @notice 买入代币
     * @param tokenAddress 代币地址
     * @param minTokensOut 最小获得代币数量
     */
    // P-007: Added whenNotPaused
    function buy(address tokenAddress, uint256 minTokensOut) external payable nonReentrant whenNotPaused {
        if (msg.value == 0) revert InvalidAmount();
        _buyInternal(tokenAddress, msg.sender, msg.value, minTokensOut);
    }

    /**
     * @notice 卖出代币
     * @param tokenAddress 代币地址
     * @param tokenAmount 卖出数量
     * @param minETHOut 最小获得 ETH 数量
     */
    // P-007: Added whenNotPaused
    function sell(address tokenAddress, uint256 tokenAmount, uint256 minETHOut) external nonReentrant whenNotPaused {
        if (tokenAmount == 0) revert InvalidAmount();
        _sellInternal(tokenAddress, msg.sender, tokenAmount, minETHOut);
    }

    // ══════════════════════════════════════════════════════════════════════════════
    // INTERNAL
    // ══════════════════════════════════════════════════════════════════════════════

    function _safeTransferFee(uint256 amount) internal {
        if (amount == 0) return;
        // Legacy: 服务费直接转给平台
        Address.sendValue(payable(feeReceiver), amount);
    }

    /**
     * @notice 分配交易手续费
     * @param token 代币地址
     * @param trader 交易者地址
     * @param amount 手续费总额
     */
    /**
     * @notice 分配交易手续费
     * @dev H-08 FIX: 移除无推荐人时的重复加算。
     *      当 referrer == address(0) 时，referrerFee = 0，
     *      platformFee = amount - creatorFee - 0 已包含推荐人份额。
     *      旧代码额外加了 10%，导致总分配 = 110% 的手续费，
     *      多出的 10% 从池子 ETH 储备中被抽走。
     *
     *      分配比例:
     *      - 有推荐人: 创建者 25% + 推荐人 10% + 平台 65% = 100%
     *      - 无推荐人: 创建者 25% + 平台 75% = 100%
     */
    function _distributeTradingFee(address token, address trader, uint256 amount) internal {
        if (amount == 0) return;

        address referrer = userReferrer[trader];

        // 计算各方份额
        uint256 creatorFee = (amount * CREATOR_FEE_SHARE) / 10000;
        uint256 referrerFee = referrer != address(0) ? (amount * REFERRER_FEE_SHARE) / 10000 : 0;
        // H-08 FIX: platformFee = amount - creatorFee - referrerFee
        // 无推荐人时 referrerFee=0，platformFee 自然包含推荐人份额，无需额外加算
        uint256 platformFee = amount - creatorFee - referrerFee;

        // 创建者: 累积收益等待提取
        if (creatorFee > 0) {
            creatorEarnings[token] += creatorFee;
        }
        // 推荐人: 累积收益等待提取（无推荐人时 referrerFee=0，跳过）
        if (referrerFee > 0) {
            referrerEarnings[referrer] += referrerFee;
        }

        // 平台份额: 每笔交易直接转到 feeReceiver 钱包
        if (platformFee > 0) {
            Address.sendValue(payable(feeReceiver), platformFee);
        }

        emit FeeDistributed(token, creatorFee, referrerFee, platformFee);
    }

    function _buyInternal(
        address tokenAddress,
        address buyer,
        uint256 ethAmount,
        uint256 minTokensOut
    ) internal returns (uint256 tokensOut) {
        PoolState storage state = _pools[tokenAddress];
        if (!state.isActive) revert PoolNotActive();
        if (state.isGraduated) revert PoolAlreadyGraduated();

        uint256 virtualEth = VIRTUAL_ETH_RESERVE + state.realETHReserve;
        uint256 virtualToken = state.realTokenReserve + (VIRTUAL_TOKEN_RESERVE - REAL_TOKEN_SUPPLY);

        // 计算毕业前最大可购买代币数量
        uint256 maxBuyableTokens = state.realTokenReserve > GRADUATION_THRESHOLD
            ? state.realTokenReserve - GRADUATION_THRESHOLD
            : 0;

        // 计算手续费
        uint256 fee = (ethAmount * FEE_BPS) / 10000;
        uint256 amountIn = ethAmount - fee;

        // 计算可获得代币数量
        tokensOut = ConstantProductAMMMath.getTokensOut(virtualEth, virtualToken, amountIn);

        // 检查是否触发毕业
        uint256 refundAmount = 0;
        bool willGraduate = false;

        if (tokensOut >= maxBuyableTokens && maxBuyableTokens > 0) {
            willGraduate = true;
            tokensOut = maxBuyableTokens;

            // 计算实际需要的 ETH
            uint256 ethNeeded = ConstantProductAMMMath.getETHIn(virtualEth, virtualToken, tokensOut);

            if (amountIn > ethNeeded) {
                uint256 excessEth = amountIn - ethNeeded;
                amountIn = ethNeeded;

                // 重新计算手续费
                uint256 newFee = (amountIn * FEE_BPS) / (10000 - FEE_BPS);
                refundAmount = excessEth + (fee - newFee);
                fee = newFee;
            }
        } else if (tokensOut > state.realTokenReserve) {
            revert InsufficientLiquidity(tokensOut, state.realTokenReserve);
        }

        if (tokensOut < minTokensOut) revert InsufficientLiquidity(tokensOut, minTokensOut);

        // AUDIT-FIX SC-C01: CEI 模式 — 状态更新在外部调用之前
        state.realETHReserve += amountIn;
        state.realTokenReserve -= tokensOut;
        state.soldTokens += tokensOut;

        // 铸造代币给买家 (内部调用，安全)
        IMemeTokenV2(tokenAddress).mint(buyer, tokensOut);

        // 分配手续费 (创建者25% + 邀请人10% + 平台65%) — 包含 ETH 外部调用
        if (fee > 0) {
            _distributeTradingFee(tokenAddress, buyer, fee);
        }

        // 退还多余 ETH — 外部调用在状态更新之后
        if (refundAmount > 0) {
            (bool refundSuccess,) = buyer.call{value: refundAmount}("");
            require(refundSuccess, "Refund failed");
        }

        emit Trade(tokenAddress, buyer, true, amountIn, tokensOut, virtualEth, virtualToken, block.timestamp);

        // 检查是否开启永续合约（达到阈值且未开启）
        if (!state.perpEnabled && state.realETHReserve >= PERP_ENABLE_THRESHOLD && priceFeed != address(0)) {
            _enablePerp(tokenAddress, state);
        }

        // 检查是否开启 P2P 借贷（达到阈值且未开启）
        if (!state.lendingEnabled && state.realETHReserve >= LENDING_ENABLE_THRESHOLD && lendingPool != address(0)) {
            _enableLending(tokenAddress, state);
        }

        // [C-01/C-05 修复] 同步价格到 PriceFeed（用于永续合约）
        PriceFeedHelper.syncPrice(
            priceFeed,
            tokenAddress,
            VIRTUAL_ETH_RESERVE + state.realETHReserve,
            state.realTokenReserve + (VIRTUAL_TOKEN_RESERVE - REAL_TOKEN_SUPPLY)
        );

        // 检查是否毕业
        if (willGraduate || (state.realTokenReserve <= GRADUATION_THRESHOLD && !state.isGraduated)) {
            // M-008: 检查剩余 gas 是否足够执行毕业
            // addLiquidityETH (含创建 pair) 需要约 2.8M gas，加上 _graduate 开销约 3M
            // 63/64 规则: 需要 3M * 64/63 ≈ 3.05M，保守要求 3.5M
            if (gasleft() >= 3_500_000) {
                _graduate(tokenAddress, state);
            } else {
                // gas 不足，标记失败让 owner 通过 retryGraduation 重试
                state.graduationFailed = true;
                state.graduationAttempts++;
                emit GraduationFailed(tokenAddress, state.graduationAttempts, "Insufficient gas for graduation");
            }
        }

        return tokensOut;
    }

    function _sellInternal(
        address tokenAddress,
        address seller,
        uint256 tokenAmount,
        uint256 minETHOut
    ) internal returns (uint256 ethOut) {
        PoolState storage state = _pools[tokenAddress];
        if (!state.isActive) revert PoolNotActive();
        if (state.isGraduated) revert PoolAlreadyGraduated();

        // 检查余额
        uint256 actualBalance = IERC20(tokenAddress).balanceOf(seller);
        if (actualBalance < tokenAmount) revert InsufficientBalance(tokenAmount, actualBalance);

        uint256 virtualEth = VIRTUAL_ETH_RESERVE + state.realETHReserve;
        uint256 virtualToken = state.realTokenReserve + (VIRTUAL_TOKEN_RESERVE - REAL_TOKEN_SUPPLY);

        uint256 ethOutTotal = ConstantProductAMMMath.getETHOut(virtualEth, virtualToken, tokenAmount);

        uint256 fee = (ethOutTotal * FEE_BPS) / 10000;
        ethOut = ethOutTotal - fee;

        if (ethOut < minETHOut) revert InsufficientLiquidity(ethOut, minETHOut);
        if (ethOutTotal > state.realETHReserve) revert InsufficientLiquidity(ethOutTotal, state.realETHReserve);

        // 转移代币到合约
        IERC20(tokenAddress).safeTransferFrom(seller, address(this), tokenAmount);

        // AUDIT-FIX SC-C01: CEI (Checks-Effects-Interactions) 模式
        // 状态更新必须在 ETH 外部调用之前完成，防止重入攻击
        // (合约已有 nonReentrant 保护，此为纵深防御)
        state.realETHReserve -= ethOutTotal;
        state.realTokenReserve += tokenAmount;
        state.soldTokens -= tokenAmount;

        // 销毁代币 (内部调用，安全)
        IMemeTokenV2(tokenAddress).burn(tokenAmount);

        // 分配手续费 (创建者25% + 邀请人10% + 平台65%) — 包含 ETH 外部调用
        _distributeTradingFee(tokenAddress, seller, fee);

        // 转移 ETH 给卖家 — 外部调用在状态更新之后
        (bool success,) = seller.call{value: ethOut}("");
        require(success, "ETH transfer failed");

        emit Trade(tokenAddress, seller, false, ethOut, tokenAmount, virtualEth, virtualToken, block.timestamp);

        // [C-01/C-05 修复] 同步价格到 PriceFeed（用于永续合约）
        PriceFeedHelper.syncPrice(
            priceFeed,
            tokenAddress,
            VIRTUAL_ETH_RESERVE + state.realETHReserve,
            state.realTokenReserve + (VIRTUAL_TOKEN_RESERVE - REAL_TOKEN_SUPPLY)
        );
    }

    /**
     * @notice 自动开启永续合约交易
     * @dev 当池子达到 PERP_ENABLE_THRESHOLD 时自动调用 PriceFeed 添加代币
     */
    function _enablePerp(address tokenAddress, PoolState storage state) internal {
        // 计算当前价格
        uint256 virtualEth = VIRTUAL_ETH_RESERVE + state.realETHReserve;
        uint256 virtualToken = state.realTokenReserve + (VIRTUAL_TOKEN_RESERVE - REAL_TOKEN_SUPPLY);
        uint256 currentPrice = ConstantProductAMMMath.getCurrentPrice(virtualEth, virtualToken);

        // 调用 PriceFeed 添加代币支持
        try IPriceFeedFactory(priceFeed).addSupportedTokenFromFactory(tokenAddress, currentPrice) {
            state.perpEnabled = true;
            emit PerpEnabled(tokenAddress, state.realETHReserve, currentPrice);
        } catch {
            // 如果失败，不阻止交易，下次买入会重试
        }
    }

    /**
     * @notice 自动开启 P2P 借贷
     * @dev 当池子达到 LENDING_ENABLE_THRESHOLD 时自动调用 LendingPool.enableToken
     */
    function _enableLending(address tokenAddress, PoolState storage state) internal {
        try ILendingPool(lendingPool).enableToken(tokenAddress) {
            state.lendingEnabled = true;
            emit LendingEnabled(tokenAddress, state.realETHReserve);
        } catch {
            // 如果失败，不阻止交易，下次买入会重试
        }
    }

    function _graduate(address tokenAddress, PoolState storage state) internal {
        if (state.isGraduated) revert PoolAlreadyGraduated();

        uint256 ethAmount = state.realETHReserve;
        uint256 tokenAmount = state.realTokenReserve;

        // M-007: 增加尝试次数
        state.graduationAttempts++;

        // 计算毕业费和流动性 ETH（费用仅在成功后发送）
        uint256 graduationFee = GRADUATION_FEE;
        uint256 liquidityETH = ethAmount - graduationFee;

        // 铸造剩余代币到合约（用于添加流动性）
        IMemeTokenV2(tokenAddress).mint(address(this), tokenAmount);

        // 授权 Router
        IERC20(tokenAddress).approve(uniswapV2Router, tokenAmount);

        // LP Token 发送到死地址 (销毁)
        address DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

        // 允许 1% 滑点 (token + ETH 双向保护)
        uint256 minTokenAmount = tokenAmount * 99 / 100;
        // M-14 FIX: ETH 侧也添加滑点保护，防止 MEV 三明治攻击
        uint256 minETHAmount = liquidityETH * 99 / 100;

        try IUniswapV2Router02(uniswapV2Router).addLiquidityETH{value: liquidityETH}(
            tokenAddress,
            tokenAmount,
            minTokenAmount,
            minETHAmount,
            DEAD_ADDRESS,
            block.timestamp + 300
        ) returns (uint256, uint256, uint256) {
            // 只在成功后才锁定铸造、收取毕业费、移除权限
            state.isGraduated = true;
            state.graduationFailed = false;

            // 发送毕业费给 feeReceiver（仅在流动性添加成功后）
            Address.sendValue(payable(feeReceiver), graduationFee);
            emit GraduationFeeCollected(tokenAddress, graduationFee, feeReceiver);

            // 迁移成功，锁定铸造
            IMemeTokenV2(tokenAddress).lockMinting();

            address factory = IUniswapV2Router02(uniswapV2Router).factory();
            address pairAddress = IUniswapV2Factory(factory).getPair(tokenAddress, WETH);

            // P0-2: 存储 Uniswap V2 Pair 地址并通知 PriceFeed
            uniswapPairs[tokenAddress] = pairAddress;
            if (priceFeed != address(0) && pairAddress != address(0)) {
                // 通知 PriceFeed 设置 Uniswap Pair（毕业后价格源切换）
                try IPriceFeedFactory(priceFeed).setTokenUniswapPair(tokenAddress, pairAddress) {} catch {}
            }

            // 毕业后启用清算奖励（从系统清算0%切换到外部清算7.5%）
            if (liquidation != address(0)) {
                try ILiquidationCallback(liquidation).enableLiquidatorReward(tokenAddress) {} catch {}
            }

            // 移除 Minter 权限
            IMemeTokenV2(tokenAddress).removeMinter(address(this));

            emit LiquidityMigrated(tokenAddress, pairAddress, liquidityETH, tokenAmount, block.timestamp);
        } catch Error(string memory reason) {
            // 迁移失败 — 销毁刚铸造的代币，恢复原状（毕业费未发送）
            IERC20(tokenAddress).approve(uniswapV2Router, 0);
            IMemeTokenV2(tokenAddress).burn(tokenAmount);
            state.graduationFailed = true;
            emit GraduationFailed(tokenAddress, state.graduationAttempts, reason);
        } catch {
            // 未知错误 — 同样销毁并恢复（毕业费未发送）
            IERC20(tokenAddress).approve(uniswapV2Router, 0);
            IMemeTokenV2(tokenAddress).burn(tokenAmount);
            state.graduationFailed = true;
            emit GraduationFailed(tokenAddress, state.graduationAttempts, "Unknown error");
        }
    }

    // ══════════════════════════════════════════════════════════════════════════════
    // ADMIN
    // ══════════════════════════════════════════════════════════════════════════════

    // P-007: Emergency pause functionality
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setServiceFee(uint256 newFee) external onlyOwner {
        uint256 oldFee = serviceFee;
        serviceFee = newFee;
        emit ServiceFeeUpdated(oldFee, newFee);
    }

    function setFeeReceiver(address newFeeReceiver) external onlyOwner {
        if (newFeeReceiver == address(0)) revert InvalidAddress();
        address oldReceiver = feeReceiver;
        feeReceiver = newFeeReceiver;
        emit FeeReceiverUpdated(oldReceiver, newFeeReceiver);
    }

    function setUniswapV2Router(address newRouter) external onlyOwner {
        if (newRouter == address(0)) revert InvalidAddress();
        address oldRouter = uniswapV2Router;
        uniswapV2Router = newRouter;
        emit RouterUpdated(oldRouter, newRouter);
    }

    /**
     * @notice 设置 PriceFeed 地址（用于自动开启永续合约）
     * @param newPriceFeed PriceFeed 地址
     */
    function setPriceFeed(address newPriceFeed) external onlyOwner {
        if (newPriceFeed == address(0)) revert InvalidAddress();
        address oldPriceFeed = priceFeed;
        priceFeed = newPriceFeed;
        emit PriceFeedUpdated(oldPriceFeed, newPriceFeed);
    }

    /**
     * @notice 设置 LendingPool 地址（用于自动开启 P2P 借贷）
     * @param newLendingPool LendingPool 地址
     */
    function setLendingPool(address newLendingPool) external onlyOwner {
        if (newLendingPool == address(0)) revert InvalidAddress();
        address oldLendingPool = lendingPool;
        lendingPool = newLendingPool;
        emit LendingPoolUpdated(oldLendingPool, newLendingPool);
    }

    function setLiquidation(address _liquidation) external onlyOwner {
        if (_liquidation == address(0)) revert InvalidAddress();
        address old = liquidation;
        liquidation = _liquidation;
        emit LiquidationUpdated(old, _liquidation);
    }

    /**
     * @notice M-007: 管理员重试毕业流程
     * @param tokenAddress 代币地址
     */
    function retryGraduation(address tokenAddress) external onlyOwner nonReentrant {
        PoolState storage state = _pools[tokenAddress];
        if (!state.graduationFailed) revert GraduationNotFailed();
        if (state.isGraduated) revert PoolAlreadyGraduated();
        if (state.graduationAttempts >= 10) revert MaxGraduationAttempts();

        emit GraduationRetried(tokenAddress, state.graduationAttempts + 1);
        _graduate(tokenAddress, state);
    }

    /**
     * @notice M-007: 紧急回退毕业流程，允许继续交易
     * @dev 重置池子状态，解锁铸造（如果被锁定）
     * @param tokenAddress 代币地址
     */
    function rollbackGraduation(address tokenAddress) external onlyOwner nonReentrant {
        PoolState storage state = _pools[tokenAddress];
        if (!state.graduationFailed) revert GraduationNotFailed();
        if (state.isGraduated) revert PoolAlreadyGraduated();

        // M-13 FIX: 仅重置 graduationFailed flag，不膨胀 realTokenReserve
        // 原来 += GRADUATION_THRESHOLD / 10 会导致会计偏差：
        // 凭空增加 token reserve 使 bonding curve 价格失真
        state.graduationFailed = false;

        // 解锁铸造（如果之前被旧版本锁定了）
        try IMemeTokenV2(tokenAddress).unlockMinting() {} catch {}

        emit GraduationRolledBack(tokenAddress, state.realETHReserve);
    }

    /**
     * @notice M-007: 紧急提取卡住的ETH（仅在毕业失败后）
     * @param tokenAddress 代币地址
     * @param recipient 接收地址
     */
    function emergencyWithdraw(address tokenAddress, address recipient) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert InvalidAddress();

        PoolState storage state = _pools[tokenAddress];
        if (!state.graduationFailed) revert GraduationNotFailed();
        if (state.graduationAttempts < 3) revert("Must attempt graduation 3 times first");

        uint256 ethAmount = state.realETHReserve;
        state.realETHReserve = 0;
        state.isActive = false;

        (bool success,) = recipient.call{value: ethAmount}("");
        require(success, "ETH transfer failed");
    }

    // ══════════════════════════════════════════════════════════════════════════════
    // FEE CLAIMS
    // ══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice 设置邀请人 (每个用户只能设置一次)
     * @param referrer 邀请人地址
     */
    function setReferrer(address referrer) external {
        if (referrer == address(0)) revert InvalidAddress();
        if (referrer == msg.sender) revert CannotReferSelf();
        if (userReferrer[msg.sender] != address(0)) revert ReferrerAlreadySet();

        userReferrer[msg.sender] = referrer;
        emit ReferrerSet(msg.sender, referrer);
    }

    /**
     * @notice 创建者提取收益
     * @param token 代币地址
     */
    function claimCreatorEarnings(address token) external nonReentrant {
        PoolState storage state = _pools[token];
        if (state.creator != msg.sender) revert InvalidAddress();

        uint256 amount = creatorEarnings[token];
        if (amount == 0) revert NoEarningsToClaim();

        creatorEarnings[token] = 0;
        Address.sendValue(payable(msg.sender), amount);

        emit CreatorEarningsClaimed(token, msg.sender, amount);
    }

    /**
     * @notice 邀请人提取返佣
     */
    function claimReferrerEarnings() external nonReentrant {
        uint256 amount = referrerEarnings[msg.sender];
        if (amount == 0) revert NoEarningsToClaim();

        referrerEarnings[msg.sender] = 0;
        Address.sendValue(payable(msg.sender), amount);

        emit ReferrerEarningsClaimed(msg.sender, amount);
    }

    /**
     * @notice 平台提取收益 (仅管理员)
     */
    function claimPlatformEarnings() external onlyOwner nonReentrant {
        uint256 amount = platformEarnings;
        if (amount == 0) revert NoEarningsToClaim();

        platformEarnings = 0;
        Address.sendValue(payable(feeReceiver), amount);

        emit PlatformEarningsClaimed(feeReceiver, amount);
    }

    // ══════════════════════════════════════════════════════════════════════════════
    // VIEWS
    // ══════════════════════════════════════════════════════════════════════════════

    function getPoolState(address tokenAddress) external view returns (PoolState memory) {
        return _pools[tokenAddress];
    }

    /// @notice 获取代币创建者地址 (供 PositionManager 调用)
    function getTokenCreator(address tokenAddress) external view returns (address) {
        return _pools[tokenAddress].creator;
    }

    function getCurrentPrice(address tokenAddress) external view returns (uint256) {
        PoolState memory state = _pools[tokenAddress];
        uint256 virtualEth = VIRTUAL_ETH_RESERVE + state.realETHReserve;
        uint256 virtualToken = state.realTokenReserve + (VIRTUAL_TOKEN_RESERVE - REAL_TOKEN_SUPPLY);
        return ConstantProductAMMMath.getCurrentPrice(virtualEth, virtualToken);
    }

    function previewBuy(address tokenAddress, uint256 ethIn) external view returns (uint256) {
        PoolState memory state = _pools[tokenAddress];
        uint256 virtualEth = VIRTUAL_ETH_RESERVE + state.realETHReserve;
        uint256 virtualToken = state.realTokenReserve + (VIRTUAL_TOKEN_RESERVE - REAL_TOKEN_SUPPLY);
        uint256 fee = (ethIn * FEE_BPS) / 10000;
        return ConstantProductAMMMath.getTokensOut(virtualEth, virtualToken, ethIn - fee);
    }

    function previewSell(address tokenAddress, uint256 tokensIn) external view returns (uint256) {
        PoolState memory state = _pools[tokenAddress];
        uint256 virtualEth = VIRTUAL_ETH_RESERVE + state.realETHReserve;
        uint256 virtualToken = state.realTokenReserve + (VIRTUAL_TOKEN_RESERVE - REAL_TOKEN_SUPPLY);
        uint256 ethOutTotal = ConstantProductAMMMath.getETHOut(virtualEth, virtualToken, tokensIn);
        uint256 fee = (ethOutTotal * FEE_BPS) / 10000;
        return ethOutTotal - fee;
    }

    function getAllTokens() external view returns (address[] memory) {
        return allTokens;
    }

    function getTokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    // L-10 FIX: 添加事件追踪意外 ETH 存入
    receive() external payable {
        emit ETHReceived(msg.sender, msg.value);
    }
}
