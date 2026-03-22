# V4 余额系统审计报告

> Date: 2026-03-21
> Scope: mode2Adjustment / positionMargin / 并发锁

## 已修复

### 强平逻辑 (2026-03-21)
- **修复前**: 100% 没收用户保证金
- **修复后**: 清算罚金 = positionValue × MMR (~2%), 剩余退还用户
- **文件**: server.ts processLiquidations()

## 待修复 (MEDIUM)

### F-3: TP/SL 与减仓单并发关闭同一仓位 — 双倍 PnL
- **风险**: closePositionByMatch 无锁, TP/SL 无锁, 两者可同时关闭同一仓位
- **影响**: mode2Adj 双倍 PnL 信用, 用户余额凭空增加
- **方案**: 统一使用 withLock("position:${trader}")

### F-9: 提款与下单使用不同锁 — TOCTOU 超支
- **风险**: 提款锁 v2:withdraw:trader, 下单锁 balance:trader, 可并发消费同一余额
- **影响**: 总消费超过实际可用余额
- **方案**: 所有余额修改统一使用 withLock("balance:${trader}")

## 低风险 (已确认安全)

- F-1: adjustUserBalance + mode2 双写 — 临时性, syncUserBalance 会覆盖
- F-2: removeMargin 无显式 mode2 — 设计正确 (positionMargin 减少自动释放)
- F-5: 资金费率双写 — 同 F-1
- F-6: BigInt 无溢出风险
- F-7: 零金额边界安全
- F-8: 负 returnAmount 已 clamp 到 0
