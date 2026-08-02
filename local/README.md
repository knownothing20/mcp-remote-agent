# Local Configuration

This directory holds private runtime configuration. Real tokens, passwords,
private keys, runtime state, logs, and generated files are not committed.

Each AI desktop application needs its own physical AgentPort directory or, at a
minimum, its own private `local/` directory. Core source may be synchronized,
but do not share `local/`, a selected connection, MCP process state, or a daemon
token between applications.

## Fresh Install Order

Start with SSH only:

```bash
cp local/connections.json.example local/connections.json
```

Edit `local/connections.json`:

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

Verify SSH:

```bash
node cli.js ssh-health --connection ssh-main --route ssh --json
```

Provision this software's daemon token:

```bash
node cli.js client provision \
  --client-id <machine-software> \
  --connection ssh-main \
  --route ssh \
  --daemon-url http://<host>:3183 \
  --daemon-name daemon-main \
  --local-dir . \
  --json
```

Validate with an authenticated daemon command:

```bash
node cli.js job list --connection daemon-main --route daemon --limit 1 --json
```

## V3 client configuration

The modular client uses separate files:

```text
connections.v3.json.example -> connections.v3.json
projects.json.example       -> projects.json
```

`connections.v3.json` stores logical server identities and their LAN,
virtual-LAN, and SSH recovery endpoints. Its `workspaceId` must match the
identity advertised by the daemon. It is not a filesystem path.

Named remote workspace paths are configured only on the daemon. Use values such
as `projects:/app` or `openclaw:/software/app` in client commands after the
daemon administrator has declared those roots. Never place remote workspace
roots, tokens, or another application's credentials in a tracked example.

## MCP Registration

If the AI tool supports native MCP, also create `local/agentport.json`:

```bash
cp agentport.example.json local/agentport.json
```

Set at least:

| Variable | Purpose |
| --- | --- |
| `skillDir` | Absolute path to this AgentPort skill directory |
| `mcpConfigPath` | Target AI tool MCP config path |
| `mcpServerName` | Usually `agentport` |

Then run:

```bash
node sync.cjs
```

Restart the AI tool after MCP config changes.

## Files

```text
local/
|-- README.md
|-- connections.json
|-- connections.v3.json
|-- agentport.json
|-- projects.json
`-- server/
    `-- .env
```

## Safety

- Do not commit real `local/connections.json`, `local/agentport.json`, or
  `local/server/.env`.
- Do not copy another software's daemon `authToken` as the final setup.
- Use one unique `clientId=token` for each machine/software pair.
- Keep daemon `workspaces.json` and daemon `.env` on the remote server, outside
  this client directory.
- Report only masked tokens.
