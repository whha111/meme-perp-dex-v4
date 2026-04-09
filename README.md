# DEXI

> AI-Built Perpetual DEX for Meme Tokens on BNB Chain

[![Solidity](https://img.shields.io/badge/Solidity-0.8.20-blue)](https://soliditylang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-14-black)](https://nextjs.org/)
[![BSC](https://img.shields.io/badge/Chain-BSC%20Testnet%2097-F0B90B)](https://www.bnbchain.org/)
[![Audits](https://img.shields.io/badge/Audits-4%20Passed-brightgreen)]()
[![Tests](https://img.shields.io/badge/Tests-373%20Passing-brightgreen)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## What is DEXI?

DEXI is the first perpetual contract DEX purpose-built for meme tokens. While platforms like dYdX, GMX, and Hyperliquid focus on BTC/ETH, thousands of meme tokens with high volatility have zero derivatives infrastructure. We fill that gap.

**Built entirely by a solo non-developer founder using AI** — 15 smart contracts, a 12,000+ line matching engine, Go backend, and Next.js frontend — all created with AI-assisted development and validated through 4 independent security audits with all 194 issues resolved.

### Key Features

- **Permissionless Perp Markets** — TokenFactory lets anyone launch a meme token and instantly create a perpetual contract market for it
- **CEX-Grade Speed, DEX-Grade Security** — Off-chain matching engine (12,000+ lines TypeScript/Bun) with on-chain settlement via SettlementV2
- **Full Risk Infrastructure** — Liquidation engine, insurance fund, funding rate mechanism, LP vault (PerpVault), price band protection
- **Escape Hatch** — Users can always withdraw funds on-chain even if the off-chain system goes down
- **Integrated Spot + Derivatives** — Token launch, spot trading, and perpetual contracts in one platform

---

## Architecture: Simplified dYdX v3

```
User places order -> Signs EIP-712 typed data (gasless)
                          |
              Off-chain Matching Engine (TypeScript/Bun)
                          |
              Positions managed in Redis + PnL settlement
                          |
              PerpVault (LP pool + OI tracking + insurance fund)
                          |
              Merkle snapshot -> SettlementV2.updateStateRoot()
                          |
              User withdrawal -> Merkle proof + EIP-712 sig -> SettlementV2.withdraw()
```

> Inspired by dYdX v3's hybrid architecture and GMX's PnL calculation model.

---

## Project Structure

```
meme-perp-dex/
├── contracts/                 # Solidity smart contracts (Foundry)
│   ├── src/
│   │   ├── common/            # Shared: PriceFeed, Vault, ContractRegistry
│   │   ├── perpetual/         # V2: SettlementV2, PerpVault, Liquidation
│   │   └── spot/              # TokenFactory, LendingPool
│   ├── test/                  # Foundry tests (373 passing)
│   └── script/                # Deployment scripts
│
├── frontend/                  # Next.js 14 frontend
│   ├── src/
│   │   ├── app/               # Pages: trade, create, earnings, wallet
│   │   ├── components/        # UI: common, spot, perpetual, referral
│   │   ├── hooks/             # React hooks: common, spot, perpetual
│   │   ├── lib/               # Contracts config, stores, utilities
│   │   └── config/            # API endpoints
│   └── messages/              # i18n: en, zh, ja, ko
│
├── backend/
│   ├── src/matching/          # TypeScript matching engine (Bun, 12000+ lines)
│   ├── src/spot/              # Spot trading backend
│   └── internal/              # Go backend: API + Keeper (liquidation, funding)
│
├── stress-test/               # 400-wallet soak test + liquidation verification
├── scripts/                   # Market maker, deployment, E2E test scripts
├── docs/                      # Documentation (audit reports, architecture)
└── docker-compose.yml         # PostgreSQL + Redis + services
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Smart Contracts** | Solidity 0.8.20, Foundry, OpenZeppelin |
| **Frontend** | Next.js 14, TypeScript, Wagmi v2, Viem, TailwindCSS |
| **State Management** | TanStack Query, Zustand 5 |
| **Matching Engine** | TypeScript + Bun runtime, WebSocket, Redis |
| **Backend Services** | Go 1.22+, Gin, GORM |
| **Database** | PostgreSQL + Redis |
| **Chain** | BSC Testnet (Chain ID 97) |
| **Charts** | TradingView Lightweight Charts |
| **i18n** | next-intl (EN, ZH, JA, KO) |

---

## Smart Contracts

### Core Contracts

| Contract | Description |
|----------|-------------|
| `SettlementV2.sol` | User WBNB custody + Merkle proof withdrawal + escape hatch |
| `PerpVault.sol` | LP pool + insurance fund + OI management |
| `TokenFactory.sol` | Meme token launchpad with bonding curve |
| `Liquidation.sol` | Position liquidation + ADL |
| `FundingRate.sol` | 8-hour funding rate settlement |
| `PriceFeed.sol` | Oracle price feed for all supported tokens |
| `InsuranceFund.sol` | Protocol insurance fund |
| `RiskManager.sol` | Risk parameter management |
| `ContractRegistry.sol` | Contract address registry |

### Key Design Decisions

- **PnL Calculation**: GMX standard — `delta = size * |currentPrice - avgPrice| / avgPrice`
- **Liquidation Price**: Bybit standard — `liqPrice = entryPrice * (1 - 1/leverage + MMR)`
- **Funding Rate**: 8-hour settlement intervals with configurable base rate
- **Fee Structure**: Taker 0.05% (5bp) / Maker 0.03% (3bp)
- **LP Profit Cap**: Max single-trade profit = LP pool value × 9%
- **Price Band**: Limit orders rejected if >±50% from spot price
- **Slippage Protection**: Mandatory `minAmountOut` on all swap/trade functions

### Deployed Contracts (BSC Testnet — 2026-03-27)

| Contract | Address |
|----------|---------|
| TokenFactory | `0xB40541Ff9f24883149fc6F9CD1021dB9C7BCcB83` |
| SettlementV2 | `0xF83D5d2E437D0e27144900cb768d2B5933EF3d6b` |
| PerpVault | `0xF0db95eD967318BC7757A671399f0D4FFC853e05` |
| PriceFeed | `0xB480517B96558E4467cfa1d91d8E6592c66B564D` |
| PositionManager | `0x50d3e039Efe373D9d52676D482E732FD9C411b05` |
| Vault | `0x7a88347Be6A9f290a55dcAd8592163E545F05e2a` |
| Liquidation | `0x5B829938d245896CAb443e30f1502aBF54312265` |
| FundingRate | `0x3A136b4Fbc8E4145F31D9586Ae9abDe9f47c7B83` |
| InsuranceFund | `0xa20488Ed2CEABD0e6441496c2F4F5fBA18F4cE83` |
| RiskManager | `0x19C763600D8cD61CCF85Ff8d00D4D5e06914F12c` |
| ContractRegistry | `0x0C6605b820084e43d0708943d15b1c681f2bCac1` |
| WBNB | `0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd` |
| PancakeRouter V2 | `0xD99D1c33F9fC3444f8101754aBC46c52416550D1` |

> Source of truth: `deployments/97.json`

---

## Quick Start

### Prerequisites

- Bun runtime (for matching engine)
- Node.js 18+ & pnpm (for frontend)
- Foundry (`curl -L https://foundry.paradigm.xyz | bash`)
- Go 1.22+ (for keeper services)
- Docker (for PostgreSQL + Redis)

### Install

```bash
# Clone
git clone https://github.com/whha111/meme-perp-dex-v4.git
cd meme-perp-dex-v4

# Start infrastructure
docker-compose up -d  # PostgreSQL + Redis

# Contracts
cd contracts && forge install && forge build

# Frontend
cd frontend && pnpm install

# Matching Engine
cd backend/src/matching && bun install
```

### Development

```bash
# Start matching engine
cd backend/src/matching && bun run server.ts

# Start frontend dev server
cd frontend && pnpm dev

# Start Go backend
cd backend && go run cmd/server/main.go

# Run contract tests
cd contracts && forge test -vvv
```

---

## Security & Audits

Four rounds of independent audits completed. **All 194 issues identified and resolved.**

| Audit | Date | Scope | Findings | Status | Report |
|-------|------|-------|----------|--------|--------|
| V1 Architecture | 2026-03-01 | Fund flow, on/off-chain consistency | 48 | All Fixed | [Report](docs/ISSUES_AUDIT_REPORT.md) |
| V2 Code Review | 2026-03-03 | Line-by-line code review, security | 75 | All Fixed | [Report](docs/CODE_REVIEW_V2.md) |
| V3 Full Audit | 2026-03-04 | Full-stack audit + fix verification | 56 | All Fixed | [Report](docs/AUDIT_V3_FULL.md) |
| V4 Industry Benchmark | 2026-03-31 | Benchmark vs. mature exchanges + bugs | 15 | All Fixed | [Report](docs/V4_INDUSTRY_BENCHMARK.md) |

**Total: 194 issues found across 4 audits → 194/194 resolved (0 remaining)**

Key security features:
- CEI (Checks-Effects-Interactions) pattern enforced across all contracts
- Merkle proof withdrawal system
- Escape hatch mechanism for user fund safety
- Insurance fund for socialized loss coverage
- 373 contract tests passing

See [DEVELOPMENT_RULES.md](DEVELOPMENT_RULES.md) for development standards and complete fix history.

---

## Environment Variables

See `.env.example` for a complete template. Key variables:

```bash
# Frontend (.env.local)
NEXT_PUBLIC_MATCHING_ENGINE_URL=http://localhost:8081
NEXT_PUBLIC_API_URL=http://localhost:8080
NEXT_PUBLIC_CHAIN_ID=97
NEXT_PUBLIC_SETTLEMENT_ADDRESS=0xF83D5d2E437D0e27144900cb768d2B5933EF3d6b

# Matching Engine (.env)
RPC_URL=https://data-seed-prebsc-1-s1.binance.org:8545/
CHAIN_ID=97
SETTLEMENT_ADDRESS=0xF83D5d2E437D0e27144900cb768d2B5933EF3d6b
MATCHER_PRIVATE_KEY=0x...
```

> **Warning**: Never commit `.env` files. See `.gitignore` for excluded patterns.

---

## Documentation

| Document | Description |
|----------|-------------|
| [DEVELOPMENT_RULES.md](DEVELOPMENT_RULES.md) | Development standards, formulas, audit fix log |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture overview |
| [docs/SETTLEMENT_DESIGN.md](docs/SETTLEMENT_DESIGN.md) | V2 Settlement dYdX-style design |
| [docs/API_SPECIFICATION_V2.md](docs/API_SPECIFICATION_V2.md) | V2 API specification |
| [docs/AUDIT_V3_FULL.md](docs/AUDIT_V3_FULL.md) | V3 full codebase audit |
| [docs/V4_INDUSTRY_BENCHMARK.md](docs/V4_INDUSTRY_BENCHMARK.md) | V4 industry benchmark audit |
| [docs/PRD.md](docs/PRD.md) | Product Requirements Document |

---

## The AI-Native Story

This entire platform was built by a solo non-developer founder using AI as the primary development tool. No traditional coding experience — just deep domain knowledge of derivatives trading and persistent iteration with AI assistants over months of development.

The result: a production-grade perpetual DEX with 15 smart contracts, 12,000+ line matching engine, and 4 passed security audits — proving that AI-native development can produce institutional-quality DeFi infrastructure.

---

## Repository History

This is the latest active repository. The project went through multiple iterations during development, with each version representing a major architectural milestone:

| Version | Repository | Description |
|---------|-----------|-------------|
| V1 | [meme-perp-dex](https://github.com/whha111/meme-perp-dex) | Initial architecture — smart contracts + basic matching engine |
| V2 | [meme-perp-dex-v2](https://github.com/whha111/meme-perp-dex-v2) | SettlementV2 + Merkle proof withdrawal + PerpVault LP pool |
| V3 | [meme-perp-dex-v3](https://github.com/whha111/meme-perp-dex-v3) | Full-stack audit fixes (56/56 resolved) + stress testing |
| **V4 (Current)** | [meme-perp-dex-v4](https://github.com/whha111/meme-perp-dex-v4) | Industry benchmark fixes + production deployment + DEXI rebrand |

**Why migrate?** Each version involved significant architectural changes (contract redesigns, new settlement system, security hardening) that warranted a clean repository to maintain clear git history and avoid confusion during audits. All historical code and commit history is preserved in the previous repositories for reference.

---

## License

MIT License - See [LICENSE](LICENSE) for details.
