# AGENTS.md

## Build & Run (once JS/TS scaffolding exists)
- Install: `npm ci`
- Dev: `npm run dev`
- Build: `npm run build`

## Validation
- Tests: `npm test`
- Typecheck: `npm run typecheck`
- Lint (optional): `npm run lint`

## Conventions
- Follow `ARCHITECTURE.md` as the source of truth.
- Keep outputs deterministic (stable IDs, stable ordering).
- Treat this as infrastructure: emit flow facts, not “findings”.
- One task per iteration in build mode; minimal diffs.

