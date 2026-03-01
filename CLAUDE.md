# Claude Code 项目指令

> 每次对话开始时自动读取此文件

## 强制要求

**在修改任何永续合约相关代码之前，必须先执行:**

```bash
cat /Users/qinlinqiu/Desktop/meme-perp-dex/DEVELOPMENT_RULES.md
```

## 审计修复状态 (2026-03-01 全面审计 → 已修复)

**审计发现 48 个问题: 12 CRITICAL, 15 HIGH, 21 MEDIUM — 已修复 35 个, 5 个部分修复, 8 个架构限制**

链上资金托管已连通:
- ✅ PerpVault 已有 2 ETH LP 种子（ConfigureSettlement.s.sol 已执行）
- ✅ 前端存款走 SettlementV2.deposit() 链上 3 步流程（AccountBalance.tsx）
- ✅ 前端提款走 Merkle proof → SettlementV2.withdraw()（AccountBalance.tsx）
- ✅ `POST /api/user/:trader/deposit` 假充值 API 已加 ALLOW_FAKE_DEPOSIT 守卫
- ✅ PerpVault batch settlement 已实现（loss/fee/liquidation/profit 队列）
- ✅ Keeper 从撮合引擎获取仓位数据（不再读空 PostgreSQL）
- ⚠️ PnL 结算仍以 mode2Adj 为主路径，PerpVault 为异步同步层
- ⚠️ 余额/仓位主数据仍在 Redis，PostgreSQL 仅镜像订单

**详见**: `docs/ISSUES_AUDIT_REPORT.md`

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
| 审计报告 | docs/ISSUES_AUDIT_REPORT.md |

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

## 修改检查清单

每次修改后问自己:
- [ ] 调用链是否完整?
- [ ] 前端是否同步更新?
- [ ] 公式是否符合行业标准?
- [ ] 资金流是否走链上合约（不是 mode2Adj）?
- [ ] DEVELOPMENT_RULES.md 是否需要更新?
