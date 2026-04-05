#!/bin/bash
# ═══════════════════════════════════════════════
# Run Module Tests Only (no replay)
# ═══════════════════════════════════════════════
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
E2E_DIR="$(dirname "$SCRIPT_DIR")"

echo "━━━ Running Module Tests (16 suites) ━━━"

cd "$E2E_DIR"

# Install Playwright if needed
npx playwright install chromium --with-deps 2>/dev/null

# Run tests
npx playwright test --reporter=list

echo ""
echo "✅ Module tests complete."
