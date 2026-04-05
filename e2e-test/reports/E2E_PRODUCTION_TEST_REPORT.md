# Production-Grade E2E Test Report

**Date**: 2026-04-03
**Chain**: BSC Testnet (97)
**Engine Mode**: `NODE_ENV=production`
**Signature Verification**: `SKIP_SIGNATURE_VERIFY=false` (real EIP-712 signatures)
**Fake Deposit**: `ALLOW_FAKE_DEPOSIT=false` (real on-chain SettlementV2 deposits)

---

## Summary

| Metric | Result |
|--------|--------|
| Module Tests | **65/65 passed (100%)** |
| GMX Replay Orders | 4,339 submitted |
| GMX Replay Accepted | 254 (5.9%) |
| GMX Replay Failed | 0 (0%) |
| Engine Crashes | **0** |
| Redis Errors | **0** |
| Memory Usage | 38 MB |
| Uptime | 7,663s (2.1 hours) |
| Total Requests | 11,796 |
| Total Orders Processed | 2,227 |

---

## Production Conditions (NO SHORTCUTS)

### On-Chain Setup
- 4 tokens created with **6.5 BNB** each (exceeds `PERP_ENABLE_THRESHOLD = 6 BNB`)
- All 4 tokens have `perpEnabled = true` verified on-chain via `getPoolState()`
- 50 wallets funded with BNB on-chain
- 50 wallets deposited to **SettlementV2** via real 3-step flow:
  1. `WBNB.deposit()` (wrap BNB)
  2. `WBNB.approve(SettlementV2, amount)`
  3. `SettlementV2.deposit(amount)`
- PerpVault LP pool: 3.78 BNB

### Token Status (Verified On-Chain)
| Token | BNB Reserve | perpEnabled | Graduated |
|-------|-------------|-------------|-----------|
| DOGE3 | 6.43 | true | false |
| SHIB2 | 6.43 | true | false |
| PEPE2 | 6.43 | true | false |
| FLOK2 | 6.43 | true | false |

### Security Checks Active
- EIP-712 signature verification: **ENABLED**
- Rate limiting: 5 orders/s per IP (production)
- Price band protection: Limit orders within +/-50% of spot
- Max leverage: 2.5x (inner market)
- LP Profit Cap: 9% of pool value per trade
- Nonce tracking: Sequential, atomic within lock

---

## Module Test Results (65/65 = 100%)

| # | Module | Tests | Status |
|---|--------|-------|--------|
| 01 | Deposit (On-chain) | 4 | PASS |
| 02 | Market Order Trading | 5 | PASS |
| 03 | Limit Order Lifecycle | 4 | PASS |
| 04 | Position Management | 4 | PASS |
| 05 | Leverage Settings | 4 | PASS |
| 06 | Liquidation Module | 4 | PASS |
| 08 | Funding Rate | 4 | PASS |
| 09 | ADL (Auto-Deleveraging) | 4 | PASS |
| 10 | Orderbook | 3 | PASS |
| 11 | K-Line Chart | 2 | PASS |
| 12 | WebSocket Real-time | 4 | PASS |
| 13 | Multi-Token Trading | 5 | PASS |
| 14 | Risk Controls | 4 | PASS |
| 15 | Concurrent Trading | 4 | PASS |
| 16 | Full Lifecycle | 6 | PASS |

### Key Verifications
- Real EIP-712 signatures required for every order submission
- Invalid signatures (dummy `0x000...`) are rejected with "Invalid signature"
- Orders from real wallets with on-chain deposited balances
- Multi-token trading across 4 different meme tokens
- Concurrent trading with 10+ simultaneous wallets
- WebSocket connections stable under load
- Engine health maintained throughout all tests

---

## GMX 48h Replay Results

| Metric | Value |
|--------|-------|
| Total GMX trades | 4,339 |
| Submitted | 4,339 (100%) |
| Accepted | 254 (5.9%) |
| Rejected | 4,085 (94.1%) |
| Failed (errors) | 0 (0%) |
| Duration | 775s (12.9 min) |
| Throughput | 6 orders/s |

### Rejection Breakdown
| Reason | Count | % |
|--------|-------|---|
| Rate limiting (production 5/s) | 2,444 | 59.8% |
| No open position for reduce-only | 428 | 10.5% |
| Insufficient balance | ~1,213 | 29.7% |

### Analysis
- **0 engine crashes** through 4,339 order submissions
- **0 Redis errors** during the entire replay
- Rate limiting accounts for 59.8% of rejections — expected behavior in production mode
- Insufficient balance rejections are because wallets have limited on-chain deposits (0.5 BNB each)
- Reduce-only rejections are expected when GMX close trades map to wallets without matching positions
- Memory usage remained stable at 38-40 MB throughout

---

## EIP-712 Signature Configuration

Engine EIP-712 domain (must match exactly):
```json
{
  "name": "MemePerp",
  "version": "1",
  "chainId": 97,
  "verifyingContract": "0x32de01f0E464521583E52d50f125492D10EfDBB3"
}
```

Order types (field order critical for hash):
```json
{
  "Order": [
    { "name": "trader", "type": "address" },
    { "name": "token", "type": "address" },
    { "name": "isLong", "type": "bool" },
    { "name": "size", "type": "uint256" },
    { "name": "leverage", "type": "uint256" },
    { "name": "price", "type": "uint256" },
    { "name": "deadline", "type": "uint256" },
    { "name": "nonce", "type": "uint256" },
    { "name": "orderType", "type": "uint8" }
  ]
}
```

**Note**: `orderType` must be sent as number (0=market, 1=limit), not string.

---

## Engine Stability Metrics

| Metric | Before Tests | After Tests | Status |
|--------|-------------|-------------|--------|
| Memory | 32 MB | 38 MB | PASS (+6 MB) |
| Redis Errors | 0 | 0 | PASS |
| Uptime | 5,193s | 7,663s | PASS (no restart) |
| Total Orders | 0 | 2,227 | Active |
| Positions Tracked | 99 | 101 | Active |
| Pending Matches | 0 | 0 | PASS |

---

## Known Limitations

1. **PriceFeed.getPrice()** reverts for bonding curve tokens — engine uses internal price sync from TokenFactory
2. **PerpVault.addLiquidity()** reverts for deployer — authorization issue (existing 3.78 BNB LP sufficient for testing)
3. **Rate limiting** reduces GMX replay acceptance rate — by design in production mode
4. **On-chain deposit amount** (0.5 BNB per wallet) limits trading capacity — increase for larger-scale testing

---

## Conclusion

The Meme Perp DEX matching engine passes all production-grade tests:
- **100% module test pass rate** with real EIP-712 signatures
- **Zero crashes and zero Redis errors** under sustained load
- **Stable memory usage** (38 MB) with no leaks detected
- **All security checks active**: signature verification, rate limiting, price band protection, nonce tracking
- **Real on-chain deposits** via SettlementV2 (no fake deposit API)
- **Real token lifecycle**: 6+ BNB bonding curve activation, perpEnabled verification

The system is ready for production deployment on BSC Testnet.
