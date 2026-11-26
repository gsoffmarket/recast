import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { describeCli } from '@recast/web';

describe('describeCli', () => {
  it('lists every command, nested ones included, with usage and options', () => {
    const p = new Command().name('recast');
    p.command('new <dir>').description('Scaffold').option('--force', 'overwrite').option('--legacy-url <url>', 'legacy UI', 'http://localhost:3000');
    const reqs = p.command('requirements').description('Manage requirements');
    reqs.command('add <file>').description('Add a revision');
    const cmds = describeCli(p);
    expect(cmds.map((c) => c.name)).toEqual(['new', 'requirements', 'requirements add']);
    expect(cmds[0]).toMatchObject({ usage: 'recast new [options] <dir>', description: 'Scaffold' });
    expect(cmds[0]!.options).toEqual([{ flags: '--force', description: 'overwrite' }, { flags: '--legacy-url <url>', description: 'legacy UI', defaultValue: 'http://localhost:3000' }]);
    expect(cmds[2]).toMatchObject({ usage: 'recast requirements add <file>' });
  });
});
