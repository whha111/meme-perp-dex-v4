// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IPriceFeed
 * @notice 简化版价格接口 - 100%硬锚Bonding Curve现货价格
 */
interface IPriceFeed {
    // Legacy single-token functions (返回0，不再使用)
    function getSpotPrice() external view returns (uint256);
    function getMarkPrice() external view returns (uint256);
    function getLastUpdateTime() external view returns (uint256);

    // Legacy update function (no-op，保持AMM兼容性)
    function updatePrice(uint256 newPrice) external;
    function updateTokenPrice(address token, uint256 newPrice) external;

    // Multi-token support (主要使用)
    function getTokenSpotPrice(address token) external view returns (uint256);
    function getTokenMarkPrice(address token) external view returns (uint256);
    function getTokenLastUpdateTime(address token) external view returns (uint256);
    function isTokenSupported(address token) external view returns (bool);
    function getSupportedTokens() external view returns (address[] memory);

    // Price update (only TokenFactory can call)
    function updateTokenPriceFromFactory(address token, uint256 newPrice) external;

    // P0-2: Uniswap V2 price update (permissionless — any keeper can call)
    function updateTokenPriceFromUniswap(address token) external;
    function setTokenUniswapPair(address token, address pair) external;
    function tokenUniswapPair(address token) external view returns (address);

    // Admin functions
    function addSupportedToken(address token, uint256 initialPrice) external;
    function addSupportedTokenFromFactory(address token, uint256 initialPrice) external;
    function removeSupportedToken(address token) external;
    function setWETH(address _weth) external;
}
