import { sleep } from '@recast/shared';

/**
 * Observation adapters: independent, read-only oracles that produce typed values for assertions.
 * Kane performs the workflow; these decide what actually happened.
 */
export interface Observation {
  path: string;
  value: string | number | boolean | null;
  adapter: string;
  status: 'observed' | 'unavailable';
  at: string;
  detail?: string;
}

export interface TrinoQueryState {
  queryId: string;
  state: string;
  errorCode: string | null;
  errorType: string | null;
  user: string | null;
}

const TERMINAL = new Set(['FINISHED', 'FAILED']);

export class TrinoOracle {
  readonly name = 'trino-rest-v1';
  private readonly baseUrl: string;
  private readonly user: string;
  constructor(baseUrl: string, user = 'recast-oracle') { this.baseUrl = baseUrl; this.user = user; }

  /** Read-only GET /v1/query/{id}. */
  async queryState(queryId: string): Promise<TrinoQueryState> {
    if (!/^[0-9]{8}_[0-9]{6}_[0-9]{5}_[a-z0-9]+$/.test(queryId)) throw new Error(`not a Trino query id: ${queryId}`);
    const res = await fetch(`${this.baseUrl}/v1/query/${queryId}`, { headers: { 'X-Trino-User': this.user } });
    if (!res.ok) throw new Error(`oracle GET /v1/query/${queryId} -> ${res.status}`);
    const d = (await res.json()) as Record<string, any>;
    return {
      queryId: d.queryId,
      state: d.state,
      errorCode: d.errorCode?.name ?? null,
      errorType: d.errorType ?? null,
      user: d.session?.user ?? null,
    };
  }

  /**
   * Observe until the query reaches a terminal state or settleMs elapses (bounded eventual consistency).
   * A still-running query after settleMs is a real observation: state RUNNING.
   */
  async observe(queryId: string, settleMs: number, pollMs = 1000): Promise<Observation[]> {
    const deadline = Date.now() + settleMs;
    let last: TrinoQueryState | null = null;
    let error: string | null = null;
    do {
      try { last = await this.queryState(queryId); error = null; } catch (e) { error = (e as Error).message; }
      if (last && TERMINAL.has(last.state)) break;
      if (Date.now() >= deadline) break;
      await sleep(pollMs);
    } while (true);
    const at = new Date().toISOString();
    if (!last) {
      return ['query.state', 'query.errorCode'].map((path) => ({ path, value: null, adapter: this.name, status: 'unavailable' as const, at, detail: error ?? 'no response' }));
    }
    return [
      { path: 'query.state', value: last.state, adapter: this.name, status: 'observed', at },
      { path: 'query.errorCode', value: last.errorCode, adapter: this.name, status: 'observed', at },
    ];
  }
}

/**
 * Fixture for the Trino reference case: a fresh, independent long-running query per run.
 * Keeps following nextUri so the coordinator does not abandon it, and cancels leftovers
 * via REST after observation (which shows as USER_CANCELED, distinguishable from a UI kill).
 */
export class TrinoRunningQueryFixture {
  readonly identity = 'trino-481-running-query-v1';
  private pollers = new Map<string, AbortController>();
  private readonly baseUrl: string;
  private readonly user: string;
  private readonly sql: string;

  constructor(baseUrl: string, user = 'recast-m0', sql = "SELECT count(*) FROM tpch.sf1000.lineitem WHERE comment LIKE '%recast%'") {
    this.baseUrl = baseUrl; this.user = user; this.sql = sql;
  }

  async start(source: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/v1/statement`, {
      method: 'POST', body: this.sql, headers: { 'X-Trino-User': this.user, 'X-Trino-Source': source },
    });
    if (!res.ok) throw new Error(`fixture POST /v1/statement -> ${res.status}`);
    const first = (await res.json()) as { id: string; nextUri?: string };
    const ac = new AbortController();
    this.pollers.set(first.id, ac);
    void this.follow(first.nextUri, ac.signal);
    const oracle = new TrinoOracle(this.baseUrl);
    for (let i = 0; i < 30; i++) {
      const s = await oracle.queryState(first.id).catch(() => null);
      if (s?.state === 'RUNNING') return first.id;
      if (s && TERMINAL.has(s.state)) throw new Error(`fixture query ${first.id} ended early: ${s.state}`);
      await sleep(1000);
    }
    throw new Error(`fixture query ${first.id} never reached RUNNING`);
  }

  private async follow(next: string | undefined, signal: AbortSignal): Promise<void> {
    while (next && !signal.aborted) {
      try {
        const r = await fetch(next, { headers: { 'X-Trino-User': this.user }, signal });
        const d = (await r.json()) as { nextUri?: string };
        next = d.nextUri;
      } catch { return; }
      await sleep(1000, signal).catch(() => {});
    }
  }

  /** Cancel if still running, stop the poller. Returns the REST status code or null. */
  async cleanup(queryId: string): Promise<number | null> {
    const s = await new TrinoOracle(this.baseUrl).queryState(queryId).catch(() => null);
    let code: number | null = null;
    if (s && !TERMINAL.has(s.state)) {
      const r = await fetch(`${this.baseUrl}/v1/query/${queryId}`, { method: 'DELETE', headers: { 'X-Trino-User': 'recast-cleanup' } });
      code = r.status;
    }
    this.pollers.get(queryId)?.abort();
    this.pollers.delete(queryId);
    return code;
  }
}

/** Environment fingerprint: what exactly we ran against. */
export async function trinoFingerprint(baseUrl: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/v1/info`);
  if (!res.ok) throw new Error(`GET /v1/info -> ${res.status}`);
  const d = (await res.json()) as Record<string, any>;
  return { product: 'trino', version: d.nodeVersion?.version, environment: d.environment, coordinator: d.coordinator, starting: d.starting };
}

/**
 * Browser observations: values Kane read off the page and stored ("store it as X"), exposed as `ui.X`.
 * These are UI readings, labelled with their adapter; ground truth for them comes from the fixture or
 * the REST oracle in the requirement's assertions, never from Kane's own pass/fail.
 */
export function kaneFinalStateObservations(finalState: Record<string, unknown> | undefined, at = new Date().toISOString()): Observation[] {
  if (!finalState) return [];
  return Object.entries(finalState)
    .filter(([k, v]) => k !== 'url' && /^[a-z][a-z0-9_]{0,40}$/.test(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'))
    .map(([k, v]) => ({ path: `ui.${k}`, value: typeof v === 'string' ? v.trim() : (v as number | boolean), adapter: 'kane-final-state', status: 'observed' as const, at }));
}
