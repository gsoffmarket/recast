import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseKaneLine, classifyKaneOutcome, parseBalance, buildKaneArgs, isSafeEntryPath, type KaneEvent } from '@recast/kane-adapter';

const load = (f: string): KaneEvent[] => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8').split('\n').map(parseKaneLine).filter((e): e is KaneEvent => e !== null);

describe('Kane NDJSON parser on real 0.10.9 output', () => {
  it('parses a passed classic run end to end', () => {
    const ev = load('classic-passed.ndjson');
    expect(ev.find((e) => e.kind === 'stream_start')).toMatchObject({ cliVersion: '0.10.9' });
    const end = ev.find((e) => e.kind === 'run_end');
    expect(end?.kind === 'run_end' && end.runEnd.status).toBe('passed');
    expect(end?.kind === 'run_end' && typeof end.runEnd.credits_consumed).toBe('number');
    expect(ev.some((e) => e.kind === 'step')).toBe(true);
    expect(ev.some((e) => e.kind === 'malformed')).toBe(false);
  });
  it('keeps the failing step message of a preview run separately from Kane\'s verdict', () => {
    const ev = load('preview-failed.ndjson');
    const end = ev.find((e) => e.kind === 'run_end');
    expect(end?.kind === 'run_end' && end.runEnd.status).toBe('failed');
    expect(end?.kind === 'run_end' && end.runEnd.verdict).toBeTruthy();
    expect(ev.filter((e) => e.kind === 'step' && e.status === 'failed').length).toBeGreaterThan(0);
  });
  it('preserves unknown event types and flags malformed lines', () => {
    expect(parseKaneLine('{"type":"brand_new","x":1}')).toMatchObject({ kind: 'unknown', type: 'brand_new' });
    expect(parseKaneLine('{not json')).toMatchObject({ kind: 'malformed' });
    expect(parseKaneLine('[1,2]')).toMatchObject({ kind: 'malformed' });
    expect(parseKaneLine('   ')).toBeNull();
  });
});

describe('outcome mapping', () => {
  const passed = { type: 'run_end' as const, status: 'passed' };
  const failed = { type: 'run_end' as const, status: 'failed' };
  it('maps exit codes and run_end consistently', () => {
    expect(classifyKaneOutcome(0, passed, false)).toBe('passed');
    expect(classifyKaneOutcome(1, failed, false)).toBe('did_not_pass');
    expect(classifyKaneOutcome(2, undefined, false)).toBe('did_not_start');
    expect(classifyKaneOutcome(3, undefined, false)).toBe('cancelled');
    expect(classifyKaneOutcome(0, undefined, false)).toBe('inconclusive');
    expect(classifyKaneOutcome(0, failed, false)).toBe('inconclusive');
    expect(classifyKaneOutcome(1, failed, true)).toBe('cancelled');
  });
  it('treats exit 3 with a completed assertion-failure run_end as did_not_pass (seen live in 0.10.9)', () => {
    const stepNotAchievable = { type: 'run_end' as const, status: 'failed', result_code: 750, reason_code: 'assertion_error.step_not_achievable' };
    expect(classifyKaneOutcome(3, stepNotAchievable, false)).toBe('did_not_pass');
    expect(classifyKaneOutcome(3, { type: 'run_end' as const, status: 'failed', reason_code: 'run.timeout' }, false)).toBe('cancelled');
    expect(classifyKaneOutcome(3, { type: 'run_end' as const, status: 'passed' }, false)).toBe('inconclusive');
  });
});

describe('helpers', () => {
  it('parses the balance line', () => {
    expect(parseBalance('Skill update available\n\nAvailable credits: 876.8671')).toBe(876.8671);
    expect(parseBalance('Not authenticated [prod].')).toBeNull();
  });
  it('passes variables as JSON, never inlined into the objective', () => {
    const args = buildKaneArgs({ objective: 'Open {{query_id}}', url: 'http://h', variables: { query_id: 'q1' }, maxSteps: 15 });
    expect(args).toContain('--agent');
    expect(JSON.parse(args[args.indexOf('--variables') + 1]!)).toEqual({ query_id: { value: 'q1', secret: false } });
  });
  it('rejects path traversal in evidence packs', () => {
    expect(isSafeEntryPath('tests/a/steps/1/screenshot.jpg')).toBe(true);
    expect(isSafeEntryPath('../../etc/passwd')).toBe(false);
    expect(isSafeEntryPath('/abs/path')).toBe(false);
    expect(isSafeEntryPath('C:\\x')).toBe(false);
  });
});
