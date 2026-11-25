import { createHash, randomUUID } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted by code point, no insignificant whitespace,
 * arrays kept in order. Rejects values that have no stable JSON form.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, []);
}

function serialize(value: unknown, path: string[]): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError(`non-finite number at ${fmt(path)}`);
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v, i) => serialize(v, [...path, String(i)])).join(',')}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new CanonicalJsonError(`unsupported object at ${fmt(path)}`);
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialize(v, [...path, k])}`).join(',')}}`;
    }
    default:
      throw new CanonicalJsonError(`unsupported ${typeof value} at ${fmt(path)}`);
  }
}

const fmt = (path: string[]) => (path.length ? path.join('.') : '<root>');

export class CanonicalJsonError extends Error {
  override name = 'CanonicalJsonError';
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Hash of the canonical JSON form, prefixed with the algorithm. */
export function contentHash(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

export const newId = (): string => randomUUID();

export const nowIso = (): string => new Date().toISOString();

/** Parity results. Execution states (infrastructure error, cancelled) are deliberately not here. */
export const PARITY_STATUSES = ['preserved', 'missing', 'intentional_change', 'uncertain', 'untested'] as const;
export type ParityStatus = (typeof PARITY_STATUSES)[number];

export const RUN_STATES = ['queued', 'resetting', 'executing', 'observing', 'completed', 'infra_error', 'cancelled'] as const;
export type RunState = (typeof RUN_STATES)[number];

/** Recast's own versioned event envelope (distinct from Kane's NDJSON schema). */
export interface RecastEvent<T = unknown> {
  v: 1;
  seq: number;
  type: string;
  runId: string;
  at: string;
  payload: T;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}

/** Redact secrets and share tokens from text before it leaves the machine (reports, fixtures, logs). */
export function redact(text: string): string {
  return text
    .replace(/(\/share\/)[A-Za-z0-9_-]{16,}/g, '$1[REDACTED]')
    .replace(/(Trino-UI-Token=)[^;\s"]+/g, '$1[REDACTED]')
    .replace(/((?:access[_-]?key|token|password|secret)["']?\s*[:=]\s*["']?)[^"'\s,}]{6,}/gi, '$1[REDACTED]')
    .replace(/\/Users\/[^/\s"]+/g, '/Users/[USER]');
}
