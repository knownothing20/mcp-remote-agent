# Named Workspaces

AgentPort can authorize several independent directory roots without widening
`WORKSPACE_ROOT` to an entire home directory.

## Recommended configuration

Keep the existing default root in the daemon `.env`:

```env
WORKSPACE_ROOT=/home/YOUR_USER/workspace
```

Create `workspaces.json` beside the daemon `.env` file:

```json
{
  "default": "projects",
  "roots": {
    "projects": "/home/YOUR_USER/workspace",
    "openclaw": "/home/YOUR_USER/.openclaw"
  }
}
```

For the standard daemon layout, the files are usually:

```text
/home/YOUR_USER/.agentport/daemon/.env
/home/YOUR_USER/.agentport/daemon/workspaces.json
```

Restart the daemon after creating or changing the file.

## Alternative environment configuration

Containers and managed deployments can use inline JSON:

```env
WORKSPACE_ROOT=/home/YOUR_USER/workspace
DEFAULT_WORKSPACE=projects
WORKSPACE_ROOTS_JSON={"projects":"/home/YOUR_USER/workspace","openclaw":"/home/YOUR_USER/.openclaw"}
```

An explicit file can also be selected:

```env
WORKSPACE_ROOTS_FILE=./workspaces.json
```

A relative `WORKSPACE_ROOTS_FILE` is resolved relative to the daemon `.env`.

Configuration precedence is:

1. runtime `/update-workspace` override, which intentionally switches to one root;
2. `WORKSPACE_ROOTS_JSON`;
3. `WORKSPACE_ROOTS_FILE`;
4. `workspaces.json` beside the selected `.env`;
5. legacy single-root `WORKSPACE_ROOT`.

## Path formats

Assuming `projects` is the default workspace:

```text
content-analyzer/README.md
projects:/content-analyzer/README.md
workspace://projects/content-analyzer/README.md
openclaw:/workspace/AGENTS.md
workspace://openclaw/workspace/AGENTS.md
/home/YOUR_USER/.openclaw/workspace/AGENTS.md
```

Relative paths use the default workspace. Absolute paths remain compatible and
are assigned to the configured root containing the path. Non-default workspace
results return a named `path` plus `relativePath`, `namedPath`, and `workspace`
metadata so follow-up calls cannot accidentally fall back to the default root.

Named project profiles are also supported:

```json
{
  "projects": {
    "content-analyzer": {
      "server": "debian-main",
      "root": "projects:/content-analyzer",
      "defaultBranch": "main"
    }
  }
}
```

## Security properties

- Workspace names must match `[A-Za-z][A-Za-z0-9._-]{0,63}`.
- A daemon accepts at most 32 named roots.
- Duplicate or overlapping normalized roots are rejected.
- `..` traversal cannot leave the selected named root.
- A symlink inside one named workspace cannot escape to another workspace or to
  an unconfigured directory.
- Legacy relative paths remain scoped to the configured default workspace.

A named workspace is an authorization boundary, not just a display alias.
Selecting `projects:/...` does not permit a symlink to reach `openclaw:/...`.

## Migration from a broad home-directory root

Before:

```env
WORKSPACE_ROOT=/home/YOUR_USER
```

After:

```env
WORKSPACE_ROOT=/home/YOUR_USER/workspace
```

With `workspaces.json`:

```json
{
  "default": "projects",
  "roots": {
    "projects": "/home/YOUR_USER/workspace",
    "openclaw": "/home/YOUR_USER/.openclaw"
  }
}
```

This keeps `/home/YOUR_USER/.ssh`, `/home/YOUR_USER/.config`, and unrelated home
directories outside AgentPort's file and command working-directory boundary.

## Validation

```bash
npm run test:workspaces
npm run privacy:check
```
