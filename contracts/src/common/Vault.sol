// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice Interface for InsuranceFund to cover liquidation shortfalls
interface IInsuranceFund {
    function coverDeficit(uint256 amount) external returns (uint256 covered);
}

/**
 * @title Vault
 * @notice BNB 保证金托管合约
 * @dev 管理用户存款、取款、保证金锁定和盈亏结算
 *      P-007: 添加紧急暂停功能
 */
contract Vault is Ownable, ReentrancyGuard, Pausable {
    // ============================================================
    // State Variables
    // ============================================================

    // 用户可用余额
    mapping(address => uint256) public balances;
    // 用户锁定余额（作为保证金）
    mapping(address => uint256) public lockedBalances;

    // 授权合约（PositionManager, Liquidation 等）
    mapping(address => bool) public authorizedContracts;

    // LP 池地址（用于清算时分配剩余资金）
    address public lendingPool;

    // 保险基金地址（Liquidation 合约）
    address public insuranceFund;

    // H-016: 待领取的盈利（保险基金不足时记录）
    mapping(address => uint256) public pendingProfits;

    // P1-3: 活跃仓位提款延迟
    uint256 public withdrawalDelay; // 提款延迟时间（秒），默认 0 = 无延迟
    struct WithdrawRequest {
        uint256 amount;
        uint256 unlockTime;
    }
    mapping(address => WithdrawRequest) public pendingWithdrawals;

    // ============================================================
    // Events
    // ============================================================

    event Deposit(address indexed user, uint256 amount, uint256 timestamp);
    event Withdraw(address indexed user, uint256 amount, uint256 timestamp);
    event MarginLocked(address indexed user, uint256 amount);
    event MarginUnlocked(address indexed user, uint256 amount);
    event PnLSettled(address indexed from, address indexed to, uint256 amount);
    event ProfitPaid(address indexed user, uint256 collateral, uint256 profit);
    event LossCollected(address indexed user, uint256 collateral, uint256 loss);
    event BankruptcyHandled(address indexed user, uint256 collateral, uint256 deficit, uint256 covered);
    event Liquidated(
        address indexed user,
        address indexed liquidator,
        uint256 liquidatorReward,
        uint256 remainingToPool
    );
    event ContractAuthorized(address indexed contractAddr, bool authorized);
    event LendingPoolSet(address indexed pool);
    event InsuranceFundSet(address indexed fund);
    // AUDIT-FIX SC-C03: 追踪保险基金转账失败
    event InsuranceTransferFailed(address indexed user, uint256 amount);
    event FeeCollected(address indexed user, address indexed feeReceiver, uint256 amount);
    // L-004: Added missing event
    event LockedBalanceTransferred(address indexed from, address indexed to, uint256 amount);
    // H-016: Events for pending profit claims
    event ProfitPending(address indexed user, uint256 amount);
    event ProfitClaimed(address indexed user, uint256 amount);
    // P1-3: Withdrawal delay events
    event WithdrawRequested(address indexed user, uint256 amount, uint256 unlockTime);
    event WithdrawExecuted(address indexed user, uint256 amount);
    event WithdrawCancelled(address indexed user, uint256 amount);
    event WithdrawalDelaySet(uint256 delay);

    // ============================================================
    // Errors
    // ============================================================

    error InsufficientBalance();
    error InsufficientLockedBalance();
    error InvalidAmount();
    error Unauthorized();
    error ZeroAddress();
    error TransferFailed();
    error InsuranceFundInsufficient();
    error NoPendingProfit();
    error WithdrawNotReady();
    error NoPendingWithdraw();
    error WithdrawDelayTooLong();

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

    constructor() Ownable(msg.sender) {}

    // ============================================================
    // Admin Functions
    // ============================================================

    function setAuthorizedContract(address contractAddr, bool authorized) external onlyOwner {
        if (contractAddr == address(0)) revert ZeroAddress();
        authorizedContracts[contractAddr] = authorized;
        emit ContractAuthorized(contractAddr, authorized);
    }

    function setLendingPool(address _lendingPool) external onlyOwner {
        if (_lendingPool == address(0)) revert ZeroAddress();
        lendingPool = _lendingPool;
        emit LendingPoolSet(_lendingPool);
    }

    function setInsuranceFund(address _insuranceFund) external onlyOwner {
        if (_insuranceFund == address(0)) revert ZeroAddress();
        insuranceFund = _insuranceFund;
        emit InsuranceFundSet(_insuranceFund);
    }

    // P-007: Emergency pause functionality
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice P1-3: 设置提款延迟时间
     * @param _delay 延迟秒数（0 = 无延迟，最大 7 天）
     */
    function setWithdrawalDelay(uint256 _delay) external onlyOwner {
        if (_delay > 7 days) revert WithdrawDelayTooLong();
        withdrawalDelay = _delay;
        emit WithdrawalDelaySet(_delay);
    }

    /**
     * @notice 紧急救援 - 直接发送 ETH 给用户 (仅限 owner)
     * @dev P0-4: 修复双花漏洞 — 必须扣减用户账本余额，防止 rescue + withdraw 双重提款
     *      先从 available balance 扣除，不足部分从 locked balance 扣除
     * @param user 用户地址
     * @param amount 金额
     */
    function emergencyRescue(address user, uint256 amount) external onlyOwner {
        uint256 available = balances[user];
        uint256 locked = lockedBalances[user];
        require(available + locked >= amount, "Insufficient user balance");
        require(address(this).balance >= amount, "Insufficient contract balance");

        // 先从 available 扣除，不足从 locked 扣除
        if (available >= amount) {
            balances[user] -= amount;
        } else {
            balances[user] = 0;
            lockedBalances[user] -= (amount - available);
        }

        (bool success, ) = user.call{value: amount}("");
        require(success, "Transfer failed");
        emit Withdraw(user, amount, block.timestamp);
    }

    // ============================================================
    // User Functions
    // ============================================================

    // P-007: Added whenNotPaused
    function deposit() external payable nonReentrant whenNotPaused {
        if (msg.value == 0) revert InvalidAmount();
        balances[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value, block.timestamp);
    }

    /**
     * @notice P1-3: 提款（支持延迟机制）
     * @dev 如果用户有锁定保证金且设置了延迟 → 需要先 requestWithdraw 再 executeWithdraw
     *      如果用户无锁定保证金或延迟为 0 → 直接提款
     */
    function withdraw(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert InvalidAmount();
        if (balances[msg.sender] < amount) revert InsufficientBalance();

        // P1-3: 有活跃仓位且设置了延迟 → 走 pending 流程
        if (withdrawalDelay > 0 && lockedBalances[msg.sender] > 0) {
            pendingWithdrawals[msg.sender] = WithdrawRequest({
                amount: amount,
                unlockTime: block.timestamp + withdrawalDelay
            });
            emit WithdrawRequested(msg.sender, amount, block.timestamp + withdrawalDelay);
            return;
        }

        // 无延迟或无活跃仓位 → 直接提款
        balances[msg.sender] -= amount;
        (bool success,) = msg.sender.call{value: amount}("");
        if (!success) revert TransferFailed();
        emit Withdraw(msg.sender, amount, block.timestamp);
    }

    /**
     * @notice P1-3: 执行待处理的提款（延迟期满后）
     */
    function executeWithdraw() external nonReentrant whenNotPaused {
        WithdrawRequest memory req = pendingWithdrawals[msg.sender];
        if (req.amount == 0) revert NoPendingWithdraw();
        if (block.timestamp < req.unlockTime) revert WithdrawNotReady();
        if (balances[msg.sender] < req.amount) revert InsufficientBalance();

        delete pendingWithdrawals[msg.sender];
        balances[msg.sender] -= req.amount;

        (bool success,) = msg.sender.call{value: req.amount}("");
        if (!success) revert TransferFailed();

        emit WithdrawExecuted(msg.sender, req.amount);
    }

    /**
     * @notice P1-3: 取消待处理的提款
     */
    function cancelWithdraw() external {
        WithdrawRequest memory req = pendingWithdrawals[msg.sender];
        if (req.amount == 0) revert NoPendingWithdraw();
        delete pendingWithdrawals[msg.sender];
        emit WithdrawCancelled(msg.sender, req.amount);
    }

    // ============================================================
    // View Functions
    // ============================================================

    function getBalance(address user) external view returns (uint256) {
        return balances[user];
    }

    function getLockedBalance(address user) external view returns (uint256) {
        return lockedBalances[user];
    }

    function getTotalBalance(address user) external view returns (uint256) {
        return balances[user] + lockedBalances[user];
    }

    // H-016: 获取用户待领取盈利
    function getPendingProfit(address user) external view returns (uint256) {
        return pendingProfits[user];
    }

    // ============================================================
    // User Claim Functions
    // ============================================================

    /**
     * @notice 领取待支付的盈利
     * @dev H-016: 用户可以在保险基金有资金时领取之前未支付的盈利
     */
    function claimPendingProfit() external nonReentrant whenNotPaused {
        uint256 pending = pendingProfits[msg.sender];
        if (pending == 0) revert NoPendingProfit();

        // 检查保险基金是否有足够资金
        if (insuranceFund == address(0)) revert ZeroAddress();

        // 尝试从保险基金支付
        (bool success,) = insuranceFund.call(
            abi.encodeWithSignature("payProfit(address,uint256)", msg.sender, pending)
        );

        if (success) {
            // 支付成功，清除待领取记录
            pendingProfits[msg.sender] = 0;
            emit ProfitClaimed(msg.sender, pending);
        } else {
            // 保险基金仍然不足，不清除记录
            revert InsuranceFundInsufficient();
        }
    }

    /**
     * @notice 部分领取待支付的盈利
     * @dev H-016: 允许用户领取部分盈利（当保险基金资金不足以支付全部时）
     * @param amount 要领取的金额
     */
    function claimPartialPendingProfit(uint256 amount) external nonReentrant whenNotPaused {
        uint256 pending = pendingProfits[msg.sender];
        if (pending == 0) revert NoPendingProfit();
        if (amount == 0 || amount > pending) revert InvalidAmount();

        if (insuranceFund == address(0)) revert ZeroAddress();

        // 尝试从保险基金支付指定金额
        (bool success,) = insuranceFund.call(
            abi.encodeWithSignature("payProfit(address,uint256)", msg.sender, amount)
        );

        if (success) {
            pendingProfits[msg.sender] -= amount;
            emit ProfitClaimed(msg.sender, amount);
        } else {
            revert InsuranceFundInsufficient();
        }
    }

    // ============================================================
    // Authorized Contract Functions
    // ============================================================

    function lockMargin(address user, uint256 amount) external onlyAuthorized {
        if (balances[user] < amount) revert InsufficientBalance();

        balances[user] -= amount;
        lockedBalances[user] += amount;

        emit MarginLocked(user, amount);
    }

    function unlockMargin(address user, uint256 amount) external onlyAuthorized {
        if (lockedBalances[user] < amount) revert InsufficientLockedBalance();

        lockedBalances[user] -= amount;
        balances[user] += amount;

        emit MarginUnlocked(user, amount);
    }

    function settlePnL(address winner, address loser, uint256 amount) external onlyAuthorized {
        if (lockedBalances[loser] < amount) revert InsufficientLockedBalance();

        lockedBalances[loser] -= amount;
        balances[winner] += amount;

        emit PnLSettled(loser, winner, amount);
    }

    /**
     * @notice 结算盈利（平仓盈利时调用）
     * @dev 解锁用户保证金 + 从保险基金支付盈利
     *      H-010: 修复盈利支付逻辑，确保有实际 ETH 才能添加余额
     *      H-016: 保险基金不足时记录待领取盈利，用户可后续 claim
     * @param user 用户地址
     * @param collateral 解锁的保证金
     * @param profit 盈利金额
     */
    function settleProfit(address user, uint256 collateral, uint256 profit) external onlyAuthorized nonReentrant {
        // 解锁保证金
        if (lockedBalances[user] >= collateral) {
            lockedBalances[user] -= collateral;
            balances[user] += collateral;
        } else if (lockedBalances[user] > 0) {
            // 如果锁定余额不足，解锁所有可用的
            uint256 available = lockedBalances[user];
            lockedBalances[user] = 0;
            balances[user] += available;
        }

        // 从保险基金支付盈利
        uint256 actualProfit = 0;
        uint256 unpaidProfit = 0;
        if (profit > 0 && insuranceFund != address(0)) {
            // 调用保险基金支付（保险基金会直接转账给用户）
            (bool success,) = insuranceFund.call(
                abi.encodeWithSignature("payProfit(address,uint256)", user, profit)
            );
            if (success) {
                actualProfit = profit;
            } else {
                // H-016: 保险基金支付失败，记录待领取盈利
                unpaidProfit = profit;
                pendingProfits[user] += profit;
                emit ProfitPending(user, profit);
            }
        } else if (profit > 0) {
            // 没有设置保险基金，记录待领取
            unpaidProfit = profit;
            pendingProfits[user] += profit;
            emit ProfitPending(user, profit);
        }

        emit ProfitPaid(user, collateral, actualProfit);
    }

    /**
     * @notice 结算亏损（平仓亏损时调用）
     * @dev 从用户保证金扣除亏损，剩余返还用户
     *      H-013: 修复亏损结算逻辑，确保 ETH 正确转移到保险基金
     *      H-015: 修复原子性问题 - 先转移 ETH，再更新账本
     * @param user 用户地址
     * @param collateral 原始保证金
     * @param loss 亏损金额
     * @return actualLoss 实际扣除的亏损
     */
    function settleLoss(address user, uint256 collateral, uint256 loss) external onlyAuthorized nonReentrant returns (uint256 actualLoss) {
        // 获取用户实际锁定的保证金
        uint256 userLocked = lockedBalances[user];
        uint256 effectiveCollateral = collateral > userLocked ? userLocked : collateral;

        actualLoss = loss > effectiveCollateral ? effectiveCollateral : loss;
        uint256 returnAmount = effectiveCollateral - actualLoss;

        // H-015: 先转移 ETH 到保险基金，确保原子性
        // 如果转移失败，整个交易回滚，账本保持一致
        if (actualLoss > 0 && insuranceFund != address(0)) {
            // 确保 Vault 有足够的 ETH 余额
            if (address(this).balance >= actualLoss) {
                (bool success,) = insuranceFund.call{value: actualLoss}("");
                // H-015: 如果转移失败，回滚整个交易以保持账本一致性
                if (!success) revert TransferFailed();
            } else {
                // Vault ETH 不足是严重问题，应该回滚
                revert InsufficientBalance();
            }
        }

        // H-015: ETH 转移成功后，再更新账本
        // 清除锁定保证金
        if (userLocked >= effectiveCollateral) {
            lockedBalances[user] -= effectiveCollateral;
        } else {
            lockedBalances[user] = 0;
        }

        // 返还剩余保证金给用户
        if (returnAmount > 0) {
            balances[user] += returnAmount;
        }

        emit LossCollected(user, effectiveCollateral, actualLoss);
    }

    /**
     * @notice 处理穿仓（亏损超过保证金）
     * @dev 用保险基金覆盖亏空
     *      H-014: 修复穿仓结算 - 用户保证金必须转移到保险基金
     * @param user 用户地址
     * @param collateral 原始保证金（全部损失）
     * @param deficit 亏空金额（超出保证金的部分）
     * @return coveredDeficit 保险基金覆盖的金额
     */
    function settleBankruptcy(address user, uint256 collateral, uint256 deficit) external onlyAuthorized nonReentrant returns (uint256 coveredDeficit) {
        // H-014: 获取用户实际锁定的保证金
        uint256 userLocked = lockedBalances[user];
        uint256 actualCollateral = collateral > userLocked ? userLocked : collateral;

        // 清除用户所有锁定保证金
        lockedBalances[user] = 0;

        // H-014: 将用户的保证金 ETH 转移到保险基金
        // 这部分 ETH 是用户亏损的，应该进入保险基金
        // AUDIT-FIX SC-C03: 保险基金转账失败不再静默忽略，而是触发事件
        // 管理员可通过事件监控并手动处理失败转账
        if (actualCollateral > 0 && insuranceFund != address(0)) {
            if (address(this).balance >= actualCollateral) {
                (bool collateralSuccess,) = insuranceFund.call{value: actualCollateral}("");
                if (!collateralSuccess) {
                    emit InsuranceTransferFailed(user, actualCollateral);
                }
            } else {
                emit InsuranceTransferFailed(user, actualCollateral);
            }
        }

        // 从保险基金覆盖亏空（deficit 是超出保证金的部分）
        // AUDIT-FIX SC-C04: 使用 IInsuranceFund 接口调用 coverDeficit()
        // 旧代码用 insuranceFund.balance 做预检查（忽略 minReserve），且低级 call 丢弃返回值
        // coverDeficit() 内部已正确处理 minReserve 和可用余额上限，直接信任其返回值
        if (deficit > 0 && insuranceFund != address(0)) {
            try IInsuranceFund(insuranceFund).coverDeficit(deficit) returns (uint256 covered) {
                coveredDeficit = covered;
            } catch {
                coveredDeficit = 0;
            }
        }

        emit BankruptcyHandled(user, collateral, deficit, coveredDeficit);
    }

    function distributeLiquidation(
        address liquidatedUser,
        address liquidator,
        uint256 liquidatorReward,
        uint256 remainingToPool
    ) external onlyAuthorized nonReentrant {
        uint256 totalAmount = liquidatorReward + remainingToPool;
        uint256 userLocked = lockedBalances[liquidatedUser];

        // 计算用户能支付多少
        uint256 fromUser = userLocked >= totalAmount ? totalAmount : userLocked;
        uint256 shortfall = totalAmount > userLocked ? totalAmount - userLocked : 0;

        // 扣除用户锁定余额
        if (fromUser > 0) {
            lockedBalances[liquidatedUser] -= fromUser;
        }

        // 如果用户余额不足，从保险基金补足
        uint256 fromInsurance = 0;
        if (shortfall > 0 && insuranceFund != address(0)) {
            // 尝试从保险基金获取差额
            try IInsuranceFund(insuranceFund).coverDeficit(shortfall) returns (uint256 covered) {
                fromInsurance = covered;
            } catch {
                // 保险基金也不够，只能支付部分奖励
            }
        }

        // 支付清算人奖励
        uint256 actualReward = liquidatorReward;
        if (shortfall > 0) {
            // 按比例减少奖励（如果保险基金也不够）
            uint256 totalAvailable = fromUser + fromInsurance;
            if (totalAvailable < totalAmount) {
                // 优先支付清算人奖励
                actualReward = totalAvailable >= liquidatorReward ? liquidatorReward : totalAvailable;
            }
        }

        if (actualReward > 0) {
            balances[liquidator] += actualReward;
        }

        // 剩余资金转入 LP 池
        uint256 actualRemaining = (fromUser + fromInsurance) > actualReward
            ? (fromUser + fromInsurance) - actualReward
            : 0;
        if (actualRemaining > 0 && lendingPool != address(0)) {
            (bool success,) = lendingPool.call{value: actualRemaining}("");
            if (!success) revert TransferFailed();
        }

        emit Liquidated(liquidatedUser, liquidator, actualReward, actualRemaining);
    }

    function transferFromLocked(address from, address to, uint256 amount) external onlyAuthorized {
        if (lockedBalances[from] < amount) revert InsufficientLockedBalance();

        lockedBalances[from] -= amount;
        lockedBalances[to] += amount;

        // L-004: Emit event for locked balance transfer
        emit LockedBalanceTransferred(from, to, amount);
    }

    /**
     * @notice 收取手续费
     * @dev 从用户可用余额中扣除手续费，转移到指定接收地址
     * @param user 用户地址
     * @param feeReceiver 手续费接收地址
     * @param amount 手续费金额
     */
    function collectFee(address user, address feeReceiver, uint256 amount) external onlyAuthorized {
        if (amount == 0) return;
        if (balances[user] < amount) revert InsufficientBalance();
        if (feeReceiver == address(0)) revert ZeroAddress();

        balances[user] -= amount;
        balances[feeReceiver] += amount;

        emit FeeCollected(user, feeReceiver, amount);
    }

    /**
     * @notice 从锁定保证金收取手续费
     * @dev 用于平仓时从锁定保证金扣除手续费
     * @param user 用户地址
     * @param feeReceiver 手续费接收地址
     * @param amount 手续费金额
     */
    function collectFeeFromLocked(address user, address feeReceiver, uint256 amount) external onlyAuthorized {
        if (amount == 0) return;
        if (lockedBalances[user] < amount) revert InsufficientLockedBalance();
        if (feeReceiver == address(0)) revert ZeroAddress();

        lockedBalances[user] -= amount;
        balances[feeReceiver] += amount;

        emit FeeCollected(user, feeReceiver, amount);
    }

    // ============================================================
    // Receive Function
    // ============================================================

    receive() external payable {
        balances[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value, block.timestamp);
    }
}
