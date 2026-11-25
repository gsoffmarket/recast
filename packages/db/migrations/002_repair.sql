-- M3: migration tasks, agent attempts, task events
ALTER TABLE runs ADD COLUMN candidate_sha text;

CREATE TABLE migration_tasks (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requirement_id text NOT NULL,
  revision int NOT NULL,
  spec_hash text NOT NULL,
  parity_result_id uuid NOT NULL REFERENCES parity_results(id),
  base_ref text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','diagnosing','patching','building','verifying','verified_candidate','retrying','unresolved','cancelled')),
  max_attempts int NOT NULL,
  task jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_attempts (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES migration_tasks(id) ON DELETE CASCADE,
  attempt int NOT NULL,
  state text NOT NULL,
  branch text,
  base_sha text,
  candidate_sha text,
  agent text,
  agent_summary text,
  agent_cost_usd numeric,
  agent_turns int,
  agent_ms int,
  tool_uses int,
  denied_tools int,
  changed_paths text[],
  disallowed_paths text[],
  gate jsonb,
  patch text,
  reverify_run_ids uuid[],
  decision jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (task_id, attempt)
);

CREATE TABLE task_events (
  task_id uuid NOT NULL REFERENCES migration_tasks(id) ON DELETE CASCADE,
  seq int NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, seq)
);
