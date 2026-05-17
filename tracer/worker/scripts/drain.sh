#!/usr/bin/env bash
# Force-tick the stepper in a tight loop and watch the queue drain.
# Usage: ./scripts/drain.sh [count=20] [delay_seconds=4]
set -euo pipefail
cd "$(dirname "$0")/.."

COUNT="${1:-20}"
DELAY="${2:-4}"

# Source env for python watch script
set -a; source .env.local; set +a
TOKEN="$NOTION_API_TOKEN"

echo "=== BEFORE ==="
NOTION_API_TOKEN="$TOKEN" python3 scripts/watch_runs.py 1 1

START=$(date +%s)
for i in $(seq 1 "$COUNT"); do
  printf '[tick %2d] ' "$i"
  ( unset NOTION_API_TOKEN; ntn workers sync trigger functionStepper 2>&1 | head -1 )
  sleep "$DELAY"
done
ELAPSED=$(( $(date +%s) - START ))

echo "=== AFTER (${ELAPSED}s) ==="
NOTION_API_TOKEN="$TOKEN" python3 scripts/watch_runs.py 1 1
