# Recast

[![CI](https://github.com/gsoffmarket/recast/actions/workflows/ci.yml/badge.svg)](https://github.com/gsoffmarket/recast/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Node 24](https://img.shields.io/badge/node-24-339933.svg)
![Kane CLI 0.10.9](https://img.shields.io/badge/Kane%20CLI-0.10.9-8052ff.svg)

**Rebuild the software. Keep the behaviour.**

Recast watches a working legacy web app, turns what it does into frozen, hashed requirements, finds what a replacement UI is missing, hands each confirmed gap to a coding agent, and accepts the agent's patch only when [Kane CLI](https://www.testmuai.com/kane-cli/) and an independent oracle show the original requirement passing on the new code.

> Built for the KaneCLI Online Hackathon by TestMu AI. Status: the observe → freeze → compare loop runs end to end on a real, independently documented case. The repair loop is built; its first live result is pending (see [Results](#results)).

## The reference case: Trino's new web UI

[Trino](https://trino.io) 481 ships two web UIs in the same coordinator: the classic UI at `/ui/` and a rewritten "preview" UI at `/ui/preview/`. In the classic UI an operator can kill a running query from its details page. The preview UI in 481 cannot; Trino 482's [release notes](https://trino.io/docs/current/release/release-482.html) record adding that control later. That is a real behaviour lost in a real UI migration, documented by the project itself, and Recast's job is to find it and get it fixed without being told.

## How it works

```
 legacy UI ──Kane──▶ observe ──▶ requirement ──baseline ×2──▶ FROZEN (hash)
                                                               │
 new UI ─────Kane──▶ compare ──▶ oracle says MISSING ×2 ───────┤
                                                               ▼
 coding agent ◀── task (evidence only) ── isolated worktree ──▶ patch
      │
      └─▶ build gate ─▶ candidate commit ─▶ Kane + oracle re-run the SAME frozen requirement ─▶ verified / retry
```

1. **Requirement, not a script.** A requirement states an intent ("cancel this running query using only the web UI") and typed assertions checked by an oracle (`query.state equals "FAILED"`, `query.errorCode in [ADMINISTRATIVELY_KILLED, USER_CANCELED]`). Its SHA-256 covers the spec, fixture identity, assertions and comparator version.
2. **Baseline and freeze.** Kane performs the intent on the legacy UI against a fresh, independent running query per run. Two matching runs establish it; freezing makes it immutable (a Postgres trigger refuses edits).
3. **Compare.** The same intent runs on the new UI. Recast never takes Kane's pass/fail as the verdict: a deterministic classifier reads the oracle (`GET /v1/query/{id}` with a bounded settle time) and needs two consistent target runs to call a gap.
4. **Repair.** The task the agent gets is built only from evidence: the frozen requirement, the legacy UI's observed browser steps and network effect (pulled from Kane's evidence pack), and the new UI's failing steps. The agent runs headless in a sparse git worktree of the target, can read and edit files and run the app's own type check, lint and formatter, and nothing else: no web access, no git, no MCP servers.
5. **Independent proof.** Recast rejects changes outside the allowed folder and any change to its own verifier or specs, runs the build gate, commits the candidate, serves it, and re-runs the same frozen requirement with Kane and the oracle. Only that decides.

## How Kane CLI is used

| Stage | Kane | Code |
|---|---|---|
| Preflight | `kane-cli --version`, `whoami`, `balance` | [`packages/kane-adapter`](packages/kane-adapter/src/index.ts), `recast doctor` |
| Baseline / compare / re-verify | `kane-cli run "<objective>" --url … --agent --headless --variables … --max-steps 15` | [`packages/runner`](packages/runner/src/index.ts) |
| Structured results | Agent-mode NDJSON (`stream_start`, step events, `run_end`) parsed and stored as run events | [`packages/kane-adapter`](packages/kane-adapter/src/index.ts) |
| Evidence | Evidence pack per run: size and path checks, SHA-256, HAR network effects for the repair task | [`packages/kane-adapter`](packages/kane-adapter/src/index.ts), [`packages/runner/src/repair.ts`](packages/runner/src/repair.ts) |

The objective text is identical for both UIs; run values such as the query ID go in as Kane variables.

## Docs

- [Architecture](docs/architecture.md) · [Contributing](CONTRIBUTING.md) · [Security and agent containment](SECURITY.md)

## Install and run

Requirements: Node 24, pnpm 9, Docker (Colima works), Kane CLI 0.10.9 logged in, and for repair, Claude Code.

```bash
pnpm install
cp .env.example .env          # set RECAST_PG_PASSWORD and the matching DATABASE_URL
docker-compose up -d          # Postgres 17 + Redis 7 on localhost
docker run -d --name recast-trino -p 8080:8080 trinodb/trino:481
pnpm recast init --config evaluation/trino/recast.config.json
pnpm recast doctor
```

In a second terminal: `pnpm worker`. Then:

```bash
pnpm recast requirements add evaluation/trino/requirements/REQ-QRY-CANCEL.json
pnpm recast baseline --requirement REQ-QRY-CANCEL --runs 2
pnpm recast freeze   --requirement REQ-QRY-CANCEL
pnpm recast compare  --requirement REQ-QRY-CANCEL --target trino-preview --runs 2
pnpm recast repair   --requirement REQ-QRY-CANCEL --max-attempts 3
pnpm recast report --format markdown
```

Exit codes: 0 ok, 1 confirmed gap, 2 invalid configuration, 3 inconclusive or infrastructure, 4 cancelled.

## Results

All figures below are measured on 25 Nov 2026 with Kane CLI 0.10.9 against `trinodb/trino:481` on one laptop.

| Step | Runs | Outcome |
|---|---|---|
| Baseline on classic UI | 2 | 2 of 2 satisfied: query `FAILED / ADMINISTRATIVELY_KILLED`. Kane itself passed only 1 of 2: in the other run it clicked Kill and then ran out of steps; the oracle still saw the kill. |
| Compare on preview UI | 2 | 2 of 2 not satisfied: query still `RUNNING` 10 s after each run → **MISSING** (`REPRODUCIBLE_MISMATCH`). |
| Repair | 0 | First attempt stopped before any patch: the agent's plan hit its usage limit. No credits were spent; rerun pending. |

Earlier manual spike (M0): classic UI cancelled 3 of 3, preview UI still running 3 of 3.

### Adversarial checks (no model, no credits)

`recast repair --simulate-agent <kind>` runs scripted misbehaving agents against the real guards:

| Scenario | What the "agent" does | Result |
|---|---|---|
| `tamper-spec` | Rewrites the frozen requirement file so a still-running query would pass | Rejected as a protected-file change; diff kept as evidence; file restored byte for byte |
| `tamper-db` | Tries to rewrite the frozen revision in Postgres | Refused by the database: "requirement REQ-QRY-CANCEL r1 is frozen; create a new revision" |
| `edit-outside-src` | Adds a dependency to `package.json` plus a source edit | Rejected: change outside the allowed folder |

After all three, REQ-QRY-CANCEL r1 still has its original hash and expected values.

### Equivalent-UI control

REQ-QRY-OWNER ("see who submitted a running query on its page") is supported by both UIs with different layouts, so Recast must call it Preserved on the preview UI. The control is running now; this section will report its measured result.

What we learned, and why Recast is built this way:

- **Kane's verdict is not the result.** In our runs Kane's own triage called real preview-UI gaps "agent missteps", once claimed it never reached a page its own screenshot shows, and failed a classic run where the kill had happened. Recast classifies from the oracle and keeps Kane's verdict as evidence only.
- **Exit codes need care.** Kane 0.10.9 sometimes exits 3 ("cancelled") after writing a complete, failed `run_end`; Recast treats that as a finished run.
- **Cost is real.** About 41–63 credits per run in this case, measured by balance before and after each run.

## Limitations

- One requirement in scope so far; the report counts denominators honestly and says so.
- Discovery through Kane Exploration (cloud) is not wired up yet; requirements are written from observed runs.
- The candidate is served by the target's Vite dev server against the real Trino 481 coordinator, not a rebuilt Trino jar.
- Recast does not certify whole-app parity, deploy, or merge anything.

## Licence and attribution

Recast is Apache-2.0. Trino is Apache-2.0 and is not vendored here: the evaluation fetches tag 481 of [trinodb/trino](https://github.com/trinodb/trino) into an ignored folder at run time, and any candidate patch stays on a local branch of that checkout.
