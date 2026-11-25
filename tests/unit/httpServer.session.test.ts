import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import {
  createServer,
  request as httpRequest,
  type Server as HttpServer,
  type IncomingHttpHeaders,
} from 'node:http';
import { startHttp, type HttpServerOptions } from '../../src/http/server.js';
import { createLogger } from '../../src/utils/logger.js';
import type { Config } from '../../src/config.js';

/**
 * Session ownership, session cap, rate limiting and the Host/Origin guard,
 * exercised end-to-end. A tiny fake Trilium answers the connect-time
 * `/etapi/app-info` probe so sessions can actually be opened.
 */

const quietLogger = createLogger({ level: 'silent', stream: 'stderr' });

let fakeTrilium: HttpServer;
let triliumUrl: string;

beforeAll(async () => {
  fakeTrilium = createServer((req, res) => {
    if (req.url?.startsWith('/etapi/app-info')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ appVersion: '0.99.0', dbVersion: 1, syncVersion: 1 }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => fakeTrilium.listen(0, '127.0.0.1', resolve));
  triliumUrl = `http://127.0.0.1:${(fakeTrilium.address() as AddressInfo).port}/etapi`;
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
    triliumUrl,
    triliumToken: 'dummy',
    publicUrl: null,
    transport: 'http',
    httpPort: 0,
    httpHost: '127.0.0.1',
    allowedHosts: [],
    multiTenant: false,
    gatewayAuth: 'bearer',
    gatewayTokens: ['token-a', 'token-b'],
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
  while (started.length > 0) {
    const s = started.pop()!;
    s.server.closeAllConnections();
    await new Promise<void>((resolve) => s.server.close(() => resolve()));
  }
});

async function startTestServer(
  overrides: Partial<Config> = {},
  options: HttpServerOptions = {}
): Promise<Started> {
  const server = await startHttp(makeConfig(overrides), quietLogger, options);
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

const STREAMABLE_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function initStreamable(s: Started, token: string): Promise<Response> {
  return fetch(s.url('/mcp'), {
    method: 'POST',
    headers: { ...STREAMABLE_HEADERS, ...bearer(token) },
    body: INIT_BODY,
  });
}

async function openStreamableSession(s: Started, token: string): Promise<string> {
  const res = await initStreamable(s, token);
  expect(res.status).toBe(200);
  const sid = res.headers.get('mcp-session-id');
  expect(sid).toBeTruthy();
  await res.text();
  return sid!;
}

function sendInitialized(s: Started, sid: string, token: string | null): Promise<Response> {
  return fetch(s.url('/mcp'), {
    method: 'POST',
    headers: {
      ...STREAMABLE_HEADERS,
      ...(token ? bearer(token) : {}),
      'MCP-Session-Id': sid,
      'MCP-Protocol-Version': '2025-03-26',
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
}

/** Open /sse and read the `endpoint` event to learn the session id. */
async function openSseSession(
  s: Started,
  token: string
): Promise<{ sessionId: string; abort: () => void }> {
  const controller = new AbortController();
  const res = await fetch(s.url('/sse'), {
    headers: bearer(token),
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error('SSE stream ended before the endpoint event');
    buffer += decoder.decode(value, { stream: true });
    const match = buffer.match(/sessionId=([0-9a-f-]+)/);
    if (match) return { sessionId: match[1], abort: () => controller.abort() };
  }
}

/** Raw request so the Host header can be set (fetch forbids overriding it). */
function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string>
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

describe('StreamableHTTP session ownership', () => {
  it('lets the creating identity keep using its session', async () => {
    const s = await startTestServer();
    const sid = await openStreamableSession(s, 'token-a');
    const res = await sendInitialized(s, sid, 'token-a');
    expect(res.status).toBe(202);
  });

  it('rejects a different gateway token presenting the same session id with 403', async () => {
    const s = await startTestServer();
    const sid = await openStreamableSession(s, 'token-a');
    const res = await sendInitialized(s, sid, 'token-b');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('session_forbidden');
  });

  it('rejects an unauthenticated request for an existing session with 401', async () => {
    const s = await startTestServer();
    const sid = await openStreamableSession(s, 'token-a');
    const res = await sendInitialized(s, sid, null);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer realm=/);
  });

  it('binds sessions to a constant identity when gateway auth is off', async () => {
    const s = await startTestServer({ gatewayAuth: 'none', gatewayTokens: [] });
    const sid = await openStreamableSession(s, 'anything');
    const res = await sendInitialized(s, sid, null);
    expect(res.status).toBe(202);
  });
});

describe('SSE session ownership', () => {
  it('requires the POST /message caller to match the identity that opened /sse', async () => {
    const s = await startTestServer();
    const { sessionId, abort } = await openSseSession(s, 'token-a');
    try {
      const body = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const post = (headers: Record<string, string>) =>
        fetch(s.url(`/message?sessionId=${sessionId}`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body,
        });

      const anonymous = await post({});
      expect(anonymous.status).toBe(401);

      const other = await post(bearer('token-b'));
      expect(other.status).toBe(403);
      expect(((await other.json()) as { error: string }).error).toBe('session_forbidden');

      const owner = await post(bearer('token-a'));
      expect(owner.status).toBe(202);
    } finally {
      abort();
    }
  });
});

describe('session lifecycle limits', () => {
  it('refuses new sessions past maxSessions with 503', async () => {
    const s = await startTestServer({}, { maxSessions: 1 });
    await openStreamableSession(s, 'token-a');
    const res = await initStreamable(s, 'token-a');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(await res.json()).toEqual({ error: 'too_many_sessions' });
  });

  it('expires idle StreamableHTTP sessions', async () => {
    const s = await startTestServer({}, { sessionIdleTtlMs: 100, sweepIntervalMs: 25 });
    const sid = await openStreamableSession(s, 'token-a');
    await new Promise((r) => setTimeout(r, 300));
    const res = await sendInitialized(s, sid, 'token-a');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('unknown_session');
  });

  it('keeps a session alive while it holds a GET stream open, then expires it once closed', async () => {
    const s = await startTestServer({}, { sessionIdleTtlMs: 100, sweepIntervalMs: 25 });
    const sid = await openStreamableSession(s, 'token-a');
    expect((await sendInitialized(s, sid, 'token-a')).status).toBe(202);

    // A client that only listens: one standalone GET SSE stream, no POSTs.
    const controller = new AbortController();
    const stream = await fetch(s.url('/mcp'), {
      headers: {
        Accept: 'text/event-stream',
        ...bearer('token-a'),
        'MCP-Session-Id': sid,
        'MCP-Protocol-Version': '2025-03-26',
      },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);

    // Well past the idle TTL: the session must survive because the stream is open.
    await new Promise((r) => setTimeout(r, 300));
    const ping = (): Promise<Response> =>
      fetch(s.url('/mcp'), {
        method: 'POST',
        headers: {
          ...STREAMABLE_HEADERS,
          ...bearer('token-a'),
          'MCP-Session-Id': sid,
          'MCP-Protocol-Version': '2025-03-26',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
      });
    const alive = await ping();
    expect(alive.status).toBe(200);
    await alive.text();

    // Once the stream closes, the idle clock runs again.
    controller.abort();
    await stream.body?.cancel().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    const gone = await ping();
    expect(gone.status).toBe(404);
  });

  it('takes the idle TTL and session cap from config when no options are passed', async () => {
    const s = await startTestServer({ sessionIdleTtlMs: 100, sessionSweepIntervalMs: 25 });
    const sid = await openStreamableSession(s, 'token-a');
    await new Promise((r) => setTimeout(r, 300));
    expect((await sendInitialized(s, sid, 'token-a')).status).toBe(404);

    const capped = await startTestServer({ maxSessions: 1 });
    await openStreamableSession(capped, 'token-a');
    expect((await initStreamable(capped, 'token-a')).status).toBe(503);
  });
});

describe('rate limiting', () => {
  it('returns 429 with Retry-After once the per-IP bucket is empty', async () => {
    // rps is tiny so the bucket cannot refill mid-test.
    const limited = await startTestServer({
      gatewayAuth: 'none',
      gatewayTokens: [],
      rateLimitRps: 0.01,
      rateLimitBurst: 1,
    });
    const first = await fetch(limited.url('/mcp'));
    expect(first.status).toBe(400); // missing_session_id — allowed through the limiter
    const second = await fetch(limited.url('/mcp'));
    expect(second.status).toBe(429);
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await second.json()).toEqual({ error: 'rate_limited', reason: 'ip' });
  });

  it('never rate-limits /health', async () => {
    const s = await startTestServer({
      gatewayAuth: 'none',
      gatewayTokens: [],
      rateLimitRps: 0.01,
      rateLimitBurst: 1,
    });
    for (let i = 0; i < 3; i++) {
      expect((await fetch(s.url('/health'))).status).toBe(200);
    }
  });
});

describe('Host / Origin guard', () => {
  it('rejects a DNS-rebinding Host header with 403 but keeps /health open', async () => {
    const s = await startTestServer({ gatewayAuth: 'none', gatewayTokens: [] });
    const rebound = await rawRequest(s.port, '/mcp', { Host: `evil.example:${s.port}` });
    expect(rebound.status).toBe(403);
    expect(JSON.parse(rebound.body)).toEqual({ error: 'host_not_allowed' });

    const health = await rawRequest(s.port, '/health', { Host: `evil.example:${s.port}` });
    expect(health.status).toBe(200);
  });

  it('accepts a configured allowedHosts name', async () => {
    const s = await startTestServer({
      gatewayAuth: 'none',
      gatewayTokens: [],
      allowedHosts: ['mcp.example.com'],
    });
    const res = await rawRequest(s.port, '/mcp', { Host: 'mcp.example.com' });
    expect(res.status).toBe(400); // past the guard: missing_session_id
  });

  it('rejects a cross-site browser Origin that is not on the CORS allowlist', async () => {
    const s = await startTestServer({ gatewayAuth: 'none', gatewayTokens: [] });
    const res = await fetch(s.url('/mcp'), { headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'origin_not_allowed' });
  });

  it('allows an Origin on the CORS allowlist', async () => {
    const s = await startTestServer({
      gatewayAuth: 'none',
      gatewayTokens: [],
      corsOrigins: ['https://app.example.com'],
    });
    const res = await fetch(s.url('/mcp'), { headers: { Origin: 'https://app.example.com' } });
    expect(res.status).toBe(400);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
  });
});
