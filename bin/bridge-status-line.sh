#!/bin/bash
# Reads .claude-bridge/counts.json and outputs status line text
# Usage: bridge-status-line.sh [project-dir]
# Ignores stale files (>30s old) to avoid showing wrong counts after MCP restart
DIR="${1:-.}"
FILE="$DIR/.claude-bridge/counts.json"
if [ ! -f "$FILE" ]; then
  echo "📨 –"; exit 0
fi
# Check file age — stale if older than 30 seconds
AGE=$(( $(date +%s) - $(stat -f %m "$FILE" 2>/dev/null || stat -c %Y "$FILE" 2>/dev/null) ))
if [ "$AGE" -gt 30 ]; then
  echo "📨 –"; exit 0
fi
TOTAL=$(python3 -c "import json; print(json.load(open('$FILE'))['total'])" 2>/dev/null)
[ "$TOTAL" -gt 0 ] 2>/dev/null && echo "📨 $TOTAL" || echo "📨 0"
