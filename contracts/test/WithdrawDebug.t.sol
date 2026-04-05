// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

interface ISettlementV2 {
    function withdraw(
        uint256 amount,
        uint256 userEquity,
        bytes32[] calldata merkleProof,
        bytes32 merkleRoot,
        uint256 deadline,
        bytes calldata signature
    ) external;
    function currentStateRoot() external view returns (bytes32 root, uint256 timestamp, uint256 blockNumber);
    function totalWithdrawn(address user) external view returns (uint256);
    function withdrawalNonces(address user) external view returns (uint256);
    function platformSigner() external view returns (address);
    function updateStateRoot(bytes32 newRoot) external;
}

contract WithdrawDebugTest is Test {
    ISettlementV2 sv2 = ISettlementV2(0xF83D5d2E437D0e27144900cb768d2B5933EF3d6b);
    address deployer = 0xAecb229194314999E396468eb091b42E44Bc3c8c;
    uint256 deployerPK = 0x4698c351c4aead4844a41399b035e1177535db94a5418a79df07b7f0bf158776;

    function testWithdraw() public {
        uint256 equity = 27.1 ether;

        // Check state
        (bytes32 root, , ) = sv2.currentStateRoot();
        console.log("State root:");
        console.logBytes32(root);

        uint256 nonce = sv2.withdrawalNonces(deployer);
        console.log("Nonce:", nonce);

        uint256 totalW = sv2.totalWithdrawn(deployer);
        console.log("TotalWithdrawn:", totalW);

        address signer = sv2.platformSigner();
        console.log("Platform signer:", signer);

        // Compute leaf
        bytes32 leaf = keccak256(abi.encodePacked(deployer, equity));
        console.log("Computed leaf:");
        console.logBytes32(leaf);
        console.log("Leaf == root:", leaf == root);

        // If root doesn't match, update it
        if (leaf != root) {
            vm.prank(deployer);
            sv2.updateStateRoot(leaf);
            (root, , ) = sv2.currentStateRoot();
            console.log("Updated root:");
            console.logBytes32(root);
        }

        // Sign EIP-712
        bytes32 WITHDRAWAL_TYPEHASH = keccak256("Withdrawal(address user,uint256 amount,uint256 nonce,uint256 deadline,bytes32 merkleRoot)");
        uint256 deadline = block.timestamp + 3600;

        bytes32 structHash = keccak256(abi.encode(
            WITHDRAWAL_TYPEHASH,
            deployer,
            equity,
            nonce,
            deadline,
            leaf
        ));

        // EIP-712 domain separator
        bytes32 domainSeparator = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("SettlementV2"),
            keccak256("1"),
            uint256(97),
            address(sv2)
        ));

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(deployerPK, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        // Verify signer recovery
        address recovered = ecrecover(digest, v, r, s);
        console.log("Recovered signer:", recovered);
        console.log("Match platform:", recovered == signer);

        // Execute withdrawal
        bytes32[] memory proof = new bytes32[](0);

        vm.prank(deployer);
        sv2.withdraw(equity, equity, proof, leaf, deadline, signature);

        console.log("Withdrawal successful!");
    }
}
