-- Candidate checks: re-verifying a given git ref (e.g. an operator-written harness patch or an
-- unpatched control) against a frozen requirement. Kept apart from parity_results on purpose:
-- these prove the re-verify path, they are never counted as the product's parity result.
CREATE TABLE candidate_checks (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requirement_id text NOT NULL,
  revision int NOT NULL,
  spec_hash text NOT NULL,
  label text NOT NULL,
  ref text NOT NULL,
  candidate_sha text NOT NULL,
  expected text NOT NULL CHECK (expected IN ('preserved', 'missing')),
  gate jsonb,
  run_ids uuid[] NOT NULL,
  verdicts text[] NOT NULL,
  decision jsonb NOT NULL,
  as_expected boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
