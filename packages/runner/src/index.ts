import { Queue, Worker, QueueEvents, type Job } from 'bullmq';
import { nowIso, redact } from '@recast/shared';
import { compileObjective, parseRequirement, requirementHash, verifyFrozen, type NavigationBinding, type Requirement } from '@recast/behaviour-spec';
import { runKane, kaneBalance, locateEvidencePacks, inspectEvidencePack, type KaneEvent } from '@recast/kane-adapter';
import { TrinoOracle, TrinoRunningQueryFixture, trinoFingerprint, kaneFinalStateObservations } from '@recast/observations';
import { evaluateRun } from '@recast/parity';
import * as db from '@recast/db';

// ---------- project config ----------

export interface EnvironmentConfig {
  name: string;
  kind: 'source' | 'target' | 'candidate';
  baseUrl: string;
  /** Where the app's API and oracle live, when the UI is served elsewhere (e.g. a candidate dev server). */
  apiBaseUrl?: string;
  startPath: string;
  /** Navigation hints for this UI. Never names the control the requirement is about. */
  hints: string[];
}

export interface ProjectConfig {
  name: string;
  environments: EnvironmentConfig[];
  fixture: { type: 'trino-running-query'; baseUrl: string; user: string };
  role: { username: string };
  kane: { maxSteps: number; timeoutSec: number };
  budget: { minBalance: number };
}

export function navFor(env: EnvironmentConfig): NavigationBinding {
  return { startUrl: new URL(env.startPath, env.baseUrl).toString(), hints: env.hints };
}

// ---------- one run ----------

export interface RunJob {
  projectName: string;
  requirementId: string;
  revision: number;
  environment: string;
  kind: 'baseline' | 'compare' | 'reverify';
  idempotencyKey: string;
  /** Candidate commit under test (reverify runs). */
  candidateSha?: string;
}

export interface RunSummary {
  runId: string;
  state: string;
  kaneOutcome: string | null;
  verdict: string | null;
  observations: Record<string, unknown>;
  creditsSpent: number | null;
  reused: boolean;
}

export class BudgetError extends Error { override name = 'BudgetError'; }

const KANE_EVENT_CAP = 400;

function slimKaneEvent(e: KaneEvent): { type: string; payload: unknown } | null {
  switch (e.kind) {
    case 'stream_start': return { type: 'kane.stream_start', payload: { cliVersion: e.cliVersion } };
    case 'recording_state': return { type: 'kane.session', payload: { sessionId: e.sessionId } };
    case 'step': return e.status === 'running' ? null : { type: 'kane.step', payload: { step: e.step, status: e.status, remark: e.remark, childId: e.childId ?? null, ts: e.ts ?? null } };
    case 'run_end': {
      const { context: _c, verdict, test_url, ...rest } = e.runEnd as Record<string, any>;
      return { type: 'kane.run_end', payload: { ...rest, test_url: test_url ? redact(String(test_url)) : undefined, verdict: verdict ? { category: verdict.category, family: verdict.family, confidence: verdict.confidence, one_liner: verdict.one_liner } : undefined } };
    }
    case 'unknown': return { type: 'kane.unknown', payload: { type: e.type, keys: Object.keys(e.raw) } };
    case 'malformed': return { type: 'kane.malformed', payload: { error: e.error, line: e.line.slice(0, 300) } };
  }
}

/** Execute one requirement against one environment. Idempotent on idempotencyKey. */
export async function executeRun(sql: db.Sql, job: RunJob, signal?: AbortSignal): Promise<RunSummary> {
  const project = await db.getProject(sql, job.projectName);
  if (!project) throw new Error(`unknown project ${job.projectName}`);
  const cfg = project.config as ProjectConfig;
  const envCfg = cfg.environments.find((e) => e.name === job.environment);
  const envRow = await db.getEnvironment(sql, project.id, job.environment);
  if (!envCfg || !envRow) throw new Error(`unknown environment ${job.environment}`);
  const rev = await db.getRevision(sql, project.id, job.requirementId, job.revision);
  if (!rev) throw new Error(`unknown requirement ${job.requirementId} r${job.revision}`);

  const req: Requirement = parseRequirement(rev.body);
  if (rev.frozen_at) verifyFrozen({ requirement: req, hash: rev.hash, fixtureIdentity: rev.fixture_identity, frozenAt: rev.frozen_at.toISOString() });
  else if (requirementHash(req, rev.fixture_identity) !== rev.hash) throw new Error(`stored hash mismatch for ${req.id} r${req.revision}`);

  const { id: runId, created } = await db.createRun(sql, {
    project_id: project.id, kind: job.kind, environment_id: envRow.id, requirement_id: req.id, revision: req.revision, spec_hash: rev.hash, idempotency_key: job.idempotencyKey,
  });
  const existing = await db.getRun(sql, runId);
  if (!created && existing && ['completed', 'infra_error', 'cancelled'].includes(existing.state)) {
    return { runId, state: existing.state, kaneOutcome: existing.kane_outcome, verdict: existing.evaluation?.verdict ?? null, observations: {}, creditsSpent: null, reused: true };
  }
  const ev = (type: string, payload: unknown) => db.appendEvent(sql, runId, type, payload);
  signal?.addEventListener('abort', () => { void ev('run.abort_requested', { reason: String((signal.reason as Error)?.message ?? signal.reason) }).catch(() => {}); }, { once: true });
  const fixture = new TrinoRunningQueryFixture(cfg.fixture.baseUrl, cfg.fixture.user);
  const oracle = new TrinoOracle(cfg.fixture.baseUrl);
  let queryId: string | null = null;

  try {
    // Preflight: environment fingerprint and budget.
    const fingerprint = await trinoFingerprint(envCfg.apiBaseUrl ?? envCfg.baseUrl);
    const uiReachable = await fetch(new URL(envCfg.startPath, envCfg.baseUrl)).then((r) => r.ok).catch(() => false);
    if (!uiReachable) throw new Error(`environment ${envCfg.name} UI is not reachable at ${envCfg.baseUrl}${envCfg.startPath}`);
    await ev('run.started', { kind: job.kind, environment: envCfg.name, environmentKind: envCfg.kind, requirement: req.id, revision: req.revision, specHash: rev.hash, fingerprint, candidateSha: job.candidateSha ?? null });
    if (job.candidateSha) await db.updateRun(sql, runId, { candidate_sha: job.candidateSha });
    const before = await kaneBalance();
    if (before === null) throw new BudgetError('Kane balance unavailable: run `kane-cli login`.');
    if (before < cfg.budget.minBalance) throw new BudgetError(`Kane balance ${before} is below the floor ${cfg.budget.minBalance}.`);
    await db.updateRun(sql, runId, { state: 'resetting', started_at: new Date(), credits_balance_before: before });

    // Fixture: fresh independent query.
    queryId = await fixture.start(`recast-${job.kind}-${runId.slice(0, 8)}`);
    await db.updateRun(sql, runId, { fixture_ref: queryId });
    await ev('fixture.ready', { fixture: fixture.identity, queryId, state: 'RUNNING' });

    // Execute with Kane.
    const compiled = compileObjective(req, navFor(envCfg), { query_id: queryId, username: cfg.role.username });
    await db.updateRun(sql, runId, { state: 'executing' });
    await ev('kane.invoked', { startUrl: compiled.startUrl, objective: compiled.objective, variables: compiled.variables, maxSteps: cfg.kane.maxSteps });
    let stored = 0;
    const kane = await runKane({
      objective: compiled.objective, url: compiled.startUrl, variables: compiled.variables,
      maxSteps: cfg.kane.maxSteps, timeoutSec: cfg.kane.timeoutSec, ...(signal ? { signal } : {}),
      onEvent: async (e) => { const s = slimKaneEvent(e); if (s && stored++ < KANE_EVENT_CAP) await ev(s.type, s.payload); },
    });

    // Observe independently, then clean up the fixture.
    await db.updateRun(sql, runId, { state: 'observing' });
    const obs = [...await oracle.observe(queryId, req.settle_ms), ...kaneFinalStateObservations(kane.runEnd?.final_state as Record<string, unknown> | undefined)];
    await db.insertObservations(sql, runId, obs);
    await ev('oracle.observed', { adapter: obs.some((o) => o.adapter === 'kane-final-state') ? `${oracle.name}+kane-final-state` : oracle.name, settleMs: req.settle_ms, values: Object.fromEntries(obs.map((o) => [o.path, o.value])) });
    const cleanup = await fixture.cleanup(queryId);
    if (cleanup !== null) await ev('fixture.cleanup', { queryId, restStatus: cleanup, note: 'still running after observation; cancelled via REST' });

    // Evidence pack.
    let evidence: { path: string; sha256: string } | null = null;
    const sessionDir = kane.runEnd?.session_dir;
    if (sessionDir) {
      const packs = await locateEvidencePacks(sessionDir);
      if (packs[0]) {
        try { const p = await inspectEvidencePack(packs[0]); evidence = { path: p.path, sha256: p.sha256 }; await ev('evidence.recorded', { sha256: p.sha256, bytes: p.bytes, entries: p.entries.length }); }
        catch (e) { await ev('evidence.rejected', { error: (e as Error).message }); }
      } else await ev('evidence.unavailable', { sessionDir: redact(sessionDir) });
    }

    const after = await kaneBalance();
    const executionValid = kane.outcome === 'passed' || kane.outcome === 'did_not_pass';
    const evaluation = evaluateRun(runId, req, obs.map((o) => ({ path: o.path, value: o.value, status: o.status })), executionValid);
    const state = kane.outcome === 'cancelled' ? 'cancelled' : kane.outcome === 'did_not_start' ? 'infra_error' : 'completed';
    await db.updateRun(sql, runId, {
      state, finished_at: new Date(), kane_outcome: kane.outcome, kane_exit: kane.exitCode, kane_version: kane.cliVersion ?? null,
      kane_session_id: kane.sessionId ?? null, kane_run_id: kane.runEnd?.run_id ?? null, credits_reported: kane.runEnd?.credits_consumed ?? null,
      credits_balance_after: after, evidence_path: evidence?.path ?? null, evidence_sha256: evidence?.sha256 ?? null, evaluation,
    });
    await ev('run.evaluated', { verdict: evaluation.verdict, assertions: evaluation.assertions, kaneOutcome: kane.outcome, kaneStatus: kane.runEnd?.status ?? null, failedSteps: kane.failedSteps });
    return {
      runId, state, kaneOutcome: kane.outcome, verdict: evaluation.verdict,
      observations: Object.fromEntries(obs.map((o) => [o.path, o.value])),
      creditsSpent: after !== null ? Math.round((before - after) * 100) / 100 : null, reused: false,
    };
  } catch (e) {
    if (queryId) await fixture.cleanup(queryId).catch(() => null);
    const msg = (e as Error).message;
    await db.updateRun(sql, runId, { state: signal?.aborted ? 'cancelled' : 'infra_error', finished_at: new Date(), error: redact(msg) });
    await ev('run.failed', { error: redact(msg), at: nowIso() }).catch(() => {});
    if (e instanceof BudgetError) throw e;
    return { runId, state: 'infra_error', kaneOutcome: null, verdict: null, observations: {}, creditsSpent: null, reused: false };
  }
}

// ---------- queue ----------

export const QUEUE_NAME = 'recast-runs';

function redisConnection() {
  const url = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  return { host: url.hostname, port: Number(url.port || 6379), maxRetriesPerRequest: null };
}

export function createQueue(): Queue<RunJob, RunSummary> {
  return new Queue<RunJob, RunSummary>(QUEUE_NAME, { connection: redisConnection() });
}

export function createQueueEvents(): QueueEvents {
  return new QueueEvents(QUEUE_NAME, { connection: redisConnection() });
}

/** One worker, concurrency 1: one mutating run per fixture namespace. Stalled jobs are re-run idempotently. */
export function startWorker(sql: db.Sql): Worker<RunJob, RunSummary> {
  return new Worker<RunJob, RunSummary>(QUEUE_NAME, async (job: Job<RunJob, RunSummary>) => {
    const ac = new AbortController();
    const timer = setInterval(async () => { if (await job.isActive().catch(() => true) === false) ac.abort(new Error('job no longer active')); }, 5000);
    try { return await executeRun(sql, job.data, ac.signal); } finally { clearInterval(timer); }
  }, { connection: redisConnection(), concurrency: 1, lockDuration: 120_000, stalledInterval: 60_000, maxStalledCount: 1 });
}

/** Enqueue with jobId = idempotency key so a duplicate request never runs twice. */
export async function enqueueAndWait(queue: Queue<RunJob, RunSummary>, events: QueueEvents, job: RunJob): Promise<RunSummary> {
  const j = await queue.add('run', job, { jobId: job.idempotencyKey, removeOnComplete: { age: 86_400 }, removeOnFail: { age: 86_400 }, attempts: 1 });
  return j.waitUntilFinished(events);
}

export * from './repair.ts';
