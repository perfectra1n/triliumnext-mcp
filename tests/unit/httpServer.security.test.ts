import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { promises as dnsPromises } from 'node:dns';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
  type Server as HttpServer,
} from 'node:http';
import {
  startHttp,
  safeCode,
  safeStatus,
  logSafe,
  type HttpServerOptions,
} from '../../src/http/server.js';
import { createLogger, type Logger } from '../../src/utils/logger.js';
import type { Config } from '../../src/config.js';
import type { BaseLookup } from '../../src/http/urlGuard.js';

/**
 * Multi-tenant SSRF (connect-time guard), reflected upstream error fields,
 * the session-cap admission race, trusted-proxy rate limiting and log
 * sanitization — end-to-end against a fake Trilium.
 */

const quietLogger = createLogger({ level: 'silent', stream: 'stderr' });

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const appInfo: Handler = (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ appVersion: '0.99.0', dbVersion: 1, syncVersion: 1 }));
};

let fakeTrilium: HttpServer;
let fakePort: number;
let handler: Handler = appInfo;
let hits = 0;

beforeAll(async () => {
  fakeTrilium = createServer((req, res) => {
    hits += 1;
    handler(req, res);
  });
  await new Promise<void>((resolve) => fakeTrilium.listen(0, '127.0.0.1', resolve));
  fakePort = (fakeTrilium.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => fakeTrilium.close(() => resolve()));
});

interface Started {
  server: HttpServer;
  port: number;
  url: (path: string) => string;
}

function makeConfig(overrides: Partial<Config>): Config {
  return {
    triliumUrl: `http://127.0.0.1:${fakePort}/etapi`,
    triliumToken: 'dummy',
    publicUrl: null,
    transport: 'http',
    httpPort: 0,
    httpHost: '127.0.0.1',
    allowedHosts: [],
    multiTenant: false,
    gatewayAuth: 'bearer',
    gatewayTokens: ['gw'],
    urlAllowlist: [],
    allowPrivateUrls: false,
    maxPostBytes: 1024 * 1024,
    metricsEnabled: false,
    metricsAuth: 'gateway',
    metricsTokens: [],
    metricsIncludePrincipal: false,
    corsOrigins: [],
    rateLimitRps: 0,
    rateLimitBurst: 0,
    jwtSecrets: [],
    jwtJwksUrl: null,
    jwtIssuer: null,
    jwtAudience: null,
    jwtPrincipalClaim: 'sub',
    ...overrides,
  } as Config;
}

const started: Started[] = [];
afterEach(async () => {
  handler = appInfo;
  hits = 0;
  vi.restoreAllMocks();
  while (started.length > 0) {
    const s = started.pop()!;
    s.server.closeAllConnections();
    await new Promise<void>((resolve) => s.server.close(() => resolve()));
  }
});

async function startTestServer(
  overrides: Partial<Config> = {},
  options: HttpServerOptions = {},
  logger: Logger = quietLogger
): Promise<Started> {
  const server = await startHttp(makeConfig(overrides), logger, options);
  const addr = server.address() as AddressInfo;
  const s = {
    server,
    port: addr.port,
    url: (path: string) => `http://127.0.0.1:${addr.port}${path}`,
  };
  started.push(s);
  return s;
}

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
});

function initStreamable(s: Started, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(s.url('/mcp'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer gw',
      ...headers,
    },
    body: INIT_BODY,
  });
}

function captureLogger(): { logger: Logger; events: Array<[string, Record<string, unknown>]> } {
  const events: Array<[string, Record<string, unknown>]> = [];
  const push =
    () =>
    (event: string, fields: Record<string, unknown> = {}): void => {
      events.push([event, fields]);
    };
  return {
    logger: { info: push(), warn: push(), error: push(), debug: push() },
    events,
  };
}

describe('multi-tenant connect-time SSRF guard', () => {
  it('refuses a tenant host that passed the pre-flight but rebinds to a private address', async () => {
    // Pre-flight (assertUrlIsSafe) sees a public address...
    vi.spyOn(dnsPromises, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ] as never);
    // ...but at connect time the name resolves to loopback (DNS rebinding).
    const rebound: BaseLookup = (_host, _opts, cb) =>
      cb(null, [{ address: '127.0.0.1', family: 4 }]);
    const { logger, events } = captureLogger();
    const s = await startTestServer(
      { multiTenant: true, triliumUrl: null, triliumToken: null },
      { tenantLookup: rebound },
      logger
    );

    const res = await initStreamable(s, {
      'X-Trilium-Url': `http://rebind.test:${fakePort}`,
      'X-Trilium-Token': 'tenant-token',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'url_rejected', reason: 'private_address' });
    expect(hits).toBe(0); // never connected to the private service
    const rejected = events.find(([e]) => e === 'url_rejected');
    expect(rejected?.[1]).toMatchObject({ stage: 'connect', detail: 'rebind.test -> 127.0.0.1' });
  });

  it('applies the same guard over SSE', async () => {
    vi.spyOn(dnsPromises, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ] as never);
    const rebound: BaseLookup = (_host, _opts, cb) =>
      cb(null, [{ address: '127.0.0.1', family: 4 }]);
    const s = await startTestServer(
      { multiTenant: true, triliumUrl: null, triliumToken: null },
      { tenantLookup: rebound }
    );
    const res = await fetch(s.url('/sse'), {
      headers: {
        Authorization: 'Bearer gw',
        'X-Trilium-Url': `http://rebind.test:${fakePort}`,
        'X-Trilium-Token': 'tenant-token',
      },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'url_rejected', reason: 'private_address' });
    expect(hits).toBe(0);
  });

  it('still connects through the guarded fetch when private URLs are allowed', async () => {
    const s = await startTestServer({
      multiTenant: true,
      triliumUrl: null,
      triliumToken: null,
      allowPrivateUrls: true,
    });
    const res = await initStreamable(s, {
      'X-Trilium-Url': `http://127.0.0.1:${fakePort}`,
      'X-Trilium-Token': 'tenant-token',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
    await res.text();
    expect(hits).toBeGreaterThan(0);
  });
});

describe('trilium_auth_failed reflection', () => {
  it('drops a malformed upstream status/code instead of echoing it', async () => {
    handler = (_req, res) => {
      res.writeHead(418, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: { nested: 'x' }, code: '<script>'.repeat(20) }));
    };
    const s = await startTestServer();
    const res = await initStreamable(s);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'trilium_auth_failed' });
  });

  it('keeps a well-formed upstream status/code', async () => {
    handler = (_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 401, code: 'NOT_AUTHENTICATED', message: 'no' }));
    };
    const s = await startTestServer();
    const res = await initStreamable(s);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'trilium_auth_failed',
      status: 401,
      code: 'NOT_AUTHENTICATED',
    });
  });

  it('sanitizers bound status and code', () => {
    expect(safeStatus(404)).toBe(404);
    expect(safeStatus(99)).toBeUndefined();
    expect(safeStatus('401')).toBeUndefined();
    expect(safeStatus(401.5)).toBeUndefined();
    expect(safeCode('TRILIUM_UNREACHABLE')).toBe('TRILIUM_UNREACHABLE');
    expect(safeCode('a b')).toBeUndefined();
    expect(safeCode('x'.repeat(65))).toBeUndefined();
    expect(safeCode(42)).toBeUndefined();
  });
});

describe('session cap admission', () => {
  it('counts in-flight admissions so concurrent connects cannot overshoot maxSessions', async () => {
    // A slow probe keeps every attempt "pending" while the others check the cap.
    handler = (req, res) => setTimeout(() => appInfo(req, res), 150);
    const s = await startTestServer({}, { maxSessions: 1 });
    const results = await Promise.all([initStreamable(s), initStreamable(s), initStreamable(s)]);
    const statuses = results.map((r) => r.status).sort();
    await Promise.all(results.map((r) => r.text()));
    expect(statuses).toEqual([200, 503, 503]);
  });

  it('releases the slot when an admitted attempt fails', async () => {
    handler = (_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{}');
    };
    const s = await startTestServer({}, { maxSessions: 1 });
    expect((await initStreamable(s)).status).toBe(401);
    handler = appInfo;
    const ok = await initStreamable(s);
    expect(ok.status).toBe(200);
    await ok.text();
  });
});

describe('rate limiting behind a trusted proxy', () => {
  const limited = {
    gatewayAuth: 'none' as const,
    gatewayTokens: [],
    rateLimitRps: 0.01,
    rateLimitBurst: 1,
  };
  const get = (s: Started, xff: string): Promise<Response> =>
    fetch(s.url('/mcp'), { headers: { 'X-Forwarded-For': xff } });

  it('keys on the right-most untrusted X-Forwarded-For hop when the peer is trusted', async () => {
    const s = await startTestServer({ ...limited, trustedProxies: ['127.0.0.1'] });
    expect((await get(s, 'spoofed, 203.0.113.5')).status).toBe(400);
    // Same client, different spoofed prefix: still the same bucket.
    expect((await get(s, 'other-spoof, 203.0.113.5')).status).toBe(429);
    // A different client behind the same proxy has its own bucket.
    expect((await get(s, '203.0.113.6')).status).toBe(400);
  });

  it('ignores X-Forwarded-For when no proxy is trusted', async () => {
    const s = await startTestServer(limited);
    expect((await get(s, '203.0.113.5')).status).toBe(400);
    expect((await get(s, '203.0.113.6')).status).toBe(429);
  });
});

describe('request_rejected logging', () => {
  it('logs a sanitized, truncated Host and Origin', async () => {
    const { logger, events } = captureLogger();
    const s = await startTestServer({ gatewayAuth: 'none', gatewayTokens: [] }, {}, logger);
    const host = `${'a'.repeat(300)}.example`;
    const status = await new Promise<number>((resolve, reject) => {
      const r = httpRequest(
        {
          host: '127.0.0.1',
          port: s.port,
          path: '/mcp',
          headers: { Host: host, Origin: 'https://evil.example' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      r.on('error', reject);
      r.end();
    });
    expect(status).toBe(403);
    const rejected = events.find(([e]) => e === 'request_rejected');
    expect(rejected).toBeDefined();
    const fields = rejected![1];
    expect(fields.reason).toBe('host_not_allowed');
    expect((fields.host as string).length).toBeLessThanOrEqual(131);
    expect(fields.host as string).toMatch(/^a+\.\.\.$/);
    expect(fields.origin).toBe('https://evil.example');
  });

  it('logSafe replaces non-printable characters and truncates', () => {
    expect(logSafe('ok.example:3000')).toBe('ok.example:3000');
    expect(logSafe('a\nb\u0000cé')).toBe('a?b?c?');
    expect(logSafe('x'.repeat(10), 4)).toBe('xxxx...');
    expect(logSafe(['first', 'second'])).toBe('first');
    expect(logSafe(undefined)).toBeUndefined();
  });
});
