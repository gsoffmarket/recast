#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { Command, Option } from 'commander';
import { ZodError } from 'zod';
import { newId } from '@recast/shared';
import { parseDraft, parseRequirement, requirementHash, lifecycleAfterBaseline, COMPARATOR_VERSION } from '@recast/behaviour-spec';
import { kaneVersion, kaneAuthenticated, kaneBalance, TESTED_KANE_VERSION } from '@recast/kane-adapter';
import { evaluateRun, baselineStatus, classify, inferAssertions, type ObservedValue, type ProbeObservations, type RunEvaluation } from '@recast/parity';
import * as db from '@recast/db';
import { createQueue, createQueueEvents, enqueueAndWait, startWorker, executeRun, runRepair, verifyCandidateRef, makeAdapters, oracleMatches, parseProjectConfig, captureSubject, type ProjectConfig, type RunJob, type RunSummary } from '@recast/runner';
import { scaffoldProject } from './scaffold.ts';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { buildReport, toCsv, toMarkdown, buildContract, contractMarkdown } from '@recast/reports';
import { startWebServer, exportStaticSite, buildDocs, describeCli } from '@recast/web';
import { latestRunDir, readRunMap, suggestCandidates, draftFromCandidate, type CandidateSuggestion, type DiscoveryMap } from '@recast/discovery';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Recast exit codes (not Kane's): 0 ok, 1 confirmed gap, 2 invalid config, 3 inconclusive/infra, 4 cancelled. */
const EXIT = { ok: 0, gap: 1, config: 2, infra: 3, cancelled: 4 } as const;

class UsageError extends Error {}

const program = new Command()
  .name('recast')
  .description('Rebuild the software. Keep the behaviour.')
  .addOption(new Option('--project <name>', 'project name (or set RECAST_PROJECT)').default(process.env.RECAST_PROJECT ?? 'trino-preview-parity'))
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

type ProjectRow = NonNullable<Awaited<ReturnType<typeof db.getProject>>>;

/** Run a revision on the source environment and set its lifecycle from all its baseline runs. */
async function baselineRevision(sql: db.Sql, project: ProjectRow, cfg: ProjectConfig, rev: db.RevisionRow, runs: number) {
  const source = cfg.environments.find((e) => e.kind === 'source')!;
  const batch = newId().slice(0, 8);
  const jobs: RunJob[] = Array.from({ length: runs }, (_, i) => ({ projectName: project.name, requirementId: rev.requirement_id, revision: rev.revision, environment: source.name, kind: 'baseline', idempotencyKey: `baseline.${rev.requirement_id}.r${rev.revision}.${batch}.${i + 1}` }));
  if (!opts().json) console.log(`Baseline ${rev.requirement_id} r${rev.revision} on ${source.name}: ${jobs.length} runs`);
  await runJobs(sql, jobs);
  const env = (await db.getEnvironment(sql, project.id, source.name))!;
  const b = baselineStatus(evaluationsOf(await db.listRunsFor(sql, project.id, rev.requirement_id, rev.revision, 'baseline', env.id)));
  const lifecycle = lifecycleAfterBaseline(b.matching, b.contradictions);
  await db.setLifecycle(sql, project.id, rev.requirement_id, rev.revision, lifecycle);
  return { ...b, lifecycle };
}

async function freezeRevision(sql: db.Sql, projectId: string, rev: db.RevisionRow) {
  await db.setLifecycle(sql, projectId, rev.requirement_id, rev.revision, 'frozen', true);
}

/** Run a frozen revision on a target environment, classify it from this batch only, and record the result. */
async function compareRevision(sql: db.Sql, project: ProjectRow, cfg: ProjectConfig, rev: db.RevisionRow, targetName: string, runs: number) {
  const batch = newId().slice(0, 8);
  const jobs: RunJob[] = Array.from({ length: runs }, (_, i) => ({ projectName: project.name, requirementId: rev.requirement_id, revision: rev.revision, environment: targetName, kind: 'compare', idempotencyKey: `compare.${targetName}.${rev.requirement_id}.r${rev.revision}.${batch}.${i + 1}` }));
  if (!opts().json) console.log(`Compare ${rev.requirement_id} r${rev.revision} on ${targetName}: ${jobs.length} runs`);
  const results = await runJobs(sql, jobs);
  const source = cfg.environments.find((e) => e.kind === 'source')!;
  const srcEnv = (await db.getEnvironment(sql, project.id, source.name))!;
  const sourceRuns = evaluationsOf(await db.listRunsFor(sql, project.id, rev.requirement_id, rev.revision, 'baseline', srcEnv.id));
  const thisBatch = new Set(results.map((r) => r.runId));
  const tgtEnv = (await db.getEnvironment(sql, project.id, targetName))!;
  const targetRuns = evaluationsOf((await db.listRunsFor(sql, project.id, rev.requirement_id, rev.revision, 'compare', tgtEnv.id)).filter((r) => thisBatch.has(r.id)));
  const decision = classify({ requirement: rev.body, baselineEstablished: true, sourceRuns, targetRuns });
  await db.insertParity(sql, { project_id: project.id, requirement_id: rev.requirement_id, revision: rev.revision, spec_hash: rev.hash, status: decision.status, reason_code: decision.reasonCode, explanation: decision.explanation, decision, comparator_version: decision.comparatorVersion });
  return decision;
}

// ---------- commands ----------

program.command('new <dir>')
  .description('Scaffold a project for your own app: config, an example requirement and next steps (no database needed)')
  .option('--name <name>', 'project name (lowercase, dashes)')
  .option('--legacy-url <url>', 'where the legacy UI runs', 'http://localhost:3000')
  .option('--new-url <url>', 'where the new UI runs', 'http://localhost:3001')
  .option('--api-url <url>', 'where the app API runs (fixture and oracle calls)')
  .option('--force', 'overwrite existing files')
  .action(async (dir: string, o: { name?: string; legacyUrl: string; newUrl: string; apiUrl?: string; force?: boolean }) => {
    const written = await scaffoldProject(dir, { name: o.name, legacyUrl: o.legacyUrl, newUrl: o.newUrl, apiUrl: o.apiUrl, force: !!o.force }).catch((e) => { throw new UsageError((e as Error).message); });
    out(`Created ${written.length} files in ${dir}:\n${written.map((f) => `  ${f}`).join('\n')}\nNext: edit the fixture and oracle in ${dir}/recast.config.json, then read ${dir}/NEXT_STEPS.md.`, { files: written });
  });

program.command('init')
  .description('Create or update a project from a config file, migrate the database and fingerprint environments')
  .requiredOption('--config <file>', 'project config JSON')
  .action(async (o: { config: string }) => {
    const cfg = parseProjectConfig(JSON.parse(await readFile(o.config, 'utf8'))) as ProjectConfig;
    const adapters = makeAdapters(parseProjectConfig(cfg));
    await withDb(async (sql) => {
      const applied = await db.migrate(sql);
      const project = await db.upsertProject(sql, cfg.name, cfg);
      for (const e of cfg.environments) {
        const fingerprint = await adapters.fingerprint(e.apiBaseUrl ?? e.baseUrl, new URL(e.startPath, e.baseUrl).toString()).catch((err) => ({ error: (err as Error).message }));
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
      let adapters: ReturnType<typeof makeAdapters> | null = null;
      if (cfg) { try { adapters = makeAdapters(parseProjectConfig(cfg)); add('config', 'pass', `fixture ${adapters.fixtureIdentity}, oracle ${adapters.oracleName}`); } catch (e) { add('config', 'fail', (e as Error).message.slice(0, 300), 'fix the config, then recast init --config <file>'); } }
      for (const e of adapters ? cfg?.environments ?? [] : []) {
        const ui = new URL(e.startPath, e.baseUrl).toString();
        try {
          const uiOk = await fetch(ui).then((r) => r.status < 500).catch(() => false);
          const f = await adapters!.fingerprint(e.apiBaseUrl ?? e.baseUrl, ui);
          const version = f.version ?? f.status ?? '';
          if (!uiOk && e.kind === 'candidate') add(`env.${e.name}`, 'inconclusive', `candidate ${ui} not running (recast repair starts it)`);
          else add(`env.${e.name}`, uiOk && adapters!.ready(f) ? 'pass' : uiOk ? 'inconclusive' : 'fail', `${e.kind} ${ui}${version !== '' ? ` (${String(version)})` : ''}`, uiOk ? undefined : `start the app so ${ui} responds`);
        } catch (err) { add(`env.${e.name}`, 'fail', (err as Error).message, `start the app behind ${e.apiBaseUrl ?? e.baseUrl}`); }
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
      const { project, cfg } = await requireProject(sql);
      const a = makeAdapters(parseProjectConfig(cfg));
      if (req.fixture !== a.fixtureIdentity) throw new UsageError(`${req.id} uses fixture "${req.fixture}", but project ${project.name} provides "${a.fixtureIdentity}". Set "fixture" to "${a.fixtureIdentity}".`);
      if (!oracleMatches(req.oracle, a.oracleName)) throw new UsageError(`${req.id} uses oracle "${req.oracle}", but project ${project.name} provides "${a.oracleName}". Set "oracle" to "${a.oracleName}".`);
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
      const b = await baselineRevision(sql, project, cfg, rev, Number(o.runs));
      out(`${rev.requirement_id} r${rev.revision}: ${b.matching} matching source runs, ${b.contradictions} contradicting → ${b.lifecycle}.`, b);
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
      await freezeRevision(sql, project.id, rev);
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
      const decision = await compareRevision(sql, project, cfg, rev, target.name, Number(o.runs));
      out(`${rev.requirement_id} r${rev.revision} on ${target.name}: ${decision.status.toUpperCase()} (${decision.reasonCode})\n  ${decision.explanation}`, decision);
      process.exitCode = decision.status === 'missing' ? EXIT.gap : decision.status === 'uncertain' || decision.status === 'untested' ? EXIT.infra : EXIT.ok;
    });
  });

program.command('repair')
  .description('Hand a confirmed MISSING requirement to the coding agent, then re-verify each candidate with Kane and the oracle')
  .requiredOption('--requirement <id>')
  .option('--max-attempts <n>', 'repair attempts (default from config)')
  .addOption(new Option('--simulate-agent <kind>', 'adversarial evaluation: run a scripted misbehaving agent instead of the model').choices(['tamper-spec', 'tamper-db', 'edit-outside-src']))
  .action(async (o: { requirement: string; maxAttempts?: string; simulateAgent?: 'tamper-spec' | 'tamper-db' | 'edit-outside-src' }) => {
    await withDb(async (sql) => {
      const recastRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
      const res = await runRepair(sql, opts().project, o.requirement, { recastRoot, log: (l) => { if (!opts().json) console.log(l); }, ...(o.maxAttempts ? { maxAttempts: Number(o.maxAttempts) } : {}), ...(o.simulateAgent ? { simulateAgent: o.simulateAgent } : {}) });
      out(res.state === 'verified_candidate'
        ? `VERIFIED CANDIDATE after ${res.attempts} attempt(s): ${res.candidateSha} on ${res.branch}\n  ${res.decision?.explanation ?? ''}`
        : `UNRESOLVED after ${res.attempts} attempt(s).${res.decision ? `\n  Last result: ${res.decision.status} — ${res.decision.explanation}` : ''}`, res);
      process.exitCode = res.state === 'verified_candidate' ? EXIT.ok : EXIT.gap;
    });
  });

program.command('verify-candidate')
  .description('Serve a git ref of the target as the candidate and re-run a frozen requirement against it (harness or control check; not counted as parity)')
  .requiredOption('--requirement <id>')
  .requiredOption('--ref <ref>', 'git ref in the target checkout, e.g. recast/harness-cancel or 481')
  .requiredOption('--label <label>', 'short name, e.g. harness-operator or control-unpatched')
  .addOption(new Option('--expect <result>').choices(['preserved', 'missing']).makeOptionMandatory())
  .option('--runs <n>', 'runs', '2')
  .option('--regression', 'also re-check previously preserved requirements on the candidate')
  .action(async (o: { requirement: string; ref: string; label: string; expect: 'preserved' | 'missing'; runs: string; regression?: boolean }) => {
    await withDb(async (sql) => {
      const recastRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
      const r = await verifyCandidateRef(sql, opts().project, o.requirement, o.ref, { recastRoot, log: (l) => { if (!opts().json) console.log(l); }, runs: Number(o.runs), label: o.label, expected: o.expect, ...(o.regression ? { regression: true } : {}) });
      out(`${r.label}: ${r.decision.status} — ${r.asExpected ? 'as expected' : 'NOT as expected'}`, r);
      process.exitCode = r.asExpected ? EXIT.ok : EXIT.gap;
    });
  });

const disc = program.command('discover').description('Kane Exploration: map the source app, import screens, flows and candidate requirements');

async function importMap(sql: db.Sql, projectId: string, environment: string, map: DiscoveryMap) {
  const candidates = suggestCandidates(map);
  const totals = { screens: map.screens.length, flows: map.flows.length, findings: map.findings.length, candidates: candidates.length };
  const [existing] = await sql<{ id: string }[]>`SELECT id FROM discoveries WHERE project_id = ${projectId} AND map_hash = ${map.hash}`;
  const discId = existing?.id ?? newId();
  if (!existing) await sql`INSERT INTO discoveries (id, project_id, environment, exploration_id, run_id, map_hash, totals) VALUES (${discId}, ${projectId}, ${environment}, ${map.explorationId}, ${map.runId}, ${map.hash}, ${sql.json(totals)})`;
  const items: Array<{ kind: string; key: string; title: string; detail: unknown }> = [
    ...map.screens.map((x) => ({ kind: 'screen', key: x.urlPattern.replace(/\?.*$/, '') || x.id, title: x.name, detail: { url: x.urlPattern, heading: x.heading, controls: x.controls.map((c) => ({ role: c.role, name: c.name, scope: c.scope, walked: c.walked })) } })),
    ...map.flows.map((x) => ({ kind: 'flow', key: x.name.toLowerCase(), title: x.name, detail: { status: x.status, description: x.description, steps: x.steps } })),
    ...map.findings.map((x) => ({ kind: 'finding', key: x.title.toLowerCase(), title: x.title, detail: { kind: x.kind, severity: x.severity } })),
    ...candidates.map((x) => ({ kind: 'candidate', key: x.key, title: x.title, detail: x })),
  ];
  for (const it of items) {
    await sql`INSERT INTO discovery_items (project_id, kind, key, title, detail, first_discovery, last_discovery)
              VALUES (${projectId}, ${it.kind}, ${it.key}, ${it.title}, ${sql.json(it.detail as any)}, ${discId}, ${discId})
              ON CONFLICT (project_id, kind, key) DO UPDATE SET title = EXCLUDED.title, detail = EXCLUDED.detail, last_discovery = EXCLUDED.last_discovery,
                sightings = discovery_items.sightings + CASE WHEN discovery_items.last_discovery = EXCLUDED.last_discovery THEN 0 ELSE 1 END`;
  }
  return { discId, totals, candidates, reused: !!existing };
}

disc.command('import')
  .description('Import the newest run of a Kane exploration from this machine')
  .requiredOption('--exploration <id>', 'exploration id (kane-cli explore list --all)')
  .option('--env <name>', 'source environment the exploration mapped')
  .action(async (o: { exploration: string; env?: string }) => {
    await withDb(async (sql) => {
      const { project, cfg } = await requireProject(sql);
      const env = o.env ?? cfg.environments.find((e) => e.kind === 'source')!.name;
      const map = await readRunMap(await latestRunDir(o.exploration), o.exploration);
      const r = await importMap(sql, project.id, env, map);
      out([`Imported exploration ${o.exploration.slice(0, 8)} (${env})${r.reused ? ' — same map as before, sightings unchanged' : ''}: ${r.totals.screens} screens, ${r.totals.flows} flows, ${r.totals.findings} findings.`,
        `${r.totals.candidates} candidate requirements (discovery is not proof; baseline them to establish):`, ...r.candidates.map((c) => `  · ${c.title} — ${c.why}`)].join('\n'), r);
    });
  });

disc.command('run')
  .description('Run a capped Kane Exploration of the source environment on this machine, then import it')
  .option('--max-leases <n>', 'lease cap (credit budget)', '8')
  .option('--prompt <text>', 'scope for the explorer', 'Map the screens and flows an operator uses.')
  .option('--deny <names>', 'comma-separated controls never to press', 'Kill,Preempt,Log Out,Logout')
  .action(async (o: { maxLeases: string; prompt: string; deny: string }) => {
    await withDb(async (sql) => {
      const { project, cfg } = await requireProject(sql);
      const src = cfg.environments.find((e) => e.kind === 'source')!;
      const url = new URL(src.startPath, src.baseUrl).toString();
      const outDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../evaluation/trino/runs/explore');
      await mkdir(outDir, { recursive: true });
      const args = ['explore', 'run', '--url', url, '--local-orchestration', '--browser', 'local', '--headless', '--policy', 'mutating', '--allow-domain', new URL(src.baseUrl).hostname,
        ...o.deny.split(',').flatMap((d) => ['--deny', d.trim()]), '--max-leases', o.maxLeases, '--max-parallel', '1',
        '--deps', 'Logged in to the web UI as {{recast_user}}: type {{recast_user}} as the username, leave the password empty, press Log In',
        '--variables', JSON.stringify({ recast_user: { value: cfg.role.username, secret: false } }), '--prompt', o.prompt, '--agent'];
      if (!opts().json) console.log(`Exploring ${url} (max ${o.maxLeases} leases, denied: ${o.deny})…`);
      const before = await kaneBalance();
      const lines: string[] = [];
      const code = await new Promise<number | null>((res, rej) => {
        const c = spawn(process.env.KANE_BIN ?? 'kane-cli', args, { stdio: ['ignore', 'pipe', 'inherit'] });
        let buf = '';
        c.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); lines.push(l); try { const e = JSON.parse(l); if (!opts().json && ['lease_end', 'explore_end'].includes(e.type)) console.log(`  ${e.type}${e.totals ? ' ' + JSON.stringify({ screens: e.totals.junctions, flows: e.totals.flows, findings: e.totals.findings }) : ''}`); } catch { /* not json */ } } });
        c.on('error', rej); c.on('close', res);
      });
      const created = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e?.exploration_id);
      if (code !== 0 || !created) throw new Error(`kane-cli explore exited ${code}`);
      const after = await kaneBalance();
      const map = await readRunMap(await latestRunDir(created.exploration_id), created.exploration_id);
      const r = await importMap(sql, project.id, src.name, map);
      out(`Exploration ${created.exploration_id.slice(0, 8)}: ${r.totals.screens} screens, ${r.totals.flows} flows, ${r.totals.candidates} candidates; credits ${before !== null && after !== null ? (before - after).toFixed(2) : 'unknown'}.`, { ...r, credits: before !== null && after !== null ? before - after : null });
    });
  });

disc.command('list').description('Discovered screens, flows and candidate requirements').action(async () => {
  await withDb(async (sql) => {
    const { project } = await requireProject(sql);
    const rows = await sql<any[]>`SELECT kind, key, title, status, linked_requirement, sightings FROM discovery_items WHERE project_id = ${project.id} AND kind <> 'finding' ORDER BY kind, title`;
    const [f] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM discovery_items WHERE project_id = ${project.id} AND kind = 'finding'`;
    out([...rows.map((r) => `${r.kind.padEnd(10)} ${r.status.padEnd(9)} ${(r.linked_requirement ?? '').padEnd(16)} ${r.title}`), `(${f?.n ?? 0} findings not shown)`].join('\n') || 'Nothing discovered yet.', rows);
  });
});

disc.command('link')
  .description('Link a discovered candidate to the requirement that now covers it (traceability)')
  .requiredOption('--key <key>', 'candidate key from `recast discover list --json`')
  .requiredOption('--requirement <id>')
  .action(async (o: { key: string; requirement: string }) => {
    await withDb(async (sql) => {
      const { project } = await requireProject(sql);
      if (!(await db.getRevision(sql, project.id, o.requirement))) throw new UsageError(`unknown requirement ${o.requirement}`);
      const r = await sql`UPDATE discovery_items SET status = 'linked', linked_requirement = ${o.requirement} WHERE project_id = ${project.id} AND kind = 'candidate' AND key = ${o.key}`;
      if (r.count === 0) throw new UsageError(`no candidate with key ${o.key}`);
      out(`Linked ${o.key} → ${o.requirement}.`, { key: o.key, requirement: o.requirement });
    });
  });

// ---------- capture, check, contract: freeze a whole legacy app and hold a rebuild to it ----------

const collect = (v: string, prev: string[]) => [...prev, v];

program.command('capture')
  .description('Freeze what the legacy app does: probe each discovered control on the source UI, infer its effect from the API, confirm it with fresh runs, then freeze it')
  .option('--candidate <key>', 'only this discovery candidate (repeat for several; keys from `recast discover list --json`)', collect, [])
  .option('--include-linked', 'also capture candidates already linked to a requirement')
  .option('--limit <n>', 'capture at most this many candidates')
  .option('--probe-runs <n>', 'runs used to infer what each control does', '2')
  .option('--confirm-runs <n>', 'fresh runs that must then satisfy the inferred result (at least 2)', '2')
  .option('--out <dir>', 'write each captured requirement as JSON here', 'captured')
  .option('--dry-run', 'show the drafts and how many Kane runs they need, and run nothing')
  .option('--yes', 'confirm spending Kane credits on the runs')
  .action(async (o: { candidate: string[]; includeLinked?: boolean; limit?: string; probeRuns: string; confirmRuns: string; out: string; dryRun?: boolean; yes?: boolean }) => {
    const probeRuns = Number(o.probeRuns);
    const confirmRuns = Number(o.confirmRuns);
    if (!Number.isInteger(probeRuns) || probeRuns < 1) throw new UsageError('--probe-runs must be at least 1');
    if (!Number.isInteger(confirmRuns) || confirmRuns < 2) throw new UsageError('--confirm-runs must be at least 2: a behaviour is only established by two matching runs');
    await withDb(async (sql) => {
      const { project, cfg } = await requireProject(sql);
      const parsed = parseProjectConfig(cfg);
      const adapters = makeAdapters(parsed);
      const source = cfg.environments.find((e) => e.kind === 'source')!;
      const rows = await sql<{ key: string; status: string; detail: CandidateSuggestion }[]>`SELECT key, status, detail FROM discovery_items WHERE project_id = ${project.id} AND kind = 'candidate' ORDER BY title`;
      if (!rows.length) throw new UsageError('No discovered candidates. Run `recast discover run` first, so Kane maps the legacy UI.');
      const results: Array<{ candidate: string; requirement: string | null; outcome: string; detail: string }> = [];
      const drafts: Array<{ key: string; draft: ReturnType<typeof parseDraft> }> = [];
      for (const r of rows) {
        if (o.candidate.length && !o.candidate.includes(r.key)) continue;
        if (r.status === 'excluded') { results.push({ candidate: r.key, requirement: null, outcome: 'skipped', detail: 'excluded from requirements' }); continue; }
        if (r.status === 'linked' && !o.includeLinked) { results.push({ candidate: r.key, requirement: null, outcome: 'skipped', detail: 'already covered by a requirement (--include-linked to capture it anyway)' }); continue; }
        const raw = draftFromCandidate(r.detail, { fixture: adapters.fixtureIdentity, oracle: adapters.oracleName, subject: captureSubject(parsed) });
        if (!raw) { results.push({ candidate: r.key, requirement: null, outcome: 'skipped', detail: 'flows have no single effect to characterise; write a requirement for them by hand' }); continue; }
        const draft = parseDraft(raw);
        if (await db.getRevision(sql, project.id, draft.id)) { results.push({ candidate: r.key, requirement: draft.id, outcome: 'skipped', detail: `${draft.id} already exists` }); continue; }
        drafts.push({ key: r.key, draft });
      }
      const todo = o.limit ? drafts.slice(0, Number(o.limit)) : drafts;
      const kaneRuns = todo.length * (probeRuns + confirmRuns);
      const plan = [`Capture on ${source.name}: ${todo.length} control(s), ${probeRuns} probe + ${confirmRuns} confirm runs each = ${kaneRuns} Kane runs (about 25–65 credits per run in the Trino case).`,
        ...todo.map((d) => `  ${d.draft.id}\n    ${d.draft.action_intent}`)];
      if (o.dryRun || !todo.length) {
        out([...plan, ...results.map((r) => `  skip ${r.candidate}: ${r.detail}`)].join('\n'), { plan: todo.map((d) => ({ candidate: d.key, draft: d.draft })), kaneRuns, skipped: results });
        return;
      }
      if (!o.yes) throw new UsageError(`${plan[0]}\nRe-run with --yes to spend the credits, or --dry-run to preview the drafts.`);
      if (!opts().json) console.log(plan.join('\n'));
      await mkdir(o.out, { recursive: true });
      let unsettled = 0;
      for (const { key, draft } of todo) {
        const batch = newId().slice(0, 8);
        if (!opts().json) console.log(`\n${draft.id}: probing the legacy UI (${probeRuns} runs)`);
        const probes = await runJobs(sql, Array.from({ length: probeRuns }, (_, i) => ({ projectName: project.name, requirementId: draft.id, revision: 0, environment: source.name, kind: 'probe' as const, draft, idempotencyKey: `probe.${draft.id}.${batch}.${i + 1}` })));
        const usable = probes.filter((p) => p.state === 'completed' && (p.kaneOutcome === 'passed' || p.kaneOutcome === 'did_not_pass'));
        if (usable.length < probeRuns) { unsettled++; results.push({ candidate: key, requirement: draft.id, outcome: 'inconclusive', detail: `${probeRuns - usable.length} of ${probeRuns} probe runs did not complete` }); continue; }
        const obs = await sql<{ run_id: string; path: string; value: ObservedValue['value']; status: ObservedValue['status'] }[]>`SELECT run_id, path, value, status FROM observations WHERE run_id = ANY(${usable.map((p) => p.runId)})`;
        const probeObs: ProbeObservations[] = usable.map((p) => {
          const mine = obs.filter((x) => x.run_id === p.runId);
          return {
            runId: p.runId,
            before: mine.filter((x) => x.path.startsWith('before:')).map((x) => ({ path: x.path.slice('before:'.length), value: x.value, status: x.status })),
            after: mine.filter((x) => !x.path.startsWith('before:')).map((x) => ({ path: x.path, value: x.value, status: x.status })),
          };
        });
        const inferred = inferAssertions(probeObs);
        if (!inferred.assertions.length) {
          results.push({ candidate: key, requirement: draft.id, outcome: 'no observable effect', detail: inferred.skipped.map((x) => `${x.path}: ${x.reason}`).join('; ') || 'the oracle observed nothing' });
          continue;
        }
        const req = parseRequirement({ ...draft, assertions: inferred.assertions, source_evidence: [...draft.source_evidence, ...usable.map((p) => `probe-run:${p.runId}`)] });
        await writeFile(resolve(o.out, `${req.id}.json`), `${JSON.stringify(req, null, 2)}\n`);
        const hash = requirementHash(req, req.fixture);
        const rev = await db.addRevision(sql, { project_id: project.id, requirement_id: req.id, revision: req.revision, body: req, fixture_identity: req.fixture, hash, lifecycle: 'candidate' });
        if (!opts().json) console.log(`  inferred: ${inferred.assertions.map((a) => `${a.path} = ${JSON.stringify(a.expected)}`).join(', ')}\n  confirming with ${confirmRuns} fresh runs`);
        const b = await baselineRevision(sql, project, cfg, rev, confirmRuns);
        if (!b.established) { unsettled++; results.push({ candidate: key, requirement: req.id, outcome: b.lifecycle, detail: `${b.matching} matching, ${b.contradictions} contradicting confirm runs; not frozen` }); continue; }
        await freezeRevision(sql, project.id, rev);
        await sql`UPDATE discovery_items SET status = 'linked', linked_requirement = ${req.id} WHERE project_id = ${project.id} AND kind = 'candidate' AND key = ${key} AND status = 'candidate'`;
        results.push({ candidate: key, requirement: req.id, outcome: 'frozen', detail: `${inferred.assertions.map((a) => `${a.path} = ${JSON.stringify(a.expected)}`).join(', ')} (${b.matching} of ${confirmRuns} confirm runs)` });
      }
      const frozen = results.filter((r) => r.outcome === 'frozen').length;
      out([`\nCaptured ${frozen} of ${todo.length} control(s). Requirement files are in ${o.out}/.`, ...results.map((r) => `  ${r.outcome.padEnd(20)} ${(r.requirement ?? r.candidate).padEnd(34)} ${r.detail}`), frozen ? 'Next: `recast contract` writes the behaviour contract for the rebuild.' : ''].filter(Boolean).join('\n'), { frozen, results });
      process.exitCode = unsettled ? EXIT.infra : EXIT.ok;
    });
  });

program.command('check')
  .description('Check a rebuild against every frozen requirement: compare each on a target environment and summarise (exit 1 if any is missing)')
  .requiredOption('--target <env>', 'target environment name')
  .option('--runs <n>', 'target runs per requirement (a confirmed gap needs ≥2)', '2')
  .option('--requirement <id>', 'only these requirements (repeatable)', collect, [])
  .action(async (o: { target: string; runs: string; requirement: string[] }) => {
    await withDb(async (sql) => {
      const { project, cfg } = await requireProject(sql);
      const target = cfg.environments.find((e) => e.name === o.target && e.kind !== 'source');
      if (!target) throw new UsageError(`no target environment ${o.target}`);
      const frozen = (await db.listRevisions(sql, project.id)).filter((r) => r.frozen_at && (!o.requirement.length || o.requirement.includes(r.requirement_id)));
      if (!frozen.length) throw new UsageError('No frozen requirements to check. Run `recast capture`, or baseline and freeze requirements first.');
      if (!opts().json) console.log(`Check ${target.name} against ${frozen.length} frozen requirement(s), ${o.runs} runs each`);
      const rows: Array<{ requirement: string; status: string; explanation: string }> = [];
      for (const rev of frozen) {
        const d = await compareRevision(sql, project, cfg, rev, target.name, Number(o.runs));
        rows.push({ requirement: rev.requirement_id, status: d.status, explanation: d.explanation });
      }
      const count = (s: string) => rows.filter((r) => r.status === s).length;
      const missing = count('missing');
      const unsure = count('uncertain') + count('untested');
      out([`\n${target.name}: ${count('preserved') + count('intentional_change')} preserved, ${missing} missing, ${unsure} uncertain, of ${rows.length}.`, ...rows.map((r) => `  ${r.status.toUpperCase().padEnd(18)} ${r.requirement.padEnd(30)} ${r.explanation}`)].join('\n'), { target: target.name, rows });
      process.exitCode = missing ? EXIT.gap : unsure ? EXIT.infra : EXIT.ok;
    });
  });

program.command('contract')
  .description('Write the behaviour contract: every frozen requirement with its evidence, as Markdown and JSON for whoever rebuilds the app')
  .option('--out <dir>', 'output folder', 'contract')
  .action(async (o: { out: string }) => {
    await withDb(async (sql) => {
      const { project, cfg } = await requireProject(sql);
      const c = await buildContract(sql, project.id, project.name, cfg);
      await mkdir(o.out, { recursive: true });
      await writeFile(resolve(o.out, 'CONTRACT.md'), contractMarkdown(c));
      await writeFile(resolve(o.out, 'contract.json'), `${JSON.stringify(c, null, 2)}\n`);
      out(`Wrote ${o.out}/CONTRACT.md and ${o.out}/contract.json: ${c.behaviours.length} frozen behaviour(s)${c.notFrozen.length ? `, ${c.notFrozen.length} not yet frozen` : ''} (hash ${c.hash.slice(0, 23)}…).`, { behaviours: c.behaviours.length, notFrozen: c.notFrozen.length, hash: c.hash });
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

/** Docs for the site: cut from the repo's markdown and this CLI's own command definitions. */
const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const docsProvider = () => buildDocs(REPO_ROOT, {
  commands: describeCli(program),
  globals: program.options.map((o) => ({ flags: o.flags, description: o.description ?? '', ...(o.defaultValue !== undefined && o.long !== '--project' ? { defaultValue: o.defaultValue } : {}) })),
});

program.command('ui')
  .description('Serve the read-only workspace UI on 127.0.0.1')
  .option('--port <n>', 'port', '4173')
  .action(async (o: { port: string }) => {
    const sql = db.connect();
    const { url } = startWebServer(sql, opts().project, Number(o.port), docsProvider);
    console.log(`Recast workspace: ${url}  (read-only; Ctrl-C to stop)`);
  });

program.command('export-site')
  .description('Write the workspace UI with current results as a static, redacted snapshot (for hosting)')
  .option('--out <dir>', 'output directory', 'site')
  .action(async (o: { out: string }) => {
    await withDb(async (sql) => {
      const r = await exportStaticSite(sql, opts().project, resolve(o.out), docsProvider);
      out(`Wrote ${r.files} files to ${o.out} (snapshot ${r.generatedAt}).`, r);
    });
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
