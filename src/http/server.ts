import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from 'node:http';

import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';

import { normalizeServerUrl, type Config } from '../config.js';
import { TriliumClient, TriliumClientError } from '../client/trilium.js';
import { buildMcpServer } from '../server.js';
import { GatewayAuth } from './auth.js';
import { assertUrlIsSafe, UrlGuardError } from './urlGuard.js';
import { createMetrics, normalizeRoute, type Metrics } from './metrics.js';
import { MetricsAuth } from './metricsAuth.js';
import type { Logger } from '../utils/logger.js';

/** Upper bound on a single MCP JSON-RPC message POST body. The SDK enforces
 *  its own 4MB limit inside `handlePostMessage` when it reads the body itself,
 *  so to honor anything larger we must read+parse the body here and pass it
 *  to the SDK as `parsedBody` (which short-circuits its size-limited read). */

/** Keep-alive ping cadence for SSE streams; prevents idle proxies from
 *  closing the connection while the client is just waiting for server events. */
const SSE_KEEPALIVE_INTERVAL_MS = 30_000;

/** Hard ceiling on the validation probe during /sse connect. Without this,
 *  a client pointing X-Trilium-Url at a black-hole host could park a
 *  connection indefinitely. */
const TRILIUM_VALIDATE_TIMEOUT_MS = 10_000;

interface Session {
  transport: SSEServerTransport;
  mcpServer: McpServer;
  keepAlive: NodeJS.Timeout;
}

export async function startHttp(config: Config, logger: Logger): Promise<HttpServer> {
  const sessions = new Map<string, Session>();
  const gatewayAuth =
    config.gatewayAuth === 'bearer' ? new GatewayAuth(config.gatewayTokens) : null;

  const metrics: Metrics | null = config.metricsEnabled ? createMetrics('1.0.0') : null;
  const metricsAuth: MetricsAuth | null = metrics
    ? new MetricsAuth(config.metricsAuth, { gateway: gatewayAuth, bearerTokens: config.metricsTokens })
    : null;

  if (config.allowPrivateUrls && config.multiTenant) {
    // Loud but not fatal: private-IP block is the primary SSRF defense, and
    // some homelab operators legitimately need to disable it.
    logger.warn('allow_private_urls_enabled', {});
  }

  const httpServer = createHttpServer((req, res) => {
    const t0 = performance.now();
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const path = rawUrl.split('?')[0];
    const remote = req.socket.remoteAddress;

    let logged = false;
    const recordAccess = (): void => {
      if (logged) return;
      logged = true;
      const durationSec = (performance.now() - t0) / 1000;
      logger.info('http_request', {
        method,
        path,
        status: res.statusCode,
        duration_ms: Math.round(durationSec * 1000),
        remote,
      });
      if (metrics) {
        const route = normalizeRoute(method, path);
        metrics.httpRequestsTotal.inc({ method, path: route, status: String(res.statusCode) });
        metrics.httpRequestDuration.observe({ method, path: route }, durationSec);
      }
    };
    res.on('finish', recordAccess);
    res.on('close', recordAccess);

    handleRequest(req, res, config, sessions, gatewayAuth, logger, metrics, metricsAuth).catch((err) => {
      logger.error('request_handler_error', {
        method,
        path,
        err: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        respondJson(res, 500, { error: 'internal_error' });
      } else {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(config.httpPort, () => {
      const mode = config.multiTenant ? 'multi-tenant' : 'single-tenant';
      const auth = config.gatewayAuth === 'bearer' ? `bearer (${config.gatewayTokens.length} token(s))` : 'none';
      const address = httpServer.address();
      const actualPort = typeof address === 'object' && address ? address.port : config.httpPort;
      logger.info('server_started', {
        transport: 'http',
        port: actualPort,
        mode,
        gateway_auth: auth,
        metrics: metrics ? config.metricsAuth : 'off',
      });
      resolve();
    });
  });
  return httpServer;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  sessions: Map<string, Session>,
  gatewayAuth: GatewayAuth | null,
  logger: Logger,
  metrics: Metrics | null,
  metricsAuth: MetricsAuth | null
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';

  if (method === 'GET' && url === '/health') {
    respondJson(res, 200, { status: 'ok' });
    return;
  }

  if (method === 'GET' && (url === '/metrics' || url.startsWith('/metrics?'))) {
    handleMetrics(req, res, metrics, metricsAuth);
    return;
  }

  if (method === 'GET' && url === '/sse') {
    await handleSseConnect(req, res, config, sessions, gatewayAuth, logger, metrics);
    return;
  }

  if (method === 'POST' && url.startsWith('/message')) {
    await handleSsePost(req, res, sessions, config.maxPostBytes, logger);
    return;
  }

  respondJson(res, 404, { error: 'not_found' });
}

function handleMetrics(
  req: IncomingMessage,
  res: ServerResponse,
  metrics: Metrics | null,
  metricsAuth: MetricsAuth | null
): void {
  if (!metrics || !metricsAuth) {
    respondJson(res, 404, { error: 'metrics_disabled' });
    return;
  }
  if (!metricsAuth.isAuthorized(req)) {
    respondJson(res, 401, { error: 'unauthorized' });
    return;
  }
  metrics.collectProcess();
  const body = metrics.registry.render();
  res.writeHead(200, {
    'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function handleSseConnect(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  sessions: Map<string, Session>,
  gatewayAuth: GatewayAuth | null,
  logger: Logger,
  metrics: Metrics | null
): Promise<void> {
  const recordFailure = (reason: string): void => {
    metrics?.sseConnectFailuresTotal.inc({ reason });
  };

  // 1. Gateway auth gate
  if (gatewayAuth && !gatewayAuth.isAuthorized(req)) {
    logger.warn('unauthorized', { remote: req.socket.remoteAddress });
    recordFailure('unauthorized');
    respondJson(res, 401, { error: 'unauthorized' });
    return;
  }

  // 2. Resolve backend creds. In multi-tenant mode, require BOTH X-Trilium-Url
  // and X-Trilium-Token from the client as an atomic pair — no fallback to
  // server-side defaults (which config.ts rejects anyway). In single-tenant
  // mode, ignore any incoming headers and always use the startup creds.
  let clientUrlRaw: string;
  let clientToken: string;

  if (config.multiTenant) {
    const headerUrl = firstHeader(req.headers['x-trilium-url']);
    const headerToken = firstHeader(req.headers['x-trilium-token']);
    if (!headerUrl || !headerToken) {
      logger.warn('missing_trilium_credentials', { remote: req.socket.remoteAddress });
      recordFailure('missing_trilium_credentials');
      respondJson(res, 401, { error: 'missing_trilium_credentials' });
      return;
    }
    clientUrlRaw = headerUrl;
    clientToken = headerToken;

    // 3. SSRF guard — only applies to client-supplied URLs.
    try {
      await assertUrlIsSafe(clientUrlRaw, {
        allowlist: config.urlAllowlist,
        allowPrivate: config.allowPrivateUrls,
      });
    } catch (err) {
      if (err instanceof UrlGuardError) {
        logger.warn('url_rejected', { reason: err.reason });
        recordFailure('url_rejected');
        respondJson(res, 400, { error: 'url_rejected', reason: err.reason });
        return;
      }
      throw err;
    }
  } else {
    // Single-tenant: config guarantees these are non-null at this point.
    if (!config.triliumUrl || !config.triliumToken) {
      logger.error('server_misconfigured', {});
      recordFailure('server_misconfigured');
      respondJson(res, 500, { error: 'server_misconfigured' });
      return;
    }
    clientUrlRaw = config.triliumUrl;
    clientToken = config.triliumToken;
  }

  // 4. Build the client and validate creds BEFORE we let the SSE transport
  // write response headers (once start() runs, we can't return a clean JSON error).
  const triliumUrl = normalizeServerUrl(clientUrlRaw);
  const triliumHost = safeHostname(triliumUrl);
  const client = new TriliumClient(triliumUrl, clientToken);
  try {
    await withTimeout(client.getAppInfo(), TRILIUM_VALIDATE_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof TriliumClientError) {
      const status = err.status === 401 || err.status === 403 ? 401 : 502;
      logger.warn('trilium_auth_failed', { host: triliumHost, status: err.status, code: err.code });
      recordFailure('trilium_auth_failed');
      respondJson(res, status, {
        error: 'trilium_auth_failed',
        status: err.status,
        code: err.code,
      });
      return;
    }
    if (err instanceof Error && err.message === 'timeout') {
      logger.warn('trilium_validate_timeout', { host: triliumHost });
      recordFailure('trilium_validate_timeout');
      respondJson(res, 504, { error: 'trilium_validate_timeout' });
      return;
    }
    logger.warn('trilium_unreachable', {
      host: triliumHost,
      err: err instanceof Error ? err.message : String(err),
    });
    recordFailure('trilium_unreachable');
    respondJson(res, 502, { error: 'trilium_unreachable' });
    return;
  }

  // 5. Create the per-connection MCP Server + SSE transport.
  const transport = new SSEServerTransport('/message', res);
  const sessionId = transport.sessionId;
  const mcpServer = buildMcpServer(client, { logger, sessionId, metrics: metrics ?? undefined });

  // 6. Register the session BEFORE awaiting connect(). server.connect() calls
  // transport.start() which writes the endpoint event; a very fast client
  // could otherwise POST before we've inserted into the map.
  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      // Stream may have closed between check and write; onclose will clean up.
    }
  }, SSE_KEEPALIVE_INTERVAL_MS);
  // Never let the keep-alive timer hold the process open.
  keepAlive.unref?.();

  const session: Session = { transport, mcpServer, keepAlive };
  sessions.set(sessionId, session);

  // The transport's onclose fires either (a) when the SSE response closes —
  // the transport is already torn down, so mcpServer.close() MUST NOT recurse
  // back into transport.close() — or (b) when we explicitly initiate close
  // from the Server side. Either way, at this point the wire is dead and we
  // just need to drop our bookkeeping. The Server itself has no resources
  // outside the (already-closed) transport, so GC handles the rest.
  transport.onclose = () => {
    sessions.delete(sessionId);
    clearInterval(keepAlive);
    logger.info('sse_closed', { session: sessionId });
    if (metrics) {
      metrics.sseSessions.dec();
      metrics.sseClosesTotal.inc();
    }
  };

  try {
    await mcpServer.connect(transport);
    logger.info('sse_connected', { session: sessionId, host: triliumHost });
    if (metrics) {
      metrics.sseSessions.inc();
      metrics.sseConnectsTotal.inc();
    }
  } catch (err) {
    // Roll back the session entry if connect failed. onclose will also fire
    // eventually, but we want to avoid a stale entry in the meantime.
    sessions.delete(sessionId);
    clearInterval(keepAlive);
    logger.error('sse_connect_failed', {
      session: sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    recordFailure('sse_connect_failed');
    if (!res.headersSent) {
      respondJson(res, 500, { error: 'sse_connect_failed' });
    } else {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  }
}

async function handleSsePost(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, Session>,
  maxPostBytes: number,
  logger: Logger
): Promise<void> {
  // Fail fast on a Content-Length that already exceeds the cap, so we don't
  // pay to drain a giant request body just to reject it.
  const contentLengthRaw = req.headers['content-length'];
  if (contentLengthRaw) {
    const contentLength = parseInt(Array.isArray(contentLengthRaw) ? contentLengthRaw[0] : contentLengthRaw, 10);
    if (!Number.isNaN(contentLength) && contentLength > maxPostBytes) {
      respondJson(res, 413, { error: 'payload_too_large' });
      return;
    }
  }

  const parsed = parsePath(req.url);
  const sessionId = parsed.query.get('sessionId');
  if (!sessionId) {
    respondJson(res, 400, { error: 'missing_session_id' });
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    // 404 (not 503) — unknown session looks like a nonexistent resource.
    respondJson(res, 404, { error: 'unknown_session' });
    return;
  }

  // Read the body ourselves so we can (a) honor `maxPostBytes` regardless of
  // header presence (chunked requests omit Content-Length) and (b) bypass the
  // SDK's hardcoded 4MB internal limit by passing `parsedBody`.
  let parsedBody: unknown;
  let bytes: number;
  try {
    const result = await readJsonBody(req, maxPostBytes);
    parsedBody = result.parsed;
    bytes = result.bytes;
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      respondJson(res, 413, { error: 'payload_too_large' });
      return;
    }
    if (err instanceof BadJsonError) {
      respondJson(res, 400, { error: 'invalid_json' });
      return;
    }
    throw err;
  }

  logger.debug('sse_post', { session: sessionId, bytes });

  await session.transport.handlePostMessage(req, res, parsedBody);
}

class PayloadTooLargeError extends Error {}
class BadJsonError extends Error {}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<{ parsed: unknown; bytes: number }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      // Stop reading; the request will be aborted by the 413 response.
      throw new PayloadTooLargeError();
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (raw.length === 0) return { parsed: undefined, bytes: total };
  try {
    return { parsed: JSON.parse(raw), bytes: total };
  } catch {
    throw new BadJsonError();
  }
}

function parsePath(urlPath: string | undefined): { pathname: string; query: URLSearchParams } {
  const parsed = new URL(urlPath ?? '/', 'http://dummy');
  return { pathname: parsed.pathname, query: parsed.searchParams };
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (!value) return null;
  const v = Array.isArray(value) ? value[0] : value;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '<invalid>';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
