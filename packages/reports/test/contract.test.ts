import { describe, expect, it } from 'vitest';
import { contractMarkdown, type Contract } from '@recast/reports';

const contract: Contract = {
  project: 'trino-preview-parity', generatedAt: '2026-11-26T05:00:00.000Z',
  source: { name: 'trino-classic', url: 'http://localhost:8080/ui/' }, targets: ['trino-preview'],
  behaviours: [{
    id: 'REQ-CAP-QUERY-OVERVIEW-KILL', revision: 1, objective: 'A user can use the "Kill" control on Query Overview in the web UI',
    actionIntent: 'Open the query {{query_id}} and use its "Kill" control, using only the web UI.',
    expected: [{ path: 'query.state', operator: 'equals', expected: 'FAILED' }, { path: 'query.errorCode', operator: 'in', expected: ['A', 'B'] }],
    fixture: 'trino-481-running-query-v1', oracle: 'trino-rest-v1', provenance: 'source-observed', hash: 'sha256:0123456789abcdef0123456789', frozenAt: '2026-11-26T04:00:00.000Z',
    sourceEvidence: [], baseline: { runs: [{ id: 'r1', verdict: 'satisfied', observed: {} }, { id: 'r2', verdict: 'satisfied', observed: {} }], steps: [{ step: '1', remark: 'click: Kill', status: 'done' }], evidenceSha256: 'abcdef0123456789abcdef' },
    latest: null,
  }],
  notFrozen: [{ id: 'REQ-DRAFT', lifecycle: 'source-observed' }], hash: 'sha256:feed',
};

describe('contractMarkdown', () => {
  const md = contractMarkdown(contract);
  it('states each behaviour as intent and API result, with how it was established', () => {
    expect(md).toContain('### 1. A user can use the "Kill" control on Query Overview in the web UI');
    expect(md).toContain('`query.state` is `FAILED`; `query.errorCode` is one of `["A","B"]`');
    expect(contractMarkdown({ ...contract, behaviours: [{ ...contract.behaviours[0]!, expected: [{ path: 'ui.total', operator: 'equals', expected: '9' }] }] })).toContain('(read from the page by Kane)');
    expect(md).toContain('2 of 2 legacy runs satisfied');
    expect(md).toContain('1. click: Kill');
  });
  it('tells the rebuild how it will be checked, and lists what is not held yet', () => {
    expect(md).toContain('pnpm recast check --target trino-preview');
    expect(md).toContain('`REQ-DRAFT`: source-observed');
  });
  it('says so when nothing is frozen', () => {
    expect(contractMarkdown({ ...contract, behaviours: [] })).toContain('No frozen behaviours yet');
  });
});
