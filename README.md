# TriliumNext MCP Server

A Model Context Protocol (MCP) server for interacting with [TriliumNext](https://github.com/TriliumNext/Notes) via its ETAPI. Enables LLMs to create, read, update, and organize notes — including embedding images and files directly into note content.

## Contents

- [Features](#features)
- [Installation](#installation)
- [Configuration](#configuration) — CLI, env vars, config file · [Limits and tuning](#limits-and-tuning)
- [Logging](#logging) — what gets logged, where it goes, how to tune it
- [Metrics](#metrics) — Prometheus `/metrics` endpoint, auth modes, exposed series
- [Available Tools](#available-tools)
- [Embedding Images and Files](#embedding-images-and-files)
- [Multi-tenant HTTP deployment](#multi-tenant-http-deployment) — run one server for many users
  - [Architecture](#architecture)
  - [Quick start (Docker)](#quick-start-docker) / [(local)](#quick-start-local)
  - [HTTP endpoints](#http-endpoints) · [Error responses](#error-responses) · [Request body size limits](#request-body-size-limits)
  - [Connecting clients](#connecting-clients) — Claude Desktop, Claude Code, SDK
  - [JWT / OIDC gateway auth](#jwt--oidc-gateway-auth) · [CORS](#cors) · [Rate limiting](#rate-limiting) · [Host header check](#host-header-check-dns-rebinding)
  - [StreamableHTTP transport](#streamablehttp-transport) — newer MCP transport alongside `/sse`
  - [Per-tenant audit + metrics](#per-tenant-audit--metrics)
  - [SSRF configuration](#ssrf-configuration) · [Reverse-proxy](#reverse-proxy-tls-termination)
  - [Security model](#security-model) · [Troubleshooting](#troubleshooting)
- [Debugging with MCP Inspector](#debugging-with-mcp-inspector)
- [Development](#development) — build, test, docker
- [Getting an ETAPI Token](#getting-an-etapi-token)

## Features

- **20 tools** across 8 categories for full note management, search, organization, attachments, revisions, and system operations (consolidated from 35 in v1 — see [Migrating from v1](#migrating-from-v1))
- **Server-built note links** — write `<a href="note:abc123">` or `[text](note:abc123)` and the server emits a proper Trilium reference link (path, `class`, `data-note-path`), rejecting links to notes that don't exist
- **Note context on demand** — `get_note` can return tree breadcrumbs (`include_path`) and backlinks (`include_backlinks`); `search_notes` can attach plain-text content previews (`content_preview_chars`)
- **Revision restore** — `restore_revision` rolls a note back, snapshotting the current state first so the restore is reversible
- **Resilient ETAPI client** — per-request timeouts, automatic retry of idempotent requests on network errors and 502/503/504, and clear `TRILIUM_UNREACHABLE` / `TRILIUM_TIMEOUT` errors
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
- `--host <addr>` — interface the HTTP transport binds to (default: `127.0.0.1`; env `TRILIUM_HTTP_HOST`). Use `0.0.0.0` (or `::`) to accept connections from other machines. **The Docker image sets `TRILIUM_HTTP_HOST=0.0.0.0`**, since a loopback bind is unreachable through a published container port. See [Host header check](#host-header-check-dns-rebinding).
- `--allowed-hosts <hosts>` — extra `Host` header values (hostname, optional `:port`, comma-separated, repeatable; env `TRILIUM_ALLOWED_HOSTS`) accepted while bound to loopback. On a non-loopback bind, setting this turns the Host check on.
- `--trusted-proxies <cidrs>` — reverse-proxy IPs/CIDRs whose `X-Forwarded-For` is trusted for rate limiting (env `TRILIUM_TRUSTED_PROXIES`). See [Rate limiting](#rate-limiting).
- `--max-post-bytes <size>` — max size of a single MCP JSON-RPC POST body (`/message` and `/mcp`). Accepts raw bytes or suffixed values like `500mb` / `1gb` (default: `64mb`). See [Request body size limits](#request-body-size-limits).
- `-h, --help` — Show help message

Content input options (see [Providing file content](#providing-file-content-paths-urls-base64)):
- `--allow-local-file-read` / `--no-local-file-read` — permit tool inputs that name local file paths (default: on for stdio, off for `--transport http`)
- `--local-file-roots <dirs>` — comma-separated directories content may be read from (default: unrestricted when reads are allowed)
- `--content-url-allowlist <hosts>` — comma-separated hostnames permitted for http(s) content fetches (default: any public host)
- `--content-allow-private-urls` — let content URL fetches reach private/loopback addresses. Default: off in multi-tenant mode; otherwise it follows `--allow-private-urls` (see [below](#providing-file-content-paths-urls-base64))
- `--max-content-fetch-bytes <size>` — max content file read / URL download size (default: `50mb`)

Multi-tenant HTTP options (see [Multi-tenant HTTP deployment](#multi-tenant-http-deployment) below):
- `--multi-tenant` — each SSE client supplies its own Trilium URL + token
- `--gateway-auth <mode>` — `none`, `bearer` or `jwt` (default: `bearer` when multi-tenant, `none` otherwise; see [JWT / OIDC gateway auth](#jwt--oidc-gateway-auth))
- `--gateway-token <token>` — accepted bearer token (repeatable)
- `--trilium-url-allowlist <hosts>` — comma-separated allowed hostnames for client URLs
- `--allow-private-urls` — skip the private/loopback IP SSRF block for client-supplied Trilium URLs (in multi-tenant mode it no longer opens up content URL fetches; use `--content-allow-private-urls` for that)

### Environment Variables

```bash
export TRILIUM_URL=http://localhost:37740/etapi
export TRILIUM_TOKEN=your-etapi-token
export TRILIUM_PUBLIC_URL=https://trilium.example.com  # optional; web URL for note links (defaults to TRILIUM_URL without /etapi)
export TRILIUM_TRANSPORT=stdio
export TRILIUM_HTTP_PORT=3000
export TRILIUM_HTTP_HOST=127.0.0.1   # bind address; the Docker image sets 0.0.0.0
export TRILIUM_ALLOWED_HOSTS=mcp.example.com  # extra Host values accepted on a loopback bind
export TRILIUM_TRUSTED_PROXIES=127.0.0.1      # proxies whose X-Forwarded-For is trusted (rate limiting)
export TRILIUM_MAX_POST_BYTES=64mb   # MCP POST body cap; see "Request body size limits"
export TRILIUM_REQUEST_TIMEOUT=60s   # per-request ETAPI timeout (ms, or 90s / 2m); see "Reliability"
export TRILIUM_BUSY_COOLDOWN=30s     # how long a timed-out Trilium is treated as busy
export TRILIUM_SEARCH_STRATEGY=auto  # search_notes default: auto | fast | full

# Content input (file paths / URLs in attachment and image tool inputs):
export TRILIUM_ALLOW_LOCAL_FILE_READ=true   # default: true for stdio, false for http
export TRILIUM_LOCAL_FILE_ROOTS=/srv/uploads
export TRILIUM_CONTENT_URL_ALLOWLIST=example.com
export TRILIUM_CONTENT_ALLOW_PRIVATE_URLS=false  # default: false in multi-tenant, else TRILIUM_ALLOW_PRIVATE_URLS
export TRILIUM_MAX_CONTENT_FETCH_BYTES=50mb

# Multi-tenant (see section below):
export TRILIUM_MULTI_TENANT=true
export TRILIUM_GATEWAY_AUTH=bearer
export TRILIUM_GATEWAY_TOKENS=tok1,tok2
export TRILIUM_URL_ALLOWLIST=notes.example.com,trilium.internal
export TRILIUM_ALLOW_PRIVATE_URLS=false
```

Invalid values are errors, not silent fallbacks: an unparseable size, duration, integer, boolean (`true`/`false`, `1`/`0`, `yes`/`no`) or enum value (`TRILIUM_SEARCH_STRATEGY`, `TRILIUM_TRANSPORT`, `TRILIUM_GATEWAY_AUTH`, `TRILIUM_METRICS_AUTH` — matched case-insensitively) stops startup with a message naming the variable. An empty variable counts as unset.

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
  "allowPrivateUrls": false,
  "contentAllowPrivateUrls": false,
  "trustedProxies": ["127.0.0.1"]
}
```

Config-file values are type-checked like everything else: numbers must be JSON numbers in range, booleans must be `true`/`false`, and lists must be arrays of strings (a comma-separated string is also accepted).

### Limits and tuning

Every size cap, timeout, retry and search limit can be changed. Each setting follows the same precedence as everything else (CLI > env > config file > default). Sizes accept raw bytes or suffixed values (`512kb`, `5mb`, `1gb`); durations accept milliseconds or `500ms` / `90s` / `2m`. An unparseable or out-of-range value from any source (CLI, env or config file) is an error that names the setting. Config-file keys take plain numbers (bytes, milliseconds, or the integer).

`0` is accepted only where it means something: the inline caps (`TRILIUM_MAX_INLINE_ATTACHMENT_BYTES`, `TRILIUM_MAX_NOTE_IMAGE_BYTES`, `TRILIUM_MAX_NOTE_IMAGES_TOTAL_BYTES` — `0` = never inline), `TRILIUM_MAX_RETRIES` (`0` = no retries), `TRILIUM_SESSION_IDLE_TTL` (`0` = never expire), `TRILIUM_SEARCH_PREVIEW_MAX_RESULTS`, `TRILIUM_JWT_CLOCK_TOLERANCE` and the rate limits (`0` = off). Every other size and timeout must be greater than zero, and no duration may exceed what a timer can represent (~24.8 days; `TRILIUM_REQUEST_TIMEOUT` a fifth of that, since export/import get 5×).

The inline caps `TRILIUM_MAX_INLINE_ATTACHMENT_BYTES`, `TRILIUM_MAX_NOTE_IMAGE_BYTES` and `TRILIUM_MAX_EXPORT_BYTES` can't exceed `TRILIUM_MAX_RESPONSE_BYTES` (those bodies are read through the same client, which refuses anything larger first). Setting one higher is a startup error; if you only lower `TRILIUM_MAX_RESPONSE_BYTES`, the caps you didn't set shrink to fit.

Tool descriptions that mention a limit (e.g. get_attachment's inline cap) are built from the configured value at startup.

**Memory and payload caps** — on a small container (e.g. a 256 MiB limit) lower `TRILIUM_MAX_RESPONSE_BYTES` first: it bounds what any single Trilium response may occupy before it is refused.

| Env var | CLI flag | Config-file key | Default | Meaning |
|---------|----------|-----------------|---------|---------|
| `TRILIUM_MAX_RESPONSE_BYTES` | `--max-response-bytes` | `maxResponseBytes` | `64mb` | Largest ETAPI response body buffered for any request. Larger bodies are refused from their `Content-Length`, or cut off mid-stream, instead of being read into memory (`RESPONSE_TOO_LARGE`). |
| `TRILIUM_MAX_INLINE_ATTACHMENT_BYTES` | `--max-inline-attachment-bytes` | `maxInlineAttachmentBytes` | `5mb` | `get_attachment` returns image attachments as image blocks and other binaries as base64 resources up to this size; larger ones return metadata plus a notice telling the model to have the user open them in Trilium. Checked against the declared size before fetching and again on the bytes received. `0` = never inline. |
| `TRILIUM_MAX_NOTE_IMAGE_BYTES` | `--max-note-image-bytes` | `maxNoteImageBytes` | `1mb` | `get_note` inlines each image embedded in the body (and the content of an image note) up to this size. `0` = never. |
| `TRILIUM_MAX_NOTE_IMAGES_TOTAL_BYTES` | `--max-note-images-total-bytes` | `maxNoteImagesTotalBytes` | `4mb` | Total embedded-image bytes `get_note` inlines per call; the rest are listed for `get_attachment`. `0` = never. |
| `TRILIUM_MAX_EXPORT_BYTES` | `--max-export-bytes` | `maxExportBytes` | `10mb` | Largest export ZIP `manage_system` returns inline (enforced while downloading). Must be > 0. |
| `TRILIUM_CONTENT_CHAR_CAP` | `--content-char-cap` | `contentCharCap` | `50000` | Text characters returned per read: `get_note`'s default page, and the truncation point for revision and text-attachment bodies. |
| `TRILIUM_CONTENT_MAX_CHARS_LIMIT` | `--content-max-chars-limit` | `contentMaxCharsLimit` | `500000` | Highest `content_max_chars` a `get_note` call may request. |
| `TRILIUM_MAX_CONTENT_FETCH_BYTES` | `--max-content-fetch-bytes` | `maxContentFetchBytes` | `50mb` | Max content file read / URL download for attachment and image inputs. Must be > 0. |
| `TRILIUM_MAX_POST_BYTES` | `--max-post-bytes` | `maxPostBytes` | `64mb` | Max MCP POST body on the HTTP transport (`/message` and `/mcp`). Must be > 0. |

**Timeouts and retries**

| Env var | CLI flag | Config-file key | Default | Meaning |
|---------|----------|-----------------|---------|---------|
| `TRILIUM_REQUEST_TIMEOUT` | `--request-timeout` | `requestTimeoutMs` | `60s` | Per-request ETAPI timeout; export, import and backup get 5× (existing). |
| `TRILIUM_BUSY_COOLDOWN` | `--busy-cooldown` | `busyCooldownMs` | `30s` | How long a timed-out Trilium is treated as busy (existing). |
| `TRILIUM_BUSY_PROBE_TIMEOUT` | `--busy-probe-timeout` | `busyProbeTimeoutMs` | `5s` | Timeout for non-search requests while a Trilium is marked busy. |
| `TRILIUM_MAX_RETRIES` | `--max-retries` | `maxRetries` | `2` | Retries for idempotent requests on network errors and 502/503/504 (`0` disables, max `10`). |
| `TRILIUM_RETRY_DELAY` | `--retry-delay` | `retryDelayMs` | `250ms` | Base retry backoff, doubled on each attempt (max `60s`). |
| `TRILIUM_CONTENT_FETCH_TIMEOUT` | `--content-fetch-timeout` | `contentFetchTimeoutMs` | `30s` | Timeout for each http(s) download of attachment/image content. |
| `TRILIUM_PROGRESS_INTERVAL` | `--progress-interval` | `progressIntervalMs` | `10s` | Progress heartbeat cadence during a tool call that sent a `progressToken`. |

**Search and navigation**

| Env var | CLI flag | Config-file key | Default | Meaning |
|---------|----------|-----------------|---------|---------|
| `TRILIUM_SEARCH_STRATEGY` | `--search-strategy` | `searchStrategy` | `auto` | Default `search_notes` strategy: `auto` (titles and labels first, note bodies only if that finds too few), `fast` (never bodies) or `full` (always bodies). Case-insensitive. |
| `TRILIUM_DEFAULT_SEARCH_LIMIT` | `--default-search-limit` | `defaultSearchLimit` | `50` | `search_notes` results when the call passes no `limit` (clamped to the maximum). |
| `TRILIUM_MAX_SEARCH_LIMIT` | `--max-search-limit` | `maxSearchLimit` | `10000` | Highest `limit` a `search_notes` call may request; also caps the fuzzy recall window. |
| `TRILIUM_SEARCH_FAST_MIN_RESULTS` | `--search-fast-min-results` | `searchFastMinResults` | `5` | Under `strategy: "auto"`, a title/label pass with at least this many hits (or `limit`, if smaller) skips the body search. |
| `TRILIUM_SEARCH_PREVIEW_MAX_RESULTS` | `--search-preview-max-results` | `searchPreviewMaxResults` | `20` | Results that get a `contentPreview` (each costs one content fetch). |
| `TRILIUM_FETCH_CONCURRENCY` | `--fetch-concurrency` | `fetchConcurrency` | `5` | Max in-flight ETAPI requests for search previews and `get_note_tree` fan-out. |
| `TRILIUM_TREE_MAX_NOTES` | `--tree-max-notes` | `treeMaxNotes` | `200` | Notes fetched per `get_note_tree` call before it reports `truncated`. |
| `TRILIUM_FUZZY_MAX_TERMS` | `--fuzzy-max-terms` | `fuzzyMaxTerms` | `8` | Fuzzy fallback: max words turned into the OR query. |
| `TRILIUM_FUZZY_RECALL_MULTIPLIER` | `--fuzzy-recall-multiplier` | `fuzzyRecallMultiplier` | `4` | Fuzzy fallback: candidates fetched per result returned. |
| `TRILIUM_FUZZY_RECALL_CAP` | `--fuzzy-recall-cap` | `fuzzyRecallCap` | `200` | Fuzzy fallback: candidate window cap (never below the caller's `limit`). |
| `TRILIUM_NOTE_MAX_PATHS` | `--note-max-paths` | `noteMaxPaths` | `10` | `get_note include_path`: max tree placements walked. |
| `TRILIUM_NOTE_MAX_BACKLINKS` | `--note-max-backlinks` | `noteMaxBacklinks` | `50` | `get_note include_backlinks`: max backlinks returned. |
| `TRILIUM_HISTORY_LIMIT` | `--history-limit` | `historyLimit` | `100` | `get_note_history` default `limit` (clamped to the maximum). |
| `TRILIUM_HISTORY_MAX_LIMIT` | `--history-max-limit` | `historyMaxLimit` | `1000` | Highest `limit` a `get_note_history` call may request. |

**HTTP transport sessions** (ignored on stdio)

| Env var | CLI flag | Config-file key | Default | Meaning |
|---------|----------|-----------------|---------|---------|
| `TRILIUM_SSE_KEEPALIVE` | `--sse-keepalive` | `sseKeepaliveMs` | `30s` | Keep-alive ping cadence on `/sse` streams. |
| `TRILIUM_SESSION_IDLE_TTL` | `--session-idle-ttl` | `sessionIdleTtlMs` | `30m` | Close Streamable HTTP sessions with no requests for this long; a session holding a `GET /mcp` stream open counts as active. `0` disables expiry. |
| `TRILIUM_SESSION_SWEEP_INTERVAL` | `--session-sweep-interval` | `sessionSweepIntervalMs` | min(60s, max(1s, TTL/2)) | How often idle sessions are swept. |
| `TRILIUM_MAX_SESSIONS` | `--max-sessions` | `maxSessions` | `1000` | Max concurrently open sessions across `/sse` and `/mcp`; more get `503 too_many_sessions`. |
| `TRILIUM_VALIDATE_TIMEOUT` | `--validate-timeout` | `triliumValidateTimeoutMs` | `10s` | Timeout of the Trilium probe made when a session connects. |
| `TRILIUM_JWT_CLOCK_TOLERANCE` | `--jwt-clock-tolerance` | `jwtClockToleranceSec` | `30` | Seconds of clock skew tolerated on JWT `exp`/`nbf`. |
| `TRILIUM_RATE_LIMIT_RPS` / `TRILIUM_RATE_LIMIT_BURST` | `--rate-limit-rps` / `--rate-limit-burst` | `rateLimitRps` / `rateLimitBurst` | `0` (off) | Per-IP and per-token rate limit (see [Rate limiting](#rate-limiting)). |
| `TRILIUM_TRUSTED_PROXIES` | `--trusted-proxies` | `trustedProxies` | *(none)* | Proxy IPs/CIDRs whose `X-Forwarded-For` the rate limiter believes (see [Rate limiting](#rate-limiting)). |


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
2026-05-12T18:16:40.871Z INFO  list_tools session=2f1c... count=20
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
| `url_rejected`          | warn  | `reason`, `stage?`, `detail?`                          | SSRF guard rejected the client URL — up front, or (`stage=connect`) when the address actually connected to was private. `detail` (resolved address) is log-only, never sent to the client. |
| `trilium_auth_failed`   | warn  | `host`, `status?`, `code?`                             | Trilium returned an error to the connect-time probe. `status`/`code` are dropped when they aren't a valid HTTP status / short identifier (they can come from the remote body). |
| `trilium_validate_timeout` | warn | `host`                                                | Probe exceeded `--validate-timeout` (default 10 s). |
| `request_rejected`      | warn  | `reason`, `remote`, `path`, `host`, `origin`           | Host/Origin guard refused the request (`host_not_allowed`, `missing_host`, `origin_not_allowed`). `host`/`origin` are the client's headers, with non-printable characters replaced and truncated to 128 chars. |
| `rate_limited`          | warn  | `remote`, `client?`, `path`, `reason`, `retry_after_s` | A rate-limit bucket was empty. `client` is the forwarded address the limiter keyed on, when it differs from `remote` (trusted proxy). |
| `session_limit_reached` | warn  | `transport`, `open`, `pending`, `max`                  | `--max-sessions` reached (sessions still connecting count too); the client got `503 too_many_sessions`. |
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

The server exposes **20 tools**, down from 35 in v1. The trim (see [issue #6](https://github.com/perfectra1n/triliumnext-mcp/issues/6)) improves reliability on clients that pre-load only a subset of a server's tools (claude.ai web, Cursor's 40-tool cap), and consolidates near-duplicate operations behind a `mode` or `action` discriminator. Destructive verbs (`delete_*`) stay as their own tools by design. See [Migrating from v1](#migrating-from-v1) below for the old→new mapping.

### Notes (5 tools)

The note-mutating tools (`create_note`, `write_note`, `organize_note` move/clone, and `create_revision`) include a `url` field in their response that links straight to the note in the Trilium web UI (e.g. `http://localhost:37740/#root/<path>/<noteId>`), so the assistant can hand the user a clickable link when it's done. The link base is derived from `--url`/`TRILIUM_URL` (with `/etapi` stripped) unless overridden via `--public-url`/`TRILIUM_PUBLIC_URL`.

| Tool | Description |
|------|-------------|
| `get_note` | Read a note. Returns a metadata block (with a `contentInfo` size summary), the body, and embedded images by default; bodies over 50k chars are truncated with paging via `content_start`/`content_max_chars`. Pass `include_content=false` for metadata-only reads (e.g. tree navigation), `include_path=true` for title breadcrumbs of every placement (`root > Projects > Plan`), and `include_backlinks=true` for the notes that link to it. |
| `get_note_history` | Get recent changes (creations, modifications, deletions) across the tree, with optional subtree filtering. Returns `{changes, total, returned, truncated}`, bounded by `limit` (default 100, max 1000). |
| `create_note` | Create a note with title, content, type, and parent. Supports inline image/file embedding, `note:` link placeholders, and backdating (`dateCreated`, `utcDateCreated`, `utcDateModified`). |
| `write_note` | Write to a note via `mode`: `"metadata"` (title/type/mime and the date fields), `"replace"` (overwrite content), `"append"` (concatenate), `"edit"` (search/replace or unified diff). Supports inline image/file embedding in `replace`/`append` modes, and `note:` link placeholders on text notes. |
| `delete_note` | Delete or restore a note via required `action`: `"delete"` or `"undelete"`. |

### Search & Discovery (2 tools)

| Tool | Description |
|------|-------------|
| `search_notes` | Full-text and attribute search with filters, subtree scoping (`ancestorNoteId` + `ancestorDepth`), ordering, limits, query-parse diagnostics (`debug`), and optional plain-text `contentPreview`s on the top 20 results (`content_preview_chars`). Plain-fulltext queries that return zero results are automatically retried as a relevance-ranked OR over the individual terms — see [Graceful fuzzy fallback](#graceful-fuzzy-fallback) below. |
| `get_note_tree` | Explore the hierarchy: children expanded `depth` levels (1-5) with titles, types, child counts, and branch IDs. |

#### Graceful fuzzy fallback

Trilium ANDs fulltext terms, so `体积云 Niagara 教程` returns **nothing** if any single term is
wrong — and zero results tell the caller nothing about which term was the bad one. `search_notes`
therefore retries such queries automatically.

`fuzzy` controls this:

| Value | Behavior |
|-------|----------|
| `auto` (default) | Run the query as written. If it returns **zero** results and the query is eligible, retry it as an OR over the individual terms, ranked by relevance. |
| `off` | Never retry. Strict Trilium semantics, byte-identical to the pre-fallback response. |
| `force` | Skip the exact attempt and go straight to the ranked OR search. |

A query is **eligible** only if it is plain fulltext with two or more terms. Attribute filters
(`#project`), property expressions (`note.title *=* x`), `id:`/`title:` prefixes, and queries that
already contain `or` are never retried — OR-expanding them would change what was asked, not widen it.
Terms are capped at 8, since each becomes an unindexed substring scan.

When the fallback fires, the response gains sibling fields alongside the usual `results` (the note
objects themselves are never modified):

```jsonc
{
  "results": [ /* ...unmodified notes, most relevant first... */ ],
  "searchMode": "fuzzy",
  "fuzzyTerms": ["体积云", "Niagara", "教程"],
  "totalCandidates": 12,
  "termsMatchedInTitleOrAttributes": { "体积云": 12, "Niagara": 0, "教程": 9 },
  "note": "..."
}
```

`termsMatchedInTitleOrAttributes` is the "which term was wrong?" signal — a `0` means that term
appeared in no returned note's title or attributes, so it is the one to drop and re-query without.

**Ranking is title- and attribute-only.** Trilium's ETAPI search response carries no note content,
so scoring content would cost one extra HTTP request per candidate. A note that matched only in its
body is therefore still returned — never filtered out — but scores zero and ranks last. Check
`totalCandidates` against `results.length` to see whether you are looking at a truncated view.
If `orderBy` is set it is honored: the OR query still widens recall, but results keep your ordering
rather than being re-ranked.

### Organization (1 tool)

| Tool | Description |
|------|-------------|
| `organize_note` | Reorganize the note tree via `action`: `"move"` (new parent), `"clone"` (appear under multiple parents), `"reorder"` (change positions), `"unlink"` (remove a branch — cascades to note deletion if it's the last branch). For a cloned note, `move` requires `fromParentNoteId` to say which placement moves; moving onto a parent the note is already under is a no-op. |

### Attributes & Labels (3 tools)

| Tool | Description |
|------|-------------|
| `get_attributes` | Get all attributes of a note (pass `noteId`) or a single attribute by ID (pass `attributeId`). |
| `set_attribute` | Upsert an attribute on a note (default), or `mode="add"` to always create — enabling multiple same-name labels. |
| `delete_attribute` | Remove an attribute by ID. |

### Calendar & Journal (1 tool)

| Tool | Description |
|------|-------------|
| `get_special_note` | Get a periodic or inbox note via `kind`: `"day"`, `"week"`, `"month"`, `"year"`, `"inbox"`, or `"week_first_day"` (the day note starting the week — works without week notes enabled). Optional `date` in the kind's format, defaults to the current period. |

### Attachments (4 tools)

| Tool | Description |
|------|-------------|
| `get_attachment` | Read an attachment (pass `attachmentId`) or list a note's attachments (pass `noteId`). With `attachmentId`, the body is returned by default — images come back as MCP image blocks. Pass `include_content=false` when you only need metadata (e.g. checking size before pulling a large binary). |
| `create_attachment` | Create a new attachment (image or file) for a note. Binary content as base64 or a data URL. |
| `write_attachment` | Write to an attachment via `mode`: `"metadata"`, `"replace"`, or `"edit"`. |
| `delete_attachment` | Delete an attachment. |

### Revisions (2 tools)

| Tool | Description |
|------|-------------|
| `get_revisions` | Get note revisions. Pass `noteId` to list all revisions of a note; pass `revisionId` for a single revision with its HTML content (pass `include_content=false` for metadata-only). |
| `restore_revision` | Restore a note to a revision: content (text or binary), type/mime, and by default title. Snapshots the current state first (`snapshot_current`, default `true`) so the restore can itself be undone. |

### System (2 tools)

| Tool | Description |
|------|-------------|
| `create_revision` | Create a revision snapshot of a note. |
| `manage_system` | System ops via `action`: `"backup"` (create a DB backup by `backupName`), `"export"` (export a note subtree as ZIP, returned base64-encoded), `"import"` (import a base64 ZIP under a parent note), `"app_info"` (Trilium version/diagnostics), or `"metrics"` (note/attachment/revision/attribute counts and per-type breakdowns). |

### Linking notes

Trilium only renders a true note-to-note link when the anchor carries `class="reference-link"`, an `href="#root/<path>"` **and** a matching `data-note-path` — anything else is stored as an inert hash anchor. Instead of building that by hand, write a placeholder and let the server resolve it:

```markdown
See [the project plan](note:abc123def) and [](note:xyz789ghi).
```

```html
<p>See <a href="note:abc123def">the project plan</a>.</p>
```

Each `note:<noteId>` link becomes a full reference link built from the target's tree path; an empty link text is filled with the target's title. Unknown note IDs fail the write with `NOTE_NOT_FOUND` rather than storing a dead link. Placeholders are resolved on `create_note` and `write_note` (`replace`/`append`/`edit`) for **text** notes only — code notes keep the literal text.

Trilium indexes a note's links (the `internalLink` relations behind backlinks and the note map) only when content is saved through `PUT /notes/{id}/content`, which `POST /create-note` skips. `create_note` therefore re-saves text notes that contain links once, so links made through the MCP show up in Trilium's backlinks and note map immediately.

### Reliability

Every ETAPI request has a timeout (60s by default, set with `TRILIUM_REQUEST_TIMEOUT` / `--request-timeout`; export, import and backup get 5×). Idempotent requests (`GET`/`PUT`/`PATCH`/`DELETE`) are retried up to `TRILIUM_MAX_RETRIES` / `--max-retries` times (default 2) with exponential backoff (`--retry-delay`, default 250ms, doubled per attempt) on network errors and 502/503/504 responses. `POST` is never retried, because replaying `create-note` would duplicate notes. Timeouts are not retried either, since the request may still be running server-side. Failures surface as `TRILIUM_UNREACHABLE` (503) or `TRILIUM_TIMEOUT` (504), each with a suggested next step.

#### Slow searches

Trilium runs its database queries on one thread, and a full-text search scans the text of every note and attachment with `LIKE '%…%'`. On a large instance that can take minutes, and Trilium answers nothing else meanwhile; aborting the HTTP request does not stop the scan. The server limits the damage:

- **Fast search first.** `search_notes` defaults to `strategy: "auto"`: a plain-word query first matches titles and labels (milliseconds) and only searches note bodies when that finds fewer than `TRILIUM_SEARCH_FAST_MIN_RESULTS` / `--search-fast-min-results` notes (default 5; or fewer than `limit`, if smaller). Fast-pass responses carry `searchMode: "fast"`. Use `strategy: "full"` to always search bodies or `"fast"` to never, or change the default with `TRILIUM_SEARCH_STRATEGY` / `--search-strategy`. Queries using Trilium syntax (`#label`, `note.*`, `title:`, `OR`) and calls that set `fastSearch` run as written.
- **Fail fast while Trilium is busy.** After a request times out, that Trilium host is marked busy for `TRILIUM_BUSY_COOLDOWN` (30s by default), across all sessions. Meanwhile any search that reads note bodies is refused at once with `TRILIUM_BUSY` (503) and a retry-after hint instead of queueing another scan, and other requests get the shorter `TRILIUM_BUSY_PROBE_TIMEOUT` / `--busy-probe-timeout` (default 5s): the first one Trilium answers clears the flag. If the body search of an `auto` search fails this way, the title matches are returned with `partial: true`.
- **One scan per question.** Identical searches already in flight on the same Trilium with the same token share one request.
- **Progress.** When a client sends a `progressToken` with a tool call, the server sends a `notifications/progress` heartbeat every `TRILIUM_PROGRESS_INTERVAL` / `--progress-interval` (default 10s) while the call runs (plus a message when a search moves on to note bodies), so clients that reset their timeout on progress keep waiting instead of giving up.

Some features need a recent Trilium: `manage_system` `"metrics"` and `get_special_note` `"week_first_day"` need a release with those ETAPI endpoints (0.105+), and `utcDateModified` on create/patch needs a release newer than 0.105. Older servers return clear `METRICS_UNSUPPORTED` / `PROPERTY_NOT_ALLOWED` errors.

### Migrating from v1

The tool surface was consolidated in a breaking release. The mapping from the old 35-tool surface to the 19-tool v2 surface (`restore_revision` was added later, making 20):

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
| `search_notes` | `search_notes` (unchanged; gained an optional `fuzzy` fallback) |
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

### Providing file content (paths, URLs, base64)

Every content-carrying input — `create_attachment.content`, `write_attachment` replace `content`, the `data` field of `images[]`/`files[]` entries, and binary note `content` — accepts **any** of these forms, auto-detected:

| Form | Example | Notes |
|---|---|---|
| Local file path | `/tmp/screenshots/from-disk.png`, `~/docs/report.pdf` | The big win: the model never re-encodes bytes it already has on disk. Stdio transport only by default. |
| `file://` path | `file:///tmp/shot.png` | Forces path interpretation (no fallthrough). |
| http(s) URL | `https://example.com/logo.png` | The server fetches it (SSRF-guarded, 50 MB cap). |
| Data URL | `data:image/png;base64,iVBORw0KGgo...` | Its MIME type wins over everything. |
| Inline base64 / raw text | `iVBORw0KGgo...` / `plain notes here` | Today's behavior, unchanged. |

`mime`, `filename`, and `create_attachment.title` are now **optional**: the MIME type is resolved from the data-URL header, then an explicit `mime`, then magic-byte sniffing, then the file extension; a path/URL basename becomes the default filename/title. The simplest possible calls:

```json
{ "tool": "create_attachment", "arguments": { "ownerId": "abc123", "role": "image", "content": "/tmp/screenshots/from-disk.png" } }
```

```json
{ "tool": "create_note", "arguments": { "parentNoteId": "root", "title": "Image From Disk", "type": "text", "content": "<p>Look:</p><img src=\"image:0\">", "images": [{ "data": "/tmp/screenshots/from-disk.png" }] } }
```

```json
{ "files": [{ "data": "/tmp/exports/stats.csv" }] }
```

(These shapes are exercised verbatim by `tests/integration/etapi.test.ts` › "Content input normalization".)

Detection is verification-gated, so existing inline content can never be misread: a string only counts as a path when it is ≤ 1024 characters **and** names an existing regular file (JPEG base64 starts with `/9j/` but never survives both checks), and prose is never silently decoded as base64 — an undetectable inline input with no `mime` returns an actionable error instead of a guess.

Security knobs (see [CLI Arguments](#cli-arguments)):

- Local path reads are **enabled for stdio** (the server runs on your own machine) and **disabled for `--transport http`**, where a path would read the *server's* filesystem on behalf of a remote client. Override with `--allow-local-file-read` / `--no-local-file-read`, and optionally sandbox with `--local-file-roots /srv/uploads`.
- URL fetches pass an SSRF guard (private/loopback/metadata IPs blocked unless `--content-allow-private-urls`), re-checked on every redirect hop, with a `--max-content-fetch-bytes` cap (default 50 MB). Content URLs are chosen by the model, so they have their own switch: `--content-allow-private-urls` / `TRILIUM_CONTENT_ALLOW_PRIVATE_URLS` defaults to **off in multi-tenant mode** even when `--allow-private-urls` is on (that flag is for tenants' Trilium URLs). In single-tenant mode it defaults to the value of `--allow-private-urls`, which used to govern content fetches and keeps doing so unless you set the new flag explicitly.
- Trilium applies its own image compression settings server-side; the MCP always uploads the original bytes untouched.

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
3. **Credentials are verified at connect time** by calling `/etapi/app-info` (with a `TRILIUM_VALIDATE_TIMEOUT` / `--validate-timeout` timeout, default 10s). A bad token fails fast with a `401` on the SSE handshake, not with silent tool-call errors later.
4. **A gateway bearer token is required** (`--gateway-auth bearer`, enabled by default in multi-tenant mode). Clients authenticate to *you* with a shared secret you hand out.
5. **Client-supplied URLs are SSRF-checked.** By default, hostnames that resolve to private/loopback/link-local IPs (including cloud metadata `169.254.169.254`) are rejected. Adjust with `--trilium-url-allowlist` or `--allow-private-urls`. The check runs once up front for a clean `400 url_rejected`, and again on **every connection** the tenant's client opens (connect-time address check, redirects never followed), so a hostname that later re-resolves to a private address (DNS rebinding) is still refused.

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
| `POST` | `/message`  | gateway + `sessionId`    | Client sends JSON-RPC messages here (the caller must be the identity that opened the stream). `Content-Type: application/json`, up to `--max-post-bytes` (default 64 MB). |

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

**Which IP?** By default the per-IP axis keys on the TCP peer address. IPv6 clients are bucketed per `/64` (one end-user allocation), and the limiter tracks at most 10,000 buckets per axis, evicting the least recently used — eviction only ever hands a client a fresh, full bucket.

**Behind a reverse proxy** the TCP peer is the proxy, so every client shares one bucket — and since the IP check runs *before* authentication, anonymous traffic can drain it and lock everyone out. Tell the server which proxies to believe:

```bash
--trusted-proxies 127.0.0.1            # same-host proxy
--trusted-proxies 172.16.0.0/12,fd00::/8   # e.g. a Docker / Kubernetes network
```

Env `TRILIUM_TRUSTED_PROXIES` (comma-separated), config key `trustedProxies`. When a request's TCP peer is in this list, the server reads `X-Forwarded-For` from the right and uses the first address that is **not** a trusted proxy; everything to its left was written by the client and is ignored. Requests from untrusted peers keep using the peer address, and any `X-Forwarded-For` they send is ignored.

Caveats: list **only** proxies you control, and make sure the proxy *appends* to `X-Forwarded-For` (nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, Caddy and Traefik do this by default). If you trust an address that clients can reach directly, or a proxy that passes a client-supplied header through unmodified, clients can pick their own bucket. The setting only affects rate limiting; logs keep the TCP peer in `remote`.

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
| `--allow-private-urls` | Disable the private-IP block entirely for tenant Trilium URLs. Use only on trusted/homelab networks. Content URLs fetched by tools keep their own switch (`--content-allow-private-urls`, off by default in multi-tenant mode). |

The allowlist / private-IP policy is enforced twice: as a pre-flight DNS check when the session opens, and at connect time on every socket the tenant's Trilium client opens (the address actually connected to must pass; redirects are never followed). A hostname that resolves to a public address during the pre-flight and to a private one afterwards (DNS rebinding) is refused with `400 url_rejected` at connect, or a `TRILIUM_UNREACHABLE` tool error later.

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
| `413`  | `payload_too_large`     | Body exceeded `--max-post-bytes` (default 64 MB). See [Request body size limits](#request-body-size-limits). |

### Request body size limits

The HTTP/SSE transport caps each MCP JSON-RPC POST body at **64 MB by default**. Tune it with `--max-post-bytes <size>` or `TRILIUM_MAX_POST_BYTES` (e.g. `100mb`, `2gb`, or a raw byte count). On stdio there is no equivalent cap — your shell / OS pipe buffers are the limit.

Why this exists, and a few caveats worth knowing:

- **The MCP SDK has its own internal 4 MB cap** inside `handlePostMessage`. To honor anything larger, this server reads and JSON-parses the request body itself before handing it off, bypassing the SDK's read. If you fork or upgrade and bodies start failing at ~4 MB with `400` from the SDK, this read-and-pass-through is what's missing.
- **Bodies are buffered in memory** before dispatch. A 64 MB cap means a single connection can ask for 64 MB of heap (more while it is parsed). On a multi-tenant deployment, set the cap to the smallest value your largest legitimate attachment needs.
- **Attachments are base64-encoded over JSON-RPC**, which inflates payload size by ~33%. A 100 MB binary becomes ~134 MB on the wire.
- **413 is returned as soon as we can detect the overrun** — either from `Content-Length` upfront (no body drain) or mid-stream once accumulated bytes exceed the cap. Chunked uploads without `Content-Length` still get capped via the streaming check.
- **Reverse proxies have their own limits.** Nginx defaults to `client_max_body_size 1m`; bump it (`client_max_body_size 600m;` or similar) or large requests die at the proxy with `413` before they reach this server. Caddy has no default cap.

### Host header check (DNS rebinding)

Every request except `/health` passes a Host/Origin guard before auth:

- **Bound to loopback** (`127.0.0.1`, the default for `node dist/index.js`): the `Host` header must be a loopback name (`localhost`, `127.x.x.x`, `[::1]`), the bind address, or an `--allowed-hosts` / `TRILIUM_ALLOWED_HOSTS` entry. This stops a web page from reaching a local server via DNS rebinding.
- **Bound to a non-loopback address** (`--host 0.0.0.0`, which the Docker image sets): no Host check, unless you set `--allowed-hosts`, which turns it on with your list (loopback names stay accepted, so the container `HEALTHCHECK` and local probes keep working).
- **`Origin`**, when a browser sends one, must be on the `--cors-origin` list (or be a loopback origin while bound to loopback). Non-browser clients send no `Origin` and are unaffected.

**Same-host reverse proxy:** if the proxy forwards the public `Host` (nginx `proxy_set_header Host $host;`, Caddy's default) to a server bound to `127.0.0.1`, every request is refused with `403 host_not_allowed` until you add the public name: `--allowed-hosts mcp.example.com`. Rejections are logged as `request_rejected` with the (sanitized) `host` and `origin`.

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
- **Creds are validated at connect time** with a timeout (`--validate-timeout`, default 10s), so a bad or slow Trilium target fails the SSE handshake instead of hanging the connection.
- **No TLS in-process.** Use a reverse proxy. The server listens on plain HTTP and expects to run behind one.
- **Per-principal identity** is available via `--gateway-auth jwt` ([above](#jwt--oidc-gateway-auth)). When you need to attribute actions to specific users, prefer JWT over a shared bearer token — the authenticated principal threads automatically into audit logs and (opt-in) into per-principal metric labels.

### Troubleshooting

**Connection immediately returns `401 unauthorized`.** Missing or malformed `Authorization: Bearer`. Check your client logs — some MCP clients strip non-standard headers on SSE.

**Connection returns `401 trilium_auth_failed`.** The ETAPI token was rejected by Trilium. Test it directly: `curl -H "Authorization: $TOKEN" https://trilium.example.com/etapi/app-info`.

**Connection returns `400 url_rejected` with `reason=private_address`.** You're pointing at a private/loopback IP (common in homelabs). Either add the hostname to `--trilium-url-allowlist` or pass `--allow-private-urls`.

**Connection returns `504 trilium_validate_timeout`.** `getAppInfo` didn't respond within `--validate-timeout` (default 10 seconds). Usually a DNS black hole, a firewall dropping packets, or Trilium is actually down.

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

The image sets `TRILIUM_HTTP_HOST=0.0.0.0` so the HTTP transport is reachable through a published port (outside a container the default bind is `127.0.0.1`). With no `TRILIUM_ALLOWED_HOSTS`, a non-loopback bind does not check the `Host` header, so a reverse proxy can forward any public name; set `TRILIUM_ALLOWED_HOSTS` to opt in to the check (see [Host header check](#host-header-check-dns-rebinding)). If rate limiting is on behind a proxy, also set `TRILIUM_TRUSTED_PROXIES` (see [Rate limiting](#rate-limiting)).

## Getting an ETAPI Token

1. Open TriliumNext in your browser
2. Go to Options (gear icon) → ETAPI
3. Create a new ETAPI token
4. Copy the token and use it in your configuration

## License

MIT
