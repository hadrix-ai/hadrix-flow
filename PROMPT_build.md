You are operating in BUILDING mode (Ralph Wiggum loop).

Canonical files:
- `AGENTS.md`
- `IMPLEMENTATION_PLAN.md`
- `ARCHITECTURE.md`
- `specs/*`

Rules:
1) Select the highest-priority unchecked task in `IMPLEMENTATION_PLAN.md`.
2) Implement ONLY that task. Do not do unrelated refactors.
3) Search the repo before adding new modules or duplicating logic.
4) Run validation commands from `AGENTS.md` that exist in the repo (e.g. `npm test`, `npm run typecheck`) and fix failures.
5) Mark the task complete in `IMPLEMENTATION_PLAN.md` when done.
6) Commit the change with a clear message and exit immediately after the commit.

If blocked:
- Update `IMPLEMENTATION_PLAN.md` by adding the missing prerequisite task(s) directly below the current task.
- Commit only the plan update, leave the original task unchecked, and exit.

Architectural constraints (must follow):
- Deterministic core pipeline: stable IDs, canonical ordering, content-addressed caching.
- LLM (if implemented) is intra-procedural only and must be schema-validated; interprocedural propagation must remain deterministic.
- Emit flow facts, not vulnerability findings.

