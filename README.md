# Recast

[![CI](https://github.com/gsoffmarket/recast/actions/workflows/ci.yml/badge.svg)](https://github.com/gsoffmarket/recast/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Node 24](https://img.shields.io/badge/node-24-339933.svg)
![Kane CLI 0.10.9](https://img.shields.io/badge/Kane%20CLI-0.10.9-8052ff.svg)

**Rebuild the software. Keep the behaviour.**

Recast is a behaviour-parity tool for UI migrations. It uses [Kane CLI](https://www.testmuai.com/kane-cli/) to observe a working legacy web app, turns what the app does into frozen, hashed requirements, finds what a replacement UI has lost, hands each confirmed gap to a coding agent, and accepts the agent's patch only after Kane and an independent oracle show the original requirement passing on the new code.

Built for the KaneCLI Online Hackathon by TestMu AI.

## The problem

Teams rebuild legacy front ends all the time: a new framework, a redesign, a "preview" UI that will replace the old one. The visible screens get rebuilt; the behaviour hidden in them often does not. A button that kills a stuck job, a permission check, an edge case in a form: these live in the old app's behaviour, not in any spec, and they quietly disappear in the rewrite. Coding agents make rewrites faster, which makes this worse: an agent rebuilds what it is shown, not what it was never told.

Recast is for engineering teams and agencies running a migration who need to know, with evidence, what the new UI still does, what it has lost, and whether a fix really restores it.

### A real example

[Trino](https://trino.io) 481 ships two web UIs in the same coordinator: the classic UI at `/ui/` and a rewritten "preview" UI at `/ui/preview/`. In the classic UI an operator can kill or preempt a running query from its page. The 481 preview UI cannot. Trino 482's [release notes](https://trino.io/docs/current/release/release-482.html) record adding those controls later. Recast finds this gap on its own, proves it with Trino's REST API, and drives a fix.

## How it works

```
 legacy UI ──Kane Exploration──▶ map of screens, controls, flows ──▶ candidate requirements
                                                                          │ baseline ×2
 legacy UI ──Kane run──▶ oracle ──▶ established ──freeze──▶ FROZEN requirement (SHA-256)
                                                                          │
 new UI ─────Kane run──▶ oracle ──▶ MISSING ×2 (confirmed gap) ◀─────────┘
                                         │
 coding agent ◀── task built from evidence only, isolated worktree ──▶ patch
      │
      └─▶ guards + build gate ─▶ candidate commit ─▶ Kane + oracle re-run the SAME frozen
          requirement ─▶ regression re-check of every other preserved requirement ─▶ verified
```

1. **Observe.** `recast discover run` drives `kane-cli explore run` against the legacy app and imports Kane's map: screens, their controls, verified flows and findings. State-changing controls (such as Kill and Preempt) and verified flows become candidate requirements.
2. **Specify and freeze.** A requirement states an intent ("cancel this running query using only the web UI") and typed assertions checked by an oracle (`query.state equals "FAILED"`). Two matching baseline runs on the legacy app establish it; freezing locks it with a SHA-256 over the spec, fixture, assertions and comparator version. Postgres refuses edits to frozen revisions.
3. **Compare.** The same intent runs on the new UI through `kane-cli run --agent`. A deterministic classifier reads the oracle, never Kane's own pass/fail, and needs two consistent failing runs to call a gap Missing. An equivalent UI comes out Preserved.
4. **Repair.** The coding agent (Claude Code, headless) gets a briefing built only from evidence: the frozen requirement, the legacy UI's observed browser steps and network effect (from Kane's evidence pack), and the new UI's failing steps. It works in a sparse git worktree of the target with an explicit tool allowlist and no web, git or MCP access.
5. **Verify independently.** Recast rejects changes outside the allowed folder and any change to its own verifier or specs, runs the target's build gate, commits the candidate, serves it, and re-runs the same frozen requirement with Kane and the oracle. Every previously preserved requirement is re-checked on the candidate so a fix cannot break something else.

### How it is built

| Layer | Technology | Responsibility |
|---|---|---|
| Browser agent | Kane CLI 0.10.9 (`run --agent`, `explore run`, evidence packs) | Performs intents in real Chrome, maps apps, records evidence |
| Oracle | Target's own API (Trino REST `GET /v1/query/{id}`) plus Kane page readings | Decides what actually happened |
| Core | TypeScript (strict) monorepo, pnpm workspaces, Node 24 running `.ts` directly, Zod | Specs, hashing, classification, repair loop |
| State and queue | Postgres 17, Redis 7 with BullMQ | Revisions, runs, events, tasks; one mutating run at a time, idempotent jobs |
| Coding agent | Claude Code headless (`claude -p`, `dontAsk`, tool allowlist) | Patches the target in an isolated worktree |
| Interfaces | `recast` CLI, read-only web workspace (SSE), Markdown/JSON/CSV reports | Operate, watch, export |

Design decisions that keep results honest: Kane's verdict is evidence, never the result; a gap needs two consistent runs; discovery is never proof; the agent's own summary is stored but never used to judge; holdout material (the later upstream fix) never reaches the agent, enforced by a hashed leak test. More in [docs/architecture.md](docs/architecture.md).

## Features and results

All results measured on 25 Nov 2026 with Kane CLI 0.10.9 against `trinodb/trino:481` on one laptop.

| Capability | Result |
|---|---|
| **Discovery** | Kane Exploration mapped the classic UI: 5 screens, 4 verified flows, 19 findings, 5 candidate requirements, including the **Kill** and **Preempt** controls on the query page. |
| **Real gap found** | REQ-QRY-CANCEL: established 2 of 2 on the classic UI (query `FAILED / ADMINISTRATIVELY_KILLED`), then **Missing** on the preview UI in 2 of 2 runs (query still `RUNNING`). |
| **No false gap** | REQ-QRY-OWNER ("see who submitted a running query"), supported by both UIs with different layouts: established 2 of 2, **Preserved** on the preview UI. |
| **Re-verify proven** | An operator-written fix served as the candidate passed the frozen REQ-QRY-CANCEL 2 of 2 (query killed through the new button). |
| **Guardrails** | Three scripted adversarial agents (rewrite the frozen spec, rewrite the frozen row in Postgres, edit outside the allowed folder) were all rejected before any re-verification; the spec stayed byte-identical. |
| **Kane is not the judge** | In several runs Kane's own verdict was wrong: it called real gaps "agent missteps" and failed runs where the kill had happened. Recast classified every one correctly from the oracle. |
| **Agent repair** | The live Claude Code repair of REQ-QRY-CANCEL is in progress; results will be added here. |

Also included: a workspace UI (parity matrix, source vs target evidence, live run and task timelines, discovery, repair), an acceptance report with real denominators, per-run credit accounting from the Kane balance, 41 unit tests and CI.

## Reproduce it

### Prerequisites

- Node 24 and pnpm 9
- Docker (Docker Desktop or Colima)
- Kane CLI 0.10.9: `npm install -g @testmuai/kane-cli`, then `kane-cli login`
- For repair: Claude Code (`claude`) logged in

### Quick start

```bash
git clone https://github.com/gsoffmarket/recast.git && cd recast
pnpm install
cp .env.example .env          # set RECAST_PG_PASSWORD and the matching DATABASE_URL
docker-compose up -d          # Postgres 17 + Redis 7 on localhost
docker run -d --name recast-trino -p 8080:8080 trinodb/trino:481
pnpm recast init --config evaluation/trino/recast.config.json
pnpm recast doctor            # checks database, queue, Kane CLI, credits, environments
```

Start the worker in a second terminal with `pnpm worker`, and the workspace UI with `pnpm ui` (http://127.0.0.1:4173).

### Reproduce the Trino results

```bash
# 1. Observe: map the classic UI with Kane and import it
pnpm recast discover run --max-leases 8
pnpm recast discover list

# 2. Specify, baseline and freeze
pnpm recast requirements add evaluation/trino/requirements/REQ-QRY-CANCEL.json
pnpm recast baseline --requirement REQ-QRY-CANCEL --runs 2
pnpm recast freeze   --requirement REQ-QRY-CANCEL

# 3. Compare against the new UI
pnpm recast compare  --requirement REQ-QRY-CANCEL --target trino-preview --runs 2

# 4. Repair (fetch the target source once, then run the loop)
git clone --depth 1 --branch 481 --filter=blob:none --sparse https://github.com/trinodb/trino.git evaluation/trino/checkouts/trino-481
git -C evaluation/trino/checkouts/trino-481 sparse-checkout set core/trino-web-ui/src/main/resources/webapp-preview
(cd evaluation/trino/checkouts/trino-481/core/trino-web-ui/src/main/resources/webapp-preview && npm ci)
pnpm recast repair --requirement REQ-QRY-CANCEL --max-attempts 3

# 5. Evidence
pnpm recast status
pnpm recast report --format markdown
```

The equivalence control and the second gap follow the same steps with `REQ-QRY-OWNER.json` and `REQ-QRY-PREEMPT.json`. The adversarial checks need no model and no credits:

```bash
pnpm recast repair --requirement REQ-QRY-CANCEL --max-attempts 1 --simulate-agent tamper-spec
pnpm recast repair --requirement REQ-QRY-CANCEL --max-attempts 1 --simulate-agent tamper-db
pnpm recast repair --requirement REQ-QRY-CANCEL --max-attempts 1 --simulate-agent edit-outside-src
```

Kane runs cost credits (about 25–65 per run in this case, measured from the balance before and after each run; an 8-lease exploration cost about 141). Exit codes: 0 ok, 1 confirmed gap, 2 invalid configuration, 3 inconclusive or infrastructure, 4 cancelled.

### Use it on your own app

1. Write a project config like [evaluation/trino/recast.config.json](evaluation/trino/recast.config.json): a source environment (the legacy UI), a target environment (the new UI), the login role, and the repair target (repo path, app folder, allowed paths).
2. Provide a fixture and an oracle for your domain in [packages/observations](packages/observations/src/index.ts): the fixture sets up a fresh, independent starting state per run; the oracle reads the outcome from your app's API or database. Kane page readings (`ui.*`) work without any code for display requirements.
3. Run `recast discover run` to map the legacy app, add requirements for the candidates you care about, then baseline, freeze, compare and repair as above.

## Project structure

```
packages/
  cli/             recast command
  behaviour-spec/  requirement schema, frozen hash, objective compilation
  kane-adapter/    kane-cli runner, NDJSON parser, evidence packs
  discovery/       Kane Exploration import and candidates
  observations/    oracles and fixtures
  parity/          comparators and classifier
  runner/          runs, queue, repair loop, candidate checks
  coding-agents/   worktrees, Claude Code driver, guards, build gate
  db/              Postgres schema and migrations
  reports/         acceptance report
  web/             read-only workspace UI
evaluation/trino/  reference case config and requirements
docs/              architecture
```

- [Architecture](docs/architecture.md) · [Contributing](CONTRIBUTING.md) · [Security and agent containment](SECURITY.md)

## Scope

Recast verifies the requirements in scope and reports real denominators; it does not certify whole-app parity, deploy or merge. The bundled fixture and oracle target Trino; other apps need their own (see above).

## Licence and attribution

Recast is Apache-2.0. Trino is Apache-2.0 and is not vendored: the evaluation fetches tag 481 of [trinodb/trino](https://github.com/trinodb/trino) into an ignored folder, and candidate patches stay on local branches of that checkout.
