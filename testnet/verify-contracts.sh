#!/bin/bash
# ============================================================
# MEME Perp DEX - Contract Verification Script
# ============================================================
# Verifies all deployed contracts on Base Sepolia:
#   1. Code exists at each address
#   2. Key view functions return expected data
#   3. Matcher is authorized in Settlement
#   4. PriceFeed has supported tokens
#   5. LendingPool has enabled tokens
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env.testnet"

if [ -f "$ENV_FILE" ]; then
    set -a; source "$ENV_FILE"; set +a
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

ERRORS=0
WARNINGS=0

pass() { echo -e "  ${GREEN}✅ $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; ERRORS=$((ERRORS + 1)); }
warn() { echo -e "  ${YELLOW}⚠️  $1${NC}"; WARNINGS=$((WARNINGS + 1)); }
info() { echo -e "  ${BLUE}ℹ️  $1${NC}"; }

check_code() {
    local name=$1
    local addr=$2
    local code
    code=$(cast code "$addr" --rpc-url "$RPC_URL" 2>/dev/null | head -c 10)
    if [ "$code" != "0x" ] && [ -n "$code" ]; then
        pass "$name: deployed at $addr"
    else
        fail "$name: NO CODE at $addr"
    fi
}

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Contract Verification - Base Sepolia (Chain $CHAIN_ID)${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""

# ─── 1. Check Contract Deployment ───

echo -e "${YELLOW}1. Contract Deployment${NC}"
check_code "Settlement"       "$SETTLEMENT_ADDRESS"
check_code "TokenFactory"     "$TOKEN_FACTORY_ADDRESS"
check_code "LendingPool"      "$LENDING_POOL_ADDRESS"
check_code "PriceFeed"        "$PRICE_FEED_ADDRESS"
check_code "InsuranceFund"    "$INSURANCE_FUND_ADDRESS"
check_code "ContractRegistry" "$CONTRACT_REGISTRY_ADDRESS"
check_code "AMM"              "$AMM_ADDRESS"
check_code "Vault"            "$VAULT_ADDRESS"
check_code "PositionManager"  "$POSITION_MANAGER_ADDRESS"
check_code "RiskManager"      "$RISK_MANAGER_ADDRESS"
check_code "Liquidation"      "$LIQUIDATION_ADDRESS"
check_code "FundingRate"      "$FUNDING_RATE_ADDRESS"
check_code "Router"           "$ROUTER_ADDRESS"
echo ""

# ─── 2. Settlement Contract State ───

echo -e "${YELLOW}2. Settlement Contract State${NC}"

# Check owner
owner=$(cast call "$SETTLEMENT_ADDRESS" "owner()(address)" --rpc-url "$RPC_URL" 2>/dev/null)
if [ -n "$owner" ]; then
    pass "Settlement owner: $owner"
else
    fail "Settlement owner: could not read"
fi

# Check if matcher is authorized
is_matcher=$(cast call "$SETTLEMENT_ADDRESS" "authorizedMatchers(address)(bool)" "0xF339fCf70939e04C8Ce79391BB47bB943122949C" --rpc-url "$RPC_URL" 2>/dev/null)
if [ "$is_matcher" = "true" ]; then
    pass "Matcher is authorized"
else
    fail "Matcher NOT authorized - need to call setAuthorizedMatcher()"
fi

# Check paused state
is_paused=$(cast call "$SETTLEMENT_ADDRESS" "paused()(bool)" --rpc-url "$RPC_URL" 2>/dev/null)
if [ "$is_paused" = "false" ]; then
    pass "Settlement is NOT paused"
else
    warn "Settlement is PAUSED"
fi
echo ""

# ─── 3. TokenFactory State ───

echo -e "${YELLOW}3. TokenFactory State${NC}"

# Get all tokens
token_count=$(cast call "$TOKEN_FACTORY_ADDRESS" "getAllTokens()(address[])" --rpc-url "$RPC_URL" 2>/dev/null | tr ',' '\n' | grep -c "0x" 2>/dev/null || echo "0")
if [ "$token_count" -gt 0 ] 2>/dev/null; then
    pass "TokenFactory has $token_count tokens"
else
    info "TokenFactory has 0 tokens (will be created during test)"
fi

# Check creation fee
creation_fee=$(cast call "$TOKEN_FACTORY_ADDRESS" "creationFee()(uint256)" --rpc-url "$RPC_URL" 2>/dev/null || echo "error")
if [ "$creation_fee" != "error" ]; then
    info "Token creation fee: $creation_fee wei ($(echo "scale=6; $creation_fee / 1000000000000000000" | bc 2>/dev/null || echo 'N/A') ETH)"
fi
echo ""

# ─── 4. PriceFeed State ───

echo -e "${YELLOW}4. PriceFeed State${NC}"

# Check if MEME token is supported
if [ -n "$MEME_TOKEN_ADDRESS" ]; then
    is_supported=$(cast call "$PRICE_FEED_ADDRESS" "isTokenSupported(address)(bool)" "$MEME_TOKEN_ADDRESS" --rpc-url "$RPC_URL" 2>/dev/null)
    if [ "$is_supported" = "true" ]; then
        pass "MEME token is supported in PriceFeed"

        # Get price
        price=$(cast call "$PRICE_FEED_ADDRESS" "getTokenMarkPrice(address)(uint256)" "$MEME_TOKEN_ADDRESS" --rpc-url "$RPC_URL" 2>/dev/null)
        info "MEME token mark price: $price"
    else
        warn "MEME token NOT supported in PriceFeed"
    fi
fi
echo ""

# ─── 5. LendingPool State ───

echo -e "${YELLOW}5. LendingPool State${NC}"

enabled=$(cast call "$LENDING_POOL_ADDRESS" "getEnabledTokens()(address[])" --rpc-url "$RPC_URL" 2>/dev/null)
if [ -n "$enabled" ] && [ "$enabled" != "[]" ]; then
    enabled_count=$(echo "$enabled" | tr ',' '\n' | grep -c "0x" 2>/dev/null || echo "0")
    pass "LendingPool has $enabled_count enabled tokens"
else
    info "LendingPool has 0 enabled tokens"
fi
echo ""

# ─── 6. Wallet Balances ───

echo -e "${YELLOW}6. Key Wallet Balances${NC}"

matcher_bal=$(cast balance "0xF339fCf70939e04C8Ce79391BB47bB943122949C" --rpc-url "$RPC_URL" --ether 2>/dev/null || echo "error")
if [ "$matcher_bal" != "error" ]; then
    info "Matcher wallet: $matcher_bal ETH"
    # Warn if low
    if echo "$matcher_bal" | awk '{exit ($1 < 0.01)}' 2>/dev/null; then
        warn "Matcher wallet has LOW ETH balance ($matcher_bal) - needs funding for gas"
    fi
fi

# Check Settlement contract ETH balance
settlement_bal=$(cast balance "$SETTLEMENT_ADDRESS" --rpc-url "$RPC_URL" --ether 2>/dev/null || echo "error")
info "Settlement contract: $settlement_bal ETH"

# Check InsuranceFund balance
insurance_bal=$(cast balance "$INSURANCE_FUND_ADDRESS" --rpc-url "$RPC_URL" --ether 2>/dev/null || echo "error")
info "Insurance Fund: $insurance_bal ETH"
echo ""

# ─── 7. Block & Network ───

echo -e "${YELLOW}7. Network Status${NC}"

block=$(cast block-number --rpc-url "$RPC_URL" 2>/dev/null || echo "error")
chain=$(cast chain-id --rpc-url "$RPC_URL" 2>/dev/null || echo "error")
gas_price=$(cast gas-price --rpc-url "$RPC_URL" 2>/dev/null || echo "error")

info "Chain ID: $chain"
info "Block: $block"
info "Gas Price: $gas_price wei"

if [ "$chain" = "84532" ]; then
    pass "Connected to Base Sepolia"
else
    fail "Wrong chain: expected 84532, got $chain"
fi
echo ""

# ─── Summary ───

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo -e "  ${GREEN}✅ ALL CHECKS PASSED${NC}"
elif [ $ERRORS -eq 0 ]; then
    echo -e "  ${YELLOW}⚠️  PASSED with $WARNINGS warning(s)${NC}"
else
    echo -e "  ${RED}❌ $ERRORS ERROR(s), $WARNINGS WARNING(s)${NC}"
fi
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""

exit $ERRORS
