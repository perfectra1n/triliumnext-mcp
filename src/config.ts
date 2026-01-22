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

export interface Config {
  triliumUrl: string;
  triliumToken: string;
  transport: 'stdio' | 'http';
  httpPort: number;
}

interface ConfigFile {
  url?: string;
  token?: string;
  transport?: 'stdio' | 'http';
  httpPort?: number;
}

interface CliArgs {
  url?: string;
  token?: string;
  transport?: string;
  port?: number;
  help?: boolean;
}

function parseCliArgs(args: string[]): CliArgs {
  const result: CliArgs = {};

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
      case '--help':
      case '-h':
        result.help = true;
        break;
    }
  }

  return result;
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
  -u, --url <url>           Trilium server URL (default: http://localhost:37740)
                            Can be base URL or full ETAPI URL - /etapi is appended if missing
  -t, --token <token>       Trilium ETAPI token
  --transport <type>        Transport type: stdio or http (default: stdio)
  -p, --port <port>         HTTP server port when using http transport (default: 3000)
  -h, --help                Show this help message

Environment Variables:
  TRILIUM_URL               Trilium server URL (base or full ETAPI URL)
  TRILIUM_TOKEN             Trilium ETAPI token

Configuration File:
  Reads from ./trilium-mcp.json or ~/.trilium-mcp.json

Priority (highest to lowest):
  1. CLI arguments
  2. Environment variables
  3. Configuration file
  4. Default values
`);
}

export function loadConfig(args: string[] = process.argv.slice(2)): Config | null {
  const cli = parseCliArgs(args);

  if (cli.help) {
    printHelp();
    return null;
  }

  const file = loadConfigFile();

  const rawUrl = cli.url ?? process.env.TRILIUM_URL ?? file.url ?? 'http://localhost:37740';
  const triliumUrl = normalizeServerUrl(rawUrl);

  const triliumToken = cli.token ?? process.env.TRILIUM_TOKEN ?? file.token ?? '';

  const transportValue =
    cli.transport ?? process.env.TRILIUM_TRANSPORT ?? file.transport ?? 'stdio';
  const transport = transportValue === 'http' ? 'http' : 'stdio';

  const httpPort =
    cli.port ??
    (process.env.TRILIUM_HTTP_PORT ? parseInt(process.env.TRILIUM_HTTP_PORT, 10) : undefined) ??
    file.httpPort ??
    3000;

  if (!triliumToken) {
    console.error('Error: Trilium ETAPI token is required.');
    console.error('Provide it via --token, TRILIUM_TOKEN environment variable, or config file.');
    process.exit(1);
  }

  return {
    triliumUrl,
    triliumToken,
    transport,
    httpPort,
  };
}
