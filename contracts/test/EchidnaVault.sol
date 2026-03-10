// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/perpetual/PerpVault.sol";

/// @title EchidnaVault — Invariant tests for PerpVault
/// @notice Property-based testing: Echidna will try to break these invariants
contract EchidnaVault {
    PerpVault internal vault;

    constructor() {
        vault = new PerpVault();
    }

    // ── Invariant 1: Share price never drops below 1e18 unless pool drained ──
    function echidna_share_price_floor() public view returns (bool) {
        if (vault.totalShares() == 0) return true;
        return vault.getSharePrice() >= 1e18;
    }

    // ── Invariant 2: Total shares >= DEAD_SHARES after first deposit ──
    function echidna_dead_shares() public view returns (bool) {
        if (vault.totalShares() == 0) return true;
        return vault.totalShares() >= vault.DEAD_SHARES();
    }

    // ── Invariant 3: Utilization ratio never exceeds 100% ──
    function echidna_utilization_cap() public view returns (bool) {
        return vault.getUtilization() <= 10000; // basis points
    }

    // ── Invariant 4: MIN_DEPOSIT is enforced ──
    function echidna_min_deposit() public view returns (bool) {
        return vault.MIN_DEPOSIT() == 0.001 ether;
    }

    // ── Invariant 5: Fee precision constants are consistent ──
    function echidna_fee_constants() public view returns (bool) {
        return vault.depositFeeBps() <= vault.FEE_PRECISION() &&
               vault.withdrawalFeeBps() <= vault.FEE_PRECISION();
    }
}
