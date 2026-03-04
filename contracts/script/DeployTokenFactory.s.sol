// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/spot/TokenFactory.sol";

/**
 * @title DeployTokenFactory
 * @notice 单独部署 TokenFactory 合约
 */
contract DeployTokenFactory is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("Deployer:", deployer);
        console.log("Deployer balance:", deployer.balance);

        vm.startBroadcast(deployerPrivateKey);

        // BSC Testnet PancakeSwap V2 Router
        address uniswapRouter = 0xD99D1c33F9fC3444f8101754aBC46c52416550D1;

        TokenFactory tokenFactory = new TokenFactory(deployer, deployer, uniswapRouter);
        console.log("TokenFactory deployed at:", address(tokenFactory));

        vm.stopBroadcast();

        console.log("\n========================================");
        console.log("TokenFactory Deployment completed!");
        console.log("TokenFactory:", address(tokenFactory));
        console.log("========================================");
    }
}
