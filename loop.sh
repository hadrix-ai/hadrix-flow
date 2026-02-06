#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./loop.sh            -> build mode, unlimited iterations
#   ./loop.sh 10         -> build mode, max 10 iterations
#   ./loop.sh plan       -> planning mode
#   ./loop.sh plan 3     -> planning mode, max 3 iterations

MODE="build"
PROMPT_FILE="PROMPT_build.md"
MAX_ITERATIONS=0

if [[ "${1-}" == "plan" ]]; then
  MODE="plan"
  PROMPT_FILE="PROMPT_plan.md"
  MAX_ITERATIONS="${2-0}"
elif [[ "${1-}" =~ ^[0-9]+$ ]]; then
  MAX_ITERATIONS="$1"
fi

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "Missing prompt file: $PROMPT_FILE"
  exit 1
fi

LOG_DIR=".ralph-logs"
mkdir -p "$LOG_DIR"

ITER=0
BRANCH="$(git branch --show-current 2>/dev/null || true)"
if [[ -z "$BRANCH" ]]; then
  BRANCH="(detached)"
fi

echo "========================================"
echo "Mode:   $MODE"
echo "Prompt: $PROMPT_FILE"
echo "Branch: $BRANCH"
echo "========================================"

while true; do
  if [[ "$MAX_ITERATIONS" -gt 0 && "$ITER" -ge "$MAX_ITERATIONS" ]]; then
    echo "Reached max iterations"
    break
  fi

  TS="$(date -u +"%Y%m%dT%H%M%SZ")"
  LOG_FILE="$LOG_DIR/${TS}-${MODE}-iter${ITER}.jsonl"

  echo ""
  echo "----- ITERATION $ITER -----"
  echo "Log: $LOG_FILE"
  echo ""

  codex exec --full-auto --json "$(cat "$PROMPT_FILE")" \
    2> >(tee -a "$LOG_FILE" >&2) | tee -a "$LOG_FILE" >/dev/null || true

  if rg -q "ALL_TASKS_COMPLETE" "$LOG_FILE" 2>/dev/null; then
    echo "ALL_TASKS_COMPLETE"
    break
  fi

  if git remote get-url origin >/dev/null 2>&1; then
    if [[ "$BRANCH" != "(detached)" ]]; then
      git push origin "$BRANCH" || git push -u origin "$BRANCH" || true
    fi
  fi

  ITER=$((ITER + 1))
done

