# TriliumNext MCP Server

A Model Context Protocol (MCP) server for interacting with [TriliumNext](https://github.com/TriliumNext/Notes) via its ETAPI. Enables LLMs to create, read, update, and organize notes — including embedding images and files directly into note content.

## Contents

- [Features](#features)
- [Installation](#installation)
- [Configuration](#configuration) — CLI, env vars, config file
- [Logging](#logging) — what gets logged, where it goes, how to tune it
- [Metrics](#metrics) — Prometheus `/metrics` endpoint, auth modes, exposed series
- [Available Tools](#available-tools)
- [Embedding Images and Files](#embedding-images-and-files)
- [Multi-tenant HTTP deployment](#multi-tenant-http-deployment) — run one server for many users
  - [Architecture](#architecture)
  - [Quick start (Docker)](#quick-start-docker) / [(local)](#quick-start-local)
  - [HTTP endpoints](#http-endpoints) · [Error responses](#error-responses) · [Request body size limits](#request-body-size-limits)
  - [Connecting clients](#connecting-clients) — Claude Desktop, Claude Code, SDK
  - [JWT / OIDC gateway auth](#jwt--oidc-gateway-auth) · [CORS](#cors) · [Rate limiting](#rate-limiting)
  - [StreamableHTTP transport](#streamablehttp-transport) — newer MCP transport alongside `/sse`
  - [Per-tenant audit + metrics](#per-tenant-audit--metrics)
  - [SSRF configuration](#ssrf-configuration) · [Reverse-proxy](#reverse-proxy-tls-termination)
  - [Security model](#security-model) · [Troubleshooting](#troubleshooting)
- [Debugging with MCP Inspector](#debugging-with-mcp-inspector)
- [Development](#development) — build, test, docker
- [Getting an ETAPI Token](#getting-an-etapi-token)

## Features

- **19 tools** across 8 categories for full note management, search, organization, attachments, revisions, and system operations (consolidated from 35 in v1 — see [Migrating from v1](#migrating-from-v1))
- **MCP tool annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `title`) on every tool for better approval-dialog UX in clients that surface them
- **Inline image and file embedding** — attach images and files when creating or updating notes in a single tool call
- **Data URL support** — pass image/file data as raw base64 or `data:` URLs
- **Four content modes on `write_note`** — metadata, replace, append, and edit (search/replace or unified diff)
- **Markdown support** — write in markdown, stored as HTML automatically
- **Image-aware content retrieval** — `get_note` returns embedded images as MCP image blocks alongside the note body
- Support for **STDIO**, **HTTP/SSE**, and **StreamableHTTP** transports, including **multi-tenant** mode where each client brings its own Trilium URL + ETAPI token
- **Pluggable gateway auth** — none, shared-secret bearer, or **JWT/OIDC** (HS256 secrets + JWKS for RS256/ES256/EdDSA)
- **CORS** for browser-based MCP clients, **in-process rate limiting** per IP + per gateway token, and **Prometheus metrics** with optional per-principal labels
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
- `--public-url <url>` — user-facing Trilium web URL used for the clickable note links returned to the user. Defaults to `--url` with `/etapi` stripped. Set this only when the MCP server reaches Trilium at a different address than the user's browser does (e.g. an internal ETAPI host behind a public reverse-proxy domain).
- `--transport <type>` — Transport type: `stdio` or `http` (default: `stdio`)
- `-p, --port <port>` — HTTP server port when using http transport (default: `3000`)
- `--max-post-bytes <size>` — max size of a single MCP JSON-RPC POST body on the SSE transport. Accepts raw bytes or suffixed values like `500mb` / `1gb` (default: `500mb`). See [Request body size limits](#request-body-size-limits).
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
export TRILIUM_PUBLIC_URL=https://trilium.example.com  # optional; web URL for note links (defaults to TRILIUM_URL without /etapi)
export TRILIUM_TRANSPORT=stdio
export TRILIUM_HTTP_PORT=3000
export TRILIUM_MAX_POST_BYTES=500mb  # SSE POST body cap; see "Request body size limits"

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

## Logging

The server emits one line per significant event — server startup, MCP `tools/list`, every `tools/call` (with timing and outcome), and every HTTP request when running over SSE. By default logs are human-readable text; flip to JSON for log shippers.

### Where logs go

The output stream is chosen by transport, so logs never collide with the MCP wire protocol:

| Transport | Log stream | Why |
|-----------|------------|-----|
| `stdio`   | **stderr** | stdout is reserved by MCP for JSON-RPC frames — writing anything else there breaks clients. |
| `http`    | **stdout** | The MCP protocol travels over HTTP, so stdout is free for logs. Easy to pipe into `jq` / a log shipper / `docker logs`. |

Claude Desktop and Claude Code surface stdio servers' stderr in their MCP logs panel, so you'll see these events there with no extra setup.

### Tuning

Two env vars (defaults shown):

| Var | Values | Default | Effect |
|-----|--------|---------|--------|
| `LOG_LEVEL`  | `silent` \| `error` \| `warn` \| `info` \| `debug` | `info`  | `info` emits one line per tool call with timing and outcome. `debug` adds per-call argument summaries (with secrets and content blobs scrubbed). `silent` disables logging entirely. |
| `LOG_FORMAT` | `text` \| `json` | `text` | `text` is `<ISO-ts> LEVEL event k=v k=v` lines. `json` is one JSON object per line. |

### Example output

`info` level, text format (the default):

```
2026-05-12T18:16:21.098Z INFO  server_started transport=stdio
2026-05-12T18:16:33.937Z INFO  http_request method=GET path=/health status=200 duration_ms=2 remote=::1
2026-05-12T18:16:40.512Z INFO  sse_connected session=2f1c... host=notes.example.com
2026-05-12T18:16:40.871Z INFO  list_tools session=2f1c... count=19
2026-05-12T18:16:41.044Z INFO  tool_call session=2f1c... tool=search_notes duration_ms=42 ok=true
2026-05-12T18:16:42.110Z INFO  tool_call session=2f1c... tool=get_note duration_ms=11 ok=false error=trilium status=404 code=NOT_FOUND
2026-05-12T18:16:55.802Z INFO  sse_closed session=2f1c...
```

`LOG_FORMAT=json`:

```json
{"ts":"2026-05-12T18:16:41.044Z","level":"info","event":"tool_call","session":"2f1c...","tool":"search_notes","duration_ms":42,"ok":true}
```

The `session` field is identical across `sse_connected`, every `tool_call` on that connection, and `sse_closed`, so you can correlate tool activity to its SSE session and (in multi-tenant mode) to its Trilium host.

### Event reference

| Event | Level | Fields | When |
|-------|-------|--------|------|
| `server_started`        | info  | `transport`, `port?`, `mode?`, `gateway_auth?`        | After the listener is up (or stdio is connected). |
| `startup_failed`        | error | `err`                                                  | Server failed to start. |
| `list_tools`            | info  | `session`, `count`                                     | Client called `tools/list`. |
| `tool_call`             | info  | `session`, `tool`, `duration_ms`, `ok`, `error?`, `code?`, `status?` | One per `tools/call`. `error` is one of `trilium` \| `zod` \| `diff` \| `unknown_tool` \| `unknown`. |
| `tool_call_args`        | debug | `session`, `tool`, `args`                              | Per call, before dispatch. `args` is shallow + redacted (secrets stripped, content blobs replaced with `<string len=N>`, scalars truncated at 64 chars). |
| `http_request`          | info  | `method`, `path`, `status`, `duration_ms`, `remote`    | One per HTTP request to the SSE gateway. Path is pre-`?` to avoid logging query-string secrets. |
| `sse_connected`         | info  | `session`, `host`                                      | New SSE connection accepted. `host` is the Trilium hostname (never the full URL or token). |
| `sse_closed`            | info  | `session`                                              | SSE connection closed by either side. |
| `sse_post`              | debug | `session`, `bytes`                                     | Per `POST /message`, after body read. |
| `sse_connect_failed`    | error | `session`, `err`                                       | `server.connect(transport)` threw. |
| `unauthorized`          | warn  | `remote`                                               | Gateway bearer check failed. |
| `missing_trilium_credentials` | warn | `remote`                                          | Multi-tenant connect without `X-Trilium-Url`+`X-Trilium-Token`. |
| `url_rejected`          | warn  | `reason`                                               | SSRF guard rejected the client URL. |
| `trilium_auth_failed`   | warn  | `host`, `status`, `code`                               | Trilium returned 401/403 to the connect-time probe. |
| `trilium_validate_timeout` | warn | `host`                                                | Probe exceeded 10 s. |
| `trilium_unreachable`   | warn  | `host`, `err`                                          | Trilium probe failed for any other reason. |
| `allow_private_urls_enabled` | warn | *(none)*                                          | Operator started multi-tenant mode with `--allow-private-urls`. |
| `request_handler_error` | error | `method`, `path`, `err`                                | Unhandled error in the HTTP handler chain. |

Event names match the JSON `error` strings returned to the HTTP client where applicable, so a `grep` for a failure mode finds both the log line and the response.

### What's never logged

- ETAPI tokens, gateway bearer tokens, or any value of a field matching `/token|password|secret|authorization|api[_-]?key/i`
- Note bodies, attachment bytes, search results, or any field named `content`, `text`, `body`, `data`, `attachment`, `blob`, `html`, `markdown` — replaced with `<string len=N>` / `<array len=N>` / `<object>` shape descriptors at `debug`, omitted entirely at `info`
- Full Trilium URLs (which can theoretically embed credentials) — only the hostname is logged

### Quick recipes

Silence the server (e.g. when invoking under a noisy test harness):

```bash
LOG_LEVEL=silent triliumnext-mcp --token "$TRILIUM_TOKEN"
```

Tee structured logs into a file while still seeing them in the terminal:

```bash
LOG_FORMAT=json triliumnext-mcp --transport http --token "$TRILIUM_TOKEN" \
  | tee >(jq -c . > /var/log/triliumnext-mcp.jsonl)
```

Find every failing tool call from the last run:

```bash
LOG_FORMAT=json triliumnext-mcp --transport http --token "$TRILIUM_TOKEN" \
  | jq -c 'select(.event=="tool_call" and .ok==false)'
```

Watch one tenant's activity in a multi-tenant deployment (correlate by SSE session id):

```bash
docker logs -f triliumnext-mcp | grep "session=2f1c"
```

## Metrics

The server can expose a Prometheus-compatible `GET /metrics` endpoint on the SSE gateway. Off by default, opt in with `--metrics` or `TRILIUM_METRICS=true`. HTTP transport only — stdio mode has no listener, and the flag is ignored there with a warning.

### Enabling

```bash
# Reuse the gateway bearer (default; same token that protects /sse)
node dist/index.js \
  --transport http \
  --multi-tenant \
  --gateway-token "$GATEWAY_TOKEN" \
  --metrics
```

Same thing via env:

```bash
TRILIUM_TRANSPORT=http \
TRILIUM_MULTI_TENANT=true \
TRILIUM_GATEWAY_TOKENS=$GATEWAY_TOKEN \
TRILIUM_METRICS=true \
  node dist/index.js
```

### Auth modes

Selected with `--metrics-auth <mode>` or `TRILIUM_METRICS_AUTH`. Default is `gateway`.

| Mode | What it does | When to use |
|------|--------------|-------------|
| `gateway` *(default)* | Scrapers must present the same `Authorization: Bearer <token>` accepted by `/sse`. Zero new config. | Common case. Prometheus uses the same secret as your MCP clients. |
| `bearer`              | Scrapers must present a token from a separate list, supplied via `--metrics-token <tok>` (repeatable) or `TRILIUM_METRICS_TOKENS=t1,t2`. Gateway tokens are **not** accepted. | When you want Prometheus to have its own credential you can rotate independently of MCP client tokens. |
| `none`                | Endpoint is open. No `Authorization` required. | The endpoint is firewalled or sits on a private network where you trust everything that can reach it. |

If you ask for `--metrics-auth gateway` but `--gateway-auth=none`, there's no bearer to reuse — the server falls back to `--metrics-auth=none` and prints a startup warning so the behavior is explicit. If you set `--metrics-auth bearer` without providing any `--metrics-token`, startup fails fast.

### Deploying with Docker / Compose

Add to `docker-compose.multi-tenant.yml` (already templated as commented-out entries in that file):

```yaml
services:
  mcp-server:
    environment:
      - TRILIUM_METRICS=true
      # Default: reuse the gateway bearer. No new config needed.
      - TRILIUM_METRICS_AUTH=gateway
      # Or, give Prometheus its own rotatable credential:
      # - TRILIUM_METRICS_AUTH=bearer
      # - TRILIUM_METRICS_TOKENS=${PROMETHEUS_SCRAPE_TOKEN}
```

In Kubernetes, the equivalent is two env vars (`TRILIUM_METRICS=true` and `TRILIUM_METRICS_AUTH`) on the Deployment plus a ServiceMonitor with `bearerTokenSecret` pointing at the token Secret.

### Reverse-proxy hardening

`/metrics` is served on the same listener and port as `/sse` (port 3000 by default). If you don't want public scrapers hammering the auth check, gate `/metrics` at the reverse proxy and only let your monitoring network through.

**Caddy:**

```
mcp.example.com {
    @metrics path /metrics
    handle @metrics {
        # only Prometheus can even reach /metrics; everyone else gets 404
        @allowed remote_ip 10.0.0.0/8 192.168.0.0/16
        handle @allowed {
            reverse_proxy 127.0.0.1:3000
        }
        respond 404
    }
    handle {
        reverse_proxy 127.0.0.1:3000 {
            flush_interval -1
        }
    }
}
```

**nginx:**

```nginx
location = /metrics {
    allow 10.0.0.0/8;
    allow 192.168.0.0/16;
    deny all;
    proxy_pass http://127.0.0.1:3000;
}
```

This is defense-in-depth on top of the bearer auth — useful because metrics endpoints are routinely scanned by attackers, and a misconfigured `--metrics-auth=none` would otherwise leak operational data to anyone who finds the URL.

### Sample Prometheus scrape config

```yaml
scrape_configs:
  - job_name: triliumnext-mcp
    scheme: https
    static_configs:
      - targets: ['mcp.example.com']
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials: 'YOUR_GATEWAY_OR_METRICS_TOKEN'
```

### Exposed series

All series are namespaced `triliumnext_mcp_*`. Histogram buckets are in seconds.

| Series | Type | Labels | Notes |
|--------|------|--------|-------|
| `triliumnext_mcp_build_info` | gauge | `version` | Always `1`. Use for join-on-version queries. |
| `triliumnext_mcp_http_requests_total` | counter | `method`, `path`, `status` | `path` is normalized to `/health` \| `/sse` \| `/message` \| `/metrics` \| `unknown` to keep cardinality bounded. |
| `triliumnext_mcp_http_request_duration_seconds` | histogram | `method`, `path` | Buckets: `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10`. |
| `triliumnext_mcp_tool_calls_total` | counter | `tool`, `ok`, `error` | `error` is `none` on success, otherwise one of `trilium`, `zod`, `diff`, `unknown_tool`, `unknown`. |
| `triliumnext_mcp_tool_call_duration_seconds` | histogram | `tool` | Buckets: `0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60`. |
| `triliumnext_mcp_sse_sessions` | gauge | — | Current open SSE sessions. |
| `triliumnext_mcp_sse_connects_total` | counter | — | Successful SSE handshakes. |
| `triliumnext_mcp_sse_closes_total` | counter | — | SSE sessions closed by either side. |
| `triliumnext_mcp_sse_connect_failures_total` | counter | `reason` | `reason` ∈ `unauthorized` \| `missing_trilium_credentials` \| `url_rejected` \| `trilium_auth_failed` \| `trilium_validate_timeout` \| `trilium_unreachable` \| `sse_connect_failed` \| `server_misconfigured`. |
| `triliumnext_mcp_process_uptime_seconds` | gauge | — | Synced from `process.uptime()` at scrape time. |
| `triliumnext_mcp_process_resident_memory_bytes` | gauge | — | Synced from `process.memoryUsage().rss` at scrape time. |

### Cardinality and what's intentionally NOT a label

- **No `session` label.** SSE session ids are unbounded and per-connection. Use logs (which carry `session=…`) for per-session investigation; use metrics for fleet-level rollups.
- **No tenant / Trilium-host label.** Same reason — and avoids putting tenant identifiers into a scrape surface that may have different access controls than the logs.
- **No raw `path` for unknown routes.** Random scanners / typo'd URLs collapse to `unknown`, so a probe storm can't blow up cardinality.

### Useful PromQL

Tool error rate per tool:

```promql
sum by (tool) (rate(triliumnext_mcp_tool_calls_total{ok="false"}[5m]))
  /
sum by (tool) (rate(triliumnext_mcp_tool_calls_total[5m]))
```

p95 tool-call latency:

```promql
histogram_quantile(
  0.95,
  sum by (tool, le) (rate(triliumnext_mcp_tool_call_duration_seconds_bucket[5m]))
)
```

SSE connect failures by reason:

```promql
sum by (reason) (rate(triliumnext_mcp_sse_connect_failures_total[5m]))
```

## Available Tools

The server exposes **19 tools**, down from 35 in v1. The trim (see [issue #6](https://github.com/perfectra1n/triliumnext-mcp/issues/6)) improves reliability on clients that pre-load only a subset of a server's tools (claude.ai web, Cursor's 40-tool cap), and consolidates near-duplicate operations behind a `mode` or `action` discriminator. Destructive verbs (`delete_*`) stay as their own tools by design. See [Migrating from v1](#migrating-from-v1) below for the old→new mapping.

### Notes (5 tools)

The note-mutating tools (`create_note`, `write_note`, `organize_note` move/clone, and `create_revision`) include a `url` field in their response that links straight to the note in the Trilium web UI (e.g. `http://localhost:37740/#root/<path>/<noteId>`), so the assistant can hand the user a clickable link when it's done. The link base is derived from `--url`/`TRILIUM_URL` (with `/etapi` stripped) unless overridden via `--public-url`/`TRILIUM_PUBLIC_URL`.

| Tool | Description |
|------|-------------|
| `get_note` | Read a note. Returns the body, metadata, and embedded images by default; pass `include_content=false` for metadata-only reads (e.g. tree navigation). |
| `get_note_history` | Get recent changes (creations, modifications, deletions) across the tree, with optional subtree filtering. |
| `create_note` | Create a note with title, content, type, and parent. Supports inline image/file embedding. |
| `write_note` | Write to a note via `mode`: `"metadata"` (title/type/mime), `"replace"` (overwrite content), `"append"` (concatenate), `"edit"` (search/replace or unified diff). Supports inline image/file embedding in `replace`/`append` modes. |
| `delete_note` | Delete or restore a note via required `action`: `"delete"` or `"undelete"`. |

### Search & Discovery (2 tools)

| Tool | Description |
|------|-------------|
| `search_notes` | Full-text and attribute search with filters, ordering, and limits. |
| `get_note_tree` | Get children of a note for tree navigation. |

### Organization (1 tool)

| Tool | Description |
|------|-------------|
| `organize_note` | Reorganize the note tree via `action`: `"move"` (new parent), `"clone"` (appear under multiple parents), `"reorder"` (change positions), `"unlink"` (remove a branch — cascades to note deletion if it's the last branch). |

### Attributes & Labels (3 tools)

| Tool | Description |
|------|-------------|
| `get_attributes` | Get all attributes of a note (pass `noteId`) or a single attribute by ID (pass `attributeId`). |
| `set_attribute` | Upsert an attribute on a note. |
| `delete_attribute` | Remove an attribute by ID. |

### Calendar & Journal (1 tool)

| Tool | Description |
|------|-------------|
| `get_special_note` | Get the daily or inbox note via `kind`: `"day"` or `"inbox"` (optional `date`, defaults to today). |

### Attachments (4 tools)

| Tool | Description |
|------|-------------|
| `get_attachment` | Read an attachment (pass `attachmentId`) or list a note's attachments (pass `noteId`). With `attachmentId`, the body is returned by default — images come back as MCP image blocks. Pass `include_content=false` when you only need metadata (e.g. checking size before pulling a large binary). |
| `create_attachment` | Create a new attachment (image or file) for a note. |
| `write_attachment` | Write to an attachment via `mode`: `"metadata"`, `"replace"`, or `"edit"`. |
| `delete_attachment` | Delete an attachment. |

### Revisions (1 tool)

| Tool | Description |
|------|-------------|
| `get_revisions` | Get note revisions. Pass `noteId` to list all revisions of a note; pass `revisionId` for a single revision with its HTML content (pass `include_content=false` for metadata-only). |

### System (2 tools)

| Tool | Description |
|------|-------------|
| `create_revision` | Create a revision snapshot of a note. |
| `manage_system` | System ops via `action`: `"backup"` (create a DB backup by `backupName`) or `"export"` (export a note subtree as ZIP, returned base64-encoded). |

### Migrating from v1

The tool surface was consolidated in a breaking release. The mapping from the old 35-tool surface to the current 19-tool surface:

| v1 tool | v2 equivalent |
|---|---|
| `create_note` | `create_note` (unchanged) |
| `get_note` | `get_note` with `include_content=false` |
| `get_note_content` | `get_note` (default `include_content=true` returns the body) |
| `update_note` | `write_note` with `mode="metadata"` |
| `update_note_content` | `write_note` with `mode="replace"` (or `mode="edit"` for search/replace and diff) |
| `append_note_content` | `write_note` with `mode="append"` (or `mode="edit"` for search/replace and diff) |
| `delete_note` | `delete_note` with `action="delete"` (**required**, no default) |
| `undelete_note` | `delete_note` with `action="undelete"` |
| `get_note_attachments` | `get_attachment` with `noteId` (list form) |
| `get_note_history` | `get_note_history` (unchanged) |
| `search_notes` | `search_notes` (unchanged) |
| `get_note_tree` | `get_note_tree` (unchanged) |
| `move_note` | `organize_note` with `action="move"` |
| `clone_note` | `organize_note` with `action="clone"` |
| `reorder_notes` | `organize_note` with `action="reorder"` |
| `delete_branch` | `organize_note` with `action="unlink"` |
| `get_attributes` | `get_attributes` with `noteId` |
| `get_attribute` | `get_attributes` with `attributeId` |
| `set_attribute` | `set_attribute` (unchanged) |
| `delete_attribute` | `delete_attribute` (unchanged) |
| `get_day_note` | `get_special_note` with `kind="day"` |
| `get_inbox_note` | `get_special_note` with `kind="inbox"` |
| `create_attachment` | `create_attachment` (unchanged) |
| `get_attachment` | `get_attachment` with `include_content=false` |
| `get_attachment_content` | `get_attachment` (default `include_content=true` returns the body) |
| `update_attachment` | `write_attachment` with `mode="metadata"` |
| `update_attachment_content` | `write_attachment` with `mode="replace"` or `mode="edit"` |
| `delete_attachment` | `delete_attachment` (unchanged) |
| `get_note_revisions` | `get_revisions` with `noteId` |
| `get_revision` | `get_revisions` with `revisionId` and `include_content=false` |
| `get_revision_content` | `get_revisions` with `revisionId` (default `include_content=true` returns the HTML body) |
| `create_revision` | `create_revision` (unchanged) |
| `create_backup` | `manage_system` with `action="backup"` |
| `export_note` | `manage_system` with `action="export"` |
| `search_tools` | *dropped* (with 19 tools, client-side discovery is no longer needed) |

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

The `write_note` tool selects behavior via `mode`:

1. **`"metadata"`** — update title/type/mime only (no content change)
2. **`"replace"`** — overwrite content entirely with `content`. Supports `images`/`files` embedding and markdown conversion.
3. **`"append"`** — fetch existing content and concatenate `content` at the end. Supports `images`/`files` embedding and markdown conversion.
4. **`"edit"`** — apply `changes` (array of `{old_string, new_string}`) OR `patch` (unified diff) to existing content. Operates on stored HTML; cannot be combined with `format="markdown"` or `images`/`files`.

`write_attachment` follows the same shape with `"metadata"`, `"replace"`, and `"edit"` modes.

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

### StreamableHTTP transport

In addition to the older HTTP+SSE transport (`GET /sse` + `POST /message`), this server exposes the newer **StreamableHTTP** transport at `GET|POST|DELETE /mcp` on the same port. StreamableHTTP is the direction MCP is heading — single endpoint, session id in a header instead of a query string, optional resumability via Last-Event-ID. Both transports run side-by-side; clients can pick whichever the SDK they ship supports.

**Initialize handshake (POST /mcp):**

```bash
curl -X POST https://mcp.example.com/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Trilium-Url: https://notes.example.com" \
  -H "X-Trilium-Token: $ETAPI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2024-11-05","capabilities":{},
                 "clientInfo":{"name":"my-app","version":"1.0.0"}}}'
```

The response carries an `MCP-Session-Id` header. Subsequent requests echo it back:

```bash
curl -X POST https://mcp.example.com/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "MCP-Session-Id: <sid>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

`DELETE /mcp` with the session id closes the session cleanly. The gateway-auth / SSRF / rate-limit / Trilium-validation pipeline is identical to `/sse` — switching transports never changes the security surface.

**TypeScript SDK:**

```ts
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(new URL('https://mcp.example.com/mcp'), {
  requestInit: {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'X-Trilium-Url': 'https://notes.example.com',
      'X-Trilium-Token': ETAPI_TOKEN,
    },
  },
});
const client = new Client({ name: 'my-app', version: '1.0.0' });
await client.connect(transport);
```

### JWT / OIDC gateway auth

For per-user identity, use `--gateway-auth jwt` instead of `bearer`. Tokens are validated for signature, expiration (`exp`), not-before (`nbf`), and (optionally) issuer + audience. The authenticated **principal claim** (default `sub`) is threaded into every audit log line and — opt-in — into metric labels.

**HS256 shared secret(s):**

```bash
node dist/index.js \
  --transport http \
  --multi-tenant \
  --gateway-auth jwt \
  --jwt-secret "$JWT_SHARED_SECRET" \
  --jwt-issuer "https://idp.example.com" \
  --jwt-audience "mcp-gateway"
```

`--jwt-secret` is repeatable so you can roll secrets: deploy the new one alongside the old, then drop the old once all issuers have rotated.

**RS256 / ES256 / EdDSA via JWKS:**

```bash
node dist/index.js \
  --transport http --multi-tenant \
  --gateway-auth jwt \
  --jwt-jwks-url "https://idp.example.com/.well-known/jwks.json" \
  --jwt-issuer "https://idp.example.com" \
  --jwt-audience "mcp-gateway"
```

The JWKS URL is fetched on demand and cached; key rotation works automatically as the IdP publishes new keys.

**Customize the principal claim:**

```bash
--jwt-principal-claim email   # use the email claim instead of sub
```

Env equivalents: `TRILIUM_JWT_SECRETS` (CSV), `TRILIUM_JWT_JWKS_URL`, `TRILIUM_JWT_ISSUER`, `TRILIUM_JWT_AUDIENCE`, `TRILIUM_JWT_PRINCIPAL_CLAIM`. Validation: `--gateway-auth jwt` requires at least one secret OR a JWKS URL, else startup fails.

**Algorithms accepted (default set):** `HS256 HS384 HS512 RS256 RS384 RS512 ES256 ES384 EdDSA`. `alg=none` is always rejected.

### CORS

Off by default. For browser-based clients, allow specific origins:

```bash
--cors-origin https://app.example.com --cors-origin https://admin.example.com
# or wildcard (echoes Origin so credentials still work):
--cors-origin '*'
```

Env: `TRILIUM_CORS_ORIGINS=https://a.example.com,https://b.example.com`. Preflight (OPTIONS) responses allow `Authorization`, `X-Trilium-Url`, `X-Trilium-Token`, `MCP-Session-Id`, and `Content-Type` by default. The server never emits literal `Allow-Origin: *` even in wildcard mode — it always echoes the request `Origin`, because browsers reject wildcards with credentials.

### Rate limiting

In-process token-bucket limiter, applied per remote IP **and** per gateway bearer/JWT token (whichever appears in `Authorization`). Both axes are enforced independently — exceeding either limit returns `429 rate_limited` with a `Retry-After` header.

```bash
--rate-limit-rps 10 --rate-limit-burst 30
```

Env: `TRILIUM_RATE_LIMIT_RPS`, `TRILIUM_RATE_LIMIT_BURST`. `/health` is never rate-limited (cheap liveness). `/metrics` is rate-limited like everything else.

This is in-process, not a Redis-backed distributed limiter — multi-replica deployments should also limit at the reverse proxy, with this server's limits as defense-in-depth.

### Per-tenant audit + metrics

With `--gateway-auth jwt`, every audit log line carries the authenticated `principal` field — both `tool_call` and `mcp_session_opened`/`sse_connected` events. That gives you per-user tool usage in your log shipper without any extra work.

For Prometheus, the per-principal counter is **opt-in** for cardinality safety:

```bash
--metrics --metrics-include-principal
```

Env: `TRILIUM_METRICS_INCLUDE_PRINCIPAL=true`. When on, a new series appears:

```
# HELP triliumnext_mcp_tool_calls_by_principal_total Per-principal tool invocation counter…
# TYPE triliumnext_mcp_tool_calls_by_principal_total counter
triliumnext_mcp_tool_calls_by_principal_total{principal="alice@example.com",tool="search_notes",ok="true",error="none"} 12
```

Cardinality scales as principals × tools × outcomes. Only enable when your principal namespace is bounded (e.g., a known IdP user list). The base `tool_calls_total` series stays principal-free and is always safe to enable.

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
| `400`  | `invalid_json`          | Body wasn't valid JSON. |
| `404`  | `unknown_session`       | `sessionId` doesn't match any live SSE connection (typical after a disconnect / restart). |
| `413`  | `payload_too_large`     | Body exceeded `--max-post-bytes` (default 500 MB). See [Request body size limits](#request-body-size-limits). |

### Request body size limits

The HTTP/SSE transport caps each MCP JSON-RPC POST body at **500 MB by default**. Tune it with `--max-post-bytes <size>` or `TRILIUM_MAX_POST_BYTES` (e.g. `100mb`, `2gb`, or a raw byte count). On stdio there is no equivalent cap — your shell / OS pipe buffers are the limit.

Why this exists, and a few caveats worth knowing:

- **The MCP SDK has its own internal 4 MB cap** inside `handlePostMessage`. To honor anything larger, this server reads and JSON-parses the request body itself before handing it off, bypassing the SDK's read. If you fork or upgrade and bodies start failing at ~4 MB with `400` from the SDK, this read-and-pass-through is what's missing.
- **Bodies are buffered in memory** before dispatch. A 500 MB cap means a single connection can ask for 500 MB of heap. On a multi-tenant deployment, set the cap to the smallest value your largest legitimate attachment needs.
- **Attachments are base64-encoded over JSON-RPC**, which inflates payload size by ~33%. A 100 MB binary becomes ~134 MB on the wire.
- **413 is returned as soon as we can detect the overrun** — either from `Content-Length` upfront (no body drain) or mid-stream once accumulated bytes exceed the cap. Chunked uploads without `Content-Length` still get capped via the streaming check.
- **Reverse proxies have their own limits.** Nginx defaults to `client_max_body_size 1m`; bump it (`client_max_body_size 600m;` or similar) or large requests die at the proxy with `413` before they reach this server. Caddy has no default cap.

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
- **Per-principal identity** is available via `--gateway-auth jwt` ([above](#jwt--oidc-gateway-auth)). When you need to attribute actions to specific users, prefer JWT over a shared bearer token — the authenticated principal threads automatically into audit logs and (opt-in) into per-principal metric labels.

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
