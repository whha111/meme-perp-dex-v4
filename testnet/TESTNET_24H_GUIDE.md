# MEME Perp DEX - 24 小时测试网测试指南

## 概述

本指南覆盖完整的 24 小时 Base Sepolia 测试网集成测试，验证所有功能模块的连续运行稳定性。

---

## 前置要求

### 工具安装
```bash
# Foundry (Solidity 工具链: forge, cast, anvil)
curl -L https://foundry.paradigm.xyz | bash && foundryup

# Bun (匹配引擎运行时)
curl -fsSL https://bun.sh/install | bash

# Go 1.22+ (后端服务)
brew install go

# Node.js 18+ & pnpm (前端)
brew install node && npm install -g pnpm

# Docker (PostgreSQL + Redis)
brew install docker
```

### 获取测试网 ETH
1. 访问 https://www.alchemy.com/faucets/base-sepolia
2. 领取 ETH 到 Matcher 钱包: `0xF339fCf70939e04C8Ce79391BB47bB943122949C`
3. 建议至少 0.5 ETH (用于 gas 费 + 测试交易)

---

## 快速启动

### 一键启动所有服务
```bash
cd testnet

# 1. 验证合约部署状态
./verify-contracts.sh

# 2. 启动所有服务 (PostgreSQL, Redis, Matching Engine, Backend, Keeper, Frontend)
./start-all.sh

# 3. 启动交易机器人 (在另一个终端)
./trading-bot.sh

# 4. 启动健康监控 (在另一个终端)
./health-check.sh --loop
```

### 停止所有服务
```bash
./stop-all.sh
```

---

## 服务端口

| 服务 | 端口 | 健康检查 |
|------|------|---------|
| Frontend | 3000 | http://localhost:3000 |
| Matching Engine | 8081 | http://localhost:8081/health |
| Backend API | 8080 | http://localhost:8080/health |
| PostgreSQL | 5432 | `pg_isready -h localhost` |
| Redis | 6379 | `redis-cli ping` |

---

## 功能测试清单

### 1. 代币创建 (TokenFactory / Launchpad)

- [ ] **创建代币**: 访问 Launchpad 页面，填写代币名称、符号、logo
- [ ] **验证 Bonding Curve**: 创建后查看代币价格曲线
- [ ] **查看代币列表**: 所有创建的代币出现在列表中
- [ ] **代币元数据**: 名称、符号、logo 正确显示

**手动验证:**
```bash
# 查看所有代币
cast call 0x583d35e9d407Ea03dE5A2139e792841353CB67b1 "getAllTokens()(address[])" --rpc-url https://base-sepolia-rpc.publicnode.com

# 创建一个测试代币
cast send 0x583d35e9d407Ea03dE5A2139e792841353CB67b1 "createToken(string,string,string)" "TestToken" "TEST" "https://example.com" --rpc-url https://base-sepolia-rpc.publicnode.com --private-key $PRIVATE_KEY
```

### 2. 现货交易 (Spot / Bonding Curve)

- [ ] **买入代币**: 用 ETH 在 bonding curve 上购买代币
- [ ] **卖出代币**: 卖出代币换回 ETH
- [ ] **价格更新**: 买卖后价格实时变化
- [ ] **滑点保护**: 设置 minAmountOut 参数
- [ ] **图表显示**: K线图、成交历史正确渲染

**手动验证:**
```bash
# 买入代币 (0.01 ETH, minTokensOut=0 for testing)
cast send 0x583d35e9d407Ea03dE5A2139e792841353CB67b1 "buy(address,uint256)" <TOKEN_ADDRESS> 0 --value 0.01ether --rpc-url https://base-sepolia-rpc.publicnode.com --private-key $PRIVATE_KEY
```

### 3. 永续合约交易 (Perpetual Futures)

- [ ] **连接钱包**: MetaMask/WalletConnect 连接
- [ ] **生成交易钱包**: EIP-712 签名派生交易钱包
- [ ] **入金**: Settlement 合约 deposit
- [ ] **下限价单**: 设定价格挂单
- [ ] **下市价单**: 即时成交
- [ ] **订单簿显示**: 买卖盘实时更新
- [ ] **成交记录**: 交易历史正确显示
- [ ] **仓位管理**: 查看持仓、杠杆、PnL
- [ ] **平仓**: 全部平仓 / 部分平仓
- [ ] **止盈止损**: 设置 TP/SL 触发价
- [ ] **资金费率**: 每 8 小时结算
- [ ] **强制平仓**: 保证金不足时触发
- [ ] **提现**: 从 Settlement 合约提现

**手动验证:**
```bash
# 检查匹配引擎状态
curl http://localhost:8081/health

# 检查订单簿
curl http://localhost:8081/api/orderbook/<TOKEN_ADDRESS>

# 检查仓位
curl http://localhost:8081/api/user/<TRADER_ADDRESS>/positions

# 检查余额
curl http://localhost:8081/api/user/<TRADER_ADDRESS>/balance
```

### 4. 借贷 (Lending Pool)

- [ ] **查看池列表**: 启用的代币池显示正确
- [ ] **存款**: Approve + Deposit 两步操作
- [ ] **查看利率**: 供应/借款 APY 显示
- [ ] **利用率**: 利用率百分比正确
- [ ] **领取利息**: Claim Interest 操作
- [ ] **提现**: 赎回存款
- [ ] **TVL 统计**: 总锁仓量正确

**手动验证:**
```bash
# 查看启用的代币
cast call 0x7Ddb15B5E680D8a74FE44958d18387Bb3999C633 "getEnabledTokens()(address[])" --rpc-url https://base-sepolia-rpc.publicnode.com

# 查看池信息
cast call 0x7Ddb15B5E680D8a74FE44958d18387Bb3999C633 "getPoolInfo(address)" <TOKEN_ADDRESS> --rpc-url https://base-sepolia-rpc.publicnode.com
```

### 5. 收益页面 (Earnings)

- [ ] **PerpVault 存款**: 存入 ETH 获取 LP shares
- [ ] **收益显示**: APY、总收益正确
- [ ] **提现流程**: 请求提现 → 等待冷却期 → 执行提现
- [ ] **保险基金状态**: 显示正确

### 6. 前端页面 (UI/UX)

- [ ] **首页**: 正常加载，Banner 和统计数据显示
- [ ] **交易页面**: 图表、订单簿、交易面板功能正常
- [ ] **现货页面**: 代币列表、Swap 面板正常
- [ ] **Launchpad**: 创建代币流程完整
- [ ] **借贷页面**: 池列表、操作面板正常
- [ ] **收益页面**: 数据加载、操作正常
- [ ] **响应式**: 移动端布局正确
- [ ] **多语言**: EN/ZH/JA/KO 切换正常
- [ ] **WebSocket**: 实时价格推送正常
- [ ] **钱包断连**: 优雅处理断连/重连

### 7. 安全审计修复验证

| ID | 描述 | 验证方法 |
|----|------|---------|
| C-01 | 资金费率双重收取 | 开仓 → 等 8h → 结算 → 检查费率只扣一次 |
| C-03 | LendingPool 份额膨胀攻击 | 首次存入是否有虚拟偏移保护 |
| C-04 | parseFloat 精度丢失 | 前端数值 > 9007 ETH 正确显示 |
| C-05 | 零滑点保护 | 所有交易必须传入 minAmountOut |
| C-06 | 私钥暴露 | React DevTools 中无私钥 |
| H-08 | closePair 缺签名验证 | 尝试未授权关闭仓位 |
| H-10 | HTTP 明文签名传输 | 生产环境自动升级 HTTPS |
| H-11 | 浮点数滑点计算 | 前端使用 BigInt 计算 |

### 8. 24 小时稳定性检查

- [ ] **服务持续运行**: 所有 6 个服务 24h 无崩溃
- [ ] **内存泄漏**: 内存使用不持续增长
- [ ] **日志无错误**: 无异常错误堆栈
- [ ] **数据库正常**: PostgreSQL 无死锁/慢查询
- [ ] **Redis 正常**: 内存使用在合理范围
- [ ] **RPC 限速**: 无 429 错误
- [ ] **WebSocket 稳定**: 连接不频繁断开
- [ ] **Keeper 正常**: 资金费率按时结算

---

## 日志位置

```
testnet/logs/
├── matching-engine.log    # 匹配引擎日志
├── backend-api.log        # Go 后端 API 日志
├── keeper.log             # Keeper 服务日志
├── frontend.log           # Next.js 前端日志
├── trading-bot.log        # 交易机器人日志
├── health.log             # 健康检查历史
└── go-build.log           # Go 编译日志
```

## 监控命令

```bash
# 实时查看匹配引擎日志
tail -f testnet/logs/matching-engine.log

# 实时查看健康检查
tail -f testnet/logs/health.log

# 查看交易机器人活动
tail -f testnet/logs/trading-bot.log

# 查看所有日志 (合并)
tail -f testnet/logs/*.log

# 检查服务进程
cat testnet/pids/*.pid | xargs ps -p

# Docker 容器状态
docker ps --filter "name=memeperp"

# Redis 内存使用
redis-cli info memory | grep used_memory_human

# PostgreSQL 连接数
psql -h localhost -U postgres -d memeperp -c "SELECT count(*) FROM pg_stat_activity;"
```

## 故障排除

### 匹配引擎启动失败
```bash
# 检查 Redis 连接
redis-cli ping

# 检查端口占用
lsof -i :8081

# 查看详细错误
cat testnet/logs/matching-engine.log | tail -50
```

### Go 后端编译失败
```bash
cd backend
go mod tidy
go build -v ./cmd/api
```

### 前端编译失败
```bash
cd frontend
pnpm install
pnpm build
```

### 合约调用失败
```bash
# 检查 Matcher 钱包余额
cast balance 0xF339fCf70939e04C8Ce79391BB47bB943122949C --rpc-url https://base-sepolia-rpc.publicnode.com --ether

# 检查 RPC 是否可达
cast block-number --rpc-url https://base-sepolia-rpc.publicnode.com
```

---

## 测试完成标准

**24 小时测试通过条件:**

1. ✅ 所有 6 个服务运行 24h 无崩溃
2. ✅ 交易机器人成功完成 > 500 个交易周期
3. ✅ 健康检查连续 24h 全部 PASS
4. ✅ 前端所有页面可正常访问和操作
5. ✅ 永续合约: 下单 → 成交 → 持仓 → 平仓 完整流程
6. ✅ 现货交易: 创建代币 → 买入 → 卖出 完整流程
7. ✅ 借贷: 存款 → 利息产生 → 领取 → 提现 完整流程
8. ✅ 无 Critical/High 级别错误
9. ✅ 内存使用稳定 (无持续增长)
10. ✅ Matcher 钱包 ETH 余额 > 0 (gas 费未耗尽)
