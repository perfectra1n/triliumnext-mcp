import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

/**
 * Client-address resolution for rate limiting: trusted-proxy aware
 * `X-Forwarded-For` handling, CIDR matching, and IPv6 /64 bucketing.
 *
 * Kept free of other project imports so `config.ts` can validate
 * `trustedProxies` entries with {@link parseCidr} without an import cycle.
 */

interface ParsedIp {
  family: 4 | 6;
  /** Address as an unsigned integer (32 or 128 bits). */
  value: bigint;
}

export interface Cidr {
  family: 4 | 6;
  /** Network address with host bits cleared. */
  network: bigint;
  prefix: number;
}

function stripBrackets(h: string): string {
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

function parseIPv4(addr: string): bigint | null {
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  let v = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    v = (v << 8n) | BigInt(n);
  }
  return v;
}

function parseIPv6(addr: string): bigint | null {
  let s = addr.toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 0 : fill !== 0) return null;
  const all = [...head, ...new Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...rest];
  let v = 0n;
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    v = (v << 16n) | BigInt(parseInt(g, 16));
  }
  return v;
}

/** Upper 96 bits of an IPv4-mapped IPv6 address (`::ffff:0:0/96`). */
const V4_MAPPED_HIGH = 0xffffn;

/**
 * Parse an IPv4 / IPv6 address. IPv4-mapped IPv6 (`::ffff:1.2.3.4`, which is
 * what a dual-stack socket reports for IPv4 peers) is folded to IPv4 so the
 * same client always yields the same key and matches IPv4 CIDRs.
 */
export function parseIp(raw: string): ParsedIp | null {
  const addr = stripBrackets(raw.trim());
  const family = isIP(addr);
  if (family === 4) {
    const v = parseIPv4(addr);
    return v === null ? null : { family: 4, value: v };
  }
  if (family === 6) {
    const v = parseIPv6(addr);
    if (v === null) return null;
    if (v >> 32n === V4_MAPPED_HIGH) return { family: 4, value: v & 0xffffffffn };
    return { family: 6, value: v };
  }
  return null;
}

/** Parse `addr` or `addr/prefix`. Returns null when malformed. */
export function parseCidr(raw: string): Cidr | null {
  const [addrPart, prefixPart, extra] = raw.trim().split('/');
  if (extra !== undefined) return null;
  const ip = parseIp(addrPart);
  if (!ip) return null;
  const bits = ip.family === 4 ? 32 : 128;
  let prefix = bits;
  if (prefixPart !== undefined) {
    if (!/^\d{1,3}$/.test(prefixPart)) return null;
    prefix = Number(prefixPart);
    // A v4-mapped v6 CIDR (`::ffff:10.0.0.0/104`) was folded to v4 above.
    if (ip.family === 4 && isIP(stripBrackets(addrPart)) === 6) prefix -= 96;
    if (prefix < 0 || prefix > bits) return null;
  }
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
  return { family: ip.family, network: ip.value & mask, prefix };
}

function inCidr(ip: ParsedIp, cidr: Cidr): boolean {
  if (ip.family !== cidr.family) return false;
  const bits = ip.family === 4 ? 32 : 128;
  const mask =
    cidr.prefix === 0 ? 0n : ((1n << BigInt(cidr.prefix)) - 1n) << BigInt(bits - cidr.prefix);
  return (ip.value & mask) === cidr.network;
}

function formatIp(ip: ParsedIp): string {
  if (ip.family === 4) {
    const v = ip.value;
    return [24n, 16n, 8n, 0n].map((s) => String((v >> s) & 0xffn)).join('.');
  }
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) groups.push(((ip.value >> BigInt(i * 16)) & 0xffffn).toString(16));
  return groups.join(':');
}

/**
 * Rate-limit key for an address: IPv4 as-is, IPv6 collapsed to its /64 (one
 * end-user allocation, so rotating through a /64 cannot mint fresh buckets).
 * Unparseable input is returned unchanged.
 */
export function addressKey(raw: string): string {
  const ip = parseIp(raw);
  if (!ip) return raw;
  if (ip.family === 4) return formatIp(ip);
  const net = ip.value & ~((1n << 64n) - 1n);
  return `${formatIp({ family: 6, value: net })}/64`;
}

/** Matcher over a list of trusted proxy addresses / CIDRs. */
export class TrustedProxies {
  private readonly cidrs: Cidr[];

  /** Throws on a malformed entry; config.ts validates first with a friendlier error. */
  constructor(entries: readonly string[] = []) {
    this.cidrs = entries.map((e) => {
      const c = parseCidr(e);
      if (!c) throw new Error(`Invalid trusted proxy address or CIDR: "${e}"`);
      return c;
    });
  }

  get enabled(): boolean {
    return this.cidrs.length > 0;
  }

  has(addr: string): boolean {
    const ip = parseIp(addr);
    return ip !== null && this.cidrs.some((c) => inCidr(ip, c));
  }
}

/**
 * The address a request should be attributed to. Without trusted proxies (or
 * when the TCP peer is not one of them) this is the socket peer — a client
 * can't spoof it by sending its own `X-Forwarded-For`. When the peer IS
 * trusted, walk `X-Forwarded-For` from the right (entries appended by our own
 * proxies) and return the first address that is not itself a trusted proxy:
 * everything left of that point was supplied by the client and is ignored.
 * A malformed entry at that position falls back to the peer address.
 */
export function resolveClientIp(req: IncomingMessage, trusted: TrustedProxies): string {
  const peer = req.socket.remoteAddress ?? 'unknown';
  if (!trusted.enabled || !trusted.has(peer)) return peer;
  const raw = req.headers['x-forwarded-for'];
  const header = Array.isArray(raw) ? raw.join(',') : (raw ?? '');
  const hops = header
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i];
    if (trusted.has(hop)) continue;
    return parseIp(hop) ? stripBrackets(hop) : peer;
  }
  // Every hop is a trusted proxy (or no header): the left-most hop is the
  // closest thing to a client; otherwise the peer itself.
  return hops.length > 0 && parseIp(hops[0]) ? stripBrackets(hops[0]) : peer;
}
