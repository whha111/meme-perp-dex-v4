#!/bin/bash
# ============================================================
# MEME Perp DEX - Health Monitoring Script
# ============================================================
# Checks all services every 5 minutes and logs results.
# Also verifies on-chain contract states.
#
# Usage:
#   ./health-check.sh           # Run once
#   ./health-check.sh --loop    # Run continuously every 5 min
#   ./health-check.sh --json    # Output as JSON (for monitoring)
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
HEALTH_LOG="$LOG_DIR/health.log"
INTERVAL=300  # 5 minutes

# Load environment
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

LOOP_MODE=false
JSON_MODE=false
for arg in "$@"; do
    case $arg in
        --loop) LOOP_MODE=true ;;
        --json) JSON_MODE=true ;;
    esac
done

mkdir -p "$LOG_DIR"

# ============================================================
# Health Check Functions
# ============================================================

check_service() {
    local name=$1
    local url=$2
    local expected_code=${3:-200}

    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "$url" 2>/dev/null || echo "000")

    if [ "$http_code" = "$expected_code" ] || [ "$http_code" = "200" ]; then
        echo "OK"
    else
        echo "FAIL:$http_code"
    fi
}

check_port() {
    local port=$1
    if nc -z localhost "$port" 2>/dev/null; then
        echo "OK"
    else
        echo "DOWN"
    fi
}

check_docker_container() {
    local name=$1
    local status
    status=$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo "not_found")
    echo "$status"
}

check_contract() {
    local address=$1
    local code
    code=$(cast code "$address" --rpc-url "$RPC_URL" 2>/dev/null | head -c 10)
    if [ "$code" != "0x" ] && [ -n "$code" ]; then
        echo "OK"
    else
        echo "NO_CODE"
    fi
}

get_eth_balance() {
    local address=$1
    cast balance "$address" --rpc-url "$RPC_URL" --ether 2>/dev/null || echo "error"
}

get_block_number() {
    cast block-number --rpc-url "$RPC_URL" 2>/dev/null || echo "error"
}

# ============================================================
# Run Health Check
# ============================================================

run_check() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    local all_healthy=true

    if [ "$JSON_MODE" = true ]; then
        echo "{"
        echo "  \"timestamp\": \"$timestamp\","
        echo "  \"checks\": {"
    else
        echo ""
        echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
        echo -e "${BLUE}  Health Check - $timestamp${NC}"
        echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
    fi

    # --- Infrastructure ---
    local postgres_status=$(check_docker_container "memeperp-postgres-test")
    local redis_status=$(check_docker_container "memeperp-redis-test")
    local postgres_port=$(check_port 5432)
    local redis_port=$(check_port 6379)

    if [ "$JSON_MODE" = false ]; then
        echo ""
        echo -e "  ${YELLOW}Infrastructure${NC}"
        [[ "$postgres_status" == "running" ]] && echo -e "    ✅ PostgreSQL: running (port $postgres_port)" || { echo -e "    ❌ PostgreSQL: $postgres_status"; all_healthy=false; }
        [[ "$redis_status" == "running" ]] && echo -e "    ✅ Redis: running (port $redis_port)" || { echo -e "    ❌ Redis: $redis_status"; all_healthy=false; }
    fi

    # --- Application Services ---
    local me_status=$(check_service "Matching Engine" "http://localhost:${MATCHING_ENGINE_PORT:-8081}/health")
    local be_status=$(check_service "Backend API" "http://localhost:${BACKEND_PORT:-8080}/health")
    local fe_status=$(check_port "${FRONTEND_PORT:-3000}")

    if [ "$JSON_MODE" = false ]; then
        echo ""
        echo -e "  ${YELLOW}Application Services${NC}"
        [[ "$me_status" == "OK" ]] && echo -e "    ✅ Matching Engine: healthy (port ${MATCHING_ENGINE_PORT:-8081})" || { echo -e "    ❌ Matching Engine: $me_status"; all_healthy=false; }
        [[ "$be_status" == "OK" ]] && echo -e "    ✅ Backend API: healthy (port ${BACKEND_PORT:-8080})" || { echo -e "    ❌ Backend API: $be_status"; all_healthy=false; }
        [[ "$fe_status" == "OK" ]] && echo -e "    ✅ Frontend: running (port ${FRONTEND_PORT:-3000})" || { echo -e "    ❌ Frontend: $fe_status"; all_healthy=false; }
    fi

    # --- Blockchain ---
    local block_num=$(get_block_number)
    local matcher_balance=$(get_eth_balance "0xF339fCf70939e04C8Ce79391BB47bB943122949C")

    # Check key contracts
    local settlement_ok=$(check_contract "$SETTLEMENT_ADDRESS")
    local factory_ok=$(check_contract "$TOKEN_FACTORY_ADDRESS")
    local lending_ok=$(check_contract "$LENDING_POOL_ADDRESS")
    local pricefeed_ok=$(check_contract "$PRICE_FEED_ADDRESS")

    if [ "$JSON_MODE" = false ]; then
        echo ""
        echo -e "  ${YELLOW}Blockchain (Base Sepolia)${NC}"
        echo -e "    📦 Block: $block_num"
        echo -e "    💰 Matcher ETH: $matcher_balance"
        [[ "$settlement_ok" == "OK" ]] && echo -e "    ✅ Settlement: deployed" || { echo -e "    ❌ Settlement: $settlement_ok"; all_healthy=false; }
        [[ "$factory_ok" == "OK" ]] && echo -e "    ✅ TokenFactory: deployed" || { echo -e "    ❌ TokenFactory: $factory_ok"; all_healthy=false; }
        [[ "$lending_ok" == "OK" ]] && echo -e "    ✅ LendingPool: deployed" || { echo -e "    ❌ LendingPool: $lending_ok"; all_healthy=false; }
        [[ "$pricefeed_ok" == "OK" ]] && echo -e "    ✅ PriceFeed: deployed" || { echo -e "    ❌ PriceFeed: $pricefeed_ok"; all_healthy=false; }
    fi

    # --- Matching Engine Stats ---
    local me_stats=""
    if [ "$me_status" == "OK" ]; then
        me_stats=$(curl -s "http://localhost:${MATCHING_ENGINE_PORT:-8081}/api/stats" 2>/dev/null || echo "{}")
    fi

    if [ "$JSON_MODE" = false ]; then
        if [ -n "$me_stats" ] && [ "$me_stats" != "{}" ]; then
            echo ""
            echo -e "  ${YELLOW}Matching Engine Stats${NC}"
            echo "    $me_stats" | python3 -m json.tool 2>/dev/null | head -20 || echo "    $me_stats"
        fi
    fi

    # --- Summary ---
    if [ "$JSON_MODE" = false ]; then
        echo ""
        if [ "$all_healthy" = true ]; then
            echo -e "  ${GREEN}✅ Overall: ALL HEALTHY${NC}"
        else
            echo -e "  ${RED}⚠️  Overall: ISSUES DETECTED${NC}"
        fi
        echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
        echo ""
    else
        echo "    \"postgres\": \"$postgres_status\","
        echo "    \"redis\": \"$redis_status\","
        echo "    \"matching_engine\": \"$me_status\","
        echo "    \"backend\": \"$be_status\","
        echo "    \"frontend\": \"$fe_status\","
        echo "    \"block_number\": \"$block_num\","
        echo "    \"matcher_balance\": \"$matcher_balance\","
        echo "    \"settlement\": \"$settlement_ok\","
        echo "    \"token_factory\": \"$factory_ok\","
        echo "    \"lending_pool\": \"$lending_ok\","
        echo "    \"price_feed\": \"$pricefeed_ok\""
        echo "  }"
        echo "}"
    fi

    # Log to file
    echo "[$timestamp] postgres=$postgres_status redis=$redis_status me=$me_status be=$be_status fe=$fe_status block=$block_num balance=$matcher_balance" >> "$HEALTH_LOG"
}

# ============================================================
# Main
# ============================================================

if [ "$LOOP_MODE" = true ]; then
    echo -e "${GREEN}Starting continuous health monitoring (every ${INTERVAL}s)${NC}"
    echo -e "Logs: $HEALTH_LOG"
    echo -e "Press Ctrl+C to stop"
    echo ""

    while true; do
        run_check
        sleep "$INTERVAL"
    done
else
    run_check
fi
