# MEME Perp DEX

> Decentralized Perpetual Futures & Spot Trading Platform for Meme Tokens

[![Solidity](https://img.shields.io/badge/Solidity-0.8.20-blue)](https://soliditylang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-14-black)](https://nextjs.org/)
[![BSC](https://img.shields.io/badge/Chain-BSC%20Testnet%2097-F0B90B)](https://www.bnbchain.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## Overview

MEME Perp DEX is a full-stack decentralized exchange that combines:

- **Meme Token Launchpad** — Create and trade meme tokens via bonding curve (TokenFactory)
- **Perpetual Futures (V2)** — Up to 10x leverage with P2P order matching and EIP-712 signed orders
- **Spot AMM Trading** — Automated market making with real-time price feeds

### Architecture: Simplified dYdX v3

```
User places order -> Signs EIP-712 typed data (gasless)
                          |
              Off-chain Matching Engine (TypeScript/Bun)
                          |
              Positions managed in Redis + mode2PnLAdjustments
                          |
              PerpVault (LP pool + OI tracking + insurance fund)
                          |
              Merkle snapshot -> SettlementV2.updateStateRoot()
                          |
              User withdrawal -> Merkle proof + EIP-712 sig -> SettlementV2.withdraw()
```

> Inspired by dYdX v3's signature-derived trading wallet pattern and GMX's PnL calculation model.

---

## Project Structure

```
meme-perp-dex/
├── contracts/                 # Solidity smart contracts (Foundry)
│   ├── src/
│   │   ├── common/            # Shared: PriceFeed, Vault, ContractRegistry
│   │   ├── perpetual/         # V2: SettlementV2, PerpVault, Liquidation
│   │   └── spot/              # TokenFactory, LendingPool
│   ├── test/                  # Foundry tests
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
│   ├── src/matching/          # TypeScript matching engine (Bun, 13000+ lines)
│   ├── src/spot/              # Spot trading backend
│   └── internal/              # Go backend: API + Keeper (liquidation, funding)
│
├── stress-test/               # 400-wallet soak test + liquidation verification
├── scripts/                   # Market maker, deployment, E2E test scripts
├── docs/                      # Documentation (audit reports, architecture)
├── DEVELOPMENT_RULES.md       # Development standards & audit fixes
├── CLAUDE.md                  # AI assistant instructions
└── docker-compose.yml         # PostgreSQL + Redis + services
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Smart Contracts** | Solidity 0.8.20, Foundry, OpenZeppelin |
| **Frontend** | Next.js 14, TypeScript, Wagmi v2, Viem, TailwindCSS |
| **State Management** | TanStack Query, Zustand 5 |
| **Matching Engine** | TypeScript + Bun runtime, WebSocket |
| **Backend Services** | Go 1.22+, Gin, GORM |
| **Database** | PostgreSQL + Redis |
| **Chain** | BSC Testnet (Chain ID 97) |
| **Charts** | TradingView Lightweight Charts |
| **i18n** | next-intl (EN, ZH, JA, KO) |

---

## Smart Contracts

### Core Contracts (V2 - Active)

| Contract | Description |
|----------|-------------|
| `SettlementV2.sol` | User WBNB custody + Merkle proof withdrawal |
| `PerpVault.sol` | LP pool + insurance fund + OI management |
| `TokenFactory.sol` | Meme token launchpad with bonding curve |
| `Liquidation.sol` | Position liquidation + ADL |
| `PriceFeed.sol` | Oracle price feed for all supported tokens |
| `Vault.sol` | Shared asset vault |

### Key Design Decisions

- **PnL Calculation**: GMX standard — `delta = size * |currentPrice - avgPrice| / avgPrice`
- **Liquidation Price**: Bybit standard — `liqPrice = entryPrice * (1 - 1/leverage + MMR)`
- **Funding Rate**: 8-hour settlement intervals with configurable base rate
- **Slippage Protection**: Mandatory `minAmountOut` on all swap/trade functions

### Deployed Contracts (BSC Testnet)

| Contract | Address |
|----------|---------|
| SettlementV2 | `0x7fF9d60aE49F14bB604FeF1961910D7931067873` |
| PerpVault | `0x7F98ed779c3352f39b041C57d5B2C73F84dcAA75` |
| TokenFactory | `0x22276744bAF24eD503dB50Cc999a9c5AD62728cb` |
| PriceFeed | `0xe2b22673fFBeB7A2a4617125E885C12EC072ee48` |
| WBNB | `0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd` |

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
git clone https://github.com/whha111/meme-perp-dex.git
cd meme-perp-dex

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

# Run contract tests
cd contracts && forge test -vvv
```

---

## Security & Audits

Three rounds of internal audits have been completed:

| Audit | Date | Findings | Report |
|-------|------|----------|--------|
| V1 Architecture | 2026-03-01 | 48 (35 fixed) | [ISSUES_AUDIT_REPORT.md](docs/ISSUES_AUDIT_REPORT.md) |
| V2 Code Review | 2026-03-03 | 75 (8 fixed) | [CODE_REVIEW_V2.md](docs/CODE_REVIEW_V2.md) |
| V3 Full Audit | 2026-03-04 | 56 remain / 25+ fixed | [AUDIT_V3_FULL.md](docs/AUDIT_V3_FULL.md) |

See [DEVELOPMENT_RULES.md](DEVELOPMENT_RULES.md) for development standards and fix history.

---

## Documentation

| Document | Description |
|----------|-------------|
| [DEVELOPMENT_RULES.md](DEVELOPMENT_RULES.md) | Development standards, formulas, audit fix log |
| [docs/AUDIT_V3_FULL.md](docs/AUDIT_V3_FULL.md) | V3 full codebase audit (latest) |
| [docs/SETTLEMENT_DESIGN.md](docs/SETTLEMENT_DESIGN.md) | V2 Settlement dYdX-style design |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture overview |
| [docs/API_SPECIFICATION_V2.md](docs/API_SPECIFICATION_V2.md) | V2 API specification |

---

## Environment Variables

```bash
# Frontend (.env.local)
NEXT_PUBLIC_MATCHING_ENGINE_URL=http://localhost:8081
NEXT_PUBLIC_API_URL=http://localhost:8080
NEXT_PUBLIC_CHAIN_ID=97
NEXT_PUBLIC_SETTLEMENT_ADDRESS=0x7fF9d60aE49F14bB604FeF1961910D7931067873

# Matching Engine (.env)
RPC_URL=https://data-seed-prebsc-1-s1.binance.org:8545/
CHAIN_ID=97
SETTLEMENT_ADDRESS=0x7fF9d60aE49F14bB604FeF1961910D7931067873
MATCHER_PRIVATE_KEY=0x...
```

> **Warning**: Never commit `.env` files. See `.gitignore` for excluded patterns.

---

## License

MIT License - See [LICENSE](LICENSE) for details.
