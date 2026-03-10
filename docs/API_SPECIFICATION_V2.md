# API 规范文档 V2

> **⚠️ 2026-03-01**: 撮合引擎的 `POST /api/user/:trader/deposit` 和 `withdraw`
> 是无鉴权的虚假充值/提款接口，不执行任何链上操作。必须禁用或加鉴权。
> 详见 `docs/ISSUES_AUDIT_REPORT.md`

## 概述

本文档定义 MEME Perp DEX 的 REST API 和 WebSocket API 规范，参考 OKX/Binance 标准设计。

**Base URL:** `https://api.meme-perp.io`
**API 版本:** `v1`

---

## 通用规范

### 请求格式

- Content-Type: `application/json`
- 认证: 使用钱包签名 (EIP-712)

### 响应格式

```json
{
  "code": "0",
  "msg": "",
  "data": {}
}
```

### 错误码

| 错误码 | 说明 |
|--------|------|
| 0 | 成功 |
| 50000 | 服务暂不可用 |
| 50001 | 请求超时 |
| 50002 | 系统繁忙 |
| 50004 | API 限流 |
| 50005 | 参数错误 |
| 50006 | 签名验证失败 |
| 50007 | 未授权 |
| 50008 | 账户被冻结 |
| 51000 | 交易相关错误 |
| 51001 | 余额不足 |
| 51002 | 仓位不存在 |
| 51003 | 订单不存在 |
| 51004 | 超过最大杠杆 |
| 51005 | 超过仓位限制 |
| 51006 | 低于最小下单量 |
| 51007 | 价格超出限制 |
| 51008 | 风控拦截 |

### 时间戳

所有时间戳使用 Unix 毫秒时间戳。

---

## REST API

### 公共接口 (无需认证)

#### 获取服务器时间

```http
GET /api/v1/public/time
```

**响应:**
```json
{
  "code": "0",
  "data": {
    "ts": "1704067200000"
  }
}
```

#### 获取所有交易对

```http
GET /api/v1/public/instruments
```

**参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| instType | String | 否 | SPOT/PERP |
| instId | String | 否 | 交易对ID |

**响应:**
```json
{
  "code": "0",
  "data": [
    {
      "instId": "MEME-BNB",
      "instType": "PERP",
      "baseCcy": "MEME",
      "quoteCcy": "BNB",
      "ctVal": "1",
      "tickSz": "0.00000001",
      "lotSz": "1",
      "minSz": "1",
      "maxLv": "100",
      "state": "live",
      "listTime": "1704067200000"
    }
  ]
}
```

#### 获取行情数据

```http
GET /api/v1/market/ticker
```

**参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| instId | String | 是 | 交易对ID |

**响应:**
```json
{
  "code": "0",
  "data": {
    "instId": "MEME-BNB",
    "last": "0.00000005",
    "lastSz": "1000000",
    "askPx": "0.0000000505",
    "askSz": "5000000",
    "bidPx": "0.0000000495",
    "bidSz": "3000000",
    "open24h": "0.00000004",
    "high24h": "0.00000006",
    "low24h": "0.00000003",
    "vol24h": "1000000000",
    "volCcy24h": "50",
    "ts": "1704067200000"
  }
}
```

#### 获取 K 线数据

```http
GET /api/v1/market/candles
```

**参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| instId | String | 是 | 交易对ID |
| bar | String | 否 | 周期，默认 1m (1m/5m/15m/1H/4H/1D) |
| after | String | 否 | 请求此时间戳之前的数据 |
| before | String | 否 | 请求此时间戳之后的数据 |
| limit | String | 否 | 返回数量，默认 100，最大 300 |

**响应:**
```json
{
  "code": "0",
  "data": [
    {
      "ts": "1704067200000",
      "o": "0.00000004",
      "h": "0.00000005",
      "l": "0.00000003",
      "c": "0.00000005",
      "vol": "100000000",
      "volCcy": "5",
      "confirm": "1"
    }
  ]
}
```

#### 获取最新成交

```http
GET /api/v1/market/trades
```

**参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| instId | String | 是 | 交易对ID |
| limit | String | 否 | 返回数量，默认 100，最大 500 |

**响应:**
```json
{
  "code": "0",
  "data": [
    {
      "tradeId": "1234567890",
      "instId": "MEME-BNB",
      "px": "0.00000005",
      "sz": "1000000",
      "side": "buy",
      "ts": "1704067200000"
    }
  ]
}
```

#### 获取订单簿

```http
GET /api/v1/market/books
```

**参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| instId | String | 是 | 交易对ID |
| sz | String | 否 | 深度档位，默认 20 |

**响应:**
```json
{
  "code": "0",
  "data": {
    "asks": [
      ["0.0000000505", "5000000", "1"],
      ["0.0000000510", "3000000", "2"]
    ],
    "bids": [
      ["0.0000000495", "3000000", "1"],
      ["0.0000000490", "2000000", "1"]
    ],
    "ts": "1704067200000"
  }
}
```

#### 获取资金费率

```http
GET /api/v1/public/funding-rate
```

**参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| instId | String | 是 | 交易对ID |

**响应:**
```json
{
  "code": "0",
  "data": {
    "instId": "MEME-BNB",
    "fundingRate": "0.0001",
    "nextFundingRate": "0.00015",
    "fundingTime": "1704081600000",
    "nextFundingTime": "1704096000000"
  }
}
```

---

### 账户接口 (需认证)

#### 获取账户余额

```http
GET /api/v1/account/balance
```

**响应:**
```json
{
  "code": "0",
  "data": {
    "totalEq": "100.5",
    "details": [
      {
        "ccy": "BNB",
        "availBal": "50.5",
        "frozenBal": "50",
        "ordFrozen": "30",
        "eq": "100.5",
        "uTime": "1704067200000"
      }
    ]
  }
}
```

#### 获取当前仓位

```http
GET /api/v1/account/positions
```

**参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| instId | String | 否 | 交易对ID |
| posId | String | 否 | 仓位ID |

**响应:**
```json
{
  "code": "0",
  "data": [
    {
      "posId": "pos123",
      "instId": "MEME-BNB",
      "mgnMode": "cross",
      "posSide": "long",
      "pos": "1000000",
      "notionalUsd": "0.05",
      "avgPx": "0.00000005",
      "markPx": "0.00000006",
      "liqPx": "0.000000025",
      "lever": "50",
      "margin": "0.001",
      "upl": "0.01",
      "uplRatio": "10",
      "pnl": "0",
      "cTime": "1704067200000",
      "uTime": "1704067200000"
    }
  ]
}
```

#### 获取账单流水

```http
GET /api/v1/account/bills
```

**参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| ccy | String | 否 | 币种 |
| type | String | 否 | 账单类型 |
| before | String | 否 | 分页参数 |
| after | String | 否 | 分页参数 |
| limit | String | 否 | 返回数量 |

**响应:**
```json
{
  "code": "0",
  "data": [
    {
      "billId": "bill123",
      "ccy": "BNB",
      "balChg": "-0.001",
      "bal": "99.999",
      "type": "trade",
      "instId": "MEME-BNB",
      "ordId": "order123",
      "ts": "1704067200000"
    }
  ]
}
```

---

### 交易接口 (需认证)

#### 下单

```http
POST /api/v1/trade/order
```

**请求体:**
```json
{
  "instId": "MEME-BNB",
  "tdMode": "cross",
  "side": "buy",
  "posSide": "long",
  "ordType": "market",
  "sz": "1000000",
  "px": "",
  "lever": "50",
  "reduceOnly": false,
  "clOrdId": "client123"
}
```

**参数说明:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| instId | String | 是 | 交易对ID |
| tdMode | String | 是 | 保证金模式 cross/isolated |
| side | String | 是 | buy/sell |
| posSide | String | 是 | long/short/net |
| ordType | String | 是 | market/limit/stop/take_profit/stop_loss |
| sz | String | 是 | 委托数量 |
| px | String | 否 | 委托价格 (limit 必填) |
| lever | String | 是 | 杠杆倍数 |
| reduceOnly | Boolean | 否 | 是否只减仓 |
| tpTriggerPx | String | 否 | 止盈触发价 |
| tpOrdPx | String | 否 | 止盈委托价 |
| slTriggerPx | String | 否 | 止损触发价 |
| slOrdPx | String | 否 | 止损委托价 |
| clOrdId | String | 否 | 客户端订单ID |

**响应:**
```json
{
  "code": "0",
  "data": {
    "ordId": "order123",
    "clOrdId": "client123",
    "sCode": "0",
    "sMsg": ""
  }
}
```

#### 平仓

```http
POST /api/v1/trade/close-position
```

**请求体:**
```json
{
  "instId": "MEME-BNB",
  "mgnMode": "cross",
  "posSide": "long",
  "clOrdId": "client123"
}
```

**响应:**
```json
{
  "code": "0",
  "data": {
    "instId": "MEME-BNB",
    "posSide": "long",
    "clOrdId": "client123"
  }
}
```

#### 撤单

```http
POST /api/v1/trade/cancel-order
```

**请求体:**
```json
{
  "instId": "MEME-BNB",
  "ordId": "order123"
}
```

**响应:**
```json
{
  "code": "0",
  "data": {
    "ordId": "order123",
    "clOrdId": "client123",
    "sCode": "0",
    "sMsg": ""
  }
}
```

#### 获取未成交订单

```http
GET /api/v1/trade/orders-pending
```

**参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| instId | String | 否 | 交易对ID |
| ordType | String | 否 | 订单类型 |
| state | String | 否 | 订单状态 |

**响应:**
```json
{
  "code": "0",
  "data": [
    {
      "ordId": "order123",
      "clOrdId": "client123",
      "instId": "MEME-BNB",
      "tdMode": "cross",
      "side": "buy",
      "posSide": "long",
      "ordType": "limit",
      "sz": "1000000",
      "px": "0.00000004",
      "lever": "50",
      "state": "open",
      "fillSz": "0",
      "avgPx": "",
      "fee": "0",
      "pnl": "0",
      "cTime": "1704067200000",
      "uTime": "1704067200000"
    }
  ]
}
```

#### 获取历史订单

```http
GET /api/v1/trade/orders-history
```

**参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| instId | String | 否 | 交易对ID |
| ordType | String | 否 | 订单类型 |
| state | String | 否 | 订单状态 |
| before | String | 否 | 分页参数 |
| after | String | 否 | 分页参数 |
| limit | String | 否 | 返回数量 |

---

### 内盘接口

#### 获取内盘列表

```http
GET /api/v1/presale/list
```

**参数:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| status | String | 否 | 状态过滤 |
| limit | String | 否 | 返回数量 |

**响应:**
```json
{
  "code": "0",
  "data": [
    {
      "presaleId": "presale123",
      "tokenName": "PEPE",
      "tokenSymbol": "PEPE",
      "tokenLogo": "https://...",
      "targetAmount": "50",
      "raisedAmount": "25.5",
      "progress": "51",
      "totalSupply": "1000000000",
      "status": "active",
      "startTime": "1704067200000",
      "endTime": "1704153600000"
    }
  ]
}
```

#### 获取内盘详情

```http
GET /api/v1/presale/:presaleId
```

**响应:**
```json
{
  "code": "0",
  "data": {
    "presaleId": "presale123",
    "tokenName": "PEPE",
    "tokenSymbol": "PEPE",
    "tokenLogo": "https://...",
    "description": "...",
    "targetAmount": "50",
    "raisedAmount": "25.5",
    "progress": "51",
    "totalSupply": "1000000000",
    "minSubscription": "0.1",
    "maxSubscription": "5",
    "status": "active",
    "startTime": "1704067200000",
    "endTime": "1704153600000",
    "subscriberCount": 100,
    "contractAddress": "",
    "creatorAddress": "0x..."
  }
}
```

#### 认购

```http
POST /api/v1/presale/subscribe
```

**请求体:**
```json
{
  "presaleId": "presale123",
  "amount": "1.5"
}
```

**响应:**
```json
{
  "code": "0",
  "data": {
    "subscriptionId": "sub123",
    "presaleId": "presale123",
    "amount": "1.5",
    "tokenAmount": "30000000"
  }
}
```

#### 退款

```http
POST /api/v1/presale/refund
```

**请求体:**
```json
{
  "presaleId": "presale123"
}
```

---

## WebSocket API

### 连接

```
wss://ws.meme-perp.io/ws/v1/public
wss://ws.meme-perp.io/ws/v1/private
```

### 订阅格式

```json
{
  "op": "subscribe",
  "args": [
    {
      "channel": "tickers",
      "instId": "MEME-BNB"
    }
  ]
}
```

### 取消订阅

```json
{
  "op": "unsubscribe",
  "args": [
    {
      "channel": "tickers",
      "instId": "MEME-BNB"
    }
  ]
}
```

### 心跳

```json
{
  "op": "ping"
}
```

响应:
```json
{
  "op": "pong",
  "ts": "1704067200000"
}
```

### 公共频道

#### 行情推送 (tickers)

```json
{
  "op": "subscribe",
  "args": [{"channel": "tickers", "instId": "MEME-BNB"}]
}
```

推送数据:
```json
{
  "arg": {"channel": "tickers", "instId": "MEME-BNB"},
  "data": [{
    "instId": "MEME-BNB",
    "last": "0.00000005",
    "lastSz": "1000000",
    "askPx": "0.0000000505",
    "bidPx": "0.0000000495",
    "open24h": "0.00000004",
    "high24h": "0.00000006",
    "low24h": "0.00000003",
    "vol24h": "1000000000",
    "volCcy24h": "50",
    "ts": "1704067200000"
  }]
}
```

#### K 线推送 (candle{bar})

```json
{
  "op": "subscribe",
  "args": [{"channel": "candle1m", "instId": "MEME-BNB"}]
}
```

推送数据:
```json
{
  "arg": {"channel": "candle1m", "instId": "MEME-BNB"},
  "data": [[
    "1704067200000",
    "0.00000004",
    "0.00000005",
    "0.00000003",
    "0.00000005",
    "100000000",
    "5",
    "0"
  ]]
}
```

#### 成交推送 (trades)

```json
{
  "op": "subscribe",
  "args": [{"channel": "trades", "instId": "MEME-BNB"}]
}
```

推送数据:
```json
{
  "arg": {"channel": "trades", "instId": "MEME-BNB"},
  "data": [{
    "tradeId": "1234567890",
    "px": "0.00000005",
    "sz": "1000000",
    "side": "buy",
    "ts": "1704067200000"
  }]
}
```

#### 深度推送 (books)

```json
{
  "op": "subscribe",
  "args": [{"channel": "books", "instId": "MEME-BNB"}]
}
```

推送数据:
```json
{
  "arg": {"channel": "books", "instId": "MEME-BNB"},
  "action": "snapshot",
  "data": [{
    "asks": [["0.0000000505", "5000000", "1"]],
    "bids": [["0.0000000495", "3000000", "1"]],
    "ts": "1704067200000"
  }]
}
```

#### 资金费率推送 (funding-rate)

```json
{
  "op": "subscribe",
  "args": [{"channel": "funding-rate", "instId": "MEME-BNB"}]
}
```

### 私有频道 (需认证)

#### 认证

```json
{
  "op": "login",
  "args": [{
    "apiKey": "your-api-key",
    "timestamp": "1704067200000",
    "sign": "signature"
  }]
}
```

或使用钱包签名:
```json
{
  "op": "login",
  "args": [{
    "address": "0x...",
    "timestamp": "1704067200000",
    "sign": "wallet-signature"
  }]
}
```

#### 仓位推送 (positions)

```json
{
  "op": "subscribe",
  "args": [{"channel": "positions", "instType": "PERP"}]
}
```

推送数据:
```json
{
  "arg": {"channel": "positions", "instType": "PERP"},
  "data": [{
    "posId": "pos123",
    "instId": "MEME-BNB",
    "posSide": "long",
    "pos": "1000000",
    "avgPx": "0.00000005",
    "markPx": "0.00000006",
    "liqPx": "0.000000025",
    "lever": "50",
    "margin": "0.001",
    "upl": "0.01",
    "pTime": "1704067200000"
  }]
}
```

#### 订单推送 (orders)

```json
{
  "op": "subscribe",
  "args": [{"channel": "orders", "instType": "PERP"}]
}
```

推送数据:
```json
{
  "arg": {"channel": "orders", "instType": "PERP"},
  "data": [{
    "ordId": "order123",
    "clOrdId": "client123",
    "instId": "MEME-BNB",
    "side": "buy",
    "posSide": "long",
    "ordType": "limit",
    "sz": "1000000",
    "px": "0.00000004",
    "state": "filled",
    "fillSz": "1000000",
    "avgPx": "0.00000004",
    "fee": "0.00001",
    "pnl": "0",
    "uTime": "1704067200000"
  }]
}
```

#### 账户推送 (account)

```json
{
  "op": "subscribe",
  "args": [{"channel": "account"}]
}
```

推送数据:
```json
{
  "arg": {"channel": "account"},
  "data": [{
    "totalEq": "100.5",
    "details": [{
      "ccy": "BNB",
      "availBal": "50.5",
      "frozenBal": "50",
      "eq": "100.5"
    }],
    "uTime": "1704067200000"
  }]
}
```

---

## 签名规范

### REST API 签名

1. 按字母顺序排序请求参数
2. 拼接为 `key=value&key=value` 格式
3. 使用私钥对拼接字符串进行 HMAC-SHA256 签名
4. 将签名转为 Base64

### WebSocket 签名

使用 EIP-712 签名:
```javascript
const message = {
  domain: {
    name: 'MEME Perp DEX',
    version: '1',
    chainId: 56
  },
  primaryType: 'Login',
  types: {
    Login: [
      { name: 'address', type: 'address' },
      { name: 'timestamp', type: 'uint256' }
    ]
  },
  message: {
    address: walletAddress,
    timestamp: Math.floor(Date.now() / 1000)
  }
};
```

---

## 限流规则

| 端点类型 | 限制 |
|----------|------|
| 公共市场数据 | 20 次/秒 |
| 账户查询 | 10 次/秒 |
| 下单接口 | 5 次/秒 |
| WebSocket | 每连接 10 条/秒 |

超过限制返回错误码 `50004`。
