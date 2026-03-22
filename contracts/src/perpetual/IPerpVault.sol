// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IPerpVault
 * @notice Interface for PerpVault — GMX-style LP pool as counterparty for perpetual trades
 * @dev Production audit: compared against GMX V1/V2, HyperLiquid, Jupiter JLP,
 *      Gains Network, dYdX, Synthetix V3. See PERPVAULT_AUDIT_REPORT.md
 */
interface IPerpVault {
    // ── Settlement ──
    function settleTraderProfit(address trader, uint256 profitETH) external;
    function settleTraderLoss(uint256 lossETH) external payable;
    function settleLiquidation(uint256 collateralETH, uint256 liquidatorReward, address liquidator) external payable;

    // ── OI Tracking ──
    function increaseOI(address token, bool isLong, uint256 sizeETH) external;
    function decreaseOI(address token, bool isLong, uint256 sizeETH) external;

    // ── Fees ──
    function collectFee(uint256 feeETH) external payable;

    // ── C1: Unrealized PnL ──
    function updatePendingPnL(int256 _netPnL) external;

    // ── Trader Margin ──
    function depositMargin() external payable;
    function withdrawMargin(address trader, uint256 amount) external;
    function settleClose(address trader, int256 pnl, uint256 marginRelease) external;
    function batchDepositMargin(address[] calldata traders, uint256[] calldata amounts) external payable;
    function batchSettleClose(address[] calldata traders, int256[] calldata pnls, uint256[] calldata marginReleases) external;

    // ── View ──
    function getPoolValue() external view returns (uint256);
    function getRawBalance() external view returns (uint256);
    function getSharePrice() external view returns (uint256);
    function getMaxOI() external view returns (uint256);
    function getTotalOI() external view returns (uint256);
    function getLPValue(address lp) external view returns (uint256);
    function shouldADL() external view returns (bool shouldTrigger, uint256 pnlToPoolBps);
    function netPendingPnL() external view returns (int256);
    function getTraderMargin(address trader) external view returns (uint256);
    function getTotalTraderMargin() external view returns (uint256);
}
