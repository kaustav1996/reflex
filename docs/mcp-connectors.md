# MCP connectors

Reflex speaks the [Model Context Protocol](https://modelcontextprotocol.io/), so any MCP server
— local (stdio) or remote (streamable-HTTP / SSE) — becomes a set of tools inside a session. Every
tool a connector exposes is registered as `reflex` tool named `<server>__<tool>`, and like every
other Reflex tool each call passes through the TypeSafe reflex gate (`bash` / `edit` / `write`
gating rules apply), so a connector that can send mail or delete a Jira ticket is still subject to
"ask before destructive / external side effects."

There are two ways to add a connector:

1. **`reflex connect <preset>`** — one command for the official, vendor-hosted remote MCP servers.
   No endpoints, no transport details, no hand-written JSON. This is the recommended path.
2. **Edit `~/.reflex/mcp.json` directly** (or use `reflex web → Settings → Connectors`) for anything
   else: a private stdio server, a self-hosted remote, a community server, etc.

Both write to the same file (`~/.reflex/mcp.json`, mode 0600), and both show up in `/mcp` inside a
session.

---

## `reflex connect` — built-in presets

```bash
reflex connect              # list presets, show which are enabled
reflex connect <id>         # enable a connector
reflex connect remove <id>  # disable + delete a connector
```

| id          | service                  | auth    | transport                  |
|-------------|--------------------------|---------|----------------------------|
| `gmail`     | Google Gmail             | OAuth   | remote, via `mcp-remote`   |
| `slack`     | Slack                    | OAuth   | remote, via `mcp-remote`   |
| `atlassian` | Atlassian Jira + Confluence | OAuth | remote, via `mcp-remote` |
| `linear`    | Linear                   | OAuth   | remote, via `mcp-remote`   |
| `linear-key`| Linear                   | API key | streamable-HTTP (no bridge)|

### Flags

- `--readonly` / `--ro` — where the service offers a read-only endpoint (Linear), use it. The
  token can never reach write APIs.
- `--key <token>` — for `api-key` presets, provide the token inline instead of prompting.
  Equivalent to exporting the preset's env var (e.g. `LINEAR_API_KEY`).

### Examples

```bash
# OAuth remotes — a browser tab opens on first connect, token cached in ~/.mcp-auth/
reflex connect gmail
reflex connect slack
reflex connect atlassian
reflex connect linear

# read-only Linear
reflex connect linear --readonly

# Linear with a personal API key — no browser, no npx, talks streamable-HTTP directly
reflex connect linear-key --key lin_api_xxx
# or: export LINEAR_API_KEY=lin_api_xxx && reflex connect linear-key
```

After enabling, start a session and run `/mcp` to see the connector status and the tools it
loaded. The footer shows `🔌 n mcp` (or `🔌 n mcp · k failed` if a server didn't start).

---

## How OAuth remotes are bridged

Reflex's built-in MCP client speaks **stdio** (spawned server) and **streamable-HTTP** (fetch +
`Mcp-Session-Id`). It does **not** implement the OAuth 2.1 + dynamic client registration flow
that the official remote MCP servers require. Rather than ship a partial OAuth client, Reflex
bridges those remotes through the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) package:

```
reflex session  ──stdio──▶  npx -y mcp-remote <url>  ──HTTPS+OAuth──▶  vendor MCP server
                                     │
                                     └─ first run: opens browser, caches token in ~/.mcp-auth/
```

So an OAuth preset's server config is simply:

```json
{
  "gmail": {
    "command": "npx",
    "args": ["-y", "mcp-remote@latest", "https://mcp.google.com/gmail/mcp"],
    "enabled": true
  }
}
```

Requirements: `npx` (ships with Node), a browser for the one-time consent, and write access to
`~/.mcp-auth/` for the cached token. After the first run, sessions are silent.

The **`linear-key`** preset is the exception: Linear's MCP server also accepts a personal API key
as a bearer token over plain streamable-HTTP, so Reflex talks to it directly — no `npx`, no
browser, no bridge process:

```json
{
  "linear-key": {
    "url": "https://mcp.linear.app/mcp",
    "headers": { "Authorization": "Bearer lin_api_xxx" },
    "enabled": true
  }
}
```

---

## Endpoints

These are the official, vendor-hosted endpoints the presets target (defined in
`src/extensions/mcp/presets.ts`):

| service    | endpoint                                |
|------------|-----------------------------------------|
| Gmail      | `https://mcp.google.com/gmail/mcp`      |
| Slack      | `https://mcp.slack.com/sse`             |
| Atlassian  | `https://mcp.atlassian.com/v1/sse`      |
| Linear     | `https://mcp.linear.app/mcp`            |
| Linear RO  | `https://mcp.linear.app/mcp/readonly`   |

> **Verified:** Linear's endpoint and OAuth flow are confirmed against Linear's docs
> (`https://linear.app/docs/mcp`). Slack and Atlassian return `302`/`401` to an unauthenticated
> request, i.e. alive and OAuth-gated, consistent with their published remote MCP servers. The
> Gmail endpoint is the commonly-cited one; Google's own MCP docs were not reachable from the
> build environment, so treat it as the likely-but-unverified URL and adjust in `presets.ts` if it
> changes.

---

## Custom servers (beyond presets)

Anything not in the presets list is added directly to `~/.reflex/mcp.json`:

```json
{
  "servers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "enabled": true
    },
    "my-api": {
      "url": "https://my-host/mcp",
      "headers": { "Authorization": "Bearer ..." },
      "enabled": true,
      "tools": ["search", "fetch"]
    }
  }
}
```

Supported fields per server (`McpServerConfig`):

- `command` + `args` + `env` + `cwd` — stdio server (spawned lazily at session start).
- `url` + `headers` — streamable-HTTP / SSE remote.
- `enabled` — set `false` to keep the config but skip the server (default `true`).
- `tools` — optional allowlist; only these tools are registered.

You can also manage these from `reflex web → Settings → Connectors`.

---

## What happens in a session

1. On `session_start`, Reflex loads `~/.reflex/mcp.json` and connects every `enabled` server
   (lazy: stdio servers are spawned, HTTP servers are initialised with `initialize` +
   `tools/list`).
2. Each tool the server exposes is registered as `reflex` tool `<server>__<tool>`. The tool's
   input schema is passed through, so the LLM sees and fills real parameters.
3. When the model calls one, Reflex runs it through the **reflex gate** first — the same Jev
   questions as for `bash` / `edit` / `write`. A connector call that sends an email, deletes a
   Jira issue, or posts to Slack is therefore subject to your risk appetite: low-risk reads
   auto-allow, external/irreversible writes ask.
4. Tool output (text + images) is returned to the model. Errors surface as failed tool calls.

Run `/mcp` in a session to see status, tool lists, and any connect failures.

---

## Files

| file                              | role                                                          |
|-----------------------------------|---------------------------------------------------------------|
| `src/extensions/mcp/client.ts`    | minimal MCP client (stdio + streamable-HTTP), config load/save |
| `src/extensions/mcp/presets.ts`   | the built-in connector presets + endpoint constants           |
| `src/extensions/mcp/connect.ts`    | `reflex connect` CLI (enable / remove / list)                |
| `src/extensions/mcp/index.ts`      | session wiring: connect all, register tools, `/mcp` command   |

## Troubleshooting

- **`npx` not found** — install Node ≥ 22.19 (it ships with `npx`).
- **OAuth tab never completes** — check `~/.mcp-auth/` is writable and you're not headless; the
  bridge needs a browser for the first consent. Re-run `reflex connect <id>` to retry.
- **`🔌 n mcp · k failed`** — run `/mcp` to see the per-server error. For stdio servers it's
  usually a missing `command`/package; for remotes, a stale token (delete `~/.mcp-auth/<server>`
  and reconnect) or a wrong endpoint.
- **`linear-key` 401** — the key is wrong, or you hit a `--readonly` endpoint with a token that
  lacks read scope. Regenerate at Linear → Settings → API.
