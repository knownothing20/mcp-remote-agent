# AgentPort Daemon

This directory is the explicit **remote/server side** of AgentPort. It runs once
on the Linux development server and serves multiple local AgentPort clients.

## Public gateway and compatibility layers

`server-entry.cjs` now starts three cooperating layers:

```text
LAN / virtual-LAN clients
  -> public development gateway (PORT, default 3183)
       -> Worktree development-session API
       -> loopback modular gateway
            -> daemon-core file, search, exec, and Job services
            -> loopback legacy daemon for dashboard, config, token, and diagnostics
```

Only the development gateway binds to the public LAN address. The modular and
legacy services use dynamically selected `127.0.0.1` ports and remain private to
the server.

## Named workspace isolation

The public daemon exposes only the workspace roots declared in its private
environment and optional `workspaces.json`. Roots must be distinct and must not
contain each other.

```dotenv
WORKSPACE_ROOT=/home/YOUR_USER/workspace
DEFAULT_WORKSPACE=projects
WORKSPACE_ROOTS_FILE=./workspaces.json
```

```json
{
  "default": "projects",
  "roots": {
    "projects": "/home/YOUR_USER/workspace",
    "openclaw": "/home/YOUR_USER/.openclaw"
  }
}
```

`WORKSPACE_ROOTS_JSON` can provide the same object inline for managed
environments. It takes precedence over `WORKSPACE_ROOTS_FILE`; when neither is
present, the daemon remains compatible with the legacy single
`WORKSPACE_ROOT` configuration.

Clients may address a non-default root with `projects:/path`,
`openclaw:/path`, or `workspace://openclaw/path`. Relative paths resolve only
inside the default root. Path traversal, outside paths, overlapping roots, and
symlink escapes are rejected before a file, command, Job, or Session operation
is started.

## Routes owned by the modular gateway

### Files and search

- `/read` and `/api/fs/read`
- `/stat` and `/api/fs/stat`
- `/glob` and `/api/fs/glob`
- `/grep` and `/api/fs/grep`
- `/write` and `/api/fs/write`
- `/api/fs/read-bytes`
- `/api/fs/manifest`
- `/api/fs/remove` and `/api/fs/delete`

### Synchronous execution

- `/bash`
- `/api/exec`
- `/api/cmd/execute`
- `/api/exec/script`
- `/api/batch`

The execution service applies one shared command policy, workspace-bound working
directories, output limits, command timeouts, process-tree cleanup, and a
concurrency queue.

### Persistent Jobs

- `GET|POST /api/jobs`
- `POST /api/jobs/start`
- `POST /api/exec/async`
- `GET|DELETE /api/jobs/:jobId`
- `GET /api/jobs/:jobId/logs`
- `POST /api/jobs/:jobId/cancel`
- `POST /api/jobs/:jobId/delete`
- `GET /api/task/:taskId`

Every new Job runs in an independent detached Worker. Its metadata, result, and
stdout/stderr are stored on disk, so the public gateways can restart without
losing the task.

## Development-session routes

The public development gateway owns:

- `GET /api/dev/overview`
- `GET|POST /api/dev/sessions`
- `GET /api/dev/sessions/:sessionId`
- `POST /api/dev/sessions/:sessionId/heartbeat`
- `POST /api/dev/sessions/:sessionId/run`
- `GET|POST /api/dev/sessions/:sessionId/diff`
- `POST /api/dev/sessions/:sessionId/commit`
- `POST /api/dev/sessions/:sessionId/rollback`
- `POST /api/dev/sessions/:sessionId/merge`
- `POST /api/dev/sessions/:sessionId/cleanup`

Each Session creates a unique Git branch and Worktree. Standard project commands
run as persistent Jobs with the Worktree forced as `cwd`.

Short lease-aware project locks serialize Worktree creation, merge, cleanup, and
branch deletion. Editing and builds in different Worktrees remain parallel.

Merge safety requires:

- explicit Session ID confirmation
- no active attached Jobs unless force is explicit
- a clean Session Worktree
- a clean primary project checkout
- the primary checkout already on the requested target branch

AgentPort never silently switches the primary project's current branch.

## Idempotent Job submission

Long-running tasks may be submitted with a stable key:

```http
POST /api/exec/async
Idempotency-Key: script2shorts:build:commit-a83f92
Content-Type: application/json

{
  "command": "pnpm build",
  "cwd": "/home/YOUR_USER/projects/script2shorts"
}
```

Repeating the same key and parameters returns the existing `jobId` with
`reused: true`. Reusing the key with different parameters returns HTTP 409.

Session actions use the same Job service and idempotency mechanism.

## Cursor-based Job logs

The first log request returns stdout, stderr, and a cursor:

```text
GET /api/jobs/<job-id>/logs?maxBytes=65536
```

Continue from the returned position:

```text
GET /api/jobs/<job-id>/logs?cursor=<cursor>&maxBytes=65536
```

This avoids repeatedly downloading the complete log over a remote virtual LAN.
The older `tailBytes` and `bytes` parameters remain supported.

## Entrypoints

- `server-entry.cjs`: public Phase 5 development gateway entrypoint.
- `development-gateway.cjs`: Worktree Session API, Job attachment, overview, and
  reverse proxy to the modular gateway.
- `modular-gateway.cjs`: extracted file, execution, and Job routes plus proxy to
  the remaining legacy management service.
- `legacy-process.cjs`: starts and supervises the loopback legacy daemon.
- `config-loader.cjs`: reloadable `.env`, tokens, identity, workspace, execution,
  and Job settings.
- `../packages/daemon-core/development-session-service.cjs`: Git repository,
  Worktree, lease, lock, Diff, commit, merge, rollback, and cleanup lifecycle.
- `../server/`: legacy dashboard, config, diagnostics, and compatibility code.

## Start from the source tree

Install both dependency sets once:

```bash
npm install
npm --prefix server install
npm run start:daemon
```

Useful optional variables:

```bash
AGENTPORT_SERVER_ID=debian-main
AGENTPORT_WORKSPACE_ID=projects
AGENTPORT_PUBLIC_PORT=3183

EXEC_MAX_CONCURRENCY=2
JOB_MAX_CONCURRENCY=2
JOB_DEFAULT_TIMEOUT_MS=1800000

AGENTPORT_SESSIONS_DIR=/home/YOUR_USER/.agentport/sessions
AGENTPORT_WORKTREES_DIR=/home/YOUR_USER/workspace/.agentport-worktrees
AGENTPORT_SESSION_LEASE_MS=1800000
```

See `.env.example` for the complete settings.

## Deployment compatibility

Existing installations that copy only `server/` continue to run the legacy
single-process daemon. They do not receive modular file/exec/Job, named
workspace, or Worktree Session services until `daemon/`,
`packages/daemon-core/`, and `server/` are deployed together and
`daemon/server-entry.cjs` becomes the service entrypoint.

The modular Job service reuses the existing `JOBS_DIR` by default. Session and
Worktree paths are separate and configurable.

## Validation

```bash
npm run test:architecture
npm run test:gateway
npm run test:exec
npm run test:jobs
npm run test:sessions
npm run test:workspaces
npm run test:lifecycle
npm run test:all
```

Cross-platform tests cover the client runtime and synchronous execution on
Windows and Linux. They additionally validate detached Workers, real Git
Worktrees, project locks, Diff, commit, merge, cleanup, Session Job attachment,
MCP Session tool calls, named workspace path resolution, traversal rejection,
and symlink protection.

See `docs/PHASE5_DEVELOPMENT_SESSIONS.md` for the full workflow and safety rules.
