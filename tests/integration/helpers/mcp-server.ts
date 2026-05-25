import { spawn, ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(__dirname, '../../../dist/index.js');

export async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const addr = server.address() as net.AddressInfo;
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

export async function createStdioClient(triliumUrl: string) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_ENTRY],
    env: { ...process.env, TRILIUM_URL: triliumUrl, TRILIUM_TOKEN: 'test' },
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

/**
 * Spawn the MCP server in HTTP mode and return both the spawned process and
 * its listening port. The caller picks the wire transport (SSE or
 * StreamableHTTP) — those just differ in which endpoint they hit.
 */
async function spawnHttpServer(
  triliumUrl: string,
  port?: number,
  extraEnv: Record<string, string> = {}
): Promise<{ serverProcess: ChildProcess; port: number }> {
  const serverPort = port ?? (await getAvailablePort());

  const serverProcess = spawn('node', [SERVER_ENTRY], {
    env: {
      ...process.env,
      TRILIUM_URL: triliumUrl,
      TRILIUM_TOKEN: 'test',
      TRILIUM_TRANSPORT: 'http',
      TRILIUM_HTTP_PORT: String(serverPort),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for server ready message
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timeout')), 10000);
    const onReady = (data: Buffer): void => {
      if (data.toString().includes('server_started')) {
        clearTimeout(timeout);
        resolve();
      }
    };
    serverProcess.stdout?.on('data', onReady);
    serverProcess.stderr?.on('data', onReady);
    serverProcess.on('error', reject);
  });

  return { serverProcess, port: serverPort };
}

export async function createHttpClient(
  triliumUrl: string,
  port?: number,
  extraEnv: Record<string, string> = {}
) {
  const { serverProcess, port: serverPort } = await spawnHttpServer(triliumUrl, port, extraEnv);

  const transport = new SSEClientTransport(new URL(`http://localhost:${serverPort}/sse`));
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);

  return { client, transport, serverProcess, port: serverPort };
}

/**
 * Create a client speaking the StreamableHTTP transport against the /mcp
 * endpoint. This is the modern HTTP transport — distinct from the legacy
 * SSE transport above which uses /sse + /message.
 */
export async function createStreamableHttpClient(
  triliumUrl: string,
  port?: number,
  extraEnv: Record<string, string> = {}
) {
  const { serverProcess, port: serverPort } = await spawnHttpServer(triliumUrl, port, extraEnv);

  const transport = new StreamableHTTPClientTransport(
    new URL(`http://localhost:${serverPort}/mcp`)
  );
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);

  return { client, transport, serverProcess, port: serverPort };
}

export async function cleanup(
  client: Client,
  transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport,
  serverProcess?: ChildProcess
) {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
  serverProcess?.kill();
}

export const EXPECTED_TOOL_COUNT = 19;
