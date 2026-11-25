import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildRepairPrompt, type RepairTask } from '../src/repair.ts';

const task: RepairTask = {
  requirementId: 'REQ-QRY-CANCEL', revision: 1, specHash: 'sha256:abc', objective: 'A user can cancel a running query from that query\'s page in the web UI',
  actionIntent: 'Open the details page of the query with ID {{query_id}}, which is currently running, and cancel that query using only the web UI. Then read the query state shown on its details page and store it as query_state.',
  assertions: [{ path: 'query.state', operator: 'equals', expected: 'FAILED' }],
  source: { environment: 'trino-classic', runs: 2, satisfied: 2, observed: { 'query.state': 'FAILED' }, steps: ['click: Clicking Kill to cancel the query'], networkEffects: [{ method: 'PUT', path: '/ui/api/query/{query_id}/killed', status: 202 }] },
  target: { environment: 'trino-preview', runs: 2, observed: { 'query.state': 'RUNNING' }, failedSteps: ['agent_info: no cancel control'], explanation: 'In all 2 target runs query.state was "RUNNING".' },
};

describe('repair prompt', () => {
  const p = buildRepairPrompt(task, ['Attempt 1 failed the build gate'], ['src/components/QueryList.tsx:TS2322']);
  it('carries the frozen hash, source evidence and target evidence', () => {
    expect(p).toContain('sha256:abc');
    expect(p).toContain('PUT /ui/api/query/{query_id}/killed → 202');
    expect(p).toContain('RUNNING');
    expect(p).toContain('Attempt 1 failed the build gate');
  });
  it('never leaks the historical fix or target file hints', () => {
    // SHA-256 of holdout terms (the later upstream fix's id, release, files and wording), kept hashed so this
    // public repo does not name them. Any token or file name in the prompt matching one fails the test.
    const HOLDOUT = new Set(['22452caad50ec2e532791d278e67c4ad3178061a533fd1a2b9fb40775173e922','d4679c618f1af07ee8570edd4b931e2e68e1c2d4b7d3c2f1033a9b597f85d4b0','06e57b6c6e5e54ad0d062442a23aa56f48bfcd5820b1e3c162fc571b1a97c0ad','6e08f34a9229c515b8e5e2c21a92d0af0f8a63b7ae4c8f8982482bd6939b604c','6360587c777a9ca750f067b5e8e0737e3a3eaa425b8e04694af277dfbaf5458d','216c63c6346d7d78fcd3b1ceeae8c9772b30f8fb2d43b8beabcda6ebd6aa6660','1f460cca89e95beb81233803b227bffd62603782db34cf13aa1a74b5c856b3fd','8c6d2defff235d5e1055fbec07d24f4828271934c0fbc7188fc82aaa7208df60']);
    const tokens = new Set(p.split(/[^A-Za-z0-9._-]+/).flatMap((t) => [t, t.replace(/\.[a-z]+$/, '')]).filter(Boolean));
    const hits = [...tokens].filter((t) => HOLDOUT.has(createHash('sha256').update(t).digest('hex')));
    expect(hits).toEqual([]);
  });
  it('drops the Kane-only "store the state" clause from the intent', () => {
    expect(p).not.toContain('store it as query_state');
  });
});

import { agentUnavailable } from '../src/repair.ts';
describe('agent availability', () => {
  it('treats a usage-limit reply with no tool calls as unavailable, not as a failed attempt', () => {
    expect(agentUnavailable({ isError: true, toolUses: [], finalText: "You've hit your 5-hour limit · resets 11:20pm" })).toBe(true);
    expect(agentUnavailable({ isError: false, toolUses: [], finalText: "You've hit your 5-hour limit" })).toBe(true);
  });
  it('treats an agent that worked and then errored as a real attempt', () => {
    expect(agentUnavailable({ isError: true, toolUses: [{}], finalText: 'error during edit' })).toBe(false);
    expect(agentUnavailable({ isError: false, toolUses: [], finalText: 'Nothing to change.' })).toBe(false);
  });
});
