import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { startHttp } from '../../src/http/server.js';
import { createLogger } from '../../src/utils/logger.js';
import type { Config } from '../../src/config.js';

/**
 * Integration tests for the StreamableHTTP transport. We don't need a real
 * Trilium for these — we only exercise gateway-auth gating and the routing
 * around /mcp. Initialize handshake is the most invasive cross-piece test we
 * can run without a live ETAPI, since the connect-time getAppInfo() probe
 * would otherwise reach out.
 */

const quietLogger = createLogger({ level: 'silent', stream: 'stderr' });

interface Started {
  server: HttpServer;
  port: number;
  url: (path: string) => string;
}

function makeConfig(overrides: Partial<Config>): Config {
  return {
    triliumUrl: 'http://localhost:65535/etapi',
    triliumToken: 'dummy',
    transport: 'http',
    httpPort: 0,
    multiTenant: false,
    gatewayAuth: 'none',
    gatewayTokens: [],
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
  };
}

async function startTestServer(overrides: Partial<Config>): Promise<Started> {
  const server = await startHttp(makeConfig(overrides), quietLogger);
  const addr = server.address() as AddressInfo;
  return {
    server,
    port: addr.port,
    url: (path: string) => `http://127.0.0.1:${addr.port}${path}`,
  };
}

const started: Started[] = [];
afterEach(async () => {
  while (started.length > 0) {
    const s = started.pop()!;
    await new Promise<void>((resolve, reject) =>
      s.server.close((err) => (err ? reject(err) : resolve()))
    );
  }
});

async function track(p: Promise<Started>): Promise<Started> {
  const s = await p;
  started.push(s);
  return s;
}

describe('/mcp — StreamableHTTP transport', () => {
  it('GET without MCP-Session-Id returns 400 missing_session_id', async () => {
    const s = await track(startTestServer({}));
    const res = await fetch(s.url('/mcp'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing_session_id' });
  });

  it('DELETE without MCP-Session-Id returns 400 missing_session_id', async () => {
    const s = await track(startTestServer({}));
    const res = await fetch(s.url('/mcp'), { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('POST with a non-initialize body and no session id is rejected', async () => {
    const s = await track(startTestServer({}));
    const res = await fetch(s.url('/mcp'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing_session_id' });
  });

  it('uses an unknown MCP-Session-Id branch (404 unknown_session)', async () => {
    const s = await track(startTestServer({}));
    const res = await fetch(s.url('/mcp'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'MCP-Session-Id': 'nope-not-a-real-session',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown_session' });
  });

  it('rejects requests when gateway-auth=bearer and no token is provided', async () => {
    const s = await track(
      startTestServer({
        gatewayAuth: 'bearer',
        gatewayTokens: ['gw-secret'],
      })
    );
    const res = await fetch(s.url('/mcp'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0' },
        },
      }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects multi-tenant initialize without X-Trilium-* headers', async () => {
    const s = await track(
      startTestServer({
        multiTenant: true,
        triliumUrl: null,
        triliumToken: null,
        gatewayAuth: 'bearer',
        gatewayTokens: ['gw'],
        // Allow private so the SSRF guard doesn't reject 127.0.0.1 later in
        // unrelated tests — irrelevant here since we never reach SSRF.
        allowPrivateUrls: true,
      })
    );
    const res = await fetch(s.url('/mcp'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer gw',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0' },
        },
      }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'missing_trilium_credentials' });
  });
});
