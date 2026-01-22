import { spawn, ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
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

export async function createHttpClient(triliumUrl: string, port?: number) {
  const serverPort = port ?? (await getAvailablePort());

  const serverProcess = spawn('node', [SERVER_ENTRY], {
    env: {
      ...process.env,
      TRILIUM_URL: triliumUrl,
      TRILIUM_TOKEN: 'test',
      TRILIUM_TRANSPORT: 'http',
      TRILIUM_HTTP_PORT: String(serverPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for server ready message
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timeout')), 10000);
    serverProcess.stderr?.on('data', (data) => {
      if (data.toString().includes('listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    serverProcess.on('error', reject);
  });

  const transport = new SSEClientTransport(new URL(`http://localhost:${serverPort}/sse`));
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);

  return { client, transport, serverProcess, port: serverPort };
}

export async function cleanup(
  client: Client,
  transport: StdioClientTransport | SSEClientTransport,
  serverProcess?: ChildProcess
) {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
  serverProcess?.kill();
}

export const EXPECTED_TOOL_COUNT = 27;
