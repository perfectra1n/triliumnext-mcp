import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { extractBearerToken } from './auth.js';

/**
 * Token-bucket rate limiter, keyed by remote IP and (separately) by gateway
 * bearer token. The two keys are independent — exceeding either limit causes
 * the request to be rejected.
 *
 * Design notes:
 *  - Buckets refill continuously at `rps` tokens/sec, capped at `burst`.
 *  - State is in-memory only. Multi-process / multi-replica deployments
 *    should rate-limit at the reverse proxy instead (or in addition); this
 *    is here for the common single-process case.
 *  - We track the bearer-token bucket by SHA-256 fingerprint to avoid having
 *    plaintext tokens sitting in a key set.
 *  - Buckets are GC'd opportunistically: a bucket untouched for
 *    `idleSweepMs` is evicted on the next sweep tick. (Refill is lazy, so the
 *    stored token count of an idle bucket is stale; eviction is therefore
 *    decided by idle time — once idle long enough to refill fully, dropping
 *    the bucket is indistinguishable from keeping it.)
 *  - The server checks the IP axis before auth (`checkIp`) and the token
 *    axis only AFTER a successful auth (`checkToken`), so unauthenticated
 *    garbage tokens cannot create per-token buckets.
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  reason?: 'ip' | 'token';
  /** Seconds to wait before retrying (rounded up). */
  retryAfter?: number;
}

export interface RateLimitOptions {
  /** Sustained refill rate (tokens / second). 0 disables. */
  rps: number;
  /** Maximum bucket size (initial + cap). */
  burst: number;
  /** Optional clock injection for tests; defaults to performance.now(). */
  now?: () => number;
  /** Idle bucket eviction threshold; defaults to 5 minutes. */
  idleSweepMs?: number;
}

export class RateLimiter {
  private readonly rps: number;
  private readonly burst: number;
  private readonly now: () => number;
  private readonly idleSweepMs: number;
  private readonly ipBuckets = new Map<string, Bucket>();
  private readonly tokenBuckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(opts: RateLimitOptions) {
    this.rps = opts.rps;
    this.burst = opts.burst;
    this.now = opts.now ?? (() => performance.now());
    this.idleSweepMs = opts.idleSweepMs ?? 5 * 60 * 1000;
  }

  get enabled(): boolean {
    return this.rps > 0 && this.burst > 0;
  }

  /**
   * Check both axes (IP, then bearer token) and consume one token from each
   * if allowed. Kept for callers that do not separate pre-/post-auth checks.
   */
  check(req: IncomingMessage): RateLimitDecision {
    if (!this.enabled) return { allowed: true };
    const t = this.now();
    this.maybeSweep(t);

    const ipBucket = this.takeOrCreate(this.ipBuckets, ipKeyOf(req), t);
    if (ipBucket.tokens < 1) {
      return { allowed: false, reason: 'ip', retryAfter: this.retryAfterSec(ipBucket) };
    }

    const token = extractBearerToken(req.headers['authorization']);
    let tokenBucket: Bucket | null = null;
    if (token) {
      tokenBucket = this.takeOrCreate(this.tokenBuckets, fingerprint(token), t);
      if (tokenBucket.tokens < 1) {
        return { allowed: false, reason: 'token', retryAfter: this.retryAfterSec(tokenBucket) };
      }
    }

    // All buckets had a token; consume.
    ipBucket.tokens -= 1;
    if (tokenBucket) tokenBucket.tokens -= 1;
    return { allowed: true };
  }

  /** Pre-auth check: the per-remote-IP axis only. Consumes one token if allowed. */
  checkIp(req: IncomingMessage): RateLimitDecision {
    if (!this.enabled) return { allowed: true };
    const t = this.now();
    this.maybeSweep(t);
    const b = this.takeOrCreate(this.ipBuckets, ipKeyOf(req), t);
    if (b.tokens < 1) return { allowed: false, reason: 'ip', retryAfter: this.retryAfterSec(b) };
    b.tokens -= 1;
    return { allowed: true };
  }

  /**
   * Post-auth check: the per-credential axis. Call only after the request's
   * credential was verified, so buckets are created for real credentials
   * only. `credential` is the raw bearer token (fingerprinted internally);
   * when `undefined` it is read from the Authorization header; pass `null` to
   * skip the token axis. No credential → allowed (IP-only limiting).
   */
  checkToken(req: IncomingMessage, credential?: string | null): RateLimitDecision {
    if (!this.enabled) return { allowed: true };
    const token =
      credential === undefined ? extractBearerToken(req.headers['authorization']) : credential;
    if (!token) return { allowed: true };
    const t = this.now();
    this.maybeSweep(t);
    const b = this.takeOrCreate(this.tokenBuckets, fingerprint(token), t);
    if (b.tokens < 1) {
      return { allowed: false, reason: 'token', retryAfter: this.retryAfterSec(b) };
    }
    b.tokens -= 1;
    return { allowed: true };
  }

  /** Read-only snapshot for tests + diagnostics. Do not mutate. */
  inspect(): { ips: number; tokens: number } {
    return { ips: this.ipBuckets.size, tokens: this.tokenBuckets.size };
  }

  private takeOrCreate(map: Map<string, Bucket>, key: string, t: number): Bucket {
    let b = map.get(key);
    if (!b) {
      b = { tokens: this.burst, lastRefill: t };
      map.set(key, b);
      return b;
    }
    const elapsedSec = (t - b.lastRefill) / 1000;
    if (elapsedSec > 0) {
      b.tokens = Math.min(this.burst, b.tokens + elapsedSec * this.rps);
      b.lastRefill = t;
    }
    return b;
  }

  private retryAfterSec(b: Bucket): number {
    if (this.rps <= 0) return 1;
    const deficit = 1 - b.tokens;
    return Math.max(1, Math.ceil(deficit / this.rps));
  }

  /**
   * A bucket may be dropped once it has been idle for `idleSweepMs` AND its
   * lazily-refilled level would be full (so a fresh bucket is equivalent).
   */
  private isEvictable(b: Bucket, t: number): boolean {
    const idleMs = t - b.lastRefill;
    if (idleMs < this.idleSweepMs) return false;
    const refilled = Math.min(this.burst, b.tokens + (idleMs / 1000) * this.rps);
    return refilled >= this.burst;
  }

  private maybeSweep(t: number): void {
    if (t - this.lastSweep < this.idleSweepMs) return;
    this.lastSweep = t;
    for (const map of [this.ipBuckets, this.tokenBuckets]) {
      for (const [k, b] of map) {
        if (this.isEvictable(b, t)) map.delete(k);
      }
    }
  }
}

function ipKeyOf(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

function fingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16);
}
