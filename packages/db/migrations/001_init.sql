-- Recast core schema v1
CREATE TABLE projects (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE,
  config jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE environments (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('source', 'target', 'candidate')),
  name text NOT NULL,
  base_url text NOT NULL,
  start_path text NOT NULL,
  fingerprint jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE TABLE requirements (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id text NOT NULL,
  current_revision int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id)
);

CREATE TABLE requirement_revisions (
  project_id uuid NOT NULL,
  requirement_id text NOT NULL,
  revision int NOT NULL,
  body jsonb NOT NULL,
  fixture_identity text NOT NULL,
  hash text NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('candidate','source-observed','established','frozen','superseded','retired')),
  frozen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, requirement_id, revision),
  FOREIGN KEY (project_id, requirement_id) REFERENCES requirements(project_id, id) ON DELETE CASCADE
);

-- A frozen revision is immutable in place: body, hash and fixture cannot change once frozen_at is set.
CREATE FUNCTION forbid_frozen_update() RETURNS trigger AS $$
BEGIN
  IF OLD.frozen_at IS NOT NULL AND (NEW.body IS DISTINCT FROM OLD.body OR NEW.hash IS DISTINCT FROM OLD.hash OR NEW.fixture_identity IS DISTINCT FROM OLD.fixture_identity) THEN
    RAISE EXCEPTION 'requirement % r% is frozen; create a new revision', OLD.requirement_id, OLD.revision;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER requirement_revisions_frozen BEFORE UPDATE ON requirement_revisions FOR EACH ROW EXECUTE FUNCTION forbid_frozen_update();

CREATE TABLE runs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('baseline', 'compare', 'reverify')),
  environment_id uuid NOT NULL REFERENCES environments(id),
  requirement_id text NOT NULL,
  revision int NOT NULL,
  spec_hash text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  state text NOT NULL,
  attempt int NOT NULL DEFAULT 1,
  fixture_ref text,
  kane_outcome text,
  kane_exit int,
  kane_version text,
  kane_session_id text,
  kane_run_id text,
  credits_reported numeric,
  credits_balance_before numeric,
  credits_balance_after numeric,
  evidence_path text,
  evidence_sha256 text,
  evaluation jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX runs_req ON runs (project_id, requirement_id, revision, kind);

CREATE TABLE run_events (
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq int NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE observations (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  path text NOT NULL,
  value jsonb,
  adapter text NOT NULL,
  status text NOT NULL CHECK (status IN ('observed', 'unavailable')),
  detail text,
  at timestamptz NOT NULL
);

CREATE TABLE parity_results (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requirement_id text NOT NULL,
  revision int NOT NULL,
  spec_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('preserved','missing','intentional_change','uncertain','untested')),
  reason_code text NOT NULL,
  explanation text NOT NULL,
  decision jsonb NOT NULL,
  comparator_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX parity_latest ON parity_results (project_id, requirement_id, created_at DESC);
