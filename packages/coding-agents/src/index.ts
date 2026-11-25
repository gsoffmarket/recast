import { spawn } from 'node:child_process';
import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Coding-agent adapter. The agent works in an isolated git worktree of the TARGET app only.
 * Nothing it says is trusted: Recast checks the diff, the allowed paths, the build gate and then
 * re-runs the frozen requirement with Kane and the oracle.
 */

// ---------- process helper ----------

export interface Exec { code: number | null; stdout: string; stderr: string }

export function exec(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string } ): Promise<Exec> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: [opts.input ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: true });
    let stdout = ''; let stderr = '';
    const t = opts.timeoutMs ? setTimeout(() => { try { if (c.pid) process.kill(-c.pid, 'SIGTERM'); } catch { /* gone */ } }, opts.timeoutMs) : null;
    c.stdout!.on('data', (d) => { stdout += d; if (stdout.length > 4_000_000) stdout = stdout.slice(-2_000_000); });
    c.stderr!.on('data', (d) => { stderr = (stderr + d).slice(-200_000); });
    if (opts.input) { c.stdin!.end(opts.input); }
    c.on('error', (e) => { if (t) clearTimeout(t); reject(e); });
    c.on('close', (code) => { if (t) clearTimeout(t); resolve({ code, stdout, stderr }); });
  });
}

const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd, timeoutMs: 120_000 });

// ---------- workspace ----------

export interface TargetRepo {
  /** Pristine checkout pinned to the target's base ref (e.g. tag 481), with dependencies installed. */
  baseCheckout: string;
  /** App directory inside the repo, e.g. core/trino-web-ui/src/main/resources/webapp-preview */
  appDir: string;
  /** Paths (relative to repo root) the agent may change. */
  allowedPrefixes: string[];
  baseRef: string;
}

export interface Workspace { root: string; appPath: string; branch: string; baseSha: string }

/** Create a fresh sparse worktree on its own branch, with a copy-on-write copy of node_modules. */
export async function prepareWorkspace(repo: TargetRepo, attemptsDir: string, name: string): Promise<Workspace> {
  const root = join(attemptsDir, name);
  const branch = `recast/${name}`;
  await rm(root, { recursive: true, force: true });
  await git(repo.baseCheckout, 'worktree', 'prune');
  await git(repo.baseCheckout, 'branch', '-D', branch).catch(() => null);
  await mkdir(attemptsDir, { recursive: true });
  const add = await git(repo.baseCheckout, 'worktree', 'add', '--no-checkout', '-b', branch, root, repo.baseRef);
  if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr}`);
  const sp = await git(root, 'sparse-checkout', 'set', repo.appDir);
  if (sp.code !== 0) throw new Error(`sparse-checkout failed: ${sp.stderr}`);
  const co = await git(root, 'checkout', branch);
  if (co.code !== 0) throw new Error(`checkout failed: ${co.stderr}`);
  const appPath = join(root, repo.appDir);
  // APFS clone (-c) makes this near-instant; the agent's server gets its own Vite cache.
  await cp(join(repo.baseCheckout, repo.appDir, 'node_modules'), join(appPath, 'node_modules'), { recursive: true, verbatimSymlinks: true }).catch(async () => {
    const r = await exec('cp', ['-cR', join(repo.baseCheckout, repo.appDir, 'node_modules'), join(appPath, 'node_modules')], { cwd: root });
    if (r.code !== 0) throw new Error(`copy node_modules failed: ${r.stderr}`);
  });
  const sha = (await git(root, 'rev-parse', 'HEAD')).stdout.trim();
  return { root, appPath, branch, baseSha: sha };
}

// ---------- diff guard ----------

export interface DiffReport { changed: string[]; disallowed: string[]; patch: string; stat: string }

/** Everything the agent changed, tracked or not (node_modules excluded by the app's .gitignore). */
export async function collectDiff(ws: Workspace, repo: TargetRepo): Promise<DiffReport> {
  await git(ws.root, 'add', '-A', '--', repo.appDir);
  const names = (await git(ws.root, 'diff', '--cached', '--name-only', ws.baseSha)).stdout.split('\n').filter(Boolean);
  const patch = (await git(ws.root, 'diff', '--cached', ws.baseSha)).stdout;
  const statOut = (await git(ws.root, 'diff', '--cached', '--stat', ws.baseSha)).stdout;
  const disallowed = names.filter((n) => !repo.allowedPrefixes.some((p) => n.startsWith(p)));
  return { changed: names, disallowed, patch, stat: statOut };
}

export async function commitCandidate(ws: Workspace, message: string): Promise<string> {
  const c = await exec('git', ['-c', 'user.name=Recast', '-c', 'user.email=recast@localhost', 'commit', '-q', '--no-verify', '-m', message], { cwd: ws.root });
  if (c.code !== 0) throw new Error(`commit failed: ${c.stderr || c.stdout}`);
  return (await git(ws.root, 'rev-parse', 'HEAD')).stdout.trim();
}

// ---------- quality gate ----------

export interface GateStep { name: string; ok: boolean; output: string }
export interface GateResult { ok: boolean; steps: GateStep[] }

/** tsc errors as stable "file(line,col): TSxxxx" keys, so a pre-existing upstream error is not blamed on the agent. */
export function tscErrorKeys(output: string): string[] {
  return [...output.matchAll(/^(\S+?)\(\d+,\d+\): error (TS\d+)/gm)].map((m) => `${m[1]}:${m[2]}`).sort();
}

export async function runGate(appPath: string, baselineTscErrors: string[], env?: NodeJS.ProcessEnv): Promise<GateResult> {
  const steps: GateStep[] = [];
  const tsc = await exec('npx', ['tsc', '-b'], { cwd: appPath, timeoutMs: 300_000, ...(env ? { env } : {}) });
  const tscOut = tsc.stdout + tsc.stderr;
  const fresh = tscErrorKeys(tscOut).filter((k) => !baselineTscErrors.includes(k));
  steps.push({ name: 'typecheck (no new errors)', ok: fresh.length === 0, output: fresh.length ? tscOut.slice(-4000) : `ok (${baselineTscErrors.length} pre-existing upstream error(s) ignored)` });
  const lint = await exec('npm', ['run', 'lint', '--silent'], { cwd: appPath, timeoutMs: 300_000, ...(env ? { env } : {}) });
  steps.push({ name: 'lint', ok: lint.code === 0, output: (lint.stdout + lint.stderr).slice(-4000) || 'ok' });
  const fmt = await exec('npm', ['run', 'prettier:check', '--silent'], { cwd: appPath, timeoutMs: 120_000, ...(env ? { env } : {}) });
  steps.push({ name: 'format', ok: fmt.code === 0, output: (fmt.stdout + fmt.stderr).slice(-2000) || 'ok' });
  return { ok: steps.every((s) => s.ok), steps };
}

// ---------- Claude Code driver ----------

export interface AgentRunOptions {
  cwd: string;
  prompt: string;
  allowedTools: string[];
  timeoutMs: number;
  model?: string;
  maxBudgetUsd?: number;
  claudeBin?: string;
  env?: NodeJS.ProcessEnv;
  transcriptPath?: string;
}

export interface AgentRunResult {
  exitCode: number | null;
  finalText: string;
  isError: boolean;
  turns: number | null;
  costUsd: number | null;
  durationMs: number;
  toolUses: Array<{ tool: string; input: string }>;
  deniedTools: number;
  agent: string;
}

/**
 * Headless Claude Code: explicit tool allowlist, everything else denied (dontAsk), no MCP servers,
 * no web tools, no subagents, no session saved. The working directory is the app folder of the worktree.
 */
export async function runClaudeCode(o: AgentRunOptions): Promise<AgentRunResult> {
  const args = [
    '-p', o.prompt,
    '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'dontAsk',
    '--allowedTools', o.allowedTools.join(','),
    '--disallowedTools', 'WebFetch,WebSearch,Agent,Task,NotebookEdit',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--no-session-persistence',
    ...(o.model ? ['--model', o.model] : []),
    ...(o.maxBudgetUsd ? ['--max-budget-usd', String(o.maxBudgetUsd)] : []),
  ];
  const started = Date.now();
  const r = await exec(o.claudeBin ?? process.env.CLAUDE_BIN ?? 'claude', args, { cwd: o.cwd, timeoutMs: o.timeoutMs, ...(o.env ? { env: o.env } : {}) });
  if (o.transcriptPath) await writeFile(o.transcriptPath, r.stdout).catch(() => {});
  const toolUses: AgentRunResult['toolUses'] = [];
  let finalText = ''; let isError = r.code !== 0; let turns: number | null = null; let costUsd: number | null = null; let deniedTools = 0;
  let version = 'claude-code';
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    let m: any; try { m = JSON.parse(line); } catch { continue; }
    if (m.type === 'system' && m.subtype === 'init' && m.claude_code_version) version = `claude-code ${m.claude_code_version}${m.model ? ` (${m.model})` : ''}`;
    if (m.type === 'assistant') for (const c of m.message?.content ?? []) if (c.type === 'tool_use') toolUses.push({ tool: c.name, input: JSON.stringify(c.input).slice(0, 300) });
    if (m.type === 'user') for (const c of m.message?.content ?? []) if (c.type === 'tool_result' && c.is_error && /permission|denied|not allowed/i.test(JSON.stringify(c.content))) deniedTools++;
    if (m.type === 'result') { finalText = String(m.result ?? ''); isError = !!m.is_error || m.subtype !== 'success'; turns = m.num_turns ?? null; costUsd = m.total_cost_usd ?? null; }
  }
  if (!finalText && r.stderr) finalText = r.stderr.slice(-2000);
  return { exitCode: r.code, finalText, isError, turns, costUsd, durationMs: Date.now() - started, toolUses, deniedTools, agent: version };
}

// ---------- dev server for the candidate ----------

export interface DevServer { url: string; stop: () => Promise<void> }

/** Start `vite` for the candidate worktree on a fixed port and wait until it serves the app. */
export async function startViteServer(appPath: string, port: number, readyPath: string, env?: NodeJS.ProcessEnv): Promise<DevServer> {
  await stat(join(appPath, 'node_modules')).catch(() => { throw new Error('candidate workspace has no node_modules'); });
  const c = spawn('npx', ['vite', '--port', String(port), '--strictPort'], { cwd: appPath, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  c.stdout.on('data', (d) => { log = (log + d).slice(-4000); });
  c.stderr.on('data', (d) => { log = (log + d).slice(-4000); });
  const url = `http://localhost:${port}`;
  const stop = async () => { try { if (c.pid) process.kill(-c.pid, 'SIGTERM'); } catch { /* gone */ } };
  for (let i = 0; i < 60; i++) {
    if (c.exitCode !== null) throw new Error(`vite exited: ${log}`);
    const ok = await fetch(url + readyPath).then((r) => r.ok).catch(() => false);
    if (ok) return { url, stop };
    await new Promise((r) => setTimeout(r, 500));
  }
  await stop();
  throw new Error(`vite did not become ready on ${port}: ${log}`);
}
