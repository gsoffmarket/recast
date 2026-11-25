# Use Recast on your own app

Recast needs four things from your app: where the legacy UI runs, where the new UI runs, a way to give every run a fresh starting state, and a way to read what really happened. You describe all four in one JSON file. Apps with an HTTP API need no code.

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

`init` validates the config and explains any mistake by field. `doctor` checks the database, queue, Kane CLI, credits, the config, and that every UI responds.

## 5. Let a coding agent repair gaps (optional)

Add a `repair` section like the one in [evaluation/trino/recast.config.json](../evaluation/trino/recast.config.json):
- a git checkout of the new UI and the folder the agent may edit
- the commands that build and check it
- a `candidate` environment where Recast serves the patched UI

Then run `pnpm recast repair --requirement <ID>`. A fix is accepted only when the build gate passes, Kane re-runs the frozen requirement on the patched UI, the oracle confirms it, and every other preserved requirement still passes.

## Apps without an HTTP API

When the outcome lives only in a database or a message queue, write an oracle in TypeScript in [packages/observations](../packages/observations/src/index.ts). [`TrinoOracle`](../packages/observations/src/index.ts) is a worked example. Then register it in [packages/runner/src/adapters.ts](../packages/runner/src/adapters.ts).
