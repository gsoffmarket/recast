import { sleep } from '@recast/shared';
import type { Observation } from './index.ts';

/**
 * Config-only fixture and oracle for any app with an HTTP API. A project describes, in JSON,
 * one request that creates a fresh starting state (and which response fields to keep), one
 * optional request that cleans it up, and one read-only request whose response fields become
 * the observations the requirement asserts on. No TypeScript is needed for a new app.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type Scalar = string | number | boolean | null;

export interface HttpRequestSpec {
  method?: HttpMethod;
  /** May use {{variables}}: captured fixture values, {{run}}, and {{env.NAME}} for secrets. */
  url: string;
  headers?: Record<string, string>;
  /** JSON body (objects are sent as JSON, strings as text). Templates are filled inside strings. */
  body?: unknown;
}

export interface HttpFixtureConfig {
  type: 'http';
  /** Stable name for this starting state; requirements reference it in their "fixture" field. */
  identity: string;
  setup: HttpRequestSpec & {
    /** Variable name → dot path in the JSON response, e.g. { "order_id": "data.id" }. The first one is the run's reference. */
    capture: Record<string, string>;
  };
  cleanup?: HttpRequestSpec;
}

export interface HttpOracleConfig {
  type: 'http';
  /** Name recorded on every observation; requirements reference it in their "oracle" field. */
  name: string;
  request: HttpRequestSpec;
  /** Observation path → dot path in the JSON response, e.g. { "order.status": "status" }. */
  observe: Record<string, string>;
  /** Poll until this observation reaches one of these values (or settle time runs out). Without it, read once after the settle time. */
  until?: { path: string; in: Scalar[] };
}

export type Vars = Record<string, string>;

const TEMPLATE = /\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}/g;

/** Fill {{name}} and {{env.NAME}}. An unknown name is an error, never an empty string. */
export function fillTemplate(text: string, vars: Vars, env: Record<string, string | undefined> = process.env): string {
  return text.replace(TEMPLATE, (_m, name: string) => {
    if (name.startsWith('env.')) {
      const v = env[name.slice(4)];
      if (v === undefined) throw new Error(`environment variable ${name.slice(4)} is not set`);
      return v;
    }
    if (!(name in vars)) throw new Error(`unknown template variable {{${name}}}`);
    return vars[name]!;
  });
}

export function fillDeep(value: unknown, vars: Vars, env?: Record<string, string | undefined>): unknown {
  if (typeof value === 'string') return fillTemplate(value, vars, env);
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, vars, env));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, vars, env)]));
  return value;
}

/** Read a dot path ("data.items.0.id") from parsed JSON. Objects and arrays come back as canonical JSON text. */
export function pick(data: unknown, path: string): Scalar | undefined {
  let cur: unknown = data;
  for (const part of path.split('.').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (cur === undefined) return undefined;
  if (cur === null || typeof cur === 'string' || typeof cur === 'number' || typeof cur === 'boolean') return cur;
  return JSON.stringify(cur);
}

interface Sent { status: number; json: unknown }

async function send(spec: HttpRequestSpec, vars: Vars, signal?: AbortSignal): Promise<Sent> {
  const url = fillTemplate(spec.url, vars);
  const headers: Record<string, string> = Object.fromEntries(Object.entries(spec.headers ?? {}).map(([k, v]) => [k, fillTemplate(v, vars)]));
  let body: string | undefined;
  if (spec.body !== undefined) {
    const filled = fillDeep(spec.body, vars);
    if (typeof filled === 'string') body = filled;
    else { body = JSON.stringify(filled); headers['content-type'] ??= 'application/json'; }
  }
  const res = await fetch(url, { method: spec.method ?? (body === undefined ? 'GET' : 'POST'), headers, ...(body !== undefined ? { body } : {}), ...(signal ? { signal } : {}) });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json };
}

export class HttpFixture {
  readonly identity: string;
  private readonly cfg: HttpFixtureConfig;
  constructor(cfg: HttpFixtureConfig) { this.cfg = cfg; this.identity = cfg.identity; }

  /** Create a fresh starting state. Returns the captured variables and the first one as the run's reference. */
  async start(runTag: string): Promise<{ ref: string; vars: Vars }> {
    const r = await send(this.cfg.setup, { run: runTag });
    if (r.status < 200 || r.status >= 300) throw new Error(`fixture setup ${this.cfg.setup.method ?? 'POST'} -> ${r.status}`);
    const vars: Vars = { run: runTag };
    for (const [name, path] of Object.entries(this.cfg.setup.capture)) {
      const v = pick(r.json, path);
      if (v === undefined || v === null || v === '') throw new Error(`fixture setup response has no value at "${path}" for {{${name}}}`);
      vars[name] = String(v);
    }
    const first = Object.keys(this.cfg.setup.capture)[0];
    return { ref: first ? vars[first]! : runTag, vars };
  }

  /** Undo the starting state, if a cleanup request is configured. Returns the HTTP status or null. */
  async cleanup(vars: Vars): Promise<number | null> {
    if (!this.cfg.cleanup) return null;
    return (await send(this.cfg.cleanup, vars)).status;
  }
}

export class HttpOracle {
  readonly name: string;
  private readonly cfg: HttpOracleConfig;
  constructor(cfg: HttpOracleConfig) { this.cfg = cfg; this.name = cfg.name; }

  private toObservations(r: Sent, at: string): Observation[] {
    const ok = r.status >= 200 && r.status < 300;
    return [
      { path: 'http.status', value: r.status, adapter: this.name, status: 'observed', at },
      ...Object.entries(this.cfg.observe).map(([path, from]) => {
        const v = ok ? pick(r.json, from) : undefined;
        return { path, value: v ?? null, adapter: this.name, status: 'observed' as const, at, ...(v === undefined ? { detail: ok ? `no value at "${from}"` : `HTTP ${r.status}` } : {}) };
      }),
    ];
  }

  /** Observe after the UI action. A response is always an observation (a 404 after a delete is a real outcome). */
  async observe(vars: Vars, settleMs: number, pollMs = 1000): Promise<Observation[]> {
    const deadline = Date.now() + settleMs;
    if (!this.cfg.until) await sleep(settleMs);
    let last: Sent | null = null;
    let error = 'no response';
    do {
      try { last = await send(this.cfg.request, vars); } catch (e) { error = (e as Error).message; }
      if (!this.cfg.until || !last) { if (last || Date.now() >= deadline) break; await sleep(pollMs); continue; }
      const obs = this.toObservations(last, new Date().toISOString());
      const v = obs.find((o) => o.path === this.cfg.until!.path)?.value;
      if (this.cfg.until.in.some((x) => x === v)) break;
      if (Date.now() >= deadline) break;
      await sleep(pollMs);
    } while (true);
    const at = new Date().toISOString();
    if (!last) return ['http.status', ...Object.keys(this.cfg.observe)].map((path) => ({ path, value: null, adapter: this.name, status: 'unavailable' as const, at, detail: error }));
    return this.toObservations(last, at);
  }
}
