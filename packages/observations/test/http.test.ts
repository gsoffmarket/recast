import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fillTemplate, HttpFixture, HttpOracle, pick } from '../src/index.ts';

// A tiny app API: POST /api/items creates an item, GET reads it, DELETE removes it.
// Item 1 flips to "archived" after two reads, to exercise polling.
let server: Server;
let base = '';
const items = new Map<string, { id: string; status: string; reads: number; title: string }>();
const seen: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const m = req.url?.match(/^\/api\/items(?:\/(\w+))?$/);
      const send = (code: number, data?: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
      if (!m) return send(404, { error: 'nope' });
      if (req.method === 'POST') { const id = String(items.size + 1); items.set(id, { id, status: 'active', reads: 0, title: JSON.parse(body).title }); return send(201, { data: { id, title: JSON.parse(body).title } }); }
      const it = items.get(m[1] ?? '');
      if (!it) return send(404, { error: 'not found' });
      if (req.method === 'DELETE') { items.delete(it.id); return send(204); }
      it.reads++;
      if (it.id === '1' && it.reads >= 2) it.status = 'archived';
      return send(200, { status: it.status, meta: { tags: ['a'] } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('templates and paths', () => {
  it('fills variables and env, and refuses unknown names', () => {
    expect(fillTemplate('/x/{{ id }}?t={{env.TOKEN}}', { id: '7' }, { TOKEN: 'abc' })).toBe('/x/7?t=abc');
    expect(() => fillTemplate('{{missing}}', {})).toThrow(/unknown template variable/);
    expect(() => fillTemplate('{{env.NOPE_NOT_SET}}', {}, {})).toThrow(/not set/);
  });
  it('reads dot paths, including array indices and nested objects', () => {
    const d = { data: { items: [{ id: 3 }], ok: true, nested: { a: 1 } } };
    expect(pick(d, 'data.items.0.id')).toBe(3);
    expect(pick(d, 'data.ok')).toBe(true);
    expect(pick(d, 'data.nested')).toBe('{"a":1}');
    expect(pick(d, 'data.missing')).toBeUndefined();
  });
});

describe('HttpFixture and HttpOracle', () => {
  const fixture = () => new HttpFixture({
    type: 'http', identity: 'fresh-item-v1',
    setup: { method: 'POST', url: `${base}/api/items`, headers: { authorization: 'Bearer {{env.RECAST_TEST_TOKEN}}' }, body: { title: 'check {{run}}' }, capture: { item_id: 'data.id', title: 'data.title' } },
    cleanup: { method: 'DELETE', url: `${base}/api/items/{{item_id}}` },
  });
  const oracle = (until = true) => new HttpOracle({
    type: 'http', name: 'app-api', request: { url: `${base}/api/items/{{item_id}}` },
    observe: { 'item.status': 'status', 'item.tags': 'meta.tags' },
    ...(until ? { until: { path: 'item.status', in: ['archived'] } } : {}),
  });

  it('creates a fresh state, captures variables and sends secrets from env', async () => {
    process.env.RECAST_TEST_TOKEN = 'secret-1';
    const { ref, vars } = await fixture().start('run-abc');
    expect(ref).toBe('1');
    expect(vars).toEqual({ run: 'run-abc', item_id: '1', title: 'check run-abc' });
    expect(seen.at(-1)).toBe('POST /api/items Bearer secret-1');
  });

  it('polls until the final value appears and reports the HTTP status', async () => {
    const obs = await oracle().observe({ item_id: '1' }, 5000, 20);
    const byPath = Object.fromEntries(obs.map((o) => [o.path, o.value]));
    expect(byPath).toEqual({ 'http.status': 200, 'item.status': 'archived', 'item.tags': '["a"]' });
    expect(obs.every((o) => o.adapter === 'app-api' && o.status === 'observed')).toBe(true);
  });

  it('stops at the settle time with the last real value when the final value never appears', async () => {
    const { vars } = await fixture().start('run-2');
    const t0 = Date.now();
    const obs = await oracle().observe(vars, 120, 20);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(obs.find((o) => o.path === 'item.status')?.value).toBe('active');
  });

  it('treats a 404 as an observation, not an outage, and cleanup reports the status', async () => {
    const f = fixture();
    const { vars } = await f.start('run-3');
    expect(await f.cleanup(vars)).toBe(204);
    const obs = await oracle(false).observe(vars, 0);
    expect(obs.find((o) => o.path === 'http.status')).toMatchObject({ value: 404, status: 'observed' });
    expect(obs.find((o) => o.path === 'item.status')).toMatchObject({ value: null, status: 'observed', detail: 'HTTP 404' });
  });

  it('marks observations unavailable when the API cannot be reached', async () => {
    const o = new HttpOracle({ type: 'http', name: 'app-api', request: { url: 'http://127.0.0.1:9/api/items/1' }, observe: { 'item.status': 'status' } });
    const obs = await o.observe({}, 0);
    expect(obs.map((x) => x.status)).toEqual(['unavailable', 'unavailable']);
  });

  it('fails setup loudly when the response lacks a captured field', async () => {
    const f = new HttpFixture({ type: 'http', identity: 'x-v1', setup: { method: 'POST', url: `${base}/api/items`, body: { title: 't' }, capture: { order_id: 'data.order.id' } } });
    await expect(f.start('r')).rejects.toThrow(/no value at "data.order.id"/);
  });
});
