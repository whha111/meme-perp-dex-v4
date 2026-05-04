// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/perpetual/MarketRegistry.sol";

contract MarketRegistryTest is Test {
    MarketRegistry registry;

    address owner = address(0xA11CE);
    address wbnb = address(0xBEEF);
    address usdt = address(0xCAFE);
    address indexToken = address(0xD06E);
    bytes32 marketId = keccak256("DOGE-USDT-PERP");

    function setUp() public {
        registry = new MarketRegistry(owner, wbnb, usdt);
    }

    function testOwnerCanUpsertMarket() public {
        vm.prank(owner);
        registry.upsertMarket(
            marketId,
            "DOGE",
            indexToken,
            true,
            true,
            30_000,
            250_000 * 1e30,
            10_000 * 1e30,
            MarketRegistry.MarketStatus.Active,
            keccak256("binance_spot,binance_futures")
        );

        MarketRegistry.Market memory market = registry.getMarket(marketId);
        assertEq(market.displaySymbol, "DOGE");
        assertEq(market.indexToken, indexToken);
        assertEq(uint8(market.status), uint8(MarketRegistry.MarketStatus.Active));
        assertTrue(registry.isCollateralAllowed(marketId, wbnb));
        assertTrue(registry.isCollateralAllowed(marketId, usdt));
        assertEq(registry.marketCount(), 1);
    }

    function testMarketStatusCanMoveToReduceOnly() public {
        vm.startPrank(owner);
        registry.upsertMarket(
            marketId,
            "DOGE",
            indexToken,
            true,
            true,
            30_000,
            250_000 * 1e30,
            10_000 * 1e30,
            MarketRegistry.MarketStatus.Active,
            bytes32(0)
        );
        registry.setMarketStatus(marketId, MarketRegistry.MarketStatus.ReduceOnly);
        vm.stopPrank();

        assertFalse(registry.isMarketOpen(marketId));
        assertTrue(registry.isReduceOnly(marketId));
    }
}
