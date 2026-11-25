import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { contentHash, redact } from '@recast/shared';

/**
 * Kane Exploration import. Reads the map Kane writes for a run (pending-deltas.ndjson: junctions =
 * screens, flows, observations, findings), merges it, and proposes CANDIDATE requirements. Discovery is
 * never proof of behaviour: a candidate becomes a requirement only after real baseline runs.
 */

export interface DiscoveredControl { key: string; role: string; name: string; scope: string; walked: boolean; locator: string | null }
export interface DiscoveredScreen { id: string; name: string; url: string; urlPattern: string; heading: string | null; controls: DiscoveredControl[]; screenshotRef: string | null }
export interface DiscoveredFlow { id: string; name: string; description: string | null; status: string; entry: string | null; exit: string | null; steps: string[] }
export interface DiscoveredFinding { id: string; kind: string; severity: string; title: string }
export interface DiscoveryMap { explorationId: string | null; runId: string | null; screens: DiscoveredScreen[]; flows: DiscoveredFlow[]; findings: DiscoveredFinding[]; hash: string }

export interface CandidateSuggestion {
  key: string;
  kind: 'state_changing_control' | 'verified_flow';
  screen: string | null;
  screenUrl: string | null;
  title: string;
  why: string;
}

const STATE_CHANGING = /\b(kill|cancel|preempt|delete|remove|stop|abort|save|submit|create|update|approve|reject|archive|restart|run|execute)\b/i;

/** Parse the delta stream Kane writes for one exploration run (later deltas win per id). */
export function parseDeltas(text: string, explorationId: string | null = null): DiscoveryMap {
  const screens = new Map<string, DiscoveredScreen>();
  const flows = new Map<string, DiscoveredFlow>();
  const findings = new Map<string, DiscoveredFinding>();
  const stepsByFlow = new Map<string, string[]>();
  let runId: string | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let msg: any;
    try { msg = JSON.parse(line); } catch { continue; }
    const d = msg?.delta;
    if (!d) continue;
    runId = d.run_id ?? runId;
    for (const j of d.junctions ?? []) {
      screens.set(j.id, {
        id: j.id, name: String(j.name ?? ''), url: String(j.url ?? ''), urlPattern: String(j.url_pattern ?? ''), heading: j.heading ?? null,
        controls: (j.affordances ?? []).map((a: any) => ({ key: a.key, role: String(a.role ?? ''), name: String(a.name ?? ''), scope: String(a.scope ?? ''), walked: !!a.walked, locator: a.locators?.[0]?.value ?? null })),
        screenshotRef: j.screenshot_ref ?? null,
      });
    }
    for (const o of d.observations ?? []) {
      const steps = (o.steps ?? []).map((s: any) => String(s?.record?.action_instruction ?? s?.record?.intent ?? '')).filter(Boolean);
      if (o.flow_id && steps.length) stepsByFlow.set(o.flow_id, steps);
    }
    for (const f of d.flows ?? []) flows.set(f.id, { id: f.id, name: String(f.name ?? ''), description: f.description ?? null, status: String(f.status ?? ''), entry: f.entry ?? null, exit: f.exit ?? null, steps: [] });
    for (const f of d.findings ?? []) findings.set(f.id, { id: f.id, kind: String(f.kind ?? ''), severity: String(f.severity ?? ''), title: String(f.title ?? '') });
  }
  for (const [id, steps] of stepsByFlow) { const f = flows.get(id); if (f) f.steps = steps; }
  const body = { screens: [...screens.values()], flows: [...flows.values()], findings: [...findings.values()] };
  return { explorationId, runId, ...body, hash: contentHash(body) };
}

/** Candidate requirements from the map: controls that change state, and flows Kane verified end to end. */
export function suggestCandidates(map: DiscoveryMap): CandidateSuggestion[] {
  const out: CandidateSuggestion[] = [];
  for (const s of map.screens) {
    for (const c of s.controls) {
      if (!['button', 'link', 'menuitem'].includes(c.role) || !STATE_CHANGING.test(c.name)) continue;
      out.push({
        key: `control:${s.urlPattern.replace(/\?.*$/, '')}:${c.name.toLowerCase()}`,
        kind: 'state_changing_control', screen: s.name, screenUrl: s.urlPattern,
        title: `"${c.name}" on ${s.name}`,
        why: c.scope === 'policy_blocked' ? 'State-changing control seen but deliberately not pressed during exploration; its effect needs a baseline run.' : 'State-changing control seen during exploration.',
      });
    }
  }
  for (const f of map.flows) {
    if (f.status !== 'verified' || /^setup$/i.test(f.name)) continue;
    const entry = map.screens.find((s) => s.id === f.entry);
    out.push({ key: `flow:${f.name.toLowerCase()}`, kind: 'verified_flow', screen: entry?.name ?? null, screenUrl: entry?.urlPattern ?? null, title: `Flow: ${f.name}`, why: f.description ?? 'Flow Kane completed and verified.' });
  }
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.key) ? false : (seen.add(c.key), true)));
}

/** Locate the newest run directory Kane wrote for an exploration. */
export async function latestRunDir(explorationId: string, root = join(homedir(), '.testmuai', 'kaneai', 'explorations')): Promise<string> {
  if (!/^[0-9a-f-]{36}$/.test(explorationId)) throw new Error(`not an exploration id: ${explorationId}`);
  const runs = join(root, explorationId, 'runs');
  const names = await readdir(runs);
  const withTimes = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(runs, n))).mtimeMs })));
  const newest = withTimes.sort((a, b) => b.t - a.t)[0];
  if (!newest) throw new Error(`no runs for exploration ${explorationId}`);
  return join(runs, newest.n);
}

export async function readRunMap(runDir: string, explorationId: string | null): Promise<DiscoveryMap> {
  const text = await readFile(join(runDir, 'pending-deltas.ndjson'), 'utf8');
  return parseDeltas(text, explorationId);
}

export const redactUrl = (u: string) => redact(u);
