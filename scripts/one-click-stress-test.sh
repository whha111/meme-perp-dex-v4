#!/usr/bin/env bash
#
# One-Click Stress Test — Full Automation
#
# This script does EVERYTHING with a single button press:
#   1. Rebuild Docker images (backend, matching-engine, frontend, keeper)
#   2. Start all Docker services (postgres, redis, matching-engine, backend, keeper, frontend)
#   3. Wait for all services to be healthy
#   4. Install stress-test dependencies
#   5. Run bootstrap (sell tokens, distribute ETH, create tokens, market-make to 6 ETH)
#   6. Launch 48h stress-test orchestrator (200 spot + 100 perp wallets)
#
# Usage:
#   ./scripts/one-click-stress-test.sh
#   ./scripts/one-click-stress-test.sh --duration 10m --skip-sell
#   ./scripts/one-click-stress-test.sh --skip-rebuild --skip-bootstrap
#
# All logs go to ./stress-test-logs/<timestamp>/
#
set -euo pipefail

# ── Project Root ─────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# ── CLI Args ─────────────────────────────────────────────────────
SKIP_REBUILD=false
SKIP_BOOTSTRAP=false
SKIP_SELL=""
SKIP_DISTRIBUTE=""
DURATION="48h"
SPOT_COUNT=200
PERP_COUNT=100
TOKEN_COUNT=3

for arg in "$@"; do
  case "$arg" in
    --skip-rebuild)    SKIP_REBUILD=true ;;
    --skip-bootstrap)  SKIP_BOOTSTRAP=true ;;
    --skip-sell)       SKIP_SELL="--skip-sell" ;;
    --skip-distribute) SKIP_DISTRIBUTE="--skip-distribute" ;;
    --duration=*)      DURATION="${arg#*=}" ;;
    --spot=*)          SPOT_COUNT="${arg#*=}" ;;
    --perp=*)          PERP_COUNT="${arg#*=}" ;;
    --tokens=*)        TOKEN_COUNT="${arg#*=}" ;;
  esac
done

# ── Log Directory ────────────────────────────────────────────────
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
LOG_DIR="$PROJECT_ROOT/stress-test-logs/$TIMESTAMP"
mkdir -p "$LOG_DIR"

# Tee all output to log file AND terminal
exec > >(tee -a "$LOG_DIR/master.log") 2>&1

# ── Banner ───────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║   🚀 Meme-Perp-DEX One-Click Stress Test            ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  Duration:   $DURATION"
echo "║  Spot:       $SPOT_COUNT wallets"
echo "║  Perp:       $PERP_COUNT wallets"
echo "║  Tokens:     $TOKEN_COUNT"
echo "║  Logs:       $LOG_DIR"
echo "║  Started:    $(date '+%Y-%m-%d %H:%M:%S')"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── Load .env ────────────────────────────────────────────────────
if [ -f "$PROJECT_ROOT/.env" ]; then
  echo "[Step 0] Loading .env..."
  set -a
  source "$PROJECT_ROOT/.env"
  set +a
  echo "[Step 0] ✅ .env loaded"
else
  echo "[Step 0] ❌ No .env file found at $PROJECT_ROOT/.env"
  exit 1
fi

# Verify required vars
if [ -z "${MEMEPERP_BLOCKCHAIN_PRIVATE_KEY:-}" ]; then
  echo "❌ ERROR: MEMEPERP_BLOCKCHAIN_PRIVATE_KEY not set in .env"
  exit 1
fi

if [ -z "${MEMEPERP_DATABASE_PASSWORD:-}" ]; then
  echo "❌ ERROR: MEMEPERP_DATABASE_PASSWORD not set in .env"
  exit 1
fi

if [ -z "${MEMEPERP_JWT_SECRET:-}" ]; then
  echo "❌ ERROR: MEMEPERP_JWT_SECRET not set in .env"
  exit 1
fi

echo "[Step 0] ✅ Required env vars verified"

# ══════════════════════════════════════════════════════════════════
# Step 1: Rebuild Docker Images
# ══════════════════════════════════════════════════════════════════

if [ "$SKIP_REBUILD" = false ]; then
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "[Step 1] Rebuilding Docker images..."
  echo "═══════════════════════════════════════════════════════"

  docker compose build --no-cache 2>&1 | tee "$LOG_DIR/docker-build.log"
  echo "[Step 1] ✅ Docker images rebuilt"
else
  echo "[Step 1] Skipped (--skip-rebuild)"
fi

# ══════════════════════════════════════════════════════════════════
# Step 2: Start Docker Services
# ══════════════════════════════════════════════════════════════════

echo ""
echo "═══════════════════════════════════════════════════════"
echo "[Step 2] Starting Docker services..."
echo "═══════════════════════════════════════════════════════"

# Stop any existing containers first
docker compose down --remove-orphans 2>/dev/null || true

# Start all services
docker compose up -d 2>&1 | tee "$LOG_DIR/docker-up.log"

echo "[Step 2] ✅ Docker compose started"

# ══════════════════════════════════════════════════════════════════
# Step 3: Wait for All Services to be Healthy
# ══════════════════════════════════════════════════════════════════

echo ""
echo "═══════════════════════════════════════════════════════"
echo "[Step 3] Waiting for services to become healthy..."
echo "═══════════════════════════════════════════════════════"

SERVICES=("memeperp-postgres" "memeperp-redis" "memeperp-matching-engine" "memeperp-backend")
MAX_WAIT=300  # 5 minutes max
ELAPSED=0

for service in "${SERVICES[@]}"; do
  echo -n "  Waiting for $service..."
  while true; do
    STATUS=$(docker inspect --format='{{.State.Health.Status}}' "$service" 2>/dev/null || echo "not_found")
    if [ "$STATUS" = "healthy" ]; then
      echo " ✅ healthy"
      break
    fi

    if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
      echo " ❌ TIMEOUT after ${MAX_WAIT}s"
      echo ""
      echo "Docker logs for $service:"
      docker logs --tail 50 "$service" 2>&1
      echo ""
      echo "Continuing anyway — service may still be starting."
      break
    fi

    sleep 5
    ELAPSED=$((ELAPSED + 5))
    echo -n "."
  done
done

# Also check keeper (may not have healthcheck in all versions)
echo -n "  Checking memeperp-keeper..."
if docker ps --format '{{.Names}}' | grep -q memeperp-keeper; then
  echo " ✅ running"
else
  echo " ⚠️  not running (continuing without keeper)"
fi

echo "[Step 3] ✅ Services ready"

# ══════════════════════════════════════════════════════════════════
# Step 4: Install Stress Test Dependencies
# ══════════════════════════════════════════════════════════════════

echo ""
echo "═══════════════════════════════════════════════════════"
echo "[Step 4] Installing stress-test dependencies..."
echo "═══════════════════════════════════════════════════════"

cd "$PROJECT_ROOT/stress-test"
if [ -f "package.json" ]; then
  bun install 2>&1 | tail -5
  echo "[Step 4] ✅ Dependencies installed"
else
  echo "[Step 4] ⚠️  No package.json in stress-test/, assuming deps are ready"
fi
cd "$PROJECT_ROOT"

# ══════════════════════════════════════════════════════════════════
# Step 5: Run Bootstrap (Sell → Distribute → Create → Market-Make)
# ══════════════════════════════════════════════════════════════════

if [ "$SKIP_BOOTSTRAP" = false ]; then
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "[Step 5] Running bootstrap..."
  echo "═══════════════════════════════════════════════════════"

  export DEPLOYER_KEY="$MEMEPERP_BLOCKCHAIN_PRIVATE_KEY"

  bun run "$PROJECT_ROOT/stress-test/bootstrap.ts" \
    $SKIP_SELL \
    $SKIP_DISTRIBUTE \
    --tokens "$TOKEN_COUNT" \
    2>&1 | tee "$LOG_DIR/bootstrap.log"

  BOOTSTRAP_EXIT=$?
  if [ $BOOTSTRAP_EXIT -ne 0 ]; then
    echo "[Step 5] ❌ Bootstrap failed with exit code $BOOTSTRAP_EXIT"
    echo "Check $LOG_DIR/bootstrap.log for details."
    echo "You can rerun with --skip-bootstrap to skip this step."
    exit 1
  fi

  echo "[Step 5] ✅ Bootstrap complete"
else
  echo "[Step 5] Skipped (--skip-bootstrap)"
fi

# ══════════════════════════════════════════════════════════════════
# Step 6: Launch Orchestrator
# ══════════════════════════════════════════════════════════════════

echo ""
echo "═══════════════════════════════════════════════════════"
echo "[Step 6] Launching stress-test orchestrator..."
echo "═══════════════════════════════════════════════════════"
echo "  Duration: $DURATION | Spot: $SPOT_COUNT | Perp: $PERP_COUNT"
echo "  Logs: $LOG_DIR/orchestrator.log"
echo ""

export DEPLOYER_KEY="$MEMEPERP_BLOCKCHAIN_PRIVATE_KEY"

# Run orchestrator in foreground (with tee to log)
bun run "$PROJECT_ROOT/stress-test/orchestrator.ts" \
  --duration "$DURATION" \
  --spot "$SPOT_COUNT" \
  --perp "$PERP_COUNT" \
  --deployer-key "$MEMEPERP_BLOCKCHAIN_PRIVATE_KEY" \
  2>&1 | tee "$LOG_DIR/orchestrator.log"

ORCH_EXIT=$?

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║   Stress Test Complete                                ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  Exit code:  $ORCH_EXIT"
echo "║  Logs:       $LOG_DIR"
echo "║  Ended:      $(date '+%Y-%m-%d %H:%M:%S')"
echo "╚══════════════════════════════════════════════════════╝"

# Copy any generated reports
if ls "$PROJECT_ROOT/stress-test"/report-*.json 1>/dev/null 2>&1; then
  cp "$PROJECT_ROOT/stress-test"/report-*.json "$LOG_DIR/" 2>/dev/null || true
  echo "Reports copied to $LOG_DIR/"
fi

exit $ORCH_EXIT
