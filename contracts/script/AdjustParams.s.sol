// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

/**
 * @title AdjustParams
 * @notice Phase 1: 批量调参脚本 — 通过已有 setter 函数调整 Meme 币合约参数
 * @dev 无需重新部署合约，通过 admin 调用立即生效
 *
 * 使用方法:
 * forge script script/AdjustParams.s.sol --rpc-url $RPC --broadcast --legacy
 */

// Minimal interfaces for setter calls
interface IRiskManager {
    function setMaxLeverage(uint256 value) external;
    function setMaxPositionSize(uint256 value) external;
    function setMaxOpenInterest(uint256 value) external;
    function setMaxPriceMove(uint256 value) external;
    function setMaintenanceMarginRate(uint256 leverage, uint256 rate) external;
    // Read functions for verification
    function maxLeverage() external view returns (uint256);
    function maxPositionSize() external view returns (uint256);
    function maxOpenInterest() external view returns (uint256);
    function maxPriceMove() external view returns (uint256);
    function getMaintenanceMarginRate(uint256 leverage) external view returns (uint256);
}

interface IInsuranceFund {
    function setMinReserve(uint256 _minReserve) external;
    function setMaxPayoutRatio(uint256 _maxPayoutRatio) external;
    function minReserve() external view returns (uint256);
    function maxPayoutRatio() external view returns (uint256);
}

interface IPerpVault {
    function setCooldown(uint256 _cooldown) external;
    function withdrawalCooldown() external view returns (uint256);
}

contract AdjustParams is Script {
    // ============================================================
    // Contract addresses — from env or fallback to latest deployment
    // ============================================================

    function _getRiskManager() internal view returns (address) {
        return vm.envOr("RISK_MANAGER_ADDRESS", address(0x7Feb343D4951122d3Fed9592651c37e55f686150));
    }

    function _getInsuranceFund() internal view returns (address) {
        return vm.envOr("INSURANCE_FUND_ADDRESS", address(0xb4D0da0233CB6f6af06ca288aF493C7EEe673FE9));
    }

    function _getPerpVault() internal view returns (address) {
        return vm.envAddress("PERP_VAULT_ADDRESS");
    }

    // ============================================================
    // Precision constants (must match contracts)
    // ============================================================

    uint256 constant LEVERAGE_PRECISION = 1e4;
    uint256 constant PRECISION = 1e18;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("=== Phase 1: Meme Coin Parameter Adjustment ===");
        console.log("Deployer:", deployer);

        IRiskManager riskManager = IRiskManager(_getRiskManager());
        IInsuranceFund insuranceFund = IInsuranceFund(_getInsuranceFund());

        // Log current values
        console.log("\n--- Current Values ---");
        console.log("maxLeverage:", riskManager.maxLeverage());
        console.log("maxPositionSize:", riskManager.maxPositionSize());
        console.log("maxOpenInterest:", riskManager.maxOpenInterest());
        console.log("maxPriceMove:", riskManager.maxPriceMove());
        console.log("insuranceFund minReserve:", insuranceFund.minReserve());
        console.log("insuranceFund maxPayoutRatio:", insuranceFund.maxPayoutRatio());

        vm.startBroadcast(deployerPrivateKey);

        // ============================================================
        // 1. RiskManager: Leverage 100x → 10x
        // ============================================================
        console.log("\n[1/8] Setting maxLeverage: 100x -> 10x");
        riskManager.setMaxLeverage(10 * LEVERAGE_PRECISION);

        // ============================================================
        // 2. RiskManager: Position size 1000 ETH → 5 ETH
        // ============================================================
        console.log("[2/8] Setting maxPositionSize: 1000 ETH -> 5 ETH");
        riskManager.setMaxPositionSize(5 ether);

        // ============================================================
        // 3. RiskManager: Open interest 10000 ETH → 50 ETH
        // ============================================================
        console.log("[3/8] Setting maxOpenInterest: 10000 ETH -> 50 ETH");
        riskManager.setMaxOpenInterest(50 ether);

        // ============================================================
        // 4. RiskManager: Max price move 50% → 80%
        // ============================================================
        console.log("[4/8] Setting maxPriceMove: 50% -> 80%");
        riskManager.setMaxPriceMove(80e16); // 80% in 1e18 precision

        // ============================================================
        // 5. RiskManager: MMR tiers for meme coins
        //    3x→5%, 5x→8%, 7x→10%, 10x→12.5%
        // ============================================================
        console.log("[5/8] Setting MMR tiers for meme coins");
        riskManager.setMaintenanceMarginRate(3 * LEVERAGE_PRECISION, 5e16);    // 3x → 5%
        riskManager.setMaintenanceMarginRate(5 * LEVERAGE_PRECISION, 8e16);    // 5x → 8%
        riskManager.setMaintenanceMarginRate(7 * LEVERAGE_PRECISION, 1e17);    // 7x → 10%
        riskManager.setMaintenanceMarginRate(10 * LEVERAGE_PRECISION, 125e15); // 10x → 12.5%

        // ============================================================
        // 6. InsuranceFund: minReserve 1 ETH → 2 ETH
        // ============================================================
        console.log("[6/8] Setting insuranceFund minReserve: 1 ETH -> 2 ETH");
        insuranceFund.setMinReserve(2 ether);

        // ============================================================
        // 7. InsuranceFund: maxPayoutRatio 50% → 30%
        // ============================================================
        console.log("[7/8] Setting insuranceFund maxPayoutRatio: 50% -> 30%");
        insuranceFund.setMaxPayoutRatio(3000);

        // ============================================================
        // 8. PerpVault: Cooldown 24h → 48h (if PerpVault is deployed)
        // ============================================================
        address perpVaultAddr = vm.envOr("PERP_VAULT_ADDRESS", address(0));
        if (perpVaultAddr != address(0)) {
            console.log("[8/8] Setting PerpVault cooldown: 24h -> 48h");
            IPerpVault(perpVaultAddr).setCooldown(48 hours);
        } else {
            console.log("[8/8] Skipped: PerpVault not deployed");
        }

        vm.stopBroadcast();

        // ============================================================
        // Verification
        // ============================================================
        console.log("\n--- Verification (New Values) ---");
        console.log("maxLeverage:", riskManager.maxLeverage(), "(expected: 100000)");
        console.log("maxPositionSize:", riskManager.maxPositionSize(), "(expected: 5e18)");
        console.log("maxOpenInterest:", riskManager.maxOpenInterest(), "(expected: 50e18)");
        console.log("maxPriceMove:", riskManager.maxPriceMove(), "(expected: 8e17)");
        console.log("MMR @3x:", riskManager.getMaintenanceMarginRate(3 * LEVERAGE_PRECISION), "(expected: 5e16)");
        console.log("MMR @5x:", riskManager.getMaintenanceMarginRate(5 * LEVERAGE_PRECISION), "(expected: 8e16)");
        console.log("MMR @7x:", riskManager.getMaintenanceMarginRate(7 * LEVERAGE_PRECISION), "(expected: 1e17)");
        console.log("MMR @10x:", riskManager.getMaintenanceMarginRate(10 * LEVERAGE_PRECISION), "(expected: 125e15)");
        console.log("minReserve:", insuranceFund.minReserve(), "(expected: 2e18)");
        console.log("maxPayoutRatio:", insuranceFund.maxPayoutRatio(), "(expected: 3000)");

        console.log("\n=== Phase 1 Complete ===");
    }
}
