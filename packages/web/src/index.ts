import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as db from '@recast/db';
import { buildReport, toMarkdown } from '@recast/reports';
import { redact } from '@recast/shared';

/**
 * Read-only local workspace UI. Binds to 127.0.0.1 only; no endpoint mutates state or runs commands
 * (actions stay in the CLI). Live views stream persisted events over SSE with Last-Event-ID resume.
 */

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), 'public');
const UUID = /^[0-9a-f-]{36}$/;
const TERMINAL_RUN = new Set(['completed', 'infra_error', 'cancelled']);
const TERMINAL_TASK = new Set(['verified_candidate', 'unresolved', 'cancelled']);

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const slimPath = (p: string | null) => (p ? redact(p).replace(/^.*\/sessions\//, '…/sessions/') : null);

async function overview(sql: db.Sql, projectName: string) {
  const project = await db.getProject(sql, projectName);
  if (!project) return null;
  const report = await buildReport(sql, project.id, project.name);
  const envs = await sql<any[]>`SELECT name, kind, base_url, start_path, fingerprint FROM environments WHERE project_id = ${project.id} ORDER BY kind, name`;
  const [bal] = await sql<{ after: string | null }[]>`SELECT credits_balance_after AS after FROM runs WHERE project_id = ${project.id} AND credits_balance_after IS NOT NULL ORDER BY finished_at DESC LIMIT 1`;
  return { project: project.name, report, environments: envs.map((e) => ({ name: e.name, kind: e.kind, url: `${e.base_url}${e.start_path}`, version: e.fingerprint?.version ?? null })), lastKnownBalance: bal?.after ? Number(bal.after) : null };
}

async function requirementDetail(sql: db.Sql, projectName: string, reqId: string) {
  const project = await db.getProject(sql, projectName);
  if (!project) return null;
  const rev = await db.getRevision(sql, project.id, reqId);
  if (!rev) return null;
  const runs = await sql<any[]>`
    SELECT r.id, r.kind, r.state, r.kane_outcome, r.kane_exit, r.kane_version, r.fixture_ref, r.candidate_sha, r.evaluation->>'verdict' AS verdict,
           r.credits_balance_before - r.credits_balance_after AS credits, r.evidence_sha256, r.created_at, r.finished_at, e.name AS environment, e.kind AS env_kind,
           (SELECT jsonb_object_agg(path, value) FROM observations o WHERE o.run_id = r.id) AS observed,
           (SELECT payload->>'one_liner' FROM run_events x WHERE x.run_id = r.id AND x.type = 'kane.run_end' ORDER BY seq DESC LIMIT 1) AS kane_said,
           (SELECT payload->'verdict'->>'category' FROM run_events x WHERE x.run_id = r.id AND x.type = 'kane.run_end' ORDER BY seq DESC LIMIT 1) AS kane_category,
           (SELECT payload->>'remark' FROM run_events x WHERE x.run_id = r.id AND x.type = 'kane.step' AND payload->>'status' = 'failed' ORDER BY seq LIMIT 1) AS failed_step
    FROM runs r JOIN environments e ON e.id = r.environment_id
    WHERE r.project_id = ${project.id} AND r.requirement_id = ${reqId} AND r.revision = ${rev.revision} ORDER BY r.created_at`;
  const parity = await sql<any[]>`SELECT id, status, reason_code, explanation, decision, created_at FROM parity_results WHERE project_id = ${project.id} AND requirement_id = ${reqId} ORDER BY created_at DESC LIMIT 20`;
  return { requirement: rev.body, hash: rev.hash, lifecycle: rev.lifecycle, frozenAt: rev.frozen_at, fixture: rev.fixture_identity, runs: runs.map((r) => ({ ...r, credits: r.credits === null ? null : Number(r.credits) })), parity };
}

async function tasks(sql: db.Sql, projectName: string) {
  const project = await db.getProject(sql, projectName);
  if (!project) return [];
  return sql<any[]>`SELECT t.id, t.requirement_id, t.revision, t.state, t.max_attempts, t.created_at, t.updated_at, count(a.id)::int AS attempts
                    FROM migration_tasks t LEFT JOIN agent_attempts a ON a.task_id = t.id WHERE t.project_id = ${project.id} GROUP BY t.id ORDER BY t.created_at DESC`;
}

async function taskDetail(sql: db.Sql, id: string) {
  const [t] = await sql<any[]>`SELECT * FROM migration_tasks WHERE id = ${id}`;
  if (!t) return null;
  const attempts = await sql<any[]>`SELECT id, attempt, state, branch, base_sha, candidate_sha, agent, agent_summary, agent_cost_usd, agent_turns, agent_ms, tool_uses, denied_tools, changed_paths, disallowed_paths, gate, patch, reverify_run_ids, decision, created_at, finished_at FROM agent_attempts WHERE task_id = ${id} ORDER BY attempt`;
  return { ...t, attempts };
}

async function discovery(sql: db.Sql, projectName: string) {
  const project = await db.getProject(sql, projectName);
  if (!project) return null;
  const runs = await sql<any[]>`SELECT environment, exploration_id, run_id, map_hash, totals, imported_at FROM discoveries WHERE project_id = ${project.id} ORDER BY imported_at DESC`;
  const items = await sql<any[]>`SELECT kind, key, title, detail, status, linked_requirement, sightings FROM discovery_items WHERE project_id = ${project.id} ORDER BY kind, title`;
  return { runs, items };
}

async function checks(sql: db.Sql, projectName: string) {
  const project = await db.getProject(sql, projectName);
  if (!project) return [];
  return sql<any[]>`SELECT label, requirement_id, revision, ref, candidate_sha, expected, verdicts, decision->>'status' AS status, decision->'regression' AS regression, as_expected, gate, created_at
                    FROM candidate_checks WHERE project_id = ${project.id} ORDER BY created_at DESC`;
}

/** SSE over a persisted event table. Resumes from Last-Event-ID; ends when the owner is terminal and drained. */
async function streamEvents(req: IncomingMessage, res: ServerResponse, sql: db.Sql, kind: 'run' | 'task', id: string) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  let last = Number(req.headers['last-event-id'] ?? new URL(req.url!, 'http://x').searchParams.get('after') ?? 0) || 0;
  let open = true;
  req.on('close', () => { open = false; });
  while (open) {
    const rows = kind === 'run'
      ? await sql<any[]>`SELECT seq, type, payload, at FROM run_events WHERE run_id = ${id} AND seq > ${last} ORDER BY seq LIMIT 200`
      : await sql<any[]>`SELECT seq, type, payload, at FROM task_events WHERE task_id = ${id} AND seq > ${last} ORDER BY seq LIMIT 200`;
    for (const r of rows) { res.write(`id: ${r.seq}\nevent: ${kind}\ndata: ${JSON.stringify({ seq: r.seq, type: r.type, at: r.at, payload: r.payload })}\n\n`); last = r.seq; }
    const [owner] = kind === 'run' ? await sql<any[]>`SELECT state FROM runs WHERE id = ${id}` : await sql<any[]>`SELECT state FROM migration_tasks WHERE id = ${id}`;
    const done = !owner || (kind === 'run' ? TERMINAL_RUN.has(owner.state) : TERMINAL_TASK.has(owner.state));
    if (done && rows.length === 0) { res.write(`event: end\ndata: ${JSON.stringify({ state: owner?.state ?? 'unknown' })}\n\n`); break; }
    res.write(': keep-alive\n\n');
    await new Promise((r) => setTimeout(r, 1000));
  }
  res.end();
}

export function startWebServer(sql: db.Sql, projectName: string, port = 4173) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const p = url.pathname;
      if (req.method !== 'GET') return json(res, 405, { error: 'read-only' });
      if (p === '/' || p === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'" });
        return res.end(await readFile(join(PUBLIC, 'index.html')));
      }
      if (p === '/api/overview') { const o = await overview(sql, projectName); return o ? json(res, 200, o) : json(res, 404, { error: 'no project' }); }
      if (p === '/api/report.md') { const pr = await db.getProject(sql, projectName); res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' }); return res.end(pr ? toMarkdown(await buildReport(sql, pr.id, pr.name)) : ''); }
      let m = p.match(/^\/api\/requirements\/(REQ-[A-Z0-9-]+)$/);
      if (m) { const d = await requirementDetail(sql, projectName, m[1]!); return d ? json(res, 200, d) : json(res, 404, { error: 'unknown requirement' }); }
      if (p === '/api/tasks') return json(res, 200, await tasks(sql, projectName));
      if (p === '/api/discovery') return json(res, 200, await discovery(sql, projectName));
      if (p === '/api/checks') return json(res, 200, await checks(sql, projectName));
      m = p.match(/^\/api\/tasks\/([0-9a-f-]{36})$/);
      if (m) { const t = await taskDetail(sql, m[1]!); return t ? json(res, 200, t) : json(res, 404, { error: 'unknown task' }); }
      m = p.match(/^\/api\/(runs|tasks)\/([0-9a-f-]{36})\/events$/);
      if (m && UUID.test(m[2]!)) return streamEvents(req, res, sql, m[1] === 'runs' ? 'run' : 'task', m[2]!);
      json(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: redact((e as Error).message) }); else res.end();
    }
  });
  server.listen(port, '127.0.0.1');
  return { server, url: `http://127.0.0.1:${port}/`, slimPath };
}
