import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { spawn, ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(__dirname, '../../dist/index.js');
const GATEWAY_TOKEN = 'integration-test-gateway-token';

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => {
      const addr = s.address() as net.AddressInfo;
      s.close(() => resolve(addr.port));
    });
    s.on('error', reject);
  });
}

async function startTriliumBox(): Promise<{
  container: StartedTestContainer;
  etapiUrl: string;
  baseUrl: string;
}> {
  const container = await new GenericContainer('triliumnext/notes:latest')
    .withExposedPorts(8080)
    .withEnvironment({ TRILIUM_GENERAL_NOAUTHENTICATION: 'true' })
    .withWaitStrategy(Wait.forHttp('/api/app-info', 8080).forStatusCode(200))
    .withStartupTimeout(120_000)
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(8080);
  const baseUrl = `http://${host}:${port}`;

  // Fresh Trilium needs a "new document" setup before ETAPI works.
  await fetch(`${baseUrl}/api/setup/new-document`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).catch(() => {/* may already be initialized */});
  await sleep(1000);

  return { container, etapiUrl: `${baseUrl}/etapi`, baseUrl };
}

async function startMcpServer(
  port: number,
  extraEnv: Record<string, string> = {}
): Promise<ChildProcess> {
  const proc = spawn('node', [SERVER_ENTRY], {
    env: {
      ...process.env,
      TRILIUM_TRANSPORT: 'http',
      TRILIUM_HTTP_PORT: String(port),
      TRILIUM_MULTI_TENANT: 'true',
      TRILIUM_GATEWAY_TOKENS: GATEWAY_TOKEN,
      // Trilium runs on 127.0.0.1 in tests — allow private IPs.
      TRILIUM_ALLOW_PRIVATE_URLS: 'true',
      // Wipe any ambient single-tenant config from the shell.
      TRILIUM_URL: '',
      TRILIUM_TOKEN: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('MCP startup timeout')), 10_000);
    proc.stderr?.on('data', (data) => {
      if (data.toString().includes('listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`MCP exited early with code ${code}`));
      }
    });
  });

  return proc;
}

async function connectMcpClient(
  mcpPort: number,
  headers: Record<string, string>
): Promise<{ client: Client; transport: SSEClientTransport }> {
  // `requestInit.headers` is plumbed into both the SSE GET and subsequent
  // POSTs by the SDK (see @modelcontextprotocol/sdk client/sse.js).
  const transport = new SSEClientTransport(new URL(`http://localhost:${mcpPort}/sse`), {
    requestInit: { headers },
  });
  const client = new Client({ name: 'mt-test-client', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

describe('Multi-tenant SSE', () => {
  let triliumA: Awaited<ReturnType<typeof startTriliumBox>>;
  let triliumB: Awaited<ReturnType<typeof startTriliumBox>>;
  let mcpProc: ChildProcess;
  let mcpPort: number;

  beforeAll(async () => {
    [triliumA, triliumB] = await Promise.all([startTriliumBox(), startTriliumBox()]);
    mcpPort = await getAvailablePort();
    mcpProc = await startMcpServer(mcpPort);
  }, 300_000);

  afterAll(async () => {
    mcpProc?.kill();
    await Promise.all([triliumA?.container.stop(), triliumB?.container.stop()]);
  });

  describe('gateway auth', () => {
    it('rejects connections without Authorization header', async () => {
      const res = await fetch(`http://localhost:${mcpPort}/sse`, {
        headers: {
          'X-Trilium-Url': triliumA.etapiUrl,
          'X-Trilium-Token': 'anything',
        },
      });
      expect(res.status).toBe(401);
    });

    it('rejects wrong gateway token', async () => {
      const res = await fetch(`http://localhost:${mcpPort}/sse`, {
        headers: {
          Authorization: 'Bearer wrong-token',
          'X-Trilium-Url': triliumA.etapiUrl,
          'X-Trilium-Token': 'anything',
        },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('credential validation', () => {
    it('fails fast on unreachable Trilium', async () => {
      const res = await fetch(`http://localhost:${mcpPort}/sse`, {
        headers: {
          Authorization: `Bearer ${GATEWAY_TOKEN}`,
          'X-Trilium-Url': 'http://127.0.0.1:1/etapi',
          'X-Trilium-Token': 'whatever',
        },
      });
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(res.status).toBeLessThan(600);
    });
  });

  describe('SSRF guard', () => {
    it('rejects link-local metadata IPs by default', async () => {
      // Start a *second* MCP server WITHOUT --allow-private-urls for this test.
      const strictPort = await getAvailablePort();
      const strictProc = await startMcpServer(strictPort, { TRILIUM_ALLOW_PRIVATE_URLS: 'false' });
      try {
        const res = await fetch(`http://localhost:${strictPort}/sse`, {
          headers: {
            Authorization: `Bearer ${GATEWAY_TOKEN}`,
            'X-Trilium-Url': 'http://169.254.169.254/',
            'X-Trilium-Token': 'anything',
          },
        });
        expect(res.status).toBe(400);
      } finally {
        strictProc.kill();
      }
    });
  });

  describe('tenant isolation', () => {
    let clientA: Client;
    let transportA: SSEClientTransport;
    let clientB: Client;
    let transportB: SSEClientTransport;

    afterEach(async () => {
      await Promise.allSettled([
        clientA?.close(),
        transportA?.close(),
        clientB?.close(),
        transportB?.close(),
      ]);
    });

    it('routes tool calls to per-connection Trilium instances', async () => {
      const a = await connectMcpClient(mcpPort, {
        Authorization: `Bearer ${GATEWAY_TOKEN}`,
        'X-Trilium-Url': triliumA.etapiUrl,
        'X-Trilium-Token': 'tenant-A-token',
      });
      const b = await connectMcpClient(mcpPort, {
        Authorization: `Bearer ${GATEWAY_TOKEN}`,
        'X-Trilium-Url': triliumB.etapiUrl,
        'X-Trilium-Token': 'tenant-B-token',
      });
      clientA = a.client; transportA = a.transport;
      clientB = b.client; transportB = b.transport;

      const createA = await clientA.callTool({
        name: 'create_note',
        arguments: {
          parentNoteId: 'root',
          title: 'Tenant A Note',
          type: 'text',
          content: '<p>A</p>',
        },
      });
      const contentA = (createA.content as Array<{ type: string; text: string }>)[0].text;
      expect(JSON.parse(contentA).note.title).toBe('Tenant A Note');

      const createB = await clientB.callTool({
        name: 'create_note',
        arguments: {
          parentNoteId: 'root',
          title: 'Tenant B Note',
          type: 'text',
          content: '<p>B</p>',
        },
      });
      const contentB = (createB.content as Array<{ type: string; text: string }>)[0].text;
      expect(JSON.parse(contentB).note.title).toBe('Tenant B Note');

      // Each tenant's search should only see its own note.
      const searchA = await clientA.callTool({
        name: 'search_notes',
        arguments: { query: 'Tenant' },
      });
      const searchTextA = (searchA.content as Array<{ type: string; text: string }>)[0].text;
      const resultsA = JSON.parse(searchTextA).results as Array<{ title: string }>;
      expect(resultsA.some((r) => r.title === 'Tenant A Note')).toBe(true);
      expect(resultsA.some((r) => r.title === 'Tenant B Note')).toBe(false);

      const searchB = await clientB.callTool({
        name: 'search_notes',
        arguments: { query: 'Tenant' },
      });
      const searchTextB = (searchB.content as Array<{ type: string; text: string }>)[0].text;
      const resultsB = JSON.parse(searchTextB).results as Array<{ title: string }>;
      expect(resultsB.some((r) => r.title === 'Tenant B Note')).toBe(true);
      expect(resultsB.some((r) => r.title === 'Tenant A Note')).toBe(false);
    });
  });

  describe('/health endpoint', () => {
    it('returns 200 without auth', async () => {
      const res = await fetch(`http://localhost:${mcpPort}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: 'ok' });
    });
  });
});
