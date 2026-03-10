# 开发规范文档

> 统一数据库、后端API、前端TypeScript的字段命名和数据格式
>
> **⚠️ 2026-03-01**: 新的核心规范 — 所有资金流必须走链上合约，禁止使用 mode2Adj 虚拟余额。
> 详见 `docs/ISSUES_AUDIT_REPORT.md`

## 目录
1. [命名规范](#一命名规范)
2. [数据类型规范](#二数据类型规范)
3. [字段映射表](#三字段映射表)
4. [API 交互规范](#四api-交互规范)
5. [WebSocket 规范](#五websocket-规范)
6. [前端 TypeScript 类型定义](#六前端-typescript-类型定义)
7. [数据转换工具](#七数据转换工具)

---

## 一、命名规范

### 1.1 各层命名风格

| 层级 | 命名风格 | 示例 |
|------|----------|------|
| 数据库 | snake_case | `user_id`, `inst_id`, `pos_side`, `avg_px` |
| 后端 API 请求/响应 | camelCase | `userId`, `instId`, `posSide`, `avgPx` |
| 前端 TypeScript | camelCase | `userId`, `instId`, `posSide`, `avgPx` |
| 智能合约 | camelCase | `userId`, `instId`, `posSide`, `avgPx` |

### 1.2 缩写规范

统一使用以下缩写，**所有层级保持一致**：

| 缩写 | 全称 | 含义 |
|------|------|------|
| `px` | price | 价格 |
| `sz` | size | 数量 |
| `ts` | timestamp | 时间戳 |
| `ccy` | currency | 币种 |
| `inst` | instrument | 合约/交易对 |
| `ord` | order | 订单 |
| `pos` | position | 持仓 |
| `mgn` | margin | 保证金 |
| `liq` | liquidation | 清算 |
| `avg` | average | 平均 |
| `vol` | volume | 成交量 |
| `pnl` | profit and loss | 盈亏 |
| `upl` | unrealized pnl | 未实现盈亏 |
| `bal` | balance | 余额 |
| `eq` | equity | 权益 |
| `imr` | initial margin requirement | 初始保证金 |
| `mmr` | maintenance margin requirement | 维持保证金 |
| `lev` / `lever` | leverage | 杠杆 |
| `td` | trade | 交易 |
| `cl` | client | 客户端 |
| `acc` | accumulated | 累计 |
| `c` | create | 创建 |
| `u` | update | 更新 |

### 1.3 布尔字段命名

| 前缀 | 用途 | 示例 |
|------|------|------|
| `is` | 状态判断 | `isActive`, `isFilled` |
| `has` | 拥有判断 | `hasPosition`, `hasOrder` |
| `can` | 能力判断 | `canTrade`, `canWithdraw` |
| `allow` | 允许判断 | `allowTrade` |

---

## 二、数据类型规范

### 2.1 基础类型规范

| 数据类型 | 数据库类型 | API JSON 类型 | TypeScript 类型 | 说明 |
|----------|------------|---------------|-----------------|------|
| ID | BIGSERIAL | string | string | 使用字符串避免 JS 精度问题 |
| 地址 | VARCHAR(42) | string | string | 以太坊地址 0x... |
| 价格 | DECIMAL(36,18) | string | string | **必须字符串**，避免精度丢失 |
| 数量 | DECIMAL(36,18) | string | string | **必须字符串** |
| 比率 | DECIMAL(18,8) | string | string | 如资金费率、收益率 |
| 杠杆 | SMALLINT | number | number | 整数 1-100 |
| 时间戳 | BIGINT | number | number | 毫秒级时间戳 |
| 布尔值 | BOOLEAN | boolean | boolean | true/false |
| 枚举 | VARCHAR | string | string (union type) | 如 "buy" \| "sell" |
| 哈希 | VARCHAR(66) | string | string | 交易哈希 0x... |

### 2.2 精度规范

| 类型 | 小数位数 | 示例 |
|------|----------|------|
| MEME 价格 | 18 位 | "0.000000050000000000" |
| BNB 数量 | 18 位 | "1.500000000000000000" |
| MEME 数量 | 0 位（整数） | "1000000" |
| 资金费率 | 8 位 | "0.00010000" |
| 保证金率 | 8 位 | "5.50000000" |
| 杠杆 | 0 位（整数） | 50 |
| 百分比 | 4 位 | "0.0500" (5%) |

### 2.3 枚举值规范

**订单方向 (side)**
```typescript
type Side = "buy" | "sell";
```

**持仓方向 (posSide)**
```typescript
type PosSide = "long" | "short";
```

**订单类型 (ordType)**
```typescript
type OrdType = "market" | "limit" | "post_only" | "fok" | "ioc";
```

**订单状态 (state)**
```typescript
type OrderState = "live" | "partially_filled" | "filled" | "canceled";
```

**保证金模式 (mgnMode / tdMode)**
```typescript
type MgnMode = "cross" | "isolated";
```

**合约类型 (instType)**
```typescript
type InstType = "SPOT" | "PERP";
```

**合约状态 (state)**
```typescript
type InstState = "live" | "suspend" | "preopen" | "settlement";
```

**账单类型 (billType)**
```typescript
type BillType = 1 | 2 | 3 | 4 | 5 | 6;
// 1=划转, 2=交易, 3=强平, 4=资金费, 5=ADL, 6=清算
```

---

## 三、字段映射表

### 3.1 用户表 (users)

| 数据库字段 | API 字段 | 类型 | 说明 |
|------------|----------|------|------|
| id | userId | string | 用户ID |
| address | address | string | 钱包地址 |
| api_key | apiKey | string | API Key |
| api_secret | - | - | 不返回 |
| referrer_id | referrerId | string | 推荐人ID |
| referral_code | referralCode | string | 推荐码 |
| fee_tier | feeTier | number | 手续费等级 |
| created_at | cTime | number | 创建时间戳 |
| updated_at | uTime | number | 更新时间戳 |

### 3.2 合约信息表 (instruments)

| 数据库字段 | API 字段 | 类型 | 说明 |
|------------|----------|------|------|
| id | - | - | 内部ID |
| inst_id | instId | string | 合约ID "MEME-BNB-PERP" |
| inst_type | instType | string | 合约类型 |
| base_ccy | baseCcy | string | 基础币种 |
| quote_ccy | quoteCcy | string | 计价币种 |
| settle_ccy | settleCcy | string | 结算币种 |
| ct_val | ctVal | string | 合约面值 |
| tick_sz | tickSz | string | 价格精度 |
| lot_sz | lotSz | string | 数量精度 |
| min_sz | minSz | string | 最小数量 |
| max_lever | maxLever | number | 最大杠杆 |
| state | state | string | 状态 |
| list_time | listTime | number | 上架时间 |

### 3.3 K线表 (candles)

| 数据库字段 | API 字段 | 类型 | 说明 |
|------------|----------|------|------|
| inst_id | instId | string | 合约ID |
| bar | bar | string | 时间粒度 |
| ts | ts | number | 开盘时间戳 |
| o | o | string | 开盘价 |
| h | h | string | 最高价 |
| l | l | string | 最低价 |
| c | c | string | 收盘价 |
| vol | vol | string | 成交量 |
| vol_ccy | volCcy | string | 成交额 |
| confirm | confirm | number | 是否确认 (0/1) |

### 3.4 成交表 (trades)

| 数据库字段 | API 字段 | 类型 | 说明 |
|------------|----------|------|------|
| trade_id | tradeId | string | 成交ID |
| inst_id | instId | string | 合约ID |
| px | px | string | 成交价 |
| sz | sz | string | 成交量 |
| side | side | string | 方向 |
| ts | ts | number | 成交时间 |

### 3.5 订单表 (orders)

| 数据库字段 | API 字段 | 类型 | 说明 |
|------------|----------|------|------|
| ord_id | ordId | string | 订单ID |
| cl_ord_id | clOrdId | string | 客户端订单ID |
| user_id | - | - | 内部字段 |
| inst_id | instId | string | 合约ID |
| td_mode | tdMode | string | 交易模式 |
| side | side | string | 订单方向 |
| pos_side | posSide | string | 持仓方向 |
| ord_type | ordType | string | 订单类型 |
| sz | sz | string | 委托数量 |
| px | px | string | 委托价格 |
| avg_px | avgPx | string | 成交均价 |
| acc_fill_sz | accFillSz | string | 累计成交量 |
| state | state | string | 订单状态 |
| lever | lever | number | 杠杆 |
| fee | fee | string | 手续费 |
| fee_ccy | feeCcy | string | 手续费币种 |
| pnl | pnl | string | 收益 |
| reduce_only | reduceOnly | boolean | 只减仓 |
| tp_trigger_px | tpTriggerPx | string | 止盈触发价 |
| sl_trigger_px | slTriggerPx | string | 止损触发价 |
| c_time | cTime | number | 创建时间 |
| u_time | uTime | number | 更新时间 |

### 3.6 持仓表 (positions)

| 数据库字段 | API 字段 | 类型 | 说明 |
|------------|----------|------|------|
| pos_id | posId | string | 持仓ID |
| user_id | - | - | 内部字段 |
| inst_id | instId | string | 合约ID |
| mgn_mode | mgnMode | string | 保证金模式 |
| pos_side | posSide | string | 持仓方向 |
| pos | pos | string | 持仓数量 |
| avail_pos | availPos | string | 可平仓数量 |
| avg_px | avgPx | string | 开仓均价 |
| lever | lever | number | 杠杆 |
| upl | upl | string | 未实现盈亏 |
| upl_ratio | uplRatio | string | 未实现收益率 |
| liq_px | liqPx | string | 预估强平价 |
| mark_px | markPx | string | 标记价格 |
| margin | margin | string | 保证金 |
| imr | imr | string | 初始保证金 |
| mmr | mmr | string | 维持保证金 |
| mgn_ratio | mgnRatio | string | 保证金率 |
| adl | adl | number | ADL指示 (1-5) |
| c_time | cTime | number | 创建时间 |
| u_time | uTime | number | 更新时间 |

### 3.7 余额表 (balances)

| 数据库字段 | API 字段 | 类型 | 说明 |
|------------|----------|------|------|
| user_id | - | - | 内部字段 |
| ccy | ccy | string | 币种 |
| eq | eq | string | 权益 |
| cash_bal | cashBal | string | 现金余额 |
| avail_bal | availBal | string | 可用余额 |
| frozen_bal | frozenBal | string | 冻结余额 |
| ord_frozen | ordFrozen | string | 挂单冻结 |
| upl | upl | string | 未实现盈亏 |
| u_time | uTime | number | 更新时间 |

### 3.8 资金费率表 (funding_rates)

| 数据库字段 | API 字段 | 类型 | 说明 |
|------------|----------|------|------|
| inst_id | instId | string | 合约ID |
| funding_rate | fundingRate | string | 资金费率 |
| realized_rate | realizedRate | string | 实际费率 |
| funding_time | fundingTime | number | 结算时间 |
| next_funding_time | nextFundingTime | number | 下次结算 |

### 3.9 清算记录表 (liquidations)

| 数据库字段 | API 字段 | 类型 | 说明 |
|------------|----------|------|------|
| user_id | - | - | 内部字段 |
| inst_id | instId | string | 合约ID |
| pos_side | posSide | string | 持仓方向 |
| sz | sz | string | 清算数量 |
| px | px | string | 清算价格 |
| loss | loss | string | 损失金额 |
| liquidator | liquidator | string | 清算人地址 |
| liq_reward | liqReward | string | 清算奖励 |
| ts | ts | number | 时间戳 |
| tx_hash | txHash | string | 交易哈希 |

### 3.10 账单流水表 (bills)

| 数据库字段 | API 字段 | 类型 | 说明 |
|------------|----------|------|------|
| bill_id | billId | string | 账单ID |
| user_id | - | - | 内部字段 |
| inst_id | instId | string | 合约ID |
| ccy | ccy | string | 币种 |
| type | type | number | 账单类型 |
| sub_type | subType | number | 子类型 |
| bal | bal | string | 账户余额 |
| bal_chg | balChg | string | 余额变化 |
| sz | sz | string | 数量 |
| px | px | string | 价格 |
| pnl | pnl | string | 盈亏 |
| fee | fee | string | 手续费 |
| ts | ts | number | 时间戳 |

---

## 四、API 交互规范

### 4.1 请求规范

**GET 请求**
- 参数放在 URL Query String
- 参数名使用 camelCase
```
GET /api/v1/market/candles?instId=MEME-BNB-PERP&bar=1m&limit=100
```

**POST/PUT/DELETE 请求**
- 参数放在 Request Body
- Content-Type: application/json
```json
POST /api/v1/trade/order
{
    "instId": "MEME-BNB-PERP",
    "tdMode": "cross",
    "side": "buy",
    "posSide": "long",
    "ordType": "limit",
    "sz": "1000000",
    "px": "0.00000005"
}
```

### 4.2 响应规范

**统一响应结构**
```typescript
interface ApiResponse<T> {
    code: number;      // 0=成功，其他=错误码
    msg: string;       // 消息
    data: T | null;    // 数据
}
```

**成功响应**
```json
{
    "code": 0,
    "msg": "success",
    "data": {
        "ordId": "1234567890",
        "clOrdId": "myOrder001"
    }
}
```

**错误响应**
```json
{
    "code": 51007,
    "msg": "Insufficient balance",
    "data": null
}
```

**列表响应**
```json
{
    "code": 0,
    "msg": "success",
    "data": [
        { "instId": "MEME-BNB-PERP", "last": "0.00000005" }
    ]
}
```

**分页响应**
```json
{
    "code": 0,
    "msg": "success",
    "data": {
        "list": [...],
        "total": 1000,
        "page": 1,
        "pageSize": 20,
        "hasMore": true
    }
}
```

### 4.3 时间戳规范

- 所有时间戳使用 **毫秒级 Unix 时间戳**
- 13位数字，如 `1705651200000`
- 前端显示时转换为本地时间

```typescript
// 后端返回
{ "ts": 1705651200000 }

// 前端转换
new Date(1705651200000).toLocaleString()
// -> "2024/1/19 16:00:00"
```

---

## 五、WebSocket 规范

### 5.1 连接规范

```
公共频道: wss://ws.memeperp.io/ws/v1/public
私有频道: wss://ws.memeperp.io/ws/v1/private
```

### 5.2 消息格式

**订阅请求**
```json
{
    "op": "subscribe",
    "args": [
        { "channel": "tickers", "instId": "MEME-BNB-PERP" }
    ]
}
```

**订阅成功响应**
```json
{
    "event": "subscribe",
    "arg": { "channel": "tickers", "instId": "MEME-BNB-PERP" },
    "connId": "conn-12345"
}
```

**数据推送**
```json
{
    "arg": { "channel": "tickers", "instId": "MEME-BNB-PERP" },
    "action": "snapshot",  // snapshot=全量, update=增量
    "data": [{
        "instId": "MEME-BNB-PERP",
        "last": "0.00000005",
        "askPx": "0.000000051",
        "bidPx": "0.000000049",
        "vol24h": "1000000000",
        "ts": 1705651200000
    }]
}
```

### 5.3 频道数据格式

**Ticker 频道**
```typescript
interface WsTicker {
    instId: string;
    last: string;
    lastSz: string;
    askPx: string;
    askSz: string;
    bidPx: string;
    bidSz: string;
    open24h: string;
    high24h: string;
    low24h: string;
    vol24h: string;
    volCcy24h: string;
    ts: number;
}
```

**K线频道**
```typescript
// 推送格式: 数组 (节省带宽)
// [ts, o, h, l, c, vol, volCcy, confirm]
type WsCandle = [string, string, string, string, string, string, string, string];

// 解析后格式
interface Candle {
    ts: number;
    o: string;
    h: string;
    l: string;
    c: string;
    vol: string;
    volCcy: string;
    confirm: boolean;
}
```

**深度频道**
```typescript
interface WsDepth {
    asks: [string, string, string, string][]; // [px, sz, deprecated, orderCount]
    bids: [string, string, string, string][];
    ts: number;
    checksum: number;  // 校验和
}
```

**成交频道**
```typescript
interface WsTrade {
    instId: string;
    tradeId: string;
    px: string;
    sz: string;
    side: "buy" | "sell";
    ts: number;
}
```

**持仓频道 (私有)**
```typescript
interface WsPosition {
    instId: string;
    posId: string;
    posSide: "long" | "short";
    pos: string;
    availPos: string;
    avgPx: string;
    upl: string;
    uplRatio: string;
    lever: number;
    liqPx: string;
    markPx: string;
    margin: string;
    mgnRatio: string;
    uTime: number;
}
```

**订单频道 (私有)**
```typescript
interface WsOrder {
    instId: string;
    ordId: string;
    clOrdId: string;
    side: "buy" | "sell";
    posSide: "long" | "short";
    ordType: string;
    sz: string;
    px: string;
    avgPx: string;
    accFillSz: string;
    state: string;
    lever: number;
    fee: string;
    pnl: string;
    cTime: number;
    uTime: number;
}
```

### 5.4 心跳规范

```
客户端每 30 秒发送: "ping"
服务端响应: "pong"
超过 60 秒无心跳则断开连接
```

### 5.5 错误推送

```json
{
    "event": "error",
    "code": "50011",
    "msg": "Rate limit exceeded",
    "connId": "conn-12345"
}
```

---

## 六、前端 TypeScript 类型定义

### 6.1 基础类型

```typescript
// types/common.ts

/** API 响应基础结构 */
export interface ApiResponse<T = unknown> {
    code: number;
    msg: string;
    data: T | null;
}

/** 分页响应 */
export interface PaginatedData<T> {
    list: T[];
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
}

/** 订单方向 */
export type Side = "buy" | "sell";

/** 持仓方向 */
export type PosSide = "long" | "short";

/** 订单类型 */
export type OrdType = "market" | "limit" | "post_only" | "fok" | "ioc";

/** 订单状态 */
export type OrderState = "live" | "partially_filled" | "filled" | "canceled";

/** 保证金模式 */
export type MgnMode = "cross" | "isolated";

/** 合约类型 */
export type InstType = "SPOT" | "PERP";

/** K线周期 */
export type Bar = "1m" | "3m" | "5m" | "15m" | "30m" | "1H" | "2H" | "4H" | "6H" | "12H" | "1D" | "1W" | "1M";
```

### 6.2 市场数据类型

```typescript
// types/market.ts

/** 合约信息 */
export interface Instrument {
    instId: string;
    instType: InstType;
    baseCcy: string;
    quoteCcy: string;
    settleCcy: string;
    ctVal: string;
    tickSz: string;
    lotSz: string;
    minSz: string;
    maxLever: number;
    state: string;
    listTime: number;
}

/** Ticker 行情 */
export interface Ticker {
    instId: string;
    last: string;
    lastSz: string;
    askPx: string;
    askSz: string;
    bidPx: string;
    bidSz: string;
    open24h: string;
    high24h: string;
    low24h: string;
    vol24h: string;
    volCcy24h: string;
    sodUtc0: string;
    sodUtc8: string;
    ts: number;
}

/** K线数据 */
export interface Candle {
    ts: number;
    o: string;
    h: string;
    l: string;
    c: string;
    vol: string;
    volCcy: string;
    confirm: boolean;
}

/** 深度数据 */
export interface OrderBook {
    asks: OrderBookLevel[];
    bids: OrderBookLevel[];
    ts: number;
}

export interface OrderBookLevel {
    px: string;
    sz: string;
    orderCount: number;
}

/** 成交记录 */
export interface Trade {
    instId: string;
    tradeId: string;
    px: string;
    sz: string;
    side: Side;
    ts: number;
}

/** 标记价格 */
export interface MarkPrice {
    instId: string;
    markPx: string;
    ts: number;
}

/** 资金费率 */
export interface FundingRate {
    instId: string;
    fundingRate: string;
    nextFundingRate: string;
    fundingTime: number;
    nextFundingTime: number;
}
```

### 6.3 交易类型

```typescript
// types/trade.ts

/** 下单请求 */
export interface PlaceOrderRequest {
    instId: string;
    tdMode: MgnMode;
    side: Side;
    posSide: PosSide;
    ordType: OrdType;
    sz: string;
    px?: string;
    lever?: string;
    clOrdId?: string;
    reduceOnly?: boolean;
    tpTriggerPx?: string;
    tpOrdPx?: string;
    slTriggerPx?: string;
    slOrdPx?: string;
}

/** 下单响应 */
export interface PlaceOrderResponse {
    ordId: string;
    clOrdId: string;
    sCode: string;
    sMsg: string;
}

/** 订单详情 */
export interface Order {
    instId: string;
    ordId: string;
    clOrdId: string;
    ordType: OrdType;
    side: Side;
    posSide: PosSide;
    tdMode: MgnMode;
    sz: string;
    px: string;
    avgPx: string;
    accFillSz: string;
    state: OrderState;
    lever: number;
    fee: string;
    feeCcy: string;
    pnl: string;
    reduceOnly: boolean;
    tpTriggerPx: string;
    slTriggerPx: string;
    cTime: number;
    uTime: number;
}

/** 撤单请求 */
export interface CancelOrderRequest {
    instId: string;
    ordId?: string;
    clOrdId?: string;
}
```

### 6.4 账户类型

```typescript
// types/account.ts

/** 账户余额 */
export interface AccountBalance {
    totalEq: string;
    isoEq: string;
    adjEq: string;
    ordFroz: string;
    imr: string;
    mmr: string;
    mgnRatio: string;
    notionalUsd: string;
    uTime: number;
    details: BalanceDetail[];
}

export interface BalanceDetail {
    ccy: string;
    eq: string;
    cashBal: string;
    availEq: string;
    availBal: string;
    frozenBal: string;
    ordFrozen: string;
    upl: string;
    mgnRatio: string;
    eqUsd: string;
    uTime: number;
}

/** 持仓信息 */
export interface Position {
    instId: string;
    posId: string;
    posSide: PosSide;
    pos: string;
    availPos: string;
    avgPx: string;
    upl: string;
    uplRatio: string;
    lever: number;
    liqPx: string;
    markPx: string;
    margin: string;
    imr: string;
    mmr: string;
    mgnRatio: string;
    adl: number;
    cTime: number;
    uTime: number;
}

/** 账单流水 */
export interface Bill {
    billId: string;
    instId: string;
    ccy: string;
    type: number;
    subType: number;
    bal: string;
    balChg: string;
    sz: string;
    px: string;
    pnl: string;
    fee: string;
    ts: number;
}
```

### 6.5 WebSocket 类型

```typescript
// types/websocket.ts

/** WebSocket 操作类型 */
export type WsOp = "subscribe" | "unsubscribe" | "login";

/** 订阅参数 */
export interface WsArg {
    channel: string;
    instId?: string;
}

/** 订阅请求 */
export interface WsRequest {
    op: WsOp;
    args: WsArg[];
}

/** 登录请求 */
export interface WsLoginRequest {
    op: "login";
    args: [{
        apiKey: string;
        passphrase: string;
        timestamp: string;
        sign: string;
    }];
}

/** WebSocket 推送消息 */
export interface WsMessage<T = unknown> {
    arg: WsArg;
    action: "snapshot" | "update";
    data: T[];
}

/** WebSocket 事件消息 */
export interface WsEvent {
    event: "subscribe" | "unsubscribe" | "login" | "error";
    arg?: WsArg;
    code?: string;
    msg?: string;
    connId?: string;
}
```

---

## 七、数据转换工具

### 7.1 后端转换工具 (Node.js)

```typescript
// utils/transform.ts

/**
 * snake_case 转 camelCase
 */
export function snakeToCamel(str: string): string {
    return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * camelCase 转 snake_case
 */
export function camelToSnake(str: string): string {
    return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

/**
 * 数据库记录转 API 响应
 */
export function dbToApi<T extends Record<string, unknown>>(
    dbRecord: Record<string, unknown>,
    excludeFields: string[] = []
): T {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(dbRecord)) {
        if (excludeFields.includes(key)) continue;

        const camelKey = snakeToCamel(key);

        // 时间戳字段转换
        if (key.endsWith('_at') || key === 'created_at' || key === 'updated_at') {
            result[camelKey.replace('At', 'Time')] = value instanceof Date
                ? value.getTime()
                : value;
        }
        // BigInt 转字符串
        else if (typeof value === 'bigint') {
            result[camelKey] = value.toString();
        }
        // Decimal 转字符串
        else if (value && typeof value === 'object' && 'toString' in value) {
            result[camelKey] = value.toString();
        }
        else {
            result[camelKey] = value;
        }
    }

    return result as T;
}

/**
 * API 请求转数据库记录
 */
export function apiToDb<T extends Record<string, unknown>>(
    apiData: Record<string, unknown>
): T {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(apiData)) {
        const snakeKey = camelToSnake(key);
        result[snakeKey] = value;
    }

    return result as T;
}

// 使用示例
// const dbRecord = { user_id: 1, inst_id: 'MEME-BNB', avg_px: '0.00005', created_at: new Date() };
// const apiResponse = dbToApi(dbRecord, ['user_id']);
// -> { instId: 'MEME-BNB', avgPx: '0.00005', cTime: 1705651200000 }
```

### 7.2 前端转换工具 (TypeScript)

```typescript
// utils/format.ts

import BigNumber from 'bignumber.js';

/**
 * 格式化价格显示
 */
export function formatPrice(price: string, decimals: number = 8): string {
    const bn = new BigNumber(price);
    if (bn.isZero()) return '0';

    // 自动确定小数位数
    const absValue = bn.abs();
    if (absValue.lt(0.00000001)) {
        return bn.toFixed(18);
    } else if (absValue.lt(0.0001)) {
        return bn.toFixed(12);
    } else if (absValue.lt(1)) {
        return bn.toFixed(8);
    } else {
        return bn.toFixed(decimals);
    }
}

/**
 * 格式化数量显示
 */
export function formatSize(size: string, decimals: number = 2): string {
    const bn = new BigNumber(size);
    if (bn.gte(1_000_000_000)) {
        return bn.div(1_000_000_000).toFixed(decimals) + 'B';
    } else if (bn.gte(1_000_000)) {
        return bn.div(1_000_000).toFixed(decimals) + 'M';
    } else if (bn.gte(1_000)) {
        return bn.div(1_000).toFixed(decimals) + 'K';
    }
    return bn.toFixed(0);
}

/**
 * 格式化百分比
 */
export function formatPercent(value: string, decimals: number = 2): string {
    const bn = new BigNumber(value).times(100);
    const prefix = bn.gte(0) ? '+' : '';
    return prefix + bn.toFixed(decimals) + '%';
}

/**
 * 格式化时间戳
 */
export function formatTimestamp(ts: number, format: 'full' | 'date' | 'time' = 'full'): string {
    const date = new Date(ts);

    if (format === 'date') {
        return date.toLocaleDateString();
    } else if (format === 'time') {
        return date.toLocaleTimeString();
    }
    return date.toLocaleString();
}

/**
 * 解析 K线数组为对象
 */
export function parseCandle(arr: string[]): Candle {
    return {
        ts: parseInt(arr[0]),
        o: arr[1],
        h: arr[2],
        l: arr[3],
        c: arr[4],
        vol: arr[5],
        volCcy: arr[6],
        confirm: arr[7] === '1'
    };
}

/**
 * 解析深度数组
 */
export function parseOrderBookLevel(arr: string[]): OrderBookLevel {
    return {
        px: arr[0],
        sz: arr[1],
        orderCount: parseInt(arr[3])
    };
}
```

### 7.3 前端 WebSocket 管理器

```typescript
// services/websocket.ts

type MessageHandler = (data: unknown) => void;

export class WebSocketManager {
    private ws: WebSocket | null = null;
    private url: string;
    private handlers: Map<string, Set<MessageHandler>> = new Map();
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 5;
    private heartbeatTimer: NodeJS.Timer | null = null;

    constructor(url: string) {
        this.url = url;
    }

    connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.url);

            this.ws.onopen = () => {
                this.reconnectAttempts = 0;
                this.startHeartbeat();
                resolve();
            };

            this.ws.onmessage = (event) => {
                this.handleMessage(event.data);
            };

            this.ws.onclose = () => {
                this.stopHeartbeat();
                this.reconnect();
            };

            this.ws.onerror = (error) => {
                reject(error);
            };
        });
    }

    private handleMessage(data: string): void {
        if (data === 'pong') return;

        try {
            const message = JSON.parse(data);

            // 处理事件消息
            if (message.event) {
                const eventKey = `event:${message.event}`;
                this.emit(eventKey, message);
                return;
            }

            // 处理数据推送
            if (message.arg) {
                const { channel, instId } = message.arg;
                const key = instId ? `${channel}:${instId}` : channel;
                this.emit(key, message.data);
            }
        } catch (e) {
            console.error('WebSocket message parse error:', e);
        }
    }

    subscribe(channel: string, instId?: string): void {
        this.send({
            op: 'subscribe',
            args: [{ channel, instId }]
        });
    }

    unsubscribe(channel: string, instId?: string): void {
        this.send({
            op: 'unsubscribe',
            args: [{ channel, instId }]
        });
    }

    on(channel: string, instId: string | undefined, handler: MessageHandler): () => void {
        const key = instId ? `${channel}:${instId}` : channel;

        if (!this.handlers.has(key)) {
            this.handlers.set(key, new Set());
        }
        this.handlers.get(key)!.add(handler);

        // 返回取消订阅函数
        return () => {
            this.handlers.get(key)?.delete(handler);
        };
    }

    private emit(key: string, data: unknown): void {
        this.handlers.get(key)?.forEach(handler => handler(data));
    }

    private send(message: object): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
    }

    private startHeartbeat(): void {
        this.heartbeatTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send('ping');
            }
        }, 30000);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    private reconnect(): void {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('Max reconnect attempts reached');
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

        setTimeout(() => {
            this.connect();
        }, delay);
    }

    disconnect(): void {
        this.stopHeartbeat();
        this.ws?.close();
        this.ws = null;
    }
}

// 使用示例
/*
const ws = new WebSocketManager('wss://ws.memeperp.io/ws/v1/public');
await ws.connect();

// 订阅 ticker
ws.subscribe('tickers', 'MEME-BNB-PERP');
const unsubscribe = ws.on('tickers', 'MEME-BNB-PERP', (data) => {
    console.log('Ticker update:', data);
});

// 取消订阅
unsubscribe();
ws.unsubscribe('tickers', 'MEME-BNB-PERP');
*/
```

---

## 附录

### A. 完整字段速查表

| 中文 | 数据库 | API/前端 | 类型 |
|------|--------|----------|------|
| 用户ID | user_id | userId | string |
| 合约ID | inst_id | instId | string |
| 订单ID | ord_id | ordId | string |
| 客户端订单ID | cl_ord_id | clOrdId | string |
| 持仓ID | pos_id | posId | string |
| 交易ID | trade_id | tradeId | string |
| 账单ID | bill_id | billId | string |
| 价格 | px | px | string |
| 数量 | sz | sz | string |
| 方向 | side | side | string |
| 持仓方向 | pos_side | posSide | string |
| 订单类型 | ord_type | ordType | string |
| 交易模式 | td_mode | tdMode | string |
| 杠杆 | lever | lever | number |
| 保证金 | margin | margin | string |
| 未实现盈亏 | upl | upl | string |
| 实现盈亏 | pnl | pnl | string |
| 手续费 | fee | fee | string |
| 成交均价 | avg_px | avgPx | string |
| 累计成交量 | acc_fill_sz | accFillSz | string |
| 状态 | state | state | string |
| 清算价 | liq_px | liqPx | string |
| 标记价格 | mark_px | markPx | string |
| 初始保证金 | imr | imr | string |
| 维持保证金 | mmr | mmr | string |
| 保证金率 | mgn_ratio | mgnRatio | string |
| 资金费率 | funding_rate | fundingRate | string |
| 可用余额 | avail_bal | availBal | string |
| 冻结余额 | frozen_bal | frozenBal | string |
| 权益 | eq | eq | string |
| 时间戳 | ts | ts | number |
| 创建时间 | c_time | cTime | number |
| 更新时间 | u_time | uTime | number |

### B. 版本历史

| 版本 | 日期 | 说明 |
|------|------|------|
| v1.0 | 2025-01-19 | 初版 - 开发规范文档 |
