import { describe, expect, it } from 'vitest';
import { claudeCodeStatus, parseClaudeAuth, parseClaudeVersion } from '@recast/coding-agents';

describe('Claude Code preflight', () => {
  it('reads the version from claude --version', () => {
    expect(parseClaudeVersion('2.1.332 (Claude Code)\n')).toBe('2.1.332');
    expect(parseClaudeVersion('command not found')).toBeNull();
  });

  it('reads only the sign-in state from claude auth status', () => {
    const out = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'someone@example.com', orgName: 'x' });
    const r = parseClaudeAuth(out);
    expect(r).toEqual({ loggedIn: true, authMethod: 'claude.ai' });
    expect(JSON.stringify(r)).not.toContain('example.com');
    expect(parseClaudeAuth('{"loggedIn": false}')).toEqual({ loggedIn: false, authMethod: null });
    expect(parseClaudeAuth('not json')).toEqual({ loggedIn: null, authMethod: null });
  });

  it('reports a missing binary as not found instead of throwing', async () => {
    await expect(claudeCodeStatus('/nonexistent/claude-binary')).resolves.toEqual({ found: false, version: null, loggedIn: null, authMethod: null });
  });
});
