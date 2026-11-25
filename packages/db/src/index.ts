import postgres from 'postgres';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newId } from '@recast/shared';

export type Sql = postgres.Sql;

export function connect(url = process.env.DATABASE_URL): Sql {
  if (!url) throw new Error('DATABASE_URL is not set (copy .env.example to .env)');
  return postgres(url, { max: 5, onnotice: () => {}, transform: { undefined: null } });
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Apply pending .sql migrations in name order, each in a transaction, under an advisory lock. */
export async function migrate(sql: Sql): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(727274)`;
    const done = new Set((await tx<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      await tx.unsafe(await readFile(join(MIGRATIONS_DIR, f), 'utf8'));
      await tx`INSERT INTO schema_migrations (name) VALUES (${f})`;
      applied.push(f);
    }
  });
  return applied;
}

// ---------- repositories ----------

export interface ProjectRow { id: string; name: string; config: unknown; status: string }
export interface EnvironmentRow { id: string; project_id: string; kind: 'source' | 'target' | 'candidate'; name: string; base_url: string; start_path: string; fingerprint: unknown }
export interface RevisionRow { project_id: string; requirement_id: string; revision: number; body: any; fixture_identity: string; hash: string; lifecycle: string; frozen_at: Date | null }
export interface RunRow { id: string; kind: string; environment_id: string; requirement_id: string; revision: number; spec_hash: string; state: string; evaluation: any; kane_outcome: string | null; created_at: Date; finished_at: Date | null; credits_balance_before: string | null; credits_balance_after: string | null; kane_session_id: string | null; evidence_path: string | null; fixture_ref: string | null }

export async function upsertProject(sql: Sql, name: string, config: unknown): Promise<ProjectRow> {
  const [row] = await sql<ProjectRow[]>`
    INSERT INTO projects (id, name, config) VALUES (${newId()}, ${name}, ${sql.json(config as any)})
    ON CONFLICT (name) DO UPDATE SET config = EXCLUDED.config RETURNING id, name, config, status`;
  return row!;
}

export async function getProject(sql: Sql, name: string): Promise<ProjectRow | undefined> {
  const [row] = await sql<ProjectRow[]>`SELECT id, name, config, status FROM projects WHERE name = ${name}`;
  return row;
}

export async function upsertEnvironment(sql: Sql, e: Omit<EnvironmentRow, 'id'>): Promise<EnvironmentRow> {
  const [row] = await sql<EnvironmentRow[]>`
    INSERT INTO environments (id, project_id, kind, name, base_url, start_path, fingerprint)
    VALUES (${newId()}, ${e.project_id}, ${e.kind}, ${e.name}, ${e.base_url}, ${e.start_path}, ${sql.json((e.fingerprint ?? null) as any)})
    ON CONFLICT (project_id, name) DO UPDATE SET kind = EXCLUDED.kind, base_url = EXCLUDED.base_url, start_path = EXCLUDED.start_path, fingerprint = EXCLUDED.fingerprint
    RETURNING *`;
  return row!;
}

export async function getEnvironment(sql: Sql, projectId: string, name: string): Promise<EnvironmentRow | undefined> {
  const [row] = await sql<EnvironmentRow[]>`SELECT * FROM environments WHERE project_id = ${projectId} AND name = ${name}`;
  return row;
}

/** Add a new revision. Refuses to overwrite an existing revision number. */
export async function addRevision(sql: Sql, r: Omit<RevisionRow, 'frozen_at'>): Promise<RevisionRow> {
  return sql.begin(async (tx) => {
    await tx`INSERT INTO requirements (project_id, id, current_revision) VALUES (${r.project_id}, ${r.requirement_id}, ${r.revision})
             ON CONFLICT (project_id, id) DO UPDATE SET current_revision = GREATEST(requirements.current_revision, EXCLUDED.current_revision)`;
    const [row] = await tx<RevisionRow[]>`
      INSERT INTO requirement_revisions (project_id, requirement_id, revision, body, fixture_identity, hash, lifecycle)
      VALUES (${r.project_id}, ${r.requirement_id}, ${r.revision}, ${tx.json(r.body)}, ${r.fixture_identity}, ${r.hash}, ${r.lifecycle})
      RETURNING *`;
    await tx`UPDATE requirement_revisions SET lifecycle = 'superseded'
             WHERE project_id = ${r.project_id} AND requirement_id = ${r.requirement_id} AND revision < ${r.revision} AND lifecycle NOT IN ('retired')`;
    return row!;
  });
}

export async function getRevision(sql: Sql, projectId: string, reqId: string, revision?: number): Promise<RevisionRow | undefined> {
  const [row] = revision
    ? await sql<RevisionRow[]>`SELECT * FROM requirement_revisions WHERE project_id = ${projectId} AND requirement_id = ${reqId} AND revision = ${revision}`
    : await sql<RevisionRow[]>`SELECT rr.* FROM requirement_revisions rr JOIN requirements r ON r.project_id = rr.project_id AND r.id = rr.requirement_id AND r.current_revision = rr.revision
                               WHERE rr.project_id = ${projectId} AND rr.requirement_id = ${reqId}`;
  return row;
}

export async function listRevisions(sql: Sql, projectId: string): Promise<RevisionRow[]> {
  return sql<RevisionRow[]>`SELECT rr.* FROM requirement_revisions rr JOIN requirements r ON r.project_id = rr.project_id AND r.id = rr.requirement_id AND r.current_revision = rr.revision
                            WHERE rr.project_id = ${projectId} ORDER BY rr.requirement_id`;
}

export async function setLifecycle(sql: Sql, projectId: string, reqId: string, revision: number, lifecycle: string, freeze = false): Promise<void> {
  await sql`UPDATE requirement_revisions SET lifecycle = ${lifecycle}, frozen_at = CASE WHEN ${freeze} THEN COALESCE(frozen_at, now()) ELSE frozen_at END
            WHERE project_id = ${projectId} AND requirement_id = ${reqId} AND revision = ${revision}`;
}

export async function createRun(sql: Sql, r: { project_id: string; kind: string; environment_id: string; requirement_id: string; revision: number; spec_hash: string; idempotency_key: string }): Promise<{ id: string; created: boolean }> {
  const id = newId();
  const rows = await sql<{ id: string }[]>`
    INSERT INTO runs (id, project_id, kind, environment_id, requirement_id, revision, spec_hash, idempotency_key, state)
    VALUES (${id}, ${r.project_id}, ${r.kind}, ${r.environment_id}, ${r.requirement_id}, ${r.revision}, ${r.spec_hash}, ${r.idempotency_key}, 'queued')
    ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`;
  if (rows[0]) return { id: rows[0].id, created: true };
  const [existing] = await sql<{ id: string }[]>`SELECT id FROM runs WHERE idempotency_key = ${r.idempotency_key}`;
  return { id: existing!.id, created: false };
}

export async function updateRun(sql: Sql, id: string, patch: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  const values = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v !== null && typeof v === 'object' && !(v instanceof Date) ? sql.json(v as any) : v]));
  await sql`UPDATE runs SET ${sql(values as any, cols)} WHERE id = ${id}`;
}

export async function getRun(sql: Sql, id: string): Promise<(RunRow & Record<string, unknown>) | undefined> {
  const [row] = await sql<(RunRow & Record<string, unknown>)[]>`SELECT * FROM runs WHERE id = ${id}`;
  return row;
}

/** Monotonic per-run event sequence. */
export async function appendEvent(sql: Sql, runId: string, type: string, payload: unknown): Promise<number> {
  const [row] = await sql<{ seq: number }[]>`
    INSERT INTO run_events (run_id, seq, type, payload)
    VALUES (${runId}, (SELECT COALESCE(MAX(seq), 0) + 1 FROM run_events WHERE run_id = ${runId}), ${type}, ${sql.json(payload as any)})
    RETURNING seq`;
  return row!.seq;
}

export async function listEvents(sql: Sql, runId: string, afterSeq = 0) {
  return sql<{ seq: number; type: string; payload: any; at: Date }[]>`SELECT seq, type, payload, at FROM run_events WHERE run_id = ${runId} AND seq > ${afterSeq} ORDER BY seq`;
}

export async function insertObservations(sql: Sql, runId: string, obs: Array<{ path: string; value: unknown; adapter: string; status: string; detail?: string; at: string }>): Promise<void> {
  for (const o of obs) {
    await sql`INSERT INTO observations (id, run_id, path, value, adapter, status, detail, at)
              VALUES (${newId()}, ${runId}, ${o.path}, ${sql.json(o.value as any)}, ${o.adapter}, ${o.status}, ${o.detail ?? null}, ${o.at})`;
  }
}

export async function listRunsFor(sql: Sql, projectId: string, reqId: string, revision: number, kind: string, environmentId?: string): Promise<RunRow[]> {
  return environmentId
    ? sql<RunRow[]>`SELECT * FROM runs WHERE project_id = ${projectId} AND requirement_id = ${reqId} AND revision = ${revision} AND kind = ${kind} AND environment_id = ${environmentId} ORDER BY created_at`
    : sql<RunRow[]>`SELECT * FROM runs WHERE project_id = ${projectId} AND requirement_id = ${reqId} AND revision = ${revision} AND kind = ${kind} ORDER BY created_at`;
}

export async function insertParity(sql: Sql, p: { project_id: string; requirement_id: string; revision: number; spec_hash: string; status: string; reason_code: string; explanation: string; decision: unknown; comparator_version: string }): Promise<string> {
  const id = newId();
  await sql`INSERT INTO parity_results (id, project_id, requirement_id, revision, spec_hash, status, reason_code, explanation, decision, comparator_version)
            VALUES (${id}, ${p.project_id}, ${p.requirement_id}, ${p.revision}, ${p.spec_hash}, ${p.status}, ${p.reason_code}, ${p.explanation}, ${sql.json(p.decision as any)}, ${p.comparator_version})`;
  return id;
}

export async function latestParity(sql: Sql, projectId: string) {
  return sql<{ requirement_id: string; revision: number; status: string; reason_code: string; explanation: string; created_at: Date; spec_hash: string }[]>`
    SELECT DISTINCT ON (requirement_id) requirement_id, revision, status, reason_code, explanation, created_at, spec_hash
    FROM parity_results WHERE project_id = ${projectId} ORDER BY requirement_id, created_at DESC`;
}
