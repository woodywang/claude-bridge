#!/bin/bash
# Reads .claude-bridge/counts.json and outputs status line text
# Usage: bridge-status-line.sh [project-dir]
DIR="${1:-.}"
FILE="$DIR/.claude-bridge/counts.json"
if [ ! -f "$FILE" ]; then
  echo "📨 –"
  exit 0
fi
# Check file freshness (ignore if >30s old — MCP server may be stopped)
if [ "$(uname)" = "Darwin" ]; then
  AGE=$(( $(date +%s) - $(stat -f %m "$FILE") ))
else
  AGE=$(( $(date +%s) - $(stat -c %Y "$FILE") ))
fi
if [ "$AGE" -gt 30 ]; then
  exit 0
fi
# Parse total with node (no python dependency)
TOTAL=$(node -e "try{const c=JSON.parse(require('fs').readFileSync('$FILE','utf8'));process.stdout.write(String(c.total||0))}catch{process.stdout.write('0')}" 2>/dev/null)
[ "$TOTAL" -gt 0 ] 2>/dev/null && echo "📨 $TOTAL" || echo "📨 0"
