import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { CorsPolicy } from './cors.js';

/**
 * DNS-rebinding and cross-site request defenses for the HTTP transport.
 *
 * The MCP Streamable HTTP spec requires servers to validate the `Origin`
 * header on incoming connections and recommends binding to localhost when
 * running locally; without both, a malicious web page can drive a local MCP
 * server from the user's browser. Two independent checks run here:
 *
 * 1. Host check (DNS rebinding). A rebinding attack resolves an
 *    attacker-controlled name to 127.0.0.1, so the browser sends the
 *    attacker's hostname in `Host`. When the server is bound to a loopback
 *    interface — or the operator configured `allowedHosts` explicitly — the
 *    `Host` header must be a loopback name, the bind address itself, or one of
 *    `allowedHosts`. A non-loopback bind without `allowedHosts` (the Docker
 *    image behind a reverse proxy) skips this check: the public hostname is
 *    not known to us and rebinding to a routable address is not a local
 *    threat.
 *
 * 2. Origin check (cross-site). Browsers attach `Origin` to cross-origin
 *    fetches; non-browser MCP clients (SDKs, gateways, curl) send none, so a
 *    request without `Origin` is always allowed through this check. A request
 *    WITH an `Origin` must be allowed by the CORS allowlist — or, when bound to
 *    loopback, be a loopback origin itself (a local dev UI talking to a local
 *    server).
 */

export interface OriginGuardOptions {
  /** Interface the HTTP server is bound to (e.g. `127.0.0.1`, `0.0.0.0`). */
  bindHost: string;
  /** CORS policy — its allowlist doubles as the Origin allowlist. */
  cors: Pick<CorsPolicy, 'allowsOrigin'>;
  /** Extra accepted `Host` values: `hostname` or `hostname:port`. */
  allowedHosts: string[];
}

export type OriginCheckResult =
  { ok: true } | { ok: false; reason: 'missing_host' | 'host_not_allowed' | 'origin_not_allowed' };

/** True for `localhost` (and `*.localhost`), `127.0.0.0/8`, and `::1`. */
export function isLoopbackHost(host: string): boolean {
  const h = stripBrackets(host.trim().toLowerCase()).replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const family = isIP(h);
  if (family === 4) return h.startsWith('127.');
  if (family === 6) {
    if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
    // IPv4-mapped loopback, e.g. ::ffff:127.0.0.1
    const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped !== null && mapped[1].startsWith('127.');
  }
  return false;
}

/**
 * Split a `Host` header value (or `allowedHosts` entry) into hostname and
 * optional port. Handles bracketed IPv6 (`[::1]:3000`). Returns null when the
 * value is malformed.
 */
export function parseHostHeader(value: string): { hostname: string; port: string | null } | null {
  const v = value.trim().toLowerCase();
  if (v.length === 0) return null;
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    if (end === -1) return null;
    const hostname = v.slice(1, end);
    const rest = v.slice(end + 1);
    if (rest === '') return { hostname, port: null };
    if (!/^:\d+$/.test(rest)) return null;
    return { hostname, port: rest.slice(1) };
  }
  const colons = v.split(':').length - 1;
  if (colons === 0) return { hostname: v, port: null };
  if (colons === 1) {
    const [hostname, port] = v.split(':');
    if (hostname === '' || !/^\d+$/.test(port)) return null;
    return { hostname, port };
  }
  // Bare (unbracketed) IPv6 literal — only valid in config entries, not Host.
  return isIP(v) === 6 ? { hostname: v, port: null } : null;
}

function stripBrackets(h: string): string {
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

function stripTrailingDot(h: string): string {
  return h.endsWith('.') ? h.slice(0, -1) : h;
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  const v = Array.isArray(value) ? value[0] : value;
  const trimmed = v?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function hostIsAllowed(
  host: { hostname: string; port: string | null },
  opts: OriginGuardOptions
): boolean {
  const hostname = stripTrailingDot(host.hostname);
  if (isLoopbackHost(hostname)) return true;
  if (hostname === stripBrackets(opts.bindHost.trim().toLowerCase())) return true;
  for (const entry of opts.allowedHosts) {
    const parsed = parseHostHeader(entry);
    if (!parsed) continue;
    if (stripTrailingDot(parsed.hostname) !== hostname) continue;
    // An entry without a port accepts any port; with a port it must match.
    if (parsed.port === null || parsed.port === host.port) return true;
  }
  return false;
}

/**
 * Validate `Host` and `Origin` for a request. Callers exempt liveness probes
 * (`/health`) themselves.
 */
export function checkRequestOrigin(
  req: IncomingMessage,
  opts: OriginGuardOptions
): OriginCheckResult {
  const boundToLoopback = isLoopbackHost(opts.bindHost);

  if (boundToLoopback || opts.allowedHosts.length > 0) {
    const rawHost = firstHeader(req.headers.host);
    if (!rawHost) return { ok: false, reason: 'missing_host' };
    const host = parseHostHeader(rawHost);
    if (!host || !hostIsAllowed(host, opts)) return { ok: false, reason: 'host_not_allowed' };
  }

  const origin = firstHeader(req.headers.origin);
  if (origin === null) return { ok: true };
  if (opts.cors.allowsOrigin(origin)) return { ok: true };
  if (boundToLoopback) {
    try {
      const parsed = new URL(origin);
      if (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        isLoopbackHost(parsed.hostname)
      ) {
        return { ok: true };
      }
    } catch {
      // `Origin: null` (sandboxed iframes, file://) and garbage fall through.
    }
  }
  return { ok: false, reason: 'origin_not_allowed' };
}
