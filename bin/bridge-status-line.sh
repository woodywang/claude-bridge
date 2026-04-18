#!/bin/bash
# Reads .claude-bridge/counts.json in cwd and outputs status line text
FILE=".claude-bridge/counts.json"
if [ -f "$FILE" ]; then
  TOTAL=$(python3 -c "import json; print(json.load(open('$FILE'))['total'])" 2>/dev/null)
  [ "$TOTAL" -gt 0 ] 2>/dev/null && echo "📨 $TOTAL" || echo "📨 0"
else
  echo "📨 –"
fi
