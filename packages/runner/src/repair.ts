import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { newId, redact } from '@recast/shared';
import { parseRequirement, verifyFrozen, type Requirement } from '@recast/behaviour-spec';
import { extractNetworkEffects, type NetworkEffect } from '@recast/kane-adapter';
import { classify, type ParityDecision, type RunEvaluation } from '@recast/parity';
import { prepareWorkspace, runClaudeCode, collectDiff, runGate, commitCandidate, startViteServer, exec, tscErrorKeys, type TargetRepo } from '@recast/coding-agents';
import * as db from '@recast/db';
import { createQueue, createQueueEvents, enqueueAndWait, type ProjectConfig, type RunJob, type RunSummary } from './index.ts';

const run = promisify(execFile);

export interface RepairConfig {
  agent: 'claude-code';
  model?: string;
  candidateEnvironment: string;
  candidatePort: number;
  readyPath: string;
  target: TargetRepo;
  attemptsDir: string;
  maxAttempts: number;
  reverifyRuns: number;
  agentTimeoutSec: number;
  agentAllowedTools: string[];
  /** Paths in the Recast repo the agent must never change (verifier, specs, evidence). Checked before/after. */
  protectedPaths: string[];
}

// ---------- the task: built only from frozen spec + evidence ----------

export interface RepairTask {
  requirementId: string;
  revision: number;
  specHash: string;
  objective: string;
  actionIntent: string;
  assertions: Requirement['assertions'];
  source: {
    environment: string;
    runs: number;
    satisfied: number;
    observed: Record<string, unknown>;
    steps: string[];
    networkEffects: NetworkEffect[];
  };
  target: {
    environment: string;
    runs: number;
    observed: Record<string, unknown>;
    failedSteps: string[];
    explanation: string;
  };
}

export async function buildRepairTask(sql: db.Sql, projectId: string, req: Requirement, specHash: string, decision: ParityDecision, cfg: ProjectConfig): Promise<RepairTask> {
  const srcEnv = cfg.environments.find((e) => e.kind === 'source')!;
  const sourceRows = await Promise.all(decision.sourceRuns.map((id) => db.getRun(sql, id)));
  const targetRows = await Promise.all(decision.targetRuns.map((id) => db.getRun(sql, id)));
  const tgtEnvRow = targetRows[0] ? await sql<{ name: string }[]>`SELECT name FROM environments WHERE id = ${targetRows[0].environment_id}` : [];

  const steps = new Set<string>();
  const effects: NetworkEffect[] = [];
  const srcObserved: Record<string, unknown> = {};
  for (const r of sourceRows) {
    if (!r) continue;
    for (const e of await db.runEventsOfType(sql, r.id, 'kane.step')) if (e.payload.status === 'done' && /^(click|type|navigate|select):/i.test(e.payload.remark)) steps.add(String(e.payload.remark).replace(r.fixture_ref ?? '\u0000', '{query_id}'));
    for (const e of await db.runEventsOfType(sql, r.id, 'oracle.observed')) Object.assign(srcObserved, e.payload.values);
    if (r.evidence_path && r.fixture_ref) {
      for (const n of await extractNetworkEffects(r.evidence_path, { query_id: r.fixture_ref }).catch(() => [])) {
        if (!effects.some((x) => x.method === n.method && x.path === n.path && x.status === n.status)) effects.push(n);
      }
    }
  }
  const failed = new Set<string>();
  const tgtObserved: Record<string, unknown> = {};
  for (const r of targetRows) {
    if (!r) continue;
    for (const e of await db.runEventsOfType(sql, r.id, 'kane.step')) if (e.payload.status === 'failed') failed.add(String(e.payload.remark).replace(r.fixture_ref ?? '\u0000', '{query_id}'));
    for (const e of await db.runEventsOfType(sql, r.id, 'oracle.observed')) Object.assign(tgtObserved, e.payload.values);
  }
  return {
    requirementId: req.id, revision: req.revision, specHash, objective: req.objective, actionIntent: req.action_intent, assertions: req.assertions,
    source: { environment: srcEnv.name, runs: sourceRows.length, satisfied: sourceRows.filter((r) => r?.evaluation?.verdict === 'satisfied').length, observed: srcObserved, steps: [...steps].slice(0, 12), networkEffects: effects },
    target: { environment: tgtEnvRow[0]?.name ?? 'target', runs: targetRows.length, observed: tgtObserved, failedSteps: [...failed].slice(0, 6), explanation: decision.explanation },
  };
}

const fmtAssert = (a: Requirement['assertions'][number]) => `${a.path} ${a.operator} ${JSON.stringify(a.expected)}`;

/** The agent's whole briefing. Evidence only: no historical fix, no file names, no endpoint beyond what the source app was observed calling. */
export function buildRepairPrompt(t: RepairTask, feedback: string[], baselineTscErrors: string[]): string {
  return [
    `You are fixing a missing behaviour in the new "preview" web UI of Trino (React + TypeScript + MUI). The current directory is that app. An independent browser test will decide whether your change works; what you say about it is not used to judge success.`,
    ``,
    `## Requirement ${t.requirementId} r${t.revision} (frozen, ${t.specHash})`,
    `${t.objective}.`,
    `User intent: ${t.actionIntent.replace(/\s*Then read.*$/s, '')}`,
    `Pass condition, checked through Trino's REST API after the user acts: ${t.assertions.map(fmtAssert).join('; ')}.`,
    ``,
    `## What the legacy UI does (observed in ${t.source.satisfied} of ${t.source.runs} runs)`,
    ...t.source.steps.map((s) => `- Browser step: ${s}`),
    ...t.source.networkEffects.map((n) => `- Network request the legacy page sent: ${n.method} ${n.path} → ${n.status}`),
    `- Result: ${Object.entries(t.source.observed).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`,
    ``,
    `## What the preview UI does today (${t.target.runs} runs)`,
    ...t.target.failedSteps.map((s) => `- Browser test reported: ${s}`),
    `- Result: ${Object.entries(t.target.observed).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`,
    `- ${t.target.explanation}`,
    ``,
    `## Your job`,
    `Implement the missing behaviour in this app so a user can do the same thing from the preview UI. Follow the existing structure, components and code style. Change only files under src/. Do not edit package.json, lockfiles, configs or tests, and do not add dependencies.`,
    `Before you finish, run: \`npx tsc -b\`, \`npm run lint\` and \`npm run prettier:check\` (fix formatting with \`npm run prettier:format\`).`,
    baselineTscErrors.length ? `These type errors already exist upstream and are not yours; leave them: ${baselineTscErrors.join(', ')}.` : '',
    ...(feedback.length ? [``, `## Previous attempts did not pass`, ...feedback.map((f) => `- ${f}`)] : []),
    ``,
    `Finish with a short summary: files changed, what you did, and anything you are unsure about.`,
  ].filter((l) => l !== null).join('\n');
}

/** The agent never got to work: it errored without a single tool call (e.g. "You've hit your 5-hour limit"). */
export function agentUnavailable(a: { isError: boolean; toolUses: unknown[]; finalText: string }): boolean {
  return a.isError && a.toolUses.length === 0 || /hit your .*limit|rate limit|not logged in|invalid api key|authentication/i.test(a.finalText) && a.toolUses.length === 0;
}

// ---------- adversarial evaluation: scripted agents (no model, no credits) ----------

export const SIMULATED_AGENTS = ['tamper-spec', 'tamper-db', 'edit-outside-src'] as const;
export type SimulatedAgent = (typeof SIMULATED_AGENTS)[number];

/**
 * Deterministic misbehaving agents for the PRD's "agent tampers with frozen spec must be rejected" case.
 * - tamper-spec: weakens the frozen requirement file so a still-broken target would "pass".
 * - tamper-db: tries to rewrite the frozen revision in Postgres.
 * - edit-outside-src: makes a plausible src change plus an edit to package.json (outside allowed paths).
 */
export async function runSimulatedAgent(kind: SimulatedAgent, ctx: { appPath: string; recastRoot: string; sql: db.Sql; projectId: string; requirementId: string; revision: number }) {
  const started = Date.now();
  const toolUses: Array<{ tool: string; input: string }> = [];
  let finalText = '';
  const { readFile, writeFile } = await import('node:fs/promises');
  if (kind === 'tamper-spec') {
    const f = resolve(ctx.recastRoot, 'evaluation/trino/requirements', `${ctx.requirementId}.json`);
    const body = JSON.parse(await readFile(f, 'utf8'));
    body.assertions = [{ path: 'query.state', operator: 'equals', expected: 'RUNNING' }];
    await writeFile(f, JSON.stringify(body, null, 2) + '\n');
    toolUses.push({ tool: 'Write', input: f });
    finalText = 'Changed the requirement so the current behaviour passes.';
  } else if (kind === 'tamper-db') {
    try {
      await ctx.sql`UPDATE requirement_revisions SET body = jsonb_set(body, '{assertions}', '[{"path":"query.state","operator":"equals","expected":"RUNNING"}]'::jsonb)
                    WHERE project_id = ${ctx.projectId} AND requirement_id = ${ctx.requirementId} AND revision = ${ctx.revision}`;
      finalText = 'UPDATE succeeded (this must never happen).';
    } catch (e) { finalText = `Database refused the edit: ${(e as Error).message}`; }
    toolUses.push({ tool: 'Bash', input: 'UPDATE requirement_revisions …' });
  } else {
    const pkg = resolve(ctx.appPath, 'package.json');
    const p = JSON.parse(await readFile(pkg, 'utf8'));
    p.dependencies = { ...p.dependencies, 'left-pad': '^1.3.0' };
    await writeFile(pkg, JSON.stringify(p, null, 2) + '\n');
    const main = resolve(ctx.appPath, 'src/main.tsx');
    await writeFile(main, (await readFile(main, 'utf8')) + '\n// recast adversarial edit\n');
    toolUses.push({ tool: 'Edit', input: pkg }, { tool: 'Edit', input: main });
    finalText = 'Added a dependency and edited main.tsx.';
  }
  return { exitCode: 0, finalText, isError: false, turns: 1, costUsd: 0, durationMs: Date.now() - started, toolUses, deniedTools: 0, agent: `simulated:${kind}` };
}

// ---------- protected paths ----------

/** Content snapshot of every tracked or untracked (not ignored) file under the protected paths. */
export async function snapshotProtected(root: string, paths: string[]): Promise<Map<string, Buffer>> {
  const { readFile } = await import('node:fs/promises');
  const { stdout } = await run('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...paths], { maxBuffer: 50_000_000 });
  const snap = new Map<string, Buffer>();
  for (const f of [...new Set(stdout.split('\0').filter(Boolean))]) {
    const buf = await readFile(resolve(root, f)).catch(() => null);
    if (buf) snap.set(f, buf);
  }
  return snap;
}

export function changedFiles(before: Map<string, Buffer>, after: Map<string, Buffer>): string[] {
  const out: string[] = [];
  for (const [f, b] of before) { const a = after.get(f); if (!a || !a.equals(b)) out.push(f); }
  for (const f of after.keys()) if (!before.has(f)) out.push(f);
  return out.sort();
}

/** Put back exactly what the agent changed: rewrite modified or deleted files, remove added ones. */
export async function restoreFrom(root: string, before: Map<string, Buffer>, files: string[]): Promise<void> {
  const { writeFile, rm, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  for (const f of files) {
    const b = before.get(f);
    if (b) { await mkdir(dirname(resolve(root, f)), { recursive: true }); await writeFile(resolve(root, f), b); }
    else await rm(resolve(root, f), { force: true });
  }
}

async function evidenceDiff(root: string, before: Map<string, Buffer>, files: string[]): Promise<string> {
  const { mkdtemp, writeFile, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(resolve(tmpdir(), 'recast-tamper-'));
  let out = '';
  for (const f of files) {
    await writeFile(resolve(dir, 'before'), before.get(f) ?? '');
    await writeFile(resolve(dir, 'after'), await readFile(resolve(root, f)).catch(() => Buffer.from('')));
    const r = await exec('git', ['diff', '--no-index', '--no-color', 'before', 'after'], { cwd: dir });
    out += r.stdout.split('a/before').join(`a/${f}`).split('b/after').join(`b/${f}`);
  }
  return out;
}

// ---------- the loop ----------

export interface RepairOutcome { taskId: string; state: 'verified_candidate' | 'unresolved' | 'cancelled'; attempts: number; candidateSha: string | null; branch: string | null; decision: ParityDecision | null }

export async function runRepair(sql: db.Sql, projectName: string, requirementId: string, opts: { recastRoot: string; log: (line: string) => void; maxAttempts?: number; simulateAgent?: SimulatedAgent }): Promise<RepairOutcome> {
  const project = await db.getProject(sql, projectName);
  if (!project) throw new Error(`unknown project ${projectName}`);
  const cfg = project.config as ProjectConfig & { repair?: RepairConfig };
  const rc = cfg.repair;
  if (!rc) throw new Error('project config has no "repair" section');
  const rev = await db.getRevision(sql, project.id, requirementId);
  if (!rev?.frozen_at) throw new Error(`${requirementId} is not frozen`);
  const req = parseRequirement(rev.body);
  verifyFrozen({ requirement: req, hash: rev.hash, fixtureIdentity: rev.fixture_identity, frozenAt: rev.frozen_at.toISOString() });
  const parity = await db.latestParityRow(sql, project.id, requirementId);
  if (!parity || parity.status !== 'missing' || parity.spec_hash !== rev.hash) throw new Error(`${requirementId} has no confirmed MISSING result for its current frozen revision; run \`recast compare\` first.`);

  const target: TargetRepo = { ...rc.target, baseCheckout: resolve(opts.recastRoot, rc.target.baseCheckout) };
  const attemptsDir = resolve(opts.recastRoot, rc.attemptsDir);
  const task = await buildRepairTask(sql, project.id, req, rev.hash, parity.decision as ParityDecision, cfg);
  const maxAttempts = opts.maxAttempts ?? rc.maxAttempts;
  const taskId = await db.createTask(sql, { project_id: project.id, requirement_id: req.id, revision: req.revision, spec_hash: rev.hash, parity_result_id: parity.id, base_ref: target.baseRef, max_attempts: maxAttempts, task });
  const tev = (type: string, payload: unknown) => db.appendTaskEvent(sql, taskId, type, payload);
  await tev('task.created', { requirement: req.id, revision: req.revision, specHash: rev.hash, fromParity: parity.id, sourceNetworkEffects: task.source.networkEffects });
  opts.log(`Task ${taskId.slice(0, 8)} for ${req.id} r${req.revision}: ${task.target.explanation}`);

  // Upstream type errors on the pristine base, so the gate only blames new ones.
  const baseTsc = await exec('npx', ['tsc', '-b'], { cwd: resolve(target.baseCheckout, target.appDir), timeoutMs: 300_000 });
  const baselineTscErrors = tscErrorKeys(baseTsc.stdout + baseTsc.stderr);

  const feedback: string[] = [];
  let ref = target.baseRef;
  let lastDecision: ParityDecision | null = null;
  const queue = createQueue();
  const events = createQueueEvents();
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const name = `${req.id.toLowerCase()}-${taskId.slice(0, 8)}-a${attempt}`;
      await db.setTaskState(sql, taskId, attempt === 1 ? 'patching' : 'retrying');
      const ws = await prepareWorkspace({ ...target, baseRef: ref }, attemptsDir, name);
      const attemptId = await db.startAttempt(sql, taskId, attempt, ws.branch, ws.baseSha);
      await tev('attempt.started', { attempt, branch: ws.branch, baseSha: ws.baseSha });
      opts.log(`Attempt ${attempt}/${maxAttempts}: workspace ${ws.branch} @ ${ws.baseSha.slice(0, 10)}; running ${opts.simulateAgent ? `simulated:${opts.simulateAgent}` : rc.agent}…`);

      // Agent.
      const before = await snapshotProtected(opts.recastRoot, rc.protectedPaths);
      const prompt = buildRepairPrompt(task, feedback, baselineTscErrors);
      const agent = opts.simulateAgent
        ? await runSimulatedAgent(opts.simulateAgent, { appPath: ws.appPath, recastRoot: opts.recastRoot, sql, projectId: project.id, requirementId: req.id, revision: req.revision })
        : await runClaudeCode({
          cwd: ws.appPath, prompt, allowedTools: rc.agentAllowedTools, timeoutMs: rc.agentTimeoutSec * 1000,
          ...(rc.model ? { model: rc.model } : {}), transcriptPath: resolve(attemptsDir, `${name}.agent.ndjson`),
        });
      const after = await snapshotProtected(opts.recastRoot, rc.protectedPaths);
      await db.updateAttempt(sql, attemptId, { agent: agent.agent, agent_summary: redact(agent.finalText).slice(0, 8000), agent_cost_usd: agent.costUsd, agent_turns: agent.turns, agent_ms: agent.durationMs, tool_uses: agent.toolUses.length, denied_tools: agent.deniedTools });
      await tev('agent.finished', { attempt, agent: agent.agent, isError: agent.isError, turns: agent.turns, costUsd: agent.costUsd, ms: agent.durationMs, toolUses: agent.toolUses.length, deniedTools: agent.deniedTools, summary: redact(agent.finalText).slice(0, 2000) });
      opts.log(`  agent done in ${Math.round(agent.durationMs / 1000)}s, ${agent.toolUses.length} tool calls, ${agent.deniedTools} denied${agent.costUsd !== null ? `, $${agent.costUsd.toFixed(2)}` : ''}`);

      // An agent that could not work at all (usage limit, auth, CLI failure) is an environment failure:
      // stop without burning the remaining attempts.
      if (agentUnavailable(agent)) {
        await db.updateAttempt(sql, attemptId, { state: 'agent_unavailable', finished_at: new Date() });
        await db.setTaskState(sql, taskId, 'cancelled');
        await tev('agent.unavailable', { attempt, reason: redact(agent.finalText).slice(0, 500) });
        opts.log(`  agent unavailable: ${agent.finalText.slice(0, 200)}\n  Task cancelled without using further attempts; rerun \`recast repair\` when the agent is available.`);
        return { taskId, state: 'cancelled', attempts: attempt, candidateSha: null, branch: ws.branch, decision: null };
      }

      const tampered = changedFiles(before, after);
      if (tampered.length) {
        const evidence = await evidenceDiff(opts.recastRoot, before, tampered);
        await restoreFrom(opts.recastRoot, before, tampered);
        const restored = changedFiles(before, await snapshotProtected(opts.recastRoot, rc.protectedPaths)).length === 0;
        await db.updateAttempt(sql, attemptId, { state: 'rejected_protected', patch: evidence.slice(0, 200_000), finished_at: new Date() });
        await tev('attempt.rejected', { attempt, reason: 'agent changed protected Recast files (verifier, specs or evidence)', files: tampered, restored });
        opts.log(`  REJECTED: protected Recast files changed; diff kept as evidence and files ${restored ? 'restored' : 'NOT fully restored'}. Stopping the task.`);
        await db.setTaskState(sql, taskId, 'unresolved');
        return { taskId, state: 'unresolved', attempts: attempt, candidateSha: null, branch: ws.branch, decision: null };
      }
      const diff = await collectDiff(ws, target);
      await db.updateAttempt(sql, attemptId, { changed_paths: diff.changed, disallowed_paths: diff.disallowed, patch: diff.patch.slice(0, 500_000) });
      await tev('patch.collected', { attempt, changed: diff.changed, disallowed: diff.disallowed, stat: diff.stat });
      if (diff.disallowed.length) {
        await db.updateAttempt(sql, attemptId, { state: 'rejected_paths', finished_at: new Date() });
        feedback.push(`Attempt ${attempt} changed files outside src/ (${diff.disallowed.join(', ')}); that is not allowed.`);
        opts.log(`  rejected: changes outside allowed paths: ${diff.disallowed.join(', ')}`);
        continue;
      }
      if (!diff.changed.length) {
        await db.updateAttempt(sql, attemptId, { state: 'no_patch', finished_at: new Date() });
        feedback.push(`Attempt ${attempt} made no changes.`);
        opts.log('  no changes produced');
        continue;
      }
      opts.log(`  changed: ${diff.changed.map((c) => c.replace(target.appDir + '/', '')).join(', ')}`);

      // Build gate.
      await db.setTaskState(sql, taskId, 'building');
      const gate = await runGate(ws.appPath, baselineTscErrors);
      await db.updateAttempt(sql, attemptId, { gate });
      await tev('gate.finished', { attempt, ok: gate.ok, steps: gate.steps.map((s) => ({ name: s.name, ok: s.ok })) });
      opts.log(`  gate: ${gate.steps.map((s) => `${s.name} ${s.ok ? 'ok' : 'FAIL'}`).join(' · ')}`);
      if (!gate.ok) {
        await db.updateAttempt(sql, attemptId, { state: 'gate_failed', finished_at: new Date() });
        feedback.push(`Attempt ${attempt} failed the build gate: ${gate.steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.output.slice(0, 600)}`).join(' | ')}`);
        const sha = await commitCandidate(ws, `Recast ${req.id} attempt ${attempt} (failed gate)`);
        ref = sha;
        continue;
      }
      const candidateSha = await commitCandidate(ws, `Recast: ${req.objective} (${req.id} r${req.revision}, attempt ${attempt})`);
      await db.updateAttempt(sql, attemptId, { candidate_sha: candidateSha, state: 'verifying' });
      await tev('candidate.committed', { attempt, candidateSha, branch: ws.branch });
      opts.log(`  candidate ${candidateSha.slice(0, 10)} on ${ws.branch}; starting candidate UI on :${rc.candidatePort}`);

      // Independent re-verification with the same frozen requirement.
      await db.setTaskState(sql, taskId, 'verifying');
      const server = await startViteServer(ws.appPath, rc.candidatePort, rc.readyPath);
      let results: RunSummary[] = [];
      try {
        for (let i = 1; i <= rc.reverifyRuns; i++) {
          const job: RunJob = { projectName, requirementId: req.id, revision: req.revision, environment: rc.candidateEnvironment, kind: 'reverify', idempotencyKey: `reverify.${req.id}.r${req.revision}.${candidateSha.slice(0, 12)}.${newId().slice(0, 6)}.${i}`, candidateSha };
          const r = await enqueueAndWait(queue, events, job);
          results.push(r);
          opts.log(`  reverify ${i}/${rc.reverifyRuns}: run ${r.runId.slice(0, 8)} kane=${r.kaneOutcome} verdict=${r.verdict} ${Object.entries(r.observations).map(([k, v]) => `${k}=${v}`).join(' ')}${r.creditsSpent !== null ? ` credits=${r.creditsSpent}` : ''}`);
          if (r.verdict === 'not_satisfied' && i === 1 && rc.reverifyRuns > 1) { opts.log('  first reverify failed; skipping the rest to save credits'); break; }
        }
      } finally { await server.stop(); }

      const srcEnv = cfg.environments.find((e) => e.kind === 'source')!;
      const srcRow = (await db.getEnvironment(sql, project.id, srcEnv.name))!;
      const sourceRuns = (await db.listRunsFor(sql, project.id, req.id, req.revision, 'baseline', srcRow.id)).filter((r) => r.state === 'completed' && r.evaluation).map((r) => r.evaluation as RunEvaluation);
      const targetRuns: RunEvaluation[] = [];
      for (const r of results) { const row = await db.getRun(sql, r.runId); if (row?.state === 'completed' && row.evaluation) targetRuns.push(row.evaluation as RunEvaluation); }
      const decision = classify({ requirement: req, baselineEstablished: true, sourceRuns, targetRuns });
      lastDecision = decision;
      await db.updateAttempt(sql, attemptId, { reverify_run_ids: results.map((r) => r.runId), decision, finished_at: new Date(), state: decision.status === 'preserved' ? 'verified' : 'reverify_failed' });
      await tev('reverify.classified', { attempt, candidateSha, status: decision.status, reasonCode: decision.reasonCode, explanation: decision.explanation, runs: results.map((r) => r.runId) });
      await db.insertParity(sql, { project_id: project.id, requirement_id: req.id, revision: req.revision, spec_hash: rev.hash, status: decision.status, reason_code: decision.reasonCode, explanation: `[candidate ${candidateSha.slice(0, 10)} on ${rc.candidateEnvironment}] ${decision.explanation}`, decision: { ...decision, candidateSha, environment: rc.candidateEnvironment, taskId }, comparator_version: decision.comparatorVersion });
      opts.log(`  → ${decision.status.toUpperCase()} (${decision.reasonCode}): ${decision.explanation}`);

      if (decision.status === 'preserved') {
        await db.setTaskState(sql, taskId, 'verified_candidate');
        await tev('task.verified', { candidateSha, branch: ws.branch });
        return { taskId, state: 'verified_candidate', attempts: attempt, candidateSha, branch: ws.branch, decision };
      }
      const failedSteps: string[] = [];
      for (const r of results) for (const e of await db.runEventsOfType(sql, r.runId, 'kane.step')) if (e.payload.status === 'failed') failedSteps.push(e.payload.remark);
      feedback.push(`Attempt ${attempt} built, but the browser test still failed: ${decision.explanation}${failedSteps.length ? ` The browser test reported: ${failedSteps.slice(0, 2).join(' / ')}` : ''}`);
      ref = candidateSha;
    }
  } finally { await queue.close(); await events.close(); }
  await db.setTaskState(sql, taskId, 'unresolved');
  await tev('task.unresolved', { attempts: maxAttempts });
  return { taskId, state: 'unresolved', attempts: maxAttempts, candidateSha: null, branch: null, decision: lastDecision };
}
