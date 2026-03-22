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
| **V3 全量审计** | 2026-03-04 | 全层全量 + 修复验证 | **56/56 fixed** | `docs/AUDIT_V3_FULL.md` |

**当前关键状态 (BSC Testnet, Chain 97)**:
- ✅ 链上资金托管已连通（PerpVault LP, SettlementV2 存取款）
- ✅ **合约全量重新部署 2026-03-18** — 所有地址已更新
- ✅ **V3 全部 56 个问题已修复** (0 CRITICAL, 0 HIGH, 0 MEDIUM, 0 LOW 剩余)
- ✅ 373 contract tests pass, Go/TS compile clean

## 合约地址 (BSC Testnet — 2026-03-18 部署)

**⚠️ 唯一真实来源: `deployments/97.json` — 所有配置文件必须与之一致**

| 合约 | 地址 |
|------|------|
| TokenFactory | `0xaf727EeF35Ff8b5D8F4Da7215d8CF5CE91bE2946` |
| SettlementV2 | `0xAAee334783de1DE25fBdaA37C2C57EF8c9EB4F1E` |
| Settlement V1 | `0x17B74c408f7906F677f639B7c449e1ef708962Cb` |
| PerpVault | `0xAaFafb22c16C20E138e0cF35bB98Be672E33A984` |
| PriceFeed | `0x2b14DdF4761Eea5C36F93776E8F59F2928F9Cdeb` |
| PositionManager | `0x620d6C0dcF4d4d9b6a9f3c650669aF4b02AB660e` |
| Vault | `0xe813093B55a2975c5E839A766AEb00D0cf2c98f7` |
| Liquidation | `0x14d9DA599A6e5288c9DEB95A1BE504cb79B28b0c` |
| FundingRate | `0xcAe2860330eb9B66Ee6bc79a2CC74f93b8334326` |
| InsuranceFund | `0xfbC7f1f449e06c73F4d1b8134C6C2D52B244a9Aa` |
| RiskManager | `0xd3EE03cbF56C69463F2B6fef60D5284D5676CFF3` |
| ContractRegistry | `0x197B0370Ba7d2e81F2A6046BFD5966fd8A3E4ABE` |
| WBNB | `0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd` |
| PancakeRouter V2 | `0xD99D1c33F9fC3444f8101754aBC46c52416550D1` |
| Deployer | `0xAecb229194314999E396468eb091b42E44Bc3c8c` |

**配置文件同步清单** (修改地址时必须全部更新):
1. `deployments/97.json` — 唯一真实来源
2. `.env` (根目录 `MEMEPERP_*` 变量)
3. `frontend/.env.local` (`NEXT_PUBLIC_*` 变量)
4. `backend/.env`
5. `backend/src/matching/.env`
6. `backend/configs/config.yaml`
7. `backend/configs/config.local.yaml`
8. `frontend/contracts/deployments/base-sepolia.json`
9. `scripts/sync-contract-addresses.ts` (ADDRESSES 常量)

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

**V3 审计全部修复 (2026-03-07 最终验证):**
- ✅ **56/56 问题全部修复** — 0 CRITICAL, 0 HIGH, 0 MEDIUM, 0 LOW 剩余
- ✅ 373 contract tests pass, Go build clean, TypeScript compiles clean
- 详见 `docs/AUDIT_V3_FULL.md`

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
| Redis 数据层 (新，主用) | backend/src/matching/database/redis.ts — PositionRepo/OrderRepo/BalanceRepo |
| Redis 数据层 (旧，废弃) | backend/src/matching/database.ts — ⚠️ PositionRepo 已废弃，勿导入 |
| PostgreSQL 镜像 | backend/src/matching/database/postgres.ts — OrderMirrorRepo + PositionMirrorRepo |
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
13. ❌ 不要从 `database.ts` 导入 `PositionRepo` — 用 `database/redis.ts` 的版本（旧版用 `userAddress/symbol/side`，新版用 `trader/token/isLong`）
14. ❌ 不要用 `memoryPositionToDB()` 转换仓位再存 Redis — 直接传 Position 对象给 `PositionRepo`
15. ❌ server.ts 内存 Position 用 **string** 字段，database/redis.ts Position (types.ts) 用 **bigint** — 跨边界必须显式转换

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
- [ ] Redis 仓位保存后是否能正常 `JSON.stringify`（无 BigInt 泄漏）?
- [ ] 仓位删除是否传了 `traderHint` 参数（pairId≠Redis UUID）?
- [ ] DEVELOPMENT_RULES.md 是否需要更新?
