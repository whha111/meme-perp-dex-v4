// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "../interfaces/IPositionManager.sol";
import "../interfaces/IVault.sol";
import "../interfaces/IPriceFeed.sol";

/**
 * @title FundingRate
 * @notice 资金费率合约 — Meme 币专用动态失衡模型
 * @dev 核心逻辑：
 *      1. 每 15 分钟收取一次（可配置）
 *      2. 费率基于多空 OI 失衡度动态计算：skew = |longOI - shortOI| / totalOI
 *      3. 劣势方（OI 更大的一方）支付资金费
 *      4. 收取的资金费 100% 注入保险基金
 *      5. 50/50 平衡时资金费为 0（无成本）
 */
contract FundingRate is Ownable {
    using Address for address payable;

    // ============================================================
    // Constants
    // ============================================================

    uint256 public constant PRECISION = 1e18;
    uint256 public constant BPS_PRECISION = 10000;

    // ============================================================
    // Configurable Parameters (可通过 admin setter 调整)
    // ============================================================

    /// @notice 资金费收取间隔（默认 15 分钟）
    uint256 public fundingInterval = 15 minutes;

    /// @notice 基础费率（bps，默认 1 = 0.01%）
    uint256 public baseFundingRateBps = 1;

    /// @notice 最大费率上限（bps，默认 50 = 0.5%）
    uint256 public maxFundingRateBps = 50;

    /// @notice 资金费 → 保险基金比例（默认 10000 = 100%）
    uint256 public toInsuranceRatio = 10000;

    // ============================================================
    // State Variables
    // ============================================================

    IPositionManager public positionManager;
    IVault public vault;
    IPriceFeed public priceFeed;

    /// @notice 上次收取时间
    uint256 public lastFundingTime;

    /// @notice 保险基金余额（合约内管理）
    uint256 public insuranceFundBalance;

    /// @notice 平台风险准备金余额
    uint256 public riskReserveBalance;

    /// @notice 超级管理员（可紧急提取保险基金）
    address public superAdmin;

    /// @notice 累计收取的资金费
    uint256 public totalFundingCollected;

    /// @notice 当前实际费率（每次 collectFunding 后更新，方便前端读取）
    int256 public currentFundingRate; // 正 = 多头付费，负 = 空头付费

    // ============================================================
    // Events
    // ============================================================

    event FundingCollected(
        uint256 timestamp,
        uint256 totalOI,
        uint256 fundingAmount,
        uint256 toInsurance,
        uint256 toPlatform,
        int256 fundingRate // 正 = 多头付费
    );
    event InsuranceFundInjected(address indexed from, uint256 amount);
    event InsuranceFundWithdrawn(address indexed to, uint256 amount);
    event RiskReserveWithdrawn(address indexed to, uint256 amount);
    event SuperAdminUpdated(address indexed oldAdmin, address indexed newAdmin);
    event FundingIntervalUpdated(uint256 oldValue, uint256 newValue);
    event BaseFundingRateUpdated(uint256 oldValue, uint256 newValue);
    event MaxFundingRateUpdated(uint256 oldValue, uint256 newValue);
    event ToInsuranceRatioUpdated(uint256 oldValue, uint256 newValue);

    // ============================================================
    // Errors
    // ============================================================

    error TooEarlyToCollect();
    error ZeroAddress();
    error Unauthorized();
    error InsufficientBalance();
    error ZeroAmount();
    error InvalidParameter();

    // ============================================================
    // Modifiers
    // ============================================================

    modifier onlySuperAdmin() {
        if (msg.sender != superAdmin && msg.sender != owner()) revert Unauthorized();
        _;
    }

    // ============================================================
    // Constructor
    // ============================================================

    constructor(address _positionManager, address _vault, address _priceFeed) Ownable(msg.sender) {
        if (_positionManager == address(0) || _vault == address(0) || _priceFeed == address(0)) {
            revert ZeroAddress();
        }
        positionManager = IPositionManager(_positionManager);
        vault = IVault(_vault);
        priceFeed = IPriceFeed(_priceFeed);
        lastFundingTime = block.timestamp;
        superAdmin = msg.sender;
    }

    // ============================================================
    // Core Functions
    // ============================================================

    /**
     * @notice 收取资金费（动态失衡模型）
     * @dev 任何人可调用。费率基于多空 OI 比例动态计算：
     *      skew = (longOI - shortOI) / totalOI
     *      effectiveRate = |skew| × baseFundingRateBps，上限 maxFundingRateBps
     *      劣势方支付，100% 进保险基金
     */
    function collectFunding() external {
        if (block.timestamp < lastFundingTime + fundingInterval) {
            revert TooEarlyToCollect();
        }

        uint256 totalLong = positionManager.getTotalLongSize();
        uint256 totalShort = positionManager.getTotalShortSize();
        uint256 totalOI = totalLong + totalShort;

        if (totalOI == 0) {
            lastFundingTime = block.timestamp;
            currentFundingRate = 0;
            return;
        }

        // 计算失衡度 skew（精度 1e18）
        // skew > 0: 多头占优（多头付费）
        // skew < 0: 空头占优（空头付费）
        int256 skew;
        if (totalLong >= totalShort) {
            skew = int256(((totalLong - totalShort) * PRECISION) / totalOI);
        } else {
            skew = -int256(((totalShort - totalLong) * PRECISION) / totalOI);
        }

        // 计算有效费率 = |skew| × baseFundingRateBps / BPS_PRECISION
        uint256 absSkew = skew >= 0 ? uint256(skew) : uint256(-skew);
        uint256 effectiveRateBps = (absSkew * baseFundingRateBps) / PRECISION;

        // 限制最大费率
        if (effectiveRateBps > maxFundingRateBps) {
            effectiveRateBps = maxFundingRateBps;
        }

        // 资金费 = 劣势方 OI × effectiveRate
        // 劣势方是 OI 更大的一方
        uint256 dominantOI = totalLong >= totalShort ? totalLong : totalShort;
        uint256 fundingAmount = (dominantOI * effectiveRateBps) / BPS_PRECISION;

        // 分配：100% 进保险基金（toInsuranceRatio = 10000）
        uint256 toInsurance = (fundingAmount * toInsuranceRatio) / BPS_PRECISION;
        uint256 toPlatform = fundingAmount - toInsurance;

        // 更新余额
        insuranceFundBalance += toInsurance;
        riskReserveBalance += toPlatform;
        totalFundingCollected += fundingAmount;

        // 记录当前费率（带方向，供前端显示）
        currentFundingRate = skew >= 0
            ? int256(effectiveRateBps)   // 正 = 多头付费
            : -int256(effectiveRateBps); // 负 = 空头付费

        lastFundingTime = block.timestamp;

        emit FundingCollected(block.timestamp, totalOI, fundingAmount, toInsurance, toPlatform, currentFundingRate);
    }

    // ============================================================
    // Insurance Fund Management
    // ============================================================

    function injectInsuranceFund() external payable {
        if (msg.value == 0) revert ZeroAmount();
        insuranceFundBalance += msg.value;
        emit InsuranceFundInjected(msg.sender, msg.value);
    }

    function emergencyWithdrawInsurance(uint256 amount, address recipient) external onlySuperAdmin {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount > insuranceFundBalance) revert InsufficientBalance();
        insuranceFundBalance -= amount;
        payable(recipient).sendValue(amount);
        emit InsuranceFundWithdrawn(recipient, amount);
    }

    function withdrawRiskReserve(address recipient) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        uint256 amount = riskReserveBalance;
        if (amount == 0) revert ZeroAmount();
        riskReserveBalance = 0;
        payable(recipient).sendValue(amount);
        emit RiskReserveWithdrawn(recipient, amount);
    }

    function coverDeficit(uint256 amount) external returns (uint256 covered) {
        require(msg.sender == address(vault), "Only Vault");
        covered = amount > insuranceFundBalance ? insuranceFundBalance : amount;
        if (covered > 0) {
            insuranceFundBalance -= covered;
            payable(msg.sender).sendValue(covered);
        }
    }

    // ============================================================
    // Admin Functions (可配置参数)
    // ============================================================

    function setFundingInterval(uint256 _interval) external onlyOwner {
        if (_interval < 1 minutes || _interval > 24 hours) revert InvalidParameter();
        emit FundingIntervalUpdated(fundingInterval, _interval);
        fundingInterval = _interval;
    }

    function setBaseFundingRate(uint256 _rateBps) external onlyOwner {
        if (_rateBps > 100) revert InvalidParameter(); // 最大 1%
        emit BaseFundingRateUpdated(baseFundingRateBps, _rateBps);
        baseFundingRateBps = _rateBps;
    }

    function setMaxFundingRate(uint256 _maxRateBps) external onlyOwner {
        if (_maxRateBps > 500) revert InvalidParameter(); // 最大 5%
        emit MaxFundingRateUpdated(maxFundingRateBps, _maxRateBps);
        maxFundingRateBps = _maxRateBps;
    }

    function setToInsuranceRatio(uint256 _ratio) external onlyOwner {
        if (_ratio > BPS_PRECISION) revert InvalidParameter();
        emit ToInsuranceRatioUpdated(toInsuranceRatio, _ratio);
        toInsuranceRatio = _ratio;
    }

    function setSuperAdmin(address newAdmin) external onlyOwner {
        if (newAdmin == address(0)) revert ZeroAddress();
        address oldAdmin = superAdmin;
        superAdmin = newAdmin;
        emit SuperAdminUpdated(oldAdmin, newAdmin);
    }

    // ============================================================
    // View Functions
    // ============================================================

    /// @notice 获取当前资金费率（带方向）
    /// @return rate 正 = 多头付费，负 = 空头付费，单位 bps
    function getCurrentFundingRate() external view returns (int256 rate) {
        return currentFundingRate;
    }

    /// @notice 获取下次收取时间
    function getNextFundingTime() external view returns (uint256) {
        return lastFundingTime + fundingInterval;
    }

    /// @notice 获取保险基金余额
    function getInsuranceFundBalance() external view returns (uint256) {
        return insuranceFundBalance;
    }

    /// @notice 计算当前 skew（不改变状态）
    function getCurrentSkew() external view returns (int256) {
        uint256 totalLong = positionManager.getTotalLongSize();
        uint256 totalShort = positionManager.getTotalShortSize();
        uint256 totalOI = totalLong + totalShort;
        if (totalOI == 0) return 0;
        if (totalLong >= totalShort) {
            return int256(((totalLong - totalShort) * PRECISION) / totalOI);
        } else {
            return -int256(((totalShort - totalLong) * PRECISION) / totalOI);
        }
    }

    /// @notice 获取年化费率（基于当前失衡度）
    function getAnnualizedRate() external view returns (uint256) {
        uint256 periodsPerDay = 1 days / fundingInterval;
        uint256 absRate = currentFundingRate >= 0
            ? uint256(currentFundingRate)
            : uint256(-currentFundingRate);
        return absRate * periodsPerDay * 365;
    }

    function getLastFundingTime() external view returns (uint256) {
        return lastFundingTime;
    }

    function canCollectFunding() external view returns (bool) {
        return block.timestamp >= lastFundingTime + fundingInterval;
    }

    function getRiskReserveBalance() external view returns (uint256) {
        return riskReserveBalance;
    }

    // ============================================================
    // Legacy Interface (兼容旧代码)
    // ============================================================

    function settleFunding() external {
        this.collectFunding();
    }

    function getEstimatedFundingRate() external view returns (int256) {
        return currentFundingRate;
    }

    function settleUserFunding(address) external pure returns (int256) {
        return 0;
    }

    function getPendingFunding(address) external pure returns (int256) {
        return 0;
    }

    // ============================================================
    // Receive ETH
    // ============================================================

    receive() external payable {
        insuranceFundBalance += msg.value;
        emit InsuranceFundInjected(msg.sender, msg.value);
    }
}
