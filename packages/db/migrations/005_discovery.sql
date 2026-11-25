-- M1 discovery: imported Kane Exploration maps and the items in them. Discovery is evidence of what
-- exists, never of what it does; items only become requirements through baseline runs.
CREATE TABLE discoveries (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment text NOT NULL,
  exploration_id text,
  run_id text,
  map_hash text NOT NULL,
  totals jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, map_hash)
);

CREATE TABLE discovery_items (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('screen', 'flow', 'finding', 'candidate')),
  key text NOT NULL,
  title text NOT NULL,
  detail jsonb NOT NULL,
  first_discovery uuid NOT NULL REFERENCES discoveries(id),
  last_discovery uuid NOT NULL REFERENCES discoveries(id),
  sightings int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'excluded', 'linked')),
  linked_requirement text,
  PRIMARY KEY (project_id, kind, key)
);
