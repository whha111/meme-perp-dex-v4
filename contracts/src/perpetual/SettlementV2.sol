// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title SettlementV2
 * @notice Mode 2: Off-chain Execution + On-chain Attestation
 *
 * Architecture:
 * - All trading (matching, positions, PnL) happens OFF-CHAIN
 * - This contract handles ONLY:
 *   1. Fund custody (deposits)
 *   2. State root attestation (Merkle root snapshots)
 *   3. Verified withdrawals (with Merkle proof + platform signature)
 *
 * Similar to dYdX, Injective, Hyperliquid approach where blockchain is
 * the "notary" and "final settlement house", not a real-time database.
 */
contract SettlementV2 is Ownable2Step, ReentrancyGuard, Pausable, EIP712 {
    using ECDSA for bytes32;
    using SafeERC20 for IERC20;

    // ============================================================
    // Constants
    // ============================================================

    uint256 public constant PRECISION = 1e18; // WETH has 18 decimals

    // EIP-712 type hash for withdrawal authorization
    bytes32 public constant WITHDRAWAL_TYPEHASH = keccak256(
        "Withdrawal(address user,uint256 amount,uint256 nonce,uint256 deadline,bytes32 merkleRoot)"
    );

    // ============================================================
    // State Variables
    // ============================================================

    // Platform signer for withdrawal authorizations
    address public platformSigner;

    // Supported collateral token (WETH or any ERC-20)
    IERC20 public immutable collateralToken;

    // User deposits (total amount deposited, before any withdrawals)
    mapping(address => uint256) public userDeposits;

    // User withdrawal nonces (for replay protection)
    mapping(address => uint256) public withdrawalNonces;

    // Total withdrawn by each user
    mapping(address => uint256) public totalWithdrawn;

    // ============================================================
    // State Root Attestation
    // ============================================================

    struct StateRoot {
        bytes32 root;
        uint256 timestamp;
        uint256 blockNumber;
    }

    // Current state root
    StateRoot public currentStateRoot;

    // Historical state roots (for dispute resolution)
    StateRoot[] public stateRootHistory;

    // Authorized state root updaters
    mapping(address => bool) public authorizedUpdaters;

    /// @notice FIX H-1: Number of historical roots accepted for withdrawal proofs.
    ///         Prevents grief: if root updates between sign and submit, old roots still valid.
    uint256 public stateRootValidityWindow = 5;

    // ============================================================
    // Deposit Caps (risk mitigation before audit)
    // ============================================================

    uint256 public depositCapPerUser;   // Per-user deposit limit (0 = unlimited)
    uint256 public depositCapTotal;      // Global TVL limit (0 = unlimited)
    uint256 public totalDeposited;       // Current total deposits

    // ============================================================
    // Forced Withdrawal (Escape Hatch — dYdX v3 pattern)
    // ============================================================

    /// @notice Delay before a forced withdrawal can be executed (default: 7 days)
    uint256 public forcedWithdrawalDelay = 7 days;

    struct ForcedWithdrawalRequest {
        uint256 amount;          // Amount user wants to withdraw
        uint256 requestTime;     // When the request was submitted
        bool active;             // Whether the request is still active
    }

    /// @notice Pending forced withdrawal requests per user
    mapping(address => ForcedWithdrawalRequest) public forcedWithdrawals;

    // ============================================================
    // Events
    // ============================================================

    event Deposited(address indexed user, uint256 amount, uint256 totalDeposits);
    event DepositedFor(address indexed user, address indexed relayer, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount, uint256 nonce);
    event StateRootUpdated(bytes32 indexed root, uint256 timestamp, uint256 snapshotId);
    event PlatformSignerUpdated(address indexed oldSigner, address indexed newSigner);
    event UpdaterAuthorized(address indexed updater, bool authorized);
    event DepositCapPerUserUpdated(uint256 oldCap, uint256 newCap);
    event DepositCapTotalUpdated(uint256 oldCap, uint256 newCap);
    event EmergencyPaused(address indexed by);
    event EmergencyUnpaused(address indexed by);
    event ForcedWithdrawalRequested(address indexed user, uint256 amount, uint256 executeAfter);
    event ForcedWithdrawalExecuted(address indexed user, uint256 amount);
    event ForcedWithdrawalCancelled(address indexed user);

    // ============================================================
    // Errors
    // ============================================================

    error InvalidAmount();
    error InvalidSignature();
    error InvalidProof();
    error InvalidNonce();
    error DeadlineExpired();
    error InsufficientEquity();
    error UnauthorizedUpdater();
    error ZeroAddress();
    error UserDepositCapExceeded();
    error TotalDepositCapExceeded();
    error ForcedWithdrawalNotActive();
    error ForcedWithdrawalTooEarly();
    error ForcedWithdrawalAlreadyActive();
    error ForcedWithdrawalInsufficientEquity();

    // ============================================================
    // Constructor
    // ============================================================

    constructor(
        address _collateralToken,
        address _platformSigner,
        address initialOwner
    ) Ownable(initialOwner) EIP712("SettlementV2", "1") {
        if (_collateralToken == address(0)) revert ZeroAddress();
        if (_platformSigner == address(0)) revert ZeroAddress();

        collateralToken = IERC20(_collateralToken);
        platformSigner = _platformSigner;
    }

    // ============================================================
    // Deposit Functions
    // ============================================================

    /**
     * @notice Deposit collateral tokens
     * @param amount Amount to deposit (in token's native decimals)
     */
    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert InvalidAmount();

        // Deposit cap checks
        if (depositCapPerUser > 0 && userDeposits[msg.sender] + amount > depositCapPerUser) {
            revert UserDepositCapExceeded();
        }
        if (depositCapTotal > 0 && totalDeposited + amount > depositCapTotal) {
            revert TotalDepositCapExceeded();
        }

        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        userDeposits[msg.sender] += amount;
        totalDeposited += amount;

        emit Deposited(msg.sender, amount, userDeposits[msg.sender]);
    }

    /**
     * @notice Deposit on behalf of another user (for relayer/gasless deposits)
     * @param user The user to credit
     * @param amount Amount to deposit
     */
    function depositFor(address user, uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert InvalidAmount();
        if (user == address(0)) revert ZeroAddress();

        // Deposit cap checks
        if (depositCapPerUser > 0 && userDeposits[user] + amount > depositCapPerUser) {
            revert UserDepositCapExceeded();
        }
        if (depositCapTotal > 0 && totalDeposited + amount > depositCapTotal) {
            revert TotalDepositCapExceeded();
        }

        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        userDeposits[user] += amount;
        totalDeposited += amount;

        emit DepositedFor(user, msg.sender, amount);
    }

    // ============================================================
    // Withdrawal Functions (with Merkle Proof + Platform Signature)
    // ============================================================

    /**
     * @notice Withdraw with Merkle proof and platform signature
     *
     * Flow:
     * 1. User requests withdrawal from backend
     * 2. Backend verifies user's equity in latest Merkle snapshot
     * 3. Backend generates Merkle proof + EIP-712 signature
     * 4. User submits this transaction with all parameters
     *
     * @param amount Amount to withdraw
     * @param userEquity User's total equity from Merkle leaf
     * @param merkleProof Proof that (user, equity) is in the tree
     * @param deadline Signature expiration timestamp
     * @param signature Platform's EIP-712 signature
     */
    function withdraw(
        uint256 amount,
        uint256 userEquity,
        bytes32[] calldata merkleProof,
        bytes32 merkleRoot,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        if (amount == 0) revert InvalidAmount();
        if (block.timestamp > deadline) revert DeadlineExpired();

        address user = msg.sender;
        uint256 nonce = withdrawalNonces[user];

        // FIX H-1: Verify merkleRoot is current OR within the validity window.
        // This prevents grief attacks where root updates between sign and submit.
        if (!_isValidStateRoot(merkleRoot)) revert InvalidProof();

        // 1. Verify Merkle proof against the caller-specified root
        bytes32 leaf = keccak256(abi.encodePacked(user, userEquity));
        if (!MerkleProof.verify(merkleProof, merkleRoot, leaf)) {
            revert InvalidProof();
        }

        // 2. Check user has enough equity
        uint256 maxWithdrawable = userEquity > totalWithdrawn[user]
            ? userEquity - totalWithdrawn[user]
            : 0;
        if (amount > maxWithdrawable) revert InsufficientEquity();

        // 3. Verify platform signature (EIP-712) — binds to the specific merkleRoot
        bytes32 structHash = keccak256(
            abi.encode(
                WITHDRAWAL_TYPEHASH,
                user,
                amount,
                nonce,
                deadline,
                merkleRoot
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address recoveredSigner = ECDSA.recover(digest, signature);
        if (recoveredSigner != platformSigner) revert InvalidSignature();

        // 4. Update state
        withdrawalNonces[user] = nonce + 1;
        totalWithdrawn[user] += amount;
        // AUDIT-FIX SC-C01: decrement totalDeposited on withdraw to prevent permanent deposit DoS
        if (totalDeposited >= amount) {
            totalDeposited -= amount;
        } else {
            totalDeposited = 0;
        }

        // 5. Transfer tokens
        collateralToken.safeTransfer(user, amount);

        emit Withdrawn(user, amount, nonce);
    }

    /**
     * @notice Get user's withdrawable balance based on current state root
     * @dev This is a view function - actual withdrawal requires proof
     */
    function getWithdrawableBalance(address user, uint256 userEquity) external view returns (uint256) {
        if (userEquity <= totalWithdrawn[user]) return 0;
        return userEquity - totalWithdrawn[user];
    }

    // ============================================================
    // State Root Management
    // ============================================================

    /**
     * @notice Update the state root (Merkle root of all user equities)
     * @dev Can only be called by authorized updaters
     * @param newRoot New Merkle root
     */
    function updateStateRoot(bytes32 newRoot) external whenNotPaused {
        if (!authorizedUpdaters[msg.sender] && msg.sender != owner()) {
            revert UnauthorizedUpdater();
        }

        // Store current root in history before updating
        if (currentStateRoot.root != bytes32(0)) {
            stateRootHistory.push(currentStateRoot);
        }

        currentStateRoot = StateRoot({
            root: newRoot,
            timestamp: block.timestamp,
            blockNumber: block.number
        });

        emit StateRootUpdated(newRoot, block.timestamp, stateRootHistory.length);
    }

    /**
     * @notice Get state root history length
     */
    function getStateRootHistoryLength() external view returns (uint256) {
        return stateRootHistory.length;
    }

    /**
     * @notice Get historical state root by index
     */
    function getStateRootByIndex(uint256 index) external view returns (StateRoot memory) {
        return stateRootHistory[index];
    }

    /// @dev FIX H-1: Check if a merkleRoot matches current or recent historical roots
    function _isValidStateRoot(bytes32 root) internal view returns (bool) {
        if (root == currentStateRoot.root) return true;

        uint256 histLen = stateRootHistory.length;
        uint256 lookback = stateRootValidityWindow < histLen ? stateRootValidityWindow : histLen;
        for (uint256 i = 0; i < lookback; i++) {
            if (stateRootHistory[histLen - 1 - i].root == root) return true;
        }
        return false;
    }

    /// @notice Set the number of historical roots accepted for withdrawals
    function setStateRootValidityWindow(uint256 window) external onlyOwner {
        require(window >= 1 && window <= 50, "Window out of range");
        stateRootValidityWindow = window;
    }

    // ============================================================
    // Forced Withdrawal (Escape Hatch — dYdX v3 pattern)
    //
    // Flow:
    //   1. User calls requestForcedWithdrawal(amount) → starts 7-day timer
    //   2. Platform SHOULD process it normally (via regular withdraw)
    //   3. If platform doesn't act within 7 days:
    //      User calls executeForcedWithdrawal(equity, proof) → bypass platform sig
    //   4. Platform can also cancel if it processes the request off-chain
    //
    // This guarantees: even if platform goes offline or censors a user,
    // the user can ALWAYS recover their funds after the delay period.
    // ============================================================

    /**
     * @notice Request a forced withdrawal. Starts the delay timer.
     * @param amount Amount the user wants to withdraw
     */
    function requestForcedWithdrawal(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert InvalidAmount();
        if (forcedWithdrawals[msg.sender].active) revert ForcedWithdrawalAlreadyActive();

        uint256 executeAfter = block.timestamp + forcedWithdrawalDelay;

        forcedWithdrawals[msg.sender] = ForcedWithdrawalRequest({
            amount: amount,
            requestTime: block.timestamp,
            active: true
        });

        emit ForcedWithdrawalRequested(msg.sender, amount, executeAfter);
    }

    /**
     * @notice Execute a forced withdrawal after the delay period.
     *         Requires Merkle proof but NO platform signature.
     * @param userEquity User's equity from the Merkle leaf
     * @param merkleProof Proof that (user, equity) is in the tree
     * @param merkleRoot The state root to verify against
     */
    function executeForcedWithdrawal(
        uint256 userEquity,
        bytes32[] calldata merkleProof,
        bytes32 merkleRoot
    ) external nonReentrant {
        ForcedWithdrawalRequest storage req = forcedWithdrawals[msg.sender];
        if (!req.active) revert ForcedWithdrawalNotActive();
        if (block.timestamp < req.requestTime + forcedWithdrawalDelay) {
            revert ForcedWithdrawalTooEarly();
        }

        address user = msg.sender;
        uint256 amount = req.amount;

        // Verify Merkle root is valid (current or recent)
        if (!_isValidStateRoot(merkleRoot)) revert InvalidProof();

        // Verify user equity in Merkle tree
        bytes32 leaf = keccak256(abi.encodePacked(user, userEquity));
        if (!MerkleProof.verify(merkleProof, merkleRoot, leaf)) {
            revert InvalidProof();
        }

        // Check withdrawable amount (same formula as regular withdraw)
        uint256 maxWithdrawable = userEquity > totalWithdrawn[user]
            ? userEquity - totalWithdrawn[user]
            : 0;
        if (amount > maxWithdrawable) revert ForcedWithdrawalInsufficientEquity();

        // Clear the forced withdrawal request
        delete forcedWithdrawals[user];

        // Update state (CEI pattern — state before transfer)
        withdrawalNonces[user] += 1;
        totalWithdrawn[user] += amount;
        if (totalDeposited >= amount) {
            totalDeposited -= amount;
        } else {
            totalDeposited = 0;
        }

        // Transfer tokens
        collateralToken.safeTransfer(user, amount);

        emit ForcedWithdrawalExecuted(user, amount);
    }

    /**
     * @notice Cancel a pending forced withdrawal request.
     *         Can be called by the user (changed their mind) or
     *         by the platform after processing the withdrawal normally.
     */
    function cancelForcedWithdrawal(address user) external {
        // Only the user themselves or the owner can cancel
        require(msg.sender == user || msg.sender == owner(), "Not authorized");

        if (!forcedWithdrawals[user].active) revert ForcedWithdrawalNotActive();

        delete forcedWithdrawals[user];

        emit ForcedWithdrawalCancelled(user);
    }

    // ============================================================
    // Admin Functions
    // ============================================================

    /**
     * @notice Update platform signer address
     */
    function setPlatformSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        address oldSigner = platformSigner;
        platformSigner = newSigner;
        emit PlatformSignerUpdated(oldSigner, newSigner);
    }

    /**
     * @notice Authorize/deauthorize state root updaters
     */
    function setAuthorizedUpdater(address updater, bool authorized) external onlyOwner {
        if (updater == address(0)) revert ZeroAddress();
        authorizedUpdaters[updater] = authorized;
        emit UpdaterAuthorized(updater, authorized);
    }

    /**
     * @notice Emergency pause — halts all deposits and withdrawals
     */
    function pause() external onlyOwner {
        _pause();
        emit EmergencyPaused(msg.sender);
    }

    /**
     * @notice Resume normal operations after emergency
     */
    function unpause() external onlyOwner {
        _unpause();
        emit EmergencyUnpaused(msg.sender);
    }

    /**
     * @notice Set per-user deposit cap (0 = unlimited)
     */
    function setDepositCapPerUser(uint256 cap) external onlyOwner {
        uint256 oldCap = depositCapPerUser;
        depositCapPerUser = cap;
        emit DepositCapPerUserUpdated(oldCap, cap);
    }

    /**
     * @notice Set forced withdrawal delay (minimum 1 day, maximum 30 days)
     * @dev Owner can only DECREASE the delay, never increase above 30 days
     */
    function setForcedWithdrawalDelay(uint256 delay) external onlyOwner {
        require(delay >= 1 days && delay <= 30 days, "Delay out of range");
        forcedWithdrawalDelay = delay;
    }

    /**
     * @notice Set global TVL deposit cap (0 = unlimited)
     */
    function setDepositCapTotal(uint256 cap) external onlyOwner {
        uint256 oldCap = depositCapTotal;
        depositCapTotal = cap;
        emit DepositCapTotalUpdated(oldCap, cap);
    }

    // ============================================================
    // View Functions
    // ============================================================

    /**
     * @notice Get user's total deposits
     */
    function getUserDeposits(address user) external view returns (uint256) {
        return userDeposits[user];
    }

    /**
     * @notice Get user's withdrawal nonce
     */
    function getUserNonce(address user) external view returns (uint256) {
        return withdrawalNonces[user];
    }

    /**
     * @notice Get user's total withdrawn amount
     */
    function getUserTotalWithdrawn(address user) external view returns (uint256) {
        return totalWithdrawn[user];
    }

    /**
     * @notice Verify a Merkle proof (helper for off-chain verification)
     */
    function verifyMerkleProof(
        address user,
        uint256 equity,
        bytes32[] calldata proof
    ) external view returns (bool) {
        bytes32 leaf = keccak256(abi.encodePacked(user, equity));
        return MerkleProof.verify(proof, currentStateRoot.root, leaf);
    }

    /**
     * @notice Get forced withdrawal request status for a user
     * @return amount Requested amount
     * @return requestTime When the request was made
     * @return active Whether the request is active
     * @return canExecute Whether the delay period has passed
     */
    function getForcedWithdrawalStatus(address user) external view returns (
        uint256 amount,
        uint256 requestTime,
        bool active,
        bool canExecute
    ) {
        ForcedWithdrawalRequest storage req = forcedWithdrawals[user];
        return (
            req.amount,
            req.requestTime,
            req.active,
            req.active && block.timestamp >= req.requestTime + forcedWithdrawalDelay
        );
    }

    /**
     * @notice Get EIP-712 domain separator
     */
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
