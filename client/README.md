# AgentPort Client

This directory is the explicit **local/client side** of AgentPort. Install or
copy one physical client directory per AI desktop application so every tool keeps
its own credentials, selected server, logs, and MCP process lifecycle.

## Entrypoints

- `mcp-entry.js`: compatibility bootstrap for Codex, WorkBuddy, Cursor, Windsurf,
  Claude Desktop, and other MCP hosts.
- `mcp-v3.js`: modular MCP implementation with logical servers, immutable request
  contexts, project profiles, idempotency keys, cursor logs, and Worktree
  development sessions.
- `cli-entry.js`: compatibility CLI. New `server`, `project`, `session`, and `v3`
  commands use the modular runtime; every other command delegates to the existing
  root CLI.
- `modular-cli.js`: project-aware modular CLI implementation.
- `session-cli.js`: multi-Agent Worktree session commands.
- `../packages/client-core/`: connection registry, endpoint selection, project
  profiles, session state, request runtime, and development-session client.
- `../packages/client-transport/`: daemon HTTP transport and lazy SSH adapter.
- `../packages/shared/`: operation-specific safety policies and immutable request
  contexts.

## Automatic compatibility mode

`client/mcp-entry.js` uses this order:

1. `AGENTPORT_CLIENT_MODE=legacy` always starts the original root `index.js`.
2. `AGENTPORT_CLIENT_MODE=v3` always starts `mcp-v3.js`.
3. In the default `auto` mode, `local/connections.v3.json` enables V3; otherwise
   the original root MCP implementation starts.

Existing registrations pointing directly to root `index.js` are unchanged.

## V3 connection setup

Copy and edit:

```text
local/connections.v3.json.example -> local/connections.v3.json
local/projects.json.example       -> local/projects.json
```

Set `workspaceId` to the same stable identity advertised by the daemon (for
example `projects`). It identifies the server deployment; it is not a local
filesystem path and it is distinct from individual named workspace roots.

A logical server can contain several endpoints:

```text
debian-main
  -> LAN daemon
  -> virtual-LAN daemon
  -> SSH recovery
```

The client probes endpoint identity and health before each uncached selection.
Mutating operations require matching `serverId` and `workspaceId`; long-running
Jobs and development sessions require a daemon endpoint.

## Named workspace paths

The daemon decides which workspace roots a logical server exposes. Do not infer
them from the local machine or a raw SSH home directory. Use a named path when
the target is not the server's default workspace:

```text
projects:/app/src/index.js
openclaw:/software/app
workspace://openclaw/software/app
```

Relative paths resolve only inside the daemon's default workspace. The client
keeps the returned `workspace`, `relativePath`, and `namedPath` so a follow-up
operation does not silently move back to the default root. Files, search,
commands, Jobs, and development sessions use the same named workspace scope.

An SSH recovery endpoint is a separate transport with the Linux account's own
permissions. It does not expand the daemon's named-workspace boundary.

## Recommended MCP configuration

```json
{
  "mcpServers": {
    "agentport": {
      "command": "node",
      "args": ["ABSOLUTE_PATH/AgentPort/client/mcp-entry.js"],
      "env": {
        "AGENTPORT_CLIENT_MODE": "auto"
      }
    }
  }
}
```

## Modular CLI examples

```bash
node client/cli-entry.js server list --json
node client/cli-entry.js server health debian-main --force
node client/cli-entry.js server select debian-main

node client/cli-entry.js project list
node client/cli-entry.js project status script2shorts
node client/cli-entry.js project run script2shorts build \
  --idempotency-key script2shorts:build:commit-a83f92
node client/cli-entry.js project follow <job-id>
```

Use the explicit V3 namespace for generic Jobs:

```bash
node client/cli-entry.js v3 job start "pnpm test" \
  --server debian-main \
  --cwd projects:/app \
  --idempotency-key app:test:commit-a83f92
node client/cli-entry.js v3 job logs <job-id> --cursor <cursor>
```

## Worktree development sessions

Create one isolated branch and Worktree for an Agent task:

```bash
node client/cli-entry.js session create script2shorts \
  --agent codex-main \
  --task "Fix provider retries"
```

Inspect and run standard project actions:

```bash
node client/cli-entry.js session status <session-id>
node client/cli-entry.js session run <session-id> test \
  --idempotency-key script2shorts:test:commit-a83f92
node client/cli-entry.js session diff <session-id>
```

Commit only the isolated Agent branch:

```bash
node client/cli-entry.js session commit <session-id> \
  --message "Fix provider retry handling"
```

Merge and destructive operations require the Session ID as explicit confirmation:

```bash
node client/cli-entry.js session merge <session-id> \
  --confirm <session-id> \
  --target main

node client/cli-entry.js session cleanup <session-id> \
  --confirm <session-id> \
  --delete-branch
```

AgentPort refuses a normal merge when the primary project checkout is dirty or
when attached Jobs are still active.

## MCP V3 additions

Existing core names remain available, including `remote_read`, `remote_write`,
`remote_bash`, `remote_script`, `remote_exec_async`, and `remote_task`.
The modular MCP also exposes:

- `remote_job_logs`
- `remote_project_list`
- `remote_project_status`
- `remote_project_run`
- `remote_development_overview`
- `remote_session_list`
- `remote_session_create`
- `remote_session_status`
- `remote_session_heartbeat`
- `remote_session_run`
- `remote_session_diff`
- `remote_session_commit`
- `remote_session_rollback`
- `remote_session_merge`
- `remote_session_cleanup`

`remote_exec_async`, `remote_script_async`, `remote_project_run`, and
`remote_session_run` accept `idempotencyKey`. `remote_task` can accept `cursor`
and `maxBytes` to include only new Job output.

## Safety and failover behavior

- read-only calls may retry and move to another verified endpoint
- synchronous commands are never retried after being sent
- persistent Job submissions reuse one idempotency key during transport retry
- Jobs, config operations, and Worktree sessions require a daemon endpoint
- SSH is loaded only when an SSH endpoint is actually selected
- relative paths supplied with `project` stay inside that project root
- every Session uses a unique branch and Worktree
- project-level Git operations use short lease-aware locks
- merge, base rollback, forced cleanup, and branch deletion require explicit
  Session ID confirmation
