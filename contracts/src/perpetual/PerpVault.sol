// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./IPerpVault.sol";

/**
 * @title PerpVault
 * @notice GMX/HLP-style LP pool as counterparty for all perpetual trades
 * @dev Global pool covering all Quanto token perpetuals.
 *      LPs deposit ETH and receive pETH shares.
 *      Traders' losses increase pool value (LP profit).
 *      Traders' profits decrease pool value (LP cost).
 *
 *      Share Price = poolValue / totalShares
 *      Pool Value  = address(this).balance - netPendingPnL
 *        (GMX-style: includes unrealized trader PnL in pool valuation)
 *
 * @dev Production audit: compared against GMX V1/V2, HyperLiquid, Jupiter JLP,
 *      Gains Network, dYdX, Synthetix V3. See PERPVAULT_AUDIT_REPORT.md
 */
contract PerpVault is IPerpVault, Ownable, ReentrancyGuard, Pausable {
    // ============================================================
    // Constants
    // ============================================================

    uint256 public constant PRECISION = 1e18;
    uint256 public constant FEE_PRECISION = 10000; // basis points

    /// @notice Maximum utilization ratio — OI cannot exceed this % of pool value (Meme 币需更低)
    uint256 public maxUtilization = 5000; // 50% (was 80%, meme 币 50% 回撤 → 80% 利用 = 40% 池子蒸发)

    /// @notice Maximum configurable cooldown
    uint256 public constant MAX_COOLDOWN = 7 days;

    /// @notice Minimum pool liquidity after withdrawal
    uint256 public constant MIN_LIQUIDITY = 0.1 ether;

    /// @notice Minimum deposit amount
    uint256 public constant MIN_DEPOSIT = 0.001 ether;

    /// @notice Dead shares minted on first deposit to prevent inflation attack
    /// @dev See: OpenZeppelin ERC4626 "virtual shares" pattern
    uint256 public constant DEAD_SHARES = 1000;

    /// @notice Deposit/withdrawal fee in basis points (Meme 池需更高费用抑制频繁进出)
    uint256 public depositFeeBps = 50;    // 0.5% (was 0.3%)
    uint256 public withdrawalFeeBps = 50; // 0.5% (was 0.3%)

    /// @notice Dead address for burning shares
    address public constant DEAD_ADDRESS = address(0xdEaD);

    /// @notice ADL threshold — trigger when pending profits exceed this % of pool balance (Meme 币提前触发)
    uint256 public adlThresholdBps = 7000; // 70% (was 90%, 防止 90% → 150% 之间的死区)

    // ============================================================
    // State Variables
    // ============================================================

    /// @notice Total pETH shares outstanding
    uint256 public totalShares;

    /// @notice Total fees collected (cumulative, for statistics)
    uint256 public totalFeesCollected;

    /// @notice Total profits paid to traders (cumulative, for statistics)
    uint256 public totalProfitsPaid;

    /// @notice Total losses received from traders (cumulative, for statistics)
    uint256 public totalLossesReceived;

    /// @notice Total liquidation collateral received (cumulative, for statistics)
    uint256 public totalLiquidationReceived;

    // ── C1: Unrealized PnL tracking (GMX-style) ──

    /// @notice Net pending PnL of all open positions
    /// @dev Positive = traders in net profit (pool liability)
    ///      Negative = traders in net loss (pool asset)
    ///      Updated by matching engine on every trade / price change
    ///      GMX V1: guaranteedUsd + globalShortDelta in getAum()
    ///      GMX V2: getNetPnl() in MarketUtils
    int256 public netPendingPnL;

    // ── H1: Configurable cooldown (GMX-style) ──

    /// @notice Withdrawal cooldown period (owner-adjustable, GMX allows up to 48h)
    uint256 public withdrawalCooldown = 24 hours;

    // ── H2: Deposit cap / private mode (GMX inPrivateMode + maxUsdgAmount) ──

    /// @notice Maximum pool value allowed (0 = unlimited)
    uint256 public maxPoolValue;

    /// @notice Pause deposits only (without pausing all operations)
    bool public depositsPaused;

    // ── Per-token OI tracking (in ETH value) ──

    mapping(address => uint256) public longOI;
    mapping(address => uint256) public shortOI;
    mapping(address => uint256) public maxOIPerToken;

    /// @notice List of tokens with non-zero OI (for iteration)
    address[] public oiTokens;
    mapping(address => bool) public isOIToken;

    /// @notice Accumulated total OI (avoids looping oiTokens array)
    uint256 public totalOIAccumulator;

    // ── LP state ──

    mapping(address => uint256) public shares;
    mapping(address => uint256) public lastDepositAt;          // GMX-style: cooldown from deposit time
    mapping(address => uint256) public withdrawalAmount;       // Shares requested for withdrawal
    mapping(address => uint256) public withdrawalTimestamp;     // When withdrawal was requested

    // ── Authorization ──

    mapping(address => bool) public authorizedContracts;

    /// @notice Vault contract address (for sending trader profits)
    address public vault;

    // ============================================================
    // Events
    // ============================================================

    event Deposit(address indexed lp, uint256 ethAmount, uint256 sharesReceived, uint256 sharePrice, uint256 fee);
    event WithdrawalRequested(address indexed lp, uint256 shares, uint256 timestamp);
    event WithdrawalExecuted(address indexed lp, uint256 shares, uint256 ethReceived, uint256 sharePrice, uint256 fee);
    event WithdrawalCancelled(address indexed lp, uint256 shares);
    event TraderProfitSettled(address indexed trader, uint256 profitETH);
    event TraderLossSettled(uint256 lossETH);
    event LiquidationSettled(address indexed liquidator, uint256 collateralETH, uint256 liquidatorReward);
    event OIIncreased(address indexed token, bool isLong, uint256 sizeETH, uint256 newOI);
    event OIDecreased(address indexed token, bool isLong, uint256 sizeETH, uint256 newOI);
    event FeeCollected(uint256 feeETH);
    event ContractAuthorized(address indexed contractAddr, bool authorized);
    event VaultSet(address indexed vault);
    event MaxOIPerTokenSet(address indexed token, uint256 maxOI);
    // C1: Unrealized PnL
    event PendingPnLUpdated(int256 oldPnL, int256 newPnL);
    // C2: ADL
    event ADLTriggered(uint256 pendingProfit, uint256 poolBalance);
    event TraderProfitSettledPartial(address indexed trader, uint256 requestedETH, uint256 actualETH);
    // H1: Configurable cooldown
    event CooldownUpdated(uint256 oldCooldown, uint256 newCooldown);
    // H2: Deposit cap / pause
    event MaxPoolValueSet(uint256 maxValue);
    event DepositsPausedSet(bool paused);

    // ============================================================
    // Errors
    // ============================================================

    error Unauthorized();
    error ZeroAddress();
    error InvalidAmount();
    error InsufficientPoolBalance();
    error ExceedsMaxOI();
    error NoWithdrawalPending();
    error CooldownNotMet();
    error BelowMinLiquidity();
    error InsufficientShares();
    error TransferFailed();
    error SlippageExceeded();
    error InsufficientPoolForOI();
    error DepositsPausedError();
    error ExceedsMaxPoolValue();
    error CooldownTooLong();

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

    function setVault(address _vault) external onlyOwner {
        if (_vault == address(0)) revert ZeroAddress();
        vault = _vault;
        emit VaultSet(_vault);
    }

    function setMaxOIPerToken(address token, uint256 maxOI) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        maxOIPerToken[token] = maxOI;
        emit MaxOIPerTokenSet(token, maxOI);
    }

    /// @notice H1: Set withdrawal cooldown (GMX-style, owner-adjustable)
    /// @param _cooldown New cooldown period (max MAX_COOLDOWN)
    function setCooldown(uint256 _cooldown) external onlyOwner {
        if (_cooldown > MAX_COOLDOWN) revert CooldownTooLong();
        emit CooldownUpdated(withdrawalCooldown, _cooldown);
        withdrawalCooldown = _cooldown;
    }

    /// @notice H2: Set maximum pool value (GMX maxUsdgAmount equivalent)
    /// @param _maxValue Maximum allowed pool value (0 = unlimited)
    function setMaxPoolValue(uint256 _maxValue) external onlyOwner {
        maxPoolValue = _maxValue;
        emit MaxPoolValueSet(_maxValue);
    }

    /// @notice H2: Pause/unpause deposits only (GMX inPrivateMode equivalent)
    function setDepositsPaused(bool _paused) external onlyOwner {
        depositsPaused = _paused;
        emit DepositsPausedSet(_paused);
    }

    /// @notice 设置最大利用率（OI 不能超过池子价值的此比例）
    function setMaxUtilization(uint256 _bps) external onlyOwner {
        require(_bps >= 3000 && _bps <= 9500, "Out of range"); // 30%-95%
        maxUtilization = _bps;
    }

    /// @notice 设置 ADL 触发阈值
    function setAdlThreshold(uint256 _bps) external onlyOwner {
        require(_bps >= 5000 && _bps <= 9500, "Out of range"); // 50%-95%
        adlThresholdBps = _bps;
    }

    /// @notice 设置存取费率
    function setFees(uint256 _depositBps, uint256 _withdrawalBps) external onlyOwner {
        require(_depositBps <= 200 && _withdrawalBps <= 200, "Fee too high"); // Max 2%
        depositFeeBps = _depositBps;
        withdrawalFeeBps = _withdrawalBps;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ============================================================
    // LP Functions
    // ============================================================

    /**
     * @notice Deposit ETH and receive pETH shares
     * @dev First deposit mints DEAD_SHARES to address(0xdEaD) to prevent inflation attack.
     *      Deposit fee is deducted and stays in pool (benefits existing LPs).
     *      GMX-style: tracks lastDepositAt for cooldown enforcement on withdrawal.
     */
    function deposit() external payable nonReentrant whenNotPaused {
        _deposit(0);
    }

    /**
     * @notice Deposit ETH with slippage protection
     * @param minSharesOut Minimum shares to receive (reverts if below)
     */
    function depositWithSlippage(uint256 minSharesOut) external payable nonReentrant whenNotPaused {
        _deposit(minSharesOut);
    }

    function _deposit(uint256 minSharesOut) internal {
        // H2: Check deposit pause (GMX inPrivateMode equivalent)
        if (depositsPaused) revert DepositsPausedError();
        if (msg.value < MIN_DEPOSIT) revert InvalidAmount();

        // Deduct deposit fee (stays in pool → benefits existing LPs)
        uint256 fee = (msg.value * depositFeeBps) / FEE_PRECISION;
        uint256 depositAmount = msg.value - fee;

        uint256 sharesToMint;

        if (totalShares == 0) {
            // First deposit: mint dead shares to prevent inflation attack
            // See: OpenZeppelin ERC4626 "virtual shares" pattern
            sharesToMint = depositAmount - DEAD_SHARES;
            if (sharesToMint == 0) revert InvalidAmount();

            // Mint dead shares to burn address (permanently locked)
            shares[DEAD_ADDRESS] = DEAD_SHARES;
            totalShares = DEAD_SHARES;
        } else {
            // C1: Use getPoolValue() which now includes unrealized PnL
            // GMX V1: uses getAumInUsdg(true) (maximized) for deposits
            // Note: address(this).balance already includes msg.value, so we calculate
            // poolValueBefore = (balance - msg.value) adjusted for pending PnL
            uint256 rawBalanceBefore = address(this).balance - msg.value;
            int256 adjustedBefore = int256(rawBalanceBefore) - netPendingPnL;
            uint256 poolValueBefore = adjustedBefore > 0 ? uint256(adjustedBefore) : 0;

            if (poolValueBefore == 0) {
                sharesToMint = depositAmount;
            } else {
                sharesToMint = (depositAmount * totalShares) / poolValueBefore;
            }
        }

        if (sharesToMint == 0) revert InvalidAmount();
        if (minSharesOut > 0 && sharesToMint < minSharesOut) revert SlippageExceeded();

        shares[msg.sender] += sharesToMint;
        totalShares += sharesToMint;
        lastDepositAt[msg.sender] = block.timestamp;

        totalFeesCollected += fee;

        // H2: Check max pool value after deposit (GMX maxUsdgAmount equivalent)
        if (maxPoolValue > 0 && getPoolValue() > maxPoolValue) revert ExceedsMaxPoolValue();

        emit Deposit(msg.sender, msg.value, sharesToMint, getSharePrice(), fee);
    }

    /**
     * @notice Request withdrawal (starts 24h cooldown)
     * @param shareAmount Number of shares to withdraw
     */
    function requestWithdrawal(uint256 shareAmount) external whenNotPaused {
        if (shareAmount == 0) revert InvalidAmount();

        // Include any already-pending shares in the check
        uint256 availableShares = shares[msg.sender] - withdrawalAmount[msg.sender];
        if (shareAmount > availableShares) revert InsufficientShares();

        withdrawalAmount[msg.sender] += shareAmount;
        withdrawalTimestamp[msg.sender] = block.timestamp;

        emit WithdrawalRequested(msg.sender, shareAmount, block.timestamp);
    }

    /**
     * @notice Execute withdrawal after cooldown
     * @dev Burns shares, deducts fee, sends ETH at current share price.
     *      Cooldown is enforced from DEPOSIT time (GMX-style), not request time.
     *      Pool must retain enough ETH to cover active OI after withdrawal.
     */
    function executeWithdrawal() external nonReentrant whenNotPaused {
        _executeWithdrawal(0);
    }

    /**
     * @notice Execute withdrawal with slippage protection
     * @param minETHOut Minimum ETH to receive (after fee)
     */
    function executeWithdrawalWithSlippage(uint256 minETHOut) external nonReentrant whenNotPaused {
        _executeWithdrawal(minETHOut);
    }

    function _executeWithdrawal(uint256 minETHOut) internal {
        uint256 pendingShares = withdrawalAmount[msg.sender];
        if (pendingShares == 0) revert NoWithdrawalPending();

        // H1: GMX-style cooldown with configurable duration
        if (block.timestamp < lastDepositAt[msg.sender] + withdrawalCooldown) {
            revert CooldownNotMet();
        }
        // Also enforce from request time (belt and suspenders)
        if (block.timestamp < withdrawalTimestamp[msg.sender] + withdrawalCooldown) {
            revert CooldownNotMet();
        }

        // Calculate ETH to return at current share price
        uint256 grossETH = (pendingShares * getSharePrice()) / PRECISION;

        // Deduct withdrawal fee (stays in pool)
        uint256 fee = (grossETH * withdrawalFeeBps) / FEE_PRECISION;
        uint256 ethAmount = grossETH - fee;

        if (grossETH > address(this).balance) revert InsufficientPoolBalance();

        // Check minimum liquidity after withdrawal
        // Exception: if only dead shares remain after this withdrawal, allow full exit
        uint256 remainingBalance = address(this).balance - grossETH;
        uint256 remainingUserShares = totalShares - pendingShares;
        bool onlyDeadSharesRemain = remainingUserShares <= DEAD_SHARES;
        if (remainingBalance < MIN_LIQUIDITY && remainingBalance != 0 && !onlyDeadSharesRemain) {
            revert BelowMinLiquidity();
        }

        // Safety: pool must retain enough to cover active OI
        // Pool after withdrawal should be >= totalOI (at minimum)
        uint256 poolAfter = address(this).balance - grossETH;
        uint256 currentOI = totalOIAccumulator;
        if (currentOI > 0 && poolAfter > 0 && poolAfter < currentOI) {
            revert InsufficientPoolForOI();
        }

        // Slippage protection
        if (minETHOut > 0 && ethAmount < minETHOut) revert SlippageExceeded();

        // Clear pending withdrawal
        withdrawalAmount[msg.sender] = 0;
        withdrawalTimestamp[msg.sender] = 0;

        // Burn shares (fee portion stays as poolValue increase for remaining LPs)
        shares[msg.sender] -= pendingShares;
        totalShares -= pendingShares;
        totalFeesCollected += fee;

        // Send ETH (net of fee)
        (bool success,) = msg.sender.call{value: ethAmount}("");
        if (!success) revert TransferFailed();

        emit WithdrawalExecuted(msg.sender, pendingShares, ethAmount, getSharePrice(), fee);
    }

    /**
     * @notice Cancel pending withdrawal
     */
    function cancelWithdrawal() external {
        uint256 pendingShares = withdrawalAmount[msg.sender];
        if (pendingShares == 0) revert NoWithdrawalPending();

        withdrawalAmount[msg.sender] = 0;
        withdrawalTimestamp[msg.sender] = 0;

        emit WithdrawalCancelled(msg.sender, pendingShares);
    }

    // ============================================================
    // C1: Unrealized PnL Tracking (GMX-style)
    // ============================================================

    /**
     * @notice Update net pending PnL of all open positions
     * @param _netPnL Net pending PnL (positive = traders profiting = pool liability)
     * @dev Called by matching engine on every trade / price change.
     *      GMX V1 equivalent: guaranteedUsd + globalShortDelta in getAum()
     *      GMX V2 equivalent: getNetPnl() in MarketUtils
     *      Jupiter equivalent: unrealized_pnl in AUM calculation
     */
    function updatePendingPnL(int256 _netPnL) external onlyAuthorized {
        emit PendingPnLUpdated(netPendingPnL, _netPnL);
        netPendingPnL = _netPnL;
    }

    // ============================================================
    // Settlement Functions (called by matching engine)
    // ============================================================

    /**
     * @notice Settle trader profit — pool pays from its ETH
     * @param trader Trader address (for event logging)
     * @param profitETH Amount of ETH profit to pay
     * @dev Sends ETH to the Vault contract, which credits the trader's balance.
     *      C2: If pool balance insufficient, pays what's available (ADL partial settlement).
     */
    function settleTraderProfit(address trader, uint256 profitETH) external onlyAuthorized nonReentrant {
        if (profitETH == 0) return;

        // C2: ADL-aware settlement — pay what's available instead of reverting
        uint256 actualPay = profitETH;
        if (address(this).balance < profitETH) {
            // ADL scenario: can only pay partial profit
            actualPay = address(this).balance;
            emit ADLTriggered(profitETH, address(this).balance);
            if (actualPay == 0) revert InsufficientPoolBalance();
        }

        totalProfitsPaid += actualPay;

        // Send profit to Vault (Vault will credit trader's available balance)
        if (vault != address(0)) {
            (bool success,) = vault.call{value: actualPay}("");
            if (!success) revert TransferFailed();
        } else {
            // Fallback: send directly to trader
            (bool success,) = trader.call{value: actualPay}("");
            if (!success) revert TransferFailed();
        }

        if (actualPay < profitETH) {
            emit TraderProfitSettledPartial(trader, profitETH, actualPay);
        } else {
            emit TraderProfitSettled(trader, profitETH);
        }
    }

    /**
     * @notice Settle trader loss — pool receives ETH
     * @param lossETH Amount of ETH loss received
     * @dev ETH is sent along with the call (msg.value)
     */
    function settleTraderLoss(uint256 lossETH) external payable onlyAuthorized {
        if (msg.value != lossETH) revert InvalidAmount();
        totalLossesReceived += lossETH;
        emit TraderLossSettled(lossETH);
    }

    /**
     * @notice Settle liquidation — pool receives collateral, pays liquidator reward
     * @param collateralETH Total collateral from liquidated position
     * @param liquidatorReward Reward for the liquidator
     * @param liquidator Liquidator address
     * @dev ETH is sent along with the call (msg.value = collateralETH)
     */
    function settleLiquidation(
        uint256 collateralETH,
        uint256 liquidatorReward,
        address liquidator
    ) external payable onlyAuthorized nonReentrant {
        if (msg.value != collateralETH) revert InvalidAmount();
        if (liquidatorReward > collateralETH) revert InvalidAmount();

        totalLiquidationReceived += collateralETH;

        // Pay liquidator reward
        if (liquidatorReward > 0 && liquidator != address(0)) {
            (bool success,) = liquidator.call{value: liquidatorReward}("");
            if (!success) revert TransferFailed();
        }

        // Remaining stays in pool (collateralETH - liquidatorReward)
        emit LiquidationSettled(liquidator, collateralETH, liquidatorReward);
    }

    // ============================================================
    // OI Tracking
    // ============================================================

    /**
     * @notice Increase open interest for a token
     * @param token Token address
     * @param isLong Whether the position is long
     * @param sizeETH Position size in ETH
     */
    function increaseOI(address token, bool isLong, uint256 sizeETH) external onlyAuthorized {
        if (sizeETH == 0) return;

        // Track token in list (for informational queries)
        if (!isOIToken[token]) {
            oiTokens.push(token);
            isOIToken[token] = true;
        }

        if (isLong) {
            longOI[token] += sizeETH;
            emit OIIncreased(token, true, sizeETH, longOI[token]);
        } else {
            shortOI[token] += sizeETH;
            emit OIIncreased(token, false, sizeETH, shortOI[token]);
        }

        // Update accumulator (O(1) instead of looping oiTokens array)
        totalOIAccumulator += sizeETH;

        // Check global OI limit
        uint256 maxOI = getMaxOI();
        if (maxOI > 0 && totalOIAccumulator > maxOI) revert ExceedsMaxOI();

        // Check per-token OI limit (if set)
        uint256 tokenMax = maxOIPerToken[token];
        if (tokenMax > 0 && (longOI[token] + shortOI[token]) > tokenMax) {
            revert ExceedsMaxOI();
        }
    }

    /**
     * @notice Decrease open interest for a token
     * @param token Token address
     * @param isLong Whether the position is long
     * @param sizeETH Position size in ETH
     */
    function decreaseOI(address token, bool isLong, uint256 sizeETH) external onlyAuthorized {
        if (sizeETH == 0) return;

        if (isLong) {
            uint256 decreased = longOI[token] > sizeETH ? sizeETH : longOI[token];
            longOI[token] -= decreased;
            totalOIAccumulator = totalOIAccumulator > decreased ? totalOIAccumulator - decreased : 0;
            emit OIDecreased(token, true, sizeETH, longOI[token]);
        } else {
            uint256 decreased = shortOI[token] > sizeETH ? sizeETH : shortOI[token];
            shortOI[token] -= decreased;
            totalOIAccumulator = totalOIAccumulator > decreased ? totalOIAccumulator - decreased : 0;
            emit OIDecreased(token, false, sizeETH, shortOI[token]);
        }
    }

    // ============================================================
    // Fee Functions
    // ============================================================

    /**
     * @notice Collect trading fee — ETH goes directly into the pool
     * @param feeETH Fee amount
     * @dev Increases pool value → increases share price for all LPs
     */
    function collectFee(uint256 feeETH) external payable onlyAuthorized {
        if (msg.value != feeETH) revert InvalidAmount();
        totalFeesCollected += feeETH;
        emit FeeCollected(feeETH);
    }

    // ============================================================
    // View Functions
    // ============================================================

    /**
     * @notice Get total pool value in ETH (includes unrealized PnL)
     * @dev C1: GMX-style pool value calculation:
     *      poolValue = balance - netPendingPnL
     *      When traders profit (netPendingPnL > 0), pool value decreases
     *      When traders lose (netPendingPnL < 0), pool value increases
     *      GMX V1: getAum() = poolAmounts + guaranteedUsd + globalShortDelta - shortProfits
     *      GMX V2: poolValue = deposited + pendingPnL + pendingBorrowFees
     *      Jupiter: aum = nav ± unrealized_pnl
     */
    function getPoolValue() public view returns (uint256) {
        int256 adjusted = int256(address(this).balance) - netPendingPnL;
        return adjusted > 0 ? uint256(adjusted) : 0;
    }

    /**
     * @notice Get raw ETH balance (without PnL adjustment)
     * @dev Useful for checking actual available ETH for settlements
     */
    function getRawBalance() public view returns (uint256) {
        return address(this).balance;
    }

    /**
     * @notice Get current share price (1e18 precision)
     * @dev sharePrice = poolValue * PRECISION / totalShares
     *      C1: Now uses PnL-adjusted pool value
     */
    function getSharePrice() public view returns (uint256) {
        if (totalShares == 0) return PRECISION; // Default: 1 share = 1 ETH
        uint256 poolValue = getPoolValue();
        if (poolValue == 0) return 0;
        return (poolValue * PRECISION) / totalShares;
    }

    /**
     * @notice Get maximum total OI allowed (80% of pool value)
     */
    function getMaxOI() public view returns (uint256) {
        return (getPoolValue() * maxUtilization) / FEE_PRECISION;
    }

    /**
     * @notice C2: Check if ADL should be triggered
     * @dev GMX V2: isPnlFactorExceeded() checks pnlToPoolFactor > MAX_PNL_FACTOR_FOR_ADL
     *      HyperLiquid: triggers when HLP margin insufficient
     * @return shouldTrigger Whether ADL should be triggered
     * @return pnlToPoolBps Current PnL to pool ratio in basis points
     */
    function shouldADL() public view returns (bool shouldTrigger, uint256 pnlToPoolBps) {
        if (netPendingPnL <= 0) return (false, 0);
        uint256 pendingProfit = uint256(netPendingPnL);
        uint256 rawBalance = address(this).balance;
        if (rawBalance == 0) return (true, type(uint256).max);
        pnlToPoolBps = (pendingProfit * FEE_PRECISION) / rawBalance;
        shouldTrigger = pnlToPoolBps >= adlThresholdBps;
    }

    /**
     * @notice Get total OI across all tokens (O(1) via accumulator)
     */
    function getTotalOI() public view returns (uint256) {
        return totalOIAccumulator;
    }

    /**
     * @notice Get LP's current value in ETH
     */
    function getLPValue(address lp) external view returns (uint256) {
        if (totalShares == 0) return 0;
        return (shares[lp] * getSharePrice()) / PRECISION;
    }

    /**
     * @notice Get OI for a specific token
     */
    function getTokenOI(address token) external view returns (uint256 long_, uint256 short_) {
        return (longOI[token], shortOI[token]);
    }

    /**
     * @notice Get pool utilization ratio (basis points)
     */
    function getUtilization() external view returns (uint256) {
        uint256 poolValue = getPoolValue();
        if (poolValue == 0) return 0;
        return (getTotalOI() * FEE_PRECISION) / poolValue;
    }

    /**
     * @notice Get LP withdrawal info
     */
    function getWithdrawalInfo(address lp) external view returns (
        uint256 pendingShares,
        uint256 requestTime,
        uint256 executeAfter,
        uint256 estimatedETH
    ) {
        pendingShares = withdrawalAmount[lp];
        requestTime = withdrawalTimestamp[lp];
        executeAfter = requestTime > 0 ? requestTime + withdrawalCooldown : 0;
        estimatedETH = totalShares > 0 ? (pendingShares * getSharePrice()) / PRECISION : 0;
    }

    /**
     * @notice Get pool statistics
     */
    function getPoolStats() external view returns (
        uint256 poolValue,
        uint256 sharePrice,
        uint256 _totalShares,
        uint256 totalOI,
        uint256 maxOI,
        uint256 utilization,
        uint256 _totalFeesCollected,
        uint256 _totalProfitsPaid,
        uint256 _totalLossesReceived,
        uint256 _totalLiquidationReceived
    ) {
        poolValue = getPoolValue();
        sharePrice = getSharePrice();
        _totalShares = totalShares;
        totalOI = getTotalOI();
        maxOI = getMaxOI();
        utilization = poolValue > 0 ? (totalOI * FEE_PRECISION) / poolValue : 0;
        _totalFeesCollected = totalFeesCollected;
        _totalProfitsPaid = totalProfitsPaid;
        _totalLossesReceived = totalLossesReceived;
        _totalLiquidationReceived = totalLiquidationReceived;
    }

    /**
     * @notice Get extended pool stats including new fields
     */
    function getExtendedStats() external view returns (
        int256 _netPendingPnL,
        uint256 rawBalance,
        uint256 _withdrawalCooldown,
        uint256 _maxPoolValue,
        bool _depositsPaused,
        bool adlNeeded,
        uint256 adlPnlBps
    ) {
        _netPendingPnL = netPendingPnL;
        rawBalance = address(this).balance;
        _withdrawalCooldown = withdrawalCooldown;
        _maxPoolValue = maxPoolValue;
        _depositsPaused = depositsPaused;
        (adlNeeded, adlPnlBps) = shouldADL();
    }

    /**
     * @notice Get number of tracked OI tokens
     */
    function getOITokenCount() external view returns (uint256) {
        return oiTokens.length;
    }

    // ============================================================
    // Emergency Functions
    // ============================================================

    /**
     * @notice Emergency rescue ETH (owner only)
     */
    function emergencyRescue(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount > address(this).balance) revert InsufficientPoolBalance();
        (bool success,) = to.call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    // ============================================================
    // Receive
    // ============================================================

    /// @notice Accept ETH deposits (from Vault settlement or direct sends)
    receive() external payable {}
}
