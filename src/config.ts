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
   * entirely. `*` enables wildcard mode (the request Origin is echoed back so
   * credentialed requests still work — browsers reject `Allow-Origin: *` with
   * credentials).
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
}

interface ConfigFile {
  url?: string;
  token?: string;
  publicUrl?: string;
  transport?: 'stdio' | 'http';
  httpPort?: number;
  multiTenant?: boolean;
  gatewayAuth?: GatewayAuthMode;
  gatewayTokens?: string[];
  urlAllowlist?: string[];
  allowPrivateUrls?: boolean;
  maxPostBytes?: number;
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
}

interface CliArgs {
  url?: string;
  token?: string;
  publicUrl?: string;
  transport?: string;
  port?: number;
  help?: boolean;
  multiTenant?: boolean;
  gatewayAuth?: string;
  gatewayTokens?: string[];
  urlAllowlist?: string[];
  allowPrivateUrls?: boolean;
  maxPostBytes?: number;
  metrics?: boolean;
  metricsAuth?: string;
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
}

function parseCliArgs(args: string[]): CliArgs {
  const result: CliArgs = {};
  const gatewayTokens: string[] = [];
  const metricsTokens: string[] = [];
  const jwtSecrets: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--url':
      case '-u':
        result.url = nextArg;
        i++;
        break;
      case '--token':
      case '-t':
        result.token = nextArg;
        i++;
        break;
      case '--public-url':
        result.publicUrl = nextArg;
        i++;
        break;
      case '--transport':
        result.transport = nextArg;
        i++;
        break;
      case '--port':
      case '-p':
        result.port = parseInt(nextArg, 10);
        i++;
        break;
      case '--multi-tenant':
        result.multiTenant = true;
        break;
      case '--gateway-auth':
        result.gatewayAuth = nextArg;
        i++;
        break;
      case '--gateway-token':
        if (nextArg) gatewayTokens.push(nextArg);
        i++;
        break;
      case '--trilium-url-allowlist':
        result.urlAllowlist = splitCsv(nextArg);
        i++;
        break;
      case '--allow-private-urls':
        result.allowPrivateUrls = true;
        break;
      case '--max-post-bytes':
        if (nextArg) {
          const parsed = parseSize(nextArg);
          if (parsed !== undefined) result.maxPostBytes = parsed;
        }
        i++;
        break;
      case '--metrics':
        result.metrics = true;
        break;
      case '--metrics-auth':
        result.metricsAuth = nextArg;
        i++;
        break;
      case '--metrics-token':
        if (nextArg) metricsTokens.push(nextArg);
        i++;
        break;
      case '--metrics-include-principal':
        result.metricsIncludePrincipal = true;
        break;
      case '--cors-origin':
        if (nextArg) {
          result.corsOrigins ??= [];
          result.corsOrigins.push(...splitCsv(nextArg));
        }
        i++;
        break;
      case '--rate-limit-rps':
        if (nextArg) {
          const n = Number(nextArg);
          if (Number.isFinite(n) && n >= 0) result.rateLimitRps = n;
        }
        i++;
        break;
      case '--rate-limit-burst':
        if (nextArg) {
          const n = parseInt(nextArg, 10);
          if (Number.isInteger(n) && n >= 0) result.rateLimitBurst = n;
        }
        i++;
        break;
      case '--jwt-secret':
        if (nextArg) jwtSecrets.push(nextArg);
        i++;
        break;
      case '--jwt-jwks-url':
        result.jwtJwksUrl = nextArg;
        i++;
        break;
      case '--jwt-issuer':
        result.jwtIssuer = nextArg;
        i++;
        break;
      case '--jwt-audience':
        result.jwtAudience = nextArg;
        i++;
        break;
      case '--jwt-principal-claim':
        result.jwtPrincipalClaim = nextArg;
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
        return JSON.parse(content) as ConfigFile;
      } catch {
        // Ignore parse errors, continue to next file
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
                                     (e.g. 500mb, 1gb). Default: 500mb.

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

  -h, --help                         Show this help message

Environment Variables:
  TRILIUM_URL                        Trilium server URL (base or full ETAPI URL)
  TRILIUM_TOKEN                      Trilium ETAPI token
  TRILIUM_PUBLIC_URL                 User-facing Trilium web URL for note links (defaults to
                                     TRILIUM_URL with /etapi stripped)
  TRILIUM_TRANSPORT                  stdio or http
  TRILIUM_HTTP_PORT                  Port for HTTP transport
  TRILIUM_MULTI_TENANT               "true" to enable multi-tenant mode
  TRILIUM_GATEWAY_AUTH               none or bearer
  TRILIUM_GATEWAY_TOKENS             Comma-separated accepted bearer tokens
  TRILIUM_URL_ALLOWLIST              Comma-separated allowed hostnames for client URLs
  TRILIUM_ALLOW_PRIVATE_URLS         "true" to skip private-IP SSRF guard
  TRILIUM_MAX_POST_BYTES             Max SSE POST body size (raw bytes or e.g. 500mb, 1gb)
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

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return undefined;
}

const DEFAULT_MAX_POST_BYTES = 500 * 1024 * 1024;

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
  const rawUrl =
    cli.url ?? emptyToUndefined(process.env.TRILIUM_URL) ?? file.url;
  const rawToken =
    cli.token ?? emptyToUndefined(process.env.TRILIUM_TOKEN) ?? file.token ?? '';

  const rawPublicUrl =
    cli.publicUrl ?? emptyToUndefined(process.env.TRILIUM_PUBLIC_URL) ?? file.publicUrl;

  const transportValue =
    cli.transport ?? process.env.TRILIUM_TRANSPORT ?? file.transport ?? 'stdio';
  const transport: 'stdio' | 'http' = transportValue === 'http' ? 'http' : 'stdio';

  const httpPort =
    cli.port ??
    (process.env.TRILIUM_HTTP_PORT ? parseInt(process.env.TRILIUM_HTTP_PORT, 10) : undefined) ??
    file.httpPort ??
    3000;

  const multiTenant =
    cli.multiTenant ??
    parseBoolean(process.env.TRILIUM_MULTI_TENANT) ??
    file.multiTenant ??
    false;

  const gatewayTokens =
    cli.gatewayTokens ??
    (process.env.TRILIUM_GATEWAY_TOKENS ? splitCsv(process.env.TRILIUM_GATEWAY_TOKENS) : undefined) ??
    file.gatewayTokens ??
    [];

  const gatewayAuthRaw =
    cli.gatewayAuth ?? process.env.TRILIUM_GATEWAY_AUTH ?? file.gatewayAuth ?? undefined;
  let gatewayAuth: GatewayAuthMode;
  if (gatewayAuthRaw === 'bearer' || gatewayAuthRaw === 'none' || gatewayAuthRaw === 'jwt') {
    gatewayAuth = gatewayAuthRaw;
  } else {
    // Default: require bearer when multi-tenant is on, otherwise keep legacy unauth behavior
    gatewayAuth = multiTenant ? 'bearer' : 'none';
  }

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

  const metricsEnabledRaw =
    cli.metrics ?? parseBoolean(process.env.TRILIUM_METRICS) ?? file.metrics ?? false;

  const metricsTokens =
    cli.metricsTokens ??
    (process.env.TRILIUM_METRICS_TOKENS ? splitCsv(process.env.TRILIUM_METRICS_TOKENS) : undefined) ??
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

  const rateLimitRps =
    cli.rateLimitRps ??
    parseNumber(process.env.TRILIUM_RATE_LIMIT_RPS) ??
    file.rateLimitRps ??
    0;

  const rateLimitBurst =
    cli.rateLimitBurst ??
    parseNumber(process.env.TRILIUM_RATE_LIMIT_BURST) ??
    file.rateLimitBurst ??
    0;

  const jwtSecrets =
    cli.jwtSecrets ??
    (process.env.TRILIUM_JWT_SECRETS ? splitCsv(process.env.TRILIUM_JWT_SECRETS) : undefined) ??
    file.jwtSecrets ??
    [];

  const jwtJwksUrl =
    cli.jwtJwksUrl ??
    emptyToUndefined(process.env.TRILIUM_JWT_JWKS_URL) ??
    file.jwtJwksUrl ??
    null;

  const jwtIssuer =
    cli.jwtIssuer ??
    emptyToUndefined(process.env.TRILIUM_JWT_ISSUER) ??
    file.jwtIssuer ??
    null;

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

  const metricsAuthRaw =
    cli.metricsAuth ?? process.env.TRILIUM_METRICS_AUTH ?? file.metricsAuth ?? undefined;
  let metricsAuth: MetricsAuthMode;
  if (metricsAuthRaw === 'gateway' || metricsAuthRaw === 'bearer' || metricsAuthRaw === 'none') {
    metricsAuth = metricsAuthRaw;
  } else {
    metricsAuth = 'gateway';
  }

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
    console.error('Either provide a token or pass --gateway-auth none (NOT recommended for multi-tenant).');
    process.exit(1);
  }

  // JWT auth needs at least one verifier configured.
  if (gatewayAuth === 'jwt' && jwtSecrets.length === 0 && !jwtJwksUrl) {
    console.error(
      'Error: --gateway-auth jwt requires at least one --jwt-secret (HS256) or --jwt-jwks-url (RS256/ES256).'
    );
    process.exit(1);
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
    console.error('Either provide a scrape token or use --metrics-auth gateway or --metrics-auth none.');
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
    multiTenant,
    gatewayAuth,
    gatewayTokens,
    urlAllowlist,
    allowPrivateUrls,
    maxPostBytes,
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
  };
}
