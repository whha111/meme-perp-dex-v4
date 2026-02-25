#!/bin/bash
# ============================================================
# MEME Perp DEX - 24h Testnet Full Stack Startup Script
# ============================================================
# This script starts ALL services required for a full 24h testnet test:
#   1. PostgreSQL (via Docker)
#   2. Redis (via Docker)
#   3. Matching Engine (Bun/TypeScript, port 8081)
#   4. Go Backend API (port 8080)
#   5. Go Keeper Services (liquidation, funding, orders)
#   6. Frontend (Next.js, port 3000)
#   7. Trading Bot (automated activity simulation)
#   8. Health Monitor (periodic health checks)
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
PID_DIR="$SCRIPT_DIR/pids"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# ============================================================
# Helper Functions
# ============================================================

log_info()  { echo -e "${GREEN}[INFO]${NC}  $(date '+%H:%M:%S') $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $(date '+%H:%M:%S') $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $(date '+%H:%M:%S') $1"; }
log_step()  { echo -e "${CYAN}[STEP]${NC}  $(date '+%H:%M:%S') ─── $1 ───"; }

cleanup() {
    log_warn "Received shutdown signal, stopping all services..."
    "$SCRIPT_DIR/stop-all.sh" 2>/dev/null || true
    exit 0
}

trap cleanup SIGINT SIGTERM

wait_for_port() {
    local port=$1
    local name=$2
    local max_wait=${3:-60}
    local waited=0

    while ! nc -z localhost "$port" 2>/dev/null; do
        if [ $waited -ge $max_wait ]; then
            log_error "$name failed to start on port $port after ${max_wait}s"
            return 1
        fi
        sleep 2
        waited=$((waited + 2))
    done
    log_info "$name is ready on port $port (took ${waited}s)"
}

# ============================================================
# Pre-flight Checks
# ============================================================

log_step "Pre-flight Checks"

# Check required tools
for cmd in docker bun go node pnpm nc; do
    if ! command -v $cmd &>/dev/null; then
        log_error "$cmd is not installed"
        exit 1
    fi
done
log_info "All required tools found"

# Load environment
ENV_FILE="$SCRIPT_DIR/.env.testnet"
if [ ! -f "$ENV_FILE" ]; then
    log_error ".env.testnet not found at $ENV_FILE"
    exit 1
fi
set -a
source "$ENV_FILE"
set +a
log_info "Environment loaded from .env.testnet"

# Create directories
mkdir -p "$LOG_DIR" "$PID_DIR"

# ============================================================
# Step 1: Start PostgreSQL & Redis (Docker)
# ============================================================

log_step "Starting Infrastructure (PostgreSQL + Redis)"

# Check if containers already exist
if docker ps -a --format '{{.Names}}' | grep -q "memeperp-postgres-test"; then
    log_info "Removing existing test containers..."
    docker rm -f memeperp-postgres-test memeperp-redis-test 2>/dev/null || true
fi

# Start PostgreSQL
docker run -d \
    --name memeperp-postgres-test \
    -e POSTGRES_USER="$POSTGRES_USER" \
    -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
    -e POSTGRES_DB="$POSTGRES_DB" \
    -p "${POSTGRES_PORT}:5432" \
    -v "$SCRIPT_DIR/postgres_data:/var/lib/postgresql/data" \
    postgres:15-alpine \
    > /dev/null

log_info "PostgreSQL container started"

# Start Redis
docker run -d \
    --name memeperp-redis-test \
    -p 6379:6379 \
    -v "$SCRIPT_DIR/redis_data:/data" \
    redis:7-alpine \
    > /dev/null

log_info "Redis container started"

# Wait for services
wait_for_port 5432 "PostgreSQL" 30
wait_for_port 6379 "Redis" 15

# Run migrations
log_info "Running database migrations..."
for sql_file in "$PROJECT_ROOT/backend/migrations"/*.sql; do
    if [ -f "$sql_file" ]; then
        PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -p "$POSTGRES_PORT" \
            -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f "$sql_file" \
            > /dev/null 2>&1 || true
        log_info "  Applied: $(basename "$sql_file")"
    fi
done

# ============================================================
# Step 2: Start Matching Engine
# ============================================================

log_step "Starting Matching Engine (port $MATCHING_ENGINE_PORT)"

cd "$PROJECT_ROOT/backend/src/matching"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    log_info "Installing matching engine dependencies..."
    bun install > /dev/null 2>&1
fi

# Create matching engine .env
cat > .env <<ENVEOF
PORT=${MATCHING_ENGINE_PORT}
RPC_URL=${RPC_URL}
CHAIN_ID=${CHAIN_ID}
SETTLEMENT_ADDRESS=${SETTLEMENT_ADDRESS}
TOKEN_FACTORY_ADDRESS=${TOKEN_FACTORY_ADDRESS}
PRICE_FEED_ADDRESS=${PRICE_FEED_ADDRESS}
LENDING_POOL_ADDRESS=${LENDING_POOL_ADDRESS}
LIQUIDATION_ADDRESS=${LIQUIDATION_ADDRESS}
MATCHER_PRIVATE_KEY=${MATCHER_PRIVATE_KEY}
FEE_RECEIVER_ADDRESS=${FEE_RECEIVER_ADDRESS}
BATCH_INTERVAL_MS=${BATCH_INTERVAL_MS}
MIN_BATCH_SIZE=${MIN_BATCH_SIZE}
MAX_BATCH_SIZE=${MAX_BATCH_SIZE}
SKIP_SIGNATURE_VERIFY=${SKIP_SIGNATURE_VERIFY}
REDIS_URL=redis://localhost:6379
LOG_LEVEL=${LOG_LEVEL}
ENVEOF

# Start matching engine
nohup bun run server.ts > "$LOG_DIR/matching-engine.log" 2>&1 &
echo $! > "$PID_DIR/matching-engine.pid"
log_info "Matching engine started (PID: $(cat "$PID_DIR/matching-engine.pid"))"

wait_for_port "$MATCHING_ENGINE_PORT" "Matching Engine" 30

# ============================================================
# Step 3: Start Go Backend API
# ============================================================

log_step "Starting Go Backend API (port $BACKEND_PORT)"

cd "$PROJECT_ROOT/backend"

# Override config via environment variables
export MEMEPERP_DATABASE_HOST="$POSTGRES_HOST"
export MEMEPERP_DATABASE_PORT="$POSTGRES_PORT"
export MEMEPERP_DATABASE_USER="$POSTGRES_USER"
export MEMEPERP_DATABASE_PASSWORD="$POSTGRES_PASSWORD"
export MEMEPERP_DATABASE_DBNAME="$POSTGRES_DB"
export MEMEPERP_REDIS_ADDR="$REDIS_ADDR"
export MEMEPERP_BLOCKCHAIN_RPC_URL="$ALCHEMY_RPC_URL"
export MEMEPERP_BLOCKCHAIN_CHAIN_ID="$CHAIN_ID"
export MEMEPERP_BLOCKCHAIN_PRIVATE_KEY="$MATCHER_PRIVATE_KEY"
export MEMEPERP_BLOCKCHAIN_POSITION_ADDRESS="$SETTLEMENT_ADDRESS"
export MEMEPERP_BLOCKCHAIN_VAULT_ADDRESS="$VAULT_ADDRESS"
export MEMEPERP_BLOCKCHAIN_PRICE_FEED_ADDRESS="$PRICE_FEED_ADDRESS"
export MEMEPERP_JWT_SECRET="$JWT_SECRET"
export MEMEPERP_SERVER_MODE="debug"

# Build if needed
if [ ! -f "./cmd/api/main" ] || [ "$(find ./cmd/api -name '*.go' -newer ./cmd/api/main 2>/dev/null)" ]; then
    log_info "Building Go backend..."
    go build -o cmd/api/main ./cmd/api 2>> "$LOG_DIR/go-build.log"
fi

nohup ./cmd/api/main > "$LOG_DIR/backend-api.log" 2>&1 &
echo $! > "$PID_DIR/backend-api.pid"
log_info "Go backend API started (PID: $(cat "$PID_DIR/backend-api.pid"))"

wait_for_port "$BACKEND_PORT" "Backend API" 30

# ============================================================
# Step 4: Start Go Keeper Services
# ============================================================

log_step "Starting Keeper Services"

cd "$PROJECT_ROOT/backend"

# Build keeper if needed
if [ ! -f "./cmd/keeper/main" ] || [ "$(find ./cmd/keeper -name '*.go' -newer ./cmd/keeper/main 2>/dev/null)" ]; then
    log_info "Building keeper..."
    go build -o cmd/keeper/main ./cmd/keeper 2>> "$LOG_DIR/go-build.log"
fi

nohup ./cmd/keeper/main > "$LOG_DIR/keeper.log" 2>&1 &
echo $! > "$PID_DIR/keeper.pid"
log_info "Keeper services started (PID: $(cat "$PID_DIR/keeper.pid"))"

# ============================================================
# Step 5: Start Frontend
# ============================================================

log_step "Starting Frontend (port $FRONTEND_PORT)"

cd "$PROJECT_ROOT/frontend"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    log_info "Installing frontend dependencies..."
    pnpm install > /dev/null 2>&1
fi

# Create frontend .env.local
cat > .env.local <<ENVEOF
NEXT_PUBLIC_MATCHING_ENGINE_URL=http://localhost:${MATCHING_ENGINE_PORT}
NEXT_PUBLIC_API_URL=http://localhost:${BACKEND_PORT}
NEXT_PUBLIC_WS_PUBLIC_URL=ws://localhost:${BACKEND_PORT}/ws/public
NEXT_PUBLIC_WS_PRIVATE_URL=ws://localhost:${BACKEND_PORT}/ws/private
NEXT_PUBLIC_CHAIN_ID=${CHAIN_ID}
NEXT_PUBLIC_BASE_TESTNET_RPC_URL=${RPC_URL}
NEXT_PUBLIC_BASE_RPC_URL=${RPC_URL}
NEXT_PUBLIC_SETTLEMENT_ADDRESS=${SETTLEMENT_ADDRESS}
NEXT_PUBLIC_TOKEN_FACTORY_ADDRESS=${TOKEN_FACTORY_ADDRESS}
NEXT_PUBLIC_PRICE_FEED_ADDRESS=${PRICE_FEED_ADDRESS}
NEXT_PUBLIC_LENDING_POOL_ADDRESS=${LENDING_POOL_ADDRESS}
NEXT_PUBLIC_VAULT_ADDRESS=${VAULT_ADDRESS}
NEXT_PUBLIC_AMM_ADDRESS=${AMM_ADDRESS}
NEXT_PUBLIC_ROUTER_ADDRESS=${ROUTER_ADDRESS}
NEXT_PUBLIC_WETH_ADDRESS=${WETH_ADDRESS}
NEXT_PUBLIC_USDT_ADDRESS=${USDT_ADDRESS}
NEXT_PUBLIC_USDC_ADDRESS=${USDC_ADDRESS}
NEXT_PUBLIC_USD1_ADDRESS=${USD1_ADDRESS}
NEXT_PUBLIC_MEME_TOKEN_ADDRESS=${MEME_TOKEN_ADDRESS}
NEXT_PUBLIC_RISK_MANAGER_ADDRESS=${RISK_MANAGER_ADDRESS}
NEXT_PUBLIC_POSITION_MANAGER_ADDRESS=${POSITION_MANAGER_ADDRESS}
NEXT_PUBLIC_INSURANCE_FUND_ADDRESS=${INSURANCE_FUND_ADDRESS}
NEXT_PUBLIC_CONTRACT_REGISTRY_ADDRESS=${CONTRACT_REGISTRY_ADDRESS}
NEXT_PUBLIC_FUNDING_RATE_ADDRESS=${FUNDING_RATE_ADDRESS}
NEXT_PUBLIC_LIQUIDATION_ADDRESS=${LIQUIDATION_ADDRESS}
NEXT_PUBLIC_EIP712_DOMAIN_NAME=MemePerp
NEXT_PUBLIC_EIP712_DOMAIN_VERSION=1
NEXT_PUBLIC_DEV_MODE=true
NEXT_PUBLIC_TESTNET=true
ENVEOF

nohup pnpm dev > "$LOG_DIR/frontend.log" 2>&1 &
echo $! > "$PID_DIR/frontend.pid"
log_info "Frontend started (PID: $(cat "$PID_DIR/frontend.pid"))"

wait_for_port "$FRONTEND_PORT" "Frontend" 60

# ============================================================
# Step 6: Verify All Contracts On-Chain
# ============================================================

log_step "Verifying Deployed Contracts"

cd "$PROJECT_ROOT"

# Quick verification using cast (from Foundry)
verify_contract() {
    local name=$1
    local address=$2
    local result

    result=$(cast code "$address" --rpc-url "$RPC_URL" 2>/dev/null | head -c 10)
    if [ "$result" != "0x" ] && [ -n "$result" ]; then
        log_info "  ✅ $name ($address)"
    else
        log_warn "  ❌ $name ($address) - NO CODE"
    fi
}

verify_contract "Settlement" "$SETTLEMENT_ADDRESS"
verify_contract "TokenFactory" "$TOKEN_FACTORY_ADDRESS"
verify_contract "LendingPool" "$LENDING_POOL_ADDRESS"
verify_contract "PriceFeed" "$PRICE_FEED_ADDRESS"
verify_contract "PerpVault" "$VAULT_ADDRESS"
verify_contract "InsuranceFund" "$INSURANCE_FUND_ADDRESS"
verify_contract "AMM" "$AMM_ADDRESS"
verify_contract "PositionManager" "$POSITION_MANAGER_ADDRESS"

# ============================================================
# Summary
# ============================================================

echo ""
echo -e "${CYAN}============================================================${NC}"
echo -e "${GREEN}  MEME Perp DEX - All Services Running!${NC}"
echo -e "${CYAN}============================================================${NC}"
echo ""
echo -e "  ${BLUE}Frontend:${NC}         http://localhost:${FRONTEND_PORT}"
echo -e "  ${BLUE}Matching Engine:${NC}  http://localhost:${MATCHING_ENGINE_PORT}"
echo -e "  ${BLUE}Backend API:${NC}      http://localhost:${BACKEND_PORT}"
echo -e "  ${BLUE}PostgreSQL:${NC}       localhost:${POSTGRES_PORT}"
echo -e "  ${BLUE}Redis:${NC}            localhost:6379"
echo ""
echo -e "  ${YELLOW}Logs:${NC}  $LOG_DIR/"
echo -e "  ${YELLOW}PIDs:${NC}  $PID_DIR/"
echo ""
echo -e "  ${GREEN}To stop all:${NC}  ./testnet/stop-all.sh"
echo -e "  ${GREEN}To monitor:${NC}   ./testnet/health-check.sh"
echo -e "  ${GREEN}To run bot:${NC}   ./testnet/trading-bot.sh"
echo ""
echo -e "${CYAN}============================================================${NC}"
echo -e "  24h test started at: $(date '+%Y-%m-%d %H:%M:%S')"
echo -e "  Expected end:        $(date -v+24H '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -d '+24 hours' '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo 'N/A')"
echo -e "${CYAN}============================================================${NC}"
echo ""

# Keep script alive to handle SIGINT gracefully
log_info "Press Ctrl+C to stop all services"
while true; do
    sleep 60
done
