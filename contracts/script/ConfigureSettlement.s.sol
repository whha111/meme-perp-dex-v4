// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

/**
 * @title ConfigureSettlement
 * @notice Phase 0: Bootstrap on-chain settlement infrastructure
 *
 * Actions:
 *   1. Authorize matcher wallet on PerpVault
 *   2. Deposit seed LP liquidity (2 ETH) into PerpVault
 *   3. Set per-token OI caps on PerpVault
 *   4. Authorize matcher as state root updater on SettlementV2
 *   5. Set deposit caps on SettlementV2
 *   6. Set platform signer on SettlementV2 (for withdrawal signatures)
 *
 * Usage:
 *   cd contracts
 *   forge script script/ConfigureSettlement.s.sol \
 *     --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast -vvv
 */
contract ConfigureSettlement is Script {
    // ── Contract Addresses ──
    address constant PERP_VAULT = 0x586FB78b8dB39d8D89C1Fd2Aa0c756C828e5251F;
    address constant SETTLEMENT_V2 = 0x733EccCf612F70621c772D63334Cf5606d7a7C75;
    address constant VAULT = 0xcc4Fa8Df0686824F92d392Cb650057EA7D2EF46E;

    // ── Supported Tokens (from TokenFactory.getAllTokens()) ──
    address constant DOGE = 0x1BC7c612e55b8CC8e24aA4041FAC3732d50C4C6F;
    address constant PEPE = 0x0d0156063c5f805805d5324af69932FB790819D5;
    address constant SHIB = 0x0724863BD88e1F4919c85294149ae87209E917Da;

    // ── Configuration ──
    uint256 constant SEED_LP_ETH = 2 ether;
    uint256 constant MAX_OI_PER_TOKEN = 10 ether;
    uint256 constant DEPOSIT_CAP_PER_USER = 10 ether;
    uint256 constant DEPOSIT_CAP_TOTAL = 100 ether;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console.log("=== Phase 0: Settlement Bootstrap ===");
        console.log("Deployer/Matcher:", deployer);
        console.log("Deployer balance:", deployer.balance);
        console.log("");

        vm.startBroadcast(deployerKey);

        // ────────────────────────────────────────
        // 1. PerpVault: Authorize matcher wallet
        // ────────────────────────────────────────
        console.log("1. Authorizing matcher on PerpVault...");
        (bool ok1,) = PERP_VAULT.call(
            abi.encodeWithSignature("setAuthorizedContract(address,bool)", deployer, true)
        );
        require(ok1, "setAuthorizedContract failed");
        console.log("   Done: matcher authorized on PerpVault");

        // ────────────────────────────────────────
        // 2. PerpVault: Set Vault address (for settleTraderProfit ETH routing)
        // ────────────────────────────────────────
        console.log("2. Setting Vault on PerpVault...");
        (bool ok2,) = PERP_VAULT.call(
            abi.encodeWithSignature("setVault(address)", VAULT)
        );
        require(ok2, "setVault failed");
        console.log("   Done: Vault set on PerpVault");

        // ────────────────────────────────────────
        // 3. PerpVault: Deposit seed LP liquidity
        // ────────────────────────────────────────
        console.log("3. Depositing seed LP liquidity...");
        uint256 currentPoolValue = _getPoolValue();
        if (currentPoolValue < 1 ether) {
            (bool ok3,) = PERP_VAULT.call{value: SEED_LP_ETH}(
                abi.encodeWithSignature("deposit()")
            );
            require(ok3, "deposit failed");
            console.log("   Done: deposited", SEED_LP_ETH / 1e18, "ETH into PerpVault");
        } else {
            console.log("   Skipped: pool already has", currentPoolValue / 1e18, "ETH");
        }

        // ────────────────────────────────────────
        // 4. PerpVault: Set per-token OI caps
        // ────────────────────────────────────────
        console.log("4. Setting per-token OI caps...");
        address[3] memory tokens = [DOGE, PEPE, SHIB];
        for (uint256 i = 0; i < tokens.length; i++) {
            (bool ok4,) = PERP_VAULT.call(
                abi.encodeWithSignature("setMaxOIPerToken(address,uint256)", tokens[i], MAX_OI_PER_TOKEN)
            );
            require(ok4, "setMaxOIPerToken failed");
        }
        console.log("   Done: max OI per token =", MAX_OI_PER_TOKEN / 1e18, "ETH");

        // ────────────────────────────────────────
        // 5. SettlementV2: Authorize matcher as state root updater
        // ────────────────────────────────────────
        console.log("5. Authorizing matcher on SettlementV2...");
        (bool ok5,) = SETTLEMENT_V2.call(
            abi.encodeWithSignature("setAuthorizedUpdater(address,bool)", deployer, true)
        );
        require(ok5, "setAuthorizedUpdater failed");
        console.log("   Done: matcher authorized as state root updater");

        // ────────────────────────────────────────
        // 6. SettlementV2: Set platform signer (= deployer for now)
        // ────────────────────────────────────────
        console.log("6. Setting platform signer on SettlementV2...");
        (bool ok6,) = SETTLEMENT_V2.call(
            abi.encodeWithSignature("setPlatformSigner(address)", deployer)
        );
        require(ok6, "setPlatformSigner failed");
        console.log("   Done: platform signer set");

        // ────────────────────────────────────────
        // 7. SettlementV2: Set deposit caps
        // ────────────────────────────────────────
        console.log("7. Setting deposit caps on SettlementV2...");
        (bool ok7,) = SETTLEMENT_V2.call(
            abi.encodeWithSignature("setDepositCapPerUser(uint256)", DEPOSIT_CAP_PER_USER)
        );
        require(ok7, "setDepositCapPerUser failed");
        (bool ok8,) = SETTLEMENT_V2.call(
            abi.encodeWithSignature("setDepositCapTotal(uint256)", DEPOSIT_CAP_TOTAL)
        );
        require(ok8, "setDepositCapTotal failed");
        console.log("   Done: per-user cap = 10 ETH, total cap = 100 ETH");

        vm.stopBroadcast();

        // ── Final Status ──
        console.log("");
        console.log("=== BOOTSTRAP COMPLETE ===");
        console.log("PerpVault pool value:", _getPoolValue());
        console.log("Deployer remaining balance:", deployer.balance);
        console.log("");
        console.log("Next: Start docker-compose and verify settlement pipeline");
    }

    function _getPoolValue() internal view returns (uint256) {
        (bool ok, bytes memory data) = PERP_VAULT.staticcall(
            abi.encodeWithSignature("getPoolValue()")
        );
        if (!ok || data.length == 0) return 0;
        return abi.decode(data, (uint256));
    }
}
