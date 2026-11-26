import type { Sql } from '@recast/db';
import { contentHash } from '@recast/shared';

/**
 * Scoped migration acceptance report (FR-34). Every row is a current frozen requirement; untested and
 * uncertain rows count in the denominator. Evidence is referenced by pack hash, never by local path.
 */

export const REPORT_COLUMNS = [
  'requirement_id', 'revision', 'objective', 'role', 'fixture_version', 'source_build', 'target', 'target_commit',
  'expected', 'actual', 'result', 'confidence_basis', 'source_run_ids', 'target_run_ids', 'patch_sha', 'fix_status', 'evidence_refs', 'timestamp',
] as const;
export type ReportRow = Record<(typeof REPORT_COLUMNS)[number], string>;

export interface Report {
  project: string;
  generatedAt: string;
  scope: { frozen: number; notFrozen: number; verified: number; missing: number; uncertain: number; untested: number; intentional: number; fixesVerified: number };
  rows: ReportRow[];
  runs: { total: number; byKind: Record<string, number>; creditsByBalance: number | null };
  tasks: Array<{ id: string; requirement: string; state: string; attempts: number; candidateSha: string | null; branch: string | null }>;
  checks: Array<{ label: string; requirement: string; ref: string; candidateSha: string; expected: string; status: string; verdicts: string[]; asExpected: boolean; regression: unknown }>;
  discovery: { maps: number; screens: number; flows: number; findings: number; candidates: number; linked: Array<{ candidate: string; requirement: string }> };
  versions: Record<string, unknown>;
  hash: string;
}

export async function buildReport(sql: Sql, projectId: string, projectName: string): Promise<Report> {
  const revs = await sql<any[]>`SELECT rr.* FROM requirement_revisions rr JOIN requirements r ON r.project_id = rr.project_id AND r.id = rr.requirement_id AND r.current_revision = rr.revision WHERE rr.project_id = ${projectId} ORDER BY rr.requirement_id`;
  const envs = await sql<any[]>`SELECT * FROM environments WHERE project_id = ${projectId}`;
  const envById = new Map(envs.map((e) => [e.id, e]));
  const rows: ReportRow[] = [];
  const scope = { frozen: 0, notFrozen: 0, verified: 0, missing: 0, uncertain: 0, untested: 0, intentional: 0, fixesVerified: 0 };

  for (const r of revs) {
    if (!r.frozen_at) { scope.notFrozen++; continue; }
    scope.frozen++;
    // Status on the real target comes only from target runs; a verified candidate fix is reported separately.
    const [p] = await sql<any[]>`SELECT * FROM parity_results WHERE project_id = ${projectId} AND requirement_id = ${r.requirement_id} AND revision = ${r.revision} AND spec_hash = ${r.hash} AND decision->>'candidateSha' IS NULL ORDER BY created_at DESC LIMIT 1`;
    const [fix] = await sql<any[]>`SELECT decision->>'candidateSha' AS sha, status, created_at FROM parity_results WHERE project_id = ${projectId} AND requirement_id = ${r.requirement_id} AND revision = ${r.revision} AND spec_hash = ${r.hash} AND decision->>'candidateSha' IS NOT NULL ORDER BY created_at DESC LIMIT 1`;
    if (fix?.status === 'preserved' && p?.status !== 'preserved') scope.fixesVerified++;
    const status: string = p?.status ?? 'untested';
    if (status === 'preserved') scope.verified++; else if (status === 'intentional_change') { scope.intentional++; scope.verified++; } else if (status === 'missing') scope.missing++; else if (status === 'uncertain') scope.uncertain++; else scope.untested++;
    const d = p?.decision ?? {};
    const srcIds: string[] = d.sourceRuns ?? [];
    const tgtIds: string[] = d.targetRuns ?? [];
    const tgtRuns = tgtIds.length ? await sql<any[]>`SELECT r.*, o.values FROM runs r LEFT JOIN LATERAL (SELECT jsonb_object_agg(path, value) AS values FROM observations WHERE run_id = r.id) o ON true WHERE r.id = ANY(${tgtIds})` : [];
    const srcRuns = srcIds.length ? await sql<any[]>`SELECT * FROM runs WHERE id = ANY(${srcIds})` : [];
    const srcEnv = srcRuns[0] ? envById.get(srcRuns[0].environment_id) : envs.find((e) => e.kind === 'source');
    const tgtEnv = tgtRuns[0] ? envById.get(tgtRuns[0].environment_id) : undefined;
    const evidence = [...srcRuns, ...tgtRuns].map((x) => x.evidence_sha256).filter(Boolean).map((h: string) => `sha256:${h.slice(0, 16)}`);
    rows.push({
      requirement_id: r.requirement_id,
      revision: String(r.revision),
      objective: r.body.objective,
      role: r.body.role,
      fixture_version: r.fixture_identity,
      source_build: srcEnv?.fingerprint?.version ? `trino ${srcEnv.fingerprint.version} ${srcEnv.start_path}` : '',
      target: tgtEnv ? `${tgtEnv.name} ${tgtEnv.start_path}` : '',
      target_commit: d.candidateSha ?? '',
      expected: r.body.assertions.map((a: any) => `${a.path} ${a.operator} ${JSON.stringify(a.expected)}`).join('; '),
      actual: tgtRuns.length ? JSON.stringify(tgtRuns[0].values ?? {}) : '',
      result: status,
      confidence_basis: p ? `${p.reason_code}; ${srcIds.length} source / ${tgtIds.length} target runs; comparator ${p.comparator_version}; oracle ${r.body.oracle}` : 'no qualifying run for the current revision',
      source_run_ids: srcIds.map((x) => x.slice(0, 8)).join(' '),
      target_run_ids: tgtIds.map((x) => x.slice(0, 8)).join(' '),
      patch_sha: fix?.status === 'preserved' ? fix.sha : '',
      fix_status: fix ? `${fix.status} on candidate` : '',
      evidence_refs: evidence.join(' '),
      timestamp: p ? new Date(p.created_at).toISOString() : '',
    });
  }

  const kinds = await sql<{ kind: string; n: number }[]>`SELECT kind, count(*)::int AS n FROM runs WHERE project_id = ${projectId} GROUP BY kind`;
  const [credits] = await sql<{ spent: string | null }[]>`SELECT sum(credits_balance_before - credits_balance_after) AS spent FROM runs WHERE project_id = ${projectId} AND credits_balance_after IS NOT NULL`;
  const tasks = await sql<any[]>`SELECT t.id, t.requirement_id, t.state, count(a.id)::int AS attempts, max(a.candidate_sha) FILTER (WHERE a.state = 'verified') AS sha, max(a.branch) FILTER (WHERE a.state = 'verified') AS branch
                                 FROM migration_tasks t LEFT JOIN agent_attempts a ON a.task_id = t.id WHERE t.project_id = ${projectId} GROUP BY t.id ORDER BY t.created_at`;
  const checkRows = await sql<any[]>`SELECT label, requirement_id, ref, candidate_sha, expected, decision->>'status' AS status, verdicts, as_expected, decision->'regression' AS regression FROM candidate_checks WHERE project_id = ${projectId} ORDER BY created_at`;
  const di = await sql<any[]>`SELECT kind, title, status, linked_requirement FROM discovery_items WHERE project_id = ${projectId}`;
  const [maps] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM discoveries WHERE project_id = ${projectId}`;
  const [kv] = await sql<{ v: string | null }[]>`SELECT max(kane_version) AS v FROM runs WHERE project_id = ${projectId}`;
  const body = {
    project: projectName,
    generatedAt: new Date().toISOString(),
    scope,
    rows,
    runs: { total: kinds.reduce((s, k) => s + k.n, 0), byKind: Object.fromEntries(kinds.map((k) => [k.kind, k.n])), creditsByBalance: credits?.spent ? Math.round(Number(credits.spent) * 100) / 100 : null },
    tasks: tasks.map((t) => ({ id: t.id.slice(0, 8), requirement: t.requirement_id, state: t.state, attempts: t.attempts, candidateSha: t.sha, branch: t.branch })),
    checks: checkRows.map((c) => ({ label: c.label, requirement: c.requirement_id, ref: c.ref, candidateSha: c.candidate_sha.slice(0, 10), expected: c.expected, status: c.status, verdicts: c.verdicts, asExpected: c.as_expected, regression: c.regression })),
    discovery: { maps: maps?.n ?? 0, screens: di.filter((x) => x.kind === 'screen').length, flows: di.filter((x) => x.kind === 'flow').length, findings: di.filter((x) => x.kind === 'finding').length, candidates: di.filter((x) => x.kind === 'candidate').length, linked: di.filter((x) => x.kind === 'candidate' && x.linked_requirement).map((x) => ({ candidate: x.title, requirement: x.linked_requirement })) },
    versions: { kaneCli: kv?.v ?? null, environments: Object.fromEntries(envs.map((e) => [e.name, e.fingerprint?.version ?? null])) },
  };
  return { ...body, hash: contentHash(body) };
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toCsv(r: Report): string {
  return [REPORT_COLUMNS.join(','), ...r.rows.map((row) => REPORT_COLUMNS.map((c) => csvCell(row[c])).join(','))].join('\n') + '\n';
}

const label: Record<string, string> = { preserved: 'Preserved', missing: 'Missing', intentional_change: 'Intentional change', uncertain: 'Uncertain', untested: 'Untested' };

export function toMarkdown(r: Report): string {
  const s = r.scope;
  const lines = [
    `# Recast acceptance report: ${r.project}`,
    ``,
    `Generated ${r.generatedAt} · report hash \`${r.hash}\``,
    ``,
    `**${s.verified} of ${s.frozen} frozen in-scope requirements verified.** Missing ${s.missing}${s.fixesVerified ? ` (${s.fixesVerified} with a verified fix awaiting review)` : ''} · Uncertain ${s.uncertain} · Untested ${s.untested} · Intentional change ${s.intentional}. Not yet frozen (excluded): ${s.notFrozen}.`,
    ``,
    `This is scoped acceptance evidence for the requirements listed, not a claim of full feature parity or production readiness.`,
    ``,
    `| Requirement | Result on new UI | Target | Expected | Actual | Basis | Verified fix |`,
    `|---|---|---|---|---|---|---|`,
    ...r.rows.map((x) => `| ${x.requirement_id} r${x.revision} | ${label[x.result] ?? x.result} | ${x.target || '—'} | \`${x.expected}\` | \`${x.actual || '—'}\` | ${x.confidence_basis} | ${x.patch_sha ? `\`${x.patch_sha.slice(0, 10)}\`` : '—'} |`),
    ``,
    `## Runs and cost`,
    `${r.runs.total} runs (${Object.entries(r.runs.byKind).map(([k, n]) => `${k} ${n}`).join(', ')}). Kane credits by balance delta: ${r.runs.creditsByBalance ?? 'unknown'}.`,
    ``,
    `## Repair tasks`,
    ...(r.tasks.length ? r.tasks.map((t) => `- ${t.id} ${t.requirement}: ${t.state}, ${t.attempts} attempt(s)${t.candidateSha ? `, verified candidate \`${t.candidateSha.slice(0, 10)}\` on \`${t.branch}\`` : ''}`) : ['- none']),
    ``,
    `## Discovery (Kane Exploration)`,
    r.discovery.maps ? `${r.discovery.maps} imported map(s): ${r.discovery.screens} screens, ${r.discovery.flows} flows, ${r.discovery.findings} findings, ${r.discovery.candidates} candidate requirements. Discovery shows what exists, not what it does.` : 'No exploration imported.',
    ...r.discovery.linked.map((l) => `- ${l.candidate} → ${l.requirement}`),
    ``,
    `## Candidate checks (not counted as parity)`,
    `Operator-written harness patches and unpatched controls that prove the re-verify path. They never count toward the verified total.`,
    ...(r.checks.length ? r.checks.map((c) => `- ${c.label} on ${c.requirement} (\`${c.ref}\` @ \`${c.candidateSha}\`): ${c.status}, runs ${c.verdicts.join(', ')}; expected ${c.expected} → ${c.asExpected ? 'as expected' : 'NOT as expected'}`) : ['- none']),
    ``,
    `## Versions`,
    `Kane CLI ${r.versions.kaneCli ?? 'unknown'}; environments: ${Object.entries(r.versions.environments as Record<string, unknown>).map(([k, v]) => `${k} ${v ?? '?'}`).join(', ')}.`,
    ``,
    `## Evidence`,
    ...r.rows.map((x) => `- ${x.requirement_id}: source runs ${x.source_run_ids || '—'}; target runs ${x.target_run_ids || '—'}; packs ${x.evidence_refs || '—'}`),
    '',
  ];
  return lines.join('\n');
}
export * from './contract.ts';
