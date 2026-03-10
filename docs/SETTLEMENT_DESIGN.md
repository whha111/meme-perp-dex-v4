# 永续合约结算机制设计

> **最后更新**: 2026-03-01
> **当前状态**: ⚠️ 设计已确定，实现严重不完整（见 ISSUES_AUDIT_REPORT.md）

---

## 架构选择

**选定方案**: 简化版 dYdX v3（链下撮合 + 链上托管 + LP 对手方池）

| 参考平台 | 架构 | 存款托管 | 结算方式 | 提款保障 |
|----------|------|---------|---------|---------|
| dYdX v3 | 链下撮合 + StarkEx L1 | L1 合约锁定 USDC | ZK-STARK 批量证明 | 强制提款 (14天) |
| GMX | 全链上 | Vault 合约 | 每笔链上执行 | 直接提款 |
| **我们** | 链下撮合 + SettlementV2 | WETH 锁定在 SettlementV2 | 批量结算到 PerpVault | Merkle proof 提款 |

---

## 资金流设计

### 存款流 (用户 → 链上)
```
用户钱包 ETH
    │
    ▼ wrap
用户钱包 WETH
    │
    ▼ approve + deposit()
SettlementV2 合约 (WETH 托管)
    │
    ▼ Deposited 事件
撮合引擎监听 → chainAvailable += amount
    │
    ▼
用户可以下单交易
```

### 交易结算流 (链下撮合 → 链上结算)
```
撮合引擎匹配订单
    │
    ├─ 即时: 内存记账 (仓位、余额、PnL)
    │
    ├─ 每 10s: PerpVault.increaseOI/decreaseOI (OI 追踪)
    │
    └─ 每 30s: 批量结算队列
         ├─ settleTraderLoss()    → ETH 流入 PerpVault
         ├─ settleLiquidation()  → ETH 流入 PerpVault
         ├─ collectFee()         → ETH 流入 PerpVault
         └─ settleTraderProfit() → ETH 从 PerpVault 流出
```

### 提款流 (链上 → 用户)
```
撮合引擎每小时生成 Merkle 快照
    │
    ▼ submitStateRoot()
SettlementV2 记录 Merkle root
    │
用户请求提款 → 引擎返回 Merkle proof + 签名
    │
    ▼ withdraw(proof, sig)
SettlementV2 验证 proof → 转 WETH 到用户钱包
```

---

## 合约职责

### SettlementV2 (用户保证金托管)
- **类比**: dYdX 的 StarkEx 合约
- **谁存钱**: 交易用户
- **存什么**: WETH
- **作用**: 托管用户资金，Merkle proof 验证提款
- **地址**: `0x733EccCf612F70621c772D63334Cf5606d7a7C75`

### PerpVault (LP 对手方池)
- **类比**: GMX 的 GLP Vault
- **谁存钱**: LP 流动性提供者
- **存什么**: ETH (native)
- **作用**: 所有交易的对手方池，承担交易员盈利风险
- **地址**: `0x586FB78b8dB39d8D89C1Fd2Aa0c756C828e5251F`
- **关键函数**:
  - `deposit()` → LP 存入 ETH 获得份额
  - `settleTraderProfit()` → 池子支付交易员盈利
  - `settleTraderLoss()` → 池子收取交易员亏损
  - `settleLiquidation()` → 池子收取强平保证金
  - `collectFee()` → 池子收取手续费

### 资金安全不变量
```
SettlementV2.WETH >= Σ(userDeposits) - Σ(userWithdraws)
PerpVault.balance >= minSafetyThreshold (建议 > 1 ETH)
引擎钱包.balance >= 0.05 ETH (gas 费)
```

---

## ⚠️ 当前实现差距

**以上设计是目标架构。当前实际状态：**

| 流程 | 设计 | 实际 | 状态 |
|------|------|------|------|
| 用户存款 | SettlementV2.deposit() | HTTP API 虚拟存款 | ❌ 未连通 |
| 用户提款 | Merkle proof + SettlementV2.withdraw() | HTTP API 虚拟提款 | ❌ 未连通 |
| PnL 结算 | PerpVault.settleTraderProfit/Loss() | mode2Adj 内存记账 | ❌ 虚拟 |
| OI 追踪 | PerpVault.increaseOI/decreaseOI() | 批量队列 100% 成功 | ✅ 已完成 |
| Merkle 快照 | 每小时提交 stateRoot | 代码就绪，未验证 | ⚠️ 待验证 |
| LP 流动性 | PerpVault.deposit() 种子资金 | deposit() 从未调用 | ❌ 空池子 |

**详见**: `docs/ISSUES_AUDIT_REPORT.md` 完整问题清单
