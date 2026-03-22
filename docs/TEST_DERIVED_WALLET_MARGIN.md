# 派生钱包保证金架构 — 端到端测试手册

> 创建日期: 2026-03-21
> 前置条件: PerpVault 合约已部署并授权引擎地址

## 自动测试结果 (已通过)

| 测试集 | 通过 | 失败 | 状态 |
|--------|------|------|------|
| Foundry 合约测试 (全量) | 409 | 0 | PASS |
| PerpVault Margin 测试 | 36 | 0 | PASS |
| 撮合引擎 bun transpile | - | - | PASS |
| 前端 next build (production) | 18 routes | 0 | PASS |

## 部署前检查清单

- [ ] PerpVault 合约重新部署 (含新增 margin 函数)
- [ ] `setAuthorizedContract(engineAddress, true)` — 授权引擎调用 margin 函数
- [ ] `setWETH(WBNB_ADDRESS)` — 设置 WETH fallback
- [ ] 更新 `deployments/97.json` 中 PerpVault 地址 (如果重新部署)
- [ ] 同步更新所有 7 个配置文件
- [ ] 引擎 `.env` 中 `PERP_VAULT_ADDRESS` 更新
- [ ] 前端 `.env.local` 中 `NEXT_PUBLIC_PERP_VAULT_ADDRESS` 更新

## 手动端到端测试

### E2E-01: 充值流程 (1 步)

```
前置: 用户已连接 MetaMask + 激活交易钱包
操作:
  1. 打开账户面板
  2. 输入 0.05 BNB
  3. 点击 "充值 BNB 到交易账户"
  4. MetaMask 确认一笔交易
预期:
  - 只弹出一次 MetaMask 确认 (不是3次)
  - 交易确认后余额立即更新
  - "可用" 显示增加 ~0.05 BNB
  - "保证金锁定" 显示 0
验证: 派生钱包 BNB 余额增加 (BSCscan 查看)
```

### E2E-02: 提现流程 (1 步)

```
前置: 派生钱包有 BNB 余额
操作:
  1. 切换到 "提现" tab
  2. 输入金额
  3. 点击 "提现到主钱包"
预期:
  - 只弹出一次签名
  - 无需 Merkle proof 生成等待
  - 主钱包 BNB 余额增加
  - 派生钱包余额减少
```

### E2E-03: 开仓 — 乐观执行 + 异步保证金锁定

```
前置: 派生钱包有 0.5 BNB
操作:
  1. 选择代币，开多 0.1 BNB 10x
  2. 提交订单
预期 (即时):
  - 订单立即撮合 (< 1秒)
  - WS 推送仓位更新
  - "可用" 减少 (margin + fee)
  - "保证金锁定" 增加
预期 (10秒后):
  - 引擎日志: "MarginBatch DEPOSIT ok: trader=..."
  - PerpVault.traderMargin[trader] > 0 (链上查询)
```

### E2E-04: 平仓盈利 — 异步结算

```
前置: 有一个多头仓位，价格已上涨
操作:
  1. 平仓
预期 (即时):
  - 仓位消失
  - "可用" 增加 (collateral + profit)
  - "保证金锁定" 减少
预期 (10秒后):
  - 引擎日志: "MarginBatch BATCH_SETTLE ok: ..."
  - PerpVault.traderMargin[trader] == 0 (链上)
  - 派生钱包 BNB > 开仓前 (profit 已到账)
```

### E2E-05: 平仓亏损

```
前置: 有一个多头仓位，价格已下跌
操作: 平仓
预期:
  - "可用" 增加 (collateral - loss)
  - PerpVault LP poolValue 增加 (吸收亏损)
  - 派生钱包 BNB < 开仓前
```

### E2E-06: 加保证金

```
前置: 有活跃仓位
操作: 加保证金 0.05 BNB
预期:
  - 仓位 collateral 增加
  - 杠杆降低
  - 强平价格远离当前价
  - 10秒后 traderMargin 链上增加
```

### E2E-07: 多用户并发

```
操作: 3个用户同时开仓
预期:
  - 全部即时撮合成功
  - 10秒后一批链上 deposit (引擎日志显示 batch)
  - 各用户 traderMargin 链上独立正确
```

### E2E-08: 引擎重启恢复

```
操作:
  1. 用户开仓 (仓位存在)
  2. 停止引擎
  3. 重启引擎
预期:
  - 仓位从 Redis 恢复
  - 余额从链上 traderMargin 同步
  - 用户可以正常平仓
```

### E2E-09: 资金守恒

```
操作:
  1. 记录初始状态: sum(所有派生钱包BNB) + PerpVault.balance
  2. 多个用户交易多轮 (开仓/平仓/加保证金)
  3. 全部平仓后
验证:
  - sum(所有派生钱包BNB) + PerpVault.balance == 初始值
  - PerpVault.totalTraderMargin == 0
  - 手续费进入 LP pool (poolValue 增加)
```

### E2E-10: 余额显示一致性

```
操作: 在各页面检查余额
验证:
  - /wallet 页面: 可用 = 派生钱包 BNB, 锁定 = PerpVault.traderMargin
  - /account 页面: 总资产 = 可用 + 锁定
  - /perp 交易面板: 余额与 /wallet 一致
  - WS 推送与页面显示一致
```

## 性能基准

| 指标 | 预期 | 验证方法 |
|------|------|----------|
| 充值确认 | < 5秒 (BSC 出块 ~3秒) | 计时 |
| 提现确认 | < 5秒 | 计时 |
| 开仓响应 | < 100ms (乐观，不等链上) | 引擎日志 |
| 保证金上链 | 10秒内 (batch interval) | 引擎日志 |
| 余额 WS 推送 | < 1秒 | 浏览器 DevTools |

## 已知限制

1. **旧模块 stub**: `modules/relay.ts` 是 stub 文件，动态 import 返回安全默认值。不影响新流程。
2. **SettlementV2 event listener**: 仍在 server.ts 中（V1 listener 保留），但 V2 listener 的 stub 不会触发任何操作。
3. **mode2Adj 并行运行**: 现有 mode2Adj 记账系统仍然运行，作为崩溃恢复备份。不影响新流程。
4. **usePerpetualV2.ts 的 deposit/withdraw**: 前端 AccountBalance 已不调用这些函数，但函数本身未删除（其他页面可能引用）。
