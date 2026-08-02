# AgentPort

Version 3.1 remote development gateway for MCP, CLI, SSH recovery, durable Jobs,
Git Worktree sessions, and named workspace isolation.

Enable AI Agents to develop on remote Linux servers through the most stable
available channel: native MCP tools, CLI fallback, daemon HTTP APIs, SSH
recovery, and persistent remote jobs.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-3.1.0-blue)](https://github.com/knownothing20/agentport)

[中文文档](./README_CN.md)

---

## One-line Summary

Give AI Agents a stable remote development gateway: direct file operations,
command execution, diagnostics, long-running job control, and recovery paths
when a desktop tool's native MCP transport is unavailable or unstable.

**Analogy**: VS Code Remote SSH is for humans; agentport is for AI.

---

## Architecture Overview

`AgentPort` has a local client side and a remote Linux daemon side. One daemon
can serve many AI desktop applications; every application keeps its own local
configuration and credential material.

```text
AI desktop tool
  -> native MCP (short structured work) / CLI fallback / SSH recovery
  -> local client runtime and private local/ configuration
  -> public development gateway (default port 3183)
       -> development-session API
       -> modular file, search, exec, and Job services
       -> loopback legacy dashboard and management compatibility service
  -> explicitly configured remote workspace roots
```

The local client registers MCP tools when available, provides a CLI fallback,
reads only private connection configuration, and turns daemon errors into
agent-readable messages. The remote daemon performs token authentication, path
checks, file operations, command execution, durable Job control, Worktree
sessions, audit logging, health checks, Dashboard responses, and configuration
reload.

For desktop tools that spawn multiple MCP stdio children per software, agentport
now keeps one local "core" process per software key and lets other sessions
attach through a localhost proxy broker. This reduces duplicate connection churn
without forcing single-session usage.

Remote setup safety policy:
- `remote_setup` defaults to client-only mode (`deploy=false`).
- Existing remote daemon files are not overwritten by default.
- Overwrite requires explicit `deploy=true` and `forceDeploy=true`.
- For existing servers, use `node cli.js client provision` to create or reuse
  one token for the current machine/software. Do not ask agents to print or
  manually copy raw `AUTH_TOKENS` values.
- For first-time server bootstrap, run read-only detection first, then deploy
  once from one operator computer, then provision each other client separately.
- For multi-computer usage, do not share one token. Create one unique
  `clientId=token` per computer/software.

For design rationale, deployment model, and security boundaries, see
the project documentation in this repository.

---

## Core Features

| Feature | Description |
|---------|-------------|
| Named Workspace Isolation | Multiple non-overlapping roots with traversal and symlink-escape protection |
| Remote File R/W | `remote_read`, `remote_write`, and `remote_stat` return workspace-aware paths |
| Remote Search | Bounded `remote_glob` and `remote_grep` searches inside an authorized workspace |
| Command Execution | `remote_bash` for short commands and `remote_script` for short multi-line scripts |
| Persistent Jobs | Detached Jobs for builds, tests, logs, follow-up, cancellation, and restart recovery |
| Development Sessions | Per-task Git branches and Worktrees with diff, commit, merge, rollback, and cleanup guards |
| Native MCP and CLI | Structured `remote_*` tools plus a stable CLI fallback and SSH recovery route |
| Logical Servers | LAN, virtual-LAN, and SSH endpoints can share one server identity |
| Execution Backpressure | Queue state, concurrency limits, timeouts, and process-tree cleanup |
| Token and Audit Controls | Per-client tokens, redacted responses, audit logging, and optional Dashboard administration |

---

## Named Workspaces

Version 3.1 can expose more than one remote root without granting the daemon
access to the rest of the server. Each root has a stable name and roots must not
overlap.

```json
{
  "default": "projects",
  "roots": {
    "projects": "/home/YOUR_USER/workspace",
    "openclaw": "/home/YOUR_USER/.openclaw"
  }
}
```

Save this as `workspaces.json` beside the daemon environment file, then set:

```dotenv
WORKSPACE_ROOT=/home/YOUR_USER/workspace
DEFAULT_WORKSPACE=projects
WORKSPACE_ROOTS_FILE=./workspaces.json
```

The daemon accepts all of these forms:

| Input | Meaning |
| --- | --- |
| `projects:/app/README.md` | Explicit path inside the `projects` root |
| `openclaw:/software/app` | Explicit path inside the `openclaw` root |
| `workspace://openclaw/software/app` | URI form of the same named path |
| `relative/path` | Path inside the default workspace only |

File, search, command, Job, and development-session operations all retain this
workspace scope. Paths outside every configured root, `..` traversal, and
symlinks escaping a root are rejected with `EWORKSPACE`.

This is a daemon/MCP boundary. A person or an agent using direct SSH still has
the Linux account permissions granted to that SSH connection.

---

## Remote Search Dependencies

`remote_grep` does not require ripgrep: daemon mode uses bounded Node-based
search and SSH recovery uses bounded `grep`. For agents that run direct shell
searches, install the optional `ripgrep` package to provide `rg`:

```bash
sudo apt update
sudo apt install -y ripgrep
command -v rg
```

`node cli.js doctor` reports whether `rg` is available for each SSH connection.
When it is missing, agents should feature-detect it and fall back silently to a
project-scoped `grep` search rather than running a known-missing command.

---

## Agent Integration Priority

`agentport` is a remote development gateway with multiple runtime channels.
Choose by task type:

1. **Native MCP for short structured operations**: if `remote_*` tools are
   healthy, use them for a windowless local workflow.
2. **CLI daemon gateway for long-running development**: use `safe-job` and
   persistent `job` commands for tests, builds, installs, polling, and logs.
3. **SSH-first CLI as the recovery path**: use `--route ssh` when native MCP or
   daemon transport is unavailable. Synchronous commands time out by default.
4. **HTTP/manual last**: only use direct REST calls or manual commands when SSH,
   daemon, and native MCP are all unavailable.

CLI fallback examples:

```bash
node cli.js doctor
node cli.js list
node cli.js connect <connection-name>
node cli.js health
node cli.js ssh-health
node cli.js health --route ssh
node cli.js read projects:/AGENTS.md --connection <daemon> --route daemon
node cli.js glob "**/*.js" --cwd openclaw:/software/app --connection <daemon> --route daemon
node cli.js bash "pwd && ls -la" --cwd projects:/app --connection <daemon> --route daemon
node cli.js bash "pwd && ls -la" --cwd /path/to/workspace --connection <ssh> --route ssh --json
node cli.js write projects:/tmp.txt --content "hello" --connection <daemon> --route daemon
```

Provision a daemon token for a new AI software or new computer:

```bash
# First make sure an SSH connection to the server exists in local/connections.json.
node cli.js ssh-health --connection <ssh-connection> --route ssh --json

# Create or reuse a unique token, write it to the remote daemon config, and
# store only this software's daemon connection in its own local/connections.json.
node cli.js client provision \
  --client-id <machine-software> \
  --connection <admin-daemon-connection> \
  --route daemon \
  --daemon-name <machine-software-daemon> \
  --local-dir <skill-dir> \
  --json
```

If the current daemon does not yet support raw admin config reads, run the same
command with `--route ssh --connection <ssh-connection>`, then reload or restart
the daemon before validating the newly created token. The command only prints a
masked token.

For long-running development tasks, use the persistent daemon job gateway:

```bash
node cli.js status
node cli.js job start "npm test" --cwd /path/to/workspace
node cli.js safe-job local-build.sh --cwd /path/to/workspace --job-timeout-ms 1800000
node cli.js job status <job-id>
node cli.js job logs <job-id> --tail 200
node cli.js job cancel <job-id>
node cli.js job list --limit 20
```

The job gateway is designed for AI tools whose native MCP stdio transport may
disconnect during long work. Jobs continue inside the remote daemon, and the AI
can reconnect through the CLI to inspect status and logs.

When daemon transport is unhealthy, use lightweight SSH jobs as a recovery path:

```bash
node cli.js job start "sleep 30" --route ssh
node cli.js job status <job-id> --route ssh
node cli.js job logs <job-id> --route ssh --json
node cli.js job cancel <job-id> --route ssh
```

For shared-link disconnect diagnostics, use the built-in SSH trace tool:

```bash
node cli.js trace start ssh-link --route ssh --interval 2
node cli.js trace status ssh-link --route ssh --json
node cli.js trace logs ssh-link --route ssh --tail 120
node cli.js trace stop ssh-link --route ssh
```

Trace logs are written on the remote host under `~/.agentport/trace/<name>.log`.

See [AGENT_GUIDE.md](./AGENT_GUIDE.md) for the full install and agent bootstrap
workflow.

---

## Execution Backpressure

The remote daemon protects itself with an execution slot queue:

| Setting | Default | Description |
|---------|---------|-------------|
| `EXEC_TIMEOUT_MS` | `120000` | Timeout for a running command |
| `EXEC_MAX_CONCURRENCY` | `4` | Maximum commands running at the same time |
| `EXEC_QUEUE_TIMEOUT_MS` | `15000` | Maximum time a request waits for an execution slot |

When all execution slots are busy, new command requests wait in a queue. If the
queue wait exceeds `EXEC_QUEUE_TIMEOUT_MS`, the daemon returns HTTP `429` with
the current `exec` state:

```json
{
  "error": "Too many concurrent exec operations",
  "exec": {
    "running": 4,
    "max": 4,
    "queued": 1,
    "timeoutMs": 120000,
    "queueTimeoutMs": 15000
  }
}
```

`remote_health` also reports this `exec` state, which helps distinguish service
disconnects from an overloaded execution queue.

---

## Quick Start

### Fresh Agent Install Against An Existing Daemon

Use this path when a new AI software installs AgentPort for an already running
remote daemon.

### 1. Clone Into This Software's Skill Directory

```bash
git clone https://github.com/knownothing20/agentport.git
cd agentport
npm install
```

Each AI software should have its own physical AgentPort directory. Do not use a
junction when different tools need different credentials.

### 2. Create SSH-Only Local Config

Create `local/connections.json` from the example and fill in only SSH first:

```bash
cp local/connections.json.example local/connections.json
```

Example:

```json
{
  "connections": [
    {
      "name": "ssh-main",
      "type": "ssh",
      "host": "192.0.2.10",
      "port": 22,
      "username": "leon",
      "privateKey": "~/.ssh/id_rsa"
    }
  ],
  "default": "ssh-main"
}
```

Verify the SSH baseline:

```bash
node cli.js ssh-health --connection ssh-main --route ssh --json
```

### 3. Provision This Software's Daemon Token

If this fresh install does not already have an admin daemon connection, use SSH
provisioning:

```bash
node cli.js client provision \
  --client-id <machine-software> \
  --connection ssh-main \
  --route ssh \
  --daemon-url http://192.0.2.10:3183 \
  --daemon-name daemon-main \
  --local-dir . \
  --json
```

If the remote daemon was not hot-reloaded by the command, reload or restart it,
then run the same provision command again. A successful result reports
`verification.ok: true` and prints only `tokenMasked`.

Validate with an authenticated endpoint:

```bash
node cli.js job list --connection daemon-main --route daemon --limit 1 --json
```

### 4. Register Native MCP If Needed

If the target AI tool supports MCP servers, create `local/agentport.json`, set
`skillDir` and `mcpConfigPath`, then run:

```bash
cp agentport.example.json local/agentport.json
node sync.cjs
```

Restart the AI tool after MCP registration changes.

### Install on another computer or AI software

For a new computer or another AI desktop tool, use the same SSH-first flow. See
[INSTALL_OTHER_MACHINE.md](./INSTALL_OTHER_MACHINE.md).

### CLI Guided Setup

The interactive wizard can help create SSH connections, but the non-interactive
SSH-first flow above is the recommended path for agents:

```bash
npm run setup
```

### Deploy or upgrade the remote daemon

Only one operator should deploy a daemon. Normal client installation must not
overwrite an existing server. For 3.1, deploy the complete release together:
`daemon/`, `packages/daemon-core/`, `server/`, and the root package files.
Copying only `server/` keeps the legacy daemon working but does not provide the
modular file, Job, or development-session services.

On the remote server, install dependencies for both package roots and start the
public development gateway:

```bash
cd /opt/agentport
npm ci
npm --prefix server ci
npm run start:daemon
```

Before activating an upgrade, validate the release in a separate directory.
Keep the prior release available for rollback, update the service's release
pointer, restart the service, then verify `GET /healthz` and an authenticated
`node cli.js health --route daemon --json` call. Do not copy a real `.env` or a
token into source control; keep them in the daemon's private configuration
directory.

---

## Supported AI Tools

| AI Tool | MCP Config Path (Windows) | MCP Config Path (macOS/Linux) |
|---------|---------------------------|-------------------------------|
| WorkBuddy | `C:\Users\<user>\.workbuddy\mcp.json` | `~/.workbuddy/mcp.json` |
| Claude Desktop | `C:\Users\<user>\AppData\Roaming\Claude\claude_desktop_config.json` | `~/.config/Claude/claude_desktop_config.json` |
| Cursor | `<project>\.cursor\mcp.json` | `<project>/.cursor/mcp.json` |
| Windsurf | `C:\Users\<user>\.codeium\windsurf\mcp_config.json` | `~/.codeium/windsurf/mcp_config.json` |
| Tools without custom MCP | Use `node cli.js ...` through Bash/terminal | Use `node cli.js ...` through Bash/terminal |

---

## Tool List

| Tool | Function |
|------|----------|
| `remote_ssh_info` | Scan local SSH environment (keys, config, known hosts) |
| `remote_health` | Check remote service reachability |
| `remote_read` | Read remote file (ETag cache) |
| `remote_write` | Write remote file (auto clean CRLF/BOM) |
| `remote_stat` | Get file metadata |
| `remote_glob` | Search by glob pattern |
| `remote_grep` | Search remote file contents |
| `remote_bash` | Execute remote command |
| `remote_script` | Execute multi-line script |
| `remote_script_async` | Submit a multi-line script as a persistent job |
| `remote_batch` | Batch operations |
| `remote_exec_async` | Async execution |
| `remote_task` | Query async task |
| `remote_config` | Config hot reload |
| `remote_status` | Connection diagnostics |
| `remote_job_logs` | Read incremental Job logs with a cursor |
| `remote_project_*` | List, inspect, and run configured project actions |
| `remote_session_*` | Create and manage isolated Worktree development sessions |

For detailed usage, see [SKILL.md](./SKILL.md)

---

## Directory Structure

```
agentport/
|-- client/                         # Local MCP and CLI entrypoints
|-- daemon/                         # Public gateway and daemon configuration loader
|-- packages/
|   |-- client-core/                 # Connection, project, and Session client runtime
|   |-- client-transport/            # Daemon HTTP and lazy SSH transport
|   |-- daemon-core/                 # Path guards, file, exec, Job, and Session services
|   `-- shared/                      # Shared safety and request-context policies
|-- server/                          # Legacy dashboard and management compatibility service
|-- local/                           # Ignored private client configuration and logs
|-- docs/                            # Architecture and development-session documentation
|-- SKILL.md                         # Short runtime contract for AI agents
|-- AGENT_GUIDE.md                   # Install and usage guide
|-- cli.js / index.js                # Legacy-compatible CLI and MCP entrypoints
|-- sync.cjs                         # Skill and MCP configuration synchronizer
|-- test/                            # Cross-platform regression tests and test guide
`-- CHANGELOG.md                     # Version history
```

## Configuration Files

| File | Location | Description |
|------|----------|-------------|
| `local/connections.json` | Per client | Legacy-compatible SSH and daemon connection data |
| `local/connections.v3.json` | Per client | Logical server, endpoint, identity, and token configuration |
| `local/projects.json` | Per client | Named project profiles and standard commands |
| daemon `.env` | Remote daemon | Port, tokens, execution limits, and workspace defaults |
| `workspaces.json` | Remote daemon | Named workspace roots; see `daemon/workspaces.json.example` |

See [`local/config-guide.md`](./local/config-guide.md) for detailed configuration guide.

---

## Dashboard

agentport provides a Web Dashboard for monitoring and management:

### Enable Dashboard

Set in `local/agentport.json`:

```json
{
  "variables": {
    "serverEnableDashboard": "true"
  }
}
```

### Access Dashboard

After starting the service, visit:
- `http://your-server:3183/?token=<admin-token>`
- `http://your-server:3183/dashboard?token=<admin-token>`

Dashboard uses admin auth. If this software needs Dashboard access, provision or
promote its token with `client provision --admin` instead of editing remote
`.env` by hand.

### Dashboard Features

| Feature | Description |
|---------|-------------|
| Service Status | View Node.js, dependencies, port, disk status |
| Audit Statistics | View request stats, success rate, by type/client analysis |
| Error Logs | View recent error logs |
| Config Management | View and modify server config (requires Admin Token) |

---

## Autostart Configuration

For a 3.1 daemon, use a user-level systemd unit. It keeps the public gateway
under the account that owns the workspace and avoids duplicate manager scripts.

Create `~/.config/systemd/user/agentport.service`:

```ini
[Unit]
Description=AgentPort development gateway
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/agentport
Environment=AGENTPORT_ENV_PATH=/home/YOUR_USER/.agentport/daemon/.env
ExecStart=/usr/bin/node /opt/agentport/daemon/server-entry.cjs
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Load, enable, and inspect it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now agentport.service
systemctl --user status agentport.service
curl -fsS http://127.0.0.1:3183/healthz
```

Do not run multiple copies of `node server.js` or multiple manager scripts for
the same port. The legacy `server/agentport-manager.sh` remains for older
single-process deployments only.

---

## Security Features

- **Named workspace isolation**: File, search, exec, Job, and Session paths are
  restricted to configured non-overlapping roots.
- **Traversal and symlink protection**: `..` traversal and symlinks escaping an
  authorized root are rejected.
- **Token separation**: Use one `clientId=token` per machine and AI software;
  keep tokens only in ignored local configuration or private daemon `.env`.
- **Command policy**: Shell metacharacter policy, interpreter restrictions,
  execution limits, queue limits, and process-tree cleanup protect execution.
- **Explicit destructive actions**: Session merge, rollback, cleanup, and branch
  deletion require explicit Session ID confirmation.
- **Audit and redaction**: Audit logs are stored remotely and API responses mask
  sensitive command and token material.

---

## Version History

See [CHANGELOG.md](./CHANGELOG.md)

---

## License

MIT License - See [LICENSE](./LICENSE)

---

## Contributing

Issues and Pull Requests are welcome!
