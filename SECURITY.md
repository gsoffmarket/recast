# Security

## Reporting

Please report vulnerabilities privately through GitHub's "Report a vulnerability" (Security tab) rather than a public issue.

## How Recast contains the coding agent

- The agent runs headless with an explicit tool allowlist (read, edit, write, search, and the target app's own typecheck, lint and formatter commands). Everything else is denied; web tools, subagents and MCP servers are disabled and no session is saved.
- It works in a sparse git worktree of the target only. Changes outside the allowed folder are rejected.
- Recast snapshots its own verifier code, specs and config before each attempt. Any change is rejected, kept as evidence and reverted.
- Frozen requirement revisions cannot be edited in Postgres (trigger) and their hashes are re-checked before every run.
- The agent's description of its work is stored but never used to decide success; Kane plus the oracle re-run the frozen requirement.

## Data handling

- Secrets live in `.env` (ignored). The database password is random per install.
- Kane share links, UI tokens and home paths are redacted from stored events, reports and fixtures.
- Kane evidence packs are checked for size and path traversal and referenced by hash in reports, never by local path.
- The workspace UI binds to 127.0.0.1 and is read-only.
