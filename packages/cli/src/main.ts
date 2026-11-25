#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { Command, Option } from 'commander';
import { ZodError } from 'zod';
import { newId } from '@recast/shared';
import { parseRequirement, requirementHash, lifecycleAfterBaseline, COMPARATOR_VERSION } from '@recast/behaviour-spec';
import { kaneVersion, kaneAuthenticated, kaneBalance, TESTED_KANE_VERSION } from '@recast/kane-adapter';
import { trinoFingerprint } from '@recast/observations';
import { evaluateRun, baselineStatus, classify, type RunEvaluation } from '@recast/parity';
import * as db from '@recast/db';
import { createQueue, createQueueEvents, enqueueAndWait, startWorker, executeRun, runRepair, type ProjectConfig, type RunJob, type RunSummary } from '@recast/runner';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { buildReport, toCsv, toMarkdown } from '@recast/reports';
import { startWebServer } from '@recast/web';
import { resolve } from 'node:path';

/** Recast exit codes (not Kane's): 0 ok, 1 confirmed gap, 2 invalid config, 3 inconclusive/infra, 4 cancelled. */
const EXIT = { ok: 0, gap: 1, config: 2, infra: 3, cancelled: 4 } as const;

class UsageError extends Error {}

const program = new Command()
  .name('recast')
  .description('Rebuild the software. Keep the behaviour.')
  .addOption(new Option('--project <name>', 'project name').default('trino-preview-parity'))
  .option('--json', 'machine-readable output')
  .option('--inline', 'run jobs in this process instead of the queue worker');

const opts = () => program.opts<{ project: string; json?: boolean; inline?: boolean }>();
const out = (human: string, data: unknown) => { if (opts().json) console.log(JSON.stringify(data, null, 2)); else console.log(human); };

async function withDb<T>(fn: (sql: db.Sql) => Promise<T>): Promise<T> {
  const sql = db.connect();
  try { return await fn(sql); } finally { await sql.end({ timeout: 5 }); }
}

async function requireProject(sql: db.Sql) {
  const p = await db.getProject(sql, opts().project);
  if (!p) throw new UsageError(`No project "${opts().project}". Run \`recast init --config <file>\` first.`);
  return { project: p, cfg: p.config as ProjectConfig };
}

async function runJobs(sql: db.Sql, jobs: RunJob[]): Promise<RunSummary[]> {
  const results: RunSummary[] = [];
  if (opts().inline) {
    for (const j of jobs) { results.push(await executeRun(sql, j)); printRun(results.at(-1)!); }
    return results;
  }
  const queue = createQueue();
  const events = createQueueEvents();
  try {
    for (const j of jobs) { const r = await enqueueAndWait(queue, events, j); results.push(r); printRun(r); }
  } finally { await queue.close(); await events.close(); }
  return results;
}

function printRun(r: RunSummary) {
  if (opts().json) return;
  const obs = Object.entries(r.observations).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`  run ${r.runId.slice(0, 8)}  ${r.state.padEnd(11)} kane=${(r.kaneOutcome ?? '-').padEnd(12)} verdict=${(r.verdict ?? '-').padEnd(13)} ${obs}${r.creditsSpent !== null ? `  credits=${r.creditsSpent}` : ''}${r.reused ? '  (reused)' : ''}`);
}

function evaluationsOf(rows: db.RunRow[]): RunEvaluation[] {
  return rows.filter((r) => r.state === 'completed' && r.evaluation).map((r) => r.evaluation as RunEvaluation);
}

// ---------- commands ----------

program.command('init')
  .description('Create or update a project from a config file, migrate the database and fingerprint environments')
  .requiredOption('--config <file>', 'project config JSON')
  .action(async (o: { config: string }) => {
    const cfg = JSON.parse(await readFile(o.config, 'utf8')) as ProjectConfig;
    if (!cfg.name || !Array.isArray(cfg.environments) || !cfg.environments.some((e) => e.kind === 'source')) throw new UsageError('config needs a name and at least one source environment');
    await withDb(async (sql) => {
      const applied = await db.migrate(sql);
      const project = await db.upsertProject(sql, cfg.name, cfg);
      for (const e of cfg.environments) {
        const fingerprint = await trinoFingerprint(e.apiBaseUrl ?? e.baseUrl).catch((err) => ({ error: (err as Error).message }));
        await db.upsertEnvironment(sql, { project_id: project.id, kind: e.kind, name: e.name, base_url: e.baseUrl, start_path: e.startPath, fingerprint });
      }
      out(`Project ${cfg.name} ready (${cfg.environments.length} environments)${applied.length ? `; applied ${applied.join(', ')}` : ''}.`, { project: project.id, applied });
    });
  });

program.command('doctor')
  .description('Preflight: database, queue, Kane CLI, credits and environments')
  .action(async () => {
    const checks: Array<{ check: string; status: 'pass' | 'fail' | 'inconclusive'; detail: string; action?: string }> = [];
    const add = (check: string, status: 'pass' | 'fail' | 'inconclusive', detail: string, action?: string) => checks.push({ check, status, detail, ...(action ? { action } : {}) });
    await withDb(async (sql) => {
      try { await sql`SELECT 1`; add('database', 'pass', 'Postgres reachable'); } catch (e) { add('database', 'fail', (e as Error).message, 'docker-compose up -d'); }
      const q = createQueue();
      try { const c = (await q.client) as unknown as { ping(): Promise<string> }; add('queue', (await c.ping()) === 'PONG' ? 'pass' : 'fail', 'Redis reachable'); } catch (e) { add('queue', 'fail', (e as Error).message, 'docker-compose up -d'); } finally { await q.close(); }
      const v = await kaneVersion();
      add('kane.version', v ? (v === TESTED_KANE_VERSION ? 'pass' : 'inconclusive') : 'fail', v ? `kane-cli ${v} (tested ${TESTED_KANE_VERSION})` : 'kane-cli not found', v ? undefined : 'npm install -g @testmuai/kane-cli');
      const auth = await kaneAuthenticated();
      add('kane.auth', auth ? 'pass' : 'fail', auth ? 'authenticated' : 'not logged in', auth ? undefined : 'kane-cli login');
      const p = await db.getProject(sql, opts().project).catch(() => undefined);
      const cfg = p?.config as ProjectConfig | undefined;
      const bal = auth ? await kaneBalance() : null;
      if (bal === null) add('kane.credits', 'inconclusive', 'balance unavailable');
      else add('kane.credits', !cfg || bal >= cfg.budget.minBalance ? 'pass' : 'fail', `${bal} credits${cfg ? ` (floor ${cfg.budget.minBalance})` : ''}`);
      if (!cfg) add('project', 'fail', `no project ${opts().project}`, 'recast init --config evaluation/trino/recast.config.json');
      for (const e of cfg?.environments ?? []) {
        try { const f = await trinoFingerprint(e.apiBaseUrl ?? e.baseUrl); add(`env.${e.name}`, f.starting === false ? 'pass' : 'inconclusive', `${e.kind} ${e.baseUrl}${e.startPath} trino ${String(f.version)}`); }
        catch (err) { add(`env.${e.name}`, 'fail', (err as Error).message, 'start the Trino container'); }
      }
    });
    if (opts().json) console.log(JSON.stringify({ at: new Date().toISOString(), checks }, null, 2));
    else for (const c of checks) console.log(`${c.status === 'pass' ? 'PASS' : c.status === 'fail' ? 'FAIL' : 'WARN'}  ${c.check.padEnd(22)} ${c.detail}${c.action ? `  → ${c.action}` : ''}`);
    process.exitCode = checks.some((c) => c.status === 'fail') ? EXIT.infra : EXIT.ok;
  });

const reqs = program.command('requirements').description('Manage requirements');

reqs.command('add <file>')
  .description('Add a requirement revision from a JSON file (no-op if unchanged)')
  .action(async (file: string) => {
    const req = parseRequirement(JSON.parse(await readFile(file, 'utf8')));
    await withDb(async (sql) => {
      const { project } = await requireProject(sql);
      const fixtureIdentity = req.fixture;
      const hash = requirementHash(req, fixtureIdentity);
      const current = await db.getRevision(sql, project.id, req.id);
      if (current && current.hash === hash) return out(`${req.id} r${current.revision} unchanged (${hash.slice(0, 19)}…), lifecycle ${current.lifecycle}.`, current);
      if (current && req.revision <= current.revision) throw new UsageError(`${req.id} r${req.revision} already exists with different content; bump "revision" to create r${current.revision + 1}. Frozen revisions are never edited in place.`);
      const row = await db.addRevision(sql, { project_id: project.id, requirement_id: req.id, revision: req.revision, body: req, fixture_identity: fixtureIdentity, hash, lifecycle: 'candidate' });
      out(`Added ${req.id} r${row.revision} (${hash}) as candidate.`, row);
    });
  });

reqs.command('list').description('List current requirement revisions').action(async () => {
  await withDb(async (sql) => {
    const { project } = await requireProject(sql);
    const rows = await db.listRevisions(sql, project.id);
    out(rows.map((r) => `${r.requirement_id.padEnd(22)} r${r.revision}  ${r.lifecycle.padEnd(16)} ${r.hash.slice(0, 23)}…  ${r.body.objective}`).join('\n') || 'No requirements yet.', rows);
  });
});

program.command('baseline')
  .description('Run a requirement against the source environment until it is established (≥2 matching runs)')
  .requiredOption('--requirement <id>')
  .option('--runs <n>', 'source runs to execute', '2')
  .action(async (o: { requirement: string; runs: string }) => {
    await withDb(async (sql) => {
      const { project, cfg } = await requireProject(sql);
      const rev = await db.getRevision(sql, project.id, o.requirement);
      if (!rev) throw new UsageError(`unknown requirement ${o.requirement}`);
      if (rev.frozen_at) throw new UsageError(`${o.requirement} r${rev.revision} is already frozen.`);
      const source = cfg.environments.find((e) => e.kind === 'source')!;
      const batch = newId().slice(0, 8);
      const jobs: RunJob[] = Array.from({ length: Number(o.runs) }, (_, i) => ({ projectName: project.name, requirementId: rev.requirement_id, revision: rev.revision, environment: source.name, kind: 'baseline', idempotencyKey: `baseline.${rev.requirement_id}.r${rev.revision}.${batch}.${i + 1}` }));
      if (!opts().json) console.log(`Baseline ${rev.requirement_id} r${rev.revision} on ${source.name}: ${jobs.length} runs`);
      await runJobs(sql, jobs);
      const env = (await db.getEnvironment(sql, project.id, source.name))!;
      const all = evaluationsOf(await db.listRunsFor(sql, project.id, rev.requirement_id, rev.revision, 'baseline', env.id));
      const b = baselineStatus(all);
      const lifecycle = lifecycleAfterBaseline(b.matching, b.contradictions);
      await db.setLifecycle(sql, project.id, rev.requirement_id, rev.revision, lifecycle);
      out(`${rev.requirement_id} r${rev.revision}: ${b.matching} matching source runs, ${b.contradictions} contradicting → ${lifecycle}.`, { ...b, lifecycle });
      process.exitCode = b.established ? EXIT.ok : EXIT.infra;
    });
  });

program.command('freeze')
  .description('Freeze an established requirement revision (immutable; the repair agent cannot change it)')
  .requiredOption('--requirement <id>')
  .action(async (o: { requirement: string }) => {
    await withDb(async (sql) => {
      const { project } = await requireProject(sql);
      const rev = await db.getRevision(sql, project.id, o.requirement);
      if (!rev) throw new UsageError(`unknown requirement ${o.requirement}`);
      if (rev.frozen_at) return out(`${o.requirement} r${rev.revision} already frozen (${rev.hash}).`, rev);
      if (rev.lifecycle !== 'established') throw new UsageError(`${o.requirement} r${rev.revision} is ${rev.lifecycle}; run \`recast baseline\` until it is established.`);
      await db.setLifecycle(sql, project.id, rev.requirement_id, rev.revision, 'frozen', true);
      out(`Frozen ${rev.requirement_id} r${rev.revision}  ${rev.hash}  (comparator ${COMPARATOR_VERSION}).`, { ...rev, lifecycle: 'frozen' });
    });
  });

program.command('compare')
  .description('Run a frozen requirement against a target environment and classify parity')
  .requiredOption('--requirement <id>')
  .requiredOption('--target <env>', 'target environment name')
  .option('--runs <n>', 'target runs (a confirmed gap needs ≥2)', '2')
  .action(async (o: { requirement: string; target: string; runs: string }) => {
    await withDb(async (sql) => {
      const { project, cfg } = await requireProject(sql);
      const rev = await db.getRevision(sql, project.id, o.requirement);
      if (!rev) throw new UsageError(`unknown requirement ${o.requirement}`);
      if (!rev.frozen_at) throw new UsageError(`${o.requirement} r${rev.revision} is not frozen; compare only runs against frozen requirements.`);
      const target = cfg.environments.find((e) => e.name === o.target && e.kind !== 'source');
      if (!target) throw new UsageError(`no target environment ${o.target}`);
      const batch = newId().slice(0, 8);
      const jobs: RunJob[] = Array.from({ length: Number(o.runs) }, (_, i) => ({ projectName: project.name, requirementId: rev.requirement_id, revision: rev.revision, environment: target.name, kind: 'compare', idempotencyKey: `compare.${target.name}.${rev.requirement_id}.r${rev.revision}.${batch}.${i + 1}` }));
      if (!opts().json) console.log(`Compare ${rev.requirement_id} r${rev.revision} on ${target.name}: ${jobs.length} runs`);
      const results = await runJobs(sql, jobs);
      const source = cfg.environments.find((e) => e.kind === 'source')!;
      const srcEnv = (await db.getEnvironment(sql, project.id, source.name))!;
      const sourceRuns = evaluationsOf(await db.listRunsFor(sql, project.id, rev.requirement_id, rev.revision, 'baseline', srcEnv.id));
      const thisBatch = new Set(results.map((r) => r.runId));
      const tgtEnv = (await db.getEnvironment(sql, project.id, target.name))!;
      const targetRuns = evaluationsOf((await db.listRunsFor(sql, project.id, rev.requirement_id, rev.revision, 'compare', tgtEnv.id)).filter((r) => thisBatch.has(r.id)));
      const decision = classify({ requirement: rev.body, baselineEstablished: true, sourceRuns, targetRuns });
      await db.insertParity(sql, { project_id: project.id, requirement_id: rev.requirement_id, revision: rev.revision, spec_hash: rev.hash, status: decision.status, reason_code: decision.reasonCode, explanation: decision.explanation, decision, comparator_version: decision.comparatorVersion });
      out(`${rev.requirement_id} r${rev.revision} on ${target.name}: ${decision.status.toUpperCase()} (${decision.reasonCode})\n  ${decision.explanation}`, decision);
      process.exitCode = decision.status === 'missing' ? EXIT.gap : decision.status === 'uncertain' || decision.status === 'untested' ? EXIT.infra : EXIT.ok;
    });
  });

program.command('repair')
  .description('Hand a confirmed MISSING requirement to the coding agent, then re-verify each candidate with Kane and the oracle')
  .requiredOption('--requirement <id>')
  .option('--max-attempts <n>', 'repair attempts (default from config)')
  .action(async (o: { requirement: string; maxAttempts?: string }) => {
    await withDb(async (sql) => {
      const recastRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
      const res = await runRepair(sql, opts().project, o.requirement, { recastRoot, log: (l) => { if (!opts().json) console.log(l); }, ...(o.maxAttempts ? { maxAttempts: Number(o.maxAttempts) } : {}) });
      out(res.state === 'verified_candidate'
        ? `VERIFIED CANDIDATE after ${res.attempts} attempt(s): ${res.candidateSha} on ${res.branch}\n  ${res.decision?.explanation ?? ''}`
        : `UNRESOLVED after ${res.attempts} attempt(s).${res.decision ? `\n  Last result: ${res.decision.status} — ${res.decision.explanation}` : ''}`, res);
      process.exitCode = res.state === 'verified_candidate' ? EXIT.ok : EXIT.gap;
    });
  });

program.command('status')
  .description('Scoped acceptance matrix with real denominators')
  .action(async () => {
    await withDb(async (sql) => {
      const { project } = await requireProject(sql);
      const revs = await db.listRevisions(sql, project.id);
      const parity = new Map((await db.latestParity(sql, project.id)).map((p) => [p.requirement_id, p]));
      const rows = revs.filter((r) => r.lifecycle === 'frozen').map((r) => {
        const p = parity.get(r.requirement_id);
        const current = p && p.revision === r.revision && p.spec_hash === r.hash;
        return { requirement: r.requirement_id, revision: r.revision, status: current ? p.status : 'untested', reason: current ? p.reason_code : 'NO_CURRENT_RESULT', explanation: current ? p.explanation : '' };
      });
      const verified = rows.filter((r) => r.status === 'preserved' || r.status === 'intentional_change').length;
      const human = [`${verified} of ${rows.length} frozen in-scope requirements verified (${revs.length - rows.length} not yet frozen).`, ...rows.map((r) => `  ${r.requirement.padEnd(22)} r${r.revision}  ${r.status.padEnd(18)} ${r.explanation}`)].join('\n');
      out(human, { verified, frozen: rows.length, notFrozen: revs.length - rows.length, rows });
    });
  });

program.command('report')
  .description('Export the scoped acceptance report (markdown, json or csv)')
  .addOption(new Option('--format <fmt>').choices(['markdown', 'json', 'csv']).default('markdown'))
  .option('--out <file>', 'write to a file instead of stdout')
  .action(async (o: { format: 'markdown' | 'json' | 'csv'; out?: string }) => {
    await withDb(async (sql) => {
      const { project } = await requireProject(sql);
      const r = await buildReport(sql, project.id, project.name);
      const text = o.format === 'json' ? JSON.stringify(r, null, 2) + '\n' : o.format === 'csv' ? toCsv(r) : toMarkdown(r);
      if (o.out) { await writeFile(o.out, text); console.log(`Wrote ${o.format} report to ${o.out} (${r.hash}).`); } else process.stdout.write(text);
    });
  });

program.command('ui')
  .description('Serve the read-only workspace UI on 127.0.0.1')
  .option('--port <n>', 'port', '4173')
  .action(async (o: { port: string }) => {
    const sql = db.connect();
    const { url } = startWebServer(sql, opts().project, Number(o.port));
    console.log(`Recast workspace: ${url}  (read-only; Ctrl-C to stop)`);
  });

program.command('worker').description('Run the queue worker (one mutating run at a time)').action(async () => {
  const sql = db.connect();
  const w = startWorker(sql);
  console.log('Recast worker started; waiting for runs. Ctrl-C to stop.');
  const stop = async () => { await w.close(); await sql.end({ timeout: 5 }); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
});

program.command('evaluate-offline', { hidden: true })
  .description('Evaluate stored observations again (debug)')
  .argument('<runId>')
  .action(async (runId: string) => withDb(async (sql) => {
    const run = await db.getRun(sql, runId);
    if (!run) throw new UsageError('unknown run');
    const rev = await db.getRevision(sql, run.project_id as string, run.requirement_id, run.revision);
    const obs = await sql<{ path: string; value: any; status: 'observed' | 'unavailable' }[]>`SELECT path, value, status FROM observations WHERE run_id = ${runId}`;
    out('', evaluateRun(runId, rev!.body, obs, run.state === 'completed'));
  }));

program.parseAsync().catch((e: unknown) => {
  if (e instanceof UsageError) { console.error(`recast: ${e.message}`); process.exitCode = EXIT.config; }
  else if (e instanceof ZodError) { console.error(`recast: invalid input\n${e.issues.map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`).join('\n')}`); process.exitCode = EXIT.config; }
  else { console.error(`recast: ${(e as Error).message}`); process.exitCode = EXIT.infra; }
});
