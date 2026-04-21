# TriliumNext MCP Server

A Model Context Protocol (MCP) server for interacting with [TriliumNext](https://github.com/TriliumNext/Notes) via its ETAPI. Enables LLMs to create, read, update, and organize notes — including embedding images and files directly into note content.

## Contents

- [Features](#features)
- [Installation](#installation)
- [Configuration](#configuration) — CLI, env vars, config file
- [Available Tools](#available-tools)
- [Embedding Images and Files](#embedding-images-and-files)
- [Multi-tenant HTTP deployment](#multi-tenant-http-deployment) — run one server for many users
  - [Architecture](#architecture)
  - [Quick start (Docker)](#quick-start-docker) / [(local)](#quick-start-local)
  - [HTTP endpoints](#http-endpoints) · [Error responses](#error-responses)
  - [Connecting clients](#connecting-clients) — Claude Desktop, Claude Code, SDK
  - [SSRF configuration](#ssrf-configuration) · [Reverse-proxy](#reverse-proxy-tls-termination)
  - [Security model](#security-model) · [Production checklist](#production-checklist) · [Troubleshooting](#troubleshooting)
- [Debugging with MCP Inspector](#debugging-with-mcp-inspector)
- [Development](#development) — build, test, docker
- [Getting an ETAPI Token](#getting-an-etapi-token)

## Features

- **35 tools** across 8 categories for full note management, search, organization, attachments, revisions, and system operations
- **Inline image and file embedding** — attach images and files when creating or updating notes in a single tool call
- **Data URL support** — pass image/file data as raw base64 or `data:` URLs
- **Three content update modes** — full replacement, search/replace, and unified diff
- **Markdown support** — write in markdown, stored as HTML automatically
- **Image-aware content retrieval** — `get_note_content` returns embedded images as visual content blocks
- Support for both STDIO and HTTP (SSE) transports, including **multi-tenant SSE mode** where each client brings its own Trilium URL + ETAPI token
- Flexible configuration via CLI, environment variables, or config file
- TypeScript with full type safety

## Installation

```bash
git clone https://github.com/perfectra1n/triliumnext-mcp
cd triliumnext-mcp
npm install
npm run build
```

### Adding to Claude Code

```bash
claude mcp add trilium node /path/to/triliumnext-mcp/dist/index.js \
  --scope user \
  -e TRILIUM_TOKEN=<your_etapi_token> \
  -e TRILIUM_URL=<your_trilium_url_e.g._https://trilium.example.com/etapi>
```

This adds the server at user scope (available across all repositories) in your `~/.claude.json`.

### Using with claude.ai (web/desktop) over SSE

When running in HTTP/SSE mode and connecting from claude.ai (web or desktop), some MCP hosts apply a *deferred tool loading* strategy: only a subset of the server's 35 tools land in the assistant's active context at session start, with the remainder expected to be pulled in on demand. In practice some tools — most often the write-side ones like `create_note`, `update_note_content`, `append_note_content`, `delete_note`, `delete_branch` — may show up in the tool-discovery response with full schemas but then fail when invoked with an error like:

> `<tool_name> has not been loaded yet`

This is a client-side behaviour, not a server issue; the server advertises all tools correctly via `tools/list`. See [#6](https://github.com/perfectra1n/triliumnext-mcp/issues/6) for background.

**Workaround — direct SSE client.** A minimal reference client using only the Python standard library is provided in [`examples/reference-sse-client.py`](examples/reference-sse-client.py). It speaks JSON-RPC over `/sse` + `/message` and can invoke any tool from a shell, which works well as an escape hatch from agents that can shell out:

```bash
# List all 35 tools
python3 examples/reference-sse-client.py list

# Call a tool (JSON arguments on stdin)
echo '{"parentNoteId":"root","title":"Test","type":"text","content":"hi"}' \
    | python3 examples/reference-sse-client.py call create_note

# Point at a different server
TRILIUM_MCP_URL=http://other-host:3100 python3 examples/reference-sse-client.py list
```

Read-side tools (`search_notes`, `get_note_content`, `get_note_attachments`, `create_revision`, etc.) are typically pre-loaded and work natively, so a hybrid pattern tends to be most ergonomic: use native MCP tools for read/snapshot, and the reference client for writes.

## Configuration

Configuration precedence (highest to lowest):
1. CLI arguments
2. Environment variables
3. Configuration file (`./trilium-mcp.json` or `~/.trilium-mcp.json`)
4. Default values

### CLI Arguments

```bash
npm install -g .
triliumnext-mcp --url http://localhost:37740/etapi --token YOUR_TOKEN
```

Options:
- `-u, --url <url>` — Trilium ETAPI URL (default: `http://localhost:37740/etapi`)
- `-t, --token <token>` — Trilium ETAPI token (required in single-tenant mode)
- `--transport <type>` — Transport type: `stdio` or `http` (default: `stdio`)
- `-p, --port <port>` — HTTP server port when using http transport (default: `3000`)
- `-h, --help` — Show help message

Multi-tenant HTTP options (see [Multi-tenant HTTP deployment](#multi-tenant-http-deployment) below):
- `--multi-tenant` — each SSE client supplies its own Trilium URL + token
- `--gateway-auth <mode>` — `none` or `bearer` (default: `bearer` when multi-tenant)
- `--gateway-token <token>` — accepted bearer token (repeatable)
- `--trilium-url-allowlist <hosts>` — comma-separated allowed hostnames for client URLs
- `--allow-private-urls` — skip the private/loopback IP SSRF block

### Environment Variables

```bash
export TRILIUM_URL=http://localhost:37740/etapi
export TRILIUM_TOKEN=your-etapi-token
export TRILIUM_TRANSPORT=stdio
export TRILIUM_HTTP_PORT=3000

# Multi-tenant (see section below):
export TRILIUM_MULTI_TENANT=true
export TRILIUM_GATEWAY_AUTH=bearer
export TRILIUM_GATEWAY_TOKENS=tok1,tok2
export TRILIUM_URL_ALLOWLIST=notes.example.com,trilium.internal
export TRILIUM_ALLOW_PRIVATE_URLS=false
```

### Config File

Create `trilium-mcp.json` in the current directory or `~/.trilium-mcp.json`:

```json
{
  "url": "http://localhost:37740/etapi",
  "token": "your-etapi-token",
  "transport": "stdio",
  "httpPort": 3000
}
```

For multi-tenant HTTP deployments, the same precedence applies (CLI > env > file > default). Multi-tenant keys:

```json
{
  "transport": "http",
  "httpPort": 3000,
  "multiTenant": true,
  "gatewayAuth": "bearer",
  "gatewayTokens": ["pick-a-long-random-token"],
  "urlAllowlist": ["notes.example.com", "trilium.internal"],
  "allowPrivateUrls": false
}
```

## Available Tools

### Notes (10 tools)

| Tool | Description |
|------|-------------|
| `create_note` | Create a note with title, content, type, and parent. Supports inline image/file embedding. |
| `get_note` | Get note metadata by ID (title, type, attributes, parent/child relationships) |
| `get_note_content` | Get note content as HTML or markdown. Automatically includes embedded images as visual content blocks. |
| `update_note` | Update note metadata (title, type, MIME type) |
| `update_note_content` | Update note content via full replacement, search/replace, or unified diff. Supports inline image/file embedding in replacement mode. |
| `append_note_content` | Append content or edit via search/replace or diff. Supports inline image/file embedding in append mode. |
| `delete_note` | Delete a note and all its branches |
| `undelete_note` | Restore a previously deleted note |
| `get_note_attachments` | List all attachments for a note |
| `get_note_history` | Get recent changes (creations, modifications, deletions) with optional subtree filtering |

### Search & Discovery (2 tools)

| Tool | Description |
|------|-------------|
| `search_notes` | Full-text and attribute search with filters, ordering, and limits |
| `get_note_tree` | Get children of a note for tree navigation |

### Organization (4 tools)

| Tool | Description |
|------|-------------|
| `move_note` | Move a note to a different parent |
| `clone_note` | Clone a note to appear under multiple parents |
| `reorder_notes` | Change note positions within a parent |
| `delete_branch` | Remove a branch without deleting the note |

### Attributes & Labels (4 tools)

| Tool | Description |
|------|-------------|
| `get_attributes` | Get all attributes (labels/relations) of a note |
| `get_attribute` | Get a single attribute by ID |
| `set_attribute` | Add or update an attribute on a note |
| `delete_attribute` | Remove an attribute from a note |

### Calendar & Journal (2 tools)

| Tool | Description |
|------|-------------|
| `get_day_note` | Get or create the daily note for a date |
| `get_inbox_note` | Get the inbox note for quick capture |

### Attachments (6 tools)

| Tool | Description |
|------|-------------|
| `create_attachment` | Create a new attachment (image or file) for a note |
| `get_attachment` | Get attachment metadata by ID |
| `update_attachment` | Update attachment metadata (role, MIME, title, position) |
| `delete_attachment` | Delete an attachment |
| `get_attachment_content` | Get attachment content — images returned as visual content blocks |
| `update_attachment_content` | Update attachment content via replacement, search/replace, or diff |

### Revisions (3 tools)

| Tool | Description |
|------|-------------|
| `get_note_revisions` | List all revision snapshots for a note |
| `get_revision` | Get revision metadata by ID |
| `get_revision_content` | Get the content of a historical revision |

### System (4 tools)

| Tool | Description |
|------|-------------|
| `create_revision` | Create a revision snapshot of a note |
| `create_backup` | Create a full database backup |
| `export_note` | Export a note subtree as a ZIP file |
| `search_tools` | Search available tools by keyword or category |

## Embedding Images and Files

When creating or updating notes, you can embed images and files directly in a single tool call using the `images` and `files` parameters.

### Image Embedding

Pass an `images` array and reference them in your content with `image:0`, `image:1`, etc.:

```json
{
  "tool": "create_note",
  "arguments": {
    "parentNoteId": "root",
    "title": "My Note",
    "type": "text",
    "content": "<p>Here is a photo:</p><img src=\"image:0\">",
    "images": [
      {
        "data": "iVBORw0KGgo...",
        "mime": "image/png",
        "filename": "photo.png"
      }
    ]
  }
}
```

In markdown mode, use `![alt text](image:0)`:

```json
{
  "content": "# My Note\n\n![photo](image:0)\n\nSome text.",
  "format": "markdown",
  "images": [{ "data": "iVBORw0KGgo...", "mime": "image/png", "filename": "photo.png" }]
}
```

Images without a matching placeholder are automatically appended at the end of the content.

### File Embedding

Pass a `files` array and reference them with `file:0`, `file:1`, etc.:

```json
{
  "content": "<p>Download the report: <a href=\"file:0\">Report PDF</a></p>",
  "files": [
    {
      "data": "JVBERi0xLjQ...",
      "mime": "application/pdf",
      "filename": "report.pdf"
    }
  ]
}
```

Files without a matching placeholder are appended as download links.

### Data URL Support

The `data` field accepts both raw base64 and data URLs. When a data URL is provided, the MIME type is automatically extracted (overriding the `mime` field):

```json
{
  "images": [
    {
      "data": "data:image/png;base64,iVBORw0KGgo...",
      "mime": "ignored-when-data-url-is-used",
      "filename": "screenshot.png"
    }
  ]
}
```

### Content Update Modes

The `update_note_content` and `append_note_content` tools support three modes (images/files only work with mode 1):

1. **Full replacement** (`content`) — replace or append entire content, with optional markdown conversion
2. **Search/replace** (`changes`) — array of `{old_string, new_string}` blocks applied sequentially
3. **Unified diff** (`patch`) — a unified diff string applied to existing content

## Multi-tenant HTTP deployment

By default the server is single-tenant: `TRILIUM_URL` and `TRILIUM_TOKEN` are loaded once at startup and every MCP client that connects talks to the same Trilium instance. That's fine for a personal setup, but if you want to run **one MCP server process that serves multiple users**, each with their own Trilium and their own ETAPI token, switch it into multi-tenant mode.

### What changes

With `--multi-tenant`:

1. **Each SSE connection MUST supply its own Trilium credentials** via HTTP headers, as an atomic pair:
   - `X-Trilium-Url` — the client's Trilium base URL
   - `X-Trilium-Token` — the client's ETAPI token
2. **A per-connection `TriliumClient` is created** — connections are isolated; one user's tool calls never hit another's Trilium.
3. **Credentials are verified at connect time** by calling `/etapi/app-info` (with a 10s timeout). A bad token fails fast with a `401` on the SSE handshake, not with silent tool-call errors later.
4. **A gateway bearer token is required** (`--gateway-auth bearer`, enabled by default in multi-tenant mode). Clients authenticate to *you* with a shared secret you hand out.
5. **Client-supplied URLs are SSRF-checked.** By default, hostnames that resolve to private/loopback/link-local IPs (including cloud metadata `169.254.169.254`) are rejected. Adjust with `--trilium-url-allowlist` or `--allow-private-urls`.

**Startup-supplied `TRILIUM_URL` / `TRILIUM_TOKEN` are rejected in multi-tenant mode.** The server will refuse to start if either is set alongside `--multi-tenant`. This prevents a subtle token-leak where a client sending only one header would cause the operator's default to be mixed with client-supplied values.

### Architecture

```
                  ┌───────────────────────────────────┐
   Client A ─────►│ /sse                              │   ┌────────────────┐
   (Auth: Bearer  │   1. gateway bearer check          │──►│ Trilium A      │
    X-Trilium-*)  │   2. SSRF guard on X-Trilium-Url  │   │ (notes-a.tld)  │
                  │   3. validate via /etapi/app-info │   └────────────────┘
   Client B ─────►│   4. new TriliumClient (per conn) │   ┌────────────────┐
                  │   5. new MCP Server (per conn)    │──►│ Trilium B      │
                  │                                   │   │ (notes-b.tld)  │
   Client N ─────►│ sessions: Map<sessionId, Session> │   └────────────────┘
                  │                                   │           ...
                  │ POST /message?sessionId=<uuid>    │
                  │   routes to the right session     │
                  │                                   │
                  │ GET /health  (no auth)            │
                  └───────────────────────────────────┘
```

Each SSE connection owns an independent `Server` + `TriliumClient`. Tool handlers close over the client, so tenant isolation is a property of the code, not something to enforce per-request.

### Quick start (Docker)

```bash
export MCP_GATEWAY_TOKEN=$(openssl rand -hex 32)
docker compose -f docker-compose.multi-tenant.yml up -d
```

Distribute `MCP_GATEWAY_TOKEN` to authorized clients. **Put a TLS-terminating reverse proxy (nginx, Caddy, Traefik) in front of this container** — bearer tokens in plaintext HTTP are unsafe.

### Quick start (local)

```bash
npm run build
node dist/index.js \
  --transport http \
  --port 3000 \
  --multi-tenant \
  --gateway-token "$(openssl rand -hex 32)"
```

### HTTP endpoints

| Method | Path        | Auth                     | Purpose |
|--------|-------------|--------------------------|---------|
| `GET`  | `/health`   | none                     | Liveness probe — returns `{"status":"ok"}`. |
| `GET`  | `/sse`      | gateway + per-connection | Open an SSE stream. Server replies with an `endpoint` event containing `/message?sessionId=<uuid>`. |
| `POST` | `/message`  | implicit via `sessionId` | Client sends JSON-RPC messages here. `Content-Type: application/json`, up to 1 MB. |

### Connecting clients

Any MCP client that can attach custom HTTP headers to an SSE connection will work.

**Smoke test with `curl`:**

```bash
curl -N \
  -H "Authorization: Bearer $MCP_GATEWAY_TOKEN" \
  -H "X-Trilium-Url: https://notes.example.com" \
  -H "X-Trilium-Token: $YOUR_ETAPI_TOKEN" \
  http://mcp-server.example.com:3000/sse
```

On success you'll see the `endpoint` SSE event, followed by message events as your client POSTs to `/message`.

**Claude Desktop via [mcp-remote](https://github.com/geelen/mcp-remote):**

Claude Desktop speaks stdio, so bridge it through `mcp-remote` which can carry custom headers to a remote SSE server. Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "trilium": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.example.com/sse",
        "--header", "Authorization: Bearer YOUR_GATEWAY_TOKEN",
        "--header", "X-Trilium-Url: https://notes.example.com",
        "--header", "X-Trilium-Token: YOUR_ETAPI_TOKEN"
      ]
    }
  }
}
```

**Claude Code (native SSE):**

```bash
claude mcp add trilium --scope user \
  --transport sse https://mcp.example.com/sse \
  --header "Authorization: Bearer YOUR_GATEWAY_TOKEN" \
  --header "X-Trilium-Url: https://notes.example.com" \
  --header "X-Trilium-Token: YOUR_ETAPI_TOKEN"
```

**TypeScript SDK:**

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const transport = new SSEClientTransport(new URL('https://mcp.example.com/sse'), {
  requestInit: {
    headers: {
      Authorization: `Bearer ${GATEWAY_TOKEN}`,
      'X-Trilium-Url': 'https://notes.example.com',
      'X-Trilium-Token': ETAPI_TOKEN,
    },
  },
});
const client = new Client({ name: 'my-app', version: '1.0.0' });
await client.connect(transport);
```

### SSRF configuration

| Flag | Behavior |
|------|----------|
| *(default)* | Reject any `X-Trilium-Url` whose hostname resolves to a private / loopback / link-local / CGNAT / multicast address. |
| `--trilium-url-allowlist host1,host2` | Only hostnames matching the list (exact or suffix — `example.com` matches `a.example.com`) are accepted. Takes precedence over the private-IP block. |
| `--allow-private-urls` | Disable the private-IP block entirely. Use only on trusted/homelab networks. |

### Error responses

All errors are `application/json` with an `error` string. Common responses on `GET /sse`:

| Status | `error` value                      | Meaning |
|--------|------------------------------------|---------|
| `401`  | `unauthorized`                     | Missing or wrong `Authorization: Bearer`. |
| `401`  | `missing_trilium_credentials`      | `X-Trilium-Url` and `X-Trilium-Token` are required together; one or both missing. |
| `401`  | `trilium_auth_failed`              | Trilium rejected the ETAPI token. |
| `400`  | `url_rejected` (reason varies)     | Bad scheme, embedded credentials, private IP (no allowlist), or not in allowlist. |
| `502`  | `trilium_unreachable`              | Can't reach the Trilium host at all. |
| `504`  | `trilium_validate_timeout`         | `getAppInfo` probe exceeded 10 s (suggests a black-hole or slow host). |

On `POST /message`:

| Status | `error` value           | Meaning |
|--------|-------------------------|---------|
| `400`  | `missing_session_id`    | No `?sessionId=` query parameter. |
| `404`  | `unknown_session`       | `sessionId` doesn't match any live SSE connection (typical after a disconnect / restart). |
| `413`  | `payload_too_large`     | `Content-Length` exceeded 1 MB. |

### Reverse-proxy (TLS termination)

**Caddy** — simplest setup, automatic Let's Encrypt:

```
mcp.example.com {
    # preserve the client's Authorization + X-Trilium-* headers (default behavior)
    reverse_proxy 127.0.0.1:3000 {
        # SSE needs large/indefinite response buffering disabled
        flush_interval -1
    }
}
```

**nginx** — explicit SSE tuning:

```nginx
server {
    listen 443 ssl http2;
    server_name mcp.example.com;
    # ssl_certificate / ssl_certificate_key configured elsewhere

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # SSE essentials
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 24h;
    }
}
```

Make sure the proxy **passes through** `Authorization`, `X-Trilium-Url`, `X-Trilium-Token`. Both examples above do by default.

### Health check

`GET /health` returns `{"status":"ok"}` with no auth required. Used by the Docker `HEALTHCHECK`; also useful for load-balancer probes.

### Security model

- **Gateway auth** (who can connect at all) is an operator-issued shared bearer token. Constant-time comparison, tokens stored as SHA-256 hashes at startup.
- **Backend auth** (which Trilium to talk to) is each client's own ETAPI token. It's only ever used to construct that client's `TriliumClient`; it's never logged.
- **Creds are validated at connect time** with a 10-second timeout, so a bad or slow Trilium target fails the SSE handshake instead of hanging the connection.
- **No TLS in-process.** Use a reverse proxy. The server listens on plain HTTP and expects to run behind one.
- **No per-user identity.** The gateway token is a capability — anyone holding it can open a session and provide any Trilium credentials. If you need per-principal identity (OIDC, JWT), handle it at the reverse-proxy layer and pass through.

### Production checklist

- [ ] TLS terminated by a reverse proxy (Caddy / nginx / Traefik) — never expose port 3000 directly to the public internet.
- [ ] Gateway token generated from a CSPRNG (`openssl rand -hex 32`) and rotated on compromise by restarting with a new token.
- [ ] `--trilium-url-allowlist` set to the hostnames your users should legitimately reach, or the default private-IP block left in place.
- [ ] `/health` exposed internally only (behind the proxy), so external scanners can't fingerprint the service.
- [ ] Container runs as non-root (the shipped `Dockerfile` already uses `USER node`).
- [ ] Reverse proxy logs scrubbed of `Authorization` / `X-Trilium-Token` headers if you forward request headers to an APM.
- [ ] Firewall rules restrict ingress to the proxy host(s).

### What's not (yet) supported

- StreamableHTTP transport (MCP's newer replacement for SSE) — on the roadmap; the routing layer is structured to allow it alongside `/sse`.
- Rate limiting — handle at the reverse-proxy layer for now.
- CORS — no browser MCP clients today; add if/when they appear.
- Per-principal gateway identity (OIDC, JWT) — use reverse-proxy auth (mod_auth_openidc, oauth2-proxy) if you need it.
- Per-tenant audit logs / metrics — the per-connection `Server` makes this straightforward to add but isn't implemented yet.

### Troubleshooting

**Connection immediately returns `401 unauthorized`.** Missing or malformed `Authorization: Bearer`. Check your client logs — some MCP clients strip non-standard headers on SSE.

**Connection returns `401 trilium_auth_failed`.** The ETAPI token was rejected by Trilium. Test it directly: `curl -H "Authorization: $TOKEN" https://trilium.example.com/etapi/app-info`.

**Connection returns `400 url_rejected` with `reason=private_address`.** You're pointing at a private/loopback IP (common in homelabs). Either add the hostname to `--trilium-url-allowlist` or pass `--allow-private-urls`.

**Connection returns `504 trilium_validate_timeout`.** `getAppInfo` didn't respond within 10 seconds. Usually a DNS black hole, a firewall dropping packets, or Trilium is actually down.

**Connection succeeds but tool calls hang.** Reverse proxy is buffering SSE. Verify `proxy_buffering off` (nginx) / `flush_interval -1` (Caddy).

**`/health` returns 200 but clients get 502/504 from the proxy.** Proxy can reach the MCP server, but the server can't reach Trilium from its own network namespace (e.g., Docker bridge vs. host). Check `docker exec triliumnext-mcp wget -qO- http://trilium:8080/etapi/app-info`.

## Debugging with MCP Inspector

[MCP Inspector](https://github.com/modelcontextprotocol/inspector) provides a web UI for testing tools interactively:

```bash
TRILIUM_URL=http://localhost:37740/etapi TRILIUM_TOKEN=your-token npm run inspector
```

Opens at `http://localhost:6274` where you can browse tools, execute calls, and inspect responses.

## Development

### Prerequisites

- Node.js 20+
- npm
- Docker (for integration tests)

### Setup

```bash
npm install          # Install dependencies
npm run build        # Build TypeScript
npm test             # Run unit tests
npm run test:integration  # Run integration tests (starts Trilium in Docker)
npm run lint         # Run linter
npm run format       # Format code
```

### Docker

Start Trilium and the MCP server:

```bash
TRILIUM_TOKEN=your-token docker compose up -d
```

Build the Docker image:

```bash
docker build -t triliumnext-mcp .
```

## Getting an ETAPI Token

1. Open TriliumNext in your browser
2. Go to Options (gear icon) → ETAPI
3. Create a new ETAPI token
4. Copy the token and use it in your configuration

## License

MIT
