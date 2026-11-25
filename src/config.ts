import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Normalizes the Trilium server URL by:
 * 1. Removing trailing slashes
 * 2. Appending /etapi if not already present
 *
 * This allows users to provide either the base URL (http://localhost:8080)
 * or the full ETAPI URL (http://localhost:8080/etapi).
 */
export function normalizeServerUrl(url: string): string {
  // Remove trailing slashes
  let normalized = url.replace(/\/+$/, '');

  // Only append /etapi if not already present
  if (!normalized.endsWith('/etapi')) {
    normalized += '/etapi';
  }

  return normalized;
}

/**
 * Derives the Trilium web-UI base URL (what a user's browser opens) from a
 * server URL by stripping a trailing `/etapi` segment and any trailing slashes.
 *
 * Example: `http://localhost:37740/etapi` -> `http://localhost:37740`.
 */
export function deriveWebBaseUrl(url: string): string {
  return url.replace(/\/etapi\/*$/i, '').replace(/\/+$/, '');
}

export type GatewayAuthMode = 'none' | 'bearer' | 'jwt';
export type MetricsAuthMode = 'gateway' | 'bearer' | 'none';
/** search_notes strategy: titles/labels first (auto), titles/labels only (fast), or bodies too (full). */
export type SearchStrategy = 'auto' | 'fast' | 'full';

const GATEWAY_AUTH_MODES: readonly GatewayAuthMode[] = ['none', 'bearer', 'jwt'];
const METRICS_AUTH_MODES: readonly MetricsAuthMode[] = ['gateway', 'bearer', 'none'];

/** Invalid configuration. `main()` prints the message and exits 1. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Default interface the HTTP transport binds to. Loopback unless overridden. */
export const DEFAULT_HTTP_HOST = '127.0.0.1';

export interface Config {
  /**
   * Default Trilium URL. In multi-tenant mode this is a fallback used when a
   * connecting client does not provide their own `X-Trilium-Url` header;
   * `null` means no fallback (client must always supply creds).
   */
  triliumUrl: string | null;
  /**
   * Default ETAPI token. Same fallback semantics as `triliumUrl` in multi-tenant
   * mode; required and non-null in single-tenant mode.
   */
  triliumToken: string | null;
  /**
   * Optional override for the user-facing Trilium web-UI base URL used when
   * building clickable note links returned to the user. Set this when the MCP
   * server reaches Trilium at a different address than the user's browser does
   * (e.g. an internal ETAPI host vs. a public reverse-proxy domain). When unset,
   * the web base is derived from `triliumUrl` by stripping `/etapi`. Ignored in
   * multi-tenant mode, where each tenant's link base is derived per connection.
   */
  publicUrl: string | null;
  transport: 'stdio' | 'http';
  httpPort: number;
  /**
   * Interface the HTTP transport binds to. Defaults to `127.0.0.1`; the Docker
   * image sets `0.0.0.0`. When this is a loopback address, the `Host` header
   * of every request must name a loopback host (or one of `allowedHosts`) to
   * defeat DNS-rebinding attacks from a browser.
   */
  httpHost: string;
  /**
   * Extra `Host` header names (hostname, optional `:port`) accepted when the
   * server is bound to loopback — e.g. the public name a same-host reverse
   * proxy forwards. Ignored when bound to a non-loopback interface.
   */
  allowedHosts: string[];
  /**
   * When true, clients supply `X-Trilium-Url` / `X-Trilium-Token` per connection
   * and each SSE session gets its own TriliumClient. Requires `transport=http`.
   */
  multiTenant: boolean;
  /**
   * Gateway auth mode controlling who may open an SSE connection.
   * - `none`: no auth (trusted-network only)
   * - `bearer`: require `Authorization: Bearer <token>`
   */
  gatewayAuth: GatewayAuthMode;
  /**
   * Accepted gateway bearer tokens (only meaningful when `gatewayAuth='bearer'`).
   */
  gatewayTokens: string[];
  /**
   * Optional allowlist of hostnames permitted in client-supplied `X-Trilium-Url`.
   * Supports exact match and suffix match (e.g. `example.com` matches `a.example.com`).
   * Empty means "no allowlist" (private-IP block still applies unless opted out).
   */
  urlAllowlist: string[];
  /**
   * If true, skip private/loopback IP checks on client-supplied URLs. Use for
   * homelab setups where Trilium lives on a private network.
   */
  allowPrivateUrls: boolean;
  /**
   * Maximum size (bytes) of a single MCP JSON-RPC POST body on the SSE
   * transport. Above this, the server returns 413. Bodies are read into memory
   * before dispatch, so this also bounds per-request memory.
   */
  maxPostBytes: number;
  /**
   * Permit tool inputs that name local file paths (attachment/image content).
   * Defaults to true for stdio (the operator's own machine) and false for the
   * http transport, where an LLM-supplied path would read the SERVER's
   * filesystem on behalf of an arbitrary client.
   */
  allowLocalFileRead: boolean;
  /**
   * When non-empty, restrict content file reads to these directories
   * (realpath-checked, so symlinks cannot escape). Empty = unrestricted.
   */
  localFileRoots: string[];
  /**
   * Hostname allowlist for http(s) CONTENT fetches (attachment/image inputs).
   * Separate from `urlAllowlist`, which governs client-supplied Trilium hosts.
   * Empty means any public host (private IPs still blocked unless
   * `allowPrivateUrls`).
   */
  contentUrlAllowlist: string[];
  /**
   * Maximum bytes for a single content file read or URL download.
   */
  maxContentFetchBytes: number;
  /**
   * If true, expose a Prometheus-compatible `GET /metrics` endpoint on the SSE
   * gateway. Opt-in; ignored when `transport=stdio` (no HTTP listener).
   */
  metricsEnabled: boolean;
  /**
   * Auth gate for `/metrics`:
   *  - `gateway`: reuse the existing gateway bearer (default)
   *  - `bearer`: a separate set of bearer tokens (see `metricsTokens`)
   *  - `none`: open (use only when the endpoint is firewalled)
   */
  metricsAuth: MetricsAuthMode;
  /**
   * Accepted scrape bearer tokens (only meaningful when `metricsAuth='bearer'`).
   */
  metricsTokens: string[];
  /**
   * If true, declare an opt-in `triliumnext_mcp_tool_calls_by_principal_total`
   * counter labeled by JWT principal. Only enable with `gatewayAuth='jwt'` and
   * a bounded principal namespace — cardinality scales as principals × tools.
   */
  metricsIncludePrincipal: boolean;
  /**
   * CORS allowlist of origins (e.g. `https://app.example.com`). Empty disables CORS
   * entirely. `*` enables wildcard mode (`Access-Control-Allow-Origin: *`,
   * without `Allow-Credentials`).
   *
   * This list is ALSO the server's Origin allowlist: any request carrying an
   * `Origin` header that is not listed here is rejected with 403 — except, when
   * bound to loopback, origins whose host is itself a loopback name.
   */
  corsOrigins: string[];
  /**
   * Rate-limit refill rate in requests/sec, applied per remote IP and per
   * gateway token. `0` disables the in-process limiter (still recommend doing
   * limiting at the reverse proxy in multi-replica setups).
   */
  rateLimitRps: number;
  /**
   * Token-bucket burst size — the max requests allowed before refill matters.
   */
  rateLimitBurst: number;
  /**
   * JWT-mode gateway auth knobs (only meaningful when `gatewayAuth='jwt'`).
   * At least one of `jwtSecrets` or `jwtJwksUrl` must be set. Issuer/audience
   * are optional; the principal claim defaults to `sub`.
   */
  jwtSecrets: string[];
  jwtJwksUrl: string | null;
  jwtIssuer: string | null;
  jwtAudience: string | null;
  jwtPrincipalClaim: string;
  /** Per-request ETAPI timeout in ms (default 60000; export/import/backup get 5x). */
  requestTimeoutMs?: number;
  /**
   * How long a Trilium host is treated as busy after a request to it times out
   * (default 30000 ms). Meanwhile full-text searches are refused and other
   * requests get a short timeout.
   */
  busyCooldownMs?: number;
  /** Default `strategy` for search_notes. */
  searchStrategy?: SearchStrategy;
}

interface ConfigFile {
  url?: string;
  token?: string;
  publicUrl?: string;
  transport?: 'stdio' | 'http';
  httpPort?: number;
  httpHost?: string;
  allowedHosts?: string[];
  multiTenant?: boolean;
  gatewayAuth?: GatewayAuthMode;
  gatewayTokens?: string[];
  urlAllowlist?: string[];
  allowPrivateUrls?: boolean;
  maxPostBytes?: number;
  allowLocalFileRead?: boolean;
  localFileRoots?: string[];
  contentUrlAllowlist?: string[];
  maxContentFetchBytes?: number;
  metrics?: boolean;
  metricsAuth?: MetricsAuthMode;
  metricsTokens?: string[];
  metricsIncludePrincipal?: boolean;
  corsOrigins?: string[];
  rateLimitRps?: number;
  rateLimitBurst?: number;
  jwtSecrets?: string[];
  jwtJwksUrl?: string;
  jwtIssuer?: string;
  jwtAudience?: string;
  jwtPrincipalClaim?: string;
  requestTimeoutMs?: number;
  busyCooldownMs?: number;
  searchStrategy?: string;
}

interface CliArgs {
  url?: string;
  token?: string;
  publicUrl?: string;
  transport?: string;
  port?: string;
  host?: string;
  allowedHosts?: string[];
  help?: boolean;
  multiTenant?: boolean;
  gatewayAuth?: string;
  gatewayTokens?: string[];
  urlAllowlist?: string[];
  allowPrivateUrls?: boolean;
  maxPostBytes?: number;
  allowLocalFileRead?: boolean;
  localFileRoots?: string[];
  contentUrlAllowlist?: string[];
  maxContentFetchBytes?: number;
  metrics?: boolean;
  metricsAuth?: string;
  metricsTokens?: string[];
  metricsIncludePrincipal?: boolean;
  corsOrigins?: string[];
  rateLimitRps?: string;
  rateLimitBurst?: string;
  jwtSecrets?: string[];
  jwtJwksUrl?: string;
  jwtIssuer?: string;
  jwtAudience?: string;
  jwtPrincipalClaim?: string;
  requestTimeoutMs?: number;
  busyCooldownMs?: number;
  searchStrategy?: string;
}

function requireSize(flag: string, raw: string): number {
  const parsed = parseSize(raw);
  if (parsed === undefined) {
    throw new ConfigError(`Invalid size for ${flag}: "${raw}" (use bytes or e.g. 64mb, 1gb).`);
  }
  return parsed;
}

function parseCliArgs(args: string[]): CliArgs {
  const result: CliArgs = {};
  const gatewayTokens: string[] = [];
  const metricsTokens: string[] = [];
  const jwtSecrets: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Consume the flag's value. A missing value, or one that is itself a
    // `--flag`, is a usage error rather than something to silently swallow.
    const value = (): string => {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new ConfigError(`Option ${arg} requires a value.`);
      }
      i++;
      return next;
    };

    switch (arg) {
      case '--url':
      case '-u':
        result.url = value();
        break;
      case '--token':
      case '-t':
        result.token = value();
        break;
      case '--public-url':
        result.publicUrl = value();
        break;
      case '--transport':
        result.transport = value();
        break;
      case '--port':
      case '-p':
        result.port = value();
        break;
      case '--multi-tenant':
        result.multiTenant = true;
        break;
      case '--gateway-auth':
        result.gatewayAuth = value();
        break;
      case '--gateway-token':
        gatewayTokens.push(value());
        break;
      case '--trilium-url-allowlist':
        result.urlAllowlist = splitCsv(value());
        break;
      case '--allow-private-urls':
        result.allowPrivateUrls = true;
        break;
      case '--max-post-bytes':
        result.maxPostBytes = requireSize(arg, value());
        break;
      case '--allow-local-file-read':
        result.allowLocalFileRead = true;
        break;
      case '--no-local-file-read':
        result.allowLocalFileRead = false;
        break;
      case '--local-file-roots':
        result.localFileRoots = splitCsv(value());
        break;
      case '--content-url-allowlist':
        result.contentUrlAllowlist = splitCsv(value());
        break;
      case '--max-content-fetch-bytes':
        result.maxContentFetchBytes = requireSize(arg, value());
        break;
      case '--metrics':
        result.metrics = true;
        break;
      case '--metrics-auth':
        result.metricsAuth = value();
        break;
      case '--metrics-token':
        metricsTokens.push(value());
        break;
      case '--metrics-include-principal':
        result.metricsIncludePrincipal = true;
        break;
      case '--cors-origin':
        result.corsOrigins ??= [];
        result.corsOrigins.push(...splitCsv(value()));
        break;
      case '--rate-limit-rps':
        result.rateLimitRps = value();
        break;
      case '--rate-limit-burst':
        result.rateLimitBurst = value();
        break;
      case '--host':
        result.host = value();
        break;
      case '--allowed-hosts':
        result.allowedHosts ??= [];
        result.allowedHosts.push(...splitCsv(value()));
        break;
      case '--jwt-secret':
        jwtSecrets.push(value());
        break;
      case '--jwt-jwks-url':
        result.jwtJwksUrl = value();
        break;
      case '--jwt-issuer':
        result.jwtIssuer = value();
        break;
      case '--jwt-audience':
        result.jwtAudience = value();
        break;
      case '--jwt-principal-claim':
        result.jwtPrincipalClaim = value();
        break;
      case '--request-timeout': {
        const ms = parseDuration(nextArg);
        if (ms !== undefined) result.requestTimeoutMs = ms;
        i++;
        break;
      }
      case '--busy-cooldown': {
        const ms = parseDuration(nextArg);
        if (ms !== undefined) result.busyCooldownMs = ms;
        i++;
        break;
      }
      case '--search-strategy':
        result.searchStrategy = nextArg;
        i++;
        break;
      case '--help':
      case '-h':
        result.help = true;
        break;
    }
  }

  if (gatewayTokens.length > 0) {
    result.gatewayTokens = gatewayTokens;
  }
  if (metricsTokens.length > 0) {
    result.metricsTokens = metricsTokens;
  }
  if (jwtSecrets.length > 0) {
    result.jwtSecrets = jwtSecrets;
  }
  return result;
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function loadConfigFile(): ConfigFile {
  const configPaths = [
    join(process.cwd(), 'trilium-mcp.json'),
    join(homedir(), '.trilium-mcp.json'),
  ];

  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, 'utf-8');
        const parsed: unknown = JSON.parse(content);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('top-level value must be a JSON object');
        }
        return parsed as ConfigFile;
      } catch (err) {
        // Don't silently swallow: an operator who wrote a config file expects
        // it to apply. Warn and fall through to the next candidate.
        console.error(
          `Warning: ignoring config file ${configPath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  return {};
}

export function printHelp(): void {
  console.log(`
TriliumNext MCP Server

Usage: triliumnext-mcp [options]

Options:
  -u, --url <url>                    Trilium server URL (default: http://localhost:37740)
                                     Can be base URL or full ETAPI URL - /etapi is appended if missing
  -t, --token <token>                Trilium ETAPI token
  --public-url <url>                 User-facing Trilium web URL for note links returned to the
                                     user. Defaults to --url with /etapi stripped. Set this when
                                     the MCP server and the user reach Trilium at different
                                     addresses (e.g. internal ETAPI host vs. public domain).
  --transport <type>                 Transport type: stdio or http (default: stdio)
  -p, --port <port>                  HTTP server port when using http transport (default: 3000)
  --host <addr>                      Interface to bind the HTTP transport to (default: 127.0.0.1).
                                     Use 0.0.0.0 to listen on all interfaces (the Docker image
                                     does). On loopback, the Host header must be a loopback name.
  --allowed-hosts <hosts>            Extra Host header values accepted while bound to loopback
                                     (comma-separated, e.g. a same-host reverse proxy's name).

Multi-tenant HTTP options (require --transport http):
  --multi-tenant                     Each SSE client supplies its own Trilium URL + token
                                     via X-Trilium-Url and X-Trilium-Token headers
  --gateway-auth <mode>              Gateway auth mode: none, bearer, or jwt
                                     (default: bearer when multi-tenant is enabled, none otherwise)
  --gateway-token <token>            Accepted bearer token. Repeatable; supply once per token.
  --trilium-url-allowlist <hosts>    Comma-separated hostnames permitted in X-Trilium-Url.
                                     Supports suffix match (example.com matches a.example.com).
  --allow-private-urls               Allow client URLs that resolve to private/loopback IPs
                                     (default: blocked in multi-tenant mode to prevent SSRF)
  --max-post-bytes <size>            Max size of a single MCP JSON-RPC POST body on the SSE
                                     transport. Accepts raw bytes or suffixed values
                                     (e.g. 64mb, 1gb). Default: 64mb.

Content input (file paths / URLs in attachment and image tool inputs):
  --allow-local-file-read            Permit tool inputs that name local file paths.
                                     Default: on for stdio, off for --transport http.
  --no-local-file-read               Disable local file path inputs.
  --local-file-roots <dirs>          Comma-separated directories content may be read from.
                                     Empty (default) = unrestricted when reads are allowed.
  --content-url-allowlist <hosts>    Comma-separated hostnames permitted for http(s) content
                                     fetches. Empty = any public host (private IPs still
                                     blocked unless --allow-private-urls).
  --max-content-fetch-bytes <size>   Max size of a content file read or URL download.
                                     Accepts raw bytes or suffixed values (e.g. 50mb).
                                     Default: 50mb.

Metrics (require --transport http):
  --metrics                          Expose Prometheus-compatible GET /metrics on the SSE
                                     gateway. Opt-in; off by default.
  --metrics-auth <mode>              Auth gate for /metrics: gateway | bearer | none
                                     (default: gateway, which reuses --gateway-token)
  --metrics-token <token>            Accepted scrape bearer token when --metrics-auth=bearer.
                                     Repeatable; supply once per token.
  --metrics-include-principal        Declare a per-principal tool_calls counter. Cardinality
                                     scales with principals × tools — only enable when the
                                     principal namespace is bounded (typical JWT setups).

CORS (require --transport http):
  --cors-origin <origin>             Allowed CORS origin. Repeatable, or supply a comma-
                                     separated list. Use '*' for wildcard. Off by default.
                                     Also the Origin allowlist: requests with any other Origin
                                     header are rejected (403), except loopback origins when
                                     the server itself is bound to loopback.

Rate limiting (require --transport http):
  --rate-limit-rps <rps>             Sustained refill rate per IP and per gateway token, in
                                     requests/second. Off by default (0).
  --rate-limit-burst <n>             Maximum burst before refill matters. Off by default (0).

JWT gateway auth (--gateway-auth jwt):
  --jwt-secret <secret>              HS256 shared secret (repeatable for rotation).
  --jwt-jwks-url <url>               JWKS URL for asymmetric verification (RS256/ES256/EdDSA).
  --jwt-issuer <iss>                 Required iss claim (optional).
  --jwt-audience <aud>               Required aud claim (optional).
  --jwt-principal-claim <name>       Which claim names the user. Default: sub.

Backend behaviour:
  --request-timeout <duration>       Per-request ETAPI timeout (e.g. 60000, 90s, 2m). Default: 60s.
                                     Export, import and backup get 5x this.
  --busy-cooldown <duration>         After a request times out, treat that Trilium as busy for
                                     this long: full-text searches are refused at once and other
                                     requests get a 5s timeout. Default: 30s.
  --search-strategy <mode>           Default search_notes strategy: auto (titles and labels
                                     first, note bodies only if that finds too few), fast, or
                                     full. Default: auto.

  -h, --help                         Show this help message

Environment Variables:
  TRILIUM_URL                        Trilium server URL (base or full ETAPI URL)
  TRILIUM_TOKEN                      Trilium ETAPI token
  TRILIUM_PUBLIC_URL                 User-facing Trilium web URL for note links (defaults to
                                     TRILIUM_URL with /etapi stripped)
  TRILIUM_TRANSPORT                  stdio or http
  TRILIUM_HTTP_PORT                  Port for HTTP transport
  TRILIUM_HTTP_HOST                  Bind address for HTTP transport (default: 127.0.0.1)
  TRILIUM_ALLOWED_HOSTS              Extra accepted Host header values when bound to loopback
  TRILIUM_MULTI_TENANT               "true" to enable multi-tenant mode
  TRILIUM_GATEWAY_AUTH               none, bearer, or jwt
  TRILIUM_GATEWAY_TOKENS             Comma-separated accepted bearer tokens
  TRILIUM_URL_ALLOWLIST              Comma-separated allowed hostnames for client URLs
  TRILIUM_ALLOW_PRIVATE_URLS         "true" to skip private-IP SSRF guard
  TRILIUM_MAX_POST_BYTES             Max MCP POST body size (raw bytes or e.g. 64mb, 1gb)
  TRILIUM_ALLOW_LOCAL_FILE_READ      "true"/"false" to permit local file path content inputs
  TRILIUM_LOCAL_FILE_ROOTS           Comma-separated directories content may be read from
  TRILIUM_CONTENT_URL_ALLOWLIST      Comma-separated hostnames for http(s) content fetches
  TRILIUM_MAX_CONTENT_FETCH_BYTES    Max content file read / URL download size (e.g. 50mb)
  TRILIUM_METRICS                    "true" to expose GET /metrics (HTTP transport only)
  TRILIUM_METRICS_AUTH               gateway | bearer | none (default: gateway)
  TRILIUM_METRICS_TOKENS             Comma-separated scrape tokens (for TRILIUM_METRICS_AUTH=bearer)
  TRILIUM_METRICS_INCLUDE_PRINCIPAL  "true" to expose per-principal tool_calls counter (JWT only)
  TRILIUM_CORS_ORIGINS               Comma-separated allowed CORS origins. '*' for wildcard.
  TRILIUM_RATE_LIMIT_RPS             Sustained refill rate per IP and per gateway token (req/s).
  TRILIUM_RATE_LIMIT_BURST           Maximum burst before refill matters.
  TRILIUM_JWT_SECRETS                Comma-separated HS256 shared secrets.
  TRILIUM_JWT_JWKS_URL               JWKS URL for asymmetric verification.
  TRILIUM_JWT_ISSUER                 Required iss claim.
  TRILIUM_JWT_AUDIENCE               Required aud claim.
  TRILIUM_JWT_PRINCIPAL_CLAIM        Claim name carrying the principal (default: sub).
  TRILIUM_REQUEST_TIMEOUT            Per-request ETAPI timeout (ms, or e.g. 90s, 2m). Default: 60s.
  TRILIUM_BUSY_COOLDOWN              How long a timed-out Trilium is treated as busy. Default: 30s.
  TRILIUM_SEARCH_STRATEGY            Default search_notes strategy: auto | fast | full.

Logging:
  LOG_LEVEL                          silent | error | warn | info | debug (default: info)
                                     'info' emits one line per tools/call with timing and outcome.
                                     'debug' adds tool args (with secrets and content blobs redacted).
  LOG_FORMAT                         text | json (default: text)
                                     text  -> human-readable "<ts> LEVEL event k=v" lines
                                     json  -> one JSON object per line, for log shippers
  Output stream is chosen by transport: stdio -> stderr (stdout is JSON-RPC); http -> stdout.

Configuration File:
  Reads from ./trilium-mcp.json or ~/.trilium-mcp.json

Priority (highest to lowest):
  1. CLI arguments
  2. Environment variables
  3. Configuration file
  4. Default values
`);
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length > 0 ? value : undefined;
}

/** Case-insensitive, trimmed enum parse; throws listing the valid values. */
function parseEnumValue<T extends string>(raw: unknown, valid: readonly T[], what: string): T {
  const normalized = String(raw).trim().toLowerCase();
  const match = valid.find((v) => v === normalized);
  if (!match) {
    throw new ConfigError(`Invalid ${what}: "${String(raw)}". Valid values: ${valid.join(', ')}.`);
  }
  return match;
}

function validatePort(input: { value: unknown; source: string }): number {
  const { value, source } = input;
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\s*\d+\s*$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 65535 || (n === 0 && source !== 'default')) {
    // Port 0 (ephemeral) is only meaningful programmatically, never from config.
    throw new ConfigError(
      `Invalid port from ${source}: "${String(value)}". Must be an integer between 1 and 65535.`
    );
  }
  return n;
}

function validateNonNegative(raw: unknown, what: string, integer: boolean): number {
  if (raw === undefined) return 0;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (
    (typeof raw === 'string' && raw.trim() === '') ||
    !Number.isFinite(n) ||
    n < 0 ||
    (integer && !Number.isInteger(n))
  ) {
    throw new ConfigError(
      `Invalid ${what}: "${String(raw)}". Must be ${integer ? 'an integer' : 'a number'} >= 0.`
    );
  }
  return n;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return undefined;
}

const DEFAULT_MAX_POST_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CONTENT_FETCH_BYTES = 50 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_BUSY_COOLDOWN_MS = 30_000;

/** Accepts milliseconds ("90000") or a suffixed value ("500ms", "90s", "2m"). */
export function parseDuration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/i);
  if (!match) return undefined;
  const n = parseFloat(match[1]);
  const unit = (match[2] ?? 'ms').toLowerCase();
  const ms = unit === 'm' ? n * 60_000 : unit === 's' ? n * 1000 : n;
  return ms > 0 ? Math.round(ms) : undefined;
}

/** Accepts a raw byte count or a suffixed value like "500mb", "10MiB", "2g". */
function parseSize(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([kmgKMG]i?[bB]?|[bB])?$/);
  if (!match) return undefined;
  const n = parseFloat(match[1]);
  if (!Number.isFinite(n) || n < 0) return undefined;
  const unit = (match[2] ?? '').toLowerCase();
  const multiplier =
    unit === '' || unit === 'b'
      ? 1
      : unit.startsWith('k')
        ? 1024
        : unit.startsWith('m')
          ? 1024 * 1024
          : unit.startsWith('g')
            ? 1024 * 1024 * 1024
            : 1;
  return Math.floor(n * multiplier);
}

export function loadConfig(args: string[] = process.argv.slice(2)): Config | null {
  const cli = parseCliArgs(args);

  if (cli.help) {
    printHelp();
    return null;
  }

  const file = loadConfigFile();

  // Empty string env vars are treated as unset. Docker compose overrides
  // frequently resolve unset vars to "", and we want those to behave like
  // "not configured" rather than "explicitly empty".
  const rawUrl = cli.url ?? emptyToUndefined(process.env.TRILIUM_URL) ?? file.url;
  const rawToken = cli.token ?? emptyToUndefined(process.env.TRILIUM_TOKEN) ?? file.token ?? '';

  const rawPublicUrl =
    cli.publicUrl ?? emptyToUndefined(process.env.TRILIUM_PUBLIC_URL) ?? file.publicUrl;

  const transportValue =
    cli.transport ?? process.env.TRILIUM_TRANSPORT ?? file.transport ?? 'stdio';
  const transport: 'stdio' | 'http' = transportValue === 'http' ? 'http' : 'stdio';

  const httpPort = validatePort(
    cli.port !== undefined
      ? { value: cli.port, source: '--port' }
      : emptyToUndefined(process.env.TRILIUM_HTTP_PORT) !== undefined
        ? { value: process.env.TRILIUM_HTTP_PORT, source: 'TRILIUM_HTTP_PORT' }
        : file.httpPort !== undefined
          ? { value: file.httpPort, source: 'config file httpPort' }
          : { value: 3000, source: 'default' }
  );

  const httpHost =
    cli.host ??
    emptyToUndefined(process.env.TRILIUM_HTTP_HOST) ??
    file.httpHost ??
    DEFAULT_HTTP_HOST;

  const allowedHosts =
    cli.allowedHosts ??
    (process.env.TRILIUM_ALLOWED_HOSTS ? splitCsv(process.env.TRILIUM_ALLOWED_HOSTS) : undefined) ??
    file.allowedHosts ??
    [];

  const multiTenant =
    cli.multiTenant ?? parseBoolean(process.env.TRILIUM_MULTI_TENANT) ?? file.multiTenant ?? false;

  const gatewayTokens =
    cli.gatewayTokens ??
    (process.env.TRILIUM_GATEWAY_TOKENS
      ? splitCsv(process.env.TRILIUM_GATEWAY_TOKENS)
      : undefined) ??
    file.gatewayTokens ??
    [];

  const gatewayAuthRaw =
    cli.gatewayAuth ??
    emptyToUndefined(process.env.TRILIUM_GATEWAY_AUTH) ??
    file.gatewayAuth ??
    undefined;
  // Unset → default: require bearer when multi-tenant is on, otherwise keep
  // legacy unauth behavior. A set-but-unknown value is an error: silently
  // defaulting a typo like "berer" to `none` would disable auth.
  const gatewayAuth: GatewayAuthMode =
    gatewayAuthRaw === undefined
      ? multiTenant
        ? 'bearer'
        : 'none'
      : parseEnumValue(gatewayAuthRaw, GATEWAY_AUTH_MODES, 'gateway auth mode');

  const urlAllowlist =
    cli.urlAllowlist ??
    (process.env.TRILIUM_URL_ALLOWLIST ? splitCsv(process.env.TRILIUM_URL_ALLOWLIST) : undefined) ??
    file.urlAllowlist ??
    [];

  const allowPrivateUrls =
    cli.allowPrivateUrls ??
    parseBoolean(process.env.TRILIUM_ALLOW_PRIVATE_URLS) ??
    file.allowPrivateUrls ??
    false;

  const maxPostBytes =
    cli.maxPostBytes ??
    parseSize(process.env.TRILIUM_MAX_POST_BYTES) ??
    file.maxPostBytes ??
    DEFAULT_MAX_POST_BYTES;

  // Local file reads default ON for stdio (the operator's own machine) and OFF
  // for the http transport, where an LLM-supplied path reads the SERVER's
  // filesystem on behalf of an arbitrary client.
  const allowLocalFileRead =
    cli.allowLocalFileRead ??
    parseBoolean(process.env.TRILIUM_ALLOW_LOCAL_FILE_READ) ??
    file.allowLocalFileRead ??
    transport === 'stdio';

  const localFileRoots =
    cli.localFileRoots ??
    (process.env.TRILIUM_LOCAL_FILE_ROOTS
      ? splitCsv(process.env.TRILIUM_LOCAL_FILE_ROOTS)
      : undefined) ??
    file.localFileRoots ??
    [];

  const contentUrlAllowlist =
    cli.contentUrlAllowlist ??
    (process.env.TRILIUM_CONTENT_URL_ALLOWLIST
      ? splitCsv(process.env.TRILIUM_CONTENT_URL_ALLOWLIST)
      : undefined) ??
    file.contentUrlAllowlist ??
    [];

  const maxContentFetchBytes =
    cli.maxContentFetchBytes ??
    parseSize(process.env.TRILIUM_MAX_CONTENT_FETCH_BYTES) ??
    file.maxContentFetchBytes ??
    DEFAULT_MAX_CONTENT_FETCH_BYTES;

  const metricsEnabledRaw =
    cli.metrics ?? parseBoolean(process.env.TRILIUM_METRICS) ?? file.metrics ?? false;

  const metricsTokens =
    cli.metricsTokens ??
    (process.env.TRILIUM_METRICS_TOKENS
      ? splitCsv(process.env.TRILIUM_METRICS_TOKENS)
      : undefined) ??
    file.metricsTokens ??
    [];

  const metricsIncludePrincipal =
    cli.metricsIncludePrincipal ??
    parseBoolean(process.env.TRILIUM_METRICS_INCLUDE_PRINCIPAL) ??
    file.metricsIncludePrincipal ??
    false;

  const corsOrigins =
    cli.corsOrigins ??
    (process.env.TRILIUM_CORS_ORIGINS ? splitCsv(process.env.TRILIUM_CORS_ORIGINS) : undefined) ??
    file.corsOrigins ??
    [];

  const rateLimitRps = validateNonNegative(
    cli.rateLimitRps ?? emptyToUndefined(process.env.TRILIUM_RATE_LIMIT_RPS) ?? file.rateLimitRps,
    'rate-limit rps',
    false
  );

  const rateLimitBurst = validateNonNegative(
    cli.rateLimitBurst ??
      emptyToUndefined(process.env.TRILIUM_RATE_LIMIT_BURST) ??
      file.rateLimitBurst,
    'rate-limit burst',
    true
  );

  const jwtSecrets =
    cli.jwtSecrets ??
    (process.env.TRILIUM_JWT_SECRETS ? splitCsv(process.env.TRILIUM_JWT_SECRETS) : undefined) ??
    file.jwtSecrets ??
    [];

  const jwtJwksUrl =
    cli.jwtJwksUrl ?? emptyToUndefined(process.env.TRILIUM_JWT_JWKS_URL) ?? file.jwtJwksUrl ?? null;

  const jwtIssuer =
    cli.jwtIssuer ?? emptyToUndefined(process.env.TRILIUM_JWT_ISSUER) ?? file.jwtIssuer ?? null;

  const jwtAudience =
    cli.jwtAudience ??
    emptyToUndefined(process.env.TRILIUM_JWT_AUDIENCE) ??
    file.jwtAudience ??
    null;

  const jwtPrincipalClaim =
    cli.jwtPrincipalClaim ??
    emptyToUndefined(process.env.TRILIUM_JWT_PRINCIPAL_CLAIM) ??
    file.jwtPrincipalClaim ??
    'sub';

  const requestTimeoutMs =
    cli.requestTimeoutMs ??
    parseDuration(process.env.TRILIUM_REQUEST_TIMEOUT) ??
    file.requestTimeoutMs ??
    DEFAULT_REQUEST_TIMEOUT_MS;

  const busyCooldownMs =
    cli.busyCooldownMs ??
    parseDuration(process.env.TRILIUM_BUSY_COOLDOWN) ??
    file.busyCooldownMs ??
    DEFAULT_BUSY_COOLDOWN_MS;

  const searchStrategyRaw =
    cli.searchStrategy ??
    emptyToUndefined(process.env.TRILIUM_SEARCH_STRATEGY) ??
    file.searchStrategy;
  const searchStrategy: SearchStrategy =
    searchStrategyRaw === 'fast' || searchStrategyRaw === 'full' ? searchStrategyRaw : 'auto';

  const metricsAuthRaw =
    cli.metricsAuth ??
    emptyToUndefined(process.env.TRILIUM_METRICS_AUTH) ??
    file.metricsAuth ??
    undefined;
  let metricsAuth: MetricsAuthMode =
    metricsAuthRaw === undefined
      ? 'gateway'
      : parseEnumValue(metricsAuthRaw, METRICS_AUTH_MODES, 'metrics auth mode');

  // Single-tenant mode: require token (URL has a sensible default). Historical behavior.
  if (!multiTenant && !rawToken) {
    console.error('Error: Trilium ETAPI token is required.');
    console.error('Provide it via --token, TRILIUM_TOKEN environment variable, or config file.');
    console.error('Or run in multi-tenant mode with --multi-tenant so clients supply their own.');
    process.exit(1);
  }

  // Multi-tenant requires HTTP transport. Stdio is a single bidirectional pipe
  // with no way to multiplex per-connection creds.
  if (multiTenant && transport !== 'http') {
    console.error('Error: --multi-tenant requires --transport http.');
    process.exit(1);
  }

  // Multi-tenant mode: startup-supplied TRILIUM_URL/TRILIUM_TOKEN are NOT
  // allowed. Mixing them with per-connection headers used to fall back
  // independently, which meant a client sending X-Trilium-Url alone would
  // cause the operator's default token to leak to the client-chosen URL.
  // In multi-tenant mode, creds MUST travel together as a pair.
  if (multiTenant && (rawUrl !== undefined || rawToken !== '')) {
    console.error(
      'Error: --multi-tenant does not accept startup TRILIUM_URL or TRILIUM_TOKEN. ' +
        'Clients must supply both as X-Trilium-Url and X-Trilium-Token headers.'
    );
    process.exit(1);
  }

  // Bearer auth without any configured tokens is pointless and dangerous-looking
  // (would accept nothing / confuse operators); fail loudly.
  if (gatewayAuth === 'bearer' && gatewayTokens.length === 0) {
    console.error('Error: --gateway-auth bearer requires at least one --gateway-token.');
    console.error(
      'Either provide a token or pass --gateway-auth none (NOT recommended for multi-tenant).'
    );
    process.exit(1);
  }

  // JWT auth needs at least one verifier configured.
  if (gatewayAuth === 'jwt' && jwtSecrets.length === 0 && !jwtJwksUrl) {
    console.error(
      'Error: --gateway-auth jwt requires at least one --jwt-secret (HS256) or --jwt-jwks-url (RS256/ES256).'
    );
    process.exit(1);
  }

  // JWKS without an audience accepts ANY token the identity provider issues
  // for ANY client/application. Loud, but not fatal (existing deployments).
  if (gatewayAuth === 'jwt' && jwtJwksUrl && !jwtAudience) {
    console.error(
      'WARNING: --gateway-auth jwt with --jwt-jwks-url but no --jwt-audience. Any token your ' +
        'identity provider issues for ANY application will be accepted. Set --jwt-audience ' +
        "(TRILIUM_JWT_AUDIENCE) to this server's client id / audience."
    );
  }

  // Multi-tenant + unrestricted local reads would let every tenant read the
  // server's entire filesystem via tool inputs.
  if (multiTenant && allowLocalFileRead && localFileRoots.length === 0) {
    throw new ConfigError(
      '--multi-tenant with --allow-local-file-read requires --local-file-roots ' +
        '(unrestricted local reads would expose the server filesystem to every tenant).'
    );
  }

  // Metrics validation.
  let metricsEnabled = metricsEnabledRaw;
  if (metricsEnabled && transport !== 'http') {
    console.error(
      'Warning: --metrics has no effect with --transport stdio (no HTTP listener). Ignoring.'
    );
    metricsEnabled = false;
  }
  if (metricsEnabled && metricsAuth === 'bearer' && metricsTokens.length === 0) {
    console.error('Error: --metrics-auth bearer requires at least one --metrics-token.');
    console.error(
      'Either provide a scrape token or use --metrics-auth gateway or --metrics-auth none.'
    );
    process.exit(1);
  }
  if (metricsEnabled && metricsAuth === 'gateway' && gatewayAuth === 'none') {
    // gateway-auth=none means there's no bearer to reuse — metricsAuth=gateway
    // would be silently equivalent to `none`. Make that explicit.
    console.error(
      'Warning: --metrics-auth gateway requested but --gateway-auth=none. ' +
        'Falling back to --metrics-auth=none (the /metrics endpoint will be open).'
    );
    metricsAuth = 'none';
  }
  if (metricsEnabled && metricsAuth === 'gateway' && gatewayAuth === 'jwt') {
    console.error(
      'Error: --metrics-auth=gateway is incompatible with --gateway-auth=jwt. ' +
        'Prometheus typically ships a static bearer token; use --metrics-auth=bearer ' +
        'with --metrics-token, or --metrics-auth=none.'
    );
    process.exit(1);
  }

  const triliumUrl = multiTenant
    ? null
    : rawUrl
      ? normalizeServerUrl(rawUrl)
      : normalizeServerUrl('http://localhost:37740');
  const triliumToken = multiTenant ? null : rawToken;

  // The public URL is the web-UI root used for clickable note links. Normalize
  // it the same way as a derived base (strip any accidental /etapi + slashes) so
  // operators can pass either the bare host or the ETAPI URL.
  const publicUrl = rawPublicUrl ? deriveWebBaseUrl(rawPublicUrl) : null;

  return {
    triliumUrl,
    triliumToken,
    publicUrl,
    transport,
    httpPort,
    httpHost,
    allowedHosts,
    multiTenant,
    gatewayAuth,
    gatewayTokens,
    urlAllowlist,
    allowPrivateUrls,
    maxPostBytes,
    allowLocalFileRead,
    localFileRoots,
    contentUrlAllowlist,
    maxContentFetchBytes,
    metricsEnabled,
    metricsAuth,
    metricsTokens,
    metricsIncludePrincipal,
    corsOrigins,
    rateLimitRps,
    rateLimitBurst,
    jwtSecrets,
    jwtJwksUrl,
    jwtIssuer,
    jwtAudience,
    jwtPrincipalClaim,
    requestTimeoutMs,
    busyCooldownMs,
    searchStrategy,
  };
}
