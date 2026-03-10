# 开发路线图

> 最后更新: 2026-03-04 | 网络: BSC Testnet (Chain 97)

---

## 当前状态概述

**已完成**: 全栈交易平台核心功能 — 现货 + 永续合约 + 链上结算 + 3轮安全审计
**当前阶段**: V3 审计修复 + 生产就绪准备
**下一步**: 修复 V3 审计发现的关键问题 → 主网部署

---

## Phase 1: 核心基础设施 ✅ 完成

| 任务 | 状态 |
|------|------|
| Solidity 合约框架 (Foundry) | ✅ |
| TokenFactory 联合曲线 + 毕业 | ✅ |
| PriceFeed 价格聚合 | ✅ |
| Vault 资金托管 | ✅ |
| SettlementV2 (Merkle 提款) | ✅ |
| PerpVault (LP 池 + OI 追踪) | ✅ |
| Go 后端 API + Keeper | ✅ |
| Next.js 14 前端框架 | ✅ |
| TypeScript 撮合引擎 (Bun) | ✅ |
| PostgreSQL + Redis 数据层 | ✅ |
| Docker Compose 编排 | ✅ |

## Phase 2: 交易功能 ✅ 完成

| 任务 | 状态 |
|------|------|
| 现货 AMM 买/卖 (TokenFactory) | ✅ |
| 永续合约开仓/平仓 (EIP-712 签名) | ✅ |
| 订单簿 + 限价单 (链下撮合) | ✅ |
| 止盈/止损 (TP/SL) | ✅ |
| 部分平仓 | ✅ |
| 实时 WebSocket 推送 | ✅ |
| K线图表 (TradingView Lightweight) | ✅ |
| 多时间周期 (1m/5m/15m/1H/4H/1D) | ✅ |
| 滑点保护 | ✅ |

## Phase 3: 风控与结算 ✅ 完成

| 任务 | 状态 |
|------|------|
| 链下清算引擎 (server.ts) | ✅ |
| Go Keeper 清算监控 | ✅ |
| 资金费率 8h 结算 | ✅ |
| PerpVault 批量结算队列 | ✅ |
| Merkle 快照 + 链上提交 | ✅ |
| EIP-712 提款签名 | ✅ |
| SettlementV2 链上存款中继 | ✅ |
| PerpVault OI 追踪 (batch + nonce) | ✅ |

## Phase 4: 用户体验 ✅ 完成

| 任务 | 状态 |
|------|------|
| 推荐返佣系统 | ✅ |
| 账户页面 (余额/仓位/历史) | ✅ |
| 钱包页面 (存款/提款) | ✅ |
| 国际化 (zh/en/ja/ko) | ✅ |
| WalletConnect 集成 | ✅ |

## Phase 5: 安全审计 ✅ 完成 (3轮)

| 审计 | 日期 | 结果 | 报告 |
|------|------|------|------|
| V1 架构审计 | 2026-03-01 | 48 发现, 35 已修复 | `docs/ISSUES_AUDIT_REPORT.md` |
| V2 代码审查 | 2026-03-03 | 75 发现, 8 已修复 | `docs/CODE_REVIEW_V2.md` |
| V3 全量审计 | 2026-03-04 | 56 仍存在, 25+ 已确认修复 | `docs/AUDIT_V3_FULL.md` |
| 压力测试 | 2026-03-03 | 400 钱包 soak test + 清算验证 | `stress-test/` |
| E2E 测试 | 2026-03-03 | 36/36 测试通过 | `scripts/full-e2e-test.ts` |

## Phase 6: 审计修复 ⬅️ 当前阶段

### 必须修复 (上线前)

| 问题 | 严重性 | 状态 |
|------|--------|------|
| `/api/v2/withdraw/request` 无鉴权 | CRITICAL | ⬜ |
| `subscribe_risk` WS 无鉴权 | HIGH | ⬜ |
| 多个 WS 广播泄露到全量客户端 | HIGH | ⬜ |
| 提款 nonce 签名后未递增 | HIGH | ⬜ |
| 前端 100x 杠杆 vs 引擎 10x | HIGH | ⬜ |
| TokenFactory fee 无推荐人多扣 10% | HIGH | ⬜ |
| 内部 trigger 端点无鉴权 | HIGH | ⬜ |
| 杠杆提交未校验 MAX_LEVERAGE | HIGH | ⬜ |

### 短期优化

| 任务 | 优先级 |
|------|--------|
| 合并双保险基金 (Liquidation + PerpVault) | P1 |
| Merkle tree 缓存 (不每次重建) | P2 |
| Go nonce store GC | P2 |
| 前端 parseFloat → BigInt | P2 |
| 压力测试覆盖提款流程 | P2 |

## Phase 7: 主网部署 ⬜ 计划中

| 任务 | 状态 |
|------|------|
| Phase 6 审计修复全部完成 | ⬜ |
| BSC Mainnet (56) 合约部署 | ⬜ |
| 7 个配置文件同步主网地址 | ⬜ |
| 生产 Redis Sentinel 配置 | ⬜ |
| TLS/HTTPS 强制 + CORS 收紧 | ⬜ |
| 合约 BscScan 验证 | ⬜ |
| 外部安全审计 (Code4rena/Sherlock) | ⬜ |
| 渐进式发布 (白名单 → 公开) | ⬜ |

---

## 关键里程碑

```
2026-01-21  项目创建 + 核心合约 + 前端框架
2026-02-10  V2 安全审计修复 (11 个发现)
2026-02-14  前端性能优化 (无限循环 + WS 修复)
2026-02-24  PerpVault 生产级审计 + 安全修复
2026-02-25  SettlementV2 Merkle 提款系统上线
2026-03-01  V1 全面架构审计 (48 issues) + 链上结算打通
2026-03-03  V2 逐行代码审查 (75 issues) + BSC Testnet 部署
2026-03-04  V3 全量审计 + 文档大清理 ← 当前
```
