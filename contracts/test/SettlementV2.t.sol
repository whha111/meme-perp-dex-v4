// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/perpetual/SettlementV2.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title MockWETH
 * @notice Test WETH token (18 decimals)
 */
contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * @title SettlementV2 Test
 * @notice Validates the dYdX v3 style Merkle proof withdrawal system:
 *   1. Deposit WETH collateral
 *   2. State root attestation (Merkle root of user equities)
 *   3. Withdrawal with Merkle proof + EIP-712 platform signature
 */
contract SettlementV2Test is Test {
    SettlementV2 public settlement;
    MockWETH public weth;

    // Test accounts
    address public owner;
    uint256 public ownerKey = 1;

    address public platformSigner;
    uint256 public platformSignerKey = 2;

    address public updater;
    uint256 public updaterKey = 3;

    address public user1;
    uint256 public user1Key = 4;

    address public user2;
    uint256 public user2Key = 5;

    // WETH precision
    uint256 constant WETH_UNIT = 1e18;

    // EIP-712 constants
    bytes32 public constant WITHDRAWAL_TYPEHASH = keccak256(
        "Withdrawal(address user,uint256 amount,uint256 nonce,uint256 deadline,bytes32 merkleRoot)"
    );

    function setUp() public {
        // Generate addresses from private keys
        owner = vm.addr(ownerKey);
        platformSigner = vm.addr(platformSignerKey);
        updater = vm.addr(updaterKey);
        user1 = vm.addr(user1Key);
        user2 = vm.addr(user2Key);

        // Deploy MockWETH
        weth = new MockWETH();

        // Deploy SettlementV2
        vm.prank(owner);
        settlement = new SettlementV2(
            address(weth),
            platformSigner,
            owner
        );

        // Authorize updater
        vm.prank(owner);
        settlement.setAuthorizedUpdater(updater, true);

        // Mint WETH to users (10 ETH each)
        weth.mint(user1, 10 * WETH_UNIT);
        weth.mint(user2, 10 * WETH_UNIT);

        // Users approve SettlementV2
        vm.prank(user1);
        weth.approve(address(settlement), type(uint256).max);

        vm.prank(user2);
        weth.approve(address(settlement), type(uint256).max);
    }

    // ============================================================
    // Test 1: Deposit
    // ============================================================

    function test_deposit() public {
        console.log("\n=== Test 1: Deposit ===");

        vm.prank(user1);
        settlement.deposit(5 * WETH_UNIT);

        assertEq(settlement.getUserDeposits(user1), 5 * WETH_UNIT);
        assertEq(weth.balanceOf(address(settlement)), 5 * WETH_UNIT);

        console.log("  [PASS] User deposited 5 WETH");
    }

    // ============================================================
    // Test 2: DepositFor (relayer deposit)
    // ============================================================

    function test_depositFor() public {
        console.log("\n=== Test 2: DepositFor ===");

        // user1 deposits on behalf of user2
        vm.prank(user1);
        settlement.depositFor(user2, 3 * WETH_UNIT);

        assertEq(settlement.getUserDeposits(user2), 3 * WETH_UNIT);
        assertEq(weth.balanceOf(user1), 7 * WETH_UNIT); // 10 - 3

        console.log("  [PASS] Relayer deposit credited to user2");
    }

    // ============================================================
    // Test 3: Update State Root
    // ============================================================

    function test_updateStateRoot() public {
        console.log("\n=== Test 3: UpdateStateRoot ===");

        bytes32 root1 = keccak256("root1");

        // Authorized updater can update
        vm.prank(updater);
        settlement.updateStateRoot(root1);

        (bytes32 currentRoot,,) = settlement.currentStateRoot();
        assertEq(currentRoot, root1);

        console.log("  [PASS] Authorized updater set root");

        // Owner can also update
        bytes32 root2 = keccak256("root2");
        vm.prank(owner);
        settlement.updateStateRoot(root2);

        (currentRoot,,) = settlement.currentStateRoot();
        assertEq(currentRoot, root2);

        // root1 should be in history
        assertEq(settlement.getStateRootHistoryLength(), 1);

        console.log("  [PASS] Owner set root, history preserved");
    }

    function test_updateStateRoot_unauthorized_reverts() public {
        console.log("\n=== Test 4: UpdateStateRoot unauthorized ===");

        bytes32 root = keccak256("root");

        vm.prank(user1);
        vm.expectRevert(SettlementV2.UnauthorizedUpdater.selector);
        settlement.updateStateRoot(root);

        console.log("  [PASS] Unauthorized updater rejected");
    }

    // ============================================================
    // Test 5: Full Withdrawal Flow (Merkle proof + EIP-712 signature)
    // ============================================================

    function test_withdraw_fullFlow() public {
        console.log("\n=== Test 5: Full Withdrawal Flow ===");

        // 1. Users deposit
        vm.prank(user1);
        settlement.deposit(5 * WETH_UNIT);

        vm.prank(user2);
        settlement.deposit(5 * WETH_UNIT);

        // 2. Build Merkle tree of user equities
        //    Simulating: user1 gained profit, equity = 7 ETH
        //                user2 lost, equity = 3 ETH
        //    (Total is still 10 ETH, zero-sum)
        uint256 user1Equity = 7 * WETH_UNIT;
        uint256 user2Equity = 3 * WETH_UNIT;

        bytes32 leaf1 = keccak256(abi.encodePacked(user1, user1Equity));
        bytes32 leaf2 = keccak256(abi.encodePacked(user2, user2Equity));

        // Build root (OZ MerkleProof sorts pairs)
        bytes32 merkleRoot = _hashPair(leaf1, leaf2);

        // 3. Submit state root
        vm.prank(updater);
        settlement.updateStateRoot(merkleRoot);

        // 4. Verify Merkle proof on-chain
        bytes32[] memory proof1 = new bytes32[](1);
        proof1[0] = leaf2; // sibling
        assertTrue(settlement.verifyMerkleProof(user1, user1Equity, proof1));
        console.log("  [PASS] Merkle proof verified on-chain");

        // 5. Generate withdrawal: user1 withdraws 2 ETH of profit
        uint256 withdrawAmount = 2 * WETH_UNIT;
        uint256 nonce = 0;
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory signature = _signWithdrawal(
            user1, withdrawAmount, nonce, deadline, merkleRoot
        );

        // 6. User1 submits withdrawal
        uint256 user1BalBefore = weth.balanceOf(user1);

        vm.prank(user1);
        settlement.withdraw(
            withdrawAmount,
            user1Equity,
            proof1,
            merkleRoot,
            deadline,
            signature
        );

        uint256 user1BalAfter = weth.balanceOf(user1);
        assertEq(user1BalAfter - user1BalBefore, withdrawAmount);
        assertEq(settlement.getUserNonce(user1), 1);
        assertEq(settlement.getUserTotalWithdrawn(user1), withdrawAmount);

        console.log("  [PASS] User1 withdrew 2 ETH profit successfully");

        // 7. User1 can withdraw more (up to equity - totalWithdrawn = 7 - 2 = 5 ETH)
        uint256 secondWithdraw = 5 * WETH_UNIT;
        bytes memory sig2 = _signWithdrawal(
            user1, secondWithdraw, 1, deadline, merkleRoot
        );

        vm.prank(user1);
        settlement.withdraw(
            secondWithdraw,
            user1Equity,
            proof1,
            merkleRoot,
            deadline,
            sig2
        );

        assertEq(settlement.getUserTotalWithdrawn(user1), 7 * WETH_UNIT);
        console.log("  [PASS] User1 withdrew remaining 5 ETH (total 7 ETH equity)");
    }

    // ============================================================
    // Test 6: Withdraw exceeds equity
    // ============================================================

    function test_withdraw_exceedsEquity_reverts() public {
        console.log("\n=== Test 6: Withdraw exceeds equity ===");

        // Setup: deposit + Merkle root
        vm.prank(user1);
        settlement.deposit(5 * WETH_UNIT);

        uint256 user1Equity = 5 * WETH_UNIT;
        bytes32 leaf1 = keccak256(abi.encodePacked(user1, user1Equity));
        // Single-leaf tree: root = hashPair(leaf, leaf) for odd count
        bytes32 merkleRoot = _hashPair(leaf1, leaf1);

        vm.prank(updater);
        settlement.updateStateRoot(merkleRoot);

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leaf1; // self-sibling for single leaf

        // Try to withdraw more than equity
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signWithdrawal(
            user1, 6 * WETH_UNIT, 0, deadline, merkleRoot
        );

        vm.prank(user1);
        vm.expectRevert(SettlementV2.InsufficientEquity.selector);
        settlement.withdraw(
            6 * WETH_UNIT, user1Equity, proof, merkleRoot, deadline, sig
        );

        console.log("  [PASS] Excess withdrawal rejected");
    }

    // ============================================================
    // Test 7: Invalid Merkle proof
    // ============================================================

    function test_withdraw_invalidProof_reverts() public {
        console.log("\n=== Test 7: Invalid Merkle proof ===");

        vm.prank(user1);
        settlement.deposit(5 * WETH_UNIT);

        uint256 user1Equity = 5 * WETH_UNIT;
        bytes32 fakeLeaf = keccak256(abi.encodePacked(user1, uint256(999 * WETH_UNIT)));
        bytes32 realLeaf = keccak256(abi.encodePacked(user1, user1Equity));
        bytes32 merkleRoot = _hashPair(realLeaf, realLeaf);

        vm.prank(updater);
        settlement.updateStateRoot(merkleRoot);

        // Wrong proof (using fake leaf as sibling)
        bytes32[] memory wrongProof = new bytes32[](1);
        wrongProof[0] = fakeLeaf;

        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signWithdrawal(
            user1, 1 * WETH_UNIT, 0, deadline, merkleRoot
        );

        vm.prank(user1);
        vm.expectRevert(SettlementV2.InvalidProof.selector);
        settlement.withdraw(
            1 * WETH_UNIT, user1Equity, wrongProof, merkleRoot, deadline, sig
        );

        console.log("  [PASS] Invalid proof rejected");
    }

    // ============================================================
    // Test 8: Expired deadline
    // ============================================================

    function test_withdraw_expiredDeadline_reverts() public {
        console.log("\n=== Test 8: Expired deadline ===");

        vm.prank(user1);
        settlement.deposit(5 * WETH_UNIT);

        uint256 user1Equity = 5 * WETH_UNIT;
        bytes32 leaf = keccak256(abi.encodePacked(user1, user1Equity));
        bytes32 merkleRoot = _hashPair(leaf, leaf);

        vm.prank(updater);
        settlement.updateStateRoot(merkleRoot);

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leaf;

        // Use past deadline
        uint256 pastDeadline = block.timestamp - 1;
        bytes memory sig = _signWithdrawal(
            user1, 1 * WETH_UNIT, 0, pastDeadline, merkleRoot
        );

        vm.prank(user1);
        vm.expectRevert(SettlementV2.DeadlineExpired.selector);
        settlement.withdraw(
            1 * WETH_UNIT, user1Equity, proof, merkleRoot, pastDeadline, sig
        );

        console.log("  [PASS] Expired deadline rejected");
    }

    // ============================================================
    // Test 9: Invalid platform signature
    // ============================================================

    function test_withdraw_invalidSignature_reverts() public {
        console.log("\n=== Test 9: Invalid signature ===");

        vm.prank(user1);
        settlement.deposit(5 * WETH_UNIT);

        uint256 user1Equity = 5 * WETH_UNIT;
        bytes32 leaf = keccak256(abi.encodePacked(user1, user1Equity));
        bytes32 merkleRoot = _hashPair(leaf, leaf);

        vm.prank(updater);
        settlement.updateStateRoot(merkleRoot);

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leaf;

        uint256 deadline = block.timestamp + 1 hours;

        // Sign with wrong key (user1Key instead of platformSignerKey)
        bytes32 structHash = keccak256(
            abi.encode(
                WITHDRAWAL_TYPEHASH,
                user1,
                1 * WETH_UNIT,
                uint256(0),
                deadline,
                merkleRoot
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", settlement.domainSeparator(), structHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(user1Key, digest); // wrong signer!
        bytes memory wrongSig = abi.encodePacked(r, s, v);

        vm.prank(user1);
        vm.expectRevert(SettlementV2.InvalidSignature.selector);
        settlement.withdraw(
            1 * WETH_UNIT, user1Equity, proof, merkleRoot, deadline, wrongSig
        );

        console.log("  [PASS] Wrong signer rejected");
    }

    // ============================================================
    // Test 10: Deposit zero amount reverts
    // ============================================================

    function test_deposit_zeroAmount_reverts() public {
        console.log("\n=== Test 10: Zero deposit ===");

        vm.prank(user1);
        vm.expectRevert(SettlementV2.InvalidAmount.selector);
        settlement.deposit(0);

        console.log("  [PASS] Zero deposit rejected");
    }

    // ============================================================
    // Test 11: Multiple withdrawals with nonce tracking
    // ============================================================

    function test_withdraw_nonceTracking() public {
        console.log("\n=== Test 11: Nonce tracking ===");

        vm.prank(user1);
        settlement.deposit(10 * WETH_UNIT);

        uint256 user1Equity = 10 * WETH_UNIT;
        bytes32 leaf = keccak256(abi.encodePacked(user1, user1Equity));
        bytes32 merkleRoot = _hashPair(leaf, leaf);

        vm.prank(updater);
        settlement.updateStateRoot(merkleRoot);

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leaf;
        uint256 deadline = block.timestamp + 1 hours;

        // First withdrawal (nonce 0)
        bytes memory sig0 = _signWithdrawal(user1, 2 * WETH_UNIT, 0, deadline, merkleRoot);
        vm.prank(user1);
        settlement.withdraw(2 * WETH_UNIT, user1Equity, proof, merkleRoot, deadline, sig0);
        assertEq(settlement.getUserNonce(user1), 1);

        // Second withdrawal (nonce 1)
        bytes memory sig1 = _signWithdrawal(user1, 3 * WETH_UNIT, 1, deadline, merkleRoot);
        vm.prank(user1);
        settlement.withdraw(3 * WETH_UNIT, user1Equity, proof, merkleRoot, deadline, sig1);
        assertEq(settlement.getUserNonce(user1), 2);

        // Total withdrawn should be 5 ETH
        assertEq(settlement.getUserTotalWithdrawn(user1), 5 * WETH_UNIT);

        console.log("  [PASS] Nonce incremented correctly across 2 withdrawals");
    }

    // ============================================================
    // Test 12: Admin functions
    // ============================================================

    function test_admin_setPlatformSigner() public {
        console.log("\n=== Test 12: Admin functions ===");

        address newSigner = makeAddr("newSigner");

        vm.prank(owner);
        settlement.setPlatformSigner(newSigner);
        assertEq(settlement.platformSigner(), newSigner);

        console.log("  [PASS] Platform signer updated");
    }

    function test_admin_setUpdater() public {
        address newUpdater = makeAddr("newUpdater");

        vm.prank(owner);
        settlement.setAuthorizedUpdater(newUpdater, true);
        assertTrue(settlement.authorizedUpdaters(newUpdater));

        vm.prank(owner);
        settlement.setAuthorizedUpdater(newUpdater, false);
        assertFalse(settlement.authorizedUpdaters(newUpdater));

        console.log("  [PASS] Updater authorization toggled");
    }

    // ============================================================
    // Helper: Hash pair (matching OZ MerkleProof sorting)
    // ============================================================

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b
            ? keccak256(abi.encodePacked(a, b))
            : keccak256(abi.encodePacked(b, a));
    }

    // ============================================================
    // Helper: Sign EIP-712 withdrawal
    // ============================================================

    // ============================================================
    // Test 13: Ownable2Step — two-step ownership transfer
    // ============================================================

    function test_TransferOwnership_TwoStep() public {
        console.log("\n=== Test 13: Ownable2Step ===");

        address newOwner = makeAddr("newOwner");

        // Step 1: Current owner initiates transfer
        vm.prank(owner);
        settlement.transferOwnership(newOwner);

        // Owner should NOT have changed yet
        assertEq(settlement.owner(), owner);
        assertEq(settlement.pendingOwner(), newOwner);
        console.log("  [PASS] Pending owner set, current owner unchanged");

        // Step 2: New owner accepts
        vm.prank(newOwner);
        settlement.acceptOwnership();

        assertEq(settlement.owner(), newOwner);
        assertEq(settlement.pendingOwner(), address(0));
        console.log("  [PASS] New owner accepted, ownership transferred");
    }

    function test_TransferOwnership_DirectReverts() public {
        console.log("\n=== Test 14: Ownable2Step direct accept reverts ===");

        address randomUser = makeAddr("randomUser");

        // No pending transfer — acceptOwnership should revert
        vm.prank(randomUser);
        vm.expectRevert(
            abi.encodeWithSelector(
                Ownable.OwnableUnauthorizedAccount.selector,
                randomUser
            )
        );
        settlement.acceptOwnership();

        console.log("  [PASS] Direct acceptOwnership rejected");
    }

    // ============================================================
    // Test 15: Deposit reverts when paused
    // ============================================================

    function test_deposit_whenPaused_reverts() public {
        console.log("\n=== Test 15: Deposit when paused ===");

        // Owner pauses the contract
        vm.prank(owner);
        settlement.pause();
        assertTrue(settlement.paused());

        // Deposit should revert with EnforcedPause
        vm.prank(user1);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        settlement.deposit(1 * WETH_UNIT);

        console.log("  [PASS] Deposit rejected when paused");

        // DepositFor should also revert
        vm.prank(user1);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        settlement.depositFor(user2, 1 * WETH_UNIT);

        console.log("  [PASS] DepositFor rejected when paused");

        // Unpause and verify deposit works again
        vm.prank(owner);
        settlement.unpause();
        assertFalse(settlement.paused());

        vm.prank(user1);
        settlement.deposit(1 * WETH_UNIT);
        assertEq(settlement.getUserDeposits(user1), 1 * WETH_UNIT);

        console.log("  [PASS] Deposit works after unpause");
    }

    // ============================================================
    // Test 16: Withdraw reverts when paused
    // ============================================================

    function test_withdraw_whenPaused_reverts() public {
        console.log("\n=== Test 16: Withdraw when paused ===");

        // Setup: deposit + Merkle root (before pausing)
        vm.prank(user1);
        settlement.deposit(5 * WETH_UNIT);

        uint256 user1Equity = 5 * WETH_UNIT;
        bytes32 leaf = keccak256(abi.encodePacked(user1, user1Equity));
        bytes32 merkleRoot = _hashPair(leaf, leaf);

        vm.prank(updater);
        settlement.updateStateRoot(merkleRoot);

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leaf;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signWithdrawal(user1, 1 * WETH_UNIT, 0, deadline, merkleRoot);

        // Now pause
        vm.prank(owner);
        settlement.pause();

        // Withdraw should revert
        vm.prank(user1);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        settlement.withdraw(1 * WETH_UNIT, user1Equity, proof, merkleRoot, deadline, sig);

        console.log("  [PASS] Withdraw rejected when paused");
    }

    // ============================================================
    // Test 17: Deposit exceeds per-user cap
    // ============================================================

    function test_deposit_exceedsUserCap_reverts() public {
        console.log("\n=== Test 17: Per-user deposit cap ===");

        // Set per-user cap to 2 ETH
        vm.prank(owner);
        settlement.setDepositCapPerUser(2 * WETH_UNIT);
        assertEq(settlement.depositCapPerUser(), 2 * WETH_UNIT);

        // Deposit 1.5 ETH — should succeed
        vm.prank(user1);
        settlement.deposit(15 * WETH_UNIT / 10);
        assertEq(settlement.getUserDeposits(user1), 15 * WETH_UNIT / 10);

        console.log("  [PASS] Deposit within cap succeeded");

        // Deposit 0.6 ETH more — total 2.1 ETH, exceeds 2 ETH cap
        vm.prank(user1);
        vm.expectRevert(SettlementV2.UserDepositCapExceeded.selector);
        settlement.deposit(6 * WETH_UNIT / 10);

        console.log("  [PASS] Deposit exceeding user cap rejected");

        // Different user can still deposit (independent cap)
        vm.prank(user2);
        settlement.deposit(2 * WETH_UNIT);
        assertEq(settlement.getUserDeposits(user2), 2 * WETH_UNIT);

        console.log("  [PASS] Other user deposits independently");
    }

    // ============================================================
    // Test 18: Deposit exceeds global TVL cap
    // ============================================================

    function test_deposit_exceedsTotalCap_reverts() public {
        console.log("\n=== Test 18: Global TVL deposit cap ===");

        // Set global cap to 3 ETH
        vm.prank(owner);
        settlement.setDepositCapTotal(3 * WETH_UNIT);
        assertEq(settlement.depositCapTotal(), 3 * WETH_UNIT);

        // User1 deposits 2 ETH — should succeed
        vm.prank(user1);
        settlement.deposit(2 * WETH_UNIT);

        // User2 deposits 1.5 ETH — total would be 3.5 ETH, exceeds 3 ETH cap
        vm.prank(user2);
        vm.expectRevert(SettlementV2.TotalDepositCapExceeded.selector);
        settlement.deposit(15 * WETH_UNIT / 10);

        console.log("  [PASS] Deposit exceeding global cap rejected");

        // User2 deposits 1 ETH — total 3 ETH, exactly at cap
        vm.prank(user2);
        settlement.deposit(1 * WETH_UNIT);
        assertEq(settlement.totalDeposited(), 3 * WETH_UNIT);

        console.log("  [PASS] Deposit at exact cap limit succeeded");
    }

    // ============================================================
    // Test 19: Pause/unpause only callable by owner
    // ============================================================

    function test_pause_onlyOwner() public {
        console.log("\n=== Test 19: Pause access control ===");

        // Non-owner cannot pause
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                Ownable.OwnableUnauthorizedAccount.selector,
                user1
            )
        );
        settlement.pause();

        console.log("  [PASS] Non-owner pause rejected");

        // Non-owner cannot unpause
        vm.prank(owner);
        settlement.pause();

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                Ownable.OwnableUnauthorizedAccount.selector,
                user1
            )
        );
        settlement.unpause();

        console.log("  [PASS] Non-owner unpause rejected");

        // Non-owner cannot set caps
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                Ownable.OwnableUnauthorizedAccount.selector,
                user1
            )
        );
        settlement.setDepositCapPerUser(1 * WETH_UNIT);

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                Ownable.OwnableUnauthorizedAccount.selector,
                user1
            )
        );
        settlement.setDepositCapTotal(1 * WETH_UNIT);

        console.log("  [PASS] Non-owner cap setting rejected");
    }

    // ============================================================
    // Helper: Sign EIP-712 withdrawal
    // ============================================================

    function _signWithdrawal(
        address user,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes32 merkleRoot
    ) internal view returns (bytes memory) {
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

        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", settlement.domainSeparator(), structHash)
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(platformSignerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    // ============================================================
    // Forced Withdrawal (Escape Hatch) Tests
    // ============================================================

    function test_forcedWithdrawal_fullFlow() public {
        console.log("\n=== Test: Forced Withdrawal Full Flow ===");

        // 1. User deposits
        vm.prank(user1);
        settlement.deposit(5 * WETH_UNIT);

        // 2. Build Merkle tree with equity
        uint256 user1Equity = 5 * WETH_UNIT;
        uint256 user2Equity = 0;
        bytes32 leaf1 = keccak256(abi.encodePacked(user1, user1Equity));
        bytes32 leaf2 = keccak256(abi.encodePacked(user2, user2Equity));
        bytes32 merkleRoot = _hashPair(leaf1, leaf2);

        vm.prank(updater);
        settlement.updateStateRoot(merkleRoot);

        // 3. User requests forced withdrawal
        uint256 withdrawAmount = 3 * WETH_UNIT;
        vm.prank(user1);
        settlement.requestForcedWithdrawal(withdrawAmount);

        // Verify request is active
        (uint256 amount, uint256 requestTime, bool active, bool canExecute) =
            settlement.getForcedWithdrawalStatus(user1);
        assertEq(amount, withdrawAmount);
        assertTrue(active);
        assertFalse(canExecute); // Not yet past delay
        console.log("  [PASS] Forced withdrawal requested");

        // 4. Cannot execute before delay
        bytes32[] memory proof1 = new bytes32[](1);
        proof1[0] = leaf2;

        vm.prank(user1);
        vm.expectRevert(SettlementV2.ForcedWithdrawalTooEarly.selector);
        settlement.executeForcedWithdrawal(user1Equity, proof1, merkleRoot);
        console.log("  [PASS] Revert before delay period");

        // 5. Warp past 7 days
        vm.warp(block.timestamp + 7 days + 1);

        // Verify canExecute is now true
        (,,, bool canExecuteNow) = settlement.getForcedWithdrawalStatus(user1);
        assertTrue(canExecuteNow);

        // 6. Execute forced withdrawal — NO platform signature needed!
        uint256 balBefore = weth.balanceOf(user1);
        vm.prank(user1);
        settlement.executeForcedWithdrawal(user1Equity, proof1, merkleRoot);
        uint256 balAfter = weth.balanceOf(user1);

        assertEq(balAfter - balBefore, withdrawAmount);
        assertEq(settlement.getUserTotalWithdrawn(user1), withdrawAmount);
        console.log("  [PASS] Forced withdrawal executed after 7 days");

        // 7. Forced withdrawal request is cleared
        (,, bool stillActive,) = settlement.getForcedWithdrawalStatus(user1);
        assertFalse(stillActive);
        console.log("  [PASS] Request cleared after execution");
    }

    function test_forcedWithdrawal_cancelByUser() public {
        console.log("\n=== Test: Forced Withdrawal Cancel ===");

        vm.prank(user1);
        settlement.deposit(5 * WETH_UNIT);

        vm.prank(user1);
        settlement.requestForcedWithdrawal(3 * WETH_UNIT);

        // User cancels
        vm.prank(user1);
        settlement.cancelForcedWithdrawal(user1);

        (,, bool active,) = settlement.getForcedWithdrawalStatus(user1);
        assertFalse(active);
        console.log("  [PASS] User cancelled forced withdrawal");
    }

    function test_forcedWithdrawal_cancelByOwner() public {
        console.log("\n=== Test: Forced Withdrawal Cancel by Owner ===");

        vm.prank(user1);
        settlement.deposit(5 * WETH_UNIT);

        vm.prank(user1);
        settlement.requestForcedWithdrawal(3 * WETH_UNIT);

        // Owner cancels (e.g. after processing withdrawal off-band)
        vm.prank(owner);
        settlement.cancelForcedWithdrawal(user1);

        (,, bool active,) = settlement.getForcedWithdrawalStatus(user1);
        assertFalse(active);
        console.log("  [PASS] Owner cancelled forced withdrawal");
    }

    function test_forcedWithdrawal_revertDuplicate() public {
        console.log("\n=== Test: Forced Withdrawal Duplicate Revert ===");

        vm.prank(user1);
        settlement.deposit(5 * WETH_UNIT);

        vm.prank(user1);
        settlement.requestForcedWithdrawal(3 * WETH_UNIT);

        // Cannot request again while one is active
        vm.prank(user1);
        vm.expectRevert(SettlementV2.ForcedWithdrawalAlreadyActive.selector);
        settlement.requestForcedWithdrawal(2 * WETH_UNIT);
        console.log("  [PASS] Duplicate request reverted");
    }

    function test_forcedWithdrawal_revertExceedsEquity() public {
        console.log("\n=== Test: Forced Withdrawal Exceeds Equity ===");

        vm.prank(user1);
        settlement.deposit(5 * WETH_UNIT);

        // Merkle tree: user1 equity = 5 ETH
        uint256 user1Equity = 5 * WETH_UNIT;
        bytes32 leaf1 = keccak256(abi.encodePacked(user1, user1Equity));
        bytes32 leaf2 = keccak256(abi.encodePacked(user2, uint256(0)));
        bytes32 merkleRoot = _hashPair(leaf1, leaf2);

        vm.prank(updater);
        settlement.updateStateRoot(merkleRoot);

        // Request 10 ETH (more than equity)
        vm.prank(user1);
        settlement.requestForcedWithdrawal(10 * WETH_UNIT);

        vm.warp(block.timestamp + 7 days + 1);

        bytes32[] memory proof1 = new bytes32[](1);
        proof1[0] = leaf2;

        vm.prank(user1);
        vm.expectRevert(SettlementV2.ForcedWithdrawalInsufficientEquity.selector);
        settlement.executeForcedWithdrawal(user1Equity, proof1, merkleRoot);
        console.log("  [PASS] Revert when amount exceeds equity");
    }

    function test_forcedWithdrawal_setDelay() public {
        console.log("\n=== Test: Set Forced Withdrawal Delay ===");

        // Default is 7 days
        assertEq(settlement.forcedWithdrawalDelay(), 7 days);

        // Owner can change to 3 days
        vm.prank(owner);
        settlement.setForcedWithdrawalDelay(3 days);
        assertEq(settlement.forcedWithdrawalDelay(), 3 days);

        // Cannot set below 1 day
        vm.prank(owner);
        vm.expectRevert("Delay out of range");
        settlement.setForcedWithdrawalDelay(12 hours);

        // Cannot set above 30 days
        vm.prank(owner);
        vm.expectRevert("Delay out of range");
        settlement.setForcedWithdrawalDelay(31 days);

        console.log("  [PASS] Delay configuration works correctly");
    }
}
