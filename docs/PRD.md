# MEME Perp DEX - 产品需求文档 (PRD)

> 本文档基于项目实际代码编写，反映当前已实现的功能
>
> **⚠️ 2026-03-01 审计**: 永续合约"已实现"功能实际运行在虚拟余额上，无链上资金保障。
> 用户资金安全依赖 Redis 不丢失数据。详见 `docs/ISSUES_AUDIT_REPORT.md`

## 项目概述

### 项目名称
MEME Perp DEX - 去中心化 MEME 币永续合约交易平台

### 项目定位
基于 Bonding Curve (Pump.fun 风格) 的 MEME 代币发行平台 + 永续合约交易系统

### 技术栈
| 层级 | 技术 |
|------|------|
| 智能合约 | Solidity 0.8.24, Foundry |
| 区块链 | Base Sepolia (测试网) |
| 后端 | Go 1.21, Gin, GORM, PostgreSQL, Redis |
| 前端 | Next.js 14, TypeScript, Wagmi, TailwindCSS |

---

## 系统架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              前端 (Next.js)                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │  /perp      │  │  /create    │  │  /trade     │  │  /exchange          │ │
│  │  永续交易    │  │  代币创建    │  │  现货交易    │  │  DEX交换            │ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘ │
│         └────────────────┴────────────────┴─────────────────────┘           │
│                                    │                                         │
│                            ┌───────┴───────┐                                │
│                            │  Wagmi Hooks  │                                │
│                            └───────┬───────┘                                │
└────────────────────────────────────┼────────────────────────────────────────┘
                                     │
          ┌──────────────────────────┼──────────────────────────┐
          │                          │                          │
          ▼                          ▼                          ▼
┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────────┐
│   智能合约 (链上)    │   │   后端 API (Go)      │   │   WebSocket (实时推送)   │
│                     │   │                     │   │                         │
│  • TokenFactory     │   │  • REST API         │   │  • /ws/public           │
│  • PositionManager  │   │  • PostgreSQL       │   │  • /ws/private          │
│  • PriceFeed        │   │  • Redis Cache      │   │                         │
│  • Vault            │   │  • Keeper Services  │   │                         │
│  • Liquidation      │   │                     │   │                         │
│  • FundingRate      │   └─────────────────────┘   └─────────────────────────┘
│  • InsuranceFund    │
│  • Settlement       │
└─────────────────────┘
```

---

## 核心功能模块

### 一、代币创建模块 (Bonding Curve)

#### 1.1 功能描述
Pump.fun 风格的 Bonding Curve 代币发行，用户创建代币后自动初始化流动性池。

#### 1.2 合约实现
**文件**: `contracts/src/core/TokenFactory.sol` (621 行)

```solidity
// 创建代币
function createToken(
    string memory name,
    string memory symbol,
    string memory imageUri
) external returns (address tokenAddress)

// 买入代币 (ETH -> Token)
function buy(address token) external payable returns (uint256 tokensOut)

// 卖出代币 (Token -> ETH)
function sell(address token, uint256 tokenAmount) external returns (uint256 ethOut)

// 获取池状态
function getPoolState(address token) external view returns (
    uint256 virtualEthReserve,
    uint256 virtualTokenReserve,
    uint256 realEthReserve,
    uint256 realTokenReserve,
    bool graduated,
    uint256 createdAt
)
```

#### 1.3 Bonding Curve 参数
| 参数 | 值 |
|------|-----|
| 初始代币供应 | 1,000,000,000 (10亿) |
| 虚拟 ETH 储备 | 1.5 ETH |
| 虚拟代币储备 | 1,073,000,000 |
| 毕业阈值 | realTokenReserve <= 207,000,000 |
| 毕业目标 | 自动迁移到 Uniswap V2 |

#### 1.4 毕业机制
当 Bonding Curve 池中真实代币储备降至 2.07 亿以下时，自动触发毕业：
1. 销毁剩余代币
2. 创建 Uniswap V2 交易对
3. 添加流动性并锁定 LP Token

#### 1.5 永续合约自动开启
当池的真实 ETH 储备达到 0.1 ETH 时，代币自动添加到 PriceFeed，开启永续合约交易。

#### 1.6 事件
```solidity
event TokenCreated(address indexed token, address indexed creator, string name, string symbol);
event TokensPurchased(address indexed buyer, address indexed token, uint256 ethIn, uint256 tokensOut);
event TokensSold(address indexed seller, address indexed token, uint256 tokensIn, uint256 ethOut);
event TokenGraduated(address indexed token, address indexed pair, uint256 liquidity);
```

#### 1.7 前端实现
**页面**: `/create`
**Hook**: `useCreateMemeToken.ts`, `useTokenFactory.ts`

```typescript
// 创建代币
const { createToken, isLoading } = useCreateMemeToken();
await createToken({ name, symbol, imageUri });

// 获取池状态
const { data: poolState } = usePoolState(tokenAddress);
```

---

### 二、永续合约交易模块

#### 2.1 功能描述
币本位永续合约，用户使用 ETH 作为保证金进行多空交易。

#### 2.2 合约实现
**文件**: `contracts/src/core/PositionManager.sol` (1,196 行)

```solidity
// 开多仓
function openLongToken(
    address token,
    uint256 size,
    uint256 leverage
) external

// 开空仓
function openShortToken(
    address token,
    uint256 size,
    uint256 leverage
) external

// 平仓
function closePositionToken(address token) external

// 获取仓位
function getPositionByToken(
    address user,
    address token
) external view returns (
    uint256 size,
    uint256 collateral,
    uint256 averagePrice,
    bool isLong,
    uint256 lastFundingTime,
    uint256 leverage,
    uint256 takeProfit,
    uint256 stopLoss
)

// 计算 PnL (GMX 标准)
function calculatePnL(
    address user,
    address token
) external view returns (int256 pnl, bool hasProfit)

// 计算强平价格 (Bybit 标准)
function getLiquidationPrice(
    address user,
    address token
) external view returns (uint256)
```

#### 2.3 交易参数
| 参数 | 值 |
|------|-----|
| 保证金类型 | ETH |
| 最大杠杆 | 100x |
| 最小杠杆 | 1x |
| 开仓手续费 | 0.1% |
| 平仓手续费 | 0.1% |

#### 2.4 PnL 计算公式 (GMX 标准)
```
delta = size * |currentPrice - avgPrice| / avgPrice
hasProfit = isLong ? (currentPrice > avgPrice) : (avgPrice > currentPrice)
```

#### 2.5 强平价格公式 (Bybit 标准)
```
多头: liqPrice = entryPrice * (1 - 1/leverage + MMR)
空头: liqPrice = entryPrice * (1 + 1/leverage - MMR)
```

#### 2.6 保证金模式
支持全仓和逐仓两种模式：
- **全仓 (Cross)**: 所有可用余额作为仓位保证金
- **逐仓 (Isolated)**: 仅使用指定保证金

#### 2.7 事件
```solidity
event PositionOpened(address indexed user, address indexed token, bool isLong, uint256 size, uint256 collateral, uint256 leverage, uint256 price);
event PositionClosed(address indexed user, address indexed token, bool isLong, uint256 size, int256 pnl, uint256 closePrice);
event PositionLiquidated(address indexed user, address indexed token, address indexed liquidator, uint256 size, uint256 price);
```

#### 2.8 前端实现
**页面**: `/perp`
**组件**: `PerpetualTradingTerminal.tsx`, `PerpetualOrderPanel.tsx`, `PerpTradingPanelV2.tsx`
**Hook**: `usePerpetualV2.ts`

```typescript
// EIP-712 签名下单
const { signAndSubmitOrder } = usePerpetualV2();
await signAndSubmitOrder({
    instId: 'TOKEN-ETH',
    side: 'buy',
    size: '10',
    leverage: 50,
});
```

---

### 三、价格系统模块

#### 3.1 功能描述
多代币价格管理，支持 TWAP 计算和价格偏差保护。

#### 3.2 合约实现
**文件**: `contracts/src/core/PriceFeed.sol` (932 行)

```solidity
// 获取价格
function getPrice(address token) external view returns (uint256)

// 获取 TWAP 价格
function getTWAP(address token, uint256 period) external view returns (uint256)

// 获取标记价格
function getMarkPrice(address token) external view returns (uint256)

// 更新价格 (仅 AMM 可调用)
function updateTokenPrice(address token, uint256 newPrice) external

// 添加支持的代币
function addSupportedToken(address token, uint256 initialPrice) external

// 价格偏差保护
function setDeviationProtection(bool enabled) external
function setMaxPriceDeviation(uint256 deviation) external
```

#### 3.3 标记价格计算
```
markPrice = spotPrice * 70% + twapPrice * 30%
```

#### 3.4 价格偏差保护 (S-001)
| 参数 | 值 |
|------|-----|
| 默认偏差限制 | 10% |
| 最大偏差限制 | 50% |
| 严格模式 | 超过偏差 revert |
| 非严格模式 | 超过偏差使用 TWAP |

#### 3.5 TWAP 配置
| 参数 | 值 |
|------|-----|
| TWAP 周期 | 30 分钟 |
| 观察点数量 | 配置化 |

---

### 四、金库模块

#### 4.1 功能描述
ETH 保证金托管，支持存取款和保证金锁定。

#### 4.2 合约实现
**文件**: `contracts/src/core/Vault.sol` (523 行)

```solidity
// 存款
function deposit() external payable

// 取款
function withdraw(uint256 amount) external

// 获取余额
function getBalance(address user) external view returns (uint256)

// 获取可用余额
function getAvailableBalance(address user) external view returns (uint256)

// 获取锁定保证金
function getLockedMargin(address user) external view returns (uint256)

// 锁定保证金 (仅授权合约)
function lockMargin(address user, uint256 amount) external

// 解锁保证金 (仅授权合约)
function unlockMargin(address user, uint256 amount) external

// 结算盈利 (H-016)
function settleProfit(address user, uint256 collateral, uint256 profit) external

// 结算亏损 (H-015)
function settleLoss(address user, uint256 collateral, uint256 loss) external returns (uint256)

// 结算破产 (H-014)
function settleBankruptcy(address user, uint256 collateral) external returns (uint256)

// 领取待支付盈利
function claimPendingProfit() external
```

#### 4.3 已修复的安全问题
- **H-014**: settleBankruptcy 正确处理穿仓情况
- **H-015**: settleLoss 限制亏损不超过保证金
- **H-016**: settleProfit 支持待领取盈利机制

---

### 五、清算模块

#### 5.1 功能描述
监控仓位健康度，执行强制平仓和 ADL。

#### 5.2 合约实现
**文件**: `contracts/src/core/Liquidation.sol` (808 行)

```solidity
// 检查是否可清算
function canLiquidate(address user, address token) external view returns (bool)

// 执行清算
function liquidate(address user, address token) external

// 批量检查可清算仓位
function getLiquidatablePositions(address token, uint256 limit) external view returns (address[] memory)

// ADL (自动减仓)
function executeADL(address user, address token, uint256 size) external
```

#### 5.3 清算参数
| 参数 | 值 |
|------|-----|
| 清算奖励 | 保证金 × 0.5% |
| 维持保证金率 | 根据杠杆动态计算 |

---

### 六、资金费率模块

#### 6.1 功能描述
每 4 小时结算一次，平衡多空力量。

#### 6.2 合约实现
**文件**: `contracts/src/core/FundingRate.sol` (392 行)

```solidity
// 获取当前资金费率
function getCurrentFundingRate(address token) external view returns (int256)

// 获取下次结算时间
function getNextFundingTime() external view returns (uint256)

// 获取用户待结算资金费
function getPendingFunding(address user, address token) external view returns (int256)

// 结算资金费
function settleFunding(address token) external
```

#### 6.3 资金费率参数
| 参数 | 值 |
|------|-----|
| 结算周期 | 4 小时 |
| 费率上限 | ±0.25% |
| 计算公式 | clamp((markPrice - indexPrice) / indexPrice, -0.25%, +0.25%) |

---

### 七、保险基金模块

#### 7.1 功能描述
穿仓保护和盈利支付。

#### 7.2 合约实现
**文件**: `contracts/src/core/InsuranceFund.sol` (255 行)

```solidity
// 获取余额
function getBalance() external view returns (uint256)

// 覆盖穿仓亏损
function coverDeficit(uint256 amount) external returns (uint256 covered)

// 支付盈利
function payProfit(address user, uint256 amount) external

// 注入资金
function deposit() external payable
```

---

### 八、风险管理模块

#### 8.1 功能描述
杠杆验证和保证金率计算。

#### 8.2 合约实现
**文件**: `contracts/src/core/RiskManager.sol` (462 行)

```solidity
// 验证杠杆
function validateLeverage(uint256 leverage) external view returns (bool)

// 获取初始保证金率
function getInitialMarginRate(uint256 leverage) external pure returns (uint256)

// 获取维持保证金率
function getMaintenanceMarginRate(uint256 leverage) external pure returns (uint256)

// 验证仓位大小
function validatePositionSize(address token, uint256 size) external view returns (bool)
```

#### 8.3 保证金率表
| 杠杆倍数 | 初始保证金率 | 维持保证金率 |
|----------|--------------|--------------|
| 100x | 1% | 0.5% |
| 50x | 2% | 1% |
| 20x | 5% | 2.5% |
| 10x | 10% | 5% |
| 5x | 20% | 10% |

---

### 九、订单签名模块 (EIP-712)

#### 9.1 功能描述
链下签名订单，降低 Gas 成本。

#### 9.2 合约实现
**文件**: `contracts/src/core/Settlement.sol` (802 行)

```solidity
// 提交签名订单
function submitOrder(
    Order calldata order,
    bytes calldata signature
) external returns (bytes32 orderId)

// 取消订单
function cancelOrder(bytes32 orderId) external

// 验证签名
function verifySignature(Order calldata order, bytes calldata signature) public view returns (bool)
```

#### 9.3 订单结构
```solidity
struct Order {
    address trader;
    address token;
    bool isLong;
    uint256 size;
    uint256 leverage;
    uint256 price;      // 0 = 市价
    uint256 expiry;
    uint256 nonce;
}
```

---

## 数据库设计

### 数据库配置
- **数据库**: PostgreSQL 14+
- **ORM**: GORM (Go)
- **缓存**: Redis

### 数据表结构

#### 1. users - 用户表
```sql
CREATE TABLE users (
    id              BIGSERIAL PRIMARY KEY,
    created_at      TIMESTAMP WITH TIME ZONE,
    updated_at      TIMESTAMP WITH TIME ZONE,
    deleted_at      TIMESTAMP WITH TIME ZONE,

    address         VARCHAR(42) NOT NULL UNIQUE,  -- 钱包地址
    username        VARCHAR(50),
    api_key         VARCHAR(64),
    api_secret      VARCHAR(128),
    referrer_id     BIGINT REFERENCES users(id),
    referral_code   VARCHAR(20) UNIQUE,
    total_volume    DECIMAL(36,18) DEFAULT 0,
    total_pnl       DECIMAL(36,18) DEFAULT 0
);
```

#### 2. instruments - 交易对表
```sql
CREATE TABLE instruments (
    id              BIGSERIAL PRIMARY KEY,
    created_at      TIMESTAMP WITH TIME ZONE,
    updated_at      TIMESTAMP WITH TIME ZONE,

    symbol          VARCHAR(50) NOT NULL UNIQUE,   -- TOKEN-ETH
    base_currency   VARCHAR(20) NOT NULL,
    quote_currency  VARCHAR(20) NOT NULL,
    contract_type   VARCHAR(20) NOT NULL,          -- perpetual
    status          VARCHAR(20) DEFAULT 'active',
    tick_size       DECIMAL(36,18) NOT NULL,
    lot_size        DECIMAL(36,18) NOT NULL,
    min_size        DECIMAL(36,18) NOT NULL,
    max_leverage    INTEGER DEFAULT 100,
    maker_fee       DECIMAL(10,6) DEFAULT 0.0005,
    taker_fee       DECIMAL(10,6) DEFAULT 0.001,
    token_address   VARCHAR(42)
);
```

#### 3. orders - 订单表
```sql
CREATE TABLE orders (
    id              BIGSERIAL PRIMARY KEY,
    created_at      TIMESTAMP WITH TIME ZONE,
    updated_at      TIMESTAMP WITH TIME ZONE,

    order_id        VARCHAR(50) NOT NULL UNIQUE,
    user_id         BIGINT NOT NULL REFERENCES users(id),
    instrument_id   BIGINT NOT NULL REFERENCES instruments(id),
    client_order_id VARCHAR(50),
    side            VARCHAR(10) NOT NULL,          -- buy/sell
    order_type      VARCHAR(20) NOT NULL,          -- market/limit
    price           DECIMAL(36,18),
    size            DECIMAL(36,18) NOT NULL,
    filled_size     DECIMAL(36,18) DEFAULT 0,
    average_price   DECIMAL(36,18),
    status          VARCHAR(20) DEFAULT 'pending',
    leverage        INTEGER DEFAULT 1,
    margin          DECIMAL(36,18),
    fee             DECIMAL(36,18) DEFAULT 0,
    pnl             DECIMAL(36,18) DEFAULT 0,
    tx_hash         VARCHAR(66)
);
```

#### 4. positions - 仓位表
```sql
CREATE TABLE positions (
    id              BIGSERIAL PRIMARY KEY,
    created_at      TIMESTAMP WITH TIME ZONE,
    updated_at      TIMESTAMP WITH TIME ZONE,

    user_id         BIGINT NOT NULL REFERENCES users(id),
    instrument_id   BIGINT NOT NULL REFERENCES instruments(id),
    side            VARCHAR(10) NOT NULL,          -- long/short
    size            DECIMAL(36,18) NOT NULL,
    entry_price     DECIMAL(36,18) NOT NULL,
    mark_price      DECIMAL(36,18),
    liquidation_price DECIMAL(36,18),
    margin          DECIMAL(36,18) NOT NULL,
    leverage        INTEGER NOT NULL,
    unrealized_pnl  DECIMAL(36,18) DEFAULT 0,
    realized_pnl    DECIMAL(36,18) DEFAULT 0,
    funding_fee     DECIMAL(36,18) DEFAULT 0,
    status          VARCHAR(20) DEFAULT 'open',

    UNIQUE (user_id, instrument_id, side)
);
```

#### 5. balances - 余额表
```sql
CREATE TABLE balances (
    id              BIGSERIAL PRIMARY KEY,
    created_at      TIMESTAMP WITH TIME ZONE,
    updated_at      TIMESTAMP WITH TIME ZONE,

    user_id         BIGINT NOT NULL REFERENCES users(id),
    currency        VARCHAR(20) NOT NULL,
    available       DECIMAL(36,18) DEFAULT 0,
    locked          DECIMAL(36,18) DEFAULT 0,
    total           DECIMAL(36,18) DEFAULT 0,

    UNIQUE (user_id, currency)
);
```

#### 6. trades - 成交记录表
```sql
CREATE TABLE trades (
    id              BIGSERIAL PRIMARY KEY,
    created_at      TIMESTAMP WITH TIME ZONE,

    trade_id        VARCHAR(50) NOT NULL UNIQUE,
    order_id        VARCHAR(50) NOT NULL,
    user_id         BIGINT NOT NULL REFERENCES users(id),
    instrument_id   BIGINT NOT NULL REFERENCES instruments(id),
    side            VARCHAR(10) NOT NULL,
    price           DECIMAL(36,18) NOT NULL,
    size            DECIMAL(36,18) NOT NULL,
    fee             DECIMAL(36,18) NOT NULL,
    fee_currency    VARCHAR(20) NOT NULL,
    role            VARCHAR(10) NOT NULL,          -- maker/taker
    pnl             DECIMAL(36,18) DEFAULT 0,
    tx_hash         VARCHAR(66)
);
```

#### 7. candles - K线数据表
```sql
CREATE TABLE candles (
    id              BIGSERIAL PRIMARY KEY,

    instrument_id   BIGINT NOT NULL REFERENCES instruments(id),
    interval        VARCHAR(10) NOT NULL,          -- 1m/5m/15m/1h/4h/1d
    open_time       TIMESTAMP WITH TIME ZONE NOT NULL,
    close_time      TIMESTAMP WITH TIME ZONE NOT NULL,
    open            DECIMAL(36,18) NOT NULL,
    high            DECIMAL(36,18) NOT NULL,
    low             DECIMAL(36,18) NOT NULL,
    close           DECIMAL(36,18) NOT NULL,
    volume          DECIMAL(36,18) NOT NULL,
    quote_volume    DECIMAL(36,18) NOT NULL,
    trades_count    INTEGER DEFAULT 0,

    UNIQUE (instrument_id, interval, open_time)
);
```

#### 8. funding_rates - 资金费率表
```sql
CREATE TABLE funding_rates (
    id              BIGSERIAL PRIMARY KEY,
    created_at      TIMESTAMP WITH TIME ZONE,

    instrument_id   BIGINT NOT NULL REFERENCES instruments(id),
    funding_time    TIMESTAMP WITH TIME ZONE NOT NULL,
    funding_rate    DECIMAL(18,8) NOT NULL,
    mark_price      DECIMAL(36,18) NOT NULL,
    index_price     DECIMAL(36,18) NOT NULL,

    UNIQUE (instrument_id, funding_time)
);
```

#### 9. liquidations - 清算记录表
```sql
CREATE TABLE liquidations (
    id              BIGSERIAL PRIMARY KEY,
    created_at      TIMESTAMP WITH TIME ZONE,

    user_id         BIGINT NOT NULL REFERENCES users(id),
    instrument_id   BIGINT NOT NULL REFERENCES instruments(id),
    position_side   VARCHAR(10) NOT NULL,
    size            DECIMAL(36,18) NOT NULL,
    price           DECIMAL(36,18) NOT NULL,
    bankruptcy_price DECIMAL(36,18) NOT NULL,
    margin          DECIMAL(36,18) NOT NULL,
    loss            DECIMAL(36,18) NOT NULL,
    insurance_used  DECIMAL(36,18) DEFAULT 0,
    liquidator      VARCHAR(42),
    tx_hash         VARCHAR(66)
);
```

#### 10. bills - 账单流水表
```sql
CREATE TABLE bills (
    id              BIGSERIAL PRIMARY KEY,
    created_at      TIMESTAMP WITH TIME ZONE,

    user_id         BIGINT NOT NULL REFERENCES users(id),
    bill_id         VARCHAR(50) NOT NULL UNIQUE,
    currency        VARCHAR(20) NOT NULL,
    amount          DECIMAL(36,18) NOT NULL,
    balance_before  DECIMAL(36,18) NOT NULL,
    balance_after   DECIMAL(36,18) NOT NULL,
    type            VARCHAR(30) NOT NULL,          -- deposit/withdraw/trade_fee/funding_fee/realized_pnl/liquidation
    description     TEXT,
    reference_id    VARCHAR(50),
    tx_hash         VARCHAR(66)
);
```

#### 11. token_metadata - 代币元数据表
```sql
CREATE TABLE token_metadata (
    id              BIGSERIAL PRIMARY KEY,
    created_at      TIMESTAMP WITH TIME ZONE,
    updated_at      TIMESTAMP WITH TIME ZONE,

    token_address   VARCHAR(42) NOT NULL UNIQUE,
    name            VARCHAR(100) NOT NULL,
    symbol          VARCHAR(20) NOT NULL,
    decimals        INTEGER DEFAULT 18,
    creator         VARCHAR(42) NOT NULL,
    description     TEXT,
    image_uri       TEXT,
    twitter         VARCHAR(100),
    telegram        VARCHAR(100),
    website         VARCHAR(200),
    total_supply    DECIMAL(36,18),
    bonding_curve   DECIMAL(36,18),
    is_graduated    BOOLEAN DEFAULT false,
    graduated_at    TIMESTAMP WITH TIME ZONE
);
```

#### 12. sync_state - 同步状态表
```sql
CREATE TABLE sync_state (
    id              BIGSERIAL PRIMARY KEY,
    updated_at      TIMESTAMP WITH TIME ZONE,

    chain_id        INTEGER NOT NULL,
    contract_name   VARCHAR(50) NOT NULL,
    last_block      BIGINT NOT NULL,
    last_tx_hash    VARCHAR(66),

    UNIQUE (chain_id, contract_name)
);
```

---

## 后端 API 接口

### 基础信息
- **基础URL**: `/api/v1`
- **协议**: HTTP + WebSocket
- **认证**: 钱包签名 (EIP-712)

### 认证接口

#### POST /auth/nonce - 获取签名 nonce
```json
// 请求
{ "address": "0x..." }

// 响应
{ "nonce": "abc123..." }
```

#### POST /auth/login - 钱包签名登录
```json
// 请求
{
  "address": "0x...",
  "signature": "0x...",
  "nonce": "abc123..."
}

// 响应
{
  "token": "jwt_token...",
  "expiresAt": 1705632000000
}
```

### 公开接口

#### GET /public/instruments - 交易对列表
```json
// 响应
{
  "code": "0",
  "data": [{
    "instId": "TOKEN-ETH",
    "baseCcy": "TOKEN",
    "quoteCcy": "ETH",
    "tickSz": "0.00000001",
    "lotSz": "1",
    "minSz": "100",
    "maxLever": "100",
    "state": "live"
  }]
}
```

#### GET /market/ticker - 行情快照
```
GET /market/ticker?instId=TOKEN-ETH

// 响应
{
  "code": "0",
  "data": [{
    "instId": "TOKEN-ETH",
    "last": "0.000055",
    "markPx": "0.000055",
    "high24h": "0.00006",
    "low24h": "0.00004",
    "vol24h": "10000000",
    "volCcy24h": "550",
    "ts": "1705633000000"
  }]
}
```

#### GET /market/candles - K线数据
```
GET /market/candles?instId=TOKEN-ETH&bar=1H&limit=100

// bar: 1m, 5m, 15m, 30m, 1H, 4H, 1D, 1W

// 响应
{
  "code": "0",
  "data": [
    ["1705629600000", "0.00005", "0.000055", "0.000048", "0.000053", "1000000", "52"]
    // [时间戳, 开, 高, 低, 收, 成交量, 成交额]
  ]
}
```

#### GET /market/books - 订单簿
```
GET /market/books?instId=TOKEN-ETH&sz=20

// 响应
{
  "code": "0",
  "data": [{
    "asks": [["0.0000551", "1000", "1"]],
    "bids": [["0.0000549", "1500", "2"]],
    "ts": "1705633000000"
  }]
}
```

#### GET /market/trades - 最近成交
```
GET /market/trades?instId=TOKEN-ETH&limit=50

// 响应
{
  "code": "0",
  "data": [{
    "tradeId": "987654321",
    "px": "0.000055",
    "sz": "100",
    "side": "buy",
    "ts": "1705633000000"
  }]
}
```

#### GET /market/mark-price - 标记价格
```
GET /market/mark-price?instId=TOKEN-ETH

// 响应
{
  "code": "0",
  "data": [{
    "instId": "TOKEN-ETH",
    "markPx": "0.000055",
    "ts": "1705633000000"
  }]
}
```

#### GET /market/funding-rate - 资金费率
```
GET /market/funding-rate?instId=TOKEN-ETH

// 响应
{
  "code": "0",
  "data": [{
    "instId": "TOKEN-ETH",
    "fundingRate": "0.0001",
    "nextFundingTime": "1705636800000"
  }]
}
```

### 代币元数据接口

#### POST /token/metadata - 创建代币元数据
```json
// 请求
{
  "tokenAddress": "0x...",
  "name": "Doge Coin",
  "symbol": "DOGE",
  "description": "Much wow!",
  "imageUri": "ipfs://Qm...",
  "twitter": "https://twitter.com/doge",
  "telegram": "https://t.me/doge",
  "website": "https://doge.com"
}

// 响应
{ "code": "0", "msg": "success" }
```

#### GET /token/metadata - 获取代币元数据
```
GET /token/metadata?address=0x...

// 响应
{
  "code": "0",
  "data": {
    "tokenAddress": "0x...",
    "name": "Doge Coin",
    "symbol": "DOGE",
    "imageUri": "ipfs://Qm...",
    "isGraduated": true
  }
}
```

### 账户接口 (需认证)

#### GET /account/balance - 账户余额
```json
// 响应
{
  "code": "0",
  "data": [{
    "ccy": "ETH",
    "availBal": "50",
    "frozenBal": "45",
    "eq": "100"
  }]
}
```

#### GET /account/positions - 当前仓位
```json
// 响应
{
  "code": "0",
  "data": [{
    "instId": "TOKEN-ETH",
    "posSide": "long",
    "pos": "1000",
    "avgPx": "0.00005",
    "markPx": "0.000055",
    "liqPx": "0.000045",
    "margin": "0.5",
    "lever": "50",
    "upl": "0.1",
    "uplRatio": "0.2"
  }]
}
```

#### POST /account/set-leverage - 设置杠杆
```json
// 请求
{
  "instId": "TOKEN-ETH",
  "lever": "50",
  "mgnMode": "cross"
}

// 响应
{ "code": "0", "msg": "success" }
```

### 交易接口 (只读历史)

#### GET /trade/orders-history - 订单历史
```
GET /trade/orders-history?instId=TOKEN-ETH&limit=50

// 响应
{
  "code": "0",
  "data": [{
    "ordId": "123456789",
    "instId": "TOKEN-ETH",
    "side": "buy",
    "sz": "10",
    "avgPx": "0.000055",
    "state": "filled",
    "cTime": "1705632000000"
  }]
}
```

### WebSocket 接口

#### 公开频道 (/ws/public)
```json
// 订阅行情
{ "op": "subscribe", "args": [{ "channel": "tickers", "instId": "TOKEN-ETH" }] }

// 订阅 K线
{ "op": "subscribe", "args": [{ "channel": "candle1m", "instId": "TOKEN-ETH" }] }

// 订阅成交
{ "op": "subscribe", "args": [{ "channel": "trades", "instId": "TOKEN-ETH" }] }
```

#### 私有频道 (/ws/private)
```json
// 订阅仓位
{ "op": "subscribe", "args": [{ "channel": "positions" }] }

// 订阅订单
{ "op": "subscribe", "args": [{ "channel": "orders" }] }
```

---

## 前端页面与组件

### 页面路由

| 路由 | 页面 | 功能 |
|------|------|------|
| `/` | 首页 | 项目介绍、热门代币 |
| `/create` | 代币创建 | 创建 Meme 代币 |
| `/perp` | 永续交易 | 永续合约交易终端 |
| `/trade/[address]` | 现货交易 | 代币现货交易详情 |
| `/exchange` | DEX 交换 | Uniswap 风格交换 |
| `/account` | 账户 | 账户信息、仓位 |
| `/wallet` | 钱包 | 余额、存取款 |
| `/invite` | 邀请 | 推荐码、返佣 |
| `/settings` | 设置 | 系统设置 |

### 核心组件

#### 交易组件
| 组件 | 功能 |
|------|------|
| `PerpetualTradingTerminal.tsx` | 永续合约交易终端 |
| `PerpetualOrderPanel.tsx` | 开仓/平仓面板 |
| `PerpTradingPanelV2.tsx` | V2 永续交易面板 |
| `PriceChart.tsx` | 价格图表 |
| `TokenPriceChart.tsx` | 代币价格图表 |
| `FundingRateDisplay.tsx` | 资金费率显示 |
| `TradeHistoryTable.tsx` | 交易历史表 |
| `SpotSwapPanel.tsx` | 现货交换面板 |
| `InstrumentSelector.tsx` | 交易对选择器 |

#### 代币组件
| 组件 | 功能 |
|------|------|
| `TokenDetailPage.tsx` | 代币详情页 |
| `TokenDetailPageV2.tsx` | 代币详情页 V2 |
| `TokenCard.tsx` | 代币卡片 |
| `GraduationTracker.tsx` | 毕业进度跟踪 |
| `TopHolders.tsx` | 前 N 大持有者 |

#### 共享组件
| 组件 | 功能 |
|------|------|
| `WalletButton.tsx` | 钱包连接按钮 |
| `ImageUpload.tsx` | 图片上传 (IPFS) |
| `ThemeToggle.tsx` | 主题切换 |
| `LanguageSelector.tsx` | 语言选择器 |
| `Navbar.tsx` | 导航栏 |

### 核心 Hooks

#### 代币相关
```typescript
// 创建代币
const { createToken } = useCreateMemeToken();

// 获取池状态
const { data: poolState } = usePoolState(tokenAddress);

// 代币列表
const { data: tokens } = useTokenList();

// 代币信息
const { data: tokenInfo } = useTokenInfo(address);
```

#### 永续合约
```typescript
// V2 永续交易 (EIP-712)
const { signAndSubmitOrder, cancelOrder } = usePerpetualV2();

// 资金费率
const { data: fundingRate } = useFundingRate(instId);
```

#### 现货交易
```typescript
// 执行交换
const { executeSwap } = useExecuteSwap();

// 现货报价
const { data: quote } = useOnChainQuote(tokenAddress, amount);
```

#### WebSocket
```typescript
// WebSocket 连接
const { subscribe, unsubscribe } = useWebSocket();

// 成交流
const { trades } = useTradeStream(instId);
```

---

## 后台服务 (Keeper)

### 服务列表

| Keeper | 文件 | 功能 |
|--------|------|------|
| Funding | `keeper/funding.go` | 周期性资金费率计算、结算 |
| Liquidation | `keeper/liquidation.go` | 持续监控清算触发条件 |
| Price | `keeper/price.go` | 价格数据同步、缓存管理 |
| Order | `keeper/order.go` | 订单过期处理、状态更新 |

### Keeper Manager
`keeper/manager.go` 负责管理所有 Keeper 的生命周期。

---

## 部署信息

### 合约地址 (Base Sepolia)

| 合约 | 地址 |
|------|------|
| TokenFactory | 部署后填写 |
| PositionManager | 部署后填写 |
| PriceFeed | 部署后填写 |
| Vault | 部署后填写 |
| InsuranceFund | 部署后填写 |
| FundingRate | 部署后填写 |
| Liquidation | 部署后填写 |
| Settlement | 部署后填写 |

### 环境变量

```env
# 区块链
NEXT_PUBLIC_CHAIN_ID=84532
NEXT_PUBLIC_RPC_URL=https://sepolia.base.org

# 合约地址
NEXT_PUBLIC_TOKEN_FACTORY_ADDRESS=0x...
NEXT_PUBLIC_POSITION_MANAGER_ADDRESS=0x...
NEXT_PUBLIC_PRICE_FEED_ADDRESS=0x...
NEXT_PUBLIC_VAULT_ADDRESS=0x...

# 后端
NEXT_PUBLIC_API_URL=http://localhost:8080/api/v1
NEXT_PUBLIC_WS_URL=ws://localhost:8080

# IPFS
NEXT_PUBLIC_PINATA_JWT=...
NEXT_PUBLIC_IPFS_GATEWAY=https://gateway.pinata.cloud/ipfs/

# 数据库
DATABASE_URL=postgres://user:pass@localhost:5432/memeperp
REDIS_URL=redis://localhost:6379
```

---

## 安全机制

### 已实现的安全功能

| 编号 | 功能 | 说明 |
|------|------|------|
| H-014 | settleBankruptcy | 正确处理穿仓情况 |
| H-015 | settleLoss | 限制亏损不超过保证金 |
| H-016 | settleProfit | 支持待领取盈利机制 |
| H-017 | 多代币支持 | openLongToken/openShortToken |
| S-001 | 价格偏差保护 | 最大 10% 偏差限制 |
| M-007 | 毕业失败重试 | 毕业机制容错处理 |
| P-007 | 紧急暂停 | TokenFactory 暂停功能 |

### 合约安全措施

| 风险 | 防护措施 |
|------|----------|
| 重入攻击 | ReentrancyGuard |
| 整数溢出 | Solidity 0.8+ |
| 权限控制 | OpenZeppelin Ownable |
| 价格操纵 | TWAP + 偏差保护 |

---

## 文档版本

| 版本 | 日期 | 说明 |
|------|------|------|
| v1.0 | 2025-01-24 | 基于实际代码重写 |

---

## 附录

### 术语表
| 术语 | 说明 |
|------|------|
| Bonding Curve | 联合曲线定价机制 |
| 毕业 (Graduation) | 从 Bonding Curve 迁移到 Uniswap |
| 永续合约 | 无到期日的期货合约 |
| 杠杆 | 放大收益和风险的倍数 |
| 保证金 | 开仓所需的抵押资金 |
| 清算 | 强制平仓 |
| ADL | 自动减仓 |
| 资金费率 | 多空平衡机制 |
| TWAP | 时间加权平均价格 |
| EIP-712 | 结构化数据签名标准 |

### 参考项目
- Pump.fun (https://pump.fun) - Bonding Curve 模式
- GMX (https://gmx.io) - PnL 计算标准
- Bybit - 强平价格计算标准
