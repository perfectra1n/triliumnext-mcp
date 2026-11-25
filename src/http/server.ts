import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
  type Server as HttpServer,
} from 'node:http';

import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { randomUUID } from 'node:crypto';

import {
  normalizeServerUrl,
  deriveWebBaseUrl,
  DEFAULT_HTTP_HOST,
  TUNABLE_DEFAULTS,
  type Config,
} from '../config.js';
import {
  TriliumClient,
  TriliumClientError,
  clientOptionsFromConfig,
  type FetchLike,
} from '../client/trilium.js';
import { buildMcpServer } from '../server.js';
import { GatewayAuth } from './auth.js';
import { JwtAuth } from './jwtAuth.js';
import { GatewayPolicy } from './gatewayPolicy.js';
import {
  assertUrlIsSafe,
  createGuardedFetch,
  findUrlGuardError,
  UrlGuardError,
  type BaseLookup,
  type GuardedFetch,
} from './urlGuard.js';
import { createMetrics, normalizeRoute, type Metrics } from './metrics.js';
import { MetricsAuth } from './metricsAuth.js';
import { CorsPolicy } from './cors.js';
import { RateLimiter, type RateLimitDecision } from './rateLimit.js';
import { checkRequestOrigin } from './originGuard.js';
import type { Logger } from '../utils/logger.js';

/** Upper bound on a single MCP JSON-RPC message POST body. The SDK enforces
 *  its own 4MB limit inside `handlePostMessage` when it reads the body itself,
 *  so to honor anything larger we must read+parse the body here and pass it
 *  to the SDK as `parsedBody` (which short-circuits its size-limited read). */

// Defaults come from config.ts's TUNABLE_DEFAULTS (single source of truth);
// re-exported under these names for embedders and tests.

/** Default keep-alive ping cadence for SSE streams (TRILIUM_SSE_KEEPALIVE);
 *  prevents idle proxies from closing the connection while the client is just
 *  waiting for server events. */
export const DEFAULT_SSE_KEEPALIVE_INTERVAL_MS = TUNABLE_DEFAULTS.sseKeepaliveMs;

/** Default ceiling on the validation probe during connect
 *  (TRILIUM_VALIDATE_TIMEOUT). Without this, a client pointing X-Trilium-Url at
 *  a black-hole host could park a connection indefinitely. */
export const DEFAULT_TRILIUM_VALIDATE_TIMEOUT_MS = TUNABLE_DEFAULTS.triliumValidateTimeoutMs;

/** Default idle TTL for StreamableHTTP sessions (no requests for this long → closed). */
export const DEFAULT_SESSION_IDLE_TTL_MS = TUNABLE_DEFAULTS.sessionIdleTtlMs;
/** Default cap on concurrently open sessions (SSE + StreamableHTTP). */
export const DEFAULT_MAX_SESSIONS = TUNABLE_DEFAULTS.maxSessions;

/** `realm` advertised in `WWW-Authenticate` on gateway 401s. */
const AUTH_REALM = 'triliumnext-mcp';

interface Session {
  transport: SSEServerTransport;
  mcpServer: McpServer;
  keepAlive: NodeJS.Timeout;
  /** Identity (principal / token fingerprint) that opened the session. */
  identity: string;
  lastActivity: number;
}

interface StreamableSession {
  transport: StreamableHTTPServerTransport;
  mcpServer: McpServer;
  identity: string;
  lastActivity: number;
  /**
   * Open GET (standalone SSE) streams on this session. A client may hold one
   * open and send nothing else for longer than the idle TTL; while it is open
   * the session is live, so the idle sweep skips it.
   */
  openStreams: number;
}

/**
 * Tunables for tests / embedding. All optional; each overrides the matching
 * Config field (TRILIUM_SESSION_IDLE_TTL, TRILIUM_MAX_SESSIONS,
 * TRILIUM_SESSION_SWEEP_INTERVAL), which in turn falls back to the default.
 */
export interface HttpServerOptions {
  /** Idle TTL for StreamableHTTP sessions. Default 30 min. `0` disables. */
  sessionIdleTtlMs?: number;
  /** Max concurrently open sessions across both transports. Default 1000. */
  maxSessions?: number;
  /** How often the idle sweep runs. Default min(60s, ttl/2). */
  sweepIntervalMs?: number;
  /**
   * Resolver used by the connect-time SSRF guard on multi-tenant Trilium
   * connections (tests inject one to simulate DNS rebinding). Default: dns.lookup.
   */
  tenantLookup?: BaseLookup;
}

interface Ctx {
  config: Config;
  logger: Logger;
  sessions: Map<string, Session>;
  streamableSessions: Map<string, StreamableSession>;
  gatewayPolicy: GatewayPolicy;
  rateLimiter: RateLimiter;
  metrics: Metrics | null;
  metricsAuth: MetricsAuth | null;
  maxSessions: number;
  /**
   * Sessions admitted past the cap check but not yet registered in a session
   * map (still validating creds / connecting). Counted against `maxSessions`
   * so concurrent connects cannot overshoot the cap.
   */
  pendingSessions: number;
  sseKeepaliveMs: number;
  validateTimeoutMs: number;
  /**
   * Multi-tenant only: one shared fetch whose connections are re-checked
   * against the URL guard at connect time (DNS-rebinding safe). Null in
   * single-tenant mode, where the operator chose the Trilium URL.
   */
  tenantFetch: GuardedFetch | null;
}

/** Log-safe session id: first 8 chars only (the full id is a bearer capability for SSE). */
export function shortSessionId(id: string): string {
  return id.slice(0, 8);
}

/** Servers started by `startHttp` that are still open, for graceful shutdown. */
const liveServers = new Set<() => Promise<void>>();

/**
 * Close every HTTP server started by `startHttp` in this process: stop
 * accepting connections, close all MCP sessions/transports, and drop open
 * sockets (SSE streams would otherwise hold `server.close()` open forever).
 */
export async function shutdownHttpServers(): Promise<void> {
  const closers = [...liveServers];
  liveServers.clear();
  await Promise.allSettled(closers.map((c) => c()));
}

export async function startHttp(
  config: Config,
  logger: Logger,
  options: HttpServerOptions = {}
): Promise<HttpServer> {
  const sessions = new Map<string, Session>();
  const streamableSessions = new Map<string, StreamableSession>();
  const sessionIdleTtlMs =
    options.sessionIdleTtlMs ?? config.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS;
  const maxSessions = options.maxSessions ?? config.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const bindHost = config.httpHost ?? DEFAULT_HTTP_HOST;
  const gatewayAuth =
    config.gatewayAuth === 'bearer' ? new GatewayAuth(config.gatewayTokens) : null;
  const jwtAuth =
    config.gatewayAuth === 'jwt'
      ? new JwtAuth({
          secrets: config.jwtSecrets,
          jwksUrl: config.jwtJwksUrl ?? undefined,
          issuer: config.jwtIssuer ?? undefined,
          audience: config.jwtAudience ?? undefined,
          principalClaim: config.jwtPrincipalClaim,
          clockToleranceSec: config.jwtClockToleranceSec,
        })
      : null;
  const gatewayPolicy = new GatewayPolicy(config.gatewayAuth, gatewayAuth, jwtAuth);

  const metrics: Metrics | null = config.metricsEnabled
    ? createMetrics('1.0.0', { includePrincipal: config.metricsIncludePrincipal })
    : null;
  const metricsAuth: MetricsAuth | null = metrics
    ? new MetricsAuth(config.metricsAuth, {
        gateway: gatewayAuth,
        bearerTokens: config.metricsTokens,
      })
    : null;
  const cors = new CorsPolicy(config.corsOrigins);
  const rateLimiter = new RateLimiter({
    rps: config.rateLimitRps,
    burst: config.rateLimitBurst,
    trustedProxies: config.trustedProxies ?? [],
  });
  // Created once and shared: it owns one undici dispatcher (connection pool).
  // The client already sends redirect: 'manual'; the guarded fetch defaults to
  // it as well, and every connection (any hop) passes the address check.
  const tenantFetch = config.multiTenant
    ? createGuardedFetch(
        { allowlist: config.urlAllowlist, allowPrivate: config.allowPrivateUrls },
        { baseLookup: options.tenantLookup }
      )
    : null;

  const ctx: Ctx = {
    config,
    logger,
    sessions,
    streamableSessions,
    gatewayPolicy,
    rateLimiter,
    metrics,
    metricsAuth,
    maxSessions,
    pendingSessions: 0,
    sseKeepaliveMs: config.sseKeepaliveMs ?? DEFAULT_SSE_KEEPALIVE_INTERVAL_MS,
    validateTimeoutMs: config.triliumValidateTimeoutMs ?? DEFAULT_TRILIUM_VALIDATE_TIMEOUT_MS,
    tenantFetch,
  };

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

    // DNS-rebinding / cross-site defenses run before CORS, auth and routing.
    // /health stays exempt so container/LB probes keep working.
    if (path !== '/health') {
      const originCheck = checkRequestOrigin(req, {
        bindHost,
        cors,
        allowedHosts: config.allowedHosts ?? [],
      });
      if (!originCheck.ok) {
        logger.warn('request_rejected', {
          reason: originCheck.reason,
          remote,
          path: logSafe(path),
          host: logSafe(req.headers.host),
          origin: logSafe(req.headers.origin),
        });
        respondJson(res, 403, { error: originCheck.reason });
        return;
      }
    }

    // Apply CORS headers to every response, and short-circuit OPTIONS preflight.
    cors.apply(req, res);
    if (cors.handlePreflight(req, res)) {
      return;
    }

    // Rate limit everything except /health (cheap liveness) and OPTIONS
    // (already short-circuited above for CORS-enabled deployments). Only the
    // per-IP axis runs here; the per-credential axis runs after successful
    // auth (see `authorizeOrReject`) so garbage tokens can't mint buckets.
    if (rateLimiter.enabled && req.method !== 'OPTIONS' && path !== '/health') {
      const decision = rateLimiter.checkIp(req);
      if (!decision.allowed) {
        respondRateLimited(req, res, ctx, path, decision);
        return;
      }
    }

    handleRequest(req, res, ctx).catch((err) => {
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

  // Idle sweep for StreamableHTTP sessions: they outlive any single HTTP
  // connection, so an abandoned one would otherwise live forever. SSE
  // sessions are bound to their open response stream and are torn down when
  // it closes, so they only count toward the session cap.
  let sweepTimer: NodeJS.Timeout | null = null;
  if (sessionIdleTtlMs > 0) {
    const interval =
      options.sweepIntervalMs ??
      config.sessionSweepIntervalMs ??
      Math.min(60_000, Math.max(1000, sessionIdleTtlMs / 2));
    sweepTimer = setInterval(() => {
      const cutoff = Date.now() - sessionIdleTtlMs;
      for (const [sid, s] of streamableSessions) {
        // A session holding a GET stream open is in use even if it sends nothing.
        if (s.openStreams === 0 && s.lastActivity < cutoff) {
          streamableSessions.delete(sid);
          logger.info('mcp_session_expired', {
            session: shortSessionId(sid),
            transport: 'streamable',
          });
          if (metrics) {
            metrics.sseSessions.dec();
            metrics.sseClosesTotal.inc();
          }
          s.transport.close().catch(() => {});
        }
      }
    }, interval);
    sweepTimer.unref();
  }

  const closeAll = async (): Promise<void> => {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
    const transports: Array<Promise<void>> = [];
    for (const s of sessions.values()) {
      clearInterval(s.keepAlive);
      transports.push(s.transport.close().catch(() => {}));
    }
    for (const s of streamableSessions.values()) {
      transports.push(s.transport.close().catch(() => {}));
    }
    await Promise.allSettled(transports);
    sessions.clear();
    streamableSessions.clear();
    await new Promise<void>((resolve) => {
      if (!httpServer.listening) return resolve();
      httpServer.close(() => resolve());
      httpServer.closeAllConnections();
    });
  };
  liveServers.add(closeAll);
  httpServer.on('close', () => {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
    liveServers.delete(closeAll);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.httpPort, bindHost, () => {
      httpServer.off('error', reject);
      const mode = config.multiTenant ? 'multi-tenant' : 'single-tenant';
      const auth =
        config.gatewayAuth === 'bearer'
          ? `bearer (${config.gatewayTokens.length} token(s))`
          : config.gatewayAuth === 'jwt'
            ? `jwt (${config.jwtJwksUrl ? 'jwks' : 'hs256'})`
            : 'none';
      const address = httpServer.address();
      const actualPort = typeof address === 'object' && address ? address.port : config.httpPort;
      logger.info('server_started', {
        transport: 'http',
        host: bindHost,
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

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';
  const pathOnly = url.split('?')[0];

  if (method === 'GET' && url === '/health') {
    respondJson(res, 200, { status: 'ok' });
    return;
  }

  if (method === 'GET' && (url === '/metrics' || url.startsWith('/metrics?'))) {
    handleMetrics(req, res, ctx.metrics, ctx.metricsAuth);
    return;
  }

  if (method === 'GET' && url === '/sse') {
    await handleSseConnect(req, res, ctx);
    return;
  }

  if (method === 'POST' && url.startsWith('/message')) {
    await handleSsePost(req, res, ctx);
    return;
  }

  if (pathOnly === '/mcp') {
    await handleStreamable(req, res, ctx);
    return;
  }

  respondJson(res, 404, { error: 'not_found' });
}

type TransportKind = 'sse' | 'streamable';

interface AuthorizedRequest {
  /** Authenticated principal (JWT only), for audit logs and metrics. */
  principal: string | null;
  /** Stable identity a session is bound to (see `GatewayPolicy.identity`). */
  identity: string;
}

/**
 * Gateway auth + the per-credential rate-limit axis, shared by every MCP
 * endpoint. Writes the 401 / 429 response itself and returns `null` when the
 * request must stop here.
 */
async function authorizeOrReject(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  transport: TransportKind
): Promise<AuthorizedRequest | null> {
  const { gatewayPolicy, logger, metrics, rateLimiter } = ctx;
  const authResult = await gatewayPolicy.authorize(req);
  if (!authResult.authorized) {
    logger.warn('unauthorized', {
      remote: req.socket.remoteAddress,
      transport,
      reason: authResult.reason,
    });
    metrics?.sseConnectFailuresTotal.inc({ reason: 'unauthorized' });
    respondJson(
      res,
      401,
      { error: 'unauthorized' },
      { 'WWW-Authenticate': `Bearer realm="${AUTH_REALM}"` }
    );
    return null;
  }

  // Only a VERIFIED credential gets a bucket. In `none` mode the
  // Authorization header is unauthenticated input, so skip the token axis.
  if (rateLimiter.enabled) {
    const credential = gatewayPolicy.gatewayMode === 'none' ? null : undefined;
    const decision = rateLimiter.checkToken(req, credential);
    if (!decision.allowed) {
      respondRateLimited(req, res, ctx, (req.url ?? '/').split('?')[0], decision);
      return null;
    }
  }

  return {
    principal: authResult.principal,
    identity: gatewayPolicy.identity(req, authResult),
  };
}

/** 429 with `Retry-After` from the limiter decision, plus a warn log. */
function respondRateLimited(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  path: string,
  decision: RateLimitDecision
): void {
  const retryAfter = decision.retryAfter ?? 1;
  const remote = req.socket.remoteAddress;
  const client = ctx.rateLimiter.clientAddress(req);
  ctx.logger.warn('rate_limited', {
    remote,
    // The address the limiter keyed on, when a trusted proxy forwarded it.
    client: client !== remote ? client : undefined,
    path: logSafe(path),
    reason: decision.reason,
    retry_after_s: retryAfter,
  });
  respondJson(
    res,
    429,
    { error: 'rate_limited', reason: decision.reason },
    { 'Retry-After': String(retryAfter) }
  );
}

/**
 * Enforce the cap on concurrently open sessions (both transports), counting
 * admissions still in flight so concurrent connects can't all pass the check
 * before any registers. Returns a release function (idempotent) the caller
 * must invoke once the attempt has registered its session or failed — or
 * null, after writing a 503, when full.
 */
function admitNewSession(
  res: ServerResponse,
  ctx: Ctx,
  transport: TransportKind
): (() => void) | null {
  const open = ctx.sessions.size + ctx.streamableSessions.size;
  if (open + ctx.pendingSessions < ctx.maxSessions) {
    ctx.pendingSessions += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      ctx.pendingSessions -= 1;
    };
  }
  ctx.logger.warn('session_limit_reached', {
    transport,
    open,
    pending: ctx.pendingSessions,
    max: ctx.maxSessions,
  });
  ctx.metrics?.sseConnectFailuresTotal.inc({ reason: 'session_limit' });
  respondJson(res, 503, { error: 'too_many_sessions' }, { 'Retry-After': '30' });
  return null;
}

/**
 * A session id is only usable by the identity that created it, so a leaked or
 * guessed id cannot be driven by a different gateway principal/token. Writes
 * a 403 and returns false on mismatch.
 */
function sessionOwnedBy(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  session: { identity: string },
  sessionId: string,
  identity: string,
  transport: TransportKind
): boolean {
  if (session.identity === identity) return true;
  ctx.logger.warn('session_identity_mismatch', {
    transport,
    session: shortSessionId(sessionId),
    remote: req.socket.remoteAddress,
  });
  respondJson(res, 403, {
    error: 'session_forbidden',
    message: 'This session was opened by a different identity.',
  });
  return false;
}

/**
 * StreamableHTTP transport handler. Single endpoint /mcp supporting GET, POST,
 * and DELETE; the SDK transport multiplexes init / messages / SSE on it.
 *
 * Session lifecycle:
 *  - First POST with an `initialize` message: validate creds, build a fresh
 *    transport + MCP server + TriliumClient, register on `onsessioninitialized`.
 *  - Subsequent requests with MCP-Session-Id: dispatch to the existing
 *    transport.
 *  - DELETE with MCP-Session-Id: tears the session down.
 *
 * Per-tenant isolation, gateway auth, SSRF guard, and rate-limit policy mirror
 * the SSE path so operators get one consistent security surface across
 * transports.
 */
async function handleStreamable(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx
): Promise<void> {
  const { config, streamableSessions, logger } = ctx;
  const method = req.method ?? 'GET';
  const sessionId = firstHeader(req.headers['mcp-session-id']);

  // 1. Gateway auth gate (+ per-credential rate limit) — every method.
  const auth = await authorizeOrReject(req, res, ctx, 'streamable');
  if (!auth) return;
  const { principal, identity } = auth;

  // 2. Existing-session path — fast route for any method that carries a
  // session id we already know about. The caller must be the identity that
  // opened the session.
  if (sessionId) {
    const existing = streamableSessions.get(sessionId);
    if (existing) {
      if (!sessionOwnedBy(req, res, ctx, existing, sessionId, identity, 'streamable')) return;
      existing.lastActivity = Date.now();
      if (method === 'GET') {
        // Track the open stream so the idle sweep leaves the session alone
        // while it lasts; the idle clock restarts when it closes.
        existing.openStreams += 1;
        res.once('close', () => {
          existing.openStreams -= 1;
          existing.lastActivity = Date.now();
        });
      }
      try {
        if (method === 'POST') {
          const parsedBody = await readJsonBody(req, config.maxPostBytes);
          await existing.transport.handleRequest(req, res, parsedBody.parsed);
        } else {
          await existing.transport.handleRequest(req, res);
        }
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
      return;
    }
    // Unknown session id — distinguish from "no session id". Most often this
    // is a client holding a session id from a previous server process: the
    // server restarted (sessions live in-process memory) and the client kept
    // its old id. Surface that hint so the operator / SDK has somewhere to go.
    logger.info('unknown_session', {
      transport: 'streamable',
      session: shortSessionId(sessionId),
      remote: req.socket.remoteAddress,
    });
    respondJson(res, 404, {
      error: 'unknown_session',
      message:
        'No session with this MCP-Session-Id is registered on this server. ' +
        'The server may have restarted, or the session may have been closed/expired.',
      hint: 'Reinitialize by POSTing an `initialize` request to /mcp without the MCP-Session-Id header to obtain a fresh session id.',
      transport: 'streamable',
      sessionId,
    });
    return;
  }

  // 3. No session id. Only a POST initialize is allowed at this point; the
  // transport itself otherwise rejects with a 400.
  if (method !== 'POST') {
    respondJson(res, 400, { error: 'missing_session_id' });
    return;
  }

  // 3a. Read the body so we can: classify it as initialize, run auth/SSRF
  // checks, then re-hand it to the transport via parsedBody.
  let parsedBody: unknown;
  try {
    parsedBody = (await readJsonBody(req, config.maxPostBytes)).parsed;
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
  if (!isInitializeRequest(parsedBody)) {
    respondJson(res, 400, { error: 'missing_session_id' });
    return;
  }
  const release = admitNewSession(res, ctx, 'streamable');
  if (!release) return;
  try {
    await initStreamableSession(req, res, ctx, parsedBody, principal, identity);
  } finally {
    // By now the session is either registered (counted in the map) or failed.
    release();
  }
}

async function initStreamableSession(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  parsedBody: unknown,
  principal: string | null,
  identity: string
): Promise<void> {
  const { config, streamableSessions, logger, metrics } = ctx;
  const recordFailure = (reason: string): void => {
    metrics?.sseConnectFailuresTotal.inc({ reason });
  };

  // 3b. Resolve backend creds (single- vs multi-tenant), same rules as /sse.
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
    if (!config.triliumUrl || !config.triliumToken) {
      logger.error('server_misconfigured', {});
      recordFailure('server_misconfigured');
      respondJson(res, 500, { error: 'server_misconfigured' });
      return;
    }
    clientUrlRaw = config.triliumUrl;
    clientToken = config.triliumToken;
  }

  const connected = await connectTrilium(res, ctx, clientUrlRaw, clientToken, recordFailure);
  if (!connected) return;
  const { client, triliumHost } = connected;

  // 3c. Build a fresh MCP server + transport for this new session. We don't
  // know the session id yet — it's generated by the transport on init — so
  // start with a placeholder; logger correlation comes from onsessioninitialized.
  const mcpServer = buildMcpServer(client, {
    logger,
    sessionId: 'streamable-pending',
    metrics: metrics ?? undefined,
    principal: principal ?? undefined,
    progressIntervalMs: config.progressIntervalMs,
  });

  let registeredId: string | null = null;
  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      registeredId = sid;
      streamableSessions.set(sid, {
        transport,
        mcpServer,
        identity,
        lastActivity: Date.now(),
        openStreams: 0,
      });
      logger.info('mcp_session_opened', {
        session: shortSessionId(sid),
        host: triliumHost,
        transport: 'streamable',
        principal,
      });
      if (metrics) {
        metrics.sseSessions.inc();
        metrics.sseConnectsTotal.inc();
      }
    },
    onsessionclosed: (sid) => {
      const removed = streamableSessions.delete(sid);
      if (removed) {
        logger.info('mcp_session_closed', {
          session: shortSessionId(sid),
          transport: 'streamable',
        });
        if (metrics) {
          metrics.sseSessions.dec();
          metrics.sseClosesTotal.inc();
        }
      }
    },
  });
  // The transport's own close — fires when the underlying request stream ends
  // for the standalone GET stream. The session may still be live across
  // subsequent requests, so we ONLY clean up if onsessionclosed wasn't already
  // the path that removed us.
  transport.onclose = () => {
    if (registeredId && streamableSessions.has(registeredId)) {
      streamableSessions.delete(registeredId);
      logger.info('mcp_session_closed', {
        session: shortSessionId(registeredId),
        transport: 'streamable',
      });
      if (metrics) {
        metrics.sseSessions.dec();
        metrics.sseClosesTotal.inc();
      }
    }
  };

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (err) {
    logger.error('streamable_init_failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    recordFailure('sse_connect_failed');
    if (registeredId) streamableSessions.delete(registeredId);
    if (!res.headersSent) {
      respondJson(res, 500, { error: 'streamable_init_failed' });
    } else {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Build the TriliumClient for a new session and probe it (bounded by the
 * validate timeout). Writes the error response and returns null on failure.
 *
 * Multi-tenant clients use the shared connect-time-guarded fetch, so a tenant
 * hostname that passed `assertUrlIsSafe` but later rebinds to a private
 * address is refused when the socket is opened — here and on every later
 * tool call.
 */
async function connectTrilium(
  res: ServerResponse,
  ctx: Ctx,
  clientUrlRaw: string,
  clientToken: string,
  recordFailure: (reason: string) => void
): Promise<{ client: TriliumClient; triliumHost: string } | null> {
  const { config, logger } = ctx;
  const triliumUrl = normalizeServerUrl(clientUrlRaw);
  const triliumHost = safeHostname(triliumUrl);
  // Single-tenant may override the user-facing note-link base via publicUrl; in
  // multi-tenant mode each connection's link base is derived from its own URL.
  const webBaseUrl =
    !config.multiTenant && config.publicUrl ? config.publicUrl : deriveWebBaseUrl(triliumUrl);

  // Remember a guard block so the probe can answer `url_rejected` instead of
  // a generic "unreachable" (the client wraps network errors).
  let guardBlock: UrlGuardError | null = null;
  const tenantFetch = ctx.tenantFetch;
  const fetchImpl: FetchLike | undefined = tenantFetch
    ? async (input, init) => {
        try {
          return await tenantFetch(input, init);
        } catch (err) {
          guardBlock ??= findUrlGuardError(err);
          throw err;
        }
      }
    : undefined;
  const client = new TriliumClient(triliumUrl, clientToken, webBaseUrl, {
    ...clientOptionsFromConfig(config),
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  try {
    await withTimeout(client.getAppInfo(), ctx.validateTimeoutMs);
    return { client, triliumHost };
  } catch (err) {
    const blocked = guardBlock as UrlGuardError | null;
    if (blocked) {
      // `detail` (resolved address) is operator-only; the client gets the reason.
      logger.warn('url_rejected', {
        reason: blocked.reason,
        detail: blocked.detail,
        stage: 'connect',
      });
      recordFailure('url_rejected');
      respondJson(res, 400, { error: 'url_rejected', reason: blocked.reason });
      return null;
    }
    if (err instanceof TriliumClientError) {
      const status = err.status === 401 || err.status === 403 ? 401 : 502;
      // Both values can originate from the remote server: bound them before
      // reflecting them into our response and logs.
      const upstreamStatus = safeStatus(err.status);
      const upstreamCode = safeCode(err.code);
      logger.warn('trilium_auth_failed', {
        host: triliumHost,
        status: upstreamStatus,
        code: upstreamCode,
      });
      recordFailure('trilium_auth_failed');
      respondJson(res, status, {
        error: 'trilium_auth_failed',
        status: upstreamStatus,
        code: upstreamCode,
      });
      return null;
    }
    if (err instanceof Error && err.message === 'timeout') {
      logger.warn('trilium_validate_timeout', { host: triliumHost });
      recordFailure('trilium_validate_timeout');
      respondJson(res, 504, { error: 'trilium_validate_timeout' });
      return null;
    }
    logger.warn('trilium_unreachable', {
      host: triliumHost,
      err: err instanceof Error ? err.message : String(err),
    });
    recordFailure('trilium_unreachable');
    respondJson(res, 502, { error: 'trilium_unreachable' });
    return null;
  }
}

/** An HTTP status code, or undefined when the value is not one. */
export function safeStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

/** A short identifier-like error code, or undefined (never echo arbitrary remote text). */
export function safeCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined;
}

/**
 * Make a client-controlled header/path value safe for a log line: first
 * value only, non-printable-ASCII replaced with `?`, truncated to `max` chars.
 */
export function logSafe(value: string | string[] | undefined, max = 128): string | undefined {
  if (value === undefined) return undefined;
  const v = Array.isArray(value) ? (value[0] ?? '') : value;
  const clean = v.replace(/[^\x20-\x7e]/g, '?');
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
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
  ctx: Ctx
): Promise<void> {
  // 1. Gateway auth gate (+ per-credential rate limit), then the session cap.
  const auth = await authorizeOrReject(req, res, ctx, 'sse');
  if (!auth) return;
  const release = admitNewSession(res, ctx, 'sse');
  if (!release) return;
  try {
    await initSseSession(req, res, ctx, auth.principal, auth.identity);
  } finally {
    // The session is registered (or the attempt failed) once this returns.
    release();
  }
}

async function initSseSession(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  principal: string | null,
  identity: string
): Promise<void> {
  const { config, sessions, logger, metrics } = ctx;
  const recordFailure = (reason: string): void => {
    metrics?.sseConnectFailuresTotal.inc({ reason });
  };

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
  const connected = await connectTrilium(res, ctx, clientUrlRaw, clientToken, recordFailure);
  if (!connected) return;
  const { client, triliumHost } = connected;

  // 5. Create the per-connection MCP Server + SSE transport.
  const transport = new SSEServerTransport('/message', res);
  const sessionId = transport.sessionId;
  const mcpServer = buildMcpServer(client, {
    logger,
    sessionId,
    metrics: metrics ?? undefined,
    principal: principal ?? undefined,
    progressIntervalMs: config.progressIntervalMs,
  });

  // 6. Register the session BEFORE awaiting connect(). server.connect() calls
  // transport.start() which writes the endpoint event; a very fast client
  // could otherwise POST before we've inserted into the map.
  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      // Stream may have closed between check and write; onclose will clean up.
    }
  }, ctx.sseKeepaliveMs);
  // Never let the keep-alive timer hold the process open.
  keepAlive.unref?.();

  const session: Session = { transport, mcpServer, keepAlive, identity, lastActivity: Date.now() };
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
    logger.info('sse_closed', { session: shortSessionId(sessionId) });
    if (metrics) {
      metrics.sseSessions.dec();
      metrics.sseClosesTotal.inc();
    }
  };

  try {
    await mcpServer.connect(transport);
    logger.info('sse_connected', {
      session: shortSessionId(sessionId),
      host: triliumHost,
      principal,
    });
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
      session: shortSessionId(sessionId),
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

async function handleSsePost(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const { sessions, logger } = ctx;
  const maxPostBytes = ctx.config.maxPostBytes;
  // Fail fast on a Content-Length that already exceeds the cap, so we don't
  // pay to drain a giant request body just to reject it.
  const contentLengthRaw = req.headers['content-length'];
  if (contentLengthRaw) {
    const contentLength = parseInt(
      Array.isArray(contentLengthRaw) ? contentLengthRaw[0] : contentLengthRaw,
      10
    );
    if (!Number.isNaN(contentLength) && contentLength > maxPostBytes) {
      respondJson(res, 413, { error: 'payload_too_large' });
      return;
    }
  }

  // Gateway auth (+ per-credential rate limit) before any session lookup, so
  // unauthenticated callers learn nothing about which session ids exist.
  const auth = await authorizeOrReject(req, res, ctx, 'sse');
  if (!auth) return;

  const parsed = parsePath(req.url);
  const sessionId = parsed.query.get('sessionId');
  if (!sessionId) {
    respondJson(res, 400, { error: 'missing_session_id' });
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    // 404 (not 503) — unknown session looks like a nonexistent resource. Most
    // often the server restarted (sessions live in-process memory) and the
    // client kept its old sessionId; surface the hint so the operator / SDK
    // can react instead of just retrying the same dead session.
    logger.info('unknown_session', {
      transport: 'sse',
      session: shortSessionId(sessionId),
      remote: req.socket.remoteAddress,
    });
    respondJson(res, 404, {
      error: 'unknown_session',
      message:
        'No SSE session with this sessionId is registered on this server. ' +
        'The server may have restarted, or the session may have been closed/expired.',
      hint: 'Reopen the SSE connection by GETting /sse to receive a new sessionId via the `endpoint` event, then POST tool requests to that new sessionId.',
      transport: 'sse',
      sessionId,
    });
    return;
  }

  // The POST must come from the identity that opened the SSE stream; the
  // session id alone is not a sufficient capability.
  if (!sessionOwnedBy(req, res, ctx, session, sessionId, auth.identity, 'sse')) return;
  session.lastActivity = Date.now();

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

  logger.debug('sse_post', { session: shortSessionId(sessionId), bytes });

  await session.transport.handlePostMessage(req, res, parsedBody);
}

class PayloadTooLargeError extends Error {}
class BadJsonError extends Error {}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number
): Promise<{ parsed: unknown; bytes: number }> {
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

function respondJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): void {
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
    ...extraHeaders,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
