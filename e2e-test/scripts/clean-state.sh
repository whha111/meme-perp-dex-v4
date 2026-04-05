#!/bin/bash
# ═══════════════════════════════════════════════
# Clean all test state — reset to fresh environment
# ═══════════════════════════════════════════════
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
E2E_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(dirname "$E2E_DIR")"

echo "🧹 Cleaning E2E test state..."

# 1. Flush Redis (matching engine state)
echo "  Flushing Redis..."
REDIS_PASSWORD=$(grep MEMEPERP_REDIS_PASSWORD "$PROJECT_DIR/.env" 2>/dev/null | cut -d= -f2)
if [ -n "$REDIS_PASSWORD" ]; then
  docker exec memeperp-redis redis-cli -a "$REDIS_PASSWORD" FLUSHALL 2>/dev/null || echo "  ⚠️ Redis flush skipped (container not running?)"
else
  docker exec memeperp-redis redis-cli FLUSHALL 2>/dev/null || echo "  ⚠️ Redis flush skipped"
fi

# 2. Truncate PostgreSQL test tables
echo "  Truncating PG tables..."
docker exec memeperp-postgres psql -U postgres -d memeperp -c "
  TRUNCATE TABLE orders, positions, trades, bills, balance_snapshots CASCADE;
" 2>/dev/null || echo "  ⚠️ PG truncate skipped (tables may not exist)"

# 3. Delete generated data files
echo "  Removing data files..."
rm -f "$E2E_DIR/data/wallets.json"
rm -f "$E2E_DIR/data/token-addresses.json"

# 4. Remove reports
echo "  Removing reports..."
rm -f "$E2E_DIR/reports/report.md"
rm -f "$E2E_DIR/reports/report.html"
rm -f "$E2E_DIR/reports/results.json"

# 5. Restart matching engine to clear in-memory state
echo "  Restarting matching engine..."
docker restart memeperp-matching-engine 2>/dev/null || echo "  ⚠️ Matching engine restart skipped"

echo ""
echo "✅ Clean complete. Run 'bun run setup' to re-initialize."
