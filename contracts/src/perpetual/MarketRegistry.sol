// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title MarketRegistry
 * @notice Whitelist registry for curated meme perpetual markets.
 * @dev Market IDs are bytes32 hashes of canonical strings such as DOGE-USDT-PERP.
 *      This contract does not custody funds or calculate PnL. SettlementV2 and
 *      PerpVault remain the custody and settlement anchors.
 */
contract MarketRegistry is Ownable2Step {
    enum MarketStatus {
        Paused,
        Active,
        ReduceOnly,
        Experimental
    }

    struct Market {
        bytes32 marketId;
        string displaySymbol;
        address indexToken;
        bool allowWBNB;
        bool allowUSDT;
        uint256 maxLeverage; // 1e4 precision, 3x = 30000
        uint256 maxOiUsd; // 1e30 USD precision, GMX-style
        uint256 maxPositionUsd; // 1e30 USD precision
        MarketStatus status;
        bytes32 sourceConfigHash;
        uint256 updatedAt;
        bool exists;
    }

    address public wbnb;
    address public usdt;

    mapping(bytes32 => Market) private markets;
    bytes32[] private marketIds;

    event CollateralTokensSet(address indexed wbnb, address indexed usdt);
    event MarketUpserted(
        bytes32 indexed marketId,
        string displaySymbol,
        address indexed indexToken,
        MarketStatus status,
        uint256 maxLeverage,
        uint256 maxOiUsd,
        uint256 maxPositionUsd
    );
    event MarketStatusSet(bytes32 indexed marketId, MarketStatus status);
    event MarketRemoved(bytes32 indexed marketId);

    error ZeroAddress();
    error UnknownMarket();
    error InvalidMarket();
    error InvalidRiskCaps();

    constructor(address initialOwner, address _wbnb, address _usdt) Ownable(initialOwner) {
        if (initialOwner == address(0) || _wbnb == address(0) || _usdt == address(0)) revert ZeroAddress();
        wbnb = _wbnb;
        usdt = _usdt;
        emit CollateralTokensSet(_wbnb, _usdt);
    }

    function setCollateralTokens(address _wbnb, address _usdt) external onlyOwner {
        if (_wbnb == address(0) || _usdt == address(0)) revert ZeroAddress();
        wbnb = _wbnb;
        usdt = _usdt;
        emit CollateralTokensSet(_wbnb, _usdt);
    }

    function upsertMarket(
        bytes32 marketId,
        string calldata displaySymbol,
        address indexToken,
        bool allowWBNB,
        bool allowUSDT,
        uint256 maxLeverage,
        uint256 maxOiUsd,
        uint256 maxPositionUsd,
        MarketStatus status,
        bytes32 sourceConfigHash
    ) external onlyOwner {
        if (marketId == bytes32(0) || bytes(displaySymbol).length == 0 || indexToken == address(0)) {
            revert InvalidMarket();
        }
        if (!allowWBNB && !allowUSDT) revert InvalidMarket();
        if (maxLeverage < 10_000 || maxLeverage > 30_000 || maxOiUsd == 0 || maxPositionUsd == 0) {
            revert InvalidRiskCaps();
        }
        if (maxPositionUsd > maxOiUsd) revert InvalidRiskCaps();

        Market storage market = markets[marketId];
        if (!market.exists) {
            marketIds.push(marketId);
            market.marketId = marketId;
            market.exists = true;
        }

        market.displaySymbol = displaySymbol;
        market.indexToken = indexToken;
        market.allowWBNB = allowWBNB;
        market.allowUSDT = allowUSDT;
        market.maxLeverage = maxLeverage;
        market.maxOiUsd = maxOiUsd;
        market.maxPositionUsd = maxPositionUsd;
        market.status = status;
        market.sourceConfigHash = sourceConfigHash;
        market.updatedAt = block.timestamp;

        emit MarketUpserted(
            marketId,
            displaySymbol,
            indexToken,
            status,
            maxLeverage,
            maxOiUsd,
            maxPositionUsd
        );
    }

    function setMarketStatus(bytes32 marketId, MarketStatus status) external onlyOwner {
        Market storage market = markets[marketId];
        if (!market.exists) revert UnknownMarket();
        market.status = status;
        market.updatedAt = block.timestamp;
        emit MarketStatusSet(marketId, status);
    }

    function removeMarket(bytes32 marketId) external onlyOwner {
        Market storage market = markets[marketId];
        if (!market.exists) revert UnknownMarket();
        delete markets[marketId];

        for (uint256 i = 0; i < marketIds.length; i++) {
            if (marketIds[i] == marketId) {
                marketIds[i] = marketIds[marketIds.length - 1];
                marketIds.pop();
                break;
            }
        }

        emit MarketRemoved(marketId);
    }

    function getMarket(bytes32 marketId) external view returns (Market memory) {
        Market memory market = markets[marketId];
        if (!market.exists) revert UnknownMarket();
        return market;
    }

    function getMarketIds() external view returns (bytes32[] memory) {
        return marketIds;
    }

    function marketCount() external view returns (uint256) {
        return marketIds.length;
    }

    function isMarketOpen(bytes32 marketId) external view returns (bool) {
        Market memory market = markets[marketId];
        return market.exists && market.status == MarketStatus.Active;
    }

    function isReduceOnly(bytes32 marketId) external view returns (bool) {
        Market memory market = markets[marketId];
        return market.exists && market.status == MarketStatus.ReduceOnly;
    }

    function isCollateralAllowed(bytes32 marketId, address collateral) external view returns (bool) {
        Market memory market = markets[marketId];
        if (!market.exists) return false;
        if (collateral == wbnb) return market.allowWBNB;
        if (collateral == usdt) return market.allowUSDT;
        return false;
    }
}
