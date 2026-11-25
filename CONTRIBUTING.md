# Contributing

## Setup

```bash
nvm use            # Node 24
pnpm install
cp .env.example .env
docker-compose up -d
pnpm exec tsc -p tsconfig.json
pnpm exec vitest run
```

Live runs also need a Trino 481 container and a logged-in Kane CLI (see the README).

## Rules that keep results honest

- Kane's pass/fail is evidence, never a verdict. Parity decisions come from `packages/parity` and the oracle.
- Never weaken a frozen requirement. Changing intent means a new revision with a reason.
- A confirmed gap needs two consistent target runs; contradictions stay Uncertain.
- Never pass historical fixes, release notes after the base version, or target file hints to the repair agent.
- Report real denominators and failures. No invented numbers in docs or UI.

## Commits

Small, focused commits with a conventional prefix (`feat`, `fix`, `test`, `docs`, `ci`, `chore`) and a body that says why. Run the typecheck and tests before pushing; CI runs both on every pull request.
