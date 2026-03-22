#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# update-addresses.sh — One-click contract address updater
#
# After deploying new contracts, run this script to update ALL
# config files across the entire project.
#
# Usage: ./scripts/update-addresses.sh
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── Read addresses from deployments/97.json (single source of truth) ──
DEPLOY_JSON="$ROOT/deployments/97.json"
if [ ! -f "$DEPLOY_JSON" ]; then
  echo "ERROR: $DEPLOY_JSON not found"; exit 1
fi

# Parse with python3 (available on macOS)
get_addr() { python3 -c "import json; d=json.load(open('$DEPLOY_JSON')); print(d['contracts']['$1'])"; }

PRICE_FEED=$(get_addr PriceFeed)
VAULT=$(get_addr Vault)
CONTRACT_REGISTRY=$(get_addr ContractRegistry)
TOKEN_FACTORY=$(get_addr TokenFactory)
POSITION_MANAGER=$(get_addr PositionManager)
SETTLEMENT_V1=$(get_addr Settlement)
SETTLEMENT_V2=$(get_addr SettlementV2)
PERP_VAULT=$(get_addr PerpVault)
RISK_MANAGER=$(get_addr RiskManager)
FUNDING_RATE=$(get_addr FundingRate)
LIQUIDATION=$(get_addr Liquidation)
INSURANCE_FUND=$(get_addr InsuranceFund)
WBNB=$(get_addr WBNB)
PANCAKE_ROUTER=$(get_addr PancakeRouterV2)
DEPLOYER=$(python3 -c "import json; print(json.load(open('$DEPLOY_JSON'))['deployer'])")

echo "═══════════════════════════════════════════"
echo "  Contract Address Updater"
echo "═══════════════════════════════════════════"

updated=0

update_file() {
  local file="$1"
  local key="$2"
  local val="$3"

  if [ ! -f "$file" ]; then
    return
  fi

  # For .env files: KEY=value
  if [[ "$file" == *.env* ]]; then
    if grep -q "^${key}=" "$file" 2>/dev/null; then
      sed -i '' "s|^${key}=.*|${key}=${val}|" "$file"
    fi
  fi

  # For .yaml files: key: value
  if [[ "$file" == *.yaml ]]; then
    if grep -q "${key}:" "$file" 2>/dev/null; then
      sed -i '' "s|${key}:.*|${key}: \"${val}\"|" "$file"
    fi
  fi
}

# ── 1. Root .env ──
echo "  [1/8] Root .env"
for f in "$ROOT/.env"; do
  update_file "$f" "TOKEN_FACTORY_ADDRESS" "$TOKEN_FACTORY"
  update_file "$f" "SETTLEMENT_ADDRESS" "$SETTLEMENT_V1"
  update_file "$f" "SETTLEMENT_V2_ADDRESS" "$SETTLEMENT_V2"
  update_file "$f" "VAULT_ADDRESS" "$VAULT"
  update_file "$f" "PRICE_FEED_ADDRESS" "$PRICE_FEED"
  update_file "$f" "POSITION_MANAGER_ADDRESS" "$POSITION_MANAGER"
  update_file "$f" "RISK_MANAGER_ADDRESS" "$RISK_MANAGER"
  update_file "$f" "INSURANCE_FUND_ADDRESS" "$INSURANCE_FUND"
  update_file "$f" "CONTRACT_REGISTRY_ADDRESS" "$CONTRACT_REGISTRY"
  update_file "$f" "FUNDING_RATE_ADDRESS" "$FUNDING_RATE"
  update_file "$f" "LIQUIDATION_ADDRESS" "$LIQUIDATION"
  update_file "$f" "PERP_VAULT_ADDRESS" "$PERP_VAULT"
  update_file "$f" "ROUTER_ADDRESS" "$PANCAKE_ROUTER"
done
((updated++))

# ── 2. Frontend .env.local ──
echo "  [2/8] Frontend .env.local"
for f in "$ROOT/frontend/.env.local"; do
  update_file "$f" "NEXT_PUBLIC_TOKEN_FACTORY_ADDRESS" "$TOKEN_FACTORY"
  update_file "$f" "NEXT_PUBLIC_SETTLEMENT_ADDRESS" "$SETTLEMENT_V1"
  update_file "$f" "NEXT_PUBLIC_SETTLEMENT_V2_ADDRESS" "$SETTLEMENT_V2"
  update_file "$f" "NEXT_PUBLIC_VAULT_ADDRESS" "$VAULT"
  update_file "$f" "NEXT_PUBLIC_PRICE_FEED_ADDRESS" "$PRICE_FEED"
  update_file "$f" "NEXT_PUBLIC_POSITION_MANAGER_ADDRESS" "$POSITION_MANAGER"
  update_file "$f" "NEXT_PUBLIC_RISK_MANAGER_ADDRESS" "$RISK_MANAGER"
  update_file "$f" "NEXT_PUBLIC_INSURANCE_FUND_ADDRESS" "$INSURANCE_FUND"
  update_file "$f" "NEXT_PUBLIC_CONTRACT_REGISTRY_ADDRESS" "$CONTRACT_REGISTRY"
  update_file "$f" "NEXT_PUBLIC_FUNDING_RATE_ADDRESS" "$FUNDING_RATE"
  update_file "$f" "NEXT_PUBLIC_LIQUIDATION_ADDRESS" "$LIQUIDATION"
  update_file "$f" "NEXT_PUBLIC_PERP_VAULT_ADDRESS" "$PERP_VAULT"
  update_file "$f" "NEXT_PUBLIC_ROUTER_ADDRESS" "$PANCAKE_ROUTER"
done
((updated++))

# ── 3. Backend .env ──
echo "  [3/8] Backend .env"
for f in "$ROOT/backend/.env"; do
  update_file "$f" "TOKEN_FACTORY_ADDRESS" "$TOKEN_FACTORY"
  update_file "$f" "SETTLEMENT_ADDRESS" "$SETTLEMENT_V1"
  update_file "$f" "SETTLEMENT_V2_ADDRESS" "$SETTLEMENT_V2"
  update_file "$f" "VAULT_ADDRESS" "$VAULT"
  update_file "$f" "PRICE_FEED_ADDRESS" "$PRICE_FEED"
  update_file "$f" "POSITION_MANAGER_ADDRESS" "$POSITION_MANAGER"
  update_file "$f" "RISK_MANAGER_ADDRESS" "$RISK_MANAGER"
  update_file "$f" "INSURANCE_FUND_ADDRESS" "$INSURANCE_FUND"
  update_file "$f" "CONTRACT_REGISTRY_ADDRESS" "$CONTRACT_REGISTRY"
  update_file "$f" "FUNDING_RATE_ADDRESS" "$FUNDING_RATE"
  update_file "$f" "LIQUIDATION_ADDRESS" "$LIQUIDATION"
  update_file "$f" "PERP_VAULT_ADDRESS" "$PERP_VAULT"
done
((updated++))

# ── 4. Matching engine .env ──
echo "  [4/8] Matching engine .env"
for f in "$ROOT/backend/src/matching/.env"; do
  update_file "$f" "TOKEN_FACTORY_ADDRESS" "$TOKEN_FACTORY"
  update_file "$f" "SETTLEMENT_ADDRESS" "$SETTLEMENT_V1"
  update_file "$f" "SETTLEMENT_V2_ADDRESS" "$SETTLEMENT_V2"
  update_file "$f" "VAULT_ADDRESS" "$VAULT"
  update_file "$f" "PRICE_FEED_ADDRESS" "$PRICE_FEED"
  update_file "$f" "POSITION_MANAGER_ADDRESS" "$POSITION_MANAGER"
  update_file "$f" "RISK_MANAGER_ADDRESS" "$RISK_MANAGER"
  update_file "$f" "INSURANCE_FUND_ADDRESS" "$INSURANCE_FUND"
  update_file "$f" "CONTRACT_REGISTRY_ADDRESS" "$CONTRACT_REGISTRY"
  update_file "$f" "FUNDING_RATE_ADDRESS" "$FUNDING_RATE"
  update_file "$f" "LIQUIDATION_ADDRESS" "$LIQUIDATION"
  update_file "$f" "PERP_VAULT_ADDRESS" "$PERP_VAULT"
done
((updated++))

# ── 5. Backend config.yaml ──
echo "  [5/8] Backend config.yaml files"
for f in "$ROOT/backend/configs/config.yaml" "$ROOT/backend/configs/config.local.yaml"; do
  update_file "$f" "  token_factory_address" "$TOKEN_FACTORY"
  update_file "$f" "  settlement_address" "$SETTLEMENT_V1"
  update_file "$f" "  settlement_v2_address" "$SETTLEMENT_V2"
  update_file "$f" "  vault_address" "$VAULT"
  update_file "$f" "  price_feed_address" "$PRICE_FEED"
  update_file "$f" "  position_address" "$POSITION_MANAGER"
  update_file "$f" "  risk_manager_address" "$RISK_MANAGER"
  update_file "$f" "  insurance_fund_address" "$INSURANCE_FUND"
  update_file "$f" "  contract_registry_address" "$CONTRACT_REGISTRY"
  update_file "$f" "  funding_rate_address" "$FUNDING_RATE"
  update_file "$f" "  liquidation_address" "$LIQUIDATION"
  update_file "$f" "  perp_vault_address" "$PERP_VAULT"
  update_file "$f" "  router_address" "$PANCAKE_ROUTER"
done
((updated++))

# ── 6. Deployment JSON (97.json) ──
echo "  [6/8] Deployment JSON"
cat > "$ROOT/deployments/97.json" << DEPLOYEOF
{
  "chainId": 97,
  "chainName": "BSC Testnet",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "deployer": "$DEPLOYER",
  "contracts": {
    "TokenFactory": "$TOKEN_FACTORY",
    "Settlement": "$SETTLEMENT_V1",
    "SettlementV2": "$SETTLEMENT_V2",
    "PriceFeed": "$PRICE_FEED",
    "PositionManager": "$POSITION_MANAGER",
    "Vault": "$VAULT",
    "PerpVault": "$PERP_VAULT",
    "RiskManager": "$RISK_MANAGER",
    "FundingRate": "$FUNDING_RATE",
    "Liquidation": "$LIQUIDATION",
    "InsuranceFund": "$INSURANCE_FUND",
    "ContractRegistry": "$CONTRACT_REGISTRY",
    "WBNB": "$WBNB",
    "PancakeRouterV2": "$PANCAKE_ROUTER"
  }
}
DEPLOYEOF
((updated++))

# ── 7. Frontend deployment JSON ──
echo "  [7/8] Frontend deployment JSON"
cat > "$ROOT/frontend/contracts/deployments/base-sepolia.json" << DEPLOYEOF
{
  "chainId": 97,
  "chainName": "BSC Testnet",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "deployer": "$DEPLOYER",
  "contracts": {
    "TokenFactory": "$TOKEN_FACTORY",
    "Settlement": "$SETTLEMENT_V1",
    "SettlementV2": "$SETTLEMENT_V2",
    "PriceFeed": "$PRICE_FEED",
    "PositionManager": "$POSITION_MANAGER",
    "Vault": "$VAULT",
    "PerpVault": "$PERP_VAULT",
    "RiskManager": "$RISK_MANAGER",
    "FundingRate": "$FUNDING_RATE",
    "Liquidation": "$LIQUIDATION",
    "InsuranceFund": "$INSURANCE_FUND",
    "ContractRegistry": "$CONTRACT_REGISTRY",
    "WBNB": "$WBNB",
    "PancakeRouterV2": "$PANCAKE_ROUTER"
  }
}
DEPLOYEOF
((updated++))

# ── 8. Testnet env ──
echo "  [8/8] Testnet .env"
for f in "$ROOT/testnet/.env.testnet"; do
  update_file "$f" "TOKEN_FACTORY_ADDRESS" "$TOKEN_FACTORY"
  update_file "$f" "SETTLEMENT_ADDRESS" "$SETTLEMENT_V1"
  update_file "$f" "SETTLEMENT_V2_ADDRESS" "$SETTLEMENT_V2"
  update_file "$f" "VAULT_ADDRESS" "$VAULT"
  update_file "$f" "PRICE_FEED_ADDRESS" "$PRICE_FEED"
  update_file "$f" "POSITION_MANAGER_ADDRESS" "$POSITION_MANAGER"
  update_file "$f" "RISK_MANAGER_ADDRESS" "$RISK_MANAGER"
  update_file "$f" "INSURANCE_FUND_ADDRESS" "$INSURANCE_FUND"
  update_file "$f" "CONTRACT_REGISTRY_ADDRESS" "$CONTRACT_REGISTRY"
  update_file "$f" "FUNDING_RATE_ADDRESS" "$FUNDING_RATE"
  update_file "$f" "LIQUIDATION_ADDRESS" "$LIQUIDATION"
  update_file "$f" "PERP_VAULT_ADDRESS" "$PERP_VAULT"
done
((updated++))

echo "═══════════════════════════════════════════"
echo "  ✅ $updated config groups updated!"
echo "═══════════════════════════════════════════"
echo ""
echo "New addresses:"
echo "  TokenFactory:    $TOKEN_FACTORY"
echo "  SettlementV2:    $SETTLEMENT_V2"
echo "  PerpVault:       $PERP_VAULT"
echo "  PriceFeed:       $PRICE_FEED"
echo "  Liquidation:     $LIQUIDATION"
echo ""
echo "Next: clear databases and restart services"
