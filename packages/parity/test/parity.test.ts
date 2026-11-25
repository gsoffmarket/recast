import { describe, expect, it } from 'vitest';
import { parseRequirement } from '@recast/behaviour-spec';
import { evaluateRun, classify, baselineStatus, scalarEquals } from '@recast/parity';

const req = parseRequirement({
  id: 'REQ-QRY-CANCEL', revision: 1, objective: 'Cancel a running query', role: 'u', fixture: 'f', action_intent: 'Cancel query {{query_id}} now',
  oracle: 'trino-rest-v1', assertions: [{ path: 'query.state', operator: 'equals', expected: 'FAILED' }, { path: 'query.errorCode', operator: 'in', expected: ['ADMINISTRATIVELY_KILLED', 'USER_CANCELED'] }],
  provenance: 'source-observed',
});
const killed = [{ path: 'query.state', value: 'FAILED', status: 'observed' as const }, { path: 'query.errorCode', value: 'ADMINISTRATIVELY_KILLED', status: 'observed' as const }];
const running = [{ path: 'query.state', value: 'RUNNING', status: 'observed' as const }, { path: 'query.errorCode', value: null, status: 'observed' as const }];

describe('comparators', () => {
  it('uses exact typed equality', () => {
    expect(scalarEquals('1', 1)).toBe(false);
    expect(scalarEquals(null, false)).toBe(false);
    expect(scalarEquals('FAILED', 'FAILED')).toBe(true);
  });
  it('treats missing or duplicate observations as unverified, never as a pass', () => {
    expect(evaluateRun('r', req, killed.slice(0, 1), true).verdict).toBe('unverified');
    expect(evaluateRun('r', req, [...killed, killed[0]!], true).verdict).toBe('unverified');
  });
  it('treats an invalid execution as unverified even if the oracle looks good', () => {
    expect(evaluateRun('r', req, killed, false).verdict).toBe('unverified');
  });
});

describe('classify (M0 shapes)', () => {
  const src = [evaluateRun('s1', req, killed, true), evaluateRun('s2', req, killed, true), evaluateRun('s3', req, killed, true)];
  it('establishes the baseline from 3 matching source runs', () => {
    expect(baselineStatus(src)).toEqual({ established: true, matching: 3, contradictions: 0 });
  });
  it('confirms Missing when target runs consistently leave the query running', () => {
    const tgt = [evaluateRun('t1', req, running, true), evaluateRun('t2', req, running, true), evaluateRun('t3', req, running, true)];
    const d = classify({ requirement: req, baselineEstablished: true, sourceRuns: src, targetRuns: tgt });
    expect(d.status).toBe('missing');
    expect(d.explanation).toContain('query.state was "RUNNING"');
  });
  it('does not confirm a gap from a single failing run', () => {
    expect(classify({ requirement: req, baselineEstablished: true, sourceRuns: src, targetRuns: [evaluateRun('t1', req, running, true)] }).status).toBe('uncertain');
  });
  it('marks contradictory target runs uncertain', () => {
    const d = classify({ requirement: req, baselineEstablished: true, sourceRuns: src, targetRuns: [evaluateRun('t1', req, running, true), evaluateRun('t2', req, killed, true)] });
    expect(d.reasonCode).toBe('CONTRADICTORY_TARGET_RUNS');
  });
  it('passes an equivalent target that cancels through a different control (USER_CANCELED)', () => {
    const viaOtherUi = [{ path: 'query.state', value: 'FAILED', status: 'observed' as const }, { path: 'query.errorCode', value: 'USER_CANCELED', status: 'observed' as const }];
    const d = classify({ requirement: req, baselineEstablished: true, sourceRuns: src, targetRuns: [evaluateRun('t1', req, viaOtherUi, true), evaluateRun('t2', req, viaOtherUi, true)] });
    expect(d.status).toBe('preserved');
  });
  it('is untested without an established baseline', () => {
    expect(classify({ requirement: req, baselineEstablished: false, sourceRuns: [], targetRuns: [] }).status).toBe('untested');
  });
});
