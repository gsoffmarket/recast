import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { compileObjective, parseRequirement } from '@recast/behaviour-spec';
import { makeAdapters, navFor, oracleMatches, parseProjectConfig, type EnvironmentConfig } from '@recast/runner';
import { scaffoldFiles, scaffoldProject } from '../src/scaffold.ts';

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

describe('project config', () => {
  it('still accepts the Trino reference config unchanged', async () => {
    const cfg = parseProjectConfig(JSON.parse(await readFile('evaluation/trino/recast.config.json', 'utf8')));
    const a = makeAdapters(cfg);
    expect([a.fixtureIdentity, a.oracleName]).toEqual(['trino-481-running-query-v1', 'trino-rest-v1']);
    for (const id of ['CANCEL', 'OWNER', 'PREEMPT']) {
      const req = parseRequirement(JSON.parse(await readFile(`evaluation/trino/requirements/REQ-QRY-${id}.json`, 'utf8')));
      expect(req.fixture).toBe(a.fixtureIdentity);
      expect(oracleMatches(req.oracle, a.oracleName)).toBe(true);
    }
    expect(oracleMatches('trino-rest-v1+something-else', 'trino-rest-v1')).toBe(false);
  });

  it('explains what is wrong with a bad config', () => {
    const base = { name: 'x-app', role: { username: 'u' }, kane: { maxSteps: 15, timeoutSec: 480 }, budget: { minBalance: 0 } };
    const env = (name: string, kind: string) => ({ name: `env-${name}`, kind, baseUrl: 'http://localhost:3000', startPath: '/' });
    expect(() => parseProjectConfig({ ...base, environments: [env('a', 'source'), env('b', 'source')], fixture: { type: 'none', identity: 'shared-v1' }, oracle: { type: 'http', name: 'n', request: { url: 'http://x' }, observe: { a: 'b' } } })).toThrow(/must be kind .{0,4}target/);
    expect(() => parseProjectConfig({ ...base, environments: [env('a', 'source'), env('b', 'target')], fixture: { type: 'none', identity: 'shared-v1' } })).toThrow(/an .{0,4}oracle.{0,4} is required/);
  });
});

describe('recast new', () => {
  it('writes a config and requirement that validate and wire together', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recast-new-'));
    dirs.push(dir);
    const written = await scaffoldProject(join(dir, 'Shop App'), { legacyUrl: 'http://localhost:4000', newUrl: 'http://localhost:4001', apiUrl: 'http://localhost:4000/', force: false });
    expect(written.map((f) => f.slice(dir.length + 1))).toEqual(['Shop App/recast.config.json', 'Shop App/requirements/REQ-ITEM-ARCHIVE.json', 'Shop App/NEXT_STEPS.md']);
    const cfg = parseProjectConfig(JSON.parse(await readFile(written[0]!, 'utf8')));
    expect(cfg.name).toBe('shop-app');
    expect(cfg.fixture.type === 'http' && cfg.fixture.setup.url).toBe('http://localhost:4000/api/items');
    const a = makeAdapters(cfg);
    const req = parseRequirement(JSON.parse(await readFile(written[1]!, 'utf8')));
    expect([req.fixture, req.oracle]).toEqual([a.fixtureIdentity, a.oracleName]);
    const compiled = compileObjective(req, navFor(cfg.environments[1] as EnvironmentConfig), { run: 'r', item_id: '42', username: cfg.role.username });
    expect(compiled.objective).toContain('item with ID {{item_id}}');
    expect(compiled.variables.item_id).toBe('42');
    expect(await readFile(written[2]!, 'utf8')).toContain('export RECAST_PROJECT=shop-app');
    await expect(scaffoldProject(join(dir, 'Shop App'), { legacyUrl: 'http://a', newUrl: 'http://b', force: false })).rejects.toThrow(/already exists/);
  });

  it('defaults the API to the legacy URL', () => {
    const files = scaffoldFiles('x', { name: 'demo', legacyUrl: 'http://localhost:3000', newUrl: 'http://localhost:3001', force: false });
    expect(JSON.parse(files['recast.config.json']!).oracle.request.url).toBe('http://localhost:3000/api/items/{{item_id}}');
  });
});
