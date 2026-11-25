import { lookup as dnsLookupCb, promises as dns, type LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { Agent, buildConnector, fetch as undiciFetch } from 'undici';

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
  /** Stable machine-readable error code (handy when wrapped as a fetch `cause`). */
  readonly code = 'ERR_URL_GUARD_BLOCKED';

  /**
   * @param reason short machine-readable reason (`private_address`, `not_allowlisted`, ...)
   * @param message client-safe message — never contains resolved IP addresses
   * @param detail operator-only detail (e.g. the resolved address) for logs
   */
  constructor(
    public readonly reason: string,
    message: string,
    public readonly detail?: string
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
 *
 * This is a pre-flight check that yields a clean error early. It is NOT
 * sufficient on its own against DNS rebinding (the name can resolve to a
 * different address at connect time) — outbound requests must also go through
 * `createGuardedFetch` / `createGuardedDispatcher`, which re-validate the
 * address actually being connected to.
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

  const host = stripBrackets(parsed.hostname);
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
  const addresses: string[] = ipLiteral ? [host] : (await safeLookup(host)).map((a) => a.address);

  if (addresses.length === 0) {
    throw new UrlGuardError('dns_failure', `Could not resolve host: ${host}`);
  }

  for (const addr of addresses) {
    if (isPrivateAddress(addr)) {
      throw privateAddressError(host, addr);
    }
  }
}

function privateAddressError(host: string, addr: string): UrlGuardError {
  return new UrlGuardError(
    'private_address',
    `Host ${host} resolves to a private, loopback, or otherwise non-public address. ` +
      'Use an allowlist, or --allow-private-urls (Trilium URLs) / ' +
      '--content-allow-private-urls (content URLs), to permit it.',
    `${host} -> ${addr}`
  );
}

async function safeLookup(host: string): Promise<LookupAddress[]> {
  try {
    return await dns.lookup(host, { all: true });
  } catch {
    return [];
  }
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Exact match, or suffix match on `.entry` so `example.com` matches
 * `a.example.com` but not `fakeexample.com`.
 */
export function hostMatchesAllowlist(host: string, allowlist: string[]): boolean {
  const lowerHost = stripBrackets(host.toLowerCase());
  for (const entry of allowlist) {
    const lowerEntry = stripBrackets(entry.toLowerCase());
    if (lowerHost === lowerEntry) return true;
    if (lowerHost.endsWith(`.${lowerEntry}`)) return true;
  }
  return false;
}

// ============================================================================
// Connect-time guard (DNS-rebinding + redirect safe)
// ============================================================================

/**
 * Decide whether a connection to `host` (the URL hostname) at resolved
 * address `addr` is permitted under `opts`. Returns null when allowed, or the
 * `UrlGuardError` to fail the connection with.
 */
export function checkConnectTarget(
  host: string,
  addr: string,
  opts: UrlGuardOptions
): UrlGuardError | null {
  const bareHost = stripBrackets(host);
  if (opts.allowlist.length > 0) {
    return hostMatchesAllowlist(bareHost, opts.allowlist)
      ? null
      : new UrlGuardError('not_allowlisted', `Host not in allowlist: ${bareHost}`);
  }
  if (opts.allowPrivate) return null;
  return isPrivateAddress(addr) ? privateAddressError(bareHost, addr) : null;
}

type LookupCallbackAll = (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void;
/** Minimal callback-style resolver signature (subset of `dns.lookup`). */
export type BaseLookup = (
  hostname: string,
  options: { all: true; family?: number; hints?: number },
  callback: LookupCallbackAll
) => void;

const defaultBaseLookup: BaseLookup = (hostname, options, callback) =>
  dnsLookupCb(hostname, options, callback);

/**
 * Build a `net.connect`-compatible `lookup` function that resolves the host
 * and rejects the connection if ANY returned address is disallowed. Because
 * the socket connects to exactly the addresses this function returns, the
 * validated IP is the one connected to — there is no TOCTOU window for DNS
 * rebinding.
 */
export function createGuardedLookup(
  opts: UrlGuardOptions,
  baseLookup: BaseLookup = defaultBaseLookup
): LookupFunction {
  const guarded = (
    hostname: string,
    options: { all?: boolean; family?: number | string; hints?: number },
    callback: (...args: unknown[]) => void
  ): void => {
    const family =
      typeof options?.family === 'number'
        ? options.family
        : options?.family === 'IPv4'
          ? 4
          : options?.family === 'IPv6'
            ? 6
            : undefined;
    baseLookup(
      hostname,
      { all: true, ...(family ? { family } : {}), hints: options?.hints },
      (err, addresses) => {
        if (err) return callback(err);
        if (!addresses || addresses.length === 0) {
          return callback(
            new UrlGuardError('dns_failure', `Could not resolve host: ${hostname}`, hostname)
          );
        }
        for (const a of addresses) {
          const blocked = checkConnectTarget(hostname, a.address, opts);
          if (blocked) return callback(blocked);
        }
        if (options?.all) return callback(null, addresses);
        return callback(null, addresses[0].address, addresses[0].family);
      }
    );
  };
  return guarded as unknown as LookupFunction;
}

export interface GuardedDispatcherOptions {
  /** Injected resolver (tests). Defaults to `dns.lookup`. */
  baseLookup?: BaseLookup;
  /** TCP/TLS connect timeout in ms. Default 10s. */
  connectTimeoutMs?: number;
}

/**
 * An undici `Agent` that enforces the URL-guard policy at CONNECT time:
 *  - hostnames are resolved via `createGuardedLookup` (every address checked)
 *  - IP-literal hosts (which skip `lookup`) are checked directly
 * Every connection — including each redirect hop when fetch follows
 * redirects — passes through this check.
 */
export function createGuardedDispatcher(
  opts: UrlGuardOptions,
  deps: GuardedDispatcherOptions = {}
): Agent {
  const base = buildConnector({
    lookup: createGuardedLookup(opts, deps.baseLookup),
    timeout: deps.connectTimeoutMs ?? 10_000,
  });
  const connect: buildConnector.connector = (connectOpts, callback) => {
    const host = stripBrackets(connectOpts.hostname);
    if (isIP(host)) {
      const blocked = checkConnectTarget(host, host, opts);
      if (blocked) {
        callback(blocked, null);
        return;
      }
    } else if (opts.allowlist.length > 0 && !hostMatchesAllowlist(host, opts.allowlist)) {
      callback(new UrlGuardError('not_allowlisted', `Host not in allowlist: ${host}`), null);
      return;
    }
    base(connectOpts, callback);
  };
  return new Agent({ connect });
}

/** The signature of the WHATWG `fetch` exposed by the guarded factory. */
export type GuardedFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Returns a `fetch` that routes every connection through a guarded undici
 * dispatcher (see `createGuardedDispatcher`). Defaults `redirect` to
 * `'manual'` when the caller does not set it, so callers that follow
 * redirects do so explicitly (and can re-run `assertUrlIsSafe` per hop for
 * clean errors). Even if a caller opts into `redirect: 'follow'`, every hop
 * still connects through the guarded dispatcher.
 *
 * A blocked connection rejects with a `TypeError('fetch failed')` whose
 * `cause` is a `UrlGuardError`; use `findUrlGuardError(err)` to detect it.
 */
export function createGuardedFetch(
  opts: UrlGuardOptions,
  deps: GuardedDispatcherOptions = {}
): GuardedFetch {
  const dispatcher = createGuardedDispatcher(opts, deps);
  return (input, init) => {
    const merged = {
      ...(init ?? {}),
      redirect: init?.redirect ?? 'manual',
      dispatcher,
    };
    return undiciFetch(
      input instanceof URL ? input.href : input,
      merged as Parameters<typeof undiciFetch>[1]
    ) as unknown as Promise<Response>;
  };
}

/** Walks an error's `cause` chain (and AggregateError members) for a UrlGuardError. */
export function findUrlGuardError(err: unknown, depth = 0): UrlGuardError | null {
  if (depth > 6 || err === null || typeof err !== 'object') return null;
  if (err instanceof UrlGuardError) return err;
  if (err instanceof AggregateError) {
    for (const e of err.errors) {
      const found = findUrlGuardError(e, depth + 1);
      if (found) return found;
    }
  }
  return findUrlGuardError((err as { cause?: unknown }).cause, depth + 1);
}

// ============================================================================
// Address classification
// ============================================================================

/**
 * Returns true if `addr` is a loopback, private, link-local, unique-local,
 * multicast, documentation/benchmark, or otherwise-non-routable address.
 * IPv6 transition forms that embed an IPv4 address (IPv4-mapped/-compatible,
 * NAT64 64:ff9b::/96, 6to4 2002::/16) are classified by the embedded address.
 */
export function isPrivateAddress(addr: string): boolean {
  const bare = stripBrackets(addr);
  const family = isIP(bare);
  if (family === 4) return isPrivateIPv4(bare);
  if (family === 6) return isPrivateIPv6(bare);
  // Not a real IP -> treat as unsafe.
  return true;
}

function isPrivateIPv4(addr: string): boolean {
  const parts = addr.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b, c] = parts;

  // 0.0.0.0/8  — "this network"
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 100.64.0.0/10 — CGNAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (includes cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 — IETF protocol assignments
  if (a === 192 && b === 0 && c === 0) return true;
  // 192.0.2.0/24 — TEST-NET-1 (documentation)
  if (a === 192 && b === 0 && c === 2) return true;
  // 192.88.99.0/24 — deprecated 6to4 relay anycast
  if (a === 192 && b === 88 && c === 99) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 — benchmarking
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 198.51.100.0/24 — TEST-NET-2
  if (a === 198 && b === 51 && c === 100) return true;
  // 203.0.113.0/24 — TEST-NET-3
  if (a === 203 && b === 0 && c === 113) return true;
  // 224.0.0.0/4 — multicast
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 — reserved (incl. 255.255.255.255 broadcast)
  if (a >= 240) return true;

  return false;
}

/** Parse an IPv6 address into 8 16-bit groups. Returns null if malformed. */
function parseIPv6(addr: string): number[] | null {
  let s = addr.toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);

  // Embedded dotted-quad tail (e.g. ::ffff:1.2.3.4) -> two hex groups.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return null;
    const [p0, p1, p2, p3] = tail.split('.').map((x) => parseInt(x, 10));
    s = `${s.slice(0, lastColon + 1)}${((p0 << 8) | p1).toString(16)}:${((p2 << 8) | p3).toString(16)}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((g) => parseInt(g, 16));
  const head = parseGroups(halves[0]);
  const rest = halves.length === 2 ? parseGroups(halves[1]) : [];
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) {
    return null;
  }
  return groups;
}

function v4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isPrivateIPv6(addr: string): boolean {
  const g = parseIPv6(addr);
  if (!g) return true;

  const firstSixZero = g.slice(0, 6).every((x) => x === 0);
  // :: (unspecified) and ::1 (loopback)
  if (firstSixZero && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true;
  // ::/96 IPv4-compatible (deprecated) -> embedded v4
  if (firstSixZero) return isPrivateIPv4(v4FromGroups(g[6], g[7]));
  // ::ffff:0:0/96 IPv4-mapped -> embedded v4
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return isPrivateIPv4(v4FromGroups(g[6], g[7]));
  }
  // ::ffff:0:0:0/96 IPv4-translated (SIIT) -> embedded v4
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) {
    return isPrivateIPv4(v4FromGroups(g[6], g[7]));
  }
  // 64:ff9b::/96 NAT64 well-known prefix -> embedded v4
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isPrivateIPv4(v4FromGroups(g[6], g[7]));
  }
  // 64:ff9b:1::/48 local-use NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;
  // 2002::/16 6to4 -> embedded v4 in groups 1-2
  if (g[0] === 0x2002) return isPrivateIPv4(v4FromGroups(g[1], g[2]));
  // 2001:0::/32 Teredo — embedded (obfuscated) client v4; never a sane target.
  if (g[0] === 0x2001 && g[1] === 0) return true;
  // 2001:db8::/32 documentation
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;
  // 100::/64 discard
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;
  // fc00::/7 unique local
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local, fec0::/10 deprecated site-local
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true;
  // ff00::/8 multicast
  if ((g[0] & 0xff00) === 0xff00) return true;

  return false;
}
