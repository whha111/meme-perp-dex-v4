// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/perpetual/Liquidation.sol";

/**
 * @title DeployLiquidationV2
 * @notice Deploy new Liquidation contract (coverDeficit returns uint256 fix)
 *         and reconfigure Vault, PositionManager, RiskManager to use it.
 *
 * Usage:
 *   cd contracts
 *   forge script script/DeployLiquidationV2.s.sol \
 *     --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast -vvv
 */
contract DeployLiquidationV2 is Script {
    // ── Existing contract addresses ──
    address constant POSITION_MANAGER = 0x7611a924622B5f6bc4c2ECAAdB6DE078E741AcF6;
    address constant VAULT            = 0xcc4Fa8Df0686824F92d392Cb650057EA7D2EF46E;
    address constant RISK_MANAGER     = 0x7fC37B0bD2c8c2646C9087A21e33e2A404AD7A39;
    address constant PRICE_FEED       = 0x8A57904F9b9392dAB4163a6c372Df1c4Cdd1eb36;
    address constant TOKEN_FACTORY    = 0xd05A38E6C2a39762De453D90a670ED0Af65ff2f8;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        // 1. Deploy new Liquidation
        Liquidation newLiq = new Liquidation(POSITION_MANAGER, VAULT, RISK_MANAGER, PRICE_FEED);
        console.log("New Liquidation deployed at:", address(newLiq));

        // 2. Set TokenFactory on new Liquidation
        newLiq.setTokenFactory(TOKEN_FACTORY);
        console.log("TokenFactory set on Liquidation");

        // 3. Update Vault to use new Liquidation as insurance fund
        //    Vault.setInsuranceFund(newLiquidation)
        (bool s1,) = VAULT.call(abi.encodeWithSignature("setInsuranceFund(address)", address(newLiq)));
        require(s1, "Vault.setInsuranceFund failed");
        console.log("Vault.insuranceFund updated");

        // 4. Update PositionManager to authorize new Liquidation
        //    PositionManager.setLiquidation(newLiquidation)
        (bool s2,) = POSITION_MANAGER.call(abi.encodeWithSignature("setLiquidation(address)", address(newLiq)));
        require(s2, "PositionManager.setLiquidation failed");
        console.log("PositionManager.liquidation updated");

        // 5. Update RiskManager to use new Liquidation as insurance fund
        (bool s3,) = RISK_MANAGER.call(abi.encodeWithSignature("setInsuranceFund(address)", address(newLiq)));
        require(s3, "RiskManager.setInsuranceFund failed");
        console.log("RiskManager.insuranceFund updated");

        // 6. Seed insurance fund with 0.5 ETH
        (bool s4,) = address(newLiq).call{value: 0.5 ether}("");
        require(s4, "Insurance fund seed failed");
        console.log("Insurance fund seeded with 0.5 ETH");

        vm.stopBroadcast();

        console.log("========================================");
        console.log("NEW LIQUIDATION ADDRESS:", address(newLiq));
        console.log("========================================");
        console.log("Update this address in:");
        console.log("  - frontend/contracts/deployments/base-sepolia.json");
        console.log("  - frontend/src/lib/contracts.ts");
        console.log("  - backend/src/matching/config.ts");
        console.log("  - backend/configs/config.yaml");
        console.log("  - backend/configs/config.local.yaml");
        console.log("  - stress-test/config.ts");
        console.log("  - docker-compose.yml");
    }
}
