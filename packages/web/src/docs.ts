import { readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

/**
 * The docs page is generated, not written: its sections are cut from the README and docs/*.md, and
 * the CLI reference is read from the CLI's own command definitions. Fixing the docs in the repo fixes
 * the site on the next export, so the two cannot drift apart.
 */

export const REPO_URL = 'https://github.com/gsoffmarket/recast';

export interface DocsHeading { id: string; title: string }
export interface DocsSection { id: string; title: string; lead: string; source: string; html: string; headings: DocsHeading[] }
export interface DocsBundle { sections: DocsSection[]; sources: string[] }

export interface CliOptionInfo { flags: string; description: string; defaultValue?: unknown }
export interface CliCommandInfo { name: string; usage: string; description: string; options: CliOptionInfo[] }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const slug = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/** Resolve a link from a markdown file: anchors and http(s) stay, repo-relative paths go to GitHub, anything else is dropped. */
function linkTarget(href: string, fromFile: string): string | null {
  if (href.startsWith('#')) return null;
  if (/^https?:\/\//i.test(href)) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  const path = normalize(join(dirname(fromFile), href)).replace(/^(\.\.\/)+/, '');
  if (path.startsWith('..')) return null;
  return `${REPO_URL}/blob/main/${path}`;
}

function inline(text: string, fromFile: string): string {
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_m, c: string) => { codes.push(`<code>${esc(c)}</code>`); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
    const raw = href.replace(/&amp;/g, '&');
    const target = linkTarget(raw, fromFile);
    return target ? `<a href="${esc(target)}" target="_blank" rel="noopener">${label}</a>` : label;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]!);
}

/** A small, escaping markdown renderer for the subset the repo docs use. Raw HTML in the source is shown as text. */
export function renderMarkdown(md: string, opts: { fromFile: string; idPrefix: string; headingLevelOffset?: number }): { html: string; headings: DocsHeading[] } {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  const headings: DocsHeading[] = [];
  const off = opts.headingLevelOffset ?? 0;
  let i = 0;
  const isBlockStart = (l: string) => /^(#{1,6}\s|```|\s*[-*]\s|\s*\d+\.\s|\|)/.test(l) || l.trim() === '';
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^```\s*([\w-]*)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) body.push(lines[i++]!);
      i++;
      out.push(`<pre data-lang="${esc(fence[1] || 'text')}"><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const hd = line.match(/^(#{1,6})\s+(.*)$/);
    if (hd) {
      const level = Math.min(6, Math.max(2, hd[1]!.length + off));
      const text = inline(hd[2]!.trim(), opts.fromFile);
      const id = `${opts.idPrefix}--${slug(hd[2]!)}`;
      if (level <= 3) headings.push({ id, title: hd[2]!.replace(/`/g, '').trim() });
      out.push(`<h${level} id="${id}">${text}</h${level}>`);
      i++;
      continue;
    }
    if (line.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.startsWith('|')) {
        const cells = lines[i]!.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-{3,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      out.push(`<div class="table"><table><thead><tr>${(head ?? []).map((c) => `<th>${inline(c, opts.fromFile)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c, opts.fromFile)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const li = line.match(/^\s*([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      const ordered = /\d/.test(li[1]!);
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(/^\s*([-*]|\d+\.)\s+(.*)$/);
        if (m && /\d/.test(m[1]!) === ordered) { items.push(m[2]!); i++; continue; }
        if (lines[i]!.trim() && /^\s{2,}\S/.test(lines[i]!) && items.length) { items[items.length - 1] += ` ${lines[i]!.trim()}`; i++; continue; }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t, opts.fromFile)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !(para.length && isBlockStart(lines[i]!)) && lines[i]!.trim()) para.push(lines[i++]!.trim());
    out.push(`<p>${inline(para.join(' '), opts.fromFile)}</p>`);
  }
  return { html: out.join('\n'), headings };
}

/** The text under a heading, up to the next heading of the same or a higher level. */
export function extractSection(md: string, heading: string): string {
  const lines = md.split('\n');
  // Lines inside fenced code never count as headings (a "# comment" in a bash block is not one).
  let fenced = false;
  const isHeading = lines.map((l) => { if (l.startsWith('```')) { fenced = !fenced; return false; } return !fenced && /^#{1,6}\s/.test(l); });
  const start = lines.findIndex((l, i) => isHeading[i] && l.replace(/^#+\s+/, '').trim() === heading);
  if (start < 0) throw new Error(`docs: heading "${heading}" not found`);
  const level = lines[start]!.match(/^#+/)![0].length;
  const end = lines.findIndex((l, i) => i > start && isHeading[i] && l.match(/^#+/)![0].length <= level);
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

const stripTitle = (md: string) => md.replace(/^#\s+.*\n+/, '');

/** Structural view of a commander program, so this package does not depend on commander. */
interface CommandLike {
  name(): string;
  usage(): string;
  description(): string;
  options: ReadonlyArray<{ flags: string; description: string; defaultValue?: unknown; hidden?: boolean }>;
  commands: ReadonlyArray<CommandLike>;
}

export function describeCli(program: CommandLike): CliCommandInfo[] {
  const out: CliCommandInfo[] = [];
  const walk = (cmd: CommandLike, prefix: string) => {
    for (const c of cmd.commands) {
      const name = `${prefix}${c.name()}`;
      if (c.commands.length && !c.description()) { walk(c, `${name} `); continue; }
      const options = c.options.filter((o) => !o.hidden).map((o) => ({ flags: o.flags, description: o.description, ...(o.defaultValue !== undefined ? { defaultValue: o.defaultValue } : {}) }));
      const usage = `recast ${name} ${c.usage()}`.replace(options.length ? /$^/ : /\s*\[options\]/, '').replace(/\s+/g, ' ').trim();
      out.push({ name, usage, description: c.description(), options });
      if (c.commands.length) walk(c, `${name} `);
    }
  };
  walk(program, '');
  return out;
}

function renderCli(cmds: CliCommandInfo[], globals: CliOptionInfo[]): { html: string; headings: DocsHeading[] } {
  const opt = (o: CliOptionInfo) => `<tr><td><code>${esc(o.flags)}</code></td><td>${esc(o.description)}${o.defaultValue !== undefined && o.defaultValue !== false ? ` <span class="def">default ${esc(String(o.defaultValue))}</span>` : ''}</td></tr>`;
  const headings: DocsHeading[] = [];
  const parts = [
    `<p>Run every command from the repository root as <code>pnpm recast &lt;command&gt;</code>. Global options apply to all of them.</p>`,
    `<div class="table"><table><thead><tr><th>Global option</th><th>What it does</th></tr></thead><tbody>${globals.map(opt).join('')}</tbody></table></div>`,
    `<p>Exit codes: <code>0</code> ok, <code>1</code> confirmed gap, <code>2</code> invalid configuration, <code>3</code> inconclusive or infrastructure, <code>4</code> cancelled.</p>`,
  ];
  for (const c of cmds) {
    const id = `cli--${slug(c.name)}`;
    headings.push({ id, title: c.name });
    parts.push(`<div class="cmd-doc"><h3 id="${id}"><code>${esc(c.name)}</code></h3><p>${esc(c.description)}</p><pre data-lang="bash"><code>${esc(c.usage.replace(/^recast /, 'pnpm recast '))}</code></pre>${c.options.length ? `<div class="table"><table><tbody>${c.options.map(opt).join('')}</tbody></table></div>` : ''}</div>`);
  }
  return { html: parts.join('\n'), headings };
}

/** Build every docs section from the repo. Throws if a heading the page relies on has moved, so a stale page is never exported. */
export async function buildDocs(root: string, cli: { commands: CliCommandInfo[]; globals: CliOptionInfo[] }): Promise<DocsBundle> {
  const read = (rel: string) => readFile(join(root, rel), 'utf8');
  const [readme, ownApp, arch] = await Promise.all([read('README.md'), read('docs/your-own-app.md'), read('docs/architecture.md')]);
  const md = (id: string, title: string, lead: string, source: string, text: string, offset = 0): DocsSection => {
    const r = renderMarkdown(text, { fromFile: source, idPrefix: id, headingLevelOffset: offset });
    return { id, title, lead, source, html: r.html, headings: r.headings };
  };
  const quick = `${extractSection(readme, 'Reproduce it').split('\n### ')[0]}\n\n### Prerequisites\n\n${extractSection(readme, 'Prerequisites')}\n\n### Set up\n\n${extractSection(readme, 'Quick start')}`;
  const cliDoc = renderCli(cli.commands, cli.globals);
  const sections: DocsSection[] = [
    md('plain', 'Recast in plain terms', 'What Recast does, who does what, and whose AI it uses, without the jargon.', 'README.md', extractSection(readme, 'Recast in plain terms')),
    md('quick-start', 'Quick start', 'Install, start the services and check everything with recast doctor.', 'README.md', quick),
    // Capture has its own section, so it is cut out of How it works rather than shown twice.
    md('how-it-works', 'How it works', 'Observe, freeze, compare, repair and prove: the loop and how it is built.', 'README.md', extractSection(readme, 'How it works').replace(`### Freezing a whole app before a rebuild\n\n${extractSection(readme, 'Freezing a whole app before a rebuild')}`, '')),
    md('capture', 'Freeze an app before a rebuild', 'Capture what the legacy app does with no hand-written expectations, hand it over as a contract, and check the rebuild.', 'README.md', extractSection(readme, 'Freezing a whole app before a rebuild')),
    md('own-app', 'Use it on your own app', 'Describe your app in JSON with recast new, then write requirements or capture them. Apps with an HTTP API need no code.', 'docs/your-own-app.md', stripTitle(ownApp), 1),
    md('reproduce', 'Reproduce the Trino results', 'The exact commands behind every number on this site.', 'README.md', `${extractSection(readme, 'Reproduce the Trino results')}\n\n### Reproduce the capture result\n\n${extractSection(readme, 'Reproduce the capture result')}`),
    { id: 'cli', title: 'CLI reference', lead: 'Every recast command and option, read from the CLI itself.', source: 'packages/cli/src/main.ts', ...cliDoc },
    md('architecture', 'Architecture', 'Packages, one run end to end, classification and the repair loop.', 'docs/architecture.md', stripTitle(arch), 1),
  ];
  return { sections, sources: ['README.md', 'docs/your-own-app.md', 'docs/architecture.md', 'packages/cli/src/main.ts'] };
}
