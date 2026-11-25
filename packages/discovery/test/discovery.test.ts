import { describe, expect, it } from 'vitest';
import { parseDeltas, suggestCandidates } from '@recast/discovery';

const delta = (d: object) => JSON.stringify({ op: 'delta', seq: 1, delta: { run_id: 'run-1', ...d } });
const text = [
  delta({ junctions: [{ id: 'j1', name: 'Query Overview - Trino', url: 'http://h/ui/query.html?q1', url_pattern: 'h/ui/query.html?q1', heading: 'Query', affordances: [
    { key: 'k1', role: 'link', name: 'Kill', scope: 'policy_blocked', walked: false, locators: [{ value: 'role=link[name="Kill"]' }] },
    { key: 'k2', role: 'tab', name: 'Live Plan', scope: 'in', walked: true, locators: [] },
  ] }] }),
  delta({ flows: [{ id: 'f1', name: 'Inspect Query Detail Tabs', status: 'verified', entry: 'j1', exit: 'j1', description: 'Open each tab' }, { id: 'f0', name: 'Setup', status: 'verified' }],
    observations: [{ flow_id: 'f1', steps: [{ record: { action_instruction: 'Click Live Plan' } }] }],
    findings: [{ id: 'x1', kind: 'accessibility', severity: 'medium', title: 'Contrast' }] }),
  'not json',
  JSON.stringify({ op: 'committed', seq: 1 }),
].join('\n');

describe('Kane Exploration import', () => {
  const map = parseDeltas(text, 'exp-1');
  it('merges screens, flows, observation steps and findings', () => {
    expect(map.screens).toHaveLength(1);
    expect(map.screens[0]!.controls.find((c) => c.name === 'Kill')).toMatchObject({ scope: 'policy_blocked', walked: false });
    expect(map.flows.find((f) => f.id === 'f1')!.steps).toEqual(['Click Live Plan']);
    expect(map.findings).toHaveLength(1);
    expect(map.hash).toMatch(/^sha256:/);
  });
  it('proposes the blocked Kill control and the verified flow as candidates, not the setup flow or plain tabs', () => {
    const c = suggestCandidates(map);
    expect(c.map((x) => x.title)).toEqual(['"Kill" on Query Overview - Trino', 'Flow: Inspect Query Detail Tabs']);
    expect(c[0]!.why).toMatch(/not pressed/);
  });
  it('is stable: same map, same hash', () => {
    expect(parseDeltas(text, 'exp-1').hash).toBe(map.hash);
  });
});
