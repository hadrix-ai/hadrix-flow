===============================================================================
RALPH WIGGUM + CODEX CLI
COMPLETE IMPLEMENTATION GUIDE (SINGLE COPYABLE BLOCK)
===============================================================================

This document explains how to implement a “Ralph Wiggum” loop that repeatedly
spawns Codex CLI to execute tasks from a checklist / implementation plan.
It follows the mechanics described in:
- ghuntley/how-to-ralph-wiggum (as the behavioral spec)
- Codex CLI non-interactive usage (codex exec)

-------------------------------------------------------------------------------
0. WHAT YOU ARE BUILDING (MENTAL MODEL)
-------------------------------------------------------------------------------

You are building a dumb outer loop + smart inner agent.

Core ideas:
- Each iteration is a fresh Codex invocation (no memory across runs).
- Shared state lives ONLY in files on disk.
- One iteration = one checklist item.
- Planning and building are separate modes.
- The loop runs until you stop it or the plan is complete.

Key files:
- IMPLEMENTATION_PLAN.md  -> persistent checklist (shared state)
- PROMPT_plan.md         -> generates/updates the plan
- PROMPT_build.md        -> executes exactly one task
- AGENTS.md              -> build/test/run backpressure
- loop.sh                -> outer control loop

-------------------------------------------------------------------------------
1. REPO LAYOUT
-------------------------------------------------------------------------------

project-root/
├── loop.sh
├── PROMPT_plan.md
├── PROMPT_build.md
├── AGENTS.md
├── IMPLEMENTATION_PLAN.md
├── specs/
│   └── optional-requirements.md
└── src/
    └── application-code

Rules:
- Codex must run inside a git repository.
- IMPLEMENTATION_PLAN.md is the single source of truth for task state.

-------------------------------------------------------------------------------
2. CODEX CLI REQUIREMENTS
-------------------------------------------------------------------------------

- Install Codex CLI and authenticate.
- Use `codex exec` (non-interactive, scriptable).
- Prefer `--full-auto` for local automation.
- Optional: `--json` to emit JSONL events for logging.

Codex expectations:
- Repo must be a git repo (unless overridden).
- Agent starts fresh every invocation.

-------------------------------------------------------------------------------
3. LOOP SCRIPT (loop.sh)
-------------------------------------------------------------------------------

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
BRANCH="$(git branch --show-current)"

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

  git push origin "$BRANCH" || git push -u origin "$BRANCH" || true

  ITER=$((ITER + 1))
done

-------------------------------------------------------------------------------
4. IMPLEMENTATION_PLAN.md (CHECKLIST FORMAT)
-------------------------------------------------------------------------------

This file is the shared state across iterations.

Example:

# IMPLEMENTATION_PLAN.md

## Goal
Ship v0.1 of the service.

## Tasks (highest priority first)
- [ ] Add /health endpoint
- [ ] Add database migration for users table
- [ ] Add authentication middleware
- [ ] Add unit tests for auth middleware

Rules:
- Tasks must be small enough to complete in ONE iteration.
- Only this file tracks what is done vs not done.

-------------------------------------------------------------------------------
5. AGENTS.md (BACKPRESSURE + OPERATIONS)
-------------------------------------------------------------------------------

Keep this short and boring.

Example:

# AGENTS.md

## Build & Run
- Install: npm ci
- Dev: npm run dev
- Build: npm run build

## Validation
- Tests: npm test
- Typecheck: npm run typecheck
- Lint: npm run lint

## Conventions
- Make minimal, scoped changes.
- Prefer existing utilities over new abstractions.

-------------------------------------------------------------------------------
6. PROMPT_plan.md (PLANNING MODE)
-------------------------------------------------------------------------------

You are operating in PLANNING mode.

Canonical files:
- AGENTS.md
- IMPLEMENTATION_PLAN.md
- specs/*
- repository source code

Task:
1. Read specs/* and inspect the current codebase.
2. Create or update IMPLEMENTATION_PLAN.md as a prioritized checklist.
3. Do NOT implement any code changes.
4. Break work into tasks small enough for one-iteration execution.

Output rules:
- Only modify IMPLEMENTATION_PLAN.md.
- Do not create commits unrelated to planning.
- Stop after updating the plan.

-------------------------------------------------------------------------------
7. PROMPT_build.md (BUILDING MODE)
-------------------------------------------------------------------------------

You are operating in BUILDING mode.

Canonical files:
- AGENTS.md
- IMPLEMENTATION_PLAN.md
- specs/*

Rules:
- Select the highest-priority unchecked task.
- Implement ONLY that task.
- Run validation commands from AGENTS.md.
- Fix failures until validation passes.
- Mark the task complete in IMPLEMENTATION_PLAN.md.
- Commit the change with a clear message.
- Exit immediately after the commit.

Constraints:
- One task per iteration.
- No unrelated refactors.
- Search the codebase before adding new logic.

-------------------------------------------------------------------------------
8. STOP CONDITIONS
-------------------------------------------------------------------------------

Manual:
- Press Ctrl+C to stop the loop.

Optional automatic:
- If no unchecked tasks remain, the agent may print:
  ALL_TASKS_COMPLETE
- The loop script can be extended to detect this and exit.

-------------------------------------------------------------------------------
9. SAFETY & BLAST RADIUS
-------------------------------------------------------------------------------

- Run in an isolated environment when possible.
- Avoid embedding secrets in prompts or repo files.
- Prefer Codex sandbox defaults unless broader access is required.
- Treat the loop as production automation, not a toy.

-------------------------------------------------------------------------------
10. COMMON FAILURE MODES & FIXES
-------------------------------------------------------------------------------

Problem: Agent repeats work
Fix: Strengthen “search first” and “one task only” rules in PROMPT_build.md

Problem: Plan drifts or gets messy
Fix: Re-run planning mode to regenerate IMPLEMENTATION_PLAN.md

Problem: Agent does too much in one iteration
Fix: Enforce commit + exit requirement more strictly

-------------------------------------------------------------------------------
END OF GUIDE
-------------------------------------------------------------------------------
