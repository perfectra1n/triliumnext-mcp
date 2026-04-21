import { promises as dns, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';

export interface UrlGuardOptions {
  /**
   * When non-empty, the URL's hostname must exactly equal one of these entries
   * OR be a subdomain of one of them (suffix match on `.entry`).
   * Allowlist takes precedence over the private-IP block.
   */
  allowlist: string[];
  /**
   * When true, private/loopback/link-local IPs are permitted.
   */
  allowPrivate: boolean;
}

export class UrlGuardError extends Error {
  constructor(
    public readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = 'UrlGuardError';
  }
}

/**
 * Validates a client-supplied URL for SSRF risk. Throws `UrlGuardError` on reject.
 *
 * Checks:
 * 1. Scheme is http or https.
 * 2. No userinfo (`http://user:pass@host`) — such creds would leak into outbound requests.
 * 3. Hostname resolvable.
 * 4. If allowlist is non-empty, hostname must match (exact or suffix).
 * 5. Otherwise (unless `allowPrivate`), every resolved IP must be public.
 */
export async function assertUrlIsSafe(rawUrl: string, opts: UrlGuardOptions): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UrlGuardError('invalid_url', 'URL could not be parsed');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UrlGuardError('bad_scheme', `Scheme not allowed: ${parsed.protocol}`);
  }

  if (parsed.username || parsed.password) {
    throw new UrlGuardError('embedded_credentials', 'URL must not contain embedded credentials');
  }

  const host = parsed.hostname;
  if (!host) {
    throw new UrlGuardError('invalid_url', 'URL has no hostname');
  }

  // Allowlist short-circuits the private-IP block: if an operator has explicitly
  // named a host, they accept whatever IP it resolves to (including private).
  if (opts.allowlist.length > 0) {
    if (hostMatchesAllowlist(host, opts.allowlist)) {
      return;
    }
    throw new UrlGuardError('not_allowlisted', `Host not in allowlist: ${host}`);
  }

  if (opts.allowPrivate) {
    return;
  }

  // Resolve and check every address. Literal IPs don't need DNS; feed them
  // straight through the same check.
  const ipLiteral = isIP(host);
  const addresses: string[] = ipLiteral
    ? [host]
    : (await safeLookup(host)).map((a) => a.address);

  if (addresses.length === 0) {
    throw new UrlGuardError('dns_failure', `Could not resolve host: ${host}`);
  }

  for (const addr of addresses) {
    if (isPrivateAddress(addr)) {
      throw new UrlGuardError(
        'private_address',
        `Host resolves to private/loopback address: ${addr}. Use --allow-private-urls or --trilium-url-allowlist to permit.`
      );
    }
  }
}

async function safeLookup(host: string): Promise<LookupAddress[]> {
  try {
    return await dns.lookup(host, { all: true });
  } catch {
    return [];
  }
}

/**
 * Exact match, or suffix match on `.entry` so `example.com` matches
 * `a.example.com` but not `fakeexample.com`.
 */
export function hostMatchesAllowlist(host: string, allowlist: string[]): boolean {
  const lowerHost = host.toLowerCase();
  for (const entry of allowlist) {
    const lowerEntry = entry.toLowerCase();
    if (lowerHost === lowerEntry) return true;
    if (lowerHost.endsWith(`.${lowerEntry}`)) return true;
  }
  return false;
}

/**
 * Returns true if `addr` is a loopback, private, link-local, unique-local,
 * multicast, or otherwise-non-routable address. Covers the ranges that
 * typically matter for SSRF defense (cloud metadata, LAN services).
 */
export function isPrivateAddress(addr: string): boolean {
  const family = isIP(addr);
  if (family === 4) return isPrivateIPv4(addr);
  if (family === 6) return isPrivateIPv6(addr);
  // Not a real IP -> treat as unsafe.
  return true;
}

function isPrivateIPv4(addr: string): boolean {
  const parts = addr.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts;

  // 0.0.0.0/8  — "this network"
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (includes cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 — IETF protocol assignments
  if (a === 192 && b === 0 && parts[2] === 0) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 — CGNAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 224.0.0.0/4 — multicast
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 — reserved
  if (a >= 240) return true;

  return false;
}

function isPrivateIPv6(addr: string): boolean {
  const lower = addr.toLowerCase();

  // Unspecified / loopback
  if (lower === '::' || lower === '::1') return true;

  // IPv4-mapped (::ffff:a.b.c.d) — defer to IPv4 check.
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice('::ffff:'.length);
    if (isIP(v4) === 4) return isPrivateIPv4(v4);
    return true;
  }
  // Discard/Reserved (100::/64)
  if (lower.startsWith('100:')) return true;
  // Unique local fc00::/7 (fc.. or fd..)
  if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return true;
  // Link-local fe80::/10 (fe80..febf)
  if (/^fe[89ab][0-9a-f]{0,1}:/.test(lower)) return true;
  // Multicast ff00::/8
  if (lower.startsWith('ff')) return true;

  return false;
}
