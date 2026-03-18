// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

// Common
import "../src/common/PriceFeed.sol";
import "../src/common/Vault.sol";
import "../src/common/ContractRegistry.sol";

// Spot
import "../src/spot/TokenFactory.sol";

// Perpetual
import "../src/perpetual/Settlement.sol";
import "../src/perpetual/SettlementV2.sol";
import "../src/perpetual/PositionManager.sol";
import "../src/perpetual/RiskManager.sol";
import "../src/perpetual/FundingRate.sol";
import "../src/perpetual/Liquidation.sol";
import "../src/perpetual/PerpVault.sol";
import "../src/perpetual/InsuranceFund.sol";

/**
 * @title DeployBSCTestnet
 * @notice 一键部署所有合约到 BSC 测试网
 *
 * Usage:
 *   cd contracts
 *   forge script script/DeployBSCTestnet.s.sol \
 *     --rpc-url https://data-seed-prebsc-1-s1.binance.org:8545/ \
 *     --broadcast --slow -vvv
 *
 * 部署顺序:
 *   Phase 1: 无依赖合约 (PriceFeed, Vault, ContractRegistry, RiskManager, PerpVault, InsuranceFund, Settlement)
 *   Phase 2: 依赖 Phase 1 的合约 (TokenFactory, PositionManager, SettlementV2, FundingRate)
 *   Phase 3: 依赖 Phase 2 的合约 (Liquidation)
 *   Phase 4: 配置和授权 (wiring, authorize, LP seed)
 */
contract DeployBSCTestnet is Script {
    // ── BSC Testnet Constants ──
    address constant WBNB = 0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd;
    address constant PANCAKE_ROUTER_V2 = 0xD99D1c33F9fC3444f8101754aBC46c52416550D1;

    // ── Configuration ──
    uint256 constant SEED_LP_BNB = 0.5 ether;       // PerpVault 初始 LP
    uint256 constant INSURANCE_SEED = 0.1 ether;     // 保险基金种子
    uint256 constant MAX_OI_PER_TOKEN = 10 ether;    // 每代币最大 OI
    uint256 constant DEPOSIT_CAP_PER_USER = 10 ether;
    uint256 constant DEPOSIT_CAP_TOTAL = 100 ether;

    // ── Deployed Contracts ──
    PriceFeed public priceFeed;
    Vault public vault;
    ContractRegistry public registry;
    RiskManager public riskManager;
    PerpVault public perpVault;
    InsuranceFund public insuranceFund;
    Settlement public settlement;
    TokenFactory public tokenFactory;
    PositionManager public positionManager;
    SettlementV2 public settlementV2;
    FundingRate public fundingRate;
    Liquidation public liquidation;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console.log("=============================================");
        console.log("  BSC Testnet Full Deployment");
        console.log("=============================================");
        console.log("Deployer:", deployer);
        console.log("Balance:", deployer.balance / 1e18, "BNB");
        console.log("WBNB:", WBNB);
        console.log("PancakeRouter:", PANCAKE_ROUTER_V2);
        require(deployer.balance >= 1.5 ether, "Need at least 1.5 BNB for deployment + LP");

        vm.startBroadcast(deployerKey);

        // ════════════════════════════════════════════
        //  Phase 1: No-dependency contracts
        // ════════════════════════════════════════════
        console.log("\n=== Phase 1: Base Contracts ===");

        priceFeed = new PriceFeed();
        console.log("PriceFeed:", address(priceFeed));

        vault = new Vault();
        console.log("Vault:", address(vault));

        registry = new ContractRegistry();
        console.log("ContractRegistry:", address(registry));

        riskManager = new RiskManager();
        console.log("RiskManager:", address(riskManager));

        perpVault = new PerpVault();
        console.log("PerpVault:", address(perpVault));

        insuranceFund = new InsuranceFund();
        console.log("InsuranceFund:", address(insuranceFund));

        settlement = new Settlement();
        console.log("Settlement (V1):", address(settlement));

        // ════════════════════════════════════════════
        //  Phase 2: Contracts with dependencies
        // ════════════════════════════════════════════
        console.log("\n=== Phase 2: Dependent Contracts ===");

        tokenFactory = new TokenFactory(deployer, deployer, PANCAKE_ROUTER_V2, WBNB);
        console.log("TokenFactory:", address(tokenFactory));

        positionManager = new PositionManager(
            address(vault),
            address(priceFeed),
            address(riskManager)
        );
        console.log("PositionManager:", address(positionManager));

        settlementV2 = new SettlementV2(WBNB, deployer, deployer);
        console.log("SettlementV2:", address(settlementV2));

        fundingRate = new FundingRate(
            address(positionManager),
            address(vault),
            address(priceFeed)
        );
        console.log("FundingRate:", address(fundingRate));

        // ════════════════════════════════════════════
        //  Phase 3: Contracts depending on Phase 2
        // ════════════════════════════════════════════
        console.log("\n=== Phase 3: Final Contracts ===");

        liquidation = new Liquidation(
            address(positionManager),
            address(vault),
            address(riskManager),
            address(priceFeed)
        );
        console.log("Liquidation:", address(liquidation));
        liquidation.setTokenFactory(address(tokenFactory));
        console.log("  TokenFactory set on Liquidation");

        // ════════════════════════════════════════════
        //  Phase 4: Configuration & Wiring
        // ════════════════════════════════════════════
        console.log("\n=== Phase 4: Configuration ===");

        // --- PriceFeed <-> TokenFactory ---
        priceFeed.setTokenFactory(address(tokenFactory));
        tokenFactory.setPriceFeed(address(priceFeed));
        console.log("PriceFeed <-> TokenFactory wired");

        // --- Settlement V1 Configuration ---
        settlement.setContractRegistry(address(registry));
        settlement.addSupportedToken(WBNB, 18);
        settlement.setWETH(WBNB);
        settlement.setAuthorizedMatcher(deployer, true);
        settlement.setInsuranceFund(address(insuranceFund));
        settlement.setFeeReceiver(deployer);
        console.log("Settlement V1 configured (WBNB as collateral)");

        // --- InsuranceFund ---
        insuranceFund.setSettlement(address(settlement));
        insuranceFund.setAuthorizedContract(deployer, true);
        console.log("InsuranceFund configured");

        // --- Vault ---
        vault.setAuthorizedContract(address(positionManager), true);
        vault.setAuthorizedContract(address(liquidation), true);
        vault.setAuthorizedContract(address(fundingRate), true);
        vault.setInsuranceFund(address(liquidation));
        console.log("Vault configured (PM, Liq, FR authorized)");

        // --- RiskManager ---
        riskManager.setPositionManager(address(positionManager));
        riskManager.setInsuranceFund(address(liquidation));
        console.log("RiskManager configured");

        // --- PositionManager ---
        positionManager.setFundingRate(address(fundingRate));
        positionManager.setLiquidation(address(liquidation));
        console.log("PositionManager configured");

        // --- PerpVault (LP Pool) ---
        perpVault.setAuthorizedContract(deployer, true);
        perpVault.setVault(address(vault));
        console.log("PerpVault authorized & vault set");

        // Seed LP liquidity
        perpVault.deposit{value: SEED_LP_BNB}();
        console.log("PerpVault seeded with", SEED_LP_BNB / 1e18, "BNB");

        // --- SettlementV2 (dYdX-style Merkle Withdrawal) ---
        settlementV2.setAuthorizedUpdater(deployer, true);
        settlementV2.setDepositCapPerUser(DEPOSIT_CAP_PER_USER);
        settlementV2.setDepositCapTotal(DEPOSIT_CAP_TOTAL);
        console.log("SettlementV2 configured (caps: 10/100 BNB)");

        // --- Seed Insurance Fund ---
        (bool ok,) = address(liquidation).call{value: INSURANCE_SEED}("");
        require(ok, "Insurance seed failed");
        console.log("Liquidation insurance seeded with", INSURANCE_SEED / 1e18, "BNB");

        vm.stopBroadcast();

        // ════════════════════════════════════════════
        //  Output Summary
        // ════════════════════════════════════════════
        console.log("\n=============================================");
        console.log("  DEPLOYMENT COMPLETE!");
        console.log("=============================================");
        console.log("");
        console.log("--- Common ---");
        console.log("PriceFeed:        ", address(priceFeed));
        console.log("Vault:            ", address(vault));
        console.log("ContractRegistry: ", address(registry));
        console.log("");
        console.log("--- Spot ---");
        console.log("TokenFactory:     ", address(tokenFactory));
        console.log("");
        console.log("--- Perpetual ---");
        console.log("PositionManager:  ", address(positionManager));
        console.log("Settlement (V1):  ", address(settlement));
        console.log("SettlementV2:     ", address(settlementV2));
        console.log("PerpVault:        ", address(perpVault));
        console.log("RiskManager:      ", address(riskManager));
        console.log("FundingRate:      ", address(fundingRate));
        console.log("Liquidation:      ", address(liquidation));
        console.log("InsuranceFund:    ", address(insuranceFund));
        console.log("");
        console.log("--- Tokens ---");
        console.log("WBNB:             ", WBNB);
        console.log("");
        console.log("--- PerpVault LP ---");
        console.log("Pool Value:       ", address(perpVault).balance);
        console.log("Deployer Balance: ", deployer.balance);
        console.log("=============================================");
    }
}
