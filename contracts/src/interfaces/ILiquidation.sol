// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILiquidation {
    function liquidate(address user) external;
    function liquidateBatch(address[] calldata users) external;
    function canLiquidate(address user) external view returns (bool);
    function getLiquidatableUsers(address[] calldata users) external view returns (address[] memory liquidatable);
    function getLiquidationReward(address user) external view returns (uint256 reward);
    function getInsuranceFund() external view returns (uint256);
    function getStats() external view returns (uint256 count, uint256 volume);

    // ADL queue management
    function addToADLQueue(address user) external;
    function removeFromADLQueue(address user) external;
    function executeADL() external;
    function executeADLWithSortedUsers(
        address[] calldata sortedUsers,
        bool targetSide,
        uint256 targetAmount
    ) external;

    // ADL queue view functions
    function getUserPnL(address user) external view returns (int256 pnl);
    function getUsersPnL(address[] calldata users) external view returns (int256[] memory pnls);
    function getADLQueueLength() external view returns (uint256);
    function getADLQueueUsers(uint256 start, uint256 count) external view returns (address[] memory users);

    // Insurance fund functions (called by Vault)
    function payProfit(address user, uint256 amount) external;
    function coverDeficit(uint256 amount) external returns (uint256 covered);
}
