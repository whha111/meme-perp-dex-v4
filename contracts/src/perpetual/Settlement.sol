// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "../common/IContractRegistry.sol";

// WETH 接口
interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
    function balanceOf(address) external view returns (uint256);
}

/**
 * @title Settlement
 * @notice 链上结算合约 - 中心化撮合 + 链上结算 (ETH 本位版本)
 * @dev ETH 本位: 所有金额以 ETH 计价 (1e18 精度)
 *      Session Key 功能已移至 SessionKeyManager 合约
 */
contract Settlement is Ownable, ReentrancyGuard, Pausable, EIP712 {
    using ECDSA for bytes32;
    using SafeCast for uint256;
    using SafeERC20 for IERC20;

    // ============================================================
    // Constants
    // ============================================================

    uint256 public constant PRECISION = 1e18;
    uint256 public constant LEVERAGE_PRECISION = 1e4;
    uint256 public constant MAX_LEVERAGE = 100 * LEVERAGE_PRECISION;
    uint256 public constant MAINTENANCE_MARGIN_RATE = 50;
    uint256 public constant MAX_PNL = uint256(type(int256).max);
    uint256 public constant STANDARD_DECIMALS = 18;  // ETH 本位: 1e18 精度
    uint256 public fundingInterval = 15 minutes; // 15分钟收取（与 FundingRate.sol 对齐）

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address trader,address token,bool isLong,uint256 size,uint256 leverage,uint256 price,uint256 deadline,uint256 nonce,uint8 orderType)"
    );

    // EIP-712 签名类型 - 用于代付 gas 的充值/提款
    bytes32 public constant DEPOSIT_TYPEHASH = keccak256(
        "Deposit(address user,address token,uint256 amount,uint256 deadline,uint256 nonce)"
    );

    bytes32 public constant WITHDRAW_TYPEHASH = keccak256(
        "Withdraw(address user,address token,uint256 amount,uint256 deadline,uint256 nonce)"
    );

    // ============================================================
    // Enums & Structs
    // ============================================================

    enum OrderType { MARKET, LIMIT }
    enum PositionStatus { ACTIVE, CLOSED, LIQUIDATED }

    struct Order {
        address trader;
        address token;
        bool isLong;
        uint256 size;
        uint256 leverage;
        uint256 price;
        uint256 deadline;
        uint256 nonce;
        OrderType orderType;
    }

    struct MatchedPair {
        Order longOrder;
        bytes longSignature;
        Order shortOrder;
        bytes shortSignature;
        uint256 matchPrice;
        uint256 matchSize;
    }

    struct PairedPosition {
        uint256 pairId;
        address longTrader;
        address shortTrader;
        address token;
        uint256 size;
        uint256 entryPrice;
        uint256 longCollateral;
        uint256 shortCollateral;
        uint256 longLeverage;
        uint256 shortLeverage;
        uint256 openTime;
        uint256 lastFundingSettled; // C-01 fix: 上次 funding 结算时间，避免双重收费
        int256 accFundingLong;
        int256 accFundingShort;
        PositionStatus status;
    }

    struct UserBalance {
        uint256 available;
        uint256 locked;
    }

    // ============================================================
    // State Variables
    // ============================================================

    IContractRegistry public contractRegistry;

    // WETH 合约地址 (用于 ETH 直接存入)
    address public weth;

    mapping(address => bool) public supportedTokens;
    mapping(address => uint8) public tokenDecimals;
    address[] public supportedTokenList;

    mapping(address => bool) public authorizedMatchers;
    address public legacyPositionManager;

    mapping(address => uint256) public nonces;
    mapping(bytes32 => uint256) public filledAmounts;
    mapping(address => bool) public sequentialNonceMode;

    // 用于代付 gas 操作的 nonce (防重放攻击)
    mapping(address => uint256) public metaTxNonces;

    mapping(address => UserBalance) public balances;
    mapping(uint256 => PairedPosition) public pairedPositions;
    mapping(address => uint256[]) public userPairIds;
    uint256 public nextPairId = 1;

    address public insuranceFund;
    uint256 public feeRate = 10;
    address public feeReceiver;

    mapping(address => int256) public fundingRates;
    uint256 public lastFundingTime;
    mapping(address => uint256) public tokenPrices;
    mapping(address => mapping(address => uint256)) public userPositionSizes;

    // ============================================================
    // 日结与保险基金相关状态变量
    // ============================================================

    // 累计清算罚金 (待转保险基金)
    uint256 public pendingLiquidationPenalty;

    // 总锁定保证金 (用于健康度检查)
    uint256 public totalLockedMargin;

    // ============================================================
    // ADL Timeout State (P1-4)
    // ============================================================

    /// @notice ADL 超时时间（5 分钟）— 撮合引擎未响应时的后备
    uint256 public constant ADL_TIMEOUT = 5 minutes;

    /// @notice ADL 是否处于激活状态（保险基金耗尽时激活）
    bool public adlActive;

    /// @notice ADL 上次触发时间
    uint256 public lastADLTriggerTime;

    // ============================================================
    // Events
    // ============================================================

    event Deposited(address indexed user, uint256 amount);
    event DepositedFor(address indexed user, address indexed relayer, address token, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event WithdrawnFor(address indexed user, address indexed relayer, address token, uint256 amount);
    event MatcherAuthorized(address indexed matcher, bool authorized);
    event PairOpened(uint256 indexed pairId, address indexed longTrader, address indexed shortTrader, address token, uint256 size, uint256 entryPrice);
    event PairClosed(uint256 indexed pairId, uint256 exitPrice, int256 longPnL, int256 shortPnL);
    event Liquidated(uint256 indexed pairId, address indexed liquidatedTrader, address indexed liquidator, uint256 reward);
    event FundingSettled(uint256 indexed pairId, int256 longPayment, int256 shortPayment);
    event BatchSettled(uint256 pairCount, uint256 timestamp);
    event PriceUpdated(address indexed token, uint256 price);
    event SequentialNonceModeSet(address indexed user, bool enabled);
    event TokenAdded(address indexed token, uint8 decimals);
    event TokenRemoved(address indexed token);
    event ContractRegistrySet(address indexed registry);
    event ADLTriggered(uint256 indexed targetPairId, uint256 indexed adlPairId, address indexed adlTrader, uint256 adlAmount, uint256 deficit);
    event DailySettlementCompleted(uint256 fundingFee, uint256 liquidationPenalty, uint256 totalTransferred, uint256 timestamp);
    event InsuranceInjected(uint256 amount, uint256 timestamp);
    event EmergencyPaused(address indexed by, string reason);
    event EmergencyUnpaused(address indexed by);
    // P3: Missing admin setter events
    event WETHUpdated(address indexed oldWeth, address indexed newWeth);
    event InsuranceFundUpdated(address indexed oldFund, address indexed newFund);
    event FeeRateUpdated(uint256 oldRate, uint256 newRate);
    event FeeReceiverUpdated(address indexed oldReceiver, address indexed newReceiver);
    event FundingIntervalUpdated(uint256 oldInterval, uint256 newInterval);
    event BaseFundingRateUpdated(uint256 oldRate, uint256 newRate);
    event LegacyPositionManagerUpdated(address indexed oldPM, address indexed newPM);
    event NonceIncremented(address indexed user, uint256 newNonce);
    event ForceADLExecuted(uint256 indexed pairId, uint256 exitPrice, address indexed executor);
    event ADLResolved(address indexed by);

    // ============================================================
    // Errors
    // ============================================================

    error Unauthorized();
    error InvalidSignature();
    error OrderExpired();
    error InvalidNonce();
    error OrderAlreadyUsed();
    error InvalidMatch();
    error InsufficientBalance();
    error PositionNotActive();
    error CannotLiquidate();
    error InvalidAmount();
    error HasLegacyPosition();
    error TokenNotSupported();
    error ContractNotActive();
    error OrderSizeTooSmall();
    error OrderSizeTooBig();
    error PositionLimitExceeded();
    error LeverageTooHigh();
    error PriceDeviationTooLarge();
    error NoActiveADL();
    error ADLTimeoutNotReached();

    // ============================================================
    // Constructor
    // ============================================================

    constructor() Ownable(msg.sender) EIP712("MemePerp", "1") {
        feeReceiver = msg.sender;
        lastFundingTime = block.timestamp;
    }

    // ============================================================
    // User Functions
    // ============================================================

    function deposit(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (!supportedTokens[token]) revert TokenNotSupported();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 standardAmount = _toStandardDecimals(token, amount);
        balances[msg.sender].available += standardAmount;
        emit Deposited(msg.sender, standardAmount);
    }

    /**
     * @notice 为其他地址充值 (主钱包为派生钱包充值)
     * @dev 调用者支付代币和 gas，余额计入 recipient
     * @param recipient 接收余额的地址 (派生钱包/trading wallet)
     * @param token 代币地址
     * @param amount 充值金额
     */
    function depositTo(address recipient, address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (recipient == address(0)) revert InvalidAmount();
        if (!supportedTokens[token]) revert TokenNotSupported();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 standardAmount = _toStandardDecimals(token, amount);
        balances[recipient].available += standardAmount;
        emit DepositedFor(recipient, msg.sender, token, standardAmount);
    }

    /**
     * @notice 直接存入 ETH (自动包装为 WETH)
     * @dev 用户可以直接发送 ETH，合约自动包装为 WETH 并计入余额
     */
    function depositETH() external payable nonReentrant {
        if (msg.value == 0) revert InvalidAmount();
        if (weth == address(0)) revert TokenNotSupported();
        if (!supportedTokens[weth]) revert TokenNotSupported();

        // 包装 ETH 为 WETH
        IWETH(weth).deposit{value: msg.value}();

        // 计算标准化金额并计入余额
        uint256 standardAmount = _toStandardDecimals(weth, msg.value);
        balances[msg.sender].available += standardAmount;
        emit Deposited(msg.sender, standardAmount);
    }

    function depositWithPermit(address token, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (!supportedTokens[token]) revert TokenNotSupported();
        IERC20Permit(token).permit(msg.sender, address(this), amount, deadline, v, r, s);
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 standardAmount = _toStandardDecimals(token, amount);
        balances[msg.sender].available += standardAmount;
        emit Deposited(msg.sender, standardAmount);
    }

    function withdraw(address token, uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert InvalidAmount();
        if (!supportedTokens[token]) revert TokenNotSupported();
        if (balances[msg.sender].available < amount) revert InsufficientBalance();
        balances[msg.sender].available -= amount;
        uint256 tokenAmount = _fromStandardDecimals(token, amount);
        require(IERC20(token).balanceOf(address(this)) >= tokenAmount, "Insufficient liquidity");
        IERC20(token).safeTransfer(msg.sender, tokenAmount);
        emit Withdrawn(msg.sender, amount);
    }

    // ============================================================
    // Meta Transaction Functions (代付 Gas)
    // ============================================================

    /**
     * @notice 代付 gas 充值 ERC20 代币
     * @dev 用户签名授权，relayer 代为提交交易并支付 gas
     * @param user 用户地址
     * @param token 代币地址
     * @param amount 充值金额
     * @param deadline 签名过期时间
     * @param signature 用户的 EIP-712 签名
     */
    function depositFor(
        address user,
        address token,
        uint256 amount,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (!supportedTokens[token]) revert TokenNotSupported();
        if (block.timestamp > deadline) revert OrderExpired();

        // 验证签名
        uint256 nonce = metaTxNonces[user]++;
        bytes32 structHash = keccak256(abi.encode(
            DEPOSIT_TYPEHASH,
            user,
            token,
            amount,
            deadline,
            nonce
        ));
        bytes32 hash = _hashTypedDataV4(structHash);
        address signer = hash.recover(signature);
        if (signer != user) revert InvalidSignature();

        // 从用户账户转入代币（用户需要先 approve）
        IERC20(token).safeTransferFrom(user, address(this), amount);
        uint256 standardAmount = _toStandardDecimals(token, amount);
        balances[user].available += standardAmount;

        emit DepositedFor(user, msg.sender, token, standardAmount);
    }

    /**
     * @notice 代付 gas 充值 ETH（自动包装为 WETH）
     * @dev relayer 发送 ETH，合约自动包装并计入用户余额
     * @param user 用户地址
     * @param deadline 签名过期时间
     * @param signature 用户的 EIP-712 签名
     */
    function depositETHFor(
        address user,
        uint256 deadline,
        bytes calldata signature
    ) external payable nonReentrant {
        if (msg.value == 0) revert InvalidAmount();
        if (weth == address(0)) revert TokenNotSupported();
        if (!supportedTokens[weth]) revert TokenNotSupported();
        if (block.timestamp > deadline) revert OrderExpired();

        // 验证签名
        uint256 nonce = metaTxNonces[user]++;
        bytes32 structHash = keccak256(abi.encode(
            DEPOSIT_TYPEHASH,
            user,
            weth,
            msg.value,
            deadline,
            nonce
        ));
        bytes32 hash = _hashTypedDataV4(structHash);
        address signer = hash.recover(signature);
        if (signer != user) revert InvalidSignature();

        // 包装 ETH 为 WETH
        IWETH(weth).deposit{value: msg.value}();

        // 计入用户余额
        uint256 standardAmount = _toStandardDecimals(weth, msg.value);
        balances[user].available += standardAmount;

        emit DepositedFor(user, msg.sender, weth, standardAmount);
    }

    /**
     * @notice 代付 gas 提款
     * @dev 用户签名授权，relayer 代为提交交易并支付 gas
     * @param user 用户地址
     * @param token 代币地址
     * @param amount 提款金额
     * @param deadline 签名过期时间
     * @param signature 用户的 EIP-712 签名
     */
    function withdrawFor(
        address user,
        address token,
        uint256 amount,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        if (amount == 0) revert InvalidAmount();
        if (!supportedTokens[token]) revert TokenNotSupported();
        if (block.timestamp > deadline) revert OrderExpired();
        if (balances[user].available < amount) revert InsufficientBalance();

        // 验证签名
        uint256 nonce = metaTxNonces[user]++;
        bytes32 structHash = keccak256(abi.encode(
            WITHDRAW_TYPEHASH,
            user,
            token,
            amount,
            deadline,
            nonce
        ));
        bytes32 hash = _hashTypedDataV4(structHash);
        address signer = hash.recover(signature);
        if (signer != user) revert InvalidSignature();

        // 执行提款
        balances[user].available -= amount;
        uint256 tokenAmount = _fromStandardDecimals(token, amount);
        require(IERC20(token).balanceOf(address(this)) >= tokenAmount, "Insufficient liquidity");
        IERC20(token).safeTransfer(user, tokenAmount);

        emit WithdrawnFor(user, msg.sender, token, amount);
    }

    /**
     * @notice 获取用户的 meta transaction nonce
     */
    function getMetaTxNonce(address user) external view returns (uint256) {
        return metaTxNonces[user];
    }

    function incrementNonce() external {
        nonces[msg.sender]++;
        emit NonceIncremented(msg.sender, nonces[msg.sender]);
    }

    function setSequentialNonceMode(bool enabled) external {
        sequentialNonceMode[msg.sender] = enabled;
        emit SequentialNonceModeSet(msg.sender, enabled);
    }

    // ============================================================
    // Admin Functions
    // ============================================================

    function setContractRegistry(address _registry) external onlyOwner {
        contractRegistry = IContractRegistry(_registry);
        emit ContractRegistrySet(_registry);
    }

    function setWETH(address _weth) external onlyOwner {
        address old = weth;
        weth = _weth;
        emit WETHUpdated(old, _weth);
    }

    function setAuthorizedMatcher(address matcher, bool authorized) external onlyOwner {
        authorizedMatchers[matcher] = authorized;
        emit MatcherAuthorized(matcher, authorized);
    }

    function setInsuranceFund(address _insuranceFund) external onlyOwner {
        address old = insuranceFund;
        insuranceFund = _insuranceFund;
        emit InsuranceFundUpdated(old, _insuranceFund);
    }

    function setFeeRate(uint256 _feeRate) external onlyOwner {
        require(_feeRate <= 100, "Fee too high");
        uint256 old = feeRate;
        feeRate = _feeRate;
        emit FeeRateUpdated(old, _feeRate);
    }

    function setFeeReceiver(address _feeReceiver) external onlyOwner {
        address old = feeReceiver;
        feeReceiver = _feeReceiver;
        emit FeeReceiverUpdated(old, _feeReceiver);
    }

    /// @notice 设置资金费率间隔（与 FundingRate.sol 对齐）
    function setFundingInterval(uint256 _interval) external onlyOwner {
        require(_interval >= 1 minutes && _interval <= 24 hours, "Out of range");
        uint256 old = fundingInterval;
        fundingInterval = _interval;
        emit FundingIntervalUpdated(old, _interval);
    }

    /// @notice 设置基础资金费率（bps）
    function setBaseFundingRate(uint256 _rateBps) external onlyOwner {
        require(_rateBps <= 100, "Max 1%");
        uint256 old = baseFundingRateBps;
        baseFundingRateBps = _rateBps;
        emit BaseFundingRateUpdated(old, _rateBps);
    }

    function setLegacyPositionManager(address _legacy) external onlyOwner {
        address old = legacyPositionManager;
        legacyPositionManager = _legacy;
        emit LegacyPositionManagerUpdated(old, _legacy);
    }

    function addSupportedToken(address token, uint8 decimals) external onlyOwner {
        require(token != address(0) && !supportedTokens[token], "Invalid");
        if (decimals == 0) {
            (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("decimals()"));
            require(ok && data.length >= 32, "Cannot detect decimals");
            decimals = abi.decode(data, (uint8));
        }
        supportedTokens[token] = true;
        tokenDecimals[token] = decimals;
        supportedTokenList.push(token);
        emit TokenAdded(token, decimals);
    }

    function removeSupportedToken(address token) external onlyOwner {
        require(supportedTokens[token], "Not supported");
        supportedTokens[token] = false;
        for (uint256 i = 0; i < supportedTokenList.length; i++) {
            if (supportedTokenList[i] == token) {
                supportedTokenList[i] = supportedTokenList[supportedTokenList.length - 1];
                supportedTokenList.pop();
                break;
            }
        }
        emit TokenRemoved(token);
    }

    /**
     * @notice 紧急暂停合约
     * @dev 暂停后，所有关键操作（提款、结算、清算）都会被阻止
     * @param reason 暂停原因（用于日志记录）
     */
    function emergencyPause(string calldata reason) external onlyOwner {
        _pause();
        emit EmergencyPaused(msg.sender, reason);
    }

    /**
     * @notice 恢复合约运行
     * @dev 只有 owner 可以恢复
     */
    function emergencyUnpause() external onlyOwner {
        _unpause();
        emit EmergencyUnpaused(msg.sender);
    }

    // ============================================================
    // Batch PnL Settlement (链下→链上同步)
    // ============================================================

    event BatchPnLSettled(uint256 transferCount, uint256 totalAmount, uint256 timestamp);

    /**
     * @notice 批量结算链下 PnL 到链上余额
     * @dev 仅 authorizedMatcher 可调用。用于将链下撮合产生的盈亏同步到链上。
     *      from[i] 的 available 减少 amounts[i]，to[i] 的 available 增加 amounts[i]。
     *      这确保盈利用户可以从链上提取利润。
     * @param from 亏损方地址数组（余额减少）
     * @param to 盈利方地址数组（余额增加）
     * @param amounts 转移金额数组（1e18 精度）
     */
    function batchSettlePnL(
        address[] calldata from,
        address[] calldata to,
        uint256[] calldata amounts
    ) external nonReentrant whenNotPaused {
        if (!authorizedMatchers[msg.sender]) revert Unauthorized();
        require(from.length == to.length && to.length == amounts.length, "Length mismatch");
        require(from.length > 0, "Empty batch");
        require(from.length <= 200, "Batch too large");

        uint256 totalAmount;
        for (uint256 i = 0; i < from.length; i++) {
            require(amounts[i] > 0, "Zero amount");
            require(balances[from[i]].available >= amounts[i], "Insufficient from balance");

            balances[from[i]].available -= amounts[i];
            balances[to[i]].available += amounts[i];
            totalAmount += amounts[i];
        }

        emit BatchPnLSettled(from.length, totalAmount, block.timestamp);
    }

    // ============================================================
    // Matcher Functions
    // ============================================================

    function updatePrice(address token, uint256 price) external {
        if (!authorizedMatchers[msg.sender]) revert Unauthorized();
        tokenPrices[token] = price;
        emit PriceUpdated(token, price);
    }

    function updateFundingRate(address token, int256 rate) external {
        if (!authorizedMatchers[msg.sender]) revert Unauthorized();
        fundingRates[token] = rate;
    }

    function settleBatch(MatchedPair[] calldata pairs) external nonReentrant whenNotPaused {
        if (!authorizedMatchers[msg.sender]) revert Unauthorized();
        for (uint256 i = 0; i < pairs.length; i++) {
            _settlePair(pairs[i]);
        }
        emit BatchSettled(pairs.length, block.timestamp);
    }

    function _settlePair(MatchedPair calldata pair) internal {
        _validateOrder(pair.longOrder, pair.longSignature, true);
        _validateOrder(pair.shortOrder, pair.shortSignature, false);

        if (_hasLegacyPosition(pair.longOrder.trader)) revert HasLegacyPosition();
        if (_hasLegacyPosition(pair.shortOrder.trader)) revert HasLegacyPosition();
        if (pair.longOrder.token != pair.shortOrder.token) revert InvalidMatch();
        if (pair.matchSize == 0) revert InvalidMatch();

        _validateContractSpec(pair);

        // 验证填充量
        {
            bytes32 longHash = getOrderHash(pair.longOrder);
            bytes32 shortHash = getOrderHash(pair.shortOrder);
            if (pair.matchSize > pair.longOrder.size - filledAmounts[longHash]) revert InvalidMatch();
            if (pair.matchSize > pair.shortOrder.size - filledAmounts[shortHash]) revert InvalidMatch();
        }

        // 计算保证金
        uint256 longCollateral = (pair.matchSize * LEVERAGE_PRECISION) / pair.longOrder.leverage;
        uint256 shortCollateral = (pair.matchSize * LEVERAGE_PRECISION) / pair.shortOrder.leverage;

        // 处理手续费和余额
        _processFeesAndLock(pair.longOrder.trader, pair.shortOrder.trader, longCollateral, shortCollateral, pair.matchSize);

        // 创建配对仓位
        uint256 pairId = _createPairedPosition(pair, longCollateral, shortCollateral);

        // 更新追踪数据
        _updateTrackingData(pair, pairId);

        emit PairOpened(pairId, pair.longOrder.trader, pair.shortOrder.trader, pair.longOrder.token, pair.matchSize, pair.matchPrice);
    }

    /// @dev 处理手续费、锁定保证金
    function _processFeesAndLock(
        address longTrader, address shortTrader,
        uint256 longCollateral, uint256 shortCollateral,
        uint256 matchSize
    ) internal {
        uint256 perSideFee = (matchSize * feeRate) / 10000;

        if (balances[longTrader].available < longCollateral + perSideFee) revert InsufficientBalance();
        if (balances[shortTrader].available < shortCollateral + perSideFee) revert InsufficientBalance();

        balances[longTrader].available -= (longCollateral + perSideFee);
        balances[longTrader].locked += longCollateral;
        balances[shortTrader].available -= (shortCollateral + perSideFee);
        balances[shortTrader].locked += shortCollateral;
        if (perSideFee > 0) balances[feeReceiver].available += perSideFee * 2;

        totalLockedMargin += longCollateral + shortCollateral;
    }

    /// @dev 创建配对仓位
    function _createPairedPosition(
        MatchedPair calldata pair,
        uint256 longCollateral,
        uint256 shortCollateral
    ) internal returns (uint256 pairId) {
        pairId = nextPairId++;
        PairedPosition storage pos = pairedPositions[pairId];
        pos.pairId = pairId;
        pos.longTrader = pair.longOrder.trader;
        pos.shortTrader = pair.shortOrder.trader;
        pos.token = pair.longOrder.token;
        pos.size = pair.matchSize;
        pos.entryPrice = pair.matchPrice;
        pos.longCollateral = longCollateral;
        pos.shortCollateral = shortCollateral;
        pos.longLeverage = pair.longOrder.leverage;
        pos.shortLeverage = pair.shortOrder.leverage;
        pos.openTime = block.timestamp;
        pos.lastFundingSettled = block.timestamp;
        pos.status = PositionStatus.ACTIVE;
    }

    /// @dev 更新追踪数据 (pairIds, positionSizes, filledAmounts, nonces)
    function _updateTrackingData(MatchedPair calldata pair, uint256 pairId) internal {
        address longTrader = pair.longOrder.trader;
        address shortTrader = pair.shortOrder.trader;

        userPairIds[longTrader].push(pairId);
        userPairIds[shortTrader].push(pairId);
        userPositionSizes[longTrader][pair.longOrder.token] += pair.matchSize;
        userPositionSizes[shortTrader][pair.shortOrder.token] += pair.matchSize;

        bytes32 longHash = getOrderHash(pair.longOrder);
        bytes32 shortHash = getOrderHash(pair.shortOrder);
        filledAmounts[longHash] += pair.matchSize;
        filledAmounts[shortHash] += pair.matchSize;

        if (sequentialNonceMode[longTrader] && filledAmounts[longHash] >= pair.longOrder.size) nonces[longTrader]++;
        if (sequentialNonceMode[shortTrader] && filledAmounts[shortHash] >= pair.shortOrder.size) nonces[shortTrader]++;
    }

    // ============================================================
    // Position Functions
    // ============================================================

    function closePair(uint256 pairId) external nonReentrant whenNotPaused {
        PairedPosition storage pos = pairedPositions[pairId];
        if (pos.status != PositionStatus.ACTIVE) revert PositionNotActive();
        if (msg.sender != pos.longTrader && msg.sender != pos.shortTrader) revert Unauthorized();
        _closePair(pairId, tokenPrices[pos.token]);
    }

    function closePairsBatch(uint256[] calldata pairIds, uint256[] calldata exitPrices) external nonReentrant whenNotPaused {
        if (!authorizedMatchers[msg.sender]) revert Unauthorized();
        require(pairIds.length == exitPrices.length, "Length mismatch");
        for (uint256 i = 0; i < pairIds.length; i++) {
            if (pairedPositions[pairIds[i]].status == PositionStatus.ACTIVE) _closePair(pairIds[i], exitPrices[i]);
        }
    }

    function executeADL(uint256[] calldata pairIds, uint256[] calldata exitPrices) external nonReentrant whenNotPaused {
        if (!authorizedMatchers[msg.sender]) revert Unauthorized();
        require(pairIds.length == exitPrices.length, "Length mismatch");
        for (uint256 i = 0; i < pairIds.length; i++) {
            if (pairedPositions[pairIds[i]].status == PositionStatus.ACTIVE) _closePair(pairIds[i], exitPrices[i]);
        }
        // 匹配引擎已响应 ADL，重置状态
        if (adlActive) {
            adlActive = false;
            emit ADLResolved(msg.sender);
        }
    }

    /**
     * @notice P1-4: 强制 ADL — 撮合引擎未响应时的后备
     * @dev 当 ADL 被触发（保险基金耗尽）后 5 分钟，如果撮合引擎未执行 ADL，
     *      任何人可调用此函数强制平仓指定仓位。使用链上存储的最新价格。
     *      这是一个安全后备机制，确保系统不会因撮合引擎宕机而陷入僵局。
     * @param pairId 要强制平仓的配对仓位 ID
     */
    function forceADL(uint256 pairId) external nonReentrant whenNotPaused {
        if (!adlActive) revert NoActiveADL();
        if (block.timestamp < lastADLTriggerTime + ADL_TIMEOUT) revert ADLTimeoutNotReached();

        PairedPosition storage pos = pairedPositions[pairId];
        if (pos.status != PositionStatus.ACTIVE) revert PositionNotActive();

        uint256 exitPrice = tokenPrices[pos.token];
        require(exitPrice > 0, "No price available");

        _closePair(pairId, exitPrice);

        // 如果保险基金已恢复（通过 funding fee 等），可以解除 ADL 状态
        if (insuranceFund != address(0) && balances[insuranceFund].available > 0) {
            adlActive = false;
            emit ADLResolved(msg.sender);
        }

        emit ForceADLExecuted(pairId, exitPrice, msg.sender);
    }

    /**
     * @notice 由授权 matcher 或 owner 手动解除 ADL 状态
     * @dev 当 ADL 情况已通过其他方式解决时调用
     */
    function resolveADL() external {
        if (!authorizedMatchers[msg.sender] && msg.sender != owner()) revert Unauthorized();
        adlActive = false;
        emit ADLResolved(msg.sender);
    }

    function _closePair(uint256 pairId, uint256 exitPrice) internal {
        PairedPosition storage pos = pairedPositions[pairId];
        _settleFunding(pairId);
        (int256 longPnL, int256 shortPnL) = _calculatePnL(pos, exitPrice);
        longPnL -= pos.accFundingLong;
        shortPnL -= pos.accFundingShort;
        _settleProfit(pos, longPnL, shortPnL);
        _updatePositionSize(pos);
        pos.status = PositionStatus.CLOSED;
        emit PairClosed(pairId, exitPrice, longPnL, shortPnL);
    }

    function _updatePositionSize(PairedPosition storage pos) internal {
        if (userPositionSizes[pos.longTrader][pos.token] >= pos.size) userPositionSizes[pos.longTrader][pos.token] -= pos.size;
        else userPositionSizes[pos.longTrader][pos.token] = 0;
        if (userPositionSizes[pos.shortTrader][pos.token] >= pos.size) userPositionSizes[pos.shortTrader][pos.token] -= pos.size;
        else userPositionSizes[pos.shortTrader][pos.token] = 0;
    }

    function _settleProfit(PairedPosition storage pos, int256 longPnL, int256 shortPnL) internal {
        balances[pos.longTrader].locked -= pos.longCollateral;
        balances[pos.shortTrader].locked -= pos.shortCollateral;

        // 更新总锁定保证金
        totalLockedMargin -= (pos.longCollateral + pos.shortCollateral);

        if (longPnL >= 0) {
            uint256 profit = uint256(longPnL);
            uint256 transfer = profit > pos.shortCollateral ? pos.shortCollateral : profit;
            balances[pos.longTrader].available += pos.longCollateral + transfer;
            if (pos.shortCollateral > transfer) balances[pos.shortTrader].available += pos.shortCollateral - transfer;
            else if (profit > pos.shortCollateral && insuranceFund != address(0)) {
                uint256 deficit = profit - pos.shortCollateral;
                uint256 fundBal = balances[insuranceFund].available;
                if (fundBal >= deficit) { balances[insuranceFund].available -= deficit; balances[pos.longTrader].available += deficit; }
                else { if (fundBal > 0) { balances[insuranceFund].available = 0; balances[pos.longTrader].available += fundBal; deficit -= fundBal; }
                    // P1-4: 激活 ADL 超时机制
                    adlActive = true;
                    lastADLTriggerTime = block.timestamp;
                    emit ADLTriggered(pos.pairId, 0, pos.longTrader, deficit, deficit); }
            }
        } else {
            uint256 profit = uint256(shortPnL);
            uint256 transfer = profit > pos.longCollateral ? pos.longCollateral : profit;
            balances[pos.shortTrader].available += pos.shortCollateral + transfer;
            if (pos.longCollateral > transfer) balances[pos.longTrader].available += pos.longCollateral - transfer;
            else if (profit > pos.longCollateral && insuranceFund != address(0)) {
                uint256 deficit = profit - pos.longCollateral;
                uint256 fundBal = balances[insuranceFund].available;
                if (fundBal >= deficit) { balances[insuranceFund].available -= deficit; balances[pos.shortTrader].available += deficit; }
                else { if (fundBal > 0) { balances[insuranceFund].available = 0; balances[pos.shortTrader].available += fundBal; deficit -= fundBal; }
                    // P1-4: 激活 ADL 超时机制
                    adlActive = true;
                    lastADLTriggerTime = block.timestamp;
                    emit ADLTriggered(pos.pairId, 0, pos.shortTrader, deficit, deficit); }
            }
        }
    }

    // ============================================================
    // Liquidation
    // ============================================================

    function canLiquidate(uint256 pairId) public view returns (bool liquidateLong, bool liquidateShort) {
        PairedPosition storage pos = pairedPositions[pairId];
        if (pos.status != PositionStatus.ACTIVE) return (false, false);
        (int256 longPnL, int256 shortPnL) = _calculatePnL(pos, tokenPrices[pos.token]);
        uint256 mm = (pos.size * MAINTENANCE_MARGIN_RATE) / 10000;
        liquidateLong = int256(pos.longCollateral) + longPnL - pos.accFundingLong < int256(mm);
        liquidateShort = int256(pos.shortCollateral) + shortPnL - pos.accFundingShort < int256(mm);
    }

    function liquidate(uint256 pairId) external nonReentrant whenNotPaused {
        PairedPosition storage pos = pairedPositions[pairId];
        if (pos.status != PositionStatus.ACTIVE) revert PositionNotActive();
        (bool liqLong, bool liqShort) = canLiquidate(pairId);
        if (!liqLong && !liqShort) revert CannotLiquidate();

        _settleFunding(pairId);
        (int256 longPnL, int256 shortPnL) = _calculatePnL(pos, tokenPrices[pos.token]);
        longPnL -= pos.accFundingLong;
        shortPnL -= pos.accFundingShort;

        uint256 penalty;
        address liqTrader;
        if (liqLong) {
            liqTrader = pos.longTrader;
            penalty = (pos.longCollateral * 5) / 100;  // 5% 清算罚金
        } else {
            liqTrader = pos.shortTrader;
            penalty = (pos.shortCollateral * 5) / 100;
        }

        _settleProfit(pos, longPnL, shortPnL);

        // 清算罚金：一部分给清算者(激励)，一部分进保险基金
        uint256 liquidatorReward = penalty / 2;  // 50% 给清算者
        uint256 insurancePenalty = penalty - liquidatorReward;  // 50% 进保险基金

        if (penalty > 0 && balances[liqTrader].available >= penalty) {
            balances[liqTrader].available -= penalty;
            balances[msg.sender].available += liquidatorReward;  // 清算者奖励
            pendingLiquidationPenalty += insurancePenalty;  // 累计到待转保险基金
        }

        _updatePositionSize(pos);
        pos.status = PositionStatus.LIQUIDATED;
        emit Liquidated(pairId, liqTrader, msg.sender, liquidatorReward);
    }

    // ============================================================
    // Funding Rate (动态失衡模型，与 FundingRate.sol 对齐)
    // ============================================================

    // 基础费率：0.01% = 1bp = 1/10000（乘以 skew 后生效）
    uint256 public baseFundingRateBps = 1;
    uint256 public constant FUNDING_RATE_PRECISION = 10000;

    // 保险基金累计收到的资金费
    uint256 public insuranceFundFromFunding;

    /**
     * @notice 结算资金费（动态失衡模型）
     * @dev 15分钟周期，费率 = baseFundingRateBps × periods
     *      100% 进保险基金（与 FundingRate.sol 对齐）
     */
    function _settleFunding(uint256 pairId) internal {
        PairedPosition storage pos = pairedPositions[pairId];
        // C-01 fix: 使用 lastFundingSettled 而非 openTime，避免双重收费
        uint256 elapsed = block.timestamp - pos.lastFundingSettled;
        if (elapsed == 0) return;

        // 计算资金费：仓位大小 × 基础费率 × 经过的周期数
        uint256 periods = elapsed / fundingInterval;
        if (periods == 0) return;

        // 更新上次结算时间 (对齐到周期边界)
        pos.lastFundingSettled += periods * fundingInterval;

        uint256 fundingPerSide = (pos.size * baseFundingRateBps * periods) / FUNDING_RATE_PRECISION;
        if (fundingPerSide == 0) return;

        // 双方都扣（累计为正数，表示支出）
        pos.accFundingLong += int256(fundingPerSide);
        pos.accFundingShort += int256(fundingPerSide);

        // 100% 累计到保险基金（双方各扣一份）
        insuranceFundFromFunding += fundingPerSide * 2;

        emit FundingSettled(pairId, pos.accFundingLong, pos.accFundingShort);
    }

    /**
     * @notice 批量结算资金费
     */
    function settleFundingBatch(uint256[] calldata pairIds) external {
        if (!authorizedMatchers[msg.sender]) revert Unauthorized();
        for (uint256 i = 0; i < pairIds.length; i++) {
            if (pairedPositions[pairIds[i]].status == PositionStatus.ACTIVE) _settleFunding(pairIds[i]);
        }
        lastFundingTime = block.timestamp;
    }

    /**
     * @notice 将累计的资金费转移到保险基金 (内部记账)
     * @dev 只有 owner 或授权 matcher 可以调用
     */
    function transferFundingToInsurance() external {
        if (!authorizedMatchers[msg.sender] && msg.sender != owner()) revert Unauthorized();
        if (insuranceFund == address(0)) return;
        if (insuranceFundFromFunding == 0) return;

        uint256 amount = insuranceFundFromFunding;
        insuranceFundFromFunding = 0;

        // 增加保险基金余额（内部记账）
        balances[insuranceFund].available += amount;
    }

    /**
     * @notice 获取待转保险基金金额
     */
    function getPendingInsuranceAmount() external view returns (uint256 funding, uint256 penalty) {
        return (insuranceFundFromFunding, pendingLiquidationPenalty);
    }

    /**
     * @notice 获取总锁定保证金
     */
    function getTotalLockedMargin() external view returns (uint256) {
        return totalLockedMargin;
    }

    // ============================================================
    // View Functions
    // ============================================================

    function getOrderHash(Order calldata order) public view returns (bytes32) {
        return _hashTypedDataV4(_orderStructHash(order));
    }

    /// @dev EIP-712 struct hash — 分两段 abi.encode 拼接后 keccak256
    /// 等效于 keccak256(abi.encode(TYPEHASH, trader, token, isLong, size, leverage, price, deadline, nonce, orderType))
    /// 因为 abi.encode 把每个值 pad 到 32 bytes，两段拼接等价于一段。
    function _orderStructHash(Order calldata order) internal pure returns (bytes32) {
        // 第一段: TYPEHASH + 前 5 个字段 (6 个 slot)
        bytes memory a = abi.encode(
            ORDER_TYPEHASH,
            order.trader,
            order.token,
            order.isLong,
            order.size
        );
        // 第二段: 后 5 个字段 (5 个 slot)
        bytes memory b = abi.encode(
            order.leverage,
            order.price,
            order.deadline,
            order.nonce,
            order.orderType
        );
        return keccak256(bytes.concat(a, b));
    }

    function verifyOrder(Order calldata order, bytes calldata signature) public view returns (bool) {
        return getOrderHash(order).recover(signature) == order.trader;
    }

    function getUserBalance(address user) external view returns (uint256 available, uint256 locked) {
        return (balances[user].available, balances[user].locked);
    }

    function getPairedPosition(uint256 pairId) external view returns (PairedPosition memory) {
        return pairedPositions[pairId];
    }

    function getUserPairIds(address user) external view returns (uint256[] memory) {
        return userPairIds[user];
    }

    function getUnrealizedPnL(uint256 pairId) external view returns (int256 longPnL, int256 shortPnL) {
        PairedPosition storage pos = pairedPositions[pairId];
        if (pos.status != PositionStatus.ACTIVE) return (0, 0);
        (longPnL, shortPnL) = _calculatePnL(pos, tokenPrices[pos.token]);
        longPnL -= pos.accFundingLong;
        shortPnL -= pos.accFundingShort;
    }

    function getFilledAmount(bytes32 orderHash) external view returns (uint256) { return filledAmounts[orderHash]; }
    function getSupportedTokens() external view returns (address[] memory) { return supportedTokenList; }
    function isTokenSupported(address token) external view returns (bool) { return supportedTokens[token]; }
    function getTokenDecimals(address token) external view returns (uint8) { return tokenDecimals[token]; }
    function getUserPositionSize(address user, address token) external view returns (uint256) { return userPositionSizes[user][token]; }
    function getRemainingAmount(Order calldata order) external view returns (uint256) { return order.size - filledAmounts[getOrderHash(order)]; }

    // ============================================================
    // Internal Functions
    // ============================================================

    function _toStandardDecimals(address token, uint256 amount) internal view returns (uint256) {
        uint8 d = tokenDecimals[token];
        if (d == STANDARD_DECIMALS) return amount;
        if (d > STANDARD_DECIMALS) return amount / (10 ** (d - STANDARD_DECIMALS));
        return amount * (10 ** (STANDARD_DECIMALS - d));
    }

    function _fromStandardDecimals(address token, uint256 amount) internal view returns (uint256) {
        uint8 d = tokenDecimals[token];
        if (d == STANDARD_DECIMALS) return amount;
        if (d > STANDARD_DECIMALS) return amount * (10 ** (d - STANDARD_DECIMALS));
        return amount / (10 ** (STANDARD_DECIMALS - d));
    }

    function _hasLegacyPosition(address) internal pure returns (bool) {
        return false; // Legacy check disabled to reduce contract size
    }

    function _validateOrder(Order calldata order, bytes calldata sig, bool expectLong) internal view {
        if (order.isLong != expectLong) revert InvalidMatch();
        if (block.timestamp > order.deadline) revert OrderExpired();
        if (order.nonce != nonces[order.trader]) revert InvalidNonce();
        if (!verifyOrder(order, sig)) revert InvalidSignature();
        if (filledAmounts[getOrderHash(order)] >= order.size) revert OrderAlreadyUsed();
        if (order.leverage == 0 || order.leverage > MAX_LEVERAGE) revert InvalidMatch();
    }

    function _validateContractSpec(MatchedPair calldata pair) internal view {
        if (address(contractRegistry) == address(0)) return;
        IContractRegistry.ContractSpec memory spec = contractRegistry.getContractSpec(pair.longOrder.token);
        if (!spec.isActive) revert ContractNotActive();
        if (pair.matchSize < spec.minOrderSize) revert OrderSizeTooSmall();
        if (pair.matchSize > spec.maxOrderSize) revert OrderSizeTooBig();
        // Simplified: leverage and position limit checks moved to backend
    }

    function _calculatePnL(PairedPosition storage pos, uint256 currentPrice) internal view returns (int256 longPnL, int256 shortPnL) {
        if (pos.entryPrice == 0) return (0, 0);
        if (currentPrice >= pos.entryPrice) {
            uint256 diff = currentPrice - pos.entryPrice;
            uint256 profit = (pos.size > 0 && diff > type(uint256).max / pos.size) ? MAX_PNL : (pos.size * diff) / pos.entryPrice;
            if (profit > MAX_PNL) profit = MAX_PNL;
            longPnL = profit.toInt256();
            shortPnL = -longPnL;
        } else {
            uint256 diff = pos.entryPrice - currentPrice;
            uint256 loss = (pos.size > 0 && diff > type(uint256).max / pos.size) ? MAX_PNL : (pos.size * diff) / pos.entryPrice;
            if (loss > MAX_PNL) loss = MAX_PNL;
            longPnL = -loss.toInt256();
            shortPnL = loss.toInt256();
        }
    }
}
