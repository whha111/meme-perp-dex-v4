# 派生钱包保证金架构改造计划

> 创建日期: 2026-03-21
> 状态: 待审批

## 一、改造目标

**从**: SettlementV2 托管池 + Redis 链下记账 + Merkle proof 提款
**到**: 派生钱包直接持有资金 + PerpVault 保证金锁定 + 乐观执行

**核心原则**: 用户资金在派生钱包里，需要时才转入合约（保证金），不需要时留在钱包。

---

## 二、改造前后资金流对比

### 改造前 (SettlementV2 模式)
```
充值: Main Wallet → BNB → 派生钱包 → wrap WBNB → approve → SettlementV2.deposit()
余额: Redis 记账 (availableBalance + mode2Adj + settlementAvailable)
开仓: Redis 扣 availableBalance → OI 异步上链
平仓: Redis 加 availableBalance + mode2Adj 记 PnL → PerpVault 异步结算
提现: 后端 Merkle proof → SettlementV2.withdraw(proof) → unwrap → 转回Main
```

### 改造后 (派生钱包模式)
```
充值: Main Wallet → BNB → 派生钱包 (完毕，一步)
余额: 可用 = 派生钱包 BNB 余额 (链上), 锁定 = PerpVault.traderMargin (链上)
开仓: 乐观撮合(即时) → 异步批量: 派生钱包 → PerpVault.depositMargin()
平仓: 乐观释放(即时) → 异步批量: PerpVault.settleClose() → BNB 回派生钱包
提现: 派生钱包 → Main Wallet (一步，普通转账)
```

---

## 三、分阶段执行计划

### Phase 1: PerpVault 合约扩展 (预计 2 天)

#### 1.1 新增状态变量
```solidity
// 每个 trader 锁定的总保证金 (BNB)
mapping(address => uint256) public traderMargin;

// 每个 trader 每个 token 的保证金明细 (可选，用于链上审计)
mapping(address => mapping(address => uint256)) public traderTokenMargin;

// 保证金操作事件
event MarginDeposited(address indexed trader, uint256 amount);
event MarginWithdrawn(address indexed trader, uint256 amount);
event MarginSettled(address indexed trader, int256 pnl, uint256 marginReleased, uint256 returned);
event BatchMarginDeposited(uint256 count, uint256 totalAmount);
event BatchMarginSettled(uint256 count);
```

#### 1.2 新增函数

```solidity
// --- 单笔保证金操作 ---

/// @notice 派生钱包直接发送 BNB 作为保证金
function depositMargin() external payable whenNotPaused;

/// @notice 引擎调用: 减保证金退回 trader
function withdrawMargin(address trader, uint256 amount)
    external onlyAuthorized nonReentrant;

/// @notice 引擎调用: 平仓结算 (保证金释放 + PnL)
/// @param pnl 正=盈利(从LP出), 负=亏损(留在池子)
function settleClose(address trader, int256 pnl, uint256 marginRelease)
    external onlyAuthorized nonReentrant;

// --- 批量操作 (gas 优化) ---

/// @notice 引擎调用: 批量锁定保证金 (引擎代签，从多个派生钱包)
function batchDepositMargin(
    address[] calldata traders,
    uint256[] calldata amounts
) external payable onlyAuthorized;

/// @notice 引擎调用: 批量平仓结算
function batchSettleClose(
    address[] calldata traders,
    int256[] calldata pnls,
    uint256[] calldata marginReleases
) external onlyAuthorized nonReentrant;

// --- 查询函数 ---

function getTraderMargin(address trader) external view returns (uint256);
function getTraderTokenMargin(address trader, address token) external view returns (uint256);
```

#### 1.3 settleClose 核心逻辑
```
if pnl >= 0 (盈利):
    返还给trader = marginRelease + pnl
    traderMargin[trader] -= marginRelease
    LP池减少 pnl (settleTraderProfit 内部逻辑)
    transfer BNB → trader 地址

if pnl < 0 (亏损):
    loss = |pnl|
    if loss >= marginRelease:
        返还给trader = 0
        LP池增加 = marginRelease (全部亏完)
    else:
        返还给trader = marginRelease - loss
        LP池增加 = loss
    traderMargin[trader] -= marginRelease
    transfer BNB → trader 地址 (如果 > 0)
```

#### 1.4 安全要求
- [ ] CEI 模式: 状态更新在 transfer 之前
- [ ] nonReentrant 防重入
- [ ] onlyAuthorized 限制引擎调用
- [ ] 检查 traderMargin 不会下溢
- [ ] 批量操作验证数组长度一致
- [ ] batchDepositMargin 验证 msg.value == sum(amounts)

---

### Phase 2: 撮合引擎改造 (预计 3 天)

#### 2.1 新增模块: `modules/marginBatch.ts`

负责保证金操作的异步批量上链。

```typescript
interface PendingMarginOp {
    type: 'DEPOSIT' | 'WITHDRAW' | 'SETTLE_CLOSE';
    trader: Address;
    token?: Address;
    amount: bigint;        // 保证金金额
    pnl?: bigint;          // 仅 SETTLE_CLOSE
    marginRelease?: bigint; // 仅 SETTLE_CLOSE
    timestamp: number;
    orderId?: string;      // 关联订单 (用于失败回滚)
    positionId?: string;   // 关联仓位
}

// 队列
const pendingMarginOps: PendingMarginOp[] = [];

// 定时批量执行 (复用 perpVault.ts 的 globalTxLock + nonce 管理)
const MARGIN_FLUSH_INTERVAL = 10_000; // 10秒

export function queueMarginDeposit(trader, amount, orderId): void;
export function queueMarginWithdraw(trader, amount): void;
export function queueSettleClose(trader, pnl, marginRelease, positionId): void;
export async function flushMarginQueue(): Promise<void>;
export function startMarginFlush(): void;
export function stopMarginFlush(): void;
```

#### 2.2 flushMarginQueue 执行逻辑

```
1. 获取 globalTxLock (和 OI flush / settlement batch 互斥)
2. 快照并清空队列
3. 分组:
   a. DEPOSIT 组: 收集所有 trader + amount → 引擎从各派生钱包收集 BNB
      → 发送 PerpVault.batchDepositMargin{value: totalAmount}(traders, amounts)
   b. SETTLE_CLOSE 组: 收集所有 trader + pnl + marginRelease
      → 发送 PerpVault.batchSettleClose(traders, pnls, marginReleases)
   c. WITHDRAW 组: 逐笔 PerpVault.withdrawMargin(trader, amount)
4. 成功: 更新内存 softLock 状态 → confirmed
5. 失败: 执行回滚逻辑
```

#### 2.3 派生钱包 BNB 收集逻辑

DEPOSIT 时引擎需要从派生钱包转 BNB 到 PerpVault。两种方式:

**方案 A: 引擎代签** (推荐)
- 引擎持有派生钱包私钥 (wallet.ts getSigningKey)
- 引擎直接用派生钱包账户调 `PerpVault.depositMargin{value: amount}()`
- 每个 trader 一笔 tx (不能批量，因为每个派生钱包是独立 EOA)

**方案 B: 中转** (备选，gas更优)
- 引擎先从各派生钱包 transfer BNB → 引擎账户
- 引擎再调 `PerpVault.batchDepositMargin{value: total}(traders, amounts)`
- 两轮 tx，但第二轮可批量

→ **选方案 A**: 简单直接，每笔开仓一个异步tx。10秒内的开仓攒一批，每个 trader 一笔 tx。

#### 2.4 server.ts 改造点

| 函数 | 当前逻辑 | 改造后 |
|------|----------|--------|
| `deductOrderAmount()` | Redis 扣 availableBalance | 内存软锁定 + 队列 marginDeposit |
| `settleOrderMargin()` | usedMargin += proRata | 保持内存记账，队列确认后转 confirmed |
| `closePositionByMatch()` | adjustUserBalance + mode2Adj | 内存释放 + 队列 settleClose |
| `addMarginToPosition()` | availableBalance -= amount | 内存软锁定 + 队列 marginDeposit |
| `reduceMarginFromPosition()` | (不存在) | 新增: 队列 marginWithdraw |
| `syncUserBalanceFromChain()` | 读 SettlementV2 | 读派生钱包 BNB + PerpVault.traderMargin |
| `adjustUserBalance()` | totalBalance += amount | 保持，但明确标记为乐观状态 |
| `addMode2Adjustment()` | Redis 持久化 | 保持用于崩溃恢复，但不再是余额主数据 |

#### 2.5 余额模型重构

```typescript
interface OptimisticBalance {
    // 链上确认状态 (每30s同步)
    onChainWalletBNB: bigint;          // publicClient.getBalance(derivedWallet)
    onChainLockedMargin: bigint;       // PerpVault.traderMargin[trader]
    lastSyncBlock: number;

    // 乐观状态 (内存软锁定，实时更新)
    pendingMarginLock: bigint;         // 已撮合待上链的保证金
    pendingMarginRelease: bigint;      // 已平仓待上链的释放
    pendingPnL: bigint;               // 已结算待上链的PnL
    pendingOrdersLocked: bigint;      // 挂单预留 (和现在一样)

    // 用户可见 (计算属性)
    get available(): bigint {
        return onChainWalletBNB
            - pendingMarginLock
            + pendingMarginRelease
            + pendingPnL
            - pendingOrdersLocked;
    }
    get locked(): bigint {
        return onChainLockedMargin
            + pendingMarginLock
            - pendingMarginRelease;
    }
    get equity(): bigint {
        return available + locked + unrealizedPnL;
    }
}
```

#### 2.6 失败回滚

```typescript
async function handleMarginDepositFailure(op: PendingMarginOp): Promise<void> {
    // 1. 释放软锁定
    const balance = getOptimisticBalance(op.trader);
    balance.pendingMarginLock -= op.amount;

    // 2. 如果关联订单已成交 → 需要强平
    if (op.orderId) {
        const position = findPositionByOrder(op.orderId);
        if (position) {
            await forceClosePosition(op.trader, position.token, 'MARGIN_DEPOSIT_FAILED');
            broadcastError(op.trader, {
                type: 'MARGIN_FAILED',
                message: 'Position closed: margin deposit failed on-chain',
                orderId: op.orderId,
            });
        }
    }

    // 3. 重试一次 (可能只是 gas 不够)
    // 如果第二次还失败，确认强平
}

async function handleSettleCloseFailure(op: PendingMarginOp): Promise<void> {
    // 平仓结算失败 → 重试 (资金在合约里不会丢)
    retryQueue.push(op);
    // 最多重试 3 次，之后人工介入
}
```

---

### Phase 3: 前端简化 (预计 2 天)

#### 3.1 充值流程简化

**当前 (4步)**:
```
Main Wallet → BNB → 派生钱包 → wrap WBNB → approve → SettlementV2.deposit()
```

**改后 (1步)**:
```
Main Wallet → BNB → 派生钱包 (sendTransaction, 完毕)
```

**改动文件**:
- `AccountBalance.tsx`: `handleDeposit()` 只保留 Step 1 (sendTransaction)
- 删除 Step 2 (wrapAndDeposit) 和 Step 3 (settlementDeposit)
- 进度条从 3 步变 1 步

#### 3.2 提现流程简化

**当前 (5步)**:
```
POST /api/wallet/withdraw → Merkle proof → SettlementV2.withdraw() → unwrap → 转回 Main
```

**改后 (1步)**:
```
派生钱包 → sendETH → Main Wallet
```

**改动文件**:
- `AccountBalance.tsx`: `handleWithdraw()` 只调 `sendETH(mainWallet, amount)`
- `usePerpetualV2.ts`: 删除 `withdraw()` 函数中的 Merkle/fastWithdraw 逻辑
- 删除 `/api/wallet/withdraw` 端点依赖

#### 3.3 余额显示简化

**当前**:
```
WalletBalanceContext = settlementBalance + wethBalance + nativeEthBalance
3 个数据源 + 60s 轮询 + WS 刷新
```

**改后**:
```
可用余额 = 派生钱包 BNB (useBalance wagmi hook, 实时)
锁定保证金 = PerpVault.traderMargin[trader] (useReadContract, + WS 刷新)
总计 = 可用 + 锁定
```

**改动文件**:
- `WalletBalanceContext.tsx`:
  - 删除 `settlementBalance` 相关
  - 删除 `wethBalance` (不再 wrap)
  - 保留 `nativeEthBalance` (即可用余额)
  - 新增 `lockedMargin` (读 PerpVault)
- `wallet/page.tsx`: 更新余额卡片
- `account/page.tsx`: 更新资产总览

#### 3.4 WS 消息更新

```typescript
// 引擎推送的 balance 消息改为:
interface BalanceUpdate {
    available: string;          // 派生钱包 BNB (乐观值)
    locked: string;             // PerpVault 锁定保证金 (乐观值)
    pendingMarginLock: string;  // 待确认的锁定
    unrealizedPnL: string;
    equity: string;
}
```

---

### Phase 4: 清理废弃模块 (预计 1 天)

#### 4.1 删除文件
| 文件 | 原因 |
|------|------|
| `backend/src/matching/modules/relay.ts` | SettlementV2 gasless deposit，不需要了 |
| `backend/src/matching/modules/withdraw.ts` | Merkle proof 提款，不需要了 |
| `backend/src/matching/modules/snapshot.ts` | Merkle 快照，不需要了 |

#### 4.2 server.ts 清理
- 删除 SettlementV2 event listener (Deposited / DepositedFor / Withdrawn)
- 删除 `/api/wallet/withdraw` 端点的 Merkle proof 逻辑
- 删除 `syncUserBalanceFromChain()` 中 SettlementV2 相关读取
- 简化 mode2Adj 使用 → 仅保留作为崩溃恢复的备份

#### 4.3 前端清理
- `usePerpetualV2.ts`: 删除 `deposit()` 中的 SettlementV2 approve + deposit
- `usePerpetualV2.ts`: 删除 `withdraw()` 中的 Merkle proof 逻辑
- `useTradingWallet.ts`: 删除 `wrapAndDeposit()`, `depositBNBToSettlement()`, `depositExistingWBNB()`
- `WalletBalanceContext.tsx`: 删除 `fetchSettlementBalance()`
- `deposit/page.tsx`: 简化为单步充值页面

#### 4.4 配置清理
- `.env` 系列: 移除 `SETTLEMENT_V2_ADDRESS` 相关变量 (保留合约地址在 deployments.json 供参考)
- `lib/contracts.ts`: 移除 SETTLEMENT_V2_ABI 导入
- 注意: 不删除 SettlementV2.sol 合约代码 (保留供审计参考)

---

### Phase 5: 端到端测试 (预计 2 天)

见下方详细测试清单。

---

## 四、执行清单 (Execution Checklist)

### Phase 1: 合约

- [ ] **1.1** PerpVault.sol 添加 `traderMargin` mapping
- [ ] **1.2** PerpVault.sol 添加 `traderTokenMargin` mapping
- [ ] **1.3** 实现 `depositMargin()` — payable, 任何人可调
- [ ] **1.4** 实现 `withdrawMargin()` — onlyAuthorized
- [ ] **1.5** 实现 `settleClose()` — onlyAuthorized, nonReentrant
- [ ] **1.6** 实现 `batchDepositMargin()` — onlyAuthorized, payable
- [ ] **1.7** 实现 `batchSettleClose()` — onlyAuthorized, nonReentrant
- [ ] **1.8** 添加事件: MarginDeposited, MarginWithdrawn, MarginSettled, Batch 事件
- [ ] **1.9** 更新 IPerpVault.sol 接口
- [ ] **1.10** 编写 Foundry 测试: depositMargin 基本流程
- [ ] **1.11** 编写 Foundry 测试: settleClose 盈利场景
- [ ] **1.12** 编写 Foundry 测试: settleClose 亏损场景 (亏损 < 保证金)
- [ ] **1.13** 编写 Foundry 测试: settleClose 亏损场景 (全部亏完)
- [ ] **1.14** 编写 Foundry 测试: withdrawMargin (减保证金)
- [ ] **1.15** 编写 Foundry 测试: batchDepositMargin 批量
- [ ] **1.16** 编写 Foundry 测试: batchSettleClose 批量
- [ ] **1.17** 编写 Foundry 测试: 权限控制 (非授权地址调用失败)
- [ ] **1.18** 编写 Foundry 测试: CEI 安全 (重入攻击)
- [ ] **1.19** 编写 Foundry 测试: 边界条件 (0金额, 余额不足, 数组长度不匹配)
- [ ] **1.20** 部署到 BSC Testnet + 验证
- [ ] **1.21** 授权引擎地址为 authorizedContract

### Phase 2: 撮合引擎

- [ ] **2.1** 创建 `modules/marginBatch.ts` 模块
- [ ] **2.2** 实现 `queueMarginDeposit()` + `queueSettleClose()` + `queueMarginWithdraw()`
- [ ] **2.3** 实现 `flushMarginQueue()` — 复用 globalTxLock + nonce 管理
- [ ] **2.4** 实现批量 DEPOSIT 逻辑 (引擎代签各派生钱包 → PerpVault)
- [ ] **2.5** 实现批量 SETTLE_CLOSE 逻辑
- [ ] **2.6** 实现失败回滚: `handleMarginDepositFailure()` + `handleSettleCloseFailure()`
- [ ] **2.7** 重构 `OptimisticBalance` 类型 + `getOptimisticBalance()` 函数
- [ ] **2.8** 改造 `deductOrderAmount()` — 内存软锁定 + 队列 deposit
- [ ] **2.9** 改造 `settleOrderMargin()` — 适配乐观余额模型
- [ ] **2.10** 改造 `closePositionByMatch()` — 内存释放 + 队列 settleClose
- [ ] **2.11** 改造 `addMarginToPosition()` — 内存软锁定 + 队列 deposit
- [ ] **2.12** 新增 `reduceMarginFromPosition()` — 队列 withdrawMargin
- [ ] **2.13** 重构 `syncUserBalanceFromChain()` — 读派生钱包 BNB + PerpVault.traderMargin
- [ ] **2.14** 更新 WS balance 推送消息格式
- [ ] **2.15** 更新 `/api/user/:trader/balance` HTTP 响应格式
- [ ] **2.16** 引擎启动时: 从链上恢复 traderMargin 状态
- [ ] **2.17** 处理 nonce 并发: 每个派生钱包独立 nonce 跟踪
- [ ] **2.18** 整合 marginBatch 到 server.ts 启动/关闭生命周期

### Phase 3: 前端

- [ ] **3.1** `AccountBalance.tsx`: 简化 `handleDeposit()` 为单步 (Main → 派生钱包 BNB 转账)
- [ ] **3.2** `AccountBalance.tsx`: 简化 `handleWithdraw()` 为 `sendETH(mainWallet, amount)`
- [ ] **3.3** `AccountBalance.tsx`: 更新余额显示 (可用 = 派生钱包BNB, 锁定 = PerpVault.traderMargin)
- [ ] **3.4** `WalletBalanceContext.tsx`: 重构 — 删 settlementBalance, 删 wethBalance, 加 lockedMargin
- [ ] **3.5** `wallet/page.tsx`: 更新余额卡片和充值/提现表单
- [ ] **3.6** `deposit/page.tsx`: 简化为单步充值
- [ ] **3.7** `account/page.tsx`: 更新资产总览计算
- [ ] **3.8** `usePerpetualV2.ts`: 删除 SettlementV2 deposit/withdraw 函数
- [ ] **3.9** `usePerpetualV2.ts`: 新增读取 PerpVault.traderMargin 逻辑
- [ ] **3.10** `useTradingWallet.ts`: 删除 wrapAndDeposit, depositBNBToSettlement, depositExistingWBNB
- [ ] **3.11** 更新 WS balance 消息处理 (tradingDataStore.ts)
- [ ] **3.12** 更新 i18n 翻译 (zh/en/ja/ko — 充值/提现文案变化)

### Phase 4: 清理

- [ ] **4.1** 删除 `modules/relay.ts`
- [ ] **4.2** 删除 `modules/withdraw.ts`
- [ ] **4.3** 删除 `modules/snapshot.ts`
- [ ] **4.4** server.ts: 删除 SettlementV2 event listener
- [ ] **4.5** server.ts: 清理 `/api/wallet/withdraw` Merkle 逻辑
- [ ] **4.6** server.ts: 简化 mode2Adj (仅保留崩溃恢复)
- [ ] **4.7** 前端: 删除 SETTLEMENT_V2_ABI 引用
- [ ] **4.8** 配置: 更新 .env 文件去掉 SettlementV2 相关
- [ ] **4.9** 更新 CLAUDE.md 合约地址和架构描述
- [ ] **4.10** 更新 DEVELOPMENT_RULES.md

### Phase 5: 测试

见下方测试清单。

---

## 五、测试清单 (Test Checklist)

### 合约单元测试 (Foundry)

- [ ] **T-C01** depositMargin: 派生钱包存入 0.1 BNB → traderMargin 增加 0.1
- [ ] **T-C02** depositMargin: 存入 0 BNB → revert InvalidAmount
- [ ] **T-C03** withdrawMargin: 引擎调 withdraw 0.05 → trader 收到 0.05 BNB
- [ ] **T-C04** withdrawMargin: withdraw > traderMargin → revert
- [ ] **T-C05** withdrawMargin: 非授权地址调用 → revert Unauthorized
- [ ] **T-C06** settleClose 盈利: margin=0.1, pnl=+0.02 → trader 收 0.12, LP 减 0.02
- [ ] **T-C07** settleClose 亏损(部分): margin=0.1, pnl=-0.03 → trader 收 0.07, LP 加 0.03
- [ ] **T-C08** settleClose 亏损(全部): margin=0.1, pnl=-0.15 → trader 收 0, LP 加 0.1
- [ ] **T-C09** settleClose: 盈利但 LP 余额不足 → 部分支付 (ADL)
- [ ] **T-C10** batchDepositMargin: 3个trader, msg.value = sum → 各自 traderMargin 正确
- [ ] **T-C11** batchDepositMargin: msg.value != sum(amounts) → revert
- [ ] **T-C12** batchSettleClose: 混合盈亏 → 各自结算正确
- [ ] **T-C13** 重入攻击: settleClose 中回调合约 → nonReentrant 阻止
- [ ] **T-C14** getPoolValue: depositMargin 后 poolValue 不变 (保证金不算LP)
- [ ] **T-C15** depositMargin + settleClose 交替: traderMargin 最终一致

### 撮合引擎集成测试

- [ ] **T-E01** 开仓流程: 下单 → 撮合 → WS 推仓位 → 10s 后链上 traderMargin 增加
- [ ] **T-E02** 平仓盈利: 平仓 → WS 推余额增加 → 10s 后链上 traderMargin 减少 + 派生钱包 BNB 增加
- [ ] **T-E03** 平仓亏损: 平仓 → WS 推余额减少 → 链上 traderMargin 减少 + LP 增加
- [ ] **T-E04** 加保证金: 用户加保证金 → WS 推仓位更新 → 链上 traderMargin 增加
- [ ] **T-E05** 减保证金: 用户减保证金 → WS 推仓位更新 → 链上 traderMargin 减少
- [ ] **T-E06** 批量: 3个用户同时开仓 → 一次 flush 批量上链
- [ ] **T-E07** 余额不足拒绝: 派生钱包 BNB 不够 → 下单被拒
- [ ] **T-E08** 引擎重启恢复: 关引擎 → 重启 → 从链上读 traderMargin → 余额一致
- [ ] **T-E09** 上链失败回滚: 模拟 tx revert → 仓位被强平 + 用户收到 WS 通知
- [ ] **T-E10** nonce 管理: 快速连续 5 笔开仓 → nonce 不冲突
- [ ] **T-E11** globalTxLock: OI flush + margin flush 同时触发 → 不死锁
- [ ] **T-E12** 强平: 价格触发强平 → 链上 traderMargin 清零 + LP 收到残余
- [ ] **T-E13** 余额同步: 30s 同步后 乐观余额 == 链上余额 (无 pending 时)

### 前端 UI 测试

- [ ] **T-F01** 充值: Main Wallet 输入金额 → 一步到派生钱包 → 余额更新
- [ ] **T-F02** 提现: 输入金额 → 派生钱包 BNB 转 Main → 余额更新
- [ ] **T-F03** 余额显示: 可用 = 派生钱包 BNB, 锁定 = PerpVault.traderMargin
- [ ] **T-F04** 开仓后余额: 开仓 → 可用减少, 锁定增加 (乐观即时)
- [ ] **T-F05** 平仓后余额: 平仓 → 可用增加, 锁定减少 (乐观即时)
- [ ] **T-F06** 提现上限: 不能提超过 available (锁定保证金不可提)
- [ ] **T-F07** WS 实时更新: 开仓/平仓 → WS 推送 → UI 更新 < 1秒
- [ ] **T-F08** gas 预留: 充值时自动预留 0.005 BNB gas
- [ ] **T-F09** 错误处理: 链上交易失败 → 用户看到错误提示

### 端到端完整流程测试

- [ ] **T-E2E-01** 完整多空对手盘:
  ```
  User A 充值 1 BNB → 开多 0.5 BNB 10x
  User B 充值 1 BNB → 开空 0.5 BNB 10x
  价格上涨 5% → A 平仓 (盈利) → B 平仓 (亏损)
  验证: A 派生钱包 > 初始, B 派生钱包 < 初始
  验证: PerpVault 保证金余额 == 0 (全部释放)
  ```
- [ ] **T-E2E-02** 强平场景:
  ```
  User 充值 0.5 BNB → 开多 0.3 BNB 20x
  价格下跌触发强平
  验证: 仓位被关闭, traderMargin == 0
  验证: 保证金进入 LP 池
  ```
- [ ] **T-E2E-03** 引擎崩溃恢复:
  ```
  User 开仓 → 引擎崩溃 → 重启
  验证: 仓位从 Redis 恢复
  验证: traderMargin 从链上读取
  验证: 余额 = 链上值 (乐观 pending 丢失后自动修正)
  ```
- [ ] **T-E2E-04** 资金守恒:
  ```
  N 个用户交易 M 轮
  验证: sum(所有派生钱包BNB) + PerpVault.balance == 初始总资金 + LP种子
  ```

---

## 六、风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 链上 tx 失败导致仓位回滚 | 用户体验差 | 失败概率极低(引擎控制钱包); 回滚WS通知 |
| 多派生钱包 nonce 并发 | tx stuck | 每个钱包独立 nonce 管理器 |
| 引擎掉线时保证金在链上 | 无法交易 | 重启自动恢复; 保证金安全(在合约里) |
| PerpVault 合约 bug | 资金损失 | 全面单元测试 + 已审计基础代码 |
| gas 价格波动 | 批量上链成本增加 | BSC gas 极低; 可配置 flush interval |

---

## 七、时间估算

| 阶段 | 预估时间 | 依赖 |
|------|----------|------|
| Phase 1: 合约 | 2 天 | 无 |
| Phase 2: 引擎 | 3 天 | Phase 1 部署完成 |
| Phase 3: 前端 | 2 天 | Phase 2 API 稳定 |
| Phase 4: 清理 | 1 天 | Phase 3 完成 |
| Phase 5: 测试 | 2 天 | 全部完成 |
| **总计** | **10 天** | |

---

## 八、不改的部分 (保持现状)

- `tradingWallet.ts` + `useTradingWallet.ts` — 派生钱包核心逻辑不变
- `wallet.ts` session 管理 — 引擎持有派生钱包密钥不变
- PerpVault LP 机制 (deposit/withdrawal/shares) — 不动
- PerpVault OI 追踪 (increaseOI/decreaseOI) — 不动
- PerpVault 现有 settlement 函数 (settleTraderProfit/Loss) — 保留，新函数可能内部调用
- 订单撮合逻辑 — 不动
- Keeper 强平/资金费 — 不动 (仍然读引擎数据)
- WebSocket 协议框架 — 不动，仅更新 balance 消息格式
