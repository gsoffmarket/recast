# Use Recast on your own app

Recast needs four things from your app: where the legacy UI runs, where the new UI runs, a way to give every run a fresh starting state, and a way to read what really happened. You describe all four in one JSON file. Apps with an HTTP API need no code.

There are two ways to get requirements:

- **Write them** (section 3) when you know the behaviours that matter.
- **Capture them** (section 5) when you want Recast to freeze what the legacy app does before a rebuild, with no hand-written expectations.

Either way, `recast check` then tests the new UI against every frozen requirement.

## 1. Scaffold a project

```bash
pnpm recast new ../my-app-parity --legacy-url http://localhost:3000 --new-url http://localhost:3001
```

This writes three files:

| File | What it is |
|---|---|
| `recast.config.json` | Environments, fixture, oracle, Kane limits and credit floor |
| `requirements/REQ-ITEM-ARCHIVE.json` | An example requirement wired to that fixture and oracle |
| `NEXT_STEPS.md` | The commands to run, with your project name filled in |

Pass `--api-url` when the API is not served from the legacy URL. The command never overwrites files unless you add `--force`.

## 2. Describe your app

### Environments

```json
{ "name": "legacy", "kind": "source", "baseUrl": "http://localhost:3000", "startPath": "/", "hints": ["If a login page appears, sign in as {{username}}."] }
```

`source` is the UI you are replacing and `target` is the rewrite. A `candidate` environment is only needed for repair. Keep `hints` to navigation help, and never name the control a requirement is about, so Kane has to find it the way a user would.

### Fixture: a fresh starting state per run

```json
"fixture": {
  "type": "http",
  "identity": "fresh-order-v1",
  "setup": {
    "method": "POST",
    "url": "http://localhost:3000/api/orders",
    "headers": { "authorization": "Bearer {{env.APP_TOKEN}}" },
    "body": { "note": "Recast check {{run}}" },
    "capture": { "order_id": "data.id" }
  },
  "cleanup": { "method": "DELETE", "url": "http://localhost:3000/api/orders/{{order_id}}" }
}
```

- `capture` keeps fields from the JSON response as variables, using dot paths (`data.items.0.id`). The first one is stored as the run's reference.
- `{{run}}` is a unique tag for each run. `{{env.NAME}}` reads a secret from your environment, so tokens never go in the file.
- `cleanup` is optional and runs after observation, or after a failure.
- If there is no API to create state, use `{ "type": "none", "identity": "shared-state-v1" }`.

### Oracle: read the real outcome

```json
"oracle": {
  "type": "http",
  "name": "orders-api",
  "request": { "url": "http://localhost:3000/api/orders/{{order_id}}", "headers": { "authorization": "Bearer {{env.APP_TOKEN}}" } },
  "observe": { "order.status": "status", "order.refunded": "payment.refunded" },
  "until": { "path": "order.status", "in": ["cancelled", "refunded"] }
}
```

- `observe` maps response fields to observation names that requirements assert on. `http.status` is always observed too, so a `404` after a delete is a real outcome you can assert on.
- With `until`, Recast polls until one of those values appears or the requirement's `settle_ms` runs out. Without it, Recast waits `settle_ms` and reads once.
- Kane's own pass or fail is never used. If the API is unreachable, the observation is marked unavailable and the run is inconclusive rather than a gap.

Page readings need no oracle setup at all: an action that ends "…and store it as total" is observed as `ui.total`. Add `+kane-final-state` to a requirement's `oracle` (for example `orders-api+kane-final-state`) when it asserts on both.

Optionally set `"fingerprintUrl"` to an endpoint that returns your app's version as JSON. Recast records it with every run.

## 3. Write requirements

```json
{
  "id": "REQ-ORD-CANCEL",
  "revision": 1,
  "objective": "A user can cancel an open order from its page",
  "role": "web-ui-user",
  "fixture": "fresh-order-v1",
  "oracle": "orders-api",
  "action_intent": "Open the order with ID {{order_id}} and cancel it using only the web UI.",
  "settle_ms": 10000,
  "assertions": [{ "path": "order.status", "operator": "equals", "expected": "cancelled" }],
  "provenance": "candidate"
}
```

`fixture` and `oracle` must match the names in the config. `recast requirements add` checks this and tells you the right value. Write `action_intent` as what a user wants done, in words that fit both UIs.

## 4. Run the loop

```bash
export RECAST_PROJECT=my-app-parity
pnpm recast init --config ../my-app-parity/recast.config.json
pnpm recast doctor
pnpm recast discover run --max-leases 8      # optional: let Kane map the legacy UI and suggest requirements
pnpm recast requirements add ../my-app-parity/requirements/REQ-ORD-CANCEL.json
pnpm recast baseline --requirement REQ-ORD-CANCEL --runs 2
pnpm recast freeze   --requirement REQ-ORD-CANCEL
pnpm recast compare  --requirement REQ-ORD-CANCEL --target new --runs 2      # the target environment's name
pnpm recast report --format markdown
```

`init` validates the config and explains any mistake by field. `doctor` checks the database, queue, Kane CLI, credits, the config, that every UI responds, and whether Claude Code is installed and signed in (a warning only, since it is needed just for repair).

Once several requirements are frozen, check them all in one command instead of one `compare` at a time:

```bash
pnpm recast check --target new     # every frozen requirement, 2 runs each; exit 1 if any is Missing
```

## 5. Or freeze the whole legacy app at once

Instead of writing each requirement by hand, let Recast capture them. After `recast discover run`, `recast capture` takes every state-changing control Kane found (buttons such as Cancel, Delete or Archive) and, for each one:

1. Drafts a requirement: what the user does, with no expected result yet.
2. Runs it on the legacy UI (two probe runs by default), reading your oracle **before** and **after** Kane acts.
3. Keeps as the expected result only what the action changed, to the same value in every run. Ids and timestamps that differ between runs are dropped.
4. Confirms that result with two fresh runs, then freezes it. A control with no visible effect in the API is reported, not frozen.

```bash
pnpm recast capture --dry-run      # the drafts and how many Kane runs they need; runs nothing
pnpm recast capture --yes          # spend the credits: probe, confirm and freeze
pnpm recast contract               # contract/CONTRACT.md and contract/contract.json for the rebuild
pnpm recast check --target new     # later: check the rebuild against every frozen behaviour
```

If the new UI does not exist yet, point the `target` environment at where it will run. `doctor` reports it as unreachable until then, which does not stop capture: capture only uses the legacy UI.

Each control costs four Kane runs by default. The drafted intent reads "Open {subject} and use its "{control}" control, using only the web UI." Set `"capture": { "subject": "the order {{order_id}}" }` in the config to say how a person names the item each run starts with. Captured requirement files are written to `captured/` so you can review them, and `check` exits 1 when any behaviour is missing, so it fits a CI job.

## 6. Let a coding agent repair gaps (optional)

Repair uses **Claude Code**, Anthropic's coding agent. Install it and sign in once on the machine that runs Recast, so the `claude` command works in a terminal. Recast runs it headless on your own account and Claude plan; Recast itself includes no AI and stores no AI keys. If `claude` is not on your PATH, set `CLAUDE_BIN` to its full path. Other coding agents (Codex, Cursor, Copilot and others) are not supported yet. Without Claude Code everything else still works: Recast finds, proves and reports gaps, and you fix them yourself.

**Set up Claude Code** (only needed for repair):

```bash
npm install -g @anthropic-ai/claude-code   # or follow https://code.claude.com/docs/en/setup
claude                                     # first run: sign in with your Claude account (subscription or Anthropic Console), then type /exit
claude --version                           # Recast was tested with 2.1.332
```

Once Recast is set up, `pnpm recast doctor` shows `agent.claude` and `agent.claude.auth` as PASS.

Add a `repair` section like the one in [evaluation/trino/recast.config.json](../evaluation/trino/recast.config.json):
- a git checkout of the new UI and the folder the agent may edit
- the commands that build and check it
- a `candidate` environment where Recast serves the patched UI

Then run `pnpm recast repair --requirement <ID>`. A fix is accepted only when the build gate passes, Kane re-runs the frozen requirement on the patched UI, the oracle confirms it, and every other preserved requirement still passes.

## Apps without an HTTP API

When the outcome lives only in a database or a message queue, write an oracle in TypeScript in [packages/observations](../packages/observations/src/index.ts). [`TrinoOracle`](../packages/observations/src/index.ts) is a worked example. Then register it in [packages/runner/src/adapters.ts](../packages/runner/src/adapters.ts).
