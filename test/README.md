# AgentPort Tests

All executable regression tests live in this directory. Run them through the
root package scripts so the same commands work locally and in CI.

```bash
npm test                    # Legacy-compatible installation and optional remote probe
npm run test:all            # Full source regression suite
npm run test:workspaces     # Named workspace isolation
npm run test:jobs           # Job worker, persistence, and cleanup
npm run test:sessions       # Git Worktree and project-lock lifecycle
npm run test:security       # Token and response redaction
npm run test:mcp            # Windows hidden-stdio launcher check
```

## Test groups

| Files | Coverage |
| --- | --- |
| `test-architecture.cjs`, `test-client-*.cjs` | Package contracts, endpoint selection, V3 client, MCP, and redaction |
| `test-daemon-*.cjs`, `test-exec-core.cjs` | Gateway routes, command policy, execution queue, and daemon redaction |
| `test-job-*.cjs`, `test-project-lock.cjs` | Durable workers, ownership, cleanup, readiness, and lock safety |
| `test-development-*.cjs` | Git Worktrees, development sessions, diff, commit, merge, and cleanup |
| `test-named-workspaces.cjs` | Multi-root resolution, traversal rejection, and symlink escape protection |
| `test-cli-lifecycle.cjs`, `test-mcp-windowless.cjs` | CLI process lifecycle and Windows no-window launcher behavior |
| `test-privacy-check.cjs`, `test.cjs` | Privacy-guard unit checks and legacy installation diagnostics |

The legacy `test.cjs` intentionally remains because it validates an installed
skill and can perform an optional authenticated remote compatibility probe. It
is not a duplicate of the source-level regression suite.
