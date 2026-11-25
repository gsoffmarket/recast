import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { snapshotProtected, changedFiles, restoreFrom } from '../src/repair.ts';

describe('protected files', () => {
  it('detects edits, additions and deletions and restores only those files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recast-prot-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    await mkdir(join(root, 'specs'));
    await writeFile(join(root, 'specs/a.json'), '{"expected":"FAILED"}');
    await writeFile(join(root, 'specs/b.json'), 'keep');
    await writeFile(join(root, 'specs/wip.json'), 'uncommitted work');
    execFileSync('git', ['add', 'specs/a.json', 'specs/b.json'], { cwd: root });
    const before = await snapshotProtected(root, ['specs']);
    await writeFile(join(root, 'specs/a.json'), '{"expected":"RUNNING"}');
    await writeFile(join(root, 'specs/new.json'), 'planted');
    const after = await snapshotProtected(root, ['specs']);
    const changed = changedFiles(before, after);
    expect(changed).toEqual(['specs/a.json', 'specs/new.json']);
    await restoreFrom(root, before, changed);
    expect(await readFile(join(root, 'specs/a.json'), 'utf8')).toBe('{"expected":"FAILED"}');
    expect(existsSync(join(root, 'specs/new.json'))).toBe(false);
    expect(await readFile(join(root, 'specs/wip.json'), 'utf8')).toBe('uncommitted work');
  });
});
