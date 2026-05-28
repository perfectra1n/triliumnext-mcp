import { describe, it, expect, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { SignJWT } from 'jose';
import { startHttp } from '../../src/http/server.js';
import { createLogger } from '../../src/utils/logger.js';
import type { Config } from '../../src/config.js';

const quietLogger = createLogger({ level: 'silent', stream: 'stderr' });
const enc = new TextEncoder();
const SECRET_STR = 'a'.repeat(32);
const SECRET = enc.encode(SECRET_STR);

interface Started {
  server: HttpServer;
  port: number;
  url: (path: string) => string;
}

function makeConfig(overrides: Partial<Config>): Config {
  return {
    triliumUrl: 'http://localhost:65535/etapi',
    triliumToken: 'dummy',
    publicUrl: null,
    transport: 'http',
    httpPort: 0,
    multiTenant: false,
    gatewayAuth: 'jwt',
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
    jwtSecrets: [SECRET_STR],
    jwtJwksUrl: null,
    jwtIssuer: null,
    jwtAudience: null,
    jwtPrincipalClaim: 'sub',
    ...overrides,
  };
}

async function startTestServer(overrides: Partial<Config> = {}): Promise<Started> {
  const server = await startHttp(makeConfig(overrides), quietLogger);
  const addr = server.address() as AddressInfo;
  return {
    server,
    port: addr.port,
    url: (path: string) => `http://127.0.0.1:${addr.port}${path}`,
  };
}

async function makeToken(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(SECRET);
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

describe('gateway-auth=jwt — end-to-end', () => {
  it('rejects /sse without a token', async () => {
    const s = await track(startTestServer());
    const res = await fetch(s.url('/sse'));
    expect(res.status).toBe(401);
  });

  it('rejects /sse with an invalid token', async () => {
    const s = await track(startTestServer());
    const res = await fetch(s.url('/sse'), {
      headers: { Authorization: 'Bearer not.a.jwt' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects /sse with a token signed by the wrong secret', async () => {
    const s = await track(startTestServer());
    const evilToken = await new SignJWT({ sub: 'alice' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(enc.encode('b'.repeat(32)));
    const res = await fetch(s.url('/sse'), {
      headers: { Authorization: `Bearer ${evilToken}` },
    });
    expect(res.status).toBe(401);
  });

  it('rejects /mcp init without a token', async () => {
    const s = await track(startTestServer());
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
  });

  it('startup fails when --gateway-auth=jwt has no secret or jwks URL', async () => {
    // Validate via loadConfig instead of startHttp — startHttp expects a vetted Config.
    const { loadConfig } = await import('../../src/config.js');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => loadConfig(['--transport', 'http', '--token', 't', '--gateway-auth', 'jwt'])).toThrow();
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
