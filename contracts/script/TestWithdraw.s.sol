// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/perpetual/SettlementV2.sol";

contract TestWithdraw is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address user = vm.addr(pk);
        SettlementV2 settlement = SettlementV2(0x45c4f8c301569Bb073473D11aE526408934E2177);

        // User has 0.00003 WETH deposited. Set equity = 0.00003 WETH
        uint256 userEquity = 30000000000000; // 3e13

        // Build Merkle leaf
        bytes32 leaf = keccak256(abi.encodePacked(user, userEquity));
        // Single-leaf: root = keccak256(abi.encodePacked(leaf, leaf))
        bytes32 root = keccak256(abi.encodePacked(leaf, leaf));

        console.log("User:", user);
        console.log("Equity:", userEquity);
        console.log("Leaf:");
        console.logBytes32(leaf);
        console.log("Merkle root:");
        console.logBytes32(root);

        // Step 1: Submit state root
        vm.startBroadcast(pk);
        settlement.updateStateRoot(root);
        vm.stopBroadcast();

        // Step 2: Verify merkle proof on-chain
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leaf; // sibling = self for single leaf
        bool valid = settlement.verifyMerkleProof(user, userEquity, proof);
        console.log("Merkle proof valid:", valid);
        require(valid, "PROOF INVALID");

        // Step 3: Build EIP-712 signature
        uint256 withdrawAmount = 10000000000000; // 0.00001 WETH
        uint256 nonce = settlement.getUserNonce(user);
        uint256 deadline = block.timestamp + 3600;

        bytes32 WITHDRAWAL_TYPEHASH = keccak256(
            "Withdrawal(address user,uint256 amount,uint256 nonce,uint256 deadline,bytes32 merkleRoot)"
        );

        bytes32 structHash = keccak256(
            abi.encode(WITHDRAWAL_TYPEHASH, user, withdrawAmount, nonce, deadline, root)
        );

        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", settlement.domainSeparator(), structHash)
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        console.log("Nonce:", nonce);
        console.log("Deadline:", deadline);

        // Step 4: Execute withdrawal
        vm.startBroadcast(pk);
        settlement.withdraw(withdrawAmount, userEquity, proof, deadline, signature);
        vm.stopBroadcast();

        console.log("=== WITHDRAWAL SUCCESSFUL ===");
        console.log("Withdrawn:", withdrawAmount);
        console.log("New nonce:", settlement.getUserNonce(user));
        console.log("Total withdrawn:", settlement.getUserTotalWithdrawn(user));
    }
}
