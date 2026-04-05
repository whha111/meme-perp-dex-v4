#!/bin/bash
# ═══════════════════════════════════════════════
# Run GMX Replay Only (skip module tests)
# ═══════════════════════════════════════════════
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
E2E_DIR="$(dirname "$SCRIPT_DIR")"

echo "━━━ GMX 48h Replay ━━━"
cd "$E2E_DIR"

# Verify infrastructure
echo "  Verifying infrastructure..."
bun run infrastructure/verify-infrastructure.ts

# Run replay
echo "  Starting replay..."
bun run replay/replay-executor.ts

# Validate
echo "  Running balance audit..."
bun run monitors/balance-auditor.ts

# Report
echo "  Generating report..."
bun run reports/report-generator.ts

echo ""
echo "✅ Replay complete. Report at: e2e-test/reports/report.md"
