import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Request headers the server actually reads. Preflight responses advertise
 * this fixed list instead of reflecting `Access-Control-Request-Headers`, so a
 * browser can never be talked into sending arbitrary headers cross-origin.
 */
export const CORS_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'Accept',
  'Mcp-Session-Id',
  'MCP-Protocol-Version',
  'Last-Event-ID',
  'X-Trilium-Url',
  'X-Trilium-Token',
].join(', ');

/** Response headers browser JS may read. */
export const CORS_EXPOSED_HEADERS = [
  'Mcp-Session-Id',
  'MCP-Protocol-Version',
  'WWW-Authenticate',
].join(', ');

/**
 * Minimal CORS handler with explicit origin allowlist. Off by default —
 * the server is intended for trusted clients, but browser-based MCP clients
 * (or local development against a different origin) need CORS to talk to it.
 *
 * The allowlist semantics:
 *  - empty list → CORS disabled, no headers added
 *  - exact match → echo the request Origin into Access-Control-Allow-Origin,
 *    with `Access-Control-Allow-Credentials: true`
 *  - `*` → literal `Access-Control-Allow-Origin: *` and NO credentials flag.
 *    The gateway authenticates with an `Authorization` header (never
 *    cookies), which browsers send fine under `*` as long as it is listed in
 *    Access-Control-Allow-Headers — credentialed wildcard reflection would
 *    only widen exposure.
 */
export class CorsPolicy {
  /** Pre-computed lower-case exact origins (everything stays case-insensitive at lookup). */
  private readonly exactOrigins: Set<string>;
  private readonly wildcard: boolean;

  constructor(origins: string[]) {
    this.wildcard = origins.includes('*');
    this.exactOrigins = new Set(origins.filter((o) => o !== '*').map((o) => o.toLowerCase()));
  }

  get enabled(): boolean {
    return this.wildcard || this.exactOrigins.size > 0;
  }

  get isWildcard(): boolean {
    return this.wildcard;
  }

  /** True if `origin` is explicitly (or via wildcard) allowed by the CORS allowlist. */
  allowsOrigin(origin: string): boolean {
    if (this.wildcard) return true;
    return this.exactOrigins.has(origin.toLowerCase());
  }

  /**
   * Returns the value for Access-Control-Allow-Origin, or null if no CORS
   * headers should be sent: `*` in wildcard mode, else the echoed Origin.
   */
  resolveOrigin(req: IncomingMessage): string | null {
    if (!this.enabled) return null;
    const origin = firstHeader(req.headers['origin']);
    if (!origin) return null;
    if (this.exactOrigins.has(origin.toLowerCase())) return origin;
    if (this.wildcard) return '*';
    return null;
  }

  private baseHeaders(allowOrigin: string): Record<string, string> {
    const headers: Record<string, string> = { 'Access-Control-Allow-Origin': allowOrigin };
    if (allowOrigin !== '*') {
      headers['Vary'] = 'Origin';
      headers['Access-Control-Allow-Credentials'] = 'true';
    }
    return headers;
  }

  /** Apply Access-Control-Allow-* headers to a response. Idempotent. */
  apply(req: IncomingMessage, res: ServerResponse): void {
    const origin = this.resolveOrigin(req);
    if (!origin) return;
    for (const [k, v] of Object.entries(this.baseHeaders(origin))) res.setHeader(k, v);
    res.setHeader('Access-Control-Expose-Headers', CORS_EXPOSED_HEADERS);
  }

  /**
   * Handle an OPTIONS preflight request. Returns true if the request was
   * answered (a 204 or 403), false to fall through to the regular handler.
   */
  handlePreflight(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method !== 'OPTIONS') return false;
    if (!this.enabled) {
      // Without CORS configured, OPTIONS isn't special — let the normal
      // 404 path handle it.
      return false;
    }
    const origin = this.resolveOrigin(req);
    if (!origin) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'cors_origin_rejected' }));
      return true;
    }
    const reqMethod = firstHeader(req.headers['access-control-request-method']) ?? 'GET';
    res.writeHead(204, {
      ...this.baseHeaders(origin),
      'Access-Control-Allow-Methods': normalizeMethods(reqMethod),
      'Access-Control-Allow-Headers': CORS_ALLOWED_HEADERS,
      'Access-Control-Max-Age': '600',
      'Content-Length': '0',
    });
    res.end();
    return true;
  }
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (!value) return null;
  const v = Array.isArray(value) ? value[0] : value;
  return v.trim().length > 0 ? v.trim() : null;
}

function normalizeMethods(requested: string): string {
  const allowed = new Set(['GET', 'POST', 'DELETE', 'OPTIONS']);
  const m = requested.toUpperCase();
  return allowed.has(m) ? m : 'GET, POST, DELETE, OPTIONS';
}
