-- M4: a task can be re-checking previously preserved requirements on its candidate.
ALTER TABLE migration_tasks DROP CONSTRAINT migration_tasks_state_check;
ALTER TABLE migration_tasks ADD CONSTRAINT migration_tasks_state_check
  CHECK (state IN ('queued','diagnosing','patching','building','verifying','regression_checking','verified_candidate','retrying','unresolved','cancelled'));
