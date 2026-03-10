# 数据架构标准 - WebSocket vs HTTP 明确规范

> **强制执行**: 每次修改数据获取逻辑前必须先查阅此文件
> **最后更新**: 2026-02-01
>
> **⚠️ 2026-03-01**: 撮合引擎 WebSocket/HTTP 返回的余额数据包含虚拟 mode2Adj，非链上真实值。
> 详见 `docs/ISSUES_AUDIT_REPORT.md`
> **来源**: PERP_PAGE_DATA_GUIDE.md 第七章

---

## ⚠️ 核心原则

1. **实时性数据** (<1秒延迟) → WebSocket 推送
2. **统计性数据** (可接受30秒延迟) → HTTP REST API 定时拉取
3. **配置性数据** (很少变化) → HTTP REST API 按需拉取或区块链读取

---

## 一、✅ 必须用 WebSocket 推送的数据

| 数据类型 | 延迟要求 | 更新频率 | 原因 |
|---------|---------|---------|------|
| **订单簿** | 实时 | 毫秒级 | 价格变化需要即时反映 |
| **最新成交** | 实时 | 毫秒级 | 用户需要看到最新交易 |
| **K线图实时更新** | <100ms | 实时 | 每笔交易都要更新当前K线 |
| **仓位盈亏** | <100ms | 实时 | 用户需要实时看到赚亏 |
| **风险警报** | 实时 | 触发时 | 爆仓警告必须即时 |
| **标记价格** | 实时 | 毫秒级 | 强平计算依赖实时价格 |

### WebSocket 实现规范

```typescript
// ✅ 正确示例: K线图 WebSocket 推送
import { useWebSocketKlines } from "@/hooks/useWebSocketKlines";

const { klines, chartData } = useWebSocketKlines(token, interval, 200);

useEffect(() => {
  // 1. 初始加载历史数据 (HTTP REST API, 仅一次)
  // 2. 订阅 WebSocket 实时推送
  // 3. 自动合并更新
}, [token, interval]);
```

```typescript
// ✅ 正确示例: 订单簿 WebSocket 推送
useEffect(() => {
  const ws = getWebSocketClient();
  ws.subscribe('orderbook', token, (data) => {
    setOrderBook(data);
  });
  return () => ws.unsubscribe('orderbook', token);
}, [token]);
```

---

## 二、✅ 必须用 HTTP REST API 的数据

| 数据类型 | 更新频率 | 接口路径 | 原因 |
|---------|---------|---------|------|
| **24小时统计** | 每30秒 | `/api/stats/:token` | 统计数据，30秒延迟可接受 |
| **资金费率** | 每30秒 | `/api/funding/:token` | 每8小时结算，30秒延迟足够 |
| **我的订单列表** | 每5秒 | `/api/user/:address/orders` | 低频操作，5秒延迟可接受 |
| **猎杀场热力图** | 每5秒 | `/api/liquidation-heatmap/:token` | 统计分析，不需要实时 |
| **猎杀场全部持仓** | 每3秒 | `/api/hunting/positions/:token` | 展示用，3秒延迟可接受 |
| **猎手排行榜** | 每10秒 | `/api/hunters` | 排行榜，10秒延迟足够 |
| **账户余额** | 按需 | `/api/user/:address/balance` | 用户主动查询，不需要轮询 |
| **K线历史数据** | 初始加载 | `/api/kline/:token` | 仅用于首次加载，之后用WebSocket |

### HTTP REST API 实现规范

```typescript
// ✅ 正确示例: 24小时统计 HTTP 轮询
const { data: tokenStats } = useQuery({
  queryKey: ["tokenStats24h", token],
  queryFn: async () => {
    const res = await fetch(`${API_URL}/api/stats/${token}`);
    return res.json();
  },
  staleTime: 30000, // 30秒刷新一次
  refetchInterval: 30000, // 自动轮询
});
```

```typescript
// ✅ 正确示例: 资金费率 HTTP 轮询
const { data: fundingRate } = useQuery({
  queryKey: ["fundingRate", token],
  queryFn: async () => {
    const res = await fetch(`${API_URL}/api/funding/${token}`);
    return res.json();
  },
  staleTime: 30000,
  refetchInterval: 30000,
});
```

---

## 三、✅ 必须从区块链直接读取的数据

| 数据类型 | 更新时机 | 原因 |
|---------|---------|------|
| **代币基本信息** | 页面加载时 | name, symbol, decimals |
| **永续合约状态** | 页面加载时 | perpEnabled |
| **现货价格** | 页面加载时 | TokenFactory 池子价格 |

### 区块链读取实现规范

```typescript
// ✅ 正确示例: 从区块链读取代币信息
const { data: tokenInfo } = useReadContract({
  address: tokenAddress,
  abi: ERC20_ABI,
  functionName: 'name',
});

const { data: perpEnabled } = useReadContract({
  address: POSITION_MANAGER_ADDRESS,
  abi: POSITION_MANAGER_ABI,
  functionName: 'isPerpEnabled',
  args: [tokenAddress],
});
```

---

## 四、❌ 常见错误示例

### 错误 1: 用 HTTP 轮询实时数据

```typescript
// ❌ 错误: K线用 HTTP 轮询
setInterval(async () => {
  const res = await fetch(`/api/kline/${token}`);
  const data = await res.json();
  updateChart(data);
}, 5000); // 5秒延迟太大！

// ✅ 正确: K线用 WebSocket
const { klines } = useWebSocketKlines(token, interval);
```

### 错误 2: 用 WebSocket 推送统计数据

```typescript
// ❌ 错误: 24小时统计用 WebSocket
ws.subscribe('stats24h', token); // 不需要实时推送！

// ✅ 正确: 24小时统计用 HTTP
useQuery({
  queryKey: ['stats', token],
  queryFn: () => fetch(`/api/stats/${token}`),
  staleTime: 30000,
});
```

### 错误 3: 重复实现已有功能

```typescript
// ❌ 错误: 已有 useWebSocketKlines 还重复写
const [klines, setKlines] = useState([]);
useEffect(() => {
  const ws = new WebSocket('...');
  ws.onmessage = (e) => {
    // 重复实现 K线推送逻辑！
  };
}, []);

// ✅ 正确: 直接用已有的 Hook
const { klines } = useWebSocketKlines(token, interval);
```

---

## 五、检查清单

### 修改前必须检查

```
□ 这个数据是否需要实时性 (<1秒)?
  ├─ 是 → 使用 WebSocket 推送
  └─ 否 → 使用 HTTP REST API

□ 这个功能是否已经实现?
  ├─ 是 → 直接调用已有 Hook/函数
  └─ 否 → 继续

□ 是否查阅了 PERP_PAGE_DATA_GUIDE.md?
  ├─ 是 → 确认数据更新方式
  └─ 否 → 立即查阅!

□ 是否查阅了现有代码?
  ├─ useWebSocketKlines - K线 WebSocket
  ├─ useUnifiedWebSocket - 统一 WebSocket 管理
  ├─ useQuery - HTTP REST API 数据
  └─ useReadContract - 区块链读取
```

---

## 六、现有实现清单

### 已实现的 WebSocket Hooks

| Hook 文件 | 功能 | 使用示例 |
|----------|------|---------|
| `useWebSocketKlines.ts` | K线实时推送 | `const { klines } = useWebSocketKlines(token, '1m')` |
| `useUnifiedWebSocket.ts` | 统一 WebSocket 管理 | `const { subscribe, unsubscribe } = useUnifiedWebSocket()` |

### 已实现的 HTTP Hooks

| Hook 文件 | 功能 | 使用示例 |
|----------|------|---------|
| `useTokenStats.ts` | 代币统计 | `const { stats } = useTokenStats(token)` |
| `useFundingRate.ts` | 资金费率 | `const { rate } = useFundingRate(token)` |

### 已实现的区块链 Hooks

| Hook 文件 | 功能 | 使用示例 |
|----------|------|---------|
| `useTokenList.ts` | 代币列表 | `const { tokens } = useOnChainTokenList()` |
| `usePerpetualV2.ts` | 永续合约 | `const { positions } = usePerpetualV2(token)` |

---

## 七、修复记录

### 2026-02-01 - 创建此文档

**原因**: Claude 多次混淆 WebSocket 推送和 HTTP 轮询的使用场景

**问题**:
1. ❌ K线用 HTTP 轮询 (应该用 WebSocket)
2. ❌ 24小时统计想改成 WebSocket (应该用 HTTP)
3. ❌ 重复实现已有功能

**解决**:
1. ✅ 创建此标准文档明确规范
2. ✅ 列出所有数据的更新方式
3. ✅ 提供检查清单防止再犯

---

## 八、强制执行流程

### 每次修改数据获取逻辑前:

1. **阅读此文件**
2. **查阅 PERP_PAGE_DATA_GUIDE.md 第七章**
3. **检查是否已有实现** (搜索 `use*.ts` 文件)
4. **确认数据更新方式** (WebSocket/HTTP/区块链)
5. **按规范实现**
6. **不要自己发明新方法**

---

**文档所有者**: Claude Opus 4.5
**强制执行**: 是
**违反后果**: 立即回滚代码并重新学习此文档
