# Claude Code 项目指令

> 每次对话开始时自动读取此文件

## 强制要求

**在修改任何永续合约相关代码之前，必须先执行:**

```bash
cat /Users/qinlinqiu/Desktop/meme-perp-dex/DEVELOPMENT_RULES.md
```

## 审计状态

三轮独立审计，检查维度不同：

| 审计 | 日期 | 维度 | 问题数 | 报告文件 |
|------|------|------|--------|---------|
| **V1 架构审计** | 2026-03-01 | 资金流、链上/链下一致性 | 48 (35 fixed) | `docs/ISSUES_AUDIT_REPORT.md` |
| **V2 代码审查** | 2026-03-03 | 逐行代码 bug、安全漏洞 | 75 (8 fixed) | `docs/CODE_REVIEW_V2.md` |
| **V3 全量审计** | 2026-03-04 | 全层全量 + 修复验证 | 56 remain / 25+ fixed | `docs/AUDIT_V3_FULL.md` |

**当前关键状态 (BSC Testnet, Chain 97)**:
- ✅ 链上资金托管已连通（PerpVault LP, SettlementV2 存取款）
- ✅ 合约部署到 BSC Testnet (97)，E2E 测试 36/36 通过
- ✅ V1/V2 审计中 25+ 问题已确认修复
- ❌ V3 发现 1 个 CRITICAL + 10 个 HIGH 待修复（详见 AUDIT_V3_FULL.md）

## 项目概述

这是一个 Meme 代币永续合约交易平台，包含:
- **contracts/**: Solidity 智能合约 (Foundry)
- **frontend/**: Next.js 前端
- **backend/**: Go API + Keeper 服务
- **backend/src/matching/**: TypeScript 撮合引擎 (核心，12000+ 行)

## 当前状态

**架构**: 简化版 dYdX v3 — 链下撮合 + SettlementV2 托管 + PerpVault LP 池 + Merkle 提款

**已完成 (2026-03-01 审计修复后):**
- ✅ PerpVault OI 追踪 (batch queue + nonce管理，100% 成功率)
- ✅ Merkle 快照 + 提款 Merkle proof (modules/snapshot.ts + withdraw.ts)
- ✅ ConfigureSettlement.s.sol 已执行 — PerpVault 2 ETH LP, 合约全部授权
- ✅ 前端 3 步链上存款 (ETH→WETH→SettlementV2.deposit)
- ✅ 前端 Merkle proof 链上提款 (SettlementV2.withdraw)
- ✅ 假充值/提款 API 已加环境变量守卫 (ALLOW_FAKE_DEPOSIT)
- ✅ 18 个安全 Bug 修复 (鉴权/nonce/并发/K线/死代码)
- ✅ 涨幅显示 Bug 修复 (priceChangePercent24h)
- ✅ Keeper 从撮合引擎获取数据 (不再读空 DB)
- ✅ 保险基金查询 PerpVault getPoolValue() (不再是内存假值)

**待优化 (非阻塞):**
- ⚠️ PnL 主路径仍是 mode2Adj，PerpVault batch settlement 为异步同步
- ⚠️ 余额/仓位主数据在 Redis，PostgreSQL 仅镜像订单
- ⏳ 端到端真实资金流测试 (Phase E)

**V3 审计确认已修复 (2026-03-04 验证):**
- ✅ `broadcastBalanceUpdate()` — 改用 wsTraderClients 逐用户发送
- ✅ `withdraw.ts` deadline — 改用 `Math.floor(Date.now()/1000)`
- ✅ `currentTimeMillis()` — 正确返回 `Date.now()`
- ✅ Auth nonce TOCTOU — withLock() 保护
- ✅ Nonce Redis 持久化 — write-through cache

**V3 审计仍存在的关键问题 (2026-03-04):**
- ❌ `/api/v2/withdraw/request` 无鉴权+不扣余额 (CRITICAL)
- ❌ `subscribe_risk` WS 无鉴权，泄露任意用户仓位
- ❌ `broadcastMarginUpdate` 泄露到所有 WS 客户端
- ❌ 前端允许 100x 杠杆，引擎限制 10x
- ❌ TokenFactory `_distributeTradingFee` 无推荐人时多扣 10%
- 详见 `docs/AUDIT_V3_FULL.md` — 完整 56 个问题

## 行业标准 (必须遵循)

### PnL 计算 (GMX 标准)
```solidity
delta = size * |currentPrice - avgPrice| / avgPrice
hasProfit = isLong ? (currentPrice > avgPrice) : (avgPrice > currentPrice)
```

### 强平价格 (Bybit 标准)
```
多头: liqPrice = entryPrice * (1 - 1/leverage + MMR)
空头: liqPrice = entryPrice * (1 + 1/leverage - MMR)
```

## 关键文件位置

| 功能 | 文件 |
|------|------|
| 撮合引擎入口 | backend/src/matching/server.ts (12000+ 行) |
| PerpVault 模块 | backend/src/matching/modules/perpVault.ts |
| Merkle 快照 | backend/src/matching/modules/snapshot.ts |
| 提款授权 | backend/src/matching/modules/withdraw.ts |
| 链上存款中继 | backend/src/matching/modules/relay.ts |
| 前端合约交互 | frontend/src/hooks/perpetual/usePerpetualV2.ts |
| 前端余额显示 | frontend/src/components/common/AccountBalance.tsx |
| 做市商脚本 | scripts/market-maker-all.ts |
| 部署配置 | frontend/contracts/deployments/base-sepolia.json |
| V1 审计报告 | docs/ISSUES_AUDIT_REPORT.md |
| V2 代码审查 | docs/CODE_REVIEW_V2.md |
| V3 全量审计 | docs/AUDIT_V3_FULL.md |

### 目录结构

```
frontend/src/
├── components/
│   ├── common/      # 共用组件 (OrderBook, TradeHistory, PriceBoard)
│   ├── spot/        # 现货交易组件
│   └── perpetual/   # 合约交易组件
├── hooks/
│   ├── common/      # 共用 hooks
│   ├── spot/        # 现货 hooks
│   └── perpetual/   # 合约 hooks (usePerpetualV2, useRiskControl)

contracts/src/
├── common/          # PriceFeed, Vault, ContractRegistry
├── spot/            # TokenFactory, AMM, Router
└── perpetual/       # PositionManager, Settlement, PerpVault, Liquidation

backend/src/matching/ # TypeScript 撮合引擎 (核心)
backend/internal/     # Go API + Keeper
```

## 禁止事项

1. ❌ 不要自己发明 PnL 或强平价格公式
2. ❌ 不要只改合约不改前端
3. ❌ 不要调用旧的 `openLong/openShort`，要用 `openLongToken/openShortToken`
4. ❌ 不要调用旧的 `getPosition`，要用 `getPositionByToken`
5. ❌ 不要忘记 TokenFactory 交易后更新 PriceFeed
6. ❌ 不要使用 `POST /api/user/:trader/deposit` 虚假充值接口
7. ❌ 不要在 mode2Adj 上建设新功能 — 所有资金流必须走链上合约
8. ❌ 不要在合约中 external call 之后修改状态（CEI 违规 SC-C01）
9. ❌ 不要用 `broadcastBalanceUpdate` 广播全量余额（ME-C01 隐私泄漏）
10. ❌ 不要混淆 Unix 秒和 `Date.now()` 毫秒（ME-C02）
11. ❌ 不要在前端用 `parseFloat` 处理 ETH 金额 — 使用 BigInt 全程（FE-C02）
12. ❌ 修改合约地址时必须同步更新 7 个配置文件（见 CODE_REVIEW_V2.md 第八部分）

## 修改检查清单

每次修改后问自己:
- [ ] 调用链是否完整?
- [ ] 前端是否同步更新?
- [ ] 公式是否符合行业标准?
- [ ] 资金流是否走链上合约（不是 mode2Adj）?
- [ ] 合约地址变更是否同步到所有 7 个配置文件?
- [ ] 合约状态更新是否在 external call 之前（CEI 模式）?
- [ ] 时间比较是否统一使用秒或毫秒?
- [ ] ETH 金额计算是否全程使用 BigInt?
- [ ] WS 广播是否只发送给目标用户（不是全量广播）?
- [ ] DEVELOPMENT_RULES.md 是否需要更新?
