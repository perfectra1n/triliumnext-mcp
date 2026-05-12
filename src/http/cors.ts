import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Minimal CORS handler with explicit origin allowlist. Off by default —
 * the server is intended for trusted clients, but browser-based MCP clients
 * (or local development against a different origin) need CORS to talk to it.
 *
 * The allowlist semantics:
 *  - empty list → CORS disabled, no headers added
 *  - exact match → echo the request Origin into Access-Control-Allow-Origin
 *  - `*` → wildcard, but only when no credentials are sent (browsers reject
 *    Authorization headers against `Allow-Origin: *`), so wildcard mode always
 *    echoes the Origin instead of literally emitting `*`
 *
 * Preflight (OPTIONS) responses include the headers that MCP-over-HTTP needs:
 *  - Authorization (gateway auth)
 *  - X-Trilium-Url / X-Trilium-Token (per-tenant creds)
 *  - Content-Type
 *  - MCP-Session-Id (StreamableHTTP transport)
 */
export class CorsPolicy {
  /** Pre-computed lower-case exact origins (everything stays case-insensitive at lookup). */
  private readonly exactOrigins: Set<string>;
  private readonly wildcard: boolean;

  constructor(origins: string[]) {
    this.wildcard = origins.includes('*');
    this.exactOrigins = new Set(
      origins.filter((o) => o !== '*').map((o) => o.toLowerCase())
    );
  }

  get enabled(): boolean {
    return this.wildcard || this.exactOrigins.size > 0;
  }

  /** Returns the Origin header value if it should be reflected back, else null. */
  resolveOrigin(req: IncomingMessage): string | null {
    if (!this.enabled) return null;
    const origin = firstHeader(req.headers['origin']);
    if (!origin) return null;
    if (this.wildcard) return origin;
    return this.exactOrigins.has(origin.toLowerCase()) ? origin : null;
  }

  /** Apply Access-Control-Allow-* headers to a response. Idempotent. */
  apply(req: IncomingMessage, res: ServerResponse): void {
    const origin = this.resolveOrigin(req);
    if (!origin) return;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader(
      'Access-Control-Expose-Headers',
      'MCP-Session-Id'
    );
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
    const reqHeaders = firstHeader(req.headers['access-control-request-headers']);
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': normalizeMethods(reqMethod),
      'Access-Control-Allow-Headers':
        reqHeaders ??
        'Authorization, Content-Type, X-Trilium-Url, X-Trilium-Token, MCP-Session-Id, Last-Event-ID',
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
