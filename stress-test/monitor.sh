#!/bin/bash
# 24h Stress Test Monitor — Runs periodic health checks
# Usage: ./monitor.sh [interval_seconds]

INTERVAL=${1:-300}  # Default: every 5 minutes
LOG="/tmp/stress-test-monitor.log"
PID_FILE="/tmp/stress-test-24h.pid"
STRESS_LOG="/tmp/stress-test-24h.log"

echo "=== Stress Test Monitor Started ===" | tee -a "$LOG"
echo "Interval: ${INTERVAL}s | Log: $LOG" | tee -a "$LOG"
echo "" | tee -a "$LOG"

check_count=0

while true; do
  check_count=$((check_count + 1))
  ts=$(date '+%Y-%m-%d %H:%M:%S')
  echo "[$ts] Check #$check_count" | tee -a "$LOG"

  # 1. Stress test process alive?
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if ps -p "$PID" > /dev/null 2>&1; then
      MEM=$(ps -o rss= -p "$PID" 2>/dev/null | awk '{printf "%.0f", $1/1024}')
      CPU=$(ps -o %cpu= -p "$PID" 2>/dev/null | xargs)
      echo "  [STRESS] ✅ Running (PID=$PID, ${MEM}MB, ${CPU}% CPU)" | tee -a "$LOG"
    else
      echo "  [STRESS] ❌ DEAD (PID=$PID)" | tee -a "$LOG"
    fi
  else
    echo "  [STRESS] ❌ No PID file" | tee -a "$LOG"
  fi

  # 2. Matching engine health
  HEALTH=$(curl -s --max-time 5 http://localhost:8081/health 2>/dev/null)
  if [ -n "$HEALTH" ]; then
    STATUS=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'ok mem={d[\"metrics\"][\"memoryMB\"]}MB orders={d[\"metrics\"][\"totalOrders\"]} reqs={d[\"metrics\"][\"totalRequests\"]}')" 2>/dev/null)
    echo "  [ENGINE] ✅ $STATUS" | tee -a "$LOG"
  else
    echo "  [ENGINE] ❌ NOT RESPONDING" | tee -a "$LOG"
  fi

  # 3. Redis
  REDIS=$(redis-cli ping 2>/dev/null)
  REDIS_MEM=$(redis-cli info memory 2>/dev/null | grep "used_memory_human" | cut -d: -f2 | tr -d '\r')
  if [ "$REDIS" = "PONG" ]; then
    echo "  [REDIS]  ✅ Connected (${REDIS_MEM})" | tee -a "$LOG"
  else
    echo "  [REDIS]  ❌ DOWN" | tee -a "$LOG"
  fi

  # 4. Error counts in stress log
  if [ -f "$STRESS_LOG" ]; then
    LINES=$(wc -l < "$STRESS_LOG" | xargs)
    ERRORS=$(grep -c "error\|Error" "$STRESS_LOG" 2>/dev/null)
    FATALS=$(grep -c "FATAL\|Fatal\|panic" "$STRESS_LOG" 2>/dev/null)
    AUDITS_PASS=$(grep -c "PASS" "$STRESS_LOG" 2>/dev/null)
    AUDITS_FAIL=$(grep -c "FAIL" "$STRESS_LOG" 2>/dev/null)
    RPC_429=$(grep -c "429" "$STRESS_LOG" 2>/dev/null)
    echo "  [LOGS]   Lines=$LINES Errors=$ERRORS Fatals=$FATALS Audits=${AUDITS_PASS}✅/${AUDITS_FAIL}❌ RPC429=$RPC_429" | tee -a "$LOG"
  fi

  echo "" | tee -a "$LOG"
  sleep "$INTERVAL"
done
