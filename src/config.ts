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

export type GatewayAuthMode = 'none' | 'bearer';

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
}

interface ConfigFile {
  url?: string;
  token?: string;
  transport?: 'stdio' | 'http';
  httpPort?: number;
  multiTenant?: boolean;
  gatewayAuth?: GatewayAuthMode;
  gatewayTokens?: string[];
  urlAllowlist?: string[];
  allowPrivateUrls?: boolean;
}

interface CliArgs {
  url?: string;
  token?: string;
  transport?: string;
  port?: number;
  help?: boolean;
  multiTenant?: boolean;
  gatewayAuth?: string;
  gatewayTokens?: string[];
  urlAllowlist?: string[];
  allowPrivateUrls?: boolean;
}

function parseCliArgs(args: string[]): CliArgs {
  const result: CliArgs = {};
  const gatewayTokens: string[] = [];

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
      case '--help':
      case '-h':
        result.help = true;
        break;
    }
  }

  if (gatewayTokens.length > 0) {
    result.gatewayTokens = gatewayTokens;
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
  --transport <type>                 Transport type: stdio or http (default: stdio)
  -p, --port <port>                  HTTP server port when using http transport (default: 3000)

Multi-tenant HTTP options (require --transport http):
  --multi-tenant                     Each SSE client supplies its own Trilium URL + token
                                     via X-Trilium-Url and X-Trilium-Token headers
  --gateway-auth <mode>              Gateway auth mode: none or bearer (default: bearer when
                                     multi-tenant is enabled, none otherwise)
  --gateway-token <token>            Accepted bearer token. Repeatable; supply once per token.
  --trilium-url-allowlist <hosts>    Comma-separated hostnames permitted in X-Trilium-Url.
                                     Supports suffix match (example.com matches a.example.com).
  --allow-private-urls               Allow client URLs that resolve to private/loopback IPs
                                     (default: blocked in multi-tenant mode to prevent SSRF)

  -h, --help                         Show this help message

Environment Variables:
  TRILIUM_URL                        Trilium server URL (base or full ETAPI URL)
  TRILIUM_TOKEN                      Trilium ETAPI token
  TRILIUM_TRANSPORT                  stdio or http
  TRILIUM_HTTP_PORT                  Port for HTTP transport
  TRILIUM_MULTI_TENANT               "true" to enable multi-tenant mode
  TRILIUM_GATEWAY_AUTH               none or bearer
  TRILIUM_GATEWAY_TOKENS             Comma-separated accepted bearer tokens
  TRILIUM_URL_ALLOWLIST              Comma-separated allowed hostnames for client URLs
  TRILIUM_ALLOW_PRIVATE_URLS         "true" to skip private-IP SSRF guard

Configuration File:
  Reads from ./trilium-mcp.json or ~/.trilium-mcp.json

Priority (highest to lowest):
  1. CLI arguments
  2. Environment variables
  3. Configuration file
  4. Default values
`);
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return undefined;
}

export function loadConfig(args: string[] = process.argv.slice(2)): Config | null {
  const cli = parseCliArgs(args);

  if (cli.help) {
    printHelp();
    return null;
  }

  const file = loadConfigFile();

  const rawUrl = cli.url ?? process.env.TRILIUM_URL ?? file.url;
  const rawToken = cli.token ?? process.env.TRILIUM_TOKEN ?? file.token ?? '';

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
  if (gatewayAuthRaw === 'bearer' || gatewayAuthRaw === 'none') {
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

  // Bearer auth without any configured tokens is pointless and dangerous-looking
  // (would accept nothing / confuse operators); fail loudly.
  if (gatewayAuth === 'bearer' && gatewayTokens.length === 0) {
    console.error('Error: --gateway-auth bearer requires at least one --gateway-token.');
    console.error('Either provide a token or pass --gateway-auth none (NOT recommended for multi-tenant).');
    process.exit(1);
  }

  const triliumUrl = rawUrl ? normalizeServerUrl(rawUrl) : multiTenant ? null : normalizeServerUrl('http://localhost:37740');
  const triliumToken = rawToken ? rawToken : multiTenant ? null : '';

  return {
    triliumUrl,
    triliumToken,
    transport,
    httpPort,
    multiTenant,
    gatewayAuth,
    gatewayTokens,
    urlAllowlist,
    allowPrivateUrls,
  };
}
