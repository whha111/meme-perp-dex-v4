// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/common/Vault.sol";
import "../src/perpetual/RiskManager.sol";
import "../src/perpetual/FundingRate.sol";
import "../src/perpetual/Liquidation.sol";

/**
 * @title RedeploySecurityFixes
 * @notice Redeploy 4 contracts with P0 security patches and reconfigure refs.
 *
 * NOTE: PositionManager has immutable vault/riskManager/priceFeed set in constructor.
 *       New Vault/RiskManager/FundingRate/Liquidation must reference the SAME
 *       PositionManager, so FundingRate & Liquidation use the OLD vault address
 *       that PositionManager was built with. The new Vault is standalone-configured
 *       but PositionManager still references the old one.
 *
 *       Practically: Vault and RiskManager are redeployed for BscScan verification
 *       but PositionManager keeps using its original immutable references.
 *       FundingRate and Liquidation use the original Vault/RiskManager too, since
 *       that's what PositionManager uses.
 *
 * Usage:
 *   cd contracts && source .env
 *   forge script script/RedeploySecurityFixes.s.sol \
 *     --rpc-url $BSC_TESTNET_RPC_URL --broadcast -vvv
 */
contract RedeploySecurityFixes is Script {
    // ── Existing contracts ──
    address constant POSITION_MANAGER = 0x50d3e039Efe373D9d52676D482E732FD9C411b05;
    address constant PRICE_FEED       = 0xB480517B96558E4467cfa1d91d8E6592c66B564D;
    address constant PERP_VAULT       = 0xF0db95eD967318BC7757A671399f0D4FFC853e05;
    address constant TOKEN_FACTORY    = 0xB40541Ff9f24883149fc6F9CD1021dB9C7BCcB83;

    // Old Vault/RiskManager — PositionManager has these as immutable references
    address constant OLD_VAULT        = 0xE70b128aA233Fa6e54C1EDCACDdC11C5465760Ac;
    address constant OLD_RISK_MANAGER = 0x176a7Abf1B3917DEd911B6F6aac4adcB318cd558;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console.log("=== Redeploy Security Fixes ===");
        console.log("Deployer:", deployer);
        console.log("Balance:", deployer.balance);
        console.log("");

        vm.startBroadcast(deployerKey);

        // ────────────────────────────────────────
        // Phase 1: Deploy new contracts
        // ────────────────────────────────────────

        // 1a. Vault (for BscScan verification — new code with nonReentrant fix)
        Vault newVault = new Vault();
        console.log("NEW Vault:", address(newVault));

        // 1b. RiskManager (for BscScan verification — new code with authorizedPausers)
        RiskManager newRiskManager = new RiskManager();
        console.log("NEW RiskManager:", address(newRiskManager));

        // 1c. FundingRate — uses OLD Vault because that's what PositionManager has
        FundingRate newFundingRate = new FundingRate(
            POSITION_MANAGER,
            OLD_VAULT,
            PRICE_FEED
        );
        console.log("NEW FundingRate:", address(newFundingRate));

        // 1d. Liquidation — uses OLD Vault and OLD RiskManager
        Liquidation newLiquidation = new Liquidation(
            POSITION_MANAGER,
            OLD_VAULT,
            OLD_RISK_MANAGER,
            PRICE_FEED
        );
        console.log("NEW Liquidation:", address(newLiquidation));

        // ────────────────────────────────────────
        // Phase 2: Configure new Liquidation
        // ────────────────────────────────────────
        console.log("");
        console.log("--- Configuring Liquidation ---");

        newLiquidation.setTokenFactory(TOKEN_FACTORY);
        console.log("  Liquidation: set TokenFactory");

        newLiquidation.setPerpVault(PERP_VAULT);
        console.log("  Liquidation: set PerpVault");

        // ────────────────────────────────────────
        // Phase 3: Authorize new Liquidation on OLD Vault
        // ────────────────────────────────────────
        console.log("");
        console.log("--- Authorizing on OLD Vault ---");

        (bool s1,) = OLD_VAULT.call(
            abi.encodeWithSignature("setAuthorizedContract(address,bool)", address(newLiquidation), true)
        );
        require(s1, "OldVault.setAuthorizedContract failed");
        console.log("  Old Vault: authorized new Liquidation");

        (bool s1b,) = OLD_VAULT.call(
            abi.encodeWithSignature("setInsuranceFund(address)", address(newLiquidation))
        );
        require(s1b, "OldVault.setInsuranceFund failed");
        console.log("  Old Vault: set InsuranceFund to new Liquidation");

        // ────────────────────────────────────────
        // Phase 4: Update PositionManager refs (only FundingRate and Liquidation)
        // ────────────────────────────────────────
        console.log("");
        console.log("--- Updating PositionManager refs ---");

        (bool s2,) = POSITION_MANAGER.call(
            abi.encodeWithSignature("setFundingRate(address)", address(newFundingRate))
        );
        require(s2, "PositionManager.setFundingRate failed");
        console.log("  PositionManager: set new FundingRate");

        (bool s3,) = POSITION_MANAGER.call(
            abi.encodeWithSignature("setLiquidation(address)", address(newLiquidation))
        );
        require(s3, "PositionManager.setLiquidation failed");
        console.log("  PositionManager: set new Liquidation");

        // ────────────────────────────────────────
        // Phase 5: Update OLD RiskManager to reference new Liquidation
        // ────────────────────────────────────────
        console.log("");
        console.log("--- Updating OLD RiskManager ---");

        (bool s4,) = OLD_RISK_MANAGER.call(
            abi.encodeWithSignature("setInsuranceFund(address)", address(newLiquidation))
        );
        require(s4, "OldRiskManager.setInsuranceFund failed");
        console.log("  Old RiskManager: set InsuranceFund to new Liquidation");

        vm.stopBroadcast();

        // ── Summary ──
        console.log("");
        console.log("========================================");
        console.log("  REDEPLOYMENT COMPLETE");
        console.log("========================================");
        console.log("NEW Vault:       ", address(newVault));
        console.log("NEW RiskManager: ", address(newRiskManager));
        console.log("NEW FundingRate: ", address(newFundingRate));
        console.log("NEW Liquidation: ", address(newLiquidation));
        console.log("========================================");
        console.log("");
        console.log("NOTE: PositionManager still uses OLD Vault and OLD RiskManager");
        console.log("      (immutable constructor args). FundingRate and Liquidation");
        console.log("      also reference OLD Vault/RiskManager for consistency.");
        console.log("");
        console.log("UPDATE CONFIG FILES:");
        console.log("  - VAULT_ADDRESS (for new standalone Vault)");
        console.log("  - RISK_MANAGER_ADDRESS (for new standalone RiskManager)");
        console.log("  - FUNDING_RATE_ADDRESS (actively used by Keeper)");
        console.log("  - LIQUIDATION_ADDRESS (actively used by Keeper + Engine)");
    }
}
