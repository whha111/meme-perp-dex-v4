# Meme Perpetual DEX — 代码审查报告 V2

> **审查日期**: 2026-03-03
> **审查范围**: 全部代码文件，逐行审查
> **项目版本**: 2026-03-01 审计修复后 (commit `f937f21` 之后)
> **排除项**: 测试私钥（测试网用途，无真实资金）
> **前序审计**: `docs/ISSUES_AUDIT_REPORT.md` (2026-03-01, 48 issues)

---

## 统计摘要

| 模块 | CRITICAL | HIGH/Important | MEDIUM | LOW | INFO | 总计 |
|------|----------|----------------|--------|-----|------|------|
| 智能合约 (Solidity) | 3 | 7 | 7 | 2 | 3 | 22 |
| 撮合引擎 (TypeScript) | 3 | 6 | — | — | — | 9 |
| Go 后端 (API + Keeper) | 4 | 8 | — | — | — | 12 |
| 前端 (React/Next.js) | 4 | 10 | — | — | — | 14 |
| 脚本/配置/部署 | 5 | 13 | — | — | — | 18 |
| **总计** | **19** | **44** | **7** | **2** | **3** | **75** |

> 相较 V1 审计的 48 个问题（12C + 15H + 21M），V2 审查发现 75 个新/未修复问题。
> V1 审计中的 35 个已修复问题不重复计入。

---

## 第一部分：智能合约 (Solidity) — 22 个问题

### SC-C01: TokenFactory._sellInternal — CEI 违规（重入风险）

**严重度**: CRITICAL
**文件**: `contracts/src/spot/TokenFactory.sol` L503-519
**描述**: 在 `_sellInternal()` 中，状态更新（`realEthReserve -= ethAmount`）发生在 ETH 外部转账 `payable(msg.sender).transfer(ethOut)` **之后**。虽然 `transfer()` 限制 2300 gas，但这违反了 CEI (Checks-Effects-Interactions) 模式，且对 EIP-2929 后的 gas 重定价存在风险。

```solidity
// ❌ 当前: 先转账后更新状态
payable(msg.sender).transfer(ethOut);
realEthReserve -= ethAmount;   // 状态更新在外部调用之后

// ✅ 应改为: 先更新状态后转账
realEthReserve -= ethAmount;
payable(msg.sender).transfer(ethOut);
```

**影响**: 恶意合约可能在重入窗口内利用旧状态值进行二次卖出。

---

### SC-C02: Liquidation.sol — 破产路径缺少保险基金余额保护

**严重度**: CRITICAL
**文件**: `contracts/src/perpetual/Liquidation.sol` L363-374
**描述**: `liquidateSingleToken()` 的破产路径中，当保证金不足以覆盖仓位亏损时，代码无条件从保险基金扣款，但没有检查保险基金余额是否足够。如果保险基金余额不足，`insuranceFund -= deficit` 会导致 uint256 下溢 revert，阻塞所有后续清算。

**修复建议**: 添加 `if (deficit <= insuranceFund)` 检查，余额不足时触发 ADL（自动减仓）而非 revert。

---

### SC-C03: Vault.settleBankruptcy — 静默 ETH 转账失败

**严重度**: CRITICAL
**文件**: `contracts/src/common/Vault.sol` L462-474
**描述**: `settleBankruptcy()` 使用 `payable(insuranceFundAddress).transfer(amount)`，若接收方是合约且回退函数消耗 > 2300 gas，转账会静默失败但状态已更新，导致资金记录与实际不一致。

**修复建议**: 改用 `call{value: amount}("")` 并检查返回值，或使用 ReentrancyGuard + pull 模式。

---

### SC-H01: TokenFactory._buyInternal — 毕业买入退款 CEI 违规

**严重度**: HIGH
**文件**: `contracts/src/spot/TokenFactory.sol` L427-436
**描述**: 毕业触发时的退款 `payable(msg.sender).transfer(refundAmount)` 在状态更新前执行。

---

### SC-H02: TokenFactory — 毕业后未撤销 AMM 代币授权

**严重度**: HIGH
**文件**: `contracts/src/spot/TokenFactory.sol` L581-624
**描述**: `_graduateToAMM()` 给 AMM 授权 `type(uint256).max` 代币，LP 添加成功后未将授权重置为 0。剩余授权允许 AMM 合约后续转移 TokenFactory 持有的代币。

---

### SC-H03: rollbackGraduation 虚增 realTokenReserve

**严重度**: HIGH
**文件**: `contracts/src/spot/TokenFactory.sol` L729-737
**描述**: `rollbackGraduation()` 将 `realTokenReserve` 重置为毕业前值，但未回收已经转移到 AMM LP 的代币。这导致 `realTokenReserve` 与合约实际代币余额不一致。

---

### SC-H04: PerpVault — Push 模式利润分配阻塞批量结算

**严重度**: HIGH
**文件**: `contracts/src/perpetual/PerpVault.sol` L467-491
**描述**: `settleTraderPnL()` 在 `hasProfit=true` 时通过 `vault.withdraw(amount)` 直接将 ETH push 给交易者。如果交易者地址是合约且 `receive()` revert，整个批量结算交易失败，阻塞所有后续结算。

**修复建议**: 改用 pull 模式 — 记录可提取金额，让交易者自行 claim。

---

### SC-H05: Liquidation — 保险基金 receive() + 显式增量导致双重计数

**严重度**: HIGH
**文件**: `contracts/src/perpetual/Liquidation.sol` L177-195
**描述**: `liquidate()` 同时通过两种途径增加保险基金：
1. 通过 `payable(address(this)).transfer(insuranceAmount)` 触发 `receive()` 事件
2. 显式 `insuranceFund += insuranceAmount`

如果 `receive()` 内也有 `insuranceFund +=` 逻辑，金额被计入两次。

---

### SC-H06: Vault.claimPendingProfit — 部分支付清零未付余额

**严重度**: HIGH
**文件**: `contracts/src/common/Vault.sol` L282-293
**描述**: 当合约余额不足以支付全部 `pendingProfit` 时，`claimPendingProfit` 仅转出 `address(this).balance`，但将 `pendingProfit` 完全清零。差额永久丢失。

---

### SC-H07: PerpVault — Dead Shares 防御经济无效

**严重度**: HIGH
**文件**: `contracts/src/perpetual/PerpVault.sol` L293-302
**描述**: 首次存款时铸造 `DEAD_SHARES = 1000` 个不可赎回份额防止通胀攻击。但 1000 shares 对应的锁定价值极小（~0.000000000000001 ETH），不足以防御 ERC4626 通胀攻击。攻击者仍可通过先存 1 wei、捐赠大额再存款来稀释后续存款者的份额。

---

### SC-M01: SettlementV2 — updateStateRoot 无零值保护

**严重度**: MEDIUM
**文件**: `contracts/src/perpetual/SettlementV2.sol` L278-295
**描述**: `updateStateRoot()` 允许将 Merkle 根设置为 `bytes32(0)`，这会使所有提款的 `MerkleProof.verify()` 失败（因为没有有效路径到零根），导致所有用户资金被永久锁定。

---

### SC-M02: PerpVault — 无最大杠杆限制

**严重度**: MEDIUM
**文件**: `contracts/src/perpetual/PerpVault.sol`
**描述**: `increaseOI()` 不验证调用方请求的杠杆倍数。撮合引擎可传入任意杠杆，绕过合约层风控。

### SC-M03: PositionManager — 无效的 isLiquidatable 计算

**严重度**: MEDIUM
**文件**: `contracts/src/perpetual/PositionManager.sol`
**描述**: `isLiquidatable()` 使用的保证金计算与引擎不一致（合约使用固定 MMR，引擎使用动态 MMR）。由于引擎实际不调用此合约进行清算检查，影响有限。

### SC-M04: AMM — 无滑点保护的 LP 添加

**严重度**: MEDIUM
**文件**: `contracts/src/spot/AMM.sol`
**描述**: LP 添加时无最小份额检查，首个 LP 提供者可设置极端汇率。

### SC-M05: TokenFactory — 无限代币创建无速率限制

**严重度**: MEDIUM
**文件**: `contracts/src/spot/TokenFactory.sol`
**描述**: `createToken()` 无频率限制，攻击者可批量创建代币耗尽 gas block。

### SC-M06: FundingRate.sol — 硬编码 15 分钟间隔

**严重度**: MEDIUM
**文件**: `contracts/src/perpetual/FundingRate.sol`
**描述**: 资金费结算间隔硬编码 `FUNDING_INTERVAL = 15 minutes`，无 governance 接口调整。在极端行情下无法加速结算。

### SC-M07: RiskManager — owner 可单方面修改所有风控参数

**严重度**: MEDIUM
**文件**: `contracts/src/perpetual/RiskManager.sol`
**描述**: 所有 setter 函数仅需 `onlyOwner`，无 timelock 或多签。owner 可瞬间将维持保证金率设为 100% 触发全场清算。

### SC-L01: Router.sol — 部分弃用函数

**严重度**: LOW
**文件**: `contracts/src/spot/Router.sol`
**描述**: `swapExactTokensForETH` 仍然公开可调用，但前端已不使用。

### SC-L02: ContractRegistry — 注册无验证

**严重度**: LOW
**文件**: `contracts/src/common/ContractRegistry.sol`
**描述**: `registerContract()` 不验证地址是否为合约（可注册 EOA 地址）。

### SC-I01: 多处使用 transfer() 而非 call()

**严重度**: INFO
**描述**: Solidity 社区推荐使用 `call{value:}("")` 代替 `transfer()`。

### SC-I02: 缺少 NatSpec 文档

**严重度**: INFO
**描述**: 核心合约函数缺少 @param/@return/@notice 注释。

### SC-I03: 测试覆盖率不足

**严重度**: INFO
**描述**: Foundry 测试文件缺失或覆盖率 < 50%。

---

## 第二部分：撮合引擎 (TypeScript) — 9 个问题

### ME-C01: broadcastBalanceUpdate 泄露所有用户余额

**严重度**: CRITICAL
**文件**: `backend/src/matching/server.ts` L5802-5824
**描述**: `broadcastBalanceUpdate()` 从 `balances` Map 获取 **所有** 用户的余额数据，然后通过 WebSocket 广播给 **所有** 连接的客户端。任何连接 WS 的用户都能看到其他用户的完整财务信息。

```typescript
// ❌ 当前: 广播全部用户余额
const allBalances = Object.fromEntries(this.balances);
this.wss.clients.forEach(ws => ws.send(JSON.stringify(allBalances)));

// ✅ 应改为: 每个用户只收到自己的余额
for (const [trader, ws] of this.authenticatedClients) {
  ws.send(JSON.stringify({ type: "balance", data: this.balances.get(trader) }));
}
```

**影响**: 隐私泄露 + 竞争对手可监控大户仓位变动。

---

### ME-C02: 提款截止时间比较混淆秒/毫秒

**严重度**: CRITICAL
**文件**: `backend/src/matching/modules/withdraw.ts` L266, L358
**描述**: 提款请求的 `deadline` 字段以 **秒** 为单位（Unix timestamp），但代码使用 `request.deadline < Date.now()` 比较，`Date.now()` 返回 **毫秒**。由于毫秒值始终远大于秒值，此条件永远为 true，导致 **所有提款请求在提交后立即被判定为过期**。

```typescript
// ❌ 当前: 秒 vs 毫秒比较
if (request.deadline < Date.now()) {
  return { error: "Withdrawal deadline expired" };
}

// ✅ 应改为:
if (request.deadline * 1000 < Date.now()) {
  return { error: "Withdrawal deadline expired" };
}
// 或:
if (request.deadline < Math.floor(Date.now() / 1000)) {
```

**影响**: Merkle proof 提款功能完全不可用。

---

### ME-C03: calculateLiquidationPrice 参数顺序错误

**严重度**: CRITICAL
**文件**: `backend/src/matching/server.ts` L6035, L6135 + `utils/precision.ts` L132-150
**描述**: 在加仓路径中，`calculateLiquidationPrice(entryPrice, leverage, isLong, mmr)` 被调用时 `isLong` 和 `mmr` 参数位置互换。且加仓路径缺少 `mmr` 参数（传入 `undefined`），导致 `BigInt(undefined)` 抛出 TypeError。

**影响**: 加仓后清算价格计算错误或引擎崩溃。

---

### ME-H01: pendingWithdrawals Map 无限增长

**严重度**: HIGH
**文件**: `backend/src/matching/modules/withdraw.ts` ~L94, L307
**描述**: `pendingWithdrawals: Map<string, WithdrawalRequest>` 只有添加逻辑，没有过期清理机制。已完成或过期的提款请求永远不从 Map 中移除。长时间运行后将导致内存耗尽。

**修复建议**: 在 `processWithdrawal()` 完成后 `delete` 对应条目，或定期清理超过 TTL 的条目。

---

### ME-H02: ADL 链上同步无 globalTxLock — nonce 冲突

**严重度**: HIGH
**文件**: `backend/src/matching/server.ts` L1338-1376
**描述**: ADL (自动减仓) 触发后的链上 PerpVault 调用使用 `fire-and-forget` 模式（`.catch()` 静默吞错），且不经过 `globalTxLock`。如果同时有 batch settlement 也在发交易，两个并发交易可能使用相同 nonce，导致其中一个被拒绝。

---

### ME-H03: position.ts — 僵尸模块带活跃副作用

**严重度**: HIGH
**文件**: `backend/src/matching/modules/position.ts` L1-430
**描述**: `createPositionFromMatch()` 从未被导入或调用（死代码），但模块内部引用了 PerpVault 和 Redis 客户端。如果未来误导入此模块，会导致 OI 被重复追踪（server.ts 已经处理 OI）。

---

### ME-H04: 批量结算失败项静默丢弃

**严重度**: HIGH
**文件**: `backend/src/matching/modules/perpVault.ts` ~L786-796
**描述**: `executeBatchSettlement()` 在链上交易失败时，将失败的 settlement 项从队列中移除而不是重新入队。亏损/手续费/清算收入一旦上链失败就永久丢失。

**修复建议**: 失败项应重新入队（带最大重试次数限制），而非丢弃。

---

### ME-H05: MAX_TRADES_PER_USER 常量定义但未执行

**严重度**: HIGH
**文件**: `backend/src/matching/server.ts` ~L680
**描述**: `MAX_TRADES_PER_USER = 500` 被定义但没有在任何交易路径中检查。单个用户可无限制下单，构成 DoS 向量。

---

### ME-H06: Merkle 快照不包含仓位数据

**严重度**: HIGH
**文件**: `backend/src/matching/modules/snapshot.ts`
**描述**: Merkle 快照仅覆盖余额（`userEquity`），不包含仓位详情。如果引擎崩溃，用户只能提取余额，未实现盈利的仓位价值无法恢复。

---

## 第三部分：Go 后端 (API + Keeper) — 12 个问题

### GO-C01: Auth nonce 内存存储 — 重启丢失 + TOCTOU 竞争

**严重度**: CRITICAL
**文件**: `backend/internal/api/handler/auth.go` L67-224
**描述**:
1. nonce 存储在内存 `map[string]nonceEntry` 中，服务重启后所有 nonce 丢失，之前已签名的 nonce 可被重放
2. nonce 验证和删除之间存在时间窗口（TOCTOU），并发请求可能使用同一 nonce 通过验证

```go
// ❌ 当前: 内存 Map, 无并发保护的读删间隔
entry, exists := h.nonceStore[address]  // 读
if !exists { return error }
delete(h.nonceStore, address)            // 删
// 两行之间的并发请求可读到相同 entry
```

---

### GO-C02: APISecret 明文返回

**严重度**: CRITICAL
**文件**: `backend/internal/api/handler/auth.go` L290
**描述**: 每次登录响应都包含完整的 `APISecret` 明文。如果日志记录了响应体或中间人劫持，所有用户的 API 密钥泄露。

---

### GO-C03: currentTimeMillis() 始终返回 0

**严重度**: CRITICAL
**文件**: `backend/internal/repository/trade.go` L81-83
**描述**:
```go
func currentTimeMillis() int64 {
    return model.NewDecimalFromInt(0).Decimal.IntPart() // 永远返回 0！
}
```
此函数用于计算 24h 统计时间窗口。返回 0 意味着"24小时前"实际指向 1970 年，所有统计数据使用全量历史数据而非真正的 24h 窗口。

---

### GO-C04: 清算指标数据竞争

**严重度**: CRITICAL
**文件**: `backend/internal/keeper/liquidation.go` L44-48, L487-561
**描述**: `LiquidationKeeper` 的指标字段（`totalLiquidations`, `totalFailures` 等）在多个 goroutine 中读写，没有 mutex 或 atomic 保护。Go race detector 会报告 data race。

---

### GO-H01: 限速器 Redis 故障时静默禁用

**严重度**: HIGH
**文件**: `backend/internal/api/middleware/ratelimit.go` L54-63
**描述**: 当 Redis 不可用时，`RateLimitMiddleware` 返回 `c.Next()` 放行所有请求。攻击者可通过 Redis DoS 攻击间接禁用 API 速率限制。

---

### GO-H02: broadcastToSubscribers 死锁风险

**严重度**: HIGH
**文件**: `backend/internal/ws/hub.go` L142-148
**描述**: `broadcastToSubscribers` 向 `client.send` channel 发送消息时使用阻塞写。如果 client 的读 goroutine 已停止（如网络断开），写操作永久阻塞，而此时 hub 锁仍被持有，导致整个 WS hub 死锁。

---

### GO-H03: Token metadata URL 未验证 — 存储型 XSS

**严重度**: HIGH
**文件**: `backend/internal/api/handler/token.go` L108-119
**描述**: `CreateToken` handler 接受用户提交的 `logoUrl` 和 `website` 字段，未验证 URL 格式。攻击者可注入 `javascript:alert(1)` 或恶意 URL，前端渲染时触发 XSS。

---

### GO-H04: 余额冻结和仓位更新非事务性

**严重度**: HIGH
**文件**: `backend/internal/service/account.go` L177-213
**描述**: `FreezeBalance` 和 `UpdatePosition` 是两个独立的数据库操作。如果第一个成功第二个失败，余额被冻结但仓位未创建，导致资金不可逆锁定。

---

### GO-H05: 引擎返回的仓位 UserID=0 — 错误的资金费账单

**严重度**: HIGH
**文件**: `backend/internal/keeper/funding.go` L258-264, L426-438
**描述**: 从撮合引擎 HTTP API 获取的仓位数据缺少 `UserID` 字段（引擎不维护 DB ID），导致所有资金费账单关联到 `user_id=0`。

---

### GO-H06: Health 端点 nil Redis panic

**严重度**: HIGH
**文件**: `backend/internal/api/handler/health.go` L131
**描述**: `checkRedisHealth()` 在 Redis client 为 nil 时直接调用 `h.redis.Ping()`，导致 nil pointer dereference panic，整个 API 服务崩溃。

---

### GO-H07: Keeper 字符串比较 big.Int（虽已标记修复，实际部分遗留）

**严重度**: HIGH
**文件**: `backend/internal/keeper/liquidation.go`
**描述**: 部分余额比较路径仍使用字符串格式化后的比较。

---

### GO-H08: SL/TP 订单只更新状态标志

**严重度**: HIGH
**文件**: `backend/internal/keeper/order.go` L123-151
**描述**: `executeAlgoOrder` 仅将订单状态设为 `AlgoStateTriggered`，不提交任何交易。注释: "In production, this would call the smart contract"。止损止盈功能名存实亡。

---

## 第四部分：前端 (React/Next.js) — 14 个问题

### FE-C01: 存款 MAX 按钮无 gas 预留

**严重度**: CRITICAL
**文件**: `frontend/src/components/common/AccountBalance.tsx` L326
**描述**: "MAX" 按钮将钱包全部 ETH 余额设为存款金额。存款交易需要消耗 gas（wrap ETH + approve + deposit ≈ 0.003-0.01 ETH），如果用户存入全部余额，交易因 gas 不足而失败，但 UI 显示已存入。

```typescript
// ❌ 当前:
onClick={() => setDepositAmount(formatEther(walletBalance))}

// ✅ 应改为:
const gasReserve = parseEther("0.005"); // 预留 gas
const maxDeposit = walletBalance > gasReserve ? walletBalance - gasReserve : 0n;
onClick={() => setDepositAmount(formatEther(maxDeposit))}
```

---

### FE-C02: 订单金额精度丢失

**严重度**: CRITICAL
**文件**: `frontend/src/components/perpetual/PerpetualOrderPanelV2.tsx` L304
**描述**:
```typescript
const positionValueETH = parseFloat(formatEther(margin)) * leverage;
const sizeStr = positionValueETH.toFixed(18);
const size = parseEther(sizeStr);
```
`parseFloat` 精度为 ~15-17 位有效数字，`toFixed(18)` 可能产生误差。对于大金额（如 100 ETH × 10x = 1000 ETH），最后几位小数可能不准确。

**修复建议**: 全程使用 BigInt 运算: `size = margin * BigInt(leverage)`。

---

### FE-C03: Merkle proof 数组类型不匹配

**严重度**: CRITICAL
**文件**: `frontend/src/hooks/perpetual/usePerpetualV2.ts` L750-761
**描述**: 从引擎 API 获取的 Merkle proof 为 `string[]`，直接传给合约的 `bytes32[]` 参数。如果字符串不是有效的 32 字节 hex（如缺少 `0x` 前缀或长度错误），合约调用会 revert。

---

### FE-C04: calculateLiquidationPrice 整数杠杆截断

**严重度**: CRITICAL
**文件**: `frontend/src/hooks/perpetual/useRiskControl.ts` L105-114
**描述**: `BigInt(leverage)` 对非整数值（如 `2.5`）抛出 `TypeError`。杠杆值在 1e4 精度下（如 `25000` 代表 2.5x），需要先乘以精度因子再转换。

---

### FE-H01: 仓位数据处理类型检查顺序错误

**严重度**: HIGH
**文件**: `frontend/src/hooks/common/useUnifiedWebSocket.ts` L247-260
**描述**: WebSocket 消息处理中，对仓位数据的 `Array.isArray()` 检查在对象检查之后。由于 JavaScript 中 `typeof [] === 'object'`，数组总是匹配对象分支而非数组分支，导致批量仓位更新被当作单个对象处理。

---

### FE-H02: useCreateMemeToken — render 期间调用 setState

**严重度**: HIGH
**文件**: `frontend/src/hooks/spot/useCreateMemeToken.ts` L182-188
**描述**: 在 hook 的主体（非 useEffect 内）直接调用 `setState`，违反 React 19 的并发模式规则。可能导致无限渲染循环。

---

### FE-H03: Legacy WebSocket client 仍被导出

**严重度**: HIGH
**文件**: `frontend/src/lib/websocket/client.ts` L434-444
**描述**: `WebSocketClient` 类仍然从模块导出。如果被误导入使用，会与 `useUnifiedWebSocket` 的 `WebSocketManager` 创建重复连接，导致消息重复处理和状态不一致。

---

### FE-H04: wrapAndDeposit 命名歧义 — 可能双重存款

**严重度**: HIGH
**文件**: `frontend/src/components/common/AccountBalance.tsx` L118-124
**描述**: `wrapAndDeposit` 函数同时执行 wrap ETH 和 deposit 操作。如果 wrap 成功但 deposit 失败后用户重试，可能再次执行 wrap，导致双倍 WETH 但只存入一份。

---

### FE-H05: 订单面板无重复提交保护

**严重度**: HIGH
**文件**: `frontend/src/components/perpetual/PerpetualOrderPanelV2.tsx`
**描述**: 提交按钮在交易处理期间未禁用。快速双击可能提交两个相同的订单。

---

### FE-H06: 价格输入无合理范围验证

**严重度**: HIGH
**文件**: `frontend/src/components/perpetual/PerpetualOrderPanelV2.tsx`
**描述**: 限价单价格输入允许任意值（如 0 或 `1e30`）。极端价格可能导致计算溢出或创建无意义的挂单。

---

### FE-H07: K 线图时区处理不一致

**严重度**: HIGH
**文件**: `frontend/src/components/common/TradingViewChart.tsx`
**描述**: K 线数据时间戳在不同路径中使用混合的 UTC 和本地时区，可能导致开盘/收盘时间偏移。

---

### FE-H08: useRiskControl 返回空 insuranceFund

**严重度**: HIGH
**文件**: `frontend/src/hooks/perpetual/useRiskControl.ts` L197-200
**描述**: `insuranceFund` 始终返回 `null`，前端保险基金显示为空。虽然后端已改用 PerpVault `getPoolValue()`，但前端未连接此数据源。

---

### FE-H09: 订单历史无分页

**严重度**: HIGH
**文件**: `frontend/src/hooks/perpetual/usePerpetualV2.ts`
**描述**: 订单历史一次性加载所有数据。对于高频交易用户，大量数据会导致性能下降。

---

### FE-H10: 多语言硬编码中文字符串

**严重度**: HIGH
**文件**: 多个组件文件
**描述**: 部分错误消息和 UI 文本直接使用中文硬编码（如 `"功能待实现"`），未通过 `next-intl` 国际化。

---

## 第五部分：脚本/配置/部署 — 18 个问题

### CF-C01: TokenFactory 地址 — 5 个文件存在旧地址

**严重度**: CRITICAL (已修复 ✅)
**文件**: `docker-compose.yml` L52,120 / `backend/.env` L8 / `config.ts` L23 / `config.yaml`
**描述**: TokenFactory 旧地址 `0xd05A38E6...` 在 5 个配置文件中存在，与 `base-sepolia.json` 中的新地址 `0x757eF02C...` 不一致。
**修复**: 已在本次审查中统一更新为 `0x757eF02C2233b8cE2161EE65Fb7D626776b8CB73`。

---

### CF-C02: PriceFeed 地址 — 4 个文件存在旧地址

**严重度**: CRITICAL (已修复 ✅)
**文件**: `docker-compose.yml` L53,124 / `config.yaml` L38 / `config.ts` L24
**描述**: PriceFeed 旧地址 `0x8A57904F...` 在 4 个文件中存在。
**修复**: 已统一更新为 `0xfB347BC4Cc61C7FdCD862ED212A0e3866d205112`。

---

### CF-C03: Liquidation 地址 — 4 个文件存在旧地址

**严重度**: CRITICAL (已修复 ✅)
**文件**: `docker-compose.yml` L61 / `config.yaml` L35 / `config.ts` L28 / `backend/.env`
**描述**: Liquidation 旧地址 `0x53a5A82C...` 在 4 个文件中存在。
**修复**: 已统一更新为 `0x6Fb6325094B24AE5f458f7a34C63BE30Da9aAECA`。

---

### CF-C04: Keeper 缺少 LIQUIDATION_ADDRESS 环境变量

**严重度**: CRITICAL (已修复 ✅)
**文件**: `docker-compose.yml` L152-168 / `docker-compose.production.yml`
**描述**: Keeper 服务的环境变量中完全没有 `LIQUIDATION_ADDRESS`。
**修复**: `docker-compose.production.yml` 已添加 `MEMEPERP_BLOCKCHAIN_LIQUIDATION_ADDRESS`。

---

### CF-C05: Production compose 缺少 matching-engine 服务

**严重度**: CRITICAL (已修复 ✅)
**文件**: `docker-compose.production.yml`
**描述**: 生产部署配置完全没有定义 matching-engine 服务。引擎无法在生产环境部署。
**修复**: 已添加完整的 matching-engine 服务定义。

---

### CF-H01: Production compose 默认 chain ID 是主网 (8453)

**严重度**: HIGH (已修复 ✅)
**文件**: `docker-compose.production.yml` L120, L150
**描述**: `CHAIN_ID:-8453` 默认为 Base 主网而非 Base Sepolia 测试网 (84532)。如果忘记设置环境变量，keeper 和前端会连接到主网。
**修复**: 已改为 `84532`。

---

### CF-H02: Pinata JWT API key 提交到仓库

**严重度**: HIGH
**文件**: `frontend/.env.local` L55
**描述**: 真实的 Pinata JWT API key 被提交到代码仓库中。

---

### CF-H03: 做市商代币持仓估算错误

**严重度**: HIGH
**文件**: `scripts/market-maker-all.ts` L214
**描述**: 代币持仓估算公式的量级错误，导致做市商在低余额时仍尝试大额卖单。

---

### CF-H04: Perp 做市商 nonce 冲突

**严重度**: HIGH
**文件**: `scripts/market-maker-all.ts` L493-509
**描述**: 当 `perpWs.length=3` 时，3 个钱包可能在同一轮内同时下单。如果它们共享同一个 nonce 计数器，后两个交易会因 nonce 冲突失败。

---

### CF-H05: docker-compose Redis 端口映射到宿主机

**严重度**: HIGH
**文件**: `docker-compose.yml` L29
**描述**: `"16379:6379"` 将 Redis 映射到宿主机端口。虽然需要密码，但暴露了攻击面。

---

### CF-H06: 无 .env.example 模板

**严重度**: HIGH
**描述**: 项目没有标准的 `.env.example` 文件，新开发者需要猜测所需环境变量。

---

### CF-H07: Nginx 配置文件缺失

**严重度**: HIGH
**文件**: `docker-compose.production.yml` L174
**描述**: 生产 compose 引用 `./nginx/nginx.conf`，但该文件不存在于仓库中。

---

### CF-H08: Backend Dockerfile 缺少多阶段构建

**严重度**: HIGH
**文件**: `backend/Dockerfile`
**描述**: 生产镜像包含构建工具链（Go compiler），增加镜像体积和攻击面。

---

### CF-H09: 无数据库迁移版本管理

**严重度**: HIGH
**描述**: SQL 迁移文件在 `migrations/` 目录中但无版本控制工具（如 golang-migrate）。手动管理迁移在多人协作中容易冲突。

---

### CF-H10: 做市商脚本无优雅退出

**严重度**: HIGH
**文件**: `scripts/market-maker-all.ts`
**描述**: 缺少 SIGINT/SIGTERM handler。强制退出可能留下未关闭的 WS 连接和未完成的交易。

---

### CF-H11: 压力测试 wallets 硬编码路径

**严重度**: HIGH
**文件**: `stress-test/` 目录
**描述**: 钱包文件路径硬编码为开发机绝对路径，CI/CD 环境无法运行。

---

### CF-H12: 缺少 CI/CD 管道定义

**严重度**: HIGH
**描述**: 无 GitHub Actions / GitLab CI 配置。构建、测试、部署全靠手动。

---

### CF-H13: 日志无结构化追踪 ID

**严重度**: HIGH
**描述**: 所有服务的日志缺少请求追踪 ID（trace-id）。在多服务架构中无法关联同一请求在不同服务间的日志。

---

## 第六部分：与 V1 审计的交叉对照

### V1 审计 (2026-03-01) 仍遗留的问题

| V1 Bug ID | 描述 | V1 状态 | V2 确认 |
|-----------|------|---------|---------|
| C-03 | PnL 仍以 mode2Adj 为主路径 | ⚠️ 部分修复 | 确认遗留 — PerpVault 为异步同步层 |
| C-06 | Redis 单点故障 | ⚠️ 部分修复 | 确认遗留 — 余额/仓位仍 Redis-only |
| C-07 | 撮合无链上结算 | ⚠️ 部分修复 | 确认遗留 — batch submission 仍禁用 |
| C-12 | PostgreSQL 仅镜像订单 | ⚠️ 部分修复 | 确认遗留 — 余额/仓位/交易无同步 |
| M-03 | 两套 WS 系统共存 | ℹ️ 已文档化 | V2 新发现: legacy client 仍导出 (FE-H03) |
| M-12 | Auth nonce 内存存储 | ℹ️ 已文档化 | V2 升级为 CRITICAL (GO-C01) — 新增 TOCTOU |

### V1 审计已修复的问题 — V2 确认有效

| V1 Bug ID | 描述 | 确认 |
|-----------|------|------|
| C-01 | 假充值 API | ✅ ALLOW_FAKE_DEPOSIT 守卫有效 |
| C-04 | 保险基金纯内存 | ✅ PerpVault getPoolValue() 有效 |
| C-08/C-09 | 前端存取款绕链上 | ✅ 3 步链上流程已实现 |
| C-10/C-11 | Keeper 无数据源 | ✅ matchingEngineURL 传入有效 |
| H-01 | 保险基金不持久化 | ✅ 改用 PerpVault |
| H-11 | Redis 无 AOF | ✅ --appendonly yes 已添加 |
| H-14 | Internal API 无鉴权 | ✅ INTERNAL_API_KEY 有效 |

---

## 第七部分：修复优先级建议

### P0 — 上线前必修 (安全影响)

| # | Bug ID | 描述 | 修复难度 |
|---|--------|------|---------|
| 1 | ME-C01 | WS 泄露所有用户余额 | 0.5天 |
| 2 | ME-C02 | 提款截止时间秒/毫秒混淆 | 0.1天 |
| 3 | ME-C03 | 清算价格参数顺序错误 | 0.5天 |
| 4 | SC-C01 | TokenFactory CEI 违规 | 0.5天 + 重部署 |
| 5 | SC-C02 | 清算破产路径无保护 | 0.5天 + 重部署 |
| 6 | GO-C01 | Auth nonce 重启丢失 + TOCTOU | 1天 |
| 7 | GO-C02 | APISecret 明文返回 | 0.5天 |
| 8 | GO-C03 | currentTimeMillis 返回 0 | 0.1天 |

### P1 — 核心功能修复

| # | Bug ID | 描述 | 修复难度 |
|---|--------|------|---------|
| 9 | FE-C01 | MAX 按钮无 gas 预留 | 0.1天 |
| 10 | FE-C02 | 订单精度丢失 | 0.5天 |
| 11 | FE-C03 | Merkle proof 类型不匹配 | 0.5天 |
| 12 | ME-H01 | pendingWithdrawals 内存泄漏 | 0.5天 |
| 13 | ME-H04 | 批量结算失败项丢弃 | 0.5天 |
| 14 | SC-H04 | Push 模式利润分配阻塞 | 1天 + 重部署 |
| 15 | GO-C04 | 清算指标数据竞争 | 0.5天 |

### P2 — 稳定性和质量

| # | Bug ID | 描述 | 修复难度 |
|---|--------|------|---------|
| 16 | SC-H05 | 保险基金双重计数 | 审计确认 |
| 17 | ME-H02 | ADL nonce 冲突 | 0.5天 |
| 18 | GO-H01 | 限速器 Redis 故障放行 | 0.5天 |
| 19 | GO-H02 | WS hub 死锁风险 | 0.5天 |
| 20 | FE-H02 | render 期间 setState | 0.5天 |
| 21-75 | 其余 | 中低优先级 | 各 0.1-1天 |

---

## 第八部分：地址配置统一状态

> 本次审查已修复所有陈旧合约地址。以下为当前统一地址:

| 合约 | 规范地址 | 来源 |
|------|---------|------|
| TokenFactory | `0x757eF02C2233b8cE2161EE65Fb7D626776b8CB73` | base-sepolia.json |
| PriceFeed | `0xfB347BC4Cc61C7FdCD862ED212A0e3866d205112` | base-sepolia.json |
| Liquidation | `0x6Fb6325094B24AE5f458f7a34C63BE30Da9aAECA` | base-sepolia.json |
| SettlementV2 | `0x733EccCf612F70621c772D63334Cf5606d7a7C75` | base-sepolia.json |
| PerpVault | `0x586FB78b8dB39d8D89C1Fd2Aa0c756C828e5251F` | base-sepolia.json |
| Vault | `0xcc4Fa8Df0686824F92d392Cb650057EA7D2EF46E` | base-sepolia.json |
| PositionManager | `0x7611a924622B5f6bc4c2ECAAdB6DE078E741AcF6` | base-sepolia.json |
| InsuranceFund | `0x93F63c2EEc4bF77FF301Cd14Ef4A392E58e33C69` | base-sepolia.json |
| Settlement V1 | `0x1660b3571fB04f16F70aea40ac0E908607061DBE` | base-sepolia.json |
| AMM | `0x2c23046DC1595754528a10b8340F2AD8fdE05112` | base-sepolia.json |
| Router | `0xF15197BA411b578dafC7936C241bE9DD725c22BE` | base-sepolia.json |
| FundingRate | `0xD6DD3947F8d80A031b69eBd825Be2384E787dC46` | base-sepolia.json |
| LendingPool | `0x98a7665301C0dB32ceff957e1A2c505dF8384CA4` | base-sepolia.json |
| RiskManager | `0x7fC37B0bD2c8c2646C9087A21e33e2A404AD7A39` | base-sepolia.json |
| ContractRegistry | `0x218A135F119AcAf00141b979cdFEf432f563437F` | base-sepolia.json |
| WETH (Collateral) | `0x4200000000000000000000000000000000000006` | Base 标准 |

### 已修复的配置文件

| 文件 | 修复的地址 | 审查状态 |
|------|-----------|---------|
| `frontend/.env.local` | TokenFactory, PriceFeed, Liquidation | ✅ 已更新 (上次会话) |
| `frontend/src/lib/contracts.ts` | TokenFactory, PriceFeed, Liquidation | ✅ 已更新 (上次会话) |
| `frontend/contracts/deployments/base-sepolia.json` | TokenFactory, PriceFeed, Liquidation | ✅ 已更新 (上次会话) |
| `docker-compose.yml` | TokenFactory, PriceFeed, Liquidation | ✅ 已更新 (本次) |
| `backend/.env` | TokenFactory, PriceFeed, +Liquidation | ✅ 已更新 (本次) |
| `backend/src/matching/config.ts` | TokenFactory, PriceFeed, Liquidation | ✅ 已更新 (本次) |
| `backend/configs/config.yaml` | PriceFeed, Liquidation | ✅ 已更新 (本次) |
| `docker-compose.production.yml` | +matching-engine, chain ID 84532, +MATCHING_ENGINE_URL | ✅ 已更新 (本次) |

---

> **结论**: 本次 V2 代码审查覆盖全部代码文件，发现 75 个问题（19 CRITICAL + 44 HIGH + 7 MEDIUM + 5 LOW/INFO）。
> 其中 8 个配置类 CRITICAL 问题已在审查过程中直接修复。
> 建议优先处理 P0 安全类问题（8 个），预计工作量 3-4 天。
