// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/IPositionManager.sol";
import "../interfaces/IVault.sol";
import "../interfaces/IRiskManager.sol";
import "../interfaces/IPriceFeed.sol";

/**
 * @title Liquidation
 * @notice 清算合约 + 保险基金
 * @dev 处理清算、ADL（自动减仓）、保险基金管理
 *      - 穿仓时用保险基金赔偿
 *      - 保险基金不足时触发 ADL
 *      - ADL 仍不足时暂停交易
 */
contract Liquidation is Ownable, ReentrancyGuard {
    // ============================================================
    // Constants
    // ============================================================

    uint256 public constant PRECISION = 1e18;

    // ============================================================
    // State Variables
    // ============================================================

    IPositionManager public positionManager;
    IVault public vault;
    IRiskManager public riskManager;
    IPriceFeed public priceFeed;

    // 保险基金（本合约 ETH 余额）
    uint256 public insuranceFund;

    // 清算统计
    uint256 public totalLiquidations;
    uint256 public totalLiquidationVolume;

    // ADL 相关
    address[] public adlQueue;
    mapping(address => uint256) public userADLIndex;

    /// @notice 清算奖励费率（默认 7.5% = 75e15，仅在 liquidatorRewardEnabled 为 true 时生效）
    uint256 public liquidatorRewardRate = 75e15; // 7.5%

    /// @notice 按代币粒度控制清算奖励：内盘(false) = 系统清算0%奖励，转DEX后(true) = 外部清算7.5%奖励
    mapping(address => bool) public liquidatorRewardEnabled;

    /// @notice TokenFactory 地址（用于毕业回调自动启用清算奖励）
    address public tokenFactory;

    // ============================================================
    // Events
    // ============================================================

    event Liquidated(
        address indexed user,
        address indexed liquidator,
        uint256 size,
        uint256 collateral,
        uint256 liquidatorReward,
        uint256 toInsuranceFund
    );

    // C-07: 多代币清算事件
    event TokenLiquidated(
        address indexed user,
        address indexed token,
        address indexed liquidator,
        uint256 size,
        uint256 collateral,
        uint256 liquidatorReward,
        uint256 toInsuranceFund
    );

    event InsuranceFundDeposit(uint256 amount);
    event InsuranceFundWithdraw(uint256 amount);
    event ProfitPaid(address indexed user, uint256 amount);
    event DeficitCovered(uint256 amount);
    event ADLExecuted(address indexed user, uint256 reduceAmount, string reason);
    event TradingPausedDueToInsufficient(uint256 deficit);
    event LiquidatorRewardEnabled(address indexed token);
    event LiquidatorRewardRateUpdated(uint256 oldRate, uint256 newRate);
    event TokenFactoryUpdated(address indexed tokenFactory);

    // ============================================================
    // Errors
    // ============================================================

    error CannotLiquidate();
    error ZeroAddress();
    error InsufficientInsuranceFund();
    error TransferFailed();
    error Unauthorized();

    // ============================================================
    // Constructor
    // ============================================================

    constructor(address _positionManager, address _vault, address _riskManager, address _priceFeed)
        Ownable(msg.sender)
    {
        if (_positionManager == address(0) || _vault == address(0) || _riskManager == address(0) || _priceFeed == address(0)) {
            revert ZeroAddress();
        }
        positionManager = IPositionManager(_positionManager);
        vault = IVault(_vault);
        riskManager = IRiskManager(_riskManager);
        priceFeed = IPriceFeed(_priceFeed);
    }

    // ============================================================
    // Admin Functions
    // ============================================================

    function depositInsuranceFund() external payable onlyOwner {
        insuranceFund += msg.value;
        emit InsuranceFundDeposit(msg.value);
    }

    function withdrawInsuranceFund(uint256 amount) external onlyOwner {
        if (amount > insuranceFund) revert InsufficientInsuranceFund();
        insuranceFund -= amount;

        (bool success,) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");

        emit InsuranceFundWithdraw(amount);
    }

    /// @notice 启用代币的清算奖励（毕业后由 TokenFactory 回调触发，或 owner 手动启用）
    function enableLiquidatorReward(address token) external {
        require(msg.sender == owner() || msg.sender == tokenFactory, "Unauthorized");
        liquidatorRewardEnabled[token] = true;
        emit LiquidatorRewardEnabled(token);
    }

    /// @notice 设置清算奖励费率（仅 owner）
    function setLiquidatorRewardRate(uint256 _rate) external onlyOwner {
        require(_rate <= 15e16, "Max 15%"); // 上限 15%
        emit LiquidatorRewardRateUpdated(liquidatorRewardRate, _rate);
        liquidatorRewardRate = _rate;
    }

    /// @notice 设置 TokenFactory 地址（用于毕业回调）
    function setTokenFactory(address _tokenFactory) external onlyOwner {
        if (_tokenFactory == address(0)) revert ZeroAddress();
        tokenFactory = _tokenFactory;
        emit TokenFactoryUpdated(_tokenFactory);
    }

    // ============================================================
    // Liquidation Functions
    // ============================================================

    function liquidate(address user) external nonReentrant {
        if (!positionManager.canLiquidate(user)) revert CannotLiquidate();

        IPositionManager.Position memory pos = positionManager.getPosition(user);
        uint256 markPrice = priceFeed.getMarkPrice();

        int256 pnl = _calculatePnL(pos, markPrice);
        int256 remainingValue = int256(pos.collateral) + pnl;

        positionManager.forceClose(user);

        // Legacy 函数: 默认 0 奖励（系统清算）
        uint256 liquidatorReward = 0;
        uint256 toInsuranceFund = 0;

        if (remainingValue > 0) {
            // 100% 进保险基金（legacy = 内盘 = 系统清算 = 无奖励）
            toInsuranceFund = uint256(remainingValue);
            insuranceFund += toInsuranceFund;
        } else {
            uint256 deficit = uint256(-remainingValue);

            // 尝试用保险基金覆盖
            if (insuranceFund >= deficit) {
                insuranceFund -= deficit;
            } else {
                // 保险基金不足，触发 ADL 或暂停交易
                _handleInsuranceShortfall(deficit - insuranceFund);
                insuranceFund = 0;
            }

            // Legacy = 内盘 = 系统清算 = 穿仓时无奖励
        }

        totalLiquidations++;
        totalLiquidationVolume += pos.size;

        emit Liquidated(user, msg.sender, pos.size, pos.collateral, liquidatorReward, toInsuranceFund);
    }

    function liquidateBatch(address[] calldata users) external nonReentrant {
        for (uint256 i = 0; i < users.length; i++) {
            if (positionManager.canLiquidate(users[i])) {
                try this.liquidateSingle(users[i], msg.sender) {} catch {}
            }
        }
    }

    function liquidateSingle(address user, address liquidator) external {
        require(msg.sender == address(this), "Internal only");

        IPositionManager.Position memory pos = positionManager.getPosition(user);
        uint256 markPrice = priceFeed.getMarkPrice();

        int256 pnl = _calculatePnL(pos, markPrice);
        int256 remainingValue = int256(pos.collateral) + pnl;

        positionManager.forceClose(user);

        // Legacy = 内盘 = 系统清算 = 0% 奖励
        uint256 liquidatorReward = 0;
        uint256 toInsuranceFund = 0;

        if (remainingValue > 0) {
            toInsuranceFund = uint256(remainingValue);
            insuranceFund += toInsuranceFund;
        } else {
            uint256 deficit = uint256(-remainingValue);
            if (insuranceFund >= deficit) {
                insuranceFund -= deficit;
            } else {
                _handleInsuranceShortfall(deficit - insuranceFund);
                insuranceFund = 0;
            }
        }

        totalLiquidations++;
        totalLiquidationVolume += pos.size;

        emit Liquidated(user, liquidator, pos.size, pos.collateral, liquidatorReward, toInsuranceFund);
    }

    // ============================================================
    // C-07: Multi-token Liquidation Functions
    // ============================================================

    /**
     * @notice 清算特定代币的仓位
     * @param user 用户地址
     * @param token 代币地址
     */
    function liquidateToken(address user, address token) external nonReentrant {
        if (!positionManager.canLiquidateToken(user, token)) revert CannotLiquidate();

        IPositionManager.PositionEx memory pos = positionManager.getPositionByToken(user, token);
        uint256 markPrice = priceFeed.getTokenMarkPrice(token);

        int256 pnl = _calculatePnLToken(pos, markPrice);
        int256 remainingValue = int256(pos.collateral) + pnl;

        positionManager.forceCloseToken(user, token);

        // 内盘(bonding curve) = 0% 奖励，全额进保险基金
        // 转 DEX 后 = 7.5% 奖励给外部清算人
        uint256 effectiveRewardRate = liquidatorRewardEnabled[token] ? liquidatorRewardRate : 0;

        uint256 liquidatorReward = 0;
        uint256 toInsuranceFund = 0;

        if (remainingValue > 0) {
            uint256 remaining = uint256(remainingValue);
            if (effectiveRewardRate > 0) {
                if (remaining > type(uint256).max / effectiveRewardRate) {
                    remaining = type(uint256).max / effectiveRewardRate;
                }
                liquidatorReward = (remaining * effectiveRewardRate) / PRECISION;
            }
            toInsuranceFund = uint256(remainingValue) - liquidatorReward;

            if (liquidatorReward > 0) {
                vault.distributeLiquidation(user, msg.sender, liquidatorReward, 0);
            }
            insuranceFund += toInsuranceFund;
        } else {
            uint256 deficit = uint256(-remainingValue);

            if (insuranceFund >= deficit) {
                insuranceFund -= deficit;
            } else {
                _handleInsuranceShortfall(deficit - insuranceFund);
                insuranceFund = 0;
            }

            // 穿仓时仅在奖励启用后给清算人最小奖励
            if (effectiveRewardRate > 0 && pos.collateral > 0) {
                liquidatorReward = pos.collateral / 20;
                vault.distributeLiquidation(user, msg.sender, liquidatorReward, 0);
            }
        }

        totalLiquidations++;
        totalLiquidationVolume += pos.size;

        emit TokenLiquidated(user, token, msg.sender, pos.size, pos.collateral, liquidatorReward, toInsuranceFund);
    }

    /**
     * @notice 批量清算特定代币的仓位
     * @param users 用户地址列表
     * @param token 代币地址
     */
    function liquidateBatchToken(address[] calldata users, address token) external nonReentrant {
        for (uint256 i = 0; i < users.length; i++) {
            if (positionManager.canLiquidateToken(users[i], token)) {
                try this.liquidateSingleToken(users[i], token, msg.sender) {} catch {}
            }
        }
    }

    /**
     * @notice 内部函数：清算单个代币仓位
     */
    function liquidateSingleToken(address user, address token, address liquidator) external {
        require(msg.sender == address(this), "Internal only");

        IPositionManager.PositionEx memory pos = positionManager.getPositionByToken(user, token);
        uint256 markPrice = priceFeed.getTokenMarkPrice(token);

        int256 pnl = _calculatePnLToken(pos, markPrice);
        int256 remainingValue = int256(pos.collateral) + pnl;

        positionManager.forceCloseToken(user, token);

        uint256 effectiveRewardRate = liquidatorRewardEnabled[token] ? liquidatorRewardRate : 0;

        uint256 liquidatorReward = 0;
        uint256 toInsuranceFund = 0;

        if (remainingValue > 0) {
            uint256 remaining = uint256(remainingValue);
            if (effectiveRewardRate > 0) {
                if (remaining > type(uint256).max / effectiveRewardRate) {
                    remaining = type(uint256).max / effectiveRewardRate;
                }
                liquidatorReward = (remaining * effectiveRewardRate) / PRECISION;
            }
            toInsuranceFund = uint256(remainingValue) - liquidatorReward;
            if (liquidatorReward > 0) {
                vault.distributeLiquidation(user, liquidator, liquidatorReward, 0);
            }
            insuranceFund += toInsuranceFund;
        } else {
            uint256 deficit = uint256(-remainingValue);
            if (insuranceFund >= deficit) {
                insuranceFund -= deficit;
            } else {
                _handleInsuranceShortfall(deficit - insuranceFund);
                insuranceFund = 0;
            }
            if (effectiveRewardRate > 0 && pos.collateral > 0) {
                liquidatorReward = pos.collateral / 20;
                vault.distributeLiquidation(user, liquidator, liquidatorReward, 0);
            }
        }

        totalLiquidations++;
        totalLiquidationVolume += pos.size;

        emit TokenLiquidated(user, token, liquidator, pos.size, pos.collateral, liquidatorReward, toInsuranceFund);
    }

    /**
     * @notice 检查代币仓位是否可清算
     */
    function canLiquidateToken(address user, address token) external view returns (bool) {
        return positionManager.canLiquidateToken(user, token);
    }

    /**
     * @notice 获取代币仓位的 PnL
     */
    function getUserPnLToken(address user, address token) external view returns (int256 pnl) {
        IPositionManager.PositionEx memory pos = positionManager.getPositionByToken(user, token);
        if (pos.size == 0) return 0;

        uint256 markPrice = priceFeed.getTokenMarkPrice(token);
        return _calculatePnLToken(pos, markPrice);
    }

    /**
     * @notice 获取可清算的代币仓位列表
     */
    function getLiquidatableTokenUsers(address[] calldata users, address token)
        external
        view
        returns (address[] memory liquidatable)
    {
        uint256 count = 0;

        for (uint256 i = 0; i < users.length; i++) {
            if (positionManager.canLiquidateToken(users[i], token)) {
                count++;
            }
        }

        liquidatable = new address[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < users.length; i++) {
            if (positionManager.canLiquidateToken(users[i], token)) {
                liquidatable[idx++] = users[i];
            }
        }
    }

    // ============================================================
    // Insurance Fund Functions (被 Vault 调用)
    // ============================================================

    /**
     * @notice 支付盈利给用户
     * @dev 由 Vault 调用，当用户平仓盈利时
     * @param user 用户地址
     * @param amount 盈利金额
     */
    // P-003: Added nonReentrant to prevent reentrancy via user.call
    function payProfit(address user, uint256 amount) external nonReentrant {
        // 只允许 Vault 调用
        require(msg.sender == address(vault), "Only vault");

        if (amount == 0) return;

        if (insuranceFund >= amount) {
            insuranceFund -= amount;

            // 直接转账给用户
            (bool success,) = user.call{value: amount}("");
            if (!success) {
                // 如果转账失败，增加到用户 Vault 余额
                // 这需要 Vault 有相应的方法，这里简化处理
                insuranceFund += amount; // 退回保险基金
            }

            emit ProfitPaid(user, amount);
        } else {
            // 保险基金不足，触发 ADL
            _handleInsuranceShortfall(amount - insuranceFund);

            // 支付剩余可用的
            uint256 available = insuranceFund;
            insuranceFund = 0;

            if (available > 0) {
                (bool success,) = user.call{value: available}("");
                if (success) {
                    emit ProfitPaid(user, available);
                }
            }
        }
    }

    /**
     * @notice 覆盖穿仓亏空
     * @dev 由 Vault 调用，当用户穿仓时
     * @param amount 需要覆盖的金额
     */
    function coverDeficit(uint256 amount) external {
        require(msg.sender == address(vault), "Only vault");

        if (amount == 0) return;

        if (insuranceFund >= amount) {
            insuranceFund -= amount;
            emit DeficitCovered(amount);
        } else {
            // 保险基金不足
            uint256 shortfall = amount - insuranceFund;
            insuranceFund = 0;

            _handleInsuranceShortfall(shortfall);
            emit DeficitCovered(amount - shortfall);
        }
    }

    // ============================================================
    // ADL Functions
    // ============================================================

    /**
     * @notice 执行 ADL（自动减仓）
     * @dev 当保险基金不足时，减少盈利方的仓位
     */
    function executeADL() external nonReentrant {
        (bool needADL, bool targetSide, uint256 reduceAmount) = riskManager.checkADLRequired();

        if (!needADL) return;

        // 获取需要减仓的用户列表（按盈利排序）
        // 使用内部排序逻辑
        _executeADLForSide(targetSide, reduceAmount);
    }

    /**
     * @notice 使用预排序用户列表执行 ADL
     * @dev 由 Keeper 调用，传入按盈利降序排列的用户列表
     *      合约会验证排序是否正确
     * @param sortedUsers 按盈利降序排列的用户地址列表
     * @param targetSide true=减少多头, false=减少空头
     * @param targetAmount 目标减少金额
     */
    function executeADLWithSortedUsers(
        address[] calldata sortedUsers,
        bool targetSide,
        uint256 targetAmount
    ) external nonReentrant {
        require(sortedUsers.length > 0, "Empty user list");

        uint256 markPrice = priceFeed.getMarkPrice();
        int256 lastPnL = type(int256).max;

        uint256 reduced = 0;

        for (uint256 i = 0; i < sortedUsers.length && reduced < targetAmount; i++) {
            address user = sortedUsers[i];
            IPositionManager.Position memory pos = positionManager.getPosition(user);

            // Skip users without positions or wrong side
            if (pos.size == 0) continue;
            if (pos.isLong != targetSide) continue;

            int256 pnl = _calculatePnL(pos, markPrice);

            // Verify descending order by profit
            require(pnl <= lastPnL, "Users not sorted by profit descending");
            lastPnL = pnl;

            // Only reduce profitable positions
            if (pnl <= 0) continue;

            // Calculate reduction amount
            uint256 toReduce = targetAmount - reduced;
            if (toReduce > pos.size) toReduce = pos.size;

            uint256 percentage = (toReduce * 100) / pos.size;
            if (percentage > 100) percentage = 100;
            if (percentage == 0) percentage = 1;

            // Execute force reduction
            try positionManager.forceReduce(user, percentage) {
                reduced += toReduce;
                emit ADLExecuted(user, toReduce, "ADL sorted execution");
            } catch {
                // Continue to next user
            }
        }
    }

    /**
     * @notice 获取用户当前 PnL（用于 Keeper 排序）
     * @param user 用户地址
     * @return pnl 盈亏值
     */
    function getUserPnL(address user) external view returns (int256 pnl) {
        IPositionManager.Position memory pos = positionManager.getPosition(user);
        if (pos.size == 0) return 0;

        uint256 markPrice = priceFeed.getMarkPrice();
        return _calculatePnL(pos, markPrice);
    }

    /**
     * @notice 获取多个用户的 PnL（用于 Keeper 批量查询和排序）
     * @param users 用户地址列表
     * @return pnls 对应的盈亏值列表
     */
    function getUsersPnL(address[] calldata users) external view returns (int256[] memory pnls) {
        pnls = new int256[](users.length);
        uint256 markPrice = priceFeed.getMarkPrice();

        for (uint256 i = 0; i < users.length; i++) {
            IPositionManager.Position memory pos = positionManager.getPosition(users[i]);
            if (pos.size == 0) {
                pnls[i] = 0;
            } else {
                pnls[i] = _calculatePnL(pos, markPrice);
            }
        }
    }

    /**
     * @notice 获取 ADL 队列长度
     */
    function getADLQueueLength() external view returns (uint256) {
        return adlQueue.length;
    }

    /**
     * @notice 获取 ADL 队列中的用户
     * @param start 起始索引
     * @param count 获取数量
     */
    function getADLQueueUsers(uint256 start, uint256 count) external view returns (address[] memory users) {
        uint256 end = start + count;
        if (end > adlQueue.length) {
            end = adlQueue.length;
        }
        if (start >= end) {
            return new address[](0);
        }

        users = new address[](end - start);
        for (uint256 i = start; i < end; i++) {
            users[i - start] = adlQueue[i];
        }
    }

    // ============================================================
    // View Functions
    // ============================================================

    function canLiquidate(address user) external view returns (bool) {
        return positionManager.canLiquidate(user);
    }

    function getLiquidatableUsers(address[] calldata users) external view returns (address[] memory liquidatable) {
        uint256 count = 0;

        for (uint256 i = 0; i < users.length; i++) {
            if (positionManager.canLiquidate(users[i])) {
                count++;
            }
        }

        liquidatable = new address[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < users.length; i++) {
            if (positionManager.canLiquidate(users[i])) {
                liquidatable[idx++] = users[i];
            }
        }
    }

    function getLiquidationReward(address user) external view returns (uint256 reward) {
        if (!positionManager.canLiquidate(user)) return 0;

        IPositionManager.Position memory pos = positionManager.getPosition(user);
        uint256 markPrice = priceFeed.getMarkPrice();

        int256 pnl = _calculatePnL(pos, markPrice);
        int256 remainingValue = int256(pos.collateral) + pnl;

        if (remainingValue > 0) {
            reward = (uint256(remainingValue) * liquidatorRewardRate) / PRECISION;
        } else {
            reward = pos.collateral / 20;
        }
    }

    function getInsuranceFund() external view returns (uint256) {
        return insuranceFund;
    }

    function getStats() external view returns (uint256 count, uint256 volume) {
        return (totalLiquidations, totalLiquidationVolume);
    }

    // ============================================================
    // Internal Functions
    // ============================================================

    function _calculatePnL(IPositionManager.Position memory pos, uint256 currentPrice)
        internal
        pure
        returns (int256)
    {
        if (pos.isLong) {
            if (currentPrice >= pos.entryPrice) {
                return int256((pos.size * (currentPrice - pos.entryPrice)) / pos.entryPrice);
            } else {
                return -int256((pos.size * (pos.entryPrice - currentPrice)) / pos.entryPrice);
            }
        } else {
            if (currentPrice <= pos.entryPrice) {
                return int256((pos.size * (pos.entryPrice - currentPrice)) / pos.entryPrice);
            } else {
                return -int256((pos.size * (currentPrice - pos.entryPrice)) / pos.entryPrice);
            }
        }
    }

    /**
     * @notice C-07: 计算多代币仓位的 PnL
     */
    function _calculatePnLToken(IPositionManager.PositionEx memory pos, uint256 currentPrice)
        internal
        pure
        returns (int256)
    {
        if (pos.isLong) {
            if (currentPrice >= pos.entryPrice) {
                return int256((pos.size * (currentPrice - pos.entryPrice)) / pos.entryPrice);
            } else {
                return -int256((pos.size * (pos.entryPrice - currentPrice)) / pos.entryPrice);
            }
        } else {
            if (currentPrice <= pos.entryPrice) {
                return int256((pos.size * (pos.entryPrice - currentPrice)) / pos.entryPrice);
            } else {
                return -int256((pos.size * (currentPrice - pos.entryPrice)) / pos.entryPrice);
            }
        }
    }

    /**
     * @notice 处理保险基金不足的情况
     * @param shortfall 缺口金额
     */
    function _handleInsuranceShortfall(uint256 shortfall) internal {
        // 1. 尝试 ADL
        (bool needADL, bool targetSide, uint256 reduceAmount) = riskManager.checkADLRequired();

        if (needADL && reduceAmount > 0) {
            _executeADLForSide(targetSide, reduceAmount);
            emit ADLExecuted(address(0), reduceAmount, "Insurance shortfall");
        }

        // 2. 如果 ADL 后仍然不足，暂停交易
        (, uint256 fundBalance, uint256 requiredAmount) = riskManager.checkInsuranceCoverage();

        if (fundBalance < requiredAmount) {
            // 调用 RiskManager 暂停交易
            // 注意：需要 RiskManager 授权本合约
            try riskManager.pauseTrading("Insurance fund insufficient after ADL") {
                emit TradingPausedDueToInsufficient(shortfall);
            } catch {
                // 如果无法暂停，记录事件
                emit TradingPausedDueToInsufficient(shortfall);
            }
        }
    }

    /**
     * @notice 对特定方向执行 ADL
     * @param isLong true=减少多头, false=减少空头
     * @param targetAmount 目标减少金额
     */
    function _executeADLForSide(bool isLong, uint256 targetAmount) internal {
        // 简化实现：这里应该维护一个按盈利排序的用户列表
        // 实际生产中需要更复杂的数据结构

        // 获取 ADL 队列中的用户
        uint256 reduced = 0;

        for (uint256 i = 0; i < adlQueue.length && reduced < targetAmount; i++) {
            address user = adlQueue[i];
            IPositionManager.Position memory pos = positionManager.getPosition(user);

            // 检查用户是否是目标方向且有盈利
            if (pos.size == 0) continue;
            if (pos.isLong != isLong) continue;

            uint256 markPrice = priceFeed.getMarkPrice();
            int256 pnl = _calculatePnL(pos, markPrice);

            // 只减少盈利的仓位
            if (pnl <= 0) continue;

            // 计算需要减少的比例
            uint256 toReduce = targetAmount - reduced;
            if (toReduce > pos.size) toReduce = pos.size;

            uint256 percentage = (toReduce * 100) / pos.size;
            if (percentage > 100) percentage = 100;
            if (percentage == 0) percentage = 1;

            // 执行强制减仓
            try positionManager.forceReduce(user, percentage) {
                reduced += toReduce;
                emit ADLExecuted(user, toReduce, "ADL executed");
            } catch {
                // 继续处理下一个用户
            }
        }
    }

    /**
     * @notice 添加用户到 ADL 队列
     * @dev 可以由 PositionManager 在开仓时调用
     */
    function addToADLQueue(address user) external {
        // 只允许 PositionManager 调用
        require(msg.sender == address(positionManager), "Only PositionManager");

        if (userADLIndex[user] == 0) {
            adlQueue.push(user);
            userADLIndex[user] = adlQueue.length;
        }
    }

    /**
     * @notice 从 ADL 队列移除用户
     */
    function removeFromADLQueue(address user) external {
        require(msg.sender == address(positionManager), "Only PositionManager");

        uint256 index = userADLIndex[user];
        if (index > 0) {
            // 移动最后一个元素到被删除的位置
            uint256 lastIndex = adlQueue.length - 1;
            if (index - 1 != lastIndex) {
                address lastUser = adlQueue[lastIndex];
                adlQueue[index - 1] = lastUser;
                userADLIndex[lastUser] = index;
            }
            adlQueue.pop();
            delete userADLIndex[user];
        }
    }

    // ============================================================
    // Receive Function
    // ============================================================

    receive() external payable {
        insuranceFund += msg.value;
        emit InsuranceFundDeposit(msg.value);
    }
}
