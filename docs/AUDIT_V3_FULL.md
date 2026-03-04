# V3 Full Codebase Audit Report

> **Date**: 2026-03-04
> **Scope**: Full codebase — matching engine, smart contracts, Go backend, frontend
> **Chain**: BSC Testnet (Chain ID 97)
> **Methodology**: Line-by-line code audit across all layers, cross-referenced with V1/V2 audit findings

---

## Executive Summary

This is the third comprehensive audit of the Meme Perp DEX codebase, following V1 (2026-03-01, 48 issues) and V2 (2026-03-03, 75 issues). This audit verifies which previous findings have been fixed, identifies new issues, and provides the definitive current-state assessment.

**Totals**: 47 issues remain across all severity levels. 34+ issues from V1/V2/V3 have been confirmed fixed.

> **Update 2026-03-04**: 9 issues fixed in this session (CR-01, H-01~H-07, M-26). See "FIXED" markers below.

| Severity | Still Exists | Already Fixed | Total Examined |
|----------|-------------|---------------|----------------|
| CRITICAL | 0 | 1 | 1 |
| HIGH | 3 | 15 | 18 |
| MEDIUM | 29 | 13 | 42 |
| LOW | 15 | 5 | 20 |

---

## CRITICAL (1 Issue)

### CR-01: `/api/v2/withdraw/request` has NO authentication and does NOT deduct balance
**File**: `backend/src/matching/server.ts` L10356-10382
**Impact**: Anyone can generate signed withdrawal authorizations for any user without authentication. The endpoint generates EIP-712 signatures and Merkle proofs but never deducts the user's balance, allowing double-spend.
**Status**: ✅ FIXED (2026-03-04)
**Fix Applied**: Added EIP-191 signature authentication (verifyAuthSignature), balance availability check, atomic balance deduction with rollback on failure.

---

## HIGH (10 Issues)

### H-01: `subscribe_risk` WebSocket has no authentication
**File**: `server.ts` L12220-12259
**Impact**: Any WS client can subscribe to any trader's real-time positions, margin, and PnL data.
**Status**: ✅ FIXED (2026-03-04) — Requires EIP-191 signature + timestamp (5-min anti-replay window).

### H-02: `broadcastMarginUpdate` leaks to ALL connected clients
**File**: `server.ts` L9762-9779
**Impact**: Margin adjustments for one user are broadcast to every WebSocket client.
**Status**: ✅ FIXED (2026-03-04) — Changed to per-user targeting via `wsTraderClients`.

### H-03: `/api/internal/snapshot/trigger` and `/liquidation/trigger` have no auth
**File**: `server.ts` L11144-11186
**Impact**: Anyone can trigger Merkle snapshots or liquidation sweeps.
**Status**: ✅ FIXED (2026-03-04) — Added INTERNAL_API_KEY auth (same pattern as `/api/internal/positions/all`).

### H-04: Withdrawal nonce not incremented after signing (withdraw.ts)
**File**: `backend/src/matching/modules/withdraw.ts` L228-324
**Impact**: `generateWithdrawalAuthorization()` generates a valid signature but does not call `incrementNonce()`. The nonce only increments in `markWithdrawalCompleted()`, which is called after on-chain confirmation. This allows multiple withdrawal authorizations with the same nonce.
**Status**: ✅ FIXED (2026-03-04) — Nonce incremented immediately after signing; `markWithdrawalCompleted` only cleans up pending.

### H-05: `SKIP_SIGNATURE_VERIFY` production risk
**File**: `backend/src/matching/config.ts` L130
**Impact**: If `NODE_ENV` is not explicitly set or misconfigured, signature verification may be bypassed.
**Status**: ✅ FIXED (2026-03-04) — config.ts now requires `NODE_ENV=test` AND env flag. server.ts has production abort guard.

### H-06: Frontend allows 100x leverage while engine limits 10x
**File**: `frontend/src/components/perpetual/PerpetualOrderPanelV2.tsx` L42
**Impact**: `LEVERAGE_OPTIONS = [1, 2, 3, 5, 10, 20, 50, 75, 100]` — user can select up to 100x but engine rejects >10x, causing confusing UX failures.
**Status**: ✅ FIXED (2026-03-04) — Changed to `[1, 2, 3, 5, 10]`.

### H-07: No leverage validation in order submission handler
**File**: `server.ts` L6280-6450
**Impact**: `handleOrderSubmit` does not validate leverage against MAX_LEVERAGE before processing.
**Status**: ✅ FIXED (2026-03-04) — Added leverage validation using `TRADING.MAX_LEVERAGE * PRECISION_MULTIPLIER.LEVERAGE`.

### H-08: TokenFactory `_distributeTradingFee` double-counts referrer share
**File**: `contracts/src/spot/TokenFactory.sol` L339-368
**Impact**: When `referrer == address(0)`, the 10% referrer share is not sent but still counted, draining 10% from reserves on every no-referrer trade.

### H-09: Liquidation.sol `insuranceFund` is phantom accounting
**File**: `contracts/src/perpetual/Liquidation.sol` L36, L122-135, L180-194
**Impact**: `insuranceFund` state variable tracks a balance but contract holds no real ETH. Liquidation decisions based on phantom funds.

### H-10: Dual insurance fund systems (Liquidation.sol + PerpVault) with no reconciliation
**File**: Cross-contract (Liquidation.sol + PerpVault.sol)
**Impact**: Two independent insurance fund tracking systems exist with no bridge between them.

---

## MEDIUM (30 Issues)

### Matching Engine (12)

| ID | Issue | File | Line |
|----|-------|------|------|
| M-01 | `subscribe_global_risk` WS unauthenticated | server.ts | L12274 |
| M-02 | ~~`broadcastTPSLTriggered/Executed` leaks to ALL~~ | server.ts | L3093 | ✅ FIXED |
| M-03 | ~~`broadcastLiquidationEvent` leaks to ALL~~ | server.ts | L2121 | ✅ FIXED |
| M-04 | ~~`broadcastPositionClosed` leaks to ALL~~ | server.ts | L8425 | ✅ FIXED |
| M-05 | `/api/balance/sync` no auth, DoS vector | server.ts | L10642 |
| M-06 | Leverage truncation `Math.floor` loses precision | server.ts | L9546 |
| M-07 | `canWithdraw()` no on-chain `totalWithdrawn` check | withdraw.ts | L192 |
| M-08 | `calculateUserEquity` ignores pending withdrawals | snapshot.ts | L102 |
| M-09 | `getProof()` rebuilds Merkle tree on every call | merkle.ts | L221 |
| M-10 | Failed PerpVault settlements permanently lost | perpVault.ts | L796 |
| M-11 | No dedup for relay deposit events | relay.ts | L302 |
| M-12 | `syncBalanceFromChain` overwrites usedMargin to 0 | balance.ts | L132 |

### Smart Contracts (12)

| ID | Issue | File | Line |
|----|-------|------|------|
| M-13 | `rollbackGraduation` inflates token supply | TokenFactory.sol | L725 |
| M-14 | Zero ETH slippage in graduation `_graduate()` | TokenFactory.sol | L593 |
| M-15 | `liquidateSingle` lacks `nonReentrant` | Liquidation.sol | — |
| M-16 | Inconsistent liquidation reward source | Liquidation.sol | — |
| M-17 | `executeADLWithSortedUsers` no access control | Liquidation.sol | L528 |
| M-18 | `receive()` lacks nonReentrant + whenNotPaused | Vault.sol | L602 |
| M-19 | `settleBankruptcy` orphans ETH on transfer fail | Vault.sol | L458 |
| M-20 | `distributeLiquidation` dual-debit insolvency | Vault.sol | L496 |
| M-21 | `settleTraderProfit` griefable by rejecting ETH | PerpVault.sol | L467 |
| M-22 | `decreaseOI` silent clamping causes drift | PerpVault.sol | L579 |
| M-23 | `emergencyRescue` no timelock/multi-sig | PerpVault.sol | L779 |
| M-24 | PerpVault bypasses Vault accounting | Cross-contract | — |

### Go Backend + Frontend (6)

| ID | Issue | File |
|----|-------|------|
| M-25 | Go nonce store no GC, unbounded memory | auth.go L67 |
| M-26 | ~~Go backend allows 100x leverage~~ | account.go L118 | ✅ FIXED |
| M-27 | `parseFloat` for ETH amounts in validators | validators.ts |
| M-28 | eip712.ts TESTNET/MAINNET same env var | eip712.ts L6-7 |
| M-29 | Market order match at currentPrice=0 possible | engine.ts L953 |
| M-30 | Hardcoded default addresses may be stale | config.ts L23 |

---

## LOW (15 Issues)

| ID | Issue | File |
|----|-------|------|
| L-01 | `broadcastPositionUpdate` leaks user address | server.ts L5838 |
| L-02 | Filled orders never cleaned from Map | engine.ts L231 |
| L-03 | `Number(b.price - a.price)` BigInt overflow | engine.ts L239 |
| L-04 | Merkle timestamp ms vs s inconsistency | merkle.ts |
| L-05 | ZSet price scaling mismatch in Redis | redis.ts |
| L-06 | `lastCheckTime` data race in Go keeper | liquidation.go L47 |
| L-07 | Hardcoded "ETH" string in account service | account.go L172 |
| L-08 | Stale test expects Base Mainnet chainId | validators.test.ts L113 |
| L-09 | `parseFloat` in order submission frontend | orderSigning.ts |
| L-10 | TokenFactory `receive()` no accounting | TokenFactory.sol |
| L-11 | Anyone can inflate Liquidation insurance | Liquidation.sol |
| L-12 | Vault withdrawal delay bypass possible | Vault.sol |
| L-13 | PerpVault `requestWithdrawal` resets cooldown | PerpVault.sol |
| L-14 | PerpVault donation attack vector | PerpVault.sol |
| L-15 | `indexOf` reference equality after spread+sort | perpVault.ts L788 |

---

## CONFIRMED FIXED (25+ Issues)

These issues from V1/V2 audits have been verified as properly fixed:

| Original ID | Issue | Fix Verified |
|-------------|-------|-------------|
| ME-C01 | `broadcastBalanceUpdate` leaked all balances | Now uses `wsTraderClients` per-user |
| ME-C02 | Deadline sec/ms confusion in withdraw | Uses `Math.floor(Date.now()/1000)` |
| ME-C03 | Liquidation price used static MMR | Dynamic MMR calculation |
| ME-C06 | Nonce TOCTOU race condition | Protected by `withLock()` |
| ME-H08 | Internal APIs no auth | Auth middleware added |
| — | Fake deposit API unguarded | `ALLOW_FAKE_DEPOSIT` env guard |
| — | `currentTimeMillis()` returns 0 | Returns `Date.now()` correctly |
| — | `broadcastOrderUpdate` leaked to all | Per-user targeting |
| — | Nonce not persisted to Redis | Write-through cache pattern |
| W-03 | withdraw.ts `verifyingContract` was `0x0` | Set during `initializeWithdrawModule()` |
| W-04 | Deadline comparison was `< Date.now()` | Fixed to `< Math.floor(Date.now()/1000)` |
| S-02 | Snapshot `isRunning` guard missing | Guard added |
| PV-01 | PerpVault module not handling `increaseOI` | Full OI lifecycle implemented |
| C-01 | WBNB address hardcoded wrong | Configurable via env |
| E-01 | Orders not matched by token | Token-specific orderbooks |
| — | Keeper reads empty PostgreSQL | HTTP fallback to engine API |
| — | chainId fallback inconsistent | Unified config |
| — | Settlement address mismatch | 7-file sync pattern |
| CR-01 | `/api/v2/withdraw/request` no auth + no balance deduction | EIP-191 auth + atomic balance deduction + rollback |
| H-01 | `subscribe_risk` WS no auth | Signature + timestamp anti-replay verification |
| H-02 | `broadcastMarginUpdate` leaked to all | Per-user via `wsTraderClients` |
| H-03 | Internal trigger endpoints no auth | INTERNAL_API_KEY required |
| H-04 | Withdrawal nonce not incremented after signing | Increment immediately in `generateWithdrawalAuthorization()` |
| H-05 | `SKIP_SIGNATURE_VERIFY` production risk | Double-guard: `NODE_ENV=test` + env flag |
| H-06 | Frontend 100x leverage | Changed to `[1,2,3,5,10]` |
| H-07 | No leverage validation in `handleOrderSubmit` | Added `TRADING.MAX_LEVERAGE * PRECISION_MULTIPLIER.LEVERAGE` check |
| M-02 | TPSL broadcast leaked to all | Per-user via `wsTraderClients` |
| M-03 | Liquidation broadcast leaked to all | Per-user via `wsTraderClients` |
| M-04 | Position closed/partial close broadcast leaked | Per-user via `wsTraderClients` |
| M-26 | Go backend 100x leverage | Changed to max 10x |

---

## Priority Fix Recommendations

### ✅ Immediate — ALL FIXED (2026-03-04)
1. ~~**CR-01**: Add auth + balance deduction to `/api/v2/withdraw/request`~~ ✅
2. ~~**H-01**: Require authentication for `subscribe_risk` WS~~ ✅
3. ~~**H-03**: Add auth middleware to internal trigger endpoints~~ ✅
4. ~~**H-04**: Increment nonce atomically in `generateWithdrawalAuthorization()`~~ ✅
5. ~~**H-06**: Limit frontend leverage options to match engine MAX_LEVERAGE~~ ✅

### Short-term (Before mainnet)
6. ~~**H-07**: Validate leverage in `handleOrderSubmit`~~ ✅
7. **H-08**: Fix TokenFactory fee distribution for no-referrer trades
8. **H-09/H-10**: Consolidate insurance fund to single source (PerpVault)
9. ~~**M-02 through M-04**: Fix all broadcast leaks to use per-user targeting~~ ✅
10. **M-05**: Add auth to `/api/balance/sync`

### Medium-term (Production hardening)
11. Fix all remaining MEDIUM contract issues (M-13 through M-24)
12. Implement proper GC for Go nonce store (M-25)
13. ~~**M-26**: Align leverage limits across all layers~~ ✅
14. Replace `parseFloat` with BigInt in frontend validators (M-27)

---

## Appendix: Audit Scope

| Layer | Files Examined | Key Entry Points |
|-------|---------------|-----------------|
| Matching Engine | server.ts (13,380 lines) | All 50+ API endpoints, WS handlers |
| Matching Modules | withdraw.ts, snapshot.ts, merkle.ts, perpVault.ts, relay.ts, balance.ts, wallet.ts, config.ts, engine.ts, precision.ts | All exported functions |
| Smart Contracts | TokenFactory.sol, Liquidation.sol, Vault.sol, PerpVault.sol, SettlementV2.sol | All external/public functions |
| Go Backend | auth.go, account.go, trade.go, liquidation.go, config.yaml | API handlers, keeper loops |
| Frontend | PerpetualOrderPanelV2.tsx, validators.ts, eip712.ts, contracts.ts, orderSigning.ts | User input paths, contract calls |

---

*Generated by V3 Full Codebase Audit — 2026-03-04*
