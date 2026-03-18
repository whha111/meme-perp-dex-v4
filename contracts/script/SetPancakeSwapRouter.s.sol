// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";

interface ITokenFactory {
    function setUniswapV2Router(address newRouter) external;
    function uniswapV2Router() external view returns (address);
    function owner() external view returns (address);
}

contract SetPancakeSwapRouter is Script {
    function run() external {
        address TOKEN_FACTORY = 0x22276744bAF24eD503dB50Cc999a9c5AD62728cb;
        address PANCAKESWAP_V2_ROUTER = 0xD99D1c33F9fC3444f8101754aBC46c52416550D1;

        // Check current state
        ITokenFactory factory = ITokenFactory(TOKEN_FACTORY);
        address currentRouter = factory.uniswapV2Router();
        console.log("Current router:", currentRouter);
        console.log("Target router:", PANCAKESWAP_V2_ROUTER);
        console.log("Factory owner:", factory.owner());

        if (currentRouter == PANCAKESWAP_V2_ROUTER) {
            console.log("Router already set to PancakeSwap V2, skipping");
            return;
        }

        vm.startBroadcast();
        factory.setUniswapV2Router(PANCAKESWAP_V2_ROUTER);
        vm.stopBroadcast();

        // Verify
        address newRouter = factory.uniswapV2Router();
        console.log("New router:", newRouter);
        require(newRouter == PANCAKESWAP_V2_ROUTER, "Router update failed");
        console.log("SUCCESS: Router updated to PancakeSwap V2");
    }
}
