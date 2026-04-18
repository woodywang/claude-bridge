#!/bin/bash
# Reads .claude-bridge/counts.json and outputs status line text
# Usage: bridge-status-line.sh [project-dir]
DIR="${1:-.}"
FILE="$DIR/.claude-bridge/counts.json"
if [ -f "$FILE" ]; then
  TOTAL=$(python3 -c "import json; print(json.load(open('$FILE'))['total'])" 2>/dev/null)
  [ "$TOTAL" -gt 0 ] 2>/dev/null && echo "📨 $TOTAL" || echo "📨 0"
else
  echo "📨 –"
fi
