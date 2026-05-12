import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { startHttp } from '../../src/http/server.js';
import { createLogger } from '../../src/utils/logger.js';
import type { Config } from '../../src/config.js';

/**
 * Real-server tests for the /metrics route. We instantiate `startHttp` in
 * the test process on port 0 so we never collide with a real listener, then
 * make actual HTTP requests via `fetch` to prove the wiring respects auth
 * and the metrics-enabled flag end-to-end. These complement the unit-level
 * `MetricsAuth` / `Registry` tests (which exercise the logic in isolation).
 */

const quietLogger = createLogger({ level: 'silent', stream: 'stderr' });

interface Started {
  server: HttpServer;
  port: number;
  url: (path: string) => string;
}

function makeConfig(overrides: Partial<Config>): Config {
  return {
    triliumUrl: 'http://localhost:65535/etapi', // unused; /metrics doesn't touch Trilium
    triliumToken: 'dummy',
    transport: 'http',
    httpPort: 0, // ephemeral
    multiTenant: false,
    gatewayAuth: 'none',
    gatewayTokens: [],
    urlAllowlist: [],
    allowPrivateUrls: false,
    maxPostBytes: 1024 * 1024,
    metricsEnabled: false,
    metricsAuth: 'gateway',
    metricsTokens: [],
    ...overrides,
  };
}

async function startTestServer(overrides: Partial<Config>): Promise<Started> {
  const server = await startHttp(makeConfig(overrides), quietLogger);
  const addr = server.address() as AddressInfo;
  const port = addr.port;
  return {
    server,
    port,
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
  };
}

const started: Started[] = [];

afterEach(async () => {
  while (started.length > 0) {
    const s = started.pop()!;
    await new Promise<void>((resolve, reject) => {
      s.server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

async function track(p: Promise<Started>): Promise<Started> {
  const s = await p;
  started.push(s);
  return s;
}

describe('/metrics — HTTP server integration', () => {
  it('returns 404 metrics_disabled when --metrics flag is OFF (default)', async () => {
    const s = await track(startTestServer({ metricsEnabled: false }));
    const res = await fetch(s.url('/metrics'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'metrics_disabled' });
  });

  it('with auth=gateway (default), requires a bearer token', async () => {
    const s = await track(
      startTestServer({
        metricsEnabled: true,
        metricsAuth: 'gateway',
        gatewayAuth: 'bearer',
        gatewayTokens: ['gw-secret'],
      })
    );

    const noAuth = await fetch(s.url('/metrics'));
    expect(noAuth.status).toBe(401);

    const wrong = await fetch(s.url('/metrics'), {
      headers: { Authorization: 'Bearer not-the-token' },
    });
    expect(wrong.status).toBe(401);

    const right = await fetch(s.url('/metrics'), {
      headers: { Authorization: 'Bearer gw-secret' },
    });
    expect(right.status).toBe(200);
    expect(right.headers.get('content-type')).toMatch(/text\/plain.*version=0\.0\.4/);
    const body = await right.text();
    expect(body).toContain('# HELP triliumnext_mcp_build_info');
    expect(body).toContain('triliumnext_mcp_build_info{version="1.0.0"} 1');
  });

  it('with auth=bearer, accepts only metrics tokens (NOT gateway tokens)', async () => {
    const s = await track(
      startTestServer({
        metricsEnabled: true,
        metricsAuth: 'bearer',
        metricsTokens: ['scrape-secret'],
        gatewayAuth: 'bearer',
        gatewayTokens: ['gw-secret'],
      })
    );

    const withGateway = await fetch(s.url('/metrics'), {
      headers: { Authorization: 'Bearer gw-secret' },
    });
    expect(withGateway.status).toBe(401);

    const withScrape = await fetch(s.url('/metrics'), {
      headers: { Authorization: 'Bearer scrape-secret' },
    });
    expect(withScrape.status).toBe(200);
  });

  it('with auth=none, is open (use only when firewalled — verified for completeness)', async () => {
    const s = await track(
      startTestServer({ metricsEnabled: true, metricsAuth: 'none' })
    );
    const res = await fetch(s.url('/metrics'));
    expect(res.status).toBe(200);
  });

  it('the metrics endpoint records its own access in http_requests_total', async () => {
    const s = await track(
      startTestServer({ metricsEnabled: true, metricsAuth: 'none' })
    );
    // The access counter is bumped on res `finish`/`close`, which happens
    // AFTER the body is rendered. So a request's own bump never appears in
    // its own response — only in subsequent responses. Make 3 requests; the
    // third should see counts from the first two.
    await fetch(s.url('/metrics'));
    await fetch(s.url('/metrics'));
    const third = await fetch(s.url('/metrics'));
    const body = await third.text();
    expect(body).toMatch(
      /triliumnext_mcp_http_requests_total\{method="GET",path="\/metrics",status="200"\} 2/
    );
  });

  it('does not register /metrics when metrics=off — request goes through the normal 404 path', async () => {
    const s = await track(startTestServer({ metricsEnabled: false }));
    // With metricsEnabled=false, the route handler short-circuits to a JSON 404
    // (metrics_disabled). Any other unknown path returns the generic 404 not_found.
    // Confirm /metrics specifically returns metrics_disabled (not not_found):
    const m = await fetch(s.url('/metrics'));
    expect(m.status).toBe(404);
    expect(await m.json()).toEqual({ error: 'metrics_disabled' });
    // Sanity: an unrelated unknown path still 404s with not_found.
    const other = await fetch(s.url('/totally-not-a-route'));
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: 'not_found' });
  });

  it('/health remains open regardless of metrics auth settings', async () => {
    const s = await track(
      startTestServer({
        metricsEnabled: true,
        metricsAuth: 'gateway',
        gatewayAuth: 'bearer',
        gatewayTokens: ['gw-secret'],
      })
    );
    const res = await fetch(s.url('/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
