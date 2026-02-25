#!/bin/bash
# ============================================================
# MEME Perp DEX - Stop All Testnet Services
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_DIR="$SCRIPT_DIR/pids"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC}  $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }

# Stop process by PID file
stop_service() {
    local name=$1
    local pid_file="$PID_DIR/$2.pid"

    if [ -f "$pid_file" ]; then
        local pid=$(cat "$pid_file")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            sleep 1
            # Force kill if still running
            if kill -0 "$pid" 2>/dev/null; then
                kill -9 "$pid" 2>/dev/null || true
            fi
            log_info "Stopped $name (PID: $pid)"
        else
            log_warn "$name was not running (PID: $pid)"
        fi
        rm -f "$pid_file"
    else
        log_warn "No PID file for $name"
    fi
}

echo ""
echo -e "${YELLOW}Stopping all MEME Perp DEX services...${NC}"
echo ""

# Stop services in reverse order
stop_service "Frontend" "frontend"
stop_service "Keeper" "keeper"
stop_service "Backend API" "backend-api"
stop_service "Matching Engine" "matching-engine"

# Stop Docker containers
if docker ps --format '{{.Names}}' | grep -q "memeperp-redis-test"; then
    docker stop memeperp-redis-test > /dev/null 2>&1 || true
    docker rm memeperp-redis-test > /dev/null 2>&1 || true
    log_info "Stopped Redis container"
fi

if docker ps --format '{{.Names}}' | grep -q "memeperp-postgres-test"; then
    docker stop memeperp-postgres-test > /dev/null 2>&1 || true
    docker rm memeperp-postgres-test > /dev/null 2>&1 || true
    log_info "Stopped PostgreSQL container"
fi

# Kill any orphaned processes on known ports
for port in 8081 8080 3000; do
    pid=$(lsof -ti :"$port" 2>/dev/null || true)
    if [ -n "$pid" ]; then
        kill "$pid" 2>/dev/null || true
        log_warn "Killed orphaned process on port $port (PID: $pid)"
    fi
done

# Stop trading bot and health monitor if running
stop_service "Trading Bot" "trading-bot"
stop_service "Health Monitor" "health-monitor"

echo ""
echo -e "${GREEN}All services stopped.${NC}"
echo ""
