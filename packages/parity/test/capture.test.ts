import { describe, expect, it } from 'vitest';
import { inferAssertions, type ObservedValue } from '@recast/parity';

const o = (path: string, value: ObservedValue['value'], status: ObservedValue['status'] = 'observed'): ObservedValue => ({ path, value, status });
const running = [o('query.state', 'RUNNING'), o('query.errorCode', null), o('query.user', 'recast-m0')];
const killed = [o('query.state', 'FAILED'), o('query.errorCode', 'ADMINISTRATIVELY_KILLED'), o('query.user', 'recast-m0')];

describe('inferAssertions', () => {
  it('keeps only what the action changed, to the same value in every run', () => {
    const r = inferAssertions([{ runId: 'a', before: running, after: killed }, { runId: 'b', before: running, after: killed }]);
    expect(r.assertions).toEqual([
      { path: 'query.errorCode', operator: 'equals', expected: 'ADMINISTRATIVELY_KILLED' },
      { path: 'query.state', operator: 'equals', expected: 'FAILED' },
    ]);
    expect(r.skipped).toEqual([{ path: 'query.user', reason: 'the action did not change it' }]);
  });

  it('skips values that differ between runs, such as ids', () => {
    const r = inferAssertions([
      { runId: 'a', before: [o('order.id', 'x1'), o('order.status', 'open')], after: [o('order.id', 'x2'), o('order.status', 'cancelled')] },
      { runId: 'b', before: [o('order.id', 'y1'), o('order.status', 'open')], after: [o('order.id', 'y2'), o('order.status', 'cancelled')] },
    ]);
    expect(r.assertions.map((a) => a.path)).toEqual(['order.status']);
    expect(r.skipped).toContainEqual({ path: 'order.id', reason: 'ended at different values in different runs' });
  });

  it('finds nothing when the action had no effect, so nothing gets frozen', () => {
    const r = inferAssertions([{ runId: 'a', before: running, after: running }, { runId: 'b', before: running, after: running }]);
    expect(r.assertions).toEqual([]);
    expect(r.skipped).toHaveLength(3);
  });

  it('never infers from an unavailable observation or one with no before value', () => {
    const r = inferAssertions([{ runId: 'a', before: [o('x', 1)], after: [o('x', 2, 'unavailable'), o('ui.total', '9')] }]);
    expect(r.assertions).toEqual([]);
    expect(r.skipped).toEqual([
      { path: 'ui.total', reason: 'no value before the action to compare with' },
      { path: 'x', reason: 'not observed after the action in every run' },
    ]);
  });

  it('treats a change seen in only one run as not a behaviour', () => {
    const r = inferAssertions([{ runId: 'a', before: running, after: killed }, { runId: 'b', before: running, after: running }]);
    expect(r.assertions).toEqual([]);
  });

  it('returns nothing for no probes', () => {
    expect(inferAssertions([])).toEqual({ assertions: [], skipped: [] });
  });
});
