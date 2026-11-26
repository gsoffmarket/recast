import { describe, expect, it } from 'vitest';
import { buildDocs, extractSection, renderMarkdown, REPO_URL } from '../src/docs.ts';

const r = (md: string, fromFile = 'README.md') => renderMarkdown(md, { fromFile, idPrefix: 'x' });

describe('renderMarkdown', () => {
  it('escapes raw HTML instead of rendering it', () => {
    const { html } = r('Hello <script>alert(1)</script> and <img src=x onerror=y>');
    expect(html).not.toMatch(/<script|<img/);
    expect(html).toContain('&lt;script&gt;');
  });

  it('keeps http links, maps repo paths to GitHub and drops unsafe schemes', () => {
    const { html } = r('[a](https://example.com) [b](docs/guide.md) [c](javascript:alert(1)) [d](#local)', 'README.md');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain(`href="${REPO_URL}/blob/main/docs/guide.md"`);
    expect(html).not.toContain('javascript:');
    expect(html).toMatch(/>c<|\bc\b/);
    const nested = r('[cfg](../evaluation/trino/recast.config.json)', 'docs/your-own-app.md').html;
    expect(nested).toContain(`${REPO_URL}/blob/main/evaluation/trino/recast.config.json`);
  });

  it('renders code fences verbatim, tables, lists and headings with ids', () => {
    const { html, headings } = r('### Set up\n\n```bash\n# not a heading\npnpm install <x>\n```\n\n| A | B |\n|---|---|\n| `x` | **y** |\n\n- one\n- two `z`\n\n1. first\n2. second');
    expect(html).toContain('<h3 id="x--set-up">Set up</h3>');
    expect(html).toContain('<pre data-lang="bash"><code># not a heading\npnpm install &lt;x&gt;</code></pre>');
    expect(html).toContain('<th>A</th>');
    expect(html).toContain('<td><code>x</code></td><td><strong>y</strong></td>');
    expect(html).toContain('<ul><li>one</li><li>two <code>z</code></li></ul>');
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
    expect(headings).toEqual([{ id: 'x--set-up', title: 'Set up' }]);
  });
});

describe('extractSection', () => {
  it('ignores "# comments" inside code fences when finding the end of a section', () => {
    const md = '## A\n\ntext\n\n```bash\n# 1. step\ncmd\n```\n\nmore\n\n## B\n\nother';
    expect(extractSection(md, 'A')).toBe('text\n\n```bash\n# 1. step\ncmd\n```\n\nmore');
    expect(() => extractSection(md, 'Missing')).toThrow(/not found/);
  });
});

describe('buildDocs', () => {
  it('builds every section from the real repo files', async () => {
    const d = await buildDocs(process.cwd(), { commands: [{ name: 'doctor', usage: 'recast doctor', description: 'Preflight', options: [] }], globals: [{ flags: '--json', description: 'machine-readable output' }] });
    expect(d.sections.map((s) => s.id)).toEqual(['plain', 'quick-start', 'how-it-works', 'capture', 'own-app', 'reproduce', 'cli', 'architecture']);
    for (const s of d.sections) expect(s.html.length, s.id).toBeGreaterThan(300);
    const all = d.sections.map((s) => s.html).join('\n');
    expect(all).toContain('pnpm recast compare --requirement REQ-QRY-CANCEL --target trino-preview --runs 2');
    expect(all).toContain('Does it use my own AI agent?');
    expect(all).toContain('pnpm recast capture --include-linked --candidate');
    expect(all).toContain('pnpm recast new');
    expect(all).not.toMatch(/<script/i);
    expect(all.match(/Writing requirements by hand does not scale/g)).toHaveLength(1);
  });
});
