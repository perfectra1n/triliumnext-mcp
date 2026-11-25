import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Leaf modules only (none imports config.ts back), so there is no cycle:
// each owning module keeps its default and config re-uses it.
import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_BUSY_COOLDOWN_MS,
  DEFAULT_BUSY_PROBE_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
} from './client/trilium.js';
import { DEFAULT_JWT_CLOCK_TOLERANCE_SEC } from './http/jwtAuth.js';
import { parseCidr } from './http/clientIp.js';

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
const SEARCH_STRATEGIES: readonly SearchStrategy[] = ['auto', 'fast', 'full'];
const TRANSPORTS: readonly ('stdio' | 'http')[] = ['stdio', 'http'];

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
   * proxy forwards. On a non-loopback bind the Host check is off by default;
   * setting this list opts in to it (loopback names and the bind address stay
   * accepted alongside these entries).
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
   * - `jwt`: require a signed JWT (`Authorization: Bearer <jwt>`), see `jwt*`
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
   * If true, skip private/loopback IP checks on client-supplied (multi-tenant)
   * Trilium URLs. Use for homelab setups where Trilium lives on a private
   * network. Does NOT govern content URL fetches — see `contentAllowPrivateUrls`.
   */
  allowPrivateUrls: boolean;
  /**
   * If true, http(s) CONTENT fetches (LLM-supplied attachment/image URLs) may
   * target private/loopback addresses. When unset, loadConfig uses false in
   * multi-tenant mode and `allowPrivateUrls` otherwise (that flag used to
   * govern both, and in single-tenant mode content fetches were its only
   * effect). Optional for embedders, with the same fallback.
   */
  contentAllowPrivateUrls?: boolean;
  /**
   * Reverse-proxy addresses / CIDRs whose `X-Forwarded-For` header is
   * trusted for rate limiting. Empty (default): key on the socket peer.
   */
  trustedProxies?: string[];
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
   * `contentAllowPrivateUrls`).
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

  // ---- Tunables below are optional so embedders/tests may omit them; loadConfig
  // ---- always fills them with the defaults documented in printHelp / README.

  /** Timeout for cheap requests while a Trilium is marked busy (default 5s). */
  busyProbeTimeoutMs?: number;
  /** Retries for idempotent ETAPI requests on network errors / 502-504 (default 2). */
  maxRetries?: number;
  /** Base retry backoff in ms, doubled per attempt (default 250). */
  retryDelayMs?: number;
  /**
   * Largest ETAPI response body buffered for any request (default 64 MiB).
   * Larger bodies are refused before they are read into memory.
   */
  maxResponseBytes?: number;
  /** get_attachment inlines image/binary attachments up to this size (default 5 MiB). */
  maxInlineAttachmentBytes?: number;
  /** get_note inlines each embedded image up to this size (default 1 MiB). */
  maxNoteImageBytes?: number;
  /** get_note inlines embedded images up to this total per call (default 4 MiB). */
  maxNoteImagesTotalBytes?: number;
  /** Largest export ZIP manage_system returns inline (default 10 MiB). */
  maxExportBytes?: number;
  /** Characters of text returned per read before truncation/paging (default 50000). */
  contentCharCap?: number;
  /** Ceiling for get_note's content_max_chars parameter (default 500000). */
  contentMaxCharsLimit?: number;
  /** Timeout for each http(s) content download (default 30s). */
  contentFetchTimeoutMs?: number;
  /** Progress heartbeat cadence during slow tool calls (default 10s). */
  progressIntervalMs?: number;
  /** search_notes `limit` default (50) and ceiling (10000). */
  defaultSearchLimit?: number;
  maxSearchLimit?: number;
  /** strategy "auto": a fast pass with at least this many hits skips the body search (default 5). */
  searchFastMinResults?: number;
  /** search_notes results that get a contentPreview (default 20). */
  searchPreviewMaxResults?: number;
  /** Max in-flight ETAPI requests for preview / tree fan-out (default 5). */
  fetchConcurrency?: number;
  /** Notes fetched per get_note_tree call (default 200). */
  treeMaxNotes?: number;
  /** Fuzzy fallback: max OR terms (8), recall multiplier (4), recall window cap (200). */
  fuzzyMaxTerms?: number;
  fuzzyRecallMultiplier?: number;
  fuzzyRecallCap?: number;
  /** get_note include_path: max tree placements walked (default 10). */
  noteMaxPaths?: number;
  /** get_note include_backlinks: max backlinks returned (default 50). */
  noteMaxBacklinks?: number;
  /** get_note_history `limit` default (100) and ceiling (1000). */
  historyLimit?: number;
  historyMaxLimit?: number;
  /** SSE keep-alive ping cadence (default 30s). */
  sseKeepaliveMs?: number;
  /** Idle TTL for Streamable HTTP sessions; 0 disables expiry (default 30m). */
  sessionIdleTtlMs?: number;
  /** How often idle sessions are swept (default min(60s, max(1s, ttl/2))). */
  sessionSweepIntervalMs?: number;
  /** Max concurrently open MCP sessions across both HTTP transports (default 1000). */
  maxSessions?: number;
  /** Timeout of the Trilium probe made when an HTTP session connects (default 10s). */
  triliumValidateTimeoutMs?: number;
  /** Clock skew tolerated on JWT exp/nbf, in seconds (default 30). */
  jwtClockToleranceSec?: number;
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
  contentAllowPrivateUrls?: boolean;
  trustedProxies?: string[];
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
  busyProbeTimeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  maxResponseBytes?: number;
  maxInlineAttachmentBytes?: number;
  maxNoteImageBytes?: number;
  maxNoteImagesTotalBytes?: number;
  maxExportBytes?: number;
  contentCharCap?: number;
  contentMaxCharsLimit?: number;
  contentFetchTimeoutMs?: number;
  progressIntervalMs?: number;
  defaultSearchLimit?: number;
  maxSearchLimit?: number;
  searchFastMinResults?: number;
  searchPreviewMaxResults?: number;
  fetchConcurrency?: number;
  treeMaxNotes?: number;
  fuzzyMaxTerms?: number;
  fuzzyRecallMultiplier?: number;
  fuzzyRecallCap?: number;
  noteMaxPaths?: number;
  noteMaxBacklinks?: number;
  historyLimit?: number;
  historyMaxLimit?: number;
  sseKeepaliveMs?: number;
  sessionIdleTtlMs?: number;
  sessionSweepIntervalMs?: number;
  maxSessions?: number;
  triliumValidateTimeoutMs?: number;
  jwtClockToleranceSec?: number;
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
  contentAllowPrivateUrls?: boolean;
  trustedProxies?: string[];
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
  busyProbeTimeoutMs?: number;
  maxRetries?: string;
  retryDelayMs?: number;
  maxResponseBytes?: number;
  maxInlineAttachmentBytes?: number;
  maxNoteImageBytes?: number;
  maxNoteImagesTotalBytes?: number;
  maxExportBytes?: number;
  contentCharCap?: string;
  contentMaxCharsLimit?: string;
  contentFetchTimeoutMs?: number;
  progressIntervalMs?: number;
  defaultSearchLimit?: string;
  maxSearchLimit?: string;
  searchFastMinResults?: string;
  searchPreviewMaxResults?: string;
  fetchConcurrency?: string;
  treeMaxNotes?: string;
  fuzzyMaxTerms?: string;
  fuzzyRecallMultiplier?: string;
  fuzzyRecallCap?: string;
  noteMaxPaths?: string;
  noteMaxBacklinks?: string;
  historyLimit?: string;
  historyMaxLimit?: string;
  sseKeepaliveMs?: number;
  sessionIdleTtlMs?: number;
  sessionSweepIntervalMs?: number;
  maxSessions?: string;
  triliumValidateTimeoutMs?: number;
  jwtClockToleranceSec?: string;
}

function requireSize(flag: string, raw: string): number {
  const parsed = parseSize(raw);
  if (parsed === undefined) {
    throw new ConfigError(`Invalid size for ${flag}: "${raw}" (use bytes or e.g. 64mb, 1gb).`);
  }
  return parsed;
}

function requireDuration(flag: string, raw: string, allowZero = false): number {
  const parsed = allowZero ? parseDurationOrZero(raw) : parseDuration(raw);
  if (parsed === undefined) {
    throw new ConfigError(
      `Invalid duration for ${flag}: "${raw}" (use ms or e.g. 500ms, 90s, 2m${allowZero ? '; 0 disables' : ''}).`
    );
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
      case '--content-allow-private-urls':
        result.contentAllowPrivateUrls = true;
        break;
      case '--trusted-proxies':
        result.trustedProxies ??= [];
        result.trustedProxies.push(...splitCsv(value()));
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
      case '--request-timeout':
        result.requestTimeoutMs = requireDuration(arg, value());
        break;
      case '--busy-cooldown':
        result.busyCooldownMs = requireDuration(arg, value());
        break;
      case '--search-strategy':
        result.searchStrategy = value();
        break;
      case '--busy-probe-timeout':
        result.busyProbeTimeoutMs = requireDuration(arg, value());
        break;
      case '--max-retries':
        result.maxRetries = value();
        break;
      case '--retry-delay':
        result.retryDelayMs = requireDuration(arg, value());
        break;
      case '--max-response-bytes':
        result.maxResponseBytes = requireSize(arg, value());
        break;
      case '--max-inline-attachment-bytes':
        result.maxInlineAttachmentBytes = requireSize(arg, value());
        break;
      case '--max-note-image-bytes':
        result.maxNoteImageBytes = requireSize(arg, value());
        break;
      case '--max-note-images-total-bytes':
        result.maxNoteImagesTotalBytes = requireSize(arg, value());
        break;
      case '--max-export-bytes':
        result.maxExportBytes = requireSize(arg, value());
        break;
      case '--content-char-cap':
        result.contentCharCap = value();
        break;
      case '--content-max-chars-limit':
        result.contentMaxCharsLimit = value();
        break;
      case '--content-fetch-timeout':
        result.contentFetchTimeoutMs = requireDuration(arg, value());
        break;
      case '--progress-interval':
        result.progressIntervalMs = requireDuration(arg, value());
        break;
      case '--default-search-limit':
        result.defaultSearchLimit = value();
        break;
      case '--max-search-limit':
        result.maxSearchLimit = value();
        break;
      case '--search-fast-min-results':
        result.searchFastMinResults = value();
        break;
      case '--search-preview-max-results':
        result.searchPreviewMaxResults = value();
        break;
      case '--fetch-concurrency':
        result.fetchConcurrency = value();
        break;
      case '--tree-max-notes':
        result.treeMaxNotes = value();
        break;
      case '--fuzzy-max-terms':
        result.fuzzyMaxTerms = value();
        break;
      case '--fuzzy-recall-multiplier':
        result.fuzzyRecallMultiplier = value();
        break;
      case '--fuzzy-recall-cap':
        result.fuzzyRecallCap = value();
        break;
      case '--note-max-paths':
        result.noteMaxPaths = value();
        break;
      case '--note-max-backlinks':
        result.noteMaxBacklinks = value();
        break;
      case '--history-limit':
        result.historyLimit = value();
        break;
      case '--history-max-limit':
        result.historyMaxLimit = value();
        break;
      case '--sse-keepalive':
        result.sseKeepaliveMs = requireDuration(arg, value());
        break;
      case '--session-idle-ttl':
        result.sessionIdleTtlMs = requireDuration(arg, value(), true);
        break;
      case '--session-sweep-interval':
        result.sessionSweepIntervalMs = requireDuration(arg, value());
        break;
      case '--max-sessions':
        result.maxSessions = value();
        break;
      case '--validate-timeout':
        result.triliumValidateTimeoutMs = requireDuration(arg, value());
        break;
      case '--jwt-clock-tolerance':
        result.jwtClockToleranceSec = value();
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
                                     sets TRILIUM_HTTP_HOST=0.0.0.0). On loopback, the Host
                                     header must be a loopback name or an --allowed-hosts entry.
  --allowed-hosts <hosts>            Extra Host header values accepted while bound to loopback
                                     (comma-separated). Required when a same-host reverse proxy
                                     forwards the public Host header to a loopback-bound server.
                                     On a non-loopback bind, setting this enables the Host check.
  --trusted-proxies <cidrs>          Reverse-proxy IPs/CIDRs whose X-Forwarded-For is trusted for
                                     rate limiting (comma-separated, repeatable). Default: none,
                                     i.e. key on the TCP peer. Only list proxies you control.

Multi-tenant HTTP options (require --transport http):
  --multi-tenant                     Each SSE client supplies its own Trilium URL + token
                                     via X-Trilium-Url and X-Trilium-Token headers
  --gateway-auth <mode>              Gateway auth mode: none, bearer, or jwt
                                     (default: bearer when multi-tenant is enabled, none otherwise)
  --gateway-token <token>            Accepted bearer token. Repeatable; supply once per token.
  --trilium-url-allowlist <hosts>    Comma-separated hostnames permitted in X-Trilium-Url.
                                     Supports suffix match (example.com matches a.example.com).
  --allow-private-urls               Allow client Trilium URLs that resolve to private/loopback
                                     IPs (default: blocked in multi-tenant mode to prevent SSRF).
                                     Does not apply to content URLs in multi-tenant mode.
  --max-post-bytes <size>            Max size of a single MCP JSON-RPC POST body (/message and
                                     /mcp). Accepts raw bytes or suffixed values
                                     (e.g. 64mb, 1gb). Default: 64mb. Must be > 0.

Content input (file paths / URLs in attachment and image tool inputs):
  --allow-local-file-read            Permit tool inputs that name local file paths.
                                     Default: on for stdio, off for --transport http.
  --no-local-file-read               Disable local file path inputs.
  --local-file-roots <dirs>          Comma-separated directories content may be read from.
                                     Empty (default) = unrestricted when reads are allowed.
  --content-url-allowlist <hosts>    Comma-separated hostnames permitted for http(s) content
                                     fetches. Empty = any public host (private IPs still
                                     blocked unless --content-allow-private-urls).
  --content-allow-private-urls       Let content URL fetches reach private/loopback IPs.
                                     Default: off in multi-tenant mode; otherwise follows
                                     --allow-private-urls.
  --max-content-fetch-bytes <size>   Max size of a content file read or URL download.
                                     Accepts raw bytes or suffixed values (e.g. 50mb).
                                     Default: 50mb. Must be > 0.

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
                                     requests/second. Off by default (0). IPv6 clients share a
                                     bucket per /64. Behind a reverse proxy set --trusted-proxies,
                                     or every client shares the proxy's bucket.
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
                                     requests get the --busy-probe-timeout. Default: 30s.
  --search-strategy <mode>           Default search_notes strategy: auto (titles and labels
                                     first, note bodies only if that finds too few), fast, or
                                     full. Default: auto.
  --busy-probe-timeout <duration>    Timeout for other requests while Trilium is marked busy.
                                     Default: 5s.
  --max-retries <n>                  Retries for idempotent requests on network errors or
                                     502/503/504 (0-10). Default: 2.
  --retry-delay <duration>           Base retry backoff, doubled per attempt (max 60s).
                                     Default: 250ms.
  --max-response-bytes <size>        Largest ETAPI response buffered for any request; bigger
                                     bodies are refused before being read. Default: 64mb.
                                     Must be > 0 and at least the inline/export caps below.

Response limits (what tools return to the model):
  --max-inline-attachment-bytes <size>
                                     get_attachment inlines images/binaries up to this size;
                                     larger ones return metadata only (0 = never). Default: 5mb.
  --max-note-image-bytes <size>      get_note inlines each embedded image up to this size
                                     (0 = never). Default: 1mb.
  --max-note-images-total-bytes <size>
                                     get_note inlines embedded images up to this total per call
                                     (0 = never). Default: 4mb.
  --max-export-bytes <size>          Largest export ZIP returned inline (> 0). Default: 10mb.
  --content-char-cap <n>             Text characters returned per read before truncation or
                                     paging (get_note default page, revisions, attachments).
                                     Default: 50000.
  --content-max-chars-limit <n>      Ceiling for get_note's content_max_chars. Default: 500000.
  --content-fetch-timeout <duration> Timeout for each http(s) content download. Default: 30s.
  --progress-interval <duration>     Progress heartbeat cadence during slow tool calls.
                                     Default: 10s.

Search tuning:
  --default-search-limit <n>         search_notes results when no limit is given. Default: 50.
  --max-search-limit <n>             Ceiling for search_notes' limit. Default: 10000.
  --search-fast-min-results <n>      strategy auto: a title/label pass with this many hits skips
                                     the body search. Default: 5.
  --search-preview-max-results <n>   Results that get a contentPreview. Default: 20.
  --fetch-concurrency <n>            Max in-flight ETAPI requests for preview/tree fan-out.
                                     Default: 5.
  --tree-max-notes <n>               Notes fetched per get_note_tree call. Default: 200.
  --fuzzy-max-terms <n>              Fuzzy fallback: max OR terms. Default: 8.
  --fuzzy-recall-multiplier <n>      Fuzzy fallback: candidates fetched per result. Default: 4.
  --fuzzy-recall-cap <n>             Fuzzy fallback: candidate window cap. Default: 200.
  --note-max-paths <n>               get_note include_path: max placements walked. Default: 10.
  --note-max-backlinks <n>           get_note include_backlinks: max backlinks. Default: 50.
  --history-limit <n>                get_note_history default limit. Default: 100.
  --history-max-limit <n>            get_note_history limit ceiling. Default: 1000.

HTTP sessions (require --transport http):
  --sse-keepalive <duration>         SSE keep-alive ping cadence. Default: 30s.
  --session-idle-ttl <duration>      Expire Streamable HTTP sessions idle this long (0 = never).
                                     Default: 30m.
  --session-sweep-interval <duration>
                                     How often idle sessions are swept.
                                     Default: min(60s, max(1s, ttl/2)).
  --max-sessions <n>                 Max concurrently open MCP sessions. Default: 1000.
  --validate-timeout <duration>      Timeout of the Trilium probe on session connect.
                                     Default: 10s.
  --jwt-clock-tolerance <seconds>    Clock skew tolerated on JWT exp/nbf. Default: 30.

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
  TRILIUM_TRUSTED_PROXIES            Comma-separated proxy IPs/CIDRs trusted for X-Forwarded-For
  TRILIUM_MULTI_TENANT               "true" to enable multi-tenant mode
  TRILIUM_GATEWAY_AUTH               none, bearer, or jwt
  TRILIUM_GATEWAY_TOKENS             Comma-separated accepted bearer tokens
  TRILIUM_URL_ALLOWLIST              Comma-separated allowed hostnames for client URLs
  TRILIUM_ALLOW_PRIVATE_URLS         "true" to skip the private-IP SSRF guard for Trilium URLs
  TRILIUM_CONTENT_ALLOW_PRIVATE_URLS "true" to let content URL fetches reach private IPs
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
  TRILIUM_BUSY_PROBE_TIMEOUT         --busy-probe-timeout          (default 5s)
  TRILIUM_MAX_RETRIES                --max-retries                 (default 2, max 10)
  TRILIUM_RETRY_DELAY                --retry-delay                 (default 250ms, max 60s)
  TRILIUM_MAX_RESPONSE_BYTES         --max-response-bytes          (default 64mb)
  TRILIUM_MAX_INLINE_ATTACHMENT_BYTES --max-inline-attachment-bytes (default 5mb)
  TRILIUM_MAX_NOTE_IMAGE_BYTES       --max-note-image-bytes        (default 1mb)
  TRILIUM_MAX_NOTE_IMAGES_TOTAL_BYTES --max-note-images-total-bytes (default 4mb)
  TRILIUM_MAX_EXPORT_BYTES           --max-export-bytes            (default 10mb)
  TRILIUM_CONTENT_CHAR_CAP           --content-char-cap            (default 50000)
  TRILIUM_CONTENT_MAX_CHARS_LIMIT    --content-max-chars-limit     (default 500000)
  TRILIUM_CONTENT_FETCH_TIMEOUT      --content-fetch-timeout       (default 30s)
  TRILIUM_PROGRESS_INTERVAL          --progress-interval           (default 10s)
  TRILIUM_DEFAULT_SEARCH_LIMIT       --default-search-limit        (default 50)
  TRILIUM_MAX_SEARCH_LIMIT           --max-search-limit            (default 10000)
  TRILIUM_SEARCH_FAST_MIN_RESULTS    --search-fast-min-results     (default 5)
  TRILIUM_SEARCH_PREVIEW_MAX_RESULTS --search-preview-max-results  (default 20)
  TRILIUM_FETCH_CONCURRENCY          --fetch-concurrency           (default 5)
  TRILIUM_TREE_MAX_NOTES             --tree-max-notes              (default 200)
  TRILIUM_FUZZY_MAX_TERMS            --fuzzy-max-terms             (default 8)
  TRILIUM_FUZZY_RECALL_MULTIPLIER    --fuzzy-recall-multiplier     (default 4)
  TRILIUM_FUZZY_RECALL_CAP           --fuzzy-recall-cap            (default 200)
  TRILIUM_NOTE_MAX_PATHS             --note-max-paths              (default 10)
  TRILIUM_NOTE_MAX_BACKLINKS         --note-max-backlinks          (default 50)
  TRILIUM_HISTORY_LIMIT              --history-limit               (default 100)
  TRILIUM_HISTORY_MAX_LIMIT          --history-max-limit           (default 1000)
  TRILIUM_SSE_KEEPALIVE              --sse-keepalive               (default 30s)
  TRILIUM_SESSION_IDLE_TTL           --session-idle-ttl            (default 30m; 0 = never)
  TRILIUM_SESSION_SWEEP_INTERVAL     --session-sweep-interval      (default derived from TTL)
  TRILIUM_MAX_SESSIONS               --max-sessions                (default 1000)
  TRILIUM_VALIDATE_TIMEOUT           --validate-timeout            (default 10s)
  TRILIUM_JWT_CLOCK_TOLERANCE        --jwt-clock-tolerance         (default 30, seconds)

Logging:
  LOG_LEVEL                          silent | error | warn | info | debug (default: info)
                                     'info' emits one line per tools/call with timing and outcome.
                                     'debug' adds tool args (with secrets and content blobs redacted).
  LOG_FORMAT                         text | json (default: text)
                                     text  -> human-readable "<ts> LEVEL event k=v" lines
                                     json  -> one JSON object per line, for log shippers
  Output stream is chosen by transport: stdio -> stderr (stdout is JSON-RPC); http -> stdout.

  Invalid values are errors: an unparseable size, duration, integer, boolean or enum (from
  the CLI, the environment or the config file) stops startup with a message naming it.

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

const MIB = 1024 * 1024;
const DEFAULT_MAX_POST_BYTES = 64 * MIB;
const DEFAULT_MAX_CONTENT_FETCH_BYTES = 50 * MIB;

/** Largest delay `setTimeout` honours (2^31-1 ms, ~24.8 days); longer ones fire at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** Upper bound for --max-retries. */
const MAX_RETRIES_LIMIT = 10;
/**
 * Upper bound for --retry-delay. Backoff is `retryDelay * 2^attempt` with
 * attempt < maxRetries <= 10, so the longest sleep is 60s * 2^9 (~8.5 h),
 * comfortably below MAX_TIMER_MS.
 */
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * Defaults for the numeric tunables. Values owned by another module (client,
 * JWT auth) are imported from it; the HTTP server and tool wiring in
 * server.ts read theirs from here, so each default has one source of truth.
 */
export const TUNABLE_DEFAULTS = {
  busyProbeTimeoutMs: DEFAULT_BUSY_PROBE_TIMEOUT_MS,
  maxRetries: DEFAULT_MAX_RETRIES,
  retryDelayMs: DEFAULT_RETRY_DELAY_MS,
  maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
  maxInlineAttachmentBytes: 5 * MIB,
  maxNoteImageBytes: 1 * MIB,
  maxNoteImagesTotalBytes: 4 * MIB,
  maxExportBytes: 10 * MIB,
  contentCharCap: 50_000,
  contentMaxCharsLimit: 500_000,
  contentFetchTimeoutMs: 30_000,
  progressIntervalMs: 10_000,
  defaultSearchLimit: 50,
  maxSearchLimit: 10_000,
  searchFastMinResults: 5,
  searchPreviewMaxResults: 20,
  fetchConcurrency: 5,
  treeMaxNotes: 200,
  fuzzyMaxTerms: 8,
  fuzzyRecallMultiplier: 4,
  fuzzyRecallCap: 200,
  noteMaxPaths: 10,
  noteMaxBacklinks: 50,
  historyLimit: 100,
  historyMaxLimit: 1000,
  sseKeepaliveMs: 30_000,
  sessionIdleTtlMs: 30 * 60 * 1000,
  maxSessions: 1000,
  triliumValidateTimeoutMs: 10_000,
  jwtClockToleranceSec: DEFAULT_JWT_CLOCK_TOLERANCE_SEC,
} as const;

/** `TRILIUM_FOO_BAR` -> `--foo-bar` (holds for every numeric setting). */
function flagFor(envVar: string): string {
  return `--${envVar
    .replace(/^TRILIUM_/, '')
    .toLowerCase()
    .replace(/_/g, '-')}`;
}

function checkRange(
  value: number,
  source: string,
  raw: unknown,
  min: number,
  max: number,
  what: string
): number {
  if (value < min || value > max) {
    const range = max === Infinity ? `>= ${min}` : `between ${min} and ${max}`;
    throw new ConfigError(`Invalid ${what} for ${source}: "${String(raw)}". Must be ${range}.`);
  }
  return value;
}

interface Bounds {
  min?: number;
  max?: number;
}

/**
 * CLI > env > file > default for a byte size. An unparseable env value, a
 * non-numeric file value, or anything outside [min, max] is a ConfigError
 * naming the setting. `min` defaults to 0 (where 0 is meaningful, e.g.
 * "inline nothing"); pass 1 where a zero cap is nonsensical.
 */
function sizeSetting(
  cli: number | undefined,
  envVar: string,
  file: unknown,
  fallback: number,
  { min = 0, max = Infinity }: Bounds = {}
): number {
  if (cli !== undefined) return checkRange(cli, flagFor(envVar), cli, min, max, 'size');
  const envRaw = emptyToUndefined(process.env[envVar]);
  if (envRaw !== undefined) {
    const parsed = parseSize(envRaw);
    if (parsed === undefined) {
      throw new ConfigError(
        `Invalid size for ${envVar}: "${envRaw}" (use bytes or e.g. 64mb, 1gb).`
      );
    }
    return checkRange(parsed, envVar, envRaw, min, max, 'size');
  }
  const fromFile = fileNumber(file, envVar, min);
  if (fromFile !== undefined) {
    return checkRange(fromFile, `config-file ${envVar}`, fromFile, min, max, 'size');
  }
  return fallback;
}

/**
 * CLI > env > file > default for a duration in ms. Same error rules as
 * {@link sizeSetting}; 0 is rejected unless `allowZero` (where it means
 * "disabled"), and nothing may exceed what `setTimeout` can represent.
 */
function durationSetting(
  cli: number | undefined,
  envVar: string,
  file: unknown,
  fallback: number | undefined,
  { allowZero = false, max = MAX_TIMER_MS }: { allowZero?: boolean; max?: number } = {}
): number | undefined {
  const min = allowZero ? 0 : 1;
  if (cli !== undefined) return checkRange(cli, flagFor(envVar), cli, min, max, 'duration');
  const envRaw = emptyToUndefined(process.env[envVar]);
  if (envRaw !== undefined) {
    const parsed = allowZero ? parseDurationOrZero(envRaw) : parseDuration(envRaw);
    if (parsed === undefined) {
      throw new ConfigError(
        `Invalid duration for ${envVar}: "${envRaw}" (use ms or e.g. 500ms, 90s, 2m${allowZero ? '; 0 disables' : ''}).`
      );
    }
    return checkRange(parsed, envVar, envRaw, min, max, 'duration');
  }
  const fromFile = fileNumber(file, envVar, min);
  if (fromFile !== undefined) {
    return checkRange(fromFile, `config-file ${envVar}`, fromFile, min, max, 'duration');
  }
  return fallback;
}

/** CLI > env > file > default for an integer; any invalid value is a ConfigError (like the rate limits). */
function intSetting(
  cli: string | undefined,
  envVar: string,
  file: unknown,
  fallback: number,
  min: number,
  max = Infinity
): number {
  const raw = cli ?? emptyToUndefined(process.env[envVar]) ?? file;
  if (raw === undefined) return fallback;
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw.trim())
        : NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    const range =
      max === Infinity ? `an integer >= ${min}` : `an integer between ${min} and ${max}`;
    throw new ConfigError(`Invalid value for ${envVar}: "${String(raw)}". Must be ${range}.`);
  }
  return n;
}

/** A numeric config-file value: absent → undefined; present but not a number >= min → ConfigError. */
function fileNumber(value: unknown, envVar: string, min: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new ConfigError(
      `Invalid config-file value for ${envVar}: ${JSON.stringify(value)}. Must be a number >= ${min}.`
    );
  }
  return value;
}

/** A boolean config-file value: absent → undefined; anything but true/false → ConfigError. */
function fileBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ConfigError(
      `Invalid config-file value for ${key}: ${JSON.stringify(value)}. Must be true or false.`
    );
  }
  return value;
}

/**
 * A boolean env value: unset/empty → undefined; true/1/yes or false/0/no
 * (case-insensitive) → the boolean; anything else → ConfigError, so a typo
 * never silently flips a security switch back to its default.
 */
function envBoolean(envVar: string): boolean | undefined {
  const raw = emptyToUndefined(process.env[envVar]);
  if (raw === undefined) return undefined;
  const parsed = parseBoolean(raw.trim());
  if (parsed === undefined) {
    throw new ConfigError(
      `Invalid value for ${envVar}: "${raw}". Use true/false (or 1/0, yes/no).`
    );
  }
  return parsed;
}

/** A string-list config-file value: an array of strings or a CSV string. */
function fileStringList(value: unknown, key: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return splitCsv(value);
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return value.map((v) => v.trim()).filter((v) => v.length > 0);
  }
  throw new ConfigError(
    `Invalid config-file value for ${key}: ${JSON.stringify(value)}. Must be an array of strings.`
  );
}

/** CLI > env (CSV) > file (array or CSV) > []. */
function listSetting(
  cli: string[] | undefined,
  envVar: string,
  file: unknown,
  key: string
): string[] {
  const env = emptyToUndefined(process.env[envVar]);
  return cli ?? (env !== undefined ? splitCsv(env) : undefined) ?? fileStringList(file, key) ?? [];
}

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

/** Like {@link parseDuration}, but also accepts an explicit "0" (e.g. "disabled"). */
function parseDurationOrZero(value: string | undefined): number | undefined {
  if (value !== undefined && /^\s*0+(\.0+)?\s*(ms|s|m)?\s*$/i.test(value)) return 0;
  return parseDuration(value);
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

  const transportRaw =
    cli.transport ?? emptyToUndefined(process.env.TRILIUM_TRANSPORT) ?? file.transport;
  const transport: 'stdio' | 'http' =
    transportRaw === undefined ? 'stdio' : parseEnumValue(transportRaw, TRANSPORTS, 'transport');

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

  const allowedHosts = listSetting(
    cli.allowedHosts,
    'TRILIUM_ALLOWED_HOSTS',
    file.allowedHosts,
    'allowedHosts'
  );

  const multiTenant =
    cli.multiTenant ??
    envBoolean('TRILIUM_MULTI_TENANT') ??
    fileBoolean(file.multiTenant, 'multiTenant') ??
    false;

  const gatewayTokens = listSetting(
    cli.gatewayTokens,
    'TRILIUM_GATEWAY_TOKENS',
    file.gatewayTokens,
    'gatewayTokens'
  );

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

  const urlAllowlist = listSetting(
    cli.urlAllowlist,
    'TRILIUM_URL_ALLOWLIST',
    file.urlAllowlist,
    'urlAllowlist'
  );

  const allowPrivateUrls =
    cli.allowPrivateUrls ??
    envBoolean('TRILIUM_ALLOW_PRIVATE_URLS') ??
    fileBoolean(file.allowPrivateUrls, 'allowPrivateUrls') ??
    false;

  // Content fetches are LLM-driven, so they get their own private-network
  // switch. Unset: off in multi-tenant mode (a tenant's model must not reach
  // the operator's network just because tenant Trilium URLs may be private);
  // otherwise inherit --allow-private-urls, which used to govern both and, in
  // single-tenant mode, had no other effect.
  const contentAllowPrivateUrls =
    cli.contentAllowPrivateUrls ??
    envBoolean('TRILIUM_CONTENT_ALLOW_PRIVATE_URLS') ??
    fileBoolean(file.contentAllowPrivateUrls, 'contentAllowPrivateUrls') ??
    (multiTenant ? false : allowPrivateUrls);

  const trustedProxies = listSetting(
    cli.trustedProxies,
    'TRILIUM_TRUSTED_PROXIES',
    file.trustedProxies,
    'trustedProxies'
  );
  for (const entry of trustedProxies) {
    if (!parseCidr(entry)) {
      throw new ConfigError(
        `Invalid trusted proxy "${entry}" (TRILIUM_TRUSTED_PROXIES / --trusted-proxies): ` +
          'use an IP address or CIDR, e.g. 10.0.0.0/8, 172.16.0.1, fd00::/8.'
      );
    }
  }

  const maxPostBytes = sizeSetting(
    cli.maxPostBytes,
    'TRILIUM_MAX_POST_BYTES',
    file.maxPostBytes,
    DEFAULT_MAX_POST_BYTES,
    { min: 1 }
  );

  // Local file reads default ON for stdio (the operator's own machine) and OFF
  // for the http transport, where an LLM-supplied path reads the SERVER's
  // filesystem on behalf of an arbitrary client.
  const allowLocalFileRead =
    cli.allowLocalFileRead ??
    envBoolean('TRILIUM_ALLOW_LOCAL_FILE_READ') ??
    fileBoolean(file.allowLocalFileRead, 'allowLocalFileRead') ??
    transport === 'stdio';

  const localFileRoots = listSetting(
    cli.localFileRoots,
    'TRILIUM_LOCAL_FILE_ROOTS',
    file.localFileRoots,
    'localFileRoots'
  );

  const contentUrlAllowlist = listSetting(
    cli.contentUrlAllowlist,
    'TRILIUM_CONTENT_URL_ALLOWLIST',
    file.contentUrlAllowlist,
    'contentUrlAllowlist'
  );

  const maxContentFetchBytes = sizeSetting(
    cli.maxContentFetchBytes,
    'TRILIUM_MAX_CONTENT_FETCH_BYTES',
    file.maxContentFetchBytes,
    DEFAULT_MAX_CONTENT_FETCH_BYTES,
    { min: 1 }
  );

  const metricsEnabledRaw =
    cli.metrics ?? envBoolean('TRILIUM_METRICS') ?? fileBoolean(file.metrics, 'metrics') ?? false;

  const metricsTokens = listSetting(
    cli.metricsTokens,
    'TRILIUM_METRICS_TOKENS',
    file.metricsTokens,
    'metricsTokens'
  );

  const metricsIncludePrincipal =
    cli.metricsIncludePrincipal ??
    envBoolean('TRILIUM_METRICS_INCLUDE_PRINCIPAL') ??
    fileBoolean(file.metricsIncludePrincipal, 'metricsIncludePrincipal') ??
    false;

  const corsOrigins = listSetting(
    cli.corsOrigins,
    'TRILIUM_CORS_ORIGINS',
    file.corsOrigins,
    'corsOrigins'
  );

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

  const jwtSecrets = listSetting(
    cli.jwtSecrets,
    'TRILIUM_JWT_SECRETS',
    file.jwtSecrets,
    'jwtSecrets'
  );

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

  // Export/import/backup get 5x this, so keep 5x within setTimeout's range.
  const requestTimeoutMs = durationSetting(
    cli.requestTimeoutMs,
    'TRILIUM_REQUEST_TIMEOUT',
    file.requestTimeoutMs,
    DEFAULT_TIMEOUT_MS,
    { max: Math.floor(MAX_TIMER_MS / 5) }
  );

  const busyCooldownMs = durationSetting(
    cli.busyCooldownMs,
    'TRILIUM_BUSY_COOLDOWN',
    file.busyCooldownMs,
    DEFAULT_BUSY_COOLDOWN_MS
  );

  const searchStrategyRaw =
    cli.searchStrategy ??
    emptyToUndefined(process.env.TRILIUM_SEARCH_STRATEGY) ??
    file.searchStrategy;
  const searchStrategy: SearchStrategy =
    searchStrategyRaw === undefined
      ? 'auto'
      : parseEnumValue(searchStrategyRaw, SEARCH_STRATEGIES, 'search strategy');

  const D = TUNABLE_DEFAULTS;
  const busyProbeTimeoutMs = durationSetting(
    cli.busyProbeTimeoutMs,
    'TRILIUM_BUSY_PROBE_TIMEOUT',
    file.busyProbeTimeoutMs,
    D.busyProbeTimeoutMs
  );
  const maxRetries = intSetting(
    cli.maxRetries,
    'TRILIUM_MAX_RETRIES',
    file.maxRetries,
    D.maxRetries,
    0,
    MAX_RETRIES_LIMIT
  );
  const retryDelayMs = durationSetting(
    cli.retryDelayMs,
    'TRILIUM_RETRY_DELAY',
    file.retryDelayMs,
    D.retryDelayMs,
    { max: MAX_RETRY_DELAY_MS }
  );
  const maxResponseBytes = sizeSetting(
    cli.maxResponseBytes,
    'TRILIUM_MAX_RESPONSE_BYTES',
    file.maxResponseBytes,
    D.maxResponseBytes,
    { min: 1 }
  );
  const maxInlineAttachmentBytes = sizeSetting(
    cli.maxInlineAttachmentBytes,
    'TRILIUM_MAX_INLINE_ATTACHMENT_BYTES',
    file.maxInlineAttachmentBytes,
    Math.min(D.maxInlineAttachmentBytes, maxResponseBytes)
  );
  const maxNoteImageBytes = sizeSetting(
    cli.maxNoteImageBytes,
    'TRILIUM_MAX_NOTE_IMAGE_BYTES',
    file.maxNoteImageBytes,
    Math.min(D.maxNoteImageBytes, maxResponseBytes)
  );
  const maxNoteImagesTotalBytes = sizeSetting(
    cli.maxNoteImagesTotalBytes,
    'TRILIUM_MAX_NOTE_IMAGES_TOTAL_BYTES',
    file.maxNoteImagesTotalBytes,
    D.maxNoteImagesTotalBytes
  );
  const maxExportBytes = sizeSetting(
    cli.maxExportBytes,
    'TRILIUM_MAX_EXPORT_BYTES',
    file.maxExportBytes,
    Math.min(D.maxExportBytes, maxResponseBytes),
    { min: 1 }
  );
  // Every inline cap is read through the client, whose maxResponseBytes
  // refuses larger bodies first — a bigger cap could never be reached. The
  // defaults above shrink to fit; an explicit contradiction is an error
  // rather than something that fails confusingly at runtime.
  for (const [value, envVar] of [
    [maxInlineAttachmentBytes, 'TRILIUM_MAX_INLINE_ATTACHMENT_BYTES'],
    [maxNoteImageBytes, 'TRILIUM_MAX_NOTE_IMAGE_BYTES'],
    [maxExportBytes, 'TRILIUM_MAX_EXPORT_BYTES'],
  ] as const) {
    if (value > maxResponseBytes) {
      throw new ConfigError(
        `${envVar} (${flagFor(envVar)}) is ${value} bytes, larger than ` +
          `TRILIUM_MAX_RESPONSE_BYTES (--max-response-bytes, ${maxResponseBytes} bytes), so it could ` +
          'never take effect. Lower it or raise --max-response-bytes.'
      );
    }
  }
  const contentCharCap = intSetting(
    cli.contentCharCap,
    'TRILIUM_CONTENT_CHAR_CAP',
    file.contentCharCap,
    D.contentCharCap,
    1
  );
  const contentMaxCharsLimit = intSetting(
    cli.contentMaxCharsLimit,
    'TRILIUM_CONTENT_MAX_CHARS_LIMIT',
    file.contentMaxCharsLimit,
    D.contentMaxCharsLimit,
    1
  );
  const contentFetchTimeoutMs = durationSetting(
    cli.contentFetchTimeoutMs,
    'TRILIUM_CONTENT_FETCH_TIMEOUT',
    file.contentFetchTimeoutMs,
    D.contentFetchTimeoutMs
  );
  const progressIntervalMs = durationSetting(
    cli.progressIntervalMs,
    'TRILIUM_PROGRESS_INTERVAL',
    file.progressIntervalMs,
    D.progressIntervalMs
  );
  const defaultSearchLimit = intSetting(
    cli.defaultSearchLimit,
    'TRILIUM_DEFAULT_SEARCH_LIMIT',
    file.defaultSearchLimit,
    D.defaultSearchLimit,
    1
  );
  const maxSearchLimit = intSetting(
    cli.maxSearchLimit,
    'TRILIUM_MAX_SEARCH_LIMIT',
    file.maxSearchLimit,
    D.maxSearchLimit,
    1
  );
  const searchFastMinResults = intSetting(
    cli.searchFastMinResults,
    'TRILIUM_SEARCH_FAST_MIN_RESULTS',
    file.searchFastMinResults,
    D.searchFastMinResults,
    1
  );
  const searchPreviewMaxResults = intSetting(
    cli.searchPreviewMaxResults,
    'TRILIUM_SEARCH_PREVIEW_MAX_RESULTS',
    file.searchPreviewMaxResults,
    D.searchPreviewMaxResults,
    0
  );
  const fetchConcurrency = intSetting(
    cli.fetchConcurrency,
    'TRILIUM_FETCH_CONCURRENCY',
    file.fetchConcurrency,
    D.fetchConcurrency,
    1
  );
  const treeMaxNotes = intSetting(
    cli.treeMaxNotes,
    'TRILIUM_TREE_MAX_NOTES',
    file.treeMaxNotes,
    D.treeMaxNotes,
    1
  );
  const fuzzyMaxTerms = intSetting(
    cli.fuzzyMaxTerms,
    'TRILIUM_FUZZY_MAX_TERMS',
    file.fuzzyMaxTerms,
    D.fuzzyMaxTerms,
    1
  );
  const fuzzyRecallMultiplier = intSetting(
    cli.fuzzyRecallMultiplier,
    'TRILIUM_FUZZY_RECALL_MULTIPLIER',
    file.fuzzyRecallMultiplier,
    D.fuzzyRecallMultiplier,
    1
  );
  const fuzzyRecallCap = intSetting(
    cli.fuzzyRecallCap,
    'TRILIUM_FUZZY_RECALL_CAP',
    file.fuzzyRecallCap,
    D.fuzzyRecallCap,
    1
  );
  const noteMaxPaths = intSetting(
    cli.noteMaxPaths,
    'TRILIUM_NOTE_MAX_PATHS',
    file.noteMaxPaths,
    D.noteMaxPaths,
    1
  );
  const noteMaxBacklinks = intSetting(
    cli.noteMaxBacklinks,
    'TRILIUM_NOTE_MAX_BACKLINKS',
    file.noteMaxBacklinks,
    D.noteMaxBacklinks,
    1
  );
  const historyLimit = intSetting(
    cli.historyLimit,
    'TRILIUM_HISTORY_LIMIT',
    file.historyLimit,
    D.historyLimit,
    1
  );
  const historyMaxLimit = intSetting(
    cli.historyMaxLimit,
    'TRILIUM_HISTORY_MAX_LIMIT',
    file.historyMaxLimit,
    D.historyMaxLimit,
    1
  );
  const sseKeepaliveMs = durationSetting(
    cli.sseKeepaliveMs,
    'TRILIUM_SSE_KEEPALIVE',
    file.sseKeepaliveMs,
    D.sseKeepaliveMs
  );
  const sessionIdleTtlMs = durationSetting(
    cli.sessionIdleTtlMs,
    'TRILIUM_SESSION_IDLE_TTL',
    file.sessionIdleTtlMs,
    D.sessionIdleTtlMs,
    { allowZero: true }
  );
  // Unset → derived from the TTL by the HTTP server.
  const sessionSweepIntervalMs = durationSetting(
    cli.sessionSweepIntervalMs,
    'TRILIUM_SESSION_SWEEP_INTERVAL',
    file.sessionSweepIntervalMs,
    undefined
  );
  const maxSessions = intSetting(
    cli.maxSessions,
    'TRILIUM_MAX_SESSIONS',
    file.maxSessions,
    D.maxSessions,
    1
  );
  const triliumValidateTimeoutMs = durationSetting(
    cli.triliumValidateTimeoutMs,
    'TRILIUM_VALIDATE_TIMEOUT',
    file.triliumValidateTimeoutMs,
    D.triliumValidateTimeoutMs
  );
  const jwtClockToleranceSec = intSetting(
    cli.jwtClockToleranceSec,
    'TRILIUM_JWT_CLOCK_TOLERANCE',
    file.jwtClockToleranceSec,
    D.jwtClockToleranceSec,
    0
  );

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
    contentAllowPrivateUrls,
    trustedProxies,
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
    busyProbeTimeoutMs,
    maxRetries,
    retryDelayMs,
    maxResponseBytes,
    maxInlineAttachmentBytes,
    maxNoteImageBytes,
    maxNoteImagesTotalBytes,
    maxExportBytes,
    contentCharCap,
    contentMaxCharsLimit,
    contentFetchTimeoutMs,
    progressIntervalMs,
    defaultSearchLimit,
    maxSearchLimit,
    searchFastMinResults,
    searchPreviewMaxResults,
    fetchConcurrency,
    treeMaxNotes,
    fuzzyMaxTerms,
    fuzzyRecallMultiplier,
    fuzzyRecallCap,
    noteMaxPaths,
    noteMaxBacklinks,
    historyLimit,
    historyMaxLimit,
    sseKeepaliveMs,
    sessionIdleTtlMs,
    sessionSweepIntervalMs,
    maxSessions,
    triliumValidateTimeoutMs,
    jwtClockToleranceSec,
  };
}
