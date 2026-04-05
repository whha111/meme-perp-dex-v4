#!/bin/bash
# ═══════════════════════════════════════════════
# Full E2E Test Orchestrator
# Runs: infrastructure → module tests → replay → report
# ═══════════════════════════════════════════════
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
E2E_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(dirname "$E2E_DIR")"

echo "╔══════════════════════════════════════════════════════╗"
echo "║  MEME PERP DEX — Full E2E Production Rehearsal      ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ─── Phase 0: Docker services ───
echo "━━━ Phase 0: Verify Docker services ━━━"
cd "$PROJECT_DIR"
docker compose ps --format json | head -5
echo ""

# Check all services healthy
for service in frontend matching-engine backend postgres redis; do
  status=$(docker compose ps "$service" --format "{{.Status}}" 2>/dev/null | head -1)
  if echo "$status" | grep -q "healthy\|Up"; then
    echo "  ✅ $service: $status"
  else
    echo "  ❌ $service: $status"
    echo "  Run: docker compose up -d"
    exit 1
  fi
done
echo ""

# ─── Phase 1: Infrastructure ───
echo "━━━ Phase 1: Infrastructure Setup ━━━"
cd "$E2E_DIR"

if [ ! -f "data/wallets.json" ]; then
  echo "  Generating wallets..."
  bun run infrastructure/generate-wallets.ts
fi

if [ ! -f "data/token-addresses.json" ]; then
  echo "  Creating test tokens..."
  bun run infrastructure/create-test-tokens.ts
fi

echo "  Distributing BNB..."
bun run infrastructure/distribute-bnb.ts

echo "  Verifying infrastructure..."
bun run infrastructure/verify-infrastructure.ts
echo ""

# ─── Phase 2: Module Tests ───
echo "━━━ Phase 2: Module Tests (16 suites) ━━━"
npx playwright install chromium --with-deps 2>/dev/null
npx playwright test --reporter=list
MODULES_EXIT=$?
echo ""

if [ $MODULES_EXIT -ne 0 ]; then
  echo "❌ Module tests failed. Aborting replay."
  exit 1
fi

# ─── Phase 3: GMX Replay ───
echo "━━━ Phase 3: GMX 48h Replay (4,339 trades) ━━━"
bun run replay/replay-executor.ts
echo ""

# ─── Phase 4: Validation ───
echo "━━━ Phase 4: Post-Replay Validation ━━━"
bun run monitors/balance-auditor.ts
echo ""

# ─── Phase 5: Report ───
echo "━━━ Phase 5: Generating Report ━━━"
bun run reports/report-generator.ts
echo ""

echo "╔══════════════════════════════════════════════════════╗"
echo "║  E2E TEST COMPLETE                                   ║"
echo "║  Report: e2e-test/reports/report.html                ║"
echo "╚══════════════════════════════════════════════════════╝"
