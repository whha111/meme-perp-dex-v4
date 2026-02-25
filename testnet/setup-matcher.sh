#!/bin/bash
# ============================================================
# MEME Perp DEX - Authorize Matcher in Settlement Contract
# ============================================================
# This script needs the DEPLOYER/OWNER private key to authorize
# the matcher address in the Settlement contract.
#
# The deployer address is: 0x5AF11d4784c3739cf2FD51Fdc272ae4957ADf7fE
# The matcher address is:  0xF339fCf70939e04C8Ce79391BB47bB943122949C
#
# Usage:
#   DEPLOYER_KEY=<your-deployer-private-key> ./setup-matcher.sh
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
NC='\033[0m'

DEPLOYER_KEY="${DEPLOYER_KEY:-}"
MATCHER_ADDRESS="0xF339fCf70939e04C8Ce79391BB47bB943122949C"

if [ -z "$DEPLOYER_KEY" ]; then
    echo -e "${RED}Error: DEPLOYER_KEY environment variable required${NC}"
    echo ""
    echo "Usage: DEPLOYER_KEY=<private-key> ./setup-matcher.sh"
    echo ""
    echo "The deployer address is: 0x5AF11d4784c3739cf2FD51Fdc272ae4957ADf7fE"
    echo "You need the private key that controls this address."
    exit 1
fi

# Verify deployer address
deployer_addr=$(cast wallet address --private-key "$DEPLOYER_KEY" 2>/dev/null)
echo "Deployer address: $deployer_addr"

# Check current owner
owner=$(cast call "$SETTLEMENT_ADDRESS" "owner()(address)" --rpc-url "$RPC_URL" 2>/dev/null)
echo "Settlement owner: $owner"

if [ "$(echo "$deployer_addr" | tr '[:upper:]' '[:lower:]')" != "$(echo "$owner" | tr '[:upper:]' '[:lower:]')" ]; then
    echo -e "${RED}Error: Provided key does not match Settlement owner${NC}"
    echo "Expected: $owner"
    echo "Got:      $deployer_addr"
    exit 1
fi

echo ""
echo -e "${YELLOW}Setting up matcher authorization...${NC}"
echo ""

# 1. Authorize matcher in Settlement
echo "1. Authorizing matcher $MATCHER_ADDRESS in Settlement..."
is_matcher=$(cast call "$SETTLEMENT_ADDRESS" "authorizedMatchers(address)(bool)" "$MATCHER_ADDRESS" --rpc-url "$RPC_URL" 2>/dev/null)
if [ "$is_matcher" = "true" ]; then
    echo -e "  ${GREEN}Already authorized${NC}"
else
    cast send "$SETTLEMENT_ADDRESS" \
        "setAuthorizedMatcher(address,bool)" "$MATCHER_ADDRESS" true \
        --rpc-url "$RPC_URL" \
        --private-key "$DEPLOYER_KEY" \
        > /dev/null 2>&1
    echo -e "  ${GREEN}✅ Matcher authorized${NC}"
fi

# 2. Set fee receiver
echo "2. Setting fee receiver to deployer..."
cast send "$SETTLEMENT_ADDRESS" \
    "setFeeReceiver(address)" "$deployer_addr" \
    --rpc-url "$RPC_URL" \
    --private-key "$DEPLOYER_KEY" \
    > /dev/null 2>&1 || echo "  (May already be set)"
echo -e "  ${GREEN}✅ Fee receiver set${NC}"

# 3. Set insurance fund
echo "3. Setting insurance fund..."
cast send "$SETTLEMENT_ADDRESS" \
    "setInsuranceFund(address)" "$INSURANCE_FUND_ADDRESS" \
    --rpc-url "$RPC_URL" \
    --private-key "$DEPLOYER_KEY" \
    > /dev/null 2>&1 || echo "  (May already be set)"
echo -e "  ${GREEN}✅ Insurance fund set${NC}"

# 4. Verify
echo ""
echo -e "${YELLOW}Verification:${NC}"
is_matcher=$(cast call "$SETTLEMENT_ADDRESS" "authorizedMatchers(address)(bool)" "$MATCHER_ADDRESS" --rpc-url "$RPC_URL" 2>/dev/null)
echo "  Matcher authorized: $is_matcher"
fee_receiver=$(cast call "$SETTLEMENT_ADDRESS" "feeReceiver()(address)" --rpc-url "$RPC_URL" 2>/dev/null)
echo "  Fee receiver: $fee_receiver"

echo ""
echo -e "${GREEN}Setup complete!${NC}"
