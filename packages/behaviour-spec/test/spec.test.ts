import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRequirement, requirementHash, verifyFrozen, compileObjective, FrozenSpecTamperError } from '@recast/behaviour-spec';

const raw = JSON.parse(readFileSync(new URL('../../../evaluation/trino/requirements/REQ-QRY-CANCEL.json', import.meta.url), 'utf8'));

describe('requirement schema', () => {
  it('parses the Trino reference requirement', () => {
    expect(parseRequirement(raw).id).toBe('REQ-QRY-CANCEL');
  });
  it('rejects missing expected values and unknown operators', () => {
    expect(() => parseRequirement({ ...raw, assertions: [{ path: 'query.state', operator: 'equals' }] })).toThrow();
    expect(() => parseRequirement({ ...raw, assertions: [{ path: 'query.state', operator: 'roughly', expected: 'FAILED' }] })).toThrow();
  });
  it('requires a reason for an intended change', () => {
    expect(() => parseRequirement({ ...raw, provenance: 'intended-change' })).toThrow(/reason/);
  });
});

describe('hash and freeze', () => {
  const req = parseRequirement(raw);
  const hash = requirementHash(req, req.fixture);
  it('is stable and ignores evidence lists', () => {
    expect(requirementHash(parseRequirement({ ...raw, source_evidence: ['run-a', 'run-b'] }), req.fixture)).toBe(hash);
  });
  it('changes when an expected value changes', () => {
    const edited = parseRequirement({ ...raw, assertions: [{ path: 'query.state', operator: 'equals', expected: 'RUNNING' }] });
    expect(requirementHash(edited, req.fixture)).not.toBe(hash);
  });
  it('rejects an agent that tampers with a frozen requirement', () => {
    const tampered = { ...req, assertions: [{ path: 'query.state', operator: 'equals' as const, expected: 'RUNNING' }] };
    expect(() => verifyFrozen({ requirement: tampered, hash, fixtureIdentity: req.fixture, frozenAt: '2026-11-25T00:00:00Z' })).toThrow(FrozenSpecTamperError);
    expect(() => verifyFrozen({ requirement: req, hash, fixtureIdentity: req.fixture, frozenAt: '2026-11-25T00:00:00Z' })).not.toThrow();
  });
});

describe('compileObjective', () => {
  const req = parseRequirement(raw);
  it('keeps the same intent text for both UIs and passes values as variables', () => {
    const a = compileObjective(req, { startUrl: 'http://h/ui/', hints: ['Hint.'] }, { query_id: 'q1', username: 'u' });
    const b = compileObjective(req, { startUrl: 'http://h/ui/preview/', hints: ['Hint.'] }, { query_id: 'q2', username: 'u' });
    expect(a.objective).toBe(b.objective);
    expect(a.objective).toContain('{{query_id}}');
    expect(a.variables.query_id).toBe('q1');
  });
  it('fails when an input is missing', () => {
    expect(() => compileObjective(req, { startUrl: 'http://h/', hints: [] }, {})).toThrow(/query_id/);
  });
});
