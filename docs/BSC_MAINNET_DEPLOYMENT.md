# BSC Mainnet Deployment Guide

> MemePerp DEX - Full Deployment to BSC Mainnet (Chain ID: 56)

## Overview

| Item | Detail |
|------|--------|
| Chain | BSC Mainnet (56) |
| Contracts | 12 Solidity contracts |
| Total Gas | ~40.6M gas |
| Gas Price | ~0.18 Gwei (current) |
| Deploy Cost | **~0.008 BNB** (pure gas) |
| Model | P2P (no LP seed required) |

---

## Prerequisites

### 1. Tools

```bash
# Foundry (Solidity compiler + deployer)
curl -L https://foundry.paradigm.xyz | bash
foundryup

# Node.js 18+ (matching engine)
node --version  # >= 18.0.0

# Docker + Docker Compose (production services)
docker --version
docker compose version
```

### 2. Accounts & Keys

| Item | Description |
|------|-------------|
| **Deployer Wallet** | 持有 BNB 的 EOA 钱包 (MetaMask 导出私钥) |
| **Keeper Wallet** | 撮合引擎专用钱包 (建议单独一个地址) |
| **Fee Receiver** | 手续费接收地址 (可以和 Deployer 相同) |
| **BscScan API Key** | https://bscscan.com/myapikey (合约验证用) |
| **WalletConnect ID** | https://cloud.walletconnect.com (前端钱包连接) |

### 3. BNB Balance

| Scenario | BNB Needed |
|----------|------------|
| **P2P 模式 (推荐)** | **0.05 BNB** |
| P2P + 保险基金种子 | 0.1 BNB |
| 含 LP 池种子 (非 P2P) | 0.6+ BNB |

> P2P 模式下不需要 PerpVault LP 种子和 InsuranceFund 种子。保险基金可从手续费积累。

---

## Step 1: Configure Environment

### 1.1 Contracts `.env`

```bash
cd contracts
cp .env.example .env
```

Edit `contracts/.env`:

```env
# Deployer private key (with 0x prefix)
PRIVATE_KEY=0xYOUR_DEPLOYER_PRIVATE_KEY

# BSC Mainnet RPC
BSC_RPC_URL=https://bsc-dataseed.binance.org/
BSC_MAINNET_RPC_URL=https://bsc-dataseed.binance.org/

# BscScan verification
BSCSCAN_API_KEY=YOUR_BSCSCAN_API_KEY
```

### 1.2 Modify Deploy Script for P2P Mode

Edit `contracts/script/DeployBSCMainnet.s.sol`:

```solidity
// Line 52-53: Set to 0 for P2P mode
uint256 constant SEED_LP_BNB = 0;         // P2P: no LP seed
uint256 constant INSURANCE_SEED = 0;       // Accumulate from fees

// Line 86: Lower the balance check
require(deployer.balance >= 0.05 ether, "Need at least 0.05 BNB for deployment");
```

---

## Step 2: Deploy Contracts

### 2.1 Compile

```bash
cd contracts
forge build --force
```

Verify build is clean (no errors). PositionManager is 24,228 bytes (near 24,576 limit — normal).

### 2.2 Dry Run (simulate without broadcasting)

```bash
forge script script/DeployBSCMainnet.s.sol \
  --rpc-url $BSC_MAINNET_RPC_URL \
  -vvv
```

Check the output for:
- All 12 contracts deploy successfully
- No revert errors
- Gas estimation looks reasonable

### 2.3 Deploy & Verify

```bash
forge script script/DeployBSCMainnet.s.sol \
  --rpc-url $BSC_MAINNET_RPC_URL \
  --broadcast --slow --verify \
  --etherscan-api-key $BSCSCAN_API_KEY \
  -vvv
```

`--slow` ensures each tx is confirmed before the next one. `--verify` auto-verifies source code on BscScan.

### 2.4 Record Deployed Addresses

The script output will print all 12 contract addresses. **Copy them immediately**:

```
--- Common ---
PriceFeed:         0x...
Vault:             0x...
ContractRegistry:  0x...

--- Spot ---
TokenFactory:      0x...

--- Perpetual ---
PositionManager:   0x...
Settlement (V1):   0x...
SettlementV2:      0x...
PerpVault:         0x...
RiskManager:       0x...
FundingRate:       0x...
Liquidation:       0x...
InsuranceFund:     0x...
```

---

## Step 3: Update Configuration Files (7 Files)

Deploy 后必须同步更新以下所有配置文件，漏一个就会导致系统故障。

### 3.1 `frontend/contracts/deployments/bsc-mainnet.json`

```json
{
  "network": "bsc-mainnet",
  "chainId": 56,
  "deployedAt": "2026-03-XX",
  "contracts": {
    "TokenFactory":     { "address": "0x...", "deployer": "0x..." },
    "Settlement":       { "address": "0x...", "deployer": "0x..." },
    "SettlementV2":     { "address": "0x...", "deployer": "0x..." },
    "PriceFeed":        { "address": "0x...", "deployer": "0x..." },
    "PositionManager":  { "address": "0x...", "deployer": "0x..." },
    "Vault":            { "address": "0x...", "deployer": "0x..." },
    "PerpVault":        { "address": "0x...", "deployer": "0x..." },
    "InsuranceFund":    { "address": "0x...", "deployer": "0x..." },
    "ContractRegistry": { "address": "0x...", "deployer": "0x..." },
    "FundingRate":      { "address": "0x...", "deployer": "0x..." },
    "Liquidation":      { "address": "0x...", "deployer": "0x..." },
    "RiskManager":      { "address": "0x...", "deployer": "0x..." }
  },
  "tokens": {
    "WBNB": "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"
  },
  "explorer": "https://bscscan.com"
}
```

### 3.2 `.env.production` (Backend + Matching Engine + Keeper)

```env
# ============================================================
# Contract Addresses (from deployment output)
# ============================================================
VAULT_ADDRESS=0x...
POSITION_ADDRESS=0x...              # Settlement V1 address
SETTLEMENT_V2_ADDRESS=0x...
PERP_VAULT_ADDRESS=0x...
PRICE_FEED_ADDRESS=0x...
FUNDING_RATE_ADDRESS=0x...
LIQUIDATION_ADDRESS=0x...
INSURANCE_FUND_ADDRESS=0x...
TOKEN_FACTORY_ADDRESS=0x...
LENDING_POOL_ADDRESS=0x...          # If deployed, else leave empty
COLLATERAL_TOKEN_ADDRESS=0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
FEE_RECEIVER_ADDRESS=0x...          # Your revenue wallet

# ============================================================
# Blockchain
# ============================================================
RPC_URL=https://bsc-dataseed.binance.org/
CHAIN_ID=56
KEEPER_PRIVATE_KEY=YOUR_KEEPER_PRIVATE_KEY_WITHOUT_0x

# ============================================================
# Database
# ============================================================
POSTGRES_PASSWORD=<strong-random-password>
REDIS_PASSWORD=<strong-random-password>

# ============================================================
# Security
# ============================================================
JWT_SECRET=<random-64-char-string>
```

### 3.3 `frontend/.env.local`

```env
# API
NEXT_PUBLIC_MATCHING_ENGINE_URL=https://api.yourdomain.com
NEXT_PUBLIC_API_URL=https://api.yourdomain.com
NEXT_PUBLIC_WS_PUBLIC_URL=wss://api.yourdomain.com/ws
NEXT_PUBLIC_WS_PRIVATE_URL=wss://api.yourdomain.com/ws

# Chain
NEXT_PUBLIC_CHAIN_ID=56
NEXT_PUBLIC_BSC_RPC_URL=https://bsc-dataseed.binance.org/
NEXT_PUBLIC_WETH_ADDRESS=0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
NEXT_PUBLIC_BLOCK_EXPLORER_URL=https://bscscan.com

# Contracts
NEXT_PUBLIC_SETTLEMENT_ADDRESS=0x...    # Settlement V1
NEXT_PUBLIC_ROUTER_ADDRESS=
NEXT_PUBLIC_VAULT_ADDRESS=0x...

# EIP-712
NEXT_PUBLIC_EIP712_DOMAIN_NAME=MemePerp
NEXT_PUBLIC_EIP712_DOMAIN_VERSION=1

# Features
NEXT_PUBLIC_DEV_MODE=false
NEXT_PUBLIC_DEBUG=false
NEXT_PUBLIC_TESTNET=false

# WalletConnect
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=YOUR_PROJECT_ID

# Pinata (token logo upload)
NEXT_PUBLIC_PINATA_JWT=YOUR_PINATA_JWT
NEXT_PUBLIC_PINATA_GATEWAY=https://gateway.pinata.cloud/ipfs
```

### 3.4 `backend/src/matching/.env`

```env
PORT=8081
RPC_URL=https://bsc-dataseed.binance.org/
CHAIN_ID=56
MATCHER_PRIVATE_KEY=0xYOUR_KEEPER_PRIVATE_KEY

# All contract addresses (same as .env.production)
SETTLEMENT_ADDRESS=0x...
TOKEN_FACTORY_ADDRESS=0x...
PRICE_FEED_ADDRESS=0x...
VAULT_ADDRESS=0x...
POSITION_MANAGER_ADDRESS=0x...
FUNDING_RATE_ADDRESS=0x...
LIQUIDATION_ADDRESS=0x...
PERP_VAULT_ADDRESS=0x...
SETTLEMENT_V2_ADDRESS=0x...
INSURANCE_FUND_ADDRESS=0x...
LENDING_POOL_ADDRESS=0x...
COLLATERAL_TOKEN_ADDRESS=0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
FEE_RECEIVER_ADDRESS=0x...

# Redis
REDIS_URL=redis://localhost:6379

# Production flags
ALLOW_FAKE_DEPOSIT=false
SKIP_SIGNATURE_VERIFY=false
```

### 3.5 `docker-compose.production.yml`

已预配置读取 `.env.production`，无需修改。确认所有 `${...}` 变量在 `.env.production` 中都有对应值。

### 3.6 `nginx/nginx.conf`

```nginx
# Line 22, 29: Replace domain
server_name yourdomain.com api.yourdomain.com;
```

### 3.7 `.env` (Root, Go Backend)

```env
MEMEPERP_BLOCKCHAIN_RPC_URL=https://bsc-dataseed.binance.org/
MEMEPERP_BLOCKCHAIN_CHAIN_ID=56
MEMEPERP_BLOCKCHAIN_PRIVATE_KEY=0x...
MEMEPERP_BLOCKCHAIN_POSITION_ADDRESS=0x...   # Settlement V1
MEMEPERP_BLOCKCHAIN_VAULT_ADDRESS=0x...
MEMEPERP_BLOCKCHAIN_PRICE_FEED_ADDRESS=0x...
MEMEPERP_BLOCKCHAIN_LIQUIDATION_ADDRESS=0x...
MEMEPERP_BLOCKCHAIN_FUNDING_RATE_ADDRESS=0x...
MEMEPERP_TOKEN_FACTORY_ADDRESS=0x...
MEMEPERP_SETTLEMENT_V2_ADDRESS=0x...
MEMEPERP_PERP_VAULT_ADDRESS=0x...
MEMEPERP_INSURANCE_FUND_ADDRESS=0x...
MEMEPERP_LENDING_POOL_ADDRESS=0x...
COLLATERAL_TOKEN_ADDRESS=0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
FEE_RECEIVER_ADDRESS=0x...
NEXT_PUBLIC_SETTLEMENT_ADDRESS=0x...
```

---

## Step 4: Deploy Services

### 4.1 SSL Certificate (Required)

```bash
# Option A: Let's Encrypt (free)
sudo apt install certbot
sudo certbot certonly --standalone -d yourdomain.com -d api.yourdomain.com

# Copy certs to nginx dir
cp /etc/letsencrypt/live/yourdomain.com/fullchain.pem nginx/ssl/
cp /etc/letsencrypt/live/yourdomain.com/privkey.pem nginx/ssl/
```

### 4.2 Start Production Stack

```bash
# Build and start all services
docker compose -f docker-compose.production.yml up -d --build

# Check all containers are healthy
docker compose -f docker-compose.production.yml ps
```

Expected output:

```
NAME                      STATUS
memeperp-postgres         Up (healthy)
memeperp-redis            Up (healthy)
memeperp-backend          Up (healthy)
memeperp-matching-engine  Up (healthy)
memeperp-frontend         Up (healthy)
memeperp-nginx            Up
```

### 4.3 Verify Health

```bash
# Matching engine
curl https://api.yourdomain.com/health

# Check matching engine logs
docker logs memeperp-matching-engine --tail 50
```

---

## Step 5: Post-Deployment Verification

### 5.1 Contract Verification on BscScan

If `--verify` failed during deploy, manually verify:

```bash
cd contracts
forge verify-contract \
  --chain-id 56 \
  --etherscan-api-key $BSCSCAN_API_KEY \
  --watch \
  0xCONTRACT_ADDRESS \
  src/path/ContractName.sol:ContractName
```

### 5.2 Functional Tests

| Test | Method |
|------|--------|
| BscScan contracts verified | Check green checkmark on each contract page |
| Frontend loads | Visit `https://yourdomain.com` |
| Wallet connects | Connect MetaMask on BSC Mainnet |
| Deposit works | Small test deposit (0.001 BNB) via SettlementV2 |
| Order submits | Place a limit order with EIP-712 signature |
| WS connection | Open browser devtools → Network → WS tab |
| Token creation | Create a test meme token via TokenFactory |

### 5.3 Monitoring

```bash
# Matching engine real-time logs
docker logs -f memeperp-matching-engine

# Check Redis data
docker exec memeperp-redis redis-cli -a $REDIS_PASSWORD INFO keyspace

# Check PostgreSQL
docker exec memeperp-postgres psql -U memeperp -c "SELECT count(*) FROM orders;"
```

---

## Deployment Phases Summary

```
Phase 1 (7 contracts, ~18.5M gas)
  PriceFeed → Vault → ContractRegistry → RiskManager
  → PerpVault → InsuranceFund → Settlement

Phase 2 (4 contracts, ~17.5M gas)
  TokenFactory(deployer, deployer, PancakeRouter)
  → PositionManager(Vault, PriceFeed, RiskManager)
  → SettlementV2(WBNB, deployer, deployer)
  → FundingRate(PositionManager, Vault, PriceFeed)

Phase 3 (1 contract, ~4.5M gas)
  Liquidation(PositionManager, Vault, RiskManager, PriceFeed)

Phase 4 (20+ config transactions, ~0.87M gas)
  Wire all cross-references + authorize contracts
```

---

## 12 Deployed Contracts

| # | Contract | Category | Dependencies |
|---|----------|----------|-------------|
| 1 | PriceFeed | Common | None |
| 2 | Vault | Common | None |
| 3 | ContractRegistry | Common | None |
| 4 | RiskManager | Perp | None |
| 5 | PerpVault | Perp | None |
| 6 | InsuranceFund | Perp | None |
| 7 | Settlement (V1) | Perp | None |
| 8 | TokenFactory | Spot | deployer, PancakeRouter |
| 9 | PositionManager | Perp | Vault, PriceFeed, RiskManager |
| 10 | SettlementV2 | Perp | WBNB |
| 11 | FundingRate | Perp | PositionManager, Vault, PriceFeed |
| 12 | Liquidation | Perp | PositionManager, Vault, RiskManager, PriceFeed |

---

## Rollback Plan

If something goes wrong after deployment:

1. **Frontend issue**: Roll back `frontend/.env.local` to testnet values, redeploy frontend container
2. **Matching engine issue**: Stop matching engine, fix config, restart
3. **Contract bug**: Contracts are immutable once deployed. Use `Ownable2Step` to pause if supported, or deploy new version and update all 7 config files
4. **Fund recovery**: SettlementV2 admin can pause deposits. PerpVault owner can withdraw LP.

---

## Security Checklist

- [ ] Private keys stored securely (NOT in git)
- [ ] `.env.production` is in `.gitignore`
- [ ] `ALLOW_FAKE_DEPOSIT=false` in production
- [ ] `SKIP_SIGNATURE_VERIFY` is NOT set
- [ ] `NEXT_PUBLIC_DEV_MODE=false`
- [ ] `NEXT_PUBLIC_TESTNET=false`
- [ ] SSL certificate installed and auto-renewing
- [ ] All ports except 80/443 bound to `127.0.0.1`
- [ ] Rate limiting enabled in nginx
- [ ] Firewall configured (only allow 80, 443, SSH)
- [ ] Consider transferring contract ownership to multisig
- [ ] Database backups configured
- [ ] Redis AOF persistence enabled

---

## Reference: BSC Testnet Deployment

Deployed 2026-03-03, deployer: `0x5AF11d4784c3739cf2FD51Fdc272ae4957ADf7fE`

| Contract | Testnet Address |
|----------|----------------|
| TokenFactory | `0x22276744bAF24eD503dB50Cc999a9c5AD62728cb` |
| Settlement | `0x63df8d6acF3f99Ae59Bee6184A5EB6beA8663eb7` |
| SettlementV2 | `0x7fF9d60aE49F14bB604FeF1961910D7931067873` |
| PriceFeed | `0xe2b22673fFBeB7A2a4617125E885C12EC072ee48` |
| PositionManager | `0x04C515CcFac80BFFF27E0c5A9113e515171057b6` |
| Vault | `0xACE7014F60eF9c367E7fA5Dd80601A9945E6F4d1` |
| PerpVault | `0x7F98ed779c3352f39b041C57d5B2C73F84dcAA75` |
| InsuranceFund | `0x162CEbAe2013545D191360d13ceA5083E6fcE1a7` |
| ContractRegistry | `0x6956c982aec9Ad08040b91417a313003879d0f48` |
| FundingRate | `0x0a513bf3DE079Bf2439A5884583712bD014487aa` |
| Liquidation | `0x322AeeD67C12c10684B134e1727866425dc75F1c` |
| RiskManager | `0xd4fbB0f140d8909e73e3D91C897EBe66f01B15F9` |
