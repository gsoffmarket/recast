import type { Sql } from '@recast/db';
import { contentHash } from '@recast/shared';

/**
 * The behaviour contract: every frozen requirement of a legacy app, with the evidence that established
 * it, written for whoever rebuilds the app (a team or a coding agent). It says what must keep working and
 * how Recast will check it; it never says how the old UI was built, so a rebuild is free to differ.
 */

export interface ContractStep { step: string; remark: string; status: string }
export interface ContractBehaviour {
  id: string;
  revision: number;
  objective: string;
  actionIntent: string;
  expected: Array<{ path: string; operator: string; expected: unknown }>;
  fixture: string;
  oracle: string;
  provenance: string;
  hash: string;
  frozenAt: string;
  sourceEvidence: string[];
  baseline: { runs: Array<{ id: string; verdict: string | null; observed: Record<string, unknown> }>; steps: ContractStep[]; evidenceSha256: string | null };
  latest: { status: string; explanation: string; at: string } | null;
}
export interface Contract {
  project: string;
  generatedAt: string;
  source: { name: string; url: string } | null;
  targets: string[];
  behaviours: ContractBehaviour[];
  notFrozen: Array<{ id: string; lifecycle: string }>;
  hash: string;
}

export async function buildContract(sql: Sql, projectId: string, projectName: string, cfg: { environments: Array<{ name: string; kind: string; baseUrl: string; startPath: string }> }, generatedAt = new Date().toISOString()): Promise<Contract> {
  const revs = await sql<any[]>`SELECT rr.* FROM requirement_revisions rr JOIN requirements r ON r.project_id = rr.project_id AND r.id = rr.requirement_id AND r.current_revision = rr.revision WHERE rr.project_id = ${projectId} ORDER BY rr.requirement_id`;
  const src = cfg.environments.find((e) => e.kind === 'source');
  const srcEnv = src ? (await sql<any[]>`SELECT id FROM environments WHERE project_id = ${projectId} AND name = ${src.name}`)[0] : undefined;
  const behaviours: ContractBehaviour[] = [];
  const notFrozen: Contract['notFrozen'] = [];
  for (const r of revs) {
    if (!r.frozen_at) { notFrozen.push({ id: r.requirement_id, lifecycle: r.lifecycle }); continue; }
    const runs = srcEnv ? await sql<any[]>`SELECT r.id, r.evaluation, r.evidence_sha256, o.values FROM runs r LEFT JOIN LATERAL (SELECT jsonb_object_agg(path, value) AS values FROM observations WHERE run_id = r.id AND path NOT LIKE 'before:%') o ON true
      WHERE r.project_id = ${projectId} AND r.requirement_id = ${r.requirement_id} AND r.revision = ${r.revision} AND r.kind = 'baseline' AND r.environment_id = ${srcEnv.id} AND r.state = 'completed' ORDER BY r.created_at` : [];
    const good = [...runs].reverse().find((x) => x.evaluation?.verdict === 'satisfied');
    const steps = good ? (await sql<any[]>`SELECT payload FROM run_events WHERE run_id = ${good.id} AND type = 'kane.step' ORDER BY seq`).map((e) => ({ step: String(e.payload.step), remark: String(e.payload.remark ?? ''), status: String(e.payload.status ?? '') })) : [];
    const [p] = await sql<any[]>`SELECT status, explanation, created_at FROM parity_results WHERE project_id = ${projectId} AND requirement_id = ${r.requirement_id} AND revision = ${r.revision} AND spec_hash = ${r.hash} AND decision->>'candidateSha' IS NULL ORDER BY created_at DESC LIMIT 1`;
    const b = r.body;
    behaviours.push({
      id: r.requirement_id, revision: r.revision, objective: b.objective, actionIntent: b.action_intent,
      expected: b.assertions, fixture: r.fixture_identity, oracle: b.oracle, provenance: b.provenance, hash: r.hash,
      frozenAt: new Date(r.frozen_at).toISOString(), sourceEvidence: b.source_evidence ?? [],
      baseline: { runs: runs.map((x) => ({ id: x.id, verdict: x.evaluation?.verdict ?? null, observed: x.values ?? {} })), steps: steps.filter((s) => s.status !== 'running'), evidenceSha256: good?.evidence_sha256 ?? null },
      latest: p ? { status: p.status, explanation: p.explanation, at: new Date(p.created_at).toISOString() } : null,
    });
  }
  const body = {
    project: projectName,
    source: src ? { name: src.name, url: new URL(src.startPath, src.baseUrl).toString() } : null,
    targets: cfg.environments.filter((e) => e.kind === 'target').map((e) => e.name),
    behaviours, notFrozen,
  };
  return { ...body, generatedAt, hash: contentHash(body) };
}

const code = (v: unknown) => `\`${typeof v === 'string' ? v : JSON.stringify(v)}\``;
const describe = (a: { path: string; operator: string; expected: unknown }) =>
  (a.operator === 'equals' ? `${code(a.path)} is ${code(a.expected)}` : a.operator === 'not_equals' ? `${code(a.path)} is not ${code(a.expected)}` : `${code(a.path)} is one of ${code(a.expected)}`)
  + (a.path.startsWith('ui.') ? ' (read from the page by Kane)' : '');

/** The contract as a document a person or a coding agent can read before rebuilding. */
export function contractMarkdown(c: Contract): string {
  const target = c.targets[0] ?? '<target>';
  const lines = [
    `# Behaviour contract: ${c.project}`,
    '',
    `Generated by Recast on ${c.generatedAt.slice(0, 10)}. Contract hash \`${c.hash}\`.`,
    '',
    `This is everything the legacy app${c.source ? ` at ${c.source.url}` : ''} was observed to do and that Recast has frozen. Each behaviour was performed on the legacy UI by Kane CLI and its result confirmed in at least two matching runs, then locked with a hash. Results are read from the app's own API, except \`ui.*\` values, which Kane read from the page. A rebuild may look and work differently on screen; it keeps the contract when a user can still achieve each intent and the API shows the same result.`,
    '',
    '## How the rebuild is checked',
    '',
    `Point a target environment at the rebuilt UI, then run \`pnpm recast check --target ${target}\`. Recast has Kane perform every intent below on the new UI twice and reads the result from the API. A behaviour is **Preserved** when every expected result holds in both runs and **Missing** when it fails in both; anything in between is reported as uncertain, never as a pass.`,
    '',
    `## Behaviours (${c.behaviours.length})`,
    '',
  ];
  if (!c.behaviours.length) lines.push('No frozen behaviours yet. Run `pnpm recast capture` or baseline and freeze requirements first.', '');
  c.behaviours.forEach((b, i) => {
    lines.push(`### ${i + 1}. ${b.objective}`, '');
    lines.push(`- **Requirement:** \`${b.id}\` r${b.revision}, frozen ${b.frozenAt.slice(0, 10)}, hash \`${b.hash.slice(0, 23)}…\``);
    lines.push(`- **What the user does:** ${b.actionIntent}`);
    lines.push(`- **Expected result:** ${b.expected.map(describe).join('; ')}`);
    lines.push(`- **Starting state for each run:** fixture \`${b.fixture}\`, read with oracle \`${b.oracle}\``);
    lines.push(`- **Established by:** ${b.baseline.runs.filter((r) => r.verdict === 'satisfied').length} of ${b.baseline.runs.length} legacy runs satisfied${b.baseline.evidenceSha256 ? `; evidence pack \`${b.baseline.evidenceSha256.slice(0, 16)}…\`` : ''}`);
    if (b.latest) lines.push(`- **Latest check:** ${b.latest.status} (${b.latest.at.slice(0, 10)}): ${b.latest.explanation}`);
    if (b.baseline.steps.length) {
      lines.push('', 'How Kane did it on the legacy UI:', '');
      b.baseline.steps.filter((s) => s.remark.trim()).slice(0, 25).forEach((s, n) => lines.push(`${n + 1}. ${s.remark.replace(/\s+/g, ' ').trim()}${s.status === 'failed' ? ' (failed)' : ''}`));
    }
    lines.push('');
  });
  if (c.notFrozen.length) {
    lines.push('## Not in the contract yet', '', 'These requirements exist but are not frozen, so a rebuild is not held to them:', '');
    for (const n of c.notFrozen) lines.push(`- \`${n.id}\`: ${n.lifecycle}`);
    lines.push('');
  }
  return lines.join('\n');
}
