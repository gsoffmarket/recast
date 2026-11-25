# Architecture

Recast is a TypeScript monorepo (pnpm workspaces, Node 24 running `.ts` directly). State lives in Postgres; work runs through a BullMQ queue in Redis; Kane CLI and the coding agent run as subprocesses on the same machine as the apps under test.

```
recast CLI ──▶ BullMQ (Redis) ──▶ worker ──▶ fixture ─▶ Kane CLI ─▶ oracle ─▶ evaluation
     │                               │                                     │
     └──────────── Postgres: projects, requirement revisions, runs, run_events, observations,
                   parity_results, migration_tasks, agent_attempts, task_events ◀──────────┘
                                     ▲
              read-only web UI (SSE) ┘
```

## Packages

| Package | Owns | Never does |
|---|---|---|
| `shared` | canonical JSON, content hashes, result names, redaction | anything stateful |
| `behaviour-spec` | requirement schema, frozen hash, objective compilation | decide pass/fail |
| `kane-adapter` | `kane-cli` subprocess, NDJSON parsing, exit-code mapping, evidence packs | judge business outcomes |
| `observations` | Trino REST oracle, running-query fixture, Kane page readings as `ui.*` | invent missing values |
| `parity` | typed comparators and the classifier | read Kane's verdict |
| `db` | schema, migrations, repositories | business decisions |
| `runner` | one run end to end, the queue, the repair loop | trust the agent's claims |
| `coding-agents` | worktrees, Claude Code driver, diff guard, build gate, candidate server | write specs or verifier code |
| `reports` | acceptance report (markdown, JSON, CSV) | include local paths or secrets |
| `web` | read-only workspace UI on 127.0.0.1 | mutate state or run commands |
| `cli` | `recast` commands and exit codes | duplicate verification logic |

## One run

1. Load the requirement revision; if frozen, re-check its hash.
2. Fingerprint the environment and check the Kane balance against the floor.
3. Start a fresh, independent running query (the fixture).
4. Compile the requirement into a Kane objective with variables and run `kane-cli run --agent`; every step is stored as a run event.
5. Observe: the REST oracle polls `GET /v1/query/{id}` up to the requirement's settle time; Kane's stored page readings become `ui.*` observations.
6. Cancel any leftover query through REST (logged, and distinguishable from a UI kill).
7. Record the evidence pack hash, the balance after, and the evaluation.

## Classification

`classify` takes the requirement, source runs and target runs. It returns Untested without an established baseline or target runs, Uncertain when any observation is missing or runs disagree, Missing only after two consistent failing target runs, and Preserved or Intentional change when all target runs satisfy the assertions. Kane's own `run_end` status is evidence, never an input.

## Repair

A task is created only from a current Missing result. The agent's briefing is built from evidence alone. Each attempt gets a sparse worktree of the target at the base ref, the agent runs with an explicit tool allowlist, and Recast then checks protected files, allowed paths and the build gate before committing a candidate and re-running the same frozen requirement against it. An unavailable agent cancels the task without using attempts.
