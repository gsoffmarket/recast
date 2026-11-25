import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as db from '@recast/db';
import { buildReport, toMarkdown, toCsv } from '@recast/reports';
import { redact } from '@recast/shared';
import { readEvidenceSteps, readEvidenceScreenshot, extractNetworkEffects } from '@recast/kane-adapter';

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

// ---------- requirement story: everything about one requirement, in order ----------

async function runEvidence(sql: db.Sql, runId: string | undefined) {
  if (!runId) return null;
  const [r] = await sql<any[]>`SELECT r.id, r.kind, r.state, r.kane_outcome, r.fixture_ref, r.candidate_sha, r.evidence_path, r.evidence_sha256, r.evaluation->>'verdict' AS verdict,
                                      r.credits_balance_before - r.credits_balance_after AS credits, r.created_at, e.name AS environment, e.kind AS env_kind,
                                      (SELECT jsonb_object_agg(path, value) FROM observations o WHERE o.run_id = r.id) AS observed
                               FROM runs r JOIN environments e ON e.id = r.environment_id WHERE r.id = ${runId}`;
  if (!r) return null;
  const steps = r.evidence_path ? await readEvidenceSteps(r.evidence_path).catch(() => []) : [];
  const network = r.evidence_path && r.fixture_ref ? await extractNetworkEffects(r.evidence_path, { query_id: r.fixture_ref }).catch(() => []) : [];
  const runEnd = (await sql<any[]>`SELECT payload FROM run_events WHERE run_id = ${runId} AND type = 'kane.run_end' ORDER BY seq DESC LIMIT 1`)[0]?.payload;
  return {
    id: r.id, kind: r.kind, state: r.state, environment: r.environment, envKind: r.env_kind, candidateSha: r.candidate_sha, verdict: r.verdict, kaneOutcome: r.kane_outcome,
    observed: r.observed ?? {}, credits: r.credits === null ? null : Number(r.credits), at: r.created_at, evidenceSha: r.evidence_sha256, queryId: r.fixture_ref,
    kaneSaid: runEnd ? { status: runEnd.status, oneLiner: runEnd.one_liner ?? runEnd.reason ?? null, category: runEnd.verdict?.category ?? null } : null,
    steps: steps.map((s) => ({ dir: s.dir, ordinal: s.ordinal, kind: s.kind, status: s.status, summary: s.summary.split(r.fixture_ref ?? '\u0000').join('{query_id}'), shot: s.hasScreenshot })),
    network,
  };
}

async function requirementStory(sql: db.Sql, projectName: string, reqId: string) {
  const base = await requirementDetail(sql, projectName, reqId);
  if (!base) return null;
  const project = (await db.getProject(sql, projectName))!;
  const [rev] = await sql<any[]>`SELECT created_at, frozen_at, revision, lifecycle FROM requirement_revisions WHERE project_id = ${project.id} AND requirement_id = ${reqId} ORDER BY revision DESC LIMIT 1`;
  const discovered = await sql<any[]>`SELECT i.title, i.key, i.detail, d.exploration_id, d.imported_at FROM discovery_items i JOIN discoveries d ON d.id = i.first_discovery
                                      WHERE i.project_id = ${project.id} AND i.kind = 'candidate' AND i.linked_requirement = ${reqId}`;
  const tasksFor = await sql<any[]>`SELECT t.id, t.state, t.created_at, t.updated_at, t.max_attempts FROM migration_tasks t WHERE t.project_id = ${project.id} AND t.requirement_id = ${reqId} ORDER BY t.created_at`;
  const attempts = tasksFor.length ? await sql<any[]>`SELECT task_id, attempt, state, agent, candidate_sha, changed_paths, gate, decision, agent_summary, patch, agent_ms, tool_uses, denied_tools, agent_cost_usd, created_at, finished_at
                                                      FROM agent_attempts WHERE task_id = ANY(${tasksFor.map((t) => t.id)}) ORDER BY created_at` : [];
  const checksFor = await sql<any[]>`SELECT label, ref, candidate_sha, expected, verdicts, decision->>'status' AS status, decision->'regression' AS regression, as_expected, run_ids, created_at
                                     FROM candidate_checks WHERE project_id = ${project.id} AND requirement_id = ${reqId} ORDER BY created_at`;
  const runs = base.runs as any[];
  const checkRunIds = new Set(checksFor.flatMap((c) => c.run_ids as string[]));
  const source = [...runs].reverse().find((r) => r.kind === 'baseline' && r.state === 'completed');
  const target = [...runs].reverse().find((r) => r.kind === 'compare' && r.state === 'completed');
  const verifiedAttempt = [...attempts].reverse().find((a) => a.state === 'verified');
  const candidateRunId = verifiedAttempt?.decision?.targetRuns?.at(-1) ?? [...runs].reverse().find((r) => r.kind === 'reverify' && r.state === 'completed' && r.verdict === 'satisfied' && !checkRunIds.has(r.id))?.id;
  const credits = runs.reduce((a, r) => a + (r.credits ?? 0), 0);
  return {
    ...base, revisionInfo: rev ?? null, discovered, tasks: tasksFor.map((t) => ({ ...t, attempts: attempts.filter((a) => a.task_id === t.id) })), checks: checksFor,
    compare: { source: await runEvidence(sql, source?.id), target: await runEvidence(sql, target?.id), candidate: await runEvidence(sql, candidateRunId) },
    cost: { credits: Math.round(credits * 100) / 100, runs: runs.length, byKind: Object.fromEntries(['baseline', 'compare', 'reverify'].map((k) => [k, Math.round(runs.filter((r) => r.kind === k).reduce((a, r) => a + (r.credits ?? 0), 0) * 100) / 100])), agentMs: attempts.reduce((a, x) => a + (x.agent_ms ?? 0), 0) },
  };
}

async function history(sql: db.Sql, projectName: string) {
  const project = await db.getProject(sql, projectName);
  if (!project) return [];
  return sql<any[]>`SELECT requirement_id, revision, status, reason_code, created_at, decision->>'candidateSha' AS candidate_sha FROM parity_results WHERE project_id = ${project.id} ORDER BY created_at`;
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
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:" });
        return res.end(await readFile(join(PUBLIC, 'index.html')));
      }
      if (p === '/api/overview') { const o = await overview(sql, projectName); return o ? json(res, 200, o) : json(res, 404, { error: 'no project' }); }
      if (p === '/api/report.md') { const pr = await db.getProject(sql, projectName); res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' }); return res.end(pr ? toMarkdown(await buildReport(sql, pr.id, pr.name)) : ''); }
      let m = p.match(/^\/api\/requirements\/(REQ-[A-Z0-9-]+)$/);
      if (m) { const d = await requirementStory(sql, projectName, m[1]!); return d ? json(res, 200, d) : json(res, 404, { error: 'unknown requirement' }); }
      if (p === '/api/history') return json(res, 200, await history(sql, projectName));
      if (p === '/api/report.json' || p === '/api/report.csv') {
        const pr = await db.getProject(sql, projectName);
        const rep = pr ? await buildReport(sql, pr.id, pr.name) : null;
        res.writeHead(200, { 'content-type': p.endsWith('.csv') ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8' });
        return res.end(rep ? redact(p.endsWith('.csv') ? toCsv(rep) : JSON.stringify(rep, null, 2)) : '');
      }
      m = p.match(/^\/api\/runs\/([0-9a-f-]{36})\/shots\/([A-Za-z0-9-]{1,64})\.jpg$/);
      if (m) {
        const [r] = await sql<{ evidence_path: string | null }[]>`SELECT evidence_path FROM runs WHERE id = ${m[1]!}`;
        const img = r?.evidence_path ? await readEvidenceScreenshot(r.evidence_path, m[2]!) : null;
        if (!img) return json(res, 404, { error: 'no screenshot' });
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' });
        return res.end(img);
      }
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

// ---------- static snapshot (for hosting the workspace without the local database) ----------

/**
 * Write the workspace as a static site: the same page plus every API response as JSON, and run/task
 * event streams as replayable JSON. Everything passes through redact() first (home paths, share links,
 * UI tokens). Used to publish a read-only snapshot of real results, e.g. on Vercel.
 */
export async function exportStaticSite(sql: db.Sql, projectName: string, outDir: string): Promise<{ files: number; generatedAt: string }> {
  const generatedAt = new Date().toISOString();
  await rm(outDir, { recursive: true, force: true });
  let files = 0;
  const put = async (rel: string, body: unknown) => {
    const full = join(outDir, rel);
    await mkdir(dirname(full), { recursive: true });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    await writeFile(full, redact(text));
    files++;
  };
  const project = await db.getProject(sql, projectName);
  if (!project) throw new Error(`unknown project ${projectName}`);
  await put('data/overview.json', await overview(sql, projectName));
  await put('data/report.md', toMarkdown(await buildReport(sql, project.id, project.name)));
  await put('data/discovery.json', await discovery(sql, projectName));
  await put('data/checks.json', await checks(sql, projectName));
  const ts = await tasks(sql, projectName);
  await put('data/tasks.json', ts);
  for (const t of ts) {
    await put(`data/tasks/${t.id}.json`, await taskDetail(sql, t.id));
    await put(`data/tasks/${t.id}/events.json`, await sql`SELECT seq, type, payload, at FROM task_events WHERE task_id = ${t.id} ORDER BY seq`);
  }
  const rep = await buildReport(sql, project.id, project.name);
  await put('data/report.json', JSON.stringify(rep, null, 2));
  await put('data/report.csv', toCsv(rep));
  await put('data/history.json', await history(sql, projectName));
  for (const r of await db.listRevisions(sql, project.id)) {
    const d = await requirementStory(sql, projectName, r.requirement_id);
    await put(`data/requirements/${r.requirement_id}.json`, d);
    for (const run of d?.runs ?? []) await put(`data/runs/${run.id}/events.json`, await sql`SELECT seq, type, payload, at FROM run_events WHERE run_id = ${run.id} ORDER BY seq`);
    for (const ev of [d?.compare.source, d?.compare.target, d?.compare.candidate]) {
      if (!ev) continue;
      const [row] = await sql<{ evidence_path: string | null }[]>`SELECT evidence_path FROM runs WHERE id = ${ev.id}`;
      for (const st of ev.steps.filter((x) => x.shot)) {
        const img = row?.evidence_path ? await readEvidenceScreenshot(row.evidence_path, st.dir) : null;
        if (img) { const full = join(outDir, `data/runs/${ev.id}/shots/${st.dir}.jpg`); await mkdir(dirname(full), { recursive: true }); await writeFile(full, img); files++; }
      }
    }
  }
  const page = (await readFile(join(PUBLIC, 'index.html'), 'utf8')).replace('<script>\n\'use strict\';', `<script>window.RECAST_SNAPSHOT = ${JSON.stringify({ generatedAt, project: projectName })};</script>\n<script>\n'use strict';`);
  if (!page.includes('RECAST_SNAPSHOT')) throw new Error('could not inject snapshot marker into index.html');
  await put('index.html', page);
  await put('vercel.json', { cleanUrls: true, headers: [{ source: '/(.*)', headers: [
    { key: 'Content-Security-Policy', value: "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:" },
    { key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Referrer-Policy', value: 'no-referrer' }] }] });
  return { files, generatedAt };
}
