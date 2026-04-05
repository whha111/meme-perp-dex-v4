// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/perpetual/SettlementV2.sol";

/**
 * @title DeploySettlementV2Only
 * @notice Deploy SettlementV2 with Escape Hatch (forced withdrawal)
 *
 * Changes from previous deployment:
 *   - Added requestForcedWithdrawal / executeForcedWithdrawal / cancelForcedWithdrawal
 *   - 7-day delay (configurable 1-30 days) before forced execution
 *   - Users can exit even if platform is offline (dYdX v3 pattern)
 *
 * Usage:
 *   cd contracts
 *   source .env
 *   forge script script/DeploySettlementV2Only.s.sol \
 *     --rpc-url $BSC_TESTNET_RPC_URL --broadcast -vvv
 */
contract DeploySettlementV2Only is Script {
    // WBNB on BSC Testnet
    address constant WBNB = 0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console.log("=== Deploy SettlementV2 (Escape Hatch) ===");
        console.log("Deployer:", deployer);
        console.log("Balance:", deployer.balance);

        vm.startBroadcast(deployerKey);

        SettlementV2 sv2 = new SettlementV2(
            WBNB,       // collateralToken
            deployer,   // platformSigner (deployer for now)
            deployer    // initialOwner
        );

        console.log("SettlementV2 deployed at:", address(sv2));

        // Configure: authorize deployer as state root updater
        sv2.setAuthorizedUpdater(deployer, true);
        console.log("Authorized deployer as state root updater");

        // Set deposit caps (higher for testnet)
        sv2.setDepositCapPerUser(50 ether);
        sv2.setDepositCapTotal(500 ether);
        console.log("Deposit caps: 50 BNB/user, 500 BNB total");

        // Forced withdrawal delay: 7 days (default, just log it)
        console.log("Forced withdrawal delay: 7 days (default)");

        vm.stopBroadcast();

        console.log("");
        console.log("=== DONE ===");
        console.log("New SettlementV2:", address(sv2));
        console.log("Forced withdrawal: requestForcedWithdrawal -> 7d -> executeForcedWithdrawal");
        console.log("Update deployments/97.json and all 7 config files!");
    }
}
