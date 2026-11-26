# Recast

[![CI](https://github.com/gsoffmarket/recast/actions/workflows/ci.yml/badge.svg)](https://github.com/gsoffmarket/recast/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Node 24](https://img.shields.io/badge/node-24-339933.svg)
![Kane CLI 0.10.9](https://img.shields.io/badge/Kane%20CLI-0.10.9-8052ff.svg)

**Rebuild the software. Keep the behaviour.**

Recast is a behaviour-parity tool for UI migrations. It uses [Kane CLI](https://www.testmuai.com/kane-cli/) to observe a working legacy web app, turns what the app does into frozen, hashed requirements, finds what a replacement UI has lost, hands each confirmed gap to a coding agent, and accepts the agent's patch only after Kane and an independent oracle show the original requirement passing on the new code.

It also works before a rebuild exists: `recast capture` freezes what the legacy app does, with no hand-written expectations, `recast contract` hands that behaviour to whoever does the rebuild, and `recast check` tests the rebuild against all of it.

Built for the KaneCLI Online Hackathon by TestMu AI. **Live results:** [recast-sooty.vercel.app](https://recast-sooty.vercel.app), a read-only snapshot of the workspace from real local runs. **Docs:** [recast-sooty.vercel.app/#/docs](https://recast-sooty.vercel.app/#/docs), generated from this README, the guides in `docs/` and the CLI's own command definitions.

## Recast in plain terms

When a team rebuilds an app's screens, some features quietly go missing. **Recast finds what went missing, gets an AI coding agent to put it back, and refuses the fix until it is proven to work.**

Think of moving house. Before the move you list everything the old house had. After the move you check the new house against that list. When something is missing, a builder adds it, and an inspector checks the work before you sign it off.

### Who does what

| Role | Played by | Job |
|---|---|---|
| The tester | **Kane CLI**, TestMu's AI browser agent | Opens the app in a real browser and tries a task the way a person would, for example "stop this running query". |
| The referee | **The app's own API** | Says what really happened, for example "the query's state is now FAILED, so it was killed". Recast trusts this, not Kane's opinion. |
| The builder | **Claude Code**, on your own computer | Writes the code that puts a missing feature back. |
| The manager | **Recast** | Keeps the list, runs every step in order, stores every result and decides pass or fail. |

### The five steps, with the real Trino example

1. **Explore** (optional). Kane browses the **old** screens and suggests features worth protecting, such as "running queries have a Kill button".
2. **Prove and lock.** Kane uses that feature on the old screens **twice**, and the API confirms it worked both times. Recast then **locks** the requirement with a fingerprint (a SHA-256 hash), and the database refuses any edit to it. Nobody can quietly change the rule later, the AI included.
3. **Compare.** Kane tries the same task on the **new** screens. The API says the query is still running, twice. That is a confirmed gap, marked **Missing**.
4. **Repair.** Recast gives Claude Code the evidence: Kane's failed steps, its screenshots, and the request the old screen sent to the server. Claude Code works on a **separate copy** of the new app's code. When it finishes, Recast inspects every change: an edit outside the folder you allow gets the attempt rejected, and an edit to Recast's own requirement or checking files is undone and rejected too. The change must also build cleanly.
5. **Verify.** Kane retries the same locked requirement on the **patched** app, twice. The fix is accepted only if the API confirms both runs **and** every feature that already worked still works. Anything else is rejected.

```
old app ──Kane + API──▶ locked requirement ──Kane + API──▶ new app: "Missing"
                                                                │
                              Claude Code writes a fix ◀────────┘
                                         │
                   Kane + API re-check ──▶ accepted only if proven, nothing else broken
```

### Does it use my own AI agent?

Yes, and your own accounts. Recast does not ship or host any AI itself.

- **Kane CLI** runs under your TestMu login and spends your Kane credits.
- **Claude Code** is the `claude` program already installed and signed in on your computer, so repairs run on your Claude plan.
- The repair step drives **Claude Code** today. Other coding agents are not wired in yet.
- **Repair is optional.** Without it, Recast still finds, proves and reports gaps, and you fix them yourself.

### What you set up

1. **Install once:** Node 24, pnpm, Docker (it runs Recast's database and job queue), Kane CLI, and Claude Code if you want repairs.
2. **Describe your app in one file.** `pnpm recast new` writes `recast.config.json`, where you fill in four things: where the old app runs, where the new app runs, how to create a fresh test item for each run (for example "POST to /api/orders"), and how to read the real result (for example "GET /api/orders/123 and read `status`"). If your app has an HTTP API, this is configuration only, with no code.
3. **Write one small file per feature:** what a user wants done ("cancel this order using only the web page") and the expected result (`status equals "cancelled"`).
4. **Run the commands in order:** `baseline`, `freeze`, `compare`, then optionally `repair`, then `report`. A web dashboard shows the same results as the [live site](https://recast-sooty.vercel.app).

**Rebuilding an app from scratch?** You can freeze the old app's behaviour before the new one exists. `recast capture` tries every button Kane found on the old app, works out from your API what each one does, confirms it twice more and locks it. `recast contract` then writes those behaviours as a document for whoever does the rebuild, and `recast check` tests the rebuild against all of them in one command.

In one sentence: you list what the old app does, Recast proves it, locks it and checks the new app against it, and an AI fix only counts when your app's own API says it works.

## The problem

Teams rebuild legacy front ends all the time: a new framework, a redesign, a "preview" UI that will replace the old one. The visible screens get rebuilt; the behaviour hidden in them often does not. A button that kills a stuck job, a permission check, an edge case in a form: these live in the old app's behaviour, not in any spec, and they quietly disappear in the rewrite. Coding agents make rewrites faster, which makes this worse: an agent rebuilds what it is shown, not what it was never told.

Recast is for engineering teams and agencies running a migration who need to know, with evidence, what the new UI still does, what it has lost, and whether a fix really restores it. It is also for teams about to rebuild an app that has no spec: they can freeze the old app's behaviour first and hold the rebuild, written by people or by coding agents, to it.

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

### Freezing a whole app before a rebuild

Writing requirements by hand does not scale to a whole app, and a team rebuilding from scratch has no new UI to compare against yet. Capture builds the requirements from the legacy app alone:

```
 Kane Exploration ─▶ state-changing controls ─▶ draft requirement (intent only, no expected result)
                                                        │ probe ×2 on the legacy UI
                     oracle read BEFORE Kane acts ──────┤
                     oracle read AFTER Kane acts  ──────┘
                                                        ▼
             expected result = what the action changed, to the same value in every probe
                                                        │ 2 fresh baseline runs must satisfy it
                                                        ▼
                         FROZEN requirement ─▶ recast contract (CONTRACT.md + contract.json)
                                            └─▶ recast check --target <rebuild> (exit 1 on any gap)
```

1. **Draft.** `recast capture` turns each state-changing control Kane Exploration found into a requirement with an intent ("open the query … and use its Kill control") and no assertions.
2. **Probe.** Kane performs the draft on the legacy UI twice. Each probe reads the oracle once before Kane acts and once after.
3. **Infer.** A value becomes an assertion only when the action changed it, to the same value in both probes. Ids and timestamps that differ between runs, values the action did not touch, and page readings with no before value are skipped with a reason.
4. **Confirm and freeze.** Two fresh baseline runs must satisfy the inferred assertions before the requirement is frozen, so nothing is established from the runs it was inferred from. A control with no observable effect, or whose probes do not complete, is reported and never frozen.
5. **Hand over and hold.** `recast contract` writes every frozen behaviour with its evidence and Kane's legacy steps for the rebuild team or coding agent. `recast check` later compares every frozen requirement on the rebuild and exits 1 if any is missing, so it can gate CI.

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
| **Second gap, found by Kane** | REQ-QRY-PREEMPT came from the Preempt control Kane Exploration discovered: established 2 of 2 (`ADMINISTRATIVELY_PREEMPTED`), **Missing** on the preview UI 2 of 2. |
| **Gap fixed by an agent and proven** | Claude Code patched Trino's preview UI from evidence alone (3 files under `src/`: a Kill button and a `PUT` helper). Recast's build gate passed, Kane re-ran the frozen REQ-QRY-CANCEL on the patched UI and the query was killed **2 of 2**, and the regression check kept REQ-QRY-OWNER Preserved. Candidate `626ea9b`, awaiting review. |
| **Whole-app capture** | `recast capture` re-derived the Kill behaviour with no hand-written expectation: 2 probe runs read the query as `RUNNING` before Kane acted and `FAILED / ADMINISTRATIVELY_KILLED` after, it inferred exactly those two values (the same ones REQ-QRY-CANCEL's author wrote by hand), 2 fresh runs confirmed them, and it froze REQ-CAP-QUERY-OVERVIEW-KILL. 4 Kane runs, 116.87 credits (26 Nov 2026, separate project). |
| **No false gap** | REQ-QRY-OWNER ("see who submitted a running query"), supported by both UIs with different layouts: established 2 of 2, **Preserved** on the preview UI. |
| **Re-verify cannot be fooled** | An operator-written harness fix passed 2 of 2 with a clean regression check, and the unpatched code served the same way failed (query still `RUNNING`). |
| **Guardrails** | Three scripted adversarial agents (rewrite the frozen spec, rewrite the frozen row in Postgres, edit outside the allowed folder) were all rejected before any re-verification; the spec stayed byte-identical. |
| **Kane is not the judge** | In several runs Kane's own verdict was wrong: it called real gaps "agent missteps" and failed runs where the kill had happened. Recast classified every one correctly from the oracle. |

Also included: a workspace UI (requirement stories with a step-by-step legacy / new / fixed comparison, Kane screenshots, the network request each version sent, a "Why?" for every verdict, discovery inbox, cost and trend), an acceptance report with real denominators, per-run credit accounting from the Kane balance, a `recast new` scaffolder with a config-only HTTP fixture and oracle for other apps, whole-app capture with a behaviour contract and a one-command `check` for CI, 75 unit tests and CI.

## Reproduce it

This section rebuilds every result above on your own computer, step by step. You run Trino 481 locally (it has both the old and the new UI), and Recast finds the missing Kill button, fixes it with Claude Code, and proves the fix. Each step says what it does and what you should see.

### Prerequisites

| You need | Why |
|---|---|
| Node 24 and pnpm 9 | Recast is a TypeScript project that Node runs directly. |
| Docker (Docker Desktop or Colima) | Runs Recast's database (Postgres) and job queue (Redis), and the Trino app being tested. |
| Kane CLI 0.10.9: `npm install -g @testmuai/kane-cli`, then `kane-cli login` | Kane is the tester that clicks through the UI. It runs on your TestMu account and spends your Kane credits. |
| Claude Code (`claude`), signed in | Only for the repair step. It is the coding agent that writes the fix, on your Claude plan. Set `CLAUDE_BIN` if `claude` is not on your PATH. Other coding agents (Codex, Cursor and others) are not supported yet. |

### Quick start

These commands download Recast, start its services and the Trino app, and check that everything is connected.

```bash
git clone https://github.com/gsoffmarket/recast.git && cd recast
pnpm install                  # install Recast's dependencies
cp .env.example .env          # local settings: choose RECAST_PG_PASSWORD and put the same value in DATABASE_URL
docker-compose up -d          # start Postgres 17 and Redis 7 on localhost
docker run -d --name recast-trino -p 8080:8080 trinodb/trino:481   # the app under test, on http://localhost:8080
pnpm recast init --config evaluation/trino/recast.config.json      # load the Trino setup into Recast
pnpm recast doctor            # checks database, queue, Kane CLI, credits and both UIs
```

`doctor` prints one line per check, marked PASS, WARN or FAIL. A FAIL line ends with the command that fixes it. The `env.trino-preview-candidate` line shows WARN until the repair step starts the patched UI, which is expected.

Then open two more terminals in the same folder:

- `pnpm worker` runs the jobs. Leave it running: the commands below queue work and this process carries it out.
- `pnpm ui` starts the dashboard at http://127.0.0.1:4173, where you can watch runs live and see screenshots and verdicts.

To publish a read-only copy of your results like the live site, run `pnpm recast export-site --out site` and upload the folder to any static host (the live site uses Vercel).

### Reproduce the Trino results

Run these in order. Each Kane run opens a real browser, takes a few minutes and spends Kane credits.

**1. Explore the old UI** (optional). Kane maps Trino's classic UI and suggests requirements, including the Kill and Preempt buttons.

```bash
pnpm recast discover run --max-leases 8
pnpm recast discover list     # the screens, controls and candidate requirements Kane found
```

**2. Prove and lock the requirement.** Add "kill a running query from the web UI", have Kane do it twice on the old UI (Trino's API must confirm the query was killed both times), then lock it.

```bash
pnpm recast requirements add evaluation/trino/requirements/REQ-QRY-CANCEL.json
pnpm recast baseline --requirement REQ-QRY-CANCEL --runs 2     # expect: established, 2 of 2
pnpm recast freeze   --requirement REQ-QRY-CANCEL              # locks it with a SHA-256 hash
```

**3. Check the new UI.** Kane tries the same task on Trino's new preview UI twice. Expect **Missing**: the query is still running because the new UI has no Kill button. The command exits with code 1, which means a confirmed gap.

```bash
pnpm recast compare --requirement REQ-QRY-CANCEL --target trino-preview --runs 2
```

**4. Let Claude Code fix it.** First download the new UI's source code once (only the folder the agent may edit). Then `repair` gives Claude Code the evidence, checks its change builds, and re-runs the locked requirement with Kane on the patched UI. Expect **verified**: the query is killed 2 of 2, and every requirement already marked Preserved still passes.

```bash
git clone --depth 1 --branch 481 --filter=blob:none --sparse https://github.com/trinodb/trino.git evaluation/trino/checkouts/trino-481
git -C evaluation/trino/checkouts/trino-481 sparse-checkout set core/trino-web-ui/src/main/resources/webapp-preview
(cd evaluation/trino/checkouts/trino-481/core/trino-web-ui/src/main/resources/webapp-preview && npm ci)
pnpm recast repair --requirement REQ-QRY-CANCEL --max-attempts 3
```

The fix stays on a local branch of that checkout for you to review. Recast never merges or deploys it.

**5. See the evidence.**

```bash
pnpm recast status                    # every requirement and its current verdict
pnpm recast report --format markdown  # the acceptance report
```

The other two results use the same steps with different requirement files: `REQ-QRY-OWNER.json` (a feature both UIs have, which should come out **Preserved**) and `REQ-QRY-PREEMPT.json` (the second missing button).

**Try to cheat it.** These scripted "bad agents" try to edit the locked requirement, edit the database, or change files they are not allowed to. Each should be **rejected** before any re-check, with the locked files restored. They need no AI and no Kane credits. Repair only runs on a requirement whose latest result is Missing, so run them on REQ-QRY-PREEMPT after its steps 2 and 3, before you repair it.

```bash
pnpm recast repair --requirement REQ-QRY-PREEMPT --max-attempts 1 --simulate-agent tamper-spec
pnpm recast repair --requirement REQ-QRY-PREEMPT --max-attempts 1 --simulate-agent tamper-db
pnpm recast repair --requirement REQ-QRY-PREEMPT --max-attempts 1 --simulate-agent edit-outside-src
```

Cost: each Kane run used about 25–65 credits here, measured from the balance before and after; an 8-lease exploration used about 141. Exit codes for every command: 0 ok, 1 confirmed gap, 2 invalid configuration, 3 inconclusive or infrastructure problem, 4 cancelled.

### Reproduce the capture result

This re-derives the Kill behaviour with no hand-written expectation. It needs the exploration from step 1, and takes 4 Kane runs (116.87 credits when measured). Kill is already covered by REQ-QRY-CANCEL, so `--include-linked` is needed to capture it again.

```bash
pnpm recast capture --dry-run --include-linked                      # the drafts and the run count; runs nothing
pnpm recast capture --include-linked --candidate "control:localhost:8080/ui/query.html:kill" --yes
pnpm recast contract                                                # contract/CONTRACT.md and contract/contract.json
```

Expect the two probe runs to read the query as `RUNNING` before Kane acts and `FAILED / ADMINISTRATIVELY_KILLED` after, capture to infer exactly those two values, both confirm runs to be satisfied, and `REQ-CAP-QUERY-OVERVIEW-KILL` to be frozen. Its requirement file is written to `captured/`. If you use `pnpm worker`, restart it after upgrading so it knows the probe run kind.

### Use it on your own app

Apps with an HTTP API need no code: the fixture (a fresh starting state per run) and the oracle (the real outcome) are declared in JSON.

```bash
pnpm recast new ../my-app-parity --legacy-url http://localhost:3000 --new-url http://localhost:3001
```

This writes a validated `recast.config.json`, an example requirement and the next commands to run. Point the fixture at the API call that creates a fresh record, point the oracle at the call that reads its state, then `init`, `doctor`, baseline, freeze, compare and repair as above. The full walkthrough is in [docs/your-own-app.md](docs/your-own-app.md).

To freeze a whole legacy app before rebuilding it, skip writing requirements and let Recast capture them from what Kane discovered:

```bash
pnpm recast discover run          # Kane maps the legacy UI
pnpm recast capture --dry-run     # what would be captured, and how many Kane runs it costs
pnpm recast capture --yes         # probe each control, infer its effect from your API, confirm twice, freeze
pnpm recast contract              # the behaviour contract for the rebuild: contract/CONTRACT.md and contract.json
pnpm recast check --target new    # test the rebuild against every frozen behaviour (exit 1 if any is missing)
```

## Project structure

```
packages/
  cli/             recast command
  behaviour-spec/  requirement schema, frozen hash, objective compilation
  kane-adapter/    kane-cli runner, NDJSON parser, evidence packs
  discovery/       Kane Exploration import, candidates and capture drafts
  observations/    oracles and fixtures
  parity/          comparators, classifier and capture inference
  runner/          runs (including capture probes), queue, repair loop, candidate checks
  coding-agents/   worktrees, Claude Code driver, guards, build gate
  db/              Postgres schema and migrations
  reports/         acceptance report and behaviour contract
  web/             read-only workspace UI
evaluation/trino/  reference case config and requirements
docs/              architecture and the guide for your own app
```

- [Architecture](docs/architecture.md) · [Contributing](CONTRIBUTING.md) · [Security and agent containment](SECURITY.md)

## Scope

Recast verifies the requirements in scope and reports real denominators; it does not certify whole-app parity, deploy or merge. Capture covers state-changing controls Kane discovers whose effect your oracle can read; flows and read-only behaviour still need requirements written by hand. The bundled fixture and oracle target Trino; other apps need their own (see above).

## Licence and attribution

Recast is Apache-2.0. Trino is Apache-2.0 and is not vendored: the evaluation fetches tag 481 of [trinodb/trino](https://github.com/trinodb/trino) into an ignored folder, and candidate patches stay on local branches of that checkout.
