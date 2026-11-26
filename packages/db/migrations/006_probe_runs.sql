-- Capture: probe runs perform a draft requirement on the legacy UI and record the oracle before and
-- after, so `recast capture` can infer what the behaviour does. They are never evaluated or compared.
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_kind_check;
ALTER TABLE runs ADD CONSTRAINT runs_kind_check CHECK (kind IN ('baseline', 'compare', 'reverify', 'probe'));
