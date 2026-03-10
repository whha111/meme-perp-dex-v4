# Meme Perp DEX 开发准则与问题清单

> **重要**: 每次修改代码前必须先阅读本文件，确保遵循行业标准

---

## ⚠️ 审计状态 (截至 2026-03-04)

**三轮审计已完成，链上资金托管已打通，BSC Testnet (97) 部署已验证。**

| 审计 | 日期 | 发现 | 已修复 | 报告 |
|------|------|------|--------|------|
| V1 架构审计 | 2026-03-01 | 48 | 35 | `docs/ISSUES_AUDIT_REPORT.md` |
| V2 代码审查 | 2026-03-03 | 75 | 8 | `docs/CODE_REVIEW_V2.md` |
| V3 全量审计 | 2026-03-04 | 12 open / 9 partial / 35 fixed | `docs/AUDIT_V3_FULL.md` |

### V1 核心问题 (已修复)
- ✅ 虚假存取款 API 已加 `ALLOW_FAKE_DEPOSIT` 守卫
- ✅ 前端存款走 SettlementV2.deposit(), 提款走 Merkle proof
- ✅ PerpVault 有 LP 种子流动性，ConfigureSettlement.s.sol 已执行
- ✅ Keeper 从撮合引擎 HTTP API 获取仓位数据

### V3 关键问题状态 (ALL CRITICAL/HIGH RESOLVED ✅)
- ✅ `/api/v2/withdraw/request` 无鉴权+不扣余额 (CRITICAL — CR-01) — 已修复 2026-03-04
- ✅ 多个 WS 广播泄露数据给所有客户端 (HIGH — H-01/H-02) — 已修复 2026-03-04
- ✅ 前端允许 100x 杠杆，引擎限制 10x (HIGH — H-06) — 已修复 2026-03-04
- ✅ TokenFactory `_distributeTradingFee` 无推荐人时多扣 10% (HIGH — H-08) — 已修复 2026-03-07
- ✅ Liquidation.sol phantom insuranceFund (HIGH — H-09) — 已修复 2026-03-07
- ✅ 双保险基金无对账 (HIGH — H-10) — 已修复 2026-03-07
- **0 CRITICAL, 0 HIGH 剩余 — 372 contract tests pass**
- 完整清单: `docs/AUDIT_V3_FULL.md` (12 open + 9 partial，全部 MEDIUM/LOW)

---

## 零、系统架构选择

### V1 架构 (PositionManager - 资金池模式)
- 用户直接与资金池对赌
- 盈利从保险基金支付
- 简单但保险基金可能枯竭
- 文件: `PositionManager.sol`, `usePerpetualToken.ts`, `PerpetualOrderPanel.tsx`

### V2 架构 (Settlement - 用户对赌模式) ⭐ 推荐
- 用户签名 EIP-712 订单（链下，不花 Gas）
- 撮合引擎配对多空订单（链下）
- 撮合引擎批量提交配对结果（链上）
- Settlement 合约验证签名并执行结算
- **盈亏直接在多空之间转移，保险基金仅用于穿仓**
- 文件: `Settlement.sol`, `usePerpetualV2.ts`, `PerpetualOrderPanelV2.tsx`

```
V2 架构流程：
用户下单 → 签名 EIP-712 订单 → 发送到撮合引擎
                                      ↓
                              撮合多空订单配对
                                      ↓
                              批量提交到链上
                                      ↓
                      Settlement 合约验证签名 + 执行结算
                                      ↓
                      盈亏直接转移 (多头盈利 ←→ 空头亏损)
```

### 何时使用哪个架构?
| 场景 | 推荐架构 |
|------|---------|
| 新项目 | V2 Settlement |
| 已有 PositionManager 仓位 | V1 (迁移完成前) |
| 高流动性需求 | V2 Settlement |
| 极简测试 | V1 PositionManager |

---

## 一、行业标准公式 (必须遵循)

### 1. PnL 计算公式 (参考 GMX)

```solidity
// 来源: https://github.com/gmx-io/gmx-contracts/blob/master/contracts/core/Vault.sol
// getDelta 函数

function getDelta(
    uint256 _size,        // 仓位名义价值
    uint256 _averagePrice, // 开仓均价
    uint256 _currentPrice, // 当前标记价格
    bool _isLong
) pure returns (bool hasProfit, uint256 delta) {

    uint256 priceDelta = _averagePrice > _currentPrice
        ? _averagePrice - _currentPrice
        : _currentPrice - _averagePrice;

    // 核心公式
    delta = _size * priceDelta / _averagePrice;

    hasProfit = _isLong
        ? (_currentPrice > _averagePrice)  // 多头: 涨了赚钱
        : (_averagePrice > _currentPrice); // 空头: 跌了赚钱
}
```

### 2. 强平价格公式 (参考 Bybit/Binance)

```solidity
// 来源: https://www.bybit.com/en/help-center/article/Liquidation-Price-USDT-Contract/

// 多头强平价格
liqPrice_long = entryPrice - (initialMargin - maintenanceMargin) / positionSize

// 空头强平价格
liqPrice_short = entryPrice + (initialMargin - maintenanceMargin) / positionSize

// 其中:
// initialMargin = positionSize / leverage
// maintenanceMargin = positionSize * maintenanceMarginRate
```

**简化公式:**
```solidity
// 多头
liqPrice_long = entryPrice * (1 - 1/leverage + MMR)

// 空头
liqPrice_short = entryPrice * (1 + 1/leverage - MMR)

// MMR = Maintenance Margin Rate (维持保证金率, 通常 0.5% - 1%)
```

### 3. 保证金率计算

```solidity
// 保证金率 = (保证金 + 未实现盈亏) / 仓位价值
marginRatio = (collateral + unrealizedPnL) / positionSize

// 当 marginRatio < maintenanceMarginRate 时触发清算
```

### 4. 资金费率计算

```solidity
// 资金费率 = clamp(Premium Index + Interest Rate, -0.75%, 0.75%)
// Premium Index = (markPrice - indexPrice) / indexPrice

// 每 8 小时结算一次
// 多头支付: fundingRate > 0
// 空头支付: fundingRate < 0
```

---

## 二、系统架构标准 (必须遵循)

### 合约调用链

```
用户交易
    │
    ▼
TokenFactory.buy() / sell()
    │
    ├──► 更新池子状态
    │
    └──► PriceFeed.updateTokenPrice(token, newPrice)  ← 【必须调用】
              │
              ▼
         存储代币价格历史
              │
              ▼
    PositionManager 读取价格
              │
              ├──► getUnrealizedPnL()
              ├──► getLiquidationPrice()
              └──► canLiquidate()
```

### 前端调用链

```
用户操作
    │
    ▼
React Component (UI)
    │
    ▼
Custom Hook (usePerpetualToken)
    │
    ├──► 读取: useReadContract
    │        - getPositionByToken(user, token)  ← 【不是 getPosition】
    │        - getTokenMarkPrice(token)
    │        - 批量读取优化
    │
    └──► 写入: useWriteContract
             - openLongToken(token, size, leverage, mode)  ← 【不是 openLong】
             - closePositionToken(token)
```

---

## 三、已知问题清单

### 🔴 致命问题 (必须修复才能运行)

| ID | 问题 | 文件 | 状态 |
|----|------|------|------|
| C-01 | PriceFeed 没有与 TokenFactory 价格同步 | PriceFeed.sol | ✅ 已修复 (2026-01-21) |
| C-02 | PnL 计算公式不符合行业标准 | PositionManager.sol | ✅ 已修复 - GMX 标准 (2026-01-21) |
| C-03 | 强平价格计算公式错误 | PositionManager.sol | ✅ 已修复 - Bybit 标准 (2026-01-21) |
| C-05 | TokenFactory 交易没有调用价格更新 | TokenFactory.sol | ✅ 已修复 (2026-01-21) |
| F-01 | 前端调用旧的 getPosition 而非 getPositionByToken | usePerpetual.ts | ✅ 已修复 - usePerpetualToken hook (2026-01-21) |
| F-02 | 前端调用 openLong 而非 openLongToken | PerpetualOrderPanel.tsx | ✅ 已修复 (2026-01-21) |
| F-03 | 没有显示当前仓位信息 | PerpetualOrderPanel.tsx | ✅ 已修复 (2026-01-21) |
| F-04 | 没有显示未实现盈亏 | PerpetualOrderPanel.tsx | ✅ 已修复 (2026-01-21) |
| F-05 | 没有显示强平价格 | PerpetualOrderPanel.tsx | ✅ 已修复 (2026-01-21) |
| F-07 | 永续页面没有传入 token 地址 | perp/page.tsx | ✅ 已修复 - PerpetualTradingTerminal 传入 (2026-01-21) |
| F-08 | 没有平仓界面 | 前端 | ✅ 已修复 (2026-01-21) |
| A-01 | 合约间调用链断裂 | 系统架构 | ✅ 已修复 (2026-01-21) |
| A-04 | 前端与合约 ABI 不匹配 | 系统架构 | ✅ 已修复 (2026-01-21) |
| A-05 | 多代币功能写了没用 | 系统架构 | ✅ 已修复 (2026-01-21) |

### 🟡 严重问题 (影响功能完整性)

| ID | 问题 | 文件 | 状态 |
|----|------|------|------|
| C-04 | 资金费率没有定期累计 | PositionManager.sol | ✅ 已修复 - 开仓初始化 (2026-01-21) |
| C-07 | Liquidation 没有对接多代币函数 | Liquidation.sol | ✅ 已修复 - 多代币清算 (2026-01-21) |
| F-06 | 没有显示保证金率 | PerpetualOrderPanel.tsx | ✅ 已修复 (2026-01-21) |
| A-02 | 没有 Keeper 更新资金费率 | 系统架构 | ✅ 已修复 (2026-01-21) |
| A-03 | 没有清算机器人 | 系统架构 | ✅ 已修复 - 支持多代币 (2026-01-21) |

### 🔴 借贷合约问题

| ID | 问题 | 文件 | 状态 |
|----|------|------|------|
| L-01 | claimInterest() 未减少 totalDeposits，导致会计膨胀 | LendingPool.sol | ✅ 已修复 (2026-02-10) |

### 🔴 V2 审计发现 (2026-02-10 全项目审计)

| ID | 严重性 | 问题 | 文件 | 状态 |
|----|--------|------|------|------|
| V2-C01 | Critical | Settlement funding fee 双重收费 (用 openTime 不更新) | Settlement.sol | ✅ 已修复 - 用 lastFundingSettled 替代 openTime |
| V2-C04 | Critical | parseFloat*1e18 精度丢失 (>9007 ETH 失败) | usePerpetualV2.ts | ✅ 已修复 - 改用 parseEther() |
| V2-C06 | Critical | 私钥存 React state (DevTools 可见) | useTradingWallet.ts | ✅ 已修复 - 改用 useRef 存储私钥 |
| V2-C05 | Critical | buy/sell 默认 minOut=0n (三明治攻击) | useTokenFactory.ts | ✅ 已修复 - 移除默认值强制传入 |
| V2-C03 | Critical | LendingPool share inflation attack | LendingPool.sol | ✅ 已修复 - 添加 virtual offset + 最小首存 |
| V2-H08 | High | closePair 无签名验证 (可冒充平仓) | orderSigning.ts | ✅ 已修复 - 添加签名验证 |
| V2-H11 | High | 浮点数计算 minAmountOut (精度丢失) | useSpotSwap.ts | ✅ 已修复 - 改用 bigint 计算 |
| V2-H10 | High | HTTP 明文传签名 (无 TLS) | api.ts | ✅ 已修复 - 生产环境强制 HTTPS |
| V2-H09 | High | 4 个独立 WebSocket 连接 | useWebSocketMarketData.ts | ⚠️ 已标记废弃 - 推荐迁移到 useUnifiedWebSocket |
| V2-H03 | High | ADL 只发事件不执行 | Settlement.sol | ✅ 确认合约逻辑正确 - 链下撮合引擎监听 ADLTriggered |
| V2-C02 | Critical | 保险金碎片化 (三个独立余额) | V1 合约 | ✅ V1 已废弃 - V2 Settlement 统一用 balances[insuranceFund] |

### 🟢 中等问题 (优化项)

| ID | 问题 | 文件 | 状态 |
|----|------|------|------|
| C-06 | 没有 Reader 合约批量读取 | 缺失 | ✅ 已修复 - Reader.sol (2026-01-21) |
| C-08 | 清算奖励可能溢出 | Liquidation.sol:161-166 | ✅ 已修复 - H-011 溢出保护 + Solidity 0.8.x 内置检查 (2026-01-21) |

---

## 四、开发规则 (每次修改前检查)

### 规则 1: 先确认调用链完整

```
修改任何函数前问自己:
□ 谁会调用这个函数?
□ 这个函数需要调用谁?
□ 数据从哪里来?
□ 修改后前端需要同步更新吗?
```

### 规则 2: 使用行业标准公式

```
□ PnL 计算是否符合 GMX getDelta 标准?
□ 强平价格是否符合 Bybit 公式?
□ 保证金率计算是否正确?
□ 不要自己发明公式
```

### 规则 3: 合约改动必须同步前端

```
□ 合约函数签名改了 → 更新前端 ABI
□ 合约新增函数 → 前端 hook 要调用
□ 合约返回值改了 → 前端解析要更新
```

### 规则 4: 每个修复必须验证

```
□ 写完合约 → 写测试
□ 部署后 → 前端调用验证
□ 验证失败 → 回滚并分析原因
```

### 规则 5: 更新本文件

```
□ 修复一个问题 → 更新状态为 ✅ 已修复
□ 发现新问题 → 添加到问题清单
□ 新的标准/规则 → 添加到对应章节
```

---

## 五、参考资源

### 开源代码
- GMX V1: https://github.com/gmx-io/gmx-contracts
- GMX V2: https://github.com/gmx-io/gmx-synthetics
- dYdX: https://github.com/dydxprotocol/perpetual
- Perpetual Protocol: https://github.com/perpetual-protocol/perp-curie-contract

### 文档
- Bybit 强平价格: https://www.bybit.com/en/help-center/article/Liquidation-Price-USDT-Contract/
- Hyperliquid 清算: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/liquidations

---

## 六、修复记录

### 2026-02-14 (前端性能优化 + 首页数据修复)

**修复 1: 无限循环 (PerpetualTradingTerminal 60次/秒 re-render)**
- 原因: `useUnifiedWebSocket.ts` useEffect deps 包含 `onConnect/onDisconnect/onError` 函数引用，每次 render 创建新函数 → deps 变化 → 重新执行 → 再次 render
- 修复: 使用 `useRef` 存储回调函数引用，useEffect deps 从 `[enabled, onConnect, onDisconnect]` 改为 `[enabled]`
- 文件: `frontend/src/hooks/common/useUnifiedWebSocket.ts`

**修复 2: WebSocket 自动连接恢复**
- 原因: `providers.tsx` 使用 `useAutoConnectWebSocket` (死代码，hardcoded `isConnected: false`)
- 修复: 改用 `useUnifiedWebSocket({ enabled: true })` (真实 WS 管理器)
- 文件: `frontend/src/app/providers.tsx`

**修复 3: 移除不正确的永续交易警告横幅**
- 原因: 横幅检查 `poolState?.perpEnabled` (链上状态)，但永续合约通过 Matching Engine 运行，不依赖链上标志
- 修复: 移除黄色警告横幅，badge 始终显示绿色 "Perpetual"
- 文件: `frontend/src/components/perpetual/PerpetualTradingTerminal.tsx`

**修复 4: 高频 store 更新导致级联 re-render**
- 原因: `tradingDataStore.setOrderBook/addRecentTrade/setTokenStats` 每次都 merge `lastUpdated: Date.now()`，所有订阅 store 的组件 re-render
- 修复: 移除高频 setter 中的 `lastUpdated`，仅保留在低频 setter (setPositions) 中
- 文件: `frontend/src/lib/stores/tradingDataStore.ts`, `frontend/src/hooks/common/useUnifiedWebSocket.ts`

**修复 5: 首页代币卡片 volume/traders/priceChange 显示为 0**
- 原因: MarketOverview 仅依赖 WS market_data，但 volume 来自永续交易 (trades24h)，无永续交易时为 0
- 修复: 添加 HTTP fallback 从 `/api/v1/market/tickers` 获取数据；使用 WS trades24h 作为交易笔数
- 文件: `frontend/src/components/discovery/MarketOverview.tsx`

**修复 6: 降低 HTTP 轮询频率**
- WalletBalanceContext: 15s → 60s
- useMarketData: 5s → 30s
- 文件: `frontend/src/contexts/WalletBalanceContext.tsx`, `frontend/src/hooks/common/useMarketData.ts`

**修复 7: 现货交易页面所有数据显示 $0 (ABI 字段不匹配)**
- 原因: `usePoolState.ts` 中 TokenFactory ABI 的 `getPoolState` 声明了 12 个 struct 字段（含 `lendingEnabled: bool`），但部署的合约只返回 11 个字段。viem 严格校验 boolean 值，误将 `metadataURI` 的 string 长度字节 (24=0x18) 解析为 bool → `InvalidBytesBooleanError`
- 修复: 从 ABI、`PoolState` 接口、`rawState` 类型中移除 `lendingEnabled` 字段（11 个字段匹配合约）。同步清理 `useTokenList.ts` 中的 `lendingEnabled` 引用
- 文件: `frontend/src/hooks/spot/usePoolState.ts`, `frontend/src/hooks/common/useTokenList.ts`

**修复 8: K线图表黑屏 (无历史数据时链上价格兜底)**
- 原因: K线数据存储在 Redis 中，本地开发需要 Redis 运行。Redis 未启动或无历史交易时，API 返回空数据 → `wsChartData` 为空 → 图表显示黑色遮罩
- 修复: 在 `TokenPriceChart.tsx` 中添加 `usePoolState` 链上价格兜底。当 WS K线为空且链上有价格时，生成种子蜡烛（seed candle）使图表显示当前价格线而非黑屏
- 文件: `frontend/src/components/spot/TokenPriceChart.tsx`

**修复 9: 清理诊断日志**
- 移除 `usePoolState.ts`、`TradingTerminal.tsx`、`TokenPriceChart.tsx`、`page.tsx` 中为排查问题临时添加的 `console.log` 诊断代码
- 文件: 上述 4 个文件

**⚠️ 不可回退的关键修复 (回退会导致严重问题):**
1. `useUnifiedWebSocket.ts` 的 useRef 回调模式 — 回退会导致无限循环
2. `providers.tsx` 使用 `useUnifiedWebSocket` — 回退会断开 WS 连接
3. `tradingDataStore.ts` 高频 setter 不设置 `lastUpdated` — 回退会导致级联 re-render
4. `useUnifiedWebSocket.ts` 的 `handleMessage` 不调用 `store.setLastUpdated()` — 回退同上
5. `usePoolState.ts` ABI 保持 11 个字段 — 添加回 `lendingEnabled` 会导致 InvalidBytesBooleanError

**修改的文件:**
- `frontend/src/hooks/common/useUnifiedWebSocket.ts` — useRef 回调 + 移除 handleMessage 中的 setLastUpdated
- `frontend/src/app/providers.tsx` — 改用 useUnifiedWebSocket
- `frontend/src/components/perpetual/PerpetualTradingTerminal.tsx` — 移除警告横幅
- `frontend/src/lib/stores/tradingDataStore.ts` — 高频 setter 移除 lastUpdated
- `frontend/src/components/discovery/MarketOverview.tsx` — HTTP fallback + uniqueTraders
- `frontend/src/contexts/WalletBalanceContext.tsx` — 轮询频率降低
- `frontend/src/hooks/common/useMarketData.ts` — 轮询频率降低
- `frontend/src/hooks/spot/usePoolState.ts` — ABI 修复 (移除 lendingEnabled) + 移除诊断日志
- `frontend/src/hooks/common/useTokenList.ts` — 移除 lendingEnabled 引用
- `frontend/src/components/spot/TokenPriceChart.tsx` — 链上价格种子蜡烛兜底 + 移除诊断日志
- `frontend/src/components/common/TradingTerminal.tsx` — 移除诊断日志
- `frontend/src/app/trade/[address]/page.tsx` — 移除诊断日志

### 2026-02-10 (V2 全项目安全审计修复 — 11 个发现)

**V1 架构已确认废弃，以下修复全部针对 V2 架构。**

**合约修复 (3 个):**
- V2-C01: Settlement.sol `_settleFunding()` 双重收费 — 添加 `lastFundingSettled` 字段到 PairedPosition，每次结算后更新，避免从 openTime 重复计算
- V2-C03: LendingPool.sol share inflation attack — 添加 `VIRTUAL_SHARES/VIRTUAL_ASSETS` offset + `MIN_INITIAL_DEPOSIT=1000` 最小首存量
- V2-C01 详细：`pos.lastFundingSettled += periods * FUNDING_INTERVAL` 对齐到周期边界

**前端修复 (7 个):**
- V2-C04: usePerpetualV2.ts 提现金额转换 `BigInt(Math.floor(parseFloat(amount)*1e18))` → `parseEther(amount)`
- V2-C06: useTradingWallet.ts 私钥从 `useState` 改为 `useRef`，不再暴露给 React DevTools
- V2-C05: useTokenFactory.ts buy/sell 移除 `minOut=0n` 默认值，强制调用者传入滑点保护值
- V2-H08: orderSigning.ts `requestClosePair` 添加签名参数 + `getClosePairMessage` 签名消息生成
- V2-H11: useSpotSwap.ts `minAmountOut` 从浮点计算改为 bigint 基点计算
- V2-H10: api.ts 生产环境自动升级 HTTP→HTTPS
- V2-H09: useWebSocketMarketData.ts 添加 @deprecated 标记，推荐迁移到 useUnifiedWebSocket

**降级/关闭 (2 个):**
- V2-H03: Settlement ADL — 确认 `executeADL()` 实际调用 `_closePair()`，逻辑正确。`ADLTriggered` 事件是链下撮合引擎的 ADL 触发信号
- V2-C02: 保险金碎片化 — V1 问题，V2 Settlement 已统一使用 `balances[insuranceFund]` 内部记账

**修改的文件:**
- `contracts/src/perpetual/Settlement.sol` — PairedPosition 添加 lastFundingSettled 字段 + _settleFunding 修复
- `contracts/src/spot/LendingPool.sol` — 添加 MIN_INITIAL_DEPOSIT + VIRTUAL_SHARES offset
- `frontend/src/hooks/perpetual/usePerpetualV2.ts` — parseEther + closePair 签名
- `frontend/src/hooks/perpetual/useTradingWallet.ts` — privateKey useState→useRef
- `frontend/src/hooks/spot/useTokenFactory.ts` — 移除 minOut 默认值
- `frontend/src/hooks/spot/useSpotSwap.ts` — bigint 滑点计算
- `frontend/src/utils/orderSigning.ts` — closePair 签名 + getClosePairMessage
- `frontend/src/config/api.ts` — 生产环境 HTTPS 强制
- `frontend/src/hooks/common/useWebSocketMarketData.ts` — @deprecated 标记

### 2026-02-10 (LendingPool claimInterest 会计 bug 修复)
**合约修复:**
- L-01: `claimInterest()` 转出利息代币但未减少 `pool.totalDeposits`，导致会计膨胀。
  长期后果：totalDeposits 超出合约实际余额，最后提取的用户无法 withdraw。
  修复：在 `safeTransfer` 前添加 `pool.totalDeposits -= interest;`

**新增测试 (4 个):**
- `test_ClaimInterest_ReducesTotalDeposits` — 验证 totalDeposits 在 claim 后减少
- `test_ClaimInterest_BalanceInvariant` — 验证 `contractBalance >= totalDeposits - totalBorrowed` 不变量
- `test_ClaimInterest_MultiUser_WithdrawAfterClaim` — 多用户场景：一人 claim 后其他人仍可完整 withdraw
- `test_ClaimInterest_ZeroPending_NoOp` — 零利息 claim 不影响 totalDeposits

**修改的文件:**
- `contracts/src/spot/LendingPool.sol` — claimInterest() +1 行
- `contracts/test/LendingPool.t.sol` — +4 个新测试
- 测试结果: 50 passed, 0 failed

### 2026-01-21 (第二批修复)
**合约修复:**
- C-01/C-05: 添加 `PriceFeed.updateTokenPriceFromFactory()` 函数，TokenFactory 交易后自动同步价格
- C-02: 验证 PnL 计算已符合 GMX 标准，添加 `getTokenUnrealizedPnL()` 多代币支持
- C-03: 重写强平价格公式按 Bybit 标准，添加 `getTokenLiquidationPrice()` 多代币支持
- A-01: 修复合约调用链: TokenFactory → PriceFeed → PositionManager

**前端修复:**
- F-01/F-02: 创建 `usePerpetualToken` hook 支持多代币永续交易
- F-03/F-04/F-05: 在 PerpetualOrderPanel 添加仓位信息展示（大小、入场价、未实现盈亏、强平价）
- F-08: 添加平仓按钮和 `handleClosePosition` 函数
- A-04/A-05: 更新前端 ABI 包含所有多代币函数

**修改的文件:**
- `contracts/src/core/PriceFeed.sol` - 添加 updateTokenPriceFromFactory
- `contracts/src/core/TokenFactory.sol` - 添加 PriceFeedHelper 库和价格同步调用
- `contracts/src/core/PositionManager.sol` - 添加 getTokenUnrealizedPnL, getTokenLiquidationPrice
- `frontend/src/hooks/usePerpetual.ts` - 添加 usePerpetualToken hook 和多代币 ABI
- `frontend/src/components/trading/PerpetualOrderPanel.tsx` - 添加仓位展示和平仓功能

### 2026-01-21 (第三批修复 - 全部完成)
**合约修复:**
- C-04: 在 PositionManager `_openPosition` 中添加 `fundingRate.settleUserFunding()` 初始化用户 funding index
- C-07: 为 Liquidation.sol 添加多代币清算函数 (`liquidateToken`, `canLiquidateToken`, `getUserPnLToken` 等)
- C-06: 创建 Reader.sol 批量读取合约（`getPositionsBatch`, `getUserDashboard`, `getMarketOverview` 等）
- C-08: 确认 H-011 溢出保护 + Solidity 0.8.x 内置检查已解决溢出问题

**前端修复:**
- F-07: 在 PerpetualTradingTerminal 中传入 `tokenAddress` prop 到 PerpetualOrderPanel
- F-06: 添加保证金率显示 (`getTokenMarginRatio` + UI 展示)

**后端修复:**
- A-02: 确认 FundingKeeper 已实现，支持链上结算
- A-03: 为 LiquidationContract 添加多代币清算函数 (`LiquidateToken`, `CanLiquidateToken` 等)

**修改的文件:**
- `contracts/src/core/PositionManager.sol` - 添加 getTokenMarginRatio, settleUserFunding 调用
- `contracts/src/core/Liquidation.sol` - 添加 liquidateToken, canLiquidateToken 等多代币函数
- `contracts/src/periphery/Reader.sol` - 新建批量读取合约
- `contracts/src/interfaces/IPositionManager.sol` - 添加 view 函数接口
- `frontend/src/hooks/usePerpetual.ts` - 添加 marginRatio 支持
- `frontend/src/components/trading/PerpetualOrderPanel.tsx` - 添加保证金率展示
- `frontend/src/components/trading/PerpetualTradingTerminal.tsx` - 传入 tokenAddress
- `backend/internal/blockchain/contracts.go` - 添加多代币清算合约绑定

### 2026-01-21 (初始)
- 创建本开发准则文件
- 完成问题收集和行业标准研究

---

## 七、V2 架构部署指南

### 部署步骤

1. **部署 Settlement 合约**
```bash
cd contracts
forge script script/DeploySettlement.s.sol --rpc-url $RPC_URL --broadcast
# 记录输出的 Settlement 地址
```

2. **配置前端**
```env
# frontend/.env.local
NEXT_PUBLIC_SETTLEMENT_ADDRESS=<部署的地址>
NEXT_PUBLIC_MATCHING_ENGINE_URL=http://localhost:8081
NEXT_PUBLIC_USE_V2_TRADING=true
```

3. **配置撮合引擎**
```bash
cd backend/src/matching
cp .env.template .env
# 编辑 .env 设置:
# - SETTLEMENT_ADDRESS
# - MATCHER_PRIVATE_KEY (需要有 ETH 支付 gas)
# - RPC_URL
```

4. **启动撮合引擎**
```bash
cd backend/src/matching
npm install
npm run dev
```

5. **验证部署**
```bash
# 检查 Settlement 合约
cast call $SETTLEMENT_ADDRESS "owner()" --rpc-url $RPC_URL

# 检查撮合引擎
curl http://localhost:8081/health
```

### 关键文件

| 功能 | 合约 | 后端 | 前端 |
|------|------|------|------|
| 结算 | Settlement.sol | - | - |
| 部署 | DeploySettlement.s.sol | - | - |
| 撮合 | - | matching/engine.ts | - |
| API | - | matching/server.ts | - |
| Hook | - | - | usePerpetualV2.ts |
| 组件 | - | - | PerpetualOrderPanelV2.tsx |
| 签名 | - | - | orderSigning.ts |

### 授权撮合者
```bash
# 在部署后，授权撮合者地址
cast send $SETTLEMENT_ADDRESS "setAuthorizedMatcher(address,bool)" $MATCHER_ADDRESS true \
  --rpc-url $RPC_URL --private-key $OWNER_PRIVATE_KEY
```

---

**最后更新**: 2026-03-04
**下次修改前必须先读取本文件**
**链上结算层已打通！BSC Testnet (97) SettlementV2 + PerpVault 完整管道已连接！E2E 测试 36/36 通过！**

---

## 十二、链上结算架构 — Off-chain/On-chain Settlement (2026-03-01)

### 架构概述 (简化版 dYdX v3 模型)

```
用户存款 → SettlementV2 (WETH 托管)
           ↓ 事件监听
撮合引擎 (链下) → 订单撮合 + 仓位管理 + PnL 计算
           ↓ 30s 批量结算
PerpVault (GMX-style LP 池 = 保险基金)
           ↓ 每小时
Merkle 快照提交 → SettlementV2.updateStateRoot()
           ↓
用户提款 → Merkle proof + EIP-712 签名 → SettlementV2.withdraw()
```

### 合约地址 (BSC Testnet — Chain 97)

| 合约 | 地址 | 角色 |
|------|------|------|
| SettlementV2 | `0x7fF9d60aE49F14bB604FeF1961910D7931067873` | 用户 WBNB 托管 + Merkle 提款 |
| PerpVault | `0x7F98ed779c3352f39b041C57d5B2C73F84dcAA75` | LP 池 + 保险基金 + OI 管理 |
| TokenFactory | `0x22276744bAF24eD503dB50Cc999a9c5AD62728cb` | Meme 代币发射台 |
| PriceFeed | `0xe2b22673fFBeB7A2a4617125E885C12EC072ee48` | 价格预言机 |
| WBNB | `0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd` | 抵押品代币 |

### 关键模块

| 模块 | 文件 | 职责 |
|------|------|------|
| 批量结算队列 | `backend/src/matching/modules/perpVault.ts` | payable 调用排队, 30s 批量执行 |
| 存款事件监听 | `backend/src/matching/server.ts` (L~5167) | SettlementV2 Deposited/DepositedFor → 余额同步 |
| Merkle 快照 | `backend/src/matching/modules/snapshot.ts` | 每小时生成 Merkle root → 链上提交 |
| 提款授权 | `backend/src/matching/modules/withdraw.ts` | EIP-712 签名 + nonce 链上同步 |
| Keeper 仓位查询 | `backend/internal/keeper/liquidation.go` | HTTP 查询引擎 → 降级 PostgreSQL |

### 运维引导 (Phase 0)

```bash
cd contracts
forge script script/ConfigureSettlement.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast -vvv
```

### 余额不变量

```
SettlementV2.WETH >= sum(userDeposits) - sum(totalWithdrawn)
PerpVault.balance >= 最低安全阈值 (2 ETH seed)
engineWallet.balance >= 0.05 ETH (gas 预留)
```

---

## 十一、SettlementV2 Merkle 提款系统 (2026-02-25)

### 合约部署信息

| 合约 | 地址 | 网络 |
|------|------|------|
| SettlementV2 | `0x7fF9d60aE49F14bB604FeF1961910D7931067873` | BSC Testnet (97) |
| Collateral (WBNB) | `0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd` | BSC Testnet (97) |
| PerpVault | `0x7F98ed779c3352f39b041C57d5B2C73F84dcAA75` | BSC Testnet (97) |

### 架构说明 (dYdX v3 模式)

```
用户 deposit WETH → SettlementV2
         ↓
链下撮合引擎交易 → mode2PnLAdjustments 更新
         ↓
snapshot 模块采集用户权益 → 构建 Merkle tree → 提交 root 到链上
         ↓
用户请求提款 → 后端生成 proof + EIP-712 签名
         ↓
前端提交到链上 → SettlementV2 验证 proof + 签名 → 转账 WETH
```

### V1 → V2 资金迁移策略

**策略: V1/V2 共存 + 自然迁移（不做强制迁移）**

1. **新用户**: 直接通过前端 deposit WETH 到 SettlementV2
2. **老用户**: V1 (Settlement) 余额继续可用，可通过 V1 `withdraw()` 提出后重新 deposit 到 V2
3. **后端智能路由**: `server.ts` 根据 `SETTLEMENT_V2_ADDRESS` 环境变量自动选择路径：
   - 有 V2 地址 → Merkle 模式（snapshot → submitRoot → 用户 proof 提款）
   - 无 V2 地址 → V1 模式（无链上提交，仅链下记账）
4. **batchSettlePnL 保留**: 作为 V1 补充工具，`/api/admin/settle-pnl` 端点继续可用
5. **前端**: deposit/withdraw UI 统一指向 V2 合约

### 关键文件

| 层 | 文件 | 用途 |
|---|------|------|
| 合约 | `SettlementV2.sol` | Merkle 验证 + EIP-712 提款 |
| 后端 | `snapshot.ts` | 定期快照 + Merkle tree + submitRoot |
| 后端 | `withdraw.ts` | 生成 proof + EIP-712 签名 |
| 后端 | `merkle.ts` | Merkle tree 构建 + proof |
| 后端 | `server.ts` | V2 智能路由 + 提款 API |
| 前端 | `usePerpetualV2.ts` | deposit + withdraw hooks |
| 前端 | `contracts.ts` | SETTLEMENT_V2 地址 + ABI |

---

## 十、Batch 5 安全审计修复记录

### 2026-02-24 (全面系统安全审计 — P0 资金安全修复)

**P0-1: 禁用 SKIP_SIGNATURE_VERIFY 测试开关**
- 风险: 环境变量 `SKIP_SIGNATURE_VERIFY=true` 时任何人可伪造任意用户订单
- 修复: 改为仅在 `NODE_ENV=test` + `SKIP_SIGNATURE_VERIFY=true` 同时满足时才生效
- 启动时打印醒目警告
- 文件: `backend/src/matching/server.ts`

**P0-4: emergencyRescue 双花修复**
- 风险: 紧急救援发送 ETH 但不扣减 `balances` 映射 → 用户可再次 `withdraw()` 双花
- 修复: 先从 `balances[user]` 扣除，不足部分从 `lockedBalances[user]` 扣除
- 添加 `require(available + locked >= amount)` 检查
- 文件: `contracts/src/common/Vault.sol`

**P0-2: PriceFeed Uniswap V2 价格源（毕业后价格链修复）**
- 风险: 代币毕业到 Uniswap V2 后，PriceFeed 价格冻结 → 永续合约用过时价格交易/清算
- 修复:
  - `PriceFeed.sol`: 新增 `updateTokenPriceFromUniswap(token)` — 无权限限制，任何 Keeper 可调用刷新价格
  - `PriceFeed.sol`: 新增 `tokenUniswapPair` 映射 + `setTokenUniswapPair()` 设置函数
  - `TokenFactory.sol`: `_graduate()` 成功后存储 `uniswapPairs[tokenAddress] = pairAddress`
  - `TokenFactory.sol`: 毕业时自动通知 PriceFeed 设置 Uniswap Pair
  - `IPriceFeed.sol`: 接口新增 `updateTokenPriceFromUniswap`, `setTokenUniswapPair`, `tokenUniswapPair`, `setWETH`
  - 后端 `server.ts`: 已有 Uniswap V2 价格读取逻辑（`graduatedTokens` Map + `getReserves()`）
- 文件: `PriceFeed.sol`, `IPriceFeed.sol`, `TokenFactory.sol`

**P0-3: 保险基金耗尽处理（验证已实现）**
- Settlement.sol `_settleProfit()`: 已处理保险基金不足 → 支付可用余额 + 发出 `ADLTriggered` 事件
- Vault.sol: 已有 `pendingProfits` + `claimPendingProfit()` + `claimPartialPendingProfit()` (H-016)
- Liquidation.sol: 已有 `_handleInsuranceShortfall()` → 触发 ADL → 暂停交易

**验证结果:**
- `forge build --force` ✅ 编译成功
- `forge test` ✅ 345 tests passed, 0 failed
- `npx next build` ✅ 13 pages compiled

**修改的文件:**
- `backend/src/matching/server.ts` — P0-1 签名验证改为 NODE_ENV=test 限定 + 启动警告
- `contracts/src/common/Vault.sol` — P0-4 emergencyRescue 添加余额扣减
- `contracts/src/common/PriceFeed.sol` — P0-2 新增 Uniswap V2 价格读取 + Pair 映射
- `contracts/src/interfaces/IPriceFeed.sol` — P0-2 接口更新
- `contracts/src/spot/TokenFactory.sol` — P0-2 毕业时存储 Pair + 通知 PriceFeed

**⚠️ 部署注意:**
- PriceFeed 需要重新部署并调用 `setWETH(0x4200000000000000000000000000000000000006)`
- TokenFactory 需要重新部署（新增 `uniswapPairs` 映射）
- Vault 需要重新部署（emergencyRescue 逻辑变更）
- 已毕业代币需要 owner 手动调用 `PriceFeed.setTokenUniswapPair(token, pair)` 设置 Pair

### 2026-02-24 (Phase 2: P1 功能正确性修复)

**P1-1: 精度统一到 1e18（验证已实现）**
- Settlement.sol 已有 `_toStandardDecimals` / `_fromStandardDecimals` 处理非 18 位代币
- 无需额外修改

**P1-2: 合约层滑点保护（验证已实现）**
- TokenFactory.sol `buy()` 和 `sell()` 已有 `require(tokensOut >= minTokensOut)` / `require(ethOut >= minEthOut)` 检查
- 无需额外修改

**P1-3: 活跃仓位提款延迟**
- 风险: 用户有活跃仓位（locked 资金）时立即提款可能影响系统偿付能力
- 修复:
  - 新增 `withdrawalDelay` 可配置延迟（owner 设置，最大 7 天）
  - 新增 `WithdrawRequest` 结构体 + `pendingWithdrawals` 映射
  - 修改 `withdraw()`: 有 locked 资金且 delay>0 时，提款进入 pending 队列
  - 新增 `executeWithdraw()`: 超过延迟时间后可执行
  - 新增 `cancelWithdraw()`: 用户可取消待处理提款
  - 新增事件: `WithdrawRequested`, `WithdrawExecuted`, `WithdrawCancelled`, `WithdrawalDelaySet`
  - 新增错误: `WithdrawNotReady`, `NoPendingWithdraw`, `WithdrawDelayTooLong`
- 文件: `contracts/src/common/Vault.sol`

**P1-4: 链上 ADL 超时触发**
- 风险: `ADLTriggered` 事件后如果撮合引擎宕机/未响应，系统陷入僵局
- 修复:
  - 新增状态: `adlActive` (bool) + `lastADLTriggerTime` (uint256)
  - `_settleProfit()` 保险基金耗尽时自动激活 ADL 状态
  - 新增 `forceADL(pairId)`: 任何人可在 5 分钟超时后强制平仓指定仓位
  - 新增 `resolveADL()`: matcher/owner 可手动解除 ADL 状态
  - `executeADL()` 执行后自动重置 ADL 状态
  - 保险基金恢复时自动解除 ADL 状态
  - 新增常量: `ADL_TIMEOUT = 5 minutes`
  - 新增事件: `ForceADLExecuted`, `ADLResolved`
  - 新增错误: `NoActiveADL`, `ADLTimeoutNotReached`
- 文件: `contracts/src/perpetual/Settlement.sol`

**P1-5: Redis 订单镜像到 PostgreSQL**
- 风险: Redis 重启/崩溃后所有待处理订单丢失
- 修复:
  - 安装 `postgres` 包 (Bun 兼容)
  - 重写 `database/postgres.ts`: 实际 PostgreSQL 连接 + 自动创建 `perp_order_mirror` 表
  - 新增 `OrderMirrorRepo`: upsert / updateStatus / getActiveOrders / countActive
  - 订单提交后异步 upsert 到 PostgreSQL (不阻塞撮合)
  - 订单状态变更 (`broadcastOrderUpdate`) 时异步更新 PostgreSQL
  - 订单取消时异步更新 PostgreSQL 状态为 CANCELED
  - 启动时: Redis 有订单 → 使用 Redis; Redis 空 → 从 PostgreSQL 恢复
  - PostgreSQL 不可用时系统正常运行 (仅 Redis)
- 文件: `backend/src/matching/database/postgres.ts`, `backend/src/matching/server.ts`

**验证结果:**
- `forge build --force` ✅ 编译成功
- `forge test` ✅ 345 tests passed, 0 failed
- `npx next build` ✅ 13 pages compiled
- `bun build --no-bundle server.ts` ✅ 转译成功

**修改的文件:**
- `contracts/src/common/Vault.sol` — P1-3 提款延迟机制
- `contracts/src/perpetual/Settlement.sol` — P1-4 ADL 超时触发 + forceADL + resolveADL
- `backend/src/matching/database/postgres.ts` — P1-5 PostgreSQL 实际连接 + OrderMirrorRepo
- `backend/src/matching/server.ts` — P1-5 导入 PostgreSQL + 订单镜像写入 + 启动恢复逻辑
- `backend/src/matching/package.json` — P1-5 新增 `postgres` 依赖

**⚠️ 部署注意:**
- Settlement 需重新部署（P1-4 新增 ADL 状态变量和 forceADL 函数）
- Vault 需重新部署（P1-3 新增提款延迟逻辑）
- 后端需配置 `DATABASE_URL` 环境变量启用 PostgreSQL 镜像
- PostgreSQL 镜像是可选的 — 未配置时系统仍使用 Redis-only 模式

---

## 九、PerpVault 生产级审计修复记录

### 2026-02-10 — 基于 GMX V1/V2、HyperLiquid、Jupiter、Gains Network 源码级审计

**审计报告**: `docs/AUDIT_V3_FULL.md` (V3 包含 PerpVault 审计结果)

**修复的致命问题 (C1-C3):**

| ID | 问题 | 对标 | 修复 |
|----|------|------|------|
| C1 | 池子价值不含未实现盈亏 | GMX `getAum()`, Jupiter AUM, Gains `accPnlPerTokenUsed` | 添加 `netPendingPnL` + `updatePendingPnL()` + 修改 `getPoolValue()` |
| C2 | 无 ADL 自动减仓机制 | GMX V2 `AdlUtils.sol`, HyperLiquid 阶梯式减仓 | `shouldADL()` 视图 + `settleTraderProfit` 部分结算替代 revert |
| C3 | 低流动性代币仓位无限制 | HyperLiquid JELLY 事件教训 | 运营层面合理配置 `maxOIPerToken` |

**修复的高优先级问题 (H1-H2):**

| ID | 问题 | 对标 | 修复 |
|----|------|------|------|
| H1 | 冷却期 hardcoded 不可调 | GMX `cooldownDuration` 可配置 | `setCooldown()` + `MAX_COOLDOWN=7days` |
| H2 | 无存款上限/私有模式 | GMX `inPrivateMode` + `maxUsdgAmount` | `setMaxPoolValue()` + `setDepositsPaused()` |

**新增函数:**
```solidity
// C1: 未实现盈亏
function updatePendingPnL(int256 _netPnL) external onlyAuthorized;
function getRawBalance() public view returns (uint256);

// C2: ADL
function shouldADL() public view returns (bool shouldTrigger, uint256 pnlToPoolBps);

// H1: 可配置冷却期
function setCooldown(uint256 _cooldown) external onlyOwner;

// H2: 存款控制
function setMaxPoolValue(uint256 _maxValue) external onlyOwner;
function setDepositsPaused(bool _paused) external onlyOwner;

// 扩展统计
function getExtendedStats() external view returns (...);
```

**关键公式变更:**
```solidity
// BEFORE:
getPoolValue() = address(this).balance

// AFTER (GMX 标准):
getPoolValue() = address(this).balance - netPendingPnL
// netPendingPnL > 0 = 交易者赚钱 = 池子负债
// netPendingPnL < 0 = 交易者亏钱 = 池子资产
```

**撮合引擎需要配合的改动:**
- 每次开仓/平仓/价格变动时调用 `updatePendingPnL()`
- 定期检查 `shouldADL()` 并执行减仓

**测试覆盖: 85 个测试全部通过** (原 57 + 新增 28)

---

## 八、Settlement 合约升级记录

### 2026-01-25 - 支持 1:N 撮合 + USDT 计价

**升级 1: 1:N 撮合**

问题: 原有 `usedOrders` 映射将整个订单标记为已使用，导致一个大订单只能与一个对手方撮合。

解决方案:
- 替换 `usedOrders` 为 `filledAmounts` 追踪每个订单的已成交数量
- 修改 `_validateOrder` 检查 `filledAmounts[orderHash] >= order.size`
- 修改 `_settlePair` 验证不超额成交并更新已成交数量
- 顺序 nonce 模式只在完全成交时递增 nonce

**升级 2: USDT 计价**

问题: 原版使用 ETH 作为保证金，盈亏随 ETH 价格波动。

解决方案:
- 添加 `collateralToken` 状态变量（USDT/USDC）
- 修改 `deposit(uint256 amount)` 为 ERC20 转入
- 修改 `withdraw(uint256 amount)` 为 ERC20 转出
- 所有保证金、仓位、盈亏都以 USDT 计价

**新合约地址**:
- Settlement: `0xaAAc66A691489BBF8571C8E4a95b1F96F07cE0Bc`
- MockUSDT: `0x8d44C3cf6252FaC397c7A237F70466907D6fcB47`

**USDT 精度**: 6 位小数 (1 USDT = 1e6)

**关键变更**:
```solidity
// 保证金代币
IERC20 public collateralToken;

// 存款（需先 approve）
function deposit(uint256 amount) external;

// 提款
function withdraw(uint256 amount) external;
```

**用户操作流程**:
```javascript
// 1. 获取测试 USDT
await mockUsdt.mint(userAddress, 10000 * 1e6); // 10,000 USDT

// 2. 授权 Settlement 使用 USDT
await usdt.approve(settlementAddress, MaxUint256);

// 3. 存入 USDT
await settlement.deposit(1000 * 1e6); // 存入 1,000 USDT

// 4. 签名订单、交易...

// 5. 提款 USDT
await settlement.withdraw(500 * 1e6); // 提取 500 USDT
```

**升级 3: Session Key（免签名交易）**

问题: 每次操作都需要钱包签名，体验差。

解决方案:
- 用户授权 Session Key（临时密钥）
- Session Key 代用户执行存款/提款/交易
- 用户无需频繁签名，体验接近中心化交易所

**Session Key 特性**:
- 金额限制：单次最大金额 + 每日限额
- 时间限制：自动过期
- 权限控制：可单独控制存款/交易/提款权限
- 可随时撤销

**最终合约地址**:
- Settlement: `0xd84d1fFF3650ab4806B15A0D5F32932E80f0E32C`
- MockUSDT: `0x246c4A147F8b7Afb2b4b820284f11F5119553106`

**前端集成示例**:
```javascript
// 1. 首次设置：生成 Session Key 并授权
const sessionWallet = ethers.Wallet.createRandom();
localStorage.setItem('sessionKey', sessionWallet.privateKey);

await settlement.authorizeSessionKey(
    sessionWallet.address,
    1000 * 1e6,      // 单次最大 1000 USDT
    5000 * 1e6,      // 每日限额 5000 USDT
    Date.now()/1000 + 86400,  // 24小时有效
    true,  // 可存款
    true,  // 可交易
    false  // 不可提款（更安全）
);

// 2. 用户 approve USDT（只需一次）
await usdt.approve(settlementAddress, MaxUint256);

// 3. 之后：Session Key 自动存款（无钱包弹窗）
const sessionKey = new ethers.Wallet(localStorage.getItem('sessionKey'), provider);
await settlement.connect(sessionKey).depositWithSessionKey(userAddress, amount);
```

**验证命令**:
```bash
# 查询保证金代币地址
cast call 0xd84d1fFF3650ab4806B15A0D5F32932E80f0E32C "getCollateralToken()" --rpc-url $RPC_URL

# 查询 Session Key 授权
cast call 0xd84d1fFF3650ab4806B15A0D5F32932E80f0E32C "getSessionKey(address,address)" <user> <sessionKey> --rpc-url $RPC_URL

# 查询用户 USDT 余额
cast call 0x246c4A147F8b7Afb2b4b820284f11F5119553106 "balanceOf(address)" <user> --rpc-url $RPC_URL

# Mint 测试 USDT（任何人都可以）
cast send 0x246c4A147F8b7Afb2b4b820284f11F5119553106 "mint(address,uint256)" <user> 10000000000 --rpc-url $RPC_URL
```

---

## 十二、安全审计状态

> **更新时间**: 2026-02-25

### 当前状态: ⚠️ 待外部审计

### 已完成的安全措施

| 措施 | 状态 | 说明 |
|------|------|------|
| Ownable2Step | ✅ | SettlementV2 使用两步所有权转移 |
| ReentrancyGuard | ✅ | 所有资金操作函数 |
| EIP-712 签名验证 | ✅ | 提现需要平台签名 + Merkle proof |
| Nonce 防重放 | ✅ | 每次提现递增用户 nonce |
| SafeERC20 | ✅ | 所有 ERC20 操作使用安全包装 |
| API 速率限制 | ✅ | 内存滑窗 100/20/5 req/s |
| Nginx TLS | ✅ | TLS 1.2/1.3 + 安全头 |
| Redis 高可用 | ✅ | Sentinel 模式支持 |
| 外部安全审计 | ❌ | 未进行 |

### 审计重点领域

1. **Merkle Proof 验证** (`SettlementV2.sol`)
   - `withdraw()` 函数的 Merkle proof 验证逻辑
   - 叶子节点构造: `keccak256(abi.encodePacked(user, equity))`
   - 状态根更新权限控制

2. **EIP-712 签名安全** (`SettlementV2.sol`)
   - 域分隔符 (domain separator) 正确性
   - 签名重放防护 (nonce + deadline)
   - 签名者权限管理

3. **权限管理**
   - Owner → Ownable2Step (两步转移)
   - `authorizedUpdaters` 映射管理
   - `platformSigner` 更新流程

4. **资金安全**
   - `totalWithdrawn[user] + amount <= userEquity` 校验
   - 合约持有资金与 Merkle 树总量一致性
   - 重入保护 (ReentrancyGuard)

### 推荐审计机构

| 机构 | 类型 | 适合场景 |
|------|------|----------|
| Code4rena | 竞赛审计 | 社区审计，成本较低 |
| Sherlock | 竞赛审计 | DeFi 专精，有保险保障 |
| Trail of Bits | 私人审计 | 深度审计，顶级声誉 |
| OpenZeppelin | 私人审计 | 行业标准，全面覆盖 |

### 审计前风险缓解

在外部审计完成前，建议采取以下措施:

1. **存款上限**: 设置单用户最大存款额 (如 10 ETH)
2. **余额监控**: 监控合约 WETH 余额与 Merkle 树总额的一致性
3. **紧急暂停**: 发现异常时立即暂停合约 (需添加 Pausable)
4. **渐进式发布**: 先限制白名单用户测试，逐步开放

### BscScan 合约验证

```bash
# 获取 API Key: https://bscscan.com/myapikey
# 设置到 contracts/.env: BSCSCAN_API_KEY=your_key_here

# 验证 SettlementV2 (BSC Testnet)
forge verify-contract 0x7fF9d60aE49F14bB604FeF1961910D7931067873 \
  src/perpetual/SettlementV2.sol:SettlementV2 \
  --chain 97 \
  --constructor-args $(cast abi-encode "constructor(address,address,address)" \
    0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd \
    <SIGNER_ADDRESS> \
    <SIGNER_ADDRESS>) \
  --watch
```
