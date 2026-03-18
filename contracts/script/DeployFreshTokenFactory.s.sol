// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/spot/TokenFactory.sol";
import "../src/common/PriceFeed.sol";

/**
 * @title DeployFreshTokenFactory
 * @notice Deploy fresh TokenFactory + PriceFeed, wire them together.
 *
 * Usage:
 *   cd contracts
 *   forge script script/DeployFreshTokenFactory.s.sol \
 *     --rpc-url $BSC_TESTNET_RPC_URL --broadcast --slow -vvv
 */
contract DeployFreshTokenFactory is Script {
    // BSC Mainnet PancakeSwap V2 Router
    address constant UNISWAP_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    // BSC Mainnet WBNB
    address constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console.log("Deployer:", deployer);
        console.log("Balance:", deployer.balance);

        vm.startBroadcast(deployerKey);

        // 1. Deploy PriceFeed
        PriceFeed priceFeed = new PriceFeed();
        console.log("PriceFeed deployed:", address(priceFeed));

        // 2. Deploy TokenFactory
        TokenFactory tokenFactory = new TokenFactory(deployer, deployer, UNISWAP_ROUTER, WBNB);
        console.log("TokenFactory deployed:", address(tokenFactory));

        // 3. Wire: PriceFeed <-> TokenFactory
        priceFeed.setTokenFactory(address(tokenFactory));
        tokenFactory.setPriceFeed(address(priceFeed));
        console.log("PriceFeed <-> TokenFactory wired");

        vm.stopBroadcast();

        console.log("\n========================================");
        console.log("Fresh Deploy Complete!");
        console.log("  TokenFactory:", address(tokenFactory));
        console.log("  PriceFeed:   ", address(priceFeed));
        console.log("========================================");
    }
}
