# 系统架构文档

> **最后更新**: 2026-03-01
> **架构模式**: 链下撮合 + 链上托管 (类 dYdX v3)

---

## ⚠️ 重要提示

**当前架构与最初设计不同。** 系统已从"全链上"迁移到"链下撮合 + 链上结算"模式。
大部分链上合约（PositionManager, Liquidation, FundingRate 等）已被撮合引擎替代。
详细问题清单见 `docs/ISSUES_AUDIT_REPORT.md`。

---

## 当前实际架构

```
                              用户浏览器
                                 │
                    ┌────────────┼────────────┐
                    │            │            │
                    ▼            ▼            ▼
              ┌──────────┐ ┌──────────┐ ┌──────────┐
              │ Next.js  │ │ WebSocket│ │ 链上合约  │
              │ 前端     │ │ 实时推送  │ │ (现货)   │
              │ :3000    │ │ ws:8081  │ │          │
              └──────────┘ └──────────┘ └──────────┘
                    │            │            │
                    ▼            ▼            │
              ┌──────────────────────┐       │
              │   撮合引擎 (TypeScript)│       │
              │   Bun runtime :8081  │       │
              │                      │       │
              │ ┌──────────────────┐ │       │
              │ │ 订单簿 + 撮合    │ │       │
              │ │ 仓位管理        │ │       │
              │ │ PnL 计算        │ │       │
              │ │ 强平 + ADL      │ │       │
              │ │ 资金费结算      │ │       │
              │ └──────────────────┘ │       │
              └──────────────────────┘       │
                    │          │              │
              ┌─────┘    ┌─────┘             │
              ▼          ▼                   ▼
        ┌──────────┐ ┌──────────┐    ┌──────────────┐
        │  Redis   │ │PostgreSQL│    │ Base Sepolia  │
        │ (主存储) │ │(镜像/审计)│    │   合约       │
        │  :6379   │ │  :5432   │    │              │
        └──────────┘ └──────────┘    │ TokenFactory │
                                     │ AMM/Router   │
              ┌──────────────┐       │ PriceFeed    │
              │  Go 后端      │       │ PerpVault    │
              │  API :8080   │       │ SettlementV2 │
              │  + Keeper    │       └──────────────┘
              └──────────────┘
```

---

## 模块职责

### 撮合引擎 (TypeScript/Bun) — 核心
| 功能 | 文件 | 说明 |
|------|------|------|
| HTTP/WS 服务 | server.ts | 12000+ 行主入口 |
| 订单撮合 | engine.ts | 价格-时间优先 |
| OI 追踪 | modules/perpVault.ts | 批量写入 PerpVault 合约 |
| Merkle 快照 | modules/snapshot.ts | 每小时生成 stateRoot |
| 提款授权 | modules/withdraw.ts | 生成 Merkle proof |
| 链上存款中继 | modules/relay.ts | 监听 SettlementV2 事件 |
| 资金费 | server.ts (settleFunding) | 8小时周期 |
| 强平/ADL | server.ts | 每秒检查 |
| 价格更新 | modules/priceFeed.ts | 写入 PriceFeed 合约 |

### 智能合约 — 链上层
| 合约 | 实际使用状态 | 说明 |
|------|-------------|------|
| TokenFactory | ✅ 活跃 | Meme 代币创建 |
| AMM + Router | ✅ 活跃 | 现货交易 |
| PriceFeed | ✅ 活跃 | 价格预言机 |
| PerpVault | ⚠️ 部分 | 仅 OI 追踪，LP 池空 |
| SettlementV2 | ❌ 未连通 | 设计为用户存款托管，实际空 |
| PositionManager | ❌ 未使用 | 被引擎替代 |
| Liquidation | ❌ 未使用 | 被引擎替代 |
| FundingRate | ❌ 未使用 | 被引擎替代 |
| Vault | ❌ 未使用 | 被 SettlementV2 替代 |

### Go 后端 — 辅助层
| 功能 | 状态 | 说明 |
|------|------|------|
| REST API | ⚠️ 部分有效 | 读 PostgreSQL（多数表为空） |
| Keeper (强平监控) | ❌ 无效 | 读不到仓位数据 |
| Keeper (资金费) | ❌ 无效 | 读不到仓位数据 |
| Auth (HMAC) | ✅ 有效 | 鉴权中间件正常 |

### 前端 (Next.js)
| 功能 | 数据来源 | 说明 |
|------|---------|------|
| 现货交易 | 链上合约 | 直接调合约 |
| 合约下单 | 撮合引擎 WS/HTTP | 完全链下 |
| 仓位显示 | 撮合引擎 | 无链上验证 |
| 余额显示 | 引擎 + 钱包 | 可能双重计算 |
| 存款 | ⚠️ 未连通 | 应调 SettlementV2 |
| 提款 | ⚠️ 未连通 | 应走 Merkle proof |

---

## 数据流

### 现货交易 (全链上 ✅)
```
用户 → Router.swap() → AMM 执行 → PriceFeed 更新价格
```

### 永续合约交易 (链下撮合 ⚠️)
```
用户 → WS submit_order → 引擎撮合 → 内存记账
                                      ↓
                              Redis 持久化 (仓位/余额)
                                      ↓
                              每 10s → PerpVault OI 更新 (链上)
                              每 30s → 批量结算队列 (链上, 待完善)
                              每 1h  → Merkle 快照 (链上, 待验证)
```

### ⚠️ 当前缺失的数据流
```
❌ 用户存款 → SettlementV2.deposit()    (未连通)
❌ 用户提款 → SettlementV2.withdraw()   (未连通)
❌ PnL 结算 → PerpVault.settle*()       (火烧不忘式，失败忽略)
❌ 保险基金 → PerpVault 链上池           (纯内存)
❌ Keeper   → 撮合引擎 HTTP             (读空库)
```

---

## 合约地址 (Base Sepolia)

详见 `frontend/contracts/deployments/base-sepolia.json`

---

## 参考文档

- 结算机制: `docs/SETTLEMENT_DESIGN.md`
- 问题清单: `docs/ISSUES_AUDIT_REPORT.md`
- 合约接口: `docs/CONTRACTS_INTERFACE.md`
- API 文档: `docs/API_SPECIFICATION_V2.md`
