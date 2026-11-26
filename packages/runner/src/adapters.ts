import { z } from 'zod';
import { HttpFixture, HttpOracle, TrinoOracle, TrinoRunningQueryFixture, trinoFingerprint, type Observation, type Vars } from '@recast/observations';

/**
 * Project config schema and the adapters a run uses. A project picks its fixture (how each run gets
 * a fresh starting state) and its oracle (how the real outcome is read) in JSON. Two kinds exist:
 * the built-in Trino reference case, and a generic HTTP kind that fits any app with an API.
 */

const Method = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const HttpRequest = z.object({
  method: Method.optional(),
  url: z.string().min(1),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
}).strict();

const TrinoFixture = z.object({ type: z.literal('trino-running-query'), baseUrl: z.string().url(), user: z.string().min(1) }).strict();
const HttpFixtureSchema = z.object({
  type: z.literal('http'),
  identity: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,80}$/, 'lowercase letters, digits, dot, dash or underscore'),
  setup: HttpRequest.extend({ capture: z.record(z.string().min(1)).refine((c) => Object.keys(c).every((k) => /^[a-z][a-z0-9_]{0,40}$/.test(k)), 'capture names must be snake_case') }),
  cleanup: HttpRequest.optional(),
}).strict();
const NoFixture = z.object({ type: z.literal('none'), identity: z.string().min(3) }).strict();

const HttpOracleSchema = z.object({
  type: z.literal('http'),
  name: z.string().min(1),
  request: HttpRequest,
  observe: z.record(z.string().min(1)).refine((o) => Object.keys(o).length > 0, 'observe at least one field'),
  until: z.object({ path: z.string(), in: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).min(1) }).strict().optional(),
}).strict();

export const EnvironmentSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/, 'lowercase name with dashes'),
  kind: z.enum(['source', 'target', 'candidate']),
  baseUrl: z.string().url(),
  apiBaseUrl: z.string().url().optional(),
  startPath: z.string().startsWith('/'),
  hints: z.array(z.string()).default([]),
}).strict();

export const ProjectConfigSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/, 'lowercase name with dashes'),
  environments: z.array(EnvironmentSchema).min(2, 'at least a source and a target environment')
    .refine((e) => e.some((x) => x.kind === 'source'), 'one environment must be kind "source" (the legacy UI)')
    .refine((e) => e.some((x) => x.kind === 'target'), 'one environment must be kind "target" (the new UI)')
    .refine((e) => new Set(e.map((x) => x.name)).size === e.length, 'environment names must be unique'),
  fixture: z.discriminatedUnion('type', [TrinoFixture, HttpFixtureSchema, NoFixture]),
  oracle: HttpOracleSchema.optional(),
  /** Optional URL returning JSON that identifies the app version; recorded with every run. */
  fingerprintUrl: z.string().url().optional(),
  role: z.object({ username: z.string() }).passthrough(),
  kane: z.object({ maxSteps: z.number().int().min(3).max(60), timeoutSec: z.number().int().min(60).max(3600) }).strict(),
  budget: z.object({ minBalance: z.number().min(0) }).strict(),
  repair: z.record(z.unknown()).optional(),
  /** recast capture: how to name the item each run starts with, e.g. "the order {{order_id}}". */
  capture: z.object({ subject: z.string().min(8).max(300) }).strict().optional(),
}).strict().superRefine((c, ctx) => {
  if (c.fixture.type !== 'trino-running-query' && !c.oracle) ctx.addIssue({ code: 'custom', path: ['oracle'], message: 'an "oracle" is required unless the fixture is the built-in Trino one' });
});

export type ParsedProjectConfig = z.infer<typeof ProjectConfigSchema>;

export interface RunAdapters {
  fixtureIdentity: string;
  oracleName: string;
  /** Fresh starting state. ref is stored on the run; vars are passed to Kane and to the oracle. */
  start(runTag: string): Promise<{ ref: string | null; vars: Vars }>;
  observe(vars: Vars, settleMs: number): Promise<Observation[]>;
  cleanup(vars: Vars): Promise<number | null>;
  fingerprint(apiBaseUrl: string, uiUrl: string): Promise<Record<string, unknown>>;
  /** Whether a fingerprint means the environment is ready. */
  ready(fingerprint: Record<string, unknown>): boolean;
}

async function genericFingerprint(fingerprintUrl: string | undefined, uiUrl: string): Promise<Record<string, unknown>> {
  if (fingerprintUrl) {
    const r = await fetch(fingerprintUrl);
    if (!r.ok) throw new Error(`GET ${fingerprintUrl} -> ${r.status}`);
    return { source: fingerprintUrl, ...(await r.json().catch(() => ({}))) as Record<string, unknown> };
  }
  const r = await fetch(uiUrl);
  return { source: uiUrl, status: r.status, server: r.headers.get('server') };
}

export function makeAdapters(cfg: ParsedProjectConfig): RunAdapters {
  const f = cfg.fixture;
  if (f.type === 'trino-running-query') {
    const fixture = new TrinoRunningQueryFixture(f.baseUrl, f.user);
    const oracle = new TrinoOracle(f.baseUrl);
    return {
      fixtureIdentity: fixture.identity,
      oracleName: oracle.name,
      start: async (tag) => { const id = await fixture.start(tag); return { ref: id, vars: { query_id: id } }; },
      observe: (vars, settleMs) => oracle.observe(vars.query_id!, settleMs),
      cleanup: (vars) => (vars.query_id ? fixture.cleanup(vars.query_id) : Promise.resolve(null)),
      fingerprint: (api) => trinoFingerprint(api),
      ready: (fp) => fp.starting === false,
    };
  }
  const oracle = new HttpOracle(cfg.oracle!);
  const fixture = f.type === 'http' ? new HttpFixture(f) : null;
  return {
    fixtureIdentity: f.identity,
    oracleName: oracle.name,
    start: async (tag) => (fixture ? fixture.start(tag) : { ref: null, vars: { run: tag } }),
    observe: (vars, settleMs) => oracle.observe(vars, settleMs),
    cleanup: (vars) => (fixture ? fixture.cleanup(vars) : Promise.resolve(null)),
    fingerprint: (_api, ui) => genericFingerprint(cfg.fingerprintUrl, ui),
    ready: (fp) => !('status' in fp) || (Number(fp.status) >= 200 && Number(fp.status) < 400),
  };
}

/** A requirement's oracle matches when its first part is the project's oracle; "+kane-final-state" (page readings) is always available. */
export function oracleMatches(requirementOracle: string, oracleName: string): boolean {
  const [main, ...rest] = requirementOracle.split('+');
  return main === oracleName && rest.every((r) => r === 'kane-final-state');
}

/** Parse a project config with readable errors. */
export function parseProjectConfig(raw: unknown): ParsedProjectConfig {
  return ProjectConfigSchema.parse(raw);
}

/** How capture drafts name the item a run starts with: the config's capture.subject, or a default from the fixture. */
export function captureSubject(cfg: ParsedProjectConfig): string {
  if (cfg.capture?.subject) return cfg.capture.subject;
  const f = cfg.fixture;
  if (f.type === 'trino-running-query') return 'the details page of the query with ID {{query_id}}, which is currently running,';
  if (f.type === 'http') { const first = Object.keys(f.setup.capture)[0]; if (first) return `the page for {{${first}}}`; }
  return 'the app';
}
