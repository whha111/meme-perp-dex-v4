// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/IVault.sol";
import "../interfaces/IPriceFeed.sol";
import "../interfaces/IRiskManager.sol";
import "../interfaces/IFundingRate.sol";
import "../interfaces/ILiquidation.sol";
import "../interfaces/IPositionManager.sol";

/// @notice Minimal interface for TokenFactory to get creator and referrer info
interface ITokenFactoryFee {
    function getTokenCreator(address token) external view returns (address);
    function userReferrer(address user) external view returns (address);
}

/**
 * @title PositionManager
 * @notice 永续合约仓位管理合约
 * @dev 处理开仓、平仓、追加保证金、杠杆调整等功能
 *      盈亏结算：盈利从保险基金支付，亏损转入保险基金
 *      H-016: 支持多代币交易
 *      H-017: 支持全仓/逐仓保证金模式
 */
contract PositionManager is Ownable, ReentrancyGuard, IPositionManager {
    // ============================================================
    // Constants
    // ============================================================

    uint256 public constant PRECISION = 1e18;
    uint256 public constant LEVERAGE_PRECISION = 1e4; // 杠杆精度 (10000 = 1x)

    // ============================================================
    // Structs
    // ============================================================
    // Note: Position and PositionEx structs are inherited from IPositionManager
    // MarginMode enum is also inherited from IPositionManager

    // H-016: Extended Position struct with token support (internal storage)
    struct PositionInternal {
        address token;          // 代币地址
        bool isLong;            // 方向
        uint256 size;           // 仓位大小
        uint256 collateral;     // 保证金
        uint256 entryPrice;     // 开仓价格
        uint256 leverage;       // 杠杆倍数
        uint256 lastFundingTime;// 上次资金费结算时间
        int256 accFundingFee;   // 累计资金费
        MarginMode marginMode;  // H-017: 保证金模式
    }

    // Legacy Position storage struct (different from interface)
    struct PositionStorage {
        bool isLong;
        uint256 size;
        uint256 collateral;
        uint256 entryPrice;
        uint256 leverage;
        uint256 lastFundingTime;
        int256 accFundingFee;
    }

    // ============================================================
    // State Variables
    // ============================================================

    IVault public vault;
    IPriceFeed public priceFeed;
    IRiskManager public riskManager;
    IFundingRate public fundingRate;
    ILiquidation public liquidation;

    // Legacy: 用户单代币仓位（向后兼容）
    mapping(address => PositionStorage) internal _positions;

    // Legacy: 全局持仓量
    uint256 public totalLongSize;
    uint256 public totalShortSize;

    // H-016: 多代币仓位 - user => token => position
    mapping(address => mapping(address => PositionInternal)) internal tokenPositions;

    // H-016: 用户持有仓位的代币列表
    mapping(address => address[]) internal userTokens;

    // H-016: 代币全局持仓量
    mapping(address => uint256) public tokenTotalLongSize;
    mapping(address => uint256) public tokenTotalShortSize;

    // H-017: 用户全仓保证金余额
    mapping(address => uint256) public crossMarginBalances;

    // H-017: 用户默认保证金模式
    mapping(address => MarginMode) public defaultMarginMode;

    // 手续费配置 - Maker/Taker 差异化费率 (Meme 币风险补偿)
    uint256 public openFeeRate = 10;  // 0.10% Taker fee (10/10000)
    uint256 public closeFeeRate = 5;  // 0.05% Maker fee (5/10000)

    // 手续费接收地址
    address public feeReceiver;           // 平台手续费接收地址
    address public insuranceFeeReceiver;  // 保险基金手续费接收地址
    address public lpFeeReceiver;         // LP 池手续费接收地址

    // 永续手续费分配比例 (基点，10000 = 100%) — 可配置
    uint256 public perpCreatorFeeShare = 1500;     // 15% 代币创建者
    uint256 public perpReferrerFeeShare = 1000;    // 10% 推荐人
    uint256 public perpPlatformFeeShare = 5000;    // 50% 平台
    uint256 public perpInsuranceFeeShare = 1500;   // 15% 保险基金
    uint256 public perpLpFeeShare = 1000;          // 10% LP 池

    // TokenFactory 地址 (用于获取代币创建者和用户推荐人)
    address public tokenFactory;

    // 授权合约（Liquidation）
    mapping(address => bool) public authorizedContracts;

    // H-016: 默认代币地址（用于legacy函数）
    address public defaultToken;

    // 迁移模式：启用后禁止开新仓，仅允许平仓和管理现有仓位
    bool public migrationMode;

    // ============================================================
    // Events
    // ============================================================

    event PositionOpened(
        address indexed user,
        bool isLong,
        uint256 size,
        uint256 collateral,
        uint256 leverage,
        uint256 entryPrice,
        uint256 fee
    );

    event PositionClosed(
        address indexed user,
        bool isLong,
        uint256 size,
        uint256 entryPrice,
        uint256 exitPrice,
        int256 pnl,
        uint256 fee
    );

    event PositionModified(address indexed user, uint256 newCollateral, uint256 newSize, uint256 newLeverage);

    event CollateralAdded(address indexed user, uint256 amount);
    event CollateralRemoved(address indexed user, uint256 amount);

    event FeeReceiverUpdated(address indexed oldReceiver, address indexed newReceiver);
    event FeeRatesUpdated(uint256 openFee, uint256 closeFee);

    event PnLSettled(address indexed user, int256 pnl, uint256 collateral);

    // H-016: Multi-token events (simplified to avoid stack depth issues)
    event TokenPositionOpened(
        address indexed user,
        address indexed token,
        bool isLong,
        uint256 size,
        uint256 entryPrice
    );

    event TokenPositionClosed(
        address indexed user,
        address indexed token,
        uint256 closeSize,
        int256 pnl
    );

    // H-017: Cross margin events
    event CrossMarginDeposited(address indexed user, uint256 amount);
    event CrossMarginWithdrawn(address indexed user, uint256 amount);
    event DefaultMarginModeSet(address indexed user, MarginMode mode);
    event DefaultTokenSet(address indexed token);
    event MigrationModeSet(bool enabled);

    // Fee distribution events
    event PerpFeeDistributed(
        address indexed token,
        address indexed user,
        uint256 totalFee,
        uint256 toCreator,
        uint256 toReferrer,
        uint256 toPlatform,
        uint256 toInsurance,
        uint256 toLP
    );
    event TokenFactorySet(address indexed tokenFactory);
    event FeeSharesUpdated(uint256 creator, uint256 referrer, uint256 platform, uint256 insurance, uint256 lp);
    event InsuranceFeeReceiverSet(address indexed receiver);
    event LpFeeReceiverSet(address indexed receiver);

    // ============================================================
    // Errors
    // ============================================================

    error PositionNotFound();
    error PositionAlreadyExists();
    error InvalidLeverage();
    error InvalidSize();
    error InsufficientMargin();
    error InsufficientCollateral();
    error CannotRemoveCollateral();
    error Unauthorized();
    error ZeroAddress();
    error ValidationFailed(string reason);
    error TokenNotSupported();
    error InsufficientCrossMargin();
    error InvalidMarginMode();
    error MigrationModeActive();

    // ============================================================
    // Modifiers
    // ============================================================

    modifier onlyAuthorized() {
        if (!authorizedContracts[msg.sender]) revert Unauthorized();
        _;
    }

    // ============================================================
    // Constructor
    // ============================================================

    constructor(address _vault, address _priceFeed, address _riskManager) Ownable(msg.sender) {
        if (_vault == address(0) || _priceFeed == address(0) || _riskManager == address(0)) {
            revert ZeroAddress();
        }
        vault = IVault(_vault);
        priceFeed = IPriceFeed(_priceFeed);
        riskManager = IRiskManager(_riskManager);
        feeReceiver = msg.sender;
    }

    // ============================================================
    // Admin Functions
    // ============================================================

    function setFundingRate(address _fundingRate) external onlyOwner {
        if (_fundingRate == address(0)) revert ZeroAddress();
        fundingRate = IFundingRate(_fundingRate);
    }

    function setLiquidation(address _liquidation) external onlyOwner {
        if (_liquidation == address(0)) revert ZeroAddress();
        liquidation = ILiquidation(_liquidation);
    }

    function setFeeReceiver(address _feeReceiver) external onlyOwner {
        if (_feeReceiver == address(0)) revert ZeroAddress();
        emit FeeReceiverUpdated(feeReceiver, _feeReceiver);
        feeReceiver = _feeReceiver;
    }

    function setFeeRates(uint256 _openFee, uint256 _closeFee) external onlyOwner {
        require(_openFee <= 100 && _closeFee <= 100, "Fee too high"); // Max 1%
        openFeeRate = _openFee;
        closeFeeRate = _closeFee;
        emit FeeRatesUpdated(_openFee, _closeFee);
    }

    function setAuthorizedContract(address contractAddr, bool authorized) external onlyOwner {
        if (contractAddr == address(0)) revert ZeroAddress();
        authorizedContracts[contractAddr] = authorized;
    }

    // H-016: 设置默认代币
    function setDefaultToken(address token) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (!priceFeed.isTokenSupported(token)) revert TokenNotSupported();
        defaultToken = token;
        emit DefaultTokenSet(token);
    }

    /// @notice 设置迁移模式（启用后禁止开新仓）
    function setMigrationMode(bool enabled) external onlyOwner {
        migrationMode = enabled;
        emit MigrationModeSet(enabled);
    }

    /// @notice 设置 TokenFactory 地址（用于获取代币创建者和推荐人）
    function setTokenFactory(address _tokenFactory) external onlyOwner {
        if (_tokenFactory == address(0)) revert ZeroAddress();
        tokenFactory = _tokenFactory;
        emit TokenFactorySet(_tokenFactory);
    }

    /// @notice 设置保险基金手续费接收地址
    function setInsuranceFeeReceiver(address _receiver) external onlyOwner {
        if (_receiver == address(0)) revert ZeroAddress();
        insuranceFeeReceiver = _receiver;
        emit InsuranceFeeReceiverSet(_receiver);
    }

    /// @notice 设置 LP 池手续费接收地址
    function setLpFeeReceiver(address _receiver) external onlyOwner {
        if (_receiver == address(0)) revert ZeroAddress();
        lpFeeReceiver = _receiver;
        emit LpFeeReceiverSet(_receiver);
    }

    /// @notice 设置手续费分配比例（5路，总和必须 = 10000）
    function setFeeShares(
        uint256 _creator,
        uint256 _referrer,
        uint256 _platform,
        uint256 _insurance,
        uint256 _lp
    ) external onlyOwner {
        require(_creator + _referrer + _platform + _insurance + _lp == 10000, "Sum must be 10000");
        perpCreatorFeeShare = _creator;
        perpReferrerFeeShare = _referrer;
        perpPlatformFeeShare = _platform;
        perpInsuranceFeeShare = _insurance;
        perpLpFeeShare = _lp;
        emit FeeSharesUpdated(_creator, _referrer, _platform, _insurance, _lp);
    }

    // ============================================================
    // Position Functions
    // ============================================================

    function openLong(uint256 size, uint256 leverage) external nonReentrant {
        _openPosition(msg.sender, true, size, leverage);
    }

    function openShort(uint256 size, uint256 leverage) external nonReentrant {
        _openPosition(msg.sender, false, size, leverage);
    }

    function closePosition() external nonReentrant {
        _closePosition(msg.sender, 100);
    }

    function closePositionPartial(uint256 percentage) external nonReentrant {
        require(percentage > 0 && percentage <= 100, "Invalid percentage");
        _closePosition(msg.sender, percentage);
    }

    function addCollateral(uint256 amount) external nonReentrant {
        PositionStorage storage pos = _positions[msg.sender];
        if (pos.size == 0) revert PositionNotFound();

        vault.lockMargin(msg.sender, amount);

        pos.collateral += amount;
        pos.leverage = (pos.size * LEVERAGE_PRECISION) / pos.collateral;

        emit CollateralAdded(msg.sender, amount);
        emit PositionModified(msg.sender, pos.collateral, pos.size, pos.leverage);
    }

    function removeCollateral(uint256 amount) external nonReentrant {
        PositionStorage storage pos = _positions[msg.sender];
        if (pos.size == 0) revert PositionNotFound();

        uint256 newCollateral = pos.collateral - amount;
        uint256 newLeverage = (pos.size * LEVERAGE_PRECISION) / newCollateral;

        uint256 maxLeverage = riskManager.getMaxLeverage();
        if (newLeverage > maxLeverage) revert CannotRemoveCollateral();

        uint256 mmr = riskManager.getMaintenanceMarginRate(newLeverage);
        uint256 markPrice = priceFeed.getMarkPrice();
        int256 pnl = _calculatePnL(pos, markPrice);
        int256 equity = int256(newCollateral) + pnl;

        if (equity < int256((pos.size * mmr) / PRECISION)) {
            revert CannotRemoveCollateral();
        }

        pos.collateral = newCollateral;
        pos.leverage = newLeverage;

        vault.unlockMargin(msg.sender, amount);

        emit CollateralRemoved(msg.sender, amount);
        emit PositionModified(msg.sender, pos.collateral, pos.size, pos.leverage);
    }

    // ============================================================
    // H-016: Multi-token Position Functions
    // ============================================================

    function openLongToken(address token, uint256 size, uint256 leverage, MarginMode mode) external nonReentrant {
        _openPositionToken(msg.sender, token, true, size, leverage, mode);
    }

    function openShortToken(address token, uint256 size, uint256 leverage, MarginMode mode) external nonReentrant {
        _openPositionToken(msg.sender, token, false, size, leverage, mode);
    }

    function closePositionToken(address token) external nonReentrant {
        _closePositionToken(msg.sender, token, 100);
    }

    function closePositionPartialToken(address token, uint256 percentage) external nonReentrant {
        require(percentage > 0 && percentage <= 100, "Invalid percentage");
        _closePositionToken(msg.sender, token, percentage);
    }

    function addCollateralToken(address token, uint256 amount) external nonReentrant {
        PositionInternal storage pos = tokenPositions[msg.sender][token];
        if (pos.size == 0) revert PositionNotFound();

        if (pos.marginMode == MarginMode.CROSS) {
            // 全仓模式：添加到全仓余额
            vault.lockMargin(msg.sender, amount);
            crossMarginBalances[msg.sender] += amount;
            emit CrossMarginDeposited(msg.sender, amount);
        } else {
            // 逐仓模式：添加到仓位保证金
            vault.lockMargin(msg.sender, amount);
            pos.collateral += amount;
            pos.leverage = (pos.size * LEVERAGE_PRECISION) / pos.collateral;
            emit CollateralAdded(msg.sender, amount);
        }
    }

    function removeCollateralToken(address token, uint256 amount) external nonReentrant {
        PositionInternal storage pos = tokenPositions[msg.sender][token];
        if (pos.size == 0) revert PositionNotFound();

        if (pos.marginMode == MarginMode.CROSS) {
            // 全仓模式：从全仓余额移除
            if (crossMarginBalances[msg.sender] < amount) revert InsufficientCrossMargin();

            // 检查移除后是否仍有足够保证金
            int256 equity = getCrossMarginEquity(msg.sender);
            if (equity - int256(amount) < _getCrossMarginRequirement(msg.sender)) {
                revert CannotRemoveCollateral();
            }

            crossMarginBalances[msg.sender] -= amount;
            vault.unlockMargin(msg.sender, amount);
            emit CrossMarginWithdrawn(msg.sender, amount);
        } else {
            // 逐仓模式
            uint256 newCollateral = pos.collateral - amount;
            uint256 newLeverage = (pos.size * LEVERAGE_PRECISION) / newCollateral;

            uint256 maxLeverage = riskManager.getMaxLeverage();
            if (newLeverage > maxLeverage) revert CannotRemoveCollateral();

            uint256 mmr = riskManager.getMaintenanceMarginRate(newLeverage);
            uint256 markPrice = priceFeed.getTokenMarkPrice(token);
            int256 pnl = _calculatePnLToken(pos, markPrice);
            int256 posEquity = int256(newCollateral) + pnl;

            if (posEquity < int256((pos.size * mmr) / PRECISION)) {
                revert CannotRemoveCollateral();
            }

            pos.collateral = newCollateral;
            pos.leverage = newLeverage;
            vault.unlockMargin(msg.sender, amount);
            emit CollateralRemoved(msg.sender, amount);
        }
    }

    // H-017: 设置用户默认保证金模式
    function setDefaultMarginMode(MarginMode mode) external {
        defaultMarginMode[msg.sender] = mode;
        emit DefaultMarginModeSet(msg.sender, mode);
    }

    /**
     * @notice 从全仓余额提取资金到 Vault
     * @param amount 提取金额
     */
    function withdrawCrossMargin(uint256 amount) external nonReentrant {
        require(amount > 0, "Amount must be > 0");
        require(crossMarginBalances[msg.sender] >= amount, "Insufficient cross margin balance");

        // 检查是否有活跃仓位需要保留保证金
        uint256 requiredMargin = _calculateRequiredCrossMargin(msg.sender);
        require(crossMarginBalances[msg.sender] - amount >= requiredMargin, "Would leave insufficient margin for positions");

        crossMarginBalances[msg.sender] -= amount;
        vault.unlockMargin(msg.sender, amount);

        emit CrossMarginWithdrawn(msg.sender, amount);
    }

    /**
     * @notice 计算用户全仓仓位所需的最低保证金
     */
    function _calculateRequiredCrossMargin(address user) internal view returns (uint256) {
        uint256 totalRequired = 0;
        address[] storage tokens = userTokens[user];

        for (uint256 i = 0; i < tokens.length; i++) {
            PositionInternal storage pos = tokenPositions[user][tokens[i]];
            if (pos.size > 0 && pos.marginMode == MarginMode.CROSS) {
                // 维持保证金要求：仓位大小 * 维持保证金率 (0.5%)
                totalRequired += (pos.size * 50) / 10000;
            }
        }
        return totalRequired;
    }

    /**
     * @notice Owner 设置用户全仓余额 (用于合约升级迁移)
     * @param user 用户地址
     * @param amount 金额
     */
    function setCrossMarginBalance(address user, uint256 amount) external onlyOwner {
        crossMarginBalances[user] = amount;
        emit CrossMarginDeposited(user, amount);
    }

    /**
     * @notice Owner 救援用户资金 - 解锁 Vault 中的锁定余额
     * @param user 用户地址
     * @param amount 解锁金额
     */
    function rescueUnlockMargin(address user, uint256 amount) external onlyOwner {
        vault.unlockMargin(user, amount);
    }

    /**
     * @notice Owner 救援用户资金 - 调用 settleProfit 增加用户余额
     * @param user 用户地址
     * @param collateral 解锁的保证金
     * @param profit 盈利金额
     */
    function rescueSettleProfit(address user, uint256 collateral, uint256 profit) external onlyOwner {
        vault.settleProfit(user, collateral, profit);
    }

    // ============================================================
    // Liquidation Functions (仅授权合约)
    // ============================================================

    function forceClose(address user) external onlyAuthorized {
        _closePosition(user, 100);
    }

    /**
     * @notice ADL 强制减仓（仅授权合约）
     * @param user 用户地址
     * @param percentage 减仓比例 (1-100)
     */
    function forceReduce(address user, uint256 percentage) external onlyAuthorized {
        require(percentage > 0 && percentage <= 100, "Invalid percentage");
        _closePosition(user, percentage);
    }

    // H-016: 多代币强制平仓
    function forceCloseToken(address user, address token) external onlyAuthorized {
        _closePositionToken(user, token, 100);
    }

    // H-016: 多代币强制减仓
    function forceReduceToken(address user, address token, uint256 percentage) external onlyAuthorized {
        require(percentage > 0 && percentage <= 100, "Invalid percentage");
        _closePositionToken(user, token, percentage);
    }

    // ============================================================
    // View Functions
    // ============================================================

    function getPosition(address user) external view returns (Position memory) {
        PositionStorage storage pos = _positions[user];
        return Position({
            isLong: pos.isLong,
            size: pos.size,
            collateral: pos.collateral,
            entryPrice: pos.entryPrice,
            leverage: pos.leverage,
            lastFundingTime: pos.lastFundingTime,
            accFundingFee: pos.accFundingFee
        });
    }

    function getUnrealizedPnL(address user) external view returns (int256) {
        PositionStorage storage pos = _positions[user];
        if (pos.size == 0) return 0;

        uint256 markPrice = priceFeed.getMarkPrice();
        return _calculatePnL(pos, markPrice);
    }

    function getMarginRatio(address user) external view returns (uint256) {
        PositionStorage storage pos = _positions[user];
        if (pos.size == 0) return type(uint256).max;

        uint256 markPrice = priceFeed.getMarkPrice();
        int256 pnl = _calculatePnL(pos, markPrice);
        int256 equity = int256(pos.collateral) + pnl;

        if (equity <= 0) return 0;
        return (uint256(equity) * PRECISION) / pos.size;
    }

    /**
     * @notice 获取强平价格
     * @dev 按 Bybit 行业标准公式计算:
     *      多头: liqPrice = entryPrice * (1 - 1/leverage + MMR)
     *      空头: liqPrice = entryPrice * (1 + 1/leverage - MMR)
     *      来源: https://www.bybit.com/en/help-center/article/Liquidation-Price-USDT-Contract/
     */
    function getLiquidationPrice(address user) external view returns (uint256) {
        PositionStorage storage pos = _positions[user];
        if (pos.size == 0) return 0;
        if (pos.entryPrice == 0) return 0;

        // leverage 存储为 实际杠杆 * LEVERAGE_PRECISION (e.g., 10x = 100000)
        // MMR 存储为 比率 * PRECISION (e.g., 0.5% = 0.005 * 1e18)
        uint256 mmr = riskManager.getMaintenanceMarginRate(pos.leverage);

        // 1/leverage = LEVERAGE_PRECISION / leverage
        // 转换为 PRECISION 精度: (PRECISION * LEVERAGE_PRECISION) / leverage
        uint256 inverseLeveage = (PRECISION * LEVERAGE_PRECISION) / pos.leverage;

        if (pos.isLong) {
            // 多头: liqPrice = entryPrice * (1 - 1/leverage + MMR)
            // = entryPrice * (PRECISION - inverseLeveage + mmr) / PRECISION
            uint256 factor = PRECISION - inverseLeveage + mmr;
            // 如果 factor >= PRECISION，强平价格为0（不会被清算）
            if (factor >= PRECISION) return 0;
            return (pos.entryPrice * factor) / PRECISION;
        } else {
            // 空头: liqPrice = entryPrice * (1 + 1/leverage - MMR)
            // = entryPrice * (PRECISION + inverseLeveage - mmr) / PRECISION
            // 注意：如果 mmr > inverseLeveage，结果可能 < 1，这是正常的（高杠杆低MMR）
            uint256 factor;
            if (mmr >= inverseLeveage) {
                factor = PRECISION + inverseLeveage - mmr;
            } else {
                factor = PRECISION + inverseLeveage - mmr;
            }
            return (pos.entryPrice * factor) / PRECISION;
        }
    }

    function canLiquidate(address user) external view returns (bool) {
        PositionStorage storage pos = _positions[user];
        if (pos.size == 0) return false;

        uint256 markPrice = priceFeed.getMarkPrice();
        int256 pnl = _calculatePnL(pos, markPrice);
        int256 equity = int256(pos.collateral) + pnl;

        if (equity <= 0) return true;

        uint256 mmr = riskManager.getMaintenanceMarginRate(pos.leverage);
        uint256 requiredMargin = (pos.size * mmr) / PRECISION;

        return uint256(equity) < requiredMargin;
    }

    function getTotalLongSize() external view returns (uint256) {
        return totalLongSize;
    }

    function getTotalShortSize() external view returns (uint256) {
        return totalShortSize;
    }

    function canOpenPosition(address user, bool isLong, uint256 size, uint256 leverage)
        external
        view
        returns (bool isValid, string memory reason)
    {
        return riskManager.validateOpenPosition(user, isLong, size, leverage);
    }

    // ============================================================
    // H-016: Multi-token View Functions
    // ============================================================

    function getPositionByToken(address user, address token) external view returns (PositionEx memory) {
        PositionInternal storage pos = tokenPositions[user][token];
        return PositionEx({
            token: pos.token,
            isLong: pos.isLong,
            size: pos.size,
            collateral: pos.collateral,
            entryPrice: pos.entryPrice,
            leverage: pos.leverage,
            lastFundingTime: pos.lastFundingTime,
            accFundingFee: pos.accFundingFee,
            marginMode: pos.marginMode
        });
    }

    function getUserTokens(address user) external view returns (address[] memory) {
        return userTokens[user];
    }

    function getTokenTotalLongSize(address token) external view returns (uint256) {
        return tokenTotalLongSize[token];
    }

    function getTokenTotalShortSize(address token) external view returns (uint256) {
        return tokenTotalShortSize[token];
    }

    function canLiquidateToken(address user, address token) external view returns (bool) {
        PositionInternal storage pos = tokenPositions[user][token];
        if (pos.size == 0) return false;

        uint256 markPrice = priceFeed.getTokenMarkPrice(token);
        int256 pnl = _calculatePnLToken(pos, markPrice);

        if (pos.marginMode == MarginMode.CROSS) {
            // 全仓模式：检查全仓权益
            int256 equity = getCrossMarginEquity(user);
            if (equity <= 0) return true;
            int256 required = _getCrossMarginRequirement(user);
            return equity < required;
        } else {
            // 逐仓模式：检查单仓位权益
            int256 equity = int256(pos.collateral) + pnl;
            if (equity <= 0) return true;
            uint256 mmr = riskManager.getMaintenanceMarginRate(pos.leverage);
            uint256 requiredMargin = (pos.size * mmr) / PRECISION;
            return uint256(equity) < requiredMargin;
        }
    }

    /**
     * @notice H-016: 获取代币仓位的未实现盈亏
     * @dev 使用 GMX 标准公式: delta = size * priceDelta / averagePrice
     * @param user 用户地址
     * @param token 代币地址
     * @return pnl 未实现盈亏（正数盈利，负数亏损）
     */
    function getTokenUnrealizedPnL(address user, address token) external view returns (int256) {
        PositionInternal storage pos = tokenPositions[user][token];
        if (pos.size == 0) return 0;

        uint256 markPrice = priceFeed.getTokenMarkPrice(token);
        return _calculatePnLToken(pos, markPrice);
    }

    /**
     * @notice H-016: 获取代币仓位的强平价格
     * @dev 使用 Bybit 标准公式:
     *      多头: liqPrice = entryPrice * (1 - 1/leverage + MMR)
     *      空头: liqPrice = entryPrice * (1 + 1/leverage - MMR)
     * @param user 用户地址
     * @param token 代币地址
     * @return 强平价格
     */
    function getTokenLiquidationPrice(address user, address token) external view returns (uint256) {
        PositionInternal storage pos = tokenPositions[user][token];
        if (pos.size == 0) return 0;
        if (pos.entryPrice == 0) return 0;

        // leverage 存储为 实际杠杆 * LEVERAGE_PRECISION (e.g., 10x = 100000)
        // MMR 存储为 比率 * PRECISION (e.g., 0.5% = 0.005 * 1e18)
        uint256 mmr = riskManager.getMaintenanceMarginRate(pos.leverage);

        // 1/leverage = LEVERAGE_PRECISION / leverage
        // 转换为 PRECISION 精度: (PRECISION * LEVERAGE_PRECISION) / leverage
        uint256 inverseLeverage = (PRECISION * LEVERAGE_PRECISION) / pos.leverage;

        if (pos.isLong) {
            // 多头: liqPrice = entryPrice * (1 - 1/leverage + MMR)
            uint256 factor = PRECISION - inverseLeverage + mmr;
            if (factor >= PRECISION) return 0;
            return (pos.entryPrice * factor) / PRECISION;
        } else {
            // 空头: liqPrice = entryPrice * (1 + 1/leverage - MMR)
            uint256 factor = PRECISION + inverseLeverage - mmr;
            return (pos.entryPrice * factor) / PRECISION;
        }
    }

    /**
     * @notice F-06: 获取代币仓位的保证金率
     * @dev 保证金率 = (保证金 + 未实现盈亏) / 仓位价值 * 100%
     * @param user 用户地址
     * @param token 代币地址
     * @return 保证金率（以 PRECISION 为基准，1e18 = 100%）
     */
    function getTokenMarginRatio(address user, address token) external view returns (uint256) {
        PositionInternal storage pos = tokenPositions[user][token];
        if (pos.size == 0) return type(uint256).max;

        uint256 markPrice = priceFeed.getTokenMarkPrice(token);
        int256 pnl = _calculatePnLToken(pos, markPrice);
        int256 equity = int256(pos.collateral) + pnl;

        if (equity <= 0) return 0;
        return (uint256(equity) * PRECISION) / pos.size;
    }

    // H-017: Cross Margin View Functions
    function getCrossMarginBalance(address user) external view returns (uint256) {
        return crossMarginBalances[user];
    }

    function getCrossMarginEquity(address user) public view returns (int256) {
        int256 equity = int256(crossMarginBalances[user]);

        // 遍历用户所有全仓仓位计算总权益
        address[] storage tokens = userTokens[user];
        for (uint256 i = 0; i < tokens.length; i++) {
            PositionInternal storage pos = tokenPositions[user][tokens[i]];
            if (pos.size > 0 && pos.marginMode == MarginMode.CROSS) {
                uint256 markPrice = priceFeed.getTokenMarkPrice(tokens[i]);
                int256 pnl = _calculatePnLToken(pos, markPrice);
                equity += pnl;
                // 加上逐仓锁定的保证金（全仓模式下仓位也有初始保证金）
                equity += int256(pos.collateral);
            }
        }

        return equity;
    }

    // ============================================================
    // Internal Functions
    // ============================================================

    function _openPosition(address user, bool isLong, uint256 size, uint256 leverage) internal {
        if (migrationMode) revert MigrationModeActive();

        PositionStorage storage pos = _positions[user];
        if (pos.size > 0) revert PositionAlreadyExists();

        (bool isValid, string memory reason) = riskManager.validateOpenPosition(user, isLong, size, leverage);
        if (!isValid) revert ValidationFailed(reason);

        uint256 collateral = (size * LEVERAGE_PRECISION) / leverage;
        uint256 fee = (size * openFeeRate) / 10000;
        uint256 totalRequired = collateral + fee;

        if (vault.getBalance(user) < totalRequired) revert InsufficientMargin();

        // 先收取开仓手续费 (使用新的分配逻辑)
        if (fee > 0) {
            // Legacy 仓位使用 defaultToken
            address token = defaultToken != address(0) ? defaultToken : address(1);
            _distributePerpFee(user, token, fee);
        }

        // 然后锁定保证金
        vault.lockMargin(user, collateral);

        uint256 entryPrice = priceFeed.getMarkPrice();

        pos.isLong = isLong;
        pos.size = size;
        pos.collateral = collateral;
        pos.entryPrice = entryPrice;
        pos.leverage = leverage;
        pos.lastFundingTime = block.timestamp;
        pos.accFundingFee = 0;

        if (isLong) {
            totalLongSize += size;
        } else {
            totalShortSize += size;
        }

        // [C-04 修复] 初始化用户的 funding index（开仓时调用一次，返回值为0）
        if (address(fundingRate) != address(0)) {
            fundingRate.settleUserFunding(user);
        }

        // Add user to ADL queue for tracking
        if (address(liquidation) != address(0)) {
            liquidation.addToADLQueue(user);
        }

        emit PositionOpened(user, isLong, size, collateral, leverage, entryPrice, fee);
    }

    function _closePosition(address user, uint256 percentage) internal {
        PositionStorage storage pos = _positions[user];
        if (pos.size == 0) revert PositionNotFound();

        // 结算资金费
        if (address(fundingRate) != address(0)) {
            int256 funding = fundingRate.settleUserFunding(user);
            pos.accFundingFee += funding;
        }

        uint256 exitPrice = priceFeed.getMarkPrice();
        uint256 closeSize = (pos.size * percentage) / 100;
        uint256 closeCollateral = (pos.collateral * percentage) / 100;

        // M-003: Calculate PnL directly for closeSize to avoid precision loss
        int256 pnl = _calculatePnLForSize(pos.isLong, closeSize, pos.entryPrice, exitPrice);

        // 加上资金费影响 (按比例计算)
        int256 closeFunding = (pos.accFundingFee * int256(percentage)) / 100;
        pnl -= closeFunding;

        // 计算平仓手续费
        uint256 fee = (closeSize * closeFeeRate) / 10000;

        // 更新全局持仓
        if (pos.isLong) {
            totalLongSize -= closeSize;
        } else {
            totalShortSize -= closeSize;
        }

        // 保存仓位信息用于事件
        bool wasLong = pos.isLong;
        uint256 entryPrice = pos.entryPrice;

        if (percentage == 100) {
            delete _positions[user];
            // Remove user from ADL queue when position is fully closed
            if (address(liquidation) != address(0)) {
                liquidation.removeFromADLQueue(user);
            }
        } else {
            pos.size -= closeSize;
            pos.collateral -= closeCollateral;
            pos.accFundingFee = (pos.accFundingFee * int256(100 - percentage)) / 100;
        }

        // ============================================================
        // 核心：盈亏结算
        // ============================================================
        // Legacy 仓位使用 defaultToken
        address token = defaultToken != address(0) ? defaultToken : address(1);
        _settlePnL(user, token, closeCollateral, pnl, fee);

        emit PositionClosed(user, wasLong, closeSize, entryPrice, exitPrice, pnl, fee);
        emit PnLSettled(user, pnl, closeCollateral);
    }

    /**
     * @notice 结算盈亏
     * @dev 盈利从保险基金支付，亏损转入保险基金
     *      平仓手续费从锁定保证金中收取，按比例分配给创建者/推荐人/平台
     */
    function _settlePnL(address user, address token, uint256 collateral, int256 pnl, uint256 fee) internal {
        // 先从锁定保证金收取平仓手续费 (使用新的分配逻辑)
        if (fee > 0) {
            // 确保手续费不超过保证金
            uint256 actualFee = fee > collateral ? collateral : fee;
            _distributePerpFeeFromLocked(user, token, actualFee);
            collateral -= actualFee;
        }

        if (pnl >= 0) {
            // 盈利：解锁保证金 + 从保险基金支付盈利
            vault.settleProfit(user, collateral, uint256(pnl));
        } else {
            uint256 loss = uint256(-pnl);

            if (loss <= collateral) {
                // 正常亏损：从保证金扣除，剩余返还
                vault.settleLoss(user, collateral, loss);
            } else {
                // 穿仓：保证金全部损失 + 保险基金覆盖亏空
                uint256 deficit = loss - collateral;
                vault.settleBankruptcy(user, collateral, deficit);
            }
        }
    }

    function _calculatePnL(PositionStorage storage pos, uint256 currentPrice) internal view returns (int256) {
        return _calculatePnLForSize(pos.isLong, pos.size, pos.entryPrice, currentPrice);
    }

    // M-003: Calculate PnL for a specific size to avoid precision loss in partial closes
    function _calculatePnLForSize(
        bool isLong,
        uint256 size,
        uint256 entryPrice,
        uint256 currentPrice
    ) internal pure returns (int256) {
        if (entryPrice == 0) return 0;

        if (isLong) {
            if (currentPrice >= entryPrice) {
                return int256((size * (currentPrice - entryPrice)) / entryPrice);
            } else {
                return -int256((size * (entryPrice - currentPrice)) / entryPrice);
            }
        } else {
            if (currentPrice <= entryPrice) {
                return int256((size * (entryPrice - currentPrice)) / entryPrice);
            } else {
                return -int256((size * (currentPrice - entryPrice)) / entryPrice);
            }
        }
    }

    // ============================================================
    // H-016: Multi-token Internal Functions
    // ============================================================

    function _openPositionToken(
        address user,
        address token,
        bool isLong,
        uint256 size,
        uint256 leverage,
        MarginMode mode
    ) internal {
        if (migrationMode) revert MigrationModeActive();

        // 验证代币支持
        if (!priceFeed.isTokenSupported(token)) revert TokenNotSupported();

        PositionInternal storage pos = tokenPositions[user][token];
        if (pos.size > 0) revert PositionAlreadyExists();

        _validateAndProcessMargin(user, token, isLong, size, leverage, mode);

        uint256 collateral = (size * LEVERAGE_PRECISION) / leverage;
        uint256 entryPrice = priceFeed.getTokenMarkPrice(token);

        _setPositionToken(pos, token, isLong, size, collateral, entryPrice, leverage, mode);

        // 添加到用户代币列表
        _addUserToken(user, token);

        // 更新全局持仓
        if (isLong) {
            tokenTotalLongSize[token] += size;
        } else {
            tokenTotalShortSize[token] += size;
        }

        // Add user to ADL queue for tracking
        if (address(liquidation) != address(0)) {
            liquidation.addToADLQueue(user);
        }

        emit TokenPositionOpened(user, token, isLong, size, entryPrice);
    }

    function _validateAndProcessMargin(
        address user,
        address token,
        bool isLong,
        uint256 size,
        uint256 leverage,
        MarginMode mode
    ) internal {
        (bool isValid, string memory reason) = riskManager.validateOpenPosition(user, isLong, size, leverage);
        if (!isValid) revert ValidationFailed(reason);

        uint256 collateral = (size * LEVERAGE_PRECISION) / leverage;
        uint256 fee = (size * openFeeRate) / 10000;
        uint256 totalRequired = collateral + fee;

        if (mode == MarginMode.CROSS) {
            _processCrossMargin(user, token, totalRequired);
        } else {
            _processIsolatedMargin(user, token, collateral, fee);
        }
    }

    /**
     * @notice 处理全仓保证金
     * @dev 修复版本：始终通过 Vault 锁定保证金，确保有真实 ETH 支持
     *      crossMarginBalances 仅作为记账辅助，不作为实际资金来源
     * @param user 用户地址
     * @param token 代币地址
     * @param totalRequired 所需总金额（保证金 + 手续费）
     */
    function _processCrossMargin(address user, address token, uint256 totalRequired) internal {
        // 计算保证金和手续费
        uint256 collateral = totalRequired; // 这里 totalRequired = collateral + fee

        // 检查用户在 Vault 中的可用余额
        uint256 availableBalance = vault.getBalance(user);
        if (availableBalance < totalRequired) revert InsufficientMargin();

        // 收取开仓手续费 (使用新的分配逻辑)
        uint256 fee = (totalRequired * openFeeRate) / (10000 + openFeeRate); // 反算手续费
        if (fee > 0) {
            _distributePerpFee(user, token, fee);
            collateral = totalRequired - fee;
        }

        // 锁定保证金到 Vault
        vault.lockMargin(user, collateral);
    }

    function _processIsolatedMargin(address user, address token, uint256 collateral, uint256 fee) internal {
        if (vault.getBalance(user) < collateral + fee) revert InsufficientMargin();
        if (fee > 0) {
            _distributePerpFee(user, token, fee);
        }
        vault.lockMargin(user, collateral);
    }

    function _setPositionToken(
        PositionInternal storage pos,
        address token,
        bool isLong,
        uint256 size,
        uint256 collateral,
        uint256 entryPrice,
        uint256 leverage,
        MarginMode mode
    ) internal {
        pos.token = token;
        pos.isLong = isLong;
        pos.size = size;
        pos.collateral = collateral;
        pos.entryPrice = entryPrice;
        pos.leverage = leverage;
        pos.lastFundingTime = block.timestamp;
        pos.accFundingFee = 0;
        pos.marginMode = mode;
    }

    function _closePositionToken(address user, address token, uint256 percentage) internal {
        PositionInternal storage pos = tokenPositions[user][token];
        if (pos.size == 0) revert PositionNotFound();

        (uint256 closeSize, uint256 closeCollateral, int256 pnl, uint256 fee) =
            _calculateCloseAmountsToken(pos, token, percentage);

        // 更新全局持仓
        if (pos.isLong) {
            tokenTotalLongSize[token] -= closeSize;
        } else {
            tokenTotalShortSize[token] -= closeSize;
        }

        MarginMode marginMode = pos.marginMode;

        if (percentage == 100) {
            delete tokenPositions[user][token];
            _removeUserToken(user, token);
            if (_getUserActivePositionCount(user) == 0 && address(liquidation) != address(0)) {
                liquidation.removeFromADLQueue(user);
            }
        } else {
            pos.size -= closeSize;
            pos.collateral -= closeCollateral;
            pos.accFundingFee = (pos.accFundingFee * int256(100 - percentage)) / 100;
        }

        // 根据保证金模式结算
        if (marginMode == MarginMode.CROSS) {
            _settlePnLCross(user, token, closeCollateral, pnl, fee);
        } else {
            _settlePnL(user, token, closeCollateral, pnl, fee);
        }

        emit TokenPositionClosed(user, token, closeSize, pnl);
        emit PnLSettled(user, pnl, closeCollateral);
    }

    // M-003: Fixed precision calculation for partial closes
    function _calculateCloseAmountsToken(
        PositionInternal storage pos,
        address token,
        uint256 percentage
    ) internal view returns (uint256 closeSize, uint256 closeCollateral, int256 pnl, uint256 fee) {
        uint256 exitPrice = priceFeed.getTokenMarkPrice(token);
        closeSize = (pos.size * percentage) / 100;
        closeCollateral = (pos.collateral * percentage) / 100;

        // Calculate PnL directly for closeSize to avoid precision loss
        pnl = _calculatePnLForSize(pos.isLong, closeSize, pos.entryPrice, exitPrice);
        pnl -= (pos.accFundingFee * int256(percentage)) / 100;

        fee = (closeSize * closeFeeRate) / 10000;
    }

    function _calculatePnLToken(PositionInternal storage pos, uint256 currentPrice) internal view returns (int256) {
        return _calculatePnLForSize(pos.isLong, pos.size, pos.entryPrice, currentPrice);
    }

    /**
     * @notice H-017: 全仓模式盈亏结算
     * @dev 修复版本：通过 Vault 进行实际 ETH 结算，确保盈亏有真实资金流动
     *      盈利从保险基金支付，亏损转入保险基金
     *      平仓手续费按比例分配给创建者/推荐人/平台
     * @param user 用户地址
     * @param token 代币地址
     * @param collateral 平仓的保证金金额
     * @param pnl 盈亏（正数盈利，负数亏损）
     * @param fee 平仓手续费
     */
    function _settlePnLCross(address user, address token, uint256 collateral, int256 pnl, uint256 fee) internal {
        // 先从锁定保证金收取平仓手续费 (使用新的分配逻辑)
        if (fee > 0) {
            // 确保手续费不超过保证金
            uint256 actualFee = fee > collateral ? collateral : fee;
            _distributePerpFeeFromLocked(user, token, actualFee);
            collateral -= actualFee;
        }

        if (pnl >= 0) {
            // 盈利：解锁保证金 + 从保险基金支付盈利
            // vault.settleProfit 会：
            // 1. 将 collateral 从 lockedBalances 转移到 balances
            // 2. 调用 InsuranceFund.payProfit() 支付盈利给用户
            vault.settleProfit(user, collateral, uint256(pnl));
        } else {
            uint256 loss = uint256(-pnl);

            if (loss <= collateral) {
                // 正常亏损：从保证金扣除，剩余返还
                // vault.settleLoss 会：
                // 1. 扣除亏损金额
                // 2. 将剩余保证金转移到用户可用余额
                // 3. 将亏损金额发送到保险基金
                vault.settleLoss(user, collateral, loss);
            } else {
                // 穿仓：保证金全部损失 + 保险基金覆盖亏空
                uint256 deficit = loss - collateral;
                vault.settleBankruptcy(user, collateral, deficit);
            }
        }
    }

    // H-017: 计算用户全仓保证金需求
    function _getCrossMarginRequirement(address user) internal view returns (int256) {
        int256 totalRequired = 0;

        address[] storage tokens = userTokens[user];
        for (uint256 i = 0; i < tokens.length; i++) {
            PositionInternal storage pos = tokenPositions[user][tokens[i]];
            if (pos.size > 0 && pos.marginMode == MarginMode.CROSS) {
                uint256 mmr = riskManager.getMaintenanceMarginRate(pos.leverage);
                totalRequired += int256((pos.size * mmr) / PRECISION);
            }
        }

        return totalRequired;
    }

    // Helper: 添加用户代币
    function _addUserToken(address user, address token) internal {
        address[] storage tokens = userTokens[user];
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] == token) return; // 已存在
        }
        tokens.push(token);
    }

    // Helper: 移除用户代币
    function _removeUserToken(address user, address token) internal {
        address[] storage tokens = userTokens[user];
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] == token) {
                tokens[i] = tokens[tokens.length - 1];
                tokens.pop();
                return;
            }
        }
    }

    // Helper: 获取用户活跃仓位数量
    function _getUserActivePositionCount(address user) internal view returns (uint256) {
        uint256 count = 0;

        // Legacy position
        if (_positions[user].size > 0) count++;

        // Multi-token positions
        address[] storage tokens = userTokens[user];
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokenPositions[user][tokens[i]].size > 0) count++;
        }

        return count;
    }

    // ============================================================
    // Fee Distribution Functions
    // ============================================================

    /**
     * @notice 分配永续开仓手续费 (从用户可用余额)
     * @dev 5路分配: creator/referrer/platform/insurance/LP
     *      无效接收方的份额回流到平台
     * @param user 用户地址
     * @param token 代币地址
     * @param fee 总手续费
     */
    function _distributePerpFee(address user, address token, uint256 fee) internal {
        if (fee == 0) return;

        address creator;
        address referrer;

        // 从 TokenFactory 获取创建者和推荐人
        if (tokenFactory != address(0)) {
            try ITokenFactoryFee(tokenFactory).getTokenCreator(token) returns (address _creator) {
                creator = _creator;
            } catch {}
            try ITokenFactoryFee(tokenFactory).userReferrer(user) returns (address _referrer) {
                referrer = _referrer;
            } catch {}
        }

        // 计算分配金额
        uint256 toCreator = (fee * perpCreatorFeeShare) / 10000;
        uint256 toReferrer = (fee * perpReferrerFeeShare) / 10000;
        uint256 toInsurance = (fee * perpInsuranceFeeShare) / 10000;
        uint256 toLP = (fee * perpLpFeeShare) / 10000;
        uint256 toPlatform = fee - toCreator - toReferrer - toInsurance - toLP;

        // 分配给创建者（无效则回流平台）
        if (toCreator > 0 && creator != address(0)) {
            vault.collectFee(user, creator, toCreator);
        } else {
            toPlatform += toCreator;
            toCreator = 0;
        }

        // 分配给推荐人（无效则回流平台）
        if (toReferrer > 0 && referrer != address(0)) {
            vault.collectFee(user, referrer, toReferrer);
        } else {
            toPlatform += toReferrer;
            toReferrer = 0;
        }

        // 分配给保险基金
        if (toInsurance > 0 && insuranceFeeReceiver != address(0)) {
            vault.collectFee(user, insuranceFeeReceiver, toInsurance);
        } else {
            toPlatform += toInsurance;
            toInsurance = 0;
        }

        // 分配给 LP 池
        if (toLP > 0 && lpFeeReceiver != address(0)) {
            vault.collectFee(user, lpFeeReceiver, toLP);
        } else {
            toPlatform += toLP;
            toLP = 0;
        }

        // 分配给平台
        if (toPlatform > 0 && feeReceiver != address(0)) {
            vault.collectFee(user, feeReceiver, toPlatform);
        }

        emit PerpFeeDistributed(token, user, fee, toCreator, toReferrer, toPlatform, toInsurance, toLP);
    }

    /**
     * @notice 分配永续平仓手续费 (从用户锁定余额)
     * @dev 5路分配: creator/referrer/platform/insurance/LP
     *      无效接收方的份额回流到平台
     * @param user 用户地址
     * @param token 代币地址
     * @param fee 总手续费
     */
    function _distributePerpFeeFromLocked(address user, address token, uint256 fee) internal {
        if (fee == 0) return;

        address creator;
        address referrer;

        // 从 TokenFactory 获取创建者和推荐人
        if (tokenFactory != address(0)) {
            try ITokenFactoryFee(tokenFactory).getTokenCreator(token) returns (address _creator) {
                creator = _creator;
            } catch {}
            try ITokenFactoryFee(tokenFactory).userReferrer(user) returns (address _referrer) {
                referrer = _referrer;
            } catch {}
        }

        // 计算分配金额
        uint256 toCreator = (fee * perpCreatorFeeShare) / 10000;
        uint256 toReferrer = (fee * perpReferrerFeeShare) / 10000;
        uint256 toInsurance = (fee * perpInsuranceFeeShare) / 10000;
        uint256 toLP = (fee * perpLpFeeShare) / 10000;
        uint256 toPlatform = fee - toCreator - toReferrer - toInsurance - toLP;

        // 分配给创建者（无效则回流平台）
        if (toCreator > 0 && creator != address(0)) {
            vault.collectFeeFromLocked(user, creator, toCreator);
        } else {
            toPlatform += toCreator;
            toCreator = 0;
        }

        // 分配给推荐人（无效则回流平台）
        if (toReferrer > 0 && referrer != address(0)) {
            vault.collectFeeFromLocked(user, referrer, toReferrer);
        } else {
            toPlatform += toReferrer;
            toReferrer = 0;
        }

        // 分配给保险基金
        if (toInsurance > 0 && insuranceFeeReceiver != address(0)) {
            vault.collectFeeFromLocked(user, insuranceFeeReceiver, toInsurance);
        } else {
            toPlatform += toInsurance;
            toInsurance = 0;
        }

        // 分配给 LP 池
        if (toLP > 0 && lpFeeReceiver != address(0)) {
            vault.collectFeeFromLocked(user, lpFeeReceiver, toLP);
        } else {
            toPlatform += toLP;
            toLP = 0;
        }

        // 分配给平台
        if (toPlatform > 0 && feeReceiver != address(0)) {
            vault.collectFeeFromLocked(user, feeReceiver, toPlatform);
        }

        emit PerpFeeDistributed(token, user, fee, toCreator, toReferrer, toPlatform, toInsurance, toLP);
    }
}
