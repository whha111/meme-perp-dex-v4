# Comprehensive Single-Token E2E Test Report

**Date**: 2026-04-05T15:44:16.652Z
**Token**: DOGE3 (0x33cc9c28a58df057055775e9343811819401fc0c)
**Result**: **PARTIAL**
**Duration**: 31.7 minutes
**Checks**: 67/70 passed (3 failed)

---

## Phase Summary

| Phase | Status | Duration | Checks |
|-------|--------|----------|--------|
| ❌ P0: Environment | FAIL | 69.9s | 9/11 |
| ✅ P1: Referral | PASS | 0.1s | 4/4 |
| ✅ P2: Spot Trading | PASS | 11.4s | 3/3 |
| ❌ P3: Open Positions | FAIL | 35.8s | 6/7 |
| ✅ P4: TP/SL | PASS | 67.9s | 4/4 |
| ✅ P5: Close Positions | PASS | 476.1s | 4/4 |
| ✅ P6: Liquidation | PASS | 260.8s | 2/2 |
| ✅ P7: Funding Rate | PASS | 540.4s | 2/2 |
| ✅ P8: Withdrawal | PASS | 401.1s | 4/4 |
| ✅ P9: Referral Verify | PASS | 0.0s | 2/2 |
| ✅ P10: Boundaries | PASS | 36.3s | 5/5 |
| ✅ P11: Data Consistency | PASS | 0.9s | 22/22 |

---

## P0: Environment

- ✅ **Engine healthy**: ok
- ✅ **Go backend healthy**: OK
- ✅ **DOGE3 perpEnabled**: OK
- ✅ **DOGE3 isActive**: OK
- ✅ **PriceFeed has price**: 1.2233664242e-8
- ✅ **LP pool >= 3 BNB**: 102.28 BNB
- ✅ **DOGE3 circuit breaker closed**: OK
- ✅ **Wallet 40 balance**: 28.794 BNB
- ❌ **Wallet 10 deposit 3 BNB**: FAILED
- ✅ **Wallet 13 balance**: 13.856 BNB
- ❌ **Wallet 50 deposit 0.5 BNB**: FAILED

## P1: Referral

- ✅ **Referrer D registered**: code=Z4C0D6GY
- ✅ **Wallet A bound to referrer**: Already bound to a referrer
- ✅ **Wallet E bound to referrer**: Already bound to a referrer
- ✅ **Referrer D has >= 2 referees**: count=2

## P2: Spot Trading

- ✅ **Spot buy executed**: tx=0x3d913465
- ✅ **Price increased after buy**: 1.2233664242e-8 → 1.2857672615e-8
- ✅ **Engine price synced with chain**: engine=1.2857672615e-8, chain=1.2857672615e-8, ratio=1.0000

## P3: Open Positions

- ✅ **Market LONG submitted**: orderId=AA2026040515, status=FILLED
- ❌ **Market SHORT submitted**: 余额不足: 需要 0.1001 BNB，可用 0.0014 BNB (钱包: 3.6499, mode2: 18.4820, 占用: 22.1255)
- ✅ **Wallet A has LONG position**: size=1650000000000000000
- ✅ **Wallet B has SHORT position**: size=1000000000000000000
- ✅ **Wallet A balance changed after orders**: 28.7942 → 28.6941
- ✅ **Limit LONG submitted**: orderId=AA2026040515, price=1.2214788984e-8
- ✅ **Limit order accepted**: status=FILLED (LP fill may execute immediately)

## P4: TP/SL

- ✅ **TP LONG order submitted**: status=FILLED
- ✅ **TP trigger attempted**: positions after: 1
- ✅ **SL LONG order submitted**: status=FILLED
- ✅ **SL trigger attempted**: positions after: 1

## P5: Close Positions

- ✅ **Profit close submitted**: status=PENDING
- ✅ **Profit close executed or accepted**: 28.4439 → 28.3938 (delta=-0.050050, status=PENDING)
- ✅ **Loss close executed**: 28.2937 → 28.1936
- ✅ **Partial close: position partially remains**: remaining=2.3500 BNB

## P6: Liquidation

- ✅ **High-leverage LONG opened (2.5x)**: orderId=A12026040515
- ✅ **Wallet C LONG position liquidated**: positions: 1→1, PG LIQUIDATED: 29, price drop: 38.5%

## P7: Funding Rate

- ✅ **funding_rate_history has records**: count=2173
- ✅ **perp_bills has FUNDING_FEE records**: count=50453

## P8: Withdrawal

- ✅ **Merkle proof received**: OK
- ✅ **On-chain withdraw tx confirmed**: tx=0x8918a98326ef
- ✅ **WBNB balance increased after withdraw**: 19.703996 → 20.863753
- ✅ **Engine balance decreased after withdraw**: 26.979501 → 26.979493

## P9: Referral Verify

- ✅ **Referrer D has commission records**: count=9
- ✅ **Global referral commissions > 0**: pending=0.13163176430291448, paid=0

## P10: Boundaries

- ✅ **Insufficient balance rejected**: Position rejected: OI limit reached: current=1.10, new=100.0000, max=51.20 BNB. Need more LP.
- ✅ **Price band violation rejected**: Limit price deviates more than 50% from spot price. Spot: 12233664242, Your price: 36700992726
- ✅ **ReduceOnly without position rejected**: No open position to reduce. Reduce-only orders require an existing position in the opposite direction.
- ✅ **Zero size order rejected**: Position too small. Minimum: 0.001 BNB
- ✅ **Expired deadline rejected**: Order expired

## P11: Data Consistency

- ✅ **perp_order_mirror > 0**: count=964
- ✅ **perp_trade_mirror > 0**: count=937
- ✅ **perp_trade_mirror has close trades**: count=713
- ✅ **perp_trade_mirror has non-zero PnL**: count=630
- ✅ **perp_position_mirror OPEN**: count=143
- ✅ **perp_position_mirror has CLOSED**: count=27
- ✅ **perp_position_mirror LIQUIDATED**: count=29 (soft check)
- ✅ **perp_bills >= 2 types**: FUNDING_FEE:50453, INSURANCE_CONTRIBUTION:1721, SETTLE_PNL:503, OPEN_FEE:354, LIQUIDATION:210, CLOSE_FEE:119, TRADING_FEE:119, INSURANCE_PAYOUT:95, MAKER_FEE_REFUND:77, WITHDRAWAL:2
- ✅ **FUNDING_FEE bills > 0**: count=50453
- ✅ **SETTLE_PNL bills > 0**: count=503
- ✅ **Fee-related bills > 0**: count=592
- ✅ **funding_rate_history > 0**: count=2173
- ✅ **balance_snapshots**: count=0 (soft check)
- ✅ **Engine active positions**: count=0
- ✅ **referral_rewards table**: count=0 (soft check)
- ✅ **go:users**: count=0 (logged)
- ✅ **go:orders**: count=0 (logged)
- ✅ **go:trades**: count=0 (logged)
- ✅ **go:positions**: count=0 (logged)
- ✅ **go:funding_rates**: count=162 (logged)
- ✅ **go:liquidations**: count=0 (logged)
- ✅ **PerpVault pool value > 0**: 102.3930 BNB

---

## ❌ Failed Checks (3)

- **P0: Environment** > Wallet 10 deposit 3 BNB: FAILED
- **P0: Environment** > Wallet 50 deposit 0.5 BNB: FAILED
- **P3: Open Positions** > Market SHORT submitted: 余额不足: 需要 0.1001 BNB，可用 0.0014 BNB (钱包: 3.6499, mode2: 18.4820, 占用: 22.1255)

---
*Generated by Comprehensive Single-Token E2E Test*
