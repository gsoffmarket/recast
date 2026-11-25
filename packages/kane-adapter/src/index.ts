import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import yauzl from 'yauzl';

/**
 * Kane CLI adapter. Tested against kane-cli 0.10.9 (agent mode NDJSON).
 * Only documented/observed fields are mapped; unknown events are preserved raw.
 */
export const TESTED_KANE_VERSION = '0.10.9';

// ---------- NDJSON events ----------

const RunEndSchema = z.object({
  type: z.literal('run_end'),
  status: z.string(),
  summary: z.string().optional(),
  one_liner: z.string().optional(),
  final_state: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().optional(),
  duration: z.number().optional(),
  credits_consumed: z.number().optional(),
  session_dir: z.string().optional(),
  run_dir: z.string().optional(),
  result_code: z.union([z.number(), z.string()]).optional(),
  reason_code: z.string().optional(),
  run_id: z.string().optional(),
  test_url: z.string().optional(),
  verdict: z.record(z.string(), z.unknown()).optional(),
  ts: z.string().optional(),
}).passthrough();
export type KaneRunEnd = z.infer<typeof RunEndSchema>;

const StreamStartSchema = z.object({ type: z.literal('stream_start'), cli_version: z.string(), ts: z.string().optional() }).passthrough();
const RecordingStateSchema = z.object({ type: z.literal('recording_state'), session_id: z.string(), ts: z.string().optional() }).passthrough();
/** Step progress lines carry no `type` field in 0.10.9. */
const StepSchema = z.object({ step: z.union([z.number(), z.string()]), status: z.string(), remark: z.string().optional(), child_id: z.string().optional(), ts: z.string().optional() }).passthrough();

export type KaneEvent =
  | { kind: 'stream_start'; cliVersion: string; raw: Record<string, unknown> }
  | { kind: 'recording_state'; sessionId: string; raw: Record<string, unknown> }
  | { kind: 'step'; step: string; status: string; remark: string; childId?: string; ts?: string; raw: Record<string, unknown> }
  | { kind: 'run_end'; runEnd: KaneRunEnd; raw: Record<string, unknown> }
  | { kind: 'unknown'; type: string | null; raw: Record<string, unknown> }
  | { kind: 'malformed'; line: string; error: string };

export const MAX_LINE_BYTES = 1_000_000;

export function parseKaneLine(line: string): KaneEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_LINE_BYTES) return { kind: 'malformed', line: trimmed.slice(0, 200), error: 'line exceeds size cap' };
  let raw: unknown;
  try { raw = JSON.parse(trimmed); } catch (e) { return { kind: 'malformed', line: trimmed.slice(0, 500), error: (e as Error).message }; }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { kind: 'malformed', line: trimmed.slice(0, 500), error: 'not a JSON object' };
  const obj = raw as Record<string, unknown>;
  const type = typeof obj.type === 'string' ? obj.type : null;
  if (type === 'run_end') {
    const p = RunEndSchema.safeParse(obj);
    return p.success ? { kind: 'run_end', runEnd: p.data, raw: obj } : { kind: 'malformed', line: trimmed.slice(0, 500), error: p.error.message };
  }
  if (type === 'stream_start') { const p = StreamStartSchema.safeParse(obj); if (p.success) return { kind: 'stream_start', cliVersion: p.data.cli_version, raw: obj }; }
  if (type === 'recording_state') { const p = RecordingStateSchema.safeParse(obj); if (p.success) return { kind: 'recording_state', sessionId: p.data.session_id, raw: obj }; }
  if (type === null) {
    const p = StepSchema.safeParse(obj);
    if (p.success) {
      return { kind: 'step', step: String(p.data.step), status: p.data.status, remark: p.data.remark ?? '', ...(p.data.child_id ? { childId: p.data.child_id } : {}), ...(p.data.ts ? { ts: p.data.ts } : {}), raw: obj };
    }
  }
  return { kind: 'unknown', type, raw: obj };
}

// ---------- Outcome ----------

/** Kane exit codes: 0 passed, 1 did not pass, 2 did not start, 3 cancelled/timeout. */
export type KaneOutcome =
  | 'passed'          // run_end passed and exit 0
  | 'did_not_pass'    // run_end present, objective not achieved (a candidate gap, NOT a verdict)
  | 'did_not_start'   // exit 2: config/auth/infra
  | 'cancelled'       // exit 3 or our abort/timeout
  | 'inconclusive';   // missing run_end, malformed stream, exit/status disagreement

/**
 * Observed in 0.10.9: a run that wrote a complete run_end (status "failed", result_code 750,
 * reason_code "assertion_error.step_not_achievable") can still exit 3. A completed run_end with an
 * assertion/step reason is a finished execution, not a cancellation; only our own abort, a missing
 * run_end, or a cancel/timeout reason count as cancelled.
 */
export function classifyKaneOutcome(exitCode: number | null, runEnd: KaneRunEnd | undefined, aborted: boolean): KaneOutcome {
  if (aborted) return 'cancelled';
  if (exitCode === 2) return 'did_not_start';
  if (!runEnd) return exitCode === 3 ? 'cancelled' : 'inconclusive';
  const reason = `${runEnd.reason_code ?? ''} ${runEnd.status}`.toLowerCase();
  if (/cancel|timeout|timed_out|interrupt/.test(reason)) return 'cancelled';
  if (runEnd.status === 'passed') return exitCode === 0 ? 'passed' : 'inconclusive';
  if (exitCode === 1 || exitCode === 3) return 'did_not_pass';
  return 'inconclusive';
}

export interface KaneRunOptions {
  objective: string;
  url: string;
  variables?: Record<string, string>;
  maxSteps?: number;
  timeoutSec?: number;
  headless?: boolean;
  kaneBin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onEvent?: (e: KaneEvent) => void | Promise<void>;
}

export interface KaneRunResult {
  outcome: KaneOutcome;
  exitCode: number | null;
  cliVersion?: string;
  sessionId?: string;
  runEnd?: KaneRunEnd;
  events: KaneEvent[];
  stderrTail: string;
  wallMs: number;
  /** Steps whose own message differs from Kane's final verdict, kept for evidence. */
  failedSteps: Array<{ step: string; remark: string }>;
}

export function buildKaneArgs(o: KaneRunOptions): string[] {
  const args = ['run', o.objective, '--url', o.url, '--agent'];
  if (o.headless !== false) args.push('--headless');
  if (o.maxSteps) args.push('--max-steps', String(o.maxSteps));
  if (o.timeoutSec) args.push('--timeout', String(o.timeoutSec));
  if (o.variables && Object.keys(o.variables).length) {
    const vars = Object.fromEntries(Object.entries(o.variables).map(([k, v]) => [k, { value: v, secret: false }]));
    args.push('--variables', JSON.stringify(vars));
  }
  return args;
}

/** Spawn `kane-cli run ... --agent`, stream NDJSON, return a typed result. Kills the process group on abort. */
export function runKane(o: KaneRunOptions): Promise<KaneRunResult> {
  const started = Date.now();
  const child = spawn(o.kaneBin ?? process.env.KANE_BIN ?? 'kane-cli', buildKaneArgs(o), {
    cwd: o.cwd, env: o.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  const events: KaneEvent[] = [];
  let buf = '';
  let stderr = '';
  let aborted = false;
  let chain: Promise<void> = Promise.resolve();

  const kill = () => { aborted = true; try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } };
  o.signal?.addEventListener('abort', kill, { once: true });

  const handle = (line: string) => {
    const e = parseKaneLine(line);
    if (!e) return;
    events.push(e);
    if (o.onEvent) chain = chain.then(() => o.onEvent!(e)).catch(() => {});
  };
  child.stdout.setEncoding('utf8').on('data', (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
    if (buf.length > MAX_LINE_BYTES) { handle(buf); buf = ''; }
  });
  child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr = (stderr + d).slice(-8000); });

  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', async (code) => {
      if (buf) handle(buf);
      await chain;
      o.signal?.removeEventListener('abort', kill);
      const runEnd = [...events].reverse().find((e): e is Extract<KaneEvent, { kind: 'run_end' }> => e.kind === 'run_end')?.runEnd;
      const start = events.find((e): e is Extract<KaneEvent, { kind: 'stream_start' }> => e.kind === 'stream_start');
      const rec = events.find((e): e is Extract<KaneEvent, { kind: 'recording_state' }> => e.kind === 'recording_state');
      const failedSteps = events.filter((e): e is Extract<KaneEvent, { kind: 'step' }> => e.kind === 'step' && e.status === 'failed').map((e) => ({ step: e.step, remark: e.remark }));
      resolve({
        outcome: classifyKaneOutcome(code, runEnd, aborted || o.signal?.aborted === true),
        exitCode: code,
        ...(start ? { cliVersion: start.cliVersion } : {}),
        ...(rec ? { sessionId: rec.sessionId } : {}),
        ...(runEnd ? { runEnd } : {}),
        events,
        stderrTail: stderr,
        wallMs: Date.now() - started,
        failedSteps,
      });
    });
  });
}

// ---------- CLI helpers ----------

function capture(bin: string, args: string[], timeoutMs = 30_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => c.kill('SIGTERM'), timeoutMs);
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('error', (e) => { clearTimeout(t); reject(e); });
    c.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

export async function kaneVersion(bin = process.env.KANE_BIN ?? 'kane-cli'): Promise<string | null> {
  const r = await capture(bin, ['--version']).catch(() => null);
  const m = r?.out.match(/\b(\d+\.\d+\.\d+)\b/);
  return m ? m[1]! : null;
}

/** Parses "Available credits: 876.8671". Returns null when not logged in or unparseable. */
export function parseBalance(text: string): number | null {
  const m = text.match(/Available credits:\s*([0-9]+(?:\.[0-9]+)?)/);
  return m ? Number(m[1]) : null;
}

/** Retries: right after a run, `kane-cli balance` has been seen to fail once transiently. */
export async function kaneBalance(bin = process.env.KANE_BIN ?? 'kane-cli', attempts = 4): Promise<number | null> {
  for (let i = 0; i < attempts; i++) {
    const r = await capture(bin, ['balance']).catch(() => null);
    const v = r ? parseBalance(r.out) : null;
    if (v !== null) return v;
    if (i < attempts - 1) await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
  }
  return null;
}

export async function kaneAuthenticated(bin = process.env.KANE_BIN ?? 'kane-cli'): Promise<boolean> {
  const r = await capture(bin, ['whoami']).catch(() => null);
  return !!r && /Authenticated/.test(r.out) && !/Not logged in/.test(r.out);
}

// ---------- Evidence packs ----------

export interface EvidencePack {
  path: string;
  bytes: number;
  sha256: string;
  entries: string[];
}

export const MAX_EVIDENCE_BYTES = 200 * 1024 * 1024;

export async function locateEvidencePacks(sessionDir: string): Promise<string[]> {
  const dir = join(sessionDir, 'evidence');
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith('.evidence')).map((n) => join(dir, n));
}

export function isSafeEntryPath(p: string): boolean {
  if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p)) return false;
  return !p.split(/[\\/]/).some((seg) => seg === '..');
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

function listZip(path: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('cannot open evidence pack'));
      const names: string[] = [];
      zip.on('entry', (e: yauzl.Entry) => { names.push(e.fileName); zip.readEntry(); });
      zip.on('end', () => resolve(names));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

const MAX_ENTRY_BYTES = 20 * 1024 * 1024;

/** Read matching entries from a pack into memory (bounded), after the path check. Never writes to disk. */
export function readEvidenceEntries(path: string, match: (name: string) => boolean): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('cannot open evidence pack'));
      const out = new Map<string, Buffer>();
      zip.on('entry', (e: yauzl.Entry) => {
        if (!isSafeEntryPath(e.fileName)) return reject(new Error(`unsafe path in evidence pack: ${e.fileName}`));
        if (!match(e.fileName) || e.uncompressedSize > MAX_ENTRY_BYTES) return zip.readEntry();
        zip.openReadStream(e, (e2, s) => {
          if (e2 || !s) return reject(e2);
          const chunks: Buffer[] = [];
          s.on('data', (c: Buffer) => chunks.push(c)).on('end', () => { out.set(e.fileName, Buffer.concat(chunks)); zip.readEntry(); }).on('error', reject);
        });
      });
      zip.on('end', () => resolve(out));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

export interface NetworkEffect { method: string; path: string; status: number }

/**
 * State-changing HTTP requests the browser made during a run (from the pack's HAR), with the
 * given values (e.g. the fixture's query id) replaced by named placeholders. Logins are dropped.
 */
export async function extractNetworkEffects(packPath: string, placeholders: Record<string, string> = {}): Promise<NetworkEffect[]> {
  const files = await readEvidenceEntries(packPath, (n) => n.endsWith('-network.har'));
  const effects: NetworkEffect[] = [];
  for (const buf of files.values()) {
    let har: any;
    try { har = JSON.parse(buf.toString('utf8')); } catch { continue; }
    for (const e of har?.log?.entries ?? []) {
      const method = String(e?.request?.method ?? '');
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) continue;
      let path: string;
      try { path = new URL(String(e.request.url)).pathname; } catch { continue; }
      if (/\/login$|\/auth\//.test(path)) continue;
      for (const [name, value] of Object.entries(placeholders)) path = path.split(value).join(`{${name}}`);
      effects.push({ method, path, status: Number(e?.response?.status ?? 0) });
    }
  }
  return effects;
}

/** Validate size and entry paths, hash the bytes. Throws on traversal or oversize; never extracts. */
export async function inspectEvidencePack(path: string): Promise<EvidencePack> {
  const s = await stat(path);
  if (s.size > MAX_EVIDENCE_BYTES) throw new Error(`evidence pack too large: ${s.size} bytes`);
  const entries = await listZip(path);
  const bad = entries.find((e) => !isSafeEntryPath(e));
  if (bad) throw new Error(`unsafe path in evidence pack: ${bad}`);
  return { path, bytes: s.size, sha256: await hashFile(path), entries };
}
